import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { DEDICATED_N_MINUS_ONE_PROBE_TABLE } from "../src/scripts/phase4-n-minus-one-role-probe.js";

const migrationName = "037_create_n_minus_one_probe_fixtures.sql";
const migrationPath = `migrations/${migrationName}`;
const sqlBytes = readFileSync(migrationPath);
const sql = sqlBytes.toString("utf8");
const sha256 = createHash("sha256").update(sqlBytes).digest("hex");
const released = JSON.parse(readFileSync("migrations/released-checksums.json", "utf8")) as Record<string, string>;
const classification = JSON.parse(readFileSync("deploy/migration-classification.json", "utf8")) as {
  migrations: Record<string, { sha256: string; class: string }>;
};
const grants = JSON.parse(readFileSync("deploy/db-grants.json", "utf8")) as {
  roles: Record<
    string,
    {
      composePrincipalEnv: string;
      tables: Record<string, string[]>;
      columns: Record<string, Record<string, string[]>>;
      schemaPrivileges: string[];
    }
  >;
};

assert.equal(DEDICATED_N_MINUS_ONE_PROBE_TABLE, "spx_n_minus_one_probe_fixtures");
assert.match(sql, /^CREATE TABLE IF NOT EXISTS spx_n_minus_one_probe_fixtures\s*\(/);
assert.match(sql, /probe_role VARCHAR\(64\) NOT NULL/);
assert.match(sql, /probe_value BIGINT UNSIGNED NOT NULL/);
assert.match(sql, /PRIMARY KEY \(probe_role\)/);
assert.equal((sql.match(/\bCREATE TABLE\b/g) ?? []).length, 1);
assert.equal((sql.match(/\bINSERT(?: IGNORE)? INTO\b/g) ?? []).length, 1);
assert.match(sql, /INSERT IGNORE INTO spx_n_minus_one_probe_fixtures/);
assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE)\b/i);

const dbRoles = [
  ["web-api", "SPX_DB_USERNAME_WEB_API"],
  ["notification-service", "SPX_DB_USERNAME_NOTIFICATION_SERVICE"],
  ["line-service", "SPX_DB_USERNAME_LINE_SERVICE"],
  ["worker-ifn-split", "SPX_DB_USERNAME_WORKER_IFN_SPLIT"],
  ["worker-ptwl-split", "SPX_DB_USERNAME_WORKER_PTWL_SPLIT"],
] as const;
for (const [role, principalEnv] of dbRoles) {
  assert.match(sql, new RegExp(`\\('${role}',\\s*[0-9]+\\)`));
  assert.equal(grants.roles[role]?.composePrincipalEnv, principalEnv);
  assert.deepEqual(grants.roles[role]?.tables[DEDICATED_N_MINUS_ONE_PROBE_TABLE], ["SELECT"]);
  assert.deepEqual(grants.roles[role]?.columns[DEDICATED_N_MINUS_ONE_PROBE_TABLE], {
    UPDATE: ["probe_value"],
  });
  assert.deepEqual(grants.roles[role]?.schemaPrivileges, []);
}
assert.doesNotMatch(sql, /ocr-service/);
for (const [role, contract] of Object.entries(grants.roles)) {
  if (dbRoles.some(([allowed]) => allowed === role)) continue;
  assert.equal(contract.tables[DEDICATED_N_MINUS_ONE_PROBE_TABLE], undefined, `${role} table grant`);
  assert.equal(contract.columns[DEDICATED_N_MINUS_ONE_PROBE_TABLE], undefined, `${role} column grant`);
}
assert.equal("ocr-service" in grants.roles, false);

for (const businessTable of [
  "teams",
  "app_settings",
  "notification_outbox",
  "line_image_extractions",
  "auto_accept_jobs",
  "spx_booking_history",
]) {
  assert.doesNotMatch(sql, new RegExp(`\\b${businessTable}\\b`, "i"));
}

assert.equal(released[migrationName], sha256);
assert.deepEqual(classification.migrations[migrationName], { sha256, class: "expand" });
assert.deepEqual(Object.keys(released), Object.keys(classification.migrations));
assert.ok(Math.max(...Object.keys(released).map((name) => Number(name.slice(0, 3)))) >= 37);
for (const [name, digest] of Object.entries(released)) {
  assert.equal(classification.migrations[name]?.sha256, digest, `${name} classification digest`);
  assert.equal(createHash("sha256").update(readFileSync(`migrations/${name}`)).digest("hex"), digest, `${name} installed bytes`);
}

console.log("Phase 4 N-1 fixture migration tests passed");
