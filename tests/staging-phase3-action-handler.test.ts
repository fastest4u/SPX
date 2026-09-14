import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  PHASE3_STAGING_ACTIONS,
  PHASE3_STAGING_OBSERVATIONS,
  buildStagingPhase3EvidencePayload,
  buildStagingPhase3ObservationMarker,
  buildStagingPhase3DatabaseTransport,
  buildStagingPhase3Transitions,
  buildStagingPhase3ObservationPayload,
  captureInstalledPhase3ActionMeasurement,
  executeInstalledStagingPhase3Observation,
  executeStagingPhase3Action,
  executeStagingPhase3Transition,
  parseStagingPhase3Invocation,
} from "../scripts/staging-phase3-action-handler.mjs";
import {
  PHASE3_ACTION_IDS,
  phase3PartitionIdentity,
  validatePhase3ActionMeasurement,
} from "../scripts/lib/phase3-staging-evidence.mjs";

const runId = "staging-run-001";
const operatorRoot = `/opt/spx-staging/release/${"a".repeat(40)}/operator`;
const capability = {
  phase3: { canaryTeamId: 2, canaryEpoch: "ifn-epoch-001" },
};
const executionBinding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  stagingTargetDescriptorSha256: "c".repeat(64),
  operatorBundleSha256: "d".repeat(64),
  stagingRunId: runId,
};
const expectedActions = [
  ["phase3-consumer-start-disabled", "consumer-start-disabled"],
  ["phase3-legacy-lease-release", "legacy-lease-release"],
  ["phase3-poller-start", "poller-start"],
  ["phase3-publication-enable", "publication-enable"],
  ["phase3-execution-enable", "execution-enable"],
  ["phase3-publication-fence", "publication-fence"],
  ["phase3-drain-or-quarantine", "drain-or-quarantine"],
  ["phase3-inline-owner-restore", "inline-owner-restore"],
] as const;
const schemaObservationMeasurements = {
  candidateSchemaVersion: 37,
  schemaMaximum: 37,
  rollbackSchemaMinimum: 37,
  rollbackSchemaMaximum: 37,
  candidateSchemaRangeDeclared: true,
  nMinusOneSchemaRangeDeclared: true,
  migration035ChecksumMatches: true,
  pendingMigrations: 0,
  runningMigrations: 0,
  failedMigrations: 0,
  observerReadOnly: true,
};
const fenceObservationMeasurements = {
  state: "fenced",
  publicationGeneration: 7,
  fenceJobId: 10,
  ackJobId: 11,
  pollerNodeId: "stg-poller-ifn-phase3-1",
  ackNodeId: "stg-poller-ifn-phase3-1",
  acknowledgedAt: "2026-07-12T10:30:00.000Z",
  isActive: true,
  observerReadOnly: true,
};

const captureNowMs = Date.parse("2026-07-12T12:00:00.000Z");
const captureApprovalId = "capture-approval-001";

function captureHash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

