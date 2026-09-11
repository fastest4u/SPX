import type { ApiClientCredentials } from "../api-client.js";
import type { ProviderAuthRecord } from "../../models/provider-auth.js";
import { getTeamProviderAuth } from "../../repositories/team-provider-auth-repository.js";
import { providerAuthService, type ProviderAuthService } from "./session-service.js";

const CACHE_REFRESH_MS = 5_000;

export interface TeamRuntimeSession {
  credentials(): ApiClientCredentials;
  beforePoll(): Promise<boolean>;
  recover(): Promise<boolean>;
  dispose(): void;
}

export interface TeamRuntimeSessionDependencies {
  service?: ProviderAuthService;
  load?: (teamId: number) => Promise<ProviderAuthRecord | null>;
  clock?: () => number;
}

function automatic(record: ProviderAuthRecord): boolean {
  return record.storedStatus !== "manual"
    && record.hasPassword
    && record.email.length > 0
    && record.password.length > 0;
}

function pair(record: ProviderAuthRecord): ApiClientCredentials | null {
  if (!record.cookie || !record.deviceId) return null;
  return { spxCookie: record.cookie, spxDeviceId: record.deviceId };
}

export function createTeamRuntimeSession(
  teamId: number,
  initialCredentials: ApiClientCredentials,
  dependencies: TeamRuntimeSessionDependencies = {},
): TeamRuntimeSession {
  const service = dependencies.service ?? providerAuthService;
  const load = dependencies.load ?? getTeamProviderAuth;
  const clock = dependencies.clock ?? Date.now;
  let cached = { ...initialCredentials };
  let current: ProviderAuthRecord | null = null;
  let lastLoadedAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let usable = false;

  function isUsable(record: ProviderAuthRecord | null): boolean {
    if (!record || !pair(record)) return false;
    // Legacy manual credentials remain usable until their provider requests say
    // otherwise. Automatic sessions must additionally be present and not known
    // to be expired; a retained pair is not by itself a polling authorization.
    if (record.storedStatus === "manual") return true;
    if (!automatic(record) || record.storedStatus === "attention") return false;
    if (!record.expiresAt) return true;
    const expiresAt = Date.parse(record.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt > clock();
  }

  function apply(record: ProviderAuthRecord | null): void {
    current = record;
    const updated = record && pair(record);
    if (updated) cached = updated;
    usable = isUsable(record);
  }

  async function reload(force = false): Promise<ProviderAuthRecord | null> {
    if (disposed || (!force && clock() - lastLoadedAt < CACHE_REFRESH_MS)) return current;
    lastLoadedAt = clock();
    const result = await load(teamId);
    if (disposed) return null;
    apply(result);
    return result;
  }

  return {
    credentials: () => ({ ...cached }),

    async beforePoll(): Promise<boolean> {
      const refreshDue = current === null || clock() - lastLoadedAt >= CACHE_REFRESH_MS;
      const record = await reload();
      if (disposed) return false;
      if (refreshDue && record && automatic(record)) {
        const ensured = await service.ensure(teamId);
        if (disposed) return false;
        apply(ensured);
      }
      return usable;
    },

    async recover(): Promise<boolean> {
      const record = current ?? await reload();
      if (disposed || !record || !automatic(record)) return false;
      const recovered = await service.recover(teamId, record.epoch);
      if (disposed || !recovered) return false;
      await reload(true);
      return !disposed && usable;
    },

    dispose(): void {
      disposed = true;
      current = null;
      usable = false;
    },
  };
}
