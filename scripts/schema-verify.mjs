#!/usr/bin/env node
// schema-verify.mjs - read-only MySQL schema drift checker for SPX.
//
// This script reads DB connection settings from process.env or root .env,
// queries information_schema, and compares production tables with the current
// application schema contract. It never writes to the database and never prints
// secret values.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const EXPECTED_SCHEMA = {
  teams: {
    columns: {
      id: { type: "int", nullable: false, extraIncludes: ["auto_increment"] },
      name: { type: "varchar(100)", nullable: false },
      enabled: { type: "int", nullable: false, defaultIncludes: "1" },
      spx_cookie: { type: "varchar(4000)", nullable: false, defaultIncludes: "" },
      spx_device_id: { type: "varchar(1000)", nullable: false, defaultIncludes: "" },
      line_group_id: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      auto_accept_success_line_group_id: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      auto_accept_failure_line_group_id: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
      updated_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "teams_enabled_idx", unique: false, columns: ["enabled"] },
      { name: "teams_name_idx", unique: false, columns: ["name"] },
    ],
  },
  spx_booking_history: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      team_id: { type: "int", nullable: false, defaultIncludes: "1" },
      request_id: { type: "bigint unsigned", nullable: false },
      booking_id: { type: "bigint unsigned", nullable: true },
      booking_name: { type: "varchar(255)", nullable: true },
      agency_name: { type: "varchar(255)", nullable: true },
      route: { type: "varchar(255)", nullable: false },
      origin: { type: "varchar(255)", nullable: true },
      destination: { type: "varchar(255)", nullable: true },
      cost_type: { type: "varchar(50)", nullable: true },
      trip_type: { type: "varchar(50)", nullable: true },
      shift_type: { type: "varchar(50)", nullable: true },
      vehicle_type: { type: "varchar(50)", nullable: true },
      standby_datetime: { type: "varchar(50)", nullable: true },
      acceptance_status: { type: "int", nullable: true },
      assignment_status: { type: "int", nullable: true },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "spx_booking_history_team_request_uidx", unique: true, columns: ["team_id", "request_id"] },
      { name: "booking_id_idx", unique: false, columns: ["booking_id"] },
      { name: "created_at_idx", unique: false, columns: ["created_at"] },
      { name: "spx_booking_history_team_created_idx", unique: false, columns: ["team_id", "created_at"] },
    ],
  },
  users: {
    columns: {
      id: { type: "int", nullable: false, extraIncludes: ["auto_increment"] },
      username: { type: "varchar(50)", nullable: false },
      password_hash: { type: "varchar(255)", nullable: false },
      role: { type: "varchar(20)", nullable: false, defaultIncludes: "viewer" },
      team_id: { type: "int", nullable: true },
      auth_version: { type: "int", nullable: false, defaultIncludes: "0" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { unique: true, columns: ["username"] },
      { name: "users_team_id_idx", unique: false, columns: ["team_id"] },
    ],
  },
  audit_logs: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      team_id: { type: "int", nullable: true },
      actor_user_id: { type: "int", nullable: true },
      actor_team_id: { type: "int", nullable: true },
      target_team_id: { type: "int", nullable: true },
      username: { type: "varchar(50)", nullable: false },
      action: { type: "varchar(100)", nullable: false },
      details: { type: "varchar(1000)", nullable: true },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "audit_created_at_idx", unique: false, columns: ["created_at"] },
      { name: "audit_username_created_at_idx", unique: false, columns: ["username", "created_at"] },
      { name: "audit_action_created_at_idx", unique: false, columns: ["action", "created_at"] },
      { name: "audit_target_team_created_at_idx", unique: false, columns: ["target_team_id", "created_at"] },
    ],
  },
  notify_rules: {
    columns: {
      id: { type: "varchar(255)", nullable: false },
      team_id: { type: "int", nullable: false, defaultIncludes: "1" },
      name: { type: "varchar(128)", nullable: false },
      origins: { type: "varchar(4000)", nullable: false, defaultIncludes: "[]" },
      destinations: { type: "varchar(4000)", nullable: false, defaultIncludes: "[]" },
      vehicle_types: { type: "varchar(4000)", nullable: false, defaultIncludes: "[]" },
      need: { type: "int", nullable: false, defaultIncludes: "1" },
      enabled: { type: "int", nullable: false, defaultIncludes: "1" },
      fulfilled: { type: "int", nullable: false, defaultIncludes: "0" },
      auto_accept: { type: "int", nullable: false, defaultIncludes: "0" },
      accept_all: { type: "int", nullable: false, defaultIncludes: "0" },
      auto_accepted: { type: "int", nullable: false, defaultIncludes: "0" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
      updated_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp", extraIncludes: ["on update"] },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "notify_rules_team_id_idx", unique: false, columns: ["team_id"] },
    ],
  },
  auto_accept_history: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      team_id: { type: "int", nullable: false, defaultIncludes: "1" },
      rule_id: { type: "varchar(255)", nullable: false },
      rule_name: { type: "varchar(128)", nullable: false },
      booking_id: { type: "bigint unsigned", nullable: false },
      request_ids: { type: "varchar(2000)", nullable: false },
      accepted_count: { type: "int", nullable: false, defaultIncludes: "0" },
      origin: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      destination: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      vehicle_type: { type: "varchar(50)", nullable: false, defaultIncludes: "" },
      status: { type: "varchar(20)", nullable: false, defaultIncludes: "success" },
      error_message: { type: "varchar(1000)", nullable: true },
      failure_reason: { type: "varchar(64)", nullable: true },
      trace_id: { type: "varchar(160)", nullable: true },
      accept_rtt_ms: { type: "int", nullable: true },
      list_age_ms: { type: "int", nullable: true },
      verification_latency_ms: { type: "int", nullable: true },
      verification_status: { type: "varchar(32)", nullable: true },
      verified_at: { type: "datetime", nullable: true },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "aah_created_at_idx", unique: false, columns: ["created_at"] },
      { name: "aah_rule_id_idx", unique: false, columns: ["rule_id"] },
      { name: "aah_status_created_at_idx", unique: false, columns: ["status", "created_at"] },
      { name: "aah_team_created_at_idx", unique: false, columns: ["team_id", "created_at"] },
      { name: "aah_team_status_created_at_idx", unique: false, columns: ["team_id", "status", "created_at"] },
      { name: "aah_team_reason_created_at_idx", unique: false, columns: ["team_id", "failure_reason", "created_at"] },
      { name: "aah_trace_id_idx", unique: false, columns: ["trace_id"] },
    ],
  },
  metrics_snapshots: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      team_id: { type: "int", nullable: false, defaultIncludes: "1" },
      uptime: { type: "int", nullable: false },
      total_requests: { type: "int", nullable: false, defaultIncludes: "0" },
      success_count: { type: "int", nullable: false, defaultIncludes: "0" },
      error_count: { type: "int", nullable: false, defaultIncludes: "0" },
      success_rate: { type: "varchar(10)", nullable: false, defaultIncludes: "0" },
      latency_avg: { type: "int", nullable: false, defaultIncludes: "0" },
      latency_p95: { type: "int", nullable: false, defaultIncludes: "0" },
      latency_p99: { type: "int", nullable: false, defaultIncludes: "0" },
      total_records_seen: { type: "int", nullable: false, defaultIncludes: "0" },
      changes_detected: { type: "int", nullable: false, defaultIncludes: "0" },
      trips_inserted: { type: "int", nullable: false, defaultIncludes: "0" },
      trips_skipped: { type: "int", nullable: false, defaultIncludes: "0" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "metrics_created_at_idx", unique: false, columns: ["created_at"] },
      { name: "metrics_team_created_at_idx", unique: false, columns: ["team_id", "created_at"] },
    ],
  },
  line_bot_sessions: {
    columns: {
      id: { type: "int", nullable: false, extraIncludes: ["auto_increment"] },
      session_key: { type: "varchar(50)", nullable: false, defaultIncludes: "default" },
      auth_token: { type: "varchar(2000)", nullable: false },
      device: { type: "varchar(50)", nullable: false, defaultIncludes: "IOSIPAD" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
      updated_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp", extraIncludes: ["on update"] },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "lbs_session_key_idx", unique: true, columns: ["session_key"] },
    ],
  },
  line_image_extractions: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      chat_id: { type: "varchar(255)", nullable: false },
      sender_id: { type: "varchar(255)", nullable: false },
      image_path: { type: "varchar(1000)", nullable: false },
      date_text: { type: "varchar(100)", nullable: false },
      trip_number: { type: "varchar(100)", nullable: false, defaultIncludes: "" },
      driver_name: { type: "varchar(500)", nullable: false },
      agency_name: { type: "varchar(100)", nullable: false },
      vehicle_type: { type: "varchar(100)", nullable: false },
      route: { type: "varchar(255)", nullable: false },
      raw_text: { type: "varchar(4000)", nullable: false },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "lie_created_at_idx", unique: false, columns: ["created_at"] },
      { name: "lie_agency_created_at_idx", unique: false, columns: ["agency_name", "created_at"] },
      { name: "lie_trip_number_created_at_idx", unique: false, columns: ["trip_number", "created_at"] },
    ],
  },
  app_settings: {
    columns: {
      setting_key: { type: "varchar(100)", nullable: false },
      setting_value: { type: "varchar(4000)", nullable: false, defaultIncludes: "" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
      updated_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp", extraIncludes: ["on update"] },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["setting_key"] },
    ],
  },
  schema_migrations: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      name: { type: "varchar(255)", nullable: false },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "schema_migrations_name_idx", unique: true, columns: ["name"] },
    ],
  },
  jwt_blacklist: {
    columns: {
      jti: { type: "varchar(64)", nullable: false },
      revoked_at: { type: "bigint", nullable: false },
      expires_at: { type: "bigint", nullable: false },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["jti"] },
      { name: "jwt_blacklist_expires_idx", unique: false, columns: ["expires_at"] },
    ],
  },
};

