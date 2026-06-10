import { ensureSpxBookingHistoryTable } from "../db/client.js";
import { insertBookingHistories, insertBookingHistory } from "../repositories/booking-history-repository.js";
import type { BookingHistoryRecord } from "../repositories/booking-history-repository.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";

function toBookingHistoryRecord(trip: ExtractedTripInfo): BookingHistoryRecord {
  return {
    requestId: trip.request_id,
    bookingId: trip.booking_id,
    bookingName: trip.booking_name,
    agencyName: trip.agency_name,
    route: trip.เส้นทาง,
    origin: trip.ต้นทาง,
    destination: trip.ปลายทาง,
    costType: trip.ประเภทการจ่าย,
    tripType: trip.รูปแบบของทริป,
    shiftType: trip.ประเภทการเดินทาง,
    vehicleType: trip.ประเภทรถ,
    standbyDateTime: trip.วันที่เวลาสแตนบาย,
    acceptanceStatus: trip.acceptance_status,
    assignmentStatus: trip.assignment_status,
  };
}

export async function saveBookingRequest(
  trip: ExtractedTripInfo
): Promise<{ saved: boolean; action: string; message: string }> {
  try {
    await ensureSpxBookingHistoryTable();

    const { action } = await insertBookingHistory(toBookingHistoryRecord(trip));

    return {
      saved: action === "inserted",
      action,
      message: `request_id ${trip.request_id}: ${action}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { saved: false, action: "error", message: `DB error: ${msg}` };
  }
}

export async function saveBookingRequests(
  trips: ExtractedTripInfo[]
): Promise<{ inserted: number; skipped: number; errors: number; message: string }> {
  if (trips.length === 0) {
    return { inserted: 0, skipped: 0, errors: 0, message: "No trips to save" };
  }

  // DB errors must propagate: BookingHistorySaveQueue.saveWithRetry only
  // retries on throw — swallowing here would permanently drop the batch
  // after a single transient failure.
  await ensureSpxBookingHistoryTable();

  const result = await insertBookingHistories(trips.map(toBookingHistoryRecord));
  return {
    inserted: result.inserted,
    skipped: result.skipped,
    errors: 0,
    message: `batch saved: inserted=${result.inserted}, skipped=${result.skipped}`,
  };
}
