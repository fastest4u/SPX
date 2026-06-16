import type { FastifyPluginAsync } from "fastify";
import { createTeam, disableTeam, getTeamById, listTeams, updateTeam, type TeamInput, type TeamPatch } from "../repositories/team-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import type { AuthUser } from "../services/authz.js";
import { sendError, sendSuccess } from "../utils/response.js";

type RuntimeTeamAction = (teamId: number) => Promise<unknown>;
type RuntimeAllAction = () => Promise<unknown>;
type RuntimeStatusAction = (teamId: number) => { status: string } | null;

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
  };
}

async function runRuntimeAction(action: RuntimeTeamAction | undefined, teamId: number): Promise<boolean> {
  if (!action) return false;
  await action(teamId);
  return true;
}

async function withRuntimeStatus<T extends { id: number }>(team: T): Promise<T & { runtimeStatus?: string }> {
  const status = runtimeActions.getStatus?.(team.id)?.status;
  return status ? { ...team, runtimeStatus: status } : team;
}

export function patchTouchesRuntime(patch: TeamPatch): boolean {
  return patch.enabled === true
    || patch.spxCookie !== undefined
    || patch.spxDeviceId !== undefined
    || patch.lineGroupId !== undefined;
}

async function listTeamsWithRuntimeStatus() {
  const teams = await listTeams();
  return Promise.all(teams.map(withRuntimeStatus));
}

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
