import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { verifyProductionBackupRestoreEvidence } from "../scripts/production-backup-restore-evidence.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";

const H = (character: string): string => character.repeat(64);
function quiescenceObservation(phase: string, observedAt: string) {
  const core = {
    phase,
    observedAt,
    hostLockState: "absent",
    gate6DatabaseSlotState: "absent",
  };
  return {
    observedAt,
    hostLockState: core.hostLockState,
    gate6DatabaseSlotState: core.gate6DatabaseSlotState,
    observationSha256: sha256Canonical(core),
  };
}
const producer = {
  repository: "fastest4u/SPX",
  environment: "production",
  workflow: ".github/workflows/trusted-production-backup-restore.yml",
  workflowSha: "e".repeat(40),
  workflowFileSha256: H("f"),
};
const validCore = {
  schemaVersion: 1,
  releaseEnvironment: "production",
  operationId: "018f3f68-8b9b-7f62-9d1a-ef8c9c748001",
  candidateSha: "a".repeat(40),
  releaseManifestSha256: H("b"),
  targetDescriptorSha256: H("c"),
  databaseFingerprint: `sha256:${H("d")}`,
  backupSha256: H("e"),
  encryptionMetadataSha256: H("f"),
  encrypted: true,
  fingerprintCapturedAt: "2026-07-16T00:02:00.000Z",
  createdAt: "2026-07-16T00:03:00.000Z",
  beforeDdl: true,
  isolatedRestore: {
    environment: "isolated",
    databaseFingerprint: `sha256:${H("1")}`,
    productionRoutesPresent: false,
    providerCredentialsPresent: false,
    backgroundServicesPresent: false,
    sharedWritableVolumesPresent: false,
    restoredSchemaSha256: H("2"),
    invariantDefinitionsSha256: H("3"),
    invariantResultsSha256: H("4"),
    rowCountDigestSha256: H("5"),
    teardownProven: true,
    destroyedAt: "2026-07-16T00:08:00.000Z",
  },
  quiescence: {
    beforeCapture: quiescenceObservation("before-capture", "2026-07-16T00:01:00.000Z"),
    afterTeardown: quiescenceObservation("after-teardown", "2026-07-16T00:09:00.000Z"),
  },
  rpoMinutes: 1,
  rtoMinutes: 6,
  verifiedAt: "2026-07-16T00:09:00.000Z",
  producer,
};
const validSignature = {
  schemaVersion: 1,
  algorithm: "kms-sha256",
  keyId: "spx-production-backup-evidence-v1",
  subjectSha256: sha256Canonical(validCore),
  signatureBase64: Buffer.from("signed production backup evidence").toString("base64"),
  signedAt: "2026-07-16T00:10:00.000Z",
};
const valid = {
  ...validCore,
  signatureSha256: sha256Canonical(validSignature),
};
const expected = {
  candidateSha: valid.candidateSha,
  releaseManifestSha256: valid.releaseManifestSha256,
  targetDescriptorSha256: valid.targetDescriptorSha256,
  databaseFingerprint: valid.databaseFingerprint,
  evidenceSigningKeyId: validSignature.keyId,
  invariantDefinitionsSha256: H("3"),
  producer,
  maximumAgeMinutes: 30,
  maximumRpoMinutes: 5,
  maximumRtoMinutes: 20,
  now: new Date("2026-07-16T00:12:00.000Z"),
};

const result = verifyProductionBackupRestoreEvidence(valid, validSignature, expected);
assert.deepEqual(Object.keys(valid.producer).sort(), [
  "environment",
  "repository",
  "workflow",
  "workflowFileSha256",
  "workflowSha",
]);
assert.deepEqual(result, {
  ok: true,
  evidenceSha256: sha256Canonical(valid),
  backupSha256: valid.backupSha256,
  verifiedAt: valid.verifiedAt,
});

function rejects(
  evidence: Record<string, unknown>,
  signature: Record<string, unknown>,
  expectedRecord: Record<string, unknown>,
  pattern: RegExp,
) {
  assert.throws(
    () => verifyProductionBackupRestoreEvidence(evidence, signature, expectedRecord),
    pattern,
  );
}

