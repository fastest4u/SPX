import { getDb } from "../db/client.js";
import { auditLogs } from "../db/schema.js";
import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

type AuditQuery = {
  limit?: number;
  search?: string;
  username?: string;
  action?: string;
  sortBy?: "created_at" | "id";
  sortDir?: "asc" | "desc";
};

export async function insertAuditLog(username: string, action: string, details?: string) {
  const db = await getDb();
  await db.insert(auditLogs).values({ username, action, details: details?.substring(0, 1000) });
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
  if (query.search) {
    const term = `%${query.search}%`;
    const searchFilter = or(ilike(auditLogs.username, term), ilike(auditLogs.action, term), ilike(auditLogs.details, term));
    if (searchFilter) filters.push(searchFilter);
  }

  const orderBy = query.sortBy === "id"
    ? (query.sortDir === "asc" ? asc(auditLogs.id) : desc(auditLogs.id))
    : (query.sortDir === "asc" ? asc(auditLogs.createdAt) : desc(auditLogs.createdAt));

  return db.select().from(auditLogs).where(filters.length > 0 ? and(...filters) : undefined).orderBy(orderBy).limit(limit);
}
