import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { NeedBudget } from "../src/services/notifier.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import type { NotifyRule, NotifyRuleInput } from "../src/services/notify-rules.js";

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

function emptyRequestList(): BookingRequestListResponse {
  return {
    retcode: 0,
    message: "",
    data: {
      pageno: 1,
      count: 0,
      total: 0,
      request_list: [],
    },
  };
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
  const { createRule } = await import("../src/services/notify-rules.js");
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
        acceptAllBookingRequests: async (bookingId: number) => {
          acceptAllCalls += 1;
          assert.equal(bookingId, 2706815);
          return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } };
        },
      },
    });

    const clean = await processOne(poller, booking());
    assert.equal(clean, true);
    assert.equal(acceptAllCalls, 1, "route-matched accept_all rule must call SPX accept_all");
    assert.equal(detailFetchCalls, 0, "route-matched accept_all rule must not fetch request-list detail first");
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
    setLogLevel(LogLevel.INFO);
  });
