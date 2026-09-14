#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { collectInstalledPhase3CapacityEvidence } from "./a3-capacity-check.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases, monotonicNowMs } from "./lib/a3-staging-leases.mjs";
import { canonicalJson, validateReleaseBinding } from "./lib/evidence-artifact.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_RUNTIME_SOURCE_IDS,
  phase3PartitionIdentity,
  recoverPhase3CapacityObservationCheckpointStorage,
  recoverPhase3RuntimeSourceStorage,
  readPhase3ActionMeasurements,
  readPhase3CapacityObservationCheckpoint,
  readPhase3ObservationMarkers,
  readPhase3RuntimeSource,
  readPhase3RuntimeSources,
  validatePhase3ActionMeasurement,
  validatePhase3ObservationMarker,
  writePhase3CapacityObservationCheckpoint,
  writePhase3RuntimeSource,
} from "./lib/phase3-staging-evidence.mjs";
import {
  loadInstalledStagingActionCapability,
  loadStagingDatabaseCredential,
  validateStagingActionCapability,
} from "./lib/staging-action-capability.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "./lib/staging-action-plan.mjs";
import {
  buildStagingPhase3DatabaseTransport,
  buildStagingPhase3EvidencePayload,
} from "./staging-phase3-action-handler.mjs";

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const MAX_LEASE_AGE_MS = 10_000;
const MAX_DOCKER_BYTES = 256 * 1024;
const DOCKER_TIMEOUT_MS = 30_000;
const DATABASE_TIMEOUT_MS = 120_000;
const ZERO_HASH = "0".repeat(64);
const OBSERVATION_KEYS = Object.freeze(["schema", "fence"]);
const COMMON_CONTEXT_FIELDS = Object.freeze([
  "stagingRunId",
  "actionJournalHeadSha256",
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "rollbackReleaseManifestSha256",
  "stagingTargetDescriptorSha256",
  "operatorBundleSha256",
  "stagingApprovalEnvelopeSha256",
  "teamId",
  "epoch",
  "generation",
  "windowStartedAt",
  "windowEndedAt",
  "guardLeaseId",
  "watchdogLeaseId",
]);
const INPUT_FIELDS = Object.freeze(["journalSnapshot", "leases"]);
const TEST_PORT_NAMES = Object.freeze([
  "loadContext",
  "loadCapability",
  "loadObserverDatabase",
  "loadLeases",
  "readActionMeasurements",
  "readObservationMarkers",
  "assertLocalDocker",
  "listFixedServiceContainerIds",
  "inspectFixedContainer",
  "runDatabaseEvidence",
  "collectCapacityEvidence",
  "recoverRuntimeSources",
  "recoverCapacityCheckpoint",
  "readCapacityCheckpoint",
  "writeCapacityCheckpoint",
  "readSource",
  "writeSource",
  "readSources",
]);
const SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion", "binding", "recordCount", "headSha256", "actions",
]);
const SNAPSHOT_BINDING_FIELDS = Object.freeze([
  "approvalId", "stagingRunId", "approvalEnvelopeSha256",
  "targetDescriptorSha256", "operatorBundleSha256",
]);
const SNAPSHOT_ACTION_FIELDS = Object.freeze([
  "sequence", "actionId", "scope", "kind", "mutationSha256", "state",
  "occurrences", "terminalRecordSha256", "completedAt", "reconciliationId",
  "reconciliationOutcome",
]);
const LEASE_FIELDS = Object.freeze(["stagingRunId", "guard", "watchdog", "maxAgeMs"]);
const LEASE_ENTRY_FIELDS = Object.freeze([
  "schemaVersion", "role", "state", "breachCount", "baselineP95LatencyMs",
  "leaseId", "stagingRunId", "pid", "startedMonotonicMs",
  "heartbeatMonotonicMs", "heartbeatAgeMs",
]);
const DB_FIELDS = Object.freeze([
  "ok", "evidenceId", "control", "drain", "duplicates", "staleEpochActions",
  "directPollerAccepts", "inlineLease",
]);
const CAPACITY_FAILURE_ORDER = Object.freeze([
  "PRODUCTION_NOT_READY",
  "A3_CPU_BUDGET_EXCEEDED",
  "A3_MEMORY_HEADROOM_LOW",
  "A3_DISK_HEADROOM_LOW",
  "A3_INODE_HEADROOM_LOW",
  "A3_PID_HEADROOM_LOW",
  "A3_NETWORK_RX_BUDGET_EXCEEDED",
  "A3_NETWORK_TX_BUDGET_EXCEEDED",
  "A3_NETWORK_HEADROOM_LOW",
  "MYSQL_CONNECTION_HEADROOM_LOW",
  "MYSQL_CONNECTION_PERCENT_HEADROOM_LOW",
  "PRODUCTION_LATENCY_BUDGET_EXCEEDED",
  "PRODUCTION_LATENCY_INCREASE_EXCEEDED",
]);
const FIXED_CAPACITY_THRESHOLDS = Object.freeze({
  minDiskFreeBytes: 10_000_000_000,
  minInodeFreePercent: 20,
  minPidFree: 1_000,
  maxNetworkRxUtilizationPercent: 70,
  maxNetworkTxUtilizationPercent: 70,
  minNetworkHeadroomMbps: 100,
  minMysqlConnectionHeadroomPercent: 30,
});
const GATE3_PLAN_ENTRY = REQUIRED_STAGING_ACTION_PLAN.find(
  (entry) => entry.actionId === "staging-gate-3-handoff",
);
const INLINE_RESTORE_PLAN_ENTRY = REQUIRED_STAGING_ACTION_PLAN.find(
  (entry) => entry.actionId === "phase3-inline-owner-restore",
);
if (!GATE3_PLAN_ENTRY || !INLINE_RESTORE_PLAN_ENTRY) {
  throw new Error("required staging action plan is missing the Phase 3 boundary");
}
const EXPECTED_PHASE3_SNAPSHOT_RECORD_COUNT =
  REQUIRED_STAGING_ACTION_PLAN.length + 2 * INLINE_RESTORE_PLAN_ENTRY.sequence;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function freezeClone(value) {
  return deepFreeze(structuredClone(value));
}

function collectionFailure() {
  return new Error("installed Phase 3 runtime evidence collection failed");
}

