import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { evaluateProtectedMigrationInstall } from "../scripts/release-install-migration-check.mjs";

const H = (character: string): string => character.repeat(64);
const classification = {
  schemaVersion: 1,
  migrations: {
    "000_create_schema_migrations_v2.sql": { sha256: H("0"), class: "control-plane-bootstrap" },
    "035_create_auto_accept_publication_controls.sql": { sha256: H("3"), class: "expand" },
    "036_create_gate6_control_plane.sql": { sha256: H("6"), class: "control-plane" },
    "037_create_n_minus_one_probe_fixtures.sql": { sha256: H("7"), class: "expand" },
  },
};
const base = {
  classification,
  releasedChecksums: Object.fromEntries(
    Object.entries(classification.migrations).map(([name, value]) => [name, value.sha256]),
  ),
  releaseMigrationSetSha256: createHash("sha256")
    .update(
      Object.entries(classification.migrations)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}:${value.sha256}`)
        .join("\n"),
    )
    .digest("hex"),
  installedMigrations: ["000_create_schema_migrations_v2.sql"],
  expectedPending: [
    "035_create_auto_accept_publication_controls.sql",
    "036_create_gate6_control_plane.sql",
    "037_create_n_minus_one_probe_fixtures.sql",
  ],
  currentSchema: 34,
  targetSchema: 37,
  candidateSha: "a".repeat(40),
  rollbackSchemaRange: { min: 34, max: 37 },
  releaseEnvironment: "production",
  runtimeEnvironment: "production",
  drillMode: "supervised-production",
  composeProject: "spx-production",
  databaseFingerprint: `sha256:${H("f")}`,
  backupEvidence: {
    databaseFingerprint: `sha256:${H("f")}`,
    createdAt: "2026-07-11T01:00:00.000Z",
    verifiedAt: "2026-07-11T01:05:00.000Z",
    beforeDdl: true,
    encrypted: true,
    isolatedRestore: true,
    productionRoutesPresent: false,
    providerCredentialsPresent: false,
    teardownProven: true,
    rpoMinutes: 3,
    rtoMinutes: 10,
    evidenceSha256: H("b"),
  },
  maximumBackupAgeMinutes: 30,
  approvedRpoMinutes: 5,
  approvedRtoMinutes: 20,
  now: new Date("2026-07-11T01:10:00.000Z"),
};

assert.deepEqual(evaluateProtectedMigrationInstall(base), {
  ok: true,
  beforeSchema: 34,
  afterSchema: 37,
  installedMigrationSetSha256: base.releaseMigrationSetSha256,
  pendingReleasedMigrationCount: 0,
  backupRestoreEvidenceSha256: H("b"),
  rollbackSchemaCompatible: true,
  checksumSetExact: true,
});
assert.throws(
  () => evaluateProtectedMigrationInstall({ ...base, composeProject: "default" }),
  /production discriminator|Compose/i,
);
assert.throws(
  () =>
    evaluateProtectedMigrationInstall({
      ...base,
      classification: {
        ...classification,
        migrations: {
          ...classification.migrations,
          "036_create_gate6_control_plane.sql": { sha256: H("6"), class: "contract" },
        },
      },
    }),
  /contract/i,
);
assert.throws(
  () => evaluateProtectedMigrationInstall({ ...base, expectedPending: [base.expectedPending[0]] }),
  /pending migration set/i,
);
assert.throws(
  () => evaluateProtectedMigrationInstall({ ...base, releaseMigrationSetSha256: H("9") }),
  /migration set/i,
);

console.log("release install migration check tests passed");
