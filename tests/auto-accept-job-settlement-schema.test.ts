import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { autoAcceptJobSettlementsMigrationSql } from "../src/db/migration-sql.js";
import { autoAcceptJobSettlements } from "../src/db/schema.js";

const expectedColumns = [
  "id",
  "settlement_key",
  "job_id",
  "team_id",
  "booking_id",
  "request_id",
  "rule_id",
  "settlement_step",
  "side_effect_id",
  "metadata_json",
  "created_at",
  "completed_at",
] as const;

const expectedIndexes = [
  "aajs_settlement_key_uidx",
  "aajs_job_step_uidx",
  "aajs_team_step_completed_idx",
] as const;

const expectedIndexColumns: Record<(typeof expectedIndexes)[number], { unique: boolean; columns: string[] }> = {
  aajs_settlement_key_uidx: { unique: true, columns: ["settlement_key"] },
  aajs_job_step_uidx: { unique: true, columns: ["job_id", "settlement_step"] },
  aajs_team_step_completed_idx: { unique: false, columns: ["team_id", "settlement_step", "completed_at"] },
};

function assertCreateTable(sql: string, label: string): void {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_accept_job_settlements/i, `${label} should create auto_accept_job_settlements`);
  for (const column of expectedColumns) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"), `${label} should include ${column}`);
  }
  for (const indexName of expectedIndexes) {
    assert.match(sql, new RegExp(`\\b${indexName}\\b`, "i"), `${label} should include ${indexName}`);
  }
}

assert.equal(autoAcceptJobSettlements.settlementKey.name, "settlement_key");
assert.equal(autoAcceptJobSettlements.jobId.name, "job_id");
assert.equal(autoAcceptJobSettlements.settlementStep.name, "settlement_step");

resetMemoryDb();
const db = getRawMemoryDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
assert.equal(
  tables.some((table) => table.name === "auto_accept_job_settlements"),
  true,
  "memory schema should create auto_accept_job_settlements",
);

const memoryColumns = db.prepare("PRAGMA table_info(auto_accept_job_settlements)").all() as Array<{ name: string }>;
const memoryColumnNames = new Set(memoryColumns.map((column) => column.name));
for (const column of expectedColumns) {
  assert.equal(memoryColumnNames.has(column), true, `memory schema should include auto_accept_job_settlements.${column}`);
}

const memoryIndexes = db.prepare("PRAGMA index_list(auto_accept_job_settlements)").all() as Array<{ name: string; unique: number }>;
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

assertCreateTable(autoAcceptJobSettlementsMigrationSql, "migration-sql export");

const root = process.cwd();
const appendOnlySql = readFileSync(join(root, "migrations", "029_create_auto_accept_job_settlements.sql"), "utf8");
const runtimeMysqlDdl = readFileSync(join(root, "src", "db", "client.ts"), "utf8");

assertCreateTable(appendOnlySql, "append-only migration");
assertCreateTable(runtimeMysqlDdl, "runtime MySQL DDL");
