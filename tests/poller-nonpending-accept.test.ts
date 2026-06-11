import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import { NeedBudget } from "../src/services/notifier.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import type { NotifyRule } from "../src/services/notify-rules.js";

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

function request(bookingId: number, requestId: number, acceptanceStatus: number) {
  return {
    request_id: requestId,
    booking_id: bookingId,
    booking_date: 1781136000,
    standby_time: 960,
    cost_type: 1,
    trip_type: 1,
    shift_type: 0,
    vehicle_type: 13,
    vehicle_type_name: "6WH-6ล้อ[7.2m]",
    request_acceptance_status: acceptanceStatus,
    request_assignment_status: 0,
    route_detail_list: [
      { node_info_list: [{ name: "NORC-B" }] },
      { node_info_list: [{ name: "SOCW" }] },
    ],
  };
}

function requestListResponse(requests: ReturnType<typeof request>[]): BookingRequestListResponse {
  return {
    retcode: 0,
    message: "",
    data: {
      pageno: 1,
      count: 100,
      total: requests.length,
      request_list: requests,
    },
  };
}

const rule: NotifyRule = {
  id: "rule-nonpending-test",
  name: "เชียงใหม่",
  origins: ["NORC-B"],
  destinations: ["SOCW"],
  vehicle_types: ["6WH-6ล้อ[7.2m]"],
  need: 5,
  enabled: true,
  fulfilled: false,
  auto_accept: true,
  auto_accepted: false,
};

interface Harness {
  poller: Poller;
  acceptCalls: Array<{ bookingId: number; requestIds: number[] }>;
  needBudget: NeedBudget;
  processOne: (booking: Booking) => Promise<boolean>;
}

function buildHarness(bookingId: number, nonPendingStatuses: number[], options: { verifyReturnsNull: boolean }): Harness {
  const poller = new Poller();
  const acceptCalls: Array<{ bookingId: number; requestIds: number[] }> = [];
  const needBudget = new NeedBudget();
  // After an accept POST, the next two request-list fetches are the verify
  // pair; flip them to null to simulate an indeterminate (deferred) verify.
  let verifyFetchesRemaining = 0;

  Object.assign(poller as unknown as { apiClient: unknown }, {
    apiClient: {
      fetchBookingRequestList: async (
        _bookingId: number,
        fetchOptions?: { tabPendingConfirmation?: boolean },
      ) => {
        if (verifyFetchesRemaining > 0) {
          verifyFetchesRemaining--;
          if (options.verifyReturnsNull) return null;
        }
        const pending = fetchOptions?.tabPendingConfirmation !== false;
        return pending
          ? requestListResponse([])
          : requestListResponse(
              nonPendingStatuses.map((status, i) => request(bookingId, 37502000 + i, status))
            );
      },
      acceptBookingRequests: async (calledBookingId: number, requestIds: number[]) => {
        acceptCalls.push({ bookingId: calledBookingId, requestIds });
        verifyFetchesRemaining = 2;
        return { ok: false, httpStatus: 200, error: "Time-out or accept by other agency" };
      },
    },
  });
  Object.assign(poller as unknown as { tickAutoAcceptRules: unknown; tickNeedBudget: unknown }, {
    tickAutoAcceptRules: [rule],
    tickNeedBudget: needBudget,
  });

  const processOne = (poller as unknown as {
    processOneBooking: (booking: Booking) => Promise<boolean>;
  }).processOneBooking.bind(poller);

  return { poller, acceptCalls, needBudget, processOne };
}

function booking(bookingId: number): Booking {
  return {
    booking_id: bookingId,
    booking_name: "[ADHOC]NORC-B > SOCs 2026-06-11",
    agency_name: "SPX",
  } as Booking;
}

async function main(): Promise<void> {
  setLogLevel(LogLevel.ERROR);
  Object.assign(mutableEnv, {
    AUTO_ACCEPT_ENABLED: true,
    BIDDING_VEHICLE_TYPE: 13,
    FETCH_DETAILS: false,
    SAVE_TO_DB: false,
  });

  // ── Case 1: verified failure is terminal; ours/unknown statuses are not attempted ──
  {
    // statuses: index 0 → taken-by-competitor (4, attempt), 1 → ours confirmed
    // (6, skip), 2 → unknown terminal (3, warn-only, no attempt).
    const h = buildHarness(2661488, [4, 6, 3], { verifyReturnsNull: false });

    const firstClean = await h.processOne(booking(2661488));
    assert.equal(h.acceptCalls.length, 1, "expected exactly one accept attempt");
    assert.deepEqual(h.acceptCalls[0], { bookingId: 2661488, requestIds: [37502000] });
    assert.equal(firstClean, true, "terminal already-taken failure must not dirty the booking round");

    // The attempt path must not touch the shared cross-tick NeedBudget.
    assert.equal(h.needBudget.claim(rule.id, rule.need, rule.need).granted, rule.need);

    await h.processOne(booking(2661488));
    assert.equal(h.acceptCalls.length, 1, "verified failure must not be re-attempted");
  }

  // ── Case 2: deferred (indeterminate) verify un-consumes the one-shot key ──
  {
    const h = buildHarness(2661500, [4], { verifyReturnsNull: true });

    await h.processOne(booking(2661500));
    assert.equal(h.acceptCalls.length, 1, "first attempt fires");

    await h.processOne(booking(2661500));
    assert.equal(h.acceptCalls.length, 2, "deferred-unverified attempt must retry on the next cycle");
  }
}

main()
  .then(() => {
    console.log("poller-nonpending-accept.test.ts passed");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    Object.assign(mutableEnv, original);
    setLogLevel(LogLevel.INFO);
  });
