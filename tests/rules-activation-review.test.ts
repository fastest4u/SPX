process.env.NODE_ENV = "test";
process.env.DB_MODE = "memory";
process.env.HTTP_ENABLED = "false";
process.env.SECRETS_KEY = "rule-review-synthetic-secrets-key";
process.env.JWT_SECRET = "rule-review-synthetic-jwt-key-at-least-32-chars";

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../src/services/authz.js";
import type { NotifyRule } from "../src/services/notify-rules.js";

type RuleBody = {
  name: string; teamId: number; origins: string[]; destinations: string[]; vehicle_types: string[];
  need: number; enabled: boolean; fulfilled?: boolean; auto_accepted?: boolean; accept_all?: boolean;
};
type Review = { token: string; expiresAt: string; wildcardFields: string[]; acceptAll: boolean };
type Preview = { review: Review; acceptAll: boolean; need: number; matchedCount: number; scannedCount: number };
type Response = { statusCode: number; body: string };
function data<T>(response: Response): T { return JSON.parse(response.body).data as T; }
function expectError(response: Response, code: string, status = 409): void {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(JSON.parse(response.body).error_code, code, response.body);
}

test("rule activation review HTTP contract", async (t) => {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam } = await import("../src/repositories/team-repository.js");
  const { createRule, updateRule, readRulesForScope } = await import("../src/services/notify-rules.js");
  const { insertBookingHistories } = await import("../src/repositories/booking-history-repository.js");
  const { getAuditLogs } = await import("../src/repositories/audit-repository.js");
  const { getDb } = await import("../src/db/client.js");
  const { notifyRules: rulesTable } = await import("../src/db/schema.js");
  const { rulesController } = await import("../src/controllers/rules-controller.js");
  const { isAppError } = await import("../src/utils/errors.js");
  const { sendError } = await import("../src/utils/response.js");
  resetMemoryDb();
  const alpha = await createTeam({ name: "Review Alpha", enabled: true });
  const beta = await createTeam({ name: "Review Beta", enabled: true });
  const actors: Record<string, AuthUser> = {
    admin: { id: 1, username: "admin", role: "admin", teamId: null },
    admin2: { id: 2, username: "admin2", role: "admin", teamId: null },
    user: { id: 3, username: "user", role: "user", teamId: alpha.id },
    betaUser: { id: 4, username: "beta-user", role: "user", teamId: beta.id },
  };
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req: FastifyRequest) => {
    (req as FastifyRequest & { user?: AuthUser }).user = actors[String(req.headers["x-test-actor"] ?? "admin")];
  });
  app.setErrorHandler((error, _req, reply) => {
    if (isAppError(error)) return sendError(reply, error.statusCode, error.errorCode, error.message);
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return sendError(reply, status, "REQUEST_ERROR", error instanceof Error ? error.message : String(error));
  });
  await app.register(rulesController, { prefix: "/api/rules" });
  await app.ready();
  const base = (name: string, patch: Partial<RuleBody> = {}): RuleBody => ({
    name, teamId: alpha.id, origins: ["A"], destinations: ["B"], vehicle_types: ["4W"], need: 1, enabled: true, ...patch,
  });
  const request = (method: "POST" | "PUT", payload: object, actor = "admin", id?: string) => app.inject({
    method, url: `/api/rules${id ? `/${id}` : ""}`, payload, headers: { "x-test-actor": actor },
  });
  const preview = async (rule: object, actor = "admin", ruleId?: string): Promise<Preview> => {
    const response = await app.inject({ method: "POST", url: "/api/rules/preview", payload: { rule, ruleId }, headers: { "x-test-actor": actor } });
    assert.equal(response.statusCode, 200, response.body);
    const result = data<Preview>(response);
    assert.equal(typeof result.review?.token, "string", "preview must provide an activation review token");
    return result;
  };
  const approved = (review: Review) => ({ token: review.token, acknowledgeWildcard: true, acknowledgeAcceptAll: true });
  const persisted = async (id: string) => (await readRulesForScope(null)).find((rule) => rule.id === id)!;

  try {
    await t.test("active creates need a review and cannot bypass using forged fulfilled flags", async () => {
      for (const flags of [{}, { fulfilled: true, auto_accepted: true }]) {
        const rule = base(`Unreviewed ${JSON.stringify(flags)}`, flags);
        expectError(await request("POST", rule), "RULE_REVIEW_REQUIRED");
        assert.equal((await readRulesForScope(null)).some((item) => item.name === rule.name), false);
      }
    });
    await t.test("disabled and need=0 saves work without review; disabling always works", async () => {
      for (const state of [{ enabled: false }, { need: 0 }]) {
        const response = await request("POST", base(`Inactive ${JSON.stringify(state)}`, state));
        assert.equal(response.statusCode, 201, response.body);
        const saved = await persisted(data<NotifyRule>(response).id);
        assert.ok(!saved.enabled || saved.need === 0);
      }
      const existing = await createRule(alpha.id, base("Disable existing", { accept_all: true }));
      const response = await request("PUT", { name: existing.name, enabled: false }, "user", existing.id);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await persisted(existing.id)).enabled, false);
      assert.equal((await persisted(existing.id)).accept_all, true);
    });
    await t.test("whitespace-only names are rejected on create, preview and update", async () => {
      const existing = await createRule(alpha.id, base("Valid name", { enabled: false }));
      for (const response of [
        await request("POST", base("   ", { enabled: false })),
        await request("PUT", base(" \t ", { enabled: false }), "admin", existing.id),
        await app.inject({ method: "POST", url: "/api/rules/preview", payload: { rule: base("  ") } }),
      ]) expectError(response, "VALIDATION_ERROR", 400);
      assert.equal((await persisted(existing.id)).name, "Valid name");
    });
    await t.test("reviewed normalized create persists fields and records safe mode acknowledgement", async () => {
      const rule = base("  Reviewed whole booking  ", { origins: [" ", ""], accept_all: true });
      const result = await preview(rule);
      assert.deepEqual(result.review.wildcardFields, ["origins"]);
      assert.equal(result.review.acceptAll, true);
      assert.equal(result.acceptAll, true);
      assert.ok(Date.parse(result.review.expiresAt) > Date.now());
      assert.ok(Date.parse(result.review.expiresAt) <= Date.now() + 300_000);
      const response = await request("POST", { ...rule, activationReview: approved(result.review) });
      assert.equal(response.statusCode, 201, response.body);
      const saved = await persisted(data<NotifyRule>(response).id);
      assert.equal(saved.name, "Reviewed whole booking");
      assert.deepEqual(saved.origins, []);
      assert.equal(saved.accept_all, true);
      assert.equal("activationReview" in saved, false);
      const audit = (await getAuditLogs({ action: "Add Rule" })).find((row) => row.details?.includes(saved.name));
      assert.match(audit?.details ?? "", /accept_all=true/);
      assert.match(audit?.details ?? "", /acknowledgeWildcard=true/);
      assert.match(audit?.details ?? "", /acknowledgeAcceptAll=true/);
      assert.equal(audit?.details?.includes(result.review.token), false);
      assert.equal(audit?.details?.includes(process.env.JWT_SECRET!), false);
    });
    await t.test("wildcard and whole-booking warnings require separate explicit acknowledgements", async () => {
      const rule = base("Ack required", { destinations: [], accept_all: true });
      const { review } = await preview(rule);
      expectError(await request("POST", { ...rule, activationReview: { token: review.token, acknowledgeAcceptAll: true } }), "RULE_REVIEW_REQUIRED");
      expectError(await request("POST", { ...rule, activationReview: { token: review.token, acknowledgeWildcard: true } }), "RULE_REVIEW_REQUIRED");
      assert.equal((await readRulesForScope(null)).some((item) => item.name === rule.name), false);
    });
    await t.test("normal targeted rule needs no warning acknowledgement", async () => {
      const rule = base("Normal reviewed");
      const { review } = await preview(rule);
      assert.deepEqual(review.wildcardFields, []);
      assert.equal(review.acceptAll, false);
      const response = await request("POST", { ...rule, activationReview: { token: review.token } });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal((await persisted(data<NotifyRule>(response).id)).accept_all, false);
    });
    await t.test("tampered and malformed bounded tokens fail safely", async () => {
      const rule = base("Tamper");
      const { review } = await preview(rule);
      for (const token of [`${review.token[0] === "a" ? "b" : "a"}${review.token.slice(1)}`, "a.b", "a".repeat(4097)]) {
        const response = await request("POST", { ...rule, activationReview: { token } });
        assert.ok([400, 409].includes(response.statusCode), response.body);
      }
      assert.equal((await readRulesForScope(null)).some((item) => item.name === rule.name), false);
    });
    await t.test("token expires five minutes after preview", async () => {
      const rule = base("Expired");
      const { review } = await preview(rule);
      const realNow = Date.now;
      Date.now = () => Date.parse(review.expiresAt);
      try { expectError(await request("POST", { ...rule, activationReview: approved(review) }), "RULE_REVIEW_EXPIRED"); }
      finally { Date.now = realNow; }
    });
    await t.test("tokens bind every editable field, resolved team and authenticated actor", async () => {
      const rule = base("Bound input");
      const { review } = await preview(rule);
      for (const change of [
        { name: "Other" }, { origins: ["Other"] }, { destinations: [] }, { vehicle_types: ["6W"] },
        { need: 2 }, { accept_all: true }, { teamId: beta.id },
      ]) expectError(await request("POST", { ...rule, ...change, activationReview: approved(review) }), "RULE_REVIEW_CHANGED");
      expectError(await request("POST", { ...rule, activationReview: approved(review) }, "admin2"), "RULE_REVIEW_CHANGED");
    });
    await t.test("tokens cannot move between create and update or existing rule IDs", async () => {
      const rule = base("Existing binding");
      const one = await createRule(alpha.id, rule);
      const two = await createRule(alpha.id, rule);
      const forCreate = (await preview(rule)).review;
      expectError(await request("PUT", { ...rule, activationReview: approved(forCreate) }, "admin", one.id), "RULE_REVIEW_CHANGED");
      const forUpdate = (await preview(rule, "admin", one.id)).review;
      expectError(await request("POST", { ...rule, activationReview: approved(forUpdate) }), "RULE_REVIEW_CHANGED");
      expectError(await request("PUT", { ...rule, activationReview: approved(forUpdate) }, "admin", two.id), "RULE_REVIEW_CHANGED");
      expectError(await request("PUT", rule, "admin", one.id), "RULE_REVIEW_REQUIRED");
    });
    await t.test("existing live need and config changes invalidate reviewed full edits", async () => {
      for (const change of [{ need: 1 }, { destinations: ["Changed by another operator"] }]) {
        const rule = base(`Stale ${JSON.stringify(change)}`, { need: 3 });
        const existing = await createRule(alpha.id, rule);
        const { review } = await preview(rule, "admin", existing.id);
        await updateRule(alpha.id, existing.id, change);
        expectError(await request("PUT", { ...rule, activationReview: approved(review) }, "admin", existing.id), "RULE_REVIEW_CHANGED");
        const saved = await persisted(existing.id);
        for (const [key, value] of Object.entries(change)) assert.deepEqual(saved[key as keyof NotifyRule], value);
      }
    });
    await t.test("concurrent reviewed edits cannot overwrite each other's changed snapshot", async () => {
      const existing = await createRule(alpha.id, base("Concurrent original"));
      const left = base("Concurrent left");
      const right = base("Concurrent right");
      const leftReview = (await preview(left, "admin", existing.id)).review;
      const rightReview = (await preview(right, "admin", existing.id)).review;
      const responses = await Promise.all([
        request("PUT", { ...left, activationReview: approved(leftReview) }, "admin", existing.id),
        request("PUT", { ...right, activationReview: approved(rightReview) }, "admin", existing.id),
      ]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
      const winner = responses.find((response) => response.statusCode === 200)!;
      assert.equal((await persisted(existing.id)).name, data<NotifyRule>(winner).name);
    });
    await t.test("a completed-rule edit cannot overwrite a concurrent reviewed activation", async () => {
      const existing = await createRule(alpha.id, base("Completed concurrent", { need: 0 }));
      const activate = base("Reviewed activation", { need: 2 });
      const { review } = await preview(activate, "admin", existing.id);
      const responses = await Promise.all([
        request("PUT", { ...activate, activationReview: approved(review) }, "admin", existing.id),
        request("PUT", { name: "Edit while completed", enabled: true }, "admin", existing.id),
      ]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    });
    await t.test("commit guard detects a real DB update after the handler and service snapshot reads", async () => {
      for (const needBefore of [0, 3]) {
        const existing = await createRule(alpha.id, base(`Commit race ${needBefore}`, { need: needBefore }));
        const patch = { name: existing.name, enabled: true };
        const review = needBefore > 0 ? (await preview(patch, "admin", existing.id)).review : undefined;
        const db = getDb();
        const originalUpdate = db.update;
        let interleaved = false;
        // Control scheduling only: both the competing write and route commit
        // execute against the real memory DB; no validation/results are mocked.
        db.update = function (table: unknown) {
          if (table === rulesTable && !interleaved) {
            interleaved = true;
            originalUpdate.call(db, rulesTable).set({ need: 2, enabled: 1, fulfilled: 0 }).where(eq(rulesTable.id, existing.id)).run();
          }
          return originalUpdate.call(db, table);
        };
        try {
          const response = await request("PUT", { ...patch, ...(review ? { activationReview: approved(review) } : {}) }, "admin", existing.id);
          assert.equal(interleaved, true);
          expectError(response, "RULE_REVIEW_CHANGED");
        } finally { db.update = originalUpdate; }
        assert.equal((await persisted(existing.id)).need, 2);
      }
    });
    await t.test("immediate disable succeeds while preserving concurrently completed acceptance progress", async () => {
      const existing = await createRule(alpha.id, base("Emergency disable", { need: 3, accept_all: true }));
      const db = getDb();
      const originalUpdate = db.update;
      let interleaved = false;
      db.update = function (table: unknown) {
        if (table === rulesTable && !interleaved) {
          interleaved = true;
          originalUpdate.call(db, rulesTable).set({ need: 0, fulfilled: 1, autoAccepted: 1 }).where(eq(rulesTable.id, existing.id)).run();
        }
        return originalUpdate.call(db, table);
      };
      try {
        const response = await request("PUT", { name: existing.name, enabled: false }, "user", existing.id);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(data<NotifyRule>(response).need, 0);
      } finally { db.update = originalUpdate; }
      const saved = await persisted(existing.id);
      assert.equal(saved.enabled, false);
      assert.equal(saved.need, 0);
      assert.equal(saved.auto_accepted, true);
      assert.equal(saved.accept_all, true);
    });
    await t.test("user create previews the permitted normal mode and saves to own team", async () => {
      const rule = base("User normal create", { accept_all: true, teamId: beta.id });
      const result = await preview(rule, "user");
      assert.equal(result.acceptAll, false);
      assert.equal(result.review.acceptAll, false);
      const response = await request("POST", { ...rule, activationReview: { token: result.review.token } }, "user");
      assert.equal(response.statusCode, 201, response.body);
      const saved = await persisted(data<NotifyRule>(response).id);
      assert.equal(saved.teamId, alpha.id);
      assert.equal(saved.accept_all, false);
    });
    await t.test("user preview and edit preserve existing accept_all, with acknowledgements", async () => {
      const existing = await createRule(alpha.id, base("Admin whole booking", { accept_all: true, enabled: false }));
      const patch = { name: "User edited whole booking", enabled: true, accept_all: false };
      const result = await preview(patch, "user", existing.id);
      assert.equal(result.acceptAll, true);
      assert.equal(result.review.acceptAll, true);
      expectError(await request("PUT", { ...patch, activationReview: { token: result.review.token } }, "user", existing.id), "RULE_REVIEW_REQUIRED");
      const response = await request("PUT", { ...patch, activationReview: approved(result.review) }, "user", existing.id);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await persisted(existing.id)).accept_all, true);
      assert.equal((await persisted(existing.id)).enabled, true);
    });
    await t.test("existing preview and save remain scoped independently of tokens", async () => {
      const rule = base("Beta only", { teamId: beta.id });
      const existing = await createRule(beta.id, rule);
      const result = await preview(rule, "admin", existing.id);
      const response = await app.inject({ method: "POST", url: "/api/rules/preview", payload: { rule, ruleId: existing.id }, headers: { "x-test-actor": "user" } });
      expectError(response, "NOT_FOUND", 404);
      expectError(await request("PUT", { ...rule, activationReview: approved(result.review) }, "user", existing.id), "NOT_FOUND", 404);
    });
    await t.test("preview reports actual normal versus whole-booking mode with need=1 and multiple requests", async () => {
      await insertBookingHistories(alpha.id, [1, 2, 3].map((requestId) => ({
        requestId, bookingId: 500, route: "A > B", origin: "A", destination: "B", vehicleType: "4W",
        costType: "test", tripType: "test", shiftType: "test", standbyDateTime: "2026-09-11 09:00:00",
      })));
      for (const accept_all of [false, true]) {
        const result = await preview(base(`Mode ${accept_all}`, { accept_all }));
        assert.equal(result.need, 1);
        assert.equal(result.matchedCount, 3);
        assert.equal(result.acceptAll, accept_all);
        assert.equal(result.review.acceptAll, accept_all);
      }
    });
  } finally { await app.close(); }
});
