/* eslint-disable @typescript-eslint/no-explicit-any -- hostile JSON fixtures deliberately exercise runtime-only shapes */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as checker from "../scripts/phase3-rollout-evidence-check.mjs";
import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_RUNTIME_SOURCE_IDS,
  phase3PartitionIdentity,
} from "../scripts/lib/phase3-staging-evidence.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import { STAGING_PROVISIONED_DB_ROLES } from "../scripts/lib/staging-action-capability.mjs";

const REQUIRED_ACTIONS = [
  "phase3-consumer-start-disabled",
  "phase3-legacy-lease-release",
  "phase3-poller-start",
  "phase3-publication-enable",
  "phase3-execution-enable",
  "phase3-publication-fence",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
];

const hash = (character: string): string => character.repeat(64);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const completedAt = (index: number): string =>
  new Date(Date.UTC(2026, 6, 10, 12, 0, index)).toISOString();

function stagingRelease() {
  return {
    candidateSha: "a".repeat(40),
    imageDigest: `sha256:${hash("b")}`,
    releaseManifestSha256: hash("c"),
    environment: "staging",
    topology: "phase3",
    composeProject: "spx-staging",
    stagingTargetDescriptorSha256: hash("d"),
    operatorBundleSha256: hash("e"),
    stagingApprovalEnvelopeSha256: hash("f"),
    actionJournalHeadSha256: hash("1"),
    stagingRunId: "staging-a3-20260710-01",
  };
}

function validStagingEvidence() {
  const actionMeasurements = REQUIRED_ACTIONS.map((actionId, index) => ({
    actionId,
    sha256: (index + 2).toString(16).repeat(64),
  }));
  return {
    schemaVersion: 2,
    release: stagingRelease(),
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    drillMode: "staging",
    composeProject: "spx-staging",
    stagingRunId: "staging-a3-20260710-01",
    approvalEnvelopeSha256: hash("f"),
    targetDescriptor: {
      signed: true,
      environment: "staging",
      composeProject: "spx-staging",
      sha256: hash("d"),
    },
    operatorBundle: { installed: true, sha256: hash("e") },
    host: { a3HostIdentityMatches: true },
    guard: {
      sameInstanceAsTask10: true,
      heartbeatFresh: true,
      watchdogFresh: true,
      continuityGapMs: 0,
    },
    baseline: {
      sideEffectsEnabled: false,
      consumerHealthy: true,
      legacyLeaseOwnerExact: true,
      runtimeIdentitiesExact: true,
    },
    cutover: {
      legacyLeaseReleased: true,
      producerStartedAfterConsumer: true,
      directPollerAccepts: 0,
    },
    runtime: { pollerHealthy: true, consumerHealthy: true },
    epoch: {
      teamId: 2,
      historyRetained: true,
      activeEpoch: "phase3-ifn-20260710",
      activeGeneration: 4,
      staleEpochActions: 0,
    },
    fence: {
      state: "fenced",
      fenceJobId: 42,
      ackJobId: 42,
      generation: 4,
      pollerNodeMatches: true,
      acknowledgedAt: completedAt(5),
    },
    drain: {
      queued: 0,
      liveClaims: 0,
      indeterminate: 0,
      unknown: 0,
      settlementPending: 0,
    },
    rollback: { inlineOwnerRestored: true },
    duplicates: {
      externalAttempts: 0,
      results: 0,
      history: 0,
      bookingHistory: 0,
      notifications: 0,
      budgetReservations: 0,
      settlements: 0,
    },
    artifactBindings: {
      journalSnapshotSha256: hash("2"),
      schemaObservationSha256: hash("3"),
      fenceObservationSha256: hash("4"),
      actionMeasurements,
      finalSources: {
        dbSha256: hash("5"),
        runtimeSha256: hash("6"),
        leaseContinuitySha256: hash("7"),
        capacitySha256: hash("8"),
        productionObserverSha256: hash("9"),
      },
    },
    actionJournal: {
      headSha256: hash("1"),
      snapshotSha256: hash("2"),
      required: REQUIRED_ACTIONS.map((actionId, index) => ({
        actionId,
        status: "succeeded",
        occurrences: 1,
        terminalRecordSha256: "abcdef01"[index].repeat(64),
        completedAt: completedAt(index),
        measurementSha256: actionMeasurements[index].sha256,
      })),
      pending: 0,
      ambiguous: 0,
      replayed: 0,
      extra: 0,
    },
    timeline: REQUIRED_ACTIONS.map((actionId, index) => ({
      actionId,
      completedAt: completedAt(index),
    })),
  };
}

const staging = checker.evaluatePhase3Evidence(validStagingEvidence());
assert.equal(staging.ok, true, staging.failures.join(","));

const wrongTopology = structuredClone(validStagingEvidence());
wrongTopology.release.topology = "split";
assert.equal(checker.evaluatePhase3Evidence(wrongTopology).ok, false);

const wrongTeam = structuredClone(validStagingEvidence());
wrongTeam.epoch.teamId = 3;
assert.equal(checker.evaluatePhase3Evidence(wrongTeam).ok, false);

const duplicateTerminal = structuredClone(validStagingEvidence());
duplicateTerminal.actionJournal.required[1].terminalRecordSha256 =
  duplicateTerminal.actionJournal.required[0].terminalRecordSha256;
assert.equal(checker.evaluatePhase3Evidence(duplicateTerminal).ok, false);

const legacyStaging = structuredClone(validStagingEvidence()) as Record<string, unknown>;
delete legacyStaging.schemaVersion;
assert.equal(checker.evaluatePhase3Evidence(legacyStaging).ok, false);

assert.equal(checker.evaluatePhase3Evidence({
  ...validStagingEvidence(),
  unexpected: true,
}).ok, false);

assert.deepEqual(checker.evaluatePhase3Evidence({
  ...validStagingEvidence(),
  fence: { ...validStagingEvidence().fence, ackJobId: 41 },
}).failures, ["FENCE_ACK_INVALID"]);
assert.deepEqual(checker.evaluatePhase3Evidence({
  ...validStagingEvidence(),
  duplicates: { ...validStagingEvidence().duplicates, settlements: 1 },
}).failures, ["DUPLICATE_SIDE_EFFECTS_PRESENT"]);
assert.deepEqual(checker.evaluatePhase3Evidence({
  ...validStagingEvidence(),
  actionJournal: {
    ...validStagingEvidence().actionJournal,
    required: validStagingEvidence().actionJournal.required.slice(0, -1),
  },
}).failures, ["ACTION_SEQUENCE_INVALID"]);
assert.deepEqual(checker.evaluatePhase3Evidence({
  ...validStagingEvidence(),
  cutover: { ...validStagingEvidence().cutover, producerStartedAfterConsumer: false },
}).failures, ["CONSUMER_PRODUCER_ORDER_INVALID"]);

const reconciled = structuredClone(validStagingEvidence());
reconciled.actionJournal.required[0] = {
  ...reconciled.actionJournal.required[0],
  status: "reconciled-succeeded",
} as typeof reconciled.actionJournal.required[number];
assert.deepEqual(checker.evaluatePhase3Evidence(reconciled).failures, ["ACTION_SEQUENCE_INVALID"]);

