import { logger } from "../utils/logger.js";
import type { ApiClientCredentials } from "./api-client.js";
import {
  getRuntimeAccountsByTeam,
  updateAccountSession,
  type TeamSpxAccountRuntime,
  type UpdateAccountSessionInput,
} from "../repositories/team-spx-account-repository.js";
import { loginProvider, ProviderAuthError } from "./provider-auth/client.js";
import type { ProviderCredentials, ProviderSession } from "../models/provider-auth.js";

export type LoginProviderFn = (
  credentials: ProviderCredentials,
  options?: { deviceId?: string },
) => Promise<ProviderSession>;

export type UpdateAccountSessionFn = (
  id: number,
  session: UpdateAccountSessionInput,
) => Promise<boolean>;

export interface TeamCredentialPoolOptions {
  teamId: number;
  fallbackCredentials?: ApiClientCredentials | null;
  loadAccounts?: (teamId: number) => Promise<TeamSpxAccountRuntime[]>;
  updateAccountSession?: UpdateAccountSessionFn;
  loginProvider?: LoginProviderFn;
  clock?: () => number;
}

export interface AccountStatusItem {
  id: number;
  name: string;
  isRateLimited: boolean;
  rateLimitedUntil: number | null;
  isSessionExpired: boolean;
  isRecovering?: boolean;
}

export class TeamCredentialPool {
  public readonly teamId: number;
  private readonly fallbackCredentials: ApiClientCredentials | null;
  private readonly loadAccountsFn: (teamId: number) => Promise<TeamSpxAccountRuntime[]>;
  private readonly updateAccountSessionFn: UpdateAccountSessionFn;
  private readonly loginProviderFn: LoginProviderFn;
  private readonly clock: () => number;

  private accounts: TeamSpxAccountRuntime[] = [];
  private readonly rateLimitedUntil = new Map<number, number>();
  private readonly sessionExpired = new Set<number>();
  private readonly recoveringAccountIds = new Set<number>();
  private currentIndex = 0;
  private initialized = false;

  constructor(options: TeamCredentialPoolOptions) {
    this.teamId = options.teamId;
    this.fallbackCredentials = options.fallbackCredentials ?? null;
    this.loadAccountsFn = options.loadAccounts ?? getRuntimeAccountsByTeam;
    this.updateAccountSessionFn = options.updateAccountSession ?? updateAccountSession;
    this.loginProviderFn = options.loginProvider ?? loginProvider;
    this.clock = options.clock ?? Date.now;
  }

  async init(): Promise<void> {
    await this.reloadAccounts();
    this.initialized = true;
  }

