import { resolve } from "node:path";
import { closePool, getPool } from "../db/client.js";
import { runMigrationsFromDirectory } from "../db/migration-runner.js";

/**
 * Operator CLI for applying the locked, checksum-verified migration set.
 * All behavior (locking, checksums, failure state, retry guard) lives in
 * the migration runner; this wrapper only owns the process boundary.
 */
async function main(): Promise<void> {
  const pool = getPool();
  if (!pool) {
    console.log("Memory mode: skipping MySQL migrations");
    return;
  }
  const connection = await pool.getConnection();
  try {
    const result = await runMigrationsFromDirectory({
      connection,
      directory: resolve(process.cwd(), "migrations"),
    });
    for (const entry of result.applied) {
      console.log(`Applied migration: ${entry}`);
    }
    console.log(`Migration run complete: ${result.applied.length} applied, ${result.skipped.length} skipped`);
  } finally {
    connection.release();
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