const captureBindingBase = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${captureHash("capture-image")}`,
  releaseManifestSha256: captureHash("capture-release"),
  environment: "staging",
  topology: "phase3",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: captureHash("capture-target"),
  operatorBundleSha256: captureHash("capture-operator"),
  stagingApprovalEnvelopeSha256: captureHash("capture-approval"),
  actionJournalHeadSha256: captureHash("capture-head-placeholder"),
  stagingRunId: runId,
};
const captureRollbackSha256 = captureHash("capture-rollback");
const captureRedactionSentinels = {
  observerCredential: "observer-credential-sentinel-0000000001",
  rawDatabaseRow: "raw-database-row-sentinel-0000000002",
  filesystemPath: "/private/evidence/path-sentinel-0000000003",
  sqlText: "SELECT secret_sql_sentinel_0000000004 FROM private_table",
  errorText: "raw-error-text-sentinel-0000000005",
  dockerEnvironment: "raw-docker-environment-sentinel-0000000006",
};
const captureLeases = {
  stagingRunId: runId,
  guard: {
    schemaVersion: 1,
    role: "guard",
    state: "armed",
    breachCount: 0,
    baselineP95LatencyMs: null,
    leaseId: "11111111-1111-4111-8111-111111111111",
    stagingRunId: runId,
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
    stagingRunId: runId,
    pid: 202,
    startedMonotonicMs: 1_000,
    heartbeatMonotonicMs: 1_850,
    heartbeatAgeMs: 150,
  },
  maxAgeMs: 5_000,
};

function captureCompletedAt(actionId: string): string {
  const index = PHASE3_ACTION_IDS.indexOf(actionId);
  return new Date(Date.parse("2026-07-12T10:00:00.000Z") + index * 1_000).toISOString();
}

function captureJournalSnapshot(actionId: string) {
  const last = PHASE3_ACTION_IDS.indexOf(actionId);
  const actions = PHASE3_ACTION_IDS.slice(0, last + 1).map((currentActionId, index) => ({
    sequence: index + 1,
    actionId: currentActionId,
    scope: currentActionId,
    kind: "forward",
    mutationSha256: captureHash(`mutation:${currentActionId}`),
    state: "succeeded",
    occurrences: 1,
    terminalRecordSha256: captureHash(`terminal:${currentActionId}`),
    completedAt: captureCompletedAt(currentActionId),
    reconciliationId: null,
    reconciliationOutcome: null,
  }));
  return {
    schemaVersion: 1,
    binding: {
      approvalId: captureApprovalId,
      stagingRunId: runId,
      approvalEnvelopeSha256: captureBindingBase.stagingApprovalEnvelopeSha256,
      targetDescriptorSha256: captureBindingBase.stagingTargetDescriptorSha256,
      operatorBundleSha256: captureBindingBase.operatorBundleSha256,
    },
    recordCount: actions.length,
    headSha256: captureHash(`terminal:${actionId}`),
    actions,
  };
}

function captureBinding(actionId: string) {
  return {
    ...captureBindingBase,
    actionJournalHeadSha256: captureHash(`terminal:${actionId}`),
  };
}

function captureLabels(service: string) {
  return {
    "com.docker.compose.project": "spx-staging",
    "com.docker.compose.service": service,
    "com.spx.environment": "staging",
    "com.spx.release-sha": captureBindingBase.candidateSha,
    "com.spx.target-descriptor-sha256": captureBindingBase.stagingTargetDescriptorSha256,
    "com.spx.operator-bundle-sha256": captureBindingBase.operatorBundleSha256,
    "com.spx.staging-run-id": runId,
  };
}

function captureContainer(
  service: string,
  nodeId: string,
  workerEnabled: boolean,
  cutoverEpoch?: string,
) {
  return {
    status: "running",
    paused: false,
    restarting: false,
    health: "healthy",
    imageId: captureBindingBase.imageDigest,
    labels: captureLabels(service),
    environment: [
      `SPX_NODE_ID=${nodeId}`,
      `AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=${workerEnabled}`,
      `AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=${workerEnabled}`,
      ...(cutoverEpoch === undefined
        ? []
        : [`AUTO_ACCEPT_JOB_CUTOVER_EPOCH=${cutoverEpoch}`]),
      `DB_PASSWORD=${captureRedactionSentinels.observerCredential}`,
      `RAW_DOCKER_ENV=${captureRedactionSentinels.dockerEnvironment}`,
      `EVIDENCE_PATH=${captureRedactionSentinels.filesystemPath}`,
      `LAST_SQL=${captureRedactionSentinels.sqlText}`,
      `LAST_ERROR=${captureRedactionSentinels.errorText}`,
    ],
  };
}

function captureControl(state: "enabled" | "fenced", acknowledged = false) {
  return {
    state,
    pollerNodeId: "stg-poller-ifn-phase3-1",
    isActive: true,
    activeEpoch: capability.phase3.canaryEpoch,
    activeGeneration: 7,
    publicationGeneration: 7,
    fenceJobId: state === "enabled" ? null : 41,
    ackNodeId: acknowledged ? "stg-poller-ifn-phase3-1" : null,
    ackJobId: acknowledged ? 42 : null,
    acknowledgedAt: acknowledged ? "2026-07-12T10:30:00.000Z" : null,
  };
}

const captureZeroDrain = {
  queued: 0,
  liveClaims: 0,
  indeterminate: 0,
  unknown: 0,
  settlementPending: 0,
};

function captureDbResult(actionId: string) {
  const base = {
    ok: true,
    actionId,
    teamId: 2,
    epoch: capability.phase3.canaryEpoch,
  };
  if (actionId === "phase3-legacy-lease-release") {
    return {
      ...base,
      generation: null,
      measurements: {
        lease: { activeOwnerCount: 0, ownerNodeId: null, legacyOwnerActive: false },
      },
    };
  }
  if (actionId === "phase3-publication-enable") {
    return { ...base, generation: 7, measurements: { control: captureControl("enabled") } };
  }
  if (actionId === "phase3-publication-fence") {
    return { ...base, generation: 7, measurements: { control: captureControl("fenced") } };
  }
  if (actionId === "phase3-drain-or-quarantine") {
    return {
      ...base,
      generation: 7,
      measurements: {
        control: captureControl("fenced", true),
        drain: captureZeroDrain,
      },
    };
  }
  return {
    ...base,
    generation: 7,
    measurements: {
      control: captureControl("fenced", true),
      drain: captureZeroDrain,
      lease: {
        activeOwnerCount: 1,
        ownerNodeId: "stg-worker-ifn-split-1",
        status: "active",
      },
    },
  };
}

function captureDbResultWithRawRow(actionId: string) {
  const result = captureDbResult(actionId);
  Object.defineProperty(result, "rawDatabaseRows", {
    configurable: false,
    enumerable: false,
    value: [{ raw: captureRedactionSentinels.rawDatabaseRow }],
    writable: false,
  });
  return result;
}

function inherited(actionId: string, scope: string) {
  return parseStagingPhase3Invocation([], {
    SPX_STAGING_ACTION_ID: actionId,
    SPX_STAGING_ACTION_SCOPE: scope,
    SPX_STAGING_RUN_ID: runId,
  });
}

const finalObserverDatabase = {
  host: "mysql.staging.internal",
  port: 3306,
  user: "spx_stg_phase3_observer",
  password: "o".repeat(40),
  database: "spx_staging",
  ssl: { ca: "test-ca", rejectUnauthorized: true, servername: "mysql.staging.internal" },
};

function finalEvidenceFixture() {
  const finalActionId = "phase3-inline-owner-restore";
  const phase3Snapshot = captureJournalSnapshot(finalActionId);
  const gate3CompletedAt = "2026-07-12T09:59:59.123Z";
  const actions = [
    {
      sequence: 1,
      actionId: "staging-gate-3-handoff",
      scope: "gate-3",
      kind: "forward",
      mutationSha256: captureHash("mutation:staging-gate-3-handoff"),
      state: "succeeded",
      occurrences: 1,
      terminalRecordSha256: captureHash("terminal:staging-gate-3-handoff"),
      completedAt: gate3CompletedAt,
      reconciliationId: null,
      reconciliationOutcome: null,
    },
    ...phase3Snapshot.actions.map((action) => ({
      ...action,
      sequence: action.sequence + 1,
    })),
  ];
  const journalSnapshot = {
    ...phase3Snapshot,
    recordCount: actions.length,
    actions,
  };
  const installedBinding = captureBinding(finalActionId);
  const partition = phase3PartitionIdentity(
    capability.phase3.canaryTeamId,
    capability.phase3.canaryEpoch,
  );
  const labels = (service: string) => ({
    composeProject: "spx-staging",
    composeService: service,
    environment: "staging",
    releaseSha: installedBinding.candidateSha,
    targetDescriptorSha256: installedBinding.stagingTargetDescriptorSha256,
    operatorBundleSha256: installedBinding.operatorBundleSha256,
    stagingRunId: installedBinding.stagingRunId,
  });
  const terminal = actions.at(-1)!;
  const finalActionMeasurement = {
    schemaVersion: 1,
    actionId: finalActionId,
    mutationSha256: terminal.mutationSha256,
    terminalRecordSha256: terminal.terminalRecordSha256,
    completedAt: terminal.completedAt,
    observedAt: new Date(Date.now()).toISOString(),
    releaseBinding: {
      candidateSha: installedBinding.candidateSha,
      imageDigest: installedBinding.imageDigest,
      releaseManifestSha256: installedBinding.releaseManifestSha256,
      stagingTargetDescriptorSha256: installedBinding.stagingTargetDescriptorSha256,
      operatorBundleSha256: installedBinding.operatorBundleSha256,
      stagingApprovalEnvelopeSha256: installedBinding.stagingApprovalEnvelopeSha256,
      stagingRunId: installedBinding.stagingRunId,
    },
    guardLeaseId: captureLeases.guard.leaseId,
    watchdogLeaseId: captureLeases.watchdog.leaseId,
    teamId: partition.teamId,
    epoch: partition.epoch,
    generation: 7,
    measurements: {
      control: captureControl("fenced", true),
      drain: structuredClone(captureZeroDrain),
      lease: {
        activeOwnerCount: 1,
        ownerNodeId: partition.legacyNodeId,
        status: "active",
      },
      services: {
        poller: {
          service: partition.pollerService,
          nodeId: partition.pollerNodeId,
          running: false,
        },
        consumer: {
          service: partition.consumerService,
          nodeId: partition.consumerNodeId,
          running: false,
        },
        inline: {
          service: partition.legacyService,
          nodeId: partition.legacyNodeId,
          status: "running",
          health: "healthy",
          imageId: installedBinding.imageDigest,
          labels: labels(partition.legacyService),
        },
      },
    },
  };
  return {
    input: {
      context: {
        installedBinding,
        envelope: { approvalId: captureApprovalId },
        verified: {
          approvalId: captureApprovalId,
          rollbackReleaseManifestSha256: captureRollbackSha256,
        },
      },
      capability: structuredClone(capability),
      journalSnapshot,
      finalActionMeasurement,
      leases: structuredClone(captureLeases),
      observerDatabase: structuredClone(finalObserverDatabase),
    },
    gate3CompletedAt,
    finalCompletedAt: terminal.completedAt,
    partition,
  };
}

async function main(): Promise<void> {
  assert.deepEqual(
    PHASE3_STAGING_ACTIONS.map(({ actionId, scope, transition }) =>
      [actionId, scope, transition]),
    expectedActions.map(([actionId, transition]) => [actionId, actionId, transition]),
  );
  assert.equal(typeof buildStagingPhase3EvidencePayload, "function");
  const finalEvidence = finalEvidenceFixture();
  const builtFinalPayload = buildStagingPhase3EvidencePayload(finalEvidence.input);
  assert.deepEqual(builtFinalPayload, {
    schemaVersion: 1,
    evidenceId: "phase3-gate4-final",
    teamId: finalEvidence.partition.teamId,
    epoch: finalEvidence.partition.epoch,
    generation: 7,
    pollerNodeId: finalEvidence.partition.pollerNodeId,
    expectedOwnerNodeId: finalEvidence.partition.legacyNodeId,
    windowStartedAt: finalEvidence.gate3CompletedAt,
    windowEndedAt: finalEvidence.finalCompletedAt,
    connection: finalObserverDatabase,
  });
  assert.equal(Object.isFrozen(builtFinalPayload), true);
  assert.equal(Object.isFrozen(builtFinalPayload.connection), true);

  {
    const changedApproval = finalEvidenceFixture();
    changedApproval.input.context.envelope.approvalId = "other-capture-approval";
    assert.throws(
      () => buildStagingPhase3EvidencePayload(changedApproval.input),
      /approval|identity/i,
    );
  }

  for (const extra of [
    { teamId: 1 },
    { epoch: "caller-epoch" },
    { pollerNodeId: "caller-poller" },
    { expectedOwnerNodeId: "caller-owner" },
    { windowStartedAt: finalEvidence.gate3CompletedAt },
    { windowEndedAt: finalEvidence.finalCompletedAt },
    { nowMs: Date.now() },
    { now: () => Date.now() },
  ]) {
    await assert.rejects(
      async () => buildStagingPhase3EvidencePayload({ ...finalEvidenceFixture().input, ...extra }),
      /exact|input|override|context|window/i,
    );
  }
  assert.throws(
    () => buildStagingPhase3EvidencePayload(finalEvidenceFixture().input, "extra"),
    /argument|exact|input/i,
  );
  const symbolInput = finalEvidenceFixture().input as Record<PropertyKey, unknown>;
  symbolInput[Symbol("override")] = true;
  assert.throws(
    () => buildStagingPhase3EvidencePayload(symbolInput),
    /symbol|exact|input/i,
  );
  for (const hiddenField of ["teamId", "windowStartedAt", "nowMs", "sql"]) {
    const hiddenInput = finalEvidenceFixture().input as Record<string, unknown>;
    Object.defineProperty(hiddenInput, hiddenField, {
      configurable: true,
      enumerable: false,
      value: hiddenField === "teamId" ? 1 : "hidden-override",
    });
    assert.throws(
      () => buildStagingPhase3EvidencePayload(hiddenInput),
      /exact|input|field|own|data/i,
    );
  }
  const hiddenKnownBuilderInput = finalEvidenceFixture().input as Record<string, unknown>;
  const hiddenContext = hiddenKnownBuilderInput.context;
  delete hiddenKnownBuilderInput.context;
  Object.defineProperty(hiddenKnownBuilderInput, "context", {
    configurable: true,
    enumerable: false,
    value: hiddenContext,
  });
  assert.throws(
    () => buildStagingPhase3EvidencePayload(hiddenKnownBuilderInput),
    /exact|input|field|own|data/i,
  );
  const accessorBuilderInput = finalEvidenceFixture().input as Record<string, unknown>;
  const accessorMarker = accessorBuilderInput.finalActionMeasurement;
  let markerReads = 0;
  Object.defineProperty(accessorBuilderInput, "finalActionMeasurement", {
    configurable: true,
    enumerable: true,
    get() {
      markerReads += 1;
      return markerReads === 1 ? accessorMarker : null;
    },
  });
  assert.throws(
    () => buildStagingPhase3EvidencePayload(accessorBuilderInput),
    /exact|input|field|own|data/i,
  );
  assert.equal(markerReads, 0, "builder shape validation must not invoke accessors");
  const hiddenObserverSql = finalEvidenceFixture();
  Object.defineProperty(hiddenObserverSql.input.observerDatabase, "sql", {
    configurable: true,
    enumerable: false,
    value: "SELECT hidden_observer_override",
  });
  assert.throws(
    () => buildStagingPhase3EvidencePayload(hiddenObserverSql.input),
    /connection|actor|field|own|data/i,
  );
  class FinalBuilderRecord {
    constructor() { Object.assign(this, finalEvidenceFixture().input); }
  }
  assert.throws(
    () => buildStagingPhase3EvidencePayload(new FinalBuilderRecord()),
    /exact|input|plain|object/i,
  );
  const inheritedBuilderInput = Object.assign(
    Object.create({ sql: "SELECT inherited_override" }),
    finalEvidenceFixture().input,
  );
  assert.throws(
    () => buildStagingPhase3EvidencePayload(inheritedBuilderInput),
    /exact|input|plain|object/i,
  );
  const frozenBuilderFixture = finalEvidenceFixture();
  const deepFreezeFixture = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeFixture(child);
    }
    Object.freeze(value);
  };
  deepFreezeFixture(frozenBuilderFixture.input);
  assert.deepEqual(
    buildStagingPhase3EvidencePayload(frozenBuilderFixture.input),
    builtFinalPayload,
  );
  for (const [label, observedAt] of [
    ["stale", new Date(Date.now() - (24 * 60 * 60_000 + 60_000)).toISOString()],
    ["future", new Date(Date.now() + 6 * 60_000).toISOString()],
  ] as const) {
    const fixture = finalEvidenceFixture();
    fixture.input.finalActionMeasurement.observedAt = observedAt;
    assert.throws(
      () => buildStagingPhase3EvidencePayload(fixture.input),
      new RegExp(`${label}|marker observation`, "i"),
    );
  }

  const invalidFinalEvidenceInputs = [
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.journalSnapshot.actions.push({
        ...fixture.input.journalSnapshot.actions[0],
        sequence: fixture.input.journalSnapshot.actions.length + 1,
      });
      fixture.input.journalSnapshot.recordCount += 1;
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.journalSnapshot.actions[0].kind = "emergency";
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.journalSnapshot.binding.targetDescriptorSha256 = "f".repeat(64);
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.journalSnapshot.actions[0].completedAt = "2026-07-12 09:59:59";
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.journalSnapshot.actions[0].completedAt = fixture.finalCompletedAt;
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.journalSnapshot.actions[0].completedAt = "2026-07-12T10:00:08.000Z";
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.journalSnapshot.actions.at(-1)!.completedAt = "2026-07-12T10:00:08.000Z";
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.finalActionMeasurement.generation = 0;
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.finalActionMeasurement.teamId = 1;
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.finalActionMeasurement.epoch = "wrong-epoch";
    },
    (fixture: ReturnType<typeof finalEvidenceFixture>) => {
      fixture.input.leases.guard.heartbeatAgeMs = fixture.input.leases.maxAgeMs + 1;
    },
  ];
  for (const mutate of invalidFinalEvidenceInputs) {
    const fixture = finalEvidenceFixture();
    mutate(fixture);
    assert.throws(
      () => buildStagingPhase3EvidencePayload(fixture.input),
      /invalid|duplicate|exactly once|ordinary|binding|timestamp|completion|generation|team|epoch|partition|lease|ordered|window|authenticated journal terminal tuple/i,
    );
  }
  assert.deepEqual(PHASE3_STAGING_OBSERVATIONS, [
    "phase3-schema-verify",
    "phase3-fence-ack-wait",
  ]);

  const exactCurrentMigrations = [
    { name: "035_create_auto_accept_publication_controls.sql", sha256: "1".repeat(64) },
    { name: "036_create_gate6_control_plane.sql", sha256: "2".repeat(64) },
    { name: "037_create_n_minus_one_probe_fixtures.sql", sha256: "3".repeat(64) },
  ];
  const exactCurrentPayload = buildStagingPhase3ObservationPayload({
    observationId: "phase3-schema-verify",
    requiredTerminalActionId: "staging-gate-3-handoff",
    context: {
      installedBinding: {
        candidateSha: "a".repeat(40),
        imageDigest: `sha256:${"b".repeat(64)}`,
        releaseManifestSha256: "c".repeat(64),
        stagingTargetDescriptorSha256: "d".repeat(64),
        operatorBundleSha256: "e".repeat(64),
        stagingApprovalEnvelopeSha256: "f".repeat(64),
        actionJournalHeadSha256: "1".repeat(64),
        stagingRunId: runId,
      },
      envelope: {
        approvalId: captureApprovalId,
        release: { rollbackReleaseManifestSha256: "2".repeat(64) },
      },
      verified: {
        approvalId: captureApprovalId,
        rollbackReleaseManifestSha256: "2".repeat(64),
      },
      artifacts: {
        releaseManifest: {
          schema: { min: 37, max: 37 },
          migrations: exactCurrentMigrations,
        },
        rollbackReleaseManifest: {
          schema: { min: 37, max: 37 },
          migrations: exactCurrentMigrations,
        },
      },
    },
    capability,
    leases: {
      stagingRunId: runId,
      guard: { leaseId: "guard-001" },
      watchdog: { leaseId: "watchdog-001" },
    },
    database: {},
  });
  assert.deepEqual(exactCurrentPayload.releaseContext.schema, { min: 37, max: 37 });
  assert.deepEqual(exactCurrentPayload.releaseContext.rollbackSchema, { min: 37, max: 37 });

  const markerContext = {
    installedBinding: exactCurrentPayload.releaseContext,
    verified: {
      approvalId: captureApprovalId,
      rollbackReleaseManifestSha256: "2".repeat(64),
    },
  };
  const markerLeases = {
    stagingRunId: runId,
    guard: { leaseId: "guard-001" },
    watchdog: { leaseId: "watchdog-001" },
  };
  const schemaObserved = {
    ok: true,
    observationId: "phase3-schema-verify",
    requiredTerminalActionId: "staging-gate-3-handoff",
    teamId: 2,
    epoch: capability.phase3.canaryEpoch,
    pollerNodeId: "stg-poller-ifn-phase3-1",
    generation: null,
    observedAt: "2026-07-12T10:31:00.000Z",
    measurements: schemaObservationMeasurements,
  };
  const builtSchemaMarker = buildStagingPhase3ObservationMarker({
    observationId: schemaObserved.observationId,
    requiredTerminalActionId: schemaObserved.requiredTerminalActionId,
    context: markerContext,
    capability,
    leases: markerLeases,
    journalSnapshot: {
      headSha256: "1".repeat(64),
      actions: [{
        actionId: "staging-gate-3-handoff",
        terminalRecordSha256: "1".repeat(64),
      }],
    },
    observed: schemaObserved,
  });
  assert.deepEqual(builtSchemaMarker, {
    schemaVersion: 1,
    observationId: "phase3-schema-verify",
    requiredTerminalActionId: "staging-gate-3-handoff",
    terminalRecordSha256: "1".repeat(64),
    actionJournalHeadSha256: "1".repeat(64),
    stagingRunId: runId,
    teamId: 2,
    epoch: capability.phase3.canaryEpoch,
    pollerNodeId: "stg-poller-ifn-phase3-1",
    approvalEnvelopeSha256: "f".repeat(64),
    releaseManifestSha256: "c".repeat(64),
    rollbackReleaseManifestSha256: "2".repeat(64),
    targetDescriptorSha256: "d".repeat(64),
    operatorBundleSha256: "e".repeat(64),
    guardLeaseId: "guard-001",
    watchdogLeaseId: "watchdog-001",
    generation: null,
    observedAt: schemaObserved.observedAt,
    measurements: schemaObservationMeasurements,
  });
  assert.notStrictEqual(builtSchemaMarker.measurements, schemaObservationMeasurements);
  assert.equal(Object.isFrozen(builtSchemaMarker), true);
  assert.equal(Object.isFrozen(builtSchemaMarker.measurements), true);

  assert.deepEqual(
    await executeInstalledStagingPhase3Observation({
      observationId: schemaObserved.observationId,
      requiredTerminalActionId: schemaObserved.requiredTerminalActionId,
      context: {
        ...markerContext,
        envelope: {
          approvalId: captureApprovalId,
          release: { rollbackReleaseManifestSha256: "2".repeat(64) },
        },
        artifacts: {
          releaseManifest: {
            schema: { min: 37, max: 37 },
            migrations: exactCurrentMigrations,
          },
          rollbackReleaseManifest: {
            schema: { min: 37, max: 37 },
            migrations: exactCurrentMigrations,
          },
        },
      },
      capability,
      leases: markerLeases,
    }, {
      async loadDatabase() { return {}; },
      async assertLocalDocker() {},
      async runDatabaseObservation() { return schemaObserved; },
    }),
    schemaObserved,
  );
  const rejectedObservationContextEvents: string[] = [];
  await assert.rejects(
    () => executeInstalledStagingPhase3Observation({
      observationId: schemaObserved.observationId,
      requiredTerminalActionId: schemaObserved.requiredTerminalActionId,
      context: {
        ...markerContext,
        envelope: {
          approvalId: captureApprovalId,
          release: { rollbackReleaseManifestSha256: "2".repeat(64) },
        },
        artifacts: {
          releaseManifest: {
            schema: { min: 37, max: 37 },
            migrations: exactCurrentMigrations,
          },
          rollbackReleaseManifest: {
            schema: { min: 37, max: 37 },
            migrations: exactCurrentMigrations,
          },
        },
      },
      capability,
      leases: markerLeases,
    }, {
      async assertLocalDocker() {
        rejectedObservationContextEvents.push("context");
        throw new Error("named remote Docker context is forbidden");
      },
      async loadDatabase() {
        rejectedObservationContextEvents.push("credential");
        return {};
      },
      async runDatabaseObservation() {
        rejectedObservationContextEvents.push("database");
        return schemaObserved;
      },
    }),
    /named remote Docker context/i,
  );
  assert.deepEqual(rejectedObservationContextEvents, ["context"]);
  await assert.rejects(
    () => executeInstalledStagingPhase3Observation({
      observationId: schemaObserved.observationId,
      requiredTerminalActionId: schemaObserved.requiredTerminalActionId,
      context: {
        ...markerContext,
        envelope: {
          approvalId: captureApprovalId,
          release: { rollbackReleaseManifestSha256: "2".repeat(64) },
        },
        artifacts: {
          releaseManifest: {
            schema: { min: 37, max: 37 },
            migrations: exactCurrentMigrations,
          },
          rollbackReleaseManifest: {
            schema: { min: 37, max: 37 },
            migrations: exactCurrentMigrations,
          },
        },
      },
      capability,
      leases: markerLeases,
    }, {
      async loadDatabase() { return {}; },
      async assertLocalDocker() {},
      async runDatabaseObservation() {
        return { ...schemaObserved, connection: { password: "must-not-escape" } };
      },
    }),
    /observation|postcondition|field|shape/i,
  );

  const captureDatabase = {
    host: "db.internal",
    port: 3306,
    user: "spx_stg_phase3_observer",
    password: captureRedactionSentinels.observerCredential,
    database: "spx_staging",
    ssl: {
      ca: "test-ca",
      rejectUnauthorized: true,
      servername: "db.internal",
    },
  };
  const transportPayload = {
    schemaVersion: 1,
    actionId: "phase3-publication-enable",
    teamId: 2,
    epoch: capability.phase3.canaryEpoch,
    expectedGeneration: null,
    connection: {
      ...captureDatabase,
      password: "observer-credential-transport-sentinel",
    },
  };
  const databaseTransport = buildStagingPhase3DatabaseTransport(
    transportPayload,
    captureBinding("phase3-publication-enable"),
  );
  assert.equal(databaseTransport.executable, "docker");
  assert.deepEqual(databaseTransport.argv.slice(0, 7), [
    "--context",
    "default",
    "run",
    "--rm",
    "-i",
    "--pull=never",
    "--network=spx-staging",
  ]);
  assert.equal(
    databaseTransport.argv.indexOf(captureBindingBase.imageDigest) >
      databaseTransport.argv.indexOf("-i"),
    true,
  );
  assert.deepEqual(JSON.parse(databaseTransport.input), transportPayload);
  assert.equal(databaseTransport.argv.some((value: string) =>
    value.includes("observer-credential-transport-sentinel") ||
    value.includes("phase3-publication-enable") ||
    value.startsWith("{")), false);
  assert.equal(Object.isFrozen(databaseTransport), true);
  assert.equal(Object.isFrozen(databaseTransport.argv), true);
  const partition = phase3PartitionIdentity(2, capability.phase3.canaryEpoch);
  const serviceContainerIds = new Map([
    [partition.consumerService, "1".repeat(64)],
    [partition.pollerService, "2".repeat(64)],
    [partition.legacyService, "3".repeat(64)],
  ]);

  function markerExpected(actionId: string) {
    const snapshot = captureJournalSnapshot(actionId);
    return {
      position: "current",
      journalSnapshot: snapshot,
      installedBinding: captureBinding(actionId),
      approvalId: captureApprovalId,
      rollbackReleaseManifestSha256: captureRollbackSha256,
      leases: captureLeases,
      partition,
      nowMs: captureNowMs,
    };
  }

  function capturePorts(
    actionId: string,
    overrides: Record<string, unknown> = {},
    events: string[] = [],
  ) {
    const binding = captureBinding(actionId);
    const ports = {
      async loadApprovedContext() {
        events.push("approved-context");
        return {
          installedBinding: binding,
          envelope: { approvalId: captureApprovalId },
          verified: {
            approvalId: captureApprovalId,
            rollbackReleaseManifestSha256: captureRollbackSha256,
          },
        };
      },
      async loadCapability(actualBinding: unknown) {
        events.push("capability");
        assert.strictEqual(actualBinding, binding);
        return capability;
      },
      async loadObserverDatabase(actualCapability: unknown) {
        events.push("database");
        assert.strictEqual(actualCapability, capability);
        return captureDatabase;
      },
      async assertLocalDocker() {
        events.push("local-docker");
      },
      async listFixedServiceContainerIds(role: string) {
        events.push(`list:${role}`);
        const service = role === "consumer"
          ? partition.consumerService
          : role === "poller"
            ? partition.pollerService
            : partition.legacyService;
        return serviceContainerIds.get(service) ?? "";
      },
      async inspectFixedContainer(containerId: string) {
        events.push(`inspect:${containerId}`);
        if (containerId === serviceContainerIds.get(partition.consumerService)) {
          const identity = captureContainer(
            partition.consumerService,
            partition.consumerNodeId,
            actionId === "phase3-execution-enable",
          );
          return actionId === "phase3-inline-owner-restore"
            ? { ...identity, status: "exited" }
            : identity;
        }
        if (containerId === serviceContainerIds.get(partition.pollerService)) {
          const identity = captureContainer(
            partition.pollerService,
            partition.pollerNodeId,
            false,
            partition.epoch,
          );
          return actionId === "phase3-inline-owner-restore"
            ? { ...identity, status: "exited" }
            : identity;
        }
        if (containerId === serviceContainerIds.get(partition.legacyService)) {
          return captureContainer(partition.legacyService, partition.legacyNodeId, false);
        }
        throw new Error("unexpected fixed container ID");
      },
      async runDatabaseMeasurement(payload: Record<string, unknown>) {
        events.push(`database-measurement:${payload.actionId}`);
        return captureDbResult(String(payload.actionId));
      },
      async readActionMeasurement(
        predecessorActionId: string,
        expected: { position: string; approvalId: string },
      ) {
        events.push(`action-marker:${predecessorActionId}:${expected.position}`);
        assert.equal(expected.approvalId, captureApprovalId);
        return { value: { actionId: predecessorActionId, generation: 7 } };
      },
      async readObservationMarker(
        observationId: string,
        expected: { position: string; approvalId: string },
      ) {
        events.push(`observation-marker:${observationId}:${expected.position}`);
        assert.equal(expected.approvalId, captureApprovalId);
        return { value: { observationId, generation: 7 } };
      },
      now: () => captureNowMs,
      async resolveAction() { events.push("resolve-mutation:unexpected"); },
      async runMutation() { events.push("run-mutation:unexpected"); },
      async writeActionMeasurement() { events.push("write-marker:unexpected"); },
      ...overrides,
    };
    return ports;
  }

  const capturedMarkers = [];
  const databasePayloads: Array<Record<string, unknown>> = [];
  for (const actionId of PHASE3_ACTION_IDS) {
    const events: string[] = [];
    const ports = capturePorts(actionId, {
      async runDatabaseMeasurement(payload: Record<string, unknown>) {
        events.push(`database-measurement:${payload.actionId}`);
        databasePayloads.push(structuredClone(payload));
        return captureDbResult(String(payload.actionId));
      },
    }, events);
    const snapshot = captureJournalSnapshot(actionId);
    const marker = await captureInstalledPhase3ActionMeasurement({
      actionId,
      journalSnapshot: snapshot,
      leases: captureLeases,
    }, ports);
    assert.deepEqual(validatePhase3ActionMeasurement(marker, markerExpected(actionId)), marker);
    assert.equal(Object.isFrozen(marker), true);
    assert.equal(Object.isFrozen(marker.measurements), true);
    for (const sentinel of Object.values(captureRedactionSentinels)) {
      assert.equal(
        JSON.stringify(marker).includes(sentinel),
        false,
        `${actionId} marker must redact ${sentinel}`,
      );
    }
    assert.equal(events.some((event) => event.endsWith(":unexpected")), false);
    capturedMarkers.push(marker);
  }
  assert.deepEqual(
    databasePayloads.map((payload) => ({
      keys: Object.keys(payload).sort(),
      actionId: payload.actionId,
      teamId: payload.teamId,
      epoch: payload.epoch,
      expectedGeneration: payload.expectedGeneration,
      connection: payload.connection,
    })),
    [
      ["phase3-legacy-lease-release", null],
      ["phase3-publication-enable", null],
      ["phase3-publication-fence", null],
      ["phase3-drain-or-quarantine", 7],
      ["phase3-inline-owner-restore", 7],
    ].map(([actionId, expectedGeneration]) => ({
      keys: [
        "actionId",
        "connection",
        "epoch",
        "expectedGeneration",
        "schemaVersion",
        "teamId",
      ],
      actionId,
      teamId: 2,
      epoch: capability.phase3.canaryEpoch,
      expectedGeneration,
      connection: captureDatabase,
    })),
  );
  assert.deepEqual(
    capturedMarkers.map((marker) => [marker.actionId, marker.generation]),
    [
      ["phase3-consumer-start-disabled", null],
      ["phase3-legacy-lease-release", null],
      ["phase3-poller-start", null],
      ["phase3-publication-enable", 7],
      ["phase3-execution-enable", 7],
      ["phase3-publication-fence", 7],
      ["phase3-drain-or-quarantine", 7],
      ["phase3-inline-owner-restore", 7],
    ],
  );

  const observationClockEvents: string[] = [];
  await captureInstalledPhase3ActionMeasurement({
    actionId: "phase3-publication-enable",
    journalSnapshot: captureJournalSnapshot("phase3-publication-enable"),
    leases: captureLeases,
  }, capturePorts("phase3-publication-enable", {
    async runDatabaseMeasurement() {
      observationClockEvents.push("observe");
      return captureDbResult("phase3-publication-enable");
    },
    now() {
      observationClockEvents.push("clock");
      return captureNowMs;
    },
  }));
  assert.deepEqual(observationClockEvents, ["clock", "observe", "clock"]);

  for (const actionId of [
    "phase3-consumer-start-disabled",
    "phase3-poller-start",
    "phase3-execution-enable",
  ]) {
    let openedDatabase = false;
    await captureInstalledPhase3ActionMeasurement({
      actionId,
      journalSnapshot: captureJournalSnapshot(actionId),
      leases: captureLeases,
    }, capturePorts(actionId, {
      async loadObserverDatabase() { openedDatabase = true; throw new Error("unexpected DB open"); },
      async runDatabaseMeasurement() { openedDatabase = true; throw new Error("unexpected DB run"); },
    }));
    assert.equal(openedDatabase, false, `${actionId} must remain Docker-only`);
  }

  for (const actionId of [
    "phase3-legacy-lease-release",
    "phase3-publication-enable",
    "phase3-publication-fence",
    "phase3-drain-or-quarantine",
    "phase3-inline-owner-restore",
  ]) {
    const rejectedContextEvents: string[] = [];
    await assert.rejects(
      () => captureInstalledPhase3ActionMeasurement({
        actionId,
        journalSnapshot: captureJournalSnapshot(actionId),
        leases: captureLeases,
      }, capturePorts(actionId, {
        async assertLocalDocker() {
          rejectedContextEvents.push("context");
          throw new Error("named remote Docker context is forbidden");
        },
        async loadObserverDatabase() {
          rejectedContextEvents.push("credential");
          return captureDatabase;
        },
        async runDatabaseMeasurement() {
          rejectedContextEvents.push("database");
          return captureDbResult(actionId);
        },
      })),
      /named remote Docker context/i,
    );
    assert.deepEqual(
      rejectedContextEvents,
      ["context"],
      `${actionId} must reject a named remote context before DB access`,
    );
  }

  for (const invalidResult of [
    { ...captureDbResult("phase3-publication-enable"), actionId: "phase3-publication-fence" },
    { ...captureDbResult("phase3-publication-enable"), teamId: 1 },
    { ...captureDbResult("phase3-publication-enable"), epoch: "wrong-epoch" },
    { ...captureDbResult("phase3-publication-enable"), generation: 0 },
    { ...captureDbResult("phase3-publication-enable"), extra: true },
    captureDbResultWithRawRow("phase3-publication-enable"),
  ]) {
    await assert.rejects(
      () => captureInstalledPhase3ActionMeasurement({
        actionId: "phase3-publication-enable",
        journalSnapshot: captureJournalSnapshot("phase3-publication-enable"),
        leases: captureLeases,
      }, capturePorts("phase3-publication-enable", {
        async runDatabaseMeasurement() { return invalidResult; },
      })),
      /action|team|epoch|generation|measurement|result|field|shape/i,
    );
  }
  for (const [actionId, invalidResult] of [
    [
      "phase3-legacy-lease-release",
      {
        ...captureDbResult("phase3-legacy-lease-release"),
        measurements: {
          lease: {
            ...captureDbResult("phase3-legacy-lease-release").measurements.lease,
            rawRow: captureRedactionSentinels.rawDatabaseRow,
          },
        },
      },
    ],
    [
      "phase3-publication-enable",
      {
        ...captureDbResult("phase3-publication-enable"),
        measurements: {
          control: {
            ...captureDbResult("phase3-publication-enable").measurements.control,
            sql: captureRedactionSentinels.sqlText,
          },
        },
      },
    ],
    [
      "phase3-drain-or-quarantine",
      {
        ...captureDbResult("phase3-drain-or-quarantine"),
        measurements: {
          ...captureDbResult("phase3-drain-or-quarantine").measurements,
          drain: {
            ...captureDbResult("phase3-drain-or-quarantine").measurements.drain,
            errorText: captureRedactionSentinels.errorText,
          },
        },
      },
    ],
  ] as const) {
    await assert.rejects(
      () => captureInstalledPhase3ActionMeasurement({
        actionId,
        journalSnapshot: captureJournalSnapshot(actionId),
        leases: captureLeases,
      }, capturePorts(actionId, {
        async runDatabaseMeasurement() { return invalidResult; },
      })),
      /measurement|field|shape|secret|payload|message|error|sql/i,
    );
  }
  await assert.rejects(
    () => captureInstalledPhase3ActionMeasurement({
      actionId: "phase3-publication-fence",
      journalSnapshot: captureJournalSnapshot("phase3-publication-fence"),
      leases: captureLeases,
    }, capturePorts("phase3-publication-fence", {
      async runDatabaseMeasurement() {
        return { ...captureDbResult("phase3-publication-fence"), generation: 8 };
      },
    })),
    /generation|predecessor|measurement/i,
  );

  for (const invalidConsumer of [
    { ids: `${"1".repeat(64)}\n${"4".repeat(64)}` },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), status: "exited" } },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), status: "paused" } },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), paused: true } },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), status: "restarting" } },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), restarting: true } },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), status: "created" } },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), health: "unhealthy" } },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), imageId: `sha256:${"e".repeat(64)}` } },
    { identity: captureContainer(partition.consumerService, "wrong-node", false) },
    { identity: captureContainer(partition.consumerService, partition.consumerNodeId, true) },
    { identity: { ...captureContainer(partition.consumerService, partition.consumerNodeId, false), labels: { ...captureLabels(partition.consumerService), "com.spx.release-sha": "wrong" } } },
  ]) {
    const ids = invalidConsumer.ids;
    const identity = invalidConsumer.identity;
    await assert.rejects(
      () => captureInstalledPhase3ActionMeasurement({
        actionId: "phase3-consumer-start-disabled",
        journalSnapshot: captureJournalSnapshot("phase3-consumer-start-disabled"),
        leases: captureLeases,
      }, capturePorts("phase3-consumer-start-disabled", {
        ...(ids === undefined ? {} : {
          async listFixedServiceContainerIds() { return ids; },
        }),
        ...(identity === undefined ? {} : {
          async inspectFixedContainer() { return identity; },
        }),
      })),
      /container|identity|health|image|label|node|worker|service/i,
    );
  }
  const mixedInventoryIds = ["1".repeat(64), "4".repeat(64)];
  const inspectedMixedInventory: string[] = [];
  await assert.rejects(
    () => captureInstalledPhase3ActionMeasurement({
      actionId: "phase3-consumer-start-disabled",
      journalSnapshot: captureJournalSnapshot("phase3-consumer-start-disabled"),
      leases: captureLeases,
    }, capturePorts("phase3-consumer-start-disabled", {
      async listFixedServiceContainerIds() { return mixedInventoryIds.join("\n"); },
      async inspectFixedContainer(containerId: string) {
        inspectedMixedInventory.push(containerId);
        return {
          ...captureContainer(partition.consumerService, partition.consumerNodeId, false),
          status: containerId === mixedInventoryIds[0] ? "running" : "restarting",
        };
      },
    })),
    /exactly one|inventory|container|cardinality/i,
  );
  assert.deepEqual(inspectedMixedInventory.sort(), [...mixedInventoryIds].sort());
  await assert.rejects(
    () => captureInstalledPhase3ActionMeasurement({
      actionId: "phase3-poller-start",
      journalSnapshot: captureJournalSnapshot("phase3-poller-start"),
      leases: captureLeases,
    }, capturePorts("phase3-poller-start", {
      async inspectFixedContainer() {
        return captureContainer(
          partition.pollerService,
          partition.pollerNodeId,
          false,
          "wrong-epoch",
        );
      },
    })),
    /cutover|epoch|identity/i,
  );
  await assert.rejects(
    () => captureInstalledPhase3ActionMeasurement({
      actionId: "phase3-inline-owner-restore",
      journalSnapshot: captureJournalSnapshot("phase3-inline-owner-restore"),
      leases: captureLeases,
    }, capturePorts("phase3-inline-owner-restore", {
      async listFixedServiceContainerIds(role: string) {
        const service = role === "consumer"
          ? partition.consumerService
          : role === "poller"
            ? partition.pollerService
            : partition.legacyService;
        return serviceContainerIds.get(service) ?? "";
      },
      async inspectFixedContainer(containerId: string) {
        if (containerId === serviceContainerIds.get(partition.pollerService)) {
          return captureContainer(
            partition.pollerService,
            partition.pollerNodeId,
            false,
            partition.epoch,
          );
        }
        if (containerId === serviceContainerIds.get(partition.consumerService)) {
          return captureContainer(partition.consumerService, partition.consumerNodeId, true);
        }
        return captureContainer(partition.legacyService, partition.legacyNodeId, false);
      },
    })),
    /stopped|running|service|container/i,
  );
  for (const stoppedState of ["paused", "restarting", "created"]) {
    const inspectedStoppedInventory: string[] = [];
    await assert.rejects(
      () => captureInstalledPhase3ActionMeasurement({
        actionId: "phase3-inline-owner-restore",
        journalSnapshot: captureJournalSnapshot("phase3-inline-owner-restore"),
        leases: captureLeases,
      }, capturePorts("phase3-inline-owner-restore", {
        async inspectFixedContainer(containerId: string) {
          inspectedStoppedInventory.push(containerId);
          if (containerId === serviceContainerIds.get(partition.pollerService)) {
            return {
              ...captureContainer(
                partition.pollerService,
                partition.pollerNodeId,
                false,
                partition.epoch,
              ),
              status: stoppedState,
            };
          }
          if (containerId === serviceContainerIds.get(partition.consumerService)) {
            return {
              ...captureContainer(partition.consumerService, partition.consumerNodeId, true),
              status: "exited",
            };
          }
          return captureContainer(partition.legacyService, partition.legacyNodeId, false);
        },
      })),
      /stopped|state|identity|container/i,
    );
    assert.equal(inspectedStoppedInventory.includes(serviceContainerIds.get(partition.pollerService)!), true);
  }

  for (const [actionId, transition] of expectedActions) {
    const steps = buildStagingPhase3Transitions(actionId, capability, operatorRoot);
    const identity = phase3PartitionIdentity(
      capability.phase3.canaryTeamId,
      capability.phase3.canaryEpoch,
    );
    assert.equal(steps.length, 1, `${actionId} must execute exactly one transition`);
    assert.equal(steps[0].transition, transition);
    assert.equal(steps[0].partition, "ifn");
    for (const [key, value] of Object.entries(identity)) {
      assert.deepEqual(steps[0][key], value, `${actionId} must use fixed ${key}`);
    }
  }
  const handlerSource = readFileSync("scripts/staging-phase3-action-handler.mjs", "utf8");
  assert.match(handlerSource, /import\s*\{[\s\S]*?\bphase3PartitionIdentity\b[\s\S]*?\}\s*from\s*"\.\/lib\/phase3-staging-evidence\.mjs"/);
  assert.doesNotMatch(handlerSource, /const\s+PARTITIONS\s*=/);
  assert.doesNotMatch(handlerSource, /writeInstalledStagingPhase3ObservationEvidence/);
  assert.doesNotMatch(handlerSource, /\brename\s*\(/);
  const databaseCommandSource = handlerSource.match(
    /function candidateDatabaseCommand[\s\S]*?\n}/,
  )?.[0] ?? "";
  assert.match(databaseCommandSource, /"--context",\s*"default"/);
  assert.match(databaseCommandSource, /"run",\s*"--rm",\s*"-i"/);
  assert.doesNotMatch(databaseCommandSource, /canonicalJson|payload|password|connection/);
  const databaseTransportSource = handlerSource.match(
    /function runDatabasePayload[\s\S]*?(?=\nfunction runDatabaseTransition)/,
  )?.[0] ?? "";
  assert.match(databaseTransportSource, /input:\s*transport\.input/);
  assert.doesNotMatch(databaseTransportSource, /argv:[^\n]*payload/);
  assert.match(handlerSource, /spawn\("docker",\s*\[\s*"--context",\s*"default",\s*"inspect"/);
  assert.match(handlerSource, /unpinned Docker invocation is forbidden/);
  assert.doesNotMatch(
    handlerSource,
    /spawn\("docker",\s*\["context",\s*"show"\],\s*\{\s*capture:\s*true\s*\}\)/,
  );
  assert.match(handlerSource, /"ps",\s*"--all",\s*"-q"/);
  assert.doesNotMatch(handlerSource, /"ps",\s*"--status",\s*"running",\s*"-q"/);
  const mainSource = handlerSource.match(/async function main\(\)[\s\S]*$/)?.[0] ?? "";
  assert.equal(
    mainSource.indexOf("await assertInstalledLocalDocker({})") <
      mainSource.indexOf("loadStagingDatabaseCredential(capability, \"phase3-control\")"),
    true,
  );

  const ptwlEpoch = "ptwl-epoch-001";
  const ptwl = buildStagingPhase3Transitions(
    "phase3-poller-start",
    { phase3: { canaryTeamId: 1, canaryEpoch: ptwlEpoch } },
    operatorRoot,
  );
  const ptwlIdentity = phase3PartitionIdentity(1, ptwlEpoch);
  assert.equal(ptwl.length, 1);
  assert.equal(ptwl[0].partition, "ptwl");
  for (const [key, value] of Object.entries(ptwlIdentity)) {
    assert.deepEqual(ptwl[0][key], value, `PTWL must use fixed ${key}`);
  }

  const executionStep = buildStagingPhase3Transitions(
    "phase3-execution-enable",
    capability,
    operatorRoot,
  )[0];
  const otherConsumer = "auto-accept-ptwl-phase3";
  const containerId = "1".repeat(64);
  const healthyIdentity = {
    status: "running",
    health: "healthy",
    imageId: executionBinding.imageDigest,
    labels: {
      "com.docker.compose.project": "spx-staging",
      "com.docker.compose.service": executionStep.consumerService,
      "com.spx.environment": "staging",
      "com.spx.release-sha": executionBinding.candidateSha,
      "com.spx.target-descriptor-sha256":
        executionBinding.stagingTargetDescriptorSha256,
      "com.spx.operator-bundle-sha256": executionBinding.operatorBundleSha256,
      "com.spx.staging-run-id": executionBinding.stagingRunId,
    },
  };
  const trueConfig = {
    services: {
      [executionStep.consumerService]: {
        environment: {
          AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true",
          AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "true",
        },
      },
    },
  };
  async function runExecutionEnable({
    config = trueConfig,
    ids = containerId,
    identity = healthyIdentity,
  }: {
    config?: unknown;
    ids?: string;
    identity?: unknown;
  } = {}) {
    const commands: string[][] = [];
    const inspectedIds: string[] = [];
    const result = await executeStagingPhase3Transition(executionStep, {
      binding: executionBinding,
      composeEnv: {},
      async runCompose(argv: string[]) {
        commands.push(argv);
        if (argv.includes("config")) return JSON.stringify(config);
        if (argv.includes("ps")) return ids;
        return "";
      },
      async inspectService(id: string) {
        inspectedIds.push(id);
        return identity;
      },
    });
    return { commands, inspectedIds, result };
  }

  const enabled = await runExecutionEnable();
  assert.deepEqual(enabled.result, { ok: true, transition: "execution-enable" });
  assert.deepEqual(enabled.inspectedIds, [containerId]);
  const renderCommand = enabled.commands.find((argv) => argv.includes("config"));
  const upCommand = enabled.commands.find((argv) => argv.includes("up"));
  const psCommand = enabled.commands.find((argv) => argv.includes("ps"));
  assert.ok(renderCommand);
  assert.ok(upCommand);
  assert.ok(psCommand);
  assert.deepEqual(
    renderCommand.slice(-7),
    [
      "-f",
      `${operatorRoot}/deploy/staging-phase3-enabled.yml`,
      "--profile",
      "phase3",
      "config",
      "--format",
      "json",
    ],
  );
  assert.deepEqual(
    upCommand.slice(-12),
    [
      "-f",
      `${operatorRoot}/deploy/staging-phase3-enabled.yml`,
      "--profile",
      "phase3",
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "120",
      executionStep.consumerService,
    ],
  );
  assert.equal(upCommand.filter((value) => value === executionStep.consumerService).length, 1);
  assert.equal(upCommand.includes(otherConsumer), false);
  assert.deepEqual(psCommand.slice(-3), ["ps", "-q", executionStep.consumerService]);

  let missingBindingComposeRan = false;
  await assert.rejects(
    () => executeStagingPhase3Transition(executionStep, {
      composeEnv: {},
      async runCompose() {
        missingBindingComposeRan = true;
        return "";
      },
      async inspectService() { return healthyIdentity; },
    }),
    /binding|identity/i,
  );
  assert.equal(missingBindingComposeRan, false);

  for (const falseFlag of [
    "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
    "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
  ] as const) {
    let falseFlagUpRan = false;
    await assert.rejects(
      () => executeStagingPhase3Transition(executionStep, {
        binding: executionBinding,
        composeEnv: {},
        async runCompose(argv: string[]) {
          if (argv.includes("config")) {
            return JSON.stringify({
              services: {
                [executionStep.consumerService]: {
                  environment: {
                    AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true",
                    AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "true",
                    [falseFlag]: "false",
                  },
                },
              },
            });
          }
          if (argv.includes("up")) falseFlagUpRan = true;
          return "";
        },
        async inspectService() { return healthyIdentity; },
      }),
      /enabled|worker|flag/i,
    );
    assert.equal(falseFlagUpRan, false);
  }
  for (const ids of ["", `${"1".repeat(64)}\n${"2".repeat(64)}`, "not-a-container"]) {
    await assert.rejects(() => runExecutionEnable({ ids }), /container|identity|inspect/i);
  }
  for (const identity of [
    { ...healthyIdentity, status: "exited" },
    { ...healthyIdentity, health: "unhealthy" },
    { ...healthyIdentity, health: "starting" },
    { ...healthyIdentity, health: undefined },
    { ...healthyIdentity, imageId: `sha256:${"e".repeat(64)}` },
  ]) {
    await assert.rejects(() => runExecutionEnable({ identity }), /readiness|identity/i);
  }
  for (const label of Object.keys(healthyIdentity.labels)) {
    await assert.rejects(
      () => runExecutionEnable({
        identity: {
          ...healthyIdentity,
          labels: { ...healthyIdentity.labels, [label]: "wrong" },
        },
      }),
      /readiness|identity/i,
    );
    const labels = { ...healthyIdentity.labels } as Record<string, string>;
    delete labels[label];
    await assert.rejects(
      () => runExecutionEnable({ identity: { ...healthyIdentity, labels } }),
      /readiness|identity/i,
    );
  }
  await assert.rejects(
    () => executeStagingPhase3Transition(
      { ...executionStep, enabledOverlay: "/caller/selected.yml" },
      {
        binding: executionBinding,
        composeEnv: {},
        async runCompose() { return ""; },
        async inspectService() { return healthyIdentity; },
      },
    ),
    /fixed|trusted|transition/i,
  );

  const disabledStep = buildStagingPhase3Transitions(
    "phase3-consumer-start-disabled",
    capability,
    operatorRoot,
  )[0];
  const disabledOverlay = `${operatorRoot}/deploy/staging-phase3-disabled.yml`;
  const disabledCommands: string[][] = [];
  assert.deepEqual(
    await executeStagingPhase3Transition(disabledStep, {
      composeEnv: {},
      async runCompose(argv: string[]) {
        disabledCommands.push(argv);
        if (argv.includes("config")) {
          return JSON.stringify({
            services: {
              [disabledStep.consumerService]: {
                environment: {
                  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "false",
                  AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "false",
                },
              },
            },
          });
        }
        return "";
      },
    }),
    { ok: true, transition: "consumer-start-disabled" },
  );
  assert.deepEqual(disabledCommands, [
    [
      ...disabledStep.composePrefix,
      "-f",
      disabledOverlay,
      "--profile",
      "phase3",
      "config",
      "--format",
      "json",
    ],
    [
      ...disabledStep.composePrefix,
      "-f",
      disabledOverlay,
      "--profile",
      "phase3",
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      disabledStep.consumerService,
    ],
  ]);
  for (const command of disabledCommands) {
    assert.equal(
      command.filter((value) => value === "-f").length,
      disabledStep.composePrefix.filter((value: string) => value === "-f").length + 1,
    );
    assert.equal(command.filter((value) => value === disabledOverlay).length, 1);
    assert.equal(command.includes(`${operatorRoot}/deploy/staging-phase3-enabled.yml`), false);
    assert.equal(command.includes(otherConsumer), false);
  }

  for (const [actionId] of expectedActions.filter(
    ([currentActionId]) => ![
      "phase3-consumer-start-disabled",
      "phase3-execution-enable",
    ].includes(currentActionId),
  )) {
    const step = buildStagingPhase3Transitions(actionId, capability, operatorRoot)[0];
    const commands: string[][] = [];
    await executeStagingPhase3Transition(step, {
      binding: executionBinding,
      composeEnv: {},
      async runCompose(argv: string[]) {
        commands.push(argv);
        if (argv.includes("config")) {
          return JSON.stringify({
            services: {
              [step.consumerService]: {
                environment: {
                  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "false",
                  AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "false",
                },
              },
            },
          });
        }
        return "";
      },
      async runDatabaseTransition(_step: unknown, databaseAction: string) {
        return { ok: true, action: databaseAction };
      },
    });
    assert.equal(
      commands.flat().includes(`${operatorRoot}/deploy/staging-phase3-enabled.yml`),
      false,
      `${actionId} must not use the enabled overlay`,
    );
  }

  const restoreEvents: string[] = [];
  const restoreStep = buildStagingPhase3Transitions(
    "phase3-inline-owner-restore",
    capability,
    operatorRoot,
  )[0];
  assert.deepEqual(
    await executeStagingPhase3Transition(restoreStep, {
      composeEnv: {},
      async runCompose(argv: string[]) {
        restoreEvents.push(`compose:${argv.slice(-3).join(":")}`);
        return "";
      },
      async runDatabaseTransition(_step: unknown, databaseAction: string) {
        restoreEvents.push(`database:${databaseAction}`);
        return { ok: true, action: databaseAction };
      },
    }),
    { ok: true, transition: "inline-owner-restore" },
  );
  assert.deepEqual(restoreEvents, [
    "database:inline-owner-restore-precheck",
    "compose:120:poller-ifn-phase3:auto-accept-ifn-phase3",
    "compose:-d:--no-deps:worker-ifn-split",
    "database:inline-owner-restore",
  ]);
  await assert.rejects(
    () => executeStagingPhase3Transition(
      { ...restoreStep, legacyService: "caller-selected-service" },
      {
        composeEnv: {},
        async runCompose() { return ""; },
        async runDatabaseTransition(_step: unknown, databaseAction: string) {
          return { ok: true, action: databaseAction };
        },
      },
    ),
    /fixed|trusted|transition/i,
  );

  assert.throws(
    () => buildStagingPhase3Transitions(
      "phase3-poller-start",
      { phase3: { canaryTeamId: 3, canaryEpoch: "bad-team" } },
      operatorRoot,
    ),
    /canary|team/i,
  );
  assert.throws(
    () => buildStagingPhase3Transitions("phase3-fence-ack-wait", capability, operatorRoot),
    /action|observation/i,
  );

  const disabled = readFileSync("deploy/staging-phase3-disabled.yml", "utf8");
  assert.match(disabled, /auto-accept-ifn-phase3:[\s\S]*AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED:\s*"false"/);
  assert.match(disabled, /auto-accept-ptwl-phase3:[\s\S]*AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED:\s*"false"/);

  const calls: string[] = [];
  const action = inherited("phase3-publication-fence", "phase3-publication-fence");
  assert.deepEqual(
    await executeStagingPhase3Action(
      { inherited: action, capability, operatorRoot, binding: { stagingRunId: runId } },
      {
        async loadLeases() {
          calls.push("leases");
          return {
            stagingRunId: runId,
            maxAgeMs: 5_000,
            guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: 100 },
            watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
          };
        },
        async executeTransition(step: { transition: string }) {
          calls.push(step.transition);
          return { ok: true, transition: step.transition };
        },
        async recordTransition() { calls.push("record:unexpected"); },
        async writeObservationMarker() { calls.push("observation-write:unexpected"); },
        async writeActionMeasurement() { calls.push("action-write:unexpected"); },
      },
    ),
    { ok: true, actionId: action.actionId, transitionCount: 1 },
  );
  assert.deepEqual(calls, [
    "leases",
    "publication-fence",
    "leases",
  ]);

  const schemaAction = inherited(
    "phase3-consumer-start-disabled",
    "phase3-consumer-start-disabled",
  );
  let schemaTransitionRan = false;
  await assert.rejects(
    () => executeStagingPhase3Action(
      { inherited: schemaAction, capability, operatorRoot, binding: {
        stagingRunId: runId,
        actionJournalHeadSha256: "a".repeat(64),
      } },
      {
        async loadLeases() {
          return {
            stagingRunId: runId,
            maxAgeMs: 5_000,
            guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: 100 },
            watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
          };
        },
        async executeTransition() {
          schemaTransitionRan = true;
          return { ok: true, transition: "consumer-start-disabled" };
        },
      },
    ),
    /schema|observation|evidence/i,
  );
  assert.equal(schemaTransitionRan, false);

  const schemaEvidence = {
    schemaVersion: 1,
    observationId: "phase3-schema-verify",
    requiredTerminalActionId: "staging-gate-3-handoff",
    terminalRecordSha256: "a".repeat(64),
    actionJournalHeadSha256: "a".repeat(64),
    stagingRunId: runId,
    teamId: 2,
    epoch: capability.phase3.canaryEpoch,
    pollerNodeId: "stg-poller-ifn-phase3-1",
    approvalEnvelopeSha256: "b".repeat(64),
    releaseManifestSha256: "c".repeat(64),
    rollbackReleaseManifestSha256: "d".repeat(64),
    targetDescriptorSha256: "e".repeat(64),
    operatorBundleSha256: "f".repeat(64),
    guardLeaseId: "guard-001",
    watchdogLeaseId: "watchdog-001",
    generation: null,
    observedAt: "2026-07-12T10:31:00.000Z",
    measurements: schemaObservationMeasurements,
  };
  for (const invalidSchemaEvidence of [
    { ...schemaEvidence, observedAt: "not-a-timestamp" },
    {
      ...schemaEvidence,
      measurements: { ...schemaEvidence.measurements, pendingMigrations: 1 },
    },
    {
      ...schemaEvidence,
      measurements: { ...schemaEvidence.measurements, observerReadOnly: false },
    },
    {
      ...schemaEvidence,
      measurements: { ...schemaEvidence.measurements, schemaMaximum: undefined },
    },
  ]) {
    let invalidSchemaTransitionRan = false;
    await assert.rejects(
      () => executeStagingPhase3Action(
        {
          inherited: schemaAction,
          capability,
          operatorRoot,
          binding: {
            stagingRunId: runId,
            stagingApprovalEnvelopeSha256: "b".repeat(64),
            releaseManifestSha256: "c".repeat(64),
            stagingTargetDescriptorSha256: "e".repeat(64),
            operatorBundleSha256: "f".repeat(64),
            actionJournalHeadSha256: "a".repeat(64),
          },
          rollbackReleaseManifestSha256: "d".repeat(64),
        },
        {
          async loadLeases() {
            return {
              stagingRunId: runId,
              maxAgeMs: 5_000,
              guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: 100 },
              watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
            };
          },
          async loadObservationEvidence() { return invalidSchemaEvidence; },
          async executeTransition() {
            invalidSchemaTransitionRan = true;
            return { ok: true, transition: "consumer-start-disabled" };
          },
        },
      ),
      /observation|timestamp|measure|schema|field|shape/i,
    );
    assert.equal(invalidSchemaTransitionRan, false);
  }
  let schemaEvidenceTransitionRan = false;
  await executeStagingPhase3Action(
    {
      inherited: schemaAction,
      capability,
      operatorRoot,
      binding: {
        stagingRunId: runId,
        stagingApprovalEnvelopeSha256: "b".repeat(64),
        releaseManifestSha256: "c".repeat(64),
        stagingTargetDescriptorSha256: "e".repeat(64),
        operatorBundleSha256: "f".repeat(64),
        actionJournalHeadSha256: "a".repeat(64),
      },
      rollbackReleaseManifestSha256: "d".repeat(64),
    },
    {
      async loadLeases() {
        return {
          stagingRunId: runId,
          maxAgeMs: 5_000,
          guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: 100 },
          watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
        };
      },
      async loadObservationEvidence() { return schemaEvidence; },
      async executeTransition(step: { transition: string }) {
        schemaEvidenceTransitionRan = true;
        return { ok: true, transition: step.transition };
      },
    },
  );
  assert.equal(schemaEvidenceTransitionRan, true);

  const fenceEvidence = {
    schemaVersion: 1,
    observationId: "phase3-fence-ack-wait",
    requiredTerminalActionId: "phase3-publication-fence",
    terminalRecordSha256: "a".repeat(64),
    actionJournalHeadSha256: "a".repeat(64),
    stagingRunId: runId,
    teamId: 2,
    epoch: capability.phase3.canaryEpoch,
    pollerNodeId: "stg-poller-ifn-phase3-1",
    approvalEnvelopeSha256: "b".repeat(64),
    releaseManifestSha256: "c".repeat(64),
    rollbackReleaseManifestSha256: "d".repeat(64),
    targetDescriptorSha256: "e".repeat(64),
    operatorBundleSha256: "f".repeat(64),
    guardLeaseId: "guard-001",
    watchdogLeaseId: "watchdog-001",
    generation: 7,
    observedAt: "2026-07-12T10:31:00.000Z",
    measurements: fenceObservationMeasurements,
  };
  const gatedBinding = {
    stagingRunId: runId,
    stagingApprovalEnvelopeSha256: "b".repeat(64),
    releaseManifestSha256: "c".repeat(64),
    stagingTargetDescriptorSha256: "e".repeat(64),
    operatorBundleSha256: "f".repeat(64),
  };
  for (const [actionId, expectedHead] of [
    ["phase3-drain-or-quarantine", "a".repeat(64)],
    ["phase3-inline-owner-restore", "c".repeat(64)],
  ] as const) {
    const gated = inherited(actionId, actionId);
    let observedGeneration: number | undefined;
    await executeStagingPhase3Action(
      { inherited: gated, capability, operatorRoot, binding: {
        ...gatedBinding,
        actionJournalHeadSha256: expectedHead,
      }, rollbackReleaseManifestSha256: "d".repeat(64) },
      {
        async loadLeases() {
          return {
            stagingRunId: runId,
            maxAgeMs: 5_000,
            guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: 100 },
            watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
          };
        },
        async loadObservationEvidence() { return fenceEvidence; },
        async executeTransition(step: { transition: string; expectedGeneration?: number }) {
          observedGeneration = step.expectedGeneration;
          return { ok: true, transition: step.transition };
        },
      },
    );
    assert.equal(observedGeneration, 7);
  }

  let mismatchedFenceRan = false;
  await assert.rejects(
    () => executeStagingPhase3Action(
      { inherited: inherited("phase3-drain-or-quarantine", "phase3-drain-or-quarantine"),
        capability,
        operatorRoot,
        binding: {
          ...gatedBinding,
          actionJournalHeadSha256: "d".repeat(64),
        },
        rollbackReleaseManifestSha256: "d".repeat(64) },
      {
        async loadLeases() {
          return {
            stagingRunId: runId,
            maxAgeMs: 5_000,
            guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: 100 },
            watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
          };
        },
        async loadObservationEvidence() { return fenceEvidence; },
        async executeTransition() {
          mismatchedFenceRan = true;
          return { ok: true, transition: "drain-or-quarantine" };
        },
      },
    ),
    /journal|head|evidence/i,
  );
  assert.equal(mismatchedFenceRan, false);

  for (const invalidEvidence of [
    { ...fenceEvidence, observedAt: undefined },
    { ...fenceEvidence, observedAt: "not-a-timestamp" },
    { ...fenceEvidence, measurements: { ...fenceEvidence.measurements, ackJobId: 9 } },
    { ...fenceEvidence, measurements: { ...fenceEvidence.measurements, ackNodeId: "wrong" } },
    { ...fenceEvidence, measurements: { ...fenceEvidence.measurements, observerReadOnly: false } },
    { ...fenceEvidence, measurements: { ...fenceEvidence.measurements, extra: true } },
  ]) {
    let invalidEvidenceTransitionRan = false;
    await assert.rejects(
      () => executeStagingPhase3Action(
        {
          inherited: inherited("phase3-drain-or-quarantine", "phase3-drain-or-quarantine"),
          capability,
          operatorRoot,
          binding: { ...gatedBinding, actionJournalHeadSha256: "a".repeat(64) },
          rollbackReleaseManifestSha256: "d".repeat(64),
        },
        {
          async loadLeases() {
            return {
              stagingRunId: runId,
              maxAgeMs: 5_000,
              guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: 100 },
              watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
            };
          },
          async loadObservationEvidence() { return invalidEvidence; },
          async executeTransition() {
            invalidEvidenceTransitionRan = true;
            return { ok: true, transition: "drain-or-quarantine" };
          },
        },
      ),
      /observation|timestamp|measure|fence|acknowledg|field|shape/i,
    );
    assert.equal(invalidEvidenceTransitionRan, false);
  }

  let switchedCanaryRan = false;
  await assert.rejects(
    () => executeStagingPhase3Action(
      {
        inherited: inherited("phase3-drain-or-quarantine", "phase3-drain-or-quarantine"),
        capability: { phase3: { canaryTeamId: 1, canaryEpoch: "ptwl-epoch-002" } },
        operatorRoot,
        binding: { ...gatedBinding, actionJournalHeadSha256: "a".repeat(64) },
        rollbackReleaseManifestSha256: "d".repeat(64),
      },
      {
        async loadLeases() {
          return {
            stagingRunId: runId,
            maxAgeMs: 5_000,
            guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: 100 },
            watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
          };
        },
        async loadObservationEvidence() { return fenceEvidence; },
        async executeTransition() {
          switchedCanaryRan = true;
          return { ok: true, transition: "drain-or-quarantine" };
        },
      },
    ),
    /canary|team|epoch|observation|binding/i,
  );
  assert.equal(switchedCanaryRan, false);
  let invalidTransitionRan = false;
  await assert.rejects(
    () => executeStagingPhase3Action(
      { inherited: action, capability, operatorRoot, binding: { stagingRunId: runId } },
      {
        async loadLeases() {
          return {
            stagingRunId: runId,
            maxAgeMs: 5_000,
            guard: { leaseId: "guard-001", state: "armed", heartbeatAgeMs: Number.NaN },
            watchdog: { leaseId: "watchdog-001", state: "armed", heartbeatAgeMs: 100 },
          };
        },
        async executeTransition() {
          invalidTransitionRan = true;
          return { ok: true, transition: "publication-fence" };
        },
      },
    ),
    /same fresh continuous/i,
  );
  assert.equal(invalidTransitionRan, false);
  assert.throws(
    () => parseStagingPhase3Invocation(["override"], process.env),
    /zero|argument/i,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
