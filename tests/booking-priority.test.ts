import assert from "node:assert/strict";
import {
  bookingMatchesOriginFilters,
  orderBookingsByOriginHint,
} from "../src/utils/booking-priority.js";

const bookings = [
  { booking_id: 1, booking_name: "[ADHOC] UPC All-Mile Round 11" },
  { booking_id: 2, booking_name: "[ADHOC] FSOCW1 > NORC-A STB 00.00" },
  { booking_id: 3, booking_name: "[ADHOC] NERC-B > SOCW" },
];

assert.equal(bookingMatchesOriginFilters(bookings[0], []), true);
assert.equal(bookingMatchesOriginFilters(bookings[1], ["norc-a"]), true);
assert.equal(bookingMatchesOriginFilters(bookings[1], ["NERC-B"]), false);

{
  const result = orderBookingsByOriginHint(bookings, ["norc-a", "nerc-b"]);
  assert.deepEqual(result.prioritized.map((booking) => booking.booking_id), [2, 3]);
  assert.deepEqual(result.deferred.map((booking) => booking.booking_id), [1]);
  assert.deepEqual(result.ordered.map((booking) => booking.booking_id), [2, 3, 1]);
}

{
  const result = orderBookingsByOriginHint(bookings, []);
  assert.deepEqual(result.prioritized.map((booking) => booking.booking_id), [1, 2, 3]);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.ordered.map((booking) => booking.booking_id), [1, 2, 3]);
}

console.log("booking-priority: all assertions passed");
