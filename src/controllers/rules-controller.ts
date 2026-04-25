import type { FastifyPluginAsync } from "fastify";
import type { AuthUser } from "../services/authz.js";
import { createRule, deleteRule, readRules, updateRule, type NotifyRuleInput, type NotifyRulePatch } from "../services/notify-rules.js";
import { insertAuditLog } from "../repositories/audit-repository.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
    origins: isStringArray(body.origins) ? body.origins : [],
    destinations: isStringArray(body.destinations) ? body.destinations : [],
    vehicle_types: isStringArray(body.vehicle_types) ? body.vehicle_types : [],
    need: typeof body.need === "number" && body.need >= 1 ? body.need : 1,
    enabled: body.enabled ?? true,
    fulfilled: body.fulfilled ?? false,
  };
}

function toRulePatch(body: Partial<NotifyRuleInput>): NotifyRulePatch {
  const patch: NotifyRulePatch = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (isStringArray(body.origins)) patch.origins = body.origins;
  if (isStringArray(body.destinations)) patch.destinations = body.destinations;
  if (isStringArray(body.vehicle_types)) patch.vehicle_types = body.vehicle_types;
  if (typeof body.need === "number" && body.need >= 1) patch.need = body.need;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.fulfilled === "boolean") patch.fulfilled = body.fulfilled;
  return patch;
}

const ruleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    origins: { type: "array", items: { type: "string" } },
    destinations: { type: "array", items: { type: "string" } },
    vehicle_types: { type: "array", items: { type: "string" } },
    need: { type: "integer", minimum: 1 },
    enabled: { type: "boolean" },
    fulfilled: { type: "boolean" },
  },
} as const;

export const rulesController: FastifyPluginAsync = async (app) => {
  app.get("/", async () => readRules());

  app.post<{ Body: Partial<NotifyRuleInput> }>("/", { schema: { body: ruleSchema } }, async (req) => {
    const newRule = createRule(toRuleInput(req.body));
    await insertAuditLog(currentUser(req).username, "Add Rule", `Added rule: ${newRule.name}`);
    return { ok: true };
  });

  app.put<{ Params: RuleParams; Body: Partial<NotifyRuleInput> }>("/:id", { schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } }, body: ruleSchema } }, async (req, reply) => {
    const updated = updateRule(req.params.id, toRulePatch(req.body));
    if (!updated) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    await insertAuditLog(currentUser(req).username, "Update Rule", `Updated rule: ${updated.name}`);
    return { ok: true };
  });

  app.get<{ Params: RuleParams }>("/:id", async (req, reply) => {
    const rule = readRules().find((item) => item.id === req.params.id);
    if (!rule) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    return rule;
  });

  app.delete<{ Params: RuleParams }>("/:id", async (req, reply) => {
    const deleted = deleteRule(req.params.id);
    if (!deleted) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    await insertAuditLog(currentUser(req).username, "Delete Rule", `Deleted rule: ${deleted.name}`);
    return { ok: true };
  });
};
