/* eslint-disable @typescript-eslint/no-explicit-any -- adversarial port fixtures deliberately invoke invalid runtime shapes */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import { openStagingActionLedger } from "../scripts/lib/staging-action-ledger.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import { STAGING_PROVISIONED_DB_ROLES } from "../scripts/lib/staging-action-capability.mjs";
import { createTestStagingOperationRegistry } from "../scripts/lib/staging-operation-registry.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_RUNTIME_SOURCE_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
  phase3PartitionIdentity,
  readPhase3ActionJournalSnapshot,
  readPhase3ActionMeasurements,
  readPhase3CapacityObservationCheckpoint,
  readPhase3ObservationMarkers,
  readPhase3RuntimeSource,
  readPhase3RuntimeSources,
  readPhase3SemanticEvidence,
  recoverPhase3ActionJournalSnapshotStorage,
  recoverPhase3CapacityObservationCheckpointStorage,
  recoverPhase3RuntimeSourceStorage,
  recoverPhase3SemanticEvidenceStorage,
  writePhase3ActionJournalSnapshot,
  writePhase3ActionMeasurement,
  writePhase3CapacityObservationCheckpoint,
  writePhase3ObservationMarker,
  writePhase3RuntimeSource,
  writePhase3SemanticEvidence,
} from "../scripts/lib/phase3-staging-evidence.mjs";
import { produceInstalledPhase3RolloutEvidence } from "../scripts/phase3-rollout-evidence-produce.mjs";
import { collectInstalledPhase3RuntimeSources } from "../scripts/staging-phase3-runtime-evidence.mjs";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowMonotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const approvalId = "phase3-semantic-approval-001";
const stagingRunId = "phase3-semantic-run-001";
const rollbackReleaseManifestSha256 = hash("phase3-semantic-rollback-release");
const productionObserverPolicySha256 = hash("phase3-semantic-observer-policy");
const hostIdentitySha256 = hash("phase3-semantic-a3-host");
const partition = phase3PartitionIdentity(2, "phase3-semantic-ifn-001");
const gate3Plan = REQUIRED_STAGING_ACTION_PLAN.find((entry) => entry.actionId === "staging-gate-3-handoff")!;
const inlinePlan = REQUIRED_STAGING_ACTION_PLAN.find((entry) => entry.actionId === "phase3-inline-owner-restore")!;
const PRODUCER_PORT_NAMES = [
  "loadContext", "loadCapability", "loadHostIdentity", "loadLeases", "recoverSnapshot",
  "recoverSemantic", "readSnapshot", "writeSnapshot", "readObservationMarkers",
  "readActionMeasurements", "readSources", "readSemantic", "writeSemantic",
] as const;

type JsonRecord = Record<string, any>;

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function missing(label: string): Error & { code: string } {
  return Object.assign(new Error(label), { code: "ENOENT" });
}

function record(value: unknown, path = "/fixed/evidence.json") {
  const bytes = canonicalJson(value);
  return { path, value, bytes, sha256: hash(bytes) };
}

function deepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) deepFrozen(child);
}

async function createRealSnapshot(root: string) {
  const ledgerBinding = {
    approvalId,
    stagingRunId,
    approvalEnvelopeSha256: hash("phase3-semantic-envelope"),
    targetDescriptorSha256: hash("phase3-semantic-target"),
    operatorBundleSha256: hash("phase3-semantic-bundle"),
  };
  const startedAt = Date.now() - 60_000;
  const actions = REQUIRED_STAGING_ACTION_PLAN.map((entry) => ({
    ...ledgerBinding,
    ...entry,
    notBefore: new Date(startedAt - 60_000).toISOString(),
    expiresAt: new Date(startedAt + 120_000).toISOString(),
    signatureVerified: true,
  }));
  let clock = startedAt;
  const ledger = await openStagingActionLedger({
    rootPath: root,
    binding: ledgerBinding,
    actions,
    now: () => new Date((clock += 100)),
    verifyAction(value: JsonRecord) {
      assert.equal(value.signatureVerified, true);
      return true;
    },
    operationRegistry: createTestStagingOperationRegistry(actions),
    enforceOwnership: false,
    enforceMode: process.platform !== "win32",
  });
  try {
    for (const action of actions.slice(0, inlinePlan.sequence)) await ledger.consume(action);
    const snapshot = await ledger.snapshot();
    assert.equal(snapshot.actions.length, 44);
    assert.equal(snapshot.recordCount, 90);
    assert.equal(snapshot.actions[23].state, "registered");
    return snapshot as JsonRecord;
  } finally {
    await ledger.close();
  }
}

function snapshotAction(snapshot: JsonRecord, actionId: string): JsonRecord {
  const action = snapshot.actions.find((entry: JsonRecord) => entry.actionId === actionId);
  assert.ok(action);
  return action;
}

function releaseBinding(snapshot: JsonRecord) {
  return {
    candidateSha: "a".repeat(40),
    imageDigest: `sha256:${hash("phase3-semantic-image")}`,
    releaseManifestSha256: hash("phase3-semantic-release"),
    environment: "staging",
    topology: "phase3",
    composeProject: "spx-staging",
    stagingTargetDescriptorSha256: snapshot.binding.targetDescriptorSha256,
    operatorBundleSha256: snapshot.binding.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: snapshot.binding.approvalEnvelopeSha256,
    actionJournalHeadSha256: snapshot.headSha256,
    stagingRunId,
  };
}

function approvedContext(binding: JsonRecord) {
  const envelope = {
    approvalId,
    stagingRunId,
    release: {
      candidateSha: binding.candidateSha,
      candidateImageDigest: binding.imageDigest,
      releaseManifestSha256: binding.releaseManifestSha256,
      rollbackReleaseManifestSha256,
      operatorBundleSha256: binding.operatorBundleSha256,
    },
    target: {
      environment: binding.environment,
      composeProject: binding.composeProject,
      targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    },
    actions: [],
    policy: {
      thresholds: {
        maxCpuPercent: 70,
        minMemoryFreeBytes: 4_000_000_000,
        minMysqlConnectionsFree: 40,
        productionP95LatencyMs: 200,
        maxLatencyIncreasePercent: 25,
      },
    },
  };
  return {
    installedBinding: binding,
    envelope,
    artifacts: { operatorBundle: Buffer.from("authenticated-binary-operator-bundle") },
    verified: {
      approvalId,
      stagingRunId,
      envelopeSha256: binding.stagingApprovalEnvelopeSha256,
      releaseManifestSha256: binding.releaseManifestSha256,
      rollbackReleaseManifestSha256,
      targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
      operatorBundleSha256: binding.operatorBundleSha256,
      candidateSha: binding.candidateSha,
      imageDigest: binding.imageDigest,
      environment: binding.environment,
      composeProject: binding.composeProject,
      topology: binding.topology,
      actions: [],
      envelope: structuredClone(envelope),
    },
    descriptor: {
      releaseEnvironment: "staging",
      runtimeEnvironment: "staging",
      composeProject: "spx-staging",
      target: { hostIdentitySha256, productionObserverPolicySha256 },
    },
  };
}

function capability(binding: JsonRecord) {
  return {
    schemaVersion: 1,
    releaseBinding: Object.fromEntries(REQUIRED_RELEASE_FIELDS.map((field) => [field, binding[field]])),
    database: {
      host: "mysql.staging.internal",
      port: 3306,
      name: "spx_staging",
      sslServername: "mysql.staging.internal",
      caSha256: hash("phase3-semantic-database-ca"),
      actors: { bootstrap: "spx_staging_bootstrap", phase3Control: "spx_stg_phase3_control" },
      actorHosts: { bootstrap: "172.17.0.1", phase3Control: "172.17.0.1" },
      principalRoles: [...STAGING_PROVISIONED_DB_ROLES],
    },
    phase3: { canaryTeamId: partition.teamId, canaryEpoch: partition.epoch },
  };
}

