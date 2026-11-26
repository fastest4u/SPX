import type { FastifyPluginAsync } from "fastify";
import { listTeamRuntimeDesiredStates, listTeamRuntimeLeases, type TeamRuntimeDesiredStateValue } from "../repositories/runtime-repository.js";
import { createTeam, disableTeam, getTeamById, getTeamRuntimeConfig, listTeams, updateTeam, type TeamInput, type TeamPatch } from "../repositories/team-repository.js";
import {
  createAccount,
  deleteAccount,
  getAccountById,
  listAccountsByTeam,
  updateAccount,
  type UpdateTeamSpxAccountInput,
} from "../repositories/team-spx-account-repository.js";
import {
  getDriverCountsByTeam,
  getDriverSummaryByTeam,
  listDriversByTeam,
  setAllTeamDriversEnabled,
  setTeamDriverEnabled,
  summarizeDriverRecords,
  syncTeamDrivers,
} from "../repositories/team-spx-driver-repository.js";
import { ApiClient } from "../services/api-client.js";
import { getOrCreateTeamCredentialPool } from "../services/team-credential-pool.js";
import { reloadTeamDriverPool } from "../services/team-driver-pool.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import type { AuthUser } from "../services/authz.js";
import type { TeamRuntimeStatusValue } from "../services/team-runtime.js";
import { requireTeamUser } from "../services/team-scope.js";
import { loginProvider, ProviderAuthError } from "../services/provider-auth/client.js";
import { sendError, sendSuccess } from "../utils/response.js";

type RuntimeTeamAction = (teamId: number) => Promise<unknown>;
type RuntimeAllAction = () => Promise<unknown>;
type RuntimeStatusAction = (teamId: number) => { status: string } | null;
type RuntimeStatusTeam = {
  id: number;
  enabled: boolean;
  hasSpxCookie: boolean;
  hasSpxDeviceId: boolean;
};
type RuntimeLeaseStatus = {
  teamId: number;
  status: string;
  leaseExpiresAt: Date | string;
};

interface RuntimeStateSnapshot {
  desiredStates: Map<number, TeamRuntimeDesiredStateValue>;
  leases: Map<number, RuntimeLeaseStatus>;
  now: Date;
}

interface ResolveTeamRuntimeStatusInput {
  team: RuntimeStatusTeam;
  localStatus?: { status: string } | null;
  desiredState?: TeamRuntimeDesiredStateValue;
  lease?: RuntimeLeaseStatus;
  now?: Date;
}

interface TeamRuntimeActions {
  restartTeam?: RuntimeTeamAction;
  pauseTeam?: RuntimeTeamAction;
  resumeTeam?: RuntimeTeamAction;
  stopTeam?: RuntimeTeamAction;
  restartAll?: RuntimeAllAction;
  getStatus?: RuntimeStatusAction;
}

let runtimeActions: TeamRuntimeActions = {};

export function setTeamRuntimeActions(actions: TeamRuntimeActions): void {
  runtimeActions = actions;
}

interface IdParams {
  id: string;
}

interface TeamAccountParams {
  id: string;
  accountId: string;
}

interface OwnTeamAccountParams {
  accountId: string;
}

interface TeamDriverParams {
  id: string;
  driverId: string;
}

interface OwnTeamDriverParams {
  driverId: string;
}

interface BulkDriverEnabledBody {
  enabled: boolean;
  vehicleType?: number;
}

interface EnabledBody {
  enabled: boolean;
}

async function listTeamDriversPayload(teamId: number) {
  const drivers = await listDriversByTeam(teamId);
  return { drivers, summary: summarizeDriverRecords(drivers) };
}

type SyncTeamDriversOutcome =
  | {
      ok: true;
      data: Awaited<ReturnType<typeof syncTeamDrivers>>;
    }
  | { ok: false; statusCode: number; errorCode: string; message: string };

const driverSyncInFlightByTeam = new Map<number, Promise<SyncTeamDriversOutcome>>();

