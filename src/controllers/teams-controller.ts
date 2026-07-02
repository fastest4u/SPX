import type { FastifyPluginAsync } from "fastify";
import { listTeamRuntimeDesiredStates, listTeamRuntimeLeases, type TeamRuntimeDesiredStateValue } from "../repositories/runtime-repository.js";
import { createTeam, disableTeam, getTeamById, listTeams, updateTeam, type TeamInput, type TeamPatch } from "../repositories/team-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import type { AuthUser } from "../services/authz.js";
import type { TeamRuntimeStatusValue } from "../services/team-runtime.js";
import { requireTeamUser } from "../services/team-scope.js";
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

interface EnabledBody {
  enabled: boolean;
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
    || patch.autoAcceptFailureLineGroupId !== undefined;
}

async function listTeamsWithRuntimeStatus() {
  const teams = await listTeams();
  const snapshot = await loadRuntimeStateSnapshot();
  return Promise.all(teams.map((team) => withRuntimeStatus(team, snapshot)));
}

async function getCurrentUserTeam(teamId: number) {
  const team = await getTeamById(teamId);
  return team ? withRuntimeStatus(team) : null;
}

const enabledBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
  },
} as const;

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
    return sendSuccess(reply, await withRuntimeStatus(team), "Team enabled state updated");
  });
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
};
