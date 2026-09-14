import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  assertInstalledBindingMatchesVerified,
  loadInstalledApprovedStagingContext,
} from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases } from "./lib/a3-staging-leases.mjs";
import { canonicalJson, validateReleaseBinding } from "./lib/evidence-artifact.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_RUNTIME_SOURCE_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
  phase3PartitionIdentity,
  readPhase3ActionJournalSnapshot,
  readPhase3ActionMeasurements,
  readPhase3ObservationMarkers,
  readPhase3RuntimeSources,
  readPhase3SemanticEvidence,
  recoverPhase3ActionJournalSnapshotStorage,
  recoverPhase3SemanticEvidenceStorage,
  validatePhase3ActionMeasurement,
  validatePhase3ObservationMarker,
  validatePhase3PreGate4JournalSnapshot,
  writePhase3ActionJournalSnapshot,
  writePhase3SemanticEvidence,
} from "./lib/phase3-staging-evidence.mjs";
import {
  loadInstalledStagingActionCapability,
  validateStagingActionCapability,
} from "./lib/staging-action-capability.mjs";
import { validatePhase3RuntimeSourceValue } from "./staging-phase3-runtime-evidence.mjs";

const HOST_IDENTITY_PATH = "/etc/spx-staging/host-identity.sha256";
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ZERO_HASH = "0".repeat(64);
const MAX_LEASE_AGE_MS = 10_000;
const PORT_NAMES = Object.freeze([
  "loadContext",
  "loadCapability",
  "loadHostIdentity",
  "loadLeases",
  "recoverSnapshot",
  "recoverSemantic",
  "readSnapshot",
  "writeSnapshot",
  "readObservationMarkers",
  "readActionMeasurements",
  "readSources",
  "readSemantic",
  "writeSemantic",
]);
const DUPLICATE_FIELDS = Object.freeze([
  "externalAttempts",
  "results",
  "history",
  "bookingHistory",
  "notifications",
  "budgetReservations",
  "settlements",
]);
const DRAIN_FIELDS = Object.freeze([
  "queued",
  "liveClaims",
  "indeterminate",
  "unknown",
  "settlementPending",
]);
const THRESHOLD_FIELDS = Object.freeze([
  "maxCpuPercent",
  "minMemoryFreeBytes",
  "minMysqlConnectionsFree",
  "productionP95LatencyMs",
  "maxLatencyIncreasePercent",
]);
function failure() {
  return new Error("installed Phase 3 rollout evidence production failed");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${label} fields must be enumerable data properties`);
    }
  }
  return value;
}

function assertStrictJson(value, label, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
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
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new Error(`${label} contains a sparse or extended array`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error(`${label} array items must be enumerable data properties`);
      }
      assertStrictJson(descriptor.value, `${label}[${index}]`, seen);
    }
  } else {
    if (!isPlainObject(value)) throw new Error(`${label} contains a non-plain object`);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error(`${label} object fields must be enumerable data properties`);
      }
      assertStrictJson(descriptor.value, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
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

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value) || value === ZERO_HASH) {
    throw new Error(`${label} must be a concrete SHA-256 hash`);
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID.test(value) || /(?:TODO|TBD|UNKNOWN|<[^>]+>)/i.test(value)) {
    throw new Error(`${label} must be a concrete bounded identifier`);
  }
}

function ownDataValue(value, field, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain record`);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new Error(`${label}.${field} must be an enumerable data property`);
  }
  return descriptor.value;
}

function isExactMissing(error) {
  if (!error || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(descriptor && Object.hasOwn(descriptor, "value") && descriptor.value === "ENOENT");
}

async function optionalRead(operation) {
  try {
    return { present: true, record: await operation() };
  } catch (error) {
    if (isExactMissing(error)) return { present: false, record: null };
    throw error;
  }
}

function assertInvocation(input, callerArguments) {
  assertExactDataRecord(input, ["journalSnapshot"], "Phase 3 semantic producer input");
  assertStrictJson(input, "Phase 3 semantic producer input");
  if (callerArguments.length === 0) return null;
  if (process.env.NODE_ENV !== "test" || callerArguments.length !== 1) {
    throw new Error("Phase 3 semantic producer accepts one argument in production");
  }
  const ports = callerArguments[0];
  assertExactDataRecord(ports, PORT_NAMES, "test-only Phase 3 semantic producer ports");
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  if (PORT_NAMES.some((name) => typeof descriptors[name].value !== "function")) {
    throw new Error("test-only Phase 3 semantic producer ports must be complete functions");
  }
  return Object.freeze(Object.fromEntries(PORT_NAMES.map((name) => [name, descriptors[name].value])));
}

function normalizeStorageRecord(record, label) {
  assertExactDataRecord(record, ["path", "value", "bytes", "sha256"], label);
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error(`${label} path is invalid`);
  }
  assertStrictJson(record.value, `${label} value`);
  if (
    typeof record.bytes !== "string" ||
    record.bytes !== canonicalJson(record.value) ||
    record.sha256 !== sha256Text(record.bytes)
  ) throw new Error(`${label} stable bytes changed`);
  return freezeClone(record);
}

