import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
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

function request(requestId: number, vehicleType: number, vehicleTypeName: string) {
  return {
    request_id: requestId,
    booking_id: 2596347,
    booking_date: 1779469200,
    standby_time: 480,
    cost_type: 1,
    trip_type: 1,
    shift_type: 0,
    vehicle_type: vehicleType,
    vehicle_type_name: vehicleTypeName,
    request_acceptance_status: vehicleType === 13 ? 4 : 1,
    request_assignment_status: 0,
    route_detail_list: [
      { node_info_list: [{ name: "NORC-B" }] },
      { node_info_list: [{ name: "SOCs" }] },
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

async function main(): Promise<void> {
  setLogLevel(LogLevel.ERROR);
  Object.assign(mutableEnv, {
    AUTO_ACCEPT_ENABLED: false,
    BIDDING_VEHICLE_TYPE: 13,
    FETCH_DETAILS: false,
    SAVE_TO_DB: true,
  });

  const poller = new Poller();
  const fetchTabs: Array<boolean | undefined> = [];
  const enqueuedTrips: ExtractedTripInfo[][] = [];

  Object.assign(poller as unknown as { apiClient: unknown }, {
    apiClient: {
      fetchBookingRequestList: async (
        _bookingId: number,
        options?: { tabPendingConfirmation?: boolean },
      ) => {
        fetchTabs.push(options?.tabPendingConfirmation);
        const pending = options?.tabPendingConfirmation !== false;
        return pending
          ? requestListResponse([request(35622350, 13, "6WH-6ล้อ[7.2m]")])
          : requestListResponse([
              request(35622428, 13, "6WH-6ล้อ[7.2m]"),
              request(35622506, 4, "4WJ-4ล้อจัมโบ้"),
            ]);
      },
    },
  });

  Object.assign(poller as unknown as { historySaveQueue: unknown }, {
    historySaveQueue: {
      enqueue: (trips: ExtractedTripInfo[]) => enqueuedTrips.push(trips),
    },
  });

  const booking = {
    booking_id: 2596347,
    booking_name: "[ADHOC]NORC-B > SOCs 2026-06-04",
    agency_name: "SPX",
  } as Booking;

  await (poller as unknown as {
    processOneBooking: (booking: Booking) => Promise<void>;
  }).processOneBooking(booking);

  assert.deepEqual(fetchTabs, [undefined, false]);
  assert.equal(enqueuedTrips.length, 1);
  assert.deepEqual(enqueuedTrips[0]?.map((trip) => trip.request_id), [35622350, 35622428]);
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