async function executeSyncTeamDriversFromSpx(teamId: number): Promise<SyncTeamDriversOutcome> {
  const team = await getTeamRuntimeConfig(teamId);
  if (!team) {
    return { ok: false, statusCode: 404, errorCode: "NOT_FOUND", message: "Team not found" };
  }
  const fallback = team.spxCookie && team.spxDeviceId
    ? { spxCookie: team.spxCookie, spxDeviceId: team.spxDeviceId }
    : null;
  const pool = await getOrCreateTeamCredentialPool(teamId, fallback);
  if (!pool.hasCredentials()) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "TEAM_CREDENTIALS_REQUIRED",
      message: "ยังไม่ได้เชื่อมต่อบัญชี SPX ของทีมนี้ กรุณาเชื่อมต่อบัญชีก่อนดึงรายชื่อคนขับ",
    };
  }

  const apiClient = new ApiClient({
    credentialsProvider: () => pool.nextCredentials(),
    onRateLimit: (accountId, retryAfterMs) => {
      pool.recordRateLimit(accountId, retryAfterMs);
    },
    onSessionExpired: (accountId) => {
      pool.recordSessionExpired(accountId);
    },
  });

  const fetched = await apiClient.fetchLinehaulDrivers({ count: 5000 });
  if (!fetched.ok) {
    // Never return HTTP 401 for upstream SPX auth failures: the frontend treats 401 as dashboard JWT expiry and forces logout.
    if (fetched.sessionExpired || fetched.httpStatus === 401 || fetched.httpStatus === 403) {
      return {
        ok: false,
        statusCode: 502,
        errorCode: "SPX_SESSION_EXPIRED",
        message: "เซสชันบัญชี SPX ของทีมนี้หมดอายุหรือถูกปฏิเสธ กรุณาเชื่อมต่อบัญชี SPX ใหม่แล้วลองดึงรายชื่อคนขับอีกครั้ง",
      };
    }
    if (fetched.httpStatus === 429 || fetched.retcode === 130008001) {
      return {
        ok: false,
        statusCode: 429,
        errorCode: "SPX_RATE_LIMITED",
        message: fetched.error || fetched.message || "SPX จำกัดความถี่คำขอชั่วคราว กรุณารอสักครู่แล้วลองใหม่",
      };
    }
    return {
      ok: false,
      statusCode: 502,
      errorCode: "SPX_DRIVER_SYNC_FAILED",
      message: fetched.error || fetched.message || "ดึงรายชื่อคนขับจาก SPX ไม่สำเร็จ",
    };
  }

  const syncResult = await syncTeamDrivers(
    teamId,
    fetched.drivers.map((d) => ({
      driverId: d.driver_id,
      driverName: d.driver_name,
      agencyName: d.agency_name,
      vehicleType: d.vehicle_type,
      vehicleTypeName: d.vehicle_type_name,
    })),
  );
  await reloadTeamDriverPool(teamId);
  return { ok: true, data: syncResult };
}

function syncTeamDriversFromSpx(teamId: number): Promise<SyncTeamDriversOutcome> {
  const existing = driverSyncInFlightByTeam.get(teamId);
  if (existing) return existing;

  const task = executeSyncTeamDriversFromSpx(teamId).finally(() => {
    driverSyncInFlightByTeam.delete(teamId);
  });
  driverSyncInFlightByTeam.set(teamId, task);
  return task;
}

async function listTeamAccountsWithStatus(teamId: number) {
  const accounts = await listAccountsByTeam(teamId);
  const pool = await getOrCreateTeamCredentialPool(teamId);
  const statuses = new Map(pool.getAccountsStatus().map((s) => [s.id, s]));
  return accounts.map((account) => {
    const status = statuses.get(account.id);
    return {
      ...account,
      isRateLimited: status?.isRateLimited ?? false,
      rateLimitedUntil: status?.rateLimitedUntil ?? null,
      isSessionExpired: status?.isSessionExpired ?? false,
    };
  });
}

function currentUser(req: { user?: unknown }): AuthUser {
  return req.user as AuthUser;
}

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

export function toTeamPatch(body: Record<string, unknown>): TeamPatch {
  const patch: TeamPatch = {};

  if ("name" in body) {
    if (typeof body.name !== "string") throw new Error("name must be a string");
    const name = body.name.trim();
    if (!name) throw new Error("name is required");
    patch.name = name;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
    patch.enabled = body.enabled;
  }
  const spxCookie = optionalString(body.spxCookie, "spxCookie");
  if (spxCookie !== undefined) patch.spxCookie = spxCookie;
  const spxDeviceId = optionalString(body.spxDeviceId, "spxDeviceId");
  if (spxDeviceId !== undefined) patch.spxDeviceId = spxDeviceId;
  const lineGroupId = optionalString(body.lineGroupId, "lineGroupId");
  if (lineGroupId !== undefined) patch.lineGroupId = lineGroupId;
  const autoAcceptSuccessLineGroupId = optionalString(body.autoAcceptSuccessLineGroupId, "autoAcceptSuccessLineGroupId");
  if (autoAcceptSuccessLineGroupId !== undefined) patch.autoAcceptSuccessLineGroupId = autoAcceptSuccessLineGroupId;
  const autoAcceptFailureLineGroupId = optionalString(body.autoAcceptFailureLineGroupId, "autoAcceptFailureLineGroupId");
  if (autoAcceptFailureLineGroupId !== undefined) patch.autoAcceptFailureLineGroupId = autoAcceptFailureLineGroupId;
  if ("rateLimitNotifyEnabled" in body) {
    if (typeof body.rateLimitNotifyEnabled !== "boolean") throw new Error("rateLimitNotifyEnabled must be a boolean");
    patch.rateLimitNotifyEnabled = body.rateLimitNotifyEnabled;
  }
  if ("biddingVehicleType" in body) {
    const raw = body.biddingVehicleType;
    if (raw === null || raw === undefined || raw === "") {
      patch.biddingVehicleType = null;
    } else {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("biddingVehicleType must be a positive integer or null");
      patch.biddingVehicleType = parsed;
    }
  }

  return patch;
}


