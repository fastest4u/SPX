import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import { env } from "../config/env.js";
import * as schema from "./schema.js";
import { getMemoryDb, closeMemoryDb } from "./client-memory.js";

// Use any for DB type to allow both MySQL and SQLite Drizzle instances
// This is acceptable since both have the same API surface (select, insert, update, delete)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDb = any;

const DB_TIMEZONE = "+00:00";

function createPool(): Pool | null {
  // In-memory mode doesn't use mysql2 pool
  if (env.DB_MODE === "memory") {
    return null;
  }

  if (!env.DB_HOST || !env.DB_USERNAME || !env.DB_PASSWORD || !env.DB_NAME) {
    throw new Error("Missing DB configuration in .env");
  }

  const pool = mysql.createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: "utf8mb4",
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0,
    // Explicit connection-establishment bound and idle-socket death
    // detection (keepalive probes start after 10s idle instead of the OS
    // default). Note: none of these bound an *in-flight* query on a
    // black-holed link — that needs a per-query deadline at the call site
    // (tracked follow-up for the hot-path jwt_blacklist lookup).
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    timezone: DB_TIMEZONE,
    dateStrings: true,
  });

  pool.on("connection", (connection) => {
    connection.query(`SET time_zone = '${DB_TIMEZONE}'`);
  });

  return pool;
}

function createDb(): AnyDrizzleDb {
  if (env.DB_MODE === "memory") {
    // For memory mode, use SQLite Drizzle
    return getMemoryDb() as unknown as AnyDrizzleDb;
  }
  return drizzleMysql(getPool() as Pool, { schema, mode: "default" });
}

let poolInstance: ReturnType<typeof createPool> | null = null;
let dbInstance: ReturnType<typeof createDb> | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;
let dashboardTablesInitialized = false;
let dashboardTablesInitializationPromise: Promise<void> | null = null;

export function getPool(): ReturnType<typeof createPool> {
  if (poolInstance) {
    return poolInstance;
  }

  poolInstance = createPool();

  return poolInstance;
}

export function getDb(): ReturnType<typeof createDb> {
  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = createDb();
  return dbInstance;
}

export interface PoolStats {
  totalConnections: number;
  idleConnections: number;
  acquiredConnections: number;
  queuedRequests: number;
  connectionLimit: number;
}

/** Get current connection pool statistics for health monitoring */
export function getPoolStats(): PoolStats | null {
  if (!poolInstance) return null;

  // Memory pool doesn't have real connection stats
  if (env.DB_MODE === "memory") {
    return {
      totalConnections: 1,
      idleConnections: 1,
      acquiredConnections: 0,
      queuedRequests: 0,
      connectionLimit: 10,
    };
  }

  // mysql2 pool internals are not typed but available at runtime
  const pool = (poolInstance as Pool).pool as unknown as Record<string, unknown>;
  const all = Array.isArray(pool._allConnections) ? pool._allConnections.length : 0;
  const free = Array.isArray(pool._freeConnections) ? pool._freeConnections.length : 0;
  const queue = Array.isArray(pool._connectionQueue) ? pool._connectionQueue.length : 0;
  const config = pool.config as Record<string, unknown> | undefined;
  return {
    totalConnections: all,
    idleConnections: free,
    acquiredConnections: all - free,
    queuedRequests: queue,
    connectionLimit: typeof config?.connectionLimit === "number" ? config.connectionLimit : 10,
  };
}

export async function closePool(): Promise<void> {
  if (env.DB_MODE === "memory") {
    closeMemoryDb();
    dbInstance = null;
    initialized = false;
    initializationPromise = null;
    dashboardTablesInitialized = false;
    dashboardTablesInitializationPromise = null;
    return;
  }

  if (!poolInstance) {
    return;
  }

  const pool = poolInstance;
  poolInstance = null;
  dbInstance = null;
  initialized = false;
  initializationPromise = null;
  dashboardTablesInitialized = false;
  dashboardTablesInitializationPromise = null;
  await pool.end();
}

export async function ensureSpxBookingHistoryTable(): Promise<void> {
  if (initialized) {
    return;
  }

  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  initializationPromise = createSpxBookingHistoryTable();

  try {
    await initializationPromise;
    initialized = true;
  } finally {
    if (!initialized) {
      initializationPromise = null;
    }
  }
}

