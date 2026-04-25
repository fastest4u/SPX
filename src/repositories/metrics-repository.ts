import { getDb, getPool } from "../db/client.js";
import { metricsSnapshots } from "../db/schema.js";
import { desc } from "drizzle-orm";
import type { MetricsSnapshot } from "../services/metrics.js";

/** Create the metrics_snapshots table if it does not exist */
export async function ensureMetricsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      uptime INT NOT NULL,
      total_requests INT NOT NULL DEFAULT 0,
      success_count INT NOT NULL DEFAULT 0,
      error_count INT NOT NULL DEFAULT 0,
      success_rate VARCHAR(10) NOT NULL DEFAULT '0',
      latency_avg INT NOT NULL DEFAULT 0,
      latency_p95 INT NOT NULL DEFAULT 0,
      latency_p99 INT NOT NULL DEFAULT 0,
      total_records_seen INT NOT NULL DEFAULT 0,
      changes_detected INT NOT NULL DEFAULT 0,
      trips_inserted INT NOT NULL DEFAULT 0,
      trips_skipped INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY metrics_created_at_idx (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

/** Persist the current metrics snapshot */
export async function insertMetricsSnapshot(snap: MetricsSnapshot): Promise<void> {
  const db = getDb();
  await db.insert(metricsSnapshots).values({
    uptime: snap.uptime,
    totalRequests: snap.polling.totalRequests,
    successCount: snap.polling.successCount,
    errorCount: snap.polling.errorCount,
    successRate: String(snap.polling.successRate),
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
export async function getRecentMetricsSnapshots(limit = 100): Promise<Array<typeof metricsSnapshots.$inferSelect>> {
  const db = getDb();
  return db.select().from(metricsSnapshots).orderBy(desc(metricsSnapshots.createdAt)).limit(limit);
}
