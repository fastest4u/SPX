#!/usr/bin/env node

import { createHash } from "node:crypto";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import {
  loadInstalledApprovedStagingContext,
  openInstalledVerifiedStagingRollout,
} from "./lib/a3-staging-approved-context.mjs";
import {
  loadEmergencyStagingLeases,
  loadStagingLeases,
} from "./lib/a3-staging-leases.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_RUNTIME_SOURCE_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
  phase3PartitionIdentity,
  readPhase3ActionMeasurement,
  readPhase3ObservationMarker,
  readPhase3SemanticEvidence,
  validatePhase3PreGate4JournalSnapshot,
  writePhase3ActionJournalSnapshot,
  writePhase3ActionMeasurement,
  writePhase3ObservationMarker,
} from "./lib/phase3-staging-evidence.mjs";
import { loadInstalledStagingActionCapability } from "./lib/staging-action-capability.mjs";
import {
  buildStagingPhase3ObservationMarker,
  captureInstalledPhase3ActionMeasurement,
  executeInstalledStagingPhase3Observation,
} from "./staging-phase3-action-handler.mjs";
import { collectInstalledPhase3RuntimeSources } from "./staging-phase3-runtime-evidence.mjs";
import { produceInstalledPhase3RolloutEvidence } from "./phase3-rollout-evidence-produce.mjs";
import { producePhase3Gate4Proofs } from "./lib/staging-gate-evidence.mjs";

const OPERATIONS = Object.freeze({
  "db-bootstrap": "staging-db-bootstrap",
  "db-migrate": "staging-db-migrate",
  "db-finalize": "staging-db-finalize",
  "db-bootstrap-revoke": "staging-db-bootstrap-revoke",
  "runtime-start": "staging-runtime-start",
  "line-fault": "staging-line-fault",
  "line-recover": "staging-line-recovery",
  "ocr-fault": "staging-ocr-fault",
  "ocr-recover": "staging-ocr-recovery",
  "worker-forward": "staging-worker-forward-handoff",
  "worker-reverse": "staging-worker-reverse-handoff",
  "guard-emergency-stop": "staging-guard-emergency-stop",
  "watchdog-emergency-stop": "staging-watchdog-emergency-stop",
  "final-stop": "staging-final-stop",
  "guard-close": "guard-close",
  "phase3-consumer-start-disabled": "phase3-consumer-start-disabled",
  "phase3-legacy-lease-release": "phase3-legacy-lease-release",
  "phase3-poller-start": "phase3-poller-start",
  "phase3-publication-enable": "phase3-publication-enable",
  "phase3-execution-enable": "phase3-execution-enable",
  "phase3-publication-fence": "phase3-publication-fence",
  "phase3-drain-or-quarantine": "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore": "phase3-inline-owner-restore",
  "gate-4-phase3": "staging-gate-4-phase3",
});
const OBSERVATIONS = Object.freeze({
  "phase3-schema-verify": "staging-gate-3-handoff",
  "phase3-fence-ack-wait": "phase3-publication-fence",
});
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ZERO_HASH = "0".repeat(64);
const GATE4_PORT_NAMES = Object.freeze([
  "openVerifiedRollout",
  "loadLeases",
  "writeSnapshot",
  "collectRuntimeSources",
  "produceSemantic",
  "produceProofs",
  "now",
]);

function verifiedApprovalId(verified) {
  const approvalId = verified?.approvalId;
  if (!APPROVAL_ID.test(approvalId ?? "")) {
    throw new Error("installed verified staging approval ID is invalid");
  }
  return approvalId;
}

function contextApprovalId(context) {
  const approvalId = verifiedApprovalId(context?.verified);
  if (
    !APPROVAL_ID.test(context?.envelope?.approvalId ?? "") ||
    context.envelope.approvalId !== approvalId
  ) throw new Error("installed staging approval identity changed");
  return approvalId;
}

export function parseRolloutControllerArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) throw new Error("controller override is forbidden");
  if (!Object.hasOwn(OPERATIONS, argv[0]) && !Object.hasOwn(OBSERVATIONS, argv[0])) {
    throw new Error("unknown staging operation");
  }
  return { operation: argv[0] };
}