  async reloadAccounts(): Promise<void> {
    try {
      const loaded = await this.loadAccountsFn(this.teamId);
      this.accounts = loaded;

      // Prune rate limits and expired flags for accounts that no longer exist
      const activeIds = new Set(this.accounts.map((a) => a.id));
      for (const id of this.rateLimitedUntil.keys()) {
        if (!activeIds.has(id)) this.rateLimitedUntil.delete(id);
      }
      for (const id of this.sessionExpired) {
        if (!activeIds.has(id)) this.sessionExpired.delete(id);
      }
      this.checkProactiveRefresh();
    } catch (err) {
      logger.error("team-credential-pool-reload-failed", {
        teamId: this.teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hasCredentials(): boolean {
    if (this.accounts.length > 0) return true;
    return !!(this.fallbackCredentials?.spxCookie && this.fallbackCredentials?.spxDeviceId);
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getActiveAccountCount(): number {
    const now = this.clock();
    return this.accounts.filter(
      (a) => !this.sessionExpired.has(a.id) && (this.rateLimitedUntil.get(a.id) ?? 0) <= now,
    ).length;
  }

  nextCredentials(): ApiClientCredentials {
    // If no accounts in pool, fall back to legacy team credentials
    if (this.accounts.length === 0) {
      if (this.fallbackCredentials) {
        return this.fallbackCredentials;
      }
      throw new Error(`Team ${this.teamId} has no credentials configured`);
    }

    const now = this.clock();

    // 1. Prefer accounts that are not expired and not currently rate-limited
    const available = this.accounts.filter(
      (a) => !this.sessionExpired.has(a.id) && (this.rateLimitedUntil.get(a.id) ?? 0) <= now,
    );

    let chosen: TeamSpxAccountRuntime;

    if (available.length > 0) {
      this.currentIndex = (this.currentIndex + 1) % available.length;
      chosen = available[this.currentIndex];
    } else {
      // 2. If all accounts are rate-limited, choose the non-expired account whose rate limit expires earliest
      const nonExpired = this.accounts.filter((a) => !this.sessionExpired.has(a.id));
      const pool = nonExpired.length > 0 ? [...nonExpired] : [...this.accounts];

      pool.sort((a, b) => {
        const timeA = this.rateLimitedUntil.get(a.id) ?? 0;
        const timeB = this.rateLimitedUntil.get(b.id) ?? 0;
        return timeA - timeB;
      });

      chosen = pool[0];
    }

    return {
      spxCookie: chosen.spxCookie,
      spxDeviceId: chosen.spxDeviceId,
      spxAppName: chosen.spxAppName || undefined,
      spxReferer: chosen.spxReferer || undefined,
      accountId: chosen.id,
      accountName: chosen.name,
    };
  }

  recordRateLimit(accountId: number | undefined, retryAfterMs = 60_000): void {
    if (accountId === undefined) return;
    const until = this.clock() + Math.max(retryAfterMs, 1000);
    this.rateLimitedUntil.set(accountId, until);
    logger.warn("team-credential-pool-account-rate-limited", {
      teamId: this.teamId,
      accountId,
      retryAfterMs,
      rateLimitedUntil: new Date(until).toISOString(),
    });
  }

  recordSessionExpired(accountId: number | undefined): void {
    if (accountId === undefined) return;
    this.sessionExpired.add(accountId);
    logger.error("team-credential-pool-account-session-expired", {
      teamId: this.teamId,
      accountId,
    });
    void this.recoverAccount(accountId);
  }

  async recoverAccount(accountId: number): Promise<boolean> {
    if (this.recoveringAccountIds.has(accountId)) {
      return false;
    }

    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) {
      logger.warn("team-credential-pool-recover-skipped", {
        teamId: this.teamId,
        accountId,
        reason: "account_not_found",
      });
      return false;
    }

    if (!account.spxPassword || !account.spxEmail) {
      logger.warn("team-credential-pool-recover-skipped", {
        teamId: this.teamId,
        accountId,
        reason: "missing_credentials",
      });
      return false;
    }

    this.recoveringAccountIds.add(accountId);
    try {
      logger.info("team-credential-pool-recovering-account", {
        teamId: this.teamId,
        accountId,
        email: account.spxEmail,
      });

      const session = await this.loginProviderFn(
        { email: account.spxEmail, password: account.spxPassword },
        { deviceId: account.spxDeviceId || undefined },
      );

      const expiresAtDate = session.expiresAt ? new Date(session.expiresAt) : null;
      await this.updateAccountSessionFn(accountId, {
        spxCookie: session.cookie,
        spxDeviceId: session.deviceId,
        spxSessionExpiresAt: expiresAtDate,
        spxLastLoginAt: new Date(this.clock()),
        spxAuthStatus: "connected",
        spxAuthError: null,
      });

      account.spxCookie = session.cookie;
      account.spxDeviceId = session.deviceId;
      account.spxSessionExpiresAt = session.expiresAt;
      account.spxAuthStatus = "connected";
      account.spxAuthError = null;

      this.sessionExpired.delete(accountId);
      this.rateLimitedUntil.delete(accountId);

      logger.info("team-credential-pool-account-recovered", {
        teamId: this.teamId,
        accountId,
        email: account.spxEmail,
      });
      return true;
    } catch (err) {
      const errorCode = err instanceof ProviderAuthError ? err.code : "unknown";
      logger.error("team-credential-pool-account-recovery-failed", {
        teamId: this.teamId,
        accountId,
        error: err instanceof Error ? err.message : String(err),
        errorCode,
      });
      try {
        await this.updateAccountSessionFn(accountId, {
          spxCookie: account.spxCookie,
          spxAuthStatus: "attention",
          spxAuthError: errorCode,
        });
      } catch {
        // ignore secondary DB error
      }
      return false;
    } finally {
      this.recoveringAccountIds.delete(accountId);
    }
  }

  checkProactiveRefresh(): void {
    const now = this.clock();
    for (const account of this.accounts) {
      if (!account.spxPassword || !account.spxEmail || this.recoveringAccountIds.has(account.id)) {
        continue;
      }
      if (account.spxSessionExpiresAt) {
        const expiresAtMs = Date.parse(account.spxSessionExpiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs - now <= 5 * 60_000) {
          logger.info("team-credential-pool-proactive-refresh-triggered", {
            teamId: this.teamId,
            accountId: account.id,
            expiresAt: account.spxSessionExpiresAt,
          });
          void this.recoverAccount(account.id);
        }
      }
    }
  }

  isRecovering(accountId: number): boolean {
    return this.recoveringAccountIds.has(accountId);
  }

  clearRateLimits(): void {
    this.rateLimitedUntil.clear();
  }

  clearSessionExpired(accountId?: number): void {
    if (accountId !== undefined) {
      this.sessionExpired.delete(accountId);
    } else {
      this.sessionExpired.clear();
    }
  }

  getAccountsStatus(): AccountStatusItem[] {
    const now = this.clock();
    return this.accounts.map((a) => {
      const until = this.rateLimitedUntil.get(a.id) ?? null;
      return {
        id: a.id,
        name: a.name,
        isRateLimited: until !== null && until > now,
        rateLimitedUntil: until,
        isSessionExpired: this.sessionExpired.has(a.id),
        isRecovering: this.recoveringAccountIds.has(a.id),
      };
    });
  }
}

// Global registry of credential pools by team ID
const poolRegistry = new Map<number, TeamCredentialPool>();

export async function getOrCreateTeamCredentialPool(
  teamId: number,
  fallbackCredentials?: ApiClientCredentials | null,
): Promise<TeamCredentialPool> {
  let pool = poolRegistry.get(teamId);
  if (!pool) {
    pool = new TeamCredentialPool({ teamId, fallbackCredentials });
    await pool.init();
    poolRegistry.set(teamId, pool);
  } else if (fallbackCredentials && !pool.hasCredentials()) {
    // If fallback credentials were provided and pool had none, re-init
    pool = new TeamCredentialPool({ teamId, fallbackCredentials });
    await pool.init();
    poolRegistry.set(teamId, pool);
  }
  return pool;
}

export function clearTeamCredentialPools(): void {
  poolRegistry.clear();
}