function assertExactDataRecord(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain record`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) throw new Error(`${label} has an invalid or unknown field`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) throw new Error(`${label} fields must be enumerable data properties`);
  }
  return value;
}

function assertStrictJson(value, label, seen = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw new Error(`${label} is not strict acyclic JSON`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`${label} contains an invalid array prototype`);
    }
    const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) throw new Error(`${label} contains a sparse or extended array`);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error(`${label} array items must be enumerable data properties`);
      }
      assertStrictJson(descriptor.value, `${label}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw new Error(`${label} contains a non-plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) throw new Error(`${label} object fields must be enumerable data properties`);
    assertStrictJson(descriptor.value, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value) || value === ZERO_HASH) {
    throw new Error(`${label} is not a concrete SHA-256 hash`);
  }
}

function assertCommit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value) || /^0+$/.test(value)) {
    throw new Error(`${label} is not a concrete commit SHA`);
  }
}

function assertImage(value, label) {
  if (typeof value !== "string" || !IMAGE.test(value) || value === `sha256:${ZERO_HASH}`) {
    throw new Error(`${label} is not a concrete image digest`);
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID.test(value) || /(?:TODO|TBD|UNKNOWN|<[^>]+>)/i.test(value)) {
    throw new Error(`${label} is not a concrete identifier`);
  }
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertFinite(value, label, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} must be finite and at least ${minimum}`);
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return milliseconds;
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ownDataValue(value, field, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain record`);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new Error(`${label}.${field} must be an enumerable data property`);
  }
  return descriptor.value;
}

function assertInvocation(input, callerArguments) {
  assertExactDataRecord(input, INPUT_FIELDS, "Phase 3 runtime evidence input");
  assertStrictJson(input, "Phase 3 runtime evidence input");
  if (callerArguments.length === 0) return null;
  if (process.env.NODE_ENV !== "test" || callerArguments.length !== 1) {
    throw new Error("collectInstalledPhase3RuntimeSources accepts one argument in production");
  }
  const ports = callerArguments[0];
  assertExactDataRecord(ports, TEST_PORT_NAMES, "test-only Phase 3 runtime evidence ports");
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  if (TEST_PORT_NAMES.some((name) => typeof descriptors[name].value !== "function")) {
    throw new Error("test-only Phase 3 runtime evidence ports must be complete functions");
  }
  return Object.freeze(Object.fromEntries(TEST_PORT_NAMES.map((name) => [name, descriptors[name].value])));
}

function validateLoadedContext(value) {
  assertExactDataRecord(
    value,
    ["installedBinding", "envelope", "artifacts", "verified", "descriptor"],
    "installed approved staging context",
  );
  const bindingValue = ownDataValue(value, "installedBinding", "installed approved staging context");
  assertStrictJson(bindingValue, "installed release binding");
  validateReleaseBinding(bindingValue);
  if (bindingValue.environment !== "staging" || bindingValue.composeProject !== "spx-staging") {
    throw new Error("installed release binding is not the fixed staging target");
  }
  const verified = ownDataValue(value, "verified", "installed approved staging context");
  const verifiedApprovalId = ownDataValue(verified, "approvalId", "verified staging context");
  const rollback = ownDataValue(verified, "rollbackReleaseManifestSha256", "verified staging context");
  assertHash(rollback, "rollback release manifest hash");
  const envelope = ownDataValue(value, "envelope", "installed approved staging context");
  const envelopeApprovalId = ownDataValue(envelope, "approvalId", "staging approval envelope");
  assertId(verifiedApprovalId, "verified approval ID");
  assertId(envelopeApprovalId, "envelope approval ID");
  if (verifiedApprovalId !== envelopeApprovalId) {
    throw new Error("verified staging approval identity changed");
  }
  const policy = ownDataValue(envelope, "policy", "staging approval envelope");
  const thresholds = ownDataValue(policy, "thresholds", "staging approval policy");
  const thresholdFields = [
    "maxCpuPercent", "minMemoryFreeBytes", "minMysqlConnectionsFree",
    "productionP95LatencyMs", "maxLatencyIncreasePercent",
  ];
  for (const field of thresholdFields) {
    assertFinite(ownDataValue(thresholds, field, "approved capacity thresholds"), `approved ${field}`);
  }
  const descriptor = ownDataValue(value, "descriptor", "installed approved staging context");
  if (
    ownDataValue(descriptor, "releaseEnvironment", "staging target descriptor") !== "staging" ||
    ownDataValue(descriptor, "runtimeEnvironment", "staging target descriptor") !== "staging" ||
    ownDataValue(descriptor, "composeProject", "staging target descriptor") !== "spx-staging"
  ) throw new Error("installed staging target descriptor identity changed");
  const target = ownDataValue(descriptor, "target", "staging target descriptor");
  const productionPolicySha256 = ownDataValue(
    target,
    "productionObserverPolicySha256",
    "staging target descriptor target",
  );
  assertHash(productionPolicySha256, "production observer policy hash");
  return freezeClone({
    binding: bindingValue,
    approvalId: verifiedApprovalId,
    rollbackReleaseManifestSha256: rollback,
    approvedThresholds: Object.fromEntries(thresholdFields.map((field) => [field, thresholds[field]])),
    productionObserverPolicySha256: productionPolicySha256,
  });
}

function validateCapability(value, bindingValue) {
  assertStrictJson(value, "installed Phase 3 capability");
  validateStagingActionCapability(value, bindingValue);
  return freezeClone(value);
}

function validateSnapshot(value, bindingValue, approvalId) {
  assertExactDataRecord(value, SNAPSHOT_FIELDS, "action journal snapshot");
  if (value.schemaVersion !== 1) throw new Error("action journal snapshot schema changed");
  assertExactDataRecord(value.binding, SNAPSHOT_BINDING_FIELDS, "action journal snapshot binding");
  assertId(value.binding.approvalId, "snapshot approval ID");
  if (
    value.binding.approvalId !== approvalId ||
    value.binding.stagingRunId !== bindingValue.stagingRunId ||
    value.binding.approvalEnvelopeSha256 !== bindingValue.stagingApprovalEnvelopeSha256 ||
    value.binding.targetDescriptorSha256 !== bindingValue.stagingTargetDescriptorSha256 ||
    value.binding.operatorBundleSha256 !== bindingValue.operatorBundleSha256
  ) throw new Error("action journal snapshot binding changed");
  assertPositiveInteger(value.recordCount, "action journal record count");
  assertHash(value.headSha256, "action journal head");
  if (
    value.headSha256 !== bindingValue.actionJournalHeadSha256 ||
    !Array.isArray(value.actions) ||
    value.actions.length !== REQUIRED_STAGING_ACTION_PLAN.length ||
    value.recordCount !== EXPECTED_PHASE3_SNAPSHOT_RECORD_COUNT
  ) throw new Error("action journal snapshot head or action set is invalid");
  const byId = new Map();
  const terminalHashes = new Set();
  const terminalTimes = new Map();
  for (const [index, action] of value.actions.entries()) {
    const planned = REQUIRED_STAGING_ACTION_PLAN[index];
    assertExactDataRecord(action, SNAPSHOT_ACTION_FIELDS, "action journal action");
    assertId(action.actionId, "action journal action ID");
    assertId(action.scope, "action journal action scope");
    assertHash(action.mutationSha256, "action journal mutation hash");
    if (!canonicalEqual(
      {
        sequence: action.sequence,
        actionId: action.actionId,
        scope: action.scope,
        kind: action.kind,
        mutationSha256: action.mutationSha256,
      },
      planned,
    )) throw new Error("action journal action does not match the fixed staging plan");
    if (byId.has(action.actionId)) throw new Error("action journal contains a duplicate action");
    byId.set(action.actionId, action);
    if (action.sequence <= INLINE_RESTORE_PLAN_ENTRY.sequence) {
      if (
        action.kind !== "forward" ||
        action.state !== "succeeded" ||
        action.occurrences !== 1 ||
        action.reconciliationId !== null ||
        action.reconciliationOutcome !== null
      ) throw new Error("action journal contains a nonordinary Phase 3 prefix terminal");
      assertHash(action.terminalRecordSha256, "action journal terminal hash");
      if (terminalHashes.has(action.terminalRecordSha256)) {
        throw new Error("action journal contains a duplicate terminal hash");
      }
      terminalHashes.add(action.terminalRecordSha256);
      terminalTimes.set(
        action.actionId,
        canonicalTimestamp(action.completedAt, "action journal completion time"),
      );
    } else if (
      action.state !== "registered" ||
      action.occurrences !== 0 ||
      action.terminalRecordSha256 !== null ||
      action.completedAt !== null ||
      action.reconciliationId !== null ||
      action.reconciliationOutcome !== null
    ) {
      throw new Error("action journal post-Phase 3 action is not an untouched registration");
    }
  }
  const gate3 = byId.get(GATE3_PLAN_ENTRY.actionId);
  const final = byId.get(INLINE_RESTORE_PLAN_ENTRY.actionId);
  if (
    !gate3 ||
    !final ||
    gate3.sequence !== GATE3_PLAN_ENTRY.sequence ||
    final.sequence !== INLINE_RESTORE_PLAN_ENTRY.sequence ||
    final.terminalRecordSha256 !== value.headSha256 ||
    [...terminalHashes].filter((terminalHash) => terminalHash === value.headSha256).length !== 1
  ) {
    throw new Error("action journal final inline restore is not the exact head");
  }
  let previousSequence = gate3.sequence;
  for (const actionId of PHASE3_ACTION_IDS) {
    const action = byId.get(actionId);
    if (!action || action.sequence <= previousSequence) {
      throw new Error("Phase 3 actions are missing or outside canonical order");
    }
    previousSequence = action.sequence;
  }
  const windowStartedAt = canonicalTimestamp(gate3.completedAt, "Gate 3 completion time");
  const windowEndedAt = canonicalTimestamp(final.completedAt, "inline restore completion time");
  if (windowStartedAt >= windowEndedAt) throw new Error("Phase 3 evidence window is not ordered");
  for (const [actionId, actionCompletedAt] of terminalTimes) {
    if (actionId !== final.actionId && actionCompletedAt > windowEndedAt) {
      throw new Error("action journal contains a terminal after inline restore");
    }
  }
  for (const actionId of PHASE3_ACTION_IDS) {
    const actionCompletedAt = canonicalTimestamp(
      byId.get(actionId).completedAt,
      `${actionId} completion time`,
    );
    if (actionCompletedAt <= windowStartedAt || actionCompletedAt > windowEndedAt) {
      throw new Error("Phase 3 action completion is outside the exact evidence window");
    }
  }
  return { gate3, final, byId, windowStartedAt, windowEndedAt };
}

function validateLeaseEntry(value, role, stagingRunId, trustedMonotonicMs, label) {
  assertExactDataRecord(value, LEASE_ENTRY_FIELDS, `${label} ${role} lease`);
  if (
    value.schemaVersion !== 1 ||
    value.role !== role ||
    value.state !== "armed" ||
    value.breachCount !== 0 ||
    value.stagingRunId !== stagingRunId
  ) throw new Error(`${label} ${role} lease is not continuously armed`);
  assertId(value.leaseId, `${label} ${role} lease ID`);
  assertPositiveInteger(value.pid, `${label} ${role} PID`);
  assertNonnegativeInteger(value.startedMonotonicMs, `${label} ${role} start time`);
  assertNonnegativeInteger(value.heartbeatMonotonicMs, `${label} ${role} heartbeat`);
  assertFinite(value.heartbeatAgeMs, `${label} ${role} heartbeat age`);
  if (
    value.heartbeatMonotonicMs < value.startedMonotonicMs ||
    value.heartbeatMonotonicMs > trustedMonotonicMs ||
    value.heartbeatAgeMs > MAX_LEASE_AGE_MS ||
    trustedMonotonicMs - value.heartbeatMonotonicMs > MAX_LEASE_AGE_MS
  ) throw new Error(`${label} ${role} lease is stale or future-dated`);
  if (
    value.baselineP95LatencyMs !== null &&
    (typeof value.baselineP95LatencyMs !== "number" ||
      !Number.isFinite(value.baselineP95LatencyMs) ||
      value.baselineP95LatencyMs <= 0)
  ) throw new Error(`${label} ${role} baseline is invalid`);
  if (role === "guard" && value.baselineP95LatencyMs === null) {
    throw new Error(`${label} guard baseline is missing`);
  }
  return value;
}

function validateLeases(value, stagingRunId, trustedMonotonicMs, label) {
  assertExactDataRecord(value, LEASE_FIELDS, `${label} leases`);
  if (value.stagingRunId !== stagingRunId || value.maxAgeMs !== MAX_LEASE_AGE_MS) {
    throw new Error(`${label} leases are not bound to the fixed rollout and age`);
  }
  const guard = validateLeaseEntry(value.guard, "guard", stagingRunId, trustedMonotonicMs, label);
  const watchdog = validateLeaseEntry(
    value.watchdog,
    "watchdog",
    stagingRunId,
    trustedMonotonicMs,
    label,
  );
  if (guard.leaseId === watchdog.leaseId) throw new Error(`${label} lease IDs are not distinct`);
  return { guard, watchdog };
}

function assertSameLeaseInstance(left, right, label, requireHeartbeatProgress = false) {
  for (const role of ["guard", "watchdog"]) {
    for (const field of ["leaseId", "pid", "startedMonotonicMs", "baselineP95LatencyMs"]) {
      if (left[role][field] !== right[role][field]) {
        throw new Error(`${label} ${role} lease instance changed`);
      }
    }
    if (requireHeartbeatProgress && right[role].heartbeatMonotonicMs < left[role].heartbeatMonotonicMs) {
      throw new Error(`${label} ${role} heartbeat decreased`);
    }
  }
}

function validateMarkerStorageRecord(record, kind, id, expected) {
  const idField = kind === "action" ? "actionId" : "observationId";
  assertExactDataRecord(record, [idField, "path", "value", "bytes", "sha256"], `${kind} marker record`);
  if (record[idField] !== id || typeof record.path !== "string") {
    throw new Error(`${kind} marker storage identity changed`);
  }
  assertStrictJson(record.value, `${kind} marker value`);
  if (
    typeof record.bytes !== "string" ||
    record.bytes !== canonicalJson(record.value) ||
    record.sha256 !== sha256Text(record.bytes)
  ) throw new Error(`${kind} marker storage bytes changed`);
  const value = kind === "action"
    ? validatePhase3ActionMeasurement(record.value, expected)
    : validatePhase3ObservationMarker(record.value, expected);
  return freezeClone({ value, sha256: record.sha256 });
}

function deriveCommonContext(metadata, snapshotState, partitionValue, actionRecords, observations, leases) {
  const generationActions = PHASE3_ACTION_IDS.slice(3).map((actionId) => actionRecords.get(actionId).value);
  const generation = generationActions[0]?.generation;
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generationActions.some((marker) => marker.generation !== generation) ||
    observations.fence.value.generation !== generation ||
    observations.schema.value.generation !== null
  ) throw new Error("Phase 3 marker generation continuity changed");
  return freezeClone({
    stagingRunId: metadata.binding.stagingRunId,
    actionJournalHeadSha256: metadata.binding.actionJournalHeadSha256,
    candidateSha: metadata.binding.candidateSha,
    imageDigest: metadata.binding.imageDigest,
    releaseManifestSha256: metadata.binding.releaseManifestSha256,
    rollbackReleaseManifestSha256: metadata.rollbackReleaseManifestSha256,
    stagingTargetDescriptorSha256: metadata.binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: metadata.binding.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: metadata.binding.stagingApprovalEnvelopeSha256,
    teamId: partitionValue.teamId,
    epoch: partitionValue.epoch,
    generation,
    windowStartedAt: snapshotState.gate3.completedAt,
    windowEndedAt: snapshotState.final.completedAt,
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
  });
}

function validateCommonContext(value) {
  assertExactDataRecord(value, COMMON_CONTEXT_FIELDS, "Phase 3 runtime source context");
  assertStrictJson(value, "Phase 3 runtime source context");
  assertId(value.stagingRunId, "source staging run ID");
  assertHash(value.actionJournalHeadSha256, "source action journal head");
  assertCommit(value.candidateSha, "source candidate SHA");
  assertImage(value.imageDigest, "source image digest");
  for (const field of [
    "releaseManifestSha256", "rollbackReleaseManifestSha256",
    "stagingTargetDescriptorSha256", "operatorBundleSha256",
    "stagingApprovalEnvelopeSha256",
  ]) assertHash(value[field], `source ${field}`);
  if (value.teamId !== 1 && value.teamId !== 2) throw new Error("source team ID is invalid");
  assertId(value.epoch, "source epoch");
  assertPositiveInteger(value.generation, "source generation");
  const started = canonicalTimestamp(value.windowStartedAt, "source window start");
  const ended = canonicalTimestamp(value.windowEndedAt, "source window end");
  if (started >= ended) throw new Error("source evidence window is invalid");
  assertId(value.guardLeaseId, "source guard lease ID");
  assertId(value.watchdogLeaseId, "source watchdog lease ID");
  if (value.guardLeaseId === value.watchdogLeaseId) throw new Error("source lease IDs are not distinct");
  return value;
}

function validateDatabase(value, contextValue) {
  assertExactDataRecord(value, DB_FIELDS, "Phase 3 final database evidence");
  if (value.ok !== true || value.evidenceId !== "phase3-gate4-final") {
    throw new Error("Phase 3 final database evidence identity changed");
  }
  assertExactDataRecord(
    value.control,
    ["state", "generation", "fenceJobId", "ackJobId", "pollerNodeMatches", "acknowledgedAt"],
    "Phase 3 final database control",
  );
  if (
    value.control.state !== "fenced" ||
    value.control.generation !== contextValue.generation ||
    value.control.pollerNodeMatches !== true
  ) throw new Error("Phase 3 final database control changed");
  assertNonnegativeInteger(value.control.fenceJobId, "database fence job ID");
  assertNonnegativeInteger(value.control.ackJobId, "database acknowledgment job ID");
  if (value.control.ackJobId < value.control.fenceJobId) {
    throw new Error("database acknowledgment precedes the fence");
  }
  const acknowledgedAt = canonicalTimestamp(
    value.control.acknowledgedAt,
    "database acknowledgment time",
  );
  if (
    acknowledgedAt < Date.parse(contextValue.windowStartedAt) ||
    acknowledgedAt > Date.parse(contextValue.windowEndedAt)
  ) throw new Error("database acknowledgment is outside the evidence window");
  assertExactDataRecord(
    value.drain,
    ["queued", "liveClaims", "indeterminate", "unknown", "settlementPending"],
    "Phase 3 final database drain",
  );
  for (const field of ["queued", "liveClaims", "indeterminate", "unknown", "settlementPending"]) {
    assertNonnegativeInteger(value.drain[field], `database drain ${field}`);
  }
  assertExactDataRecord(
    value.duplicates,
    [
      "externalAttempts", "results", "history", "bookingHistory", "notifications",
      "budgetReservations", "settlements",
    ],
    "Phase 3 final database duplicates",
  );
  for (const field of [
    "externalAttempts", "results", "history", "bookingHistory", "notifications",
    "budgetReservations", "settlements",
  ]) assertNonnegativeInteger(value.duplicates[field], `database duplicate ${field}`);
  assertNonnegativeInteger(value.staleEpochActions, "database stale epoch actions");
  assertNonnegativeInteger(value.directPollerAccepts, "database direct poller accepts");
  assertExactDataRecord(
    value.inlineLease,
    ["activeOwnerCount", "ownerNodeId", "ownerMatches"],
    "Phase 3 final database inline lease",
  );
  const fixed = phase3PartitionIdentity(contextValue.teamId, contextValue.epoch);
  if (
    value.inlineLease.activeOwnerCount !== 1 ||
    value.inlineLease.ownerNodeId !== fixed.legacyNodeId ||
    value.inlineLease.ownerMatches !== true
  ) throw new Error("Phase 3 final database inline owner changed");
  return value;
}

function validateSanitizedLabels(value, service, contextValue) {
  assertExactDataRecord(
    value,
    [
      "composeProject", "composeService", "runtimeEnvironment", "releaseSha",
      "targetDescriptorSha256", "operatorBundleSha256", "stagingRunId",
    ],
    "sanitized runtime labels",
  );
  if (
    value.composeProject !== "spx-staging" ||
    value.composeService !== service ||
    value.runtimeEnvironment !== "staging" ||
    value.releaseSha !== contextValue.candidateSha ||
    value.targetDescriptorSha256 !== contextValue.stagingTargetDescriptorSha256 ||
    value.operatorBundleSha256 !== contextValue.operatorBundleSha256 ||
    value.stagingRunId !== contextValue.stagingRunId
  ) throw new Error("sanitized runtime labels changed");
}

function validateRuntimeService(value, kind, fixed, contextValue) {
  const common = [
    "service", "containerId", "nodeId", "status", "health", "paused", "restarting",
    "imageId", "labels",
  ];
  const fields = kind === "poller"
    ? [...common, "cutoverEpoch", "dryRunWorkerEnabled", "realWorkerEnabled", "settlementWorkerEnabled"]
    : kind === "consumer"
      ? [...common, "dryRunWorkerEnabled", "realWorkerEnabled", "settlementWorkerEnabled"]
      : [...common, "role", "runTeamIds"];
  assertExactDataRecord(value, fields, `Phase 3 ${kind} runtime service`);
  const expectedService = kind === "poller"
    ? fixed.pollerService
    : kind === "consumer"
      ? fixed.consumerService
      : fixed.legacyService;
  const expectedNode = kind === "poller"
    ? fixed.pollerNodeId
    : kind === "consumer"
      ? fixed.consumerNodeId
      : fixed.legacyNodeId;
  if (
    value.service !== expectedService ||
    value.nodeId !== expectedNode ||
    typeof value.containerId !== "string" ||
    !CONTAINER_ID.test(value.containerId) ||
    value.imageId !== contextValue.imageDigest ||
    value.paused !== false ||
    value.restarting !== false
  ) throw new Error(`Phase 3 ${kind} runtime identity changed`);
  validateSanitizedLabels(value.labels, expectedService, contextValue);
  if (kind === "legacy") {
    if (
      value.status !== "running" ||
      value.health !== "healthy" ||
      value.role !== "worker" ||
      value.runTeamIds !== String(contextValue.teamId)
    ) throw new Error("Phase 3 restored legacy runtime state changed");
  } else {
    if (value.status !== "exited" || value.health !== null || value.dryRunWorkerEnabled !== false) {
      throw new Error(`Phase 3 ${kind} stopped runtime state changed`);
    }
    if (kind === "poller") {
      if (
        value.cutoverEpoch !== contextValue.epoch ||
        value.realWorkerEnabled !== false ||
        value.settlementWorkerEnabled !== false
      ) throw new Error("Phase 3 stopped poller flags changed");
    } else if (
      value.realWorkerEnabled !== true ||
      value.settlementWorkerEnabled !== true
    ) throw new Error("Phase 3 stopped consumer flags changed");
  }
  return value;
}

function validateRuntime(value, contextValue) {
  assertExactDataRecord(
    value,
    ["services", "remainingPhase3RuntimeCount", "restoredLegacyOwner"],
    "Phase 3 final runtime evidence",
  );
  assertExactDataRecord(value.services, ["poller", "consumer", "inline"], "Phase 3 runtime services");
  const fixed = phase3PartitionIdentity(contextValue.teamId, contextValue.epoch);
  validateRuntimeService(value.services.poller, "poller", fixed, contextValue);
  validateRuntimeService(value.services.consumer, "consumer", fixed, contextValue);
  validateRuntimeService(value.services.inline, "legacy", fixed, contextValue);
  if (
    value.services.poller.containerId === value.services.consumer.containerId ||
    value.services.poller.containerId === value.services.inline.containerId ||
    value.services.consumer.containerId === value.services.inline.containerId ||
    value.remainingPhase3RuntimeCount !== 0
  ) throw new Error("Phase 3 runtime container set is not exact");
  assertExactDataRecord(
    value.restoredLegacyOwner,
    ["activeOwnerCount", "ownerNodeId", "ownerMatches"],
    "Phase 3 runtime restored owner",
  );
  if (
    value.restoredLegacyOwner.activeOwnerCount !== 1 ||
    value.restoredLegacyOwner.ownerNodeId !== fixed.legacyNodeId ||
    value.restoredLegacyOwner.ownerMatches !== true
  ) throw new Error("Phase 3 runtime restored owner changed");
  return value;
}

function validateContinuityLeaseTuple(value, role, contextValue, label) {
  assertExactDataRecord(
    value,
    [
      "leaseId", "state", "pid", "startedMonotonicMs", "heartbeatMonotonicMs",
      "heartbeatAgeMs", "baselineP95LatencyMs",
    ],
    `${label} ${role} lease tuple`,
  );
  const expectedLeaseId = role === "guard" ? contextValue.guardLeaseId : contextValue.watchdogLeaseId;
  if (value.leaseId !== expectedLeaseId || value.state !== "armed") {
    throw new Error(`${label} ${role} lease tuple identity changed`);
  }
  assertPositiveInteger(value.pid, `${label} ${role} PID`);
  assertNonnegativeInteger(value.startedMonotonicMs, `${label} ${role} start`);
  assertNonnegativeInteger(value.heartbeatMonotonicMs, `${label} ${role} heartbeat`);
  assertFinite(value.heartbeatAgeMs, `${label} ${role} heartbeat age`);
  if (
    value.heartbeatMonotonicMs < value.startedMonotonicMs ||
    value.heartbeatAgeMs > MAX_LEASE_AGE_MS ||
    (role === "guard" && !(typeof value.baselineP95LatencyMs === "number" && value.baselineP95LatencyMs > 0)) ||
    (role === "watchdog" && value.baselineP95LatencyMs !== null &&
      !(typeof value.baselineP95LatencyMs === "number" && value.baselineP95LatencyMs > 0))
  ) throw new Error(`${label} ${role} lease tuple is invalid`);
  return value;
}

function validateMarkerBinding(value, kind, expectedId, contextValue) {
  const idField = kind === "action" ? "actionId" : "observationId";
  assertExactDataRecord(
    value,
    [idField, "markerSha256", "guardLeaseId", "watchdogLeaseId"],
    `continuity ${kind} binding`,
  );
  assertHash(value.markerSha256, `continuity ${kind} marker hash`);
  if (
    value[idField] !== expectedId ||
    value.guardLeaseId !== contextValue.guardLeaseId ||
    value.watchdogLeaseId !== contextValue.watchdogLeaseId
  ) throw new Error(`continuity ${kind} marker lease binding changed`);
}

function validateContinuity(value, contextValue) {
  assertExactDataRecord(
    value,
    ["before", "after", "markerBindings", "sameInstance", "heartbeatNondecreasing", "zeroGap"],
    "Phase 3 lease continuity evidence",
  );
  for (const position of ["before", "after"]) {
    assertExactDataRecord(value[position], ["guard", "watchdog"], `continuity ${position}`);
    validateContinuityLeaseTuple(value[position].guard, "guard", contextValue, `continuity ${position}`);
    validateContinuityLeaseTuple(
      value[position].watchdog,
      "watchdog",
      contextValue,
      `continuity ${position}`,
    );
  }
  for (const role of ["guard", "watchdog"]) {
    for (const field of ["leaseId", "pid", "startedMonotonicMs", "baselineP95LatencyMs"]) {
      if (value.before[role][field] !== value.after[role][field]) {
        throw new Error(`continuity ${role} instance changed`);
      }
    }
    if (value.after[role].heartbeatMonotonicMs < value.before[role].heartbeatMonotonicMs) {
      throw new Error(`continuity ${role} heartbeat decreased`);
    }
  }
  if (
    value.sameInstance !== true ||
    value.heartbeatNondecreasing !== true ||
    value.zeroGap !== true
  ) throw new Error("lease continuity corroboration changed");
  assertExactDataRecord(
    value.markerBindings,
    ["observations", "actions"],
    "lease continuity marker bindings",
  );
  if (
    !Array.isArray(value.markerBindings.observations) ||
    value.markerBindings.observations.length !== 2 ||
    !Array.isArray(value.markerBindings.actions) ||
    value.markerBindings.actions.length !== PHASE3_ACTION_IDS.length
  ) throw new Error("lease continuity marker binding set changed");
  for (const [index, observationId] of ["phase3-schema-verify", "phase3-fence-ack-wait"].entries()) {
    validateMarkerBinding(value.markerBindings.observations[index], "observation", observationId, contextValue);
  }
  for (const [index, actionId] of PHASE3_ACTION_IDS.entries()) {
    validateMarkerBinding(value.markerBindings.actions[index], "action", actionId, contextValue);
  }
  return value;
}

function assertContinuityMarkerHashes(value, actionRecords, observations) {
  for (const [index, record] of [observations.schema, observations.fence].entries()) {
    if (value.markerBindings.observations[index].markerSha256 !== record.sha256) {
      throw new Error("lease continuity observation hash changed");
    }
  }
  for (const [index, actionId] of PHASE3_ACTION_IDS.entries()) {
    if (value.markerBindings.actions[index].markerSha256 !== actionRecords.get(actionId).sha256) {
      throw new Error("lease continuity action hash changed");
    }
  }
}

function expectedCapacityFailures(measurements, thresholds, ready) {
  const failures = [];
  const approved = thresholds.envelopeApproved;
  const fixed = thresholds.codeOwnedFixed;
  if (!ready) failures.push("PRODUCTION_NOT_READY");
  if (measurements.a3CpuPercent > approved.maxCpuPercent) failures.push("A3_CPU_BUDGET_EXCEEDED");
  if (measurements.a3MemoryFreeBytes < approved.minMemoryFreeBytes) failures.push("A3_MEMORY_HEADROOM_LOW");
  if (measurements.a3DiskFreeBytes < fixed.minDiskFreeBytes) failures.push("A3_DISK_HEADROOM_LOW");
  if (measurements.a3InodeFreePercent < fixed.minInodeFreePercent) failures.push("A3_INODE_HEADROOM_LOW");
  if (measurements.a3PidFree < fixed.minPidFree) failures.push("A3_PID_HEADROOM_LOW");
  if (measurements.a3NetworkRxUtilizationPercent > fixed.maxNetworkRxUtilizationPercent) failures.push("A3_NETWORK_RX_BUDGET_EXCEEDED");
  if (measurements.a3NetworkTxUtilizationPercent > fixed.maxNetworkTxUtilizationPercent) failures.push("A3_NETWORK_TX_BUDGET_EXCEEDED");
  if (measurements.a3NetworkHeadroomMbps < fixed.minNetworkHeadroomMbps) failures.push("A3_NETWORK_HEADROOM_LOW");
  if (measurements.sharedMysqlConnectionsFree < approved.minMysqlConnectionsFree) failures.push("MYSQL_CONNECTION_HEADROOM_LOW");
  if (measurements.sharedMysqlConnectionHeadroomPercent < fixed.minMysqlConnectionHeadroomPercent) failures.push("MYSQL_CONNECTION_PERCENT_HEADROOM_LOW");
  if (measurements.productionP95LatencyMs > approved.maxProductionP95LatencyMs) failures.push("PRODUCTION_LATENCY_BUDGET_EXCEEDED");
  if (measurements.productionLatencyIncreasePercent > approved.maxLatencyIncreasePercent) failures.push("PRODUCTION_LATENCY_INCREASE_EXCEEDED");
  if (!canonicalEqual(failures, CAPACITY_FAILURE_ORDER.filter((code) => failures.includes(code)))) {
    throw new Error("capacity failure order changed");
  }
  return failures;
}

function validateCapacity(value) {
  assertExactDataRecord(
    value,
    ["schemaVersion", "observedAt", "ok", "failures", "measurements", "thresholds"],
    "Phase 3 capacity evidence",
  );
  if (value.schemaVersion !== 1 || typeof value.ok !== "boolean" || !Array.isArray(value.failures)) {
    throw new Error("Phase 3 capacity evidence identity changed");
  }
  canonicalTimestamp(value.observedAt, "capacity observation time");
  const measurementFields = [
    "a3CpuPercent", "a3MemoryFreeBytes", "a3DiskFreeBytes", "a3InodeFreePercent",
    "a3PidFree", "a3NetworkRxUtilizationPercent", "a3NetworkTxUtilizationPercent",
    "a3NetworkHeadroomMbps", "sharedMysqlConnectionsFree",
    "sharedMysqlConnectionHeadroomPercent", "productionP95LatencyMs",
    "productionBaselineP95LatencyMs", "productionLatencyIncreasePercent",
  ];
  assertExactDataRecord(value.measurements, measurementFields, "capacity measurements");
  for (const field of measurementFields) {
    assertFinite(
      value.measurements[field],
      `capacity measurement ${field}`,
      field === "productionLatencyIncreasePercent" ? -100 : 0,
    );
  }
  assertExactDataRecord(
    value.thresholds,
    ["envelopeApproved", "codeOwnedFixed"],
    "capacity thresholds",
  );
  const approvedFields = [
    "maxCpuPercent", "minMemoryFreeBytes", "minMysqlConnectionsFree",
    "maxProductionP95LatencyMs", "maxLatencyIncreasePercent",
  ];
  assertExactDataRecord(value.thresholds.envelopeApproved, approvedFields, "approved capacity thresholds");
  for (const field of approvedFields) assertFinite(value.thresholds.envelopeApproved[field], `capacity ${field}`);
  assertExactDataRecord(
    value.thresholds.codeOwnedFixed,
    Object.keys(FIXED_CAPACITY_THRESHOLDS),
    "fixed capacity thresholds",
  );
  if (!canonicalEqual(value.thresholds.codeOwnedFixed, FIXED_CAPACITY_THRESHOLDS)) {
    throw new Error("fixed capacity thresholds changed");
  }
  for (const failure of value.failures) {
    if (typeof failure !== "string" || !CAPACITY_FAILURE_ORDER.includes(failure)) {
      throw new Error("capacity failure code changed");
    }
  }
  const readiness = !value.failures.includes("PRODUCTION_NOT_READY");
  const recomputedFailures = expectedCapacityFailures(
    value.measurements,
    value.thresholds,
    readiness,
  );
  if (
    !canonicalEqual(value.failures, recomputedFailures) ||
    value.ok !== (recomputedFailures.length === 0)
  ) throw new Error("capacity outcome is not recomputed from its standalone payload");
  return value;
}

function validateProductionObserver(value) {
  assertExactDataRecord(
    value,
    ["schemaVersion", "expectedPolicySha256", "requestMethod", "response", "observedAt", "thresholdResult"],
    "Phase 3 production observer evidence",
  );
  if (value.schemaVersion !== 1 || value.requestMethod !== "GET") {
    throw new Error("production observer request identity changed");
  }
  assertHash(value.expectedPolicySha256, "production observer policy hash");
  canonicalTimestamp(value.observedAt, "production observer observation time");
  assertExactDataRecord(value.response, ["p95LatencyMs", "ready"], "production observer response");
  assertFinite(value.response.p95LatencyMs, "production observer p95 latency");
  if (typeof value.response.ready !== "boolean") throw new Error("production observer readiness changed");
  assertExactDataRecord(
    value.thresholdResult,
    ["absoluteP95WithinApprovedLimit", "latencyIncreaseWithinApprovedLimit", "passed"],
    "production observer threshold result",
  );
  for (const field of ["absoluteP95WithinApprovedLimit", "latencyIncreaseWithinApprovedLimit", "passed"]) {
    if (typeof value.thresholdResult[field] !== "boolean") {
      throw new Error("production observer threshold result changed");
    }
  }
  if (
    value.thresholdResult.passed !==
    (value.response.ready &&
      value.thresholdResult.absoluteP95WithinApprovedLimit &&
      value.thresholdResult.latencyIncreaseWithinApprovedLimit)
  ) throw new Error("production observer passed result contradicts readiness or thresholds");
  return value;
}

function validateCapacityPair(capacity, productionObserver, contextValue, metadata = null, leases = null) {
  validateCapacity(capacity);
  validateProductionObserver(productionObserver);
  if (capacity.observedAt !== productionObserver.observedAt) {
    throw new Error("capacity and observer timestamps differ");
  }
  if (productionObserver.response.p95LatencyMs !== capacity.measurements.productionP95LatencyMs) {
    throw new Error("capacity and observer latency differ");
  }
  const increase =
    ((capacity.measurements.productionP95LatencyMs -
      capacity.measurements.productionBaselineP95LatencyMs) /
      capacity.measurements.productionBaselineP95LatencyMs) * 100;
  if (capacity.measurements.productionLatencyIncreasePercent !== increase) {
    throw new Error("capacity latency increase is not recomputed");
  }
  const expectedFailures = expectedCapacityFailures(
    capacity.measurements,
    capacity.thresholds,
    productionObserver.response.ready,
  );
  if (!canonicalEqual(capacity.failures, expectedFailures) || capacity.ok !== (expectedFailures.length === 0)) {
    throw new Error("capacity outcome is not recomputed");
  }
  const absolute =
    capacity.measurements.productionP95LatencyMs <=
    capacity.thresholds.envelopeApproved.maxProductionP95LatencyMs;
  const latencyIncrease =
    capacity.measurements.productionLatencyIncreasePercent <=
    capacity.thresholds.envelopeApproved.maxLatencyIncreasePercent;
  if (
    productionObserver.thresholdResult.absoluteP95WithinApprovedLimit !== absolute ||
    productionObserver.thresholdResult.latencyIncreaseWithinApprovedLimit !== latencyIncrease ||
    productionObserver.thresholdResult.passed !==
      (productionObserver.response.ready && absolute && latencyIncrease)
  ) throw new Error("production observer threshold booleans are not recomputed");
  if (metadata) {
    const expectedApproved = {
      maxCpuPercent: metadata.approvedThresholds.maxCpuPercent,
      minMemoryFreeBytes: metadata.approvedThresholds.minMemoryFreeBytes,
      minMysqlConnectionsFree: metadata.approvedThresholds.minMysqlConnectionsFree,
      maxProductionP95LatencyMs: metadata.approvedThresholds.productionP95LatencyMs,
      maxLatencyIncreasePercent: metadata.approvedThresholds.maxLatencyIncreasePercent,
    };
    if (
      !canonicalEqual(capacity.thresholds.envelopeApproved, expectedApproved) ||
      productionObserver.expectedPolicySha256 !== metadata.productionObserverPolicySha256
    ) throw new Error("capacity or observer approval binding changed");
  }
  if (
    leases &&
    capacity.measurements.productionBaselineP95LatencyMs !== leases.guard.baselineP95LatencyMs
  ) throw new Error("capacity baseline changed from the continuous guard");
  const observedAt = Date.parse(capacity.observedAt);
  if (observedAt < Date.parse(contextValue.windowEndedAt) || observedAt > Date.now() + 5 * 60_000) {
    throw new Error("capacity observation time is outside the final evidence window");
  }
  return true;
}

function validateSourceValueInternal(sourceId, value, expectedContext, validation = {}) {
  if (!PHASE3_RUNTIME_SOURCE_IDS.includes(sourceId)) {
    throw new Error("Phase 3 runtime source ID is invalid");
  }
  validateCommonContext(expectedContext);
  assertStrictJson(value, `Phase 3 runtime source ${sourceId}`);
  const field = sourceId === "db-final"
    ? "database"
    : sourceId === "runtime-final"
      ? "runtime"
      : sourceId === "lease-continuity"
        ? "continuity"
        : sourceId === "capacity"
          ? "capacity"
          : "productionObserver";
  assertExactDataRecord(
    value,
    ["schemaVersion", "context", field],
    `Phase 3 runtime source ${sourceId}`,
  );
  if (value.schemaVersion !== 1 || !canonicalEqual(value.context, expectedContext)) {
    throw new Error(`Phase 3 runtime source ${sourceId} context changed`);
  }
  validateCommonContext(value.context);
  if (sourceId === "db-final") validateDatabase(value.database, expectedContext);
  if (sourceId === "runtime-final") validateRuntime(value.runtime, expectedContext);
  if (sourceId === "lease-continuity") validateContinuity(value.continuity, expectedContext);
  if (sourceId === "capacity") validateCapacity(value.capacity);
  if (sourceId === "production-observer") validateProductionObserver(value.productionObserver);
  if (validation.metadata && sourceId === "production-observer") {
    if (
      value.productionObserver.expectedPolicySha256 !==
      validation.metadata.productionObserverPolicySha256
    ) throw new Error("production observer approval hash changed");
  }
  return true;
}

export function validatePhase3RuntimeSourceValue(sourceId, value, expectedContext, ...extra) {
  if (arguments.length < 3 || extra.length !== 0) {
    throw new Error("validatePhase3RuntimeSourceValue received an invalid argument count");
  }
  return validateSourceValueInternal(sourceId, value, expectedContext);
}

function normalizeStorageRecord(record, kind, id = null) {
  const fields = kind === "aggregate"
    ? ["value", "bytes", "sha256"]
    : kind === "checkpoint"
      ? ["path", "value", "bytes", "sha256"]
      : ["sourceId", "path", "value", "bytes", "sha256"];
  assertExactDataRecord(record, fields, `${kind} evidence storage record`);
  if (kind === "source" && record.sourceId !== id) {
    throw new Error("runtime source storage identity changed");
  }
  if (kind !== "aggregate" && typeof record.path !== "string") {
    throw new Error(`${kind} storage path is invalid`);
  }
  assertStrictJson(record.value, `${kind} storage value`);
  if (
    typeof record.bytes !== "string" ||
    record.bytes !== canonicalJson(record.value) ||
    record.sha256 !== sha256Text(record.bytes)
  ) throw new Error(`${kind} evidence storage bytes changed`);
  return freezeClone(record);
}

function captureCanonicalValue(value, label) {
  assertStrictJson(value, label);
  const snapshot = freezeClone(value);
  const bytes = canonicalJson(snapshot);
  return freezeClone({
    value: snapshot,
    bytes,
    sha256: sha256Text(bytes),
  });
}

function isExactMissing(error) {
  if (!error || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(descriptor && Object.hasOwn(descriptor, "value") && descriptor.value === "ENOENT");
}

async function readOptional(operation) {
  try {
    return { present: true, value: await operation() };
  } catch (error) {
    if (isExactMissing(error)) return { present: false, value: null };
    throw error;
  }
}

function runDocker(args, environment = null) {
  const result = spawnSync("docker", ["--context", "default", ...args], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: MAX_DOCKER_BYTES,
    env: environment ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") {
    throw collectionFailure();
  }
  return result.stdout.trim();
}

async function assertInstalledLocalDocker() {
  if (
    process.env.DOCKER_HOST ||
    (process.env.DOCKER_CONTEXT && process.env.DOCKER_CONTEXT !== "default") ||
    runDocker(["context", "show"]) !== "default"
  ) throw collectionFailure();
  return true;
}

async function listInstalledFixedServiceContainerIds(service, bindingValue) {
  const operatorRoot = await loadInstalledStagingOperatorRoot(bindingValue);
  const prefix = buildInstalledStagingComposePrefix(operatorRoot);
  const environment = buildInstalledStagingComposeEnvironment(bindingValue, operatorRoot);
  const output = runDocker([...prefix, "ps", "--all", "-q", service], environment);
  if (output === "") return [];
  return output.split(/\r?\n/).filter(Boolean);
}

async function inspectInstalledFixedContainer(containerId) {
  if (typeof containerId !== "string" || !CONTAINER_ID.test(containerId)) throw collectionFailure();
  let parsed;
  try {
    parsed = JSON.parse(runDocker(["inspect", containerId]));
  } catch {
    throw collectionFailure();
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw collectionFailure();
  return parsed[0];
}

function runInstalledDatabaseEvidence(payload, bindingValue) {
  const transport = buildStagingPhase3DatabaseTransport(payload, bindingValue);
  if (
    transport.executable !== "docker" ||
    !Array.isArray(transport.argv) ||
    transport.argv[0] !== "--context" ||
    transport.argv[1] !== "default" ||
    typeof transport.input !== "string" ||
    transport.input !== canonicalJson(payload)
  ) throw collectionFailure();
  const result = spawnSync(transport.executable, transport.argv, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    input: transport.input,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: DATABASE_TIMEOUT_MS,
    maxBuffer: MAX_DOCKER_BYTES,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") {
    throw collectionFailure();
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw collectionFailure();
  }
}

function defaultPorts(testPorts) {
  if (testPorts) return testPorts;
  return Object.freeze({
    loadContext: loadInstalledApprovedStagingContext,
    loadCapability: (bindingValue) => loadInstalledStagingActionCapability(bindingValue),
    loadObserverDatabase: (capabilityValue, role) => {
      if (role !== "phase3-observer") throw collectionFailure();
      return loadStagingDatabaseCredential(capabilityValue, "phase3-observer");
    },
    loadLeases: (stagingRunId) => loadStagingLeases(stagingRunId),
    readActionMeasurements: (expected) => readPhase3ActionMeasurements(expected),
    readObservationMarkers: (expected) => readPhase3ObservationMarkers(expected),
    assertLocalDocker: assertInstalledLocalDocker,
    listFixedServiceContainerIds: listInstalledFixedServiceContainerIds,
    inspectFixedContainer: inspectInstalledFixedContainer,
    runDatabaseEvidence: runInstalledDatabaseEvidence,
    collectCapacityEvidence: () => collectInstalledPhase3CapacityEvidence(),
    recoverRuntimeSources: () => recoverPhase3RuntimeSourceStorage(),
    recoverCapacityCheckpoint: () => recoverPhase3CapacityObservationCheckpointStorage(),
    readCapacityCheckpoint: () => readPhase3CapacityObservationCheckpoint(),
    writeCapacityCheckpoint: (value) => writePhase3CapacityObservationCheckpoint(value),
    readSource: (sourceId) => readPhase3RuntimeSource(sourceId),
    writeSource: (sourceId, value) => writePhase3RuntimeSource(sourceId, value),
    readSources: () => readPhase3RuntimeSources(),
  });
}

function rawDataField(value, field, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} is invalid`);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new Error(`${label}.${field} is not an enumerable data property`);
  }
  return descriptor.value;
}