function normalizeMarkerRecord(record, kind, id, expected) {
  const idField = kind === "action" ? "actionId" : "observationId";
  assertExactDataRecord(record, [idField, "path", "value", "bytes", "sha256"], `${kind} marker record`);
  if (record[idField] !== id || typeof record.path !== "string" || record.path.length === 0) {
    throw new Error(`${kind} marker storage identity changed`);
  }
  assertStrictJson(record.value, `${kind} marker value`);
  if (
    typeof record.bytes !== "string" ||
    record.bytes !== canonicalJson(record.value) ||
    record.sha256 !== sha256Text(record.bytes)
  ) throw new Error(`${kind} marker stable bytes changed`);
  const captured = freezeClone(record);
  if (kind === "action") validatePhase3ActionMeasurement(captured.value, expected);
  else validatePhase3ObservationMarker(captured.value, expected);
  return captured;
}

function normalizeObservationSet(value, expected) {
  assertExactDataRecord(value, ["schema", "fence"], "Phase 3 observation marker set");
  return freezeClone({
    schema: normalizeMarkerRecord(value.schema, "observation", "phase3-schema-verify", expected),
    fence: normalizeMarkerRecord(value.fence, "observation", "phase3-fence-ack-wait", expected),
  });
}

function normalizeActionSet(value, expected) {
  if (!Array.isArray(value) || value.length !== PHASE3_ACTION_IDS.length) {
    throw new Error("Phase 3 action marker set is incomplete");
  }
  const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new Error("Phase 3 action marker set is not a strict ordered array");
  }
  return freezeClone(PHASE3_ACTION_IDS.map((actionId, index) =>
    normalizeMarkerRecord(value[index], "action", actionId, expected)));
}

function normalizeSourceSet(value, expectedContext) {
  assertExactDataRecord(value, [...PHASE3_RUNTIME_SOURCE_IDS], "Phase 3 runtime source set");
  if (Object.keys(value).some((key, index) => key !== PHASE3_RUNTIME_SOURCE_IDS[index])) {
    throw new Error("Phase 3 runtime source set order changed");
  }
  const result = {};
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    const record = value[sourceId];
    assertExactDataRecord(record, ["value", "bytes", "sha256"], `runtime source ${sourceId}`);
    assertStrictJson(record.value, `runtime source ${sourceId} value`);
    if (
      typeof record.bytes !== "string" ||
      record.bytes !== canonicalJson(record.value) ||
      record.sha256 !== sha256Text(record.bytes)
    ) throw new Error(`runtime source ${sourceId} stable bytes changed`);
    const captured = freezeClone(record);
    validatePhase3RuntimeSourceValue(sourceId, captured.value, expectedContext);
    result[sourceId] = captured;
  }
  return freezeClone(result);
}

