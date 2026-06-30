import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getTableName, is, Table } from "drizzle-orm";
import * as schema from "../src/db/schema.js";

/**
 * Schema single-source guard.
 *
 * The Drizzle schema in src/db/schema.ts is the source of truth used by every
 * query. Tables are physically created in three other places:
 *   • src/db/client.ts                    — MySQL runtime DDL (most tables)
 *   • src/repositories/metrics-repository.ts — MySQL runtime DDL (metrics_snapshots)
 *   • src/db/client-memory.ts             — SQLite DDL (memory mode mirror)
 *
 * If a table is added to the Drizzle schema but its CREATE TABLE is forgotten in
 * one of those runtimes, queries fail at runtime instead of at build time. This
 * test fails fast in CI when those definitions drift apart.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(testDir, "..", "src");
const rootDir = resolve(testDir, "..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(srcDir, relativePath), "utf8");
}

const mysqlDdl = readSource("db/client.ts") + "\n" + readSource("repositories/metrics-repository.ts");
const sqliteDdl = readSource("db/client-memory.ts");

function declaresTable(ddl: string, tableName: string): boolean {
  // Match `CREATE TABLE IF NOT EXISTS <name>` (and bare `CREATE TABLE <name>`),
  // tolerating optional backticks/quotes and arbitrary whitespace.
  const pattern = new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?[\`"']?${tableName}[\`"']?\\b`, "i");
  return pattern.test(ddl);
}

const drizzleTableNames: string[] = [];
for (const value of Object.values(schema) as unknown[]) {
  if (is(value, Table)) {
    drizzleTableNames.push(getTableName(value));
  }
}
drizzleTableNames.sort();

assert.ok(drizzleTableNames.length > 0, "expected Drizzle schema to export at least one table");

const missingInMysql: string[] = [];
const missingInSqlite: string[] = [];

for (const tableName of drizzleTableNames) {
  if (!declaresTable(mysqlDdl, tableName)) missingInMysql.push(tableName);
  if (!declaresTable(sqliteDdl, tableName)) missingInSqlite.push(tableName);
}

assert.deepEqual(
  missingInMysql,
  [],
  `Drizzle tables missing MySQL runtime DDL (src/db/client.ts or metrics-repository.ts): ${missingInMysql.join(", ")}`,
);
assert.deepEqual(
  missingInSqlite,
  [],
  `Drizzle tables missing SQLite DDL (src/db/client-memory.ts): ${missingInSqlite.join(", ")}`,
);

const baselineMigrationSql = readFileSync(resolve(rootDir, "migrations", "001_create_booking_requests.sql"), "utf8");
const teamTargetsMigrationSql = readFileSync(resolve(rootDir, "migrations", "026_team_notification_targets.sql"), "utf8");
for (const columnName of ["auto_accept_success_line_group_id", "auto_accept_failure_line_group_id"]) {
  if (baselineMigrationSql.includes(columnName)) {
    assert.match(
      teamTargetsMigrationSql,
      new RegExp(`column_name\\s*=\\s*'${columnName}'`, "i"),
      `026_team_notification_targets.sql must conditionally check ${columnName} because 001 already creates it`,
    );
  }
}

console.log(`schema-consistency: ${drizzleTableNames.length} tables verified across Drizzle, MySQL, and SQLite DDL`);