function parseEnvironment(entries) {
  if (!Array.isArray(entries)) throw new Error("container environment is invalid");
  const result = new Map();
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
      throw new Error("container environment entry is malformed");
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("container environment entry is malformed");
    const key = entry.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || result.has(key)) {
      throw new Error("container environment contains a duplicate or malformed key");
    }
    result.set(key, entry.slice(separator + 1));
  }
  return result;
}

function expectedRawLabels(labels, service, contextValue) {
  if (!isPlainObject(labels)) throw new Error("container labels are invalid");
  const expected = {
    "com.docker.compose.project": "spx-staging",
    "com.docker.compose.service": service,
    "com.spx.environment": "staging",
    "com.spx.release-sha": contextValue.candidateSha,
    "com.spx.target-descriptor-sha256": contextValue.stagingTargetDescriptorSha256,
    "com.spx.operator-bundle-sha256": contextValue.operatorBundleSha256,
    "com.spx.staging-run-id": contextValue.stagingRunId,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (rawDataField(labels, key, "container labels") !== value) {
      throw new Error("container release labels changed");
    }
  }
  return {
    composeProject: expected["com.docker.compose.project"],
    composeService: expected["com.docker.compose.service"],
    runtimeEnvironment: expected["com.spx.environment"],
    releaseSha: expected["com.spx.release-sha"],
    targetDescriptorSha256: expected["com.spx.target-descriptor-sha256"],
    operatorBundleSha256: expected["com.spx.operator-bundle-sha256"],
    stagingRunId: expected["com.spx.staging-run-id"],
  };
}

