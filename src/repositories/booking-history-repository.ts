import { getDb, getPool } from "../db/client.js";
import { spxBookingHistory } from "../db/schema.js";
import { and, count, desc, asc, eq, like, or, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import type { SQL } from "drizzle-orm";
import type { Pool } from "mysql2/promise";

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
const requestIdLookupChunkSize = 1000;
const seenRequestIdTtlMs = 6 * 60 * 60 * 1000;
const seenRequestIdCacheMax = 100_000;
const seenRequestIdCache = new Map<number, number>();

function historyValues(record: BookingHistoryRecord): unknown[] {
  return [record.requestId, record.bookingId ?? null, record.bookingName ?? null, record.agencyName ?? null, record.route, record.origin, record.destination, record.costType, record.tripType, record.shiftType, record.vehicleType, record.standbyDateTime, record.acceptanceStatus ?? null, record.assignmentStatus ?? null];
}

export function dedupeBookingHistoryRecords(records: BookingHistoryRecord[]): { records: BookingHistoryRecord[]; skipped: number } {
  const seen = new Set<number>();
  const uniqueRecords: BookingHistoryRecord[] = [];

  for (const record of records) {
    if (seen.has(record.requestId)) {
      continue;
    }
    seen.add(record.requestId);
    uniqueRecords.push(record);
  }

  return { records: uniqueRecords, skipped: records.length - uniqueRecords.length };
}

export function filterKnownBookingHistoryRecords(
  records: BookingHistoryRecord[],
  knownRequestIds: ReadonlySet<number>
): { records: BookingHistoryRecord[]; skipped: number } {
  const unknownRecords = records.filter((record) => !knownRequestIds.has(record.requestId));
  return { records: unknownRecords, skipped: records.length - unknownRecords.length };
}

function isRequestIdCached(requestId: number, now: number): boolean {
  const expiresAt = seenRequestIdCache.get(requestId);
  if (expiresAt === undefined) {
    return false;
  }

  if (expiresAt <= now) {
    seenRequestIdCache.delete(requestId);
    return false;
  }

  return true;
}

function pruneExpiredSeenRequestIds(now: number): void {
  for (const [requestId, expiresAt] of seenRequestIdCache) {
    if (expiresAt <= now) {
      seenRequestIdCache.delete(requestId);
    }
  }
}

function rememberBookingHistoryRequestIds(requestIds: Iterable<number>, now = Date.now()): void {
  const expiresAt = now + seenRequestIdTtlMs;
  let remembered = 0;

  for (const requestId of requestIds) {
    if (!Number.isFinite(requestId)) {
      continue;
    }
    seenRequestIdCache.set(requestId, expiresAt);
    remembered += 1;
  }

  if (remembered === 0) {
    return;
  }

  if (seenRequestIdCache.size > seenRequestIdCacheMax) {
    pruneExpiredSeenRequestIds(now);
  }

  while (seenRequestIdCache.size > seenRequestIdCacheMax) {
    const oldestRequestId = seenRequestIdCache.keys().next().value;
    if (oldestRequestId === undefined) {
      break;
    }
    seenRequestIdCache.delete(oldestRequestId);
  }
}

async function findExistingBookingHistoryRequestIds(pool: Pool, requestIds: number[]): Promise<Set<number>> {
  const existingRequestIds = new Set<number>();

  for (let index = 0; index < requestIds.length; index += requestIdLookupChunkSize) {
    const chunk = requestIds.slice(index, index + requestIdLookupChunkSize);
    if (chunk.length === 0) {
      continue;
    }

    const placeholders = chunk.map(() => "?").join(", ");
    const [rows] = await pool.query(
      `SELECT request_id FROM spx_booking_history WHERE request_id IN (${placeholders})`,
      chunk
    );

    for (const row of rows as Array<{ request_id: number | string | bigint }>) {
      existingRequestIds.add(Number(row.request_id));
    }
  }

  return existingRequestIds;
}

export async function insertBookingHistory(record: BookingHistoryRecord): Promise<{ action: "inserted" | "skipped" }> {
  const { inserted } = await insertBookingHistories([record]);
  return { action: inserted > 0 ? "inserted" : "skipped" };
}

export async function insertBookingHistories(records: BookingHistoryRecord[]): Promise<{ inserted: number; skipped: number }> {
  if (records.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  const deduped = dedupeBookingHistoryRecords(records);

  // In-memory mode (SQLite) doesn't share the mysql2 pool. Fall back to Drizzle
  // which routes to the right driver. INSERT IGNORE behaves correctly because
  // Drizzle uses the underlying database's "ignore" semantics (MySQL: INSERT IGNORE,
  // SQLite: INSERT OR IGNORE).
  if (env.DB_MODE === "memory") {
    const db = await getDb();
    const rows = deduped.records.map((record) => ({
      requestId: record.requestId,
      bookingId: record.bookingId ?? null,
      bookingName: record.bookingName ?? null,
      agencyName: record.agencyName ?? null,
      route: record.route,
      origin: record.origin,
      destination: record.destination,
      costType: record.costType,
      tripType: record.tripType,
      shiftType: record.shiftType,
      vehicleType: record.vehicleType,
      standbyDateTime: record.standbyDateTime,
      acceptanceStatus: record.acceptanceStatus ?? null,
      assignmentStatus: record.assignmentStatus ?? null,
      createdAt: sql`CURRENT_TIMESTAMP`,
    }));
    // SQLite/Drizzle: insert each row with onConflictDoNothing() so the
    // UNIQUE(request_id) constraint is the authoritative dedup. The whole batch
    // runs in one transaction; only conflict-skips are swallowed (via
    // onConflictDoNothing) — any other (schema/driver) error propagates.
    const inserted: number = db.transaction((tx: typeof db) => {
      let insertedCount = 0;
      for (const row of rows) {
        const result = tx.insert(spxBookingHistory).values(row).onConflictDoNothing().run();
        // better-sqlite3 RunResult: changes === 1 on insert, 0 on conflict-skip.
        if (result?.changes > 0) {
          insertedCount += 1;
        }
      }
      return insertedCount;
    });
    return { inserted, skipped: records.length - inserted };
  }

  const pool = getPool();
  if (!pool) throw new Error("Database pool not initialised");

  const now = Date.now();

  // seenRequestIdCache is a HINT ONLY: it lets us skip the existence SELECT for
  // request_ids we already confirmed exist this TTL window. It must NOT remove
  // rows from the INSERT set — UNIQUE(request_id) + INSERT IGNORE is the
  // authoritative dedup, so a row that was deleted/changed in the DB can still
  // re-insert. We therefore INSERT IGNORE the full deduped set unconditionally.
  const uncachedRequestIds = deduped.records
    .map((record) => record.requestId)
    .filter((requestId) => !isRequestIdCached(requestId, now));

  if (uncachedRequestIds.length > 0) {
    const existingRequestIds = await findExistingBookingHistoryRequestIds(pool, uncachedRequestIds);
    // Remember confirmed-existing ids so future ticks can skip the SELECT for them.
    rememberBookingHistoryRequestIds(existingRequestIds, now);
  }

  const placeholders = `(${historyColumns.map(() => "?").join(", ")}, UTC_TIMESTAMP())`;
  const values = deduped.records.flatMap(historyValues);
  const query = `INSERT IGNORE INTO spx_booking_history (${historyColumns.join(", ")}, created_at) VALUES ${deduped.records.map(() => placeholders).join(", ")}`;
  const [result] = await pool.query(query, values);
  const inserted = (result as { affectedRows: number }).affectedRows;
  rememberBookingHistoryRequestIds(deduped.records.map((record) => record.requestId), now);
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
