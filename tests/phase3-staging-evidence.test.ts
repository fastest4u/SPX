import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import {
  chmod,
  chown,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_RUNTIME_SOURCE_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
  phase3PartitionIdentity,
  recoverPhase3ActionJournalSnapshotStorage,
  recoverPhase3CapacityObservationCheckpointStorage,
  recoverPhase3RuntimeSourceStorage,
  recoverPhase3SemanticEvidenceStorage,
  readPhase3ActionJournalSnapshot,
  readPhase3CapacityObservationCheckpoint,
  readPhase3ActionMeasurement,
  readPhase3ActionMeasurements,
  readPhase3HistoricalActionMeasurementArtifacts,
  readPhase3HistoricalObservationMarkerArtifacts,
  readPhase3ObservationMarker,
  readPhase3ObservationMarkers,
  readPhase3RuntimeSource,
  readPhase3RuntimeSources,
  readPhase3SemanticEvidence,
  validatePhase3PreGate4JournalSnapshot,
  validatePhase3ActionMeasurement,
  validatePhase3ObservationMarker,
  writePhase3ActionJournalSnapshot,
  writePhase3ActionMeasurement,
  writePhase3CapacityObservationCheckpoint,
  writePhase3ObservationMarker,
  writePhase3RuntimeSource,
  writePhase3SemanticEvidence,
} from "../scripts/lib/phase3-staging-evidence.mjs";

const ACTION_IDS = [
  "phase3-consumer-start-disabled",
  "phase3-legacy-lease-release",
  "phase3-poller-start",
  "phase3-publication-enable",
  "phase3-execution-enable",
  "phase3-publication-fence",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
] as const;
const RUNTIME_SOURCE_IDS = [
  "db-final",
  "runtime-final",
  "lease-continuity",
  "capacity",
  "production-observer",
] as const;
const MAX_RUNTIME_SOURCE_BYTES = 128 * 1024;
const RUNTIME_SOURCE_PAYLOAD_FIELDS = {
  "db-final": "database",
  "runtime-final": "runtime",
  "lease-continuity": "continuity",
  capacity: "capacity",
  "production-observer": "productionObserver",
} as const;
const TERMINAL_IDS = ["staging-gate-3-handoff", ...ACTION_IDS] as const;
const NULL_GENERATION_ACTIONS = new Set(ACTION_IDS.slice(0, 3));
const NOW_MS = Date.parse("2026-07-12T12:00:00.000Z");
const trustedApprovalId = "phase3-approval-001";

function hash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function runtimeSourceValue(sourceId: (typeof RUNTIME_SOURCE_IDS)[number], revision = 1) {
  const payloadField = RUNTIME_SOURCE_PAYLOAD_FIELDS[sourceId];
  return {
    schemaVersion: 1,
    context: {
      stagingRunId: `staging-run-phase3-${revision}`,
      actionJournalHeadSha256: hash(`runtime-source-head-${revision}`),
    },
    [payloadField]: {
      revision,
      facts: {
        ready: true,
        count: revision,
      },
      samples: [revision, { accepted: true }],
    },
  };
}

function capacityObservationCheckpointValue(revision = 1) {
  const observedAt = `2026-07-12T12:00:0${revision}.000Z`;
  return {
    schemaVersion: 1,
    context: {
      stagingRunId: `staging-run-phase3-${revision}`,
      actionJournalHeadSha256: hash(`checkpoint-head-${revision}`),
    },
    capacity: {
      observedAt,
      ok: true,
      sampleCount: revision,
    },
    productionObserver: {
      observedAt,
      ready: true,
      policySha256: hash(`observer-policy-${revision}`),
    },
  };
}

function deepMutableClone<T>(value: T): T {
  return structuredClone(value);
}

function assertDeepFrozen(value: unknown): void {
  if (value && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertDeepFrozen(child);
  }
}

