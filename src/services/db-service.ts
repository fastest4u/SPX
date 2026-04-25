import { ensureSpxBookingHistoryTable } from "../db/client.js";
import { insertBookingHistory } from "../repositories/booking-history-repository.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";

export async function saveBookingRequest(
  trip: ExtractedTripInfo
): Promise<{ saved: boolean; action: string; message: string }> {
  try {
    await ensureSpxBookingHistoryTable();

    const { action } = await insertBookingHistory({
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
    });

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
