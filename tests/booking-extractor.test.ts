import assert from "node:assert/strict";
import {
  extractAllRequestListTrips,
  filterTripsByBiddingVehicleType,
} from "../src/utils/booking-extractor.js";
import type { BookingRequestListData } from "../src/models/types.js";

function request(requestId: number, vehicleType: number, vehicleTypeName: string) {
  return {
    request_id: requestId,
    booking_id: 9000,
    booking_date: 1779469200,
    standby_time: 480,
    cost_type: 1,
    trip_type: 1,
    shift_type: 0,
    vehicle_type: vehicleType,
    vehicle_type_name: vehicleTypeName,
    request_acceptance_status: 1,
    request_assignment_status: 0,
    route_detail_list: [
      { node_info_list: [{ name: "A" }] },
      { node_info_list: [{ name: "B" }] },
    ],
  };
}

const data = {
  pageno: 1,
  count: 2,
  total: 2,
  request_list: [
    request(1, 13, "6WH-6ล้อ[7.2m]"),
    request(2, 4, "4WJ-4ล้อจัมโบ้"),
  ],
} as unknown as BookingRequestListData;

const trips = extractAllRequestListTrips(data);
assert.equal(trips[0]?.vehicle_type_id, 13);
assert.equal(trips[1]?.vehicle_type_id, 4);

const filtered = filterTripsByBiddingVehicleType(trips, 13);
assert.deepEqual(filtered.trips.map((trip) => trip.request_id), [1]);
assert.equal(filtered.skipped, 1);
assert.equal(filtered.trips[0]?.ประเภทรถ, "6WH-6ล้อ[7.2m]");

const unfiltered = filterTripsByBiddingVehicleType(trips, undefined);
assert.equal(unfiltered.trips.length, 2);
assert.equal(unfiltered.skipped, 0);