function projectInspectedContainer(raw, service, nodeId, kind, contextValue) {
  if (!isPlainObject(raw)) throw new Error("container inspection is invalid");
  const containerId = rawDataField(raw, "Id", "container inspection");
  const imageId = rawDataField(raw, "Image", "container inspection");
  const config = rawDataField(raw, "Config", "container inspection");
  const state = rawDataField(raw, "State", "container inspection");
  if (!CONTAINER_ID.test(containerId ?? "") || imageId !== contextValue.imageDigest) {
    throw new Error("container image or identity changed");
  }
  const environment = parseEnvironment(rawDataField(config, "Env", "container config"));
  if (environment.get("SPX_NODE_ID") !== nodeId) throw new Error("container node identity changed");
  const labels = expectedRawLabels(rawDataField(config, "Labels", "container config"), service, contextValue);
  const status = rawDataField(state, "Status", "container state");
  const paused = rawDataField(state, "Paused", "container state");
  const restarting = rawDataField(state, "Restarting", "container state");
  if (paused !== false || restarting !== false) throw new Error("container is paused or restarting");
  if (kind === "legacy") {
    const health = rawDataField(rawDataField(state, "Health", "container state"), "Status", "container health");
    if (
      status !== "running" ||
      health !== "healthy" ||
      environment.get("SPX_ROLE") !== "worker" ||
      environment.get("RUN_TEAM_IDS") !== String(contextValue.teamId)
    ) throw new Error("restored legacy container is not healthy and exact");
    return {
      service, containerId, nodeId, status, health, paused: false, restarting: false, imageId, labels,
      role: "worker", runTeamIds: String(contextValue.teamId),
    };
  }
  if (status !== "exited") throw new Error("selected Phase 3 container is not stopped");
  const dryRun = environment.get("AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED");
  const real = environment.get("AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED");
  const settlement = environment.get("AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED");
  if (dryRun !== "false") throw new Error("selected Phase 3 dry-run flag changed");
  if (kind === "poller") {
    if (
      environment.get("AUTO_ACCEPT_JOB_CUTOVER_EPOCH") !== contextValue.epoch ||
      real !== "false" || settlement !== "false"
    ) throw new Error("selected poller worker flags changed");
    return {
      service, containerId, nodeId, status, health: null, paused: false, restarting: false, imageId, labels,
      cutoverEpoch: contextValue.epoch,
      dryRunWorkerEnabled: false,
      realWorkerEnabled: false,
      settlementWorkerEnabled: false,
    };
  }
  if (real !== "true" || settlement !== "true") {
    throw new Error("selected consumer worker flags changed");
  }
  return {
    service, containerId, nodeId, status, health: null, paused: false, restarting: false, imageId, labels,
    dryRunWorkerEnabled: false,
    realWorkerEnabled: true,
    settlementWorkerEnabled: true,
  };
}

