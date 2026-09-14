import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resetMemoryDb, getRawMemoryDb } from "../src/db/client-memory.js";
const table = "realtime_execution_metrics";
resetMemoryDb();
const columns = getRawMemoryDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{
  name: string;
  pk: number;
}>;
assert.deepEqual(
  columns.map((c) => c.name),
  [
    "team_id",
    "source_node_id",
    "generation",
    "started_at",
    "snapshot_json",
    "emitted_at",
    "received_at",
  ],
);
assert.deepEqual(
  columns.filter((c) => c.pk).map((c) => c.name),
  ["team_id", "source_node_id"],
);
const migration = readFileSync("migrations/044_create_realtime_execution_metrics.sql", "utf8");
assert.match(
  migration,
  /COLLATE=utf8mb4_bin/,
  "signed source/generation identities must be case-sensitive in MySQL as in SQLite",
);
const classifications = JSON.parse(readFileSync("deploy/migration-classification.json", "utf8"));
assert.deepEqual(
  classifications.migrations["044_create_realtime_execution_metrics.sql"],
  { sha256: createHash("sha256").update(migration).digest("hex"), class: "expand" },
  "new table must be classified for an eventual reviewed release",
);
const grants = JSON.parse(readFileSync("deploy/db-grants.json", "utf8"));
assert.deepEqual(grants.roles["realtime-service"].tables[table], [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
]);
assert.deepEqual(grants.roles["web-api"].tables[table], ["SELECT"]);
for (const role of ["auto-accept-ifn-phase3", "auto-accept-ptwl-phase3"])
  assert.deepEqual(grants.roles[role].tables[table], ["SELECT", "INSERT", "UPDATE", "DELETE"]);
for (const source of ["src/db/client.ts", "scripts/schema-verify.mjs"]) {
  const text = readFileSync(source, "utf8");
  assert.ok(text.includes(table));
  assert.ok(text.includes("realtime_execution_metrics_received_idx"));
}
console.log(
  "execution-metrics-schema: SQLite composite identity, additive migration hash/class, narrow grants and fresh-schema parity passed",
);