function assertLeases(leases, stagingRunId) {
  if (
    !leases ||
    leases.stagingRunId !== stagingRunId ||
    !leases.guard?.leaseId ||
    !leases.watchdog?.leaseId ||
    (leases.guard.state !== undefined && leases.guard.state !== "armed") ||
    (leases.watchdog.state !== undefined && leases.watchdog.state !== "armed") ||
    leases.guard.leaseId === leases.watchdog.leaseId ||
    !Number.isFinite(leases.maxAgeMs) ||
    leases.maxAgeMs <= 0 ||
    !Number.isFinite(leases.guard.heartbeatAgeMs) ||
    leases.guard.heartbeatAgeMs < 0 ||
    leases.guard.heartbeatAgeMs > leases.maxAgeMs
  )
    throw new Error("fresh guard lease is required");
  if (
    !Number.isFinite(leases.watchdog.heartbeatAgeMs) ||
    leases.watchdog.heartbeatAgeMs < 0 ||
    leases.watchdog.heartbeatAgeMs > leases.maxAgeMs
  )
    throw new Error("fresh watchdog lease is required");
}

function assertActionLeases(leases, stagingRunId, actionId) {
  if (actionId === "staging-guard-emergency-stop") {
    if (
      leases?.stagingRunId !== stagingRunId ||
      !leases.guard?.leaseId ||
      (leases.guard.state !== undefined && leases.guard.state !== "armed") ||
      leases.guard.heartbeatAgeMs > leases.maxAgeMs
    ) {
      throw new Error("fresh guard lease is required for guard emergency stop");
    }
    return;
  }
  if (actionId === "staging-watchdog-emergency-stop") {
    if (
      leases?.stagingRunId !== stagingRunId ||
      !leases.watchdog?.leaseId ||
      (leases.watchdog.state !== undefined && leases.watchdog.state !== "armed") ||
      leases.watchdog.heartbeatAgeMs > leases.maxAgeMs
    ) {
      throw new Error("fresh watchdog lease is required for watchdog emergency stop");
    }
    return;
  }
  assertLeases(leases, stagingRunId);
}