const withoutTimeline = structuredClone(validStagingEvidence()) as Record<string, unknown>;
delete withoutTimeline.timeline;
assert.equal(
  checker.evaluatePhase3Evidence(withoutTimeline).failures.includes("ACTION_SEQUENCE_INVALID"),
  true,
);

assert.deepEqual(checker.evaluatePhase3Evidence({
  ...validStagingEvidence(),
  host: { a3HostIdentityMatches: true, productionHostUnchanged: true },
}).failures, ["GUARD_CONTINUITY_INVALID"]);

assert.deepEqual(checker.evaluatePhase3Evidence({
  ...validStagingEvidence(),
  actionJournal: {
    ...validStagingEvidence().actionJournal,
    snapshotSha256: hash("a"),
  },
}).failures, ["ACTION_SEQUENCE_INVALID"]);

const wrongMeasurement = structuredClone(validStagingEvidence());
wrongMeasurement.actionJournal.required[0].measurementSha256 = hash("a");
assert.deepEqual(
  checker.evaluatePhase3Evidence(wrongMeasurement).failures,
  ["ACTION_SEQUENCE_INVALID"],
);

const exactNestedTargets: Array<[string, (value: JsonRecord) => JsonRecord]> = [
  ["release", (value) => value.release],
  ["target descriptor", (value) => value.targetDescriptor],
  ["operator bundle", (value) => value.operatorBundle],
  ["host", (value) => value.host],
  ["guard", (value) => value.guard],
  ["baseline", (value) => value.baseline],
  ["cutover", (value) => value.cutover],
  ["runtime", (value) => value.runtime],
  ["epoch", (value) => value.epoch],
  ["fence", (value) => value.fence],
  ["drain", (value) => value.drain],
  ["rollback", (value) => value.rollback],
  ["duplicates", (value) => value.duplicates],
  ["artifact bindings", (value) => value.artifactBindings],
  ["action measurement binding", (value) => value.artifactBindings.actionMeasurements[0]],
  ["final source bindings", (value) => value.artifactBindings.finalSources],
  ["action journal", (value) => value.actionJournal],
  ["required action", (value) => value.actionJournal.required[0]],
  ["timeline entry", (value) => value.timeline[0]],
];
for (const [label, select] of exactNestedTargets) {
  const candidate = structuredClone(validStagingEvidence()) as JsonRecord;
  select(candidate).unexpected = true;
  assert.equal(
    checker.evaluatePhase3Evidence(candidate).ok,
    false,
    `${label} must reject an extra field`,
  );
}

