import { resolve } from "node:path";
import { closePool, getPool } from "../db/client.js";

const TABLES_TO_DROP = [
  "auto_accept_history",
  "notify_rules",
  "metrics_snapshots",
  "audit_logs", 
  "users",
  "spx_booking_history",
  "schema_migrations"
];

export function assertDbResetAllowed(envVars: NodeJS.ProcessEnv = process.env): void {
  if (envVars.NODE_ENV === "production" && envVars.ALLOW_PRODUCTION_DB_RESET !== "true") {
    throw new Error(
      "Refusing to run db:reset in production without ALLOW_PRODUCTION_DB_RESET=true",
    );
  }
}

async function main(): Promise<void> {
  assertDbResetAllowed();
  const pool = getPool();
  
  try {
    if (!pool) {
      console.log("⚠️  Memory mode: resetting in-memory database...");
      console.log("✅ In-memory database reset complete!");
      return;
    }
    
    console.log("⚠️  Resetting MySQL database...");
    
    // Disable foreign key checks temporarily
    await pool.query("SET FOREIGN_KEY_CHECKS = 0");
    
    // Drop all tables
    for (const table of TABLES_TO_DROP) {
      try {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
        console.log(`  ✓ Dropped table: ${table}`);
      } catch (error) {
        console.log(`  ⚠️  Could not drop ${table}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Re-enable foreign key checks
    await pool.query("SET FOREIGN_KEY_CHECKS = 1");
    
    console.log("\n✅ Database reset complete!");
    console.log("Run 'npm run db:migrate' to recreate tables.");
    
  } finally {
    await closePool();
  }
}

const isMainModule =
  Boolean(process.argv[1]) &&
  typeof __filename === "string" &&
  resolve(process.argv[1]) === resolve(__filename);

if (isMainModule) {
  main().catch((error) => {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
