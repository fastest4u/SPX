import { getDb, getPool } from "../db/client.js";
import { metricsSnapshots } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";
import type { MetricsSnapshot } from "../services/metrics.js";

/** Create the metrics_snapshots table if it does not exist */
export async function ensureMetricsTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return; // Skip in memory mode
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL DEFAULT 1,
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
      KEY metrics_created_at_idx (created_at),
      KEY metrics_team_created_at_idx (team_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMetricsColumn("team_id", "ALTER TABLE metrics_snapshots ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id");
  await ensureMetricsIndex("metrics_team_created_at_idx", "ALTER TABLE metrics_snapshots ADD INDEX metrics_team_created_at_idx (team_id, created_at)");
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

async function ensureMetricsColumn(columnName: string, ddl: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const [rows] = await pool.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'metrics_snapshots' AND column_name = ? LIMIT 1",
    [columnName]
  );
  if ((rows as unknown[]).length === 0) {
    await pool.query(ddl);
  }
}

async function ensureMetricsIndex(indexName: string, ddl: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const [rows] = await pool.query(
    "SELECT 1 FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = 'metrics_snapshots' AND index_name = ? LIMIT 1",
    [indexName]
  );
  if ((rows as unknown[]).length === 0) {
    await pool.query(ddl);
  }
}