async function collectRuntime(ports, partitionValue, contextValue, bindingValue, database) {
  const specifications = [
    ["poller", partitionValue.pollerService, partitionValue.pollerNodeId],
    ["consumer", partitionValue.consumerService, partitionValue.consumerNodeId],
    ["legacy", partitionValue.legacyService, partitionValue.legacyNodeId],
  ];
  const projected = {};
  const seen = new Set();
  for (const [kind, service, nodeId] of specifications) {
    const ids = await ports.listFixedServiceContainerIds(service, bindingValue);
    if (!Array.isArray(ids) || ids.length !== 1 || !CONTAINER_ID.test(ids[0]) || seen.has(ids[0])) {
      throw new Error("fixed service container inventory is missing, duplicate, or malformed");
    }
    seen.add(ids[0]);
    const raw = await ports.inspectFixedContainer(ids[0]);
    projected[kind] = projectInspectedContainer(raw, service, nodeId, kind, contextValue);
    if (projected[kind].containerId !== ids[0]) throw new Error("container inspection ID changed");
  }
  return {
    services: {
      poller: projected.poller,
      consumer: projected.consumer,
      inline: projected.legacy,
    },
    remainingPhase3RuntimeCount: 0,
    restoredLegacyOwner: structuredClone(database.inlineLease),
  };
}

