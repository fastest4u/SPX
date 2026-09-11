import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { teams } from "../src/db/schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expected = [
  ["spxEmail", "spx_email"],
  ["spxPassword", "spx_password"],
  ["spxAuthStatus", "spx_auth_status"],
  ["spxAuthError", "spx_auth_error"],
  ["spxAuthRetryAt", "spx_auth_retry_at"],
  ["spxAuthFailures", "spx_auth_failures"],
  ["spxSessionExpiresAt", "spx_session_expires_at"],
  ["spxLastLoginAt", "spx_last_login_at"],
  ["spxAuthEpoch", "spx_auth_epoch"],
  ["spxAuthLeaseToken", "spx_auth_lease_token"],
  ["spxAuthLeaseUntil", "spx_auth_lease_until"],
] as const;

resetMemoryDb();
const drizzleColumns = getTableColumns(teams) as Record<string, { name: string }>;
for (const [field, column] of expected) {
  assert.equal(drizzleColumns[field]?.name, column, `Drizzle mapping missing ${field}`);
}

const sqliteColumns = getRawMemoryDb().prepare("PRAGMA table_info(teams)").all() as Array<{
  name: string;
  notnull: number;
  dflt_value: string | null;
}>;
const sqliteByName = new Map(sqliteColumns.map((column) => [column.name, column]));
for (const [, column] of expected) {
  assert.ok(sqliteByName.has(column), `SQLite teams table missing ${column}`);
}
assert.equal(sqliteByName.get("spx_email")?.dflt_value, "''");
assert.equal(sqliteByName.get("spx_auth_status")?.dflt_value, "'manual'");
assert.equal(sqliteByName.get("spx_auth_failures")?.dflt_value, "0");
assert.equal(sqliteByName.get("spx_auth_epoch")?.dflt_value, "0");
assert.equal(sqliteByName.get("spx_password")?.notnull, 0);
assert.equal(sqliteByName.get("spx_auth_lease_token")?.notnull, 0);

const migration = readFileSync(resolve(root, "migrations", "040_add_team_provider_auth.sql"), "utf8");
const mysqlRuntime = readFileSync(resolve(root, "src", "db", "client.ts"), "utf8");
const verifier = readFileSync(resolve(root, "scripts", "schema-verify.mjs"), "utf8");
for (const [, column] of expected) {
  assert.match(migration, new RegExp(`\\b${column}\\b`, "i"), `migration missing ${column}`);
  assert.match(mysqlRuntime, new RegExp(`\\b${column}\\b`, "i"), `MySQL runtime DDL missing ${column}`);
  assert.match(verifier, new RegExp(`\\b${column}\\b`, "i"), `schema verifier missing ${column}`);
}

console.log("team-provider-auth-schema: schema representations are aligned");