const REQUIRED_RELEASE_FIELDS = [
  "candidateSha", "imageDigest", "releaseManifestSha256", "environment", "topology",
  "composeProject", "stagingTargetDescriptorSha256", "operatorBundleSha256",
  "stagingApprovalEnvelopeSha256", "stagingRunId",
];

function leases(binding: JsonRecord, heartbeat: number, startedMonotonicMs = heartbeat - 30_000) {
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
    startedMonotonicMs,
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

function markerLabels(service: string, binding: JsonRecord) {
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

function markerControl(generation: number, acknowledgedAt: string, state: "enabled" | "fenced", acknowledged = false) {
  return {
    state,
    pollerNodeId: partition.pollerNodeId,
    isActive: true,
    activeEpoch: partition.epoch,
    activeGeneration: generation,
    publicationGeneration: generation,
    fenceJobId: state === "enabled" ? null : 41,
    ackNodeId: acknowledged ? partition.pollerNodeId : null,
    ackJobId: acknowledged ? 42 : null,
    acknowledgedAt: acknowledged ? acknowledgedAt : null,
  };
}

const zeroDrain = { queued: 0, liveClaims: 0, indeterminate: 0, unknown: 0, settlementPending: 0 };

function actionMeasurements(actionId: string, generation: number | null, binding: JsonRecord, acknowledgedAt: string) {
  const identity = (service: string, nodeId: string, enabled: boolean) => ({
    service,
    nodeId,
    status: "running",
    health: "healthy",
    imageId: binding.imageDigest,
    labels: markerLabels(service, binding),
    realWorkerEnabled: enabled,
    settlementWorkerEnabled: enabled,
  });
  switch (actionId) {
    case "phase3-consumer-start-disabled":
      return { consumer: identity(partition.consumerService, partition.consumerNodeId, false) };
    case "phase3-legacy-lease-release":
      return { lease: { activeOwnerCount: 0, ownerNodeId: null, legacyOwnerActive: false } };
    case "phase3-poller-start":
      return { poller: { ...identity(partition.pollerService, partition.pollerNodeId, false), cutoverEpoch: partition.epoch } };
    case "phase3-publication-enable":
      return { control: markerControl(generation!, acknowledgedAt, "enabled") };
    case "phase3-execution-enable":
      return { consumer: identity(partition.consumerService, partition.consumerNodeId, true) };
    case "phase3-publication-fence":
      return { control: markerControl(generation!, acknowledgedAt, "fenced") };
    case "phase3-drain-or-quarantine":
      return { control: markerControl(generation!, acknowledgedAt, "fenced", true), drain: zeroDrain };
    case "phase3-inline-owner-restore":
      return {
        control: markerControl(generation!, acknowledgedAt, "fenced", true),
        drain: zeroDrain,
        lease: { activeOwnerCount: 1, ownerNodeId: partition.legacyNodeId, status: "active" },
        services: {
          poller: { service: partition.pollerService, nodeId: partition.pollerNodeId, running: false },
          consumer: { service: partition.consumerService, nodeId: partition.consumerNodeId, running: false },
          inline: {
            service: partition.legacyService,
            nodeId: partition.legacyNodeId,
            status: "running",
            health: "healthy",
            imageId: binding.imageDigest,
            labels: markerLabels(partition.legacyService, binding),
          },
        },
      };
    default:
      throw new Error(`unknown action ${actionId}`);
  }
}

function actionMarkerValues(snapshot: JsonRecord, binding: JsonRecord, loadedLeases: JsonRecord, observedAt: string) {
  const acknowledgedAt = snapshotAction(snapshot, "phase3-drain-or-quarantine").completedAt;
  return PHASE3_ACTION_IDS.map((actionId, index) => {
    const terminal = snapshotAction(snapshot, actionId);
    const generation = index < 3 ? null : 7;
    return {
      schemaVersion: 1,
      actionId,
      mutationSha256: terminal.mutationSha256,
      terminalRecordSha256: terminal.terminalRecordSha256,
      completedAt: terminal.completedAt,
      observedAt,
      releaseBinding: Object.fromEntries([
        "candidateSha", "imageDigest", "releaseManifestSha256", "stagingTargetDescriptorSha256",
        "operatorBundleSha256", "stagingApprovalEnvelopeSha256", "stagingRunId",
      ].map((field) => [field, binding[field]])),
      guardLeaseId: loadedLeases.guard.leaseId,
      watchdogLeaseId: loadedLeases.watchdog.leaseId,
      teamId: partition.teamId,
      epoch: partition.epoch,
      generation,
      measurements: actionMeasurements(actionId, generation, binding, acknowledgedAt),
    };
  });
}

function observationValues(snapshot: JsonRecord, binding: JsonRecord, loadedLeases: JsonRecord, observedAt: string) {
  const gate3 = snapshotAction(snapshot, gate3Plan.actionId);
  const fence = snapshotAction(snapshot, "phase3-publication-fence");
  const acknowledgedAt = snapshotAction(snapshot, "phase3-drain-or-quarantine").completedAt;
  const common = {
    schemaVersion: 1,
    stagingRunId,
    teamId: partition.teamId,
    epoch: partition.epoch,
    pollerNodeId: partition.pollerNodeId,
    approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
    releaseManifestSha256: binding.releaseManifestSha256,
    rollbackReleaseManifestSha256,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    guardLeaseId: loadedLeases.guard.leaseId,
    watchdogLeaseId: loadedLeases.watchdog.leaseId,
    observedAt,
  };
  return {
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
        pollerNodeId: partition.pollerNodeId,
        ackNodeId: partition.pollerNodeId,
        acknowledgedAt,
        isActive: true,
        observerReadOnly: true,
      },
    },
  };
}

function rawLabels(service: string, binding: JsonRecord) {
  return {
    "com.docker.compose.project": "spx-staging",
    "com.docker.compose.service": service,
    "com.spx.environment": "staging",
    "com.spx.release-sha": binding.candidateSha,
    "com.spx.target-descriptor-sha256": binding.stagingTargetDescriptorSha256,
    "com.spx.operator-bundle-sha256": binding.operatorBundleSha256,
    "com.spx.staging-run-id": binding.stagingRunId,
  };
}

function inspectedContainers(binding: JsonRecord) {
  const raw = (
    service: string,
    nodeId: string,
    id: string,
    status: "running" | "exited",
    environment: string[],
  ) => ({
    Id: id.repeat(64),
    Image: binding.imageDigest,
    Config: { Labels: rawLabels(service, binding), Env: [`SPX_NODE_ID=${nodeId}`, ...environment] },
    State: {
      Status: status,
      Paused: false,
      Restarting: false,
      ...(status === "running" ? { Health: { Status: "healthy" } } : {}),
    },
  });
  return {
    [partition.pollerService]: raw(partition.pollerService, partition.pollerNodeId, "a", "exited", [
      `AUTO_ACCEPT_JOB_CUTOVER_EPOCH=${partition.epoch}`,
      "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=false",
      "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=false",
      "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=false",
    ]),
    [partition.consumerService]: raw(partition.consumerService, partition.consumerNodeId, "b", "exited", [
      "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=false",
      "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=true",
      "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=true",
    ]),
    [partition.legacyService]: raw(partition.legacyService, partition.legacyNodeId, "c", "running", [
      "SPX_ROLE=worker",
      `RUN_TEAM_IDS=${partition.teamId}`,
    ]),
  };
}

