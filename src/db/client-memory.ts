// @ts-nocheck
/**
 * SQLite in-memory database client for testing
 * Uses better-sqlite3 with Drizzle ORM
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";

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
  drizzleDb = drizzle(sqliteDb, { schema });

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
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      spx_cookie TEXT NOT NULL DEFAULT '',
      spx_device_id TEXT NOT NULL DEFAULT '',
      line_group_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS teams_enabled_idx ON teams(enabled);
    CREATE INDEX IF NOT EXISTS teams_name_idx ON teams(name);

    CREATE TABLE IF NOT EXISTS spx_booking_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL DEFAULT 1,
      request_id INTEGER NOT NULL,
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

    CREATE UNIQUE INDEX IF NOT EXISTS spx_booking_history_team_request_uidx ON spx_booking_history(team_id, request_id);
    CREATE INDEX IF NOT EXISTS idx_booking_id ON spx_booking_history(booking_id);
    CREATE INDEX IF NOT EXISTS idx_created_at ON spx_booking_history(created_at);
    CREATE INDEX IF NOT EXISTS spx_booking_history_team_created_idx ON spx_booking_history(team_id, created_at);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      team_id INTEGER,
      auth_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS users_team_id_idx ON users(team_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER,
      actor_user_id INTEGER,
      actor_team_id INTEGER,
      target_team_id INTEGER,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS audit_created_at_idx ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS audit_username_created_at_idx ON audit_logs(username, created_at);
    CREATE INDEX IF NOT EXISTS audit_action_created_at_idx ON audit_logs(action, created_at);
    CREATE INDEX IF NOT EXISTS audit_target_team_created_at_idx ON audit_logs(target_team_id, created_at);

    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL DEFAULT 1,
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

    CREATE INDEX IF NOT EXISTS metrics_team_created_at_idx ON metrics_snapshots(team_id, created_at);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notify_rules (
      id TEXT NOT NULL PRIMARY KEY,
      team_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      origins TEXT NOT NULL DEFAULT '[]',
      destinations TEXT NOT NULL DEFAULT '[]',
      vehicle_types TEXT NOT NULL DEFAULT '[]',
      need INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      fulfilled INTEGER NOT NULL DEFAULT 0,
      auto_accept INTEGER NOT NULL DEFAULT 0,
      accept_all INTEGER NOT NULL DEFAULT 0,
      auto_accepted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS notify_rules_team_id_idx ON notify_rules(team_id);

    CREATE TABLE IF NOT EXISTS auto_accept_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL DEFAULT 1,
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
      failure_reason TEXT,
      trace_id TEXT,
      accept_rtt_ms INTEGER,
      list_age_ms INTEGER,
      verification_latency_ms INTEGER,
      verification_status TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS aah_created_at_idx ON auto_accept_history(created_at);
    CREATE INDEX IF NOT EXISTS aah_rule_id_idx ON auto_accept_history(rule_id);
    CREATE INDEX IF NOT EXISTS aah_status_created_at_idx ON auto_accept_history(status, created_at);
    CREATE INDEX IF NOT EXISTS aah_team_created_at_idx ON auto_accept_history(team_id, created_at);
    CREATE INDEX IF NOT EXISTS aah_team_status_created_at_idx ON auto_accept_history(team_id, status, created_at);
    CREATE INDEX IF NOT EXISTS aah_team_reason_created_at_idx ON auto_accept_history(team_id, failure_reason, created_at);
    CREATE INDEX IF NOT EXISTS aah_trace_id_idx ON auto_accept_history(trace_id);

    CREATE TABLE IF NOT EXISTS line_bot_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL DEFAULT 'default',
      auth_token TEXT NOT NULL,
      device TEXT NOT NULL DEFAULT 'IOSIPAD',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_line_bot_sessions_key ON line_bot_sessions(session_key);

    CREATE TABLE IF NOT EXISTS line_image_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      image_path TEXT NOT NULL,
      date_text TEXT NOT NULL,
      trip_number TEXT NOT NULL DEFAULT '',
      driver_name TEXT NOT NULL,
      agency_name TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      route TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS lie_created_at_idx ON line_image_extractions(created_at);
    CREATE INDEX IF NOT EXISTS lie_agency_created_at_idx ON line_image_extractions(agency_name, created_at);
    CREATE INDEX IF NOT EXISTS lie_trip_number_created_at_idx ON line_image_extractions(trip_number, created_at);

    CREATE TABLE IF NOT EXISTS notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      worker_node_id TEXT NOT NULL,
      trace_id TEXT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS notification_events_event_key_uidx ON notification_events(event_key);
    CREATE INDEX IF NOT EXISTS notification_events_team_received_idx ON notification_events(team_id, received_at);

    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL DEFAULT (datetime('now')),
      locked_by TEXT,
      locked_until TEXT,
      sent_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_event_key_uidx ON notification_outbox(event_key);
    CREATE INDEX IF NOT EXISTS notification_outbox_status_available_idx ON notification_outbox(status, available_at);
    CREATE INDEX IF NOT EXISTS notification_outbox_team_created_idx ON notification_outbox(team_id, created_at);

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbox_id INTEGER NOT NULL,
      delivery_attempt INTEGER NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS notification_deliveries_outbox_idx ON notification_deliveries(outbox_id);

    CREATE TABLE IF NOT EXISTS runtime_nodes (
      node_id TEXT NOT NULL PRIMARY KEY,
      role TEXT NOT NULL,
      hostname TEXT,
      pid INTEGER,
      version TEXT,
      last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS runtime_nodes_role_heartbeat_idx ON runtime_nodes(role, last_heartbeat_at);

    CREATE TABLE IF NOT EXISTS team_runtime_leases (
      team_id INTEGER NOT NULL PRIMARY KEY,
      owner_node_id TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'running',
      last_error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS trl_owner_idx ON team_runtime_leases(owner_node_id);
    CREATE INDEX IF NOT EXISTS trl_expires_idx ON team_runtime_leases(lease_expires_at);

    CREATE TABLE IF NOT EXISTS team_runtime_desired_state (
      team_id INTEGER NOT NULL PRIMARY KEY,
      desired_state TEXT NOT NULL DEFAULT 'running',
      changed_by_user_id INTEGER,
      reason TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auto_accept_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      worker_node_id TEXT NOT NULL,
      booking_id INTEGER NOT NULL,
      request_ids_json TEXT NOT NULL,
      rule_id TEXT,
      rule_name TEXT,
      accept_mode TEXT NOT NULL,
      accept_started_at TEXT NOT NULL,
      accept_finished_at TEXT,
      accept_rtt_ms INTEGER,
      spx_http_status INTEGER,
      spx_retcode INTEGER,
      spx_message TEXT,
      raw_error TEXT,
      ambiguous_accept INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS aaa_trace_uidx ON auto_accept_attempts(trace_id);
    CREATE INDEX IF NOT EXISTS aaa_team_booking_idx ON auto_accept_attempts(team_id, booking_id);
    CREATE INDEX IF NOT EXISTS aaa_worker_created_idx ON auto_accept_attempts(worker_node_id, created_at);

    CREATE TABLE IF NOT EXISTS auto_accept_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      winning_attempt_trace_id TEXT,
      status TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      evidence_json TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS aar_team_booking_request_uidx ON auto_accept_results(team_id, booking_id, request_id);
    CREATE INDEX IF NOT EXISTS aar_team_status_idx ON auto_accept_results(team_id, status);
    CREATE INDEX IF NOT EXISTS aar_trace_idx ON auto_accept_results(winning_attempt_trace_id);

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT NOT NULL PRIMARY KEY,
      setting_value TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
