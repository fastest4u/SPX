import type {
  ProviderAuthErrorCode,
  ProviderAuthLease,
  ProviderAuthRecord,
  ProviderAuthState,
  ProviderCredentials,
  ProviderSession,
} from "../../models/provider-auth.js";
import {
  acquireTeamProviderAuthLease,
  commitTeamProviderAuth,
  failTeamProviderAuth,
  getTeamProviderAuth,
  releaseTeamProviderAuthLease,
} from "../../repositories/team-provider-auth-repository.js";
import {
  ProviderAuthError,
  checkProviderSession,
  loginProvider,
  type ProviderSessionCheck,
} from "./client.js";

const REFRESH_MARGIN_MS = 5 * 60_000;
const MIN_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 300_000;

export interface ProviderAuthRepositoryDependency {
  getTeamProviderAuth(teamId: number): Promise<ProviderAuthRecord | null>;
  acquireTeamProviderAuthLease(teamId: number, now?: Date): Promise<ProviderAuthLease | null>;
  commitTeamProviderAuth(
    lease: ProviderAuthLease,
    credentials: ProviderCredentials,
    session: ProviderSession,
    now?: Date,
  ): Promise<boolean>;
  failTeamProviderAuth(
    lease: ProviderAuthLease,
    failure: {
      status: ProviderAuthState;
      errorCode: ProviderAuthErrorCode;
      retryAt: string | null;
      failures: number;
    },
    now?: Date,
  ): Promise<boolean>;
  releaseTeamProviderAuthLease(lease: ProviderAuthLease, now?: Date): Promise<boolean>;
}

export interface ProviderAuthClientDependency {
  login(credentials: ProviderCredentials, options: { deviceId?: string }): Promise<ProviderSession>;
  check(session: ProviderSession): Promise<ProviderSessionCheck>;
}

export interface ProviderAuthServiceDependencies {
  repository?: ProviderAuthRepositoryDependency;
  client?: ProviderAuthClientDependency;
  clock?: () => Date;
}

export interface ProviderAuthService {
  connect(teamId: number, credentials: ProviderCredentials): Promise<ProviderAuthRecord | null>;
  reconnect(teamId: number): Promise<ProviderAuthRecord | null>;
  ensure(teamId: number): Promise<ProviderAuthRecord | null>;
  recover(teamId: number, rejectedEpoch: number): Promise<boolean>;
}

const defaultRepository: ProviderAuthRepositoryDependency = {
  getTeamProviderAuth,
  acquireTeamProviderAuthLease,
  commitTeamProviderAuth,
  failTeamProviderAuth,
  releaseTeamProviderAuthLease,
};

const defaultClient: ProviderAuthClientDependency = {
  login: loginProvider,
  check: checkProviderSession,
};

function configured(record: ProviderAuthRecord): boolean {
  return record.hasPassword && record.email.length > 0 && record.password.length > 0;
}

function cooldownRemaining(record: ProviderAuthRecord, now: Date): number {
  if (!record.retryAt) return 0;
  const retryAt = Date.parse(record.retryAt);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now.getTime()) : 0;
}

function manualSuccessCooldownRemaining(record: ProviderAuthRecord, now: Date): number {
  if (!record.lastLoginAt) return 0;
  const lastLoginAt = Date.parse(record.lastLoginAt);
  return Number.isFinite(lastLoginAt)
    ? Math.max(0, lastLoginAt + MIN_COOLDOWN_MS - now.getTime())
    : 0;
}

function nextFailure(
  record: ProviderAuthRecord,
  error: ProviderAuthError,
  now: Date,
  candidateReplacement: boolean,
) {
  const failures = record.failures + 1;
  const transient = error.code === "provider_unavailable" || error.code === "rate_limited";
  const exponential = Math.min(MAX_COOLDOWN_MS, MIN_COOLDOWN_MS * (2 ** Math.max(0, failures - 1)));
  const retryAfter = error.retryAfterMs === null
    ? 0
    : Math.min(MAX_COOLDOWN_MS, Math.max(0, error.retryAfterMs));
  const delay = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, exponential, retryAfter));
  const retainPreviousEligibility = candidateReplacement
    && (record.storedStatus === "manual"
      || (configured(record) && (record.storedStatus === "connected" || record.storedStatus === "retry_wait")))
    && record.cookie.length > 0
    && record.deviceId.length > 0;
  return {
    status: (retainPreviousEligibility ? record.storedStatus : transient ? "retry_wait" : "attention") as ProviderAuthState,
    errorCode: error.code,
    retryAt: new Date(now.getTime() + delay).toISOString(),
    failures,
  };
}

