import { getDb, ensureDashboardTables } from "../db/client.js";
import { autoAcceptHistory, teams } from "../db/schema.js";
import { and, asc, desc, eq, like, or, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { logger } from "../utils/logger.js";
import type { AutoAcceptFailureReason, AutoAcceptHistoryStatus, VerificationStatus } from "../services/auto-accept-diagnostics.js";

export interface AutoAcceptRecord {
  ruleId: string;
  ruleName: string;
  bookingId: number;
  requestIds: number[];
  acceptedCount: number;
  origin: string;
  destination: string;
  vehicleType: string;
  status: AutoAcceptHistoryStatus;
  errorMessage?: string;
  failureReason?: AutoAcceptFailureReason | null;
  traceId?: string | null;
  acceptRttMs?: number | null;
  listAgeMs?: number | null;
  verificationLatencyMs?: number | null;
  verificationStatus?: VerificationStatus | null;
  verifiedAt?: Date | string | null;
}

export interface AutoAcceptHistoryUpdate {
  requestIds?: number[];
  acceptedCount?: number;
  origin?: string;
  destination?: string;
  vehicleType?: string;
  status?: AutoAcceptHistoryStatus;
  errorMessage?: string | null;
  failureReason?: AutoAcceptFailureReason | null;
  traceId?: string | null;
  acceptRttMs?: number | null;
  listAgeMs?: number | null;
  verificationLatencyMs?: number | null;
  verificationStatus?: VerificationStatus | null;
  verifiedAt?: Date | string | null;
}

export type AutoAcceptHistoryRow = ReturnType<typeof dbRowToItem>;
type AutoAcceptHistoryJoinRow = { history: typeof autoAcceptHistory.$inferSelect; teamName: string | null };

type AutoAcceptHistoryQuery = {
  limit?: number;
  search?: string;
  ruleName?: string;
  status?: string;
  sortBy?: "created_at" | "id";
  sortDir?: "asc" | "desc";
};

function dbRowToItem(row: typeof autoAcceptHistory.$inferSelect, teamName?: string | null) {
  const parseIds = (val: string): number[] => {
    try { return JSON.parse(val) as number[]; } catch { return []; }
  };
  return {
    id: row.id,
    teamId: row.teamId,
    teamName,
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
    failureReason: row.failureReason,
    traceId: row.traceId,
    acceptRttMs: row.acceptRttMs,
    listAgeMs: row.listAgeMs,
    verificationLatencyMs: row.verificationLatencyMs,
    verificationStatus: row.verificationStatus,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
  };
}

function truncateNullable(value: string | null | undefined, length: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value.substring(0, length);
}

function toDateValue(value: Date | string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function toInsertValues(teamId: number, record: AutoAcceptRecord): typeof autoAcceptHistory.$inferInsert {
  return {
    teamId,
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
    failureReason: record.failureReason ?? undefined,
    traceId: truncateNullable(record.traceId, 160),
    acceptRttMs: record.acceptRttMs ?? undefined,
    listAgeMs: record.listAgeMs ?? undefined,
    verificationLatencyMs: record.verificationLatencyMs ?? undefined,
    verificationStatus: record.verificationStatus ?? undefined,
    verifiedAt: toDateValue(record.verifiedAt),
  };
}

function insertResultId(result: unknown): number | null {
  if (Array.isArray(result) && typeof result[0]?.insertId === "number") return result[0].insertId;
  if (typeof (result as { lastInsertRowid?: unknown })?.lastInsertRowid === "number") {
    return (result as { lastInsertRowid: number }).lastInsertRowid;
  }
  return null;
}

export async function insertAutoAcceptHistoryAndGetId(teamId: number, record: AutoAcceptRecord): Promise<number | null> {
  try {
    await ensureDashboardTables();
    const db = await getDb();
    const result = await db.insert(autoAcceptHistory).values(toInsertValues(teamId, record));
    return insertResultId(result);
  } catch (err) {
    logger.warn("auto-accept-history-insert-failed", {
      ruleId: record.ruleId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function insertAutoAcceptHistory(teamId: number, record: AutoAcceptRecord): Promise<void> {
  await insertAutoAcceptHistoryAndGetId(teamId, record);
}

export async function updateAutoAcceptHistory(teamId: number, historyId: number, patch: AutoAcceptHistoryUpdate): Promise<boolean> {
  try {
    await ensureDashboardTables();
    const db = await getDb();
    const values: Partial<typeof autoAcceptHistory.$inferInsert> = {};
    if (patch.requestIds) values.requestIds = JSON.stringify(patch.requestIds);
    if (typeof patch.acceptedCount === "number") values.acceptedCount = patch.acceptedCount;
    if (typeof patch.origin === "string") values.origin = patch.origin;
    if (typeof patch.destination === "string") values.destination = patch.destination;
    if (typeof patch.vehicleType === "string") values.vehicleType = patch.vehicleType;
    if (typeof patch.status === "string") values.status = patch.status;
    if ("errorMessage" in patch) values.errorMessage = patch.errorMessage?.substring(0, 1000) ?? null;
    if ("failureReason" in patch) values.failureReason = patch.failureReason ?? null;
    if ("traceId" in patch) values.traceId = truncateNullable(patch.traceId, 160) ?? null;
    if ("acceptRttMs" in patch) values.acceptRttMs = patch.acceptRttMs ?? null;
    if ("listAgeMs" in patch) values.listAgeMs = patch.listAgeMs ?? null;
    if ("verificationLatencyMs" in patch) values.verificationLatencyMs = patch.verificationLatencyMs ?? null;
    if ("verificationStatus" in patch) values.verificationStatus = patch.verificationStatus ?? null;
    if ("verifiedAt" in patch) values.verifiedAt = toDateValue(patch.verifiedAt) ?? null;
    if (Object.keys(values).length === 0) return true;

    await db
      .update(autoAcceptHistory)
      .set(values)
      .where(and(
        eq(autoAcceptHistory.teamId, teamId),
        eq(autoAcceptHistory.id, historyId)
      ));
    return true;
  } catch (err) {
    logger.warn("auto-accept-history-update-failed", {
      historyId,
      teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * "bookingId:requestId" keys of the most recent attempts (any outcome), used
 * to seed the poller's non-pending one-shot dedupe across restarts so a
 * deploy does not re-fire doomed accepts + failure alerts for races already
 * recorded. Bounded by row count instead of a date filter so the query
 * behaves identically on MySQL and memory-mode SQLite.
 */
export async function getRecentAutoAcceptRequestKeys(teamId: number, limit = 500): Promise<string[]> {
  try {
    await ensureDashboardTables();
    const db = await getDb();
    const rows = await db
      .select({ bookingId: autoAcceptHistory.bookingId, requestIds: autoAcceptHistory.requestIds })
      .from(autoAcceptHistory)
      .where(eq(autoAcceptHistory.teamId, teamId))
      .orderBy(desc(autoAcceptHistory.id))
      .limit(limit);
    const keys: string[] = [];
    for (const row of rows) {
      let ids: number[] = [];
      try { ids = JSON.parse(row.requestIds) as number[]; } catch { ids = []; }
      for (const id of ids) keys.push(`${row.bookingId}:${id}`);
    }
    return keys;
  } catch (err) {
    logger.warn("auto-accept-history-keys-load-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function buildAutoAcceptFilters(teamId: number | null, query: AutoAcceptHistoryQuery): SQL | undefined {
  const filters: SQL[] = [];
  if (typeof teamId === "number") filters.push(eq(autoAcceptHistory.teamId, teamId));
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
  return filters.length > 0 ? and(...filters) : undefined;
}

export async function getAutoAcceptHistory(teamId: number, query: AutoAcceptHistoryQuery) {
  return getAutoAcceptHistoryForScope(teamId, query);
}

export async function getAutoAcceptHistoryForScope(teamId: number | null, query: AutoAcceptHistoryQuery) {
  const db = await getDb();
  const limit = query.limit ?? 200;

  const orderBy = query.sortBy === "id"
    ? (query.sortDir === "asc" ? asc(autoAcceptHistory.id) : desc(autoAcceptHistory.id))
    : (query.sortDir === "asc" ? asc(autoAcceptHistory.createdAt) : desc(autoAcceptHistory.createdAt));

  const whereClause = buildAutoAcceptFilters(teamId, query);
  const rows = await db
    .select({ history: autoAcceptHistory, teamName: teams.name })
    .from(autoAcceptHistory)
    .leftJoin(teams, eq(autoAcceptHistory.teamId, teams.id))
    .where(whereClause)
    .orderBy(orderBy)
    .limit(limit);
  return rows.map((row: AutoAcceptHistoryJoinRow) => dbRowToItem(row.history, row.teamName));
}

export type PaginatedAutoAcceptHistory = {
  data: ReturnType<typeof dbRowToItem>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type PaginatedAutoAcceptHistoryQuery = AutoAcceptHistoryQuery & {
  page?: number;
  pageSize?: number;
};

export async function getAutoAcceptHistoryPaginated(teamId: number, query: PaginatedAutoAcceptHistoryQuery): Promise<PaginatedAutoAcceptHistory> {
  return getAutoAcceptHistoryPaginatedForScope(teamId, query);
}

export async function getAutoAcceptHistoryPaginatedForScope(teamId: number | null, query: PaginatedAutoAcceptHistoryQuery): Promise<PaginatedAutoAcceptHistory> {
  const db = await getDb();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const orderBy = query.sortBy === "id"
    ? (query.sortDir === "asc" ? asc(autoAcceptHistory.id) : desc(autoAcceptHistory.id))
    : (query.sortDir === "asc" ? asc(autoAcceptHistory.createdAt) : desc(autoAcceptHistory.createdAt));

  const whereClause = buildAutoAcceptFilters(teamId, query);

  const [data, [countResult]] = await Promise.all([
    db
      .select({ history: autoAcceptHistory, teamName: teams.name })
      .from(autoAcceptHistory)
      .leftJoin(teams, eq(autoAcceptHistory.teamId, teams.id))
      .where(whereClause)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(autoAcceptHistory).where(whereClause),
  ]);

  const total = countResult?.total ?? 0;

  return {
    data: data.map((row: AutoAcceptHistoryJoinRow) => dbRowToItem(row.history, row.teamName)),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