function leaseTuple(value) {
  return {
    leaseId: value.leaseId,
    state: value.state,
    pid: value.pid,
    startedMonotonicMs: value.startedMonotonicMs,
    heartbeatMonotonicMs: value.heartbeatMonotonicMs,
    heartbeatAgeMs: value.heartbeatAgeMs,
    baselineP95LatencyMs: value.baselineP95LatencyMs,
  };
}

function buildContinuity(before, after, actionRecords, observations) {
  const binding = (kind, id, record) => ({
    [kind === "action" ? "actionId" : "observationId"]: id,
    markerSha256: record.sha256,
    guardLeaseId: before.guard.leaseId,
    watchdogLeaseId: before.watchdog.leaseId,
  });
  return {
    before: { guard: leaseTuple(before.guard), watchdog: leaseTuple(before.watchdog) },
    after: { guard: leaseTuple(after.guard), watchdog: leaseTuple(after.watchdog) },
    markerBindings: {
      observations: [
        binding("observation", "phase3-schema-verify", observations.schema),
        binding("observation", "phase3-fence-ack-wait", observations.fence),
      ],
      actions: PHASE3_ACTION_IDS.map((actionId) =>
        binding("action", actionId, actionRecords.get(actionId))),
    },
    sameInstance: true,
    heartbeatNondecreasing: true,
    zeroGap: true,
  };
}

