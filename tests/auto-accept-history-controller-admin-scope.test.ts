process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "auto-accept-history-controller-admin-scope-test-key";

import assert from "node:assert/strict";
import Fastify, { type FastifyRequest } from "fastify";
import type { AuthUser } from "../src/services/authz.js";

type ApiBody<T = unknown> = {
  status: "success" | "error";
  data?: T;
  error_code?: string;
  message?: string;
  meta?: {
    total_items: number;
  };
};

function parseBody<T>(response: { body: string }): ApiBody<T> {
  return JSON.parse(response.body) as ApiBody<T>;
}

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam } = await import("../src/repositories/team-repository.js");
  const { insertAutoAcceptHistory } = await import("../src/repositories/auto-accept-repository.js");
  const { autoAcceptHistoryController } = await import("../src/controllers/auto-accept-history-controller.js");
  const { isAppError } = await import("../src/utils/errors.js");
  const { sendError } = await import("../src/utils/response.js");

  resetMemoryDb();

  const alpha = await createTeam({ name: "Alpha Ops", enabled: true, spxCookie: "c1", spxDeviceId: "d1", lineGroupId: "g1" });
  const beta = await createTeam({ name: "Beta Ops", enabled: true, spxCookie: "c2", spxDeviceId: "d2", lineGroupId: "g2" });

  await insertAutoAcceptHistory(alpha.id, {
    ruleId: "alpha-rule",
    ruleName: "Alpha rule",
    bookingId: 2001,
    requestIds: [1001],
    acceptedCount: 1,
    origin: "Alpha Origin",
    destination: "Alpha Destination",
    vehicleType: "4W",
    status: "success",
  });
  await insertAutoAcceptHistory(beta.id, {
    ruleId: "beta-rule",
    ruleName: "Beta rule",
    bookingId: 2002,
    requestIds: [1002],
    acceptedCount: 1,
    origin: "Beta Origin",
    destination: "Beta Destination",
    vehicleType: "6W",
    status: "failed",
    errorMessage: "No driver",
  });

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
  await app.register(autoAcceptHistoryController, { prefix: "/api/auto-accept-history" });
  await app.ready();

  try {
    const adminList = await app.inject({ method: "GET", url: "/api/auto-accept-history/paginated", headers: { "x-test-actor": "admin" } });
    assert.equal(adminList.statusCode, 200);
    const adminBody = parseBody<Array<{ ruleName: string; teamId?: number; teamName?: string }>>(adminList);
    assert.equal(adminBody.meta?.total_items, 2);
    assert.deepEqual(new Set((adminBody.data ?? []).map((row) => row.ruleName)), new Set(["Alpha rule", "Beta rule"]));
    assert.deepEqual(new Set((adminBody.data ?? []).map((row) => row.teamId)), new Set([alpha.id, beta.id]));
    assert.deepEqual(new Set((adminBody.data ?? []).map((row) => row.teamName)), new Set(["Alpha Ops", "Beta Ops"]));

    const userList = await app.inject({ method: "GET", url: "/api/auto-accept-history/paginated", headers: { "x-test-actor": "user" } });
    assert.equal(userList.statusCode, 200);
    const userRows = parseBody<Array<{ ruleName: string; teamId?: number; teamName?: string }>>(userList).data ?? [];
    assert.deepEqual(userRows.map((row) => row.ruleName), ["Alpha rule"]);
    assert.equal(userRows[0]?.teamId, alpha.id);
    assert.equal(userRows[0]?.teamName, "Alpha Ops");

    const userCrossTeamList = await app.inject({ method: "GET", url: `/api/auto-accept-history/paginated?teamId=${beta.id}`, headers: { "x-test-actor": "user" } });
    assert.equal(userCrossTeamList.statusCode, 200);
    const userCrossTeamRows = parseBody<Array<{ ruleName: string; teamId?: number; teamName?: string }>>(userCrossTeamList).data ?? [];
    assert.deepEqual(userCrossTeamRows.map((row) => row.ruleName), ["Alpha rule"]);
    assert.equal(userCrossTeamRows[0]?.teamId, alpha.id);

    const userCrossTeamFlatList = await app.inject({ method: "GET", url: `/api/auto-accept-history?teamId=${beta.id}`, headers: { "x-test-actor": "user" } });
    assert.equal(userCrossTeamFlatList.statusCode, 200);
    const userCrossTeamFlatRows = parseBody<Array<{ ruleName: string; teamId?: number }>>(userCrossTeamFlatList).data ?? [];
    assert.deepEqual(userCrossTeamFlatRows.map((row) => row.ruleName), ["Alpha rule"]);
    assert.equal(userCrossTeamFlatRows[0]?.teamId, alpha.id);
  } finally {
    await app.close();
  }

  console.log("auto-accept-history-controller-admin-scope: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
