import { logger } from "../utils/logger.js";
import type { ApiClientCredentials } from "./api-client.js";
import {
  getRuntimeAccountsByTeam,
  type TeamSpxAccountRuntime,
} from "../repositories/team-spx-account-repository.js";

export interface TeamCredentialPoolOptions {
  teamId: number;
  fallbackCredentials?: ApiClientCredentials | null;
  loadAccounts?: (teamId: number) => Promise<TeamSpxAccountRuntime[]>;
  clock?: () => number;
}

export interface AccountStatusItem {
  id: number;
  name: string;
  isRateLimited: boolean;
  rateLimitedUntil: number | null;
  isSessionExpired: boolean;
}

export class TeamCredentialPool {
  public readonly teamId: number;
  private readonly fallbackCredentials: ApiClientCredentials | null;
  private readonly loadAccountsFn: (teamId: number) => Promise<TeamSpxAccountRuntime[]>;
  private readonly clock: () => number;

  private accounts: TeamSpxAccountRuntime[] = [];
  private readonly rateLimitedUntil = new Map<number, number>();
  private readonly sessionExpired = new Set<number>();
  private currentIndex = 0;
  private initialized = false;

  constructor(options: TeamCredentialPoolOptions) {
    this.teamId = options.teamId;
    this.fallbackCredentials = options.fallbackCredentials ?? null;
    this.loadAccountsFn = options.loadAccounts ?? getRuntimeAccountsByTeam;
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