function validateCheckpointValue(value, contextValue, metadata, leases) {
  assertStrictJson(value, "Phase 3 capacity observation checkpoint");
  assertExactDataRecord(
    value,
    ["schemaVersion", "context", "capacity", "productionObserver"],
    "Phase 3 capacity observation checkpoint",
  );
  if (value.schemaVersion !== 1 || !canonicalEqual(value.context, contextValue)) {
    throw new Error("Phase 3 capacity observation checkpoint context changed");
  }
  validateCommonContext(value.context);
  validateCapacityPair(
    value.capacity,
    value.productionObserver,
    contextValue,
    metadata,
    leases,
  );
  return value;
}

function presentContinuityMatchesCurrent(continuity, current) {
  for (const role of ["guard", "watchdog"]) {
    const previous = continuity.after[role];
    const loaded = current[role];
    for (const field of ["leaseId", "pid", "startedMonotonicMs", "baselineP95LatencyMs"]) {
      if (previous[field] !== loaded[field]) {
        throw new Error(`persisted continuity ${role} instance changed`);
      }
    }
    if (loaded.heartbeatMonotonicMs < previous.heartbeatMonotonicMs) {
      throw new Error(`persisted continuity ${role} heartbeat moved backward`);
    }
  }
}

function sourceWrapper(sourceId, contextValue, payload) {
  const field = sourceId === "db-final"
    ? "database"
    : sourceId === "runtime-final"
      ? "runtime"
      : sourceId === "lease-continuity"
        ? "continuity"
        : sourceId === "capacity"
          ? "capacity"
          : "productionObserver";
  return freezeClone({ schemaVersion: 1, context: contextValue, [field]: payload });
}

function assertPairSourceMatchesCheckpoint(sourceId, record, checkpoint, contextValue) {
  const projected = sourceId === "capacity"
    ? sourceWrapper(sourceId, contextValue, checkpoint.capacity)
    : sourceWrapper(sourceId, contextValue, checkpoint.productionObserver);
  if (!canonicalEqual(record.value, projected)) {
    throw new Error("capacity pair source differs from its durable checkpoint");
  }
}