rejects({ ...valid, unexpected: true }, validSignature, expected, /exact keys/i);
rejects(
  {
    ...valid,
    isolatedRestore: { ...valid.isolatedRestore, rawSql: "SELECT COUNT(*) FROM users" },
  },
  validSignature,
  expected,
  /exact keys/i,
);
rejects(
  {
    ...valid,
    isolatedRestore: { ...valid.isolatedRestore, tableCounts: { users: 42 } },
  },
  validSignature,
  expected,
  /exact keys/i,
);
rejects(valid, { ...validSignature, subjectSha256: H("0") }, expected, /subject/i);
rejects({ ...valid, signatureSha256: H("0") }, validSignature, expected, /signature.*hash/i);
rejects({ ...valid, candidateSha: "0".repeat(40) }, validSignature, expected, /binding/i);
rejects({ ...valid, releaseManifestSha256: H("0") }, validSignature, expected, /binding/i);
rejects({ ...valid, targetDescriptorSha256: H("0") }, validSignature, expected, /binding/i);
rejects(
  {
    ...valid,
    isolatedRestore: {
      ...valid.isolatedRestore,
      databaseFingerprint: valid.databaseFingerprint,
    },
  },
  validSignature,
  expected,
  /isolated restore/i,
);
rejects(
  {
    ...valid,
    isolatedRestore: { ...valid.isolatedRestore, teardownProven: false },
  },
  validSignature,
  expected,
  /teardown|isolated restore/i,
);
rejects(
  {
    ...valid,
    quiescence: {
      ...valid.quiescence,
      afterTeardown: { ...valid.quiescence.afterTeardown, hostLockState: "closing" },
    },
  },
  validSignature,
  expected,
  /quiescent/i,
);
rejects(
  {
    ...valid,
    quiescence: {
      ...valid.quiescence,
      beforeCapture: {
        ...valid.quiescence.beforeCapture,
        observationSha256: H("0"),
      },
    },
  },
  validSignature,
  expected,
  /quiescence.*hash|observation.*hash/i,
);
rejects(
  {
    ...valid,
    quiescence: {
      beforeCapture: valid.quiescence.afterTeardown,
      afterTeardown: valid.quiescence.beforeCapture,
    },
  },
  validSignature,
  expected,
  /quiescence.*hash|observation.*hash/i,
);
rejects({ ...valid, beforeDdl: false }, validSignature, expected, /before DDL/i);
rejects({ ...valid, rpoMinutes: 6 }, validSignature, expected, /RPO\/RTO/i);
rejects({ ...valid, rtoMinutes: 21 }, validSignature, expected, /RPO\/RTO/i);
rejects(
  valid,
  validSignature,
  {
    ...expected,
    now: new Date("2026-07-16T01:00:00.000Z"),
  },
  /stale/i,
);
rejects(
  valid,
  {
    ...validSignature,
    signatureBase64: Buffer.from("password=supersecret123").toString("base64"),
  },
  expected,
  /secret/i,
);
rejects(
  valid,
  validSignature,
  {
    ...expected,
    producer: { ...producer, workflowSha: "0".repeat(40) },
  },
  /producer/i,
);
rejects(
  valid,
  validSignature,
  {
    ...expected,
    maximumRpoMinutes: Number.NaN,
  },
  /policy/i,
);
rejects(
  valid,
  validSignature,
  {
    ...expected,
    maximumRtoMinutes: undefined,
  },
  /policy/i,
);
rejects(
  valid,
  {
    ...validSignature,
    signedAt: "2026-07-16T00:07:00.000Z",
  },
  expected,
  /signature.*time/i,
);
rejects(
  valid,
  {
    ...validSignature,
    signedAt: "2026-07-16T00:13:00.000Z",
  },
  expected,
  /signature.*future|future.*signature/i,
);

const schema = JSON.parse(
  readFileSync(
    new URL("../deploy/production-backup-restore-evidence.schema.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(schema.additionalProperties, false);
assert.deepEqual([...schema.required].sort(), Object.keys(valid).sort());
assert.deepEqual([...schema.properties.producer.required].sort(), Object.keys(producer).sort());
assert.deepEqual(
  [...schema.properties.isolatedRestore.required].sort(),
  Object.keys(valid.isolatedRestore).sort(),
);
assert.deepEqual(
  [...schema.properties.quiescence.required].sort(),
  Object.keys(valid.quiescence).sort(),
);
assert.equal(canonicalJson(JSON.parse(JSON.stringify(valid))), canonicalJson(valid));

console.log("production backup restore evidence tests passed");
