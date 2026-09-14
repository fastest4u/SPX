import assert from "node:assert/strict";

import {
  PRODUCTION_DB_TRANSITION_SERVICES,
  evaluateProductionDbTransitionEvidence,
  parseProductionDbTransitionArgs,
} from "../scripts/production-db-transition-evidence-check.mjs";

const H = (character: string): string => character.repeat(64);

const release = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${H("b")}`,
  releaseManifestSha256: H("c"),
  environment: "supervised-production",
  topology: "split",
  composeProject: "spx-production",
  operatorBundleSha256: H("d"),
  targetDescriptorSha256: H("e"),
  productionIdentityApprovalSha256: H("f"),
};

function validEvidence() {
  return {
    schemaVersion: 1,
    gate6Id: "gate6-prod-001",
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    composeProject: "spx-production",
    release,
    checkedAt: "2026-07-11T02:00:00.000Z",
    services: PRODUCTION_DB_TRANSITION_SERVICES.map((service, index) => ({
      service,
      principalSha256: H(String((index + 1) % 10)),
      positiveGrantProofSha256: H("1"),
      forbiddenGrantProofSha256: H("2"),
      runtimeCapabilitySha256: H("3"),
      runtimeIdentitySha256: H("4"),
      principalPrepared: true,
      switched: true,
      ready: true,
      legacyPrincipalValid: true,
      checkedAt: "2026-07-11T01:59:30.000Z",
    })),
    migrator: {
      verificationSha256: H("5"),
      runtimePrincipalMounted: false,
      checkedAt: "2026-07-11T01:59:35.000Z",
    },
    liveness: {
      monitorStatus: "green",
      monitorLeaseExpiresAt: "2026-07-11T02:00:20.000Z",
      supervisorStatus: "green",
      supervisorLeaseExpiresAt: "2026-07-11T02:00:20.000Z",
      continuousObservationSeconds: 1800,
      redSamples: 0,
    },
  };
}

async function main(): Promise<void> {
  assert.deepEqual(parseProductionDbTransitionArgs([
    "--supervised-production",
    "--dir=/var/lib/spx-production-rollout/evidence/db-transition",
  ]), {
    directory: "/var/lib/spx-production-rollout/evidence/db-transition",
    supervisedProduction: true,
  });
  assert.throws(() => parseProductionDbTransitionArgs([
    "--supervised-production",
    "--dir=/tmp/evidence",
  ]), /fixed approved path/i);
  const options = { now: new Date("2026-07-11T02:00:05.000Z") };
  assert.deepEqual(evaluateProductionDbTransitionEvidence(validEvidence(), release, options), {
    ok: true,
    failures: [],
  });
  const missing = validEvidence();
  missing.services.pop();
  assert.ok(evaluateProductionDbTransitionEvidence(missing, release, options).failures.includes("SERVICE_SET_INVALID"));
  const unsafe = validEvidence();
  unsafe.services[0].legacyPrincipalValid = false;
  assert.ok(evaluateProductionDbTransitionEvidence(unsafe, release, options).failures.includes("SERVICE_TRANSITION_INVALID"));
  const stale = validEvidence();
  stale.liveness.monitorLeaseExpiresAt = stale.checkedAt;
  assert.ok(evaluateProductionDbTransitionEvidence(stale, release, options).failures.includes("LIVENESS_INVALID"));
  console.log("production DB-transition evidence checker tests passed");
}

void main();
