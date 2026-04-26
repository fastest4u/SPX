import { closePool, getPool } from "../db/client.js";

const TABLES_TO_DROP = [
  "metrics_snapshots",
  "audit_logs", 
  "users",
  "spx_booking_history",
  "schema_migrations"
];

async function main(): Promise<void> {
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

main().catch((error) => {
  console.error("❌ Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