const APP_TABLE_PREFIXES = ["spx_", "line_", "auto_", "metrics_"];
const APP_TABLE_NAMES = new Set([
  "teams",
  "users",
  "audit_logs",
  "notify_rules",
  "app_settings",
  "schema_migrations",
  "jwt_blacklist",
]);

function isAppOwnedTable(tableName) {
  return APP_TABLE_NAMES.has(tableName) || APP_TABLE_PREFIXES.some((prefix) => tableName.startsWith(prefix));
}

function loadDotEnv() {
  const envFilePath = resolve(ROOT, ".env");
  if (!existsSync(envFilePath)) return;
  const lines = readFileSync(envFilePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function getDbConfig() {
  loadDotEnv();
  const missing = [];
  for (const key of ["DB_HOST", "DB_USERNAME", "DB_PASSWORD", "DB_NAME"]) {
    if (!process.env[key]) missing.push(key);
  }
  const port = Number(process.env.DB_PORT || "3306");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) missing.push("DB_PORT(valid integer)");
  if (missing.length > 0) {
    throw new Error(`Missing DB env values: ${missing.join(", ")}`);
  }
  if (process.env.DB_MODE === "memory") {
    throw new Error("DB_MODE=memory cannot verify a MySQL production schema");
  }
  return {
    host: process.env.DB_HOST,
    port,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: "utf8mb4",
    timezone: "+00:00",
    dateStrings: true,
  };
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[()]/g, "").trim();
}

