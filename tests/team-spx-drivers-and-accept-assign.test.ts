import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { env } from "../src/config/env.js";
import { closePool, ensureDashboardTables } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import {
  getDriverCountByTeam,
  getDriverCountsByTeam,
  getDriverSummaryByTeam,
  listDriversByTeam,
  setAllTeamDriversEnabled,
  setTeamDriverEnabled,
  syncTeamDrivers,
} from "../src/repositories/team-spx-driver-repository.js";
import { ApiClient } from "../src/services/api-client.js";
import { validateAutoAcceptJobDryRunPayloadStructure } from "../src/services/auto-accept-job-dry-run.js";
import { publishAutoAcceptJob } from "../src/services/auto-accept-job-publisher.js";
import { acceptAndNotifyMatchedRules, awaitAutoAcceptVerificationIdle } from "../src/services/notifier.js";
import { createRule } from "../src/services/notify-rules.js";
import {
  TeamDriverPool,
  clearTeamDriverPoolRegistry,
  getOrCreateTeamDriverPool,
} from "../src/services/team-driver-pool.js";

async function resetDriversTable(): Promise<void> {
  await ensureDashboardTables();
  getRawMemoryDb().prepare("DELETE FROM team_spx_drivers").run();
  clearTeamDriverPoolRegistry();
}