function toTeamInput(body: Record<string, unknown>): TeamInput {
  const patch = toTeamPatch(body);
  if (!patch.name) throw new Error("name is required");
  return {
    name: patch.name,
    enabled: patch.enabled,
    spxCookie: patch.spxCookie,
    spxDeviceId: patch.spxDeviceId,
    lineGroupId: patch.lineGroupId,
    autoAcceptSuccessLineGroupId: patch.autoAcceptSuccessLineGroupId,
    autoAcceptFailureLineGroupId: patch.autoAcceptFailureLineGroupId,
    rateLimitNotifyEnabled: patch.rateLimitNotifyEnabled,
    biddingVehicleType: patch.biddingVehicleType,
  };
}


async function runRuntimeAction(action: RuntimeTeamAction | undefined, teamId: number): Promise<boolean> {
  if (!action) return false;
  await action(teamId);
  return true;
}

const runtimeStatusValues = new Set<TeamRuntimeStatusValue>([
  "stopped",
  "running",
  "paused",
  "misconfigured",
  "session_expired",
  "error",
]);

function normalizeRuntimeStatus(status: string | undefined): TeamRuntimeStatusValue | null {
  return status && runtimeStatusValues.has(status as TeamRuntimeStatusValue)
    ? status as TeamRuntimeStatusValue
    : null;
}

function timeMs(value: Date | string | undefined): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function isActiveLease(lease: RuntimeLeaseStatus | undefined, teamId: number, now: Date): boolean {
  if (!lease || lease.teamId !== teamId) return false;
  const expiresAtMs = timeMs(lease.leaseExpiresAt);
  return expiresAtMs !== null && expiresAtMs > now.getTime();
}

export function resolveTeamRuntimeStatus({
  team,
  localStatus,
  desiredState,
  lease,
  now = new Date(),
}: ResolveTeamRuntimeStatusInput): TeamRuntimeStatusValue {
  const local = normalizeRuntimeStatus(localStatus?.status);
  if (local) return local;

  if (!team.enabled) return "stopped";
  if (!team.hasSpxCookie || !team.hasSpxDeviceId) return "misconfigured";
  if (desiredState === "stopped") return "stopped";

  const hasActiveLease = isActiveLease(lease, team.id, now);
  if (desiredState === "paused" && hasActiveLease) return "paused";

  if (hasActiveLease) {
    return normalizeRuntimeStatus(lease?.status) ?? "running";
  }

  return "stopped";
}

async function loadRuntimeStateSnapshot(): Promise<RuntimeStateSnapshot> {
  const [desiredStates, leases] = await Promise.all([
    listTeamRuntimeDesiredStates(),
    listTeamRuntimeLeases(),
  ]);

  return {
    desiredStates: new Map(desiredStates.map((state) => [state.teamId, state.desiredState])),
    leases: new Map(leases.map((lease) => [lease.teamId, lease])),
    now: new Date(),
  };
}

async function withRuntimeStatus<T extends RuntimeStatusTeam>(team: T, snapshot?: RuntimeStateSnapshot): Promise<T & { runtimeStatus: TeamRuntimeStatusValue }> {
  const runtimeState = snapshot ?? await loadRuntimeStateSnapshot();
  const runtimeStatus = resolveTeamRuntimeStatus({
    team,
    localStatus: runtimeActions.getStatus?.(team.id) ?? null,
    desiredState: runtimeState.desiredStates.get(team.id),
    lease: runtimeState.leases.get(team.id),
    now: runtimeState.now,
  });

  return { ...team, runtimeStatus };
}

export function patchTouchesRuntime(patch: TeamPatch): boolean {
  return patch.enabled === true
    || patch.spxCookie !== undefined
    || patch.spxDeviceId !== undefined
    || patch.lineGroupId !== undefined
    || patch.autoAcceptSuccessLineGroupId !== undefined
    || patch.autoAcceptFailureLineGroupId !== undefined
    || patch.biddingVehicleType !== undefined;
}

async function listTeamsWithRuntimeStatus() {
  const [teams, snapshot, driverCounts] = await Promise.all([
    listTeams(),
    loadRuntimeStateSnapshot(),
    getDriverCountsByTeam(),
  ]);
  return Promise.all(
    teams.map(async (team) => {
      const counts = driverCounts.get(team.id);
      return {
        ...(await withRuntimeStatus(team, snapshot)),
        driversCount: counts?.total ?? 0,
        enabledDriversCount: counts?.enabled ?? 0,
      };
    }),
  );
}

async function getCurrentUserTeam(teamId: number) {
  const [team, summary] = await Promise.all([
    getTeamById(teamId),
    getDriverSummaryByTeam(teamId),
  ]);
  if (!team) return null;
  return {
    ...(await withRuntimeStatus(team)),
    driversCount: summary.total,
    enabledDriversCount: summary.enabled,
  };
}

const bulkDriverEnabledBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
    vehicleType: { type: "integer", minimum: 1 },
  },
} as const;

const enabledBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
  },
} as const;

interface ResolvedAccountCredentials {
  name?: string;
  email?: string;
  password?: string;
  spxCookie?: string;
  spxDeviceId?: string;
  spxAppName?: string;
  spxReferer?: string;
  enabled?: boolean;
  expiresAt?: string | null;
}

