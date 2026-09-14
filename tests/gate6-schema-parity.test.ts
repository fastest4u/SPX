import assert from "node:assert/strict";

import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { gate6ControlPlaneMigrationSql } from "../src/db/migration-sql.js";
import {
  gate6Actions,
  gate6EnvironmentSlots,
  gate6FaultPermits,
  gate6Runs,
} from "../src/db/schema.js";

resetMemoryDb();
const sqlite = getRawMemoryDb();
for (const table of [
  "gate6_environment_slots",
  "gate6_runs",
  "gate6_actions",
  "gate6_fault_permits",
]) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  assert.ok(columns.length > 0, `${table} must exist in memory schema`);
  assert.match(gate6ControlPlaneMigrationSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
}
assert.ok(gate6EnvironmentSlots);
assert.ok(gate6Runs);
assert.ok(gate6Actions);
assert.ok(gate6FaultPermits);
assert.doesNotThrow(() => sqlite.prepare("SELECT * FROM operational_gate6_terminal_evidence").all());

console.log("Gate 6 schema parity tests passed");
