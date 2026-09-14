import assert from "node:assert/strict";

import {
  REQUIRED_GATE5_ACTION_IDS,
  REQUIRED_PRODUCTION_PHASE4_ACTION_IDS,
  evaluatePhase4Evidence,
  parsePhase4EvidenceArgs,
} from "../scripts/phase4-rollout-evidence-check.mjs";

const H = (value: string) => value.repeat(64).slice(0, 64);
const terminal = (actionIds: readonly string[]) =>
  actionIds.map((actionId) => ({ actionId, status: "succeeded", occurrences: 1 }));

const staging = {
  releaseEnvironment: "staging",
  runtimeEnvironment: "staging",
  drillMode: "staging",
  composeProject: "spx-staging",
  release: { valid: true, candidateExact: true },
  targetDescriptor: { valid: true, environment: "staging", project: "spx-staging" },
  operatorBundle: { valid: true, installedExact: true },
  binding: {
    stagingRunIdExact: true,
    approvalEnvelopeExact: true,
    actionIndexExact: true,
    databaseFingerprintExact: true,
  },
  host: { a3HostIdentityMatches: true, productionHostUnchanged: true },
  guard: {
    sameInstanceAsTask10AndGate4: true,
    heartbeatFreshThroughout: true,
    watchdogFreshThroughout: true,
    continuityGapMs: 0,
  },
  runtime: { baselineLeaseOwnerExact: true, identitiesExact: true, databaseRoutingExact: true },
  migration: { checksumsValid: true, schemaCompatible: true },
  singleton: { firstReady: true, competingOwnerRejected: true, ownerCount: 1 },
  baseline: { localWatermark: 100, webReady: true, productionReady: true },
  routed: { routingWatermark: 110, producersRemote: true, webRemote: true, streamsRemote: true },
  replay: { resumedAtOrAfter: 110, raceDuplicates: 0 },
  pressure: { retentionOk: true, backpressureOk: true, slowClientResynced: true },
  proxyTls: { bufferingDisabled: true, cursorPreserved: true, upstreamIdentityVerified: true },
  dbFault: {
    stagingRealtimeUnavailable: true,
    targetedReaderDegraded: true,
    directDbClientsHealthy: true,
    stagingWebReady: true,
    workerAlive: true,
    productionReady: true,
  },
  recovered: { realtimeReady: true, cursorAtOrAfter: 110 },
  rollback: { localWatermark: 110, webReady: true, forwardRouteRestored: true },
  nMinusOne: {
    bundleValid: true,
    allRollbackEligibleRolesCovered: true,
    sideEffects: 0,
    fixtureDrift: 0,
  },
  cleanup: { allStagingStopped: true, guardClosed: true, watchdogClosed: true },
  actionJournal: {
    headSha256: H("c"),
    required: terminal(REQUIRED_GATE5_ACTION_IDS),
    pending: 0,
    ambiguous: 0,
    replayed: 0,
  },
};

assert.deepEqual(evaluatePhase4Evidence(staging), { ok: true, failures: [] });
assert.deepEqual(
  evaluatePhase4Evidence({
    ...staging,
    actionJournal: { ...staging.actionJournal, required: terminal(REQUIRED_GATE5_ACTION_IDS.slice(1)) },
  }).failures,
  ["GATE5_ACTION_LEDGER_INVALID"],
);
assert.deepEqual(
  evaluatePhase4Evidence({ ...staging, guard: { ...staging.guard, continuityGapMs: 1 } }).failures,
  ["GUARD_CONTINUITY_INVALID"],
);
assert.deepEqual(
  evaluatePhase4Evidence({
    ...staging,
    nMinusOne: { ...staging.nMinusOne, sideEffects: 1 },
  }).failures,
  ["N_MINUS_ONE_EVIDENCE_INVALID"],
);

const production = {
  releaseEnvironment: "production",
  runtimeEnvironment: "production",
  drillMode: "supervised-production",
  composeProject: "spx-production",
  release: { valid: true, candidateExact: true },
  targetDescriptor: { valid: true, environment: "production", project: "spx-production" },
  operatorBundle: { valid: true, installedExact: true },
  phase4Approval: { valid: true, fresh: true, distinct: true, reused: false },
  stagingBundleSha256: H("a"),
  nMinusOneBundleSha256: H("b"),
  predecessorStageCheckerSha256: H("d"),
  migration: { checksumsValid: true, schemaCompatible: true, expandOnly: true, contractMigration: false },
  singleton: { ownerCount: 1, ready: true },
  routed: { incremental: true, routingWatermark: 110, finalRouteApproved: true },
  replay: { resumedAtOrAfter: 110, raceDuplicates: 0 },
  rollback: { localWatermark: 110, catchupComplete: true, finalRouteApproved: true },
  productionDbFault: { attempted: false, count: 0 },
  actionLedger: {
    headSha256: H("e"),
    required: terminal(REQUIRED_PRODUCTION_PHASE4_ACTION_IDS),
    pending: 0,
    ambiguous: 0,
    replayed: 0,
  },
};

assert.deepEqual(evaluatePhase4Evidence(production), { ok: true, failures: [] });
assert.equal(
  evaluatePhase4Evidence({ ...production, productionDbFault: { attempted: true, count: 1 } }).ok,
  false,
);
assert.equal(evaluatePhase4Evidence({ ...production, releaseEnvironment: "supervised-production" }).ok, false);
assert.equal(evaluatePhase4Evidence({ ...production, runtimeEnvironment: "staging" }).ok, false);
assert.deepEqual(
  evaluatePhase4Evidence({
    ...production,
    phase4Approval: { ...production.phase4Approval, reused: true },
  }).failures,
  ["PHASE4_PRODUCTION_APPROVAL_INVALID"],
);
assert.deepEqual(
  evaluatePhase4Evidence({
    ...production,
    migration: { ...production.migration, contractMigration: true },
  }).failures,
  ["PRODUCTION_MIGRATION_NOT_EXPAND_ONLY"],
);

assert.deepEqual(
  parsePhase4EvidenceArgs(["--dir=/var/lib/spx-staging-rollout/evidence/phase4-staging"]),
  { mode: "staging", directory: "/var/lib/spx-staging-rollout/evidence/phase4-staging" },
);
assert.deepEqual(
  parsePhase4EvidenceArgs([
    "--supervised-production",
    "--dir=/var/lib/spx-production-rollout/evidence/phase4-production",
  ]),
  {
    mode: "supervised-production",
    directory: "/var/lib/spx-production-rollout/evidence/phase4-production",
  },
);
assert.throws(
  () => parsePhase4EvidenceArgs(["--supervised-production", "--dir=/tmp/evidence"]),
  /directory|fixed/i,
);

console.log("Phase 4 rollout evidence checker tests passed");
