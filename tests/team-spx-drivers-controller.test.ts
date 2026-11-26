process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "team-spx-drivers-controller-test-key";

import assert from "node:assert/strict";
import Fastify from "fastify";
import { env } from "../src/config/env.js";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam } = await import("../src/repositories/team-repository.js");
  const {
    teamsController,
    currentTeamController,
  } = await import("../src/controllers/teams-controller.js");
  const { biddingController } = await import("../src/controllers/bidding-controller.js");
  const { clearTeamDriverPoolRegistry } = await import("../src/services/team-driver-pool.js");

  resetMemoryDb();
  clearTeamDriverPoolRegistry();

  const team1 = await createTeam({
    name: "Team IFN",
    enabled: true,
    spxCookie: "fms_user_skey=secret-ifn",
    spxDeviceId: "device-ifn",
    lineGroupId: "line-1",
    biddingVehicleType: 2,
  });

  const team2 = await createTeam({
    name: "Team PTWL",
    enabled: true,
    spxCookie: "fms_user_skey=secret-ptwl",
    spxDeviceId: "device-ptwl",
    lineGroupId: "line-2",
    biddingVehicleType: 13,
  });

  const app = Fastify({ logger: false });
  let authUser = {
    id: 1,
    username: "admin-user",
    role: "admin",
    teamId: undefined as number | undefined,
  };

  app.addHook("preHandler", async (req) => {
    req.user = authUser;
  });

  await app.register(teamsController, { prefix: "/teams" });
  await app.register(currentTeamController, { prefix: "/team" });
  await app.register(biddingController, { prefix: "/bidding" });

  const originalFetch = globalThis.fetch;
  const originalApiUrl = env.API_URL;
  const mutableEnv = env as { API_URL: string };
  mutableEnv.API_URL = "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/list";

  const acceptAssignCalls: Array<Record<string, unknown>> = [];
  let driverListMode: "normal" | "unauthorized" | "rate_limited" | "slow_normal" = "normal";
  let driverListFetchCount = 0;
  let acceptMode: "ok" | "partial_fail" | "unauthorized" = "ok";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const cookie = headers.cookie ?? headers.Cookie ?? "";

    if (url.endsWith("/api/driverservice/agency/operation/linehaul/driver/list")) {
      driverListFetchCount++;
      if (driverListMode === "unauthorized") {
        return new Response(
          JSON.stringify({ retcode: 401, message: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      if (driverListMode === "rate_limited") {
        return new Response(
          JSON.stringify({ retcode: 130008001, message: "Too many requests" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (driverListMode === "slow_normal") {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const list = cookie.includes("secret-ptwl")
        ? [
            { driver_id: 801, driver_name: "พทว หกล้อ 1", agency_name: "PTWL", vehicle_type: 13, vehicle_type_name: "6WH-6ล้อ[7.2m]" },
          ]
        : [
            { driver_id: 501, driver_name: "คนขับ หนึ่ง", agency_name: "IFN", vehicle_type: 2, vehicle_type_name: "4WH-4ล้อ" },
            { driver_id: 502, driver_name: "คนขับ สอง", agency_name: "IFN", vehicle_type: 2, vehicle_type_name: "4WH-4ล้อ" },
            { driver_id: 503, driver_name: "คนขับ สาม", agency_name: "IFN", vehicle_type: 13, vehicle_type_name: "6WH-6ล้อ[7.2m]" },
          ];
      return new Response(
        JSON.stringify({ retcode: 0, message: "Success", data: { pageno: 1, count: 5000, list } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.endsWith("/booking/bidding/accept_assign")) {
      acceptAssignCalls.push(body);
      if (acceptMode === "unauthorized") {
        return new Response(
          JSON.stringify({ retcode: 401, message: "Session expired" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const reqList = Array.isArray(body.request_id_list) ? (body.request_id_list as number[]) : [];
      if (acceptMode === "partial_fail" && reqList[0] === 67842399) {
        return new Response(
          JSON.stringify({ retcode: 131490500, message: "Booking already taken" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ retcode: 0, message: "Success", data: { success_count: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ retcode: 0, message: "Success", data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    // 1. Admin GET /teams/:id/spx-drivers starts empty
    const initRes = await app.inject({ method: "GET", url: `/teams/${team1.id}/spx-drivers` });
    assert.equal(initRes.statusCode, 200);
    assert.equal(initRes.json().data.summary.total, 0);

    // 2. Admin POST /teams/:id/spx-drivers/sync fetches & stores drivers in DB
    const syncRes = await app.inject({
      method: "POST",
      url: `/teams/${team1.id}/spx-drivers/sync`,
      payload: {},
    });
    assert.equal(syncRes.statusCode, 200);
    const syncData = syncRes.json().data;
    assert.equal(syncData.synced, 3);
    assert.equal(syncData.inserted, 3);
    assert.equal(syncData.summary.enabled, 3);
    assert.equal(syncData.drivers.length, 3);

    // 3. GET /teams reflects driversCount & enabledDriversCount
    const teamsRes = await app.inject({ method: "GET", url: "/teams" });
    assert.equal(teamsRes.statusCode, 200);
    const t1Row = teamsRes.json().data.find((t: { id: number }) => t.id === team1.id);
    assert.equal(t1Row.driversCount, 3);
    assert.equal(t1Row.enabledDriversCount, 3);

    // 4. Toggle single driver off & verify count updates
    const toggleRes = await app.inject({
      method: "PUT",
      url: `/teams/${team1.id}/spx-drivers/503`,
      payload: { enabled: false },
    });
    assert.equal(toggleRes.statusCode, 200);
    assert.equal(toggleRes.json().data.enabled, false);

    // 5. Bulk toggle back on for vehicleType=13
    const bulkRes = await app.inject({
      method: "PUT",
      url: `/teams/${team1.id}/spx-drivers/bulk-enabled`,
      payload: { enabled: true, vehicleType: 13 },
    });
    assert.equal(bulkRes.statusCode, 200);
    assert.equal(bulkRes.json().data.updatedCount, 1);
    assert.equal(bulkRes.json().data.summary.enabled, 3);

    // 6. Own-team user syncs team2 via /team/spx-drivers/sync
    authUser = { id: 2, username: "ptwl-user", role: "user", teamId: team2.id };
    const ownSyncRes = await app.inject({ method: "POST", url: "/team/spx-drivers/sync", payload: {} });
    assert.equal(ownSyncRes.statusCode, 200);
    assert.equal(ownSyncRes.json().data.synced, 1);
    assert.equal(ownSyncRes.json().data.drivers[0].driverId, 801);

    const ownGetRes = await app.inject({ method: "GET", url: "/team" });
    assert.equal(ownGetRes.statusCode, 200);
    assert.equal(ownGetRes.json().data.driversCount, 1);
    assert.equal(ownGetRes.json().data.enabledDriversCount, 1);

    // 7. Manual multi-request accept splits into unique-driver accept_assign calls
    authUser = { id: 3, username: "ifn-user", role: "user", teamId: team1.id };
    const acceptRes = await app.inject({
      method: "POST",
      url: "/bidding/accept",
      payload: {
        bookingId: 3985496,
        requestIds: [67842361, 67842362],
        vehicleType: 2,
        confirm: true,
      },
    });
    assert.equal(acceptRes.statusCode, 200);
    assert.equal(acceptAssignCalls.length, 2);
    const usedDriverIds = new Set(acceptAssignCalls.map((c) => c.driver_id));
    assert.equal(usedDriverIds.size, 2, "Manual multi-request accept must assign distinct driver_ids");
    assert.ok(usedDriverIds.has(501) && usedDriverIds.has(502));
    assert.equal(acceptRes.json().data.assignedDrivers.length, 2);
    assert.equal(acceptRes.json().data.partialSuccess, false);
    assert.deepEqual(acceptRes.json().data.acceptedRequestIds, [67842361, 67842362]);
    assert.deepEqual(acceptRes.json().data.failedRequests, []);

    // 8. Partial failure on manual multi-request accept surfaces failedRequests clearly
    acceptMode = "partial_fail";
    const partialRes = await app.inject({
      method: "POST",
      url: "/bidding/accept",
      payload: {
        bookingId: 3985499,
        requestIds: [67842398, 67842399],
        vehicleType: 2,
        confirm: true,
      },
    });
    assert.equal(partialRes.statusCode, 200);
    const partialData = partialRes.json().data;
    assert.equal(partialData.partialSuccess, true);
    assert.deepEqual(partialData.acceptedRequestIds, [67842398]);
    assert.equal(partialData.failedRequests.length, 1);
    assert.equal(partialData.failedRequests[0].requestId, 67842399);
    assert.equal(partialData.assignedDrivers.find((d: { requestId: number }) => d.requestId === 67842398)?.ok, true);
    assert.equal(partialData.assignedDrivers.find((d: { requestId: number }) => d.requestId === 67842399)?.ok, false);

    // 9. Upstream SPX 401 on manual accept returns HTTP 502 (never 401 dashboard logout)
    acceptMode = "unauthorized";
    const unauthAcceptRes = await app.inject({
      method: "POST",
      url: "/bidding/accept",
      payload: {
        bookingId: 3985500,
        requestIds: [67842401],
        vehicleType: 2,
        confirm: true,
      },
    });
    assert.equal(unauthAcceptRes.statusCode, 502, "Upstream SPX 401 on manual accept must map to HTTP 502");
    acceptMode = "ok";

    // 10. Upstream SPX 401 on driver sync returns HTTP 502 (SPX_SESSION_EXPIRED), never HTTP 401
    authUser = { id: 1, username: "admin-user", role: "admin", teamId: undefined };
    driverListMode = "unauthorized";
    const unauthSyncRes = await app.inject({
      method: "POST",
      url: `/teams/${team1.id}/spx-drivers/sync`,
      payload: {},
    });
    assert.equal(unauthSyncRes.statusCode, 502, "Upstream SPX 401 on sync must NOT return HTTP 401");
    assert.equal(unauthSyncRes.json().error_code, "SPX_SESSION_EXPIRED");

    // 11. Upstream SPX business rate limit returns HTTP 429
    driverListMode = "rate_limited";
    const rlSyncRes = await app.inject({
      method: "POST",
      url: `/teams/${team1.id}/spx-drivers/sync`,
      payload: {},
    });
    assert.equal(rlSyncRes.statusCode, 429);
    assert.equal(rlSyncRes.json().error_code, "SPX_RATE_LIMITED");

    // 12. Concurrent sync requests for the same team coalesce via single-flight into one upstream fetch
    driverListMode = "slow_normal";
    const beforeCount = driverListFetchCount;
    const [c1, c2] = await Promise.all([
      app.inject({ method: "POST", url: `/teams/${team1.id}/spx-drivers/sync`, payload: {} }),
      app.inject({ method: "POST", url: `/teams/${team1.id}/spx-drivers/sync`, payload: {} }),
    ]);
    assert.equal(c1.statusCode, 200);
    assert.equal(c2.statusCode, 200);
    assert.equal(driverListFetchCount - beforeCount, 1, "Concurrent syncs must coalesce to 1 SPX fetch");
    driverListMode = "normal";

    // 13. PUT /team/enabled preserves driversCount & enabledDriversCount
    authUser = { id: 2, username: "ptwl-user", role: "user", teamId: team2.id };
    const toggleTeamRes = await app.inject({
      method: "PUT",
      url: "/team/enabled",
      payload: { enabled: true },
    });
    assert.equal(toggleTeamRes.statusCode, 200);
    assert.equal(toggleTeamRes.json().data.driversCount, 1);
    assert.equal(toggleTeamRes.json().data.enabledDriversCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    mutableEnv.API_URL = originalApiUrl;
    await app.close();
  }

  console.log("team-spx-drivers-controller: all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
