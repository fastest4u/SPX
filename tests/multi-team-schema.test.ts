import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

const schema = read("src/db/schema.ts");
const mysqlDdl = `${read("src/db/client.ts")}\n${read("src/repositories/metrics-repository.ts")}`;
const sqliteDdl = read("src/db/client-memory.ts");
const migration = read("migrations/018_multi_team_runtime.sql");

for (const source of [schema, mysqlDdl, sqliteDdl, migration]) {
  assert.match(source, /teams/i, "teams table must exist in schema, DDL, and migration");
  assert.match(source, /team[_A-Za-z]*id|team_id/i, "team id must exist in schema, DDL, and migration");
}

assert.match(schema, /uniqueIndex\([^)]*\)\.on\(table\.teamId,\s*table\.requestId\)|unique\([^)]*teamId[^)]*requestId|unique\([^)]*team_id[^)]*request_id/i, "Drizzle schema must express team-scoped request uniqueness");
assert.match(migration, /team_id[^\n]+request_id|request_id[^\n]+team_id/i, "migration must replace request-only uniqueness with team/request uniqueness");
assert.doesNotMatch(schema, /COOKIE\?:|DEVICE_ID\?:|LINE_USER_ID\?:/, "frontend/global settings should stop treating team credentials as global settings after this plan is complete");

console.log("multi-team-schema: team schema invariants verified");