async function resolveAccountCredentials(
  body: Record<string, unknown>,
  isCreate: boolean,
): Promise<
  | { success: true; data: ResolvedAccountCredentials }
  | { success: false; statusCode: number; errorCode: string; message: string }
> {
  const rawEmail = typeof body?.email === "string" ? body.email.trim() : "";
  const rawPassword = typeof body?.password === "string" ? body.password : "";
  const rawName = typeof body?.name === "string" ? body.name.trim() : "";
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : undefined;

  let spxCookie = typeof body?.spxCookie === "string" ? body.spxCookie.trim() : undefined;
  let spxDeviceId = typeof body?.spxDeviceId === "string" ? body.spxDeviceId.trim() : undefined;
  const spxAppName = typeof body?.spxAppName === "string" ? body.spxAppName.trim() : (isCreate ? "SPX Express" : undefined);
  const spxReferer = typeof body?.spxReferer === "string" ? body.spxReferer.trim() : (isCreate ? "https://spx.co.th/" : undefined);
  let expiresAt: string | null = null;

  if (rawPassword) {
    const loginEmail = rawEmail || (rawName.includes("@") ? rawName : "");
    if (!loginEmail) {
      return {
        success: false,
        statusCode: 400,
        errorCode: "VALIDATION_ERROR",
        message: "กรุณาระบุอีเมลสำหรับเข้าสู่ระบบ SPX",
      };
    }
    try {
      const session = await loginProvider({ email: loginEmail, password: rawPassword });
      spxCookie = session.cookie;
      spxDeviceId = session.deviceId;
      expiresAt = session.expiresAt;
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        if (err.code === "invalid_credentials") {
          return {
            success: false,
            statusCode: 401,
            errorCode: "INVALID_CREDENTIALS",
            message: "อีเมลหรือรหัสผ่าน SPX ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่อีกครั้ง",
          };
        }
        if (err.code === "challenge_required") {
          return {
            success: false,
            statusCode: 400,
            errorCode: "CHALLENGE_REQUIRED",
            message: "ผู้ให้บริการต้องการยืนยันตัวตน (Captcha/Challenge) กรุณาเข้าสู่ MyAgencyService เพื่อยืนยันตัวตนให้เสร็จสิ้นก่อน",
          };
        }
        if (err.code === "rate_limited") {
          return {
            success: false,
            statusCode: 429,
            errorCode: "RATE_LIMITED",
            message: "บัญชีนี้ถูกจำกัดการลองใหม่ชั่วคราว กรุณารอสักครู่",
          };
        }
        return {
          success: false,
          statusCode: 400,
          errorCode: "AUTH_FAILED",
          message: `เข้าสู่ระบบ SPX ไม่สำเร็จ (${err.code})`,
        };
      }
      return {
        success: false,
        statusCode: 500,
        errorCode: "LOGIN_ERROR",
        message: err instanceof Error ? err.message : "เข้าสู่ระบบ SPX ไม่สำเร็จ",
      };
    }
  }

  const name = rawName || rawEmail;
  const email = rawEmail || (name.includes("@") ? name : "");

  if (isCreate) {
    if (!name) {
      return {
        success: false,
        statusCode: 400,
        errorCode: "VALIDATION_ERROR",
        message: "กรุณาระบุอีเมลหรือชื่อบัญชี SPX",
      };
    }
    if (!spxCookie) {
      return {
        success: false,
        statusCode: 400,
        errorCode: "VALIDATION_ERROR",
        message: "กรุณาระบุรหัสผ่านเพื่อเข้าสู่ระบบ SPX",
      };
    }
  }

  return {
    success: true,
    data: {
      name: name || undefined,
      email: email || undefined,
      password: rawPassword || undefined,
      spxCookie,
      spxDeviceId,
      spxAppName,
      spxReferer,
      enabled: enabled ?? (isCreate ? true : undefined),
      expiresAt,
    },
  };
}