function safeError(error: unknown): ProviderAuthError {
  return error instanceof ProviderAuthError
    ? error
    : new ProviderAuthError("provider_unavailable");
}

export function createProviderAuthService(
  dependencies: ProviderAuthServiceDependencies = {},
): ProviderAuthService {
  const repository = dependencies.repository ?? defaultRepository;
  const client = dependencies.client ?? defaultClient;
  const clock = dependencies.clock ?? (() => new Date());
  const flights = new Map<number, Promise<boolean>>();
  const recoveryFlights = new Map<number, Promise<boolean>>();

  async function authenticate(
    teamId: number,
    candidate: ProviderCredentials | null,
    throwFailure: boolean,
    automaticTrigger: { expectedEpoch: number; reason: "proactive" | "reactive" } | null,
  ): Promise<boolean> {
    const existingFlight = flights.get(teamId);
    if (existingFlight) {
      if (throwFailure) throw new ProviderAuthError("busy");
      return existingFlight;
    }

    const operation = (async () => {
      const now = clock();
      const before = await repository.getTeamProviderAuth(teamId);
      if (!before) {
        if (throwFailure) throw new ProviderAuthError("not_configured");
        return false;
      }
      const remaining = cooldownRemaining(before, now);
      if (remaining > 0) {
        if (throwFailure) throw new ProviderAuthError("rate_limited", remaining);
        return false;
      }
      const manualRemaining = automaticTrigger === null
        ? manualSuccessCooldownRemaining(before, now)
        : 0;
      if (manualRemaining > 0) {
        if (throwFailure) throw new ProviderAuthError("rate_limited", manualRemaining);
        return false;
      }
      const lease = await repository.acquireTeamProviderAuthLease(teamId, now);
      if (!lease) {
        if (throwFailure) throw new ProviderAuthError("busy");
        return false;
      }
      const owned = await repository.getTeamProviderAuth(teamId);
      if (!owned || owned.epoch !== lease.epoch) {
        await repository.releaseTeamProviderAuthLease(lease, clock());
        if (throwFailure) throw new ProviderAuthError("stale_operation");
        return false;
      }
      if (automaticTrigger && owned.epoch !== automaticTrigger.expectedEpoch) {
        await repository.releaseTeamProviderAuthLease(lease, clock());
        return false;
      }
      const ownedCooldown = cooldownRemaining(owned, clock());
      if (ownedCooldown > 0) {
        await repository.releaseTeamProviderAuthLease(lease, clock());
        if (throwFailure) throw new ProviderAuthError("rate_limited", ownedCooldown);
        return false;
      }
      const ownedManualRemaining = automaticTrigger === null
        ? manualSuccessCooldownRemaining(owned, clock())
        : 0;
      if (ownedManualRemaining > 0) {
        await repository.releaseTeamProviderAuthLease(lease, clock());
        if (throwFailure) throw new ProviderAuthError("rate_limited", ownedManualRemaining);
        return false;
      }
      const proactiveStillDue = automaticTrigger?.reason !== "proactive"
        || (owned.expiresAt !== null
          && Number.isFinite(Date.parse(owned.expiresAt))
          && Date.parse(owned.expiresAt) <= clock().getTime() + REFRESH_MARGIN_MS);
      if (automaticTrigger && (
        !owned.enabled
        || !configured(owned)
        || owned.storedStatus === "attention"
        || !proactiveStillDue
      )) {
        await repository.releaseTeamProviderAuthLease(lease, clock());
        return false;
      }
      if (!candidate && !configured(owned)) {
        await repository.releaseTeamProviderAuthLease(lease, clock());
        if (throwFailure) throw new ProviderAuthError("not_configured");
        return false;
      }
      const credentials = candidate ?? { email: owned.email, password: owned.password };
      try {
        const session = await client.login(credentials, owned.deviceId ? { deviceId: owned.deviceId } : {});
        const committed = await repository.commitTeamProviderAuth(lease, credentials, session, clock());
        if (!committed) {
          const stale = new ProviderAuthError("stale_operation");
          if (throwFailure) throw stale;
          return false;
        }
        return true;
      } catch (error) {
        const mapped = safeError(error);
        await repository.failTeamProviderAuth(
          lease,
          nextFailure(owned, mapped, clock(), candidate !== null),
          clock(),
        );
        if (throwFailure) throw mapped;
        return false;
      }
    })();
    flights.set(teamId, operation);
    try {
      return await operation;
    } finally {
      if (flights.get(teamId) === operation) flights.delete(teamId);
    }
  }

  async function reload(teamId: number): Promise<ProviderAuthRecord | null> {
    return repository.getTeamProviderAuth(teamId);
  }

  async function recoverSession(teamId: number, rejectedEpoch: number): Promise<boolean> {
    const current = await reload(teamId);
    if (!current) return false;
    if (current.epoch !== rejectedEpoch) return true;
    if (!current.enabled || !configured(current) || current.storedStatus === "attention" || cooldownRemaining(current, clock()) > 0) return false;

    // Share the database lease with password login so separate owners cannot
    // multiply identity probes or overwrite a newer account's cooldown.
    const lease = await repository.acquireTeamProviderAuthLease(teamId, clock());
    if (!lease) return false;
    try {
      const owned = await reload(teamId);
      if (!owned) return false;
      if (owned.epoch !== rejectedEpoch) return true;
      if (owned.epoch !== lease.epoch || !owned.enabled || !configured(owned)
        || owned.storedStatus === "attention" || cooldownRemaining(owned, clock()) > 0) return false;

      const checked = await client.check({
        cookie: owned.cookie,
        deviceId: owned.deviceId,
        expiresAt: owned.expiresAt,
      });
      const afterCheck = await reload(teamId);
      if (!afterCheck) return false;
      if (afterCheck.epoch !== rejectedEpoch) return true;
      if (!afterCheck.enabled || !configured(afterCheck) || afterCheck.storedStatus === "attention"
        || cooldownRemaining(afterCheck, clock()) > 0) return false;
      if (checked.status === "valid") return true;
      if (checked.status === "unavailable") {
        if (checked.errorCode === "provider_unavailable" || checked.errorCode === "rate_limited") {
          const failureTime = clock();
          await repository.failTeamProviderAuth(lease, nextFailure(
            afterCheck,
            new ProviderAuthError(checked.errorCode, checked.retryAfterMs),
            failureTime,
            false,
          ), failureTime);
        }
        return false;
      }
    } finally {
      await repository.releaseTeamProviderAuthLease(lease, clock());
    }

    // Only a confirmed expiry reaches login. Its existing lease/epoch checks
    // revalidate the account after releasing the read-only probe's lease.
    await authenticate(teamId, null, false, { expectedEpoch: rejectedEpoch, reason: "reactive" });
    const recovered = await reload(teamId);
    return Boolean(recovered && recovered.epoch !== rejectedEpoch);
  }

  return {
    async connect(teamId, credentials) {
      const current = await reload(teamId);
      if (!current) throw new ProviderAuthError("not_configured");
      await authenticate(teamId, credentials, true, null);
      return reload(teamId);
    },

    async reconnect(teamId) {
      const current = await reload(teamId);
      if (!current || !configured(current)) throw new ProviderAuthError("not_configured");
      await authenticate(teamId, null, true, null);
      return reload(teamId);
    },

    async ensure(teamId) {
      const current = await reload(teamId);
      if (!current || !current.enabled || !configured(current) || current.storedStatus === "attention") return current;
      if (cooldownRemaining(current, clock()) > 0) return current;
      if (!current.expiresAt) return current;
      const expiresAt = Date.parse(current.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > clock().getTime() + REFRESH_MARGIN_MS) return current;
      await authenticate(teamId, null, false, { expectedEpoch: current.epoch, reason: "proactive" });
      return reload(teamId);
    },

    async recover(teamId, rejectedEpoch) {
      const existing = recoveryFlights.get(teamId);
      if (existing) return existing;
      const operation = recoverSession(teamId, rejectedEpoch);
      recoveryFlights.set(teamId, operation);
      try {
        return await operation;
      } finally {
        if (recoveryFlights.get(teamId) === operation) recoveryFlights.delete(teamId);
      }
    },
  };
}

export const providerAuthService = createProviderAuthService();
