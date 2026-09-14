import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";
import {
  PHASE3_RUNTIME_SOURCE_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
} from "../scripts/lib/phase3-staging-evidence.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import {
  executeInstalledStagingRolloutAction,
  executeStagingRolloutAction,
  parseRolloutControllerArgs,
} from "../scripts/a3-staging-rollout-controller.mjs";

const events: string[] = [];
const verifiedRollout = {
  action(actionId: string) {
    events.push(`resolve:${actionId}`);
    return {
      async run() {
        events.push(`consume-and-run:${actionId}`);
        return true;
      },
    };
  },
};
const leases = {
  stagingRunId: "staging-run-001",
  guard: { leaseId: "guard-001", heartbeatAgeMs: 1_000 },
  watchdog: { leaseId: "watchdog-001", heartbeatAgeMs: 1_000 },
  maxAgeMs: 5_000,
};
const phase3Operations = [
  ["phase3-consumer-start-disabled", "phase3-consumer-start-disabled"],
  ["phase3-legacy-lease-release", "phase3-legacy-lease-release"],
  ["phase3-poller-start", "phase3-poller-start"],
  ["phase3-publication-enable", "phase3-publication-enable"],
  ["phase3-execution-enable", "phase3-execution-enable"],
  ["phase3-publication-fence", "phase3-publication-fence"],
  ["phase3-drain-or-quarantine", "phase3-drain-or-quarantine"],
  ["phase3-inline-owner-restore", "phase3-inline-owner-restore"],
  ["gate-4-phase3", "staging-gate-4-phase3"],
] as const;
const phase3ActionIds = phase3Operations.slice(0, 8).map(([, actionId]) => actionId);
const phase3ControllerApprovalId = "phase3-controller-approval-001";
const phase3ControllerRollbackSha256 = "9".repeat(64);
const phase3ControllerBindingBase = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: "c".repeat(64),
  environment: "staging",
  topology: "phase3",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: "d".repeat(64),
  operatorBundleSha256: "e".repeat(64),
  stagingApprovalEnvelopeSha256: "f".repeat(64),
  actionJournalHeadSha256: "0".repeat(64),
  stagingRunId: leases.stagingRunId,
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function gate4Snapshot(gate4State = "registered") {
  const actions = REQUIRED_STAGING_ACTION_PLAN.map((planned, index) => {
    const succeeded = index < 23;
    const terminalRecordSha256 = succeeded ? hash(`terminal:${planned.actionId}`) : null;
    return {
      ...planned,
      state: index === 23 ? gate4State : succeeded ? "succeeded" : "registered",
      occurrences: index === 23 && gate4State === "succeeded" ? 1 : succeeded ? 1 : 0,
      terminalRecordSha256: index === 23 && gate4State === "succeeded"
        ? hash("terminal:staging-gate-4-phase3")
        : terminalRecordSha256,
      completedAt: index === 23 && gate4State === "succeeded"
        ? "2026-07-12T10:24:00.000Z"
        : succeeded
          ? new Date(Date.parse("2026-07-12T10:00:00.000Z") + index * 60_000).toISOString()
          : null,
      reconciliationId: null,
      reconciliationOutcome: null,
    };
  });
  if (gate4State === "ambiguous") {
    actions[23] = {
      ...actions[23],
      occurrences: 0,
      terminalRecordSha256: null,
      completedAt: null,
    };
  }
  const headSha256 = gate4State === "succeeded"
    ? actions[23].terminalRecordSha256!
    : actions[22].terminalRecordSha256!;
  return {
    schemaVersion: 1,
    binding: {
      approvalId: phase3ControllerApprovalId,
      stagingRunId: leases.stagingRunId,
      approvalEnvelopeSha256: phase3ControllerBindingBase.stagingApprovalEnvelopeSha256,
      targetDescriptorSha256: phase3ControllerBindingBase.stagingTargetDescriptorSha256,
      operatorBundleSha256: phase3ControllerBindingBase.operatorBundleSha256,
    },
    recordCount: gate4State === "succeeded" ? 92 : gate4State === "ambiguous" ? 91 : 90,
    headSha256,
    actions,
  };
}

const gate4InitialLeases = {
  stagingRunId: leases.stagingRunId,
  guard: {
    schemaVersion: 1,
    role: "guard",
    state: "armed",
    breachCount: 0,
    baselineP95LatencyMs: 25,
    leaseId: "11111111-1111-4111-8111-111111111111",
    stagingRunId: leases.stagingRunId,
    pid: 101,
    startedMonotonicMs: 1_000,
    heartbeatMonotonicMs: 9_000,
    heartbeatAgeMs: 1_000,
  },
  watchdog: {
    schemaVersion: 1,
    role: "watchdog",
    state: "armed",
    breachCount: 0,
    baselineP95LatencyMs: null,
    leaseId: "22222222-2222-4222-8222-222222222222",
    stagingRunId: leases.stagingRunId,
    pid: 202,
    startedMonotonicMs: 2_000,
    heartbeatMonotonicMs: 9_100,
    heartbeatAgeMs: 900,
  },
  maxAgeMs: 10_000,
};

function gate4RuntimeRecord(sourceId: string, value: unknown) {
  const sourceValue = { schemaVersion: 1, sourceId, ...(value as object) };
  const bytes = canonicalJson(sourceValue);
  return { value: sourceValue, bytes, sha256: hash(bytes) };
}

function gate4RuntimeSources() {
  const after = {
    guard: {
      leaseId: gate4InitialLeases.guard.leaseId,
      state: "armed",
      pid: gate4InitialLeases.guard.pid,
      startedMonotonicMs: gate4InitialLeases.guard.startedMonotonicMs,
      heartbeatMonotonicMs: 9_200,
      heartbeatAgeMs: 800,
      baselineP95LatencyMs: gate4InitialLeases.guard.baselineP95LatencyMs,
    },
    watchdog: {
      leaseId: gate4InitialLeases.watchdog.leaseId,
      state: "armed",
      pid: gate4InitialLeases.watchdog.pid,
      startedMonotonicMs: gate4InitialLeases.watchdog.startedMonotonicMs,
      heartbeatMonotonicMs: 9_300,
      heartbeatAgeMs: 700,
      baselineP95LatencyMs: gate4InitialLeases.watchdog.baselineP95LatencyMs,
    },
  };
  return Object.fromEntries(PHASE3_RUNTIME_SOURCE_IDS.map((sourceId) => [
    sourceId,
    gate4RuntimeRecord(
      sourceId,
      sourceId === "lease-continuity" ? { continuity: { after } } : {},
    ),
  ]));
}