function validateContext(value) {
  assertExactDataRecord(
    value,
    ["installedBinding", "envelope", "artifacts", "verified", "descriptor"],
    "installed approved staging context",
  );
  const loadedBinding = ownDataValue(value, "installedBinding", "installed approved staging context");
  assertStrictJson(loadedBinding, "installed release binding");
  const binding = freezeClone(loadedBinding);
  validateReleaseBinding(binding);
  if (binding.environment !== "staging" || binding.composeProject !== "spx-staging") {
    throw new Error("installed release is not the fixed staging target");
  }
  const envelope = ownDataValue(value, "envelope", "installed approved staging context");
  const verified = ownDataValue(value, "verified", "installed approved staging context");
  const descriptor = ownDataValue(value, "descriptor", "installed approved staging context");
  assertStrictJson(envelope, "staging approval envelope");
  assertStrictJson(verified, "verified staging context");
  assertStrictJson(descriptor, "staging target descriptor");
  assertExactDataRecord(
    verified,
    [
      "approvalId", "stagingRunId", "envelopeSha256", "releaseManifestSha256",
      "rollbackReleaseManifestSha256", "targetDescriptorSha256", "operatorBundleSha256",
      "candidateSha", "imageDigest", "environment", "composeProject", "topology",
      "actions", "envelope",
    ],
    "verified staging context",
  );
  assertInstalledBindingMatchesVerified(binding, verified);
  const approvalId = ownDataValue(verified, "approvalId", "verified staging context");
  const envelopeApprovalId = ownDataValue(envelope, "approvalId", "staging approval envelope");
  assertId(approvalId, "verified approval ID");
  if (envelopeApprovalId !== approvalId) throw new Error("approved staging approval identity changed");
  const rollbackReleaseManifestSha256 = ownDataValue(
    verified,
    "rollbackReleaseManifestSha256",
    "verified staging context",
  );
  assertHash(rollbackReleaseManifestSha256, "rollback release manifest hash");
  const envelopeRelease = ownDataValue(envelope, "release", "staging approval envelope");
  const envelopeTarget = ownDataValue(envelope, "target", "staging approval envelope");
  const verifiedEnvelope = ownDataValue(verified, "envelope", "verified staging context");
  const verifiedActions = ownDataValue(verified, "actions", "verified staging context");
  if (
    !canonicalEqual(verifiedEnvelope, envelope) ||
    !canonicalEqual(verifiedActions, ownDataValue(envelope, "actions", "staging approval envelope")) ||
    envelopeRelease.candidateSha !== verified.candidateSha ||
    envelopeRelease.candidateImageDigest !== verified.imageDigest ||
    envelopeRelease.releaseManifestSha256 !== verified.releaseManifestSha256 ||
    envelopeRelease.rollbackReleaseManifestSha256 !== rollbackReleaseManifestSha256 ||
    envelopeRelease.operatorBundleSha256 !== verified.operatorBundleSha256 ||
    envelopeTarget.environment !== verified.environment ||
    envelopeTarget.composeProject !== verified.composeProject ||
    envelopeTarget.targetDescriptorSha256 !== verified.targetDescriptorSha256
  ) throw new Error("verified staging envelope release identity changed");
  const policy = ownDataValue(envelope, "policy", "staging approval envelope");
  const thresholds = ownDataValue(policy, "thresholds", "staging approval policy");
  const approvedThresholds = {};
  for (const field of THRESHOLD_FIELDS) {
    const threshold = ownDataValue(thresholds, field, "approved capacity thresholds");
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
      throw new Error("approved capacity threshold is invalid");
    }
    approvedThresholds[field] = threshold;
  }
  if (
    ownDataValue(descriptor, "releaseEnvironment", "staging target descriptor") !== "staging" ||
    ownDataValue(descriptor, "runtimeEnvironment", "staging target descriptor") !== "staging" ||
    ownDataValue(descriptor, "composeProject", "staging target descriptor") !== "spx-staging"
  ) throw new Error("installed staging target descriptor identity changed");
  const target = ownDataValue(descriptor, "target", "staging target descriptor");
  const hostIdentitySha256 = ownDataValue(target, "hostIdentitySha256", "staging target descriptor target");
  const productionObserverPolicySha256 = ownDataValue(
    target,
    "productionObserverPolicySha256",
    "staging target descriptor target",
  );
  assertHash(hostIdentitySha256, "signed A3 host identity hash");
  assertHash(productionObserverPolicySha256, "production observer policy hash");
  return freezeClone({
    binding,
    approvalId,
    rollbackReleaseManifestSha256,
    approvedThresholds,
    hostIdentitySha256,
    productionObserverPolicySha256,
  });
}

function validateCapability(value, binding) {
  assertStrictJson(value, "installed Phase 3 capability");
  validateStagingActionCapability(value, binding);
  return freezeClone(value);
}

function validateHostIdentity(value, expected) {
  if (typeof value !== "string" || value !== expected || !HASH.test(value) || value === ZERO_HASH) {
    throw new Error("installed A3 host identity changed");
  }
  return value;
}

function monotonicNowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function validateLeases(value, stagingRunId) {
  assertExactDataRecord(value, ["stagingRunId", "guard", "watchdog", "maxAgeMs"], "loaded staging leases");
  if (value.stagingRunId !== stagingRunId || value.maxAgeMs !== MAX_LEASE_AGE_MS) {
    throw new Error("loaded leases are not bound to the fixed rollout");
  }
  const trustedNow = monotonicNowMs();
  for (const role of ["guard", "watchdog"]) {
    const lease = value[role];
    assertExactDataRecord(
      lease,
      [
        "schemaVersion", "role", "state", "breachCount", "baselineP95LatencyMs",
        "leaseId", "stagingRunId", "pid", "startedMonotonicMs", "heartbeatMonotonicMs",
        "heartbeatAgeMs",
      ],
      `${role} lease`,
    );
    assertId(lease.leaseId, `${role} lease ID`);
    if (
      lease.schemaVersion !== 1 || lease.role !== role || lease.state !== "armed" ||
      lease.breachCount !== 0 || lease.stagingRunId !== stagingRunId ||
      !Number.isSafeInteger(lease.pid) || lease.pid <= 0 ||
      !Number.isSafeInteger(lease.startedMonotonicMs) || lease.startedMonotonicMs < 0 ||
      !Number.isSafeInteger(lease.heartbeatMonotonicMs) ||
      lease.heartbeatMonotonicMs < lease.startedMonotonicMs ||
      lease.heartbeatMonotonicMs > trustedNow ||
      trustedNow - lease.heartbeatMonotonicMs > MAX_LEASE_AGE_MS ||
      typeof lease.heartbeatAgeMs !== "number" || !Number.isFinite(lease.heartbeatAgeMs) ||
      lease.heartbeatAgeMs < 0 || lease.heartbeatAgeMs > MAX_LEASE_AGE_MS
    ) throw new Error(`${role} lease is not continuously fresh`);
    if (
      (role === "guard" &&
        !(typeof lease.baselineP95LatencyMs === "number" &&
          Number.isFinite(lease.baselineP95LatencyMs) && lease.baselineP95LatencyMs > 0)) ||
      (role === "watchdog" && lease.baselineP95LatencyMs !== null &&
        !(typeof lease.baselineP95LatencyMs === "number" &&
          Number.isFinite(lease.baselineP95LatencyMs) && lease.baselineP95LatencyMs > 0))
    ) throw new Error(`${role} lease baseline is invalid`);
  }
  if (value.guard.leaseId === value.watchdog.leaseId) throw new Error("loaded lease IDs are not distinct");
  return freezeClone(value);
}