export async function collectInstalledPhase3RuntimeSources(input, ...callerArguments) {
  const testPorts = assertInvocation(input, callerArguments);
  const capturedInput = freezeClone(input);
  const ports = defaultPorts(testPorts);
  try {
    const metadata = validateLoadedContext(await ports.loadContext());
    const capabilityValue = validateCapability(
      await ports.loadCapability(metadata.binding),
      metadata.binding,
    );
    const snapshotState = validateSnapshot(
      capturedInput.journalSnapshot,
      metadata.binding,
      metadata.approvalId,
    );
    const partitionValue = phase3PartitionIdentity(
      capabilityValue.phase3.canaryTeamId,
      capabilityValue.phase3.canaryEpoch,
    );

    const callerMonotonicMs = monotonicNowMs();
    const callerLeaseState = validateLeases(
      capturedInput.leases,
      metadata.binding.stagingRunId,
      callerMonotonicMs,
      "caller",
    );
    const loadedBeforePortValue = await ports.loadLeases(metadata.binding.stagingRunId);
    const beforeMonotonicMs = monotonicNowMs();
    validateLeases(
      loadedBeforePortValue,
      metadata.binding.stagingRunId,
      beforeMonotonicMs,
      "before",
    );
    const loadedBeforeValue = freezeClone(loadedBeforePortValue);
    const before = validateLeases(
      loadedBeforeValue,
      metadata.binding.stagingRunId,
      beforeMonotonicMs,
      "before",
    );
    assertSameLeaseInstance(callerLeaseState, before, "caller-to-before", true);

    const expectedMarkers = freezeClone({
      position: "historical",
      journalSnapshot: capturedInput.journalSnapshot,
      installedBinding: metadata.binding,
      approvalId: metadata.approvalId,
      rollbackReleaseManifestSha256: metadata.rollbackReleaseManifestSha256,
      leases: loadedBeforeValue,
      partition: partitionValue,
      nowMs: Date.now(),
    });
    const observationSet = await ports.readObservationMarkers(expectedMarkers);
    assertExactDataRecord(observationSet, OBSERVATION_KEYS, "Phase 3 observation marker set");
    const observations = {
      schema: validateMarkerStorageRecord(
        observationSet.schema,
        "observation",
        "phase3-schema-verify",
        expectedMarkers,
      ),
      fence: validateMarkerStorageRecord(
        observationSet.fence,
        "observation",
        "phase3-fence-ack-wait",
        expectedMarkers,
      ),
    };
    const actionSet = await ports.readActionMeasurements(expectedMarkers);
    if (!Array.isArray(actionSet) || actionSet.length !== PHASE3_ACTION_IDS.length) {
      throw new Error("Phase 3 action marker set is incomplete");
    }
    const actionRecords = new Map();
    for (const [index, actionId] of PHASE3_ACTION_IDS.entries()) {
      const record = validateMarkerStorageRecord(actionSet[index], "action", actionId, expectedMarkers);
      actionRecords.set(actionId, record);
    }
    const commonContext = deriveCommonContext(
      metadata,
      snapshotState,
      partitionValue,
      actionRecords,
      observations,
      before,
    );

    await ports.recoverRuntimeSources();
    await ports.recoverCapacityCheckpoint();

    const present = new Map();
    for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
      const attempted = await readOptional(() => ports.readSource(sourceId));
      if (!attempted.present) continue;
      const record = normalizeStorageRecord(attempted.value, "source", sourceId);
      validateSourceValueInternal(sourceId, record.value, commonContext, { metadata });
      present.set(sourceId, record);
    }
    if (present.has("lease-continuity")) {
      assertContinuityMarkerHashes(
        present.get("lease-continuity").value.continuity,
        actionRecords,
        observations,
      );
      presentContinuityMatchesCurrent(
        present.get("lease-continuity").value.continuity,
        before,
      );
    }

    const checkpointAttempt = await readOptional(() => ports.readCapacityCheckpoint());
    let checkpointRecordValue = null;
    if (checkpointAttempt.present) {
      checkpointRecordValue = normalizeStorageRecord(checkpointAttempt.value, "checkpoint");
      validateCheckpointValue(checkpointRecordValue.value, commonContext, metadata, before);
    }
    const hasCapacity = present.has("capacity");
    const hasObserver = present.has("production-observer");
    if (!checkpointRecordValue && (hasCapacity || hasObserver)) {
      throw new Error("capacity pair source exists without its durable checkpoint");
    }
    if (checkpointRecordValue) {
      if (hasCapacity) {
        assertPairSourceMatchesCheckpoint(
          "capacity",
          present.get("capacity"),
          checkpointRecordValue.value,
          commonContext,
        );
      }
      if (hasObserver) {
        assertPairSourceMatchesCheckpoint(
          "production-observer",
          present.get("production-observer"),
          checkpointRecordValue.value,
          commonContext,
        );
      }
    }

    const candidates = new Map();
    const requiresDatabase = !present.has("db-final");
    const requiresRuntime = !present.has("runtime-final");
    const requiresCapacityCollection = checkpointRecordValue === null;
    if (requiresCapacityCollection && (hasCapacity || hasObserver)) {
      throw new Error("partial capacity pair cannot be recollected");
    }
    if (requiresDatabase || requiresRuntime || requiresCapacityCollection) {
      if (await ports.assertLocalDocker() !== true) throw new Error("local Docker is not authenticated");
    }

    let database = present.get("db-final")?.value.database ?? null;
    if (requiresDatabase) {
      const observerDatabase = await ports.loadObserverDatabase(
        capabilityValue,
        "phase3-observer",
      );
      const payload = buildStagingPhase3EvidencePayload({
        context: {
          installedBinding: metadata.binding,
          envelope: { approvalId: metadata.approvalId },
          verified: {
            approvalId: metadata.approvalId,
            rollbackReleaseManifestSha256: metadata.rollbackReleaseManifestSha256,
          },
        },
        capability: capabilityValue,
        journalSnapshot: capturedInput.journalSnapshot,
        finalActionMeasurement: actionRecords.get("phase3-inline-owner-restore").value,
        leases: loadedBeforeValue,
        observerDatabase,
      });
      const databasePortValue = await ports.runDatabaseEvidence(payload, metadata.binding);
      assertStrictJson(databasePortValue, "Phase 3 final database result");
      validateDatabase(databasePortValue, commonContext);
      database = freezeClone(databasePortValue);
      candidates.set("db-final", sourceWrapper("db-final", commonContext, database));
    } else {
      validateDatabase(database, commonContext);
    }

    if (requiresRuntime) {
      const runtime = await collectRuntime(
        ports,
        partitionValue,
        commonContext,
        metadata.binding,
        database,
      );
      const wrapped = sourceWrapper("runtime-final", commonContext, runtime);
      validateSourceValueInternal("runtime-final", wrapped, commonContext, { metadata });
      candidates.set("runtime-final", wrapped);
    }

    if (requiresCapacityCollection) {
      const pairPortValue = await ports.collectCapacityEvidence();
      assertStrictJson(pairPortValue, "installed Phase 3 capacity pair");
      assertExactDataRecord(
        pairPortValue,
        ["capacity", "productionObserver"],
        "installed Phase 3 capacity pair",
      );
      validateCapacityPair(
        pairPortValue.capacity,
        pairPortValue.productionObserver,
        commonContext,
        metadata,
        before,
      );
      const pair = freezeClone(pairPortValue);
      const checkpointValue = {
        schemaVersion: 1,
        context: commonContext,
        capacity: pair.capacity,
        productionObserver: pair.productionObserver,
      };
      validateCheckpointValue(checkpointValue, commonContext, metadata, before);
      const checkpointCandidate = captureCanonicalValue(
        checkpointValue,
        "Phase 3 capacity observation checkpoint candidate",
      );
      const writtenCheckpoint = normalizeStorageRecord(
        await ports.writeCapacityCheckpoint(structuredClone(checkpointCandidate.value)),
        "checkpoint",
      );
      if (
        writtenCheckpoint.bytes !== checkpointCandidate.bytes ||
        writtenCheckpoint.sha256 !== checkpointCandidate.sha256
      ) {
        throw new Error("capacity checkpoint changed during publication");
      }
      checkpointRecordValue = normalizeStorageRecord(
        await ports.readCapacityCheckpoint(),
        "checkpoint",
      );
      validateCheckpointValue(checkpointRecordValue.value, commonContext, metadata, before);
      if (
        checkpointRecordValue.bytes !== checkpointCandidate.bytes ||
        checkpointRecordValue.sha256 !== checkpointCandidate.sha256
      ) throw new Error("capacity checkpoint changed after publication");
    }

    if (!checkpointRecordValue) throw new Error("capacity checkpoint is unavailable");
    if (!present.has("capacity")) {
      candidates.set(
        "capacity",
        sourceWrapper("capacity", commonContext, checkpointRecordValue.value.capacity),
      );
    }
    if (!present.has("production-observer")) {
      candidates.set(
        "production-observer",
        sourceWrapper(
          "production-observer",
          commonContext,
          checkpointRecordValue.value.productionObserver,
        ),
      );
    }

    const loadedAfterPortValue = await ports.loadLeases(metadata.binding.stagingRunId);
    const afterMonotonicMs = monotonicNowMs();
    validateLeases(
      loadedAfterPortValue,
      metadata.binding.stagingRunId,
      afterMonotonicMs,
      "after",
    );
    const loadedAfterValue = freezeClone(loadedAfterPortValue);
    const after = validateLeases(
      loadedAfterValue,
      metadata.binding.stagingRunId,
      afterMonotonicMs,
      "after",
    );
    assertSameLeaseInstance(before, after, "before-to-after", true);
    if (!present.has("lease-continuity")) {
      candidates.set(
        "lease-continuity",
        sourceWrapper(
          "lease-continuity",
          commonContext,
          buildContinuity(before, after, actionRecords, observations),
        ),
      );
    }

    const continuityValue =
      candidates.get("lease-continuity")?.continuity ??
      present.get("lease-continuity")?.value.continuity;
    assertContinuityMarkerHashes(continuityValue, actionRecords, observations);

    const capturedCandidates = new Map();
    for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
      const candidate = candidates.get(sourceId);
      if (!candidate) continue;
      validateSourceValueInternal(sourceId, candidate, commonContext, { metadata });
      capturedCandidates.set(
        sourceId,
        captureCanonicalValue(candidate, `Phase 3 runtime source candidate ${sourceId}`),
      );
    }
    const capacityValue = candidates.get("capacity")?.capacity ?? present.get("capacity")?.value.capacity;
    const observerValue =
      candidates.get("production-observer")?.productionObserver ??
      present.get("production-observer")?.value.productionObserver;
    validateCapacityPair(capacityValue, observerValue, commonContext, metadata, before);

    const winners = new Map(present);
    for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
      if (winners.has(sourceId)) continue;
      const candidate = capturedCandidates.get(sourceId);
      if (!candidate) throw new Error("missing runtime source candidate");
      const written = normalizeStorageRecord(
        await ports.writeSource(sourceId, structuredClone(candidate.value)),
        "source",
        sourceId,
      );
      validateSourceValueInternal(sourceId, written.value, commonContext, { metadata });
      if (written.bytes !== candidate.bytes || written.sha256 !== candidate.sha256) {
        throw new Error("runtime source changed during publication");
      }
      const reopened = normalizeStorageRecord(
        await ports.readSource(sourceId),
        "source",
        sourceId,
      );
      validateSourceValueInternal(sourceId, reopened.value, commonContext, { metadata });
      if (reopened.bytes !== candidate.bytes || reopened.sha256 !== candidate.sha256) {
        throw new Error("runtime source changed after publication");
      }
      winners.set(sourceId, reopened);
    }

    const aggregate = await ports.readSources();
    assertExactDataRecord(aggregate, PHASE3_RUNTIME_SOURCE_IDS, "exact-five runtime source set");
    if (!canonicalEqual(Object.keys(aggregate), PHASE3_RUNTIME_SOURCE_IDS)) {
      throw new Error("exact-five runtime source order changed");
    }
    const result = {};
    for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
      const record = normalizeStorageRecord(aggregate[sourceId], "aggregate");
      validateSourceValueInternal(sourceId, record.value, commonContext, { metadata });
      const winner = winners.get(sourceId);
      if (
        !winner ||
        record.bytes !== winner.bytes ||
        record.sha256 !== winner.sha256 ||
        !canonicalEqual(record.value, winner.value)
      ) throw new Error("final exact-five runtime source changed");
      result[sourceId] = {
        value: record.value,
        bytes: record.bytes,
        sha256: record.sha256,
      };
    }
    validateCapacityPair(
      result.capacity.value.capacity,
      result["production-observer"].value.productionObserver,
      commonContext,
      metadata,
      before,
    );
    return freezeClone(result);
  } catch {
    throw collectionFailure();
  }
}
