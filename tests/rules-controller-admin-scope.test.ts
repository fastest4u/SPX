process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "rules-controller-admin-scope-test-key";

import assert from "node:assert/strict";
import Fastify, { type FastifyRequest } from "fastify";
import type { AuthUser } from "../src/services/authz.js";

type ApiBody<T = unknown> = {
  status: "success" | "error";
  data?: T;
  error_code?: string;
  message?: string;
};

function parseBody<T>(response: { body: string }): ApiBody<T> {
  return JSON.parse(response.body) as ApiBody<T>;
}

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam } = await import("../src/repositories/team-repository.js");
  const { createRule } = await import("../src/services/notify-rules.js");
  const { getAuditLogs } = await import("../src/repositories/audit-repository.js");
  const { rulesController } = await import("../src/controllers/rules-controller.js");
  const { isAppError } = await import("../src/utils/errors.js");
  const { sendError } = await import("../src/utils/response.js");

  resetMemoryDb();

  const alpha = await createTeam({ name: "Alpha Ops", enabled: true, spxCookie: "alpha-cookie", spxDeviceId: "alpha-device", lineGroupId: "alpha-line" });
  const beta = await createTeam({ name: "Beta Ops", enabled: true, spxCookie: "beta-cookie", spxDeviceId: "beta-device", lineGroupId: "beta-line" });

  await createRule(alpha.id, { name: "Alpha route", origins: ["A"], destinations: ["B"], vehicle_types: ["4W"], need: 1, enabled: true });
  await createRule(beta.id, { name: "Beta route", origins: ["C"], destinations: ["D"], vehicle_types: ["6W"], need: 1, enabled: true });

  const actors: Record<string, AuthUser> = {
    admin: { id: 1, username: "admin", role: "admin", teamId: null },
    user: { id: 2, username: "alpha-user", role: "user", teamId: alpha.id },
  };

  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const actorName = String(req.headers["x-test-actor"] ?? "admin");
    (req as FastifyRequest & { user?: AuthUser }).user = actors[actorName] ?? actors.admin;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (isAppError(error)) {
      return sendError(reply, error.statusCode, error.errorCode, error.message, error.details);
    }
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    return sendError(reply, statusCode, "REQUEST_ERROR", error instanceof Error ? error.message : String(error));
  });
  await app.register(rulesController, { prefix: "/api/rules" });
  await app.ready();

  try {
    const adminList = await app.inject({ method: "GET", url: "/api/rules", headers: { "x-test-actor": "admin" } });
    assert.equal(adminList.statusCode, 200);
    const adminRules = parseBody<Array<{ name: string; teamId?: number; teamName?: string }>>(adminList).data ?? [];
    assert.deepEqual(new Set(adminRules.map((rule) => rule.name)), new Set(["Alpha route", "Beta route"]));
    assert.deepEqual(new Set(adminRules.map((rule) => rule.teamId)), new Set([alpha.id, beta.id]));
    assert.deepEqual(new Set(adminRules.map((rule) => rule.teamName)), new Set(["Alpha Ops", "Beta Ops"]));

    const missingTeam = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "x-test-actor": "admin" },
      payload: { name: "No owner", origins: [], destinations: [], vehicle_types: [], need: 1, enabled: true },
    });
    assert.equal(missingTeam.statusCode, 400);
    assert.equal(parseBody(missingTeam).error_code, "TEAM_REQUIRED");

    const adminCreate = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "x-test-actor": "admin" },
      payload: { teamId: beta.id, name: "Admin beta route", origins: ["E"], destinations: ["F"], vehicle_types: ["10W"], need: 2, enabled: true },
    });
    assert.equal(adminCreate.statusCode, 201);
    const adminCreated = parseBody<{ name: string; teamId?: number; teamName?: string }>(adminCreate).data;
    assert.equal(adminCreated?.teamId, beta.id);
    assert.equal(adminCreated?.teamName, "Beta Ops");

    const userList = await app.inject({ method: "GET", url: "/api/rules", headers: { "x-test-actor": "user" } });
    assert.equal(userList.statusCode, 200);
    const userRules = parseBody<Array<{ name: string; teamId?: number }>>(userList).data ?? [];
    assert.deepEqual(userRules.map((rule) => rule.name), ["Alpha route"]);
    assert.deepEqual(new Set(userRules.map((rule) => rule.teamId)), new Set([alpha.id]));

    const userCreate = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "x-test-actor": "user" },
      payload: { teamId: beta.id, name: "User cannot cross team", origins: ["X"], destinations: ["Y"], vehicle_types: ["4W"], need: 1, enabled: true },
    });
    assert.equal(userCreate.statusCode, 201);
    const userCreated = parseBody<{ teamId?: number; teamName?: string }>(userCreate).data;
    assert.equal(userCreated?.teamId, alpha.id);
    assert.equal(userCreated?.teamName, "Alpha Ops");

    const auditRows = await getAuditLogs({ action: "Add Rule", sortBy: "id", sortDir: "asc" });
    assert.equal(auditRows.length, 2);
    assert.deepEqual(auditRows.map((row) => row.targetTeamId), [beta.id, alpha.id]);
  } finally {
    await app.close();
  }

  console.log("rules-controller-admin-scope: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
