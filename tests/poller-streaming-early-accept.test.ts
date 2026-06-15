import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { NeedBudget } from "../src/services/notifier.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import type { NotifyRule } from "../src/services/notify-rules.js";
import type { ExtractedTripInfo } from "../src/utils/booking-extractor.js";

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

const rule: NotifyRule = {
  id: "rayong-rule",
  name: "Rayong lane",
  origins: ["Bangkok"],
  destinations: ["Rayong"],
  vehicle_types: ["6WH"],
  need: 5,
  enabled: true,
  fulfilled: false,
  auto_accept: true,
  auto_accepted: false,
};

function request(requestId: number, origin: string, destination: string) {
  return {
    request_id: requestId,
    booking_id: 991,
    booking_date: 1779469200,
    standby_time: 480,
    cost_type: 1,
    trip_type: 1,
    shift_type: 0,
    vehicle_type: 13,
    vehicle_type_name: "6WH-6ล้อ[7.2m]",
    request_acceptance_status: 1,
    request_assignment_status: 0,
    route_detail_list: [
      { node_info_list: [{ name: origin }] },
      { node_info_list: [{ name: destination }] },
    ],
  };
}

function page(pageno: number, requests: ReturnType<typeof request>[]): BookingRequestListResponse {
  return {
    retcode: 0,
    message: "",
    data: {
      pageno,
      count: 1,
      total: 2,
      request_list: requests,
    },
  };
}

async function main(): Promise<void> {
  setLogLevel(LogLevel.ERROR);
  Object.assign(mutableEnv, {
    AUTO_ACCEPT_ENABLED: true,
    BIDDING_VEHICLE_TYPE: 13,
    FETCH_DETAILS: false,
    SAVE_TO_DB: false,
  });

  const poller = new Poller();
  Object.assign(poller as unknown as { tickAutoAcceptRules: NotifyRule[]; tickNeedBudget: NeedBudget }, {
    tickAutoAcceptRules: [rule],
    tickNeedBudget: new NeedBudget(),
  });

  const seenPages: number[] = [];
  const acceptedRequestIds: number[][] = [];
  let pages = [
    page(1, [request(1001, "Bangkok", "Chonburi")]),
    page(2, [request(1002, "Bangkok", "Rayong")]),
  ];

  Object.assign(poller as unknown as { apiClient: unknown }, {
    apiClient: {
      fetchBookingRequestList: async (_bookingId: number, options?: {
        onPage?: (response: BookingRequestListResponse) => boolean | void;
        tabPendingConfirmation?: boolean;
      }) => {
        const collected = [];
        for (const response of pages) {
          seenPages.push(response.data.pageno);
          const shouldContinue = options?.onPage?.(response) !== false;
          collected.push(...response.data.request_list);
          if (!shouldContinue) break;
        }

        return {
          ...pages[0],
          data: {
            ...pages[0].data,
            request_list: collected,
          },
        };
      },
    },
  });

  Object.assign(poller as unknown as { runAutoAcceptForTrips: unknown }, {
    runAutoAcceptForTrips: async (trips: ExtractedTripInfo[]) => {
      acceptedRequestIds.push(trips.map((trip) => trip.request_id));
      return true;
    },
  });

  const booking = {
    booking_id: 991,
    booking_name: "[ADHOC] Bangkok lanes",
    agency_name: "SPX",
  } as Booking;

  await (poller as unknown as {
    processOneBooking: (booking: Booking) => Promise<boolean>;
  }).processOneBooking(booking);

  assert.deepEqual(seenPages, [1, 2]);
  assert.deepEqual(acceptedRequestIds, [[1002]]);

  seenPages.length = 0;
  acceptedRequestIds.length = 0;
  pages = [
    page(1, [request(1003, "Bangkok", "Rayong")]),
    page(2, [request(1004, "Bangkok", "Rayong")]),
  ];

  await (poller as unknown as {
    processOneBooking: (booking: Booking) => Promise<boolean>;
  }).processOneBooking(booking);

  assert.deepEqual(seenPages, [1, 2]);
  assert.deepEqual(acceptedRequestIds, [[1003], [1004]]);

  console.log("poller-streaming-early-accept: all assertions passed");
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
