import { getDb } from "../db/client.js";
import { auditLogs } from "../db/schema.js";
import { and, asc, desc, eq, like, or, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { logger } from "../utils/logger.js";

type AuditQuery = {
  limit?: number;
  search?: string;
  username?: string;
  action?: string;
  targetTeamId?: number;
  sortBy?: "created_at" | "id";
  sortDir?: "asc" | "desc";
};

type AuditInsertOptions = {
  actorUserId?: number;
  actorTeamId?: number | null;
  targetTeamId?: number | null;
};

export async function insertAuditLog(username: string, action: string, details?: string, options: AuditInsertOptions = {}) {
  try {
    const db = await getDb();
    await db.insert(auditLogs).values({
      username,
      action,
      details: details?.substring(0, 1000),
      actorUserId: options.actorUserId,
      actorTeamId: options.actorTeamId,
      targetTeamId: options.targetTeamId,
      teamId: options.targetTeamId,
    });
  } catch (error) {
    logger.warn("audit-log-insert-failed", {
      username,
      action,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getAuditLogs(query: AuditQuery | number = 100) {
  const db = await getDb();
  if (typeof query === "number") {
    return db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(query);
  }

  const limit = query.limit ?? 200;
  const filters: SQL[] = [];
  if (query.username) filters.push(eq(auditLogs.username, query.username));
  if (query.action) filters.push(eq(auditLogs.action, query.action));
  if (query.targetTeamId) filters.push(eq(auditLogs.targetTeamId, query.targetTeamId));
  if (query.search) {
    const term = `%${query.search}%`;
    const searchFilter = or(like(auditLogs.username, term), like(auditLogs.action, term), like(auditLogs.details, term));
    if (searchFilter) filters.push(searchFilter);
  }

  const orderBy = query.sortBy === "id"
    ? (query.sortDir === "asc" ? asc(auditLogs.id) : desc(auditLogs.id))
    : (query.sortDir === "asc" ? asc(auditLogs.createdAt) : desc(auditLogs.createdAt));

  return db.select().from(auditLogs).where(filters.length > 0 ? and(...filters) : undefined).orderBy(orderBy).limit(limit);
}

export async function getAuditLogsPaginated(query: AuditQuery & { page?: number; pageSize?: number }) {
  const db = await getDb();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [];
  if (query.username) filters.push(eq(auditLogs.username, query.username));
  if (query.action) filters.push(eq(auditLogs.action, query.action));
  if (query.targetTeamId) filters.push(eq(auditLogs.targetTeamId, query.targetTeamId));
  if (query.search) {
    const term = `%${query.search}%`;
    const searchFilter = or(like(auditLogs.username, term), like(auditLogs.action, term), like(auditLogs.details, term));
    if (searchFilter) filters.push(searchFilter);
  }

  const orderBy = query.sortBy === "id"
    ? (query.sortDir === "asc" ? asc(auditLogs.id) : desc(auditLogs.id))
    : (query.sortDir === "asc" ? asc(auditLogs.createdAt) : desc(auditLogs.createdAt));

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const [data, [countResult]] = await Promise.all([
    db.select().from(auditLogs).where(whereClause).orderBy(orderBy).limit(pageSize).offset(offset),
    db.select({ total: count() }).from(auditLogs).where(whereClause),
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