function gate4SemanticResult(runtimeSources: ReturnType<typeof gate4RuntimeSources>) {
  const semanticValue = { schemaVersion: 2, evidenceId: "phase3-semantic-controller-test" };
  const bytes = canonicalJson(semanticValue);
  return {
    semantic: { value: semanticValue, bytes, sha256: hash(bytes) },
    semanticSha256: hash(bytes),
    sources: Object.fromEntries(PHASE3_SEMANTIC_SOURCE_IDS.map((sourceId) => [
      sourceId,
      PHASE3_RUNTIME_SOURCE_IDS.some((runtimeSourceId) =>
        sourceId === `phase3-${runtimeSourceId}`)
        ? runtimeSources[sourceId.slice("phase3-".length)].sha256
        : hash(`source:${sourceId}`),
    ])),
  };
}

function phase3ControllerMutation(actionId: string) {
  return (phase3ActionIds.indexOf(actionId) + 1).toString(16).repeat(64);
}

function phase3ControllerTerminal(actionId: string) {
  return (phase3ActionIds.indexOf(actionId) + 8).toString(16).repeat(64);
}

function phase3ControllerAction(
  actionId: string,
  sequence: number,
  state: string,
) {
  const succeeded = state === "succeeded" || state === "reconciled";
  return {
    sequence,
    actionId,
    scope: actionId,
    kind: "forward",
    mutationSha256: phase3ControllerMutation(actionId),
    state,
    occurrences: succeeded ? 1 : 0,
    terminalRecordSha256: succeeded ? phase3ControllerTerminal(actionId) : null,
    completedAt: succeeded
      ? new Date(Date.parse("2026-07-12T10:00:00.000Z") + sequence * 1_000).toISOString()
      : null,
    reconciliationId: state === "reconciled" ? "reconciliation-001" : null,
    reconciliationOutcome: state === "reconciled" ? "succeeded" : null,
  };
}

function phase3ControllerSnapshot(
  currentActionId: string,
  currentState: string,
  options: { nonCurrent?: boolean; duplicate?: boolean } = {},
) {
  const currentIndex = phase3ActionIds.indexOf(currentActionId);
  const actions = phase3ActionIds.map((actionId, index) => phase3ControllerAction(
    actionId,
    index + 1,
    index < currentIndex ? "succeeded" : index === currentIndex ? currentState : "registered",
  ));
  if (options.duplicate) actions.push({ ...actions[currentIndex] });
  const previousHead = currentIndex === 0
    ? "0".repeat(64)
    : phase3ControllerTerminal(phase3ActionIds[currentIndex - 1]);
  return {
    schemaVersion: 1,
    binding: {
      approvalId: phase3ControllerApprovalId,
      stagingRunId: leases.stagingRunId,
      approvalEnvelopeSha256: phase3ControllerBindingBase.stagingApprovalEnvelopeSha256,
      targetDescriptorSha256: phase3ControllerBindingBase.stagingTargetDescriptorSha256,
      operatorBundleSha256: phase3ControllerBindingBase.operatorBundleSha256,
    },
    recordCount: phase3ActionIds.length + currentIndex + (currentState === "succeeded" ? 1 : 0),
    headSha256: currentState === "succeeded" && !options.nonCurrent
      ? phase3ControllerTerminal(currentActionId)
      : previousHead,
    actions,
  };
}

function phase3ControllerBinding(snapshot: ReturnType<typeof phase3ControllerSnapshot>) {
  return { ...phase3ControllerBindingBase, actionJournalHeadSha256: snapshot.headSha256 };
}

