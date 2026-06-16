import { and, eq } from "drizzle-orm";
import { ApiClient } from "../services/api-client.js";
import { closePool, getDb } from "../db/client.js";
import { spxBookingHistory } from "../db/schema.js";
import { getTeamRuntimeConfig } from "../repositories/team-repository.js";
import { extractAllRequestListTrips } from "../utils/booking-extractor.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";
import { saveBookingRequest } from "../services/db-service.js";

type DbWriteSmokeResult = {
  mode: "live-booking" | "synthetic-fallback";
  requestId: number;
  bookingId: number | null;
  saveAction: string;
  rowVerified: boolean;
  cleanedUp?: boolean;
  reason?: string;
};

function resolveTeamId(): number {
  const raw = process.argv[2] ?? process.env.DB_TEST_TEAM_ID ?? "1";
  const teamId = Number(raw);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    throw new Error(`Invalid team id "${raw}". Use a positive integer via DB_TEST_TEAM_ID or the first CLI argument.`);
  }
  return teamId;
}

function makeSyntheticTrip(): ExtractedTripInfo {
  const requestId = Date.now() * 1000 + (process.pid % 1000);
  const bookingId = requestId + 1;
  return {
    เส้นทาง: "DB Smoke Origin -> DB Smoke Destination",
    ประเภทการจ่าย: "Fixed",
    รูปแบบของทริป: "One Way",
    ประเภทการเดินทาง: "By Land",
    ประเภทรถ: "DB Smoke Vehicle",
    vehicle_type_id: 0,
    ต้นทาง: "DB Smoke Origin",
    ปลายทาง: "DB Smoke Destination",
    วันที่เวลาสแตนบาย: new Date().toISOString(),
    request_id: requestId,
    booking_id: bookingId,
    booking_name: "db-test synthetic fallback",
    agency_name: "SPX DB Test",
    acceptance_status: 0,
    assignment_status: 0,
  };
}

async function hasSavedRequest(teamId: number, requestId: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: spxBookingHistory.id })
    .from(spxBookingHistory)
    .where(and(
      eq(spxBookingHistory.teamId, teamId),
      eq(spxBookingHistory.requestId, requestId),
    ))
    .limit(1);
  return Boolean(row);
}

async function cleanupSyntheticRequest(teamId: number, requestId: number): Promise<boolean> {
  const db = getDb();
  await db
    .delete(spxBookingHistory)
    .where(and(
      eq(spxBookingHistory.teamId, teamId),
      eq(spxBookingHistory.requestId, requestId),
    ));
  return !(await hasSavedRequest(teamId, requestId));
}

async function saveAndVerifyTrip(
  teamId: number,
  trip: ExtractedTripInfo,
  mode: DbWriteSmokeResult["mode"],
  reason?: string,
): Promise<DbWriteSmokeResult> {
  const saveResult = await saveBookingRequest(teamId, trip);
  if (saveResult.action === "error") {
    throw new Error(saveResult.message);
  }

  const rowVerified = await hasSavedRequest(teamId, trip.request_id);
  if (!rowVerified) {
    throw new Error(`Saved request_id ${trip.request_id} was not found for team_id ${teamId}`);
  }

  const result: DbWriteSmokeResult = {
    mode,
    requestId: trip.request_id,
    bookingId: trip.booking_id ?? null,
    saveAction: saveResult.action,
    rowVerified,
  };

  if (reason) {
    result.reason = reason;
  }

  if (mode === "synthetic-fallback") {
    result.cleanedUp = await cleanupSyntheticRequest(teamId, trip.request_id);
    if (!result.cleanedUp) {
      throw new Error(`Synthetic request_id ${trip.request_id} cleanup failed for team_id ${teamId}`);
    }
  }

  return result;
}

async function runSyntheticFallback(teamId: number, reason: string): Promise<DbWriteSmokeResult> {
  return saveAndVerifyTrip(teamId, makeSyntheticTrip(), "synthetic-fallback", reason);
}

async function runDbTest(): Promise<void> {
  const teamId = resolveTeamId();
  const team = await getTeamRuntimeConfig(teamId);
  if (!team) {
    throw new Error(`Team ${teamId} was not found`);
  }
  if (!team.spxCookie || !team.spxDeviceId) {
    throw new Error(`Team ${teamId} is missing SPX cookie or device id`);
  }

  const apiClient = new ApiClient({
    credentials: {
      spxCookie: team.spxCookie,
      spxDeviceId: team.spxDeviceId,
    },
  });
  const listResult = await apiClient.fetch(1);

  if (!listResult.success) {
    throw new Error(listResult.error || "Failed to fetch bidding list");
  }

  const firstBooking = listResult.data.data.list[0];
  if (!firstBooking) {
    const dbWriteSmoke = await runSyntheticFallback(teamId, "no booking returned from bidding list");
    console.log(JSON.stringify({
      ok: true,
      teamId,
      teamEnabled: team.enabled,
      upstreamAuthenticated: true,
      biddingListCount: 0,
      dbWriteSmoke,
    }, null, 2));
    return;
  }

  const requestList = await apiClient.fetchBookingRequestList(firstBooking.booking_id);
  if (!requestList) {
    throw new Error(`Failed to fetch request list for booking_id ${firstBooking.booking_id}`);
  }

  const trips = extractAllRequestListTrips(requestList.data, {
    booking_id: firstBooking.booking_id,
    booking_name: firstBooking.booking_name,
    agency_name: firstBooking.agency_name,
  });
  const firstTrip = trips[0];
  if (!firstTrip) {
    const dbWriteSmoke = await runSyntheticFallback(teamId, `no request returned for booking_id ${firstBooking.booking_id}`);
    console.log(JSON.stringify({
      ok: true,
      teamId,
      teamEnabled: team.enabled,
      upstreamAuthenticated: true,
      biddingListCount: listResult.data.data.list.length,
      testedBookingId: firstBooking.booking_id,
      requestTripCount: 0,
      dbWriteSmoke,
    }, null, 2));
    return;
  }

  const dbWriteSmoke = await saveAndVerifyTrip(teamId, firstTrip, "live-booking");

  console.log(JSON.stringify({
    ok: true,
    teamId,
    teamEnabled: team.enabled,
    upstreamAuthenticated: true,
    biddingListCount: listResult.data.data.list.length,
    testedBookingId: firstBooking.booking_id,
    requestTripCount: trips.length,
    dbWriteSmoke,
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
