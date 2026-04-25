import { desc } from "drizzle-orm";
import { ApiClient } from "../services/api-client.js";
import { closePool, getDb } from "../db/client.js";
import { spxBookingHistory } from "../db/schema.js";
import { extractAllRequestListTrips } from "../utils/booking-extractor.js";
import { saveBookingRequest } from "../services/db-service.js";

async function runDbTest(): Promise<void> {
  const apiClient = new ApiClient();
  const listResult = await apiClient.fetch(1);

  if (!listResult.success) {
    throw new Error(listResult.error || "Failed to fetch bidding list");
  }

  const firstBooking = listResult.data.data.list[0];
  if (!firstBooking) {
    throw new Error("No booking returned from bidding list");
  }

  const requestList = await apiClient.fetchBookingRequestList(firstBooking.booking_id);
  if (!requestList) {
    throw new Error(`Failed to fetch request list for booking_id ${firstBooking.booking_id}`);
  }

  const firstTrip = extractAllRequestListTrips(requestList.data)[0];
  if (!firstTrip) {
    throw new Error(`No request returned for booking_id ${firstBooking.booking_id}`);
  }

  const saveResult = await saveBookingRequest(firstTrip);
  console.log(`Save result: ${saveResult.message}`);

  const db = getDb();
  const latestRows = await db
    .select()
    .from(spxBookingHistory)
    .orderBy(desc(spxBookingHistory.createdAt))
    .limit(5);

  console.log(JSON.stringify({
    testedBookingId: firstBooking.booking_id,
    testedRequestId: firstTrip.request_id,
    latestRows,
  }, null, 2));
}

async function main(): Promise<void> {
  try {
    await runDbTest();
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
