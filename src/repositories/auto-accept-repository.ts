import { getDb, ensureDashboardTables } from "../db/client.js";
import { autoAcceptHistory } from "../db/schema.js";
import { and, asc, desc, eq, like, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { logger } from "../utils/logger.js";

export interface AutoAcceptRecord {
  ruleId: string;
  ruleName: string;
  bookingId: number;
  requestIds: number[];
  acceptedCount: number;
  origin: string;
  destination: string;
  vehicleType: string;
  status: "success" | "failed";
  errorMessage?: string;
}

export type AutoAcceptHistoryRow = ReturnType<typeof dbRowToItem>;

type AutoAcceptHistoryQuery = {
  limit?: number;
  search?: string;
  ruleName?: string;
  status?: string;
  sortBy?: "created_at" | "id";
  sortDir?: "asc" | "desc";
};

function dbRowToItem(row: typeof autoAcceptHistory.$inferSelect) {
  const parseIds = (val: string): number[] => {
    try { return JSON.parse(val) as number[]; } catch { return []; }
  };
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    bookingId: row.bookingId,
    requestIds: parseIds(row.requestIds),
    acceptedCount: row.acceptedCount,
    origin: row.origin,
    destination: row.destination,
    vehicleType: row.vehicleType,
    status: row.status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}

export async function insertAutoAcceptHistory(record: AutoAcceptRecord): Promise<void> {
  try {
    await ensureDashboardTables();
    const db = await getDb();
    await db.insert(autoAcceptHistory).values({
      ruleId: record.ruleId,
      ruleName: record.ruleName,
      bookingId: record.bookingId,
      requestIds: JSON.stringify(record.requestIds),
      acceptedCount: record.acceptedCount,
      origin: record.origin,
      destination: record.destination,
      vehicleType: record.vehicleType,
      status: record.status,
      errorMessage: record.errorMessage?.substring(0, 1000),
    });
  } catch (err) {
    logger.warn("auto-accept-history-insert-failed", {
      ruleId: record.ruleId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getAutoAcceptHistory(query: AutoAcceptHistoryQuery) {
  const db = await getDb();
  const limit = query.limit ?? 200;
  const filters: SQL[] = [];
  if (query.ruleName) filters.push(like(autoAcceptHistory.ruleName, `%${query.ruleName}%`));
  if (query.status) filters.push(eq(autoAcceptHistory.status, query.status));
  if (query.search) {
    const term = `%${query.search}%`;
    const searchFilter = or(
      like(autoAcceptHistory.ruleName, term),
      like(autoAcceptHistory.origin, term),
      like(autoAcceptHistory.destination, term),
      like(autoAcceptHistory.vehicleType, term),
    );
    if (searchFilter) filters.push(searchFilter);
  }

  const orderBy = query.sortBy === "id"
    ? (query.sortDir === "asc" ? asc(autoAcceptHistory.id) : desc(autoAcceptHistory.id))
    : (query.sortDir === "asc" ? asc(autoAcceptHistory.createdAt) : desc(autoAcceptHistory.createdAt));

  const q = db.select()
    .from(autoAcceptHistory)
    .orderBy(orderBy)
    .limit(limit);

  if (filters.length > 0) {
    q.where(and(...filters));
  }

  const rows = await q;
  return rows.map(dbRowToItem);
}