async function loadFixedHostIdentity() {
  const parentPath = dirname(HOST_IDENTITY_PATH);
  const [parentBefore, fileBefore, parentCanonical, fileCanonical] = await Promise.all([
    lstat(parentPath, { bigint: true }),
    lstat(HOST_IDENTITY_PATH, { bigint: true }),
    realpath(parentPath),
    realpath(HOST_IDENTITY_PATH),
  ]);
  if (
    parentBefore.isSymbolicLink() || !parentBefore.isDirectory() ||
    fileBefore.isSymbolicLink() || !fileBefore.isFile() ||
    resolve(parentCanonical) !== resolve(parentPath) ||
    resolve(fileCanonical) !== resolve(HOST_IDENTITY_PATH) ||
    fileBefore.size < 64n || fileBefore.size > 65n
  ) throw new Error("installed A3 host identity file is invalid");
  if (
    process.platform !== "win32" &&
    (parentBefore.uid !== 0n || Number(parentBefore.mode & 0o077n) !== 0 ||
      fileBefore.uid !== 0n ||
      ![0o400, 0o600].includes(Number(fileBefore.mode & 0o777n)))
  ) throw new Error("installed A3 host identity file is not root-private");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(HOST_IDENTITY_PATH, constants.O_RDONLY | noFollow);
  let text;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== fileBefore.dev || opened.ino !== fileBefore.ino || opened.size !== fileBefore.size) {
      throw new Error("installed A3 host identity file changed");
    }
    text = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
    ) throw new Error("installed A3 host identity file changed");
  } finally {
    await handle.close();
  }
  const [parentAfter, fileAfter, finalCanonical] = await Promise.all([
    lstat(parentPath, { bigint: true }),
    lstat(HOST_IDENTITY_PATH, { bigint: true }),
    realpath(HOST_IDENTITY_PATH),
  ]);
  if (
    parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino ||
    parentAfter.mtimeNs !== parentBefore.mtimeNs || parentAfter.ctimeNs !== parentBefore.ctimeNs ||
    fileAfter.isSymbolicLink() || !fileAfter.isFile() ||
    fileAfter.dev !== fileBefore.dev || fileAfter.ino !== fileBefore.ino ||
    fileAfter.size !== fileBefore.size || fileAfter.mtimeNs !== fileBefore.mtimeNs ||
    fileAfter.ctimeNs !== fileBefore.ctimeNs || resolve(finalCanonical) !== resolve(HOST_IDENTITY_PATH)
  ) {
    throw new Error("installed A3 host identity directory changed");
  }
  if (text !== text.trim() && text !== `${text.trim()}\n`) {
    throw new Error("installed A3 host identity content is invalid");
  }
  const identity = text.trim();
  assertHash(identity, "installed A3 host identity");
  return identity;
}

function defaultPorts(testPorts) {
  if (testPorts) return testPorts;
  return Object.freeze({
    loadContext: loadInstalledApprovedStagingContext,
    loadCapability: (binding) => loadInstalledStagingActionCapability(binding),
    loadHostIdentity: loadFixedHostIdentity,
    loadLeases: (stagingRunId) => loadStagingLeases(stagingRunId),
    recoverSnapshot: () => recoverPhase3ActionJournalSnapshotStorage(),
    recoverSemantic: () => recoverPhase3SemanticEvidenceStorage(),
    readSnapshot: () => readPhase3ActionJournalSnapshot(),
    writeSnapshot: (value) => writePhase3ActionJournalSnapshot(value),
    readObservationMarkers: (expected) => readPhase3ObservationMarkers(expected),
    readActionMeasurements: (expected) => readPhase3ActionMeasurements(expected),
    readSources: () => readPhase3RuntimeSources(),
    readSemantic: () => readPhase3SemanticEvidence(),
    writeSemantic: (value) => writePhase3SemanticEvidence(value),
  });
}

function assertSnapshotRecord(record, candidateBytes, metadata) {
  const captured = normalizeStorageRecord(record, "Phase 3 journal snapshot storage record");
  validatePhase3PreGate4JournalSnapshot(captured.value, {
    installedBinding: metadata.binding,
    approvalId: metadata.approvalId,
  });
  if (captured.bytes !== candidateBytes) throw new Error("durable Phase 3 journal snapshot changed");
  return captured;
}

