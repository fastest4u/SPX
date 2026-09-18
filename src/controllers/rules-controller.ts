import type { FastifyPluginAsync } from "fastify";
import type { AuthUser } from "../services/authz.js";
import { createRule, deleteRule, getRuleTeamId, previewRuleAgainstTrips, readRuleForReview, readRulesForScope, updateRule, type NotifyRule, type NotifyRuleInput, type NotifyRulePatch } from "../services/notify-rules.js";
import { createRuleActivationReview, MAX_RULE_REVIEW_TOKEN_LENGTH, ruleActivationAuditSummary, verifyRuleActivationReview, type ActivationReviewInput } from "../services/rule-activation-review.js";
import { getBookingHistory } from "../repositories/booking-history-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { resolveScopedTeamId } from "../services/team-scope.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { AppError } from "../utils/errors.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const MAX_FILTER_ENTRIES = 200;

function clampStringArray(value: unknown): string[] {
  if (!isStringArray(value)) return [];
  return value.slice(0, MAX_FILTER_ENTRIES).filter((item) => item.trim().length > 0);
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
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new AppError("Rule name must contain non-whitespace characters", 400, "VALIDATION_ERROR");
  const need = typeof body.need === "number" && body.need >= 0 ? body.need : 1;
  return {
    name,
    origins: clampStringArray(body.origins),
    destinations: clampStringArray(body.destinations),
    vehicle_types: clampStringArray(body.vehicle_types),
    need,
    enabled: body.enabled ?? true,
    // DB reads derive completion from need; callers cannot hide an active rule
    // behind a forged fulfilled flag to skip the activation gate.
    fulfilled: need === 0,
    accept_all: allowAcceptAll && body.accept_all === true,
    auto_accepted: need === 0 && body.auto_accepted === true,
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

function effectiveRuleInput(body: Partial<NotifyRuleInput>, user: AuthUser, existing?: NotifyRule): NotifyRuleInput {
  if (!existing) return toRuleInput(body, user.role === "admin");
  // Permission-filter the patch first, then retain the existing admin-only mode.
  return toRuleInput({ ...existing, ...toRulePatch(body, user.role === "admin") }, true);
}

type RuleWriteBody = Partial<NotifyRuleInput> & { teamId?: number; activationReview?: ActivationReviewInput };

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
    activationReview: {
      type: "object",
      additionalProperties: false,
      required: ["token"],
      properties: {
        token: { type: "string", maxLength: MAX_RULE_REVIEW_TOKEN_LENGTH },
        acknowledgeWildcard: { type: "boolean" },
        acknowledgeAcceptAll: { type: "boolean" },
      },
    },
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
    ruleId: { type: "string", minLength: 1, maxLength: 128 },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
    sampleLimit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
  },
} as const;

type RulePreviewBody = {
  rule: NotifyRuleInput & { teamId?: number };
  ruleId?: string;
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
    const user = currentUser(req);
    const teamId = req.body.ruleId
      ? await existingRuleTeamScope(req, req.body.ruleId, bodyTeamId(req.body.rule))
      : createTeamScope(req, bodyTeamId(req.body.rule));
    if (teamId === null) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    const existing = req.body.ruleId ? await readRuleForReview(teamId, req.body.ruleId) : undefined;
    if (req.body.ruleId && !existing) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    const rule = effectiveRuleInput(req.body.rule, user, existing ?? undefined);
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

    const preview = previewRuleAgainstTrips(rule, trips, sampleLimit);
    return sendSuccess(reply, {
      ...preview,
      scannedCount: historyRows.length,
      review: createRuleActivationReview({ user, teamId, rule, existing: existing ?? undefined }),
    });
  });

  app.post<{ Body: RuleWriteBody }>("/", { schema: { body: ruleSchema } }, async (req, reply) => {
    const teamId = createTeamScope(req, bodyTeamId(req.body));
    const user = currentUser(req);
    const rule = effectiveRuleInput(req.body, user);
    const reviewed = verifyRuleActivationReview({ user, teamId, rule }, req.body.activationReview);
    const newRule = await createRule(teamId, rule);
    await insertAuditLog(user.username, "Add Rule", `Added rule: ${newRule.name}; ${ruleActivationAuditSummary(rule, reviewed, req.body.activationReview)}`, { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId });
    return sendSuccess(reply, newRule, "Rule created successfully", 201);
  });

  app.put<{ Params: RuleParams; Body: RuleWriteBody }>("/:id", { schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } }, body: ruleSchema } }, async (req, reply) => {
    const teamId = await existingRuleTeamScope(req, req.params.id, bodyTeamId(req.body));
    if (teamId === null) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    const user = currentUser(req);
    const existing = await readRuleForReview(teamId, req.params.id);
    if (!existing) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    const rule = effectiveRuleInput(req.body, user, existing);
    const reviewed = verifyRuleActivationReview({ user, teamId, rule, existing }, req.body.activationReview);
    // Inactive writes retain partial-patch semantics. Guard their snapshot too:
    // a completed/disabled rule could become active after the initial read.
    const patch = reviewed ? rule : toRulePatch(req.body, user.role === "admin");
    if (!reviewed && (patch.need !== undefined || patch.fulfilled !== undefined || patch.auto_accepted !== undefined)) {
      patch.fulfilled = rule.fulfilled;
      patch.auto_accepted = rule.auto_accepted;
    }
    // An explicit disable always remains available without a review or CAS gate.
    const updated = await updateRule(teamId, req.params.id, patch, req.body.enabled === false ? undefined : existing);
    if (!updated) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    await insertAuditLog(user.username, "Update Rule", `Updated rule: ${updated.name}; ${ruleActivationAuditSummary(updated, reviewed, req.body.activationReview)}`, { actorUserId: user.id, actorTeamId: user.teamId, targetTeamId: teamId });
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
