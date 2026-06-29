import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import {
  notificationEventsMigrationSql,
  notificationOutboxMigrationSql,
  notificationDeliveriesMigrationSql,
  runtimeNodesMigrationSql,
  teamRuntimeLeasesMigrationSql,
  teamRuntimeDesiredStateMigrationSql,
  autoAcceptAttemptsMigrationSql,
  autoAcceptResultsMigrationSql,
} from "../src/db/migration-sql.js";

const distributedRuntimeTables = [
  "notification_events",
  "notification_outbox",
  "notification_deliveries",
  "runtime_nodes",
  "team_runtime_leases",
  "team_runtime_desired_state",
  "auto_accept_attempts",
  "auto_accept_results",
] as const;

type DistributedRuntimeTable = typeof distributedRuntimeTables[number];

const requiredColumnsByTable: Record<DistributedRuntimeTable, string[]> = {
  notification_events: ["event_key", "payload_json"],
  notification_outbox: ["message", "locked_by", "locked_until", "sent_at"],
  notification_deliveries: ["provider_message_id", "finished_at"],
  runtime_nodes: ["metadata_json", "last_heartbeat_at"],
  team_runtime_leases: ["lease_expires_at", "last_error"],
  team_runtime_desired_state: ["desired_state", "reason"],
  auto_accept_attempts: ["trace_id", "request_ids_json", "spx_retcode", "raw_error"],
  auto_accept_results: ["winning_attempt_trace_id", "evidence_json", "resolved_at"],
};

const textColumnsByTable: Partial<Record<DistributedRuntimeTable, string[]>> = {
  notification_events: ["event_key", "payload_json"],
  notification_outbox: ["message", "locked_by", "locked_until", "sent_at"],
  notification_deliveries: ["provider_message_id", "finished_at"],
  runtime_nodes: ["metadata_json", "last_heartbeat_at"],
  team_runtime_leases: ["lease_expires_at", "last_error"],
  team_runtime_desired_state: ["desired_state", "reason"],
  auto_accept_attempts: ["trace_id", "request_ids_json", "raw_error"],
  auto_accept_results: ["winning_attempt_trace_id", "evidence_json", "resolved_at"],
};

const requiredIndexesByTable: Partial<Record<DistributedRuntimeTable, string[]>> = {
  notification_events: ["notification_events_event_key_uidx", "notification_events_team_received_idx"],
  notification_outbox: [
    "notification_outbox_event_key_uidx",
    "notification_outbox_status_available_idx",
    "notification_outbox_team_created_idx",
  ],
  notification_deliveries: ["notification_deliveries_outbox_idx"],
  runtime_nodes: ["runtime_nodes_role_heartbeat_idx"],
  team_runtime_leases: ["trl_owner_idx", "trl_expires_idx"],
  auto_accept_attempts: ["aaa_trace_uidx", "aaa_team_booking_idx", "aaa_worker_created_idx"],
  auto_accept_results: ["aar_team_booking_request_uidx", "aar_team_status_idx", "aar_trace_idx"],
};

resetMemoryDb();
const db = getRawMemoryDb();

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
const names = new Set(tables.map((row) => row.name));

for (const table of distributedRuntimeTables) {
  assert.equal(names.has(table), true, `${table} should exist in memory schema`);
}

const migrationSql = [
  notificationEventsMigrationSql,
  notificationOutboxMigrationSql,
  notificationDeliveriesMigrationSql,
  runtimeNodesMigrationSql,
  teamRuntimeLeasesMigrationSql,
  teamRuntimeDesiredStateMigrationSql,
  autoAcceptAttemptsMigrationSql,
  autoAcceptResultsMigrationSql,
].join("\n");

const migrationFileName = "021_create_distributed_runtime_tables.sql";
const migrationsDir = join(process.cwd(), "migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort();

assert.equal(
  migrationFiles.includes(migrationFileName),
  true,
  `${migrationFileName} should be checked in for db:migrate`
);

const checkedInMigrationSql = readFileSync(join(migrationsDir, migrationFileName), "utf8");

for (const table of names) {
  if (table.startsWith("sqlite_")) continue;
  if ((distributedRuntimeTables as readonly string[]).includes(table)) {
    assert.match(migrationSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(checkedInMigrationSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
}

for (const table of distributedRuntimeTables) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
  const columnsByName = new Map(columns.map((column) => [column.name, column]));

  for (const column of requiredColumnsByTable[table]) {
    assert.equal(columnsByName.has(column), true, `${table}.${column} should exist in memory schema`);
  }

  for (const column of textColumnsByTable[table] ?? []) {
    assert.equal(
      columnsByName.get(column)?.type.toUpperCase(),
      "TEXT",
      `${table}.${column} should use TEXT in memory schema`
    );
  }

  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
  const indexNames = new Set(indexes.map((index) => index.name));

  for (const indexName of requiredIndexesByTable[table] ?? []) {
    assert.equal(indexNames.has(indexName), true, `${table}.${indexName} index should exist in memory schema`);
  }
}