function sourceContext(metadata, capability, projection, actionRecords, leases) {
  const generation = actionRecords[3].value.generation;
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("Phase 3 generation is invalid");
  }
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
    teamId: capability.phase3.canaryTeamId,
    epoch: capability.phase3.canaryEpoch,
    generation,
    windowStartedAt: projection.windowStartedAt,
    windowEndedAt: projection.windowEndedAt,
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
  });
}

function assertTimeline(projection, actions) {
  let previous = Date.parse(projection.windowStartedAt);
  for (const [index, actionId] of PHASE3_ACTION_IDS.entries()) {
    const terminal = projection.phase3Actions[index];
    const completed = Date.parse(terminal.completedAt);
    if (
      terminal.actionId !== actionId || !Number.isFinite(completed) || completed <= Date.parse(projection.windowStartedAt) ||
      completed < previous || terminal.terminalRecordSha256 !== actions[index].value.terminalRecordSha256 ||
      terminal.completedAt !== actions[index].value.completedAt ||
      terminal.mutationSha256 !== actions[index].value.mutationSha256
    ) throw new Error("Phase 3 action timeline changed");
    previous = completed;
  }
  if (projection.inlineRestore.actionId !== PHASE3_ACTION_IDS.at(-1)) {
    throw new Error("Phase 3 inline restore projection changed");
  }
  if (Date.parse(actions[2].value.completedAt) <= Date.parse(actions[0].value.completedAt)) {
    throw new Error("Phase 3 producer did not start after the consumer");
  }
}

function assertMarkerRelationships(metadata, projection, observations, actions, expectedContext) {
  if (
    observations.schema.value.terminalRecordSha256 !== projection.gate3.terminalRecordSha256 ||
    observations.schema.value.rollbackReleaseManifestSha256 !== metadata.rollbackReleaseManifestSha256 ||
    observations.fence.value.rollbackReleaseManifestSha256 !== metadata.rollbackReleaseManifestSha256
  ) throw new Error("Phase 3 observation release or terminal binding changed");
  const generation = expectedContext.generation;
  for (const [index, action] of actions.entries()) {
    if ((index < 3 && action.value.generation !== null) || (index >= 3 && action.value.generation !== generation)) {
      throw new Error("Phase 3 marker generation changed");
    }
  }
  const fenceAction = actions[5].value;
  const fenceObservation = observations.fence.value.measurements;
  const publicationFence = fenceAction.measurements.control;
  const drainFence = actions[6].value.measurements.control;
  const restoreFence = actions[7].value.measurements.control;
  if (
    observations.fence.value.terminalRecordSha256 !== fenceAction.terminalRecordSha256 ||
    observations.fence.value.generation !== generation ||
    fenceObservation.publicationGeneration !== generation ||
    publicationFence.fenceJobId !== fenceObservation.fenceJobId ||
    drainFence.fenceJobId !== fenceObservation.fenceJobId ||
    drainFence.ackJobId !== fenceObservation.ackJobId ||
    drainFence.acknowledgedAt !== fenceObservation.acknowledgedAt ||
    restoreFence.fenceJobId !== fenceObservation.fenceJobId ||
    restoreFence.ackJobId !== fenceObservation.ackJobId ||
    restoreFence.acknowledgedAt !== fenceObservation.acknowledgedAt
  ) throw new Error("Phase 3 fence observation changed");
  assertTimeline(projection, actions);
}

function assertLeaseContinuity(continuity, leases, observations, actions) {
  for (const role of ["guard", "watchdog"]) {
    for (const field of ["leaseId", "pid", "startedMonotonicMs", "baselineP95LatencyMs"]) {
      if (
        continuity.before[role][field] !== continuity.after[role][field] ||
        continuity.after[role][field] !== leases[role][field]
      ) throw new Error("Phase 3 lease instance changed");
    }
    if (
      continuity.after[role].heartbeatMonotonicMs < continuity.before[role].heartbeatMonotonicMs ||
      leases[role].heartbeatMonotonicMs < continuity.after[role].heartbeatMonotonicMs
    ) throw new Error("Phase 3 lease heartbeat moved backward");
  }
  if (continuity.sameInstance !== true || continuity.heartbeatNondecreasing !== true || continuity.zeroGap !== true) {
    throw new Error("Phase 3 lease continuity failed");
  }
  for (const [index, record] of [observations.schema, observations.fence].entries()) {
    if (continuity.markerBindings.observations[index].markerSha256 !== record.sha256) {
      throw new Error("Phase 3 observation continuity hash changed");
    }
  }
  for (const [index, record] of actions.entries()) {
    if (continuity.markerBindings.actions[index].markerSha256 !== record.sha256) {
      throw new Error("Phase 3 action continuity hash changed");
    }
  }
}