function defaultsMatch(actualDefault, expectedIncludes) {
  if (expectedIncludes === undefined) return true;
  const actual = normalize(actualDefault);
  const expected = normalize(expectedIncludes);
  if (expected === "") return actual === "";
  return actual.includes(expected);
}

function columnsEqual(actualColumns, expectedColumns, tableName, problems) {
  const actualByName = new Map(actualColumns.map((column) => [column.column_name, column]));

  for (const [columnName, expected] of Object.entries(expectedColumns)) {
    const actual = actualByName.get(columnName);
    if (!actual) {
      problems.push(`${tableName}.${columnName}: missing column`);
      continue;
    }

    if (normalize(actual.column_type) !== normalize(expected.type)) {
      problems.push(`${tableName}.${columnName}: type ${actual.column_type} != ${expected.type}`);
    }

    const actualNullable = actual.is_nullable === "YES";
    if (actualNullable !== expected.nullable) {
      problems.push(`${tableName}.${columnName}: nullable ${actual.is_nullable} != ${expected.nullable ? "YES" : "NO"}`);
    }

    if (!defaultsMatch(actual.column_default, expected.defaultIncludes)) {
      problems.push(`${tableName}.${columnName}: default ${actual.column_default ?? "NULL"} does not include ${expected.defaultIncludes}`);
    }

    for (const needle of expected.extraIncludes ?? []) {
      if (!normalize(actual.extra).includes(normalize(needle))) {
        problems.push(`${tableName}.${columnName}: extra ${actual.extra || "(empty)"} missing ${needle}`);
      }
    }
  }

  for (const actual of actualColumns) {
    if (!expectedColumns[actual.column_name]) {
      problems.push(`${tableName}.${actual.column_name}: extra column not in source contract`);
    }
  }
}

