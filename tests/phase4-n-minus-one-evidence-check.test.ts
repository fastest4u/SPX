import assert from "node:assert/strict";

import {
  REQUIRED_N_MINUS_ONE_ACTION_IDS,
  evaluateNMinusOneEvidence,
  parseNMinusOneEvidenceArgs,
} from "../scripts/phase4-n-minus-one-evidence-check.mjs";

const roles = [
  "web-api",
  "notification-service",
  "line-service",
  "ocr-service",
  "worker-ifn-split",
  "worker-ptwl-split",
];
const H = (value: string) => value.repeat(64).slice(0, 64);
const roleEvidence = roles.map((role) => ({
  role,
  usesDatabase: role !== "ocr-service",
  dbCredentialPresent: role !== "ocr-service",
  connectAttempts: role === "ocr-service" ? 0 : 1,
  representativeReadPassed: role === "ocr-service" ? false : true,
  representativeWritePassed: role === "ocr-service" ? false : true,
  transactionRolledBack: role === "ocr-service" ? false : true,
  fixtureHashUnchanged: true,
  fixtureRowCountUnchanged: true,
  ddlStatements: 0,
  providerCalls: 0,
  backgroundLoops: 0,
  liveClaims: 0,
  localBoundaryPassed: role === "ocr-service",
}));

const valid = {
  releaseEnvironment: "staging",
  runtimeEnvironment: "staging",
  drillMode: "staging-n-minus-one",
  composeProject: "spx-staging",
  candidateSha: "a".repeat(40),
  candidateImageDigest: `sha256:${H("b")}`,
  nMinusOneSha: "c".repeat(40),
  nMinusOneImageDigest: `sha256:${H("d")}`,
  candidateManifestSha256: H("e"),
  nMinusOneManifestSha256: H("f"),
  targetDescriptorValid: true,
  operatorBundleValid: true,
  a3HostIdentityMatches: true,
  stagingRunIdExact: true,
  approvalEnvelopeExact: true,
  guardContinuous: true,
  watchdogContinuous: true,
  baselineIdentityExact: true,
  productionChanged: false,
  productionReadyThroughout: true,
  migrationChecksumsValid: true,
  currentSchema: 37,
  candidateSchemaRange: { min: 35, max: 37 },
  nMinusOneSchemaRange: { min: 34, max: 37 },
  signedRollbackEligibleRoles: roles,
  contractRoles: roles,
  probeInvocations: roles,
  roles: roleEvidence,
  fixtureDrift: 0,
  providerCalls: 0,
  backgroundLoops: 0,
  liveClaims: 0,
  timestamps: {
    preflight: "2026-07-11T00:00:00.000Z",
    start: "2026-07-11T00:01:00.000Z",
    verify: "2026-07-11T00:02:00.000Z",
    rollbackForward: "2026-07-11T00:03:00.000Z",
    stop: "2026-07-11T00:04:00.000Z",
  },
  actionJournal: {
    headSha256: H("1"),
    required: REQUIRED_N_MINUS_ONE_ACTION_IDS.map((actionId) => ({
      actionId,
      status: "succeeded",
      occurrences: 1,
    })),
    pending: 0,
    ambiguous: 0,
    replayed: 0,
  },
};

assert.deepEqual(evaluateNMinusOneEvidence(valid), { ok: true, failures: [] });
assert.equal(
  evaluateNMinusOneEvidence({
    ...valid,
    roles: valid.roles.filter((item) => item.role !== "line-service"),
  }).ok,
  false,
);
assert.equal(
  evaluateNMinusOneEvidence({
    ...valid,
    roles: valid.roles.map((item) =>
      item.role === "web-api" ? { ...item, transactionRolledBack: false } : item,
    ),
  }).ok,
  false,
);
assert.deepEqual(
  evaluateNMinusOneEvidence({ ...valid, productionChanged: true }).failures,
  ["PRODUCTION_NON_INTERFERENCE_INVALID"],
);
assert.deepEqual(
  evaluateNMinusOneEvidence({
    ...valid,
    roles: valid.roles.map((item) =>
      item.role === "ocr-service" ? { ...item, dbCredentialPresent: true } : item,
    ),
  }).failures,
  ["N_MINUS_ONE_ROLE_EVIDENCE_INVALID"],
);
assert.deepEqual(
  parseNMinusOneEvidenceArgs([
    "--dir=/var/lib/spx-staging-rollout/evidence/phase4-n-minus-one-staging",
  ]),
  { directory: "/var/lib/spx-staging-rollout/evidence/phase4-n-minus-one-staging" },
);
assert.throws(() => parseNMinusOneEvidenceArgs(["--dir=/tmp/n1"]), /fixed|directory/i);

console.log("Phase 4 N-1 evidence checker tests passed");