export const currentTeamController: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const teamId = requireTeamUser(req);
    const team = await getCurrentUserTeam(teamId);
    if (!team) return sendError(reply, 404, "NOT_FOUND", "Team not found");
    return sendSuccess(reply, team);
  });

  app.put<{ Body: EnabledBody }>("/enabled", { schema: { body: enabledBodySchema } }, async (req, reply) => {
    const teamId = requireTeamUser(req);
    const user = currentUser(req);
    const team = await updateTeam(teamId, { enabled: req.body.enabled });
    if (!team) return sendError(reply, 404, "NOT_FOUND", "Team not found");

    if (req.body.enabled) {
      await runtimeActions.restartTeam?.(teamId);
    } else {
      await runtimeActions.stopTeam?.(teamId);
    }

    await insertAuditLog(
      user.username,
      req.body.enabled ? "Enable Own Team" : "Disable Own Team",
      `${req.body.enabled ? "Enabled" : "Disabled"} team ${teamId}: ${team.name}`,
      { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId },
    );
    return sendSuccess(reply, (await getCurrentUserTeam(teamId)) ?? (await withRuntimeStatus(team)), "Team enabled state updated");
  });

  app.get("/spx-accounts", async (req, reply) => {
    const teamId = requireTeamUser(req);
    return sendSuccess(reply, await listTeamAccountsWithStatus(teamId));
  });

  app.post("/spx-accounts", async (req, reply) => {
    const teamId = requireTeamUser(req);
    const body = req.body as Record<string, unknown>;
    const resolved = await resolveAccountCredentials(body, true);
    if (!resolved.success) {
      return sendError(reply, resolved.statusCode, resolved.errorCode, resolved.message);
    }

    const created = await createAccount({
      teamId,
      name: resolved.data.name ?? "SPX Account",
      spxEmail: resolved.data.email ?? "",
      spxPassword: resolved.data.password,
      spxCookie: resolved.data.spxCookie ?? "",
      spxDeviceId: resolved.data.spxDeviceId,
      spxAppName: resolved.data.spxAppName,
      spxReferer: resolved.data.spxReferer,
      spxAuthStatus: "connected",
      spxSessionExpiresAt: resolved.data.expiresAt ? new Date(resolved.data.expiresAt) : null,
      spxLastLoginAt: new Date(),
      enabled: resolved.data.enabled ?? true,
    });

    const pool = await getOrCreateTeamCredentialPool(teamId);
    await pool.reloadAccounts();

    const user = currentUser(req);
    await insertAuditLog(
      user.username,
      "Create Team SPX Account",
      `Created SPX account ${created.id} (${created.name}) for own team ${teamId}`,
      { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId },
    );

    return sendSuccess(reply, created, "SPX account created", 201);
  });

  app.put<{ Params: OwnTeamAccountParams }>("/spx-accounts/:accountId", async (req, reply) => {
    const teamId = requireTeamUser(req);
    const accountId = parseId(req.params.accountId);
    if (!accountId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid account id");

    const existing = await getAccountById(accountId);
    if (!existing || existing.teamId !== teamId) return sendError(reply, 404, "NOT_FOUND", "SPX account not found");

    const body = req.body as Record<string, unknown>;
    const resolved = await resolveAccountCredentials(body, false);
    if (!resolved.success) {
      return sendError(reply, resolved.statusCode, resolved.errorCode, resolved.message);
    }

    const patch: UpdateTeamSpxAccountInput = {};
    if (resolved.data.name !== undefined) patch.name = resolved.data.name;
    if (resolved.data.email !== undefined) patch.spxEmail = resolved.data.email;
    if (resolved.data.password !== undefined) patch.spxPassword = resolved.data.password;
    if (resolved.data.spxCookie !== undefined) patch.spxCookie = resolved.data.spxCookie;
    if (resolved.data.spxDeviceId !== undefined) patch.spxDeviceId = resolved.data.spxDeviceId;
    if (resolved.data.spxAppName !== undefined) patch.spxAppName = resolved.data.spxAppName;
    if (resolved.data.spxReferer !== undefined) patch.spxReferer = resolved.data.spxReferer;
    if (resolved.data.expiresAt !== undefined) {
      patch.spxSessionExpiresAt = resolved.data.expiresAt ? new Date(resolved.data.expiresAt) : null;
    }
    if (resolved.data.password) {
      patch.spxAuthStatus = "connected";
      patch.spxAuthError = null;
      patch.spxLastLoginAt = new Date();
    }
    if (typeof resolved.data.enabled === "boolean") patch.enabled = resolved.data.enabled;

    const updated = await updateAccount(accountId, patch);
    const pool = await getOrCreateTeamCredentialPool(teamId);
    await pool.reloadAccounts();

    const user = currentUser(req);
    await insertAuditLog(
      user.username,
      "Update Team SPX Account",
      `Updated SPX account ${accountId} for own team ${teamId}`,
      { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId },
    );

    return sendSuccess(reply, updated, "SPX account updated");
  });

  app.delete<{ Params: OwnTeamAccountParams }>("/spx-accounts/:accountId", async (req, reply) => {
    const teamId = requireTeamUser(req);
    const accountId = parseId(req.params.accountId);
    if (!accountId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid account id");

    const existing = await getAccountById(accountId);
    if (!existing || existing.teamId !== teamId) return sendError(reply, 404, "NOT_FOUND", "SPX account not found");

    await deleteAccount(accountId);
    const pool = await getOrCreateTeamCredentialPool(teamId);
    await pool.reloadAccounts();

    const user = currentUser(req);
    await insertAuditLog(
      user.username,
      "Delete Team SPX Account",
      `Deleted SPX account ${accountId} from own team ${teamId}`,
      { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId },
    );

    return sendSuccess(reply, null, "SPX account deleted");
  });

  app.post<{ Params: OwnTeamAccountParams }>("/spx-accounts/:accountId/reset-rate-limit", async (req, reply) => {
    const teamId = requireTeamUser(req);
    const accountId = parseId(req.params.accountId);
    if (!accountId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid account id");

    const pool = await getOrCreateTeamCredentialPool(teamId);
    pool.clearRateLimits();
    pool.clearSessionExpired(accountId);

    const user = currentUser(req);
    await insertAuditLog(
      user.username,
      "Reset Account Rate Limit",
      `Reset rate limit for SPX account ${accountId} in own team ${teamId}`,
      { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId },
    );

    return sendSuccess(reply, null, "Account rate limit reset");
  });

  app.get("/spx-drivers", async (req, reply) => {
    const teamId = requireTeamUser(req);
    return sendSuccess(reply, await listTeamDriversPayload(teamId));
  });

  app.post("/spx-drivers/sync", async (req, reply) => {
    const teamId = requireTeamUser(req);
    const result = await syncTeamDriversFromSpx(teamId);
    if (!result.ok) {
      return sendError(reply, result.statusCode, result.errorCode, result.message);
    }

    const user = currentUser(req);
    await insertAuditLog(
      user.username,
      "Sync Team SPX Drivers",
      `Synced ${result.data.synced} SPX drivers (inserted=${result.data.inserted}, updated=${result.data.updated}, removed=${result.data.removed}) for own team ${teamId}`,
      { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId },
    );

    return sendSuccess(reply, result.data, "SPX drivers synced");
  });

  app.put<{ Body: BulkDriverEnabledBody }>(
    "/spx-drivers/bulk-enabled",
    { schema: { body: bulkDriverEnabledBodySchema } },
    async (req, reply) => {
      const teamId = requireTeamUser(req);
      const updatedCount = await setAllTeamDriversEnabled(teamId, req.body.enabled, req.body.vehicleType);
      await reloadTeamDriverPool(teamId);

      const user = currentUser(req);
      await insertAuditLog(
        user.username,
        "Bulk Update Team SPX Drivers",
        `Set enabled=${req.body.enabled} for ${updatedCount} drivers (vehicleType=${req.body.vehicleType ?? "all"}) in own team ${teamId}`,
        { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId },
      );

      return sendSuccess(reply, { updatedCount, ...(await listTeamDriversPayload(teamId)) }, "SPX drivers updated");
    },
  );

  app.put<{ Params: OwnTeamDriverParams; Body: EnabledBody }>(
    "/spx-drivers/:driverId",
    { schema: { body: enabledBodySchema } },
    async (req, reply) => {
      const teamId = requireTeamUser(req);
      const driverId = parseId(req.params.driverId);
      if (!driverId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid driver id");

      const updated = await setTeamDriverEnabled(teamId, driverId, req.body.enabled);
      if (!updated) return sendError(reply, 404, "NOT_FOUND", "SPX driver not found");
      await reloadTeamDriverPool(teamId);

      const user = currentUser(req);
      await insertAuditLog(
        user.username,
        "Update Team SPX Driver",
        `Set driver ${driverId} (${updated.driverName}) enabled=${req.body.enabled} for own team ${teamId}`,
        { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId },
      );

      return sendSuccess(reply, updated, "SPX driver updated");
    },
  );
};

export const teamsController: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    return sendSuccess(reply, await listTeamsWithRuntimeStatus());
  });

  app.post("/", async (req, reply) => {
    let input: TeamInput;
    try {
      input = toTeamInput(req.body as Record<string, unknown>);
    } catch (error) {
      return sendError(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : String(error));
    }

    const team = await createTeam(input);
    await insertAuditLog(currentUser(req).username, "Create Team", `Created team ${team.id}: ${team.name}`);
    return sendSuccess(reply, await withRuntimeStatus(team), "Team created", 201);
  });

  app.post("/restart-all", async (req, reply) => {
    if (!runtimeActions.restartAll) return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "Team runtime manager is not available");
    await runtimeActions.restartAll();
    await insertAuditLog(currentUser(req).username, "Restart All Teams", "Restarted all team runtimes");
    return sendSuccess(reply, await listTeamsWithRuntimeStatus(), "All team runtimes restarted");
  });

  app.get<{ Params: IdParams }>("/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    const team = await getTeamById(id);
    if (!team) return sendError(reply, 404, "NOT_FOUND", "Team not found");
    return sendSuccess(reply, await withRuntimeStatus(team));
  });

  app.put<{ Params: IdParams }>("/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    let patch: TeamPatch;
    try {
      patch = toTeamPatch(req.body as Record<string, unknown>);
    } catch (error) {
      return sendError(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : String(error));
    }

    const team = await updateTeam(id, patch);
    if (!team) return sendError(reply, 404, "NOT_FOUND", "Team not found");
    if (patch.enabled === false) {
      await runtimeActions.stopTeam?.(id);
    } else if (team.enabled && patchTouchesRuntime(patch)) {
      await runtimeActions.restartTeam?.(id);
    }
    await insertAuditLog(currentUser(req).username, "Update Team", `Updated team ${id}: ${team.name}`);
    return sendSuccess(reply, await withRuntimeStatus(team), "Team updated");
  });

  app.post<{ Params: IdParams }>("/:id/disable", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    const disabled = await disableTeam(id);
    if (!disabled) return sendError(reply, 404, "NOT_FOUND", "Team not found");
    await runtimeActions.stopTeam?.(id);
    await insertAuditLog(currentUser(req).username, "Disable Team", `Disabled team ${id}`);
    return sendSuccess(reply, null, "Team disabled");
  });

  app.post<{ Params: IdParams }>("/:id/restart-poller", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    if (!(await runRuntimeAction(runtimeActions.restartTeam, id))) return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "Team runtime manager is not available");
    await insertAuditLog(currentUser(req).username, "Restart Team Poller", `Restarted team ${id}`);
    const team = await getTeamById(id);
    return sendSuccess(reply, team ? await withRuntimeStatus(team) : null, "Team poller restarted");
  });

  app.post<{ Params: IdParams }>("/:id/pause", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    if (!(await runRuntimeAction(runtimeActions.pauseTeam, id))) return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "Team runtime manager is not available");
    await insertAuditLog(currentUser(req).username, "Pause Team Poller", `Paused team ${id}`);
    const team = await getTeamById(id);
    return sendSuccess(reply, team ? await withRuntimeStatus(team) : null, "Team poller paused");
  });

  app.post<{ Params: IdParams }>("/:id/resume", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    if (!(await runRuntimeAction(runtimeActions.resumeTeam, id))) return sendError(reply, 503, "RUNTIME_UNAVAILABLE", "Team runtime manager is not available");
    await insertAuditLog(currentUser(req).username, "Resume Team Poller", `Resumed team ${id}`);
    const team = await getTeamById(id);
    return sendSuccess(reply, team ? await withRuntimeStatus(team) : null, "Team poller resumed");
  });

  app.get<{ Params: IdParams }>("/:id/spx-accounts", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    const team = await getTeamById(id);
    if (!team) return sendError(reply, 404, "NOT_FOUND", "Team not found");
    return sendSuccess(reply, await listTeamAccountsWithStatus(id));
  });

  app.post<{ Params: IdParams }>("/:id/spx-accounts", async (req, reply) => {
    const teamId = parseId(req.params.id);
    if (!teamId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    const team = await getTeamById(teamId);
    if (!team) return sendError(reply, 404, "NOT_FOUND", "Team not found");

    const body = req.body as Record<string, unknown>;
    const resolved = await resolveAccountCredentials(body, true);
    if (!resolved.success) {
      return sendError(reply, resolved.statusCode, resolved.errorCode, resolved.message);
    }

    const created = await createAccount({
      teamId,
      name: resolved.data.name ?? "SPX Account",
      spxEmail: resolved.data.email ?? "",
      spxPassword: resolved.data.password,
      spxCookie: resolved.data.spxCookie ?? "",
      spxDeviceId: resolved.data.spxDeviceId,
      spxAppName: resolved.data.spxAppName,
      spxReferer: resolved.data.spxReferer,
      spxAuthStatus: "connected",
      spxSessionExpiresAt: resolved.data.expiresAt ? new Date(resolved.data.expiresAt) : null,
      spxLastLoginAt: new Date(),
      enabled: resolved.data.enabled ?? true,
    });

    const pool = await getOrCreateTeamCredentialPool(teamId);
    await pool.reloadAccounts();

    if (team.enabled) {
      await runtimeActions.restartTeam?.(teamId);
    }

    await insertAuditLog(
      currentUser(req).username,
      "Create Team SPX Account",
      `Created SPX account ${created.id} (${created.name}) for team ${teamId}`,
      { targetTeamId: teamId },
    );

    return sendSuccess(reply, created, "SPX account created", 201);
  });

  app.put<{ Params: TeamAccountParams }>("/:id/spx-accounts/:accountId", async (req, reply) => {
    const teamId = parseId(req.params.id);
    const accountId = parseId(req.params.accountId);
    if (!teamId || !accountId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team or account id");

    const existing = await getAccountById(accountId);
    if (!existing || existing.teamId !== teamId) return sendError(reply, 404, "NOT_FOUND", "SPX account not found");

    const body = req.body as Record<string, unknown>;
    const resolved = await resolveAccountCredentials(body, false);
    if (!resolved.success) {
      return sendError(reply, resolved.statusCode, resolved.errorCode, resolved.message);
    }

    const patch: UpdateTeamSpxAccountInput = {};
    if (resolved.data.name !== undefined) patch.name = resolved.data.name;
    if (resolved.data.email !== undefined) patch.spxEmail = resolved.data.email;
    if (resolved.data.password !== undefined) patch.spxPassword = resolved.data.password;
    if (resolved.data.spxCookie !== undefined) patch.spxCookie = resolved.data.spxCookie;
    if (resolved.data.spxDeviceId !== undefined) patch.spxDeviceId = resolved.data.spxDeviceId;
    if (resolved.data.spxAppName !== undefined) patch.spxAppName = resolved.data.spxAppName;
    if (resolved.data.spxReferer !== undefined) patch.spxReferer = resolved.data.spxReferer;
    if (resolved.data.expiresAt !== undefined) {
      patch.spxSessionExpiresAt = resolved.data.expiresAt ? new Date(resolved.data.expiresAt) : null;
    }
    if (resolved.data.password) {
      patch.spxAuthStatus = "connected";
      patch.spxAuthError = null;
      patch.spxLastLoginAt = new Date();
    }
    if (typeof resolved.data.enabled === "boolean") patch.enabled = resolved.data.enabled;

    const updated = await updateAccount(accountId, patch);
    const pool = await getOrCreateTeamCredentialPool(teamId);
    await pool.reloadAccounts();

    await insertAuditLog(
      currentUser(req).username,
      "Update Team SPX Account",
      `Updated SPX account ${accountId} for team ${teamId}`,
      { targetTeamId: teamId },
    );

    return sendSuccess(reply, updated, "SPX account updated");
  });

  app.delete<{ Params: TeamAccountParams }>("/:id/spx-accounts/:accountId", async (req, reply) => {
    const teamId = parseId(req.params.id);
    const accountId = parseId(req.params.accountId);
    if (!teamId || !accountId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team or account id");

    const existing = await getAccountById(accountId);
    if (!existing || existing.teamId !== teamId) return sendError(reply, 404, "NOT_FOUND", "SPX account not found");

    await deleteAccount(accountId);
    const pool = await getOrCreateTeamCredentialPool(teamId);
    await pool.reloadAccounts();

    await insertAuditLog(
      currentUser(req).username,
      "Delete Team SPX Account",
      `Deleted SPX account ${accountId} from team ${teamId}`,
      { targetTeamId: teamId },
    );

    return sendSuccess(reply, null, "SPX account deleted");
  });

  app.post<{ Params: TeamAccountParams }>("/:id/spx-accounts/:accountId/reset-rate-limit", async (req, reply) => {
    const teamId = parseId(req.params.id);
    const accountId = parseId(req.params.accountId);
    if (!teamId || !accountId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team or account id");

    const pool = await getOrCreateTeamCredentialPool(teamId);
    pool.clearRateLimits();
    pool.clearSessionExpired(accountId);

    await insertAuditLog(
      currentUser(req).username,
      "Reset Account Rate Limit",
      `Reset rate limit for SPX account ${accountId} in team ${teamId}`,
      { targetTeamId: teamId },
    );

    return sendSuccess(reply, null, "Account rate limit reset");
  });

  app.get<{ Params: IdParams }>("/:id/spx-drivers", async (req, reply) => {
    const teamId = parseId(req.params.id);
    if (!teamId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    const team = await getTeamById(teamId);
    if (!team) return sendError(reply, 404, "NOT_FOUND", "Team not found");
    return sendSuccess(reply, await listTeamDriversPayload(teamId));
  });

  app.post<{ Params: IdParams }>("/:id/spx-drivers/sync", async (req, reply) => {
    const teamId = parseId(req.params.id);
    if (!teamId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    const result = await syncTeamDriversFromSpx(teamId);
    if (!result.ok) {
      return sendError(reply, result.statusCode, result.errorCode, result.message);
    }

    await insertAuditLog(
      currentUser(req).username,
      "Sync Team SPX Drivers",
      `Synced ${result.data.synced} SPX drivers (inserted=${result.data.inserted}, updated=${result.data.updated}, removed=${result.data.removed}) for team ${teamId}`,
      { targetTeamId: teamId },
    );

    return sendSuccess(reply, result.data, "SPX drivers synced");
  });

  app.put<{ Params: IdParams; Body: BulkDriverEnabledBody }>(
    "/:id/spx-drivers/bulk-enabled",
    { schema: { body: bulkDriverEnabledBodySchema } },
    async (req, reply) => {
      const teamId = parseId(req.params.id);
      if (!teamId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
      const team = await getTeamById(teamId);
      if (!team) return sendError(reply, 404, "NOT_FOUND", "Team not found");

      const updatedCount = await setAllTeamDriversEnabled(teamId, req.body.enabled, req.body.vehicleType);
      await reloadTeamDriverPool(teamId);

      await insertAuditLog(
        currentUser(req).username,
        "Bulk Update Team SPX Drivers",
        `Set enabled=${req.body.enabled} for ${updatedCount} drivers (vehicleType=${req.body.vehicleType ?? "all"}) in team ${teamId}`,
        { targetTeamId: teamId },
      );

      return sendSuccess(reply, { updatedCount, ...(await listTeamDriversPayload(teamId)) }, "SPX drivers updated");
    },
  );

  app.put<{ Params: TeamDriverParams; Body: EnabledBody }>(
    "/:id/spx-drivers/:driverId",
    { schema: { body: enabledBodySchema } },
    async (req, reply) => {
      const teamId = parseId(req.params.id);
      const driverId = parseId(req.params.driverId);
      if (!teamId || !driverId) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid team or driver id");

      const updated = await setTeamDriverEnabled(teamId, driverId, req.body.enabled);
      if (!updated) return sendError(reply, 404, "NOT_FOUND", "SPX driver not found");
      await reloadTeamDriverPool(teamId);

      await insertAuditLog(
        currentUser(req).username,
        "Update Team SPX Driver",
        `Set driver ${driverId} (${updated.driverName}) enabled=${req.body.enabled} for team ${teamId}`,
        { targetTeamId: teamId },
      );

      return sendSuccess(reply, updated, "SPX driver updated");
    },
  );
};