function groupIndexes(indexRows) {
  const byName = new Map();
  for (const row of indexRows) {
    const key = row.index_name;
    if (!byName.has(key)) {
      byName.set(key, {
        name: row.index_name,
        unique: Number(row.non_unique) === 0,
        columns: [],
      });
    }
    byName.get(key).columns.push(row.column_name);
  }
  return [...byName.values()];
}

function indexesEqual(actualIndexes, expectedIndexes, tableName, problems) {
  for (const expected of expectedIndexes) {
    const match = actualIndexes.find((actual) => {
      if (expected.name && actual.name !== expected.name) return false;
      if (actual.unique !== expected.unique) return false;
      return actual.columns.join(",") === expected.columns.join(",");
    });

    if (!match) {
      const name = expected.name ? `${expected.name} ` : "";
      problems.push(`${tableName}: missing ${expected.unique ? "unique " : ""}index ${name}(${expected.columns.join(", ")})`);
    }
  }
}

async function main() {
  const dbConfig = getDbConfig();
  const expectedTables = Object.keys(EXPECTED_SCHEMA);
  const connection = await mysql.createConnection(dbConfig);

  try {
    const [allTableRows] = await connection.execute(
      `SELECT
         table_name AS table_name,
         engine AS engine,
         table_collation AS table_collation
       FROM information_schema.tables
        WHERE table_schema = ?
        ORDER BY table_name`,
      [dbConfig.database],
    );
    const tableRows = allTableRows.filter((row) => expectedTables.includes(row.table_name));

    const [columnRows] = await connection.execute(
      `SELECT
         table_name AS table_name,
         column_name AS column_name,
         column_type AS column_type,
         is_nullable AS is_nullable,
         column_default AS column_default,
         extra AS extra
       FROM information_schema.columns
       WHERE table_schema = ?
         AND table_name IN (${expectedTables.map(() => "?").join(",")})
       ORDER BY table_name, ordinal_position`,
      [dbConfig.database, ...expectedTables],
    );

    const [indexRows] = await connection.execute(
      `SELECT
         table_name AS table_name,
         index_name AS index_name,
         non_unique AS non_unique,
         seq_in_index AS seq_in_index,
         column_name AS column_name
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND table_name IN (${expectedTables.map(() => "?").join(",")})
       ORDER BY table_name, index_name, seq_in_index`,
      [dbConfig.database, ...expectedTables],
    );

    const tableNames = new Set(tableRows.map((row) => row.table_name));
    const columnsByTable = new Map();
    for (const row of columnRows) {
      if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, []);
      columnsByTable.get(row.table_name).push(row);
    }

    const indexesByTable = new Map();
    for (const row of indexRows) {
      if (!indexesByTable.has(row.table_name)) indexesByTable.set(row.table_name, []);
      indexesByTable.get(row.table_name).push(row);
    }

    const problems = [];
    for (const [tableName, expected] of Object.entries(EXPECTED_SCHEMA)) {
      if (!tableNames.has(tableName)) {
        problems.push(`${tableName}: missing table`);
        continue;
      }
      columnsEqual(columnsByTable.get(tableName) ?? [], expected.columns, tableName, problems);
      indexesEqual(groupIndexes(indexesByTable.get(tableName) ?? []), expected.indexes, tableName, problems);
    }

    const observedExtraTables = allTableRows
      .map((row) => row.table_name)
      .filter((name) => isAppOwnedTable(name))
      .filter((name) => !EXPECTED_SCHEMA[name]);

    console.log("");
    console.log("SPX Schema Verification (read-only)");
    console.log(`Database: ${dbConfig.database}`);
    console.log(`Expected tables: ${expectedTables.length}`);
    console.log(`Observed expected tables: ${tableRows.length}`);
    console.log("-".repeat(60));

    for (const row of tableRows) {
      const columnCount = (columnsByTable.get(row.table_name) ?? []).length;
      const indexCount = groupIndexes(indexesByTable.get(row.table_name) ?? []).length;
      console.log(`${row.table_name}: ${columnCount} columns, ${indexCount} indexes, ${row.engine || "unknown"} / ${row.table_collation || "unknown"}`);
    }

    if (observedExtraTables.length > 0) {
      console.log("");
      console.log(`Extra matched tables ignored: ${observedExtraTables.join(", ")}`);
    }

    if (problems.length > 0) {
      console.log("");
      console.log(`Schema drift detected (${problems.length}):`);
      for (const problem of problems) console.log(`  - ${problem}`);
      process.exit(2);
    }

    console.log("");
    console.log("Result: schema matches the source contract.");
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
