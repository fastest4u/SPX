import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import { openStagingActionLedger } from "../scripts/lib/staging-action-ledger.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_RUNTIME_SOURCE_IDS,
  phase3PartitionIdentity,
  readPhase3CapacityObservationCheckpoint,
  readPhase3RuntimeSource,
  readPhase3RuntimeSources,
  recoverPhase3CapacityObservationCheckpointStorage,
  recoverPhase3RuntimeSourceStorage,
  writePhase3CapacityObservationCheckpoint,
  writePhase3RuntimeSource,
} from "../scripts/lib/phase3-staging-evidence.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import { STAGING_PROVISIONED_DB_ROLES } from "../scripts/lib/staging-action-capability.mjs";
import { createTestStagingOperationRegistry } from "../scripts/lib/staging-operation-registry.mjs";
import {
  collectInstalledPhase3RuntimeSources,
  validatePhase3RuntimeSourceValue,
} from "../scripts/staging-phase3-runtime-evidence.mjs";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowMonotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const leaseStartedMonotonicMs = nowMonotonicMs() - 30_000;
const partition = phase3PartitionIdentity(2, "phase3-ifn-final-001");
const baseTime = Date.now() - 60_000;
const markerObservedAt = new Date(baseTime + 20_000).toISOString();
const completedAt = (index: number): string => new Date(baseTime + index * 1_000).toISOString();
const approvalId = "phase3-approval-final-001";
const gate3PlanEntry = REQUIRED_STAGING_ACTION_PLAN.find(
  (entry) => entry.actionId === "staging-gate-3-handoff",
)!;
const inlineRestorePlanEntry = REQUIRED_STAGING_ACTION_PLAN.find(
  (entry) => entry.actionId === "phase3-inline-owner-restore",
)!;

