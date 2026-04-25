import type { FastifyPluginAsync } from "fastify";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NotifyRule } from "../services/notify-rules.js";
import { insertAuditLog } from "../repositories/audit-repository.js";

const RULES_PATH = resolve(process.cwd(), "notify-rules.json");

function readRulesFile(): NotifyRule[] {
  if (!existsSync(RULES_PATH)) return [];
  try {
    return JSON.parse(readFileSync(RULES_PATH, "utf-8")) as NotifyRule[];
  } catch {
    return [];
  }
}

function writeRulesFile(rules: NotifyRule[]): void {
  const tempFile = `${RULES_PATH}.tmp`;
  writeFileSync(tempFile, JSON.stringify(rules, null, 2) + "\n", "utf-8");
  renameSync(tempFile, RULES_PATH);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
  app.get("/", async () => readRulesFile());

  app.post("/", { schema: { body: ruleSchema } }, async (req: any) => {
    const body = req.body as Partial<NotifyRule>;
    const rules = readRulesFile();
    const newRule: NotifyRule = {
      name: body.name!.trim(),
      origins: isStringArray(body.origins) ? body.origins : [],
      destinations: isStringArray(body.destinations) ? body.destinations : [],
      vehicle_types: isStringArray(body.vehicle_types) ? body.vehicle_types : [],
      need: typeof body.need === "number" && body.need >= 1 ? body.need : 1,
      enabled: body.enabled ?? true,
      fulfilled: body.fulfilled ?? false,
    };
    rules.push(newRule);
    writeRulesFile(rules);
    await insertAuditLog(req.user.username, "Add Rule", `Added rule: ${newRule.name}`);
    return { ok: true };
  });

  app.put("/:id", { schema: { params: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 0 } } }, body: ruleSchema } }, async (req: any, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid rule id" } });
    const body = req.body as Partial<NotifyRule>;
    const rules = readRulesFile();
    if (id >= rules.length) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    rules[id] = { ...rules[id], ...body };
    writeRulesFile(rules);
    await insertAuditLog(req.user.username, "Update Rule", `Updated rule: ${rules[id].name}`);
    return { ok: true };
  });

  app.get("/:id", async (req: any, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const rules = readRulesFile();
    if (!Number.isInteger(id) || id < 0 || id >= rules.length) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    return rules[id];
  });

  app.delete("/:id", async (req: any, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const rules = readRulesFile();
    if (!Number.isInteger(id) || id < 0 || id >= rules.length) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    const deleted = rules.splice(id, 1)[0];
    writeRulesFile(rules);
    await insertAuditLog(req.user.username, "Delete Rule", `Deleted rule: ${deleted.name}`);
    return { ok: true };
  });
};
