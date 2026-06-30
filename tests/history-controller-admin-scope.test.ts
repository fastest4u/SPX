process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "history-controller-admin-scope-test-key";

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
  const { insertBookingHistories } = await import("../src/repositories/booking-history-repository.js");
  const { historyController } = await import("../src/controllers/history-controller.js");
  const { isAppError } = await import("../src/utils/errors.js");
  const { sendError } = await import("../src/utils/response.js");

  resetMemoryDb();

  const alpha = await createTeam({ name: "Alpha Ops", enabled: true, spxCookie: "c1", spxDeviceId: "d1", lineGroupId: "g1" });
  const beta = await createTeam({ name: "Beta Ops", enabled: true, spxCookie: "c2", spxDeviceId: "d2", lineGroupId: "g2" });

  await insertBookingHistories(alpha.id, [{
    requestId: 1001,
    bookingId: 2001,
    bookingName: "Alpha booking",
    agencyName: "Agency A",
    route: "Alpha Origin -> Alpha Destination",
    origin: "Alpha Origin",
    destination: "Alpha Destination",
    costType: "fixed",
    tripType: "single",
    shiftType: "day",
    vehicleType: "4W",
    standbyDateTime: "2026-06-16 10:00",
  }]);
  await insertBookingHistories(beta.id, [{
    requestId: 1002,
    bookingId: 2002,
    bookingName: "Beta booking",
    agencyName: "Agency B",
    route: "Beta Origin -> Beta Destination",
    origin: "Beta Origin",
    destination: "Beta Destination",
    costType: "fixed",
    tripType: "single",
    shiftType: "night",
    vehicleType: "6W",
    standbyDateTime: "2026-06-16 12:00",
  }]);

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
  await app.register(historyController, { prefix: "/api/history" });
  await app.ready();

  try {
    const adminList = await app.inject({ method: "GET", url: "/api/history/paginated", headers: { "x-test-actor": "admin" } });
    assert.equal(adminList.statusCode, 200);
    const adminBody = parseBody<Array<{ requestId: number; teamId?: number; teamName?: string }>>(adminList);
    assert.equal(adminBody.meta?.total_items, 2);
    assert.deepEqual(new Set((adminBody.data ?? []).map((row) => row.requestId)), new Set([1001, 1002]));
    assert.deepEqual(new Set((adminBody.data ?? []).map((row) => row.teamId)), new Set([alpha.id, beta.id]));
    assert.deepEqual(new Set((adminBody.data ?? []).map((row) => row.teamName)), new Set(["Alpha Ops", "Beta Ops"]));

    const userList = await app.inject({ method: "GET", url: "/api/history/paginated", headers: { "x-test-actor": "user" } });
    assert.equal(userList.statusCode, 200);
    const userRows = parseBody<Array<{ requestId: number; teamId?: number; teamName?: string }>>(userList).data ?? [];
    assert.deepEqual(userRows.map((row) => row.requestId), [1001]);
    assert.equal(userRows[0]?.teamId, alpha.id);
    assert.equal(userRows[0]?.teamName, "Alpha Ops");

    const adminOptions = await app.inject({ method: "GET", url: "/api/history/filter-options", headers: { "x-test-actor": "admin" } });
    assert.equal(adminOptions.statusCode, 200);
    const adminOptionsBody = parseBody<{
      teams: Array<{ id: number; name: string }>;
      vehicleTypes: string[];
    }>(adminOptions).data;
    assert.deepEqual(adminOptionsBody?.teams, [
      { id: alpha.id, name: "Alpha Ops" },
      { id: beta.id, name: "Beta Ops" },
    ]);
    assert.deepEqual(adminOptionsBody?.vehicleTypes, ["4W", "6W"]);

    const betaOptions = await app.inject({ method: "GET", url: `/api/history/filter-options?teamId=${beta.id}`, headers: { "x-test-actor": "admin" } });
    assert.equal(betaOptions.statusCode, 200);
    const betaOptionsBody = parseBody<{ vehicleTypes: string[] }>(betaOptions).data;
    assert.deepEqual(betaOptionsBody?.vehicleTypes, ["6W"]);

    const userOptions = await app.inject({ method: "GET", url: "/api/history/filter-options", headers: { "x-test-actor": "user" } });
    assert.equal(userOptions.statusCode, 200);
    const userOptionsBody = parseBody<{
      teams: Array<{ id: number; name: string }>;
      vehicleTypes: string[];
    }>(userOptions).data;
    assert.deepEqual(userOptionsBody?.teams, [{ id: alpha.id, name: "Alpha Ops" }]);
    assert.deepEqual(userOptionsBody?.vehicleTypes, ["4W"]);
  } finally {
    await app.close();
  }

  console.log("history-controller-admin-scope: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