const binding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${hash("candidate-image")}`,
  releaseManifestSha256: hash("release-manifest"),
  environment: "staging",
  topology: "phase3",
  composeProject: "spx-staging",
  operatorBundleSha256: hash("operator-bundle"),
  stagingTargetDescriptorSha256: hash("target-descriptor"),
  stagingApprovalEnvelopeSha256: hash("approval-envelope"),
  actionJournalHeadSha256: hash("terminal:phase3-inline-owner-restore"),
  stagingRunId: "staging-run-phase3-final-001",
};
const rollbackReleaseManifestSha256 = hash("rollback-release-manifest");
const productionObserverPolicySha256 = hash("production-observer-policy");
const approvedThresholds = {
  maxCpuPercent: 70,
  minMemoryFreeBytes: 4_000_000_000,
  minMysqlConnectionsFree: 40,
  productionP95LatencyMs: 200,
  maxLatencyIncreasePercent: 25,
};
const context = {
  installedBinding: binding,
  envelope: { approvalId, policy: { thresholds: approvedThresholds } },
  artifacts: {},
  verified: { approvalId, rollbackReleaseManifestSha256 },
  descriptor: {
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    composeProject: "spx-staging",
    target: { productionObserverPolicySha256 },
  },
};
const capability = {
  schemaVersion: 1,
  releaseBinding: Object.fromEntries(
    [
      "candidateSha", "imageDigest", "releaseManifestSha256", "environment", "topology",
      "composeProject", "stagingTargetDescriptorSha256", "operatorBundleSha256",
      "stagingApprovalEnvelopeSha256", "stagingRunId",
    ].map((field) => [field, binding[field as keyof typeof binding]]),
  ),
  database: {
    host: "mysql.staging.internal",
    port: 3306,
    name: "spx_staging",
    sslServername: "mysql.staging.internal",
    caSha256: hash("database-ca"),
    actors: { bootstrap: "spx_staging_bootstrap", phase3Control: "spx_stg_phase3_control" },
    actorHosts: { bootstrap: "172.17.0.1", phase3Control: "172.17.0.1" },
    principalRoles: [...STAGING_PROVISIONED_DB_ROLES],
  },
  phase3: { canaryTeamId: partition.teamId, canaryEpoch: partition.epoch },
};

function lease(role: "guard" | "watchdog", heartbeat: number) {
  return {
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
    startedMonotonicMs: leaseStartedMonotonicMs,
    heartbeatMonotonicMs: heartbeat,
    heartbeatAgeMs: 100,
  };
}

function loadedLeases(heartbeat = nowMonotonicMs() - 1_000) {
  return {
    stagingRunId: binding.stagingRunId,
    guard: lease("guard", heartbeat),
    watchdog: lease("watchdog", heartbeat - 10),
    maxAgeMs: 10_000,
  };
}

function journalSnapshot() {
  const actions = REQUIRED_STAGING_ACTION_PLAN.map((entry) => {
    const succeeded = entry.sequence <= inlineRestorePlanEntry.sequence;
    const phase3Index = PHASE3_ACTION_IDS.indexOf(entry.actionId);
    const terminalCompletedAt = entry.sequence < gate3PlanEntry.sequence
      ? new Date(baseTime - (gate3PlanEntry.sequence - entry.sequence) * 1_000).toISOString()
      : entry.actionId === gate3PlanEntry.actionId
        ? completedAt(0)
        : completedAt(phase3Index + 1);
    return {
      sequence: entry.sequence,
      actionId: entry.actionId,
      scope: entry.scope,
      kind: entry.kind,
      mutationSha256: entry.mutationSha256,
      state: succeeded ? "succeeded" : "registered",
      occurrences: succeeded ? 1 : 0,
      terminalRecordSha256: succeeded ? hash(`terminal:${entry.actionId}`) : null,
      completedAt: succeeded ? terminalCompletedAt : null,
      reconciliationId: null,
      reconciliationOutcome: null,
    };
  });
  return {
    schemaVersion: 1,
    binding: {
      approvalId,
      stagingRunId: binding.stagingRunId,
      approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
      targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
      operatorBundleSha256: binding.operatorBundleSha256,
    },
    recordCount: actions.length + 2 * inlineRestorePlanEntry.sequence,
    headSha256: binding.actionJournalHeadSha256,
    actions,
  };
}

function snapshotAction(
  snapshot: ReturnType<typeof journalSnapshot>,
  actionId: string,
): ReturnType<typeof journalSnapshot>["actions"][number] {
  const action = snapshot.actions.find((entry) => entry.actionId === actionId);
  assert.ok(action, `snapshot is missing action ${actionId}`);
  return action;
}

function labels(service: string) {
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

function markerLabels(service: string) {
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

function control(generation: number, state: "enabled" | "fenced", acknowledged = false) {
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
    acknowledgedAt: acknowledged ? completedAt(6) : null,
  };
}

const zeroDrain = { queued: 0, liveClaims: 0, indeterminate: 0, unknown: 0, settlementPending: 0 };

function actionMeasurements(actionId: string, generation: number | null) {
  const identity = (service: string, nodeId: string, enabled: boolean) => ({
    service,
    nodeId,
    status: "running",
    health: "healthy",
    imageId: binding.imageDigest,
    labels: markerLabels(service),
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
      return { control: control(generation as number, "enabled") };
    case "phase3-execution-enable":
      return { consumer: identity(partition.consumerService, partition.consumerNodeId, true) };
    case "phase3-publication-fence":
      return { control: control(generation as number, "fenced") };
    case "phase3-drain-or-quarantine":
      return { control: control(generation as number, "fenced", true), drain: zeroDrain };
    case "phase3-inline-owner-restore":
      return {
        control: control(generation as number, "fenced", true),
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
            labels: markerLabels(partition.legacyService),
          },
        },
      };
    default:
      throw new Error(`unknown action ${actionId}`);
  }
}

function actionMarkers(
  leases: ReturnType<typeof loadedLeases>,
  snapshot: ReturnType<typeof journalSnapshot>,
) {
  return PHASE3_ACTION_IDS.map((actionId, index) => {
    const terminal = snapshotAction(snapshot, actionId);
    const generation = index < 3 ? null : 7;
    return {
      schemaVersion: 1,
      actionId,
      mutationSha256: terminal.mutationSha256,
      terminalRecordSha256: terminal.terminalRecordSha256,
      completedAt: terminal.completedAt,
      observedAt: markerObservedAt,
      releaseBinding: {
        candidateSha: binding.candidateSha,
        imageDigest: binding.imageDigest,
        releaseManifestSha256: binding.releaseManifestSha256,
        stagingTargetDescriptorSha256: binding.stagingTargetDescriptorSha256,
        operatorBundleSha256: binding.operatorBundleSha256,
        stagingApprovalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
        stagingRunId: binding.stagingRunId,
      },
      guardLeaseId: leases.guard.leaseId,
      watchdogLeaseId: leases.watchdog.leaseId,
      teamId: partition.teamId,
      epoch: partition.epoch,
      generation,
      measurements: actionMeasurements(actionId, generation),
    };
  });
}

function observations(
  leases: ReturnType<typeof loadedLeases>,
  snapshot: ReturnType<typeof journalSnapshot>,
) {
  const gate3 = snapshotAction(snapshot, "staging-gate-3-handoff");
  const fence = snapshotAction(snapshot, "phase3-publication-fence");
  return {
    schema: {
      schemaVersion: 1,
      observationId: "phase3-schema-verify",
      requiredTerminalActionId: "staging-gate-3-handoff",
      terminalRecordSha256: gate3.terminalRecordSha256,
      actionJournalHeadSha256: gate3.terminalRecordSha256,
      stagingRunId: binding.stagingRunId,
      teamId: partition.teamId,
      epoch: partition.epoch,
      pollerNodeId: partition.pollerNodeId,
      approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
      releaseManifestSha256: binding.releaseManifestSha256,
      rollbackReleaseManifestSha256,
      targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
      operatorBundleSha256: binding.operatorBundleSha256,
      guardLeaseId: leases.guard.leaseId,
      watchdogLeaseId: leases.watchdog.leaseId,
      generation: null,
      observedAt: markerObservedAt,
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
      schemaVersion: 1,
      observationId: "phase3-fence-ack-wait",
      requiredTerminalActionId: "phase3-publication-fence",
      terminalRecordSha256: fence.terminalRecordSha256,
      actionJournalHeadSha256: fence.terminalRecordSha256,
      stagingRunId: binding.stagingRunId,
      teamId: partition.teamId,
      epoch: partition.epoch,
      pollerNodeId: partition.pollerNodeId,
      approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
      releaseManifestSha256: binding.releaseManifestSha256,
      rollbackReleaseManifestSha256,
      targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
      operatorBundleSha256: binding.operatorBundleSha256,
      guardLeaseId: leases.guard.leaseId,
      watchdogLeaseId: leases.watchdog.leaseId,
      generation: 7,
      observedAt: markerObservedAt,
      measurements: {
        state: "fenced",
        publicationGeneration: 7,
        fenceJobId: 41,
        ackJobId: 42,
        pollerNodeId: partition.pollerNodeId,
        ackNodeId: partition.pollerNodeId,
        acknowledgedAt: completedAt(6),
        isActive: true,
        observerReadOnly: true,
      },
    },
  };
}

function markerRecord(kind: "action" | "observation", id: string, value: unknown) {
  const bytes = canonicalJson(value);
  return {
    [kind === "action" ? "actionId" : "observationId"]: id,
    path: `/protected/${id}.json`,
    value,
    bytes,
    sha256: hash(bytes),
  };
}

function inspectValues() {
  const raw = (
    service: string,
    nodeId: string,
    idCharacter: string,
    status: "running" | "exited",
    environment: string[],
  ) => ({
    Id: idCharacter.repeat(64),
    Image: binding.imageDigest,
    Config: { Labels: labels(service), Env: [`SPX_NODE_ID=${nodeId}`, ...environment] },
    State: {
      Status: status,
      Paused: false,
      Restarting: false,
      ...(status === "running" ? { Health: { Status: "healthy" } } : {}),
    },
  });
  return {
    [partition.pollerService]: raw(
      partition.pollerService,
      partition.pollerNodeId,
      "a",
      "exited",
      [
        `AUTO_ACCEPT_JOB_CUTOVER_EPOCH=${partition.epoch}`,
        "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=false",
        "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=false",
        "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=false",
      ],
    ),
    [partition.consumerService]: raw(
      partition.consumerService,
      partition.consumerNodeId,
      "b",
      "exited",
      [
        "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=false",
        "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=true",
        "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=true",
      ],
    ),
    [partition.legacyService]: raw(
      partition.legacyService,
      partition.legacyNodeId,
      "c",
      "running",
      ["SPX_ROLE=worker", `RUN_TEAM_IDS=${partition.teamId}`],
    ),
  };
}

function databaseEvidence() {
  return {
    ok: true,
    evidenceId: "phase3-gate4-final",
    control: {
      state: "fenced",
      generation: 7,
      fenceJobId: 41,
      ackJobId: 42,
      pollerNodeMatches: true,
      acknowledgedAt: completedAt(6),
    },
    drain: { queued: 1, liveClaims: 2, indeterminate: 3, unknown: 4, settlementPending: 5 },
    duplicates: {
      externalAttempts: 6,
      results: 7,
      history: 8,
      bookingHistory: 9,
      notifications: 10,
      budgetReservations: 11,
      settlements: 12,
    },
    staleEpochActions: 13,
    directPollerAccepts: 14,
    inlineLease: { activeOwnerCount: 1, ownerNodeId: partition.legacyNodeId, ownerMatches: true },
  };
}

function capacityPair() {
  const observedAt = new Date().toISOString();
  const measurements = {
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
    productionP95LatencyMs: 80,
    productionBaselineP95LatencyMs: 75,
    productionLatencyIncreasePercent: 100 / 15,
  };
  const thresholds = {
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
  };
  return {
    capacity: { schemaVersion: 1, observedAt, ok: true, failures: [], measurements, thresholds },
    productionObserver: {
      schemaVersion: 1,
      expectedPolicySha256: productionObserverPolicySha256,
      requestMethod: "GET",
      response: { p95LatencyMs: 80, ready: true },
      observedAt,
      thresholdResult: {
        absoluteP95WithinApprovedLimit: true,
        latencyIncreaseWithinApprovedLimit: true,
        passed: true,
      },
    },
  };
}

type StorageRecord = { value: unknown; bytes: string; sha256: string };
type HarnessOverrides = Record<string, unknown> & {
  sourceValues?: Map<string, StorageRecord>;
  checkpointValue?: StorageRecord | null;
  journalSnapshotValue?: ReturnType<typeof journalSnapshot>;
};

function sourceRecord(sourceId: string, value: unknown) {
  const bytes = canonicalJson(value);
  return { sourceId, path: `/protected/sources/${sourceId}.json`, value, bytes, sha256: hash(bytes) };
}

function clonedSourceValues(sourceValues: Map<string, StorageRecord>) {
  return new Map(
    [...sourceValues].map(([sourceId, record]) => [sourceId, structuredClone(record)]),
  );
}

function checkpointRecord(value: unknown) {
  const bytes = canonicalJson(value);
  return { path: "/protected/checkpoint.json", value, bytes, sha256: hash(bytes) };
}

function missing(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "ENOENT" });
}

function harness(overrides: HarnessOverrides = {}) {
  const calls: string[] = [];
  const snapshotValue = overrides.journalSnapshotValue ?? journalSnapshot();
  const callerLeases = loadedLeases();
  const before = structuredClone(callerLeases);
  before.guard.heartbeatMonotonicMs += 20;
  before.watchdog.heartbeatMonotonicMs += 20;
  const after = structuredClone(before);
  after.guard.heartbeatMonotonicMs += 20;
  after.watchdog.heartbeatMonotonicMs += 20;
  const markerValues = actionMarkers(before, snapshotValue);
  const observationValues = observations(before, snapshotValue);
  const sourceValues = overrides.sourceValues ?? new Map<string, StorageRecord>();
  let checkpointValue = overrides.checkpointValue ?? null;
  let leaseRead = 0;
  const inspections = inspectValues();
  const pair = capacityPair();
  const basePorts = {
    async loadContext() { calls.push("context"); return structuredClone(context); },
    async loadCapability() { calls.push("capability"); return structuredClone(capability); },
    async loadObserverDatabase(loadedCapability: unknown, role: string) {
      calls.push("database-credential");
      assert.deepEqual(loadedCapability, capability);
      assert.equal(role, "phase3-observer");
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
      leaseRead += 1;
      calls.push(`leases-${leaseRead}`);
      const value = structuredClone(leaseRead === 1 ? before : after);
      if (leaseRead > 1) {
        const freshHeartbeat = nowMonotonicMs() - 1_000;
        for (const role of ["guard", "watchdog"] as const) {
          value[role].heartbeatMonotonicMs = Math.max(
            value[role].heartbeatMonotonicMs,
            freshHeartbeat,
          );
          value[role].heartbeatAgeMs = 1_000;
        }
      }
      return value;
    },
    async readActionMeasurements() {
      calls.push("actions");
      return markerValues.map((value, index) => markerRecord("action", PHASE3_ACTION_IDS[index], value));
    },
    async readObservationMarkers() {
      calls.push("observations");
      return {
        schema: markerRecord("observation", "phase3-schema-verify", observationValues.schema),
        fence: markerRecord("observation", "phase3-fence-ack-wait", observationValues.fence),
      };
    },
    async assertLocalDocker() { calls.push("docker-local"); return true; },
    async listFixedServiceContainerIds(service: string) {
      calls.push(`list:${service}`);
      const value = inspections[service as keyof typeof inspections];
      return value ? [value.Id] : [];
    },
    async inspectFixedContainer(containerId: string) {
      calls.push(`inspect:${containerId[0]}`);
      const value = Object.values(inspections).find((entry) => entry.Id === containerId);
      return structuredClone(value);
    },
    async runDatabaseEvidence(payload: Record<string, unknown>, installedBinding: unknown) {
      calls.push("database");
      assert.deepEqual(installedBinding, binding);
      assert.deepEqual(Object.keys(payload), [
        "schemaVersion", "evidenceId", "teamId", "epoch", "generation", "pollerNodeId",
        "expectedOwnerNodeId", "windowStartedAt", "windowEndedAt", "connection",
      ]);
      assert.deepEqual({ ...payload, connection: "authenticated" }, {
        schemaVersion: 1,
        evidenceId: "phase3-gate4-final",
        teamId: partition.teamId,
        epoch: partition.epoch,
        generation: 7,
        pollerNodeId: partition.pollerNodeId,
        expectedOwnerNodeId: partition.legacyNodeId,
        windowStartedAt: completedAt(0),
        windowEndedAt: completedAt(8),
        connection: "authenticated",
      });
      return databaseEvidence();
    },
    async collectCapacityEvidence(...args: unknown[]) {
      calls.push("capacity-collect");
      assert.equal(args.length, 0);
      return structuredClone(pair);
    },
    async recoverRuntimeSources(...args: unknown[]) {
      calls.push("recover-runtime");
      assert.equal(args.length, 0);
    },
    async recoverCapacityCheckpoint(...args: unknown[]) {
      calls.push("recover-checkpoint");
      assert.equal(args.length, 0);
    },
    async readCapacityCheckpoint() {
      calls.push("checkpoint-read");
      if (!checkpointValue) throw missing("checkpoint absent sentinel");
      return { ...checkpointValue, path: "/protected/checkpoint.json" };
    },
    async writeCapacityCheckpoint(value: unknown) {
      calls.push("checkpoint-write");
      if (checkpointValue && checkpointValue.bytes !== canonicalJson(value)) {
        throw new Error("checkpoint conflict sentinel");
      }
      checkpointValue = checkpointRecord(structuredClone(value));
      return structuredClone(checkpointValue);
    },
    async readSource(sourceId: string) {
      calls.push(`source-read:${sourceId}`);
      const record = sourceValues.get(sourceId);
      if (!record) throw missing(`source ${sourceId} absent sentinel`);
      return { sourceId, path: `/protected/sources/${sourceId}.json`, ...structuredClone(record) };
    },
    async writeSource(sourceId: string, value: unknown) {
      calls.push(`source-write:${sourceId}`);
      if (sourceValues.has(sourceId)) throw new Error("attempted present-source write sentinel");
      const record = sourceRecord(sourceId, structuredClone(value));
      sourceValues.set(sourceId, { value: record.value, bytes: record.bytes, sha256: record.sha256 });
      return record;
    },
    async readSources() {
      calls.push("sources-read-all");
      const result: Record<string, StorageRecord> = {};
      for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
        const record = sourceValues.get(sourceId);
        if (!record) throw missing(`final source ${sourceId} absent sentinel`);
        result[sourceId] = structuredClone(record);
      }
      return result;
    },
  };
  const ports = { ...basePorts } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (
      key !== "sourceValues" &&
      key !== "checkpointValue" &&
      key !== "journalSnapshotValue"
    ) ports[key] = value;
  }
  return {
    input: { journalSnapshot: snapshotValue, leases: callerLeases },
    ports,
    calls,
    sourceValues,
    get checkpointValue() { return checkpointValue; },
    pair,
    before,
    after,
    markerValues,
    observationValues,
    inspections,
  };
}

type RealStoragePaths = {
  parent: string;
  sourceRoot: string;
  sourceTempRoot: string;
  checkpointRoot: string;
  checkpointTempRoot: string;
};

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function realStoragePaths(base: string, label: string): Promise<RealStoragePaths> {
  const parent = join(base, label);
  await privateDirectory(parent);
  return {
    parent,
    sourceRoot: join(parent, "phase3-sources"),
    sourceTempRoot: join(parent, ".phase3-source-tmp"),
    checkpointRoot: join(parent, "phase3-capacity-observation"),
    checkpointTempRoot: join(parent, ".phase3-capacity-observation-tmp"),
  };
}

function installRealStoragePorts(
  fixture: ReturnType<typeof harness>,
  paths: RealStoragePaths,
): void {
  const sourceOptions = {
    rootPath: paths.sourceRoot,
    tempRootPath: paths.sourceTempRoot,
  };
  const checkpointOptions = {
    rootPath: paths.checkpointRoot,
    tempRootPath: paths.checkpointTempRoot,
  };
  fixture.ports.recoverRuntimeSources = async () => {
    fixture.calls.push("recover-runtime");
    await recoverPhase3RuntimeSourceStorage(sourceOptions);
  };
  fixture.ports.recoverCapacityCheckpoint = async () => {
    fixture.calls.push("recover-checkpoint");
    await recoverPhase3CapacityObservationCheckpointStorage(checkpointOptions);
  };
  fixture.ports.readCapacityCheckpoint = async () => {
    fixture.calls.push("checkpoint-read");
    return readPhase3CapacityObservationCheckpoint({ rootPath: paths.checkpointRoot });
  };
  fixture.ports.writeCapacityCheckpoint = async (value: unknown) => {
    fixture.calls.push("checkpoint-write");
    return writePhase3CapacityObservationCheckpoint(value, checkpointOptions);
  };
  fixture.ports.readSource = async (sourceId: string) => {
    fixture.calls.push(`source-read:${sourceId}`);
    return readPhase3RuntimeSource(sourceId, { rootPath: paths.sourceRoot });
  };
  fixture.ports.writeSource = async (sourceId: string, value: unknown) => {
    fixture.calls.push(`source-write:${sourceId}`);
    return writePhase3RuntimeSource(sourceId, value, sourceOptions);
  };
  fixture.ports.readSources = async () => {
    fixture.calls.push("sources-read-all");
    return readPhase3RuntimeSources({ rootPath: paths.sourceRoot });
  };
}

async function linkedCrashFile(
  temporary: string,
  destination: string,
  value: unknown,
): Promise<{ bytes: string; inode: bigint }> {
  const bytes = canonicalJson(value);
  await writeFile(temporary, bytes, { mode: 0o600 });
  await link(temporary, destination);
  const status = await stat(destination, { bigint: true });
  assert.equal(status.nlink, 2n);
  return { bytes, inode: status.ino };
}

function assertNoLiveCollection(calls: string[]): void {
  assert.equal(calls.includes("docker-local"), false);
  assert.equal(calls.includes("database-credential"), false);
  assert.equal(calls.includes("database"), false);
  assert.equal(calls.includes("capacity-collect"), false);
  assert.equal(calls.some((entry) => entry.startsWith("list:")), false);
}

function assertDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

async function rejection(operation: () => Promise<unknown>, pattern = /runtime evidence collection failed/i) {
  await assert.rejects(operation, pattern);
}

async function createRealLedgerSnapshot(): Promise<ReturnType<typeof journalSnapshot>> {
  const root = await mkdtemp(join(tmpdir(), "spx-phase3-runtime-real-ledger-"));
  const ledgerBinding = {
    approvalId,
    stagingRunId: binding.stagingRunId,
    approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
  };
  const notBefore = new Date(baseTime - 120_000).toISOString();
  const expiresAt = new Date(baseTime + 120_000).toISOString();
  const actions = REQUIRED_STAGING_ACTION_PLAN.map((entry) => ({
    ...ledgerBinding,
    ...entry,
    notBefore,
    expiresAt,
    signatureVerified: true,
  }));
  let clockMs = baseTime - 30_000;
  let ledger: Awaited<ReturnType<typeof openStagingActionLedger>> | null = null;
  try {
    ledger = await openStagingActionLedger({
      rootPath: root,
      binding: ledgerBinding,
      actions,
      now: () => new Date((clockMs += 100)),
      verifyAction(value: Record<string, unknown>) {
        if (value.signatureVerified !== true) throw new Error("test signed action is invalid");
        return true;
      },
      operationRegistry: createTestStagingOperationRegistry(actions),
      enforceOwnership: false,
      enforceMode: process.platform !== "win32",
    });
    for (const action of actions.slice(0, inlineRestorePlanEntry.sequence)) {
      await ledger.consume(action);
    }
    const snapshot = await ledger.snapshot();
    assert.equal(snapshot.actions.length, REQUIRED_STAGING_ACTION_PLAN.length);
    assert.equal(snapshot.recordCount, EXPECTED_REAL_SNAPSHOT_RECORD_COUNT);
    return snapshot as ReturnType<typeof journalSnapshot>;
  } finally {
    await ledger?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const EXPECTED_REAL_SNAPSHOT_RECORD_COUNT =
  REQUIRED_STAGING_ACTION_PLAN.length + 2 * inlineRestorePlanEntry.sequence;

async function main(): Promise<void> {
  assert.equal(typeof collectInstalledPhase3RuntimeSources, "function");
  assert.equal(typeof validatePhase3RuntimeSourceValue, "function");

  for (const mutate of [
    (value: Record<PropertyKey, unknown>) => { value.extra = true; },
    (value: Record<PropertyKey, unknown>) => { value[Symbol("extra")] = true; },
    (value: Record<PropertyKey, unknown>) => Object.defineProperty(value, "extra", { value: true }),
    (value: Record<PropertyKey, unknown>) => {
      const journal = value.journalSnapshot;
      delete value.journalSnapshot;
      Object.defineProperty(value, "journalSnapshot", { enumerable: true, get: () => journal });
    },
  ]) {
    const fixture = harness();
    const invalid = { ...fixture.input } as Record<PropertyKey, unknown>;
    mutate(invalid);
    await rejection(
      () => collectInstalledPhase3RuntimeSources(invalid as never, fixture.ports as never),
      /input|argument|plain|field|data/i,
    );
    assert.deepEqual(fixture.calls, []);
  }

  {
    const fixture = harness();
    const partial = { ...fixture.ports };
    delete partial.readSources;
    await rejection(
      () => collectInstalledPhase3RuntimeSources(fixture.input, partial as never),
      /ports|complete|invalid/i,
    );
    const hidden = { ...fixture.ports };
    Object.defineProperty(hidden, "hidden", { value: () => true });
    await rejection(
      () => collectInstalledPhase3RuntimeSources(fixture.input, hidden as never),
      /ports|complete|invalid/i,
    );
    const symbol = { ...fixture.ports } as Record<PropertyKey, unknown>;
    symbol[Symbol("port")] = () => true;
    await rejection(
      () => collectInstalledPhase3RuntimeSources(fixture.input, symbol as never),
      /ports|complete|invalid/i,
    );
    await rejection(
      () => (collectInstalledPhase3RuntimeSources as never)(fixture.input, fixture.ports, true),
      /argument/i,
    );
    assert.deepEqual(fixture.calls, []);
  }

  {
    const fixture = harness();
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await rejection(
        () => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never),
        /production|argument|ports/i,
      );
    } finally {
      process.env.NODE_ENV = original;
    }
    assert.deepEqual(fixture.calls, []);
  }

  const first = harness();
  assert.equal(first.input.journalSnapshot.actions.length, REQUIRED_STAGING_ACTION_PLAN.length);
  assert.equal(
    first.input.journalSnapshot.recordCount,
    REQUIRED_STAGING_ACTION_PLAN.length + 2 * inlineRestorePlanEntry.sequence,
  );
  assert.deepEqual(
    first.input.journalSnapshot.actions[inlineRestorePlanEntry.sequence],
    {
      ...REQUIRED_STAGING_ACTION_PLAN[inlineRestorePlanEntry.sequence],
      state: "registered",
      occurrences: 0,
      terminalRecordSha256: null,
      completedAt: null,
      reconciliationId: null,
      reconciliationOutcome: null,
    },
  );
  const result = await collectInstalledPhase3RuntimeSources(first.input, first.ports as never);
  assert.deepEqual(Object.keys(result), PHASE3_RUNTIME_SOURCE_IDS);
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    assert.deepEqual(Object.keys(result[sourceId]), ["value", "bytes", "sha256"]);
    assert.equal(result[sourceId].bytes, canonicalJson(result[sourceId].value));
    assert.equal(result[sourceId].sha256, hash(result[sourceId].bytes));
  }
  assertDeepFrozen(result);
  const common = result["db-final"].value.context;
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    assert.deepEqual(result[sourceId].value.context, common);
    assert.equal(validatePhase3RuntimeSourceValue(sourceId, result[sourceId].value, common), true);
  }
  assert.deepEqual(common, {
    stagingRunId: binding.stagingRunId,
    actionJournalHeadSha256: binding.actionJournalHeadSha256,
    candidateSha: binding.candidateSha,
    imageDigest: binding.imageDigest,
    releaseManifestSha256: binding.releaseManifestSha256,
    rollbackReleaseManifestSha256,
    stagingTargetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
    teamId: partition.teamId,
    epoch: partition.epoch,
    generation: 7,
    windowStartedAt: completedAt(0),
    windowEndedAt: completedAt(8),
    guardLeaseId: first.before.guard.leaseId,
    watchdogLeaseId: first.before.watchdog.leaseId,
  });
  assert.ok(first.calls.indexOf("leases-1") < first.calls.indexOf("actions"));
  assert.ok(first.calls.indexOf("leases-1") < first.calls.indexOf("observations"));
  assert.ok(first.calls.indexOf("actions") < first.calls.indexOf("recover-runtime"));
  assert.ok(first.calls.indexOf("observations") < first.calls.indexOf("recover-runtime"));
  assert.ok(first.calls.indexOf("recover-runtime") < first.calls.indexOf("recover-checkpoint"));
  assert.ok(first.calls.indexOf("recover-checkpoint") < first.calls.indexOf("source-read:db-final"));
  assert.ok(first.calls.indexOf("recover-checkpoint") < first.calls.indexOf("checkpoint-read"));
  assert.ok(first.calls.indexOf("docker-local") < first.calls.indexOf("database-credential"));
  assert.ok(first.calls.indexOf("checkpoint-write") < first.calls.indexOf("source-write:db-final"));
  assert.equal(first.calls.filter((entry) => entry === "capacity-collect").length, 1);
  assert.deepEqual(
    first.calls.filter((entry) => entry.startsWith("source-write:")).map((entry) => entry.slice(13)),
    PHASE3_RUNTIME_SOURCE_IDS,
  );
  assert.doesNotMatch(JSON.stringify(result), /password|test-ca|mysql\.staging|\/protected|rawRows/i);
  for (const service of Object.values(result["runtime-final"].value.runtime.services)) {
    assert.equal(service.paused, false);
    assert.equal(service.restarting, false);
  }
  const runtimeSourceText = readFileSync(
    new URL("../scripts/staging-phase3-runtime-evidence.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runtimeSourceText, /const DATABASE_TIMEOUT_MS = 120_000;/);

  {
    const realSnapshot = await createRealLedgerSnapshot();
    const realBinding = {
      ...binding,
      actionJournalHeadSha256: realSnapshot.headSha256,
    };
    const realContext = structuredClone(context);
    realContext.installedBinding = realBinding;
    const fixture = harness({
      journalSnapshotValue: realSnapshot,
      async loadContext() {
        fixture.calls.push("context");
        return structuredClone(realContext);
      },
      async runDatabaseEvidence(payload: Record<string, unknown>, installedBinding: unknown) {
        fixture.calls.push("database");
        assert.deepEqual(installedBinding, realBinding);
        const evidence = databaseEvidence();
        const started = Date.parse(payload.windowStartedAt as string);
        const ended = Date.parse(payload.windowEndedAt as string);
        evidence.control.acknowledgedAt = new Date(started + Math.floor((ended - started) / 2))
          .toISOString();
        return evidence;
      },
    });
    const realResult = await collectInstalledPhase3RuntimeSources(
      fixture.input,
      fixture.ports as never,
    );
    assert.equal(realResult["db-final"].value.context.actionJournalHeadSha256, realSnapshot.headSha256);
    assert.equal(
      realResult["db-final"].value.context.windowStartedAt,
      snapshotAction(realSnapshot, "staging-gate-3-handoff").completedAt,
    );
    assert.equal(
      realResult["db-final"].value.context.windowEndedAt,
      snapshotAction(realSnapshot, "phase3-inline-owner-restore").completedAt,
    );
    assert.equal(snapshotAction(realSnapshot, "staging-gate-4-phase3").state, "registered");
  }

  for (const [recoveryPort, expectedCalls] of [
    ["recoverRuntimeSources", ["recover-runtime"]],
    ["recoverCapacityCheckpoint", ["recover-runtime", "recover-checkpoint"]],
  ] as const) {
    const fixture = harness({
      async [recoveryPort]() {
        fixture.calls.push(
          recoveryPort === "recoverRuntimeSources" ? "recover-runtime" : "recover-checkpoint",
        );
        throw new Error("recovery failure sentinel");
      },
    });
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.deepEqual(fixture.calls.filter((entry) => entry.startsWith("recover-")), expectedCalls);
    assert.equal(fixture.calls.some((entry) => entry.startsWith("source-read:")), false);
    assert.equal(fixture.calls.includes("checkpoint-read"), false);
    assert.equal(fixture.calls.includes("docker-local"), false);
    assert.equal(fixture.calls.includes("database-credential"), false);
    assert.equal(fixture.calls.includes("capacity-collect"), false);
  }

  const retry = harness({ sourceValues: first.sourceValues, checkpointValue: first.checkpointValue });
  const retried = await collectInstalledPhase3RuntimeSources(retry.input, retry.ports as never);
  assert.deepEqual(retried, result);
  assert.equal(retry.calls.some((entry) => entry.startsWith("source-write:")), false);
  assert.equal(retry.calls.includes("capacity-collect"), false);
  assert.equal(retry.calls.includes("database-credential"), false);
  assert.equal(retry.calls.some((entry) => entry.startsWith("list:")), false);

  const realStorageBase = await mkdtemp(join(tmpdir(), "spx-phase3-runtime-orchestrator-"));
  await chmod(realStorageBase, 0o700);
  try {
    {
      const paths = await realStoragePaths(realStorageBase, "linked-checkpoint-retry");
      await Promise.all([
        privateDirectory(paths.checkpointRoot),
        privateDirectory(paths.checkpointTempRoot),
      ]);
      const checkpointTemporary = join(
        paths.checkpointTempRoot,
        `capacity-observation.${randomUUID()}.tmp`,
      );
      const checkpointDestination = join(
        paths.checkpointRoot,
        "capacity-observation.json",
      );
      const crashed = await linkedCrashFile(
        checkpointTemporary,
        checkpointDestination,
        first.checkpointValue!.value,
      );
      const fixture = harness();
      installRealStoragePorts(fixture, paths);
      const recovered = await collectInstalledPhase3RuntimeSources(
        fixture.input,
        fixture.ports as never,
      );
      assert.equal(fixture.calls.includes("checkpoint-write"), false);
      assert.equal(fixture.calls.includes("capacity-collect"), false);
      assert.deepEqual(recovered.capacity.value.capacity, result.capacity.value.capacity);
      assert.deepEqual(
        recovered["production-observer"].value.productionObserver,
        result["production-observer"].value.productionObserver,
      );
      assert.deepEqual(await readdir(paths.checkpointTempRoot), []);
      const finalized = await stat(checkpointDestination, { bigint: true });
      assert.equal(finalized.ino, crashed.inode);
      assert.equal(finalized.nlink, 1n);
      assert.equal(await readFile(checkpointDestination, "utf8"), crashed.bytes);
    }

    for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
      const paths = await realStoragePaths(realStorageBase, `linked-source-${sourceId}`);
      await Promise.all([
        privateDirectory(paths.sourceRoot),
        privateDirectory(paths.sourceTempRoot),
        privateDirectory(paths.checkpointRoot),
        privateDirectory(paths.checkpointTempRoot),
      ]);
      await writeFile(
        join(paths.checkpointRoot, "capacity-observation.json"),
        canonicalJson(first.checkpointValue!.value),
        { mode: 0o600 },
      );
      await Promise.all(
        PHASE3_RUNTIME_SOURCE_IDS
          .filter((installedSourceId) => installedSourceId !== sourceId)
          .map((installedSourceId) => writeFile(
            join(paths.sourceRoot, `${installedSourceId}.json`),
            canonicalJson(result[installedSourceId].value),
            { mode: 0o600 },
          )),
      );
      const temporary = join(
        paths.sourceTempRoot,
        `${sourceId}.${randomUUID()}.tmp`,
      );
      const destination = join(paths.sourceRoot, `${sourceId}.json`);
      const crashed = await linkedCrashFile(temporary, destination, result[sourceId].value);
      const fixture = harness();
      installRealStoragePorts(fixture, paths);
      const recovered = await collectInstalledPhase3RuntimeSources(
        fixture.input,
        fixture.ports as never,
      );
      assert.deepEqual(recovered, result);
      assertNoLiveCollection(fixture.calls);
      assert.equal(fixture.calls.includes("checkpoint-write"), false);
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
      assert.deepEqual(await readdir(paths.sourceTempRoot), []);
      const finalized = await stat(destination, { bigint: true });
      assert.equal(finalized.ino, crashed.inode);
      assert.equal(finalized.nlink, 1n);
      assert.equal(await readFile(destination, "utf8"), crashed.bytes);
    }

    {
      const paths = await realStoragePaths(realStorageBase, "malformed-runtime-recovery");
      await Promise.all([
        privateDirectory(paths.sourceRoot),
        privateDirectory(paths.sourceTempRoot),
      ]);
      const temporary = join(paths.sourceTempRoot, `db-final.${randomUUID()}.tmp`);
      const destination = join(paths.sourceRoot, "db-final.json");
      await writeFile(temporary, "{", { mode: 0o600 });
      await link(temporary, destination);
      const fixture = harness();
      installRealStoragePorts(fixture, paths);
      await rejection(() => collectInstalledPhase3RuntimeSources(
        fixture.input,
        fixture.ports as never,
      ));
      assert.deepEqual(
        fixture.calls.filter((entry) => entry.startsWith("recover-")),
        ["recover-runtime"],
      );
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-read:")), false);
      assert.equal(fixture.calls.includes("checkpoint-read"), false);
      assert.equal(fixture.calls.includes("checkpoint-write"), false);
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
      assertNoLiveCollection(fixture.calls);
      assert.equal((await stat(temporary, { bigint: true })).nlink, 2n);
      assert.equal((await stat(destination, { bigint: true })).nlink, 2n);
    }

    {
      const paths = await realStoragePaths(realStorageBase, "malformed-checkpoint-recovery");
      await Promise.all([
        privateDirectory(paths.checkpointRoot),
        privateDirectory(paths.checkpointTempRoot),
      ]);
      const temporary = join(
        paths.checkpointTempRoot,
        `capacity-observation.${randomUUID()}.tmp`,
      );
      const destination = join(paths.checkpointRoot, "capacity-observation.json");
      await writeFile(temporary, "{", { mode: 0o600 });
      await link(temporary, destination);
      const fixture = harness();
      installRealStoragePorts(fixture, paths);
      await rejection(() => collectInstalledPhase3RuntimeSources(
        fixture.input,
        fixture.ports as never,
      ));
      assert.deepEqual(
        fixture.calls.filter((entry) => entry.startsWith("recover-")),
        ["recover-runtime", "recover-checkpoint"],
      );
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-read:")), false);
      assert.equal(fixture.calls.includes("checkpoint-read"), false);
      assert.equal(fixture.calls.includes("checkpoint-write"), false);
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
      assertNoLiveCollection(fixture.calls);
      assert.equal((await stat(temporary, { bigint: true })).nlink, 2n);
      assert.equal((await stat(destination, { bigint: true })).nlink, 2n);
    }

    {
      const paths = await realStoragePaths(realStorageBase, "mixed-runtime-recovery");
      await Promise.all([
        privateDirectory(paths.sourceRoot),
        privateDirectory(paths.sourceTempRoot),
      ]);
      const validTemporary = join(
        paths.sourceTempRoot,
        `db-final.${randomUUID()}.tmp`,
      );
      const validDestination = join(paths.sourceRoot, "db-final.json");
      await linkedCrashFile(
        validTemporary,
        validDestination,
        result["db-final"].value,
      );
      const malformedTemporary = join(
        paths.sourceTempRoot,
        `runtime-final.${randomUUID()}.tmp`,
      );
      const malformedDestination = join(paths.sourceRoot, "runtime-final.json");
      await writeFile(malformedTemporary, "{", { mode: 0o600 });
      await link(malformedTemporary, malformedDestination);
      const fixture = harness();
      installRealStoragePorts(fixture, paths);
      await rejection(() => collectInstalledPhase3RuntimeSources(
        fixture.input,
        fixture.ports as never,
      ));
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-read:")), false);
      assert.equal(fixture.calls.includes("checkpoint-read"), false);
      assert.equal(fixture.calls.includes("checkpoint-write"), false);
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
      assertNoLiveCollection(fixture.calls);
      assert.equal((await stat(validTemporary, { bigint: true })).nlink, 2n);
      assert.equal((await stat(validDestination, { bigint: true })).nlink, 2n);
      assert.equal((await stat(malformedTemporary, { bigint: true })).nlink, 2n);
      assert.equal((await stat(malformedDestination, { bigint: true })).nlink, 2n);
    }

    {
      const paths = await realStoragePaths(realStorageBase, "mismatched-runtime-recovery");
      await Promise.all([
        privateDirectory(paths.sourceRoot),
        privateDirectory(paths.sourceTempRoot),
      ]);
      const temporary = join(paths.sourceTempRoot, `db-final.${randomUUID()}.tmp`);
      const heldDestination = join(paths.parent, "unrelated-held.json");
      await writeFile(temporary, canonicalJson(result["db-final"].value), { mode: 0o600 });
      await link(temporary, heldDestination);
      const fixture = harness();
      installRealStoragePorts(fixture, paths);
      await rejection(() => collectInstalledPhase3RuntimeSources(
        fixture.input,
        fixture.ports as never,
      ));
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-read:")), false);
      assert.equal(fixture.calls.includes("checkpoint-read"), false);
      assert.equal(fixture.calls.includes("checkpoint-write"), false);
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
      assertNoLiveCollection(fixture.calls);
      assert.equal((await stat(temporary, { bigint: true })).nlink, 2n);
      assert.equal((await stat(heldDestination, { bigint: true })).nlink, 2n);
    }

    for (const presentPairSource of ["capacity", "production-observer"] as const) {
      const paths = await realStoragePaths(
        realStorageBase,
        `checkpoint-half-pair-${presentPairSource}`,
      );
      await Promise.all([
        privateDirectory(paths.sourceRoot),
        privateDirectory(paths.sourceTempRoot),
        privateDirectory(paths.checkpointRoot),
        privateDirectory(paths.checkpointTempRoot),
      ]);
      await writeFile(
        join(paths.checkpointRoot, "capacity-observation.json"),
        canonicalJson(first.checkpointValue!.value),
        { mode: 0o600 },
      );
      await Promise.all(
        ["db-final", "runtime-final", "lease-continuity", presentPairSource].map(
          (installedSourceId) => writeFile(
            join(paths.sourceRoot, `${installedSourceId}.json`),
            canonicalJson(result[installedSourceId].value),
            { mode: 0o600 },
          ),
        ),
      );
      const fixture = harness();
      installRealStoragePorts(fixture, paths);
      const projected = await collectInstalledPhase3RuntimeSources(
        fixture.input,
        fixture.ports as never,
      );
      assert.equal(fixture.calls.includes("capacity-collect"), false);
      assert.equal(fixture.calls.includes("checkpoint-write"), false);
      assertNoLiveCollection(fixture.calls);
      assert.equal(
        fixture.calls.includes(`source-write:${presentPairSource}`),
        false,
      );
      assert.equal(
        fixture.calls.includes(
          `source-write:${presentPairSource === "capacity" ? "production-observer" : "capacity"}`,
        ),
        true,
      );
      assert.deepEqual(projected.capacity.value.capacity, result.capacity.value.capacity);
      assert.deepEqual(
        projected["production-observer"].value.productionObserver,
        result["production-observer"].value.productionObserver,
      );
    }

    {
      const paths = await realStoragePaths(realStorageBase, "checkpoint-pair-mismatch");
      await Promise.all([
        privateDirectory(paths.sourceRoot),
        privateDirectory(paths.sourceTempRoot),
        privateDirectory(paths.checkpointRoot),
        privateDirectory(paths.checkpointTempRoot),
      ]);
      await writeFile(
        join(paths.checkpointRoot, "capacity-observation.json"),
        canonicalJson(first.checkpointValue!.value),
        { mode: 0o600 },
      );
      const mismatchedCapacity = structuredClone(result.capacity.value);
      mismatchedCapacity.capacity.measurements.a3CpuPercent += 1;
      await Promise.all([
        writeFile(
          join(paths.sourceRoot, "capacity.json"),
          canonicalJson(mismatchedCapacity),
          { mode: 0o600 },
        ),
        writeFile(
          join(paths.sourceRoot, "production-observer.json"),
          canonicalJson(result["production-observer"].value),
          { mode: 0o600 },
        ),
      ]);
      const fixture = harness();
      installRealStoragePorts(fixture, paths);
      await rejection(() => collectInstalledPhase3RuntimeSources(
        fixture.input,
        fixture.ports as never,
      ));
      assertNoLiveCollection(fixture.calls);
      assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
      assert.equal(fixture.calls.includes("checkpoint-write"), false);
    }
  } finally {
    await rm(realStorageBase, { recursive: true, force: true });
  }

  {
    const fixture = harness();
    const originalObservationReader = fixture.ports.readObservationMarkers as (...args: unknown[]) => Promise<unknown>;
    let leaseRead = 0;
    let beforeAlias: ReturnType<typeof loadedLeases> | null = null;
    fixture.ports.loadLeases = async () => {
      leaseRead += 1;
      if (leaseRead === 1) {
        beforeAlias = structuredClone(fixture.before);
        return beforeAlias;
      }
      return structuredClone(fixture.after);
    };
    fixture.ports.readObservationMarkers = async (...args: unknown[]) => {
      const records = await originalObservationReader(...args);
      beforeAlias!.guard.leaseId = "33333333-3333-4333-8333-333333333333";
      beforeAlias!.guard.baselineP95LatencyMs = 999;
      return records;
    };
    const detached = await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    assert.equal(detached["db-final"].value.context.guardLeaseId, fixture.before.guard.leaseId);
    assert.equal(
      detached.capacity.value.capacity.measurements.productionBaselineP95LatencyMs,
      fixture.before.guard.baselineP95LatencyMs,
    );
  }

  {
    const sourceValues = clonedSourceValues(first.sourceValues);
    const fixture = harness({ sourceValues, checkpointValue: first.checkpointValue });
    const aliases = new Map<string, Record<string, unknown>>();
    fixture.ports.readSource = async (sourceId: string) => {
      const record = sourceValues.get(sourceId);
      if (!record) throw missing("missing source alias");
      const alias = sourceRecord(sourceId, structuredClone(record.value));
      aliases.set(sourceId, alias);
      return alias;
    };
    const originalCheckpointReader = fixture.ports.readCapacityCheckpoint as () => Promise<unknown>;
    fixture.ports.readCapacityCheckpoint = async () => {
      const record = await originalCheckpointReader();
      const dbAlias = aliases.get("db-final")!;
      (dbAlias.value as ReturnType<typeof databaseEvidence> & { context: Record<string, unknown> })
        .context.stagingRunId = "mutated-after-source-validation";
      return record;
    };
    const detached = await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    assert.equal(detached["db-final"].value.context.stagingRunId, binding.stagingRunId);
  }

  {
    const sourceValues = clonedSourceValues(first.sourceValues);
    sourceValues.delete("production-observer");
    const fixture = harness({ sourceValues, checkpointValue: first.checkpointValue });
    const checkpointAlias = {
      ...first.checkpointValue!,
      path: "/protected/checkpoint.json",
      value: structuredClone(first.checkpointValue!.value),
    };
    fixture.ports.readCapacityCheckpoint = async () => checkpointAlias;
    const originalLeaseLoader = fixture.ports.loadLeases as () => Promise<unknown>;
    let leaseRead = 0;
    fixture.ports.loadLeases = async () => {
      leaseRead += 1;
      const loaded = await originalLeaseLoader();
      if (leaseRead === 2) {
        checkpointAlias.value.productionObserver.response.ready = false;
        checkpointAlias.value.productionObserver.thresholdResult.passed = false;
      }
      return loaded;
    };
    const detached = await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    assert.equal(detached["production-observer"].value.productionObserver.response.ready, true);
  }

  {
    const fixture = harness({ checkpointValue: first.checkpointValue });
    let returnedWriteAlias: Record<string, unknown> | null = null;
    fixture.ports.writeSource = async (sourceId: string, value: unknown) => {
      const original = structuredClone(value);
      (value as { context: { stagingRunId: string } }).context.stagingRunId = "mutated-write-argument";
      const record = sourceRecord(sourceId, original);
      fixture.sourceValues.set(sourceId, {
        value: record.value,
        bytes: record.bytes,
        sha256: record.sha256,
      });
      returnedWriteAlias = record;
      return record;
    };
    fixture.ports.readSource = async (sourceId: string) => {
      if (returnedWriteAlias) returnedWriteAlias.bytes = "mutated-returned-write-record";
      const record = fixture.sourceValues.get(sourceId);
      if (!record) throw missing("missing source during alias reopen");
      return sourceRecord(sourceId, structuredClone(record.value));
    };
    const detached = await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    assert.equal(detached["db-final"].value.context.stagingRunId, binding.stagingRunId);
  }

  {
    const fixture = harness();
    let checkpoint: ReturnType<typeof checkpointRecord> | null = null;
    let returnedWriteAlias: ReturnType<typeof checkpointRecord> | null = null;
    fixture.ports.readCapacityCheckpoint = async () => {
      if (!checkpoint) throw missing("checkpoint missing before alias write");
      if (returnedWriteAlias) returnedWriteAlias.bytes = "mutated-checkpoint-write-record";
      return checkpoint;
    };
    fixture.ports.writeCapacityCheckpoint = async (value: unknown) => {
      const original = structuredClone(value);
      (value as { context: { stagingRunId: string } }).context.stagingRunId =
        "mutated-checkpoint-write-argument";
      checkpoint = checkpointRecord(original);
      returnedWriteAlias = structuredClone(checkpoint);
      return returnedWriteAlias;
    };
    const detached = await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    assert.equal(detached.capacity.value.context.stagingRunId, binding.stagingRunId);
  }

  {
    const sourceValues = clonedSourceValues(first.sourceValues);
    const fixture = harness({ sourceValues, checkpointValue: first.checkpointValue });
    let aggregateAlias: Record<string, StorageRecord> | null = null;
    fixture.ports.readSources = async () => {
      aggregateAlias = Object.fromEntries(
        PHASE3_RUNTIME_SOURCE_IDS.map((sourceId) => [sourceId, sourceValues.get(sourceId)!]),
      );
      setTimeout(() => {
        (aggregateAlias!["db-final"].value as { context: { stagingRunId: string } })
          .context.stagingRunId = "mutated-after-return";
      }, 0);
      return aggregateAlias;
    };
    const detached = await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(detached["db-final"].value.context.stagingRunId, binding.stagingRunId);
  }

  {
    const partialSources = clonedSourceValues(first.sourceValues);
    partialSources.delete("production-observer");
    const fixture = harness({ sourceValues: partialSources, checkpointValue: first.checkpointValue });
    await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    assert.equal(fixture.calls.includes("capacity-collect"), false);
    assert.deepEqual(
      fixture.calls.filter((entry) => entry.startsWith("source-write:")),
      ["source-write:production-observer"],
    );
  }

  {
    const tamperedSources = clonedSourceValues(first.sourceValues);
    const original = tamperedSources.get("lease-continuity")!;
    const value = structuredClone(original.value);
    value.continuity.markerBindings.actions[0].markerSha256 = hash("other-authenticated-marker");
    tamperedSources.set("lease-continuity", {
      value,
      bytes: canonicalJson(value),
      sha256: hash(canonicalJson(value)),
    });
    tamperedSources.delete("db-final");
    const fixture = harness({ sourceValues: tamperedSources, checkpointValue: first.checkpointValue });
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
    assert.equal(fixture.calls.includes("docker-local"), false);
    assert.equal(fixture.calls.includes("database-credential"), false);
  }

  {
    const partialSources = clonedSourceValues(first.sourceValues);
    partialSources.delete("production-observer");
    const fixture = harness({ sourceValues: partialSources, checkpointValue: null });
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.includes("capacity-collect"), false);
  }

  {
    const sourceValues = clonedSourceValues(first.sourceValues);
    sourceValues.delete("db-final");
    const fixture = harness({ sourceValues, checkpointValue: first.checkpointValue });
    const original = sourceValues.get("lease-continuity")!;
    const value = structuredClone(original.value);
    value.continuity.after.guard.heartbeatMonotonicMs =
      fixture.before.guard.heartbeatMonotonicMs + 1;
    sourceValues.set("lease-continuity", {
      value,
      bytes: canonicalJson(value),
      sha256: hash(canonicalJson(value)),
    });
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.includes("checkpoint-read"), false);
    assert.equal(fixture.calls.includes("docker-local"), false);
    assert.equal(fixture.calls.includes("database-credential"), false);
    assert.equal(fixture.calls.includes("capacity-collect"), false);
  }

  for (const mutate of [
    (fixture: ReturnType<typeof harness>) => { fixture.markerValues[4].generation = 8; },
    (fixture: ReturnType<typeof harness>) => { fixture.markerValues[7].guardLeaseId = "33333333-3333-4333-8333-333333333333"; },
    (fixture: ReturnType<typeof harness>) => { fixture.observationValues.fence.generation = 8; },
  ]) {
    const fixture = harness();
    mutate(fixture);
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
  }

  for (const actionIndex of PHASE3_ACTION_IDS.keys()) {
    const fixture = harness();
    fixture.markerValues[actionIndex].guardLeaseId =
      "33333333-3333-4333-8333-333333333333";
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.includes("recover-runtime"), false);
  }
  for (const observationName of ["schema", "fence"] as const) {
    const fixture = harness();
    fixture.observationValues[observationName].watchdogLeaseId =
      "33333333-3333-4333-8333-333333333333";
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.includes("recover-runtime"), false);
  }

  for (const mutate of [
    (value: ReturnType<typeof loadedLeases>) => { value.guard.state = "aborted"; },
    (value: ReturnType<typeof loadedLeases>) => { value.guard.heartbeatAgeMs = 10_001; },
    (value: ReturnType<typeof loadedLeases>) => {
      value.guard.heartbeatMonotonicMs = nowMonotonicMs() + 10_000;
      value.guard.heartbeatAgeMs = 0;
    },
    (value: ReturnType<typeof loadedLeases>) => { value.watchdog.stagingRunId = "other-run"; },
    (value: ReturnType<typeof loadedLeases>) => {
      value.guard.leaseId = "33333333-3333-4333-8333-333333333333";
    },
  ]) {
    const fixture = harness();
    mutate(fixture.input.leases);
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.includes("observations"), false);
    assert.equal(fixture.calls.includes("actions"), false);
  }

  {
    const fixture = harness();
    fixture.input.journalSnapshot.binding.approvalId = "other-phase3-approval";
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("leases-")), false);
    assert.equal(fixture.calls.includes("observations"), false);
    assert.equal(fixture.calls.includes("actions"), false);
    assertNoLiveCollection(fixture.calls);
  }

  {
    const fixture = harness();
    const changedContext = structuredClone(context);
    changedContext.envelope.approvalId = "other-phase3-approval";
    fixture.ports.loadContext = async () => {
      fixture.calls.push("context");
      return changedContext;
    };
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("leases-")), false);
    assert.equal(fixture.calls.includes("observations"), false);
    assert.equal(fixture.calls.includes("actions"), false);
    assertNoLiveCollection(fixture.calls);
  }

  for (const mutate of [
    (value: ReturnType<typeof loadedLeases>) => { value.watchdog.state = "aborted"; },
    (value: ReturnType<typeof loadedLeases>) => { value.watchdog.heartbeatAgeMs = 10_001; },
    (value: ReturnType<typeof loadedLeases>) => {
      value.watchdog.heartbeatMonotonicMs = nowMonotonicMs() + 10_000;
      value.watchdog.heartbeatAgeMs = 0;
    },
    (value: ReturnType<typeof loadedLeases>) => { value.guard.stagingRunId = "other-run"; },
    (value: ReturnType<typeof loadedLeases>) => {
      value.watchdog.leaseId = "33333333-3333-4333-8333-333333333333";
    },
  ]) {
    const fixture = harness();
    const before = structuredClone(fixture.before);
    mutate(before);
    fixture.ports.loadLeases = async () => before;
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.includes("observations"), false);
    assert.equal(fixture.calls.includes("actions"), false);
  }

  for (const mutate of [
    (value: ReturnType<typeof journalSnapshot>) => { value.actions.at(-1)!.state = "reconciled"; value.actions.at(-1)!.reconciliationId = "r1"; value.actions.at(-1)!.reconciliationOutcome = "succeeded"; },
    (value: ReturnType<typeof journalSnapshot>) => { value.actions.push(structuredClone(value.actions.at(-1)!)); value.recordCount += 1; },
    (value: ReturnType<typeof journalSnapshot>) => { value.actions.pop(); },
    (value: ReturnType<typeof journalSnapshot>) => {
      [value.actions[22], value.actions[23]] = [value.actions[23], value.actions[22]];
    },
    (value: ReturnType<typeof journalSnapshot>) => {
      snapshotAction(value, "staging-gate-4-phase3").actionId =
        "phase3-inline-owner-restore";
    },
    (value: ReturnType<typeof journalSnapshot>) => {
      snapshotAction(value, "staging-gate-4-phase3").scope = "wrong-gate-4-scope";
    },
    (value: ReturnType<typeof journalSnapshot>) => {
      snapshotAction(value, "staging-gate-4-phase3").kind = "compensation";
    },
    (value: ReturnType<typeof journalSnapshot>) => {
      snapshotAction(value, "staging-gate-4-phase3").mutationSha256 = hash("wrong-mutation");
    },
    (value: ReturnType<typeof journalSnapshot>) => { value.recordCount += 1; },
    (value: ReturnType<typeof journalSnapshot>) => { value.headSha256 = hash("wrong-head"); },
    (value: ReturnType<typeof journalSnapshot>) => {
      snapshotAction(value, "phase3-inline-owner-restore").terminalRecordSha256 =
        hash("wrong-inline-terminal");
    },
    (value: ReturnType<typeof journalSnapshot>) => {
      snapshotAction(value, "staging-gate-3-handoff").terminalRecordSha256 =
        snapshotAction(value, "staging-gate-2-worker").terminalRecordSha256;
    },
    (value: ReturnType<typeof journalSnapshot>) => {
      snapshotAction(value, "staging-gate-3-handoff").completedAt =
        snapshotAction(value, "phase3-inline-owner-restore").completedAt;
    },
    (value: ReturnType<typeof journalSnapshot>) => {
      snapshotAction(value, "staging-db-bootstrap").completedAt =
        new Date(Date.parse(completedAt(8)) + 1_000).toISOString();
    },
  ]) {
    const fixture = harness();
    mutate(fixture.input.journalSnapshot);
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("leases-")), false);
  }

  for (const field of [
    "occurrences",
    "terminalRecordSha256",
    "completedAt",
    "reconciliationId",
    "reconciliationOutcome",
  ] as const) {
    const fixture = harness();
    const future = snapshotAction(fixture.input.journalSnapshot, "staging-gate-4-phase3");
    if (field === "occurrences") future.occurrences = 1;
    if (field === "terminalRecordSha256") future.terminalRecordSha256 = hash("forged-terminal");
    if (field === "completedAt") future.completedAt = completedAt(9);
    if (field === "reconciliationId") future.reconciliationId = "forged-reconciliation";
    if (field === "reconciliationOutcome") future.reconciliationOutcome = "succeeded";
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("leases-")), false);
  }

  for (const state of ["succeeded", "failed", "ambiguous", "reconciled", "compensated"]) {
    const fixture = harness();
    const future = snapshotAction(fixture.input.journalSnapshot, "staging-gate-4-phase3");
    future.state = state;
    if (state === "succeeded" || state === "reconciled") {
      future.occurrences = 1;
      future.terminalRecordSha256 = hash(`future-${state}-terminal`);
      future.completedAt = completedAt(9);
    }
    if (state === "reconciled") {
      future.reconciliationId = "future-reconciliation";
      future.reconciliationOutcome = "succeeded";
    }
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("leases-")), false);
  }

  for (const state of ["registered", "failed", "ambiguous", "reconciled", "compensated"]) {
    const fixture = harness();
    const gate3 = snapshotAction(fixture.input.journalSnapshot, "staging-gate-3-handoff");
    gate3.state = state;
    if (state !== "reconciled") {
      gate3.occurrences = 0;
      gate3.terminalRecordSha256 = null;
      gate3.completedAt = null;
    } else {
      gate3.reconciliationId = "gate-3-reconciliation";
      gate3.reconciliationOutcome = "succeeded";
    }
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("leases-")), false);
  }

  {
    const fixture = harness();
    const future = snapshotAction(fixture.input.journalSnapshot, "staging-gate-4-phase3");
    future.state = "succeeded";
    future.occurrences = 1;
    future.terminalRecordSha256 = hash("terminal:staging-gate-4-phase3");
    future.completedAt = new Date(Date.parse(completedAt(8)) + 1_000).toISOString();
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("leases-")), false);
  }

  for (const actionIndex of PHASE3_ACTION_IDS.keys()) {
    const fixture = harness();
    snapshotAction(
      fixture.input.journalSnapshot,
      PHASE3_ACTION_IDS[actionIndex],
    ).completedAt = completedAt(0);
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(
      fixture.calls.some((entry) => entry.startsWith("leases-")),
      false,
      `${PHASE3_ACTION_IDS[actionIndex]} at Gate 3 must fail before lease effects`,
    );
  }
  for (const actionIndex of PHASE3_ACTION_IDS.slice(0, -1).keys()) {
    const fixture = harness();
    snapshotAction(
      fixture.input.journalSnapshot,
      PHASE3_ACTION_IDS[actionIndex],
    ).completedAt = new Date(Date.parse(completedAt(8)) + 1_000).toISOString();
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(
      fixture.calls.some((entry) => entry.startsWith("leases-")),
      false,
      `${PHASE3_ACTION_IDS[actionIndex]} after inline restore must fail before lease effects`,
    );
  }

  for (const replacement of [
    Object.assign(new Error("permission sentinel"), { code: "EACCES" }),
    new Error("raw database password sentinel"),
  ]) {
    const fixture = harness({ async readSource() { throw replacement; } });
    let captured: Error | null = null;
    try {
      await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    } catch (error) {
      captured = error as Error;
    }
    assert.ok(captured);
    assert.doesNotMatch(captured.message, /permission sentinel|password sentinel/i);
  }

  for (const mutate of [
    (values: ReturnType<typeof inspectValues>) => { delete (values[partition.legacyService].State as Record<string, unknown>).Health; },
    (values: ReturnType<typeof inspectValues>) => { values[partition.pollerService].State.Status = "running"; },
    (values: ReturnType<typeof inspectValues>) => { values[partition.consumerService].State.Paused = true; },
    (values: ReturnType<typeof inspectValues>) => { values[partition.pollerService].State.Restarting = true; },
    (values: ReturnType<typeof inspectValues>) => { values[partition.legacyService].Image = `sha256:${hash("wrong")}`; },
    (values: ReturnType<typeof inspectValues>) => { values[partition.pollerService].Config.Labels["com.spx.staging-run-id"] = "other"; },
    (values: ReturnType<typeof inspectValues>) => { values[partition.consumerService].Config.Env.push(`SPX_NODE_ID=${partition.consumerNodeId}`); },
    (values: ReturnType<typeof inspectValues>) => { values[partition.legacyService].Config.Env[0] = "SPX_NODE_ID=wrong"; },
    (values: ReturnType<typeof inspectValues>) => {
      values[partition.pollerService].Config.Env[3] = "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=true";
    },
    (values: ReturnType<typeof inspectValues>) => {
      values[partition.consumerService].Config.Env[3] =
        "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=false";
    },
    (values: ReturnType<typeof inspectValues>) => {
      values[partition.legacyService].Config.Env[1] = "SPX_ROLE=combined";
    },
  ]) {
    const fixture = harness();
    mutate(fixture.inspections);
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
  }

  for (const listFixedServiceContainerIds of [
    async () => [],
    async (service: string) => {
      const values = inspectValues();
      const id = values[service as keyof typeof values]?.Id ?? "a".repeat(64);
      return [id, id];
    },
    async () => ["a".repeat(64)],
  ]) {
    const fixture = harness({ listFixedServiceContainerIds });
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.some((entry) => entry.startsWith("source-write:")), false);
  }

  {
    const fixture = harness({ async assertLocalDocker() { return false; } });
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
    assert.equal(fixture.calls.includes("database-credential"), false);
  }

  for (const mutate of [
    (value: ReturnType<typeof databaseEvidence>) => { value.inlineLease.ownerNodeId = "wrong-owner"; },
    (value: ReturnType<typeof databaseEvidence> & Record<string, unknown>) => { value.rawRows = [{ password: "secret" }]; },
  ]) {
    const fixture = harness({
      async runDatabaseEvidence() {
        const value = databaseEvidence() as ReturnType<typeof databaseEvidence> & Record<string, unknown>;
        mutate(value);
        return value;
      },
    });
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
  }

  for (const pairValue of (() => {
    const failedReadiness = capacityPair();
    failedReadiness.capacity.ok = false;
    failedReadiness.capacity.failures = ["PRODUCTION_NOT_READY"];
    failedReadiness.productionObserver.response.ready = false;
    failedReadiness.productionObserver.thresholdResult.passed = false;
    const negativeIncrease = capacityPair();
    negativeIncrease.capacity.measurements.productionP95LatencyMs = 60;
    negativeIncrease.capacity.measurements.productionBaselineP95LatencyMs = 75;
    negativeIncrease.capacity.measurements.productionLatencyIncreasePercent = -20;
    negativeIncrease.productionObserver.response.p95LatencyMs = 60;
    return [failedReadiness, negativeIncrease];
  })()) {
    const fixture = harness({ async collectCapacityEvidence() { return pairValue; } });
    const collected = await collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never);
    assert.deepEqual(collected.capacity.value.capacity, pairValue.capacity);
    assert.deepEqual(
      collected["production-observer"].value.productionObserver,
      pairValue.productionObserver,
    );
  }

  for (const mutate of [
    (pair: ReturnType<typeof capacityPair>) => { pair.capacity.ok = false; },
    (pair: ReturnType<typeof capacityPair>) => { pair.capacity.measurements.productionLatencyIncreasePercent = 1; },
    (pair: ReturnType<typeof capacityPair>) => { pair.productionObserver.expectedPolicySha256 = hash("other-policy"); },
    (pair: ReturnType<typeof capacityPair>) => { pair.productionObserver.observedAt = new Date(Date.now() + 1_000).toISOString(); },
  ]) {
    const fixture = harness({
      async collectCapacityEvidence() {
        const pair = capacityPair();
        mutate(pair);
        return pair;
      },
    });
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
  }

  for (const mutateAfter of [
    (value: ReturnType<typeof loadedLeases>) => { value.guard.state = "aborted"; },
    (value: ReturnType<typeof loadedLeases>) => { value.guard.pid += 1; },
    (value: ReturnType<typeof loadedLeases>) => { value.watchdog.startedMonotonicMs += 1; },
    (value: ReturnType<typeof loadedLeases>) => { value.guard.baselineP95LatencyMs = 76; },
    (value: ReturnType<typeof loadedLeases>) => { value.guard.heartbeatMonotonicMs -= 100; },
    (value: ReturnType<typeof loadedLeases>) => { value.watchdog.heartbeatAgeMs = 10_001; },
    (value: ReturnType<typeof loadedLeases>) => { value.watchdog.heartbeatMonotonicMs = nowMonotonicMs() + 10_000; value.watchdog.heartbeatAgeMs = 0; },
  ]) {
    const fixture = harness();
    let reads = 0;
    fixture.ports.loadLeases = async () => {
      reads += 1;
      const value = structuredClone(reads === 1 ? fixture.before : fixture.after);
      if (reads > 1) mutateAfter(value);
      return value;
    };
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
  }

  {
    const fixture = harness();
    let written = false;
    fixture.ports.writeSource = async (sourceId: string, value: unknown) => {
      written = true;
      const record = sourceRecord(sourceId, value);
      fixture.sourceValues.set(sourceId, record);
      return record;
    };
    fixture.ports.readSource = async (sourceId: string) => {
      const record = fixture.sourceValues.get(sourceId);
      if (!record) throw missing("missing");
      if (written && sourceId === "db-final") return { ...sourceRecord(sourceId, record.value), bytes: `${record.bytes} ` };
      return sourceRecord(sourceId, record.value);
    };
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
  }

  {
    const fixture = harness();
    fixture.ports.readSources = async () => {
      const reversed: Record<string, StorageRecord> = {};
      for (const sourceId of [...PHASE3_RUNTIME_SOURCE_IDS].reverse()) {
        reversed[sourceId] = fixture.sourceValues.get(sourceId)!;
      }
      return reversed;
    };
    await rejection(() => collectInstalledPhase3RuntimeSources(fixture.input, fixture.ports as never));
  }

  {
    const inconsistent = structuredClone(result.capacity.value);
    inconsistent.capacity.ok = false;
    assert.throws(
      () => validatePhase3RuntimeSourceValue("capacity", inconsistent, common),
      /capacity|outcome|failure|source/i,
    );

    const consistentFailure = structuredClone(result.capacity.value);
    consistentFailure.capacity.measurements.a3CpuPercent = 71;
    consistentFailure.capacity.failures = ["A3_CPU_BUDGET_EXCEEDED"];
    consistentFailure.capacity.ok = false;
    assert.equal(
      validatePhase3RuntimeSourceValue("capacity", consistentFailure, common),
      true,
    );

    const negativeIncrease = structuredClone(result.capacity.value);
    negativeIncrease.capacity.measurements.productionP95LatencyMs = 60;
    negativeIncrease.capacity.measurements.productionBaselineP95LatencyMs = 75;
    negativeIncrease.capacity.measurements.productionLatencyIncreasePercent = -20;
    negativeIncrease.capacity.failures = [];
    negativeIncrease.capacity.ok = true;
    assert.equal(
      validatePhase3RuntimeSourceValue("capacity", negativeIncrease, common),
      true,
    );

    const observerInconsistent = structuredClone(result["production-observer"].value);
    observerInconsistent.productionObserver.response.ready = false;
    assert.throws(
      () => validatePhase3RuntimeSourceValue("production-observer", observerInconsistent, common),
      /observer|threshold|readiness|source/i,
    );
    observerInconsistent.productionObserver.thresholdResult.passed = false;
    assert.equal(
      validatePhase3RuntimeSourceValue("production-observer", observerInconsistent, common),
      true,
    );
  }

  assert.throws(
    () => (validatePhase3RuntimeSourceValue as never)("db-final", result["db-final"].value, common, true),
    /argument/i,
  );
  assert.throws(
    () => validatePhase3RuntimeSourceValue("unknown", result["db-final"].value, common),
    /source/i,
  );
  const replayed = structuredClone(result["db-final"].value);
  replayed.context.stagingRunId = "previous-run";
  assert.throws(
    () => validatePhase3RuntimeSourceValue("db-final", replayed, common),
    /context|source/i,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