function assertSameLeaseInstance(before, after, stagingRunId) {
  assertLeases(before, stagingRunId);
  assertLeases(after, stagingRunId);
  if (
    before.guard.leaseId !== after.guard.leaseId ||
    before.watchdog.leaseId !== after.watchdog.leaseId
  ) {
    throw new Error("the same fresh staging guard/watchdog lease instance is required");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function freezeClone(value) {
  return deepFreeze(structuredClone(value));
}

function observationTerminal(snapshot, requiredTerminalActionId) {
  const matches = Array.isArray(snapshot?.actions)
    ? snapshot.actions.filter((action) => action.actionId === requiredTerminalActionId)
    : [];
  const terminal = matches.length === 1 ? matches[0] : null;
  if (
    !terminal ||
    !/^[0-9a-f]{64}$/.test(terminal.terminalRecordSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(snapshot?.headSha256 ?? "")
  ) throw new Error("authenticated observation journal terminal is invalid");
  return terminal;
}

function assertObservationContextBinding(context, binding) {
  contextApprovalId(context);
  const contextBinding = context?.installedBinding;
  for (const field of [
    "stagingRunId",
    "releaseManifestSha256",
    "stagingTargetDescriptorSha256",
    "operatorBundleSha256",
    "stagingApprovalEnvelopeSha256",
    "actionJournalHeadSha256",
  ]) {
    if (!contextBinding?.[field] || contextBinding[field] !== binding?.[field]) {
      throw new Error("installed staging observation context binding changed");
    }
  }
  if (!/^[0-9a-f]{64}$/.test(context?.verified?.rollbackReleaseManifestSha256 ?? "")) {
    throw new Error("installed staging rollback observation binding is invalid");
  }
  return { ...context, installedBinding: binding };
}

function observationExpectedContext(position, input) {
  return {
    position,
    journalSnapshot: input.journalSnapshot,
    installedBinding: input.binding,
    approvalId: contextApprovalId(input.context),
    rollbackReleaseManifestSha256: input.context.verified.rollbackReleaseManifestSha256,
    leases: input.leases,
    partition: input.partition,
    nowMs: input.nowMs,
  };
}

function projectObservationMarker(value, observationId, requiredTerminalActionId) {
  if (
    value?.observationId !== observationId ||
    value?.requiredTerminalActionId !== requiredTerminalActionId
  ) throw new Error("installed Phase 3 observation marker identity changed");
  return freezeClone({
    ok: true,
    observationId,
    requiredTerminalActionId,
    teamId: value.teamId,
    epoch: value.epoch,
    pollerNodeId: value.pollerNodeId,
    generation: value.generation,
    observedAt: value.observedAt,
    measurements: value.measurements,
  });
}

function trustedNow(now, label) {
  if (typeof now !== "function") throw new Error(`${label} clock is invalid`);
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error(`${label} clock is invalid`);
  }
  return nowMs;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactRecord(value, fields, label) {
  if (
    !isPlainObject(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())
  ) throw new Error(`${label} must be the exact complete record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (fields.some((field) =>
    !descriptors[field] ||
    !descriptors[field].enumerable ||
    !Object.hasOwn(descriptors[field], "value")
  )) throw new Error(`${label} must contain enumerable data properties`);
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeStableRecord(record, label, withPath = false) {
  assertExactRecord(
    record,
    withPath ? ["path", "value", "bytes", "sha256"] : ["value", "bytes", "sha256"],
    label,
  );
  const bytes = canonicalJson(record.value);
  if (
    (withPath && (typeof record.path !== "string" || record.path.length === 0)) ||
    typeof record.bytes !== "string" ||
    record.bytes !== bytes ||
    typeof record.sha256 !== "string" ||
    !SHA256.test(record.sha256) ||
    record.sha256 === ZERO_HASH ||
    sha256Text(record.bytes) !== record.sha256
  ) throw new Error(`${label} stable bytes or hash changed`);
  return record;
}

function validateGate4LeaseSet(leases, stagingRunId, label) {
  if (
    !leases ||
    leases.stagingRunId !== stagingRunId ||
    !Number.isFinite(leases.maxAgeMs) ||
    leases.maxAgeMs <= 0
  ) throw new Error(`${label} Gate 4 lease set is invalid`);
  for (const role of ["guard", "watchdog"]) {
    const lease = leases[role];
    const baselineIsValid = role === "guard"
      ? typeof lease?.baselineP95LatencyMs === "number" &&
        Number.isFinite(lease.baselineP95LatencyMs) &&
        lease.baselineP95LatencyMs > 0
      : lease?.baselineP95LatencyMs === null ||
        (typeof lease?.baselineP95LatencyMs === "number" &&
          Number.isFinite(lease.baselineP95LatencyMs) &&
          lease.baselineP95LatencyMs > 0);
    if (
      !lease ||
      lease.stagingRunId !== stagingRunId ||
      lease.role !== role ||
      lease.state !== "armed" ||
      typeof lease.leaseId !== "string" ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      !Number.isSafeInteger(lease.startedMonotonicMs) ||
      lease.startedMonotonicMs < 0 ||
      !Number.isSafeInteger(lease.heartbeatMonotonicMs) ||
      lease.heartbeatMonotonicMs < lease.startedMonotonicMs ||
      !Number.isFinite(lease.heartbeatAgeMs) ||
      lease.heartbeatAgeMs < 0 ||
      lease.heartbeatAgeMs > leases.maxAgeMs ||
      !baselineIsValid
    ) throw new Error(`${label} fresh ${role} Gate 4 lease is invalid`);
  }
  if (leases.guard.leaseId === leases.watchdog.leaseId) {
    throw new Error(`${label} Gate 4 lease identities must be distinct`);
  }
  return leases;
}

function validateGate4RuntimeSources(value) {
  assertExactRecord(value, PHASE3_RUNTIME_SOURCE_IDS, "Gate 4 runtime source set");
  if (canonicalJson(Object.keys(value)) !== canonicalJson(PHASE3_RUNTIME_SOURCE_IDS)) {
    throw new Error("Gate 4 runtime source order changed");
  }
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    normalizeStableRecord(value[sourceId], `Gate 4 runtime source ${sourceId}`);
  }
  return value;
}

function validateGate4SemanticResult(value, runtimeSources) {
  assertExactRecord(
    value,
    ["semantic", "semanticSha256", "sources"],
    "Gate 4 semantic producer result",
  );
  const semantic = normalizeStableRecord(value.semantic, "Gate 4 semantic source");
  if (value.semanticSha256 !== semantic.sha256) {
    throw new Error("Gate 4 semantic source hash changed after reopening");
  }
  assertExactRecord(value.sources, PHASE3_SEMANTIC_SOURCE_IDS, "Gate 4 Task 4 source hashes");
  if (canonicalJson(Object.keys(value.sources)) !== canonicalJson(PHASE3_SEMANTIC_SOURCE_IDS)) {
    throw new Error("Gate 4 Task 4 source hash order changed");
  }
  for (const sourceId of PHASE3_SEMANTIC_SOURCE_IDS) {
    if (
      typeof value.sources[sourceId] !== "string" ||
      !SHA256.test(value.sources[sourceId]) ||
      value.sources[sourceId] === ZERO_HASH
    ) throw new Error("Gate 4 Task 4 source hash is invalid");
  }
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    if (value.sources[`phase3-${sourceId}`] !== runtimeSources[sourceId].sha256) {
      throw new Error("Gate 4 runtime source changed before semantic production");
    }
  }
  return value;
}

function assertGate4LeaseHandoff(initial, current, continuityAfter, stagingRunId) {
  validateGate4LeaseSet(initial, stagingRunId, "initial");
  validateGate4LeaseSet(current, stagingRunId, "pre-consumption");
  if (!isPlainObject(continuityAfter)) {
    throw new Error("authenticated Gate 4 lease continuity is missing");
  }
  for (const role of ["guard", "watchdog"]) {
    const first = initial[role];
    const live = current[role];
    const after = continuityAfter[role];
    if (!isPlainObject(after)) throw new Error(`authenticated ${role} lease continuity is missing`);
    for (const field of ["leaseId", "pid", "startedMonotonicMs", "baselineP95LatencyMs"]) {
      if (first[field] !== after[field] || live[field] !== after[field]) {
        throw new Error(`Gate 4 ${role} lease instance changed before consumption`);
      }
    }
    if (
      after.state !== "armed" ||
      !Number.isSafeInteger(after.heartbeatMonotonicMs) ||
      live.heartbeatMonotonicMs < after.heartbeatMonotonicMs
    ) throw new Error(`Gate 4 ${role} lease heartbeat moved behind continuity`);
  }
}

async function produceFixedPhase3Semantic(input) {
  const produced = await produceInstalledPhase3RolloutEvidence(input);
  const reopened = await readPhase3SemanticEvidence();
  const semantic = normalizeStableRecord({
    value: reopened.value,
    bytes: reopened.bytes,
    sha256: reopened.sha256,
  }, "reopened fixed Phase 3 semantic source");
  if (
    produced?.sha256 !== semantic.sha256 ||
    produced?.bytes !== semantic.bytes ||
    canonicalJson(produced?.evidence) !== canonicalJson(semantic.value)
  ) throw new Error("fixed Phase 3 semantic source changed after production");
  return {
    semantic,
    semanticSha256: produced.sha256,
    sources: produced.sources,
  };
}

function fixedGate4Ports(callerArguments) {
  if (callerArguments.length === 0) {
    return Object.freeze({
      openVerifiedRollout: async () => {
        const rollout = await openInstalledVerifiedStagingRollout();
        return { binding: rollout.binding, verified: rollout.verified, rollout };
      },
      loadLeases: (stagingRunId) => loadStagingLeases(stagingRunId),
      writeSnapshot: (value) => writePhase3ActionJournalSnapshot(value),
      collectRuntimeSources: (input) => collectInstalledPhase3RuntimeSources(input),
      produceSemantic: produceFixedPhase3Semantic,
      produceProofs: (input) => producePhase3Gate4Proofs(input),
      now: Date.now,
    });
  }
  if (process.env.NODE_ENV !== "test" || callerArguments.length !== 1) {
    throw new Error("caller-selected Gate 4 controller ports are forbidden");
  }
  const ports = callerArguments[0];
  assertExactRecord(ports, GATE4_PORT_NAMES, "Gate 4 controller ports");
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  if (GATE4_PORT_NAMES.some((name) => typeof descriptors[name].value !== "function")) {
    throw new Error("Gate 4 controller ports must be complete functions");
  }
  return Object.freeze(Object.fromEntries(
    GATE4_PORT_NAMES.map((name) => [name, descriptors[name].value]),
  ));
}

function phase3ActionExpectedContext(position, input) {
  return {
    position,
    journalSnapshot: input.journalSnapshot,
    installedBinding: input.binding,
    approvalId: input.approvalId,
    rollbackReleaseManifestSha256: input.rollbackReleaseManifestSha256,
    leases: input.leases,
    partition: input.partition,
    nowMs: input.nowMs,
  };
}

function uniquePhase3Action(snapshot, actionId) {
  const matches = Array.isArray(snapshot?.actions)
    ? snapshot.actions.filter((entry) => entry?.actionId === actionId)
    : [];
  if (matches.length !== 1) {
    throw new Error("authenticated Phase 3 journal action is missing or duplicated");
  }
  return matches[0];
}

function assertRegisteredPhase3Action(action) {
  if (
    action.kind !== "forward" ||
    action.state !== "registered" ||
    action.occurrences !== 0 ||
    action.terminalRecordSha256 !== null ||
    action.completedAt !== null ||
    action.reconciliationId !== null ||
    action.reconciliationOutcome !== null ||
    !/^[0-9a-f]{64}$/.test(action.mutationSha256 ?? "")
  ) throw new Error("Phase 3 action is not an ordinary registered journal entry");
  return action;
}

function assertOrdinarySucceededPhase3Action(action, snapshot) {
  if (
    action.kind !== "forward" ||
    action.state !== "succeeded" ||
    action.occurrences !== 1 ||
    action.reconciliationId !== null ||
    action.reconciliationOutcome !== null ||
    !/^[0-9a-f]{64}$/.test(action.mutationSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(action.terminalRecordSha256 ?? "") ||
    typeof action.completedAt !== "string" ||
    action.terminalRecordSha256 !== snapshot?.headSha256
  ) throw new Error("Phase 3 action is not the current ordinary succeeded terminal");
  return action;
}

function assertPhase3JournalTransition(before, after, actionId) {
  const registered = assertRegisteredPhase3Action(uniquePhase3Action(before, actionId));
  const succeeded = assertOrdinarySucceededPhase3Action(
    uniquePhase3Action(after, actionId),
    after,
  );
  if (
    !Array.isArray(before.actions) ||
    !Array.isArray(after.actions) ||
    before.actions.length !== after.actions.length ||
    !Number.isSafeInteger(before.recordCount) ||
    !Number.isSafeInteger(after.recordCount) ||
    after.recordCount !== before.recordCount + 1 ||
    canonicalJson(before.binding) !== canonicalJson(after.binding) ||
    registered.sequence !== succeeded.sequence ||
    registered.scope !== succeeded.scope ||
    registered.kind !== succeeded.kind ||
    registered.mutationSha256 !== succeeded.mutationSha256
  ) throw new Error("Phase 3 action journal transition changed outside its terminal");
  for (const beforeEntry of before.actions) {
    if (beforeEntry.actionId === actionId) continue;
    const afterEntry = uniquePhase3Action(after, beforeEntry.actionId);
    if (canonicalJson(beforeEntry) !== canonicalJson(afterEntry)) {
      throw new Error("Phase 3 action journal changed an unrelated action");
    }
  }
  return succeeded;
}

const IMMUTABLE_PHASE3_RELEASE_FIELDS = Object.freeze([
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "environment",
  "topology",
  "composeProject",
  "stagingTargetDescriptorSha256",
  "operatorBundleSha256",
  "stagingApprovalEnvelopeSha256",
  "stagingRunId",
]);

function assertReloadedPhase3Context(opened, context, journalSnapshot) {
  const initialApprovalId = verifiedApprovalId(opened?.verified);
  if (contextApprovalId(context) !== initialApprovalId) {
    throw new Error("installed Phase 3 approval identity changed");
  }
  const reloaded = context?.installedBinding;
  for (const field of IMMUTABLE_PHASE3_RELEASE_FIELDS) {
    if (!opened.binding?.[field] || reloaded?.[field] !== opened.binding[field]) {
      throw new Error("installed Phase 3 immutable release binding changed");
    }
  }
  if (
    reloaded.actionJournalHeadSha256 !== journalSnapshot?.headSha256 ||
    !/^[0-9a-f]{64}$/.test(opened?.verified?.rollbackReleaseManifestSha256 ?? "") ||
    context?.verified?.rollbackReleaseManifestSha256 !==
      opened.verified.rollbackReleaseManifestSha256
  ) throw new Error("installed Phase 3 journal head or rollback release binding changed");
  return context;
}

function assertReadPhase3ActionMarker(result, actionId) {
  if (
    result?.value?.actionId !== actionId ||
    !/^[0-9a-f]{64}$/.test(result?.sha256 ?? "")
  ) throw new Error("installed Phase 3 action marker result is invalid");
  return result;
}

export async function executeStagingRolloutAction(input) {
  const actionId = OPERATIONS[input?.operation];
  if (!actionId) throw new Error("unknown staging operation");
  assertActionLeases(input.leases, input.stagingRunId, actionId);
  if (!input.verifiedRollout || typeof input.verifiedRollout.action !== "function")
    throw new Error("verified staging rollout is required");
  const context = input.verifiedRollout.action(actionId);
  if (!context || typeof context.run !== "function")
    throw new Error("verified action context is required");
  await context.run();
  return { ok: true, actionId };
}

export async function executeInstalledStagingRolloutAction(operation, ...callerArguments) {
  const gate4 = operation === "gate-4-phase3";
  if (!gate4 && callerArguments.length > 1) {
    throw new Error("staging rollout controller accepts at most one test port record");
  }
  const ports = gate4 ? fixedGate4Ports(callerArguments) : (callerArguments[0] ?? {});
  const loadLeases =
    ports.loadLeases ??
    ((stagingRunId, requestedOperation) => {
      if (requestedOperation === "guard-emergency-stop") {
        return loadEmergencyStagingLeases(stagingRunId, "guard");
      }
      if (requestedOperation === "watchdog-emergency-stop") {
        return loadEmergencyStagingLeases(stagingRunId, "watchdog");
      }
      return loadStagingLeases(stagingRunId);
    });
  const openVerifiedRollout =
    ports.openVerifiedRollout ??
    (async () => {
      const rollout = await openInstalledVerifiedStagingRollout();
      return { binding: rollout.binding, verified: rollout.verified, rollout };
    });
  const opened = await openVerifiedRollout();
  if (!opened?.rollout || typeof opened.rollout.close !== "function") {
    throw new Error("installed verified staging rollout is invalid");
  }
  try {
    if (!opened?.binding?.stagingRunId) {
      throw new Error("installed verified staging rollout is invalid");
    }
    if (gate4) {
      if (typeof opened.rollout.snapshot !== "function") {
        throw new Error("installed Gate 4 rollout snapshot is required");
      }
      const initialLeases = freezeClone(
        validateGate4LeaseSet(
          await loadLeases(opened.binding.stagingRunId, operation),
          opened.binding.stagingRunId,
          "initial",
        ),
      );
      const snapshot = freezeClone(await opened.rollout.snapshot());
      validatePhase3PreGate4JournalSnapshot(snapshot, {
        installedBinding: opened.binding,
        approvalId: verifiedApprovalId(opened.verified),
      });
      const writtenSnapshot = normalizeStableRecord(
        await ports.writeSnapshot(snapshot),
        "persisted pre-consumption Gate 4 journal snapshot",
        true,
      );
      if (writtenSnapshot.bytes !== canonicalJson(snapshot)) {
        throw new Error("persisted Gate 4 snapshot bytes changed");
      }
      const runtimeSources = validateGate4RuntimeSources(
        await ports.collectRuntimeSources({
          journalSnapshot: snapshot,
          leases: initialLeases,
        }),
      );
      const semantic = validateGate4SemanticResult(
        await ports.produceSemantic({ journalSnapshot: snapshot }),
        runtimeSources,
      );
      const capturedAt = new Date(trustedNow(ports.now, "trusted Gate 4 evidence")).toISOString();
      await ports.produceProofs({
        semantic: semantic.semantic,
        semanticSha256: semantic.semanticSha256,
        sources: semantic.sources,
        binding: opened.binding,
        capturedAt,
      });
      const beforeConsumption = freezeClone(
        await loadLeases(opened.binding.stagingRunId, operation),
      );
      assertGate4LeaseHandoff(
        initialLeases,
        beforeConsumption,
        runtimeSources["lease-continuity"].value?.continuity?.after,
        opened.binding.stagingRunId,
      );
      const context = opened.rollout.action("staging-gate-4-phase3");
      if (!context || typeof context.run !== "function") {
        throw new Error("verified Gate 4 action context is required");
      }
      await context.run();
      return { ok: true, actionId: "staging-gate-4-phase3" };
    }
    const phase3ActionId = OPERATIONS[operation];
    if (PHASE3_ACTION_IDS.includes(phase3ActionId)) {
      if (typeof opened.rollout.snapshot !== "function") {
        throw new Error("installed verified staging rollout snapshot is required");
      }
      const initialSnapshot = await opened.rollout.snapshot();
      const initialApprovalId = verifiedApprovalId(opened.verified);
      const loadCapability = ports.loadCapability ?? loadInstalledStagingActionCapability;
      const capability = await loadCapability(opened.binding);
      const partition = phase3PartitionIdentity(
        capability?.phase3?.canaryTeamId,
        capability?.phase3?.canaryEpoch,
      );
      const initialLeases = await loadLeases(opened.binding.stagingRunId, operation);
      assertLeases(initialLeases, opened.binding.stagingRunId);
      const now = ports.now ?? Date.now;
      const rollbackReleaseManifestSha256 = opened?.verified?.rollbackReleaseManifestSha256;
      if (!/^[0-9a-f]{64}$/.test(rollbackReleaseManifestSha256 ?? "")) {
        throw new Error("installed Phase 3 rollback release binding is invalid");
      }
      const readActionMarkerPort = ports.readActionMarker ?? readPhase3ActionMeasurement;
      const writeActionMarkerPort = ports.writeActionMarker ?? writePhase3ActionMeasurement;
      const captureActionMeasurement =
        ports.captureActionMeasurement ?? captureInstalledPhase3ActionMeasurement;
      const historicalExpected = phase3ActionExpectedContext("historical", {
        journalSnapshot: initialSnapshot,
        binding: opened.binding,
        approvalId: initialApprovalId,
        rollbackReleaseManifestSha256,
        leases: initialLeases,
        partition,
        nowMs: trustedNow(now, "trusted staging Phase 3 action measurement"),
      });
      const actionIndex = PHASE3_ACTION_IDS.indexOf(phase3ActionId);
      for (const predecessorActionId of PHASE3_ACTION_IDS.slice(0, actionIndex)) {
        assertReadPhase3ActionMarker(
          await readActionMarkerPort(predecessorActionId, historicalExpected),
          predecessorActionId,
        );
      }
      const currentEntry = uniquePhase3Action(initialSnapshot, phase3ActionId);
      let journalSnapshot = initialSnapshot;
      let binding = opened.binding;
      let approvalId = initialApprovalId;
      let currentRollbackReleaseManifestSha256 = rollbackReleaseManifestSha256;
      if (currentEntry.state === "registered") {
        assertRegisteredPhase3Action(currentEntry);
        const context = opened.rollout.action(phase3ActionId);
        if (!context || typeof context.run !== "function") {
          throw new Error("verified Phase 3 action context is required");
        }
        await context.run();
        journalSnapshot = await opened.rollout.snapshot();
        assertPhase3JournalTransition(initialSnapshot, journalSnapshot, phase3ActionId);
        const loadApprovedContext = ports.loadApprovedContext ?? loadInstalledApprovedStagingContext;
        const reloaded = assertReloadedPhase3Context(
          opened,
          await loadApprovedContext(),
          journalSnapshot,
        );
        binding = reloaded.installedBinding;
        approvalId = contextApprovalId(reloaded);
        currentRollbackReleaseManifestSha256 =
          reloaded.verified.rollbackReleaseManifestSha256;
      } else if (currentEntry.state === "succeeded") {
        assertOrdinarySucceededPhase3Action(currentEntry, initialSnapshot);
        let installed;
        try {
          installed = assertReadPhase3ActionMarker(
            await readActionMarkerPort(phase3ActionId, historicalExpected),
            phase3ActionId,
          );
        } catch (error) {
          if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
        }
        if (installed) {
          const afterReadLeases = await loadLeases(opened.binding.stagingRunId, operation);
          assertSameLeaseInstance(initialLeases, afterReadLeases, opened.binding.stagingRunId);
          return { ok: true, actionId: phase3ActionId, markerSha256: installed.sha256 };
        }
      } else {
        throw new Error("Phase 3 action state cannot be executed or recovered");
      }

      const beforeCaptureLeases = await loadLeases(binding.stagingRunId, operation);
      assertSameLeaseInstance(initialLeases, beforeCaptureLeases, binding.stagingRunId);
      const marker = await captureActionMeasurement({
        actionId: phase3ActionId,
        journalSnapshot,
        leases: beforeCaptureLeases,
      });
      if (marker?.actionId !== phase3ActionId) {
        throw new Error("captured Phase 3 action marker identity changed");
      }
      const afterCaptureLeases = await loadLeases(binding.stagingRunId, operation);
      assertSameLeaseInstance(beforeCaptureLeases, afterCaptureLeases, binding.stagingRunId);
      const written = await writeActionMarkerPort(
        marker,
        phase3ActionExpectedContext("current", {
          journalSnapshot,
          binding,
          approvalId,
          rollbackReleaseManifestSha256: currentRollbackReleaseManifestSha256,
          leases: afterCaptureLeases,
          partition,
          nowMs: trustedNow(now, "trusted staging Phase 3 action measurement"),
        }),
      );
      if (!/^[0-9a-f]{64}$/.test(written?.sha256 ?? "")) {
        throw new Error("written Phase 3 action marker hash is invalid");
      }
      return { ok: true, actionId: phase3ActionId, markerSha256: written.sha256 };
    }
    const requiredTerminalActionId = OBSERVATIONS[operation];
    if (requiredTerminalActionId) {
      if (typeof opened.rollout.snapshot !== "function") {
        throw new Error("installed verified staging rollout snapshot is required");
      }
      const loadApprovedContext =
        ports.loadApprovedContext ?? loadInstalledApprovedStagingContext;
      const loadCapability =
        ports.loadCapability ?? loadInstalledStagingActionCapability;
      const observePhase3 =
        ports.observePhase3 ?? executeInstalledStagingPhase3Observation;
      const readObservationMarkerPort =
        ports.readObservationMarker ?? readPhase3ObservationMarker;
      const writeObservationMarkerPort =
        ports.writeObservationMarker ?? writePhase3ObservationMarker;
      const now = ports.now ?? Date.now;
      if (typeof now !== "function") {
        throw new Error("trusted staging observation clock is invalid");
      }
      const context = assertObservationContextBinding(
        await loadApprovedContext(),
        opened.binding,
      );
      const capability = await loadCapability(opened.binding);
      const phase3 = capability?.phase3;
      const partition = phase3PartitionIdentity(phase3?.canaryTeamId, phase3?.canaryEpoch);
      const before = await loadLeases(opened.binding.stagingRunId, operation);
      assertLeases(before, opened.binding.stagingRunId);
      const journalSnapshot = await opened.rollout.snapshot();
      const readNowMs = now();
      if (!Number.isSafeInteger(readNowMs) || readNowMs < 0) {
        throw new Error("trusted staging observation clock is invalid");
      }
      const historicalExpected = observationExpectedContext("historical", {
        journalSnapshot,
        binding: opened.binding,
        context,
        leases: before,
        partition,
        nowMs: readNowMs,
      });
      let installed;
      try {
        installed = await readObservationMarkerPort(
          operation,
          historicalExpected,
        );
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
      }
      if (installed) {
        return projectObservationMarker(
          installed.value,
          operation,
          requiredTerminalActionId,
        );
      }

      const terminal = observationTerminal(journalSnapshot, requiredTerminalActionId);
      if (terminal.terminalRecordSha256 !== journalSnapshot.headSha256) {
        throw new Error("missing Phase 3 observation is no longer at its fixed journal terminal");
      }
      const observed = await observePhase3({
        observationId: operation,
        requiredTerminalActionId,
        context,
        capability,
        leases: before,
        journalSnapshot,
      });
      const after = await loadLeases(opened.binding.stagingRunId, operation);
      assertSameLeaseInstance(before, after, opened.binding.stagingRunId);
      const marker = buildStagingPhase3ObservationMarker({
        observationId: operation,
        requiredTerminalActionId,
        context,
        capability,
        leases: after,
        journalSnapshot,
        observed,
      });
      const writeNowMs = now();
      if (!Number.isSafeInteger(writeNowMs) || writeNowMs < 0) {
        throw new Error("trusted staging observation clock is invalid");
      }
      await writeObservationMarkerPort(
        marker,
        observationExpectedContext("current", {
          journalSnapshot,
          binding: opened.binding,
          context,
          leases: after,
          partition,
          nowMs: writeNowMs,
        }),
      );
      return projectObservationMarker(marker, operation, requiredTerminalActionId);
    }
    const leases = await loadLeases(opened.binding.stagingRunId, operation);
    return await executeStagingRolloutAction({
      operation,
      verifiedRollout: opened.rollout,
      leases,
      stagingRunId: opened.binding.stagingRunId,
    });
  } finally {
    await opened.rollout.close();
  }
}

async function main() {
  try {
    const { operation } = parseRolloutControllerArgs(process.argv.slice(2));
    const result = await executeInstalledStagingRolloutAction(operation);
    console.log(canonicalJson(result));
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["STAGING_ROLLOUT_ACTION_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("a3-staging-rollout-controller.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
