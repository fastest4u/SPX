import { getDb, getPool } from "../db/client.js";
import { spxBookingHistory } from "../db/schema.js";
import { and, count, desc, asc, eq, like, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

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

export type HistoryFilterQuery = {
  search?: string;
  requestId?: number;
  bookingId?: number;
  origin?: string;
  destination?: string;
  vehicleType?: string;
  sortBy?: "created_at" | "request_id";
  sortDir?: "asc" | "desc";
};

type BookingHistoryQuery = HistoryFilterQuery & { limit?: number };

type PaginatedHistoryQuery = HistoryFilterQuery & { page?: number; pageSize?: number };

function buildHistoryFilters(query: HistoryFilterQuery): SQL | undefined {
  const filters: SQL[] = [];
  if (query.requestId) filters.push(eq(spxBookingHistory.requestId, query.requestId));
  if (query.bookingId) filters.push(eq(spxBookingHistory.bookingId, query.bookingId));
  if (query.origin) filters.push(like(spxBookingHistory.origin, `%${query.origin}%`));
  if (query.destination) filters.push(like(spxBookingHistory.destination, `%${query.destination}%`));
  if (query.vehicleType) filters.push(like(spxBookingHistory.vehicleType, `%${query.vehicleType}%`));
  if (query.search) {
    const term = `%${query.search}%`;
    const searchNum = Number(query.search);
    const isNum = Number.isInteger(searchNum) && searchNum > 0;
    const conditions = [
      like(spxBookingHistory.route, term),
      like(spxBookingHistory.origin, term),
      like(spxBookingHistory.destination, term),
      like(spxBookingHistory.vehicleType, term),
      like(spxBookingHistory.bookingName, term),
      like(spxBookingHistory.agencyName, term),
    ];
    if (isNum) {
      conditions.push(eq(spxBookingHistory.requestId, searchNum));
      conditions.push(eq(spxBookingHistory.bookingId, searchNum));
    }
    const searchFilter = or(...conditions);
    if (searchFilter) filters.push(searchFilter);
  }
  return filters.length > 0 ? and(...filters) : undefined;
}

function buildHistoryOrderBy(query: HistoryFilterQuery) {
  return query.sortBy === "request_id"
    ? (query.sortDir === "asc" ? asc(spxBookingHistory.requestId) : desc(spxBookingHistory.requestId))
    : (query.sortDir === "asc" ? asc(spxBookingHistory.createdAt) : desc(spxBookingHistory.createdAt));
}

const historyColumns = ["request_id", "booking_id", "booking_name", "agency_name", "route", "origin", "destination", "cost_type", "trip_type", "shift_type", "vehicle_type", "standby_datetime", "acceptance_status", "assignment_status"] as const;

function historyValues(record: BookingHistoryRecord): unknown[] {
  return [record.requestId, record.bookingId ?? null, record.bookingName ?? null, record.agencyName ?? null, record.route, record.origin, record.destination, record.costType, record.tripType, record.shiftType, record.vehicleType, record.standbyDateTime, record.acceptanceStatus ?? null, record.assignmentStatus ?? null];
}

export async function insertBookingHistory(record: BookingHistoryRecord): Promise<{ action: "inserted" | "skipped" }> {
  const { inserted } = await insertBookingHistories([record]);
  return { action: inserted > 0 ? "inserted" : "skipped" };
}

export async function insertBookingHistories(records: BookingHistoryRecord[]): Promise<{ inserted: number; skipped: number }> {
  if (records.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  const pool = getPool();
  const placeholders = `(${historyColumns.map(() => "?").join(", ")}, UTC_TIMESTAMP())`;
  const values = records.flatMap(historyValues);
  const query = `INSERT IGNORE INTO spx_booking_history (${historyColumns.join(", ")}, created_at) VALUES ${records.map(() => placeholders).join(", ")}`;
  const [result] = await pool!.query(query, values);
  const inserted = (result as { affectedRows: number }).affectedRows;
  return { inserted, skipped: records.length - inserted };
}

export async function getBookingHistory(query: BookingHistoryQuery | number = 100): Promise<Array<typeof spxBookingHistory.$inferSelect>> {
  const db = await getDb();
  if (typeof query === "number") {
    const rows = await db.select().from(spxBookingHistory).orderBy(desc(spxBookingHistory.id)).limit(query);
    return rows;
  }

  const limit = query.limit ?? 200;
  const whereClause = buildHistoryFilters(query);
  const orderBy = buildHistoryOrderBy(query);

  const rows = await db.select().from(spxBookingHistory).where(whereClause).orderBy(orderBy).limit(limit);
  return rows;
}

export type PaginatedBookingHistory = {
  data: Array<typeof spxBookingHistory.$inferSelect>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export async function getBookingHistoryPaginated(query: PaginatedHistoryQuery): Promise<PaginatedBookingHistory> {
  const db = await getDb();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const whereClause = buildHistoryFilters(query);
  const orderBy = buildHistoryOrderBy(query);

  const [data, [countResult]] = await Promise.all([
    db.select().from(spxBookingHistory).where(whereClause).orderBy(orderBy).limit(pageSize).offset(offset),
    db.select({ total: count() }).from(spxBookingHistory).where(whereClause),
  ]);

  const total = countResult?.total ?? 0;

  return {
    data,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