async function main(): Promise<void> {
  assert.deepEqual(parseRolloutControllerArgs(["line-fault"]), { operation: "line-fault" });
  assert.deepEqual(parseRolloutControllerArgs(["phase3-schema-verify"]), {
    operation: "phase3-schema-verify",
  });
  assert.deepEqual(parseRolloutControllerArgs(["phase3-fence-ack-wait"]), {
    operation: "phase3-fence-ack-wait",
  });
  assert.deepEqual(
    phase3Operations.map(([operation]) => parseRolloutControllerArgs([operation])),
    phase3Operations.map(([operation]) => ({ operation })),
  );
  for (const inheritedName of ["toString", "constructor", "__proto__"]) {
    assert.throws(() => parseRolloutControllerArgs([inheritedName]), /unknown/i);
  }
  assert.throws(() => parseRolloutControllerArgs([]), /override/i);
  assert.throws(() => parseRolloutControllerArgs(["phase3-unknown"]), /unknown/i);
  for (const override of [
    "--scope=staging",
    "--team=all",
    "--epoch=caller-selected",
    "--service=poller",
    "--path=/tmp/caller-selected",
    "--command=caller-selected",
  ]) {
    assert.throws(
      () => parseRolloutControllerArgs(["phase3-consumer-start-disabled", override]),
      /override/i,
    );
    assert.throws(
      () => parseRolloutControllerArgs(["gate-4-phase3", override]),
      /override/i,
    );
  }
  assert.throws(() => parseRolloutControllerArgs(["line-fault", "--project=spx"]), /override/i);
  for (const observationOperation of [
    "phase3-schema-verify",
    "phase3-fence-ack-wait",
  ]) {
    await assert.rejects(
      () => executeStagingRolloutAction({
        operation: observationOperation,
        verifiedRollout,
        leases,
        stagingRunId: leases.stagingRunId,
      }),
      /unknown staging operation/i,
    );
  }
  assert.deepEqual(
    await executeStagingRolloutAction({
    operation: "line-fault",
    verifiedRollout,
    leases,
    stagingRunId: leases.stagingRunId,
    }),
    { ok: true, actionId: "staging-line-fault" },
  );
  assert.deepEqual(events, ["resolve:staging-line-fault", "consume-and-run:staging-line-fault"]);

  const liveEvents: string[] = [];
  const installedRollout = {
    action(actionId: string) {
      liveEvents.push(`resolve:${actionId}`);
      return {
        async run() {
          liveEvents.push(`consume-and-run:${actionId}`);
        },
      };
    },
    async close() {
      liveEvents.push("close");
    },
  };
  assert.deepEqual(
    await executeInstalledStagingRolloutAction("line-fault", {
      async openVerifiedRollout() {
        liveEvents.push("verified-rollout");
        return {
          binding: { stagingRunId: leases.stagingRunId },
          rollout: installedRollout,
        };
      },
      async loadLeases(stagingRunId: string) {
        liveEvents.push(`leases:${stagingRunId}`);
        return leases;
      },
    }),
    { ok: true, actionId: "staging-line-fault" },
  );
  assert.deepEqual(liveEvents, [
    "verified-rollout",
    `leases:${leases.stagingRunId}`,
    "resolve:staging-line-fault",
    "consume-and-run:staging-line-fault",
    "close",
  ]);

  const gate4ActionId = "staging-gate-4-phase3";
  const gate4ProofNames = [
    "schema-verify",
    "consumer-start-disabled",
    "legacy-lease-release",
    "poller-start",
    "publication-enable",
    "execution-enable",
    "publication-fence",
    "fence-acknowledged",
    "drain-or-quarantine",
    "inline-owner-restore",
    "baseline-restored",
    "phase3-durable-evidence",
    "release-binding",
    "guard-continuity",
    "production-unchanged",
  ];
  function gate4Harness(options: {
    snapshot?: ReturnType<typeof gate4Snapshot>;
    producerError?: Error;
    leaseResults?: Array<typeof gate4InitialLeases>;
  } = {}) {
    const snapshot = options.snapshot ?? gate4Snapshot();
    const binding = {
      ...phase3ControllerBindingBase,
      topology: "phase3",
      actionJournalHeadSha256: snapshot.headSha256,
    };
    const runtimeSources = gate4RuntimeSources();
    const semanticResult = gate4SemanticResult(runtimeSources);
    const gate4Events: string[] = [];
    let runCount = 0;
    let resolveCount = 0;
    let closeCount = 0;
    let leaseIndex = 0;
    const leaseResults = options.leaseResults ?? [
      gate4InitialLeases,
      {
        ...gate4InitialLeases,
        guard: {
          ...gate4InitialLeases.guard,
          heartbeatMonotonicMs: 9_500,
          heartbeatAgeMs: 500,
        },
        watchdog: {
          ...gate4InitialLeases.watchdog,
          heartbeatMonotonicMs: 9_600,
          heartbeatAgeMs: 400,
        },
      },
    ];
    const ports = {
      async openVerifiedRollout() {
        gate4Events.push("open-verified-rollout");
        return {
          binding,
          verified: {
            approvalId: phase3ControllerApprovalId,
            rollbackReleaseManifestSha256: phase3ControllerRollbackSha256,
          },
          rollout: {
            action(actionId: string) {
              resolveCount += 1;
              gate4Events.push(`resolve:${actionId}`);
              assert.equal(actionId, gate4ActionId);
              return {
                async run() {
                  runCount += 1;
                  gate4Events.push("consume:staging-gate-4-phase3");
                  gate4Events.push("verify:gate-4-proofs");
                  gate4Events.push("verify:phase3-semantic");
                  gate4Events.push("handler:reload-leases");
                  gate4Events.push("terminal:staging-gate-4-phase3");
                },
              };
            },
            async snapshot() {
              gate4Events.push("snapshot:phase3-inline-owner-restore");
              return snapshot;
            },
            async close() {
              closeCount += 1;
              gate4Events.push("close");
            },
          },
        };
      },
      async loadLeases() {
        leaseIndex += 1;
        gate4Events.push(leaseIndex === 1 ? "leases:L0" : "leases:Lpre");
        return leaseResults[Math.min(leaseIndex - 1, leaseResults.length - 1)];
      },
      async writeSnapshot(value: unknown) {
        gate4Events.push("persist:snapshot-bytes");
        assert.deepEqual(value, snapshot);
        const bytes = canonicalJson(value);
        return { path: "/fixed/journal-snapshot.json", value, bytes, sha256: hash(bytes) };
      },
      async collectRuntimeSources(input: { journalSnapshot: unknown; leases: unknown }) {
        gate4Events.push("collect:five-runtime-sources");
        assert.deepEqual(input.journalSnapshot, snapshot);
        assert.deepEqual(input.leases, gate4InitialLeases);
        return runtimeSources;
      },
      async produceSemantic(input: { journalSnapshot: unknown }) {
        gate4Events.push("produce:phase3-rollout-evidence.json");
        assert.deepEqual(input.journalSnapshot, snapshot);
        return semanticResult;
      },
      async produceProofs(input: { semanticSha256: string; sources: Record<string, string> }) {
        if (options.producerError) throw options.producerError;
        assert.equal(input.semanticSha256, semanticResult.semanticSha256);
        assert.deepEqual(input.sources, semanticResult.sources);
        for (const proofName of gate4ProofNames) gate4Events.push(`proof:${proofName}`);
        gate4Events.push("aggregate:gate-4.json");
        return { ok: true, actionId: gate4ActionId };
      },
      now: () => Date.now(),
    };
    return {
      gate4Events,
      ports,
      get runCount() { return runCount; },
      get resolveCount() { return resolveCount; },
      get closeCount() { return closeCount; },
    };
  }

  const gate4 = gate4Harness();
  assert.deepEqual(
    await executeInstalledStagingRolloutAction("gate-4-phase3", gate4.ports),
    { ok: true, actionId: gate4ActionId },
  );
  assert.equal(gate4.runCount, 1);
  assert.equal(gate4.resolveCount, 1);
  assert.equal(gate4.closeCount, 1);
  assert.deepEqual(gate4.gate4Events, [
    "open-verified-rollout",
    "leases:L0",
    "snapshot:phase3-inline-owner-restore",
    "persist:snapshot-bytes",
    "collect:five-runtime-sources",
    "produce:phase3-rollout-evidence.json",
    ...gate4ProofNames.map((proofName) => `proof:${proofName}`),
    "aggregate:gate-4.json",
    "leases:Lpre",
    "resolve:staging-gate-4-phase3",
    "consume:staging-gate-4-phase3",
    "verify:gate-4-proofs",
    "verify:phase3-semantic",
    "handler:reload-leases",
    "terminal:staging-gate-4-phase3",
    "close",
  ]);

  const gate4ProducerFailure = gate4Harness({
    producerError: new Error("Gate 4 proof producer failed"),
  });
  await assert.rejects(
    executeInstalledStagingRolloutAction("gate-4-phase3", gate4ProducerFailure.ports),
    /proof producer failed/i,
  );
  assert.equal(gate4ProducerFailure.resolveCount, 0);
  assert.equal(gate4ProducerFailure.runCount, 0);
  assert.equal(gate4ProducerFailure.closeCount, 1);
  assert.equal(
    gate4ProducerFailure.gate4Events.includes("consume:staging-gate-4-phase3"),
    false,
  );

  for (const invalidState of ["ambiguous", "succeeded"]) {
    const invalidGate4 = gate4Harness({ snapshot: gate4Snapshot(invalidState) });
    await assert.rejects(
      executeInstalledStagingRolloutAction("gate-4-phase3", invalidGate4.ports),
      /Gate.?4|registered|snapshot|head|inline|pre-consumption/i,
    );
    assert.equal(invalidGate4.resolveCount, 0);
    assert.equal(invalidGate4.runCount, 0);
    assert.equal(invalidGate4.closeCount, 1);
  }

  const changedPreLease = gate4Harness({
    leaseResults: [
      gate4InitialLeases,
      {
        ...gate4InitialLeases,
        guard: { ...gate4InitialLeases.guard, pid: 999 },
      },
    ],
  });
  await assert.rejects(
    executeInstalledStagingRolloutAction("gate-4-phase3", changedPreLease.ports),
    /lease|continuity|instance|pid/i,
  );
  assert.equal(changedPreLease.resolveCount, 0);
  assert.equal(changedPreLease.runCount, 0);

  const changedBaselinePreLease = gate4Harness({
    leaseResults: [
      gate4InitialLeases,
      {
        ...gate4InitialLeases,
        guard: {
          ...gate4InitialLeases.guard,
          baselineP95LatencyMs: 26,
        },
      },
    ],
  });
  await assert.rejects(
    executeInstalledStagingRolloutAction("gate-4-phase3", changedBaselinePreLease.ports),
    /lease|continuity|instance|baseline/i,
  );
  assert.equal(changedBaselinePreLease.resolveCount, 0);
  assert.equal(changedBaselinePreLease.runCount, 0);

  const rolledBackHeartbeatPreLease = gate4Harness({
    leaseResults: [
      gate4InitialLeases,
      {
        ...gate4InitialLeases,
        guard: {
          ...gate4InitialLeases.guard,
          heartbeatMonotonicMs: 9_100,
          heartbeatAgeMs: 500,
        },
      },
    ],
  });
  await assert.rejects(
    executeInstalledStagingRolloutAction("gate-4-phase3", rolledBackHeartbeatPreLease.ports),
    /lease|continuity|heartbeat/i,
  );
  assert.equal(rolledBackHeartbeatPreLease.resolveCount, 0);
  assert.equal(rolledBackHeartbeatPreLease.runCount, 0);

  const expiredPreLease = gate4Harness({
    leaseResults: [
      gate4InitialLeases,
      {
        ...gate4InitialLeases,
        watchdog: {
          ...gate4InitialLeases.watchdog,
          heartbeatMonotonicMs: 9_600,
          heartbeatAgeMs: 10_001,
        },
      },
    ],
  });
  await assert.rejects(
    executeInstalledStagingRolloutAction("gate-4-phase3", expiredPreLease.ports),
    /fresh|watchdog|lease/i,
  );
  assert.equal(expiredPreLease.resolveCount, 0);
  assert.equal(expiredPreLease.runCount, 0);

  await assert.rejects(
    executeInstalledStagingRolloutAction("gate-4-phase3", {
      openVerifiedRollout: gate4.ports.openVerifiedRollout,
    } as never),
    /port|complete|function|Gate.?4/i,
  );
  const controllerNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      executeInstalledStagingRolloutAction("gate-4-phase3", gate4.ports),
      /test|port|caller|forbidden/i,
    );
  } finally {
    process.env.NODE_ENV = controllerNodeEnv;
  }

  const markerSha256 = "7".repeat(64);
  function phase3Harness({
    actionId,
    initialSnapshot,
    postSnapshot = phase3ControllerSnapshot(actionId, "succeeded"),
    leaseResults = [leases, leases, leases],
    currentMarker = "missing",
    mutationError,
    captureError,
    writeError,
    reloadedBinding,
    reloadedRollbackSha256 = phase3ControllerRollbackSha256,
  }: {
    actionId: string;
    initialSnapshot: ReturnType<typeof phase3ControllerSnapshot>;
    postSnapshot?: ReturnType<typeof phase3ControllerSnapshot>;
    leaseResults?: Array<typeof leases>;
    currentMarker?: "missing" | "valid" | "tampered";
    mutationError?: Error;
    captureError?: Error;
    writeError?: Error;
    reloadedBinding?: Record<string, unknown>;
    reloadedRollbackSha256?: string;
  }) {
    const harnessEvents: string[] = [];
    let currentSnapshot = initialSnapshot;
    let runCount = 0;
    let closeCount = 0;
    let leaseIndex = 0;
    let captureCount = 0;
    let writeCount = 0;
    let resolveCount = 0;
    const initialBinding = phase3ControllerBinding(initialSnapshot);
    const finalBinding = reloadedBinding ?? phase3ControllerBinding(postSnapshot);
    const marker = { schemaVersion: 1, actionId };
    const opened = {
      binding: initialBinding,
      verified: {
        approvalId: phase3ControllerApprovalId,
        rollbackReleaseManifestSha256: phase3ControllerRollbackSha256,
      },
      rollout: {
        action(actualActionId: string) {
          resolveCount += 1;
          harnessEvents.push(`resolve:${actualActionId}`);
          assert.equal(actualActionId, actionId);
          return {
            async run() {
              runCount += 1;
              harnessEvents.push(`run:${actualActionId}`);
              if (mutationError) throw mutationError;
              currentSnapshot = postSnapshot;
            },
          };
        },
        async snapshot() {
          harnessEvents.push(`snapshot:${currentSnapshot.headSha256}`);
          return currentSnapshot;
        },
        async close() {
          closeCount += 1;
          harnessEvents.push("close");
        },
      },
    };
    return {
      harnessEvents,
      opened,
      get runCount() { return runCount; },
      get resolveCount() { return resolveCount; },
      get closeCount() { return closeCount; },
      get captureCount() { return captureCount; },
      get writeCount() { return writeCount; },
      ports: {
        async openVerifiedRollout() {
          harnessEvents.push("open");
          return opened;
        },
        async loadCapability(actualBinding: typeof initialBinding) {
          harnessEvents.push("capability");
          assert.strictEqual(actualBinding, initialBinding);
          return { phase3: { canaryTeamId: 2, canaryEpoch: "ifn-epoch-001" } };
        },
        async loadLeases() {
          harnessEvents.push(`leases:${leaseIndex + 1}`);
          const value = leaseResults[Math.min(leaseIndex, leaseResults.length - 1)];
          leaseIndex += 1;
          return value;
        },
        async readActionMarker(
          markerActionId: string,
          expected: { position: string; journalSnapshot: unknown; approvalId: string },
        ) {
          harnessEvents.push(`read:${markerActionId}:${expected.position}`);
          assert.strictEqual(expected.journalSnapshot, currentSnapshot);
          assert.equal(expected.approvalId, phase3ControllerApprovalId);
          if (markerActionId !== actionId) {
            return { sha256: "6".repeat(64), value: { actionId: markerActionId } };
          }
          if (currentMarker === "valid") {
            return { sha256: markerSha256, value: marker };
          }
          if (currentMarker === "tampered") throw new Error("tampered action marker");
          throw Object.assign(new Error("missing action marker"), { code: "ENOENT" });
        },
        async loadApprovedContext() {
          harnessEvents.push("approved-context");
          return {
            installedBinding: finalBinding,
            envelope: { approvalId: phase3ControllerApprovalId },
            verified: {
              approvalId: phase3ControllerApprovalId,
              rollbackReleaseManifestSha256: reloadedRollbackSha256,
            },
          };
        },
        async captureActionMeasurement(input: {
          actionId: string;
          journalSnapshot: unknown;
          leases: unknown;
        }) {
          captureCount += 1;
          harnessEvents.push("capture");
          assert.equal(input.actionId, actionId);
          assert.strictEqual(input.journalSnapshot, currentSnapshot);
          if (captureError) throw captureError;
          return marker;
        },
        async writeActionMarker(
          value: unknown,
          expected: { position: string; journalSnapshot: unknown; approvalId: string },
        ) {
          writeCount += 1;
          harnessEvents.push(`write:${expected.position}`);
          assert.strictEqual(value, marker);
          assert.strictEqual(expected.journalSnapshot, currentSnapshot);
          assert.equal(expected.approvalId, phase3ControllerApprovalId);
          if (writeError) throw writeError;
          return { sha256: markerSha256, value };
        },
        now: () => Date.parse("2026-07-12T12:00:00.000Z"),
      },
    };
  }

  const registeredActionId = "phase3-execution-enable";
  const registeredSnapshot = phase3ControllerSnapshot(registeredActionId, "registered");
  const registered = phase3Harness({ actionId: registeredActionId, initialSnapshot: registeredSnapshot });
  assert.deepEqual(
    await executeInstalledStagingRolloutAction(registeredActionId, registered.ports),
    { ok: true, actionId: registeredActionId, markerSha256 },
  );
  assert.equal(registered.runCount, 1);
  assert.equal(registered.captureCount, 1);
  assert.equal(registered.writeCount, 1);
  assert.equal(registered.closeCount, 1);
  assert.deepEqual(registered.harnessEvents, [
    "open",
    `snapshot:${registeredSnapshot.headSha256}`,
    "capability",
    "leases:1",
    "read:phase3-consumer-start-disabled:historical",
    "read:phase3-legacy-lease-release:historical",
    "read:phase3-poller-start:historical",
    "read:phase3-publication-enable:historical",
    `resolve:${registeredActionId}`,
    `run:${registeredActionId}`,
    `snapshot:${phase3ControllerTerminal(registeredActionId)}`,
    "approved-context",
    "leases:2",
    "capture",
    "leases:3",
    "write:current",
    "close",
  ]);

  const missingPredecessor = phase3Harness({
    actionId: registeredActionId,
    initialSnapshot: registeredSnapshot,
  });
  const originalRead = missingPredecessor.ports.readActionMarker;
  missingPredecessor.ports.readActionMarker = async (markerActionId: string, expected: never) => {
    if (markerActionId === "phase3-poller-start") {
      throw Object.assign(new Error("missing predecessor marker"), { code: "ENOENT" });
    }
    return originalRead(markerActionId, expected);
  };
  await assert.rejects(
    () => executeInstalledStagingRolloutAction(registeredActionId, missingPredecessor.ports),
    /missing predecessor/i,
  );
  assert.equal(missingPredecessor.resolveCount, 0);
  assert.equal(missingPredecessor.closeCount, 1);

  const mutationFailure = phase3Harness({
    actionId: "phase3-consumer-start-disabled",
    initialSnapshot: phase3ControllerSnapshot("phase3-consumer-start-disabled", "registered"),
    mutationError: new Error("fixed mutation failed"),
  });
  await assert.rejects(
    () => executeInstalledStagingRolloutAction(
      "phase3-consumer-start-disabled",
      mutationFailure.ports,
    ),
    /fixed mutation failed/i,
  );
  assert.equal(mutationFailure.runCount, 1);
  assert.equal(mutationFailure.captureCount, 0);
  assert.equal(mutationFailure.writeCount, 0);
  assert.equal(mutationFailure.closeCount, 1);

  for (const invalidPostSnapshot of [
    phase3ControllerSnapshot(registeredActionId, "registered"),
    phase3ControllerSnapshot(registeredActionId, "reconciled"),
    phase3ControllerSnapshot(registeredActionId, "succeeded", { nonCurrent: true }),
    phase3ControllerSnapshot(registeredActionId, "succeeded", { duplicate: true }),
  ]) {
    const invalidPost = phase3Harness({
      actionId: registeredActionId,
      initialSnapshot: registeredSnapshot,
      postSnapshot: invalidPostSnapshot,
    });
    await assert.rejects(
      () => executeInstalledStagingRolloutAction(registeredActionId, invalidPost.ports),
      /ordinary|terminal|head|duplicate|snapshot|succeeded/i,
    );
    assert.equal(invalidPost.captureCount, 0);
    assert.equal(invalidPost.closeCount, 1);
  }

  for (const invalidReload of [
    { binding: { ...phase3ControllerBinding(phase3ControllerSnapshot(registeredActionId, "succeeded")), candidateSha: "b".repeat(40) } },
    { binding: { ...phase3ControllerBinding(phase3ControllerSnapshot(registeredActionId, "succeeded")), actionJournalHeadSha256: "1".repeat(64) } },
    { rollback: "8".repeat(64) },
  ]) {
    const changedBinding = phase3Harness({
      actionId: registeredActionId,
      initialSnapshot: registeredSnapshot,
      reloadedBinding: invalidReload.binding,
      reloadedRollbackSha256: invalidReload.rollback,
    });
    await assert.rejects(
      () => executeInstalledStagingRolloutAction(registeredActionId, changedBinding.ports),
      /binding|release|rollback|head|changed/i,
    );
    assert.equal(changedBinding.captureCount, 0);
    assert.equal(changedBinding.closeCount, 1);
  }

  const succeededSnapshot = phase3ControllerSnapshot(registeredActionId, "succeeded");
  const reusedMarker = phase3Harness({
    actionId: registeredActionId,
    initialSnapshot: succeededSnapshot,
    postSnapshot: succeededSnapshot,
    currentMarker: "valid",
  });
  assert.deepEqual(
    await executeInstalledStagingRolloutAction(registeredActionId, reusedMarker.ports),
    { ok: true, actionId: registeredActionId, markerSha256 },
  );
  assert.equal(reusedMarker.runCount, 0);
  assert.equal(reusedMarker.captureCount, 0);
  assert.equal(reusedMarker.writeCount, 0);
  assert.equal(reusedMarker.closeCount, 1);
  assert.deepEqual(reusedMarker.harnessEvents.slice(-3), [
    `read:${registeredActionId}:historical`,
    "leases:2",
    "close",
  ]);

  const recovery = phase3Harness({
    actionId: registeredActionId,
    initialSnapshot: succeededSnapshot,
    postSnapshot: succeededSnapshot,
  });
  assert.deepEqual(
    await executeInstalledStagingRolloutAction(registeredActionId, recovery.ports),
    { ok: true, actionId: registeredActionId, markerSha256 },
  );
  assert.equal(recovery.runCount, 0);
  assert.equal(recovery.resolveCount, 0);
  assert.equal(recovery.captureCount, 1);
  assert.equal(recovery.writeCount, 1);
  assert.equal(recovery.closeCount, 1);

  const tamperedMarker = phase3Harness({
    actionId: registeredActionId,
    initialSnapshot: succeededSnapshot,
    postSnapshot: succeededSnapshot,
    currentMarker: "tampered",
  });
  await assert.rejects(
    () => executeInstalledStagingRolloutAction(registeredActionId, tamperedMarker.ports),
    /tampered action marker/i,
  );
  assert.equal(tamperedMarker.captureCount, 0);
  assert.equal(tamperedMarker.closeCount, 1);

  for (const invalidState of ["failed", "ambiguous", "reconciled", "compensated"]) {
    const noReplay = phase3Harness({
      actionId: registeredActionId,
      initialSnapshot: phase3ControllerSnapshot(registeredActionId, invalidState),
    });
    await assert.rejects(
      () => executeInstalledStagingRolloutAction(registeredActionId, noReplay.ports),
      /state|ordinary|terminal|replay|succeeded|registered/i,
    );
    assert.equal(noReplay.resolveCount, 0);
    assert.equal(noReplay.captureCount, 0);
    assert.equal(noReplay.closeCount, 1);
  }
  const nonCurrentSuccess = phase3Harness({
    actionId: registeredActionId,
    initialSnapshot: phase3ControllerSnapshot(registeredActionId, "succeeded", { nonCurrent: true }),
  });
  await assert.rejects(
    () => executeInstalledStagingRolloutAction(registeredActionId, nonCurrentSuccess.ports),
    /current|head|terminal/i,
  );
  assert.equal(nonCurrentSuccess.resolveCount, 0);
  assert.equal(nonCurrentSuccess.closeCount, 1);

  for (const leaseFailure of [
    [leases, { ...leases, guard: { ...leases.guard, leaseId: "guard-replaced" } }],
    [leases, leases, {
      ...leases,
      watchdog: { ...leases.watchdog, heartbeatAgeMs: leases.maxAgeMs + 1 },
    }],
  ]) {
    const invalidLease = phase3Harness({
      actionId: registeredActionId,
      initialSnapshot: succeededSnapshot,
      postSnapshot: succeededSnapshot,
      leaseResults: leaseFailure,
    });
    await assert.rejects(
      () => executeInstalledStagingRolloutAction(registeredActionId, invalidLease.ports),
      /same|fresh|lease|instance|watchdog/i,
    );
    assert.equal(invalidLease.writeCount, 0);
    assert.equal(invalidLease.closeCount, 1);
  }

  let retrySnapshot = phase3ControllerSnapshot("phase3-consumer-start-disabled", "registered");
  const retrySucceededSnapshot = phase3ControllerSnapshot(
    "phase3-consumer-start-disabled",
    "succeeded",
  );
  let retryRunCount = 0;
  let retryCaptureCount = 0;
  let retryWriteCount = 0;
  let retryCloseCount = 0;
  let retryInvocation = 0;
  async function retryInvocationPorts() {
    const invocation = retryInvocation;
    retryInvocation += 1;
    const initialBinding = phase3ControllerBinding(retrySnapshot);
    return {
      async openVerifiedRollout() {
        return {
          binding: initialBinding,
          verified: {
            approvalId: phase3ControllerApprovalId,
            rollbackReleaseManifestSha256: phase3ControllerRollbackSha256,
          },
          rollout: {
            action() {
              return {
                async run() {
                  retryRunCount += 1;
                  retrySnapshot = retrySucceededSnapshot;
                },
              };
            },
            async snapshot() { return retrySnapshot; },
            async close() { retryCloseCount += 1; },
          },
        };
      },
      async loadCapability() {
        return { phase3: { canaryTeamId: 2, canaryEpoch: "ifn-epoch-001" } };
      },
      async loadLeases() { return leases; },
      async readActionMarker() {
        throw Object.assign(new Error("missing action marker"), { code: "ENOENT" });
      },
      async loadApprovedContext() {
        return {
          installedBinding: phase3ControllerBinding(retrySucceededSnapshot),
          envelope: { approvalId: phase3ControllerApprovalId },
          verified: {
            approvalId: phase3ControllerApprovalId,
            rollbackReleaseManifestSha256: phase3ControllerRollbackSha256,
          },
        };
      },
      async captureActionMeasurement() {
        retryCaptureCount += 1;
        return { actionId: "phase3-consumer-start-disabled" };
      },
      async writeActionMarker(value: unknown) {
        retryWriteCount += 1;
        if (invocation === 0) throw new Error("marker publication failed");
        return { sha256: markerSha256, value };
      },
      now: () => Date.parse("2026-07-12T12:00:00.000Z"),
    };
  }
  await assert.rejects(
    () => retryInvocationPorts().then((ports) => executeInstalledStagingRolloutAction(
      "phase3-consumer-start-disabled",
      ports,
    )),
    /marker publication failed/i,
  );
  assert.deepEqual(
    await retryInvocationPorts().then((ports) => executeInstalledStagingRolloutAction(
      "phase3-consumer-start-disabled",
      ports,
    )),
    { ok: true, actionId: "phase3-consumer-start-disabled", markerSha256 },
  );
  assert.equal(retryRunCount, 1);
  assert.equal(retryCaptureCount, 2);
  assert.equal(retryWriteCount, 2);
  assert.equal(retryCloseCount, 2);

  const observationBinding = {
    candidateSha: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    releaseManifestSha256: "c".repeat(64),
    environment: "staging",
    topology: "phase3",
    composeProject: "spx-staging",
    stagingTargetDescriptorSha256: "d".repeat(64),
    operatorBundleSha256: "e".repeat(64),
    stagingApprovalEnvelopeSha256: "f".repeat(64),
    actionJournalHeadSha256: "1".repeat(64),
    stagingRunId: leases.stagingRunId,
  };
  let invalidOpenedCloseCount = 0;
  await assert.rejects(
    () => executeInstalledStagingRolloutAction("phase3-schema-verify", {
      async openVerifiedRollout() {
        return {
          binding: {},
          rollout: {
            async close() { invalidOpenedCloseCount += 1; },
          },
        };
      },
    }),
    /installed|verified|rollout|invalid/i,
  );
  assert.equal(invalidOpenedCloseCount, 1);
  const observationContext = {
    installedBinding: observationBinding,
    envelope: { approvalId: phase3ControllerApprovalId },
    verified: {
      approvalId: phase3ControllerApprovalId,
      rollbackReleaseManifestSha256: "9".repeat(64),
    },
  };
  const schemaMeasurements = {
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
  };
  const schemaResult = {
    ok: true,
    observationId: "phase3-schema-verify",
    requiredTerminalActionId: "staging-gate-3-handoff",
    teamId: 2,
    epoch: "ifn-epoch-001",
    pollerNodeId: "stg-poller-ifn-phase3-1",
    generation: null,
    observedAt: "2026-07-12T10:31:00.000Z",
    measurements: schemaMeasurements,
  };
  const schemaMarker = {
    schemaVersion: 1,
    observationId: schemaResult.observationId,
    requiredTerminalActionId: schemaResult.requiredTerminalActionId,
    terminalRecordSha256: "1".repeat(64),
    actionJournalHeadSha256: "1".repeat(64),
    stagingRunId: leases.stagingRunId,
    teamId: schemaResult.teamId,
    epoch: schemaResult.epoch,
    pollerNodeId: schemaResult.pollerNodeId,
    approvalEnvelopeSha256: observationBinding.stagingApprovalEnvelopeSha256,
    releaseManifestSha256: observationBinding.releaseManifestSha256,
    rollbackReleaseManifestSha256: observationContext.verified.rollbackReleaseManifestSha256,
    targetDescriptorSha256: observationBinding.stagingTargetDescriptorSha256,
    operatorBundleSha256: observationBinding.operatorBundleSha256,
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
    generation: null,
    observedAt: schemaResult.observedAt,
    measurements: schemaMeasurements,
  };
  function schemaSnapshot(headSha256 = "1".repeat(64)) {
    return {
      headSha256,
      actions: [{
        actionId: "staging-gate-3-handoff",
        terminalRecordSha256: "1".repeat(64),
      }],
    };
  }
  function observationOpened(
    events: string[],
    snapshot = schemaSnapshot(),
    binding = observationBinding,
  ) {
    let closeCount = 0;
    return {
      get closeCount() { return closeCount; },
      snapshot,
      opened: {
        binding,
        rollout: {
          action() { throw new Error("observation must never resolve a signed action"); },
          async snapshot() {
            events.push("snapshot");
            return snapshot;
          },
          async close() {
            closeCount += 1;
            events.push("close");
          },
        },
      },
    };
  }
  function observationBasePorts(events: string[], opened: ReturnType<typeof observationOpened>) {
    return {
      async openVerifiedRollout() {
        events.push("open");
        return opened.opened;
      },
      async loadApprovedContext() {
        events.push("approved-context");
        return observationContext;
      },
      async loadCapability() {
        events.push("capability");
        return { phase3: { canaryTeamId: 2, canaryEpoch: "ifn-epoch-001" } };
      },
      async loadLeases() {
        events.push("leases");
        return leases;
      },
      now: () => Date.parse("2026-07-12T10:31:00.000Z"),
    };
  }

  {
    const approvalEvents: string[] = [];
    const approvalOpened = observationOpened(approvalEvents);
    await assert.rejects(
      () => executeInstalledStagingRolloutAction("phase3-schema-verify", {
        ...observationBasePorts(approvalEvents, approvalOpened),
        async loadApprovedContext() {
          return {
            ...observationContext,
            envelope: { approvalId: "other-phase3-approval" },
          };
        },
      }),
      /approval|identity/i,
    );
    assert.equal(approvalOpened.closeCount, 1);
  }

  const reuseEvents: string[] = [];
  const reuseOpened = observationOpened(reuseEvents);
  const reused = await executeInstalledStagingRolloutAction("phase3-schema-verify", {
    ...observationBasePorts(reuseEvents, reuseOpened),
    async readObservationMarker(
      observationId: string,
      expected: { position: string; approvalId: string },
    ) {
      reuseEvents.push(`read:${observationId}:${expected.position}`);
      assert.equal(expected.approvalId, phase3ControllerApprovalId);
      return { observationId, value: schemaMarker };
    },
    async observePhase3() { throw new Error("installed marker must skip DB observation"); },
    async writeObservationMarker() { throw new Error("installed marker must skip writing"); },
  });
  assert.deepEqual(reused, schemaResult);
  assert.equal(Object.isFrozen(reused), true);
  assert.equal(reuseOpened.closeCount, 1);
  assert.deepEqual(reuseEvents, [
    "open",
    "approved-context",
    "capability",
    "leases",
    "snapshot",
    "read:phase3-schema-verify:historical",
    "close",
  ]);

  const fenceMeasurements = {
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
  const fenceMarker = {
    ...schemaMarker,
    observationId: "phase3-fence-ack-wait",
    requiredTerminalActionId: "phase3-publication-fence",
    generation: 7,
    measurements: fenceMeasurements,
  };
  const fenceResult = {
    ...schemaResult,
    observationId: "phase3-fence-ack-wait",
    requiredTerminalActionId: "phase3-publication-fence",
    generation: 7,
    measurements: fenceMeasurements,
  };
  const fenceEvents: string[] = [];
  const fenceOpened = observationOpened(fenceEvents, {
    headSha256: "1".repeat(64),
    actions: [{
      actionId: "phase3-publication-fence",
      terminalRecordSha256: "1".repeat(64),
    }],
  });
  assert.deepEqual(
    await executeInstalledStagingRolloutAction("phase3-fence-ack-wait", {
      ...observationBasePorts(fenceEvents, fenceOpened),
      async readObservationMarker(observationId: string) {
        fenceEvents.push(`read:${observationId}`);
        return { observationId, value: fenceMarker };
      },
      async observePhase3() { throw new Error("fence winner must skip DB observation"); },
      async writeObservationMarker() { throw new Error("fence winner must skip writing"); },
    }),
    fenceResult,
  );
  assert.equal(fenceOpened.closeCount, 1);
  assert.deepEqual(fenceEvents, [
    "open",
    "approved-context",
    "capability",
    "leases",
    "snapshot",
    "read:phase3-fence-ack-wait",
    "close",
  ]);

  const writeEvents: string[] = [];
  const writeOpened = observationOpened(writeEvents);
  const written = await executeInstalledStagingRolloutAction("phase3-schema-verify", {
    ...observationBasePorts(writeEvents, writeOpened),
    async readObservationMarker(_observationId: string, expected: { position: string }) {
      writeEvents.push(`read:${expected.position}`);
      throw Object.assign(new Error("missing marker"), { code: "ENOENT" });
    },
    async observePhase3(input: { journalSnapshot: ReturnType<typeof schemaSnapshot> }) {
      writeEvents.push("observe");
      assert.strictEqual(input.journalSnapshot, writeOpened.snapshot);
      return schemaResult;
    },
    async writeObservationMarker(
      value: typeof schemaMarker,
      expected: { position: string; approvalId: string },
    ) {
      writeEvents.push(`write:${expected.position}`);
      assert.deepEqual(value, schemaMarker);
      assert.equal(expected.approvalId, phase3ControllerApprovalId);
      return { path: "/fixed/phase3-schema-verify.json", value };
    },
  });
  assert.deepEqual(written, schemaResult);
  assert.equal(writeOpened.closeCount, 1);
  assert.deepEqual(writeEvents, [
    "open",
    "approved-context",
    "capability",
    "leases",
    "snapshot",
    "read:historical",
    "observe",
    "leases",
    "write:current",
    "close",
  ]);

  const advancedEvents: string[] = [];
  const advancedOpened = observationOpened(advancedEvents, schemaSnapshot("2".repeat(64)), {
    ...observationBinding,
    actionJournalHeadSha256: "2".repeat(64),
  });
  let advancedObserved = false;
  await assert.rejects(
    () => executeInstalledStagingRolloutAction("phase3-schema-verify", {
      ...observationBasePorts(advancedEvents, advancedOpened),
      async loadApprovedContext() {
        return {
          ...observationContext,
          installedBinding: advancedOpened.opened.binding,
        };
      },
      async readObservationMarker() {
        throw Object.assign(new Error("missing marker"), { code: "ENOENT" });
      },
      async observePhase3() { advancedObserved = true; return schemaResult; },
      async writeObservationMarker() {},
    }),
    /terminal|head|observation/i,
  );
  assert.equal(advancedObserved, false);
  assert.equal(advancedOpened.closeCount, 1);

  const replacedLeaseEvents: string[] = [];
  const replacedLeaseOpened = observationOpened(replacedLeaseEvents);
  let leaseReadCount = 0;
  let replacedLeaseWrote = false;
  await assert.rejects(
    () => executeInstalledStagingRolloutAction("phase3-schema-verify", {
      ...observationBasePorts(replacedLeaseEvents, replacedLeaseOpened),
      async loadLeases() {
        leaseReadCount += 1;
        return leaseReadCount === 1
          ? leases
          : { ...leases, guard: { ...leases.guard, leaseId: "guard-replaced" } };
      },
      async readObservationMarker() {
        throw Object.assign(new Error("missing marker"), { code: "ENOENT" });
      },
      async observePhase3() { return schemaResult; },
      async writeObservationMarker() { replacedLeaseWrote = true; },
    }),
    /same|lease|instance/i,
  );
  assert.equal(replacedLeaseWrote, false);
  assert.equal(replacedLeaseOpened.closeCount, 1);

  const expiredLeaseEvents: string[] = [];
  const expiredLeaseOpened = observationOpened(expiredLeaseEvents);
  let expiredLeaseReadCount = 0;
  let expiredLeaseWrote = false;
  await assert.rejects(
    () => executeInstalledStagingRolloutAction("phase3-schema-verify", {
      ...observationBasePorts(expiredLeaseEvents, expiredLeaseOpened),
      async loadLeases() {
        expiredLeaseReadCount += 1;
        return expiredLeaseReadCount === 1
          ? leases
          : {
              ...leases,
              watchdog: { ...leases.watchdog, heartbeatAgeMs: leases.maxAgeMs + 1 },
            };
      },
      async readObservationMarker() {
        throw Object.assign(new Error("missing marker"), { code: "ENOENT" });
      },
      async observePhase3() { return schemaResult; },
      async writeObservationMarker() { expiredLeaseWrote = true; },
    }),
    /fresh|watchdog|lease/i,
  );
  assert.equal(expiredLeaseWrote, false);
  assert.equal(expiredLeaseOpened.closeCount, 1);

  const nonMissingEvents: string[] = [];
  const nonMissingOpened = observationOpened(nonMissingEvents);
  let nonMissingObserved = false;
  await assert.rejects(
    () => executeInstalledStagingRolloutAction("phase3-schema-verify", {
      ...observationBasePorts(nonMissingEvents, nonMissingOpened),
      async readObservationMarker() { throw new Error("tampered marker"); },
      async observePhase3() { nonMissingObserved = true; return schemaResult; },
      async writeObservationMarker() {},
    }),
    /tampered marker/i,
  );
  assert.equal(nonMissingObserved, false);
  assert.equal(nonMissingOpened.closeCount, 1);

  const conflictEvents: string[] = [];
  const conflictOpened = observationOpened(conflictEvents);
  await assert.rejects(
    () => executeInstalledStagingRolloutAction("phase3-schema-verify", {
      ...observationBasePorts(conflictEvents, conflictOpened),
      async readObservationMarker() {
        throw Object.assign(new Error("missing marker"), { code: "ENOENT" });
      },
      async observePhase3() { return schemaResult; },
      async writeObservationMarker() { throw new Error("create-once marker conflict"); },
    }),
    /conflict/i,
  );
  assert.equal(conflictOpened.closeCount, 1);
  const retryEvents: string[] = [];
  const retryOpened = observationOpened(retryEvents);
  assert.deepEqual(
    await executeInstalledStagingRolloutAction("phase3-schema-verify", {
      ...observationBasePorts(retryEvents, retryOpened),
      async readObservationMarker() { return { value: schemaMarker }; },
      async observePhase3() { throw new Error("retry must reuse winner"); },
      async writeObservationMarker() { throw new Error("retry must not rewrite winner"); },
    }),
    schemaResult,
  );
  assert.equal(retryOpened.closeCount, 1);
  await assert.rejects(
    () =>
      executeStagingRolloutAction({
      operation: "line-recover",
      verifiedRollout,
      leases: { ...leases, watchdog: { ...leases.watchdog, heartbeatAgeMs: 6_000 } },
      stagingRunId: leases.stagingRunId,
      }),
    /watchdog lease/i,
  );
  await assert.rejects(
    () =>
      executeStagingRolloutAction({
      operation: "line-recover",
      verifiedRollout,
      leases: { ...leases, maxAgeMs: Number.NaN },
      stagingRunId: leases.stagingRunId,
      }),
    /fresh|lease/i,
  );
  await assert.rejects(
    () =>
      executeStagingRolloutAction({
      operation: "production-stop",
      verifiedRollout,
      leases,
      stagingRunId: leases.stagingRunId,
      }),
    /staging operation/i,
  );

  console.log("A3 staging rollout controller tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
