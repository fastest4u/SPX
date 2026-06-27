import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { NeedBudget, awaitAutoAcceptVerificationIdle } from "../src/services/notifier.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import type { NotifyRule } from "../src/services/notify-rules.js";

process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "poller-auto-accept-detached-verify-test-key";

const mutableEnv = env as unknown as {
  AUTO_ACCEPT_ENABLED: boolean;
  BIDDING_VEHICLE_TYPE?: number;
  FETCH_DETAILS: boolean;
  SAVE_TO_DB: boolean;
};

const original = {
  AUTO_ACCEPT_ENABLED: mutableEnv.AUTO_ACCEPT_ENABLED,
  BIDDING_VEHICLE_TYPE: mutableEnv.BIDDING_VEHICLE_TYPE,
  FETCH_DETAILS: mutableEnv.FETCH_DETAILS,
  SAVE_TO_DB: mutableEnv.SAVE_TO_DB,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestList(requests: BookingRequestListResponse["data"]["request_list"]): BookingRequestListResponse {
  return {
    retcode: 0,
    message: "",
    data: {
      pageno: 1,
      count: requests.length,
      total: requests.length,
      request_list: requests,
    },
  };
}

function requestListItem(requestId: number, status: number): BookingRequestListResponse["data"]["request_list"][number] {
  return {
    onsite_id: requestId,
    request_id: requestId,
    booking_id: 2706815,
    booking_date: 1782144000,
    report_station_id: 0,
    report_station_name: "",
    cost_type: 1,
    shift_type: 1,
    trip_type: 2,
    trip_path: null,
    route_path: null,
    route_level: 0,
    vehicle_type: 13,
    vehicle_type_name: "6WH-6ล้อ[7.2m]",
    vehicle_plate_number: "",
    driver_id: 0,
    driver_name: "",
    driver_contact_number: "",
    standby_time: 480,
    remark: "",
    request_acceptance_status: status,
    request_assignment_status: 3,
    request_fulfilled_status: 0,
    request_assign_ddl: 0,
    assign_able: 0,
    display_countdown_assign: 0,
    child_request_edit: false,
    request_mtime: 0,
    route_detail_list: [
      { route_level: 0, node_id: 1, station_type_list: [], station_type_name_list: null, node_info_list: [{ name: "A", address_info: { l1: "", l2: "" } }] },
      { route_level: 1, node_id: 2, station_type_list: [], station_type_name_list: null, node_info_list: [{ name: "B", address_info: { l1: "", l2: "" } }] },
    ],
    trip_limit: 0,
    partially_canceled: false,
    origin_driver_id: 0,
    origin_driver_name: "",
    right_vehicle_type: 0,
    right_vehicle_type_name: "",
    replacement_vehicle_type: 0,
    replacement_vehicle_type_name: "",
    replacement_vehicle_plate_number: "",
  };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 3_000;
  let lastValue: T;
  do {
    lastValue = await read();
    if (done(lastValue)) return lastValue;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { closePool } = await import("../src/db/client.js");
  const teams = await import("../src/repositories/team-repository.js");
  const rules = await import("../src/services/notify-rules.js");
  const { getAutoAcceptHistory } = await import("../src/repositories/auto-accept-repository.js");

  resetMemoryDb();
  setLogLevel(LogLevel.ERROR);
  Object.assign(mutableEnv, {
    AUTO_ACCEPT_ENABLED: true,
    BIDDING_VEHICLE_TYPE: 13,
    FETCH_DETAILS: false,
    SAVE_TO_DB: false,
  });

  const team = await teams.createTeam({
    name: "Poller Detached Team",
    enabled: true,
    spxCookie: "cookie",
    spxDeviceId: "device",
    lineGroupId: "",
  });
  const rule = await rules.createRule(team.id, {
    name: "Poller Detached",
    origins: ["A"],
    destinations: ["B"],
    vehicle_types: ["6WH"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  });

  const poller = new Poller(undefined, {
    teamId: team.id,
    teamName: team.name,
    lineGroupId: "",
    manageHttpServer: false,
    manageProcessSignals: false,
    closeSharedResourcesOnStop: false,
    exitOnStop: false,
  });
  Object.assign(poller as unknown as { tickAutoAcceptRules: NotifyRule[]; tickNeedBudget: NeedBudget }, {
    tickAutoAcceptRules: [rule],
    tickNeedBudget: new NeedBudget(),
  });

  const verifyGate = deferred();
  const events: string[] = [];
  Object.assign(poller as unknown as { apiClient: unknown }, {
    apiClient: {
      fetchBookingRequestList: async (_bookingId: number, options?: {
        onPage?: (response: BookingRequestListResponse) => boolean | void;
        tabPendingConfirmation?: boolean;
      }) => {
        if (options?.onPage) {
          events.push("list");
          const page = requestList([requestListItem(38659805, 1)]);
          options.onPage(page);
          return page;
        }
        events.push(options?.tabPendingConfirmation === false ? "verify-confirmed" : "verify-pending");
        await verifyGate.promise;
        return options?.tabPendingConfirmation === false
          ? requestList([requestListItem(38659805, 2)])
          : requestList([]);
      },
      acceptBookingRequests: async () => {
        events.push("accept");
        return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } };
      },
    },
  });

  const booking = {
    booking_id: 2706815,
    booking_name: "[ADHOC] A to B",
    agency_name: "SPX",
    ctime: Math.floor((Date.now() - 1_500) / 1000),
  } as Booking;

  const processPromise = (poller as unknown as {
    processOneBooking: (booking: Booking) => Promise<boolean>;
  }).processOneBooking(booking);

  const race = await Promise.race([
    processPromise.then(() => "resolved"),
    delay(75).then(() => "blocked"),
  ]);

  assert.equal(events[0], "list");
  assert.equal(events[1], "accept");
  assert.ok(events.includes("verify-pending"));
  assert.ok(events.includes("verify-confirmed"));
  assert.equal(race, "resolved", "processOneBooking should not wait for detached verification");
  assert.equal(await processPromise, true);

  verifyGate.resolve();
  await awaitAutoAcceptVerificationIdle();

  const rows = await waitFor(
    () => getAutoAcceptHistory(team.id, { limit: 20 }),
    (items) => items.some((item) => item.bookingId === 2706815 && item.status === "success"),
    "detached poller success history",
  );
  const row = rows.find((item) => item.bookingId === 2706815);
  assert.equal(row?.verificationStatus, "verified_success");
  assert.deepEqual(row?.requestIds, [38659805]);
  assert.equal(typeof row?.listAgeMs, "number");
  assert.ok((row?.listAgeMs ?? 0) >= 0);

  const updatedRule = (await rules.readRules(team.id)).find((item) => item.id === rule.id);
  assert.equal(updatedRule?.need, 0);

  await closePool();
  console.log("poller-auto-accept-detached-verify: all assertions passed");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(() => {
    Object.assign(mutableEnv, original);
    setLogLevel(LogLevel.INFO);
  });
