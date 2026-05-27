import assert from "node:assert/strict";
import {
  dedupeBookingHistoryRecords,
  filterKnownBookingHistoryRecords,
  type BookingHistoryRecord,
} from "../repositories/booking-history-repository.js";

function bookingHistoryRecord(requestId: number, route = `route-${requestId}`): BookingHistoryRecord {
  return {
    requestId,
    bookingId: requestId + 1000,
    bookingName: `booking-${requestId}`,
    agencyName: "agency",
    route,
    origin: "origin",
    destination: "destination",
    costType: "cost",
    tripType: "trip",
    shiftType: "shift",
    vehicleType: "vehicle",
    standbyDateTime: "2026-05-27 10:00:00",
    acceptanceStatus: 1,
    assignmentStatus: 0,
  };
}

function requestIds(records: BookingHistoryRecord[]): number[] {
  return records.map((record) => record.requestId);
}

function runTests(): void {
  const deduped = dedupeBookingHistoryRecords([
    bookingHistoryRecord(101, "first"),
    bookingHistoryRecord(102),
    bookingHistoryRecord(101, "second"),
    bookingHistoryRecord(103),
    bookingHistoryRecord(102, "duplicate"),
  ]);

  assert.deepEqual(requestIds(deduped.records), [101, 102, 103]);
  assert.equal(deduped.skipped, 2);
  assert.equal(deduped.records[0]?.route, "first");

  const filtered = filterKnownBookingHistoryRecords(
    [bookingHistoryRecord(201), bookingHistoryRecord(202), bookingHistoryRecord(203)],
    new Set([202])
  );

  assert.deepEqual(requestIds(filtered.records), [201, 203]);
  assert.equal(filtered.skipped, 1);

  console.log("Booking history repository tests passed");
}

runTests();
