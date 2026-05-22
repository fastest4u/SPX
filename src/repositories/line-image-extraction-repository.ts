import { ensureDashboardTables, getDb } from "../db/client.js";
import { lineImageExtractions } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import { and, asc, count, desc, eq, gte, like, lt, lte, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

export interface LineImageExtractionRecord {
  chatId: string;
  senderId: string;
  imagePath: string;
  dateText: string;
  tripNumber: string;
  driverName: string;
  agencyName: string;
  vehicleType: string;
  route: string;
  rawText: string;
}

export type LineImageExtractionSortBy = "created_at" | "date_text" | "trip_number" | "driver_name" | "route";

export interface LineImageExtractionQuery {
  search?: string;
  agency?: string;
  tripNumber?: string;
  route?: string;
  vehicleType?: string;
  driver?: string;
  createdFrom?: string;
  createdTo?: string;
  month?: string;
  sortBy?: LineImageExtractionSortBy;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export type LineImageExtractionRow = typeof lineImageExtractions.$inferSelect & {
  imageUrl: string;
};

export interface PaginatedLineImageExtractions {
  data: LineImageExtractionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function toImageUrl(imagePath: string): string {
  const normalized = imagePath.replace(/\\/g, "/");
  const prefix = "data/line-images/";
  if (normalized.startsWith(prefix)) {
    return `/line-images/${normalized.slice(prefix.length)}`;
  }
  return `/line-images/${normalized.split("/").pop() ?? normalized}`;
}

function normalizeDateBoundary(value: string, endOfDay = false): Date {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
  }
  return new Date(trimmed);
}

function buildLineImageExtractionFilters(query: LineImageExtractionQuery): SQL | undefined {
  const filters: SQL[] = [];
  if (query.agency) filters.push(like(lineImageExtractions.agencyName, `%${query.agency}%`));
  if (query.tripNumber) filters.push(like(lineImageExtractions.tripNumber, `%${query.tripNumber}%`));
  if (query.route) filters.push(like(lineImageExtractions.route, `%${query.route}%`));
  if (query.vehicleType) filters.push(like(lineImageExtractions.vehicleType, `%${query.vehicleType}%`));
  if (query.driver) filters.push(like(lineImageExtractions.driverName, `%${query.driver}%`));
  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    filters.push(gte(lineImageExtractions.createdAt, new Date(`${query.month}-01T00:00:00Z`)));
    const nextMonth = new Date(`${query.month}-01T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    filters.push(lt(lineImageExtractions.createdAt, nextMonth));
  }
  if (query.createdFrom) filters.push(gte(lineImageExtractions.createdAt, normalizeDateBoundary(query.createdFrom)));
  if (query.createdTo) filters.push(lte(lineImageExtractions.createdAt, normalizeDateBoundary(query.createdTo, true)));
  if (query.search) {
    const term = `%${query.search}%`;
    const searchFilter = or(
      like(lineImageExtractions.dateText, term),
      like(lineImageExtractions.tripNumber, term),
      like(lineImageExtractions.driverName, term),
      like(lineImageExtractions.agencyName, term),
      like(lineImageExtractions.vehicleType, term),
      like(lineImageExtractions.route, term),
      like(lineImageExtractions.rawText, term),
    );
    if (searchFilter) filters.push(searchFilter);
  }
  return filters.length > 0 ? and(...filters) : undefined;
}

function buildLineImageExtractionOrderBy(query: LineImageExtractionQuery) {
  const direction = query.sortDir === "asc" ? asc : desc;
  switch (query.sortBy) {
    case "date_text":
      return direction(lineImageExtractions.dateText);
    case "trip_number":
      return direction(lineImageExtractions.tripNumber);
    case "driver_name":
      return direction(lineImageExtractions.driverName);
    case "route":
      return direction(lineImageExtractions.route);
    default:
      return direction(lineImageExtractions.createdAt);
  }
}

export async function insertLineImageExtraction(record: LineImageExtractionRecord): Promise<number | null> {
  try {
    await ensureDashboardTables();
    const db = await getDb();
    const result = await db.insert(lineImageExtractions).values({
      chatId: record.chatId,
      senderId: record.senderId,
      imagePath: record.imagePath,
      dateText: record.dateText,
      tripNumber: record.tripNumber.substring(0, 100),
      driverName: record.driverName.substring(0, 500),
      agencyName: record.agencyName.substring(0, 100),
      vehicleType: record.vehicleType.substring(0, 100),
      route: record.route.substring(0, 255),
      rawText: record.rawText.substring(0, 4000),
    });

    return typeof result?.[0]?.insertId === "number" ? result[0].insertId : null;
  } catch (error) {
    logger.warn("line-image-extraction-insert-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getLineImageExtractionsPaginated(query: LineImageExtractionQuery): Promise<PaginatedLineImageExtractions> {
  await ensureDashboardTables();
  const db = await getDb();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));
  const offset = (page - 1) * pageSize;
  const whereClause = buildLineImageExtractionFilters(query);
  const orderBy = buildLineImageExtractionOrderBy(query);

  const [rows, [countResult]] = await Promise.all([
    db.select().from(lineImageExtractions).where(whereClause).orderBy(orderBy).limit(pageSize).offset(offset),
    db.select({ total: count() }).from(lineImageExtractions).where(whereClause),
  ]);

  const total = countResult?.total ?? 0;
  return {
    data: rows.map((row: typeof lineImageExtractions.$inferSelect) => ({ ...row, imageUrl: toImageUrl(row.imagePath) })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function getLineImageExtractionByTripNumber(tripNumber: string): Promise<typeof lineImageExtractions.$inferSelect | null> {
  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db
    .select()
    .from(lineImageExtractions)
    .where(eq(lineImageExtractions.tripNumber, tripNumber))
    .limit(1);
  return rows[0] ?? null;
}

