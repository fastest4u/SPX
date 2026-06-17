process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "bidding-controller-accept-all-test-key";

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
  const { getAuditLogs } = await import("../src/repositories/audit-repository.js");
  const { biddingController } = await import("../src/controllers/bidding-controller.js");
  const { env } = await import("../src/config/env.js");
  const { isAppError } = await import("../src/utils/errors.js");
  const { sendError } = await import("../src/utils/response.js");

  resetMemoryDb();
  const alpha = await createTeam({ name: "Alpha Ops", enabled: true, spxCookie: "alpha-cookie", spxDeviceId: "alpha-device", lineGroupId: "alpha-line" });
  const beta = await createTeam({ name: "Beta Ops", enabled: true, spxCookie: "beta-cookie", spxDeviceId: "beta-device", lineGroupId: "beta-line" });

  const mutableEnv = env as unknown as { API_URL: string };
  const originalApiUrl = mutableEnv.API_URL;
  mutableEnv.API_URL = "https://spx.example.test/booking/bidding/list";

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
  await app.register(biddingController, { prefix: "/api/bidding" });
  await app.ready();

  const originalFetch = globalThis.fetch;
  const acceptBodies: unknown[] = [];
  const acceptHeaders: Array<Record<string, string>> = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    acceptBodies.push(JSON.parse(String(init?.body ?? "{}")));
    acceptHeaders.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ retcode: 0, message: "ok", data: { success_count: 2 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const userAttempt = await app.inject({
      method: "POST",
      url: "/api/bidding/accept-all",
      headers: { "x-test-actor": "user" },
      payload: { teamId: alpha.id, bookingId: 2706815, confirm: true },
    });
    assert.equal(userAttempt.statusCode, 403);
    assert.equal(parseBody(userAttempt).error_code, "FORBIDDEN");
    assert.equal(acceptBodies.length, 0);

    const missingTeam = await app.inject({
      method: "POST",
      url: "/api/bidding/accept-all",
      headers: { "x-test-actor": "admin" },
      payload: { bookingId: 2706815, confirm: true },
    });
    assert.equal(missingTeam.statusCode, 400);
    assert.equal(parseBody(missingTeam).error_code, "TEAM_REQUIRED");
    assert.equal(acceptBodies.length, 0);

    const adminAcceptAll = await app.inject({
      method: "POST",
      url: "/api/bidding/accept-all",
      headers: { "x-test-actor": "admin" },
      payload: { teamId: beta.id, bookingId: 2706815, confirm: true },
    });
    assert.equal(adminAcceptAll.statusCode, 200);
    const data = parseBody<{ bookingId: number; teamId: number; acceptAll: boolean; response: { retcode: number } }>(adminAcceptAll).data;
    assert.equal(data?.bookingId, 2706815);
    assert.equal(data?.teamId, beta.id);
    assert.equal(data?.acceptAll, true);
    assert.equal(data?.response.retcode, 0);
    assert.deepEqual(acceptBodies, [{ booking_id: 2706815, accept_all: true, request_id_list: [] }]);
    assert.equal(acceptHeaders[0]?.cookie, "beta-cookie");
    assert.equal(acceptHeaders[0]?.["device-id"], "beta-device");

    const auditRows = await getAuditLogs({ action: "Accept All Booking Requests", sortBy: "id", sortDir: "asc" });
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]?.targetTeamId, beta.id);
  } finally {
    globalThis.fetch = originalFetch;
    mutableEnv.API_URL = originalApiUrl;
    await app.close();
  }

  console.log("bidding-controller-accept-all: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
