import assert from "node:assert/strict";

import {
  runtimeSchemaMutationsAllowed,
  verifyReleasedMigrationRows,
  type RuntimeReleasedMigration,
} from "../src/db/runtime-schema-readiness.js";

const released: RuntimeReleasedMigration[] = [
  { name: "000_create_schema_migrations_v2.sql", sha256: "a".repeat(64) },
  { name: "034_reconcile_rolling_baseline.sql", sha256: "b".repeat(64) },
];

assert.equal(runtimeSchemaMutationsAllowed("production"), false);
assert.equal(runtimeSchemaMutationsAllowed("test"), true);
assert.equal(runtimeSchemaMutationsAllowed("development"), true);

assert.doesNotThrow(() => verifyReleasedMigrationRows(released, [
  {
    name: released[0].name,
    checksum_sha256: released[0].sha256,
    status: "applied",
  },
  {
    name: released[1].name,
    checksum_sha256: released[1].sha256,
    status: "applied",
  },
]));

for (const rows of [
  [],
  [{ name: released[0].name, checksum_sha256: released[0].sha256, status: "applied" }],
  [
    { name: released[0].name, checksum_sha256: released[0].sha256, status: "applied" },
    { name: released[1].name, checksum_sha256: "c".repeat(64), status: "applied" },
  ],
  [
    { name: released[0].name, checksum_sha256: released[0].sha256, status: "applied" },
    { name: released[1].name, checksum_sha256: released[1].sha256, status: "failed" },
  ],
]) {
  assert.throws(
    () => verifyReleasedMigrationRows(released, rows),
    /runtime-schema-not-ready/,
  );
}

console.log("runtime-schema-readiness: exact released migration history verified");
