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
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY teams_enabled_idx (enabled),
      KEY teams_name_idx (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
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
