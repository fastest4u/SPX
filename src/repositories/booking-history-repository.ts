import { getDb } from "../db/client.js";
import { spxBookingHistory } from "../db/schema.js";
import { and, desc, asc, eq, ilike, or, sql } from "drizzle-orm";

export interface BookingHistoryRecord {
  requestId: number;
  bookingId?: number;
  bookingName?: string;
  agencyName?: string;
  route: string;
  origin: string;
  destination: string;
  costType: string;
  tripType: string;
  shiftType: string;
  vehicleType: string;
  standbyDateTime: string;
  acceptanceStatus?: number;
  assignmentStatus?: number;
}

type BookingHistoryQuery = {
  limit?: number;
  search?: string;
  bookingId?: number;
  origin?: string;
  destination?: string;
  vehicleType?: string;
  sortBy?: "created_at" | "request_id";
  sortDir?: "asc" | "desc";
};

export async function insertBookingHistory(record: BookingHistoryRecord): Promise<{ action: "inserted" | "skipped" }> {
  const pool = (await import("../db/client.js")).getPool();
  const cols = ["request_id", "booking_id", "booking_name", "agency_name", "route", "origin", "destination", "cost_type", "trip_type", "shift_type", "vehicle_type", "standby_datetime", "acceptance_status", "assignment_status"] as const;
  const values = [record.requestId, record.bookingId ?? null, record.bookingName ?? null, record.agencyName ?? null, record.route, record.origin, record.destination, record.costType, record.tripType, record.shiftType, record.vehicleType, record.standbyDateTime, record.acceptanceStatus ?? null, record.assignmentStatus ?? null];
  const placeholders = cols.map(() => "?").join(", ");
  const query = `INSERT IGNORE INTO spx_booking_history (${cols.join(", ")}) VALUES (${placeholders})`;
  const [result] = await pool.query(query, values);
  const affectedRows = (result as { affectedRows: number }).affectedRows;
  return { action: affectedRows > 0 ? "inserted" : "skipped" };
}

export async function getBookingHistory(query: BookingHistoryQuery | number = 100): Promise<any[]> {
  const db = await getDb();
  if (typeof query === "number") {
    const rows = await db.select().from(spxBookingHistory).orderBy(desc(spxBookingHistory.id)).limit(query);
    return rows;
  }

  const limit = query.limit ?? 200;
  const filters = [] as any[];
  if (query.bookingId) filters.push(eq(spxBookingHistory.bookingId, query.bookingId));
  if (query.origin) filters.push(ilike(spxBookingHistory.origin, `%${query.origin}%`));
  if (query.destination) filters.push(ilike(spxBookingHistory.destination, `%${query.destination}%`));
  if (query.vehicleType) filters.push(ilike(spxBookingHistory.vehicleType, `%${query.vehicleType}%`));
  if (query.search) {
    const term = `%${query.search}%`;
    filters.push(or(ilike(spxBookingHistory.route, term), ilike(spxBookingHistory.origin, term), ilike(spxBookingHistory.destination, term), ilike(spxBookingHistory.vehicleType, term), ilike(spxBookingHistory.bookingName, term), ilike(spxBookingHistory.agencyName, term)));
  }

  const orderBy = query.sortBy === "request_id"
    ? (query.sortDir === "asc" ? asc(spxBookingHistory.requestId) : desc(spxBookingHistory.requestId))
    : (query.sortDir === "asc" ? asc(spxBookingHistory.createdAt) : desc(spxBookingHistory.createdAt));

  const rows = await db.select().from(spxBookingHistory).where(filters.length > 0 ? and(...filters) : undefined).orderBy(orderBy).limit(limit);
  return rows;
}