function capacityPair(observedAt: string) {
  const productionP95LatencyMs = 80;
  const productionBaselineP95LatencyMs = 75;
  return {
    capacity: {
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
          maxCpuPercent: 70,
          minMemoryFreeBytes: 4_000_000_000,
          minMysqlConnectionsFree: 40,
          maxProductionP95LatencyMs: 200,
          maxLatencyIncreasePercent: 25,
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
    },
    productionObserver: {
      schemaVersion: 1,
      expectedPolicySha256: productionObserverPolicySha256,
      requestMethod: "GET",
      response: { p95LatencyMs: productionP95LatencyMs, ready: true },
      observedAt,
      thresholdResult: {
        absoluteP95WithinApprovedLimit: true,
        latencyIncreaseWithinApprovedLimit: true,
        passed: true,
      },
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spx-phase3-semantic-producer-"));
  await privateDirectory(root);
  const ledgerRoot = join(root, "ledger");
  await privateDirectory(ledgerRoot);
  const snapshot = await createRealSnapshot(ledgerRoot);
  const binding = releaseBinding(snapshot);
  const context = approvedContext(binding);
  const installedCapability = capability(binding);
  // Historical marker setup may take longer than the live collector's 10 s
  // freshness window. Keep its lease snapshot deliberately older than that
  // window so this fixture cannot accidentally depend on fast filesystem I/O.
  const baseHeartbeat = nowMonotonicMs() - 30_000;
  const leaseStarted = baseHeartbeat - 30_000;
  const markerLeases = leases(binding, baseHeartbeat + 500, leaseStarted);
  let lastProducerHeartbeat = baseHeartbeat + 1_500;
  const loadFreshProducerLeases = () => {
    const currentHeartbeat = nowMonotonicMs();
    lastProducerHeartbeat = Math.max(lastProducerHeartbeat + 1, currentHeartbeat - 1_000);
    return leases(binding, lastProducerHeartbeat, leaseStarted);
  };
  const observedAt = new Date().toISOString();
  const actions = actionMarkerValues(snapshot, binding, markerLeases, observedAt);
  const observations = observationValues(snapshot, binding, markerLeases, observedAt);
  const markerParent = join(root, "markers");
  await privateDirectory(markerParent);
  const actionRoot = join(markerParent, "actions");
  const observationRoot = join(markerParent, "observations");
  const markerTempRoot = join(markerParent, ".tmp");
  const actionMarkerOptions = { rootPath: actionRoot, tempRootPath: markerTempRoot };
  const observationMarkerOptions = { rootPath: observationRoot, tempRootPath: markerTempRoot };
  const expectedMarkers = {
    position: "historical",
    journalSnapshot: snapshot,
    installedBinding: binding,
    approvalId,
    rollbackReleaseManifestSha256,
    leases: markerLeases,
    partition,
    nowMs: Date.now(),
  };
  const currentExpected = (actionId: string) => {
    const terminal = snapshotAction(snapshot, actionId);
    const prefixSnapshot = structuredClone(snapshot);
    for (const action of prefixSnapshot.actions) {
      if (action.sequence <= terminal.sequence) continue;
      action.state = "registered";
      action.occurrences = 0;
      action.terminalRecordSha256 = null;
      action.completedAt = null;
      action.reconciliationId = null;
      action.reconciliationOutcome = null;
    }
    prefixSnapshot.recordCount = prefixSnapshot.actions.length + 2 * terminal.sequence;
    prefixSnapshot.headSha256 = terminal.terminalRecordSha256;
    return {
      ...expectedMarkers,
      position: "current",
      journalSnapshot: prefixSnapshot,
      installedBinding: { ...binding, actionJournalHeadSha256: terminal.terminalRecordSha256 },
    };
  };
  for (const value of actions) {
    await writePhase3ActionMeasurement(
      value,
      currentExpected(value.actionId),
      actionMarkerOptions,
    );
  }
  await writePhase3ObservationMarker(
    observations.schema,
    currentExpected("staging-gate-3-handoff"),
    observationMarkerOptions,
  );
  await writePhase3ObservationMarker(
    observations.fence,
    currentExpected("phase3-publication-fence"),
    observationMarkerOptions,
  );

  const evidenceParent = join(root, "evidence");
  await privateDirectory(evidenceParent);
  const sourceOptions = {
    rootPath: join(evidenceParent, "phase3-sources"),
    tempRootPath: join(evidenceParent, ".phase3-source-tmp"),
  };
  const checkpointOptions = {
    rootPath: join(evidenceParent, "capacity-observation"),
    tempRootPath: join(evidenceParent, ".capacity-observation-tmp"),
  };
  const snapshotOptions = {
    rootPath: join(evidenceParent, "phase3-snapshot"),
    tempRootPath: join(evidenceParent, ".phase3-snapshot-tmp"),
  };
  const semanticOptions = {
    rootPath: join(evidenceParent, "phase3-staging"),
    tempRootPath: join(evidenceParent, ".phase3-staging-tmp"),
  };
  const inspections = inspectedContainers(binding);
  const collectorLeaseSamples: JsonRecord[] = [];
  const pair = capacityPair(observedAt);
  const collectorPorts = {
    async loadContext() { return structuredClone(context); },
    async loadCapability() { return structuredClone(installedCapability); },
    async loadObserverDatabase() {
      return {
        host: "mysql.staging.internal",
        port: 3306,
        user: "spx_stg_phase3_observer",
        password: "x".repeat(40),
        database: "spx_staging",
        ssl: { ca: "test-ca", rejectUnauthorized: true, servername: "mysql.staging.internal" },
      };
    },
    async loadLeases() {
      const currentLeases = loadFreshProducerLeases();
      collectorLeaseSamples.push(structuredClone(currentLeases));
      return currentLeases;
    },
    async readActionMeasurements(expected: JsonRecord) {
      return readPhase3ActionMeasurements(expected, { rootPath: actionRoot });
    },
    async readObservationMarkers(expected: JsonRecord) {
      return readPhase3ObservationMarkers(expected, { rootPath: observationRoot });
    },
    async assertLocalDocker() { return true; },
    async listFixedServiceContainerIds(service: string) {
      const value = inspections[service as keyof typeof inspections];
      return value ? [value.Id] : [];
    },
    async inspectFixedContainer(containerId: string) {
      return structuredClone(Object.values(inspections).find((entry) => entry.Id === containerId));
    },
    async runDatabaseEvidence() {
      return {
        ok: true,
        evidenceId: "phase3-gate4-final",
        control: {
          state: "fenced",
          generation: 7,
          fenceJobId: 41,
          ackJobId: 42,
          pollerNodeMatches: true,
          acknowledgedAt: snapshotAction(snapshot, "phase3-drain-or-quarantine").completedAt,
        },
        drain: structuredClone(zeroDrain),
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
        inlineLease: { activeOwnerCount: 1, ownerNodeId: partition.legacyNodeId, ownerMatches: true },
      };
    },
    async collectCapacityEvidence() { return structuredClone(pair); },
    async recoverRuntimeSources() { await recoverPhase3RuntimeSourceStorage(sourceOptions); },
    async recoverCapacityCheckpoint() { await recoverPhase3CapacityObservationCheckpointStorage(checkpointOptions); },
    async readCapacityCheckpoint() {
      return readPhase3CapacityObservationCheckpoint({ rootPath: checkpointOptions.rootPath });
    },
    async writeCapacityCheckpoint(value: unknown) {
      return writePhase3CapacityObservationCheckpoint(value, checkpointOptions);
    },
    async readSource(sourceId: string) {
      return readPhase3RuntimeSource(sourceId, { rootPath: sourceOptions.rootPath });
    },
    async writeSource(sourceId: string, value: unknown) {
      return writePhase3RuntimeSource(sourceId, value, sourceOptions);
    },
    async readSources() { return readPhase3RuntimeSources({ rootPath: sourceOptions.rootPath }); },
  };
  const collected = await collectInstalledPhase3RuntimeSources(
    { journalSnapshot: snapshot, leases: loadFreshProducerLeases() },
    collectorPorts as never,
  );
  assert.deepEqual(Object.keys(collected), PHASE3_RUNTIME_SOURCE_IDS);

  const calls: string[] = [];
  let producerLeaseReads = 0;
  const ports = {
    async loadContext() { calls.push("context"); return structuredClone(context); },
    async loadCapability() { calls.push("capability"); return structuredClone(installedCapability); },
    async loadHostIdentity() { calls.push("host"); return hostIdentitySha256; },
    async loadLeases() {
      calls.push("leases");
      producerLeaseReads += 1;
      return structuredClone(loadFreshProducerLeases());
    },
    async recoverSnapshot() { calls.push("recover-snapshot"); await recoverPhase3ActionJournalSnapshotStorage(snapshotOptions); },
    async recoverSemantic() { calls.push("recover-semantic"); await recoverPhase3SemanticEvidenceStorage(semanticOptions); },
    async readSnapshot() { calls.push("read-snapshot"); return readPhase3ActionJournalSnapshot({ rootPath: snapshotOptions.rootPath }); },
    async writeSnapshot(value: unknown) {
      calls.push("write-snapshot");
      return writePhase3ActionJournalSnapshot(value, snapshotOptions);
    },
    async readObservationMarkers(expected: JsonRecord) {
      calls.push("observations");
      return readPhase3ObservationMarkers(expected, { rootPath: observationRoot });
    },
    async readActionMeasurements(expected: JsonRecord) {
      calls.push("actions");
      return readPhase3ActionMeasurements(expected, { rootPath: actionRoot });
    },
    async readSources() { calls.push("sources"); return readPhase3RuntimeSources({ rootPath: sourceOptions.rootPath }); },
    async readSemantic() { calls.push("read-semantic"); return readPhase3SemanticEvidence({ rootPath: semanticOptions.rootPath }); },
    async writeSemantic(value: unknown) {
      calls.push("write-semantic");
      return writePhase3SemanticEvidence(value, semanticOptions);
    },
  };
  return {
    root,
    snapshot,
    binding,
    context,
    installedCapability,
    collected,
    markerLeases,
    collectorLeaseSamples,
    actions,
    observations,
    loadFreshProducerLeases,
    ports,
    calls,
    sourceOptions,
    snapshotOptions,
    semanticOptions,
    get producerLeaseReads() { return producerLeaseReads; },
  };
}

function markerRecord(kind: "action" | "observation", id: string, value: unknown) {
  const stored = record(structuredClone(value), `/fixed/${id}.json`);
  return { [kind === "action" ? "actionId" : "observationId"]: id, ...stored };
}

function rehashRuntimeRecord(value: JsonRecord) {
  const bytes = canonicalJson(value);
  return { value, bytes, sha256: hash(bytes) };
}

function rehashMarkerRecord(value: JsonRecord) {
  const bytes = canonicalJson(value.value);
  return { ...value, bytes, sha256: hash(bytes) };
}

function sourcesForMarkers(
  harness: Awaited<ReturnType<typeof fixture>>,
  actions: JsonRecord[],
  observations: { schema: JsonRecord; fence: JsonRecord },
) {
  const sources = structuredClone(harness.collected);
  const bindings = sources["lease-continuity"].value.continuity.markerBindings;
  bindings.observations[0].markerSha256 = observations.schema.sha256;
  bindings.observations[1].markerSha256 = observations.fence.sha256;
  for (const [index, action] of actions.entries()) {
    bindings.actions[index].markerSha256 = action.sha256;
  }
  sources["lease-continuity"] = rehashRuntimeRecord(sources["lease-continuity"].value);
  return sources;
}

function memoryPorts(
  harness: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Record<keyof typeof harness.ports, (...args: any[]) => any>> = {},
) {
  const snapshotRecord = record(harness.snapshot, "/fixed/journal-snapshot.json");
  const actionRecords = harness.actions.map((value, index) =>
    markerRecord("action", PHASE3_ACTION_IDS[index], value));
  const observationRecords = {
    schema: markerRecord("observation", "phase3-schema-verify", harness.observations.schema),
    fence: markerRecord("observation", "phase3-fence-ack-wait", harness.observations.fence),
  };
  let semanticRecord: ReturnType<typeof record> | null = null;
  const base = {
    async loadContext() { return structuredClone(harness.context); },
    async loadCapability() { return structuredClone(harness.installedCapability); },
    async loadHostIdentity() { return hostIdentitySha256; },
    async loadLeases() { return structuredClone(harness.loadFreshProducerLeases()); },
    async recoverSnapshot() {},
    async recoverSemantic() {},
    async readSnapshot() { return structuredClone(snapshotRecord); },
    async writeSnapshot(value: unknown) {
      assert.equal(canonicalJson(value), snapshotRecord.bytes);
      return structuredClone(snapshotRecord);
    },
    async readObservationMarkers() { return structuredClone(observationRecords); },
    async readActionMeasurements() { return structuredClone(actionRecords); },
    async readSources() { return structuredClone(harness.collected); },
    async readSemantic() {
      if (!semanticRecord) throw missing("semantic missing");
      return structuredClone(semanticRecord);
    },
    async writeSemantic(value: unknown) {
      semanticRecord = record(structuredClone(value), "/fixed/phase3-rollout-evidence.json");
      return structuredClone(semanticRecord);
    },
  };
  return {
    ports: { ...base, ...overrides },
    snapshotRecord,
    actionRecords,
    observationRecords,
    get semanticRecord() { return semanticRecord; },
    setSemantic(value: unknown) {
      semanticRecord = record(structuredClone(value), "/fixed/phase3-rollout-evidence.json");
    },
  };
}

async function expectProductionFailure(operation: () => Promise<unknown>) {
  await assert.rejects(
    operation,
    /^Error: installed Phase 3 rollout evidence production failed$/,
  );
}

test("produces one immutable source-bound schema-v2 bundle from the real ledger and Task 3D collector", async () => {
  const harness = await fixture();
  try {
    // The collector must observe the same live actors at both boundaries even
    // when the earlier marker snapshots have already aged out of its budget.
    assert.equal(harness.collectorLeaseSamples.length, 2);
    for (const role of ["guard", "watchdog"] as const) {
      const historical = harness.markerLeases[role];
      const [before, after] = harness.collectorLeaseSamples.map((sample) => sample[role]);
      assert.ok(before.heartbeatMonotonicMs - historical.heartbeatMonotonicMs > 10_000);
      assert.equal(before.leaseId, historical.leaseId);
      assert.equal(before.pid, historical.pid);
      assert.equal(before.startedMonotonicMs, historical.startedMonotonicMs);
      assert.equal(after.leaseId, before.leaseId);
      assert.equal(after.pid, before.pid);
      assert.equal(after.startedMonotonicMs, before.startedMonotonicMs);
      assert.ok(after.heartbeatMonotonicMs > before.heartbeatMonotonicMs);
    }
    const firstFixtureLeases = await harness.ports.loadLeases();
    const secondFixtureLeases = await harness.ports.loadLeases();
    const fixtureLeaseReadAt = nowMonotonicMs();
    for (const role of ["guard", "watchdog"] as const) {
      assert.equal(secondFixtureLeases[role].leaseId, firstFixtureLeases[role].leaseId);
      assert.equal(secondFixtureLeases[role].pid, firstFixtureLeases[role].pid);
      assert.equal(
        secondFixtureLeases[role].startedMonotonicMs,
        firstFixtureLeases[role].startedMonotonicMs,
      );
      assert.ok(
        secondFixtureLeases[role].heartbeatMonotonicMs >
          firstFixtureLeases[role].heartbeatMonotonicMs,
      );
      assert.ok(fixtureLeaseReadAt - secondFixtureLeases[role].heartbeatMonotonicMs <= 2_000);
    }
    const producerLeaseReadsBeforeProduction = harness.producerLeaseReads;
    const result = await produceInstalledPhase3RolloutEvidence(
      { journalSnapshot: harness.snapshot },
      harness.ports as never,
    );
    assert.deepEqual(Object.keys(result), ["evidence", "bytes", "sha256", "sources"]);
    assert.equal(result.bytes, canonicalJson(result.evidence));
    assert.equal(result.sha256, hash(result.bytes));
    assert.deepEqual(Object.keys(result.sources), PHASE3_SEMANTIC_SOURCE_IDS);
    assert.equal(result.evidence.schemaVersion, 2);
    assert.equal(result.evidence.release.actionJournalHeadSha256, harness.snapshot.headSha256);
    assert.equal(result.evidence.actionJournal.headSha256, harness.snapshot.headSha256);
    assert.equal(result.evidence.actionJournal.required.length, 8);
    assert.deepEqual(
      result.evidence.actionJournal.required.map((entry: JsonRecord) => entry.status),
      Array(8).fill("succeeded"),
    );
    assert.equal(Object.hasOwn(result.evidence.host, "productionHostUnchanged"), false);
    assert.equal(result.evidence.epoch.historyRetained, true);
    assert.equal(result.evidence.baseline.legacyLeaseOwnerExact, true);
    assert.equal(result.sources["phase3-journal-snapshot"], result.evidence.artifactBindings.journalSnapshotSha256);
    for (const [index, actionId] of PHASE3_ACTION_IDS.entries()) {
      assert.equal(
        result.sources[`phase3-action:${actionId}`],
        result.evidence.artifactBindings.actionMeasurements[index].sha256,
      );
    }
    deepFrozen(result);
    assert.ok(harness.calls.indexOf("write-snapshot") < harness.calls.indexOf("observations"));
    assert.ok(harness.calls.indexOf("write-snapshot") < harness.calls.indexOf("sources"));
    assert.ok(harness.calls.indexOf("sources") < harness.calls.indexOf("write-semantic"));
    assert.equal(harness.producerLeaseReads, producerLeaseReadsBeforeProduction + 1);
    assert.equal(harness.calls.filter((entry) => entry === "host").length, 2);
    assert.equal(harness.calls.filter((entry) => entry === "observations").length, 2);
    assert.equal(harness.calls.filter((entry) => entry === "actions").length, 2);
    assert.equal(harness.calls.filter((entry) => entry === "sources").length, 2);

    const snapshotPath = (await readPhase3ActionJournalSnapshot({ rootPath: harness.snapshotOptions.rootPath })).path;
    const semanticPath = (await readPhase3SemanticEvidence({ rootPath: harness.semanticOptions.rootPath })).path;
    const before = await Promise.all([stat(snapshotPath, { bigint: true }), stat(semanticPath, { bigint: true })]);
    const retry = await produceInstalledPhase3RolloutEvidence(
      { journalSnapshot: harness.snapshot },
      harness.ports as never,
    );
    const after = await Promise.all([stat(snapshotPath, { bigint: true }), stat(semanticPath, { bigint: true })]);
    assert.deepEqual(retry, result);
    assert.equal(after[0].ino, before[0].ino);
    assert.equal(after[1].ino, before[1].ino);
    assert.equal(harness.calls.filter((entry) => entry === "write-semantic").length, 1);
    assert.equal(harness.producerLeaseReads, producerLeaseReadsBeforeProduction + 2);

    const callsBeforeImpossible = harness.calls.length;
    const impossiblePorts = {
      ...harness.ports,
      async readSnapshot() { throw missing("snapshot absent"); },
    };
    await assert.rejects(
      () => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot },
        impossiblePorts as never,
      ),
      /^Error: installed Phase 3 rollout evidence production failed$/,
    );
    assert.equal(harness.calls.slice(callsBeforeImpossible).includes("observations"), false);

    const failingSources = structuredClone(harness.collected);
    failingSources["db-final"].value.database.directPollerAccepts = 1;
    failingSources["db-final"] = {
      value: failingSources["db-final"].value,
      bytes: canonicalJson(failingSources["db-final"].value),
      sha256: hash(canonicalJson(failingSources["db-final"].value)),
    };
    const failingPorts = { ...harness.ports, async readSources() { return structuredClone(failingSources); } };
    await assert.rejects(
      () => produceInstalledPhase3RolloutEvidence({ journalSnapshot: harness.snapshot }, failingPorts as never),
      /^Error: installed Phase 3 rollout evidence production failed$/,
    );

    let sourceRead = 0;
    const toctouPorts = {
      ...harness.ports,
      async readSources() {
        sourceRead += 1;
        const value = structuredClone(harness.collected);
        if (sourceRead === 2) {
          value.capacity.value.capacity.measurements.a3CpuPercent = 11;
          value.capacity.bytes = canonicalJson(value.capacity.value);
          value.capacity.sha256 = hash(value.capacity.bytes);
        }
        return value;
      },
    };
    await assert.rejects(
      () => produceInstalledPhase3RolloutEvidence({ journalSnapshot: harness.snapshot }, toctouPorts as never),
      /^Error: installed Phase 3 rollout evidence production failed$/,
    );
    assert.equal(sourceRead, 2);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("fails closed across release, artifact, state, recovery, and TOCTOU boundaries", async () => {
  const harness = await fixture();
  try {
    const baselineMemory = memoryPorts(harness);
    const baseline = await produceInstalledPhase3RolloutEvidence(
      { journalSnapshot: harness.snapshot },
      baselineMemory.ports as never,
    );
    assert.equal(baseline.evidence.schemaVersion, 2);
    assert.ok(Buffer.isBuffer(harness.context.artifacts.operatorBundle));
    {
      const binaryContext = memoryPorts(harness, {
        async loadContext() { return harness.context; },
      });
      const result = await produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, binaryContext.ports as never,
      );
      assert.equal(result.sha256, baseline.sha256);
    }

    const installedBindingMismatches: Array<[string, unknown]> = [
      ["candidateSha", "b".repeat(40)],
      ["imageDigest", `sha256:${"b".repeat(64)}`],
      ["releaseManifestSha256", hash("wrong-installed-release")],
      ["environment", "supervised-production"],
      ["topology", "split"],
      ["composeProject", "spx-production"],
      ["stagingTargetDescriptorSha256", hash("wrong-installed-target")],
      ["operatorBundleSha256", hash("wrong-installed-bundle")],
      ["stagingApprovalEnvelopeSha256", hash("wrong-installed-envelope")],
      ["actionJournalHeadSha256", hash("wrong-installed-head")],
      ["stagingRunId", "wrong-installed-run"],
    ];
    for (const [field, changed] of installedBindingMismatches) {
      const context = structuredClone(harness.context);
      context.installedBinding[field] = changed;
      const attempt = memoryPorts(harness, { async loadContext() { return context; } });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    const verifiedMismatches: Array<[string, unknown]> = [
      ["candidateSha", "b".repeat(40)],
      ["imageDigest", `sha256:${"b".repeat(64)}`],
      ["releaseManifestSha256", hash("wrong-release")],
      ["environment", "supervised-production"],
      ["topology", "split"],
      ["composeProject", "spx-production"],
      ["targetDescriptorSha256", hash("wrong-target")],
      ["operatorBundleSha256", hash("wrong-bundle")],
      ["envelopeSha256", hash("wrong-envelope")],
      ["stagingRunId", "wrong-staging-run"],
    ];
    for (const [field, changed] of verifiedMismatches) {
      const context = structuredClone(harness.context);
      context.verified[field] = changed;
      const attempt = memoryPorts(harness, {
        async loadContext() { return context; },
      });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }
    for (const mutate of [
      (context: JsonRecord) => { delete context.verified.candidateSha; },
      (context: JsonRecord) => { context.verified.rollbackReleaseManifestSha256 = hash("wrong-rollback"); },
      (context: JsonRecord) => { context.envelope.release.rollbackReleaseManifestSha256 = hash("wrong-envelope-rollback"); },
      (context: JsonRecord) => { context.verified.envelope.release.rollbackReleaseManifestSha256 = hash("wrong-verified-envelope"); },
      (context: JsonRecord) => { context.envelope.approvalId = "wrong-approval"; },
      (context: JsonRecord) => { context.verified.approvalId = "wrong-verified-approval"; },
    ]) {
      const context = structuredClone(harness.context);
      mutate(context);
      const attempt = memoryPorts(harness, { async loadContext() { return context; } });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    for (const mutate of [
      (value: JsonRecord) => { value.releaseBinding.candidateSha = "b".repeat(40); },
      (value: JsonRecord) => { value.phase3.canaryTeamId = 1; },
      (value: JsonRecord) => { value.phase3.canaryEpoch = "wrong-phase3-epoch"; },
    ]) {
      const value = structuredClone(harness.installedCapability);
      mutate(value);
      const attempt = memoryPorts(harness, { async loadCapability() { return value; } });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }
    {
      const attempt = memoryPorts(harness, { async loadHostIdentity() { return hash("wrong-host"); } });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    const snapshotMutations: Array<(value: JsonRecord) => void> = [
      (value) => { value.actions.pop(); },
      (value) => { value.recordCount = 89; },
      (value) => { value.headSha256 = hash("wrong-head"); },
      (value) => { value.binding.approvalId = "wrong-approval"; },
      (value) => { value.binding.stagingRunId = "wrong-snapshot-run"; },
      (value) => { value.binding.approvalEnvelopeSha256 = hash("wrong-snapshot-envelope"); },
      (value) => { value.binding.targetDescriptorSha256 = hash("wrong-snapshot-target"); },
      (value) => { value.binding.operatorBundleSha256 = hash("wrong-snapshot-bundle"); },
      (value) => { value.actions[0].mutationSha256 = hash("wrong-plan-mutation"); },
      (value) => {
        value.actions[0].state = "reconciled";
        value.actions[0].reconciliationId = "reconcile-1";
        value.actions[0].reconciliationOutcome = "succeeded";
      },
      (value) => {
        value.actions[23].state = "succeeded";
        value.actions[23].occurrences = 1;
        value.actions[23].terminalRecordSha256 = hash("future-terminal");
        value.actions[23].completedAt = new Date().toISOString();
      },
      (value) => { value.actions[21].terminalRecordSha256 = value.headSha256; },
      (value) => { value.actions[15].completedAt = value.actions[14].completedAt; },
    ];
    for (const mutate of snapshotMutations) {
      const journalSnapshot = structuredClone(harness.snapshot);
      mutate(journalSnapshot);
      const attempt = memoryPorts(harness);
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot }, attempt.ports as never,
      ));
    }

    const markerCases: Array<(attempt: ReturnType<typeof memoryPorts>) => void> = [
      (attempt) => { attempt.actionRecords.pop(); },
      (attempt) => { attempt.actionRecords.push(structuredClone(attempt.actionRecords[0])); },
      (attempt) => { [attempt.actionRecords[0], attempt.actionRecords[1]] = [attempt.actionRecords[1], attempt.actionRecords[0]]; },
      (attempt) => {
        attempt.actionRecords[0].value.terminalRecordSha256 = hash("wrong-terminal");
        attempt.actionRecords[0] = rehashMarkerRecord(attempt.actionRecords[0]);
      },
      (attempt) => {
        attempt.actionRecords[0].value.completedAt = new Date(Date.parse(attempt.actionRecords[0].value.completedAt) + 1).toISOString();
        attempt.actionRecords[0] = rehashMarkerRecord(attempt.actionRecords[0]);
      },
      (attempt) => {
        attempt.actionRecords[0].value.guardLeaseId = "33333333-3333-4333-8333-333333333333";
        attempt.actionRecords[0] = rehashMarkerRecord(attempt.actionRecords[0]);
      },
      (attempt) => {
        const marker = attempt.actionRecords[3];
        marker.value.generation = 8;
        marker.value.measurements.control.activeGeneration = 8;
        marker.value.measurements.control.publicationGeneration = 8;
        attempt.actionRecords[3] = rehashMarkerRecord(marker);
      },
      (attempt) => {
        attempt.observationRecords.schema.value.terminalRecordSha256 = hash("wrong-schema-terminal");
        attempt.observationRecords.schema.value.actionJournalHeadSha256 = hash("wrong-schema-terminal");
        attempt.observationRecords.schema = rehashMarkerRecord(attempt.observationRecords.schema);
      },
      (attempt) => {
        attempt.observationRecords.fence.value.generation = 8;
        attempt.observationRecords.fence.value.measurements.publicationGeneration = 8;
        attempt.observationRecords.fence = rehashMarkerRecord(attempt.observationRecords.fence);
      },
      (attempt) => {
        attempt.observationRecords.fence.value.rollbackReleaseManifestSha256 = hash("wrong-observation-rollback");
        attempt.observationRecords.fence = rehashMarkerRecord(attempt.observationRecords.fence);
      },
      ...[
        ["candidateSha", "b".repeat(40)],
        ["imageDigest", `sha256:${"b".repeat(64)}`],
        ["releaseManifestSha256", hash("wrong-marker-release")],
        ["stagingTargetDescriptorSha256", hash("wrong-marker-target")],
        ["operatorBundleSha256", hash("wrong-marker-bundle")],
        ["stagingApprovalEnvelopeSha256", hash("wrong-marker-envelope")],
        ["stagingRunId", "wrong-marker-run"],
      ].map(([field, changed]) => (attempt: ReturnType<typeof memoryPorts>) => {
        attempt.actionRecords[0].value.releaseBinding[field] = changed;
        attempt.actionRecords[0] = rehashMarkerRecord(attempt.actionRecords[0]);
      }),
    ];
    for (const mutate of markerCases) {
      const attempt = memoryPorts(harness);
      mutate(attempt);
      attempt.ports.readActionMeasurements = async () => structuredClone(attempt.actionRecords);
      attempt.ports.readObservationMarkers = async () => structuredClone(attempt.observationRecords);
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    for (const mutate of [
      (attempt: ReturnType<typeof memoryPorts>) => {
        attempt.actionRecords[5].value.measurements.control.fenceJobId = 43;
        attempt.actionRecords[5] = rehashMarkerRecord(attempt.actionRecords[5]);
      },
      (attempt: ReturnType<typeof memoryPorts>) => {
        attempt.actionRecords[6].value.measurements.control.fenceJobId = 40;
        attempt.actionRecords[6] = rehashMarkerRecord(attempt.actionRecords[6]);
      },
      (attempt: ReturnType<typeof memoryPorts>) => {
        attempt.actionRecords[6].value.measurements.control.ackJobId = 43;
        attempt.actionRecords[6] = rehashMarkerRecord(attempt.actionRecords[6]);
      },
      (attempt: ReturnType<typeof memoryPorts>) => {
        attempt.actionRecords[6].value.measurements.control.acknowledgedAt =
          new Date(Date.parse(attempt.actionRecords[6].value.measurements.control.acknowledgedAt) + 1).toISOString();
        attempt.actionRecords[6] = rehashMarkerRecord(attempt.actionRecords[6]);
      },
    ]) {
      const attempt = memoryPorts(harness);
      mutate(attempt);
      const sources = sourcesForMarkers(harness, attempt.actionRecords, attempt.observationRecords);
      attempt.ports.readActionMeasurements = async () => structuredClone(attempt.actionRecords);
      attempt.ports.readSources = async () => structuredClone(sources);
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    const sourceMutations: Array<(sources: JsonRecord) => void> = [
      (sources) => { sources["db-final"].value.database.staleEpochActions = 1; },
      (sources) => { sources["db-final"].value.database.directPollerAccepts = 1; },
      ...["queued", "liveClaims", "indeterminate", "unknown", "settlementPending"].map(
        (field) => (sources: JsonRecord) => { sources["db-final"].value.database.drain[field] = 1; },
      ),
      ...["externalAttempts", "results", "history", "bookingHistory", "notifications", "budgetReservations", "settlements"].map(
        (field) => (sources: JsonRecord) => { sources["db-final"].value.database.duplicates[field] = 1; },
      ),
      (sources) => { sources["runtime-final"].value.runtime.remainingPhase3RuntimeCount = 1; },
      (sources) => { sources["runtime-final"].value.runtime.services.poller.status = "running"; },
      (sources) => { sources["runtime-final"].value.runtime.services.inline.labels.releaseSha = "b".repeat(40); },
      (sources) => { sources["runtime-final"].value.runtime.restoredLegacyOwner.ownerNodeId = "wrong-node"; },
      (sources) => { sources["lease-continuity"].value.continuity.markerBindings.actions[0].markerSha256 = hash("wrong-marker"); },
      (sources) => { sources["lease-continuity"].value.continuity.after.guard.heartbeatMonotonicMs -= 10_000; },
      (sources) => { sources["capacity"].value.capacity.thresholds.envelopeApproved.maxCpuPercent = 71; },
      (sources) => { sources["production-observer"].value.productionObserver.expectedPolicySha256 = hash("wrong-policy"); },
      (sources) => { sources["capacity"].value.capacity.measurements.productionBaselineP95LatencyMs = 76; },
      (sources) => { sources["production-observer"].value.productionObserver.response.p95LatencyMs = 81; },
    ];
    for (const mutate of sourceMutations) {
      const sources = structuredClone(harness.collected);
      mutate(sources);
      for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
        sources[sourceId] = rehashRuntimeRecord(sources[sourceId].value);
      }
      const attempt = memoryPorts(harness, { async readSources() { return structuredClone(sources); } });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    {
      const sources = structuredClone(harness.collected);
      const observer = sources["production-observer"].value.productionObserver;
      const capacity = sources.capacity.value.capacity;
      observer.response.ready = false;
      observer.thresholdResult.passed = false;
      capacity.ok = false;
      capacity.failures = ["PRODUCTION_NOT_READY"];
      sources.capacity = rehashRuntimeRecord(sources.capacity.value);
      sources["production-observer"] = rehashRuntimeRecord(sources["production-observer"].value);
      const attempt = memoryPorts(harness, { async readSources() { return structuredClone(sources); } });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }
    {
      const sources = structuredClone(harness.collected);
      sources.capacity.value.capacity.measurements.a3CpuPercent = 80;
      sources.capacity.value.capacity.ok = false;
      sources.capacity.value.capacity.failures = ["A3_CPU_BUDGET_EXCEEDED"];
      sources.capacity = rehashRuntimeRecord(sources.capacity.value);
      const attempt = memoryPorts(harness, { async readSources() { return structuredClone(sources); } });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    for (const recoveryName of ["recoverSnapshot", "recoverSemantic"] as const) {
      let artifactRead = false;
      const attempt = memoryPorts(harness, {
        async [recoveryName]() { throw new Error("recovery sentinel"); },
        async readObservationMarkers() { artifactRead = true; return {}; },
      } as never);
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
      assert.equal(artifactRead, false);
    }
    {
      const conflict = structuredClone(harness.snapshot);
      conflict.actions[0].completedAt =
        new Date(Date.parse(conflict.actions[0].completedAt) + 1).toISOString();
      const attempt = memoryPorts(harness, {
        async readSnapshot() { return record(conflict, "/fixed/journal-snapshot.json"); },
      });
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }
    {
      const attempt = memoryPorts(harness);
      const conflict = structuredClone(baseline.evidence);
      conflict.timeline[0].completedAt = new Date(Date.parse(conflict.timeline[0].completedAt) + 1).toISOString();
      attempt.setSemantic(conflict);
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    const stableInput = { journalSnapshot: structuredClone(harness.snapshot) };
    const aliasAttempt = memoryPorts(harness);
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    let contextReached = false;
    aliasAttempt.ports.loadContext = async () => {
      contextReached = true;
      await contextGate;
      return structuredClone(harness.context);
    };
    const aliasPromise = produceInstalledPhase3RolloutEvidence(stableInput, aliasAttempt.ports as never);
    assert.equal(contextReached, true);
    stableInput.journalSnapshot.actions[0].actionId = "mutated-after-call";
    releaseContext();
    const aliasResult = await aliasPromise;
    assert.equal(aliasResult.evidence.schemaVersion, 2);

    {
      const hostile = memoryPorts(harness);
      const returnedContext = structuredClone(harness.context);
      const returnedActions = structuredClone(hostile.actionRecords);
      const returnedSources = structuredClone(harness.collected);
      const originalLoadCapability = hostile.ports.loadCapability;
      const originalWriteSemantic = hostile.ports.writeSemantic;
      let actionRead = 0;
      let sourceRead = 0;
      hostile.ports.loadContext = async () => returnedContext;
      hostile.ports.loadCapability = async (...args: unknown[]) => {
        returnedContext.installedBinding.candidateSha = "b".repeat(40);
        return originalLoadCapability(...args);
      };
      hostile.ports.readActionMeasurements = async () => {
        actionRead += 1;
        return actionRead === 1 ? returnedActions : structuredClone(hostile.actionRecords);
      };
      hostile.ports.readSources = async () => {
        sourceRead += 1;
        if (sourceRead === 1) {
          returnedActions[0].value.actionId = "mutated-after-marker-return";
          return returnedSources;
        }
        return structuredClone(harness.collected);
      };
      hostile.ports.writeSemantic = async (value: JsonRecord) => {
        const stored = await originalWriteSemantic(value);
        returnedSources["db-final"].value.database.directPollerAccepts = 99;
        value.timeline[0].actionId = "mutated-writer-input";
        return stored;
      };
      const detached = await produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, hostile.ports as never,
      );
      assert.equal(detached.sha256, baseline.sha256);
    }

    const finalRereadCases = [
      "host",
      "snapshot",
      "observation:0",
      "observation:1",
      ...PHASE3_ACTION_IDS.map((_, index) => `action:${index}`),
      ...PHASE3_RUNTIME_SOURCE_IDS.map((sourceId) => `source:${sourceId}`),
      "semantic",
    ];
    for (const kind of finalRereadCases) {
      const attempt = memoryPorts(harness);
      if (kind === "host") {
        let count = 0;
        attempt.ports.loadHostIdentity = async () => (++count === 2 ? hash("changed-host") : hostIdentitySha256);
      } else if (kind === "snapshot") {
        let count = 0;
        attempt.ports.readSnapshot = async () => {
          count += 1;
          if (count < 3) return structuredClone(attempt.snapshotRecord);
          const changed = structuredClone(harness.snapshot);
          changed.actions[0].completedAt = new Date(Date.parse(changed.actions[0].completedAt) + 1).toISOString();
          return record(changed, "/fixed/journal-snapshot.json");
        };
      } else if (kind.startsWith("observation:")) {
        const observationIndex = Number(kind.slice("observation:".length));
        const observationKey = observationIndex === 0 ? "schema" : "fence";
        let count = 0;
        attempt.ports.readObservationMarkers = async () => {
          count += 1;
          const changed = structuredClone(attempt.observationRecords);
          if (count === 2) {
            changed[observationKey].value.observedAt =
              new Date(Date.parse(changed[observationKey].value.observedAt) + 1).toISOString();
            changed[observationKey] = rehashMarkerRecord(changed[observationKey]);
          }
          return changed;
        };
      } else if (kind.startsWith("action:")) {
        const actionIndex = Number(kind.slice("action:".length));
        let count = 0;
        attempt.ports.readActionMeasurements = async () => {
          count += 1;
          const changed = structuredClone(attempt.actionRecords);
          if (count === 2) {
            changed[actionIndex].value.observedAt =
              new Date(Date.parse(changed[actionIndex].value.observedAt) + 1).toISOString();
            changed[actionIndex] = rehashMarkerRecord(changed[actionIndex]);
          }
          return changed;
        };
      } else if (kind.startsWith("source:")) {
        const sourceId = kind.slice("source:".length);
        let count = 0;
        attempt.ports.readSources = async () => {
          count += 1;
          const changed = structuredClone(harness.collected);
          if (count === 2) {
            if (sourceId === "db-final") {
              changed[sourceId].value.database.control.acknowledgedAt = new Date(
                Date.parse(changed[sourceId].value.database.control.acknowledgedAt) + 1,
              ).toISOString();
            } else if (sourceId === "runtime-final") {
              changed[sourceId].value.runtime.services.poller.containerId = "d".repeat(64);
            } else if (sourceId === "lease-continuity") {
              changed[sourceId].value.continuity.after.guard.heartbeatMonotonicMs += 1;
            } else if (sourceId === "capacity") {
              changed[sourceId].value.capacity.measurements.a3CpuPercent = 11;
            } else {
              changed[sourceId].value.productionObserver.response.p95LatencyMs = 81;
            }
            changed[sourceId] = rehashRuntimeRecord(changed[sourceId].value);
          }
          return changed;
        };
      } else {
        const originalRead = attempt.ports.readSemantic;
        let count = 0;
        attempt.ports.readSemantic = async () => {
          count += 1;
          const value = await originalRead();
          if (count === 3) {
            value.value.timeline[0].completedAt =
              new Date(Date.parse(value.value.timeline[0].completedAt) + 1).toISOString();
            return record(value.value, value.path);
          }
          return value;
        };
      }
      await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
        { journalSnapshot: harness.snapshot }, attempt.ports as never,
      ));
    }

    const crashMemory = memoryPorts(harness);
    const expected = await produceInstalledPhase3RolloutEvidence(
      { journalSnapshot: harness.snapshot }, crashMemory.ports as never,
    );
    await privateDirectory(harness.snapshotOptions.tempRootPath);
    const malformedTemporary = join(
      harness.snapshotOptions.tempRootPath,
      `journal-snapshot.${randomUUID()}.tmp`,
    );
    await writeFile(malformedTemporary, "{}", { mode: 0o600 });
    await chmod(malformedTemporary, 0o600);
    await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
      { journalSnapshot: harness.snapshot }, harness.ports as never,
    ));
    assert.deepEqual(await readdir(harness.snapshotOptions.tempRootPath), [malformedTemporary.split(/[\\/]/).at(-1)]);
    await rm(harness.snapshotOptions.tempRootPath, { recursive: true, force: true });
    for (const [options, basename, value] of [
      [harness.snapshotOptions, "journal-snapshot.json", harness.snapshot],
      [harness.semanticOptions, "phase3-rollout-evidence.json", expected.evidence],
    ] as const) {
      await privateDirectory(options.rootPath);
      await privateDirectory(options.tempRootPath);
      const stem = basename.slice(0, -5);
      const temporary = join(options.tempRootPath, `${stem}.${randomUUID()}.tmp`);
      const destination = join(options.rootPath, basename);
      await writeFile(temporary, canonicalJson(value), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await link(temporary, destination);
      assert.equal((await stat(destination, { bigint: true })).nlink, 2n);
    }
    const recovered = await produceInstalledPhase3RolloutEvidence(
      { journalSnapshot: harness.snapshot }, harness.ports as never,
    );
    assert.equal(recovered.sha256, expected.sha256);
    assert.deepEqual(await readdir(harness.snapshotOptions.tempRootPath), []);
    assert.deepEqual(await readdir(harness.semanticOptions.tempRootPath), []);
    assert.equal((await stat(join(harness.snapshotOptions.rootPath, "journal-snapshot.json"), { bigint: true })).nlink, 1n);
    assert.equal((await stat(join(harness.semanticOptions.rootPath, "phase3-rollout-evidence.json"), { bigint: true })).nlink, 1n);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("rejects hostile invocation shapes before any caller port effect", async () => {
  await assert.rejects(
    () => produceInstalledPhase3RolloutEvidence({} as never),
    /^Error: installed Phase 3 rollout evidence production failed$/,
  );
  const snapshot = { journalSnapshot: {} };
  const touched: string[] = [];
  const partial = { async loadContext() { touched.push("context"); } };
  await assert.rejects(
    () => produceInstalledPhase3RolloutEvidence(snapshot as never, partial as never),
    /^Error: installed Phase 3 rollout evidence production failed$/,
  );
  const accessor = {} as JsonRecord;
  Object.defineProperty(accessor, "journalSnapshot", { enumerable: true, get: () => ({}) });
  await assert.rejects(
    () => produceInstalledPhase3RolloutEvidence(accessor as never),
    /^Error: installed Phase 3 rollout evidence production failed$/,
  );
  for (const invalid of [
    { journalSnapshot: {}, extra: true },
    Object.assign(Object.create(null), { journalSnapshot: {}, extra: true }),
  ]) {
    await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(invalid as never));
  }
  const hiddenInput = { journalSnapshot: {} } as JsonRecord;
  Object.defineProperty(hiddenInput, "hidden", { value: true });
  await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(hiddenInput as never));
  const symbolInput = { journalSnapshot: {} } as JsonRecord;
  Object.defineProperty(symbolInput, Symbol("hidden"), { enumerable: true, value: true });
  await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(symbolInput as never));

  const completePorts = Object.fromEntries(
    PRODUCER_PORT_NAMES.map((name) => [name, async () => { touched.push(name); }]),
  ) as JsonRecord;
  for (const invalidPorts of [
    { ...completePorts, extra: async () => {} },
    Object.assign({ ...completePorts }, { loadContext: undefined }),
  ]) {
    await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(
      snapshot as never,
      invalidPorts as never,
    ));
  }
  const hiddenPorts = { ...completePorts } as JsonRecord;
  Object.defineProperty(hiddenPorts, "hidden", { value: async () => {} });
  await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(snapshot as never, hiddenPorts as never));
  const symbolPorts = { ...completePorts } as JsonRecord;
  Object.defineProperty(symbolPorts, Symbol("hidden"), { enumerable: true, value: async () => {} });
  await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(snapshot as never, symbolPorts as never));
  const accessorPorts = { ...completePorts } as JsonRecord;
  Object.defineProperty(accessorPorts, "loadContext", { enumerable: true, get: () => async () => {} });
  await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(snapshot as never, accessorPorts as never));
  await expectProductionFailure(() => (produceInstalledPhase3RolloutEvidence as any)(snapshot, completePorts, completePorts));
  await expectProductionFailure(() => (produceInstalledPhase3RolloutEvidence as any)(snapshot, undefined));
  const originalNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await expectProductionFailure(() => produceInstalledPhase3RolloutEvidence(snapshot as never, completePorts as never));
  } finally {
    process.env.NODE_ENV = originalNodeEnvironment;
  }
  assert.deepEqual(touched, []);
});
