import type { FastifyPluginAsync } from "fastify";
import type { AuthUser } from "../services/authz.js";
import { createRule, deleteRule, previewRuleAgainstTrips, readRules, updateRule, type NotifyRuleInput, type NotifyRulePatch } from "../services/notify-rules.js";
import { getBookingHistory } from "../repositories/booking-history-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { sendSuccess, sendError } from "../utils/response.js";

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

function toRuleInput(body: Partial<NotifyRuleInput>): NotifyRuleInput {
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    origins: clampStringArray(body.origins),
    destinations: clampStringArray(body.destinations),
    vehicle_types: clampStringArray(body.vehicle_types),
    need: typeof body.need === "number" && body.need >= 0 ? body.need : 1,
    enabled: body.enabled ?? true,
    fulfilled: body.fulfilled ?? false,
    auto_accepted: body.auto_accepted ?? false,
  };
}

function toRulePatch(body: Partial<NotifyRuleInput>): NotifyRulePatch {
  const patch: NotifyRulePatch = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (isStringArray(body.origins)) patch.origins = clampStringArray(body.origins);
  if (isStringArray(body.destinations)) patch.destinations = clampStringArray(body.destinations);
  if (isStringArray(body.vehicle_types)) patch.vehicle_types = clampStringArray(body.vehicle_types);
  if (typeof body.need === "number" && body.need >= 0) patch.need = body.need;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.fulfilled === "boolean") patch.fulfilled = body.fulfilled;
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
    origins: { type: "array", items: { type: "string", maxLength: 255 }, maxItems: MAX_FILTER_ENTRIES },
    destinations: { type: "array", items: { type: "string", maxLength: 255 }, maxItems: MAX_FILTER_ENTRIES },
    vehicle_types: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: MAX_FILTER_ENTRIES },
    need: { type: "integer", minimum: 0, maximum: 1000 },
    enabled: { type: "boolean" },
    fulfilled: { type: "boolean" },
    auto_accept: { type: "boolean" },
    auto_accepted: { type: "boolean" },
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
  rule: NotifyRuleInput;
  limit?: number;
  sampleLimit?: number;
};

export const rulesController: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const rules = await readRules();
    return sendSuccess(reply, rules);
  });

  app.post<{ Body: RulePreviewBody }>("/preview", { schema: { body: rulePreviewSchema } }, async (req, reply) => {
    const limit = req.body.limit ?? 200;
    const sampleLimit = req.body.sampleLimit ?? 8;
    const historyRows = await getBookingHistory({ limit, sortBy: "created_at", sortDir: "desc" });
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

  app.post<{ Body: Partial<NotifyRuleInput> }>("/", { schema: { body: ruleSchema } }, async (req, reply) => {
    const newRule = await createRule(toRuleInput(req.body));
    await insertAuditLog(currentUser(req).username, "Add Rule", `Added rule: ${newRule.name}`);
    return sendSuccess(reply, newRule, "Rule created successfully", 201);
  });

  app.put<{ Params: RuleParams; Body: Partial<NotifyRuleInput> }>("/:id", { schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } }, body: ruleSchema } }, async (req, reply) => {
    const updated = await updateRule(req.params.id, toRulePatch(req.body));
    if (!updated) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    await insertAuditLog(currentUser(req).username, "Update Rule", `Updated rule: ${updated.name}`);
    return sendSuccess(reply, updated, "Rule updated successfully");
  });

  app.get<{ Params: RuleParams }>("/:id", async (req, reply) => {
    const rules = await readRules();
    const rule = rules.find((item) => item.id === req.params.id);
    if (!rule) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    return sendSuccess(reply, rule);
  });

  app.delete<{ Params: RuleParams }>("/:id", async (req, reply) => {
    const deleted = await deleteRule(req.params.id);
    if (!deleted) return sendError(reply, 404, "NOT_FOUND", "Rule not found");
    await insertAuditLog(currentUser(req).username, "Delete Rule", `Deleted rule: ${deleted.name}`);
    return sendSuccess(reply, null, "Rule deleted successfully", 204);
  });
};
