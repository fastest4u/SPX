import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  inspectOnlineAlterStatements,
  verifyOnlineDdlEvidence,
} from "../scripts/release-install-migration-check.mjs";

const H = (character: string): string => character.repeat(64);
assert.equal(verifyOnlineDdlEvidence({
  migration: "035_create_auto_accept_publication_controls.sql",
  migrationSha256: H("a"),
  tableSizeBucket: "10m-100m",
  algorithm: "INPLACE",
  lock: "NONE",
  implicitFallback: false,
  durationMs: 5_000,
  maximumDurationMs: 30_000,
  latencyBudgetPassed: true,
  ioBudgetPassed: true,
  connectionBudgetPassed: true,
  rehearsalMysqlVersion: "8.4.0",
}).ok, true);
assert.throws(() => verifyOnlineDdlEvidence({
  migration: "035_create_auto_accept_publication_controls.sql",
  migrationSha256: H("a"),
  tableSizeBucket: "10m-100m",
  algorithm: "COPY",
  lock: "SHARED",
  implicitFallback: true,
  durationMs: 5_000,
  maximumDurationMs: 30_000,
  latencyBudgetPassed: true,
  ioBudgetPassed: true,
  connectionBudgetPassed: true,
  rehearsalMysqlVersion: "8.4.0",
}), /online DDL/i);
const migration035 = readFileSync(new URL("../migrations/035_create_auto_accept_publication_controls.sql", import.meta.url), "utf8");
assert.deepEqual(inspectOnlineAlterStatements(migration035), [{ algorithm: "INPLACE", lock: "NONE" }]);
assert.throws(
  () => inspectOnlineAlterStatements("ALTER TABLE example ADD COLUMN value INT;"),
  /online DDL/i,
);

console.log("protected install online DDL tests passed");