export async function ensureDashboardTables(): Promise<void> {
  if (dashboardTablesInitialized) {
    return;
  }

  if (dashboardTablesInitializationPromise) {
    await dashboardTablesInitializationPromise;
    return;
  }

  dashboardTablesInitializationPromise = createDashboardTables();

  try {
    await dashboardTablesInitializationPromise;
    dashboardTablesInitialized = true;
  } finally {
    if (!dashboardTablesInitialized) {
      dashboardTablesInitializationPromise = null;
    }
  }
}

async function createSpxBookingHistoryTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return; // Skip in memory mode
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spx_booking_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL DEFAULT 1,
      request_id BIGINT UNSIGNED NOT NULL,
      booking_id BIGINT UNSIGNED NULL,
      booking_name VARCHAR(255) NULL,
      agency_name VARCHAR(255) NULL,
      route VARCHAR(255) NOT NULL,
      origin VARCHAR(255) NULL,
      destination VARCHAR(255) NULL,
      cost_type VARCHAR(50) NULL,
      trip_type VARCHAR(50) NULL,
      shift_type VARCHAR(50) NULL,
      vehicle_type VARCHAR(50) NULL,
      standby_datetime VARCHAR(50) NULL,
      acceptance_status INT NULL,
      assignment_status INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY spx_booking_history_team_request_uidx (team_id, request_id),
      KEY booking_id_idx (booking_id),
      KEY created_at_idx (created_at),
      KEY spx_booking_history_team_created_idx (team_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "spx_booking_history", "team_id", "ALTER TABLE spx_booking_history ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id");
  await dropMysqlIndexIfExists(pool, "spx_booking_history", "request_id_idx");
  await ensureMysqlIndex(pool, "spx_booking_history", "spx_booking_history_team_request_uidx", "ALTER TABLE spx_booking_history ADD UNIQUE KEY spx_booking_history_team_request_uidx (team_id, request_id)");
  await ensureMysqlIndex(pool, "spx_booking_history", "spx_booking_history_team_created_idx", "ALTER TABLE spx_booking_history ADD INDEX spx_booking_history_team_created_idx (team_id, created_at)");
}

