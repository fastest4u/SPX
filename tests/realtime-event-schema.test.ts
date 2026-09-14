import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { realtimeEventsMigrationSql } from "../src/db/migration-sql.js";
import { realtimeEvents } from "../src/db/schema.js";

const expectedColumns = [
  "id",
  "event_id",
  "idempotency_key",
  "event_type",
  "payload_version",
  "envelope_version",
  "scope_kind",
  "team_id",
  "subject_type",
  "subject_id",
  "source_service",
  "source_node_id",
  "source_role",
  "trace_id",
  "replayable",
  "payload_json",
  "envelope_json",
  "emitted_at",
  "received_at",
  "created_at",
] as const;

const expectedIndexes = [
  "realtime_events_event_id_uidx",
  "realtime_events_idempotency_key_uidx",
  "realtime_events_scope_team_id_idx",
  "realtime_events_type_received_idx",
  "realtime_events_source_node_received_idx",
  "realtime_events_replayable_id_idx",
  "realtime_events_replay_scope_id_idx",
  "realtime_events_replay_created_id_idx",
] as const;

const historicalCreateTableIndexes = [
  "realtime_events_event_id_uidx",
  "realtime_events_idempotency_key_uidx",
  "realtime_events_scope_team_id_idx",
  "realtime_events_type_received_idx",
  "realtime_events_source_node_received_idx",
] as const;

const retentionIndexContracts = [
  { name: "realtime_events_replayable_id_idx", columns: ["replayable", "id"] },
  {
    name: "realtime_events_replay_scope_id_idx",
    columns: ["replayable", "scope_kind", "team_id", "id"],
  },
  {
    name: "realtime_events_replay_created_id_idx",
    columns: ["replayable", "created_at", "id"],
  },
] as const;

const retentionIndexes = retentionIndexContracts.map(({ name }) => name);

const expectedIndexColumns: Record<(typeof expectedIndexes)[number], { unique: boolean; columns: string[] }> = {
  realtime_events_event_id_uidx: { unique: true, columns: ["event_id"] },
  realtime_events_idempotency_key_uidx: { unique: true, columns: ["idempotency_key"] },
  realtime_events_scope_team_id_idx: { unique: false, columns: ["scope_kind", "team_id", "id"] },
  realtime_events_type_received_idx: { unique: false, columns: ["event_type", "received_at"] },
  realtime_events_source_node_received_idx: { unique: false, columns: ["source_node_id", "received_at"] },
  realtime_events_replayable_id_idx: { unique: false, columns: ["replayable", "id"] },
  realtime_events_replay_scope_id_idx: { unique: false, columns: ["replayable", "scope_kind", "team_id", "id"] },
  realtime_events_replay_created_id_idx: { unique: false, columns: ["replayable", "created_at", "id"] },
};

function assertIndexNames(sql: string, label: string, indexNames: readonly string[]): void {
  for (const indexName of indexNames) {
    assert.match(sql, new RegExp(`\\b${indexName}\\b`, "i"), `${label} should include ${indexName}`);
  }
}

function assertCreateTable(sql: string, label: string, indexNames = expectedIndexes): void {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS realtime_events/i, `${label} should create realtime_events`);
  for (const column of expectedColumns) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"), `${label} should include ${column}`);
  }
  assertIndexNames(sql, label, indexNames);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function guardedRetentionIndexPattern(contract: (typeof retentionIndexContracts)[number]): RegExp {
  const indexName = escapeRegExp(contract.name);
  const columns = contract.columns.map(escapeRegExp).join("\\s*,\\s*");

  return new RegExp(
    [
      `SET\\s+@${indexName}_exists\\s*:=\\s*\\(`,
      "\\s*SELECT\\s+COUNT\\(\\*\\)",
      "\\s*FROM\\s+information_schema\\.STATISTICS",
      "\\s*WHERE\\s+TABLE_SCHEMA\\s*=\\s*DATABASE\\(\\)",
      "\\s+AND\\s+TABLE_NAME\\s*=\\s*'realtime_events'",
      `\\s+AND\\s+INDEX_NAME\\s*=\\s*'${indexName}'`,
      "\\s*\\)\\s*;",
      `\\s*SET\\s+@${indexName}_sql\\s*:=\\s*IF\\(`,
      `\\s*@${indexName}_exists\\s*=\\s*0\\s*,`,
      `\\s*'ALTER\\s+TABLE\\s+realtime_events\\s+ADD\\s+INDEX\\s+${indexName}\\s*\\(\\s*${columns}\\s*\\)'\\s*,`,
      "\\s*'SELECT\\s+1'",
      "\\s*\\)\\s*;",
      `\\s*PREPARE\\s+${indexName}_stmt\\s+FROM\\s+@${indexName}_sql\\s*;`,
      `\\s*EXECUTE\\s+${indexName}_stmt\\s*;`,
      `\\s*DEALLOCATE\\s+PREPARE\\s+${indexName}_stmt\\s*;`,
    ].join(""),
    "i",
  );
}

function schemaVerifierIndexPattern(contract: (typeof retentionIndexContracts)[number]): RegExp {
  const indexName = escapeRegExp(contract.name);
  const columns = contract.columns.map((column) => `"${escapeRegExp(column)}"`).join("\\s*,\\s*");

  return new RegExp(
    `\\{\\s*name:\\s*"${indexName}"\\s*,\\s*unique:\\s*false\\s*,\\s*columns:\\s*\\[\\s*${columns}\\s*\\]\\s*\\}`,
  );
}

