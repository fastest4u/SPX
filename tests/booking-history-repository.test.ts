// Must set DB_MODE before importing app modules. env.ts reads process.env.DB_MODE
// at module load time, so use dynamic imports after this assignment.
process.env.DB_MODE = "memory";

import assert from "node:assert/strict";
import type { BookingHistoryRecord } from "../src/repositories/booking-history-repository.js";

async function main(): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { ensureSpxBookingHistoryTable, getDb, closePool } = await import("../src/db/client.js");
  const { spxBookingHistory } = await import("../src/db/schema.js");
  const { insertBookingHistories } = await import("../src/repositories/booking-history-repository.js");

  function rec(requestId: number, route = `r-${requestId}`): BookingHistoryRecord {
    return {
      requestId,
      bookingId: requestId + 1000,
      bookingName: `b-${requestId}`,
      agencyName: "agency",
      route,
      origin: "o",
      destination: "d",
      costType: "c",
      tripType: "t",
      shiftType: "s",
      vehicleType: "v",
      standbyDateTime: "2026-05-27 10:00:00",
      acceptanceStatus: 1,
      assignmentStatus: 0,
    };
  }

  try {
    await ensureSpxBookingHistoryTable();
    const db = await getDb();

    let result = await insertBookingHistories([rec(1), rec(2), rec(3)]);
    assert.deepEqual(result, { inserted: 3, skipped: 0 });

    result = await insertBookingHistories([rec(1), rec(2)]);
    assert.deepEqual(result, { inserted: 0, skipped: 2 });

    result = await insertBookingHistories([rec(3), rec(4)]);
    assert.deepEqual(result, { inserted: 1, skipped: 1 });

    await db.delete(spxBookingHistory).where(eq(spxBookingHistory.requestId, 4));
    result = await insertBookingHistories([rec(4)]);
    assert.equal(result.inserted, 1);

    await assert.rejects(
      insertBookingHistories([{ ...rec(99), route: null as unknown as string }]),
      /NOT NULL|constraint|datatype|column/i,
    );
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