async function testRepositorySyncPreserveEnabledAndPruneStale(): Promise<void> {
  await resetDriversTable();

  const first = await syncTeamDrivers(2, [
    { driverId: 261224, driverName: "สมชาย ใจดี", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 261225, driverName: "สมหญิง รักดี", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 261985, driverName: "วิชัย ขับเก่ง", agencyName: "IFN", vehicleType: 13, vehicleTypeName: "6WH-6ล้อ[7.2m]" },
    // Duplicate driverId in same payload should be deduplicated
    { driverId: 261224, driverName: "สมชาย ใจดี (ซ้ำ)", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
  ]);

  assert.equal(first.synced, 3);
  assert.equal(first.inserted, 3);
  assert.equal(first.updated, 0);
  assert.equal(first.removed, 0);
  assert.equal(first.summary.total, 3);
  assert.equal(first.summary.enabled, 3);
  assert.equal(first.summary.byVehicleType.length, 2);

  // Disable one driver manually — next sync MUST preserve enabled=false
  const toggled = await setTeamDriverEnabled(2, 261225, false);
  assert.equal(toggled?.enabled, false);

  // Sync again: 261224 updated, 261225 still disabled, 261985 removed, 262000 inserted
  const second = await syncTeamDrivers(2, [
    { driverId: 261224, driverName: "สมชาย ใจดี (อัปเดต)", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 261225, driverName: "สมหญิง รักดี", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 262000, driverName: "ประเสริฐ หกล้อ", agencyName: "IFN", vehicleType: 13, vehicleTypeName: "6WH-6ล้อ[7.2m]" },
  ]);

  assert.equal(second.synced, 3);
  assert.equal(second.inserted, 1);
  assert.equal(second.updated, 2);
  assert.equal(second.removed, 1);

  const allTeam2 = await listDriversByTeam(2);
  assert.equal(allTeam2.length, 3);
  const disabledRow = allTeam2.find((d) => d.driverId === 261225);
  assert.equal(disabledRow?.enabled, false, "Re-sync must preserve existing enabled=false toggle");
  assert.equal(allTeam2.find((d) => d.driverId === 261224)?.driverName, "สมชาย ใจดี (อัปเดต)");
  assert.equal(allTeam2.find((d) => d.driverId === 261985), undefined, "Stale driver missing from SPX must be pruned");

  // Team isolation: syncing team 3 must not affect team 2
  await syncTeamDrivers(3, [
    { driverId: 900001, driverName: "ทีมสาม คนขับ", agencyName: "PTWL", vehicleType: 13, vehicleTypeName: "6WH-6ล้อ[7.2m]" },
  ]);
  assert.equal((await listDriversByTeam(2)).length, 3);
  assert.equal((await listDriversByTeam(3)).length, 1);

  const changedCount = await setAllTeamDriversEnabled(2, true, 2);
  assert.equal(changedCount, 2);
  const summary = await getDriverSummaryByTeam(2);
  assert.equal(summary.enabled, 3);
  assert.deepEqual(await getDriverCountByTeam(2), { total: 3, enabled: 3 });

  // Empty upstream glitch guard: syncing an empty list MUST NOT wipe existing drivers
  const emptySync = await syncTeamDrivers(2, []);
  assert.equal(emptySync.synced, 0);
  assert.equal(emptySync.removed, 0);
  assert.equal((await listDriversByTeam(2)).length, 3, "Empty sync must preserve existing drivers");
}

async function testDriverPoolUniqueNamesAndStrictVehicleType(): Promise<void> {
  await resetDriversTable();

  await syncTeamDrivers(2, [
    { driverId: 101, driverName: "คนขับ ก", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 102, driverName: "คนขับ ก", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" }, // duplicate name!
    { driverId: 103, driverName: "คนขับ ข", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 104, driverName: "คนขับ ค", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 201, driverName: "หกล้อ 1", agencyName: "IFN", vehicleType: 13, vehicleTypeName: "6WH-6ล้อ[7.2m]" },
    { driverId: 202, driverName: "หกล้อ 2", agencyName: "IFN", vehicleType: 13, vehicleTypeName: "6WH-6ล้อ[7.2m]" },
  ]);

  let seed = 0.25;
  const pool = new TeamDriverPool({
    teamId: 2,
    random: () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    },
  });
  await pool.init();

  // Allocate 3 drivers for vehicleType=2: must have 3 DISTINCT driver_names (not both 101 and 102!)
  const batch = pool.allocateDrivers({ count: 3, vehicleTypeId: 2, bookingId: 5001 });
  assert.equal(batch.length, 3);
  const names = new Set(batch.map((d) => d.driverName.trim().toLowerCase()));
  const ids = new Set(batch.map((d) => d.driverId));
  assert.equal(names.size, 3, "Allocated drivers in a batch must have non-duplicate driver names");
  assert.equal(ids.size, 3, "Allocated drivers in a batch must have non-duplicate driver IDs");
  assert.ok(batch.every((d) => d.vehicleType === 2), "All drivers must strictly match vehicleType=2");

  // Strict vehicleType: requesting vehicleType=8 (none synced) must NOT fall back to 4W/6W drivers
  const missingType = pool.allocateDrivers({ count: 1, vehicleTypeId: 8, bookingId: 5002 });
  assert.equal(missingType.length, 0, "Must not assign wrong vehicleType driver");

  // Match by vehicleTypeName when numeric vehicleTypeId is absent
  const byName = pool.allocateDrivers({ count: 2, vehicleTypeName: "6WH-6ล้อ[7.2m]", bookingId: 5003 });
  assert.equal(byName.length, 2);
  assert.equal(new Set(byName.map((d) => d.driverName)).size, 2);
  assert.ok(byName.every((d) => d.vehicleType === 13));

  // Cooldown excludes failed driver
  pool.recordDriverFailure(201, 60_000);
  const nextAfterFail = pool.nextDriver({ vehicleTypeId: 13, bookingId: 5004 });
  assert.equal(nextAfterFail?.driverId, 202);
}

async function testApiClientFetchDriversAndAcceptAssign(): Promise<void> {
  await resetDriversTable();

  const originalFetch = globalThis.fetch;
  const originalApiUrl = env.API_URL;
  const mutableEnv = env as { API_URL: string };
  mutableEnv.API_URL = "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/list";

  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body });

    if (url.endsWith("/api/driverservice/agency/operation/linehaul/driver/list")) {
      return new Response(
        JSON.stringify({
          retcode: 0,
          message: "Success",
          data: {
            pageno: 1,
            count: 5000,
            list: [
              { driver_id: 261224, driver_name: "สมชาย", agency_name: "IFN", vehicle_type: 2, vehicle_type_name: "4WH-4ล้อ" },
              { driver_id: 261985, driver_name: "วิชัย", agency_name: "IFN", vehicle_type: 13, vehicle_type_name: "6WH-6ล้อ[7.2m]" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ retcode: 0, message: "Success", data: { success_count: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    // 1. Fetch linehaul drivers
    const fetchClient = new ApiClient({
      credentials: { spxCookie: "fms_user_skey=test", spxDeviceId: "dev-1" },
    });
    const driverRes = await fetchClient.fetchLinehaulDrivers({ count: 5000 });
    assert.equal(driverRes.ok, true);
    assert.equal(driverRes.drivers.length, 2);
    assert.equal(calls[0]?.url, "https://logistics.myagencyservice.in.th/api/driverservice/agency/operation/linehaul/driver/list");
    assert.deepEqual(calls[0]?.body, { count: 5000 });

    // 2. Sync to DB and attach TeamDriverPool via driverResolver
    await syncTeamDrivers(
      2,
      driverRes.drivers.map((d) => ({
        driverId: d.driver_id,
        driverName: d.driver_name,
        agencyName: d.agency_name,
        vehicleType: d.vehicle_type,
        vehicleTypeName: d.vehicle_type_name,
      })),
    );
    const driverPool = await getOrCreateTeamDriverPool(2);
    const clientWithDrivers = new ApiClient({
      credentials: { spxCookie: "fms_user_skey=test", spxDeviceId: "dev-1" },
      biddingVehicleType: 13,
      driverResolver: (input) => driverPool.nextDriver(input),
    });

    const acceptRes = await clientWithDrivers.acceptBookingRequests(3985496, [67842363], {
      vehicleTypeId: 2,
      vehicleTypeName: "4WH-4ล้อ",
    });
    assert.equal(acceptRes.ok, true);
    assert.equal(acceptRes.assignedDriver?.driverId, 261224);
    assert.equal(acceptRes.assignedDriver?.driverName, "สมชาย");

    const acceptCall = calls[1];
    assert.equal(acceptCall?.url, "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/accept_assign");
    assert.deepEqual(acceptCall?.body, {
      booking_id: 3985496,
      accept_all: false,
      exclude_id_list: [],
      request_id_list: [67842363],
      bundle_task_id_list: [],
      driver_id: 261224,
      vehicle_plate_number: "",
      warning_confirmed: false,
    });

    // 3. acceptAllBookingRequests uses biddingVehicleType=13 driver
    const acceptAllRes = await clientWithDrivers.acceptAllBookingRequests(3985497);
    assert.equal(acceptAllRes.ok, true);
    assert.equal(acceptAllRes.assignedDriver?.driverId, 261985);
    assert.equal(calls[2]?.url, "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/accept_assign");
    assert.equal(calls[2]?.body.accept_all, true);
    assert.equal(calls[2]?.body.driver_id, 261985);

    // 4. Backward compatibility: without driverResolver or driverId, falls back to legacy /booking/bidding/accept
    const legacyRes = await fetchClient.acceptBookingRequests(3985498, [67842364]);
    assert.equal(legacyRes.ok, true);
    assert.equal(calls[3]?.url, "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/accept");
    assert.deepEqual(calls[3]?.body, {
      booking_id: 3985498,
      accept_all: false,
      request_id_list: [67842364],
    });
  } finally {
    globalThis.fetch = originalFetch;
    mutableEnv.API_URL = originalApiUrl;
  }
}

async function testMultiRequestAutoAcceptAssignsUniqueNonDuplicateDriverNames(): Promise<void> {
  await resetDriversTable();
  const db = getRawMemoryDb();
  db.prepare("DELETE FROM notify_rules WHERE team_id = 2").run();
  db.prepare("DELETE FROM auto_accept_history WHERE team_id = 2").run();

  await syncTeamDrivers(2, [
    { driverId: 301, driverName: "สมชาย หนึ่ง", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 302, driverName: "สมชาย หนึ่ง", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" }, // duplicate name!
    { driverId: 303, driverName: "สมหญิง สอง", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 304, driverName: "สมศักดิ์ สาม", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
  ]);

  await createRule(2, {
    name: "Multi 4W unique drivers",
    origins: ["NORC"],
    destinations: ["SOCN"],
    vehicle_types: ["4WH-4ล้อ"],
    need: 3,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
  });

  const driverPool = await getOrCreateTeamDriverPool(2);
  const originalFetch = globalThis.fetch;
  const originalApiUrl = env.API_URL;
  const mutableEnv = env as { API_URL: string };
  mutableEnv.API_URL = "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/list";

  const acceptAssignCalls: Array<Record<string, unknown>> = [];
  const acceptedRequestIds = new Set<number>();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (url.endsWith("/booking/bidding/accept_assign")) {
      acceptAssignCalls.push(body);
      for (const reqId of (body.request_id_list as number[]) ?? []) {
        acceptedRequestIds.add(reqId);
      }
      return new Response(
        JSON.stringify({ retcode: 0, message: "Success", data: { success_count: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.endsWith("/booking/bidding/request/list")) {
      const requestList = [7001, 7002, 7003].map((requestId) => ({
        request_id: requestId,
        booking_id: 9001,
        vehicle_type: 2,
        vehicle_type_name: "4WH-4ล้อ",
        request_acceptance_status: acceptedRequestIds.has(requestId) ? 2 : 1,
        request_assignment_status: acceptedRequestIds.has(requestId) ? 3 : 1,
        route_detail_list: [],
      }));
      return new Response(
        JSON.stringify({ retcode: 0, message: "Success", data: { pageno: 1, count: 100, total: 3, request_list: requestList } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ retcode: 0, message: "Success", data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const apiClient = new ApiClient({
      credentials: { spxCookie: "fms_user_skey=test", spxDeviceId: "dev-1" },
      driverResolver: (input) => driverPool.nextDriver(input),
      hasAutoDrivers: () => driverPool.hasDrivers(),
    });

    const trips = [7001, 7002, 7003].map((requestId) => ({
      booking_id: 9001,
      request_id: requestId,
      origin: "NORC",
      destination: "SOCN",
      vehicle_type: "4WH-4ล้อ",
      vehicle_type_id: 2,
      "ต้นทาง": "NORC",
      "ปลายทาง": "SOCN",
      "ประเภทรถ": "4WH-4ล้อ",
      acceptance_status: 1,
    }));

    const result = await acceptAndNotifyMatchedRules(trips, apiClient, {
      teamId: 2,
      dryRun: true,
      verificationMode: "inline",
    });

    assert.equal(result.accepted.length, 3, "All 3 matched requests should be accepted");
    assert.equal(acceptAssignCalls.length, 3, "Multi-request batch must split into 3 accept_assign calls for unique drivers");

    const driverIdByReq = new Map<number, number>();
    for (const call of acceptAssignCalls) {
      const reqList = call.request_id_list as number[];
      assert.equal(reqList.length, 1, "Each accept_assign call should target 1 request_id");
      assert.equal(call.booking_id, 9001);
      assert.equal(call.accept_all, false);
      assert.equal(call.vehicle_plate_number, "");
      assert.equal(call.warning_confirmed, false);
      driverIdByReq.set(reqList[0], call.driver_id as number);
    }

    const assignedDriverIds = [...driverIdByReq.values()];
    assert.equal(new Set(assignedDriverIds).size, 3, "All 3 requests must have distinct driver_ids");

    const allDrivers = await listDriversByTeam(2);
    const nameById = new Map(allDrivers.map((d) => [d.driverId, d.driverName]));
    const assignedDriverNames = assignedDriverIds.map((id) => nameById.get(id));
    assert.equal(
      new Set(assignedDriverNames).size,
      3,
      `All 3 requests must have distinct driver names, got: ${assignedDriverNames.join(", ")}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    mutableEnv.API_URL = originalApiUrl;
  }
}

async function testStrictVehicleTypeEdgeCasesAndPoolLifecycle(): Promise<void> {
  await resetDriversTable();

  await syncTeamDrivers(2, [
    { driverId: 401, driverName: "สี่ล้อ หนึ่ง", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 402, driverName: "สี่ล้อ สอง", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 403, driverName: "หกล้อ สั้น", agencyName: "IFN", vehicleType: 14, vehicleTypeName: "6WH-6ล้อ" },
    { driverId: 404, driverName: "หกล้อ ใหญ่", agencyName: "IFN", vehicleType: 15, vehicleTypeName: "6WH-6ล้อจัมโบ้" },
  ]);

  const pool = new TeamDriverPool({ teamId: 2, random: () => 0.1 });
  await pool.init();

  // 1. Placeholder "-" must NEVER match hyphenated vehicle type names
  assert.equal(pool.nextDriver({ vehicleTypeName: "-", bookingId: 6001 }), null, "Placeholder '-' must not match any vehicle type");
  assert.equal(pool.nextDriver({ vehicleTypeName: "  --  ", bookingId: 6001 }), null);

  // 2. Numeric vehicleTypeId=13 miss MUST NOT fuzzy-fallback to vehicleType=14 ("6WH-6ล้อ")
  assert.equal(
    pool.nextDriver({ vehicleTypeId: 13, vehicleTypeName: "6WH-6ล้อ[7.2m]", bookingId: 6002 }),
    null,
    "Numeric vehicleTypeId miss must not cross-assign different vehicleType via substring containment",
  );

  // 3. Ambiguous containment ("6WH" matches both type 14 and type 15) returns null; unambiguous ("4WH") resolves to type 2
  assert.equal(pool.nextDriver({ vehicleTypeName: "6WH", bookingId: 6003 }), null, "Ambiguous vehicleTypeName must not guess");
  assert.equal(pool.nextDriver({ vehicleTypeName: "4WH", bookingId: 6004 })?.vehicleType, 2);

  // 4. Multi-fleet team with no vehicleType hint must not randomly mix vehicle types
  assert.equal(pool.nextDriver({ bookingId: 6005 }), null, "Multi-fleet pool must require vehicle type");

  // 5. Release on transient accept failure allows retries for the same bookingId without starving
  const d1 = pool.nextDriver({ vehicleTypeId: 2, bookingId: 6006 });
  const d2 = pool.nextDriver({ vehicleTypeId: 2, bookingId: 6006 });
  assert.ok(d1 && d2 && d1.driverId !== d2.driverId);
  pool.releaseBookingDriver(6006, d1.driverId, d1.driverName);
  const retryPick = pool.nextDriver({ vehicleTypeId: 2, bookingId: 6006 });
  assert.equal(retryPick?.driverId, d1.driverId, "Released driver must be reusable for retries on the same bookingId");

  // 6. Booking exhaustion falls back within the SAME vehicleType instead of returning null
  const extraPick = pool.nextDriver({ vehicleTypeId: 2, bookingId: 6006 });
  assert.ok(extraPick && extraPick.vehicleType === 2, "Exhausted booking should reuse a driver from the same vehicle type");
  assert.equal(
    pool.nextDriver({ vehicleTypeId: 2, bookingId: 6006, excludeDriverIds: [401, 402] }),
    null,
    "Explicit excludeDriverIds must still be respected",
  );

  // 7. Single-fleet team resolves even when no vehicleType hint is provided
  await resetDriversTable();
  await syncTeamDrivers(2, [
    { driverId: 410, driverName: "เดี่ยว 1", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
  ]);
  const singlePool = new TeamDriverPool({ teamId: 2 });
  await singlePool.init();
  assert.equal(singlePool.nextDriver({ bookingId: 6007 })?.driverId, 410);

  // 8. Queued reloadDrivers() guarantees commits made during an in-flight reload are picked up
  let loadCalls = 0;
  let releaseFirstLoad!: () => void;
  const firstLoadGate = new Promise<void>((resolve) => {
    releaseFirstLoad = resolve;
  });
  const queuedPool = new TeamDriverPool({
    teamId: 2,
    loadDrivers: async () => {
      loadCalls++;
      if (loadCalls === 1) {
        await firstLoadGate;
        return [
          {
            id: 1, teamId: 2, driverId: 1, driverName: "Old", agencyName: "IFN",
            vehicleType: 2, vehicleTypeName: "4WH-4ล้อ", enabled: true, syncedAt: "", createdAt: "", updatedAt: "",
          },
        ];
      }
      return [
        {
          id: 2, teamId: 2, driverId: 2, driverName: "Fresh", agencyName: "IFN",
          vehicleType: 2, vehicleTypeName: "4WH-4ล้อ", enabled: true, syncedAt: "", createdAt: "", updatedAt: "",
        },
      ];
    },
  });
  const firstReload = queuedPool.reloadDrivers();
  const secondReload = queuedPool.reloadDrivers();
  releaseFirstLoad();
  await Promise.all([firstReload, secondReload]);
  assert.equal(loadCalls, 2, "Overlapping reloadDrivers() must trigger one follow-up reload");
  assert.equal(queuedPool.nextDriver({ vehicleTypeId: 2 })?.driverId, 2);
}

async function testConcurrentSyncNilSliceAndDbGrants(): Promise<void> {
  await resetDriversTable();

  // Concurrent syncTeamDrivers on the same team must succeed atomically with no UNIQUE errors
  const payload = [
    { driverId: 901, driverName: "พร้อมกัน 1", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    { driverId: 902, driverName: "พร้อมกัน 2", agencyName: "IFN", vehicleType: 13, vehicleTypeName: "6WH-6ล้อ[7.2m]" },
  ];
  await Promise.all([
    syncTeamDrivers(2, payload),
    syncTeamDrivers(2, payload),
  ]);
  const counts = await getDriverCountsByTeam();
  assert.deepEqual(counts.get(2), { total: 2, enabled: 2 });

  // Go nil-slice `data.list: null` and placeholder "-" in ApiClient
  const originalFetch = globalThis.fetch;
  const originalApiUrl = env.API_URL;
  const mutableEnv = env as { API_URL: string };
  mutableEnv.API_URL = "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/list";

  let lastAcceptBody: Record<string, unknown> | null = null;
  let releasedCalled = false;
  let acceptAttempt = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/driver/list")) {
      return new Response(
        JSON.stringify({ retcode: 0, message: "Success", data: { pageno: 1, count: 5000, list: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    lastAcceptBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    acceptAttempt++;
    if (acceptAttempt === 1) {
      return new Response(
        JSON.stringify({ retcode: 130008001, message: "Rate limit" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ retcode: 0, message: "Success", data: { success_count: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const driverPool = await getOrCreateTeamDriverPool(2);
    const apiClient = new ApiClient({
      credentials: { spxCookie: "fms_user_skey=test", spxDeviceId: "dev-1" },
      biddingVehicleType: 2,
      driverResolver: (input) => driverPool.nextDriver(input),
      onDriverAcceptReleased: (bookingId, driverId, driverName) => {
        releasedCalled = true;
        driverPool.releaseBookingDriver(bookingId, driverId, driverName);
      },
    });

    const nilListRes = await apiClient.fetchLinehaulDrivers({ count: 5000 });
    assert.equal(nilListRes.ok, true, "Go nil-slice data.list: null should succeed with empty drivers array");
    assert.deepEqual(nilListRes.drivers, []);

    // Placeholder vehicleTypeName: "-" must fall back to team biddingVehicleType=2 (driverId=901)
    const failRes = await apiClient.acceptBookingRequests(8801, [9901], { vehicleTypeName: "-" });
    assert.equal(failRes.ok, false);
    assert.equal(releasedCalled, true, "Non-ambiguous accept failure must release booking driver lock");
    assert.equal(lastAcceptBody?.driver_id, 901);

    const retryRes = await apiClient.acceptBookingRequests(8801, [9901], { vehicleTypeName: "-" });
    assert.equal(retryRes.ok, true);
    assert.equal(lastAcceptBody?.driver_id, 901);
  } finally {
    globalThis.fetch = originalFetch;
    mutableEnv.API_URL = originalApiUrl;
  }

  // Verify deploy/db-grants.json grants for team_spx_drivers
  const grants = JSON.parse(readFileSync("deploy/db-grants.json", "utf8")) as {
    roles: Record<string, { tables: Record<string, string[]> }>;
  };
  assert.deepEqual(grants.roles["web-api"].tables.team_spx_drivers, ["SELECT", "INSERT", "UPDATE", "DELETE"]);
  for (const role of ["worker-ifn-split", "worker-ptwl-split", "auto-accept-ifn-phase3", "auto-accept-ptwl-phase3"]) {
    assert.deepEqual(grants.roles[role].tables.team_spx_drivers, ["SELECT"], `${role} must have SELECT on team_spx_drivers`);
  }
  assert.equal(grants.roles["poller-ifn-phase3"].tables.team_spx_drivers, undefined);
  assert.equal(grants.roles["poller-ptwl-phase3"].tables.team_spx_drivers, undefined);
}

async function testDisambiguationPaginationDetachedSplitAndFastAcceptAll(): Promise<void> {
  await resetDriversTable();

  // 1. Shorthand "6WH" disambiguation with preferredVehicleTypeId & bracketed non-downgrade
  await syncTeamDrivers(2, [
    { driverId: 1201, driverName: "หกล้อ ห้าเมตร", agencyName: "IFN", vehicleType: 12, vehicleTypeName: "6WH-6ล้อ[5.5m]" },
    { driverId: 1301, driverName: "หกล้อ เจ็ดเมตร", agencyName: "IFN", vehicleType: 13, vehicleTypeName: "6WH-6ล้อ[7.2m]" },
    { driverId: 1401, driverName: "หกล้อ ทั่วไป", agencyName: "IFN", vehicleType: 14, vehicleTypeName: "6WH-6ล้อ" },
  ]);

  let nowMs = 100_000;
  let reloadFailCalls = 0;
  const pool = new TeamDriverPool({ teamId: 2, clock: () => nowMs, random: () => 0.1 });
  await pool.init();

  assert.equal(pool.nextDriver({ vehicleTypeName: "6WH" }), null, "Ambiguous '6WH' without preferredVehicleTypeId returns null");
  assert.equal(
    pool.nextDriver({ vehicleTypeName: "6WH", preferredVehicleTypeId: 13 })?.driverId,
    1301,
    "preferredVehicleTypeId disambiguates shorthand '6WH' to type 13",
  );
  assert.equal(
    pool.canResolveDriver({ vehicleTypeId: 8 }),
    false,
    "canResolveDriver returns false when no drivers exist for vehicleType=8",
  );

  // Bracketed subtype must NOT downgrade via reverse containment to generic "6WH-6ล้อ"
  await resetDriversTable();
  await syncTeamDrivers(2, [
    { driverId: 1401, driverName: "หกล้อ ทั่วไป", agencyName: "IFN", vehicleType: 14, vehicleTypeName: "6WH-6ล้อ" },
  ]);
  const genericOnlyPool = new TeamDriverPool({ teamId: 2, clock: () => nowMs });
  await genericOnlyPool.init();
  assert.equal(
    genericOnlyPool.nextDriver({ vehicleTypeName: "6WH-6ล้อ[7.2m]" }),
    null,
    "Specific bracketed subtype must not downgrade to generic type via reverse containment",
  );

  // Reload failure backoff prevents tight-loop retries during DB outages
  const failingPool = new TeamDriverPool({
    teamId: 2,
    clock: () => nowMs,
    loadDrivers: async () => {
      reloadFailCalls++;
      throw new Error("simulated DB outage");
    },
  });
  await failingPool.init();
  assert.equal(reloadFailCalls, 1);
  nowMs += 2_000;
  failingPool.triggerBackgroundReloadIfStale(30_000, 10_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reloadFailCalls, 1, "Failure backoff should suppress immediate background retries");
  nowMs += 11_000;
  failingPool.triggerBackgroundReloadIfStale(30_000, 10_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reloadFailCalls, 2, "Background reload should resume after failure backoff expires");

  // 2. fetchLinehaulDrivers pagination & truncation fail-safe
  const originalFetch = globalThis.fetch;
  const originalApiUrl = env.API_URL;
  const mutableEnv = env as { API_URL: string };
  mutableEnv.API_URL = "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/list";

  let paginationMode: "multi_page" | "truncated_same_page" = "multi_page";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const pageNo = typeof body.pageno === "number" ? body.pageno : 1;
    if (paginationMode === "multi_page") {
      const list = pageNo === 1
        ? [{ driver_id: 1, driver_name: "A", agency_name: "IFN", vehicle_type: 2, vehicle_type_name: "4WH-4ล้อ" }]
        : [{ driver_id: 2, driver_name: "B", agency_name: "IFN", vehicle_type: 2, vehicle_type_name: "4WH-4ล้อ" }];
      return new Response(
        JSON.stringify({ retcode: 0, message: "Success", data: { pageno: pageNo, count: 1, total: 2, list } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        retcode: 0,
        message: "Success",
        data: {
          pageno: 1,
          count: 1,
          total: 2,
          list: [{ driver_id: 1, driver_name: "A", agency_name: "IFN", vehicle_type: 2, vehicle_type_name: "4WH-4ล้อ" }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const client = new ApiClient({ credentials: { spxCookie: "fms_user_skey=test", spxDeviceId: "dev-1" } });
    const merged = await client.fetchLinehaulDrivers({ count: 1 });
    assert.equal(merged.ok, true);
    assert.equal(merged.drivers.length, 2, "Multi-page driver list should merge pages cleanly");

    paginationMode = "truncated_same_page";
    const truncated = await client.fetchLinehaulDrivers({ count: 1 });
    assert.equal(truncated.ok, false, "Truncated upstream response with ignored pageno must fail safe");
    assert.match(truncated.error ?? "", /truncated/i);

    // 3. Detached verification multi-request auto-accept splitting assigns unique driver names
    await resetDriversTable();
    const db = getRawMemoryDb();
    db.prepare("DELETE FROM notify_rules WHERE team_id = 2").run();
    db.prepare("DELETE FROM auto_accept_verification_jobs WHERE team_id = 2").run();
    await syncTeamDrivers(2, [
      { driverId: 701, driverName: "ดีแทช หนึ่ง", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
      { driverId: 702, driverName: "ดีแทช สอง", agencyName: "IFN", vehicleType: 2, vehicleTypeName: "4WH-4ล้อ" },
    ]);
    await createRule(2, {
      name: "Detached 4W unique",
      origins: ["NORC"],
      destinations: ["SOCN"],
      vehicle_types: ["4WH-4ล้อ"],
      need: 2,
      enabled: true,
      fulfilled: false,
      auto_accept: true,
      accept_all: false,
    });
    const detachedPool = await getOrCreateTeamDriverPool(2);
    const detachedCalls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (url.endsWith("/booking/bidding/accept_assign")) {
        detachedCalls.push(body);
        return new Response(
          JSON.stringify({ retcode: 0, message: "Success", data: { success_count: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          retcode: 0,
          message: "Success",
          data: {
            pageno: 1,
            count: 100,
            total: 2,
            request_list: [7101, 7102].map((requestId) => ({
              request_id: requestId,
              booking_id: 9101,
              vehicle_type: 2,
              vehicle_type_name: "4WH-4ล้อ",
              request_acceptance_status: 2,
              request_assignment_status: 3,
              route_detail_list: [],
            })),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const detachedClient = new ApiClient({
      credentials: { spxCookie: "fms_user_skey=test", spxDeviceId: "dev-1" },
      driverResolver: (input) => detachedPool.nextDriver(input),
      hasAutoDrivers: (input) => (input ? detachedPool.canResolveDriver(input) : detachedPool.hasDrivers()),
    });
    await acceptAndNotifyMatchedRules(
      [7101, 7102].map((requestId) => ({
        booking_id: 9101,
        request_id: requestId,
        origin: "NORC",
        destination: "SOCN",
        vehicle_type: "4WH-4ล้อ",
        vehicle_type_id: 2,
        "ต้นทาง": "NORC",
        "ปลายทาง": "SOCN",
        "ประเภทรถ": "4WH-4ล้อ",
        acceptance_status: 1,
      })),
      detachedClient,
      { teamId: 2, dryRun: true, verificationMode: "detached" },
    );
    await awaitAutoAcceptVerificationIdle();
    assert.equal(detachedCalls.length, 2, "Detached multi-request auto-accept must split per request");
    assert.equal(new Set(detachedCalls.map((c) => c.driver_id)).size, 2, "Detached calls must assign distinct driver_ids");
  } finally {
    globalThis.fetch = originalFetch;
    mutableEnv.API_URL = originalApiUrl;
  }

  // 4. fast_accept_all job with vehicle_type trip hint passes dry-run payload structure validation
  const published = await publishAutoAcceptJob({
    executionMode: "shadow",
    teamId: 2,
    bookingId: 9202,
    requestId: 0,
    ruleId: "rule-fast-vt",
    ruleName: "Fast 6W",
    attemptKind: "fast_accept_all",
    acceptAll: true,
    source: "booking_name",
    bookingName: "[ADHOC] NORC-SOCN",
    trip: { booking_id: 9202, vehicle_type_id: 13, vehicle_type: "6WH-6ล้อ[7.2m]" },
    ruleSnapshot: { need: 1, accept_all: true, enabled: true, fulfilled: false },
    pollerNodeId: "test-poller",
  });
  assert.equal(published.published, true);
  if (published.published) {
    const validated = validateAutoAcceptJobDryRunPayloadStructure(published.job);
    assert.equal(validated.ok, true, "fast_accept_all payload with vehicle_type trip hint must validate cleanly");
  }
}

async function run(): Promise<void> {
  try {
    await testRepositorySyncPreserveEnabledAndPruneStale();
    await testDriverPoolUniqueNamesAndStrictVehicleType();
    await testApiClientFetchDriversAndAcceptAssign();
    await testMultiRequestAutoAcceptAssignsUniqueNonDuplicateDriverNames();
    await testStrictVehicleTypeEdgeCasesAndPoolLifecycle();
    await testConcurrentSyncNilSliceAndDbGrants();
    await testDisambiguationPaginationDetachedSplitAndFastAcceptAll();
    console.log("team-spx-drivers-and-accept-assign: all tests passed");
  } finally {
    await closePool();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