function assertPassingSources(metadata, context, sources, observations, actions, leases) {
  const database = sources["db-final"].value.database;
  const runtime = sources["runtime-final"].value.runtime;
  const continuity = sources["lease-continuity"].value.continuity;
  const capacity = sources.capacity.value.capacity;
  const observer = sources["production-observer"].value.productionObserver;
  if (
    database.ok !== true || database.control.generation !== context.generation ||
    database.control.state !== "fenced" || database.control.pollerNodeMatches !== true ||
    database.staleEpochActions !== 0 || database.directPollerAccepts !== 0 ||
    DRAIN_FIELDS.some((field) => database.drain[field] !== 0) ||
    DUPLICATE_FIELDS.some((field) => database.duplicates[field] !== 0)
  ) throw new Error("Phase 3 database evidence is not Gate 4 passing");
  const fence = observations.fence.value.measurements;
  const drainControl = actions[6].value.measurements.control;
  const finalControl = actions[7].value.measurements.control;
  if (
    database.control.fenceJobId !== fence.fenceJobId ||
    database.control.ackJobId !== fence.ackJobId ||
    database.control.acknowledgedAt !== fence.acknowledgedAt ||
    database.control.fenceJobId !== drainControl.fenceJobId ||
    database.control.ackJobId !== drainControl.ackJobId ||
    database.control.acknowledgedAt !== drainControl.acknowledgedAt ||
    database.control.fenceJobId !== finalControl.fenceJobId ||
    database.control.ackJobId !== finalControl.ackJobId ||
    database.control.acknowledgedAt !== finalControl.acknowledgedAt
  ) throw new Error("Phase 3 database fence corroboration changed");
  if (
    runtime.remainingPhase3RuntimeCount !== 0 ||
    runtime.restoredLegacyOwner.ownerNodeId !== database.inlineLease.ownerNodeId ||
    runtime.restoredLegacyOwner.activeOwnerCount !== database.inlineLease.activeOwnerCount ||
    runtime.restoredLegacyOwner.ownerMatches !== database.inlineLease.ownerMatches ||
    actions[7].value.measurements.lease.ownerNodeId !== database.inlineLease.ownerNodeId
  ) throw new Error("Phase 3 restored runtime owner changed");
  assertLeaseContinuity(continuity, leases, observations, actions);
  const expectedApproved = {
    maxCpuPercent: metadata.approvedThresholds.maxCpuPercent,
    minMemoryFreeBytes: metadata.approvedThresholds.minMemoryFreeBytes,
    minMysqlConnectionsFree: metadata.approvedThresholds.minMysqlConnectionsFree,
    maxProductionP95LatencyMs: metadata.approvedThresholds.productionP95LatencyMs,
    maxLatencyIncreasePercent: metadata.approvedThresholds.maxLatencyIncreasePercent,
  };
  if (
    !canonicalEqual(capacity.thresholds.envelopeApproved, expectedApproved) ||
    observer.expectedPolicySha256 !== metadata.productionObserverPolicySha256 ||
    capacity.observedAt !== observer.observedAt ||
    capacity.measurements.productionP95LatencyMs !== observer.response.p95LatencyMs ||
    capacity.measurements.productionBaselineP95LatencyMs !== leases.guard.baselineP95LatencyMs ||
    Date.parse(capacity.observedAt) < Date.parse(context.windowEndedAt) ||
    Date.parse(capacity.observedAt) > Date.now() + 5 * 60_000 ||
    capacity.ok !== true || capacity.failures.length !== 0 || observer.response.ready !== true ||
    observer.thresholdResult.absoluteP95WithinApprovedLimit !== true ||
    observer.thresholdResult.latencyIncreaseWithinApprovedLimit !== true ||
    observer.thresholdResult.passed !== true
  ) throw new Error("Phase 3 capacity or production observer evidence is not Gate 4 passing");
  const increase = ((capacity.measurements.productionP95LatencyMs -
    capacity.measurements.productionBaselineP95LatencyMs) /
    capacity.measurements.productionBaselineP95LatencyMs) * 100;
  if (capacity.measurements.productionLatencyIncreasePercent !== increase) {
    throw new Error("Phase 3 production latency increase changed");
  }
}