const productionRelease = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${hash("b")}`,
  releaseManifestSha256: hash("c"),
  environment: "supervised-production",
  topology: "phase3",
  composeProject: "spx-production",
  targetDescriptorSha256: hash("9"),
  operatorBundleSha256: hash("e"),
  productionIdentityApprovalSha256: hash("8"),
};
const productionEvidence = {
  release: productionRelease,
  releaseEnvironment: "production",
  runtimeEnvironment: "production",
  drillMode: "supervised-production",
  composeProject: "spx-production",
  stagingRunId: null,
  approvalEnvelopeSha256: hash("8"),
  targetDescriptor: {
    signed: true,
    environment: "production",
    composeProject: "spx-production",
    sha256: hash("9"),
  },
  operatorBundle: { installed: true, sha256: hash("e") },
  host: { a3HostIdentityMatches: true, productionHostUnchanged: true },
  guard: {
    sameInstanceAsTask10: true,
    heartbeatFresh: true,
    watchdogFresh: true,
    continuityGapMs: 0,
  },
  baseline: {
    sideEffectsEnabled: false,
    consumerHealthy: true,
    legacyLeaseOwnerExact: true,
    runtimeIdentitiesExact: true,
  },
  cutover: {
    legacyLeaseReleased: true,
    producerStartedAfterConsumer: true,
    directPollerAccepts: 0,
  },
  runtime: { pollerHealthy: true, consumerHealthy: true },
  epoch: {
    teamId: 2,
    historyRetained: true,
    activeEpoch: "phase3-ifn-20260710",
    activeGeneration: 4,
    staleEpochActions: 0,
  },
  fence: {
    state: "fenced",
    fenceJobId: 42,
    ackJobId: 42,
    generation: 4,
    pollerNodeMatches: true,
    acknowledgedAt: completedAt(5),
  },
  drain: {
    queued: 0,
    liveClaims: 0,
    indeterminate: 0,
    unknown: 0,
    settlementPending: 0,
  },
  rollback: { inlineOwnerRestored: true },
  duplicates: {
    externalAttempts: 0,
    results: 0,
    history: 0,
    bookingHistory: 0,
    notifications: 0,
    budgetReservations: 0,
    settlements: 0,
  },
  actionJournal: {
    headSha256: hash("1"),
    required: REQUIRED_ACTIONS.map((actionId) => ({
      actionId,
      status: "succeeded",
      occurrences: 1,
    })),
    pending: 0,
    ambiguous: 0,
    replayed: 0,
    extra: 0,
  },
  production: {
    passingStagingBundleSha256: hash("7"),
    approvalSha256: hash("8"),
    canaryTeamIds: [2],
  },
};
assert.equal(checker.evaluatePhase3Evidence(
  productionEvidence,
  { supervisedProduction: true },
).ok, true);

const reconciledProduction = structuredClone(productionEvidence);
reconciledProduction.actionJournal.required[0] = {
  actionId: REQUIRED_ACTIONS[0],
  status: "reconciled-succeeded",
  occurrences: 1,
  reconcileActionId: "phase3-reconcile-consumer-start-disabled",
  reconcileOccurrences: 1,
};
assert.equal(checker.evaluatePhase3Evidence(
  reconciledProduction,
  { supervisedProduction: true },
).ok, true);
assert.equal(checker.evaluatePhase3Evidence({
  ...productionEvidence,
  releaseEnvironment: "supervised-production",
}, { supervisedProduction: true }).ok, false);
assert.equal(checker.evaluatePhase3Evidence(productionEvidence).ok, false);
assert.equal(checker.evaluatePhase3Evidence(
  validStagingEvidence(),
  { supervisedProduction: true },
).ok, false);

let supervisedStagingPortCalls = 0;
const supervisedStagingPorts = Object.fromEntries([
  "readSemantic", "readSnapshot", "readObservations", "readActions", "readSources", "verifyPrefix",
].map((name) => [name, () => {
  supervisedStagingPortCalls += 1;
  throw new Error(`supervised production touched staging port ${name}`);
}]));
assert.equal(checker.evaluatePhase3Evidence(productionEvidence, {
  supervisedProduction: true,
  stagingPorts: supervisedStagingPorts,
} as never).ok, true);
assert.equal(supervisedStagingPortCalls, 0);

type JsonRecord = Record<string, any>;

const installedApprovalId = "phase3-checker-approval-001";
const installedRunId = "phase3-checker-run-001";
const installedEpoch = "phase3-checker-epoch-001";
const installedPartition = phase3PartitionIdentity(2, installedEpoch);
const installedRollbackSha256 = digest("checker-rollback-release");
const installedHostIdentitySha256 = digest("checker-host-identity");
const installedObserverPolicySha256 = digest("checker-observer-policy");
const installedBaseMs = Date.now() - 60_000;
const installedTime = (offset: number): string =>
  new Date(installedBaseMs + offset * 1_000).toISOString();
const installedGate3 = REQUIRED_STAGING_ACTION_PLAN.find(
  (entry) => entry.actionId === "staging-gate-3-handoff",
)!;
const installedInline = REQUIRED_STAGING_ACTION_PLAN.find(
  (entry) => entry.actionId === "phase3-inline-owner-restore",
)!;

function installedSnapshot(): JsonRecord {
  const actions = REQUIRED_STAGING_ACTION_PLAN.map((entry) => {
    const succeeded = entry.sequence <= installedInline.sequence;
    return {
      sequence: entry.sequence,
      actionId: entry.actionId,
      scope: entry.scope,
      kind: entry.kind,
      mutationSha256: entry.mutationSha256,
      state: succeeded ? "succeeded" : "registered",
      occurrences: succeeded ? 1 : 0,
      terminalRecordSha256: succeeded ? digest(`checker-terminal:${entry.actionId}`) : null,
      completedAt: succeeded ? installedTime(entry.sequence) : null,
      reconciliationId: null,
      reconciliationOutcome: null,
    };
  });
  return {
    schemaVersion: 1,
    binding: {
      approvalId: installedApprovalId,
      stagingRunId: installedRunId,
      approvalEnvelopeSha256: digest("checker-envelope"),
      targetDescriptorSha256: digest("checker-target"),
      operatorBundleSha256: digest("checker-bundle"),
    },
    recordCount: actions.length + 2 * installedInline.sequence,
    headSha256: digest("checker-terminal:phase3-inline-owner-restore"),
    actions,
  };
}

function installedSnapshotAction(snapshot: JsonRecord, actionId: string): JsonRecord {
  const action = snapshot.actions.find((entry: JsonRecord) => entry.actionId === actionId);
  assert.ok(action);
  return action;
}

function installedRelease(snapshot: JsonRecord): JsonRecord {
  return {
    candidateSha: "a".repeat(40),
    imageDigest: `sha256:${digest("checker-image")}`,
    releaseManifestSha256: digest("checker-release"),
    environment: "staging",
    topology: "phase3",
    composeProject: "spx-staging",
    stagingTargetDescriptorSha256: snapshot.binding.targetDescriptorSha256,
    operatorBundleSha256: snapshot.binding.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: snapshot.binding.approvalEnvelopeSha256,
    actionJournalHeadSha256: snapshot.headSha256,
    stagingRunId: installedRunId,
  };
}

const installedThresholds = {
  maxCpuPercent: 70,
  minMemoryFreeBytes: 4_000_000_000,
  minMysqlConnectionsFree: 40,
  productionP95LatencyMs: 200,
  maxLatencyIncreasePercent: 25,
};

function installedContext(binding: JsonRecord): JsonRecord {
  return {
    installedBinding: binding,
    envelope: { approvalId: installedApprovalId, policy: { thresholds: installedThresholds } },
    artifacts: { operatorBundle: Buffer.from("authenticated-binary-operator-bundle") },
    verified: {
      approvalId: installedApprovalId,
      rollbackReleaseManifestSha256: installedRollbackSha256,
      envelopeSha256: binding.stagingApprovalEnvelopeSha256,
      targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
      operatorBundleSha256: binding.operatorBundleSha256,
      stagingRunId: binding.stagingRunId,
    },
    descriptor: {
      releaseEnvironment: "staging",
      runtimeEnvironment: "staging",
      composeProject: "spx-staging",
      target: {
        hostIdentitySha256: installedHostIdentitySha256,
        productionObserverPolicySha256: installedObserverPolicySha256,
      },
    },
  };
}

const installedReleaseIdentityFields = [
  "candidateSha", "imageDigest", "releaseManifestSha256", "environment", "topology",
  "composeProject", "stagingTargetDescriptorSha256", "operatorBundleSha256",
  "stagingApprovalEnvelopeSha256", "stagingRunId",
];

function installedCapability(binding: JsonRecord): JsonRecord {
  return {
    schemaVersion: 1,
    releaseBinding: Object.fromEntries(
      installedReleaseIdentityFields.map((field) => [field, binding[field]]),
    ),
    database: {
      host: "mysql.staging.internal",
      port: 3306,
      name: "spx_staging",
      sslServername: "mysql.staging.internal",
      caSha256: digest("checker-ca"),
      actors: { bootstrap: "spx_staging_bootstrap", phase3Control: "spx_stg_phase3_control" },
      actorHosts: { bootstrap: "172.17.0.1", phase3Control: "172.17.0.1" },
      principalRoles: [...STAGING_PROVISIONED_DB_ROLES],
    },
    phase3: { canaryTeamId: installedPartition.teamId, canaryEpoch: installedPartition.epoch },
  };
}

function installedLeases(binding: JsonRecord): JsonRecord {
  const heartbeat = Number(process.hrtime.bigint() / 1_000_000n) - 1_000;
  const started = heartbeat - 30_000;
  const entry = (role: "guard" | "watchdog", offset: number) => ({
    schemaVersion: 1,
    role,
    state: "armed",
    breachCount: 0,
    baselineP95LatencyMs: role === "guard" ? 75 : null,
    leaseId: role === "guard"
      ? "11111111-1111-4111-8111-111111111111"
      : "22222222-2222-4222-8222-222222222222",
    stagingRunId: binding.stagingRunId,
    pid: role === "guard" ? 101 : 202,
    startedMonotonicMs: started,
    heartbeatMonotonicMs: heartbeat - offset,
    heartbeatAgeMs: 1_000,
  });
  return {
    stagingRunId: binding.stagingRunId,
    guard: entry("guard", 0),
    watchdog: entry("watchdog", 10),
    maxAgeMs: 10_000,
  };
}

function installedMarkerLabels(service: string, binding: JsonRecord): JsonRecord {
  return {
    composeProject: "spx-staging",
    composeService: service,
    environment: "staging",
    releaseSha: binding.candidateSha,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    stagingRunId: binding.stagingRunId,
  };
}

function installedControl(
  generation: number,
  acknowledgedAt: string,
  state: "enabled" | "fenced",
  acknowledged = false,
): JsonRecord {
  return {
    state,
    pollerNodeId: installedPartition.pollerNodeId,
    isActive: true,
    activeEpoch: installedPartition.epoch,
    activeGeneration: generation,
    publicationGeneration: generation,
    fenceJobId: state === "enabled" ? null : 41,
    ackNodeId: acknowledged ? installedPartition.pollerNodeId : null,
    ackJobId: acknowledged ? 42 : null,
    acknowledgedAt: acknowledged ? acknowledgedAt : null,
  };
}

const installedZeroDrain = {
  queued: 0,
  liveClaims: 0,
  indeterminate: 0,
  unknown: 0,
  settlementPending: 0,
};

function installedMeasurements(
  actionId: string,
  generation: number | null,
  binding: JsonRecord,
  acknowledgedAt: string,
): JsonRecord {
  const identity = (service: string, nodeId: string, enabled: boolean) => ({
    service,
    nodeId,
    status: "running",
    health: "healthy",
    imageId: binding.imageDigest,
    labels: installedMarkerLabels(service, binding),
    realWorkerEnabled: enabled,
    settlementWorkerEnabled: enabled,
  });
  switch (actionId) {
    case "phase3-consumer-start-disabled":
      return { consumer: identity(installedPartition.consumerService, installedPartition.consumerNodeId, false) };
    case "phase3-legacy-lease-release":
      return { lease: { activeOwnerCount: 0, ownerNodeId: null, legacyOwnerActive: false } };
    case "phase3-poller-start":
      return {
        poller: {
          ...identity(installedPartition.pollerService, installedPartition.pollerNodeId, false),
          cutoverEpoch: installedPartition.epoch,
        },
      };
    case "phase3-publication-enable":
      return { control: installedControl(generation!, acknowledgedAt, "enabled") };
    case "phase3-execution-enable":
      return { consumer: identity(installedPartition.consumerService, installedPartition.consumerNodeId, true) };
    case "phase3-publication-fence":
      return { control: installedControl(generation!, acknowledgedAt, "fenced") };
    case "phase3-drain-or-quarantine":
      return {
        control: installedControl(generation!, acknowledgedAt, "fenced", true),
        drain: installedZeroDrain,
      };
    case "phase3-inline-owner-restore":
      return {
        control: installedControl(generation!, acknowledgedAt, "fenced", true),
        drain: installedZeroDrain,
        lease: {
          activeOwnerCount: 1,
          ownerNodeId: installedPartition.legacyNodeId,
          status: "active",
        },
        services: {
          poller: {
            service: installedPartition.pollerService,
            nodeId: installedPartition.pollerNodeId,
            running: false,
          },
          consumer: {
            service: installedPartition.consumerService,
            nodeId: installedPartition.consumerNodeId,
            running: false,
          },
          inline: {
            service: installedPartition.legacyService,
            nodeId: installedPartition.legacyNodeId,
            status: "running",
            health: "healthy",
            imageId: binding.imageDigest,
            labels: installedMarkerLabels(installedPartition.legacyService, binding),
          },
        },
      };
    default:
      throw new Error(`unknown installed checker action ${actionId}`);
  }
}

function installedMarkerArtifacts(
  snapshot: JsonRecord,
  binding: JsonRecord,
  leases: JsonRecord,
): { observations: JsonRecord; actions: JsonRecord[] } {
  const observedAt = new Date(Date.now() - 5_000).toISOString();
  const acknowledgedAt = installedSnapshotAction(
    snapshot,
    "phase3-drain-or-quarantine",
  ).completedAt;
  const releaseBinding = Object.fromEntries([
    "candidateSha", "imageDigest", "releaseManifestSha256", "stagingTargetDescriptorSha256",
    "operatorBundleSha256", "stagingApprovalEnvelopeSha256", "stagingRunId",
  ].map((field) => [field, binding[field]]));
  const actionValues = PHASE3_ACTION_IDS.map((actionId, index) => {
    const terminal = installedSnapshotAction(snapshot, actionId);
    const generation = index < 3 ? null : 7;
    return {
      schemaVersion: 1,
      actionId,
      mutationSha256: terminal.mutationSha256,
      terminalRecordSha256: terminal.terminalRecordSha256,
      completedAt: terminal.completedAt,
      observedAt,
      releaseBinding,
      guardLeaseId: leases.guard.leaseId,
      watchdogLeaseId: leases.watchdog.leaseId,
      teamId: installedPartition.teamId,
      epoch: installedPartition.epoch,
      generation,
      measurements: installedMeasurements(actionId, generation, binding, acknowledgedAt),
    };
  });
  const gate3 = installedSnapshotAction(snapshot, installedGate3.actionId);
  const fence = installedSnapshotAction(snapshot, "phase3-publication-fence");
  const common = {
    schemaVersion: 1,
    stagingRunId: binding.stagingRunId,
    teamId: installedPartition.teamId,
    epoch: installedPartition.epoch,
    pollerNodeId: installedPartition.pollerNodeId,
    approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
    releaseManifestSha256: binding.releaseManifestSha256,
    rollbackReleaseManifestSha256: installedRollbackSha256,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
    observedAt,
  };
  const observationValues = {
    schema: {
      ...common,
      observationId: "phase3-schema-verify",
      requiredTerminalActionId: gate3.actionId,
      terminalRecordSha256: gate3.terminalRecordSha256,
      actionJournalHeadSha256: gate3.terminalRecordSha256,
      generation: null,
      measurements: {
        candidateSchemaVersion: 37,
        schemaMaximum: 37,
        rollbackSchemaMinimum: 36,
        rollbackSchemaMaximum: 38,
        candidateSchemaRangeDeclared: true,
        nMinusOneSchemaRangeDeclared: true,
        migration035ChecksumMatches: true,
        pendingMigrations: 0,
        runningMigrations: 0,
        failedMigrations: 0,
        observerReadOnly: true,
      },
    },
    fence: {
      ...common,
      observationId: "phase3-fence-ack-wait",
      requiredTerminalActionId: fence.actionId,
      terminalRecordSha256: fence.terminalRecordSha256,
      actionJournalHeadSha256: fence.terminalRecordSha256,
      generation: 7,
      measurements: {
        state: "fenced",
        publicationGeneration: 7,
        fenceJobId: 41,
        ackJobId: 42,
        pollerNodeId: installedPartition.pollerNodeId,
        ackNodeId: installedPartition.pollerNodeId,
        acknowledgedAt,
        isActive: true,
        observerReadOnly: true,
      },
    },
  };
  const markerRecord = (kind: "action" | "observation", id: string, value: JsonRecord) => {
    const bytes = canonicalJson(value);
    return {
      [kind === "action" ? "actionId" : "observationId"]: id,
      path: `/fixed/${id}.json`,
      value,
      bytes,
      sha256: digest(bytes),
    };
  };
  return {
    observations: {
      schema: markerRecord("observation", "phase3-schema-verify", observationValues.schema),
      fence: markerRecord("observation", "phase3-fence-ack-wait", observationValues.fence),
    },
    actions: actionValues.map((value, index) =>
      markerRecord("action", PHASE3_ACTION_IDS[index], value)),
  };
}

function installedRuntimeLabels(service: string, context: JsonRecord): JsonRecord {
  return {
    composeProject: "spx-staging",
    composeService: service,
    runtimeEnvironment: "staging",
    releaseSha: context.candidateSha,
    targetDescriptorSha256: context.stagingTargetDescriptorSha256,
    operatorBundleSha256: context.operatorBundleSha256,
    stagingRunId: context.stagingRunId,
  };
}

function installedRuntimeSourceArtifacts(
  snapshot: JsonRecord,
  binding: JsonRecord,
  leases: JsonRecord,
  markers: { observations: JsonRecord; actions: JsonRecord[] },
): JsonRecord {
  const commonContext = {
    stagingRunId: binding.stagingRunId,
    actionJournalHeadSha256: snapshot.headSha256,
    candidateSha: binding.candidateSha,
    imageDigest: binding.imageDigest,
    releaseManifestSha256: binding.releaseManifestSha256,
    rollbackReleaseManifestSha256: installedRollbackSha256,
    stagingTargetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
    teamId: installedPartition.teamId,
    epoch: installedPartition.epoch,
    generation: 7,
    windowStartedAt: installedSnapshotAction(snapshot, installedGate3.actionId).completedAt,
    windowEndedAt: installedSnapshotAction(snapshot, installedInline.actionId).completedAt,
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
  };
  const leaseTuple = (role: "guard" | "watchdog") => ({
    leaseId: leases[role].leaseId,
    state: "armed",
    pid: leases[role].pid,
    startedMonotonicMs: leases[role].startedMonotonicMs,
    heartbeatMonotonicMs: leases[role].heartbeatMonotonicMs,
    heartbeatAgeMs: leases[role].heartbeatAgeMs,
    baselineP95LatencyMs: leases[role].baselineP95LatencyMs,
  });
  const database = {
    ok: true,
    evidenceId: "phase3-gate4-final",
    control: {
      state: "fenced",
      generation: 7,
      fenceJobId: 41,
      ackJobId: 42,
      pollerNodeMatches: true,
      acknowledgedAt: installedSnapshotAction(
        snapshot,
        "phase3-drain-or-quarantine",
      ).completedAt,
    },
    drain: installedZeroDrain,
    duplicates: {
      externalAttempts: 0,
      results: 0,
      history: 0,
      bookingHistory: 0,
      notifications: 0,
      budgetReservations: 0,
      settlements: 0,
    },
    staleEpochActions: 0,
    directPollerAccepts: 0,
    inlineLease: {
      activeOwnerCount: 1,
      ownerNodeId: installedPartition.legacyNodeId,
      ownerMatches: true,
    },
  };
  const service = (
    kind: "poller" | "consumer" | "inline",
    id: string,
  ): JsonRecord => {
    const isInline = kind === "inline";
    const serviceName = isInline
      ? installedPartition.legacyService
      : kind === "poller"
        ? installedPartition.pollerService
        : installedPartition.consumerService;
    const nodeId = isInline
      ? installedPartition.legacyNodeId
      : kind === "poller"
        ? installedPartition.pollerNodeId
        : installedPartition.consumerNodeId;
    const common = {
      service: serviceName,
      containerId: id.repeat(64),
      nodeId,
      status: isInline ? "running" : "exited",
      health: isInline ? "healthy" : null,
      paused: false,
      restarting: false,
      imageId: binding.imageDigest,
      labels: installedRuntimeLabels(serviceName, commonContext),
    };
    if (kind === "poller") {
      return {
        ...common,
        cutoverEpoch: installedPartition.epoch,
        dryRunWorkerEnabled: false,
        realWorkerEnabled: false,
        settlementWorkerEnabled: false,
      };
    }
    if (kind === "consumer") {
      return {
        ...common,
        dryRunWorkerEnabled: false,
        realWorkerEnabled: true,
        settlementWorkerEnabled: true,
      };
    }
    return { ...common, role: "worker", runTeamIds: String(installedPartition.teamId) };
  };
  const runtime = {
    services: {
      poller: service("poller", "a"),
      consumer: service("consumer", "b"),
      inline: service("inline", "c"),
    },
    remainingPhase3RuntimeCount: 0,
    restoredLegacyOwner: {
      activeOwnerCount: 1,
      ownerNodeId: installedPartition.legacyNodeId,
      ownerMatches: true,
    },
  };
  const continuity = {
    before: { guard: leaseTuple("guard"), watchdog: leaseTuple("watchdog") },
    after: { guard: leaseTuple("guard"), watchdog: leaseTuple("watchdog") },
    markerBindings: {
      observations: [markers.observations.schema, markers.observations.fence].map((record) => ({
        observationId: record.observationId,
        markerSha256: record.sha256,
        guardLeaseId: leases.guard.leaseId,
        watchdogLeaseId: leases.watchdog.leaseId,
      })),
      actions: markers.actions.map((record) => ({
        actionId: record.actionId,
        markerSha256: record.sha256,
        guardLeaseId: leases.guard.leaseId,
        watchdogLeaseId: leases.watchdog.leaseId,
      })),
    },
    sameInstance: true,
    heartbeatNondecreasing: true,
    zeroGap: true,
  };
  const observedAt = new Date(Date.now() - 1_000).toISOString();
  const productionP95LatencyMs = 80;
  const productionBaselineP95LatencyMs = 75;
  const capacity = {
    schemaVersion: 1,
    observedAt,
    ok: true,
    failures: [],
    measurements: {
      a3CpuPercent: 10,
      a3MemoryFreeBytes: 8_000_000_000,
      a3DiskFreeBytes: 20_000_000_000,
      a3InodeFreePercent: 50,
      a3PidFree: 2_000,
      a3NetworkRxUtilizationPercent: 10,
      a3NetworkTxUtilizationPercent: 20,
      a3NetworkHeadroomMbps: 500,
      sharedMysqlConnectionsFree: 100,
      sharedMysqlConnectionHeadroomPercent: 50,
      productionP95LatencyMs,
      productionBaselineP95LatencyMs,
      productionLatencyIncreasePercent:
        ((productionP95LatencyMs - productionBaselineP95LatencyMs) /
          productionBaselineP95LatencyMs) * 100,
    },
    thresholds: {
      envelopeApproved: {
        maxCpuPercent: installedThresholds.maxCpuPercent,
        minMemoryFreeBytes: installedThresholds.minMemoryFreeBytes,
        minMysqlConnectionsFree: installedThresholds.minMysqlConnectionsFree,
        maxProductionP95LatencyMs: installedThresholds.productionP95LatencyMs,
        maxLatencyIncreasePercent: installedThresholds.maxLatencyIncreasePercent,
      },
      codeOwnedFixed: {
        minDiskFreeBytes: 10_000_000_000,
        minInodeFreePercent: 20,
        minPidFree: 1_000,
        maxNetworkRxUtilizationPercent: 70,
        maxNetworkTxUtilizationPercent: 70,
        minNetworkHeadroomMbps: 100,
        minMysqlConnectionHeadroomPercent: 30,
      },
    },
  };
  const productionObserver = {
    schemaVersion: 1,
    expectedPolicySha256: installedObserverPolicySha256,
    requestMethod: "GET",
    response: { p95LatencyMs: productionP95LatencyMs, ready: true },
    observedAt,
    thresholdResult: {
      absoluteP95WithinApprovedLimit: true,
      latencyIncreaseWithinApprovedLimit: true,
      passed: true,
    },
  };
  const values: JsonRecord = {
    "db-final": { schemaVersion: 1, context: commonContext, database },
    "runtime-final": { schemaVersion: 1, context: commonContext, runtime },
    "lease-continuity": { schemaVersion: 1, context: commonContext, continuity },
    capacity: { schemaVersion: 1, context: commonContext, capacity },
    "production-observer": { schemaVersion: 1, context: commonContext, productionObserver },
  };
  return Object.fromEntries(PHASE3_RUNTIME_SOURCE_IDS.map((sourceId) => {
    const value = values[sourceId];
    const bytes = canonicalJson(value);
    return [sourceId, { value, bytes, sha256: digest(bytes) }];
  }));
}

function installedSemanticValue(
  snapshotRecord: JsonRecord,
  binding: JsonRecord,
  markers: { observations: JsonRecord; actions: JsonRecord[] },
  sources: JsonRecord,
): JsonRecord {
  const database = sources["db-final"].value.database;
  const required = PHASE3_ACTION_IDS.map((actionId, index) => {
    const terminal = installedSnapshotAction(snapshotRecord.value, actionId);
    return {
      actionId,
      status: "succeeded",
      occurrences: 1,
      terminalRecordSha256: terminal.terminalRecordSha256,
      completedAt: terminal.completedAt,
      measurementSha256: markers.actions[index].sha256,
    };
  });
  return {
    schemaVersion: 2,
    release: binding,
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    drillMode: "staging",
    composeProject: "spx-staging",
    stagingRunId: binding.stagingRunId,
    approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
    targetDescriptor: {
      signed: true,
      environment: "staging",
      composeProject: "spx-staging",
      sha256: binding.stagingTargetDescriptorSha256,
    },
    operatorBundle: { installed: true, sha256: binding.operatorBundleSha256 },
    host: { a3HostIdentityMatches: true },
    guard: {
      sameInstanceAsTask10: true,
      heartbeatFresh: true,
      watchdogFresh: true,
      continuityGapMs: 0,
    },
    baseline: {
      sideEffectsEnabled: false,
      consumerHealthy: true,
      legacyLeaseOwnerExact: true,
      runtimeIdentitiesExact: true,
    },
    cutover: {
      legacyLeaseReleased: true,
      producerStartedAfterConsumer: true,
      directPollerAccepts: database.directPollerAccepts,
    },
    runtime: { pollerHealthy: true, consumerHealthy: true },
    epoch: {
      teamId: installedPartition.teamId,
      historyRetained: true,
      activeEpoch: installedPartition.epoch,
      activeGeneration: sources["db-final"].value.context.generation,
      staleEpochActions: database.staleEpochActions,
    },
    fence: { ...database.control },
    drain: { ...database.drain },
    rollback: { inlineOwnerRestored: true },
    duplicates: { ...database.duplicates },
    artifactBindings: {
      journalSnapshotSha256: snapshotRecord.sha256,
      schemaObservationSha256: markers.observations.schema.sha256,
      fenceObservationSha256: markers.observations.fence.sha256,
      actionMeasurements: PHASE3_ACTION_IDS.map((actionId, index) => ({
        actionId,
        sha256: markers.actions[index].sha256,
      })),
      finalSources: {
        dbSha256: sources["db-final"].sha256,
        runtimeSha256: sources["runtime-final"].sha256,
        leaseContinuitySha256: sources["lease-continuity"].sha256,
        capacitySha256: sources.capacity.sha256,
        productionObserverSha256: sources["production-observer"].sha256,
      },
    },
    actionJournal: {
      headSha256: snapshotRecord.value.headSha256,
      snapshotSha256: snapshotRecord.sha256,
      required,
      pending: 0,
      ambiguous: 0,
      replayed: 0,
      extra: 0,
    },
    timeline: required.map(({ actionId, completedAt }) => ({ actionId, completedAt })),
  };
}

function installedRecord(value: JsonRecord, path: string): JsonRecord {
  const bytes = canonicalJson(value);
  return { path, value, bytes, sha256: digest(bytes) };
}

function installedVerifierFixture(options: {
  currentHeadSha256?: string;
  prefixResult?: JsonRecord;
  installedSemanticMutator?: (value: JsonRecord) => JsonRecord;
  currentBindingMutator?: (value: JsonRecord) => JsonRecord;
  contextMutator?: (value: JsonRecord) => JsonRecord;
  semanticMutator?: (value: JsonRecord) => JsonRecord;
  snapshotMutator?: (value: JsonRecord) => JsonRecord;
  observationMutator?: (value: JsonRecord) => JsonRecord;
  actionMutator?: (value: JsonRecord) => JsonRecord;
  sourceMutator?: (value: JsonRecord) => JsonRecord;
  finalSemanticMutator?: (value: JsonRecord) => JsonRecord;
  finalSnapshotMutator?: (value: JsonRecord) => JsonRecord;
  finalObservationMutator?: (value: JsonRecord) => JsonRecord;
  finalActionMutator?: (value: JsonRecord) => JsonRecord;
  finalSourceMutator?: (value: JsonRecord) => JsonRecord;
} = {}) {
  const snapshotValue = installedSnapshot();
  const historicalBinding = installedRelease(snapshotValue);
  const loadedLeases = installedLeases(historicalBinding);
  const markers = installedMarkerArtifacts(snapshotValue, historicalBinding, loadedLeases);
  const sources = installedRuntimeSourceArtifacts(
    snapshotValue,
    historicalBinding,
    loadedLeases,
    markers,
  );
  const snapshotRecord = installedRecord(
    snapshotValue,
    "/fixed/phase3-snapshot/journal-snapshot.json",
  );
  const baseSemanticValue = installedSemanticValue(snapshotRecord, historicalBinding, markers, sources);
  const semanticValue = options.installedSemanticMutator
    ? options.installedSemanticMutator(structuredClone(baseSemanticValue))
    : baseSemanticValue;
  const semanticRecord = installedRecord(
    semanticValue,
    "/fixed/phase3-staging/phase3-rollout-evidence.json",
  );
  const baseCurrentBinding = {
    ...historicalBinding,
    actionJournalHeadSha256: options.currentHeadSha256 ?? historicalBinding.actionJournalHeadSha256,
  };
  const currentBinding = options.currentBindingMutator
    ? options.currentBindingMutator(structuredClone(baseCurrentBinding))
    : baseCurrentBinding;
  let semanticReads = 0;
  let snapshotReads = 0;
  let observationReads = 0;
  let actionReads = 0;
  let sourceReads = 0;
  let prefixCalls = 0;
  const calls: string[] = [];
  const ports = {
    async loadContext() {
      calls.push("context");
      const context = structuredClone(installedContext(currentBinding));
      return options.contextMutator ? options.contextMutator(context) : context;
    },
    async loadCapability(receivedBinding: JsonRecord) {
      calls.push("capability");
      assert.deepEqual(receivedBinding, currentBinding);
      return structuredClone(installedCapability(currentBinding));
    },
    async loadHostIdentity() {
      calls.push("host");
      return installedHostIdentitySha256;
    },
    async readSemantic() {
      semanticReads += 1;
      calls.push(`semantic-${semanticReads}`);
      const selected = semanticReads > 1 && options.finalSemanticMutator
        ? options.finalSemanticMutator(structuredClone(semanticRecord))
        : options.semanticMutator
          ? options.semanticMutator(structuredClone(semanticRecord))
          : structuredClone(semanticRecord);
      return selected;
    },
    async readSnapshot() {
      snapshotReads += 1;
      calls.push("snapshot");
      const selected = snapshotReads > 1 && options.finalSnapshotMutator
        ? options.finalSnapshotMutator(structuredClone(snapshotRecord))
        : options.snapshotMutator
        ? options.snapshotMutator(structuredClone(snapshotRecord))
        : structuredClone(snapshotRecord);
      return selected;
    },
    async readHistoricalObservationMarkerArtifacts() {
      observationReads += 1;
      calls.push("observations");
      const selected = observationReads > 1 && options.finalObservationMutator
        ? options.finalObservationMutator(structuredClone(markers.observations))
        : options.observationMutator
        ? options.observationMutator(structuredClone(markers.observations))
        : structuredClone(markers.observations);
      return selected;
    },
    async readHistoricalActionMeasurementArtifacts() {
      actionReads += 1;
      calls.push("actions");
      const selected = actionReads > 1 && options.finalActionMutator
        ? options.finalActionMutator(structuredClone(markers.actions))
        : options.actionMutator
        ? options.actionMutator(structuredClone(markers.actions))
        : structuredClone(markers.actions);
      return selected;
    },
    async readSources() {
      sourceReads += 1;
      calls.push("sources");
      const selected = sourceReads > 1 && options.finalSourceMutator
        ? options.finalSourceMutator(structuredClone(sources))
        : options.sourceMutator
        ? options.sourceMutator(structuredClone(sources))
        : structuredClone(sources);
      return selected;
    },
    async verifyJournalPrefix(input: JsonRecord) {
      prefixCalls += 1;
      calls.push("prefix");
      assert.deepEqual(input.binding, currentBinding);
      assert.deepEqual(input.snapshot, snapshotValue);
      return structuredClone(options.prefixResult ?? {
        ok: true,
        prefixHeadSha256: snapshotValue.headSha256,
        currentHeadSha256: currentBinding.actionJournalHeadSha256,
      });
    },
  };
  return {
    expectedSemanticSha256: semanticRecord.sha256,
    ports,
    calls,
    semanticRecord,
    snapshotRecord,
    markers,
    sources,
    historicalBinding,
    currentBinding,
    get prefixCalls() { return prefixCalls; },
  };
}

async function installedVerifierAssertions(): Promise<void> {
  assert.equal(typeof checker.verifyInstalledPhase3RolloutEvidence, "function");

  const direct = installedVerifierFixture();
  const directResult = await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: direct.expectedSemanticSha256 },
    direct.ports,
  );
  assert.deepEqual(directResult, { ok: true, failures: [] });
  assert.equal(direct.prefixCalls, 0);
  assert.equal(direct.calls.filter((entry) => entry === "host").length, 2);
  assert.equal(direct.calls.filter((entry) => entry === "snapshot").length, 2);
  assert.equal(direct.calls.filter((entry) => entry === "observations").length, 2);
  assert.equal(direct.calls.filter((entry) => entry === "actions").length, 2);
  assert.equal(direct.calls.filter((entry) => entry === "sources").length, 2);
  assert.equal(direct.calls.filter((entry) => entry.startsWith("semantic-")).length, 2);

  const wrongHash = installedVerifierFixture();
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: digest("wrong-semantic") },
    wrongHash.ports,
  )).ok, false);
  for (const expectedSemanticSha256 of ["0".repeat(64), "A".repeat(64), "", undefined]) {
    const fixture = installedVerifierFixture();
    assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
      { expectedSemanticSha256 } as never,
      fixture.ports,
    )).ok, false);
    assert.deepEqual(fixture.calls, []);
  }

  const advancedHeadSha256 = digest("advanced-installed-head");
  const advanced = installedVerifierFixture({ currentHeadSha256: advancedHeadSha256 });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: advanced.expectedSemanticSha256 },
    advanced.ports,
  )).ok, true);
  assert.equal(advanced.prefixCalls, 1);

  const prefixNotOk = installedVerifierFixture({
    currentHeadSha256: advancedHeadSha256,
    prefixResult: {
      ok: false,
      prefixHeadSha256: installedSnapshot().headSha256,
      currentHeadSha256: advancedHeadSha256,
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: prefixNotOk.expectedSemanticSha256 },
    prefixNotOk.ports,
  )).ok, false);
  assert.equal(prefixNotOk.prefixCalls, 1);

  const mismatchedCurrentHead = installedVerifierFixture({
    currentHeadSha256: advancedHeadSha256,
    prefixResult: {
      ok: true,
      prefixHeadSha256: installedSnapshot().headSha256,
      currentHeadSha256: digest("different-current-head"),
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: mismatchedCurrentHead.expectedSemanticSha256 },
    mismatchedCurrentHead.ports,
  )).ok, false);
  assert.equal(mismatchedCurrentHead.prefixCalls, 1);

  const rolledBackCurrentHead = installedVerifierFixture({
    currentHeadSha256: digest("rolled-back-current-head"),
    prefixResult: {
      ok: false,
      prefixHeadSha256: installedSnapshot().headSha256,
      currentHeadSha256: digest("rolled-back-current-head"),
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: rolledBackCurrentHead.expectedSemanticSha256 },
    rolledBackCurrentHead.ports,
  )).ok, false);
  assert.equal(rolledBackCurrentHead.prefixCalls, 1);

  const immutableReleaseChanged = installedVerifierFixture({
    currentHeadSha256: advancedHeadSha256,
    currentBindingMutator(binding) {
      binding.candidateSha = "b".repeat(40);
      return binding;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: immutableReleaseChanged.expectedSemanticSha256 },
    immutableReleaseChanged.ports,
  )).ok, false);

  const rollbackReleaseChanged = installedVerifierFixture({
    contextMutator(context) {
      context.verified.rollbackReleaseManifestSha256 = digest("changed-rollback-release");
      return context;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: rollbackReleaseChanged.expectedSemanticSha256 },
    rollbackReleaseChanged.ports,
  )).ok, false);

  const divergent = installedVerifierFixture({
    currentHeadSha256: advancedHeadSha256,
    prefixResult: {
      ok: true,
      prefixHeadSha256: digest("wrong-prefix"),
      currentHeadSha256: advancedHeadSha256,
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: divergent.expectedSemanticSha256 },
    divergent.ports,
  )).ok, false);
  assert.equal(divergent.prefixCalls, 1);

  const artifactBindingTargets: Array<[string, (semantic: JsonRecord) => JsonRecord]> = [
    ["journal snapshot", (semantic) => semantic.artifactBindings],
    ["schema observation", (semantic) => semantic.artifactBindings],
    ["fence observation", (semantic) => semantic.artifactBindings],
    ...PHASE3_ACTION_IDS.map((actionId, index) => [
      `action ${actionId}`,
      (semantic: JsonRecord) => semantic.artifactBindings.actionMeasurements[index],
    ] as [string, (semantic: JsonRecord) => JsonRecord]),
    ["database source", (semantic) => semantic.artifactBindings.finalSources],
    ["runtime source", (semantic) => semantic.artifactBindings.finalSources],
    ["lease continuity source", (semantic) => semantic.artifactBindings.finalSources],
    ["capacity source", (semantic) => semantic.artifactBindings.finalSources],
    ["production observer source", (semantic) => semantic.artifactBindings.finalSources],
  ];
  const artifactBindingFields = [
    "journalSnapshotSha256",
    "schemaObservationSha256",
    "fenceObservationSha256",
    ...PHASE3_ACTION_IDS.map(() => "sha256"),
    "dbSha256",
    "runtimeSha256",
    "leaseContinuitySha256",
    "capacitySha256",
    "productionObserverSha256",
  ];
  for (const [index, [label, select]] of artifactBindingTargets.entries()) {
    const fixture = installedVerifierFixture({
      installedSemanticMutator(semantic) {
        select(semantic)[artifactBindingFields[index]] = digest(`tampered binding:${label}`);
        return semantic;
      },
    });
    assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
      { expectedSemanticSha256: fixture.expectedSemanticSha256 },
      fixture.ports,
    )).ok, false, `${label} artifact binding tamper must fail`);
  }

  for (const observationName of ["schema", "fence"]) {
    const fixture = installedVerifierFixture({
      observationMutator(records) {
        const record = records[observationName];
        record.value.observedAt = new Date(Date.parse(record.value.observedAt) + 1).toISOString();
        record.bytes = canonicalJson(record.value);
        record.sha256 = digest(record.bytes);
        return records;
      },
    });
    assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
      { expectedSemanticSha256: fixture.expectedSemanticSha256 },
      fixture.ports,
    )).ok, false, `${observationName} observation byte/hash tamper must fail`);
  }

  const changedSemantic = installedVerifierFixture({
    finalSemanticMutator(record) {
      record.value.runtime.consumerHealthy = false;
      record.bytes = canonicalJson(record.value);
      record.sha256 = digest(record.bytes);
      return record;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: changedSemantic.expectedSemanticSha256 },
    changedSemantic.ports,
  )).ok, false);

  const finalSnapshotChanged = installedVerifierFixture({
    finalSnapshotMutator(record) {
      record.value.recordCount = 89;
      record.bytes = canonicalJson(record.value);
      record.sha256 = digest(record.bytes);
      return record;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: finalSnapshotChanged.expectedSemanticSha256 },
    finalSnapshotChanged.ports,
  )).ok, false);

  const finalObservationsChanged = installedVerifierFixture({
    finalObservationMutator(records) {
      records.schema.value.observedAt = new Date(
        Date.parse(records.schema.value.observedAt) + 1,
      ).toISOString();
      records.schema.bytes = canonicalJson(records.schema.value);
      records.schema.sha256 = digest(records.schema.bytes);
      return records;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: finalObservationsChanged.expectedSemanticSha256 },
    finalObservationsChanged.ports,
  )).ok, false);

  const finalActionsChanged = installedVerifierFixture({
    finalActionMutator(records) {
      records[0].value.observedAt = new Date(Date.parse(records[0].value.observedAt) + 1).toISOString();
      records[0].bytes = canonicalJson(records[0].value);
      records[0].sha256 = digest(records[0].bytes);
      return records;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: finalActionsChanged.expectedSemanticSha256 },
    finalActionsChanged.ports,
  )).ok, false);

  const finalSourcesChanged = installedVerifierFixture({
    finalSourceMutator(records) {
      records.capacity.value.capacity.observedAt = new Date(
        Date.parse(records.capacity.value.capacity.observedAt) + 1,
      ).toISOString();
      records.capacity.bytes = canonicalJson(records.capacity.value);
      records.capacity.sha256 = digest(records.capacity.bytes);
      return records;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: finalSourcesChanged.expectedSemanticSha256 },
    finalSourcesChanged.ports,
  )).ok, false);

  const changedAction = installedVerifierFixture({
    actionMutator(records) {
      records[0].value.measurements.consumer.health = "unhealthy";
      records[0].bytes = canonicalJson(records[0].value);
      records[0].sha256 = digest(records[0].bytes);
      return records;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: changedAction.expectedSemanticSha256 },
    changedAction.ports,
  )).ok, false);

  const changedSource = installedVerifierFixture({
    sourceMutator(records) {
      records["db-final"].value.database.directPollerAccepts = 1;
      records["db-final"].bytes = canonicalJson(records["db-final"].value);
      records["db-final"].sha256 = digest(records["db-final"].bytes);
      return records;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: changedSource.expectedSemanticSha256 },
    changedSource.ports,
  )).ok, false);

  const changedSnapshot = installedVerifierFixture({
    snapshotMutator(record) {
      record.value.recordCount = 89;
      record.bytes = canonicalJson(record.value);
      record.sha256 = digest(record.bytes);
      return record;
    },
  });
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: changedSnapshot.expectedSemanticSha256 },
    changedSnapshot.ports,
  )).ok, false);

  const partialPorts = { loadContext: direct.ports.loadContext };
  assert.equal((await checker.verifyInstalledPhase3RolloutEvidence!(
    { expectedSemanticSha256: direct.expectedSemanticSha256 },
    partialPorts as never,
  )).ok, false);

  const cliDirectory = await mkdtemp(join(tmpdir(), "phase3-checker-cli-"));
  try {
    await writeFile(
      join(cliDirectory, "phase3-rollout-evidence.json"),
      canonicalJson(productionEvidence),
      "utf8",
    );
    const preload = `data:text/javascript,${encodeURIComponent(
      `globalThis.__SPX_TEST_INSTALLED_RELEASE_BINDING__=${JSON.stringify(productionRelease)};`,
    )}`;
    const legacyCli = spawnSync(process.execPath, [
      "--import",
      preload,
      resolve("scripts/phase3-rollout-evidence-check.mjs"),
      "--supervised-production",
      `--dir=${cliDirectory}`,
    ], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test" },
    });
    assert.equal(legacyCli.status, 0, legacyCli.stderr);
    assert.deepEqual(JSON.parse(legacyCli.stdout), { ok: true, failures: [] });

    const rejectedStagingCliForms = [
      [],
      [`--dir=${cliDirectory}`],
      ["--staging", `--dir=${cliDirectory}`],
      ["--expected-semantic-sha256", direct.expectedSemanticSha256],
      [`--semantic-sha256=${direct.expectedSemanticSha256}`],
      ["--supervised-production"],
      ["--supervised-production", "--staging", `--dir=${cliDirectory}`],
      ["--supervised-production", `--dir=${cliDirectory}`, "unexpected"],
    ];
    for (const argumentsList of rejectedStagingCliForms) {
      const rejected = spawnSync(process.execPath, [
        resolve("scripts/phase3-rollout-evidence-check.mjs"),
        ...argumentsList,
      ], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
      });
      assert.equal(rejected.status, 1, `CLI arguments unexpectedly accepted: ${argumentsList.join(" ")}`);
      assert.deepEqual(JSON.parse(rejected.stdout), {
        ok: false,
        failures: ["PHASE3_EVIDENCE_INVALID"],
      });
    }
  } finally {
    await rm(cliDirectory, { recursive: true, force: true });
  }
}

void installedVerifierAssertions().then(() => {
  console.log("phase3-rollout-evidence-check: all assertions passed");
});
