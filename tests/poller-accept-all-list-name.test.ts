import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { NeedBudget, setWorkerNotificationPublisherForTests } from "../src/services/notifier.js";
import { createNotificationPublisher, type PublishEnvelope } from "../src/services/notification-publisher.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import type { NotifyRule, NotifyRuleInput } from "../src/services/notify-rules.js";

const mutableEnv = env as unknown as {
  AUTO_ACCEPT_ENABLED: boolean;
  BIDDING_VEHICLE_TYPE?: number;
  FETCH_DETAILS: boolean;
  SAVE_TO_DB: boolean;
  SPX_ROLE: typeof env.SPX_ROLE;
};

const original = {
  AUTO_ACCEPT_ENABLED: mutableEnv.AUTO_ACCEPT_ENABLED,
  BIDDING_VEHICLE_TYPE: mutableEnv.BIDDING_VEHICLE_TYPE,
  FETCH_DETAILS: mutableEnv.FETCH_DETAILS,
  SAVE_TO_DB: mutableEnv.SAVE_TO_DB,
  SPX_ROLE: mutableEnv.SPX_ROLE,
};

function emptyRequestList(): BookingRequestListResponse {
  return requestList([]);
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

function requestListItem(
  requestId: number,
  status: number,
  origin: string,
  destination: string,
  vehicleTypeName = "6WH-6ล้อ[7.2m]",
  bookingId = 2706815
): BookingRequestListResponse["data"]["request_list"][number] {
  return {
    onsite_id: requestId,
    request_id: requestId,
    booking_id: bookingId,
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
    vehicle_type_name: vehicleTypeName,
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
      { route_level: 0, node_id: 1, station_type_list: [], station_type_name_list: null, node_info_list: [{ name: origin, address_info: { l1: "", l2: "" } }] },
      { route_level: 1, node_id: 2, station_type_list: [], station_type_name_list: null, node_info_list: [{ name: destination, address_info: { l1: "", l2: "" } }] },
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  let lastValue = await read();
  while (Date.now() < deadline) {
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 20));
    lastValue = await read();
  }
  assert.fail(`${label}; last value: ${JSON.stringify(lastValue)}`);
}

function routeRuleInput(acceptAll: boolean): NotifyRuleInput {
  return {
    name: acceptAll ? "NORC-B to SOCs accept all" : "NORC-B to SOCs normal",
    origins: ["NORC-B"],
    destinations: ["SOCs"],
    vehicle_types: ["6WH-6ล้อ[7.2m]"],
    need: 1,
    enabled: true,
    accept_all: acceptAll,
  };
}

function booking(): Booking {
  return {
    booking_id: 2706815,
    booking_name: "[ADHOC]NORC-B > SOCs 2026-06-17",
    agency_name: "SPX",
  } as Booking;
}

