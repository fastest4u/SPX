process.env.DB_MODE = "memory";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { realtimeMetricsReadModelsMigrationSql } from "../src/db/migration-sql.js";
import { realtimeMetricsReadModels } from "../src/db/schema.js";

const tableName = "realtime_metrics_read_models";
const expectedColumns = [
  "team_id",
  "source_node_id",
  "snapshot_json",
  "emitted_at",
  "received_at",
  "updated_at",
] as const;
const receivedIndex = {
  name: "realtime_metrics_read_models_received_team_idx",
  columns: ["received_at", "team_id"],
} as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertCreateTable(sql: string, label: string): void {
  const statement = sql.match(
    /CREATE TABLE IF NOT EXISTS realtime_metrics_read_models\s*\([\s\S]*?\)\s*ENGINE=InnoDB[^;]*;/i,
  )?.[0];
  assert.ok(statement, `${label} should create ${tableName}`);
  for (const column of expectedColumns) {
    assert.match(statement, new RegExp(`\\b${column}\\b`, "i"), `${label} should include ${column}`);
  }
  assert.match(statement, /snapshot_json\s+JSON\s+NOT\s+NULL/i, `${label} should store a validated JSON snapshot`);
  for (const timestampColumn of ["emitted_at", "received_at", "updated_at"]) {
    assert.match(statement, new RegExp(`${timestampColumn}\\s+DATETIME\\(3\\)`, "i"));
  }
  assert.match(statement, /PRIMARY KEY\s*\(\s*team_id\s*\)/i, `${label} should key one latest row per team`);
  assert.match(
    statement,
    /realtime_metrics_read_models_received_team_idx\s*\(\s*received_at\s*,\s*team_id\s*\)/i,
    `${label} should index freshness reads`,
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
  if (/\bALTER\s+TABLE\b/i.test(executableSql)) problems.push("top-level ALTER TABLE");
  if (/\bDELIMITER\b/i.test(executableSql)) problems.push("DELIMITER");
  if (/\bPROCEDURE\b/i.test(executableSql)) problems.push("stored PROCEDURE");
  if (/\b(?:BEGIN|END)\b/i.test(executableSql)) problems.push("BEGIN/END block");
  return problems;
}

function guardedIndexPattern(): RegExp {
  const indexName = escapeRegExp(receivedIndex.name);
  return new RegExp([
    `SET\\s+@${indexName}_exists\\s*:=\\s*\\(`,
    "\\s*SELECT\\s+COUNT\\(\\*\\)",
    "\\s*FROM\\s+information_schema\\.STATISTICS",
    "\\s*WHERE\\s+TABLE_SCHEMA\\s*=\\s*DATABASE\\(\\)",
    `\\s+AND\\s+TABLE_NAME\\s*=\\s*'${tableName}'`,
    `\\s+AND\\s+INDEX_NAME\\s*=\\s*'${indexName}'`,
    "\\s*\\)\\s*;",
    `\\s*SET\\s+@${indexName}_sql\\s*:=\\s*IF\\(`,
    `\\s*@${indexName}_exists\\s*=\\s*0\\s*,`,
    `\\s*'ALTER\\s+TABLE\\s+${tableName}\\s+ADD\\s+INDEX\\s+${indexName}\\s*\\(\\s*received_at\\s*,\\s*team_id\\s*\\)'\\s*,`,
    "\\s*'SELECT\\s+1'",
    "\\s*\\)\\s*;",
    `\\s*PREPARE\\s+${indexName}_stmt\\s+FROM\\s+@${indexName}_sql\\s*;`,
    `\\s*EXECUTE\\s+${indexName}_stmt\\s*;`,
    `\\s*DEALLOCATE\\s+PREPARE\\s+${indexName}_stmt\\s*;`,
  ].join(""), "i");
}

assert.equal(realtimeMetricsReadModels.teamId.name, "team_id");
assert.equal(realtimeMetricsReadModels.sourceNodeId.name, "source_node_id");
assert.equal(realtimeMetricsReadModels.snapshotJson.name, "snapshot_json");

resetMemoryDb();
const db = getRawMemoryDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
assert.equal(tables.some((table) => table.name === tableName), true, `memory schema should create ${tableName}`);

const memoryColumns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; pk: number }>;
assert.deepEqual(memoryColumns.map((column) => column.name), [...expectedColumns]);
assert.equal(memoryColumns.find((column) => column.name === "team_id")?.pk, 1);

const memoryIndexes = db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string; unique: number }>;
const freshnessIndex = memoryIndexes.find((index) => index.name === receivedIndex.name);
assert.ok(freshnessIndex, `memory schema should include ${receivedIndex.name}`);
assert.equal(freshnessIndex.unique, 0);
const freshnessColumns = db.prepare(`PRAGMA index_info(${receivedIndex.name})`).all() as Array<{ name: string }>;
assert.deepEqual(freshnessColumns.map((column) => column.name), [...receivedIndex.columns]);

const root = process.cwd();
const appendOnlySql = readFileSync(join(root, "migrations", "031_create_realtime_metrics_read_models.sql"), "utf8");
const mysqlRuntimeDdl = readFileSync(join(root, "src", "db", "client.ts"), "utf8");
const schemaVerifierSource = readFileSync(join(root, "scripts", "schema-verify.mjs"), "utf8");

assertCreateTable(realtimeMetricsReadModelsMigrationSql, "migration-sql export");
assertCreateTable(appendOnlySql, "append-only migration");
assertCreateTable(mysqlRuntimeDdl, "runtime MySQL DDL");
assert.deepEqual(migrationSyntaxProblems(appendOnlySql), [], "migration 031 should avoid non-idempotent top-level DDL");
assert.match(appendOnlySql, guardedIndexPattern(), "migration 031 should conditionally repair its freshness index");
assert.match(
  schemaVerifierSource,
  /realtime_metrics_read_models:\s*\{[\s\S]*?source_node_id:\s*\{\s*type:\s*"varchar\(120\)"[\s\S]*?snapshot_json:\s*\{\s*type:\s*"json"[\s\S]*?received_at:\s*\{\s*type:\s*"datetime\(3\)"[\s\S]*?realtime_metrics_read_models_received_team_idx/s,
  "schema verifier should include the metrics read-model table and index",
);
