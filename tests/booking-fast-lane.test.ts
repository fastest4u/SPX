import assert from "node:assert/strict";
import {
  fastLaneReserveForConcurrency,
  partitionBookingsByFastLane,
} from "../src/utils/booking-fast-lane.js";

assert.equal(fastLaneReserveForConcurrency(1), 0);
assert.equal(fastLaneReserveForConcurrency(2), 1);
assert.equal(fastLaneReserveForConcurrency(4), 1);
assert.equal(fastLaneReserveForConcurrency(8), 2);
assert.equal(fastLaneReserveForConcurrency(50), 8);

const bookings = [
  { booking_id: 10, booking_name: "old-priority" },
  { booking_id: 20, booking_name: "new-priority" },
  { booking_id: 30, booking_name: "old-deferred" },
  { booking_id: 40, booking_name: "new-deferred" },
];

const partitioned = partitionBookingsByFastLane(bookings, new Set([20, 40]));

assert.deepEqual(partitioned.fastLane.map((booking) => booking.booking_id), [20, 40]);
assert.deepEqual(partitioned.background.map((booking) => booking.booking_id), [10, 30]);
assert.deepEqual(partitioned.ordered.map((booking) => booking.booking_id), [20, 40, 10, 30]);

console.log("booking-fast-lane: all assertions passed");
