import { getDb } from "../db/client.js";
import { ensureDashboardTables } from "../db/client.js";
import { metricsSnapshots } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";
import type { MetricsSnapshot } from "../services/metrics.js";

/**
 * Metrics snapshots are part of the dashboard-owned schema. Runtime schema
 * mutations live in `src/db/client.ts` and are production-guarded there, so
 * this repository stays read/write-only and never emits DDL.
 */
export async function ensureMetricsTable(): Promise<void> {
  await ensureDashboardTables();
}

/** Persist the current metrics snapshot */
export async function insertMetricsSnapshot(snap: MetricsSnapshot, teamId: number = snap.teamId ?? 1): Promise<void> {
  const db = getDb();
  await db.insert(metricsSnapshots).values({
    teamId,
    uptime: snap.uptime,
    totalRequests: snap.polling.totalRequests,
    successCount: snap.polling.successCount,
    errorCount: snap.polling.errorCount,
    successRate: snap.polling.successRate.toFixed(2),
    latencyAvg: snap.polling.latency.avg,
    latencyP95: snap.polling.latency.p95,
    latencyP99: snap.polling.latency.p99,
    totalRecordsSeen: snap.data.totalRecordsSeen,
    changesDetected: snap.data.changesDetected,
    tripsInserted: snap.data.tripsInserted,
    tripsSkipped: snap.data.tripsSkipped,
  });
}

/** Get recent metrics snapshots for analytics */
export async function getRecentMetricsSnapshots(limit = 100, teamId?: number): Promise<Array<typeof metricsSnapshots.$inferSelect>> {
  const db = getDb();
  const query = db.select().from(metricsSnapshots);
  if (typeof teamId === "number") {
    return query.where(eq(metricsSnapshots.teamId, teamId)).orderBy(desc(metricsSnapshots.createdAt)).limit(limit);
  }
  return query.orderBy(desc(metricsSnapshots.createdAt)).limit(limit);
}