async function createDashboardTables(): Promise<void> {
  const pool = getPool();
  if (!pool) return; // Skip in memory mode

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      enabled INT NOT NULL DEFAULT 1,
      spx_cookie VARCHAR(4000) NOT NULL DEFAULT '',
      spx_device_id VARCHAR(1000) NOT NULL DEFAULT '',
      line_group_id VARCHAR(255) NOT NULL DEFAULT '',
      auto_accept_success_line_group_id VARCHAR(255) NOT NULL DEFAULT '',
      auto_accept_failure_line_group_id VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY teams_enabled_idx (enabled),
      KEY teams_name_idx (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "teams", "auto_accept_success_line_group_id", "ALTER TABLE teams ADD COLUMN auto_accept_success_line_group_id VARCHAR(255) NOT NULL DEFAULT '' AFTER line_group_id");
  await ensureMysqlColumn(pool, "teams", "auto_accept_failure_line_group_id", "ALTER TABLE teams ADD COLUMN auto_accept_failure_line_group_id VARCHAR(255) NOT NULL DEFAULT '' AFTER auto_accept_success_line_group_id");
  await pool.query(`
    UPDATE teams
    SET
      auto_accept_success_line_group_id = line_group_id,
      auto_accept_failure_line_group_id = line_group_id
    WHERE line_group_id <> ''
      AND auto_accept_success_line_group_id = ''
      AND auto_accept_failure_line_group_id = ''
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'viewer',
      team_id INT NULL,
      auth_version INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const [roleColumnRows] = await pool!.query("SHOW COLUMNS FROM users LIKE 'role'");
  if ((roleColumnRows as unknown[]).length === 0) {
    await pool!.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'viewer' AFTER password_hash");
  }

  const [teamIdColumnRows] = await pool!.query("SHOW COLUMNS FROM users LIKE 'team_id'");
  if ((teamIdColumnRows as unknown[]).length === 0) {
    await pool!.query("ALTER TABLE users ADD COLUMN team_id INT NULL AFTER role");
  }
  await ensureMysqlIndex(pool, "users", "users_team_id_idx", "ALTER TABLE users ADD INDEX users_team_id_idx (team_id)");

  const [authVersionColumnRows] = await pool!.query("SHOW COLUMNS FROM users LIKE 'auth_version'");
  if ((authVersionColumnRows as unknown[]).length === 0) {
    await pool!.query("ALTER TABLE users ADD COLUMN auth_version INT NOT NULL DEFAULT 0 AFTER role");
  }

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      team_id INT NULL,
      actor_user_id INT NULL,
      actor_team_id INT NULL,
      target_team_id INT NULL,
      username VARCHAR(50) NOT NULL,
      action VARCHAR(100) NOT NULL,
      details VARCHAR(1000) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "audit_logs", "team_id", "ALTER TABLE audit_logs ADD COLUMN team_id INT NULL AFTER id");
  await ensureMysqlColumn(pool, "audit_logs", "actor_user_id", "ALTER TABLE audit_logs ADD COLUMN actor_user_id INT NULL AFTER team_id");
  await ensureMysqlColumn(pool, "audit_logs", "actor_team_id", "ALTER TABLE audit_logs ADD COLUMN actor_team_id INT NULL AFTER actor_user_id");
  await ensureMysqlColumn(pool, "audit_logs", "target_team_id", "ALTER TABLE audit_logs ADD COLUMN target_team_id INT NULL AFTER actor_team_id");

  await ensureMysqlIndex(pool, "audit_logs", "audit_created_at_idx", "ALTER TABLE audit_logs ADD INDEX audit_created_at_idx (created_at)");
  await ensureMysqlIndex(pool, "audit_logs", "audit_username_created_at_idx", "ALTER TABLE audit_logs ADD INDEX audit_username_created_at_idx (username, created_at)");
  await ensureMysqlIndex(pool, "audit_logs", "audit_action_created_at_idx", "ALTER TABLE audit_logs ADD INDEX audit_action_created_at_idx (action, created_at)");
  await ensureMysqlIndex(pool, "audit_logs", "audit_target_team_created_at_idx", "ALTER TABLE audit_logs ADD INDEX audit_target_team_created_at_idx (target_team_id, created_at)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS notify_rules (
      id VARCHAR(255) NOT NULL PRIMARY KEY,
      team_id INT NOT NULL DEFAULT 1,
      name VARCHAR(128) NOT NULL,
      origins VARCHAR(4000) NOT NULL DEFAULT '[]',
      destinations VARCHAR(4000) NOT NULL DEFAULT '[]',
      vehicle_types VARCHAR(4000) NOT NULL DEFAULT '[]',
      need INT NOT NULL DEFAULT 1,
      enabled INT NOT NULL DEFAULT 1,
      fulfilled INT NOT NULL DEFAULT 0,
      auto_accept INT NOT NULL DEFAULT 0,
      accept_all INT NOT NULL DEFAULT 0,
      auto_accepted INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "notify_rules", "team_id", "ALTER TABLE notify_rules ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id");
  await ensureMysqlColumn(pool, "notify_rules", "accept_all", "ALTER TABLE notify_rules ADD COLUMN accept_all INT NOT NULL DEFAULT 0 AFTER auto_accept");
  await ensureMysqlIndex(pool, "notify_rules", "notify_rules_team_id_idx", "ALTER TABLE notify_rules ADD INDEX notify_rules_team_id_idx (team_id)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS auto_accept_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL DEFAULT 1,
      rule_id VARCHAR(255) NOT NULL,
      rule_name VARCHAR(128) NOT NULL,
      booking_id BIGINT UNSIGNED NOT NULL,
      request_ids VARCHAR(2000) NOT NULL,
      accepted_count INT NOT NULL DEFAULT 0,
      origin VARCHAR(255) NOT NULL DEFAULT '',
      destination VARCHAR(255) NOT NULL DEFAULT '',
      vehicle_type VARCHAR(50) NOT NULL DEFAULT '',
      status VARCHAR(20) NOT NULL DEFAULT 'success',
      error_message VARCHAR(1000) NULL,
      failure_reason VARCHAR(64) NULL,
      trace_id VARCHAR(160) NULL,
      accept_rtt_ms INT NULL,
      list_age_ms INT NULL,
      verification_latency_ms INT NULL,
      verification_status VARCHAR(32) NULL,
      verified_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY aah_created_at_idx (created_at),
      KEY aah_rule_id_idx (rule_id),
      KEY aah_status_created_at_idx (status, created_at),
      KEY aah_team_created_at_idx (team_id, created_at),
      KEY aah_team_status_created_at_idx (team_id, status, created_at),
      KEY aah_team_reason_created_at_idx (team_id, failure_reason, created_at),
      KEY aah_trace_id_idx (trace_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "auto_accept_history", "team_id", "ALTER TABLE auto_accept_history ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id");
  await ensureMysqlColumn(pool, "auto_accept_history", "failure_reason", "ALTER TABLE auto_accept_history ADD COLUMN failure_reason VARCHAR(64) NULL AFTER error_message");
  await ensureMysqlColumn(pool, "auto_accept_history", "trace_id", "ALTER TABLE auto_accept_history ADD COLUMN trace_id VARCHAR(160) NULL AFTER failure_reason");
  await ensureMysqlColumn(pool, "auto_accept_history", "accept_rtt_ms", "ALTER TABLE auto_accept_history ADD COLUMN accept_rtt_ms INT NULL AFTER trace_id");
  await ensureMysqlColumn(pool, "auto_accept_history", "list_age_ms", "ALTER TABLE auto_accept_history ADD COLUMN list_age_ms INT NULL AFTER accept_rtt_ms");
  await ensureMysqlColumn(pool, "auto_accept_history", "verification_latency_ms", "ALTER TABLE auto_accept_history ADD COLUMN verification_latency_ms INT NULL AFTER list_age_ms");
  await ensureMysqlColumn(pool, "auto_accept_history", "verification_status", "ALTER TABLE auto_accept_history ADD COLUMN verification_status VARCHAR(32) NULL AFTER verification_latency_ms");
  await ensureMysqlColumn(pool, "auto_accept_history", "verified_at", "ALTER TABLE auto_accept_history ADD COLUMN verified_at DATETIME NULL AFTER verification_status");

  await ensureMysqlIndex(pool, "auto_accept_history", "aah_status_created_at_idx", "ALTER TABLE auto_accept_history ADD INDEX aah_status_created_at_idx (status, created_at)");
  await ensureMysqlIndex(pool, "auto_accept_history", "aah_team_created_at_idx", "ALTER TABLE auto_accept_history ADD INDEX aah_team_created_at_idx (team_id, created_at)");
  await ensureMysqlIndex(pool, "auto_accept_history", "aah_team_status_created_at_idx", "ALTER TABLE auto_accept_history ADD INDEX aah_team_status_created_at_idx (team_id, status, created_at)");
  await ensureMysqlIndex(pool, "auto_accept_history", "aah_team_reason_created_at_idx", "ALTER TABLE auto_accept_history ADD INDEX aah_team_reason_created_at_idx (team_id, failure_reason, created_at)");
  await ensureMysqlIndex(pool, "auto_accept_history", "aah_trace_id_idx", "ALTER TABLE auto_accept_history ADD INDEX aah_trace_id_idx (trace_id)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS line_bot_sessions (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      session_key VARCHAR(50) NOT NULL DEFAULT 'default',
      auth_token VARCHAR(2000) NOT NULL,
      device VARCHAR(50) NOT NULL DEFAULT 'IOSIPAD',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY lbs_session_key_idx (session_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS line_image_extractions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      sender_id VARCHAR(255) NOT NULL,
      image_path VARCHAR(1000) NOT NULL,
      date_text VARCHAR(100) NOT NULL,
      trip_number VARCHAR(100) NOT NULL DEFAULT '',
      driver_name VARCHAR(500) NOT NULL,
      agency_name VARCHAR(100) NOT NULL,
      vehicle_type VARCHAR(100) NOT NULL,
      route VARCHAR(255) NOT NULL,
      raw_text VARCHAR(4000) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY lie_created_at_idx (created_at),
      KEY lie_agency_created_at_idx (agency_name, created_at),
      KEY lie_trip_number_created_at_idx (trip_number, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const [tripNumberColumnRows] = await pool.query("SHOW COLUMNS FROM line_image_extractions LIKE 'trip_number'");
  if ((tripNumberColumnRows as unknown[]).length === 0) {
    await pool.query("ALTER TABLE line_image_extractions ADD COLUMN trip_number VARCHAR(100) NOT NULL DEFAULT '' AFTER date_text");
  }
  await ensureMysqlIndex(pool, "line_image_extractions", "lie_trip_number_created_at_idx", "ALTER TABLE line_image_extractions ADD INDEX lie_trip_number_created_at_idx (trip_number, created_at)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS notification_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      event_key VARCHAR(255) NOT NULL,
      schema_version INT NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      severity VARCHAR(32) NOT NULL,
      team_id INT NOT NULL,
      worker_node_id VARCHAR(120) NOT NULL,
      trace_id VARCHAR(160) NULL,
      subject_type VARCHAR(64) NOT NULL,
      subject_id VARCHAR(160) NOT NULL,
      payload_json TEXT NOT NULL,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY notification_events_event_key_uidx (event_key),
      KEY notification_events_team_received_idx (team_id, received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "notification_events", "trace_id", "ALTER TABLE notification_events ADD COLUMN trace_id VARCHAR(160) NULL AFTER worker_node_id");
  await ensureMysqlIndex(pool, "notification_events", "notification_events_event_key_uidx", "ALTER TABLE notification_events ADD UNIQUE KEY notification_events_event_key_uidx (event_key)");
  await ensureMysqlIndex(pool, "notification_events", "notification_events_team_received_idx", "ALTER TABLE notification_events ADD INDEX notification_events_team_received_idx (team_id, received_at)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      event_key VARCHAR(255) NOT NULL,
      team_id INT NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      target_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      severity VARCHAR(32) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      attempts INT NOT NULL DEFAULT 0,
      available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      locked_by VARCHAR(120) NULL,
      locked_until DATETIME NULL,
      sent_at DATETIME NULL,
      last_error VARCHAR(1000) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY notification_outbox_event_key_uidx (event_key),
      KEY notification_outbox_status_available_idx (status, available_at),
      KEY notification_outbox_team_created_idx (team_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "notification_outbox", "locked_by", "ALTER TABLE notification_outbox ADD COLUMN locked_by VARCHAR(120) NULL AFTER available_at");
  await ensureMysqlColumn(pool, "notification_outbox", "locked_until", "ALTER TABLE notification_outbox ADD COLUMN locked_until DATETIME NULL AFTER locked_by");
  await ensureMysqlColumn(pool, "notification_outbox", "sent_at", "ALTER TABLE notification_outbox ADD COLUMN sent_at DATETIME NULL AFTER locked_until");
  await ensureMysqlColumn(pool, "notification_outbox", "last_error", "ALTER TABLE notification_outbox ADD COLUMN last_error VARCHAR(1000) NULL AFTER sent_at");
  await ensureMysqlIndex(pool, "notification_outbox", "notification_outbox_event_key_uidx", "ALTER TABLE notification_outbox ADD UNIQUE KEY notification_outbox_event_key_uidx (event_key)");
  await ensureMysqlIndex(pool, "notification_outbox", "notification_outbox_status_available_idx", "ALTER TABLE notification_outbox ADD INDEX notification_outbox_status_available_idx (status, available_at)");
  await ensureMysqlIndex(pool, "notification_outbox", "notification_outbox_team_created_idx", "ALTER TABLE notification_outbox ADD INDEX notification_outbox_team_created_idx (team_id, created_at)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      outbox_id BIGINT UNSIGNED NOT NULL,
      delivery_attempt INT NOT NULL,
      provider VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      provider_message_id VARCHAR(255) NULL,
      error_message VARCHAR(1000) NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      KEY notification_deliveries_outbox_idx (outbox_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "notification_deliveries", "provider_message_id", "ALTER TABLE notification_deliveries ADD COLUMN provider_message_id VARCHAR(255) NULL AFTER status");
  await ensureMysqlColumn(pool, "notification_deliveries", "error_message", "ALTER TABLE notification_deliveries ADD COLUMN error_message VARCHAR(1000) NULL AFTER provider_message_id");
  await ensureMysqlColumn(pool, "notification_deliveries", "finished_at", "ALTER TABLE notification_deliveries ADD COLUMN finished_at DATETIME NULL AFTER started_at");
  await ensureMysqlIndex(pool, "notification_deliveries", "notification_deliveries_outbox_idx", "ALTER TABLE notification_deliveries ADD INDEX notification_deliveries_outbox_idx (outbox_id)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS runtime_nodes (
      node_id VARCHAR(120) NOT NULL PRIMARY KEY,
      role VARCHAR(32) NOT NULL,
      hostname VARCHAR(255) NULL,
      pid INT NULL,
      version VARCHAR(120) NULL,
      last_heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata_json TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY runtime_nodes_role_heartbeat_idx (role, last_heartbeat_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "runtime_nodes", "hostname", "ALTER TABLE runtime_nodes ADD COLUMN hostname VARCHAR(255) NULL AFTER role");
  await ensureMysqlColumn(pool, "runtime_nodes", "pid", "ALTER TABLE runtime_nodes ADD COLUMN pid INT NULL AFTER hostname");
  await ensureMysqlColumn(pool, "runtime_nodes", "version", "ALTER TABLE runtime_nodes ADD COLUMN version VARCHAR(120) NULL AFTER pid");
  await ensureMysqlColumn(pool, "runtime_nodes", "metadata_json", "ALTER TABLE runtime_nodes ADD COLUMN metadata_json TEXT NULL AFTER last_heartbeat_at");
  await ensureMysqlIndex(pool, "runtime_nodes", "runtime_nodes_role_heartbeat_idx", "ALTER TABLE runtime_nodes ADD INDEX runtime_nodes_role_heartbeat_idx (role, last_heartbeat_at)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS team_runtime_leases (
      team_id INT NOT NULL PRIMARY KEY,
      owner_node_id VARCHAR(120) NOT NULL,
      owner_role VARCHAR(32) NOT NULL,
      lease_token VARCHAR(80) NOT NULL,
      lease_expires_at DATETIME NOT NULL,
      heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(32) NOT NULL DEFAULT 'running',
      last_error VARCHAR(1000) NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY trl_owner_idx (owner_node_id),
      KEY trl_expires_idx (lease_expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "team_runtime_leases", "last_error", "ALTER TABLE team_runtime_leases ADD COLUMN last_error VARCHAR(1000) NULL AFTER status");
  await ensureMysqlIndex(pool, "team_runtime_leases", "trl_owner_idx", "ALTER TABLE team_runtime_leases ADD INDEX trl_owner_idx (owner_node_id)");
  await ensureMysqlIndex(pool, "team_runtime_leases", "trl_expires_idx", "ALTER TABLE team_runtime_leases ADD INDEX trl_expires_idx (lease_expires_at)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS team_runtime_desired_state (
      team_id INT NOT NULL PRIMARY KEY,
      desired_state VARCHAR(32) NOT NULL DEFAULT 'running',
      changed_by_user_id INT NULL,
      reason VARCHAR(1000) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "team_runtime_desired_state", "changed_by_user_id", "ALTER TABLE team_runtime_desired_state ADD COLUMN changed_by_user_id INT NULL AFTER desired_state");
  await ensureMysqlColumn(pool, "team_runtime_desired_state", "reason", "ALTER TABLE team_runtime_desired_state ADD COLUMN reason VARCHAR(1000) NULL AFTER changed_by_user_id");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS auto_accept_attempts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      trace_id VARCHAR(160) NOT NULL,
      team_id INT NOT NULL,
      worker_node_id VARCHAR(120) NOT NULL,
      booking_id BIGINT UNSIGNED NOT NULL,
      request_ids_json VARCHAR(2000) NOT NULL,
      rule_id VARCHAR(255) NULL,
      rule_name VARCHAR(128) NULL,
      accept_mode VARCHAR(32) NOT NULL,
      accept_started_at DATETIME NOT NULL,
      accept_finished_at DATETIME NULL,
      accept_rtt_ms INT NULL,
      spx_http_status INT NULL,
      spx_retcode INT NULL,
      spx_message VARCHAR(1000) NULL,
      raw_error VARCHAR(1000) NULL,
      ambiguous_accept INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY aaa_trace_uidx (trace_id),
      KEY aaa_team_booking_idx (team_id, booking_id),
      KEY aaa_worker_created_idx (worker_node_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "auto_accept_attempts", "rule_id", "ALTER TABLE auto_accept_attempts ADD COLUMN rule_id VARCHAR(255) NULL AFTER request_ids_json");
  await ensureMysqlColumn(pool, "auto_accept_attempts", "rule_name", "ALTER TABLE auto_accept_attempts ADD COLUMN rule_name VARCHAR(128) NULL AFTER rule_id");
  await ensureMysqlColumn(pool, "auto_accept_attempts", "accept_finished_at", "ALTER TABLE auto_accept_attempts ADD COLUMN accept_finished_at DATETIME NULL AFTER accept_started_at");
  await ensureMysqlColumn(pool, "auto_accept_attempts", "accept_rtt_ms", "ALTER TABLE auto_accept_attempts ADD COLUMN accept_rtt_ms INT NULL AFTER accept_finished_at");
  await ensureMysqlColumn(pool, "auto_accept_attempts", "spx_http_status", "ALTER TABLE auto_accept_attempts ADD COLUMN spx_http_status INT NULL AFTER accept_rtt_ms");
  await ensureMysqlColumn(pool, "auto_accept_attempts", "spx_retcode", "ALTER TABLE auto_accept_attempts ADD COLUMN spx_retcode INT NULL AFTER spx_http_status");
  await ensureMysqlColumn(pool, "auto_accept_attempts", "spx_message", "ALTER TABLE auto_accept_attempts ADD COLUMN spx_message VARCHAR(1000) NULL AFTER spx_retcode");
  await ensureMysqlColumn(pool, "auto_accept_attempts", "raw_error", "ALTER TABLE auto_accept_attempts ADD COLUMN raw_error VARCHAR(1000) NULL AFTER spx_message");
  await ensureMysqlIndex(pool, "auto_accept_attempts", "aaa_trace_uidx", "ALTER TABLE auto_accept_attempts ADD UNIQUE KEY aaa_trace_uidx (trace_id)");
  await ensureMysqlIndex(pool, "auto_accept_attempts", "aaa_team_booking_idx", "ALTER TABLE auto_accept_attempts ADD INDEX aaa_team_booking_idx (team_id, booking_id)");
  await ensureMysqlIndex(pool, "auto_accept_attempts", "aaa_worker_created_idx", "ALTER TABLE auto_accept_attempts ADD INDEX aaa_worker_created_idx (worker_node_id, created_at)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS auto_accept_results (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      booking_id BIGINT UNSIGNED NOT NULL,
      request_id BIGINT UNSIGNED NOT NULL,
      winning_attempt_trace_id VARCHAR(160) NULL,
      status VARCHAR(32) NOT NULL,
      reason_code VARCHAR(64) NOT NULL,
      evidence_json TEXT NULL,
      first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY aar_team_booking_request_uidx (team_id, booking_id, request_id),
      KEY aar_team_status_idx (team_id, status),
      KEY aar_trace_idx (winning_attempt_trace_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await ensureMysqlColumn(pool, "auto_accept_results", "winning_attempt_trace_id", "ALTER TABLE auto_accept_results ADD COLUMN winning_attempt_trace_id VARCHAR(160) NULL AFTER request_id");
  await ensureMysqlColumn(pool, "auto_accept_results", "evidence_json", "ALTER TABLE auto_accept_results ADD COLUMN evidence_json TEXT NULL AFTER reason_code");
  await ensureMysqlColumn(pool, "auto_accept_results", "resolved_at", "ALTER TABLE auto_accept_results ADD COLUMN resolved_at DATETIME NULL AFTER first_seen_at");
  await ensureMysqlIndex(pool, "auto_accept_results", "aar_team_booking_request_uidx", "ALTER TABLE auto_accept_results ADD UNIQUE KEY aar_team_booking_request_uidx (team_id, booking_id, request_id)");
  await ensureMysqlIndex(pool, "auto_accept_results", "aar_team_status_idx", "ALTER TABLE auto_accept_results ADD INDEX aar_team_status_idx (team_id, status)");
  await ensureMysqlIndex(pool, "auto_accept_results", "aar_trace_idx", "ALTER TABLE auto_accept_results ADD INDEX aar_trace_idx (winning_attempt_trace_id)");

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
      setting_value VARCHAR(4000) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

async function ensureMysqlIndex(pool: Pool, tableName: string, indexName: string, ddl: string): Promise<void> {
  const [rows] = await pool.query(
    "SELECT 1 FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1",
    [tableName, indexName]
  );
  if ((rows as unknown[]).length === 0) {
    await pool.query(ddl);
  }
}

async function ensureMysqlColumn(pool: Pool, tableName: string, columnName: string, ddl: string): Promise<void> {
  const [rows] = await pool.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1",
    [tableName, columnName]
  );
  if ((rows as unknown[]).length === 0) {
    await pool.query(ddl);
  }
}

async function dropMysqlIndexIfExists(pool: Pool, tableName: string, indexName: string): Promise<void> {
  const [rows] = await pool.query(
    "SELECT 1 FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1",
    [tableName, indexName]
  );
  if ((rows as unknown[]).length > 0) {
    await pool.query(`ALTER TABLE ${tableName} DROP INDEX ${indexName}`);
  }
}