const installedBinding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${hash("candidate-image")}`,
  releaseManifestSha256: hash("release-manifest"),
  environment: "staging",
  topology: "phase3",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: hash("target-descriptor"),
  operatorBundleSha256: hash("operator-bundle"),
  stagingApprovalEnvelopeSha256: hash("approval-envelope"),
  actionJournalHeadSha256: hash("mutable-installed-head"),
  stagingRunId: "staging-run-phase3-001",
};
const rollbackReleaseManifestSha256 = hash("rollback-release-manifest");
const leases = {
  stagingRunId: installedBinding.stagingRunId,
  guard: {
    schemaVersion: 1,
    role: "guard",
    state: "armed",
    breachCount: 0,
    baselineP95LatencyMs: null,
    leaseId: "11111111-1111-4111-8111-111111111111",
    stagingRunId: installedBinding.stagingRunId,
    pid: 101,
    startedMonotonicMs: 1_000,
    heartbeatMonotonicMs: 1_900,
    heartbeatAgeMs: 100,
  },
  watchdog: {
    schemaVersion: 1,
    role: "watchdog",
    state: "armed",
    breachCount: 0,
    baselineP95LatencyMs: 12.5,
    leaseId: "22222222-2222-4222-8222-222222222222",
    stagingRunId: installedBinding.stagingRunId,
    pid: 202,
    startedMonotonicMs: 1_000,
    heartbeatMonotonicMs: 1_850,
    heartbeatAgeMs: 150,
  },
  maxAgeMs: 5_000,
};

function completedAt(actionId: string): string {
  const index = TERMINAL_IDS.indexOf(actionId as (typeof TERMINAL_IDS)[number]);
  return new Date(Date.parse("2026-07-12T10:00:00.000Z") + index * 1_000).toISOString();
}

function journalAction(actionId: string, sequence: number) {
  return {
    sequence,
    actionId,
    scope: actionId,
    kind: "forward",
    mutationSha256: hash(`mutation:${actionId}`),
    state: "succeeded",
    occurrences: 1,
    terminalRecordSha256: hash(`terminal:${actionId}`),
    completedAt: completedAt(actionId),
    reconciliationId: null,
    reconciliationOutcome: null,
  };
}

function journalSnapshot(actionIds: readonly string[], headActionId: string) {
  const actions = actionIds.map((actionId, index) => journalAction(actionId, index + 1));
  return {
    schemaVersion: 1,
    binding: {
      approvalId: trustedApprovalId,
      stagingRunId: installedBinding.stagingRunId,
      approvalEnvelopeSha256: installedBinding.stagingApprovalEnvelopeSha256,
      targetDescriptorSha256: installedBinding.stagingTargetDescriptorSha256,
      operatorBundleSha256: installedBinding.operatorBundleSha256,
    },
    recordCount: actions.length,
    headSha256: hash(`terminal:${headActionId}`),
    actions,
  };
}

function preGate4JournalSnapshot() {
  const inlineSequence = REQUIRED_STAGING_ACTION_PLAN.find(
    (entry) => entry.actionId === "phase3-inline-owner-restore",
  )?.sequence;
  assert.equal(inlineSequence, 23);
  const actions = REQUIRED_STAGING_ACTION_PLAN.map((planned) => {
    const transitioned = planned.sequence <= (inlineSequence as number);
    return {
      ...planned,
      state: transitioned ? "succeeded" : "registered",
      occurrences: transitioned ? 1 : 0,
      terminalRecordSha256: transitioned ? hash(`pregate-terminal:${planned.actionId}`) : null,
      completedAt: transitioned
        ? new Date(Date.parse("2026-07-12T09:00:00.000Z") + planned.sequence * 1_000).toISOString()
        : null,
      reconciliationId: null,
      reconciliationOutcome: null,
    };
  });
  const inline = actions[(inlineSequence as number) - 1];
  return {
    schemaVersion: 1,
    binding: {
      approvalId: trustedApprovalId,
      stagingRunId: installedBinding.stagingRunId,
      approvalEnvelopeSha256: installedBinding.stagingApprovalEnvelopeSha256,
      targetDescriptorSha256: installedBinding.stagingTargetDescriptorSha256,
      operatorBundleSha256: installedBinding.operatorBundleSha256,
    },
    recordCount: REQUIRED_STAGING_ACTION_PLAN.length + 2 * (inlineSequence as number),
    headSha256: inline.terminalRecordSha256 as string,
    actions,
  };
}

function semanticEvidenceValue(snapshot = preGate4JournalSnapshot()) {
  const phase3Actions = snapshot.actions.slice(15, 23);
  const actionHashes = Object.fromEntries(
    ACTION_IDS.map((actionId) => [actionId, hash(`semantic-marker:${actionId}`)]),
  );
  return {
    schemaVersion: 2,
    release: {
      ...installedBinding,
      actionJournalHeadSha256: snapshot.headSha256,
    },
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    drillMode: "staging",
    composeProject: "spx-staging",
    stagingRunId: installedBinding.stagingRunId,
    approvalEnvelopeSha256: installedBinding.stagingApprovalEnvelopeSha256,
    targetDescriptor: {
      signed: true,
      environment: "staging",
      composeProject: "spx-staging",
      sha256: installedBinding.stagingTargetDescriptorSha256,
    },
    operatorBundle: { installed: true, sha256: installedBinding.operatorBundleSha256 },
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
      activeEpoch: "phase3-epoch-001",
      activeGeneration: 7,
      staleEpochActions: 0,
    },
    fence: {
      state: "fenced",
      fenceJobId: 41,
      ackJobId: 42,
      generation: 7,
      pollerNodeMatches: true,
      acknowledgedAt: "2026-07-12T10:30:00.000Z",
    },
    drain: { ...zeroDrain },
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
      journalSnapshotSha256: hash(canonicalJson(snapshot)),
      schemaObservationSha256: hash("semantic-schema-observation"),
      fenceObservationSha256: hash("semantic-fence-observation"),
      actionMeasurements: ACTION_IDS.map((actionId) => ({
        actionId,
        sha256: actionHashes[actionId],
      })),
      finalSources: {
        dbSha256: hash("semantic-db"),
        runtimeSha256: hash("semantic-runtime"),
        leaseContinuitySha256: hash("semantic-continuity"),
        capacitySha256: hash("semantic-capacity"),
        productionObserverSha256: hash("semantic-observer"),
      },
    },
    actionJournal: {
      headSha256: snapshot.headSha256,
      snapshotSha256: hash(canonicalJson(snapshot)),
      required: phase3Actions.map((action) => ({
        actionId: action.actionId,
        status: "succeeded",
        occurrences: 1,
        terminalRecordSha256: action.terminalRecordSha256 as string,
        completedAt: action.completedAt as string,
        measurementSha256: actionHashes[action.actionId],
      })),
      pending: 0,
      ambiguous: 0,
      replayed: 0,
      extra: 0,
    },
    timeline: phase3Actions.map((action) => ({
      actionId: action.actionId,
      completedAt: action.completedAt as string,
    })),
  };
}

function expectedFor(
  position: "current" | "historical",
  snapshot: ReturnType<typeof journalSnapshot>,
) {
  return {
    position,
    journalSnapshot: snapshot,
    installedBinding: {
      ...installedBinding,
      actionJournalHeadSha256: snapshot.headSha256,
    },
    approvalId: trustedApprovalId,
    rollbackReleaseManifestSha256,
    leases,
    partition: phase3PartitionIdentity(2, "phase3-epoch-001"),
    nowMs: NOW_MS,
  };
}

function labels(service: string) {
  return {
    composeProject: "spx-staging",
    composeService: service,
    environment: "staging",
    releaseSha: installedBinding.candidateSha,
    targetDescriptorSha256: installedBinding.stagingTargetDescriptorSha256,
    operatorBundleSha256: installedBinding.operatorBundleSha256,
    stagingRunId: installedBinding.stagingRunId,
  };
}

function identity(service: string, nodeId: string, enabled: boolean) {
  return {
    service,
    nodeId,
    status: "running",
    health: "healthy",
    imageId: installedBinding.imageDigest,
    labels: labels(service),
    realWorkerEnabled: enabled,
    settlementWorkerEnabled: enabled,
  };
}

function control(generation: number, state: "enabled" | "fenced", acknowledged = false) {
  return {
    state,
    pollerNodeId: "stg-poller-ifn-phase3-1",
    isActive: true,
    activeEpoch: "phase3-epoch-001",
    activeGeneration: generation,
    publicationGeneration: generation,
    fenceJobId: state === "enabled" ? null : 41,
    ackNodeId: acknowledged ? "stg-poller-ifn-phase3-1" : null,
    ackJobId: acknowledged ? 42 : null,
    acknowledgedAt: acknowledged ? "2026-07-12T10:30:00.000Z" : null,
  };
}

const zeroDrain = {
  queued: 0,
  liveClaims: 0,
  indeterminate: 0,
  unknown: 0,
  settlementPending: 0,
};

function measurements(actionId: (typeof ACTION_IDS)[number], generation: number | null) {
  switch (actionId) {
    case "phase3-consumer-start-disabled":
      return { consumer: identity("auto-accept-ifn-phase3", "stg-auto-accept-ifn-phase3-1", false) };
    case "phase3-legacy-lease-release":
      return { lease: { activeOwnerCount: 0, ownerNodeId: null, legacyOwnerActive: false } };
    case "phase3-poller-start":
      return {
        poller: {
          ...identity("poller-ifn-phase3", "stg-poller-ifn-phase3-1", false),
          cutoverEpoch: "phase3-epoch-001",
        },
      };
    case "phase3-publication-enable":
      return { control: control(generation as number, "enabled") };
    case "phase3-execution-enable":
      return { consumer: identity("auto-accept-ifn-phase3", "stg-auto-accept-ifn-phase3-1", true) };
    case "phase3-publication-fence":
      return { control: control(generation as number, "fenced") };
    case "phase3-drain-or-quarantine":
      return { control: control(generation as number, "fenced", true), drain: zeroDrain };
    case "phase3-inline-owner-restore": {
      const inlineService = "worker-ifn-split";
      return {
        control: control(generation as number, "fenced", true),
        drain: zeroDrain,
        lease: {
          activeOwnerCount: 1,
          ownerNodeId: "stg-worker-ifn-split-1",
          status: "active",
        },
        services: {
          poller: {
            service: "poller-ifn-phase3",
            nodeId: "stg-poller-ifn-phase3-1",
            running: false,
          },
          consumer: {
            service: "auto-accept-ifn-phase3",
            nodeId: "stg-auto-accept-ifn-phase3-1",
            running: false,
          },
          inline: {
            service: inlineService,
            nodeId: "stg-worker-ifn-split-1",
            status: "running",
            health: "healthy",
            imageId: installedBinding.imageDigest,
            labels: labels(inlineService),
          },
        },
      };
    }
  }
}

function actionMarker(actionId: (typeof ACTION_IDS)[number]) {
  const generation = NULL_GENERATION_ACTIONS.has(actionId) ? null : 7;
  return {
    schemaVersion: 1,
    actionId,
    mutationSha256: hash(`mutation:${actionId}`),
    terminalRecordSha256: hash(`terminal:${actionId}`),
    completedAt: completedAt(actionId),
    observedAt: "2026-07-12T10:30:00.000Z",
    releaseBinding: {
      candidateSha: installedBinding.candidateSha,
      imageDigest: installedBinding.imageDigest,
      releaseManifestSha256: installedBinding.releaseManifestSha256,
      stagingTargetDescriptorSha256: installedBinding.stagingTargetDescriptorSha256,
      operatorBundleSha256: installedBinding.operatorBundleSha256,
      stagingApprovalEnvelopeSha256: installedBinding.stagingApprovalEnvelopeSha256,
      stagingRunId: installedBinding.stagingRunId,
    },
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
    teamId: 2,
    epoch: "phase3-epoch-001",
    generation,
    measurements: measurements(actionId, generation),
  };
}

function schemaObservation() {
  const actionId = "staging-gate-3-handoff";
  return {
    schemaVersion: 1,
    observationId: "phase3-schema-verify",
    requiredTerminalActionId: actionId,
    terminalRecordSha256: hash(`terminal:${actionId}`),
    actionJournalHeadSha256: hash(`terminal:${actionId}`),
    stagingRunId: installedBinding.stagingRunId,
    teamId: 2,
    epoch: "phase3-epoch-001",
    pollerNodeId: "stg-poller-ifn-phase3-1",
    approvalEnvelopeSha256: installedBinding.stagingApprovalEnvelopeSha256,
    releaseManifestSha256: installedBinding.releaseManifestSha256,
    rollbackReleaseManifestSha256,
    targetDescriptorSha256: installedBinding.stagingTargetDescriptorSha256,
    operatorBundleSha256: installedBinding.operatorBundleSha256,
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
    generation: null,
    observedAt: "2026-07-12T10:31:00.000Z",
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
  };
}

function fenceObservation() {
  const actionId = "phase3-publication-fence";
  return {
    schemaVersion: 1,
    observationId: "phase3-fence-ack-wait",
    requiredTerminalActionId: actionId,
    terminalRecordSha256: hash(`terminal:${actionId}`),
    actionJournalHeadSha256: hash(`terminal:${actionId}`),
    stagingRunId: installedBinding.stagingRunId,
    teamId: 2,
    epoch: "phase3-epoch-001",
    pollerNodeId: "stg-poller-ifn-phase3-1",
    approvalEnvelopeSha256: installedBinding.stagingApprovalEnvelopeSha256,
    releaseManifestSha256: installedBinding.releaseManifestSha256,
    rollbackReleaseManifestSha256,
    targetDescriptorSha256: installedBinding.stagingTargetDescriptorSha256,
    operatorBundleSha256: installedBinding.operatorBundleSha256,
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
    generation: 7,
    observedAt: "2026-07-12T10:31:00.000Z",
    measurements: {
      state: "fenced",
      publicationGeneration: 7,
      fenceJobId: 41,
      ackJobId: 42,
      pollerNodeId: "stg-poller-ifn-phase3-1",
      ackNodeId: "stg-poller-ifn-phase3-1",
      acknowledgedAt: "2026-07-12T10:30:00.000Z",
      isActive: true,
      observerReadOnly: true,
    },
  };
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function expectSymlinkRejection(
  target: string,
  path: string,
  operation: () => Promise<unknown>,
  type?: "file" | "dir" | "junction",
): Promise<void> {
  try {
    await symlink(target, path, type);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }
  await assert.rejects(operation, /symlink|canonical|directory|regular/i);
}

async function main(): Promise<void> {
  assert.deepEqual(PHASE3_SEMANTIC_SOURCE_IDS, [
    "phase3-journal-snapshot",
    "phase3-schema-marker",
    "phase3-fence-marker",
    ...ACTION_IDS.map((actionId) => `phase3-action:${actionId}`),
    "phase3-db-final",
    "phase3-runtime-final",
    "phase3-lease-continuity",
    "phase3-capacity",
    "phase3-production-observer",
  ]);
  assertDeepFrozen(PHASE3_SEMANTIC_SOURCE_IDS);
  for (const task4StorageApi of [
    readPhase3ActionJournalSnapshot,
    writePhase3ActionJournalSnapshot,
    recoverPhase3ActionJournalSnapshotStorage,
    readPhase3SemanticEvidence,
    writePhase3SemanticEvidence,
    recoverPhase3SemanticEvidenceStorage,
    validatePhase3PreGate4JournalSnapshot,
    readPhase3HistoricalActionMeasurementArtifacts,
    readPhase3HistoricalObservationMarkerArtifacts,
  ]) {
    assert.equal(typeof task4StorageApi, "function");
  }
  assert.deepEqual(PHASE3_ACTION_IDS, ACTION_IDS);
  assert.deepEqual(PHASE3_RUNTIME_SOURCE_IDS, [
    "db-final",
    "runtime-final",
    "lease-continuity",
    "capacity",
    "production-observer",
  ]);
  assertDeepFrozen(PHASE3_RUNTIME_SOURCE_IDS);
  assert.equal(typeof writePhase3RuntimeSource, "function");
  assert.equal(typeof readPhase3RuntimeSource, "function");
  assert.equal(typeof readPhase3RuntimeSources, "function");
  assert.equal(typeof writePhase3CapacityObservationCheckpoint, "function");
  assert.equal(typeof readPhase3CapacityObservationCheckpoint, "function");
  assert.equal(typeof recoverPhase3RuntimeSourceStorage, "function");
  assert.equal(typeof recoverPhase3CapacityObservationCheckpointStorage, "function");
  assertDeepFrozen(PHASE3_ACTION_IDS);
  assert.deepEqual(phase3PartitionIdentity(1, "epoch-one"), {
    teamId: 1,
    epoch: "epoch-one",
    pollerService: "poller-ptwl-phase3",
    pollerNodeId: "stg-poller-ptwl-phase3-1",
    consumerService: "auto-accept-ptwl-phase3",
    consumerNodeId: "stg-auto-accept-ptwl-phase3-1",
    legacyService: "worker-ptwl-split",
    legacyNodeId: "stg-worker-ptwl-split-1",
  });
  assertDeepFrozen(phase3PartitionIdentity(2, "epoch-two"));
  assert.throws(() => phase3PartitionIdentity(3, "epoch"), /team|partition/i);
  assert.throws(() => phase3PartitionIdentity(1, "../epoch"), /epoch/i);
  assert.throws(() => phase3PartitionIdentity(1, "x".repeat(129)), /epoch/i);

  for (const actionId of ACTION_IDS) {
    const marker = actionMarker(actionId);
    const expected = expectedFor("current", journalSnapshot([actionId], actionId));
    const validated = validatePhase3ActionMeasurement(marker, expected);
    assert.deepEqual(validated, marker);
    assert.notEqual(validated, marker);
    assertDeepFrozen(validated);
  }

  const first = actionMarker(ACTION_IDS[0]);
  const firstExpected = expectedFor("current", journalSnapshot([ACTION_IDS[0]], ACTION_IDS[0]));
  for (const invalid of [
    { ...first, mutationSha256: hash("wrong-mutation") },
    { ...first, terminalRecordSha256: hash("wrong-terminal") },
    { ...first, completedAt: "2026-07-12T10:59:00.000Z" },
    { ...first, observedAt: "2026-07-10T10:30:00.000Z" },
    { ...first, observedAt: "2026-07-12T12:06:00.000Z" },
    { ...first, teamId: 1 },
    { ...first, epoch: "wrong-epoch" },
    { ...first, guardLeaseId: "replaced-guard" },
    { ...first, releaseBinding: { ...first.releaseBinding, releaseManifestSha256: "0".repeat(64) } },
    { ...first, measurements: { ...first.measurements, token: "sk-1234567890123456" } },
  ]) {
    assert.throws(() => validatePhase3ActionMeasurement(invalid, firstExpected));
  }
  const nonTerminal = deepMutableClone(firstExpected);
  nonTerminal.journalSnapshot.actions[0].state = "registered";
  nonTerminal.journalSnapshot.actions[0].occurrences = 0;
  nonTerminal.journalSnapshot.actions[0].terminalRecordSha256 = null as never;
  nonTerminal.journalSnapshot.actions[0].completedAt = null as never;
  assert.throws(() => validatePhase3ActionMeasurement(first, nonTerminal), /terminal|succeeded/i);
  const wrongApproval = deepMutableClone(firstExpected);
  wrongApproval.journalSnapshot.binding.approvalId = "other-phase3-approval";
  assert.throws(
    () => validatePhase3ActionMeasurement(first, wrongApproval),
    /approval|binding/i,
  );
  const laterHead = deepMutableClone(firstExpected);
  laterHead.journalSnapshot.headSha256 = hash("later-head");
  assert.throws(() => validatePhase3ActionMeasurement(first, laterHead), /current|head|terminal/i);
  const staleLeases = deepMutableClone(firstExpected);
  staleLeases.leases.guard.heartbeatAgeMs = staleLeases.leases.maxAgeMs + 1;
  assert.throws(() => validatePhase3ActionMeasurement(first, staleLeases), /lease|fresh|age/i);
  const replacedLeases = deepMutableClone(firstExpected);
  replacedLeases.leases.watchdog.leaseId = "33333333-3333-4333-8333-333333333333";
  assert.throws(() => validatePhase3ActionMeasurement(first, replacedLeases), /lease/i);
  const duplicateLeases = deepMutableClone(firstExpected);
  duplicateLeases.leases.watchdog.leaseId = duplicateLeases.leases.guard.leaseId;
  assert.throws(() => validatePhase3ActionMeasurement(first, duplicateLeases), /lease|distinct/i);
  const changedInstalledHead = deepMutableClone(firstExpected);
  changedInstalledHead.installedBinding.actionJournalHeadSha256 = hash("wrong-installed-head");
  assert.throws(
    () => validatePhase3ActionMeasurement(first, changedInstalledHead),
    /installed|journal|head/i,
  );
  const invalidClock = deepMutableClone(firstExpected);
  invalidClock.nowMs = Number.NaN;
  assert.throws(() => validatePhase3ActionMeasurement(first, invalidClock), /clock|integer/i);
  const secretLeaseExpected = deepMutableClone(firstExpected);
  secretLeaseExpected.leases.guard.leaseId = "token";
  assert.throws(
    () => validatePhase3ActionMeasurement(
      { ...first, guardLeaseId: "token" },
      secretLeaseExpected,
    ),
    /secret|token/i,
  );
  assert.throws(
    () => validatePhase3ActionMeasurement(first, { ...firstExpected, unknown: true }),
    /expected|unknown|field/i,
  );

  const allSnapshot = journalSnapshot(TERMINAL_IDS, ACTION_IDS.at(-1) as string);
  const historicalExpected = expectedFor("historical", allSnapshot);
  const schema = schemaObservation();
  const fence = fenceObservation();
  for (const observation of [schema, fence]) {
    const validated = validatePhase3ObservationMarker(observation, historicalExpected);
    assert.deepEqual(validated, observation);
    assertDeepFrozen(validated);
  }
  for (const invalid of [
    { ...schema, observedAt: undefined },
    { ...schema, observedAt: "2026-07-12T09:59:59.999Z" },
    { ...schema, observedAt: "2026-07-10T10:31:00.000Z" },
    { ...schema, observedAt: "2026-07-12T12:06:00.000Z" },
    { ...schema, terminalRecordSha256: hash("changed-schema-terminal") },
    { ...schema, actionJournalHeadSha256: hash("changed-schema-head") },
    { ...schema, guardLeaseId: "replaced-guard" },
    { ...schema, watchdogLeaseId: "replaced-watchdog" },
    { ...schema, teamId: 1 },
    { ...schema, epoch: "changed-epoch" },
    { ...schema, releaseManifestSha256: hash("changed-release") },
    { ...schema, rollbackReleaseManifestSha256: hash("wrong-rollback") },
    { ...schema, rollbackReleaseManifestSha256: "0".repeat(64) },
    { ...schema, measurements: { ...schema.measurements, pendingMigrations: -1 } },
    { ...schema, measurements: { ...schema.measurements, pendingMigrations: 1 } },
    { ...schema, measurements: { ...schema.measurements, runningMigrations: 1 } },
    { ...schema, measurements: { ...schema.measurements, failedMigrations: 1 } },
    { ...schema, measurements: { ...schema.measurements, observerReadOnly: false } },
    { ...schema, measurements: { ...schema.measurements, schemaMaximum: undefined } },
    { ...schema, measurements: { ...schema.measurements, payload: "secret" } },
    { ...fence, measurements: { ...fence.measurements, acknowledgedAt: undefined } },
    { ...fence, measurements: { ...fence.measurements, ackNodeId: "wrong-poller" } },
    { ...fence, measurements: { ...fence.measurements, publicationGeneration: 8 } },
    { ...fence, measurements: { ...fence.measurements, ackJobId: 40 } },
    { ...fence, generation: null },
  ]) {
    assert.throws(() => validatePhase3ObservationMarker(invalid, historicalExpected));
  }

  const base = await mkdtemp(join(tmpdir(), "spx-phase3-markers-"));
  const actionRoot = join(base, "phase3-action-measurements");
  const tempRoot = join(base, ".phase3-marker-tmp");
  const observationRoot = join(base, "phase3-observations");
  await Promise.all([privateDirectory(actionRoot), privateDirectory(tempRoot), privateDirectory(observationRoot)]);

  try {
    const provisionBase = join(base, "clean-parent-provisioning");
    const provisionActionRoot = join(provisionBase, "actions");
    const provisionTempRoot = join(provisionBase, ".tmp");
    await privateDirectory(provisionBase);
    const provisioned = await writePhase3ActionMeasurement(first, firstExpected, {
      rootPath: provisionActionRoot,
      tempRootPath: provisionTempRoot,
    });
    assert.equal(provisioned.path, join(provisionActionRoot, `${ACTION_IDS[0]}.json`));
    assert.equal((await stat(provisionActionRoot)).isDirectory(), true);
    assert.equal((await stat(provisionTempRoot)).isDirectory(), true);
    assert.deepEqual(await readdir(provisionTempRoot), []);
    if (process.platform !== "win32") {
      assert.equal((await stat(provisionActionRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(provisionTempRoot)).mode & 0o777, 0o700);
    }
    await assert.rejects(
      () => writePhase3ActionMeasurement(first, firstExpected, {
        rootPath: join(base, "missing-parent", "actions"),
        tempRootPath: join(base, "missing-parent", ".tmp"),
      }),
      /ENOENT|parent|directory/i,
    );
    const writerSymlinkBase = join(base, "writer-symlink-root");
    await privateDirectory(writerSymlinkBase);
    await expectSymlinkRejection(
      provisionActionRoot,
      join(writerSymlinkBase, "actions"),
      () => writePhase3ActionMeasurement(first, firstExpected, {
        rootPath: join(writerSymlinkBase, "actions"),
        tempRootPath: join(writerSymlinkBase, ".tmp"),
      }),
      process.platform === "win32" ? "junction" : "dir",
    );
    if (process.platform !== "win32") {
      const permissiveWriterParent = join(base, "permissive-writer-parent");
      await privateDirectory(permissiveWriterParent);
      await chmod(permissiveWriterParent, 0o755);
      await assert.rejects(
        () => writePhase3ActionMeasurement(first, firstExpected, {
          rootPath: join(permissiveWriterParent, "actions"),
          tempRootPath: join(permissiveWriterParent, ".tmp"),
        }),
        /0700|mode|secure|private/i,
      );

      const permissiveWriterRootBase = join(base, "permissive-writer-root");
      const permissiveWriterRoot = join(permissiveWriterRootBase, "actions");
      const permissiveWriterTemp = join(permissiveWriterRootBase, ".tmp");
      await privateDirectory(permissiveWriterRootBase);
      await Promise.all([
        privateDirectory(permissiveWriterRoot),
        privateDirectory(permissiveWriterTemp),
      ]);
      await chmod(permissiveWriterRoot, 0o755);
      await assert.rejects(
        () => writePhase3ActionMeasurement(first, firstExpected, {
          rootPath: permissiveWriterRoot,
          tempRootPath: permissiveWriterTemp,
        }),
        /0700|mode|secure|private/i,
      );
    }

    for (const actionId of ACTION_IDS) {
      const marker = actionMarker(actionId);
      const expected = expectedFor("current", journalSnapshot([actionId], actionId));
      const result = await writePhase3ActionMeasurement(marker, expected, { rootPath: actionRoot, tempRootPath: tempRoot });
      assert.equal(result.path, join(actionRoot, `${actionId}.json`));
      assert.equal(result.sha256, hash(canonicalJson(marker)));
      assert.deepEqual(result.value, marker);
      assertDeepFrozen(result);
      assert.equal(await readFile(result.path, "utf8"), canonicalJson(marker));
      assert.equal((await stat(result.path)).size, Buffer.byteLength(canonicalJson(marker)));
    }
    assert.deepEqual(await readdir(tempRoot), []);

    const idempotent = await writePhase3ActionMeasurement(first, firstExpected, {
      rootPath: actionRoot,
      tempRootPath: tempRoot,
    });
    assert.equal(idempotent.sha256, hash(canonicalJson(first)));
    await assert.rejects(
      () => writePhase3ActionMeasurement(
        { ...first, observedAt: "2026-07-12T10:31:00.000Z" },
        firstExpected,
        { rootPath: actionRoot, tempRootPath: tempRoot },
      ),
      /conflict|different|identical/i,
    );
    await assert.rejects(
      () => writePhase3ActionMeasurement(first, historicalExpected, {
        rootPath: actionRoot,
        tempRootPath: tempRoot,
      }),
      /current/i,
    );

    const currentSchemaExpected = expectedFor(
      "current",
      journalSnapshot(["staging-gate-3-handoff"], "staging-gate-3-handoff"),
    );
    const schemaWrite = await writePhase3ObservationMarker(schema, currentSchemaExpected, {
      rootPath: observationRoot,
      tempRootPath: tempRoot,
    });
    assert.equal(
      schemaWrite.path,
      join(observationRoot, "phase3-schema-verify.json"),
    );
    assert.equal(schemaWrite.sha256, hash(canonicalJson(schema)));
    assert.deepEqual(schemaWrite.value, schema);
    assertDeepFrozen(schemaWrite);
    assert.equal(await readFile(schemaWrite.path, "utf8"), canonicalJson(schema));
    const schemaOnlyRetry = await readPhase3ObservationMarker(
      "phase3-schema-verify",
      historicalExpected,
      { rootPath: observationRoot },
    );
    assert.equal(schemaOnlyRetry.observationId, "phase3-schema-verify");
    assert.equal(schemaOnlyRetry.bytes, canonicalJson(schema));
    assert.equal(schemaOnlyRetry.sha256, hash(schemaOnlyRetry.bytes));
    assertDeepFrozen(schemaOnlyRetry);
    await assert.rejects(
      () => readPhase3ObservationMarkers(historicalExpected, { rootPath: observationRoot }),
      /missing|exact|file/i,
    );

    const fenceSnapshot = journalSnapshot(
      [...TERMINAL_IDS.slice(0, TERMINAL_IDS.indexOf("phase3-publication-fence") + 1)],
      "phase3-publication-fence",
    );
    const currentFenceExpected = expectedFor("current", fenceSnapshot);
    const fenceWrite = await writePhase3ObservationMarker(fence, currentFenceExpected, {
      rootPath: observationRoot,
      tempRootPath: tempRoot,
    });
    assert.equal(
      fenceWrite.path,
      join(observationRoot, "phase3-fence-ack-wait.json"),
    );
    assert.equal(fenceWrite.sha256, hash(canonicalJson(fence)));
    assertDeepFrozen(fenceWrite);
    assert.deepEqual(await readdir(tempRoot), []);
    const currentFenceRead = await readPhase3ObservationMarker(
      "phase3-fence-ack-wait",
      currentFenceExpected,
      { rootPath: observationRoot },
    );
    assert.deepEqual(currentFenceRead.value, fence);
    assertDeepFrozen(currentFenceRead);
    const schemaIdempotent = await writePhase3ObservationMarker(schema, currentSchemaExpected, {
      rootPath: observationRoot,
      tempRootPath: tempRoot,
    });
    assert.equal(schemaIdempotent.sha256, hash(canonicalJson(schema)));
    await assert.rejects(
      () => writePhase3ObservationMarker(
        { ...schema, observedAt: "2026-07-12T10:32:00.000Z" },
        currentSchemaExpected,
        { rootPath: observationRoot, tempRootPath: tempRoot },
      ),
      /conflict|different|identical/i,
    );
    await assert.rejects(
      () => writePhase3ObservationMarker(schema, historicalExpected, {
        rootPath: observationRoot,
        tempRootPath: tempRoot,
      }),
      /current/i,
    );
    const advancedCurrent = expectedFor("current", allSnapshot);
    await assert.rejects(
      () => writePhase3ObservationMarker(schema, advancedCurrent, {
        rootPath: observationRoot,
        tempRootPath: tempRoot,
      }),
      /current|head|terminal/i,
    );
    await assert.rejects(
      () => readPhase3ActionMeasurement(ACTION_IDS[0], firstExpected, { rootPath: actionRoot }),
      /historical/i,
    );

    const single = await readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: actionRoot });
    assert.equal(single.actionId, ACTION_IDS[0]);
    assert.equal(single.bytes, canonicalJson(first));
    assert.equal(single.sha256, hash(single.bytes));
    assertDeepFrozen(single);
    const all = await readPhase3ActionMeasurements(historicalExpected, { rootPath: actionRoot });
    assert.deepEqual(all.map((entry) => entry.actionId), ACTION_IDS);
    assertDeepFrozen(all);

    const extraPath = join(actionRoot, "unexpected.json");
    await writeFile(extraPath, "{}", { mode: 0o600 });
    await assert.rejects(
      () => readPhase3ActionMeasurements(historicalExpected, { rootPath: actionRoot }),
      /unexpected|exact|file/i,
    );
    await unlink(extraPath);
    const missingPath = join(actionRoot, `${ACTION_IDS[7]}.json`);
    const heldPath = join(base, "held-marker.json");
    await rename(missingPath, heldPath);
    await assert.rejects(
      () => readPhase3ActionMeasurements(historicalExpected, { rootPath: actionRoot }),
      /missing|exact|file/i,
    );
    await rename(heldPath, missingPath);

    const observations = await readPhase3ObservationMarkers(historicalExpected, { rootPath: observationRoot });
    assert.deepEqual(observations.schema.value, schema);
    assert.deepEqual(observations.fence.value, fence);
    assert.equal(observations.schema.bytes, canonicalJson(schema));
    assert.equal(observations.fence.sha256, hash(canonicalJson(fence)));
    assertDeepFrozen(observations);
    await assert.rejects(
      () => readPhase3ObservationMarkers(firstExpected, { rootPath: observationRoot }),
      /historical/i,
    );
    const observationExtra = join(observationRoot, "extra.json");
    await writeFile(observationExtra, "{}", { mode: 0o600 });
    await assert.rejects(
      () => readPhase3ObservationMarkers(historicalExpected, { rootPath: observationRoot }),
      /unexpected|exact|file/i,
    );
    await unlink(observationExtra);

    const malformedObservationRoot = join(base, "malformed-observations");
    await privateDirectory(malformedObservationRoot);
    const malformedObservationPath = join(
      malformedObservationRoot,
      "phase3-schema-verify.json",
    );
    await writeFile(malformedObservationPath, `${canonicalJson(schema)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => readPhase3ObservationMarker(
        "phase3-schema-verify",
        historicalExpected,
        { rootPath: malformedObservationRoot },
      ),
      /canonical/i,
    );
    await writeFile(malformedObservationPath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(
      () => readPhase3ObservationMarker(
        "phase3-schema-verify",
        historicalExpected,
        { rootPath: malformedObservationRoot },
      ),
      /size|64|large/i,
    );

    const malformedRoot = join(base, "malformed");
    await privateDirectory(malformedRoot);
    const malformedPath = join(malformedRoot, `${ACTION_IDS[0]}.json`);
    await writeFile(malformedPath, `${canonicalJson(first)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: malformedRoot }),
      /canonical/i,
    );
    await writeFile(malformedPath, "{", { mode: 0o600 });
    await assert.rejects(
      () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: malformedRoot }),
      /JSON|parse|marker/i,
    );
    await writeFile(malformedPath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(
      () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: malformedRoot }),
      /size|64|large/i,
    );

    const orphanBase = join(base, "orphan-recovery");
    const orphanRoot = join(orphanBase, "actions");
    const orphanTemp = join(orphanBase, ".tmp");
    await Promise.all([privateDirectory(orphanRoot), privateDirectory(orphanTemp)]);
    const orphanName = `${randomUUID()}.tmp`;
    await writeFile(join(orphanTemp, orphanName), "partial", { mode: 0o600 });
    await writePhase3ActionMeasurement(first, firstExpected, { rootPath: orphanRoot, tempRootPath: orphanTemp });
    assert.deepEqual(await readdir(orphanTemp), []);

    const linkedBase = join(base, "linked-recovery");
    const linkedRoot = join(linkedBase, "actions");
    const linkedTemp = join(linkedBase, ".tmp");
    await Promise.all([privateDirectory(linkedRoot), privateDirectory(linkedTemp)]);
    const linkedTempPath = join(linkedTemp, `${randomUUID()}.tmp`);
    const linkedDestination = join(linkedRoot, `${ACTION_IDS[0]}.json`);
    await writeFile(linkedTempPath, canonicalJson(first), { mode: 0o600 });
    await link(linkedTempPath, linkedDestination);
    await writePhase3ActionMeasurement(first, firstExpected, { rootPath: linkedRoot, tempRootPath: linkedTemp });
    assert.deepEqual(await readdir(linkedTemp), []);
    assert.equal(await readFile(linkedDestination, "utf8"), canonicalJson(first));

    const linkedObservationBase = join(base, "linked-observation-recovery");
    const linkedObservationRoot = join(linkedObservationBase, "phase3-observations");
    const linkedObservationTemp = join(linkedObservationBase, ".phase3-marker-tmp");
    await Promise.all([
      privateDirectory(linkedObservationRoot),
      privateDirectory(linkedObservationTemp),
    ]);
    const linkedObservationTempPath = join(
      linkedObservationTemp,
      `${randomUUID()}.tmp`,
    );
    const linkedObservationDestination = join(
      linkedObservationRoot,
      "phase3-schema-verify.json",
    );
    await writeFile(linkedObservationTempPath, canonicalJson(schema), { mode: 0o600 });
    await link(linkedObservationTempPath, linkedObservationDestination);
    await writePhase3ObservationMarker(schema, currentSchemaExpected, {
      rootPath: linkedObservationRoot,
      tempRootPath: linkedObservationTemp,
    });
    assert.deepEqual(await readdir(linkedObservationTemp), []);
    assert.equal(
      await readFile(linkedObservationDestination, "utf8"),
      canonicalJson(schema),
    );

    const crossKindBase = join(base, "cross-kind-recovery");
    const crossKindActionRoot = join(crossKindBase, "phase3-action-measurements");
    const crossKindObservationRoot = join(crossKindBase, "phase3-observations");
    const crossKindTemp = join(crossKindBase, ".phase3-marker-tmp");
    await Promise.all([
      privateDirectory(crossKindActionRoot),
      privateDirectory(crossKindObservationRoot),
      privateDirectory(crossKindTemp),
    ]);
    const crossKindActionTemp = join(crossKindTemp, `${randomUUID()}.tmp`);
    const crossActionDestination = join(
      crossKindActionRoot,
      `${ACTION_IDS[0]}.json`,
    );
    await writeFile(crossKindActionTemp, canonicalJson(first), { mode: 0o600 });
    await link(crossKindActionTemp, crossActionDestination);
    await writePhase3ObservationMarker(fence, currentFenceExpected, {
      rootPath: crossKindObservationRoot,
      tempRootPath: crossKindTemp,
    });
    assert.deepEqual(await readdir(crossKindTemp), []);
    assert.equal(await readFile(crossActionDestination, "utf8"), canonicalJson(first));

    const reverseCrossKindBase = join(base, "reverse-cross-kind-recovery");
    const reverseActionRoot = join(
      reverseCrossKindBase,
      "phase3-action-measurements",
    );
    const reverseObservationRoot = join(reverseCrossKindBase, "phase3-observations");
    const reverseTempRoot = join(reverseCrossKindBase, ".phase3-marker-tmp");
    await Promise.all([
      privateDirectory(reverseActionRoot),
      privateDirectory(reverseObservationRoot),
      privateDirectory(reverseTempRoot),
    ]);
    const reverseObservationTemp = join(reverseTempRoot, `${randomUUID()}.tmp`);
    const reverseObservationDestination = join(
      reverseObservationRoot,
      "phase3-schema-verify.json",
    );
    await writeFile(reverseObservationTemp, canonicalJson(schema), { mode: 0o600 });
    await link(reverseObservationTemp, reverseObservationDestination);
    const finalAction = actionMarker(ACTION_IDS[7]);
    const finalActionExpected = expectedFor("current", allSnapshot);
    await writePhase3ActionMeasurement(finalAction, finalActionExpected, {
      rootPath: reverseActionRoot,
      tempRootPath: reverseTempRoot,
    });
    assert.deepEqual(await readdir(reverseTempRoot), []);
    assert.equal(
      await readFile(reverseObservationDestination, "utf8"),
      canonicalJson(schema),
    );

    const heldObservationBase = join(base, "held-observation-link");
    const heldObservationRoot = join(heldObservationBase, "phase3-observations");
    const heldObservationTemp = join(heldObservationBase, ".phase3-marker-tmp");
    await Promise.all([
      privateDirectory(heldObservationRoot),
      privateDirectory(heldObservationTemp),
    ]);
    const heldObservationDestination = join(
      heldObservationRoot,
      "phase3-schema-verify.json",
    );
    await writeFile(heldObservationDestination, canonicalJson(schema), { mode: 0o600 });
    await link(heldObservationDestination, join(heldObservationBase, "held.json"));
    await assert.rejects(
      () => writePhase3ObservationMarker(schema, currentSchemaExpected, {
        rootPath: heldObservationRoot,
        tempRootPath: heldObservationTemp,
      }),
      /hard-link|link count|installed|create-once/i,
    );

    const missingObservationParent = join(base, "missing-observation-parent");
    await assert.rejects(
      () => writePhase3ObservationMarker(schema, currentSchemaExpected, {
        rootPath: join(missingObservationParent, "phase3-observations"),
        tempRootPath: join(missingObservationParent, ".phase3-marker-tmp"),
      }),
      /ENOENT|parent|directory/i,
    );

    const crossActionBase = join(base, "cross-action-recovery");
    const crossActionRoot = join(crossActionBase, "actions");
    const crossActionTemp = join(crossActionBase, ".tmp");
    await Promise.all([privateDirectory(crossActionRoot), privateDirectory(crossActionTemp)]);
    const predecessorTemp = join(crossActionTemp, `${randomUUID()}.tmp`);
    await writeFile(predecessorTemp, canonicalJson(first), { mode: 0o600 });
    await link(predecessorTemp, join(crossActionRoot, `${ACTION_IDS[0]}.json`));
    const secondExpected = expectedFor(
      "current",
      journalSnapshot([ACTION_IDS[0], ACTION_IDS[1]], ACTION_IDS[1]),
    );
    await writePhase3ActionMeasurement(actionMarker(ACTION_IDS[1]), secondExpected, {
      rootPath: crossActionRoot,
      tempRootPath: crossActionTemp,
    });
    assert.deepEqual(await readdir(crossActionTemp), []);
    assert.deepEqual(
      (await readdir(crossActionRoot)).sort(),
      ACTION_IDS.slice(0, 2).map((actionId) => `${actionId}.json`).sort(),
    );

    const concurrentLinkBase = join(base, "concurrent-link-eexist");
    const concurrentLinkRoot = join(concurrentLinkBase, "actions");
    const concurrentLinkTemp = join(concurrentLinkBase, ".tmp");
    await Promise.all([privateDirectory(concurrentLinkRoot), privateDirectory(concurrentLinkTemp)]);
    const concurrentDestination = join(concurrentLinkRoot, `${ACTION_IDS[0]}.json`);
    const heldConcurrentLink = join(concurrentLinkBase, "held-writer-link.json");
    await writeFile(concurrentDestination, canonicalJson(first), { mode: 0o600 });
    await link(concurrentDestination, heldConcurrentLink);
    await assert.rejects(
      () => writePhase3ActionMeasurement(first, firstExpected, {
        rootPath: concurrentLinkRoot,
        tempRootPath: concurrentLinkTemp,
      }),
      /hard-link|link count|installed|create-once/i,
    );

    const dirtyBase = join(base, "dirty-recovery");
    const dirtyRoot = join(dirtyBase, "actions");
    const dirtyTemp = join(dirtyBase, ".tmp");
    await Promise.all([privateDirectory(dirtyRoot), privateDirectory(dirtyTemp)]);
    await writeFile(join(dirtyTemp, "unexpected.txt"), "x", { mode: 0o600 });
    await assert.rejects(
      () => writePhase3ActionMeasurement(first, firstExpected, { rootPath: dirtyRoot, tempRootPath: dirtyTemp }),
      /temporary|unexpected|UUID/i,
    );

    const excessiveBase = join(base, "excessive-recovery");
    const excessiveRoot = join(excessiveBase, "actions");
    const excessiveTemp = join(excessiveBase, ".tmp");
    await Promise.all([privateDirectory(excessiveRoot), privateDirectory(excessiveTemp)]);
    await Promise.all(
      Array.from({ length: 65 }, () =>
        writeFile(join(excessiveTemp, `${randomUUID()}.tmp`), "", { mode: 0o600 })),
    );
    await assert.rejects(
      () => writePhase3ActionMeasurement(first, firstExpected, {
        rootPath: excessiveRoot,
        tempRootPath: excessiveTemp,
      }),
      /entry|limit|64|exceed/i,
    );

    const wrongLinkBase = join(base, "wrong-link-recovery");
    const wrongLinkRoot = join(wrongLinkBase, "actions");
    const wrongLinkTemp = join(wrongLinkBase, ".tmp");
    await Promise.all([privateDirectory(wrongLinkRoot), privateDirectory(wrongLinkTemp)]);
    const wrongTempPath = join(wrongLinkTemp, `${randomUUID()}.tmp`);
    await writeFile(wrongTempPath, canonicalJson(first), { mode: 0o600 });
    await link(wrongTempPath, join(wrongLinkRoot, "unrelated-hard-link.json"));
    const wrongDestination = join(wrongLinkRoot, `${ACTION_IDS[0]}.json`);
    await writeFile(wrongDestination, canonicalJson(first), { mode: 0o600 });
    await link(wrongDestination, join(wrongLinkRoot, "second-unrelated-hard-link.json"));
    await assert.rejects(
      () => writePhase3ActionMeasurement(first, firstExpected, {
        rootPath: wrongLinkRoot,
        tempRootPath: wrongLinkTemp,
      }),
      /inode|destination|match/i,
    );

    for (const [label, marker] of [
      ["both-identities", { ...first, observationId: "phase3-schema-verify" }],
      ["neither-identity", { schemaVersion: 1 }],
    ] as const) {
      const identityBase = join(base, label);
      const identityRoot = join(identityBase, "phase3-observations");
      const identityTemp = join(identityBase, ".phase3-marker-tmp");
      await Promise.all([privateDirectory(identityRoot), privateDirectory(identityTemp)]);
      const identityTempPath = join(identityTemp, `${randomUUID()}.tmp`);
      await writeFile(identityTempPath, canonicalJson(marker), { mode: 0o600 });
      await link(identityTempPath, join(identityRoot, "held-linked-marker.json"));
      await assert.rejects(
        () => writePhase3ObservationMarker(schema, currentSchemaExpected, {
          rootPath: identityRoot,
          tempRootPath: identityTemp,
        }),
        /exactly one|identity|actionId|observationId/i,
      );
    }

    await assert.rejects(
      () => writePhase3ActionMeasurement(first, firstExpected, { rootPath: actionRoot } as never),
      /option|override|together|temporary/i,
    );
    await assert.rejects(
      () => writePhase3ActionMeasurement(first, firstExpected, {
        rootPath: "relative/actions",
        tempRootPath: "relative/.tmp",
      }),
      /absolute|override/i,
    );
    await assert.rejects(
      () => writePhase3ActionMeasurement(first, firstExpected, {
        rootPath: actionRoot,
        tempRootPath: join(actionRoot, ".tmp"),
      }),
      /sibling|parent|distinct/i,
    );
    await assert.rejects(
      () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: actionRoot, extra: true } as never),
      /option|unknown|field/i,
    );

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: resolve(base, "does-not-exist") }),
        /test|override|production/i,
      );
      await assert.rejects(
        () => writePhase3ActionMeasurement(first, firstExpected, {
          rootPath: actionRoot,
          tempRootPath: tempRoot,
        }),
        /test|override|production/i,
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }

    const symlinkFileRoot = join(base, "symlink-file-root");
    await privateDirectory(symlinkFileRoot);
    await expectSymlinkRejection(
      join(actionRoot, `${ACTION_IDS[0]}.json`),
      join(symlinkFileRoot, `${ACTION_IDS[0]}.json`),
      () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: symlinkFileRoot }),
      "file",
    );
    const symlinkDirectory = join(base, "symlink-directory");
    await expectSymlinkRejection(
      actionRoot,
      symlinkDirectory,
      () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: symlinkDirectory }),
      process.platform === "win32" ? "junction" : "dir",
    );

    if (process.platform !== "win32") {
      const permissiveRoot = join(base, "permissive");
      await privateDirectory(permissiveRoot);
      await writeFile(join(permissiveRoot, `${ACTION_IDS[0]}.json`), canonicalJson(first), { mode: 0o600 });
      await chmod(permissiveRoot, 0o755);
      await assert.rejects(
        () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, { rootPath: permissiveRoot }),
        /0700|mode|secure|private/i,
      );

      const permissiveFileRoot = join(base, "permissive-file");
      await privateDirectory(permissiveFileRoot);
      const permissiveFile = join(permissiveFileRoot, `${ACTION_IDS[0]}.json`);
      await writeFile(permissiveFile, canonicalJson(first), { mode: 0o600 });
      await chmod(permissiveFile, 0o644);
      await assert.rejects(
        () => readPhase3ActionMeasurement(ACTION_IDS[0], historicalExpected, {
          rootPath: permissiveFileRoot,
        }),
        /0600|mode|secure/i,
      );

      const permissiveObservationRoot = join(base, "permissive-observation-file");
      await privateDirectory(permissiveObservationRoot);
      const permissiveObservationFile = join(
        permissiveObservationRoot,
        "phase3-schema-verify.json",
      );
      await writeFile(permissiveObservationFile, canonicalJson(schema), { mode: 0o600 });
      await chmod(permissiveObservationFile, 0o644);
      await assert.rejects(
        () => readPhase3ObservationMarker(
          "phase3-schema-verify",
          historicalExpected,
          { rootPath: permissiveObservationRoot },
        ),
        /0600|mode|secure/i,
      );
    }

    const crossDeviceBase = join(base, "cross-device-publication");
    const crossDeviceRoot = join(crossDeviceBase, "phase3-observations");
    const crossDeviceTemp = join(crossDeviceBase, ".phase3-marker-tmp");
    await privateDirectory(crossDeviceBase);
    const originalLink = fsPromises.link;
    (fsPromises as { link: typeof link }).link = async () => {
      throw Object.assign(new Error("simulated cross-device link"), { code: "EXDEV" });
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => writePhase3ObservationMarker(schema, currentSchemaExpected, {
          rootPath: crossDeviceRoot,
          tempRootPath: crossDeviceTemp,
        }),
        /cross-device|hard-link|EXDEV/i,
      );
      assert.deepEqual(await readdir(crossDeviceRoot), []);
      assert.deepEqual(await readdir(crossDeviceTemp), []);
    } finally {
      (fsPromises as { link: typeof link }).link = originalLink;
      syncBuiltinESMExports();
    }

    const sourceBase = join(base, "runtime-sources");
    const sourceRoot = join(sourceBase, "phase3-sources");
    const sourceTempRoot = join(sourceBase, ".phase3-source-tmp");
    await privateDirectory(sourceBase);
    const sourceOptions = { rootPath: sourceRoot, tempRootPath: sourceTempRoot };
    const firstSourceValue = runtimeSourceValue("db-final", 1);
    const firstSourceWrite = await writePhase3RuntimeSource(
      "db-final",
      firstSourceValue,
      sourceOptions,
    );
    assert.equal(firstSourceWrite.sourceId, "db-final");
    assert.equal(firstSourceWrite.path, join(sourceRoot, "db-final.json"));
    assert.equal(firstSourceWrite.bytes, canonicalJson(firstSourceValue));
    assert.equal(firstSourceWrite.sha256, hash(firstSourceWrite.bytes));
    assert.deepEqual(firstSourceWrite.value, firstSourceValue);
    assertDeepFrozen(firstSourceWrite);
    assert.equal((await stat(firstSourceWrite.path)).nlink, 1);
    assert.deepEqual(await readdir(sourceTempRoot), []);

    const partialSourceRead = await readPhase3RuntimeSource("db-final", { rootPath: sourceRoot });
    assert.deepEqual(partialSourceRead, firstSourceWrite);
    assertDeepFrozen(partialSourceRead);
    await assert.rejects(
      () => readPhase3RuntimeSource("runtime-final", { rootPath: sourceRoot }),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        /missing/i.test((error as Error).message),
    );
    await assert.rejects(
      () => readPhase3RuntimeSources({ rootPath: sourceRoot }),
      /exact|five|missing|file set/i,
    );

    const idempotentSourceWrite = await writePhase3RuntimeSource(
      "db-final",
      firstSourceValue,
      sourceOptions,
    );
    assert.deepEqual(idempotentSourceWrite, firstSourceWrite);
    await assert.rejects(
      () => writePhase3RuntimeSource(
        "db-final",
        runtimeSourceValue("db-final", 2),
        sourceOptions,
      ),
      /conflict|create-once|identical|different/i,
    );
    assert.equal(await readFile(firstSourceWrite.path, "utf8"), canonicalJson(firstSourceValue));

    const invalidSourceIdentityBase = join(base, "runtime-source-invalid-document-identity");
    await privateDirectory(invalidSourceIdentityBase);
    const invalidSourceIdentityOptions = {
      rootPath: join(invalidSourceIdentityBase, "phase3-sources"),
      tempRootPath: join(invalidSourceIdentityBase, ".phase3-source-tmp"),
    };
    const dbSourceValue = runtimeSourceValue("db-final");
    const invalidDbSourceDocuments = [
      { ...dbSourceValue, schemaVersion: 2 },
      runtimeSourceValue("runtime-final"),
      { ...dbSourceValue, extra: true },
      { schemaVersion: 1, context: dbSourceValue.context },
      { ...dbSourceValue, context: [] },
      { ...dbSourceValue, database: [] },
    ];
    for (const invalidDocument of invalidDbSourceDocuments) {
      await assert.rejects(
        () => writePhase3RuntimeSource(
          "db-final",
          invalidDocument as never,
          invalidSourceIdentityOptions,
        ),
        /source|schema|identity|field|wrapper|context|database|record/i,
      );
    }
    assert.deepEqual(await readdir(invalidSourceIdentityBase), []);

    for (const [index, invalidDocument] of invalidDbSourceDocuments.entries()) {
      const invalidReadBase = join(base, `runtime-source-invalid-identity-read-${index}`);
      const invalidReadRoot = join(invalidReadBase, "phase3-sources");
      const invalidReadPath = join(invalidReadRoot, "db-final.json");
      await privateDirectory(invalidReadBase);
      await privateDirectory(invalidReadRoot);
      await writeFile(invalidReadPath, canonicalJson(invalidDocument), { mode: 0o600 });
      const invalidReadInode = (await stat(invalidReadPath, { bigint: true })).ino;
      await assert.rejects(
        () => readPhase3RuntimeSource("db-final", { rootPath: invalidReadRoot }),
        /source|schema|identity|field|wrapper|context|database|record/i,
      );
      assert.equal((await stat(invalidReadPath, { bigint: true })).ino, invalidReadInode);
      assert.equal(await readFile(invalidReadPath, "utf8"), canonicalJson(invalidDocument));
    }

    const sourceValues = Object.fromEntries(
      RUNTIME_SOURCE_IDS.map((sourceId, index) => [
        sourceId,
        sourceId === "db-final" ? firstSourceValue : runtimeSourceValue(sourceId, index + 1),
      ]),
    ) as Record<(typeof RUNTIME_SOURCE_IDS)[number], ReturnType<typeof runtimeSourceValue>>;
    for (const sourceId of RUNTIME_SOURCE_IDS.slice(1)) {
      await writePhase3RuntimeSource(sourceId, sourceValues[sourceId], sourceOptions);
    }
    assert.deepEqual(
      (await readdir(sourceRoot)).sort(),
      RUNTIME_SOURCE_IDS.map((sourceId) => `${sourceId}.json`).sort(),
    );
    const allSources = await readPhase3RuntimeSources({ rootPath: sourceRoot });
    assert.deepEqual(Object.keys(allSources), RUNTIME_SOURCE_IDS);
    assert.equal(allSources instanceof Map, false);
    for (const sourceId of RUNTIME_SOURCE_IDS) {
      const singular = await readPhase3RuntimeSource(sourceId, { rootPath: sourceRoot });
      assert.equal(singular.path, join(sourceRoot, `${sourceId}.json`));
      assert.deepEqual(Object.keys(allSources[sourceId]), ["value", "bytes", "sha256"]);
      assert.deepEqual(allSources[sourceId].value, sourceValues[sourceId]);
      assert.equal(allSources[sourceId].bytes, canonicalJson(sourceValues[sourceId]));
      assert.equal(allSources[sourceId].sha256, hash(allSources[sourceId].bytes));
    }
    assertDeepFrozen(allSources);
    assert.deepEqual(
      (await readPhase3RuntimeSource("db-final", { rootPath: sourceRoot })).value,
      firstSourceValue,
    );

    const originalIdentityLstat = fsPromises.lstat;
    let authenticatedRootLstats = 0;
    (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = (async (
      ...args: Parameters<typeof fsPromises.lstat>
    ) => {
      const status = await originalIdentityLstat(...args as Parameters<typeof originalIdentityLstat>);
      if (resolve(String(args[0])) !== resolve(sourceRoot)) return status;
      authenticatedRootLstats += 1;
      if (authenticatedRootLstats <= 2) return status;
      return new Proxy(status, {
        get(target, property) {
          if (property === "ino") return (target.ino as bigint) + 1n;
          const result = Reflect.get(target, property, target);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
    }) as typeof fsPromises.lstat;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => readPhase3RuntimeSource("db-final", { rootPath: sourceRoot }),
        /identity|changed|authentication/i,
      );
    } finally {
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = originalIdentityLstat;
      syncBuiltinESMExports();
    }

    const originalParentIdentityLstat = fsPromises.lstat;
    let authenticatedParentLstats = 0;
    (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = (async (
      ...args: Parameters<typeof fsPromises.lstat>
    ) => {
      const status = await originalParentIdentityLstat(
        ...args as Parameters<typeof originalParentIdentityLstat>
      );
      if (resolve(String(args[0])) !== resolve(sourceBase)) return status;
      authenticatedParentLstats += 1;
      if (authenticatedParentLstats <= 4) return status;
      return new Proxy(status, {
        get(target, property) {
          if (property === "ino") return (target.ino as bigint) + 1n;
          const result = Reflect.get(target, property, target);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
    }) as typeof fsPromises.lstat;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => readPhase3RuntimeSource("db-final", { rootPath: sourceRoot }),
        /parent|chain|identity|changed|authentication/i,
      );
    } finally {
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = originalParentIdentityLstat;
      syncBuiltinESMExports();
    }

    const writerIdentityBase = join(base, "runtime-source-writer-chain-identity");
    const writerIdentityRoot = join(writerIdentityBase, "phase3-sources");
    const writerIdentityTemp = join(writerIdentityBase, ".phase3-source-tmp");
    await privateDirectory(writerIdentityBase);
    const originalWriterIdentityLstat = fsPromises.lstat;
    let writerParentLstats = 0;
    (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = (async (
      ...args: Parameters<typeof fsPromises.lstat>
    ) => {
      const status = await originalWriterIdentityLstat(
        ...args as Parameters<typeof originalWriterIdentityLstat>
      );
      if (resolve(String(args[0])) !== resolve(writerIdentityBase)) return status;
      writerParentLstats += 1;
      if (writerParentLstats <= 10) return status;
      return new Proxy(status, {
        get(target, property) {
          if (property === "ino") return (target.ino as bigint) + 1n;
          const result = Reflect.get(target, property, target);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
    }) as typeof fsPromises.lstat;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => writePhase3RuntimeSource("capacity", runtimeSourceValue("capacity"), {
          rootPath: writerIdentityRoot,
          tempRootPath: writerIdentityTemp,
        }),
        /parent|chain|identity|changed|authentication/i,
      );
    } finally {
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = originalWriterIdentityLstat;
      syncBuiltinESMExports();
    }

    const unexpectedSourceEntry = join(sourceRoot, "unexpected.json");
    await writeFile(unexpectedSourceEntry, "{}", { mode: 0o600 });
    await assert.rejects(
      () => readPhase3RuntimeSource("db-final", { rootPath: sourceRoot }),
      /unexpected|allowed|file set|source root/i,
    );
    await assert.rejects(
      () => readPhase3RuntimeSources({ rootPath: sourceRoot }),
      /unexpected|exact|file set|source root/i,
    );
    await unlink(unexpectedSourceEntry);

    const heldSourcePath = join(base, "held-runtime-source.json");
    await link(join(sourceRoot, "db-final.json"), heldSourcePath);
    await assert.rejects(
      () => readPhase3RuntimeSource("db-final", { rootPath: sourceRoot }),
      /hard-link|link count|held/i,
    );
    await unlink(heldSourcePath);

    const sizeBase = join(base, "runtime-source-size");
    const sizeRoot = join(sizeBase, "phase3-sources");
    const sizeTemp = join(sizeBase, ".phase3-source-tmp");
    await privateDirectory(sizeBase);
    const sizeBaseValue = {
      schemaVersion: 1,
      context: {},
      capacity: { filler: "" },
    };
    const canonicalOverhead = Buffer.byteLength(canonicalJson(sizeBaseValue), "utf8");
    const exactSizeValue = {
      ...sizeBaseValue,
      capacity: { filler: "x".repeat(MAX_RUNTIME_SOURCE_BYTES - canonicalOverhead) },
    };
    assert.equal(Buffer.byteLength(canonicalJson(exactSizeValue), "utf8"), MAX_RUNTIME_SOURCE_BYTES);
    const exactSizeWrite = await writePhase3RuntimeSource("capacity", exactSizeValue, {
      rootPath: sizeRoot,
      tempRootPath: sizeTemp,
    });
    assert.equal(Buffer.byteLength(exactSizeWrite.bytes, "utf8"), MAX_RUNTIME_SOURCE_BYTES);

    const oversizedBase = join(base, "runtime-source-oversized");
    await privateDirectory(oversizedBase);
    const oversizedValue = {
      ...sizeBaseValue,
      capacity: { filler: "x".repeat(MAX_RUNTIME_SOURCE_BYTES - canonicalOverhead + 1) },
    };
    assert.equal(Buffer.byteLength(canonicalJson(oversizedValue), "utf8"), MAX_RUNTIME_SOURCE_BYTES + 1);
    await assert.rejects(
      () => writePhase3RuntimeSource("capacity", oversizedValue, {
        rootPath: join(oversizedBase, "phase3-sources"),
        tempRootPath: join(oversizedBase, ".phase3-source-tmp"),
      }),
      /128|size|large|byte/i,
    );
    assert.deepEqual(await readdir(oversizedBase), []);

    const multibyteBase = join(base, "runtime-source-multibyte");
    await privateDirectory(multibyteBase);
    const multibyteValue = {
      ...sizeBaseValue,
      capacity: {
        filler: "é".repeat(
          Math.floor((MAX_RUNTIME_SOURCE_BYTES - canonicalOverhead) / 2) + 1,
        ),
      },
    };
    assert.ok(canonicalJson(multibyteValue).length < MAX_RUNTIME_SOURCE_BYTES);
    assert.ok(Buffer.byteLength(canonicalJson(multibyteValue), "utf8") > MAX_RUNTIME_SOURCE_BYTES);
    await assert.rejects(
      () => writePhase3RuntimeSource("capacity", multibyteValue, {
        rootPath: join(multibyteBase, "phase3-sources"),
        tempRootPath: join(multibyteBase, ".phase3-source-tmp"),
      }),
      /128|size|large|byte/i,
    );

    const invalidInputBase = join(base, "runtime-source-invalid-input");
    await privateDirectory(invalidInputBase);
    const invalidInputOptions = {
      rootPath: join(invalidInputBase, "phase3-sources"),
      tempRootPath: join(invalidInputBase, ".phase3-source-tmp"),
    };
    const hiddenValue = { safe: true };
    Object.defineProperty(hiddenValue, "hidden", { value: 1, enumerable: false });
    const symbolValue = { safe: true } as Record<PropertyKey, unknown>;
    symbolValue[Symbol("hidden")] = true;
    let accessorInvoked = false;
    const accessorValue = { safe: true } as Record<string, unknown>;
    Object.defineProperty(accessorValue, "computed", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return 1;
      },
    });
    const sparse = [] as unknown[];
    sparse[1] = true;
    const propertyArray = [1] as unknown[] & { extra?: boolean };
    propertyArray.extra = true;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const forbiddenPrototypeKey = { safe: true } as Record<string, unknown>;
    Object.defineProperty(forbiddenPrototypeKey, "__proto__", {
      value: "blocked",
      enumerable: true,
    });
    for (const invalidValue of [
      [],
      hiddenValue,
      symbolValue,
      accessorValue,
      { nested: sparse },
      { nested: propertyArray },
      cycle,
      { missing: undefined },
      { huge: 1n },
      { callback: () => true },
      { invalid: Number.NaN },
      { date: new Date(0) },
      forbiddenPrototypeKey,
      { prototype: "blocked" },
      { constructor: "blocked" },
      { payload: "blocked" },
      { messages: ["blocked"] },
      { responseBody: "blocked" },
      { environment: { SAFE: "value" } },
      { url: "blocked" },
      { endpoint: "blocked" },
      { command: "blocked" },
      { sql: "blocked" },
      { token: "blocked" },
      { benign: "Bearer abcdefghijklmnop" },
      { benign: "TODO" },
      null,
    ]) {
      await assert.rejects(
        () => writePhase3RuntimeSource("runtime-final", invalidValue as never, invalidInputOptions),
        /source|object|field|array|cycle|finite|secret|placeholder|payload|message|body|environment|URL|endpoint|command|SQL|prototype|property|accessor|symbol/i,
      );
    }
    assert.equal(accessorInvoked, false);
    assert.deepEqual(await readdir(invalidInputBase), []);

    const embeddedPlaceholderCases = [
      ["TODO", "captured TODO evidence"],
      ["TBD", "captured (TBD) evidence"],
      ["UNKNOWN", "captured_UNKNOWN_evidence"],
      ["REDACTED", "captured REDACTED:evidence"],
      ["unicode-punctuation", "captured—TODO—evidence"],
      ["angle", "captured <replace-at-runtime> evidence"],
    ] as const;
    async function placeholderOutcome(operation: () => Promise<unknown>): Promise<string> {
      try {
        await operation();
        return "accepted";
      } catch (error: unknown) {
        const message = (error as Error).message;
        return /placeholder/i.test(message) ? "placeholder-rejected" : `unexpected:${message}`;
      }
    }
    const embeddedPlaceholderOutcomes = [];
    for (const [label, embedded] of embeddedPlaceholderCases) {
      const writerBase = join(base, `runtime-source-embedded-placeholder-writer-${label}`);
      await privateDirectory(writerBase);
      const writerOptions = {
        rootPath: join(writerBase, "phase3-sources"),
        tempRootPath: join(writerBase, ".phase3-source-tmp"),
      };
      const writerValue = {
        schemaVersion: 1,
        context: {},
        runtime: { evidenceState: embedded },
      };
      const writer = await placeholderOutcome(
        () => writePhase3RuntimeSource("runtime-final", writerValue, writerOptions),
      );

      const installedBase = join(base, `runtime-source-embedded-placeholder-installed-${label}`);
      const installedRoot = join(installedBase, "phase3-sources");
      const installedTemp = join(installedBase, ".phase3-source-tmp");
      await Promise.all([
        privateDirectory(installedBase),
        privateDirectory(installedRoot),
        privateDirectory(installedTemp),
      ]);
      const installedValue = {
        schemaVersion: 1,
        context: {},
        runtime: { evidenceState: embedded },
      };
      await writeFile(
        join(installedRoot, "runtime-final.json"),
        canonicalJson(installedValue),
        { mode: 0o600 },
      );
      const rawReader = await placeholderOutcome(
        () => readPhase3RuntimeSource("runtime-final", { rootPath: installedRoot }),
      );

      const existingRaceBase = join(
        base,
        `runtime-source-embedded-placeholder-existing-race-${label}`,
      );
      const existingRaceRoot = join(existingRaceBase, "phase3-sources");
      const existingRaceTemp = join(existingRaceBase, ".phase3-source-tmp");
      const existingRaceDestination = join(existingRaceRoot, "runtime-final.json");
      const existingRaceBytes = Buffer.from(canonicalJson(installedValue), "utf8");
      await privateDirectory(existingRaceBase);
      const originalExistingLink = fsPromises.link;
      let existingCreateOnceLinkInvocations = 0;
      let installedRaceInode: bigint | undefined;
      (fsPromises as { link: typeof link }).link = async (...args: Parameters<typeof link>) => {
        if (resolve(String(args[1])) !== resolve(existingRaceDestination)) {
          await originalExistingLink(...args);
          return;
        }
        existingCreateOnceLinkInvocations += 1;
        await writeFile(existingRaceDestination, existingRaceBytes, {
          flag: "wx",
          mode: 0o600,
        });
        installedRaceInode = (await stat(existingRaceDestination, { bigint: true })).ino;
        throw Object.assign(new Error("simulated create-once EEXIST race"), { code: "EEXIST" });
      };
      syncBuiltinESMExports();
      let existingCreateOnce;
      try {
        existingCreateOnce = await placeholderOutcome(
          () => writePhase3RuntimeSource("runtime-final", {
            schemaVersion: 1,
            context: {},
            runtime: { evidenceState: "captured complete evidence" },
          }, {
            rootPath: existingRaceRoot,
            tempRootPath: existingRaceTemp,
          }),
        );
      } finally {
        (fsPromises as { link: typeof link }).link = originalExistingLink;
        syncBuiltinESMExports();
      }
      assert.equal(existingCreateOnceLinkInvocations, 1);
      assert.deepEqual(await readFile(existingRaceDestination), existingRaceBytes);
      assert.equal(
        (await stat(existingRaceDestination, { bigint: true })).ino,
        installedRaceInode,
      );
      assert.deepEqual(await readdir(existingRaceRoot), ["runtime-final.json"]);
      assert.deepEqual(await readdir(existingRaceTemp), []);
      embeddedPlaceholderOutcomes.push({ label, writer, rawReader, existingCreateOnce });
    }

    const nearbyWordsBase = join(base, "runtime-source-placeholder-nearby-words");
    await privateDirectory(nearbyWordsBase);
    const nearbyWordsOptions = {
      rootPath: join(nearbyWordsBase, "phase3-sources"),
      tempRootPath: join(nearbyWordsBase, ".phase3-source-tmp"),
    };
    const nearbyWordsValue = {
      schemaVersion: 1,
      context: {},
      runtime: {
        domainValues: [
          "TODOist-worker",
          "TBDestination-worker",
          "unknownCount",
          "knownUNKNOWNs",
          "unredacted-field",
          "redactedAt",
          "éTODOé-worker",
          "e\u0301TODO\u0301-worker",
          "١TODO١-worker",
          "less-than < threshold",
          "greater-than > threshold",
        ],
      },
    };
    const nearbyWordsWrite = await writePhase3RuntimeSource(
      "runtime-final",
      nearbyWordsValue,
      nearbyWordsOptions,
    );
    assert.deepEqual(nearbyWordsWrite.value, nearbyWordsValue);
    assert.deepEqual(
      (await readPhase3RuntimeSource("runtime-final", {
        rootPath: nearbyWordsOptions.rootPath,
      })).value,
      nearbyWordsValue,
    );
    assert.deepEqual(
      embeddedPlaceholderOutcomes,
      embeddedPlaceholderCases.map(([label]) => ({
        label,
        writer: "placeholder-rejected",
        rawReader: "placeholder-rejected",
        existingCreateOnce: "placeholder-rejected",
      })),
    );

    const malformedSourceBase = join(base, "runtime-source-malformed");
    const malformedSourceRoot = join(malformedSourceBase, "phase3-sources");
    await privateDirectory(malformedSourceBase);
    await privateDirectory(malformedSourceRoot);
    const malformedSourcePath = join(malformedSourceRoot, "db-final.json");
    const malformedBytes: Array<string | Buffer> = [
      "",
      "{",
      '{"z":1,"a":2}',
      '{"safe":1,"safe":1}',
      Buffer.from([0xc3, 0x28]),
      canonicalJson({ token: "blocked" }),
      canonicalJson({ safe: "https://example.invalid" }),
      '{"__proto__":"blocked"}',
      "x".repeat(MAX_RUNTIME_SOURCE_BYTES + 1),
    ];
    for (const bytes of malformedBytes) {
      await writeFile(malformedSourcePath, bytes, { mode: 0o600 });
      await assert.rejects(
        () => readPhase3RuntimeSource("db-final", { rootPath: malformedSourceRoot }),
        /empty|JSON|UTF-8|canonical|duplicate|secret|URL|prototype|source|128|size/i,
      );
    }

    const blockingMemberBase = join(base, "runtime-source-blocking-member");
    const blockingMemberRoot = join(blockingMemberBase, "phase3-sources");
    const blockingMemberTemp = join(blockingMemberBase, ".phase3-source-tmp");
    await privateDirectory(blockingMemberBase);
    await privateDirectory(blockingMemberRoot);
    await writeFile(join(blockingMemberRoot, "db-final.json"), "{", { mode: 0o600 });
    await assert.rejects(
      () => writePhase3RuntimeSource("capacity", runtimeSourceValue("capacity"), {
        rootPath: blockingMemberRoot,
        tempRootPath: blockingMemberTemp,
      }),
      /JSON|canonical|source/i,
    );
    await assert.rejects(() => stat(join(blockingMemberRoot, "capacity.json")), /ENOENT/i);

    const missingReaderBase = join(base, "runtime-source-reader-no-create");
    const missingReaderRoot = join(missingReaderBase, "phase3-sources");
    await privateDirectory(missingReaderBase);
    await assert.rejects(
      () => readPhase3RuntimeSource("db-final", { rootPath: missingReaderRoot }),
      /ENOENT|directory|source root/i,
    );
    await assert.rejects(() => stat(missingReaderRoot), /ENOENT/i);

    await assert.rejects(
      () => writePhase3RuntimeSource("../db-final", firstSourceValue, sourceOptions),
      /source ID|invalid/i,
    );
    await assert.rejects(
      () => readPhase3RuntimeSource("unknown", { rootPath: sourceRoot }),
      /source ID|invalid/i,
    );
    await assert.rejects(
      () => (writePhase3RuntimeSource as never)("db-final", firstSourceValue, sourceOptions, true),
      /argument|extra/i,
    );
    await assert.rejects(
      () => (readPhase3RuntimeSource as never)("db-final", { rootPath: sourceRoot }, true),
      /argument|extra/i,
    );
    await assert.rejects(
      () => (readPhase3RuntimeSources as never)({ rootPath: sourceRoot }, true),
      /argument|extra/i,
    );
    await assert.rejects(
      () => writePhase3RuntimeSource("db-final", firstSourceValue, { rootPath: sourceRoot } as never),
      /override|together|temporary/i,
    );
    await assert.rejects(
      () => writePhase3RuntimeSource("db-final", firstSourceValue, {
        rootPath: "relative/sources",
        tempRootPath: "relative/temp",
      }),
      /absolute|override/i,
    );
    await assert.rejects(
      () => writePhase3RuntimeSource("db-final", firstSourceValue, {
        rootPath: sourceRoot,
        tempRootPath: join(sourceRoot, ".temp"),
      }),
      /sibling|parent|distinct/i,
    );
    await assert.rejects(
      () => readPhase3RuntimeSource("db-final", { rootPath: sourceRoot, extra: true } as never),
      /option|unknown|field/i,
    );

    const previousSourceNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        () => readPhase3RuntimeSource("db-final", { rootPath: sourceRoot }),
        /test|override|production/i,
      );
      await assert.rejects(
        () => writePhase3RuntimeSource("db-final", firstSourceValue, sourceOptions),
        /test|override|production/i,
      );
    } finally {
      process.env.NODE_ENV = previousSourceNodeEnv;
    }

    const sourceSymlinkBase = join(base, "runtime-source-symlink");
    await privateDirectory(sourceSymlinkBase);
    await expectSymlinkRejection(
      sourceRoot,
      join(sourceSymlinkBase, "phase3-sources"),
      () => readPhase3RuntimeSource("db-final", {
        rootPath: join(sourceSymlinkBase, "phase3-sources"),
      }),
      process.platform === "win32" ? "junction" : "dir",
    );
    if (process.platform !== "win32") {
      const permissiveSourceBase = join(base, "runtime-source-permissive-parent");
      await privateDirectory(permissiveSourceBase);
      await chmod(permissiveSourceBase, 0o755);
      await assert.rejects(
        () => writePhase3RuntimeSource("db-final", firstSourceValue, {
          rootPath: join(permissiveSourceBase, "phase3-sources"),
          tempRootPath: join(permissiveSourceBase, ".phase3-source-tmp"),
        }),
        /0700|mode|secure|private/i,
      );

      const permissiveSourceFileBase = join(base, "runtime-source-permissive-file");
      const permissiveSourceFileRoot = join(permissiveSourceFileBase, "phase3-sources");
      await privateDirectory(permissiveSourceFileBase);
      await privateDirectory(permissiveSourceFileRoot);
      const permissiveSourceFile = join(permissiveSourceFileRoot, "db-final.json");
      await writeFile(permissiveSourceFile, canonicalJson(firstSourceValue), { mode: 0o600 });
      await chmod(permissiveSourceFile, 0o644);
      await assert.rejects(
        () => readPhase3RuntimeSource("db-final", { rootPath: permissiveSourceFileRoot }),
        /0600|mode|secure/i,
      );

      if (typeof process.getuid === "function" && process.getuid() === 0) {
        const wrongOwnerSourceBase = join(base, "runtime-source-wrong-owner");
        const wrongOwnerSourceRoot = join(wrongOwnerSourceBase, "phase3-sources");
        await privateDirectory(wrongOwnerSourceBase);
        await privateDirectory(wrongOwnerSourceRoot);
        const wrongOwnerSourceFile = join(wrongOwnerSourceRoot, "db-final.json");
        await writeFile(wrongOwnerSourceFile, canonicalJson(firstSourceValue), { mode: 0o600 });
        await chown(wrongOwnerSourceFile, 1, 1);
        await assert.rejects(
          () => readPhase3RuntimeSource("db-final", { rootPath: wrongOwnerSourceRoot }),
          /owner|ownership/i,
        );
      }
    }

    const invalidRecoveryBase = join(base, "phase3-storage-recovery-invalid-options");
    await privateDirectory(invalidRecoveryBase);
    const invalidRuntimeRecoveryOptions = {
      rootPath: join(invalidRecoveryBase, "phase3-sources"),
      tempRootPath: join(invalidRecoveryBase, ".phase3-source-tmp"),
    };
    const invalidCheckpointRecoveryOptions = {
      rootPath: join(invalidRecoveryBase, "phase3-capacity-observation"),
      tempRootPath: join(invalidRecoveryBase, ".phase3-capacity-observation-tmp"),
    };
    await assert.rejects(
      () => (recoverPhase3RuntimeSourceStorage as never)(undefined),
      /argument|option|undefined/i,
    );
    await assert.rejects(
      () => (recoverPhase3CapacityObservationCheckpointStorage as never)(undefined),
      /argument|option|undefined/i,
    );
    await assert.rejects(
      () => (recoverPhase3RuntimeSourceStorage as never)(invalidRuntimeRecoveryOptions, true),
      /argument|extra/i,
    );
    await assert.rejects(
      () => (recoverPhase3CapacityObservationCheckpointStorage as never)(
        invalidCheckpointRecoveryOptions,
        true,
      ),
      /argument|extra/i,
    );
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: invalidRuntimeRecoveryOptions.rootPath,
      } as never),
      /override|together|temporary/i,
    );
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: invalidCheckpointRecoveryOptions.rootPath,
      } as never),
      /override|together|temporary/i,
    );
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: "relative/sources",
        tempRootPath: "relative/temp",
      }),
      /absolute|override/i,
    );
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: "relative/checkpoint",
        tempRootPath: "relative/temp",
      }),
      /absolute|override/i,
    );
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: invalidRuntimeRecoveryOptions.rootPath,
        tempRootPath: join(invalidRuntimeRecoveryOptions.rootPath, ".temp"),
      }),
      /sibling|parent|distinct/i,
    );
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: invalidCheckpointRecoveryOptions.rootPath,
        tempRootPath: join(invalidCheckpointRecoveryOptions.rootPath, ".temp"),
      }),
      /sibling|parent|distinct/i,
    );
    const hiddenRecoveryOptions = { ...invalidRuntimeRecoveryOptions };
    Object.defineProperty(hiddenRecoveryOptions, "hidden", { value: true, enumerable: false });
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage(hiddenRecoveryOptions as never),
      /option|enumerable|field/i,
    );
    const previousRecoveryNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        () => recoverPhase3RuntimeSourceStorage(invalidRuntimeRecoveryOptions),
        /test|override|production/i,
      );
      await assert.rejects(
        () => recoverPhase3CapacityObservationCheckpointStorage(
          invalidCheckpointRecoveryOptions,
        ),
        /test|override|production/i,
      );
    } finally {
      process.env.NODE_ENV = previousRecoveryNodeEnv;
    }
    assert.deepEqual(await readdir(invalidRecoveryBase), []);

    const freshRecoveryBase = join(base, "phase3-storage-recovery-fresh-run");
    await privateDirectory(freshRecoveryBase);
    await recoverPhase3RuntimeSourceStorage({
      rootPath: join(freshRecoveryBase, "phase3-sources"),
      tempRootPath: join(freshRecoveryBase, ".phase3-source-tmp"),
    });
    await recoverPhase3CapacityObservationCheckpointStorage({
      rootPath: join(freshRecoveryBase, "phase3-capacity-observation"),
      tempRootPath: join(freshRecoveryBase, ".phase3-capacity-observation-tmp"),
    });
    assert.deepEqual(await readdir(freshRecoveryBase), []);

    for (const [label, recover, rootName, tempName] of [
      [
        "runtime-root-only",
        recoverPhase3RuntimeSourceStorage,
        "phase3-sources",
        ".phase3-source-tmp",
      ],
      [
        "checkpoint-root-only",
        recoverPhase3CapacityObservationCheckpointStorage,
        "phase3-capacity-observation",
        ".phase3-capacity-observation-tmp",
      ],
    ] as const) {
      const oneRootBase = join(base, `phase3-storage-recovery-${label}`);
      const oneRoot = join(oneRootBase, rootName);
      const missingTemp = join(oneRootBase, tempName);
      await privateDirectory(oneRootBase);
      await privateDirectory(oneRoot);
      await recover({ rootPath: oneRoot, tempRootPath: missingTemp });
      assert.deepEqual(await readdir(oneRoot), []);
      await assert.rejects(() => stat(missingTemp), /ENOENT/i);
      assert.deepEqual(await readdir(oneRootBase), [rootName]);
    }

    for (const [label, recover, rootName, tempName, winnerName, winnerValue] of [
      [
        "runtime-nonempty-root-only",
        recoverPhase3RuntimeSourceStorage,
        "phase3-sources",
        ".phase3-source-tmp",
        "db-final.json",
        runtimeSourceValue("db-final"),
      ],
      [
        "checkpoint-nonempty-root-only",
        recoverPhase3CapacityObservationCheckpointStorage,
        "phase3-capacity-observation",
        ".phase3-capacity-observation-tmp",
        "capacity-observation.json",
        capacityObservationCheckpointValue(1),
      ],
    ] as const) {
      const nonemptyRootBase = join(base, `phase3-storage-recovery-${label}`);
      const nonemptyRoot = join(nonemptyRootBase, rootName);
      const missingTemp = join(nonemptyRootBase, tempName);
      const winner = join(nonemptyRoot, winnerName);
      const winnerBytes = canonicalJson(winnerValue);
      await privateDirectory(nonemptyRootBase);
      await privateDirectory(nonemptyRoot);
      await writeFile(winner, winnerBytes, { mode: 0o600 });
      const winnerInode = (await stat(winner, { bigint: true })).ino;
      await assert.rejects(
        () => recover({ rootPath: nonemptyRoot, tempRootPath: missingTemp }),
        /nonempty|incomplete|both roots|root pair|missing/i,
      );
      assert.equal((await stat(winner, { bigint: true })).ino, winnerInode);
      assert.equal(await readFile(winner, "utf8"), winnerBytes);
      await assert.rejects(() => stat(missingTemp), /ENOENT/i);
    }

    for (const [label, recover, rootName, tempName] of [
      [
        "runtime-temp-only",
        recoverPhase3RuntimeSourceStorage,
        "phase3-sources",
        ".phase3-source-tmp",
      ],
      [
        "checkpoint-temp-only",
        recoverPhase3CapacityObservationCheckpointStorage,
        "phase3-capacity-observation",
        ".phase3-capacity-observation-tmp",
      ],
    ] as const) {
      const oneTempBase = join(base, `phase3-storage-recovery-${label}`);
      const missingRoot = join(oneTempBase, rootName);
      const oneTemp = join(oneTempBase, tempName);
      await privateDirectory(oneTempBase);
      await privateDirectory(oneTemp);
      await assert.rejects(
        () => recover({ rootPath: missingRoot, tempRootPath: oneTemp }),
        /exactly one|incomplete|both roots|root pair|missing/i,
      );
      assert.deepEqual(await readdir(oneTempBase), [tempName]);
    }

    const recoveryCrossDeviceBase = join(base, "phase3-storage-recovery-cross-device");
    const recoveryCrossRuntimeRoot = join(recoveryCrossDeviceBase, "phase3-sources");
    const recoveryCrossRuntimeTemp = join(recoveryCrossDeviceBase, ".phase3-source-tmp");
    const recoveryCrossCheckpointRoot = join(
      recoveryCrossDeviceBase,
      "phase3-capacity-observation",
    );
    const recoveryCrossCheckpointTemp = join(
      recoveryCrossDeviceBase,
      ".phase3-capacity-observation-tmp",
    );
    await Promise.all([
      privateDirectory(recoveryCrossDeviceBase),
      privateDirectory(recoveryCrossRuntimeRoot),
      privateDirectory(recoveryCrossRuntimeTemp),
      privateDirectory(recoveryCrossCheckpointRoot),
      privateDirectory(recoveryCrossCheckpointTemp),
    ]);
    const recoveryCrossRuntimeOrphan = join(
      recoveryCrossRuntimeTemp,
      `db-final.${randomUUID()}.tmp`,
    );
    const recoveryCrossCheckpointOrphan = join(
      recoveryCrossCheckpointTemp,
      `capacity-observation.${randomUUID()}.tmp`,
    );
    await writeFile(recoveryCrossRuntimeOrphan, "partial", { mode: 0o600 });
    await writeFile(recoveryCrossCheckpointOrphan, "partial", { mode: 0o600 });
    const recoveryCrossDeviceLstat = fsPromises.lstat;
    const crossDeviceTempPaths = new Set([
      resolve(recoveryCrossRuntimeTemp),
      resolve(recoveryCrossCheckpointTemp),
    ]);
    (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = (async (
      ...args: Parameters<typeof fsPromises.lstat>
    ) => {
      const status = await recoveryCrossDeviceLstat(
        ...args as Parameters<typeof recoveryCrossDeviceLstat>
      );
      if (!crossDeviceTempPaths.has(resolve(String(args[0])))) return status;
      return new Proxy(status, {
        get(target, property) {
          if (property === "dev") return (target.dev as bigint) + 1n;
          const result = Reflect.get(target, property, target);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
    }) as typeof fsPromises.lstat;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => recoverPhase3RuntimeSourceStorage({
          rootPath: recoveryCrossRuntimeRoot,
          tempRootPath: recoveryCrossRuntimeTemp,
        }),
        /cross-device|device|hard-link/i,
      );
      await assert.rejects(
        () => recoverPhase3CapacityObservationCheckpointStorage({
          rootPath: recoveryCrossCheckpointRoot,
          tempRootPath: recoveryCrossCheckpointTemp,
        }),
        /cross-device|device|hard-link/i,
      );
    } finally {
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = recoveryCrossDeviceLstat;
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(recoveryCrossRuntimeOrphan, "utf8"), "partial");
    assert.equal(await readFile(recoveryCrossCheckpointOrphan, "utf8"), "partial");

    const recoverySymlinkBase = join(base, "phase3-storage-recovery-symlink-temp");
    const recoverySymlinkTarget = join(recoverySymlinkBase, "actual-temp");
    const recoverySymlinkRuntimeRoot = join(recoverySymlinkBase, "phase3-sources");
    const recoverySymlinkRuntimeTemp = join(recoverySymlinkBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(recoverySymlinkBase),
      privateDirectory(recoverySymlinkTarget),
      privateDirectory(recoverySymlinkRuntimeRoot),
    ]);
    await expectSymlinkRejection(
      recoverySymlinkTarget,
      recoverySymlinkRuntimeTemp,
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: recoverySymlinkRuntimeRoot,
        tempRootPath: recoverySymlinkRuntimeTemp,
      }),
      process.platform === "win32" ? "junction" : "dir",
    );

    const orphanSourceBase = join(base, "runtime-source-orphan-recovery");
    const orphanSourceRoot = join(orphanSourceBase, "phase3-sources");
    const orphanSourceTemp = join(orphanSourceBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(orphanSourceBase),
      privateDirectory(orphanSourceRoot),
      privateDirectory(orphanSourceTemp),
    ]);
    for (const [index, sourceId] of RUNTIME_SOURCE_IDS.entries()) {
      const orphanBytes = index === 0
        ? ""
        : index === 1
          ? "partial"
          : index === 2
            ? "x".repeat(MAX_RUNTIME_SOURCE_BYTES + 1)
            : canonicalJson(runtimeSourceValue(sourceId));
      await writeFile(
        join(orphanSourceTemp, `${sourceId}.${randomUUID()}.tmp`),
        orphanBytes,
        { mode: 0o600 },
      );
    }
    await recoverPhase3RuntimeSourceStorage({
      rootPath: orphanSourceRoot,
      tempRootPath: orphanSourceTemp,
    });
    assert.deepEqual(await readdir(orphanSourceTemp), []);
    assert.deepEqual(await readdir(orphanSourceRoot), []);

    const atomicMalformedSourceBase = join(base, "runtime-source-atomic-malformed-set");
    const atomicMalformedSourceRoot = join(atomicMalformedSourceBase, "phase3-sources");
    const atomicMalformedSourceTemp = join(atomicMalformedSourceBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(atomicMalformedSourceBase),
      privateDirectory(atomicMalformedSourceRoot),
      privateDirectory(atomicMalformedSourceTemp),
    ]);
    const atomicSourceOrphan = join(
      atomicMalformedSourceTemp,
      "db-final.00000000-0000-4000-8000-000000000001.tmp",
    );
    const atomicSourceMalformed = join(
      atomicMalformedSourceTemp,
      "zz-later-malformed.tmp",
    );
    await writeFile(atomicSourceOrphan, "partial", { mode: 0o600 });
    await writeFile(atomicSourceMalformed, "malformed", { mode: 0o600 });
    const atomicSourceOrphanStatus = await stat(atomicSourceOrphan, { bigint: true });
    const atomicSourceMalformedStatus = await stat(atomicSourceMalformed, { bigint: true });
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: atomicMalformedSourceRoot,
        tempRootPath: atomicMalformedSourceTemp,
      }),
      /prefix|source-qualified|unexpected|temporary/i,
    );
    assert.equal(
      (await stat(atomicSourceOrphan, { bigint: true })).ino,
      atomicSourceOrphanStatus.ino,
    );
    assert.equal(
      (await stat(atomicSourceMalformed, { bigint: true })).ino,
      atomicSourceMalformedStatus.ino,
    );
    assert.deepEqual(
      (await readdir(atomicMalformedSourceTemp)).sort(),
      ["db-final.00000000-0000-4000-8000-000000000001.tmp", "zz-later-malformed.tmp"],
    );

    const atomicMismatchSourceBase = join(base, "runtime-source-atomic-mismatched-set");
    const atomicMismatchSourceRoot = join(atomicMismatchSourceBase, "phase3-sources");
    const atomicMismatchSourceTemp = join(atomicMismatchSourceBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(atomicMismatchSourceBase),
      privateDirectory(atomicMismatchSourceRoot),
      privateDirectory(atomicMismatchSourceTemp),
    ]);
    const atomicValidSourceTemp = join(
      atomicMismatchSourceTemp,
      "db-final.00000000-0000-4000-8000-000000000001.tmp",
    );
    const atomicValidSourceDestination = join(atomicMismatchSourceRoot, "db-final.json");
    const atomicValidSourceBytes = canonicalJson(runtimeSourceValue("db-final"));
    await writeFile(atomicValidSourceTemp, atomicValidSourceBytes, { mode: 0o600 });
    await link(atomicValidSourceTemp, atomicValidSourceDestination);
    const atomicValidSourceInode = (
      await stat(atomicValidSourceDestination, { bigint: true })
    ).ino;
    const atomicMismatchSourceDestination = join(
      atomicMismatchSourceRoot,
      "runtime-final.json",
    );
    const atomicMismatchWinnerBytes = canonicalJson(runtimeSourceValue("runtime-final"));
    await writeFile(atomicMismatchSourceDestination, atomicMismatchWinnerBytes, {
      mode: 0o600,
    });
    const atomicMismatchWinnerInode = (
      await stat(atomicMismatchSourceDestination, { bigint: true })
    ).ino;
    const atomicMismatchSourceTempPath = join(
      atomicMismatchSourceTemp,
      "runtime-final.ffffffff-ffff-4fff-bfff-ffffffffffff.tmp",
    );
    const atomicMismatchTempBytes = canonicalJson(runtimeSourceValue("runtime-final", 2));
    await writeFile(atomicMismatchSourceTempPath, atomicMismatchTempBytes, { mode: 0o600 });
    const atomicMismatchHeld = join(atomicMismatchSourceBase, "unrelated-held.json");
    await link(atomicMismatchSourceTempPath, atomicMismatchHeld);
    const atomicMismatchTempInode = (
      await stat(atomicMismatchSourceTempPath, { bigint: true })
    ).ino;
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: atomicMismatchSourceRoot,
        tempRootPath: atomicMismatchSourceTemp,
      }),
      /inode|destination|match|linked|link count/i,
    );
    assert.equal((await stat(atomicValidSourceTemp, { bigint: true })).nlink, 2n);
    assert.equal((await stat(atomicValidSourceDestination, { bigint: true })).nlink, 2n);
    assert.equal(
      (await stat(atomicValidSourceDestination, { bigint: true })).ino,
      atomicValidSourceInode,
    );
    assert.equal(
      (await stat(atomicMismatchSourceDestination, { bigint: true })).ino,
      atomicMismatchWinnerInode,
    );
    assert.equal(
      (await stat(atomicMismatchSourceTempPath, { bigint: true })).ino,
      atomicMismatchTempInode,
    );
    assert.equal(await readFile(atomicValidSourceDestination, "utf8"), atomicValidSourceBytes);
    assert.equal(
      await readFile(atomicMismatchSourceDestination, "utf8"),
      atomicMismatchWinnerBytes,
    );
    assert.equal(await readFile(atomicMismatchSourceTempPath, "utf8"), atomicMismatchTempBytes);

    const linkedSourceBase = join(base, "runtime-source-linked-recovery");
    const linkedSourceRoot = join(linkedSourceBase, "phase3-sources");
    const linkedSourceTemp = join(linkedSourceBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(linkedSourceBase),
      privateDirectory(linkedSourceRoot),
      privateDirectory(linkedSourceTemp),
    ]);
    const linkedSourceInodes = new Map<string, bigint>();
    const linkedSourceBytes = new Map<string, string>();
    for (const [index, sourceId] of RUNTIME_SOURCE_IDS.entries()) {
      const value = runtimeSourceValue(sourceId, index + 1);
      const temporary = join(linkedSourceTemp, `${sourceId}.${randomUUID()}.tmp`);
      const destination = join(linkedSourceRoot, `${sourceId}.json`);
      const bytes = canonicalJson(value);
      await writeFile(temporary, bytes, { mode: 0o600 });
      await link(temporary, destination);
      linkedSourceInodes.set(sourceId, (await stat(destination, { bigint: true })).ino);
      linkedSourceBytes.set(sourceId, bytes);
    }
    await recoverPhase3RuntimeSourceStorage({
      rootPath: linkedSourceRoot,
      tempRootPath: linkedSourceTemp,
    });
    assert.deepEqual(await readdir(linkedSourceTemp), []);
    for (const sourceId of RUNTIME_SOURCE_IDS) {
      const destination = join(linkedSourceRoot, `${sourceId}.json`);
      const recoveredStatus = await stat(destination, { bigint: true });
      assert.equal(recoveredStatus.nlink, 1n);
      assert.equal(recoveredStatus.ino, linkedSourceInodes.get(sourceId));
      assert.equal(await readFile(destination, "utf8"), linkedSourceBytes.get(sourceId));
    }
    await recoverPhase3RuntimeSourceStorage({
      rootPath: linkedSourceRoot,
      tempRootPath: linkedSourceTemp,
    });
    for (const sourceId of RUNTIME_SOURCE_IDS) {
      const destination = join(linkedSourceRoot, `${sourceId}.json`);
      assert.equal((await stat(destination, { bigint: true })).ino, linkedSourceInodes.get(sourceId));
      assert.equal(await readFile(destination, "utf8"), linkedSourceBytes.get(sourceId));
    }

    const invalidLinkedSourceDocuments = [
      ["wrong-schema", { ...runtimeSourceValue("db-final"), schemaVersion: 2 }],
      ["wrong-field", { schemaVersion: 1, context: {}, runtime: {} }],
      ["extra-field", { ...runtimeSourceValue("db-final"), extra: true }],
      ["missing-field", { schemaVersion: 1, context: {} }],
      ["cross-id", runtimeSourceValue("runtime-final")],
    ] as const;
    for (const [label, invalidDocument] of invalidLinkedSourceDocuments) {
      const invalidLinkedBase = join(base, `runtime-source-linked-identity-${label}`);
      const invalidLinkedRoot = join(invalidLinkedBase, "phase3-sources");
      const invalidLinkedTemp = join(invalidLinkedBase, ".phase3-source-tmp");
      const invalidLinkedDestination = join(invalidLinkedRoot, "db-final.json");
      const invalidLinkedTemporary = join(
        invalidLinkedTemp,
        `db-final.${randomUUID()}.tmp`,
      );
      const invalidLinkedBytes = canonicalJson(invalidDocument);
      await Promise.all([
        privateDirectory(invalidLinkedBase),
        privateDirectory(invalidLinkedRoot),
        privateDirectory(invalidLinkedTemp),
      ]);
      await writeFile(invalidLinkedTemporary, invalidLinkedBytes, { mode: 0o600 });
      await link(invalidLinkedTemporary, invalidLinkedDestination);
      const invalidLinkedInode = (
        await stat(invalidLinkedDestination, { bigint: true })
      ).ino;
      await assert.rejects(
        () => recoverPhase3RuntimeSourceStorage({
          rootPath: invalidLinkedRoot,
          tempRootPath: invalidLinkedTemp,
        }),
        /source|schema|identity|field|wrapper|database|record/i,
      );
      assert.equal((await stat(invalidLinkedTemporary, { bigint: true })).nlink, 2n);
      assert.equal((await stat(invalidLinkedDestination, { bigint: true })).nlink, 2n);
      assert.equal(
        (await stat(invalidLinkedTemporary, { bigint: true })).ino,
        invalidLinkedInode,
      );
      assert.equal(
        (await stat(invalidLinkedDestination, { bigint: true })).ino,
        invalidLinkedInode,
      );
      assert.equal(await readFile(invalidLinkedTemporary, "utf8"), invalidLinkedBytes);
      assert.equal(await readFile(invalidLinkedDestination, "utf8"), invalidLinkedBytes);
    }

    const wrongPrefixBase = join(base, "runtime-source-wrong-prefix");
    const wrongPrefixRoot = join(wrongPrefixBase, "phase3-sources");
    const wrongPrefixTemp = join(wrongPrefixBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(wrongPrefixBase),
      privateDirectory(wrongPrefixRoot),
      privateDirectory(wrongPrefixTemp),
    ]);
    await writeFile(join(wrongPrefixTemp, `${randomUUID()}.tmp`), "partial", { mode: 0o600 });
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: wrongPrefixRoot,
        tempRootPath: wrongPrefixTemp,
      }),
      /prefix|source-qualified|unexpected|temporary/i,
    );

    const wrongDestinationBase = join(base, "runtime-source-wrong-destination");
    const wrongDestinationRoot = join(wrongDestinationBase, "phase3-sources");
    const wrongDestinationTemp = join(wrongDestinationBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(wrongDestinationBase),
      privateDirectory(wrongDestinationRoot),
      privateDirectory(wrongDestinationTemp),
    ]);
    const wrongDestinationPath = join(wrongDestinationRoot, "db-final.json");
    await writeFile(wrongDestinationPath, canonicalJson(firstSourceValue), { mode: 0o600 });
    const wrongDestinationWinnerInode = (
      await stat(wrongDestinationPath, { bigint: true })
    ).ino;
    const wrongDestinationWinnerBytes = await readFile(wrongDestinationPath, "utf8");
    const wrongDestinationTemporary = join(
      wrongDestinationTemp,
      `db-final.${randomUUID()}.tmp`,
    );
    await writeFile(
      wrongDestinationTemporary,
      canonicalJson(runtimeSourceValue("db-final", 2)),
      { mode: 0o600 },
    );
    await link(wrongDestinationTemporary, join(wrongDestinationBase, "unrelated-held.json"));
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: wrongDestinationRoot,
        tempRootPath: wrongDestinationTemp,
      }),
      /inode|destination|match|linked/i,
    );
    assert.equal((await stat(wrongDestinationTemporary)).nlink, 2);
    assert.equal(
      (await stat(wrongDestinationPath, { bigint: true })).ino,
      wrongDestinationWinnerInode,
    );
    assert.equal(await readFile(wrongDestinationPath, "utf8"), wrongDestinationWinnerBytes);

    const malformedLinkedSourceBase = join(base, "runtime-source-malformed-linked-pair");
    const malformedLinkedSourceRoot = join(malformedLinkedSourceBase, "phase3-sources");
    const malformedLinkedSourceTemp = join(malformedLinkedSourceBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(malformedLinkedSourceBase),
      privateDirectory(malformedLinkedSourceRoot),
      privateDirectory(malformedLinkedSourceTemp),
    ]);
    const malformedLinkedSourceTemporary = join(
      malformedLinkedSourceTemp,
      `db-final.${randomUUID()}.tmp`,
    );
    const malformedLinkedSourceDestination = join(malformedLinkedSourceRoot, "db-final.json");
    await writeFile(malformedLinkedSourceTemporary, "{", { mode: 0o600 });
    await link(malformedLinkedSourceTemporary, malformedLinkedSourceDestination);
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: malformedLinkedSourceRoot,
        tempRootPath: malformedLinkedSourceTemp,
      }),
      /JSON|canonical|source/i,
    );
    assert.equal((await stat(malformedLinkedSourceTemporary)).nlink, 2);
    assert.equal((await stat(malformedLinkedSourceDestination)).nlink, 2);
    assert.equal(await readFile(malformedLinkedSourceDestination, "utf8"), "{");

    const excessiveSourceBase = join(base, "runtime-source-excessive-temp");
    const excessiveSourceRoot = join(excessiveSourceBase, "phase3-sources");
    const excessiveSourceTemp = join(excessiveSourceBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(excessiveSourceBase),
      privateDirectory(excessiveSourceRoot),
      privateDirectory(excessiveSourceTemp),
    ]);
    await Promise.all(Array.from({ length: 65 }, (_, index) =>
      writeFile(
        join(
          excessiveSourceTemp,
          `${RUNTIME_SOURCE_IDS[index % RUNTIME_SOURCE_IDS.length]}.${randomUUID()}.tmp`,
        ),
        "",
        { mode: 0o600 },
      )));
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: excessiveSourceRoot,
        tempRootPath: excessiveSourceTemp,
      }),
      /entry|limit|64|exceed/i,
    );

    const heldLinkedBase = join(base, "runtime-source-held-linked");
    const heldLinkedRoot = join(heldLinkedBase, "phase3-sources");
    const heldLinkedTemp = join(heldLinkedBase, ".phase3-source-tmp");
    await Promise.all([
      privateDirectory(heldLinkedBase),
      privateDirectory(heldLinkedRoot),
      privateDirectory(heldLinkedTemp),
    ]);
    const heldLinkedTemporary = join(heldLinkedTemp, `db-final.${randomUUID()}.tmp`);
    await writeFile(heldLinkedTemporary, canonicalJson(firstSourceValue), { mode: 0o600 });
    await link(heldLinkedTemporary, join(heldLinkedRoot, "db-final.json"));
    await link(heldLinkedTemporary, join(heldLinkedBase, "third-link.json"));
    await assert.rejects(
      () => recoverPhase3RuntimeSourceStorage({
        rootPath: heldLinkedRoot,
        tempRootPath: heldLinkedTemp,
      }),
      /hard-link|link count|two|held/i,
    );
    assert.equal((await stat(heldLinkedTemporary)).nlink, 3);

    const sourceExdevBase = join(base, "runtime-source-exdev");
    const sourceExdevRoot = join(sourceExdevBase, "phase3-sources");
    const sourceExdevTemp = join(sourceExdevBase, ".phase3-source-tmp");
    await privateDirectory(sourceExdevBase);
    const originalSourceLink = fsPromises.link;
    (fsPromises as { link: typeof link }).link = async () => {
      throw Object.assign(new Error("simulated source EXDEV"), { code: "EXDEV" });
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => writePhase3RuntimeSource("db-final", firstSourceValue, {
          rootPath: sourceExdevRoot,
          tempRootPath: sourceExdevTemp,
        }),
        /cross-device|hard-link|EXDEV/i,
      );
      assert.deepEqual(await readdir(sourceExdevRoot), []);
      assert.deepEqual(await readdir(sourceExdevTemp), []);
    } finally {
      (fsPromises as { link: typeof link }).link = originalSourceLink;
      syncBuiltinESMExports();
    }

    const postLinkBase = join(base, "runtime-source-post-link-failure");
    const postLinkRoot = join(postLinkBase, "phase3-sources");
    const postLinkTemp = join(postLinkBase, ".phase3-source-tmp");
    const postLinkDestination = join(postLinkRoot, "db-final.json");
    await privateDirectory(postLinkBase);
    const originalPostLink = fsPromises.link;
    const originalPostLstat = fsPromises.lstat;
    let destinationLinked = false;
    let postLinkFailureInjected = false;
    (fsPromises as { link: typeof link }).link = async (...args: Parameters<typeof link>) => {
      await originalPostLink(...args);
      if (resolve(String(args[1])) === resolve(postLinkDestination)) destinationLinked = true;
    };
    (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = async (...args: Parameters<typeof fsPromises.lstat>) => {
      if (
        destinationLinked &&
        !postLinkFailureInjected &&
        resolve(String(args[0])) === resolve(postLinkDestination)
      ) {
        postLinkFailureInjected = true;
        throw Object.assign(new Error("injected post-link authentication failure"), { code: "EIO" });
      }
      return originalPostLstat(...args as Parameters<typeof originalPostLstat>);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => writePhase3RuntimeSource("db-final", firstSourceValue, {
          rootPath: postLinkRoot,
          tempRootPath: postLinkTemp,
        }),
        /post-link|authentication|EIO|injected/i,
      );
    } finally {
      (fsPromises as { link: typeof link }).link = originalPostLink;
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = originalPostLstat;
      syncBuiltinESMExports();
    }
    const preservedTemps = await readdir(postLinkTemp);
    assert.equal(preservedTemps.length, 1);
    assert.match(preservedTemps[0], /^db-final\.[0-9a-f-]{36}\.tmp$/);
    assert.equal((await stat(join(postLinkTemp, preservedTemps[0]))).nlink, 2);
    assert.equal((await stat(postLinkDestination)).nlink, 2);
    const postLinkInode = (await stat(postLinkDestination, { bigint: true })).ino;
    await recoverPhase3RuntimeSourceStorage({
      rootPath: postLinkRoot,
      tempRootPath: postLinkTemp,
    });
    assert.deepEqual(await readdir(postLinkTemp), []);
    const recoveredPostLink = await stat(postLinkDestination, { bigint: true });
    assert.equal(recoveredPostLink.nlink, 1n);
    assert.equal(recoveredPostLink.ino, postLinkInode);
    assert.equal(await readFile(postLinkDestination, "utf8"), canonicalJson(firstSourceValue));

    const checkpointBase = join(base, "capacity-observation-checkpoint");
    const checkpointRoot = join(checkpointBase, "phase3-capacity-observation");
    const checkpointTempRoot = join(checkpointBase, ".phase3-capacity-observation-tmp");
    const checkpointPath = join(checkpointRoot, "capacity-observation.json");
    const checkpointOptions = {
      rootPath: checkpointRoot,
      tempRootPath: checkpointTempRoot,
    };
    const firstCheckpointValue = capacityObservationCheckpointValue(1);
    await privateDirectory(checkpointBase);
    const firstCheckpointWrite = await writePhase3CapacityObservationCheckpoint(
      firstCheckpointValue,
      checkpointOptions,
    );
    assert.deepEqual(Object.keys(firstCheckpointWrite), ["path", "value", "bytes", "sha256"]);
    assert.equal(firstCheckpointWrite.path, checkpointPath);
    assert.deepEqual(firstCheckpointWrite.value, firstCheckpointValue);
    assert.equal(firstCheckpointWrite.bytes, canonicalJson(firstCheckpointValue));
    assert.equal(firstCheckpointWrite.sha256, hash(firstCheckpointWrite.bytes));
    assertDeepFrozen(firstCheckpointWrite);
    assert.equal((await stat(checkpointPath)).nlink, 1);
    assert.deepEqual(await readdir(checkpointRoot), ["capacity-observation.json"]);
    assert.deepEqual(await readdir(checkpointTempRoot), []);

    const checkpointRead = await readPhase3CapacityObservationCheckpoint({
      rootPath: checkpointRoot,
    });
    assert.deepEqual(checkpointRead, firstCheckpointWrite);
    assertDeepFrozen(checkpointRead);
    const idempotentCheckpoint = await writePhase3CapacityObservationCheckpoint(
      firstCheckpointValue,
      checkpointOptions,
    );
    assert.deepEqual(idempotentCheckpoint, firstCheckpointWrite);
    await assert.rejects(
      () => writePhase3CapacityObservationCheckpoint(
        capacityObservationCheckpointValue(2),
        checkpointOptions,
      ),
      /conflict|create-once|identical|different/i,
    );
    assert.equal(await readFile(checkpointPath, "utf8"), canonicalJson(firstCheckpointValue));

    const missingCheckpointBase = join(base, "capacity-checkpoint-reader-no-create");
    const missingCheckpointRoot = join(missingCheckpointBase, "phase3-capacity-observation");
    await privateDirectory(missingCheckpointBase);
    await assert.rejects(
      () => readPhase3CapacityObservationCheckpoint({ rootPath: missingCheckpointRoot }),
      /ENOENT|directory|checkpoint root/i,
    );
    await assert.rejects(() => stat(missingCheckpointRoot), /ENOENT/i);

    const invalidCheckpointBase = join(base, "capacity-checkpoint-invalid-input");
    await privateDirectory(invalidCheckpointBase);
    const invalidCheckpointOptions = {
      rootPath: join(invalidCheckpointBase, "phase3-capacity-observation"),
      tempRootPath: join(invalidCheckpointBase, ".phase3-capacity-observation-tmp"),
    };
    const hiddenCheckpoint = capacityObservationCheckpointValue(1);
    Object.defineProperty(hiddenCheckpoint, "hidden", { value: true, enumerable: false });
    const symbolCheckpoint = capacityObservationCheckpointValue(1) as Record<PropertyKey, unknown>;
    symbolCheckpoint[Symbol("hidden")] = true;
    let checkpointAccessorInvoked = false;
    const accessorCheckpoint = capacityObservationCheckpointValue(1) as Record<string, unknown>;
    Object.defineProperty(accessorCheckpoint, "context", {
      enumerable: true,
      get() {
        checkpointAccessorInvoked = true;
        return {};
      },
    });
    for (const invalid of [
      { ...firstCheckpointValue, schemaVersion: 2 },
      { context: firstCheckpointValue.context, capacity: firstCheckpointValue.capacity,
        productionObserver: firstCheckpointValue.productionObserver },
      { ...firstCheckpointValue, extra: true },
      { ...firstCheckpointValue, context: null },
      { ...firstCheckpointValue, capacity: [] },
      { ...firstCheckpointValue, productionObserver: false },
      { ...firstCheckpointValue, capacity: { token: "blocked" } },
      { ...firstCheckpointValue, capacity: { endpoint: "blocked" } },
      hiddenCheckpoint,
      symbolCheckpoint,
      accessorCheckpoint,
      null,
    ]) {
      await assert.rejects(
        () => writePhase3CapacityObservationCheckpoint(invalid as never, invalidCheckpointOptions),
        /checkpoint|shape|field|schema|plain|object|secret|token|endpoint|enumerable|accessor|symbol/i,
      );
    }
    assert.equal(checkpointAccessorInvoked, false);
    assert.deepEqual(await readdir(invalidCheckpointBase), []);

    const checkpointSizeBaseValue = {
      schemaVersion: 1,
      context: {},
      capacity: { filler: "" },
      productionObserver: {},
    };
    const checkpointSizeOverhead = Buffer.byteLength(
      canonicalJson(checkpointSizeBaseValue),
      "utf8",
    );
    const exactCheckpointValue = {
      ...checkpointSizeBaseValue,
      capacity: { filler: "x".repeat(MAX_RUNTIME_SOURCE_BYTES - checkpointSizeOverhead) },
    };
    assert.equal(
      Buffer.byteLength(canonicalJson(exactCheckpointValue), "utf8"),
      MAX_RUNTIME_SOURCE_BYTES,
    );
    const exactCheckpointBase = join(base, "capacity-checkpoint-exact-size");
    await privateDirectory(exactCheckpointBase);
    const exactCheckpointWrite = await writePhase3CapacityObservationCheckpoint(
      exactCheckpointValue,
      {
        rootPath: join(exactCheckpointBase, "phase3-capacity-observation"),
        tempRootPath: join(exactCheckpointBase, ".phase3-capacity-observation-tmp"),
      },
    );
    assert.equal(Buffer.byteLength(exactCheckpointWrite.bytes, "utf8"), MAX_RUNTIME_SOURCE_BYTES);
    const oversizedCheckpointBase = join(base, "capacity-checkpoint-oversized");
    await privateDirectory(oversizedCheckpointBase);
    await assert.rejects(
      () => writePhase3CapacityObservationCheckpoint(
        {
          ...checkpointSizeBaseValue,
          capacity: {
            filler: "x".repeat(MAX_RUNTIME_SOURCE_BYTES - checkpointSizeOverhead + 1),
          },
        },
        {
          rootPath: join(oversizedCheckpointBase, "phase3-capacity-observation"),
          tempRootPath: join(oversizedCheckpointBase, ".phase3-capacity-observation-tmp"),
        },
      ),
      /128|size|large|byte/i,
    );
    assert.deepEqual(await readdir(oversizedCheckpointBase), []);

    const malformedCheckpointBase = join(base, "capacity-checkpoint-malformed");
    const malformedCheckpointRoot = join(malformedCheckpointBase, "phase3-capacity-observation");
    await privateDirectory(malformedCheckpointBase);
    await privateDirectory(malformedCheckpointRoot);
    const malformedCheckpointPath = join(malformedCheckpointRoot, "capacity-observation.json");
    const malformedCheckpointBytes: Array<string | Buffer> = [
      "",
      "{",
      '{"z":1,"a":2}',
      '{"schemaVersion":1,"context":{},"capacity":{},"capacity":{},"productionObserver":{}}',
      Buffer.from([0xc3, 0x28]),
      canonicalJson({ ...firstCheckpointValue, extra: true }),
      canonicalJson({ ...firstCheckpointValue, schemaVersion: 2 }),
      canonicalJson({ ...firstCheckpointValue, capacity: { token: "blocked" } }),
      "x".repeat(MAX_RUNTIME_SOURCE_BYTES + 1),
    ];
    for (const bytes of malformedCheckpointBytes) {
      await writeFile(malformedCheckpointPath, bytes, { mode: 0o600 });
      await assert.rejects(
        () => readPhase3CapacityObservationCheckpoint({ rootPath: malformedCheckpointRoot }),
        /empty|JSON|UTF-8|canonical|duplicate|checkpoint|shape|schema|secret|token|128|size/i,
      );
    }

    await assert.rejects(
      () => (writePhase3CapacityObservationCheckpoint as never)(
        firstCheckpointValue,
        checkpointOptions,
        true,
      ),
      /argument|extra/i,
    );
    await assert.rejects(
      () => (readPhase3CapacityObservationCheckpoint as never)(
        { rootPath: checkpointRoot },
        true,
      ),
      /argument|extra/i,
    );
    await assert.rejects(
      () => (writePhase3CapacityObservationCheckpoint as never)(firstCheckpointValue, undefined),
      /argument|option|undefined/i,
    );
    await assert.rejects(
      () => (readPhase3CapacityObservationCheckpoint as never)(undefined),
      /argument|option|undefined/i,
    );
    await assert.rejects(
      () => writePhase3CapacityObservationCheckpoint(
        firstCheckpointValue,
        { rootPath: checkpointRoot } as never,
      ),
      /override|together|temporary/i,
    );
    await assert.rejects(
      () => writePhase3CapacityObservationCheckpoint(firstCheckpointValue, {
        rootPath: "relative/checkpoint",
        tempRootPath: "relative/temp",
      }),
      /absolute|override/i,
    );
    await assert.rejects(
      () => writePhase3CapacityObservationCheckpoint(firstCheckpointValue, {
        rootPath: checkpointRoot,
        tempRootPath: join(checkpointRoot, ".temp"),
      }),
      /sibling|parent|distinct/i,
    );
    await assert.rejects(
      () => readPhase3CapacityObservationCheckpoint({
        rootPath: checkpointRoot,
        extra: true,
      } as never),
      /option|unknown|field/i,
    );

    const previousCheckpointNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        () => readPhase3CapacityObservationCheckpoint({ rootPath: checkpointRoot }),
        /test|override|production/i,
      );
      await assert.rejects(
        () => writePhase3CapacityObservationCheckpoint(firstCheckpointValue, checkpointOptions),
        /test|override|production/i,
      );
    } finally {
      process.env.NODE_ENV = previousCheckpointNodeEnv;
    }

    const checkpointUnexpectedEntry = join(checkpointRoot, "unexpected.json");
    await writeFile(checkpointUnexpectedEntry, "{}", { mode: 0o600 });
    await assert.rejects(
      () => readPhase3CapacityObservationCheckpoint({ rootPath: checkpointRoot }),
      /unexpected|checkpoint root|entry/i,
    );
    await unlink(checkpointUnexpectedEntry);

    const checkpointHeldPath = join(checkpointBase, "held-capacity-observation.json");
    await link(checkpointPath, checkpointHeldPath);
    await assert.rejects(
      () => readPhase3CapacityObservationCheckpoint({ rootPath: checkpointRoot }),
      /hard-link|link count|invalid/i,
    );
    await unlink(checkpointHeldPath);

    const checkpointSymlinkBase = join(base, "capacity-checkpoint-symlink-root");
    await privateDirectory(checkpointSymlinkBase);
    await expectSymlinkRejection(
      checkpointRoot,
      join(checkpointSymlinkBase, "phase3-capacity-observation"),
      () => readPhase3CapacityObservationCheckpoint({
        rootPath: join(checkpointSymlinkBase, "phase3-capacity-observation"),
      }),
      process.platform === "win32" ? "junction" : "dir",
    );

    if (process.platform !== "win32") {
      const permissiveCheckpointBase = join(base, "capacity-checkpoint-permissive-parent");
      await privateDirectory(permissiveCheckpointBase);
      await chmod(permissiveCheckpointBase, 0o755);
      await assert.rejects(
        () => writePhase3CapacityObservationCheckpoint(firstCheckpointValue, {
          rootPath: join(permissiveCheckpointBase, "phase3-capacity-observation"),
          tempRootPath: join(permissiveCheckpointBase, ".phase3-capacity-observation-tmp"),
        }),
        /0700|mode|secure|private/i,
      );

      const permissiveCheckpointFileBase = join(base, "capacity-checkpoint-permissive-file");
      const permissiveCheckpointFileRoot = join(
        permissiveCheckpointFileBase,
        "phase3-capacity-observation",
      );
      await privateDirectory(permissiveCheckpointFileBase);
      await privateDirectory(permissiveCheckpointFileRoot);
      const permissiveCheckpointFile = join(
        permissiveCheckpointFileRoot,
        "capacity-observation.json",
      );
      await writeFile(permissiveCheckpointFile, canonicalJson(firstCheckpointValue), {
        mode: 0o600,
      });
      await chmod(permissiveCheckpointFile, 0o644);
      await assert.rejects(
        () => readPhase3CapacityObservationCheckpoint({
          rootPath: permissiveCheckpointFileRoot,
        }),
        /0600|mode|secure/i,
      );
    }

    const orphanCheckpointBase = join(base, "capacity-checkpoint-orphan-recovery");
    const orphanCheckpointRoot = join(orphanCheckpointBase, "phase3-capacity-observation");
    const orphanCheckpointTemp = join(orphanCheckpointBase, ".phase3-capacity-observation-tmp");
    await Promise.all([
      privateDirectory(orphanCheckpointBase),
      privateDirectory(orphanCheckpointRoot),
      privateDirectory(orphanCheckpointTemp),
    ]);
    await Promise.all(["", "partial", "x".repeat(MAX_RUNTIME_SOURCE_BYTES + 1)].map((bytes) =>
      writeFile(
        join(orphanCheckpointTemp, `capacity-observation.${randomUUID()}.tmp`),
        bytes,
        { mode: 0o600 },
      )));
    await recoverPhase3CapacityObservationCheckpointStorage({
      rootPath: orphanCheckpointRoot,
      tempRootPath: orphanCheckpointTemp,
    });
    assert.deepEqual(await readdir(orphanCheckpointTemp), []);
    assert.deepEqual(await readdir(orphanCheckpointRoot), []);

    const atomicMalformedCheckpointBase = join(
      base,
      "capacity-checkpoint-atomic-malformed-set",
    );
    const atomicMalformedCheckpointRoot = join(
      atomicMalformedCheckpointBase,
      "phase3-capacity-observation",
    );
    const atomicMalformedCheckpointTemp = join(
      atomicMalformedCheckpointBase,
      ".phase3-capacity-observation-tmp",
    );
    await Promise.all([
      privateDirectory(atomicMalformedCheckpointBase),
      privateDirectory(atomicMalformedCheckpointRoot),
      privateDirectory(atomicMalformedCheckpointTemp),
    ]);
    const atomicCheckpointOrphan = join(
      atomicMalformedCheckpointTemp,
      "capacity-observation.00000000-0000-4000-8000-000000000001.tmp",
    );
    const atomicCheckpointMalformed = join(
      atomicMalformedCheckpointTemp,
      "zz-later-malformed.tmp",
    );
    await writeFile(atomicCheckpointOrphan, "partial", { mode: 0o600 });
    await writeFile(atomicCheckpointMalformed, "malformed", { mode: 0o600 });
    const atomicCheckpointOrphanInode = (
      await stat(atomicCheckpointOrphan, { bigint: true })
    ).ino;
    const atomicCheckpointMalformedInode = (
      await stat(atomicCheckpointMalformed, { bigint: true })
    ).ino;
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: atomicMalformedCheckpointRoot,
        tempRootPath: atomicMalformedCheckpointTemp,
      }),
      /prefix|checkpoint-qualified|unexpected|temporary/i,
    );
    assert.equal(
      (await stat(atomicCheckpointOrphan, { bigint: true })).ino,
      atomicCheckpointOrphanInode,
    );
    assert.equal(
      (await stat(atomicCheckpointMalformed, { bigint: true })).ino,
      atomicCheckpointMalformedInode,
    );

    const atomicMismatchCheckpointBase = join(
      base,
      "capacity-checkpoint-atomic-mismatched-set",
    );
    const atomicMismatchCheckpointRoot = join(
      atomicMismatchCheckpointBase,
      "phase3-capacity-observation",
    );
    const atomicMismatchCheckpointTemp = join(
      atomicMismatchCheckpointBase,
      ".phase3-capacity-observation-tmp",
    );
    await Promise.all([
      privateDirectory(atomicMismatchCheckpointBase),
      privateDirectory(atomicMismatchCheckpointRoot),
      privateDirectory(atomicMismatchCheckpointTemp),
    ]);
    const atomicCheckpointWinner = join(
      atomicMismatchCheckpointRoot,
      "capacity-observation.json",
    );
    const atomicCheckpointWinnerBytes = canonicalJson(firstCheckpointValue);
    await writeFile(atomicCheckpointWinner, atomicCheckpointWinnerBytes, { mode: 0o600 });
    const atomicCheckpointWinnerInode = (
      await stat(atomicCheckpointWinner, { bigint: true })
    ).ino;
    const atomicCheckpointValidOrphan = join(
      atomicMismatchCheckpointTemp,
      "capacity-observation.00000000-0000-4000-8000-000000000001.tmp",
    );
    await writeFile(atomicCheckpointValidOrphan, "partial", { mode: 0o600 });
    const atomicCheckpointValidOrphanInode = (
      await stat(atomicCheckpointValidOrphan, { bigint: true })
    ).ino;
    const atomicCheckpointMismatchTemp = join(
      atomicMismatchCheckpointTemp,
      "capacity-observation.ffffffff-ffff-4fff-bfff-ffffffffffff.tmp",
    );
    const atomicCheckpointMismatchBytes = canonicalJson(
      capacityObservationCheckpointValue(2),
    );
    await writeFile(atomicCheckpointMismatchTemp, atomicCheckpointMismatchBytes, {
      mode: 0o600,
    });
    const atomicCheckpointHeld = join(atomicMismatchCheckpointBase, "unrelated-held.json");
    await link(atomicCheckpointMismatchTemp, atomicCheckpointHeld);
    const atomicCheckpointMismatchInode = (
      await stat(atomicCheckpointMismatchTemp, { bigint: true })
    ).ino;
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: atomicMismatchCheckpointRoot,
        tempRootPath: atomicMismatchCheckpointTemp,
      }),
      /inode|destination|match|linked|link count/i,
    );
    assert.equal(
      (await stat(atomicCheckpointValidOrphan, { bigint: true })).ino,
      atomicCheckpointValidOrphanInode,
    );
    assert.equal(
      (await stat(atomicCheckpointMismatchTemp, { bigint: true })).ino,
      atomicCheckpointMismatchInode,
    );
    assert.equal(
      (await stat(atomicCheckpointWinner, { bigint: true })).ino,
      atomicCheckpointWinnerInode,
    );
    assert.equal(await readFile(atomicCheckpointWinner, "utf8"), atomicCheckpointWinnerBytes);
    assert.equal(
      await readFile(atomicCheckpointMismatchTemp, "utf8"),
      atomicCheckpointMismatchBytes,
    );

    const linkedCheckpointBase = join(base, "capacity-checkpoint-linked-recovery");
    const linkedCheckpointRoot = join(linkedCheckpointBase, "phase3-capacity-observation");
    const linkedCheckpointTemp = join(
      linkedCheckpointBase,
      ".phase3-capacity-observation-tmp",
    );
    const linkedCheckpointPath = join(linkedCheckpointRoot, "capacity-observation.json");
    await Promise.all([
      privateDirectory(linkedCheckpointBase),
      privateDirectory(linkedCheckpointRoot),
      privateDirectory(linkedCheckpointTemp),
    ]);
    const linkedCheckpointTemporary = join(
      linkedCheckpointTemp,
      `capacity-observation.${randomUUID()}.tmp`,
    );
    await writeFile(linkedCheckpointTemporary, canonicalJson(firstCheckpointValue), {
      mode: 0o600,
    });
    await link(linkedCheckpointTemporary, linkedCheckpointPath);
    const linkedCheckpointInode = (await stat(linkedCheckpointPath, { bigint: true })).ino;
    await recoverPhase3CapacityObservationCheckpointStorage({
      rootPath: linkedCheckpointRoot,
      tempRootPath: linkedCheckpointTemp,
    });
    assert.deepEqual(await readdir(linkedCheckpointTemp), []);
    assert.equal((await stat(linkedCheckpointPath, { bigint: true })).nlink, 1n);
    assert.equal((await stat(linkedCheckpointPath, { bigint: true })).ino, linkedCheckpointInode);
    assert.equal(await readFile(linkedCheckpointPath, "utf8"), canonicalJson(firstCheckpointValue));
    await recoverPhase3CapacityObservationCheckpointStorage({
      rootPath: linkedCheckpointRoot,
      tempRootPath: linkedCheckpointTemp,
    });
    assert.equal((await stat(linkedCheckpointPath, { bigint: true })).ino, linkedCheckpointInode);
    assert.equal(await readFile(linkedCheckpointPath, "utf8"), canonicalJson(firstCheckpointValue));

    const mismatchedCheckpointBase = join(base, "capacity-checkpoint-mismatched-linked-pair");
    const mismatchedCheckpointRoot = join(
      mismatchedCheckpointBase,
      "phase3-capacity-observation",
    );
    const mismatchedCheckpointTemp = join(
      mismatchedCheckpointBase,
      ".phase3-capacity-observation-tmp",
    );
    const mismatchedCheckpointPath = join(
      mismatchedCheckpointRoot,
      "capacity-observation.json",
    );
    await Promise.all([
      privateDirectory(mismatchedCheckpointBase),
      privateDirectory(mismatchedCheckpointRoot),
      privateDirectory(mismatchedCheckpointTemp),
    ]);
    await writeFile(mismatchedCheckpointPath, canonicalJson(firstCheckpointValue), {
      mode: 0o600,
    });
    const mismatchedCheckpointWinnerInode = (
      await stat(mismatchedCheckpointPath, { bigint: true })
    ).ino;
    const mismatchedCheckpointWinnerBytes = await readFile(mismatchedCheckpointPath, "utf8");
    const mismatchedCheckpointTemporary = join(
      mismatchedCheckpointTemp,
      `capacity-observation.${randomUUID()}.tmp`,
    );
    await writeFile(
      mismatchedCheckpointTemporary,
      canonicalJson(capacityObservationCheckpointValue(2)),
      { mode: 0o600 },
    );
    await link(
      mismatchedCheckpointTemporary,
      join(mismatchedCheckpointBase, "unrelated-held.json"),
    );
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: mismatchedCheckpointRoot,
        tempRootPath: mismatchedCheckpointTemp,
      }),
      /inode|destination|match|linked|link count/i,
    );
    assert.equal((await stat(mismatchedCheckpointTemporary)).nlink, 2);
    assert.equal(
      (await stat(mismatchedCheckpointPath, { bigint: true })).ino,
      mismatchedCheckpointWinnerInode,
    );
    assert.equal(await readFile(mismatchedCheckpointPath, "utf8"), mismatchedCheckpointWinnerBytes);

    const malformedLinkedCheckpointBase = join(
      base,
      "capacity-checkpoint-malformed-linked-pair",
    );
    const malformedLinkedCheckpointRoot = join(
      malformedLinkedCheckpointBase,
      "phase3-capacity-observation",
    );
    const malformedLinkedCheckpointTemp = join(
      malformedLinkedCheckpointBase,
      ".phase3-capacity-observation-tmp",
    );
    const malformedLinkedCheckpointPath = join(
      malformedLinkedCheckpointRoot,
      "capacity-observation.json",
    );
    await Promise.all([
      privateDirectory(malformedLinkedCheckpointBase),
      privateDirectory(malformedLinkedCheckpointRoot),
      privateDirectory(malformedLinkedCheckpointTemp),
    ]);
    const malformedLinkedCheckpointTemporary = join(
      malformedLinkedCheckpointTemp,
      `capacity-observation.${randomUUID()}.tmp`,
    );
    await writeFile(malformedLinkedCheckpointTemporary, "{", { mode: 0o600 });
    await link(malformedLinkedCheckpointTemporary, malformedLinkedCheckpointPath);
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: malformedLinkedCheckpointRoot,
        tempRootPath: malformedLinkedCheckpointTemp,
      }),
      /JSON|canonical|checkpoint/i,
    );
    assert.equal((await stat(malformedLinkedCheckpointTemporary)).nlink, 2);
    assert.equal((await stat(malformedLinkedCheckpointPath)).nlink, 2);
    assert.equal(await readFile(malformedLinkedCheckpointPath, "utf8"), "{");

    const wrongCheckpointTempBase = join(base, "capacity-checkpoint-wrong-temp");
    const wrongCheckpointTempRoot = join(wrongCheckpointTempBase, "phase3-capacity-observation");
    const wrongCheckpointTemp = join(
      wrongCheckpointTempBase,
      ".phase3-capacity-observation-tmp",
    );
    await Promise.all([
      privateDirectory(wrongCheckpointTempBase),
      privateDirectory(wrongCheckpointTempRoot),
      privateDirectory(wrongCheckpointTemp),
    ]);
    await writeFile(join(wrongCheckpointTemp, `${randomUUID()}.tmp`), "partial", {
      mode: 0o600,
    });
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: wrongCheckpointTempRoot,
        tempRootPath: wrongCheckpointTemp,
      }),
      /prefix|checkpoint-qualified|unexpected|temporary/i,
    );

    const heldCheckpointTempBase = join(base, "capacity-checkpoint-held-linked");
    const heldCheckpointTempRoot = join(
      heldCheckpointTempBase,
      "phase3-capacity-observation",
    );
    const heldCheckpointTemp = join(
      heldCheckpointTempBase,
      ".phase3-capacity-observation-tmp",
    );
    await Promise.all([
      privateDirectory(heldCheckpointTempBase),
      privateDirectory(heldCheckpointTempRoot),
      privateDirectory(heldCheckpointTemp),
    ]);
    const heldCheckpointTemporary = join(
      heldCheckpointTemp,
      `capacity-observation.${randomUUID()}.tmp`,
    );
    await writeFile(heldCheckpointTemporary, canonicalJson(firstCheckpointValue), {
      mode: 0o600,
    });
    await link(
      heldCheckpointTemporary,
      join(heldCheckpointTempRoot, "capacity-observation.json"),
    );
    await link(heldCheckpointTemporary, join(heldCheckpointTempBase, "third-link.json"));
    await assert.rejects(
      () => recoverPhase3CapacityObservationCheckpointStorage({
        rootPath: heldCheckpointTempRoot,
        tempRootPath: heldCheckpointTemp,
      }),
      /hard-link|link count|two|held/i,
    );
    assert.equal((await stat(heldCheckpointTemporary)).nlink, 3);

    const checkpointExdevBase = join(base, "capacity-checkpoint-exdev");
    const checkpointExdevRoot = join(checkpointExdevBase, "phase3-capacity-observation");
    const checkpointExdevTemp = join(
      checkpointExdevBase,
      ".phase3-capacity-observation-tmp",
    );
    await privateDirectory(checkpointExdevBase);
    const originalCheckpointLink = fsPromises.link;
    (fsPromises as { link: typeof link }).link = async () => {
      throw Object.assign(new Error("simulated checkpoint EXDEV"), { code: "EXDEV" });
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => writePhase3CapacityObservationCheckpoint(firstCheckpointValue, {
          rootPath: checkpointExdevRoot,
          tempRootPath: checkpointExdevTemp,
        }),
        /cross-device|hard-link|EXDEV/i,
      );
      assert.deepEqual(await readdir(checkpointExdevRoot), []);
      assert.deepEqual(await readdir(checkpointExdevTemp), []);
    } finally {
      (fsPromises as { link: typeof link }).link = originalCheckpointLink;
      syncBuiltinESMExports();
    }

    const checkpointPostLinkBase = join(base, "capacity-checkpoint-post-link-failure");
    const checkpointPostLinkRoot = join(
      checkpointPostLinkBase,
      "phase3-capacity-observation",
    );
    const checkpointPostLinkTemp = join(
      checkpointPostLinkBase,
      ".phase3-capacity-observation-tmp",
    );
    const checkpointPostLinkPath = join(
      checkpointPostLinkRoot,
      "capacity-observation.json",
    );
    await privateDirectory(checkpointPostLinkBase);
    const originalCheckpointPostLink = fsPromises.link;
    const originalCheckpointPostLinkLstat = fsPromises.lstat;
    let checkpointDestinationLinked = false;
    let checkpointPostLinkFailureInjected = false;
    (fsPromises as { link: typeof link }).link = async (...args: Parameters<typeof link>) => {
      await originalCheckpointPostLink(...args);
      if (resolve(String(args[1])) === resolve(checkpointPostLinkPath)) {
        checkpointDestinationLinked = true;
      }
    };
    (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = async (
      ...args: Parameters<typeof fsPromises.lstat>
    ) => {
      if (
        checkpointDestinationLinked &&
        !checkpointPostLinkFailureInjected &&
        resolve(String(args[0])) === resolve(checkpointPostLinkPath)
      ) {
        checkpointPostLinkFailureInjected = true;
        throw Object.assign(new Error("injected checkpoint post-link authentication failure"), {
          code: "EIO",
        });
      }
      return originalCheckpointPostLinkLstat(
        ...args as Parameters<typeof originalCheckpointPostLinkLstat>
      );
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => writePhase3CapacityObservationCheckpoint(firstCheckpointValue, {
          rootPath: checkpointPostLinkRoot,
          tempRootPath: checkpointPostLinkTemp,
        }),
        /post-link|authentication|EIO|injected/i,
      );
    } finally {
      (fsPromises as { link: typeof link }).link = originalCheckpointPostLink;
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = originalCheckpointPostLinkLstat;
      syncBuiltinESMExports();
    }
    const preservedCheckpointTemps = await readdir(checkpointPostLinkTemp);
    assert.equal(preservedCheckpointTemps.length, 1);
    assert.match(
      preservedCheckpointTemps[0],
      /^capacity-observation\.[0-9a-f-]{36}\.tmp$/,
    );
    assert.equal(
      (await stat(join(checkpointPostLinkTemp, preservedCheckpointTemps[0]))).nlink,
      2,
    );
    assert.equal((await stat(checkpointPostLinkPath)).nlink, 2);
    const checkpointPostLinkInode = (
      await stat(checkpointPostLinkPath, { bigint: true })
    ).ino;
    await recoverPhase3CapacityObservationCheckpointStorage({
      rootPath: checkpointPostLinkRoot,
      tempRootPath: checkpointPostLinkTemp,
    });
    assert.deepEqual(await readdir(checkpointPostLinkTemp), []);
    assert.equal((await stat(checkpointPostLinkPath, { bigint: true })).nlink, 1n);
    assert.equal(
      (await stat(checkpointPostLinkPath, { bigint: true })).ino,
      checkpointPostLinkInode,
    );

    const checkpointIdentityLstat = fsPromises.lstat;
    let checkpointRootLstats = 0;
    (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = (async (
      ...args: Parameters<typeof fsPromises.lstat>
    ) => {
      const status = await checkpointIdentityLstat(
        ...args as Parameters<typeof checkpointIdentityLstat>
      );
      if (resolve(String(args[0])) !== resolve(checkpointRoot)) return status;
      checkpointRootLstats += 1;
      if (checkpointRootLstats <= 2) return status;
      return new Proxy(status, {
        get(target, property) {
          if (property === "ino") return (target.ino as bigint) + 1n;
          const result = Reflect.get(target, property, target);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
    }) as typeof fsPromises.lstat;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => readPhase3CapacityObservationCheckpoint({ rootPath: checkpointRoot }),
        /identity|changed|authentication/i,
      );
    } finally {
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = checkpointIdentityLstat;
      syncBuiltinESMExports();
    }

    const task4Snapshot = preGate4JournalSnapshot();
    const task4Binding = {
      ...installedBinding,
      actionJournalHeadSha256: task4Snapshot.headSha256,
    };
    const snapshotProjection = validatePhase3PreGate4JournalSnapshot(task4Snapshot, {
      installedBinding: task4Binding,
      approvalId: trustedApprovalId,
    });
    assert.deepEqual(Object.keys(snapshotProjection), [
      "gate3",
      "phase3Actions",
      "inlineRestore",
      "windowStartedAt",
      "windowEndedAt",
    ]);
    assert.equal(snapshotProjection.gate3.actionId, "staging-gate-3-handoff");
    assert.deepEqual(
      snapshotProjection.phase3Actions.map((action: { actionId: string }) => action.actionId),
      ACTION_IDS,
    );
    assert.equal(snapshotProjection.inlineRestore.actionId, "phase3-inline-owner-restore");
    assert.equal(snapshotProjection.inlineRestore.terminalRecordSha256, task4Snapshot.headSha256);
    assert.equal(snapshotProjection.windowStartedAt, snapshotProjection.gate3.completedAt);
    assert.equal(snapshotProjection.windowEndedAt, snapshotProjection.inlineRestore.completedAt);
    assertDeepFrozen(snapshotProjection);
    const transitionedGate4 = deepMutableClone(task4Snapshot);
    transitionedGate4.actions[23].state = "succeeded";
    transitionedGate4.actions[23].occurrences = 1;
    transitionedGate4.actions[23].terminalRecordSha256 = hash("unexpected-gate4-terminal");
    transitionedGate4.actions[23].completedAt = "2026-07-12T09:00:24.000Z";
    transitionedGate4.recordCount += 2;
    await assert.rejects(
      async () => validatePhase3PreGate4JournalSnapshot(transitionedGate4, {
        installedBinding: task4Binding,
        approvalId: trustedApprovalId,
      }),
      /44|90|untouched|registered|record/i,
    );
    const reconciledPrefix = deepMutableClone(task4Snapshot);
    reconciledPrefix.actions[15].state = "reconciled";
    reconciledPrefix.actions[15].reconciliationId = "reconciliation-001";
    reconciledPrefix.actions[15].reconciliationOutcome = "succeeded";
    assert.throws(
      () => validatePhase3PreGate4JournalSnapshot(reconciledPrefix, {
        installedBinding: task4Binding,
        approvalId: trustedApprovalId,
      }),
      /ordinary|reconcil|terminal/i,
    );
    const wrongPlanSnapshot = deepMutableClone(task4Snapshot);
    wrongPlanSnapshot.actions[0].scope = "wrong-scope";
    assert.throws(
      () => validatePhase3PreGate4JournalSnapshot(wrongPlanSnapshot, {
        installedBinding: task4Binding,
        approvalId: trustedApprovalId,
      }),
      /plan|scope|identity/i,
    );
    assert.throws(
      () => validatePhase3PreGate4JournalSnapshot(task4Snapshot, {
        installedBinding: task4Binding,
        approvalId: "other-approval",
      }),
      /approval|binding/i,
    );

    const singletonBase = join(base, "task4-singletons");
    const snapshotRoot = join(singletonBase, "phase3-snapshot");
    const snapshotTempRoot = join(singletonBase, ".phase3-snapshot-tmp");
    const semanticRoot = join(singletonBase, "phase3-staging");
    const semanticTempRoot = join(singletonBase, ".phase3-staging-tmp");
    await privateDirectory(singletonBase);
    const snapshotWritten = await writePhase3ActionJournalSnapshot(task4Snapshot, {
      rootPath: snapshotRoot,
      tempRootPath: snapshotTempRoot,
    });
    assert.deepEqual(Object.keys(snapshotWritten), ["path", "value", "bytes", "sha256"]);
    assert.equal(snapshotWritten.path, join(snapshotRoot, "journal-snapshot.json"));
    assert.equal(snapshotWritten.bytes, canonicalJson(task4Snapshot));
    assert.equal(snapshotWritten.sha256, hash(snapshotWritten.bytes));
    assertDeepFrozen(snapshotWritten);
    const snapshotRead = await readPhase3ActionJournalSnapshot({ rootPath: snapshotRoot });
    assert.deepEqual(snapshotRead, snapshotWritten);
    assertDeepFrozen(snapshotRead);
    const snapshotInode = (await stat(snapshotWritten.path, { bigint: true })).ino;
    const snapshotRetry = await writePhase3ActionJournalSnapshot(task4Snapshot, {
      rootPath: snapshotRoot,
      tempRootPath: snapshotTempRoot,
    });
    assert.equal((await stat(snapshotRetry.path, { bigint: true })).ino, snapshotInode);
    const conflictingSnapshot = deepMutableClone(task4Snapshot);
    conflictingSnapshot.actions[0].completedAt = "2026-07-12T08:59:59.000Z";
    await assert.rejects(
      () => writePhase3ActionJournalSnapshot(conflictingSnapshot, {
        rootPath: snapshotRoot,
        tempRootPath: snapshotTempRoot,
      }),
      /conflict|different|create-once/i,
    );

    const semanticValue = semanticEvidenceValue(task4Snapshot);
    type SemanticFixture = ReturnType<typeof semanticEvidenceValue>;
    const freshSemanticRejections: Array<[
      string,
      (value: SemanticFixture) => void,
    ]> = [
      ["unsigned-target", (value) => { value.targetDescriptor.signed = false; }],
      ["operator-not-installed", (value) => { value.operatorBundle.installed = false; }],
      ["host-identity-mismatch", (value) => { value.host.a3HostIdentityMatches = false; }],
      ["guard-instance-mismatch", (value) => { value.guard.sameInstanceAsTask10 = false; }],
      ["guard-heartbeat-stale", (value) => { value.guard.heartbeatFresh = false; }],
      ["watchdog-heartbeat-stale", (value) => { value.guard.watchdogFresh = false; }],
      ["guard-gap", (value) => { value.guard.continuityGapMs = 1; }],
      ["baseline-side-effects-enabled", (value) => { value.baseline.sideEffectsEnabled = true; }],
      ["baseline-consumer-unhealthy", (value) => { value.baseline.consumerHealthy = false; }],
      ["baseline-lease-owner-inexact", (value) => { value.baseline.legacyLeaseOwnerExact = false; }],
      ["baseline-runtime-inexact", (value) => { value.baseline.runtimeIdentitiesExact = false; }],
      ["legacy-lease-not-released", (value) => { value.cutover.legacyLeaseReleased = false; }],
      ["producer-order-failed", (value) => { value.cutover.producerStartedAfterConsumer = false; }],
      ["direct-poller-accept", (value) => { value.cutover.directPollerAccepts = 1; }],
      ["poller-unhealthy", (value) => { value.runtime.pollerHealthy = false; }],
      ["consumer-unhealthy", (value) => { value.runtime.consumerHealthy = false; }],
      ["history-not-retained", (value) => { value.epoch.historyRetained = false; }],
      ["stale-epoch-action", (value) => { value.epoch.staleEpochActions = 1; }],
      ["fence-node-mismatch", (value) => { value.fence.pollerNodeMatches = false; }],
      ["inline-owner-not-restored", (value) => { value.rollback.inlineOwnerRestored = false; }],
      ...Object.keys(zeroDrain).map((field) => [
        `drain-${field}`,
        (value: SemanticFixture) => {
          value.drain[field as keyof typeof value.drain] = 1;
        },
      ] as [string, (value: SemanticFixture) => void]),
      ...Object.keys(semanticValue.duplicates).map((field) => [
        `duplicate-${field}`,
        (value: SemanticFixture) => {
          value.duplicates[field as keyof typeof value.duplicates] = 1;
        },
      ] as [string, (value: SemanticFixture) => void]),
      ...(["pending", "ambiguous", "replayed", "extra"] as const).map((field) => [
        `journal-${field}`,
        (value: SemanticFixture) => { value.actionJournal[field] = 1; },
      ] as [string, (value: SemanticFixture) => void]),
      ["release-topology", (value) => { value.release.topology = "split"; }],
      ["historical-head", (value) => {
        const changed = hash("changed-semantic-historical-head");
        value.release.actionJournalHeadSha256 = changed;
        value.actionJournal.headSha256 = changed;
      }],
      ["snapshot-binding", (value) => {
        value.actionJournal.snapshotSha256 = hash("changed-semantic-snapshot-binding");
      }],
      ["inline-required-terminal", (value) => {
        value.actionJournal.required.at(-1)!.terminalRecordSha256 = hash(
          "changed-inline-required-terminal",
        );
      }],
      ["duplicate-required-terminal", (value) => {
        value.actionJournal.required.at(-1)!.terminalRecordSha256 =
          value.actionJournal.required[0].terminalRecordSha256;
      }],
      ["required-terminal-order", (value) => {
        const changed = "2026-07-12T09:00:15.500Z";
        value.actionJournal.required[1].completedAt = changed;
        value.timeline[1].completedAt = changed;
      }],
      ["generation-disagreement", (value) => { value.fence.generation = 8; }],
    ];
    for (const [caseName, mutate] of freshSemanticRejections) {
      const invalidValue = deepMutableClone(semanticValue);
      mutate(invalidValue);
      const invalidBase = join(singletonBase, `fresh-invalid-${caseName}`);
      const invalidRoot = join(invalidBase, "phase3-staging");
      const invalidTemp = join(invalidBase, ".phase3-staging-tmp");
      await privateDirectory(invalidBase);
      await assert.rejects(
        () => writePhase3SemanticEvidence(invalidValue, {
          rootPath: invalidRoot,
          tempRootPath: invalidTemp,
        }),
        /semantic|zero|healthy|topology|head|snapshot|terminal|generation|invalid|inconsistent/i,
        caseName,
      );
      await assert.rejects(() => stat(invalidRoot), /ENOENT/i, caseName);
      await assert.rejects(() => stat(invalidTemp), /ENOENT/i, caseName);
    }
    const semanticWritten = await writePhase3SemanticEvidence(semanticValue, {
      rootPath: semanticRoot,
      tempRootPath: semanticTempRoot,
    });
    assert.deepEqual(Object.keys(semanticWritten), ["path", "value", "bytes", "sha256"]);
    assert.equal(semanticWritten.path, join(semanticRoot, "phase3-rollout-evidence.json"));
    assert.equal(semanticWritten.bytes, canonicalJson(semanticValue));
    assert.equal(semanticWritten.sha256, hash(semanticWritten.bytes));
    assertDeepFrozen(semanticWritten);
    assert.deepEqual(
      await readPhase3SemanticEvidence({ rootPath: semanticRoot }),
      semanticWritten,
    );
    const semanticInode = (await stat(semanticWritten.path, { bigint: true })).ino;
    await writePhase3SemanticEvidence(semanticValue, {
      rootPath: semanticRoot,
      tempRootPath: semanticTempRoot,
    });
    assert.equal((await stat(semanticWritten.path, { bigint: true })).ino, semanticInode);
    await assert.rejects(
      () => writePhase3SemanticEvidence({
        ...semanticValue,
        artifactBindings: {
          ...semanticValue.artifactBindings,
          finalSources: {
            ...semanticValue.artifactBindings.finalSources,
            dbSha256: hash("different-but-valid-semantic-db-source"),
          },
        },
      }, {
        rootPath: semanticRoot,
        tempRootPath: semanticTempRoot,
      }),
      /conflict|different|create-once/i,
    );
    await assert.rejects(
      () => writePhase3SemanticEvidence({
        ...semanticValue,
        productionHostUnchanged: true,
      }, {
        rootPath: join(singletonBase, "invalid-semantic"),
        tempRootPath: join(singletonBase, ".invalid-semantic-tmp"),
      }),
      /unknown|field|schema/i,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(snapshotRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(snapshotWritten.path)).mode & 0o777, 0o600);
      assert.equal((await stat(semanticRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(semanticWritten.path)).mode & 0o777, 0o600);
    }

    const missingSingletonBase = join(base, "task4-missing-singletons");
    const missingSnapshotRoot = join(missingSingletonBase, "phase3-snapshot");
    const missingSemanticRoot = join(missingSingletonBase, "phase3-staging");
    await Promise.all([
      privateDirectory(missingSingletonBase),
      privateDirectory(missingSnapshotRoot),
      privateDirectory(missingSemanticRoot),
    ]);
    for (const operation of [
      () => readPhase3ActionJournalSnapshot({ rootPath: missingSnapshotRoot }),
      () => readPhase3SemanticEvidence({ rootPath: missingSemanticRoot }),
    ]) {
      await assert.rejects(operation, (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
        return true;
      });
    }

    const absentRecoveryBase = join(base, "task4-absent-recovery");
    await privateDirectory(absentRecoveryBase);
    const absentSnapshotRoot = join(absentRecoveryBase, "phase3-snapshot");
    const absentSnapshotTemp = join(absentRecoveryBase, ".phase3-snapshot-tmp");
    await recoverPhase3ActionJournalSnapshotStorage({
      rootPath: absentSnapshotRoot,
      tempRootPath: absentSnapshotTemp,
    });
    await assert.rejects(() => stat(absentSnapshotRoot), /ENOENT/i);
    await assert.rejects(() => stat(absentSnapshotTemp), /ENOENT/i);
    const emptyProvisionedRoot = join(absentRecoveryBase, "empty-phase3-staging");
    await privateDirectory(emptyProvisionedRoot);
    await recoverPhase3SemanticEvidenceStorage({
      rootPath: emptyProvisionedRoot,
      tempRootPath: join(absentRecoveryBase, ".empty-phase3-staging-tmp"),
    });
    assert.deepEqual(await readdir(emptyProvisionedRoot), []);

    const linkedSingletonBase = join(base, "task4-linked-recovery");
    const linkedSnapshotRoot = join(linkedSingletonBase, "phase3-snapshot");
    const linkedSnapshotTemp = join(linkedSingletonBase, ".phase3-snapshot-tmp");
    await Promise.all([
      privateDirectory(linkedSingletonBase),
      privateDirectory(linkedSnapshotRoot),
      privateDirectory(linkedSnapshotTemp),
    ]);
    const linkedSnapshotTemporary = join(
      linkedSnapshotTemp,
      `journal-snapshot.${randomUUID()}.tmp`,
    );
    const linkedSnapshotDestination = join(linkedSnapshotRoot, "journal-snapshot.json");
    await writeFile(linkedSnapshotTemporary, canonicalJson(task4Snapshot), { mode: 0o600 });
    await link(linkedSnapshotTemporary, linkedSnapshotDestination);
    const linkedSnapshotInode = (await stat(linkedSnapshotDestination, { bigint: true })).ino;
    await recoverPhase3ActionJournalSnapshotStorage({
      rootPath: linkedSnapshotRoot,
      tempRootPath: linkedSnapshotTemp,
    });

    const semanticRecoveryBase = join(base, "task4-semantic-linked-recovery");
    const linkedSemanticRoot = join(semanticRecoveryBase, "phase3-staging");
    const linkedSemanticTemp = join(semanticRecoveryBase, ".phase3-staging-tmp");
    await Promise.all([
      privateDirectory(semanticRecoveryBase),
      privateDirectory(linkedSemanticRoot),
      privateDirectory(linkedSemanticTemp),
    ]);
    const linkedSemanticTemporary = join(
      linkedSemanticTemp,
      `phase3-rollout-evidence.${randomUUID()}.tmp`,
    );
    const linkedSemanticDestination = join(
      linkedSemanticRoot,
      "phase3-rollout-evidence.json",
    );
    await writeFile(linkedSemanticTemporary, canonicalJson(semanticValue), { mode: 0o600 });
    await link(linkedSemanticTemporary, linkedSemanticDestination);
    const linkedSemanticInode = (await stat(linkedSemanticDestination, { bigint: true })).ino;
    await recoverPhase3SemanticEvidenceStorage({
      rootPath: linkedSemanticRoot,
      tempRootPath: linkedSemanticTemp,
    });
    assert.deepEqual(await readdir(linkedSemanticTemp), []);
    assert.equal((await stat(linkedSemanticDestination, { bigint: true })).nlink, 1n);
    assert.equal((await stat(linkedSemanticDestination, { bigint: true })).ino, linkedSemanticInode);
    await recoverPhase3SemanticEvidenceStorage({
      rootPath: linkedSemanticRoot,
      tempRootPath: linkedSemanticTemp,
    });

    const orphanSnapshotBase = join(base, "task4-snapshot-orphan-recovery");
    const orphanSnapshotRoot = join(orphanSnapshotBase, "phase3-snapshot");
    const orphanSnapshotTemp = join(orphanSnapshotBase, ".phase3-snapshot-tmp");
    await Promise.all([
      privateDirectory(orphanSnapshotBase),
      privateDirectory(orphanSnapshotRoot),
      privateDirectory(orphanSnapshotTemp),
    ]);
    const orphanSnapshotPath = join(
      orphanSnapshotTemp,
      `journal-snapshot.${randomUUID()}.tmp`,
    );
    await writeFile(orphanSnapshotPath, "partial", { mode: 0o600 });
    await recoverPhase3ActionJournalSnapshotStorage({
      rootPath: orphanSnapshotRoot,
      tempRootPath: orphanSnapshotTemp,
    });
    assert.deepEqual(await readdir(orphanSnapshotTemp), []);
    assert.deepEqual(await readdir(orphanSnapshotRoot), []);
    assert.deepEqual(await readdir(linkedSnapshotTemp), []);
    assert.equal((await stat(linkedSnapshotDestination, { bigint: true })).nlink, 1n);
    assert.equal((await stat(linkedSnapshotDestination, { bigint: true })).ino, linkedSnapshotInode);
    await recoverPhase3ActionJournalSnapshotStorage({
      rootPath: linkedSnapshotRoot,
      tempRootPath: linkedSnapshotTemp,
    });

    const twoPassBase = join(base, "task4-two-pass-recovery");
    const twoPassRoot = join(twoPassBase, "phase3-staging");
    const twoPassTemp = join(twoPassBase, ".phase3-staging-tmp");
    await Promise.all([
      privateDirectory(twoPassBase),
      privateDirectory(twoPassRoot),
      privateDirectory(twoPassTemp),
    ]);
    const validOrphan = join(twoPassTemp, `phase3-rollout-evidence.${randomUUID()}.tmp`);
    const malformedTemp = join(twoPassTemp, "wrong-store.tmp");
    await writeFile(validOrphan, "partial", { mode: 0o600 });
    await writeFile(malformedTemp, "partial", { mode: 0o600 });
    const orphanBefore = await stat(validOrphan, { bigint: true });
    await assert.rejects(
      () => recoverPhase3SemanticEvidenceStorage({
        rootPath: twoPassRoot,
        tempRootPath: twoPassTemp,
      }),
      /unexpected|temporary|qualified/i,
    );
    assert.equal((await stat(validOrphan, { bigint: true })).ino, orphanBefore.ino);
    assert.equal(await readFile(validOrphan, "utf8"), "partial");
    assert.equal(await readFile(malformedTemp, "utf8"), "partial");

    const singletonMatrices = [
      {
        name: "snapshot",
        file: "journal-snapshot.json",
        tempPrefix: "journal-snapshot",
        value: task4Snapshot,
        read: (options: { rootPath: string }) => readPhase3ActionJournalSnapshot(options),
        recover: (options: { rootPath: string; tempRootPath: string }) =>
          recoverPhase3ActionJournalSnapshotStorage(options),
        wrongSchema: () => ({ ...deepMutableClone(task4Snapshot), schemaVersion: 2 }),
      },
      {
        name: "semantic",
        file: "phase3-rollout-evidence.json",
        tempPrefix: "phase3-rollout-evidence",
        value: semanticValue,
        read: (options: { rootPath: string }) => readPhase3SemanticEvidence(options),
        recover: (options: { rootPath: string; tempRootPath: string }) =>
          recoverPhase3SemanticEvidenceStorage(options),
        wrongSchema: () => ({ ...deepMutableClone(semanticValue), schemaVersion: 1 }),
      },
    ] as const;
    const singletonPayloadCases = (matrix: (typeof singletonMatrices)[number]) => {
      const wrongPlanOrRequired = deepMutableClone(matrix.value);
      if (matrix.name === "snapshot") {
        wrongPlanOrRequired.actions[0].scope = "wrong-fixed-plan-scope";
      } else {
        wrongPlanOrRequired.actionJournal.required[0].actionId = ACTION_IDS[1];
      }
      return [
        ["noncanonical", Buffer.from(`${canonicalJson(matrix.value)}\n`)],
        ["duplicate-key", Buffer.from('{"x":1,"x":1}')],
        ["non-utf8", Buffer.from([0xc3, 0x28])],
        ["oversized", Buffer.alloc(512 * 1024 + 1, 0x78)],
        ["secret", Buffer.from(canonicalJson({ token: "sk-12345678901234567890" }))],
        ["wrong-schema", Buffer.from(canonicalJson(matrix.wrongSchema()))],
        ["wrong-plan-or-required", Buffer.from(canonicalJson(wrongPlanOrRequired))],
      ] as const;
    };

    for (const matrix of singletonMatrices) {
      for (const [caseName, payload] of singletonPayloadCases(matrix)) {
        const caseBase = join(base, `task4-${matrix.name}-payload-${caseName}`);
        const caseRoot = join(caseBase, matrix.name);
        await Promise.all([privateDirectory(caseBase), privateDirectory(caseRoot)]);
        await writeFile(join(caseRoot, matrix.file), payload, { mode: 0o600 });
        await assert.rejects(
          () => matrix.read({ rootPath: caseRoot }),
          /canonical|JSON|UTF|size|512|secret|schema|invalid|field|plan|required/i,
          `${matrix.name}:${caseName}`,
        );
      }

      const extraBase = join(base, `task4-${matrix.name}-extra-entry`);
      const extraRoot = join(extraBase, matrix.name);
      await Promise.all([privateDirectory(extraBase), privateDirectory(extraRoot)]);
      await Promise.all([
        writeFile(join(extraRoot, matrix.file), canonicalJson(matrix.value), { mode: 0o600 }),
        writeFile(join(extraRoot, "unexpected.json"), "{}", { mode: 0o600 }),
      ]);
      await assert.rejects(
        () => matrix.read({ rootPath: extraRoot }),
        /unexpected|exact|entry/i,
        `${matrix.name}:extra-entry`,
      );

      const fileSymlinkBase = join(base, `task4-${matrix.name}-file-symlink`);
      const fileSymlinkRoot = join(fileSymlinkBase, matrix.name);
      const fileSymlinkTarget = join(fileSymlinkBase, "target.json");
      await Promise.all([privateDirectory(fileSymlinkBase), privateDirectory(fileSymlinkRoot)]);
      await writeFile(fileSymlinkTarget, canonicalJson(matrix.value), { mode: 0o600 });
      await expectSymlinkRejection(
        fileSymlinkTarget,
        join(fileSymlinkRoot, matrix.file),
        () => matrix.read({ rootPath: fileSymlinkRoot }),
        "file",
      );

      const rootSymlinkBase = join(base, `task4-${matrix.name}-root-symlink`);
      const rootSymlinkTarget = join(rootSymlinkBase, "real-root");
      const rootSymlinkPath = join(rootSymlinkBase, "linked-root");
      await Promise.all([privateDirectory(rootSymlinkBase), privateDirectory(rootSymlinkTarget)]);
      await writeFile(join(rootSymlinkTarget, matrix.file), canonicalJson(matrix.value), {
        mode: 0o600,
      });
      await expectSymlinkRejection(
        rootSymlinkTarget,
        rootSymlinkPath,
        () => matrix.read({ rootPath: rootSymlinkPath }),
        process.platform === "win32" ? "junction" : "dir",
      );

      if (process.platform !== "win32") {
        const modeBase = join(base, `task4-${matrix.name}-mode`);
        const modeRoot = join(modeBase, matrix.name);
        await Promise.all([privateDirectory(modeBase), privateDirectory(modeRoot)]);
        const modePath = join(modeRoot, matrix.file);
        await writeFile(modePath, canonicalJson(matrix.value), { mode: 0o600 });
        await chmod(modePath, 0o644);
        await assert.rejects(
          () => matrix.read({ rootPath: modeRoot }),
          /0600|mode|private/i,
          `${matrix.name}:file-mode`,
        );
        await chmod(modePath, 0o600);
        await chmod(modeRoot, 0o755);
        await assert.rejects(
          () => matrix.read({ rootPath: modeRoot }),
          /0700|mode|private/i,
          `${matrix.name}:root-mode`,
        );

        if (typeof process.getuid === "function" && process.getuid() === 0) {
          const ownerBase = join(base, `task4-${matrix.name}-owner`);
          const ownerRoot = join(ownerBase, matrix.name);
          await Promise.all([privateDirectory(ownerBase), privateDirectory(ownerRoot)]);
          const ownerPath = join(ownerRoot, matrix.file);
          await writeFile(ownerPath, canonicalJson(matrix.value), { mode: 0o600 });
          await chown(ownerPath, 1, 1);
          await assert.rejects(
            () => matrix.read({ rootPath: ownerRoot }),
            /owner|ownership/i,
            `${matrix.name}:file-owner`,
          );
        }
      }

      const unstableBase = join(base, `task4-${matrix.name}-unstable-read`);
      const unstableRoot = join(unstableBase, matrix.name);
      const unstablePath = join(unstableRoot, matrix.file);
      await Promise.all([privateDirectory(unstableBase), privateDirectory(unstableRoot)]);
      await writeFile(unstablePath, canonicalJson(matrix.value), { mode: 0o600 });
      const originalUnstableLstat = fsPromises.lstat;
      let unstableFileStats = 0;
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = (async (
        ...args: Parameters<typeof fsPromises.lstat>
      ) => {
        const status = await originalUnstableLstat(
          ...args as Parameters<typeof originalUnstableLstat>
        );
        if (resolve(String(args[0])) !== resolve(unstablePath)) return status;
        unstableFileStats += 1;
        if (unstableFileStats <= 2) return status;
        return new Proxy(status, {
          get(target, property) {
            if (property === "ino") return (target.ino as bigint) + 1n;
            const result = Reflect.get(target, property, target);
            return typeof result === "function" ? result.bind(target) : result;
          },
        });
      }) as typeof fsPromises.lstat;
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          () => matrix.read({ rootPath: unstableRoot }),
          /changed|stable|identity/i,
          `${matrix.name}:unstable-final-read`,
        );
      } finally {
        (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = originalUnstableLstat;
        syncBuiltinESMExports();
      }

      const mismatchedBase = join(base, `task4-${matrix.name}-mismatched-pair`);
      const mismatchedRoot = join(mismatchedBase, matrix.name);
      const mismatchedTemp = join(mismatchedBase, `.${matrix.name}-tmp`);
      await Promise.all([
        privateDirectory(mismatchedBase),
        privateDirectory(mismatchedRoot),
        privateDirectory(mismatchedTemp),
      ]);
      const mismatchedDestination = join(mismatchedRoot, matrix.file);
      const mismatchedTemporary = join(
        mismatchedTemp,
        `${matrix.tempPrefix}.11111111-1111-4111-8111-111111111111.tmp`,
      );
      const mismatchedExternal = join(mismatchedBase, "external-link");
      await writeFile(mismatchedDestination, canonicalJson(matrix.value), { mode: 0o600 });
      await writeFile(mismatchedTemporary, canonicalJson(matrix.value), { mode: 0o600 });
      await link(mismatchedTemporary, mismatchedExternal);
      const mismatchedBefore = await stat(mismatchedTemporary, { bigint: true });
      await assert.rejects(
        () => matrix.recover({ rootPath: mismatchedRoot, tempRootPath: mismatchedTemp }),
        /link|pair|destination|count|match/i,
        `${matrix.name}:mismatched-pair`,
      );
      assert.equal((await stat(mismatchedTemporary, { bigint: true })).ino, mismatchedBefore.ino);
      assert.equal((await stat(mismatchedTemporary, { bigint: true })).nlink, 2n);

      const duplicateBase = join(base, `task4-${matrix.name}-duplicate-linked`);
      const duplicateRoot = join(duplicateBase, matrix.name);
      const duplicateTemp = join(duplicateBase, `.${matrix.name}-tmp`);
      await Promise.all([
        privateDirectory(duplicateBase),
        privateDirectory(duplicateRoot),
        privateDirectory(duplicateTemp),
      ]);
      const duplicateOne = join(
        duplicateTemp,
        `${matrix.tempPrefix}.00000000-0000-4000-8000-000000000001.tmp`,
      );
      const duplicateTwo = join(
        duplicateTemp,
        `${matrix.tempPrefix}.ffffffff-ffff-4fff-8fff-ffffffffffff.tmp`,
      );
      await writeFile(duplicateOne, canonicalJson(matrix.value), { mode: 0o600 });
      await link(duplicateOne, join(duplicateRoot, matrix.file));
      await writeFile(duplicateTwo, canonicalJson(matrix.value), { mode: 0o600 });
      await link(duplicateTwo, join(duplicateBase, "second-external-link"));
      await assert.rejects(
        () => matrix.recover({ rootPath: duplicateRoot, tempRootPath: duplicateTemp }),
        /duplicate|ambiguous|linked/i,
        `${matrix.name}:duplicate-linked`,
      );
      assert.equal((await stat(duplicateOne, { bigint: true })).nlink, 2n);
      assert.equal((await stat(duplicateTwo, { bigint: true })).nlink, 2n);

      const overlinkedBase = join(base, `task4-${matrix.name}-overlinked`);
      const overlinkedRoot = join(overlinkedBase, matrix.name);
      const overlinkedTemp = join(overlinkedBase, `.${matrix.name}-tmp`);
      await Promise.all([
        privateDirectory(overlinkedBase),
        privateDirectory(overlinkedRoot),
        privateDirectory(overlinkedTemp),
      ]);
      const overlinkedTemporary = join(
        overlinkedTemp,
        `${matrix.tempPrefix}.22222222-2222-4222-8222-222222222222.tmp`,
      );
      await writeFile(overlinkedTemporary, canonicalJson(matrix.value), { mode: 0o600 });
      await link(overlinkedTemporary, join(overlinkedRoot, matrix.file));
      await link(overlinkedTemporary, join(overlinkedBase, "third-link"));
      await assert.rejects(
        () => matrix.recover({ rootPath: overlinkedRoot, tempRootPath: overlinkedTemp }),
        /link|count|invalid/i,
        `${matrix.name}:nlink>2`,
      );
      assert.equal((await stat(overlinkedTemporary, { bigint: true })).nlink, 3n);

      const heldBase = join(base, `task4-${matrix.name}-held-destination`);
      const heldRoot = join(heldBase, matrix.name);
      const heldTemp = join(heldBase, `.${matrix.name}-tmp`);
      await Promise.all([
        privateDirectory(heldBase),
        privateDirectory(heldRoot),
        privateDirectory(heldTemp),
      ]);
      const heldDestination = join(heldRoot, matrix.file);
      await writeFile(heldDestination, canonicalJson(matrix.value), { mode: 0o600 });
      await link(heldDestination, join(heldBase, "held-external-link"));
      await assert.rejects(
        () => matrix.recover({ rootPath: heldRoot, tempRootPath: heldTemp }),
        /unaccounted|hard link|temporary|held/i,
        `${matrix.name}:destination-without-temp`,
      );
      assert.equal((await stat(heldDestination, { bigint: true })).nlink, 2n);

      const crossDeviceBase = join(base, `task4-${matrix.name}-cross-device`);
      const crossDeviceRoot = join(crossDeviceBase, matrix.name);
      const crossDeviceTemp = join(crossDeviceBase, `.${matrix.name}-tmp`);
      await Promise.all([
        privateDirectory(crossDeviceBase),
        privateDirectory(crossDeviceRoot),
        privateDirectory(crossDeviceTemp),
      ]);
      const originalCrossDeviceLstat = fsPromises.lstat;
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = (async (
        ...args: Parameters<typeof fsPromises.lstat>
      ) => {
        const status = await originalCrossDeviceLstat(
          ...args as Parameters<typeof originalCrossDeviceLstat>
        );
        if (resolve(String(args[0])) !== resolve(crossDeviceTemp)) return status;
        return new Proxy(status, {
          get(target, property) {
            if (property === "dev") return (target.dev as bigint) + 1n;
            const result = Reflect.get(target, property, target);
            return typeof result === "function" ? result.bind(target) : result;
          },
        });
      }) as typeof fsPromises.lstat;
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          () => matrix.recover({ rootPath: crossDeviceRoot, tempRootPath: crossDeviceTemp }),
          /cross-device|hard-link/i,
          `${matrix.name}:cross-device`,
        );
      } finally {
        (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = originalCrossDeviceLstat;
        syncBuiltinESMExports();
      }

      const incompleteBase = join(base, `task4-${matrix.name}-incomplete-pair`);
      const incompleteRoot = join(incompleteBase, matrix.name);
      const incompleteTemp = join(incompleteBase, `.${matrix.name}-tmp`);
      await Promise.all([privateDirectory(incompleteBase), privateDirectory(incompleteRoot)]);
      const incompleteDestination = join(incompleteRoot, matrix.file);
      await writeFile(incompleteDestination, canonicalJson(matrix.value), { mode: 0o600 });
      await assert.rejects(
        () => matrix.recover({ rootPath: incompleteRoot, tempRootPath: incompleteTemp }),
        /incomplete|nonempty|both roots/i,
        `${matrix.name}:nonempty-incomplete-pair`,
      );
      assert.equal(await readFile(incompleteDestination, "utf8"), canonicalJson(matrix.value));

      const namespaceBase = join(base, `task4-${matrix.name}-wrong-temp-namespace`);
      const namespaceRoot = join(namespaceBase, matrix.name);
      const namespaceTemp = join(namespaceBase, `.${matrix.name}-tmp`);
      await Promise.all([
        privateDirectory(namespaceBase),
        privateDirectory(namespaceRoot),
        privateDirectory(namespaceTemp),
      ]);
      const otherPrefix = matrix.name === "snapshot"
        ? "phase3-rollout-evidence"
        : "journal-snapshot";
      const wrongNamespacePath = join(
        namespaceTemp,
        `${otherPrefix}.33333333-3333-4333-8333-333333333333.tmp`,
      );
      await writeFile(wrongNamespacePath, "partial", { mode: 0o600 });
      await assert.rejects(
        () => matrix.recover({ rootPath: namespaceRoot, tempRootPath: namespaceTemp }),
        /unexpected|qualified|temporary/i,
        `${matrix.name}:wrong-temp-namespace`,
      );
      assert.equal(await readFile(wrongNamespacePath, "utf8"), "partial");

      const laterInvalidBase = join(base, `task4-${matrix.name}-later-invalid-plan`);
      const laterInvalidRoot = join(laterInvalidBase, matrix.name);
      const laterInvalidTemp = join(laterInvalidBase, `.${matrix.name}-tmp`);
      await Promise.all([
        privateDirectory(laterInvalidBase),
        privateDirectory(laterInvalidRoot),
        privateDirectory(laterInvalidTemp),
      ]);
      const plannedOrphan = join(
        laterInvalidTemp,
        `${matrix.tempPrefix}.00000000-0000-4000-8000-000000000001.tmp`,
      );
      const laterMalformed = join(
        laterInvalidTemp,
        `${matrix.tempPrefix}.ffffffff-ffff-4fff-8fff-ffffffffffff.tmp`,
      );
      const laterExternal = join(laterInvalidBase, "later-external-link");
      await writeFile(plannedOrphan, "orphan-bytes", { mode: 0o600 });
      await writeFile(laterMalformed, "{", { mode: 0o600 });
      await link(laterMalformed, laterExternal);
      const orphanSnapshotBefore = await stat(plannedOrphan, { bigint: true });
      const malformedSnapshotBefore = await stat(laterMalformed, { bigint: true });
      await assert.rejects(
        () => matrix.recover({ rootPath: laterInvalidRoot, tempRootPath: laterInvalidTemp }),
        /JSON|canonical|schema|malformed/i,
        `${matrix.name}:qualified-later-invalid-two-pass`,
      );
      assert.equal((await stat(plannedOrphan, { bigint: true })).ino, orphanSnapshotBefore.ino);
      assert.equal(await readFile(plannedOrphan, "utf8"), "orphan-bytes");
      assert.equal((await stat(laterMalformed, { bigint: true })).ino, malformedSnapshotBefore.ino);
      assert.equal((await stat(laterMalformed, { bigint: true })).nlink, 2n);
      assert.equal(await readFile(laterMalformed, "utf8"), "{");
    }

    for (const [reader, writer, recovery, validValue] of [
      [
        readPhase3ActionJournalSnapshot,
        writePhase3ActionJournalSnapshot,
        recoverPhase3ActionJournalSnapshotStorage,
        task4Snapshot,
      ],
      [
        readPhase3SemanticEvidence,
        writePhase3SemanticEvidence,
        recoverPhase3SemanticEvidenceStorage,
        semanticValue,
      ],
    ] as const) {
      await assert.rejects(() => reader(undefined as never), /argument|undefined|options/i);
      await assert.rejects(() => reader({ unknown: true } as never), /unknown|options/i);
      const hiddenReadOptions = {};
      Object.defineProperty(hiddenReadOptions, "rootPath", {
        value: snapshotRoot,
        enumerable: false,
      });
      await assert.rejects(() => reader(hiddenReadOptions as never), /enumerable|options|field/i);
      await assert.rejects(
        () => reader({ [Symbol("root")]: snapshotRoot } as never),
        /symbol|options|field/i,
      );
      await assert.rejects(
        () => reader(Object.defineProperty({}, "rootPath", {
          get: () => snapshotRoot,
          enumerable: true,
        }) as never),
        /data|accessor|options/i,
      );
      await assert.rejects(
        () => writer(validValue as never, { rootPath: snapshotRoot } as never),
        /together|partial|temporary/i,
      );
      await assert.rejects(
        () => recovery({ rootPath: snapshotRoot } as never),
        /together|partial|temporary/i,
      );
      await assert.rejects(
        () => (reader as (...args: unknown[]) => Promise<unknown>)({}, "extra"),
        /argument|extra|options/i,
      );
      await assert.rejects(
        () => (writer as (...args: unknown[]) => Promise<unknown>)(validValue, {}, "extra"),
        /argument|extra|options/i,
      );
      await assert.rejects(
        () => (recovery as (...args: unknown[]) => Promise<unknown>)({}, "extra"),
        /argument|extra|options/i,
      );
    }

    const rawHistoricalBase = join(base, "task4-raw-historical");
    const rawActionRoot = join(rawHistoricalBase, "phase3-action-measurements");
    const rawObservationRoot = join(rawHistoricalBase, "phase3-observations");
    await Promise.all([
      privateDirectory(rawHistoricalBase),
      privateDirectory(rawActionRoot),
      privateDirectory(rawObservationRoot),
    ]);
    for (const actionId of ACTION_IDS) {
      await writeFile(
        join(rawActionRoot, `${actionId}.json`),
        canonicalJson(actionMarker(actionId)),
        { mode: 0o600 },
      );
    }
    await Promise.all([
      writeFile(
        join(rawObservationRoot, "phase3-schema-verify.json"),
        canonicalJson(schemaObservation()),
        { mode: 0o600 },
      ),
      writeFile(
        join(rawObservationRoot, "phase3-fence-ack-wait.json"),
        canonicalJson(fenceObservation()),
        { mode: 0o600 },
      ),
    ]);
    const rawActions = await readPhase3HistoricalActionMeasurementArtifacts({
      rootPath: rawActionRoot,
    });
    assert.deepEqual(rawActions.map((entry: { actionId: string }) => entry.actionId), ACTION_IDS);
    assert.equal(rawActions[0].sha256, hash(rawActions[0].bytes));
    assertDeepFrozen(rawActions);
    const rawObservations = await readPhase3HistoricalObservationMarkerArtifacts({
      rootPath: rawObservationRoot,
    });
    assert.equal(rawObservations.schema.observationId, "phase3-schema-verify");
    assert.equal(rawObservations.fence.observationId, "phase3-fence-ack-wait");
    assertDeepFrozen(rawObservations);
    const rawExtra = join(rawActionRoot, "extra.json");
    await writeFile(rawExtra, "{}", { mode: 0o600 });
    await assert.rejects(
      () => readPhase3HistoricalActionMeasurementArtifacts({ rootPath: rawActionRoot }),
      /exact|unexpected|file/i,
    );
    await unlink(rawExtra);
    const wrongEmbedded = deepMutableClone(actionMarker(ACTION_IDS[0]));
    wrongEmbedded.actionId = ACTION_IDS[1];
    await writeFile(
      join(rawActionRoot, `${ACTION_IDS[0]}.json`),
      canonicalJson(wrongEmbedded),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => readPhase3HistoricalActionMeasurementArtifacts({ rootPath: rawActionRoot }),
      /filename|action ID|exact/i,
    );

    async function seedHistoricalMatrix(caseName: string) {
      const caseBase = join(base, `task4-historical-${caseName}`);
      const caseActionRoot = join(caseBase, "phase3-action-measurements");
      const caseObservationRoot = join(caseBase, "phase3-observations");
      await Promise.all([
        privateDirectory(caseBase),
        privateDirectory(caseActionRoot),
        privateDirectory(caseObservationRoot),
      ]);
      for (const actionId of ACTION_IDS) {
        await writeFile(
          join(caseActionRoot, `${actionId}.json`),
          canonicalJson(actionMarker(actionId)),
          { mode: 0o600 },
        );
      }
      await Promise.all([
        writeFile(
          join(caseObservationRoot, "phase3-schema-verify.json"),
          canonicalJson(schemaObservation()),
          { mode: 0o600 },
        ),
        writeFile(
          join(caseObservationRoot, "phase3-fence-ack-wait.json"),
          canonicalJson(fenceObservation()),
          { mode: 0o600 },
        ),
      ]);
      return { caseBase, caseActionRoot, caseObservationRoot };
    }

    const missingActionSet = await seedHistoricalMatrix("missing-action");
    await unlink(join(missingActionSet.caseActionRoot, `${ACTION_IDS[0]}.json`));
    await assert.rejects(
      () => readPhase3HistoricalActionMeasurementArtifacts({
        rootPath: missingActionSet.caseActionRoot,
      }),
      /exact|required|file/i,
    );
    const missingObservationSet = await seedHistoricalMatrix("missing-observation");
    await unlink(join(missingObservationSet.caseObservationRoot, "phase3-schema-verify.json"));
    await assert.rejects(
      () => readPhase3HistoricalObservationMarkerArtifacts({
        rootPath: missingObservationSet.caseObservationRoot,
      }),
      /exact|required|file/i,
    );

    const noncanonicalActionSet = await seedHistoricalMatrix("noncanonical-action");
    await writeFile(
      join(noncanonicalActionSet.caseActionRoot, `${ACTION_IDS[0]}.json`),
      `${canonicalJson(actionMarker(ACTION_IDS[0]))}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => readPhase3HistoricalActionMeasurementArtifacts({
        rootPath: noncanonicalActionSet.caseActionRoot,
      }),
      /canonical/i,
    );
    const noncanonicalObservationSet = await seedHistoricalMatrix("noncanonical-observation");
    await writeFile(
      join(noncanonicalObservationSet.caseObservationRoot, "phase3-schema-verify.json"),
      `${canonicalJson(schemaObservation())}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => readPhase3HistoricalObservationMarkerArtifacts({
        rootPath: noncanonicalObservationSet.caseObservationRoot,
      }),
      /canonical/i,
    );

    const actionSchemaSet = await seedHistoricalMatrix("action-schema");
    await writeFile(
      join(actionSchemaSet.caseActionRoot, `${ACTION_IDS[0]}.json`),
      canonicalJson({ ...actionMarker(ACTION_IDS[0]), schemaVersion: 2 }),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => readPhase3HistoricalActionMeasurementArtifacts({ rootPath: actionSchemaSet.caseActionRoot }),
      /schema|identity/i,
    );
    const actionReleaseSet = await seedHistoricalMatrix("action-release-schema");
    const actionWithExtraRelease = actionMarker(ACTION_IDS[0]);
    await writeFile(
      join(actionReleaseSet.caseActionRoot, `${ACTION_IDS[0]}.json`),
      canonicalJson({
        ...actionWithExtraRelease,
        releaseBinding: { ...actionWithExtraRelease.releaseBinding, unexpected: true },
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => readPhase3HistoricalActionMeasurementArtifacts({
        rootPath: actionReleaseSet.caseActionRoot,
      }),
      /release|unknown|field/i,
    );
    const observationSchemaSet = await seedHistoricalMatrix("observation-schema");
    await writeFile(
      join(observationSchemaSet.caseObservationRoot, "phase3-schema-verify.json"),
      canonicalJson({ ...schemaObservation(), schemaVersion: 2 }),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => readPhase3HistoricalObservationMarkerArtifacts({
        rootPath: observationSchemaSet.caseObservationRoot,
      }),
      /schema|identity/i,
    );
    const observationReleaseSet = await seedHistoricalMatrix("observation-release-schema");
    await writeFile(
      join(observationReleaseSet.caseObservationRoot, "phase3-schema-verify.json"),
      canonicalJson({ ...schemaObservation(), releaseManifestSha256: "0".repeat(64) }),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => readPhase3HistoricalObservationMarkerArtifacts({
        rootPath: observationReleaseSet.caseObservationRoot,
      }),
      /release|hash|SHA/i,
    );
    const embeddedObservationSet = await seedHistoricalMatrix("embedded-observation-id");
    await writeFile(
      join(embeddedObservationSet.caseObservationRoot, "phase3-schema-verify.json"),
      canonicalJson(fenceObservation()),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => readPhase3HistoricalObservationMarkerArtifacts({
        rootPath: embeddedObservationSet.caseObservationRoot,
      }),
      /filename|observation ID|differ/i,
    );

    const actionSymlinkSet = await seedHistoricalMatrix("action-symlink");
    const actionSymlinkPath = join(actionSymlinkSet.caseActionRoot, `${ACTION_IDS[0]}.json`);
    const actionSymlinkTarget = join(actionSymlinkSet.caseBase, "action-target.json");
    await unlink(actionSymlinkPath);
    await writeFile(actionSymlinkTarget, canonicalJson(actionMarker(ACTION_IDS[0])), { mode: 0o600 });
    await expectSymlinkRejection(
      actionSymlinkTarget,
      actionSymlinkPath,
      () => readPhase3HistoricalActionMeasurementArtifacts({
        rootPath: actionSymlinkSet.caseActionRoot,
      }),
      "file",
    );
    const observationSymlinkSet = await seedHistoricalMatrix("observation-symlink");
    const observationSymlinkPath = join(
      observationSymlinkSet.caseObservationRoot,
      "phase3-schema-verify.json",
    );
    const observationSymlinkTarget = join(observationSymlinkSet.caseBase, "observation-target.json");
    await unlink(observationSymlinkPath);
    await writeFile(observationSymlinkTarget, canonicalJson(schemaObservation()), { mode: 0o600 });
    await expectSymlinkRejection(
      observationSymlinkTarget,
      observationSymlinkPath,
      () => readPhase3HistoricalObservationMarkerArtifacts({
        rootPath: observationSymlinkSet.caseObservationRoot,
      }),
      "file",
    );

    if (process.platform !== "win32") {
      const actionModeSet = await seedHistoricalMatrix("action-mode");
      await chmod(join(actionModeSet.caseActionRoot, `${ACTION_IDS[0]}.json`), 0o644);
      await assert.rejects(
        () => readPhase3HistoricalActionMeasurementArtifacts({ rootPath: actionModeSet.caseActionRoot }),
        /0600|mode|private/i,
      );
      const observationModeSet = await seedHistoricalMatrix("observation-mode");
      await chmod(
        join(observationModeSet.caseObservationRoot, "phase3-schema-verify.json"),
        0o644,
      );
      await assert.rejects(
        () => readPhase3HistoricalObservationMarkerArtifacts({
          rootPath: observationModeSet.caseObservationRoot,
        }),
        /0600|mode|private/i,
      );
    }

    for (const [caseName, targetKind] of [
      ["action-final-reread", "action"],
      ["observation-final-reread", "observation"],
    ] as const) {
      const unstableHistorical = await seedHistoricalMatrix(caseName);
      const targetPath = targetKind === "action"
        ? join(unstableHistorical.caseActionRoot, `${ACTION_IDS[0]}.json`)
        : join(unstableHistorical.caseObservationRoot, "phase3-schema-verify.json");
      const originalHistoricalLstat = fsPromises.lstat;
      let historicalTargetStats = 0;
      (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = (async (
        ...args: Parameters<typeof fsPromises.lstat>
      ) => {
        const status = await originalHistoricalLstat(
          ...args as Parameters<typeof originalHistoricalLstat>
        );
        if (resolve(String(args[0])) !== resolve(targetPath)) return status;
        historicalTargetStats += 1;
        if (historicalTargetStats <= 2) return status;
        return new Proxy(status, {
          get(target, property) {
            if (property === "ino") return (target.ino as bigint) + 1n;
            const result = Reflect.get(target, property, target);
            return typeof result === "function" ? result.bind(target) : result;
          },
        });
      }) as typeof fsPromises.lstat;
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          () => targetKind === "action"
            ? readPhase3HistoricalActionMeasurementArtifacts({
                rootPath: unstableHistorical.caseActionRoot,
              })
            : readPhase3HistoricalObservationMarkerArtifacts({
                rootPath: unstableHistorical.caseObservationRoot,
              }),
          /changed|stable|identity/i,
          caseName,
        );
      } finally {
        (fsPromises as { lstat: typeof fsPromises.lstat }).lstat = originalHistoricalLstat;
        syncBuiltinESMExports();
      }
    }

    const source = await readFile("scripts/lib/phase3-staging-evidence.mjs", "utf8");
    assert.match(source, /\bEXDEV\b/);
    assert.doesNotMatch(source, /\brename\s*\(/);
    assert.match(source, /MAX_MARKER_BYTES\s*=\s*64\s*\*\s*1024/);
    assert.match(source, /MAX_RUNTIME_SOURCE_BYTES\s*=\s*128\s*\*\s*1024/);
    assert.match(
      source,
      /\/var\/lib\/spx-staging-rollout\/evidence\/phase3-capacity-observation\/capacity-observation\.json/,
    );
    assert.match(
      source,
      /\/var\/lib\/spx-staging-rollout\/evidence\/\.phase3-capacity-observation-tmp/,
    );
    assert.match(source, /O_NOFOLLOW/);
    assert.match(source, /sourceRoot\.status\.dev\s*!==\s*tempRoot\.status\.dev/);
    assert.match(source, /await syncDirectory\(sourceRoot\.path\)/);
    assert.match(source, /allowedNlinks:\s*\[2n\]/);
    assert.match(source, /allowedNlinks:\s*\[1n\]/);
    assert.match(source, /sameInodeAndSize/);
    assert.match(source, /sameIdentity/);
    assert.match(
      source,
      /sameInodeAndSize\(installed\.status,\s*temporaryStatus\)/,
    );
    assert.match(
      source,
      /Phase 3 finalized [^\n]+ marker[\s\S]{0,300}allowedNlinks:\s*\[1n\]/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  console.log("Phase 3 staging marker storage tests passed");
}

void main();