function stripSqlStringsAndComments(sql: string): string {
  const quotedOrComment =
    /'(?:\\[\s\S]|''|[^'])*'|"(?:\\[\s\S]|""|[^"])*"|`(?:``|[^`])*`|--(?=\s|$)[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\//g;
  return sql.replace(quotedOrComment, (match) => match.replace(/[^\r\n]/g, " "));
}

function migrationSyntaxProblems(sql: string): string[] {
  const executableSql = stripSqlStringsAndComments(sql);
  const problems: string[] = [];
  if (/\bALTER\s+TABLE\b/i.test(executableSql)) {
    problems.push("top-level ALTER TABLE");
  }
  if (/\bDELIMITER\b/i.test(executableSql)) {
    problems.push("DELIMITER");
  }
  if (/\bPROCEDURE\b/i.test(executableSql)) {
    problems.push("stored PROCEDURE");
  }
  if (/\b(?:BEGIN|END)\b/i.test(executableSql)) {
    problems.push("BEGIN/END block");
  }
  return problems;
}

const unsafeMigrationSamples = [
  { label: "same-line ALTER TABLE", sql: "SELECT 1; ALTER TABLE realtime_events ADD INDEX unsafe_idx (id)", problem: "top-level ALTER TABLE" },
  { label: "DELIMITER", sql: "DELIMITER $$", problem: "DELIMITER" },
  { label: "stored procedure", sql: "CREATE PROCEDURE unsafe_proc() SELECT 1", problem: "stored PROCEDURE" },
  { label: "BEGIN block", sql: "BEGIN; SELECT 1", problem: "BEGIN/END block" },
  { label: "END block", sql: "SELECT 1; END", problem: "BEGIN/END block" },
] as const;

for (const sample of unsafeMigrationSamples) {
  assert.equal(
    migrationSyntaxProblems(sample.sql).includes(sample.problem),
    true,
    `migration syntax guard should reject ${sample.label}`,
  );
}
assert.deepEqual(
  migrationSyntaxProblems("SET @ddl := 'ALTER TABLE realtime_events ADD INDEX safe_idx (id)'; SELECT 1"),
  [],
  "migration syntax guard should allow quoted dynamic ALTER TABLE",
);

assert.equal(realtimeEvents.eventId.name, "event_id");
assert.equal(realtimeEvents.idempotencyKey.name, "idempotency_key");
assert.equal(realtimeEvents.envelopeJson.name, "envelope_json");

resetMemoryDb();
const db = getRawMemoryDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
assert.equal(tables.some((table) => table.name === "realtime_events"), true, "memory schema should create realtime_events");

const memoryColumns = db.prepare("PRAGMA table_info(realtime_events)").all() as Array<{ name: string; type: string }>;
const memoryColumnNames = new Set(memoryColumns.map((column) => column.name));
for (const column of expectedColumns) {
  assert.equal(memoryColumnNames.has(column), true, `memory schema should include realtime_events.${column}`);
}

const memoryIndexes = db.prepare("PRAGMA index_list(realtime_events)").all() as Array<{ name: string; unique: number }>;
const memoryIndexesByName = new Map(memoryIndexes.map((index) => [index.name, index]));
for (const indexName of expectedIndexes) {
  const index = memoryIndexesByName.get(indexName);
  assert.ok(index, `memory schema should include ${indexName}`);
  const expectedIndex = expectedIndexColumns[indexName];
  assert.equal(Boolean(index.unique), expectedIndex.unique, `memory schema should match ${indexName} uniqueness`);
  const indexColumns = db
    .prepare(`PRAGMA index_info(${indexName})`)
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    indexColumns.map((column) => column.name),
    expectedIndex.columns,
    `memory schema should match ${indexName} column order`,
  );
}

assertCreateTable(realtimeEventsMigrationSql, "migration-sql export");

const root = process.cwd();
const historicalAppendOnlySql = readFileSync(join(root, "migrations", "028_create_realtime_events.sql"), "utf8");
const retentionAppendOnlySql = readFileSync(join(root, "migrations", "030_add_realtime_event_retention_indexes.sql"), "utf8");
const schemaVerifierSource = readFileSync(join(root, "scripts", "schema-verify.mjs"), "utf8");
const drizzleSchemaSource = readFileSync(join(root, "src", "db", "schema.ts"), "utf8");
const runtimeMysqlDdl = readFileSync(join(root, "src", "db", "client.ts"), "utf8");

assertIndexNames(drizzleSchemaSource, "Drizzle schema", expectedIndexes);
assertCreateTable(historicalAppendOnlySql, "historical append-only migration", historicalCreateTableIndexes);
assertIndexNames(retentionAppendOnlySql, "retention append-only migration", retentionIndexes);
assertCreateTable(runtimeMysqlDdl, "runtime MySQL DDL");

const retentionContractProblems: string[] = [];
retentionContractProblems.push(...migrationSyntaxProblems(retentionAppendOnlySql));
for (const contract of retentionIndexContracts) {
  if (!guardedRetentionIndexPattern(contract).test(retentionAppendOnlySql)) {
    retentionContractProblems.push(`migration 030 must guard ${contract.name} with its complete prepared-statement sequence`);
  }
  if (!schemaVerifierIndexPattern(contract).test(schemaVerifierSource)) {
    retentionContractProblems.push(`schema verifier must declare non-unique ${contract.name} with ordered columns`);
  }
}
assert.deepEqual(retentionContractProblems, [], "retention index safety contract violations");