function processOne(poller: Poller, item: Booking): Promise<boolean> {
  return (poller as unknown as {
    processOneBooking: (booking: Booking) => Promise<boolean>;
  }).processOneBooking(item);
}

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { closePool } = await import("../src/db/client.js");
  const { createRule, readRules } = await import("../src/services/notify-rules.js");
  const { getAutoAcceptHistory } = await import("../src/repositories/auto-accept-repository.js");
  const { getAutoAcceptResult, upsertAutoAcceptResult } = await import("../src/repositories/auto-accept-result-repository.js");
  resetMemoryDb();
  setLogLevel(LogLevel.ERROR);
  Object.assign(mutableEnv, {
    AUTO_ACCEPT_ENABLED: true,
    BIDDING_VEHICLE_TYPE: 13,
    FETCH_DETAILS: false,
    SAVE_TO_DB: false,
  });

  {
    const rule = await createRule(1, routeRuleInput(true));
    const poller = new Poller();
    let acceptAllCalls = 0;
    let detailFetchCalls = 0;
    const events: string[] = [];
    const published: PublishEnvelope[] = [];
    const reconcileGate = deferred();
    mutableEnv.SPX_ROLE = "worker";
    setWorkerNotificationPublisherForTests(createNotificationPublisher({
      publish: async (envelope) => {
        published.push(envelope);
        return { ok: true };
      },
    }));
    Object.assign(poller as unknown as { tickAutoAcceptRules: NotifyRule[]; tickNeedBudget: NeedBudget }, {
      tickAutoAcceptRules: [rule],
      tickNeedBudget: new NeedBudget(),
    });
    Object.assign(poller as unknown as { apiClient: unknown }, {
      apiClient: {
        fetchBookingRequestList: async (bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
          detailFetchCalls += 1;
          events.push(`fetch:${options?.tabPendingConfirmation === false ? "confirmed" : "pending"}`);
          assert.equal(bookingId, 2706815);
          assert.ok(events.includes("accept"), "fast accept_all reconcile must not fetch request-list detail before accept_all");
          await reconcileGate.promise;
          return options?.tabPendingConfirmation === false
            ? requestList([
                requestListItem(38659805, 2, "NORC-B", "SOCs"),
                requestListItem(38659806, 2, "NORC-B", "SOCs"),
              ])
            : emptyRequestList();
        },
        acceptAllBookingRequests: async (bookingId: number) => {
          acceptAllCalls += 1;
          events.push("accept");
          assert.equal(bookingId, 2706815);
          return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success", data: { success_count: 2 } } };
        },
      },
    });

    const clean = await processOne(poller, booking());
    assert.equal(clean, true);
    assert.equal(acceptAllCalls, 1, "route-matched accept_all rule must call SPX accept_all");
    assert.equal(events[0], "accept", "route-matched accept_all must submit before any request-list detail fetch");
    reconcileGate.resolve();
    const historyRows = await waitFor(
      () => getAutoAcceptHistory(1, { limit: 20 }),
      (rows) => rows.some((row) => row.bookingId === 2706815 && row.requestIds.length === 2),
      "fast accept_all should reconcile auto_accept_history request IDs"
    );
    const row = historyRows.find((item) => item.bookingId === 2706815);
    assert.equal(row?.status, "success");
    assert.deepEqual(row?.requestIds, [38659805, 38659806]);
    assert.equal(row?.acceptedCount, 2);
    assert.equal(row?.origin, "NORC-B");
    assert.equal(row?.destination, "SOCs");
    assert.equal(row?.vehicleType, "6WH-6ล้อ[7.2m]");
    assert.ok(detailFetchCalls >= 2, "fast accept_all reconcile must fetch pending and confirmed tabs after accept_all");
    assert.equal(published.length, 1, "worker fast accept_all reconcile must publish success centrally");
    assert.equal(published[0]?.eventKey, "auto_accept_owned:team:1:booking:2706815:req:38659805");
    assert.match(published[0]?.event.traceId ?? "", /^aa:1:2706815:38659805-38659806:/);
    assert.deepEqual(published[0]?.event.requestIds, ["38659805", "38659806"]);
    assert.equal(published[0]?.event.evidence?.sourcePath, "fast_accept_all_reconcile");
    assert.equal(published[0]?.event.evidence?.acceptedCount, 2);
    mutableEnv.SPX_ROLE = original.SPX_ROLE;
    setWorkerNotificationPublisherForTests(null);
  }

  await closePool();
  resetMemoryDb();
  {
    const rule = await createRule(1, routeRuleInput(true));
    await upsertAutoAcceptResult({
      teamId: 1,
      bookingId: 2706815,
      requestId: 39795912,
      winningAttemptTraceId: "already-owned",
      status: "owned",
      reasonCode: "verified_owned",
      evidence: { source: "preexisting" },
    });
    const poller = new Poller();
    const reconcileGate = deferred();
    Object.assign(poller as unknown as { tickAutoAcceptRules: NotifyRule[]; tickNeedBudget: NeedBudget }, {
      tickAutoAcceptRules: [rule],
      tickNeedBudget: new NeedBudget(),
    });
    Object.assign(poller as unknown as { apiClient: unknown }, {
      apiClient: {
        fetchBookingRequestList: async (bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
          assert.equal(bookingId, 2706815);
          await reconcileGate.promise;
          return options?.tabPendingConfirmation === false
            ? requestList([
                requestListItem(39795910, 2, "NORC-B", "SOCs"),
                { ...requestListItem(39795911, 4, "NORC-B", "SOCs"), remark: "Other agency accept first." },
                { ...requestListItem(39795912, 4, "NORC-B", "SOCs"), remark: "Stale sibling already owned in canonical facts." },
              ])
            : emptyRequestList();
        },
        acceptAllBookingRequests: async (bookingId: number) => {
          assert.equal(bookingId, 2706815);
          return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success", data: { success_count: 2 } } };
        },
      },
    });

    const clean = await processOne(poller, booking());
    assert.equal(clean, true);
    reconcileGate.resolve();
    await waitFor(
      () => getAutoAcceptHistory(1, { limit: 20 }),
      (rows) => rows.some((row) => row.bookingId === 2706815 && row.status === "success" && row.requestIds.includes(39795910)),
      "partial fast accept_all should reconcile accepted request"
    );

    const ownedResult = await getAutoAcceptResult(1, 2706815, 39795910);
    assert.equal(ownedResult?.status, "owned");
    assert.equal(ownedResult?.reasonCode, "verified_owned");
    assert.match(ownedResult?.winningAttemptTraceId ?? "", /^aa:1:2706815:39795910:/);

    const lostResult = await getAutoAcceptResult(1, 2706815, 39795911);
    assert.equal(lostResult?.status, "lost");
    assert.equal(lostResult?.reasonCode, "verified_not_owned");
    const lostEvidence = JSON.parse(lostResult?.evidenceJson ?? "{}") as Record<string, unknown>;
    assert.equal(lostEvidence.source, "fast_accept_all_reconcile");
    assert.equal(lostEvidence.observedCount, 3);
    assert.equal(lostEvidence.acceptedCount, 1);
    assert.equal(lostEvidence.observedStatus, 4);

    const preservedOwned = await getAutoAcceptResult(1, 2706815, 39795912);
    assert.equal(preservedOwned?.status, "owned");
    assert.equal(preservedOwned?.winningAttemptTraceId, "already-owned");
  }

  await closePool();
  resetMemoryDb();
  {
    const rule = await createRule(1, routeRuleInput(true));
    const poller = new Poller();
    const reconcileGate = deferred();
    Object.assign(poller as unknown as { tickAutoAcceptRules: NotifyRule[]; tickNeedBudget: NeedBudget }, {
      tickAutoAcceptRules: [rule],
      tickNeedBudget: new NeedBudget(),
    });
    Object.assign(poller as unknown as { apiClient: unknown }, {
      apiClient: {
        fetchBookingRequestList: async (bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
          assert.equal(bookingId, 2706815);
          await reconcileGate.promise;
          return options?.tabPendingConfirmation === false
            ? requestList([
                { ...requestListItem(39795903, 4, "NORC-B", "SOCs"), remark: "Other agency accept first." },
              ])
            : emptyRequestList();
        },
        acceptAllBookingRequests: async (bookingId: number) => {
          assert.equal(bookingId, 2706815);
          return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success", data: { success_count: 1 } } };
        },
      },
    });

    const clean = await processOne(poller, booking());
    assert.equal(clean, true);
    reconcileGate.resolve();
    const historyRows = await waitFor(
      () => getAutoAcceptHistory(1, { limit: 20 }),
      (rows) => rows.some((row) => row.bookingId === 2706815 && row.status === "failed" && row.requestIds.length === 1),
      "unverified fast accept_all should become a failed history row"
    );
    const row = historyRows.find((item) => item.bookingId === 2706815);
    assert.equal(row?.status, "failed");
    assert.deepEqual(row?.requestIds, [39795903]);
    assert.equal(row?.acceptedCount, 0);
    assert.match(row?.errorMessage ?? "", /not confirmed|ambiguous/i);
    assert.equal((await readRules(1)).find((item) => item.id === rule.id)?.need, 1);
  }

  await closePool();
  resetMemoryDb();
  {
    const rule = await createRule(1, routeRuleInput(true));
    const poller = new Poller();
    const reconcileGate = deferred();
    Object.assign(poller as unknown as { tickAutoAcceptRules: NotifyRule[]; tickNeedBudget: NeedBudget }, {
      tickAutoAcceptRules: [rule],
      tickNeedBudget: new NeedBudget(),
    });
    Object.assign(poller as unknown as { apiClient: unknown }, {
      apiClient: {
        fetchBookingRequestList: async (bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
          assert.equal(bookingId, 2706815);
          await reconcileGate.promise;
          return options?.tabPendingConfirmation === false
            ? requestList([
                requestListItem(39795906, 6, "NORC-B", "SOCs"),
              ])
            : emptyRequestList();
        },
        acceptAllBookingRequests: async (bookingId: number) => {
          assert.equal(bookingId, 2706815);
          return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success", data: { success_count: 1 } } };
        },
      },
    });

    const clean = await processOne(poller, booking());
    assert.equal(clean, true);
    reconcileGate.resolve();
    const historyRows = await waitFor(
      () => getAutoAcceptHistory(1, { limit: 20 }),
      (rows) => rows.some((row) => row.bookingId === 2706815 && row.requestIds.includes(39795906)),
      "status 6 must not be treated as verified fast accept_all success"
    );
    const row = historyRows.find((item) => item.bookingId === 2706815);
    assert.equal(row?.status, "failed");
    assert.deepEqual(row?.requestIds, [39795906]);
    assert.equal(row?.acceptedCount, 0);
    assert.match(row?.errorMessage ?? "", /not confirmed|ambiguous/i);
    assert.equal((await readRules(1)).find((item) => item.id === rule.id)?.need, 1);
  }

  await closePool();
  resetMemoryDb();
  {
    const rule = await createRule(1, routeRuleInput(true));
    const poller = new Poller();
    let acceptAllCalls = 0;
    Object.assign(poller as unknown as { tickAutoAcceptRules: NotifyRule[]; tickNeedBudget: NeedBudget }, {
      tickAutoAcceptRules: [rule],
      tickNeedBudget: new NeedBudget(),
    });
    Object.assign(poller as unknown as { apiClient: unknown }, {
      apiClient: {
        fetchBookingRequestList: async (bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
          assert.equal(bookingId, 2791810);
          return options?.tabPendingConfirmation === false
            ? requestList([
                { ...requestListItem(40288194, 4, "NORC-B", "SOCs", "6WH-6ล้อ[7.2m]", 2791810), remark: "Other agency accept first." },
                requestListItem(40288114, 2, "NORC-B", "SOCs", "6WH-6ล้อ[7.2m]", 2791810),
              ])
            : emptyRequestList();
        },
        acceptAllBookingRequests: async () => {
          acceptAllCalls += 1;
          return { ok: false, httpStatus: 200, error: "You can not accept this request due to Time-out or accept by other agency" };
        },
      },
    });

    const clean = await processOne(poller, {
      booking_id: 2791810,
      booking_name: "[ADHOC]UNMATCHED > LANE 2026-06-29",
      agency_name: "SPX",
    } as Booking);
    assert.equal(clean, true);
    assert.equal(acceptAllCalls, 0, "own confirmed accept_all result must suppress status-4 retry in same booking/rule");
    const historyRows = await getAutoAcceptHistory(1, { limit: 20 });
    const successRow = historyRows.find((item) => item.bookingId === 2791810 && item.status === "success");
    assert.deepEqual(successRow?.requestIds, [40288114]);
    assert.equal(successRow?.acceptedCount, 1);
    assert.equal(successRow?.origin, "NORC-B");
    assert.equal(successRow?.destination, "SOCs");
    assert.equal((await readRules(1)).find((item) => item.id === rule.id)?.need, 0);
    assert.equal(
      historyRows.some((item) => item.bookingId === 2791810 && item.status === "failed" && item.requestIds.includes(40288194)),
      false,
      "status-4 sibling must not create a failure row when the booking/rule already has a verified accepted request"
    );
  }

  {
    const rule = await createRule(1, routeRuleInput(false));
    const poller = new Poller();
    let detailFetchCalls = 0;
    let acceptAllCalls = 0;
    Object.assign(poller as unknown as { tickAutoAcceptRules: NotifyRule[]; tickNeedBudget: NeedBudget }, {
      tickAutoAcceptRules: [rule],
      tickNeedBudget: new NeedBudget(),
    });
    Object.assign(poller as unknown as { apiClient: unknown }, {
      apiClient: {
        fetchBookingRequestList: async () => {
          detailFetchCalls += 1;
          return emptyRequestList();
        },
        acceptAllBookingRequests: async () => {
          acceptAllCalls += 1;
          return { ok: true, httpStatus: 200, response: { retcode: 0, message: "unexpected" } };
        },
      },
    });

    const clean = await processOne(poller, booking());
    assert.equal(clean, true);
    assert.equal(acceptAllCalls, 0, "normal rule must not use booking-level accept_all");
    assert.ok(detailFetchCalls > 0, "normal rule must continue through the request-list detail flow");
  }

  await closePool();
  console.log("poller-accept-all-list-name: all assertions passed");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    Object.assign(mutableEnv, original);
    setWorkerNotificationPublisherForTests(null);
    setLogLevel(LogLevel.INFO);
  });
