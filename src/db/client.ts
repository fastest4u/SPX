import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import { env } from "../config/env.js";
import * as schema from "./schema.js";
import { getMemoryDb, closeMemoryDb } from "./client-memory.js";

// Use any for DB type to allow both MySQL and SQLite Drizzle instances
// This is acceptable since both have the same API surface (select, insert, update, delete)
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
      UNIQUE KEY request_id_idx (request_id),
      KEY booking_id_idx (booking_id),
      KEY created_at_idx (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

async function createDashboardTables(): Promise<void> {
  const pool = getPool();
  if (!pool) return; // Skip in memory mode

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'viewer',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const [roleColumnRows] = await pool!.query("SHOW COLUMNS FROM users LIKE 'role'");
  if ((roleColumnRows as unknown[]).length === 0) {
    await pool!.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'viewer' AFTER password_hash");
  }

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      action VARCHAR(100) NOT NULL,
      details VARCHAR(1000) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await pool!.query(`
    CREATE TABLE IF NOT EXISTS notify_rules (
      id VARCHAR(255) NOT NULL PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      origins VARCHAR(4000) NOT NULL DEFAULT '[]',
      destinations VARCHAR(4000) NOT NULL DEFAULT '[]',
      vehicle_types VARCHAR(4000) NOT NULL DEFAULT '[]',
      need INT NOT NULL DEFAULT 1,
      enabled INT NOT NULL DEFAULT 1,
      fulfilled INT NOT NULL DEFAULT 0,
      auto_accept INT NOT NULL DEFAULT 0,
      auto_accepted INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}
