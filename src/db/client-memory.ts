// @ts-nocheck
/**
 * SQLite in-memory database client for testing
 * Uses better-sqlite3 with Drizzle ORM
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

let sqliteDb: Database.Database | null = null;
let drizzleDb: ReturnType<typeof drizzle> | null = null;

/**
 * Get or create SQLite in-memory database
 * Returns a Drizzle ORM instance compatible with MySQL schema
 */
export function getMemoryDb(): ReturnType<typeof drizzle> {
  if (drizzleDb) {
    return drizzleDb;
  }

  sqliteDb = new Database(":memory:");
  drizzleDb = drizzle(sqliteDb);

  // Initialize schema
  initSchema(sqliteDb);

  return drizzleDb;
}

/**
 * Close the in-memory database
 */
export function closeMemoryDb(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    drizzleDb = null;
  }
}

/**
 * Reset all data in the in-memory database
 */
export function resetMemoryDb(): void {
  closeMemoryDb();
  getMemoryDb();
}

/**
 * Initialize SQLite schema (tables)
 */
function initSchema(db: Database.Database): void {
  // Create tables that mirror MySQL schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS spx_booking_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL UNIQUE,
      booking_id INTEGER,
      booking_name TEXT,
      agency_name TEXT,
      route TEXT NOT NULL,
      origin TEXT,
      destination TEXT,
      cost_type TEXT,
      trip_type TEXT,
      shift_type TEXT,
      vehicle_type TEXT,
      standby_datetime TEXT,
      acceptance_status INTEGER,
      assignment_status INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_request_id ON spx_booking_history(request_id);
    CREATE INDEX IF NOT EXISTS idx_booking_id ON spx_booking_history(booking_id);
    CREATE INDEX IF NOT EXISTS idx_created_at ON spx_booking_history(created_at);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uptime INTEGER NOT NULL,
      total_requests INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      success_rate TEXT NOT NULL DEFAULT '0',
      latency_avg INTEGER NOT NULL DEFAULT 0,
      latency_p95 INTEGER NOT NULL DEFAULT 0,
      latency_p99 INTEGER NOT NULL DEFAULT 0,
      total_records_seen INTEGER NOT NULL DEFAULT 0,
      changes_detected INTEGER NOT NULL DEFAULT 0,
      trips_inserted INTEGER NOT NULL DEFAULT 0,
      trips_skipped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notify_rules (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      origins TEXT NOT NULL DEFAULT '[]',
      destinations TEXT NOT NULL DEFAULT '[]',
      vehicle_types TEXT NOT NULL DEFAULT '[]',
      need INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      fulfilled INTEGER NOT NULL DEFAULT 0,
      auto_accept INTEGER NOT NULL DEFAULT 0,
      auto_accepted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auto_accept_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      booking_id INTEGER NOT NULL,
      request_ids TEXT NOT NULL,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT '',
      destination TEXT NOT NULL DEFAULT '',
      vehicle_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Get raw SQLite database instance (for migrations)
 */
export function getRawMemoryDb(): Database.Database {
  if (!sqliteDb) {
    getMemoryDb();
  }
  return sqliteDb!;
}

// Legacy exports for compatibility
export function getMemoryPool(): Database.Database {
  return getRawMemoryDb();
}

export function closeMemoryPool(): void {
  closeMemoryDb();
}

export function resetMemoryStore(): void {
  resetMemoryDb();
}
