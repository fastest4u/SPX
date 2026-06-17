import type { FastifyPluginAsync } from "fastify";
import type { AuthUser } from "../services/authz.js";
import { createRule, deleteRule, getRuleTeamId, previewRuleAgainstTrips, readRulesForScope, updateRule, type NotifyRuleInput, type NotifyRulePatch } from "../services/notify-rules.js";
import { getBookingHistory } from "../repositories/booking-history-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { resolveScopedTeamId } from "../services/team-scope.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { AppError } from "../utils/errors.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const MAX_FILTER_ENTRIES = 50;

function clampStringArray(value: unknown): string[] {
  if (!isStringArray(value)) return [];
  return value.slice(0, MAX_FILTER_ENTRIES);
}

interface RuleParams {
  id: string;
}

function currentUser(req: { user?: unknown }): AuthUser {
  return req.user as AuthUser;
}

function queryTeamId(req: { query?: unknown }): number | undefined {
  const query = req.query as { teamId?: number } | undefined;
  return typeof query?.teamId === "number" ? query.teamId : undefined;
}

function bodyTeamId(body: { teamId?: unknown } | undefined): number | undefined {
  return typeof body?.teamId === "number" ? body.teamId : undefined;
}

function listTeamScope(req: { user?: unknown; query?: unknown }): number | null {
  const user = currentUser(req);
  const explicitTeamId = queryTeamId(req);
  if (user.role === "admin" && typeof explicitTeamId !== "number") return null;
  return resolveScopedTeamId(req, explicitTeamId);
}

function createTeamScope(req: { user?: unknown }, explicitTeamId?: number): number {
  const user = currentUser(req);
  if (user.role === "admin" && typeof explicitTeamId !== "number") {
    throw new AppError("Admin requests must include teamId", 400, "TEAM_REQUIRED");
  }
  return resolveScopedTeamId(req, explicitTeamId);
}

async function existingRuleTeamScope(req: { user?: unknown; query?: unknown }, id: string, explicitTeamId?: number): Promise<number | null> {
  const user = currentUser(req);
  if (user.role === "admin") {
    return typeof explicitTeamId === "number" ? explicitTeamId : getRuleTeamId(id);
  }
  return resolveScopedTeamId(req, explicitTeamId);
}

function toRuleInput(body: Partial<NotifyRuleInput>, allowAcceptAll: boolean): NotifyRuleInput {
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    origins: clampStringArray(body.origins),
    destinations: clampStringArray(body.destinations),
    vehicle_types: clampStringArray(body.vehicle_types),
    need: typeof body.need === "number" && body.need >= 0 ? body.need : 1,
    enabled: body.enabled ?? true,
    fulfilled: body.fulfilled ?? false,
    accept_all: allowAcceptAll && body.accept_all === true,
    auto_accepted: body.auto_accepted ?? false,
  };
}

function toRulePatch(body: Partial<NotifyRuleInput>, allowAcceptAll: boolean): NotifyRulePatch {
  const patch: NotifyRulePatch = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (isStringArray(body.origins)) patch.origins = clampStringArray(body.origins);
  if (isStringArray(body.destinations)) patch.destinations = clampStringArray(body.destinations);
  if (isStringArray(body.vehicle_types)) patch.vehicle_types = clampStringArray(body.vehicle_types);
  if (typeof body.need === "number" && body.need >= 0) patch.need = body.need;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.fulfilled === "boolean") patch.fulfilled = body.fulfilled;
  if (allowAcceptAll && typeof body.accept_all === "boolean") patch.accept_all = body.accept_all;
  if (typeof body.auto_accepted === "boolean") patch.auto_accepted = body.auto_accepted;
  return patch;
}

const ruleSchema = {
  type: "object",
  // Allow legacy `auto_accept` field on the wire so older clients don't 400, but ignore it.
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    teamId: { type: "integer", minimum: 1 },
    origins: { type: "array", items: { type: "string", maxLength: 255 }, maxItems: MAX_FILTER_ENTRIES },
    destinations: { type: "array", items: { type: "string", maxLength: 255 }, maxItems: MAX_FILTER_ENTRIES },
    vehicle_types: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: MAX_FILTER_ENTRIES },
    need: { type: "integer", minimum: 0, maximum: 1000 },
    enabled: { type: "boolean" },
    fulfilled: { type: "boolean" },
    auto_accept: { type: "boolean" },
    accept_all: { type: "boolean" },
    auto_accepted: { type: "boolean" },
  },
} as const;

const teamQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    teamId: { type: "integer", minimum: 1 },
  },
} as const;

const rulePreviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rule"],
  properties: {
    rule: ruleSchema,
    limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
    sampleLimit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
  },
} as const;

type RulePreviewBody = {
  rule: NotifyRuleInput & { teamId?: number };
  limit?: number;
  sampleLimit?: number;
};

export const rulesController: FastifyPluginAsync = async (app) => {
  app.get("/", { schema: { querystring: teamQuerySchema } }, async (req, reply) => {
    const teamId = listTeamScope(req);
    const rules = await readRulesForScope(teamId);
    return sendSuccess(reply, rules);
  });

  app.post<{ Body: RulePreviewBody }>("/preview", { schema: { body: rulePreviewSchema } }, async (req, reply) => {
    const limit = req.body.limit ?? 200;
    const sampleLimit = req.body.sampleLimit ?? 8;
    const teamId = createTeamScope(req, bodyTeamId(req.body.rule));
    const historyRows = await getBookingHistory(teamId, { limit, sortBy: "created_at", sortDir: "desc" });
    const trips = historyRows.map((row) => ({
      origin: row.origin ?? "",
      destination: row.destination ?? "",
      vehicle_type: row.vehicleType ?? "",
      request_id: row.requestId,
      booking_id: row.bookingId,
      standby_datetime: row.standbyDateTime,
      created_at: row.createdAt,
    }));

    const preview = previewRuleAgainstTrips(req.body.rule, trips, sampleLimit);
    return sendSuccess(reply, {
      ...preview,
      scannedCount: historyRows.length,
    });
  });

  app.post<{ Body: Partial<NotifyRuleInput> & { teamId?: number } }>("/", { schema: { body: ruleSchema } }, async (req, reply) => {
    const teamId = createTeamScope(req, bodyTeamId(req.body));
    const user = currentUser(req);
    const newRule = await createRule(teamId, toRuleInput(req.body, user.role === "admin"));
    await insertAuditLog(user.username, "Add Rule", `Added rule: ${newRule.name}`, { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId });
    return sendSuccess(reply, newRule, "Rule created successfully", 201);
  });

  app.put<{ Params: RuleParams; Body: Partial<NotifyRuleInput> & { teamId?: number } }>("/:id", { schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } }, body: ruleSchema } }, async (req, reply) => {
    const teamId = await existingRuleTeamScope(req, req.params.id, bodyTeamId(req.body));
    if (teamId === null) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    const user = currentUser(req);
    const updated = await updateRule(teamId, req.params.id, toRulePatch(req.body, user.role === "admin"));
    if (!updated) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    await insertAuditLog(user.username, "Update Rule", `Updated rule: ${updated.name}`, { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId });
    return sendSuccess(reply, updated, "Rule updated successfully");
  });

  app.get<{ Params: RuleParams }>("/:id", { schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } }, querystring: teamQuerySchema } }, async (req, reply) => {
    const teamId = await existingRuleTeamScope(req, req.params.id, queryTeamId(req));
    if (teamId === null) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    const rules = await readRulesForScope(teamId);
    const rule = rules.find((item) => item.id === req.params.id);
    if (!rule) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    return sendSuccess(reply, rule);
  });

  app.delete<{ Params: RuleParams }>("/:id", { schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } }, querystring: teamQuerySchema } }, async (req, reply) => {
    const teamId = await existingRuleTeamScope(req, req.params.id, queryTeamId(req));
    if (teamId === null) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    const deleted = await deleteRule(teamId, req.params.id);
    if (!deleted) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    const user = currentUser(req);
    await insertAuditLog(user.username, "Delete Rule", `Deleted rule: ${deleted.name}`, { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId });
    return sendSuccess(reply, null, "Rule deleted successfully", 204);
  });
};