function buildSemantic(metadata, capability, snapshotRecord, projection, observations, actions, sources) {
  const database = sources["db-final"].value.database;
  const context = sources["db-final"].value.context;
  const required = PHASE3_ACTION_IDS.map((actionId, index) => ({
    actionId,
    status: "succeeded",
    occurrences: 1,
    terminalRecordSha256: projection.phase3Actions[index].terminalRecordSha256,
    completedAt: projection.phase3Actions[index].completedAt,
    measurementSha256: actions[index].sha256,
  }));
  return freezeClone({
    schemaVersion: 2,
    release: metadata.binding,
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    drillMode: "staging",
    composeProject: "spx-staging",
    stagingRunId: metadata.binding.stagingRunId,
    approvalEnvelopeSha256: metadata.binding.stagingApprovalEnvelopeSha256,
    targetDescriptor: {
      signed: true,
      environment: "staging",
      composeProject: "spx-staging",
      sha256: metadata.binding.stagingTargetDescriptorSha256,
    },
    operatorBundle: { installed: true, sha256: metadata.binding.operatorBundleSha256 },
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
      teamId: capability.phase3.canaryTeamId,
      historyRetained: true,
      activeEpoch: capability.phase3.canaryEpoch,
      activeGeneration: context.generation,
      staleEpochActions: database.staleEpochActions,
    },
    fence: {
      state: database.control.state,
      fenceJobId: database.control.fenceJobId,
      ackJobId: database.control.ackJobId,
      generation: database.control.generation,
      pollerNodeMatches: database.control.pollerNodeMatches,
      acknowledgedAt: database.control.acknowledgedAt,
    },
    drain: Object.fromEntries(DRAIN_FIELDS.map((field) => [field, database.drain[field]])),
    rollback: { inlineOwnerRestored: true },
    duplicates: Object.fromEntries(DUPLICATE_FIELDS.map((field) => [field, database.duplicates[field]])),
    artifactBindings: {
      journalSnapshotSha256: snapshotRecord.sha256,
      schemaObservationSha256: observations.schema.sha256,
      fenceObservationSha256: observations.fence.sha256,
      actionMeasurements: PHASE3_ACTION_IDS.map((actionId, index) => ({
        actionId,
        sha256: actions[index].sha256,
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
      headSha256: metadata.binding.actionJournalHeadSha256,
      snapshotSha256: snapshotRecord.sha256,
      required,
      pending: 0,
      ambiguous: 0,
      replayed: 0,
      extra: 0,
    },
    timeline: required.map(({ actionId, completedAt }) => ({ actionId, completedAt })),
  });
}

function assertSameRecord(left, right, label) {
  if (
    left.bytes !== right.bytes || left.sha256 !== right.sha256 ||
    !canonicalEqual(left.value, right.value)
  ) throw new Error(`${label} changed during stable reread`);
}

function orderedSourceHashes(snapshot, observations, actions, runtimeSources) {
  const entries = [
    ["phase3-journal-snapshot", snapshot.sha256],
    ["phase3-schema-marker", observations.schema.sha256],
    ["phase3-fence-marker", observations.fence.sha256],
    ...PHASE3_ACTION_IDS.map((actionId, index) => [`phase3-action:${actionId}`, actions[index].sha256]),
    ...PHASE3_RUNTIME_SOURCE_IDS.map((sourceId) => [`phase3-${sourceId}`, runtimeSources[sourceId].sha256]),
  ];
  if (
    entries.length !== PHASE3_SEMANTIC_SOURCE_IDS.length ||
    entries.some(([sourceId], index) => sourceId !== PHASE3_SEMANTIC_SOURCE_IDS[index])
  ) throw new Error("Phase 3 semantic source identity order changed");
  return freezeClone(Object.fromEntries(entries));
}

async function produce(input, callerArguments) {
  const testPorts = assertInvocation(input, callerArguments);
  const capturedInput = freezeClone(input);
  const ports = defaultPorts(testPorts);
  const metadata = validateContext(await ports.loadContext());
  const capability = validateCapability(await ports.loadCapability(structuredClone(metadata.binding)), metadata.binding);
  const initialHostIdentity = validateHostIdentity(
    await ports.loadHostIdentity(),
    metadata.hostIdentitySha256,
  );
  const projection = validatePhase3PreGate4JournalSnapshot(capturedInput.journalSnapshot, {
    installedBinding: metadata.binding,
    approvalId: metadata.approvalId,
  });
  if (metadata.binding.actionJournalHeadSha256 !== capturedInput.journalSnapshot.headSha256) {
    throw new Error("installed Phase 3 journal head is not the inline restore head");
  }
  const fixedPartition = phase3PartitionIdentity(
    capability.phase3.canaryTeamId,
    capability.phase3.canaryEpoch,
  );

  await ports.recoverSnapshot();
  await ports.recoverSemantic();
  const preflightSnapshotAttempt = await optionalRead(() => ports.readSnapshot());
  const preflightSemanticAttempt = await optionalRead(() => ports.readSemantic());
  if (preflightSemanticAttempt.present && !preflightSnapshotAttempt.present) {
    throw new Error("semantic evidence exists without its journal snapshot");
  }
  const snapshotCandidateBytes = canonicalJson(capturedInput.journalSnapshot);
  if (preflightSnapshotAttempt.present) {
    assertSnapshotRecord(preflightSnapshotAttempt.record, snapshotCandidateBytes, metadata);
  }
  const preflightSemantic = preflightSemanticAttempt.present
    ? normalizeStorageRecord(preflightSemanticAttempt.record, "Phase 3 semantic evidence record")
    : null;
  const writtenSnapshot = assertSnapshotRecord(
    await ports.writeSnapshot(structuredClone(capturedInput.journalSnapshot)),
    snapshotCandidateBytes,
    metadata,
  );
  const snapshotRecord = assertSnapshotRecord(
    await ports.readSnapshot(),
    snapshotCandidateBytes,
    metadata,
  );
  assertSameRecord(writtenSnapshot, snapshotRecord, "Phase 3 journal snapshot");

  const leases = validateLeases(await ports.loadLeases(metadata.binding.stagingRunId), metadata.binding.stagingRunId);
  const expectedMarkers = freezeClone({
    position: "historical",
    journalSnapshot: snapshotRecord.value,
    installedBinding: metadata.binding,
    approvalId: metadata.approvalId,
    rollbackReleaseManifestSha256: metadata.rollbackReleaseManifestSha256,
    leases,
    partition: fixedPartition,
    nowMs: Date.now(),
  });
  const observations = normalizeObservationSet(
    await ports.readObservationMarkers(structuredClone(expectedMarkers)),
    expectedMarkers,
  );
  const actions = normalizeActionSet(
    await ports.readActionMeasurements(structuredClone(expectedMarkers)),
    expectedMarkers,
  );
  const commonContext = sourceContext(metadata, capability, projection, actions, leases);
  assertMarkerRelationships(metadata, projection, observations, actions, commonContext);
  const runtimeSources = normalizeSourceSet(await ports.readSources(), commonContext);
  assertPassingSources(metadata, commonContext, runtimeSources, observations, actions, leases);

  const semanticCandidate = buildSemantic(
    metadata,
    capability,
    snapshotRecord,
    projection,
    observations,
    actions,
    runtimeSources,
  );
  const semanticBytes = canonicalJson(semanticCandidate);
  const semanticSha256 = sha256Text(semanticBytes);
  let semanticWinner;
  if (preflightSemantic) {
    semanticWinner = preflightSemantic;
    if (semanticWinner.bytes !== semanticBytes || semanticWinner.sha256 !== semanticSha256) {
      throw new Error("installed Phase 3 semantic winner conflicts with the candidate");
    }
  } else {
    semanticWinner = normalizeStorageRecord(
      await ports.writeSemantic(structuredClone(semanticCandidate)),
      "Phase 3 semantic evidence record",
    );
    if (semanticWinner.bytes !== semanticBytes || semanticWinner.sha256 !== semanticSha256) {
      throw new Error("Phase 3 semantic evidence changed during publication");
    }
  }
  const reopenedSemantic = normalizeStorageRecord(
    await ports.readSemantic(),
    "Phase 3 semantic evidence record",
  );
  assertSameRecord(semanticWinner, reopenedSemantic, "Phase 3 semantic evidence");
  if (reopenedSemantic.bytes !== semanticBytes || reopenedSemantic.sha256 !== semanticSha256) {
    throw new Error("Phase 3 semantic evidence differs from its candidate");
  }

  const finalHostIdentity = validateHostIdentity(await ports.loadHostIdentity(), metadata.hostIdentitySha256);
  if (finalHostIdentity !== initialHostIdentity) throw new Error("installed A3 host identity changed");
  const finalSnapshot = assertSnapshotRecord(await ports.readSnapshot(), snapshotCandidateBytes, metadata);
  assertSameRecord(snapshotRecord, finalSnapshot, "Phase 3 journal snapshot");
  const finalObservations = normalizeObservationSet(
    await ports.readObservationMarkers(structuredClone(expectedMarkers)),
    expectedMarkers,
  );
  const finalActions = normalizeActionSet(
    await ports.readActionMeasurements(structuredClone(expectedMarkers)),
    expectedMarkers,
  );
  const finalSources = normalizeSourceSet(await ports.readSources(), commonContext);
  const finalSemantic = normalizeStorageRecord(await ports.readSemantic(), "Phase 3 semantic evidence record");
  assertSameRecord(observations.schema, finalObservations.schema, "Phase 3 schema observation");
  assertSameRecord(observations.fence, finalObservations.fence, "Phase 3 fence observation");
  for (const [index, actionId] of PHASE3_ACTION_IDS.entries()) {
    assertSameRecord(actions[index], finalActions[index], `Phase 3 action ${actionId}`);
  }
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    assertSameRecord(runtimeSources[sourceId], finalSources[sourceId], `Phase 3 runtime source ${sourceId}`);
  }
  assertSameRecord(reopenedSemantic, finalSemantic, "Phase 3 semantic evidence");

  return freezeClone({
    evidence: semanticCandidate,
    bytes: semanticBytes,
    sha256: semanticSha256,
    sources: orderedSourceHashes(snapshotRecord, observations, actions, runtimeSources),
  });
}

export async function produceInstalledPhase3RolloutEvidence(input, ...callerArguments) {
  try {
    return await produce(input, callerArguments);
  } catch {
    throw failure();
  }
}
