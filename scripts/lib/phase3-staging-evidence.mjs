import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, validateReleaseBinding } from "./evidence-artifact.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "./staging-action-plan.mjs";

const ACTION_ROOT = "/var/lib/spx-staging-rollout/phase3-action-measurements";
const OBSERVATION_ROOT = "/var/lib/spx-staging-rollout/phase3-observations";
const TEMP_ROOT = "/var/lib/spx-staging-rollout/.phase3-marker-tmp";
const ROLLOUT_ROOT = "/var/lib/spx-staging-rollout";
const EVIDENCE_ROOT = `${ROLLOUT_ROOT}/evidence`;
const RUNTIME_SOURCE_ROOT = `${EVIDENCE_ROOT}/phase3-sources`;
const RUNTIME_SOURCE_TEMP_ROOT = `${EVIDENCE_ROOT}/.phase3-source-tmp`;
const CAPACITY_OBSERVATION_PATH =
  "/var/lib/spx-staging-rollout/evidence/phase3-capacity-observation/capacity-observation.json";
const CAPACITY_OBSERVATION_ROOT = dirname(CAPACITY_OBSERVATION_PATH);
const CAPACITY_OBSERVATION_TEMP_ROOT =
  "/var/lib/spx-staging-rollout/evidence/.phase3-capacity-observation-tmp";
const CAPACITY_OBSERVATION_FILE = "capacity-observation.json";
const PHASE3_SNAPSHOT_PATH = `${EVIDENCE_ROOT}/phase3-snapshot/journal-snapshot.json`;
const PHASE3_SNAPSHOT_ROOT = dirname(PHASE3_SNAPSHOT_PATH);
const PHASE3_SNAPSHOT_TEMP_ROOT = `${EVIDENCE_ROOT}/.phase3-snapshot-tmp`;
const PHASE3_SNAPSHOT_FILE = "journal-snapshot.json";
const PHASE3_SEMANTIC_PATH = `${EVIDENCE_ROOT}/phase3-staging/phase3-rollout-evidence.json`;
const PHASE3_SEMANTIC_ROOT = dirname(PHASE3_SEMANTIC_PATH);
const PHASE3_SEMANTIC_TEMP_ROOT = `${EVIDENCE_ROOT}/.phase3-staging-tmp`;
const PHASE3_SEMANTIC_FILE = "phase3-rollout-evidence.json";
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_RUNTIME_SOURCE_BYTES = 128 * 1024;
const MAX_PHASE3_SINGLETON_BYTES = 512 * 1024;
const MAX_TEMP_ENTRIES = 64;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_MARKER_AGE_MS = 24 * 60 * 60_000;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_TEMP =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ZERO_HASH = "0".repeat(64);
const ACTION_FIELDS = Object.freeze([
  "schemaVersion",
  "actionId",
  "mutationSha256",
  "terminalRecordSha256",
  "completedAt",
  "observedAt",
  "releaseBinding",
  "guardLeaseId",
  "watchdogLeaseId",
  "teamId",
  "epoch",
  "generation",
  "measurements",
]);
const OBSERVATION_FIELDS = Object.freeze([
  "schemaVersion",
  "observationId",
  "requiredTerminalActionId",
  "terminalRecordSha256",
  "actionJournalHeadSha256",
  "stagingRunId",
  "teamId",
  "epoch",
  "pollerNodeId",
  "approvalEnvelopeSha256",
  "releaseManifestSha256",
  "rollbackReleaseManifestSha256",
  "targetDescriptorSha256",
  "operatorBundleSha256",
  "guardLeaseId",
  "watchdogLeaseId",
  "generation",
  "observedAt",
  "measurements",
]);
const RELEASE_FIELDS = Object.freeze([
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "stagingTargetDescriptorSha256",
  "operatorBundleSha256",
  "stagingApprovalEnvelopeSha256",
  "stagingRunId",
]);
const PARTITION_FIELDS = Object.freeze([
  "teamId",
  "epoch",
  "pollerService",
  "pollerNodeId",
  "consumerService",
  "consumerNodeId",
  "legacyService",
  "legacyNodeId",
]);
const EXPECTED_FIELDS = Object.freeze([
  "position",
  "journalSnapshot",
  "installedBinding",
  "approvalId",
  "rollbackReleaseManifestSha256",
  "leases",
  "partition",
  "nowMs",
]);
const SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion",
  "binding",
  "recordCount",
  "headSha256",
  "actions",
]);
const SNAPSHOT_BINDING_FIELDS = Object.freeze([
  "approvalId",
  "stagingRunId",
  "approvalEnvelopeSha256",
  "targetDescriptorSha256",
  "operatorBundleSha256",
]);
const SNAPSHOT_ACTION_FIELDS = Object.freeze([
  "sequence",
  "actionId",
  "scope",
  "kind",
  "mutationSha256",
  "state",
  "occurrences",
  "terminalRecordSha256",
  "completedAt",
  "reconciliationId",
  "reconciliationOutcome",
]);
const LEASE_FIELDS = Object.freeze(["stagingRunId", "guard", "watchdog", "maxAgeMs"]);
const LEASE_ENTRY_FIELDS = Object.freeze([
  "schemaVersion",
  "role",
  "state",
  "breachCount",
  "baselineP95LatencyMs",
  "leaseId",
  "stagingRunId",
  "pid",
  "startedMonotonicMs",
  "heartbeatMonotonicMs",
  "heartbeatAgeMs",
]);
const IDENTITY_FIELDS = Object.freeze([
  "service",
  "nodeId",
  "status",
  "health",
  "imageId",
  "labels",
  "realWorkerEnabled",
  "settlementWorkerEnabled",
]);
const INLINE_IDENTITY_FIELDS = Object.freeze([
  "service",
  "nodeId",
  "status",
  "health",
  "imageId",
  "labels",
]);
const LABEL_FIELDS = Object.freeze([
  "composeProject",
  "composeService",
  "environment",
  "releaseSha",
  "targetDescriptorSha256",
  "operatorBundleSha256",
  "stagingRunId",
]);
const CONTROL_FIELDS = Object.freeze([
  "state",
  "pollerNodeId",
  "isActive",
  "activeEpoch",
  "activeGeneration",
  "publicationGeneration",
  "fenceJobId",
  "ackNodeId",
  "ackJobId",
  "acknowledgedAt",
]);
const DRAIN_FIELDS = Object.freeze([
  "queued",
  "liveClaims",
  "indeterminate",
  "unknown",
  "settlementPending",
]);
const OBSERVATION_IDS = Object.freeze([
  "phase3-schema-verify",
  "phase3-fence-ack-wait",
]);
const SECRET_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const FORBIDDEN_KEY = /^(?:env|environmentVariables|payload|message|error|url|endpoint|command|sql)$/i;
const SECRET_VALUE = [
  /^(?:authorization|cookie|credential|password|private.?key|secret|token)$/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
];
const FORBIDDEN_VALUE = [
  /(?:https?|mysql|postgres(?:ql)?):\/\//i,
  /\b(?:select|insert|update|delete|drop|alter|create)\s+\S+/i,
  /\b(?:curl|wget|powershell|cmd\.exe|bash)\s+\S+/i,
];
const FORBIDDEN_SOURCE_KEY = /^(?:payloads?|messages?|errors?|bod(?:y|ies)|response[-_]?bod(?:y|ies)|env|environments?|environment[-_]?maps?|environment[-_]?variables?|urls?|endpoints?|commands?|sql)$/i;
const FORBIDDEN_PROTOTYPE_KEY = new Set(["__proto__", "prototype", "constructor"]);
const PLACEHOLDER_TOKEN =
  /(?:^|[^\p{L}\p{N}\p{M}])(?:TODO|TBD|UNKNOWN|REDACTED)(?=$|[^\p{L}\p{N}\p{M}])/iu;
const ANGLE_BRACKET_PLACEHOLDER = /<[^<>\r\n]+>/u;

export const PHASE3_ACTION_IDS = deepFreeze([
  "phase3-consumer-start-disabled",
  "phase3-legacy-lease-release",
  "phase3-poller-start",
  "phase3-publication-enable",
  "phase3-execution-enable",
  "phase3-publication-fence",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
]);

export const PHASE3_RUNTIME_SOURCE_IDS = deepFreeze([
  "db-final",
  "runtime-final",
  "lease-continuity",
  "capacity",
  "production-observer",
]);

export const PHASE3_SEMANTIC_SOURCE_IDS = deepFreeze([
  "phase3-journal-snapshot",
  "phase3-schema-marker",
  "phase3-fence-marker",
  ...PHASE3_ACTION_IDS.map((actionId) => `phase3-action:${actionId}`),
  "phase3-db-final",
  "phase3-runtime-final",
  "phase3-lease-continuity",
  "phase3-capacity",
  "phase3-production-observer",
]);

const NULL_GENERATION_ACTIONS = new Set(PHASE3_ACTION_IDS.slice(0, 3));
const PHASE3_ACTION_SET = new Set(PHASE3_ACTION_IDS);
const PHASE3_RUNTIME_SOURCE_SET = new Set(PHASE3_RUNTIME_SOURCE_IDS);
const RUNTIME_SOURCE_PAYLOAD_FIELDS = Object.freeze({
  "db-final": "database",
  "runtime-final": "runtime",
  "lease-continuity": "continuity",
  capacity: "capacity",
  "production-observer": "productionObserver",
});
const RUNTIME_SOURCE_TEMP = new RegExp(
  `^(${PHASE3_RUNTIME_SOURCE_IDS.join("|")})\\.(${UUID_PATTERN})\\.tmp$`,
);
const CAPACITY_OBSERVATION_TEMP = new RegExp(
  `^capacity-observation\\.(${UUID_PATTERN})\\.tmp$`,
);
const PHASE3_SNAPSHOT_TEMP = new RegExp(
  `^journal-snapshot\\.(${UUID_PATTERN})\\.tmp$`,
);
const PHASE3_SEMANTIC_TEMP = new RegExp(
  `^phase3-rollout-evidence\\.(${UUID_PATTERN})\\.tmp$`,
);
const SNAPSHOT_STATES = new Set([
  "registered",
  "ambiguous",
  "succeeded",
  "failed",
  "reconciled",
  "compensated",
]);
const SNAPSHOT_KINDS = new Set(["forward", "compensation", "emergency"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function assertExactObject(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error(`${label} has an invalid symbol field`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an invalid or unknown field`);
  }
}

function assertNoExtraArguments(extra, label) {
  if (extra.length !== 0) throw new Error(`${label} does not accept options or extra arguments`);
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value) || value === ZERO_HASH) {
    throw new Error(`${label} must be a non-zero SHA-256 hash`);
  }
}

function assertCommitSha(value, label) {
  if (typeof value !== "string" || !COMMIT_SHA.test(value) || /^0+$/.test(value)) {
    throw new Error(`${label} must be a non-zero lowercase commit SHA`);
  }
}

function assertImageDigest(value, label) {
  if (
    typeof value !== "string" ||
    !IMAGE_DIGEST.test(value) ||
    value === `sha256:${ZERO_HASH}`
  ) {
    throw new Error(`${label} must be a non-zero immutable image digest`);
  }
}

function assertId(value, label) {
  if (
    typeof value !== "string" ||
    !SAFE_ID.test(value) ||
    /(?:\bTODO\b|\bTBD\b|<[^>]+>)/i.test(value)
  ) {
    throw new Error(`${label} must be a concrete bounded identifier`);
  }
}

function assertNonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function parseIso(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a finite ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a finite ISO timestamp`);
  }
  return milliseconds;
}

function scanMarker(value, path = "$", seen = new Set()) {
  if (typeof value === "string") {
    if (value.length > 512) throw new Error(`marker string at ${path} is oversized`);
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("marker contains secret-shaped content");
    }
    if (FORBIDDEN_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("marker contains a URL, endpoint, command, or SQL text");
    }
    if (value === ZERO_HASH || value === `sha256:${ZERO_HASH}`) {
      throw new Error("marker contains a zero hash");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`marker number at ${path} is not finite`);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`marker value at ${path} is not an admissible JSON object`);
  }
  if (seen.has(value)) throw new Error("marker contains a cycle");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || FORBIDDEN_KEY.test(key)) {
      throw new Error("marker contains a secret, payload, message, environment, URL, command, or SQL field");
    }
    if (key === "environment" && isPlainObject(child)) {
      throw new Error("marker contains a raw environment map");
    }
    scanMarker(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function assertRuntimeSourceProperty(key, descriptor, path) {
  if (typeof key !== "string") {
    throw new Error(`Phase 3 runtime source at ${path} contains a symbol property`);
  }
  if (!descriptor.enumerable) {
    throw new Error(`Phase 3 runtime source property ${path}.${key} must be enumerable`);
  }
  if (!Object.hasOwn(descriptor, "value")) {
    throw new Error(`Phase 3 runtime source property ${path}.${key} must not be an accessor`);
  }
  if (FORBIDDEN_PROTOTYPE_KEY.has(key)) {
    throw new Error(`Phase 3 runtime source contains forbidden prototype key ${key}`);
  }
  if (SECRET_KEY.test(key) || FORBIDDEN_SOURCE_KEY.test(key)) {
    throw new Error(
      "Phase 3 runtime source contains a secret, payload, message, error, body, environment, URL, endpoint, command, or SQL field",
    );
  }
}

function scanRuntimeSource(value, path = "$", seen = new Set(), topLevel = true) {
  if (typeof value === "string") {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("Phase 3 runtime source contains secret-shaped content");
    }
    if (FORBIDDEN_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("Phase 3 runtime source contains a URL, endpoint, command, or SQL text");
    }
    if (PLACEHOLDER_TOKEN.test(value) || ANGLE_BRACKET_PLACEHOLDER.test(value)) {
      throw new Error("Phase 3 runtime source contains placeholder content");
    }
    return;
  }
  if (value === null || typeof value === "boolean") {
    if (topLevel) throw new Error("Phase 3 runtime source value must be a plain top-level object");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Phase 3 runtime source number at ${path} must be finite`);
    }
    if (topLevel) throw new Error("Phase 3 runtime source value must be a plain top-level object");
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Phase 3 runtime source value at ${path} is not admissible JSON`);
  }
  if (seen.has(value)) throw new Error("Phase 3 runtime source contains a cycle");

  if (Array.isArray(value)) {
    if (topLevel) throw new Error("Phase 3 runtime source value must be a plain top-level object");
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`Phase 3 runtime source array at ${path} has an invalid prototype`);
    }
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
    const actualKeys = keys.filter((key) => key !== "length");
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new Error(`Phase 3 runtime source array at ${path} must be dense without extra properties`);
    }
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) throw new Error(`Phase 3 runtime source array at ${path} is sparse`);
      assertRuntimeSourceProperty(key, descriptor, path);
      scanRuntimeSource(descriptor.value, `${path}[${key}]`, seen, false);
    }
    seen.delete(value);
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error(`Phase 3 runtime source object at ${path} must be plain`);
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new Error(`Phase 3 runtime source property at ${path} disappeared`);
    assertRuntimeSourceProperty(key, descriptor, path);
    scanRuntimeSource(descriptor.value, `${path}.${key}`, seen, false);
  }
  seen.delete(value);
}

function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function snapshotAction(snapshot, actionId) {
  const matches = snapshot.actions.filter((entry) => entry.actionId === actionId);
  if (matches.length !== 1) throw new Error(`journal snapshot must contain action ${actionId} exactly once`);
  const action = matches[0];
  if (
    action.kind !== "forward" ||
    action.state !== "succeeded" ||
    action.occurrences !== 1 ||
    action.reconciliationId !== null ||
    action.reconciliationOutcome !== null ||
    typeof action.terminalRecordSha256 !== "string" ||
    typeof action.completedAt !== "string"
  ) {
    throw new Error(`journal action ${actionId} is not an ordinary succeeded terminal`);
  }
  assertHash(action.mutationSha256, `${actionId} mutation hash`);
  assertHash(action.terminalRecordSha256, `${actionId} terminal hash`);
  parseIso(action.completedAt, `${actionId} completion time`);
  return action;
}

function validateSnapshot(snapshot, binding, approvalId) {
  assertExactObject(snapshot, SNAPSHOT_FIELDS, "action journal snapshot");
  if (snapshot.schemaVersion !== 1) throw new Error("action journal snapshot schema version is invalid");
  assertExactObject(snapshot.binding, SNAPSHOT_BINDING_FIELDS, "action journal snapshot binding");
  assertId(snapshot.binding.approvalId, "action journal approval ID");
  assertId(snapshot.binding.stagingRunId, "action journal staging run ID");
  assertHash(snapshot.binding.approvalEnvelopeSha256, "action journal approval envelope hash");
  assertHash(snapshot.binding.targetDescriptorSha256, "action journal target descriptor hash");
  assertHash(snapshot.binding.operatorBundleSha256, "action journal operator bundle hash");
  if (
    snapshot.binding.approvalId !== approvalId ||
    snapshot.binding.stagingRunId !== binding.stagingRunId ||
    snapshot.binding.approvalEnvelopeSha256 !== binding.stagingApprovalEnvelopeSha256 ||
    snapshot.binding.targetDescriptorSha256 !== binding.stagingTargetDescriptorSha256 ||
    snapshot.binding.operatorBundleSha256 !== binding.operatorBundleSha256
  ) {
    throw new Error("action journal snapshot binding does not match the installed release");
  }
  assertPositiveSafeInteger(snapshot.recordCount, "action journal record count");
  assertHash(snapshot.headSha256, "action journal head hash");
  if (!Array.isArray(snapshot.actions) || snapshot.actions.length === 0) {
    throw new Error("action journal snapshot actions are invalid");
  }
  if (snapshot.recordCount < snapshot.actions.length) {
    throw new Error("action journal record count is smaller than its action set");
  }
  const sequences = new Set();
  const actionIds = new Set();
  for (const [index, entry] of snapshot.actions.entries()) {
    assertExactObject(entry, SNAPSHOT_ACTION_FIELDS, "action journal snapshot action");
    assertPositiveSafeInteger(entry.sequence, "action sequence");
    if (entry.sequence !== index + 1) {
      throw new Error("journal action sequence must be contiguous from one");
    }
    assertId(entry.actionId, "journal action ID");
    assertId(entry.scope, "journal action scope");
    assertId(entry.kind, "journal action kind");
    if (!SNAPSHOT_KINDS.has(entry.kind)) throw new Error("journal action kind is invalid");
    assertHash(entry.mutationSha256, "journal action mutation hash");
    if (!SNAPSHOT_STATES.has(entry.state)) throw new Error("journal action state is invalid");
    assertNonnegativeSafeInteger(entry.occurrences, "journal action occurrences");
    if (entry.terminalRecordSha256 !== null) {
      assertHash(entry.terminalRecordSha256, "journal action terminal hash");
    }
    if (entry.completedAt !== null) parseIso(entry.completedAt, "journal action completion time");
    if (entry.reconciliationId !== null) assertId(entry.reconciliationId, "reconciliation ID");
    if (entry.reconciliationOutcome !== null) {
      assertId(entry.reconciliationOutcome, "reconciliation outcome");
    }
    const hasTerminal = entry.state === "succeeded" || entry.state === "reconciled";
    if (
      (hasTerminal &&
        (entry.occurrences !== 1 ||
          entry.terminalRecordSha256 === null ||
          entry.completedAt === null)) ||
      (!hasTerminal &&
        (entry.occurrences !== 0 ||
          entry.terminalRecordSha256 !== null ||
          entry.completedAt !== null)) ||
      (entry.state === "reconciled" &&
        (entry.reconciliationId === null || entry.reconciliationOutcome !== "succeeded")) ||
      (entry.state !== "reconciled" &&
        (entry.reconciliationId !== null || entry.reconciliationOutcome !== null))
    ) throw new Error("journal action terminal and reconciliation fields are inconsistent");
    if (sequences.has(entry.sequence) || actionIds.has(entry.actionId)) {
      throw new Error("journal snapshot contains a duplicate sequence or action ID");
    }
    sequences.add(entry.sequence);
    actionIds.add(entry.actionId);
  }
  return snapshot;
}

function validateInstalledBinding(value) {
  validateReleaseBinding(value);
  if (value.environment !== "staging") throw new Error("installed release binding must be staging");
  assertCommitSha(value.candidateSha, "candidate SHA");
  assertImageDigest(value.imageDigest, "image digest");
  for (const field of [
    "releaseManifestSha256",
    "stagingTargetDescriptorSha256",
    "operatorBundleSha256",
    "stagingApprovalEnvelopeSha256",
    "actionJournalHeadSha256",
  ]) assertHash(value[field], `installed binding ${field}`);
  assertId(value.stagingRunId, "installed staging run ID");
  return value;
}

function validateLeaseEntry(value, role, stagingRunId, maxAgeMs) {
  assertExactObject(value, LEASE_ENTRY_FIELDS, `${role} lease`);
  if (value.schemaVersion !== 1 || value.role !== role || value.state !== "armed") {
    throw new Error(`${role} lease must be the armed loaded lease`);
  }
  assertNonnegativeSafeInteger(value.breachCount, `${role} lease breach count`);
  if (
    value.baselineP95LatencyMs !== null &&
    (!Number.isFinite(value.baselineP95LatencyMs) || value.baselineP95LatencyMs <= 0)
  ) throw new Error(`${role} lease baseline latency is invalid`);
  assertId(value.leaseId, `${role} lease ID`);
  assertId(value.stagingRunId, `${role} lease staging run ID`);
  if (value.stagingRunId !== stagingRunId) throw new Error(`${role} lease belongs to another rollout`);
  assertPositiveSafeInteger(value.pid, `${role} lease process ID`);
  assertNonnegativeSafeInteger(value.startedMonotonicMs, `${role} lease start time`);
  assertNonnegativeSafeInteger(value.heartbeatMonotonicMs, `${role} lease heartbeat time`);
  if (value.heartbeatMonotonicMs < value.startedMonotonicMs) {
    throw new Error(`${role} lease heartbeat precedes its start`);
  }
  if (
    !Number.isFinite(value.heartbeatAgeMs) ||
    value.heartbeatAgeMs < 0 ||
    value.heartbeatAgeMs > maxAgeMs
  ) throw new Error(`${role} lease is not fresh`);
  return value;
}

function validateLeases(value, stagingRunId) {
  assertExactObject(value, LEASE_FIELDS, "loaded staging leases");
  assertId(value.stagingRunId, "loaded lease staging run ID");
  if (value.stagingRunId !== stagingRunId) throw new Error("loaded leases belong to another rollout");
  if (!Number.isFinite(value.maxAgeMs) || value.maxAgeMs <= 0) {
    throw new Error("loaded lease maximum age must be positive and finite");
  }
  validateLeaseEntry(value.guard, "guard", stagingRunId, value.maxAgeMs);
  validateLeaseEntry(value.watchdog, "watchdog", stagingRunId, value.maxAgeMs);
  if (value.guard.leaseId === value.watchdog.leaseId) {
    throw new Error("guard and watchdog leases must be distinct");
  }
  return value;
}

export function phase3PartitionIdentity(teamId, epoch, ...extra) {
  assertNoExtraArguments(extra, "phase3PartitionIdentity");
  if (teamId !== 1 && teamId !== 2) throw new Error("Phase 3 partition team must be 1 or 2");
  assertId(epoch, "Phase 3 partition epoch");
  const suffix = teamId === 1 ? "ptwl" : "ifn";
  return freezeClone({
    teamId,
    epoch,
    pollerService: `poller-${suffix}-phase3`,
    pollerNodeId: `stg-poller-${suffix}-phase3-1`,
    consumerService: `auto-accept-${suffix}-phase3`,
    consumerNodeId: `stg-auto-accept-${suffix}-phase3-1`,
    legacyService: `worker-${suffix}-split`,
    legacyNodeId: `stg-worker-${suffix}-split-1`,
  });
}

function validateExpected(expected) {
  assertExactObject(expected, EXPECTED_FIELDS, "Phase 3 marker expected context");
  if (expected.position !== "current" && expected.position !== "historical") {
    throw new Error("Phase 3 marker expected position is invalid");
  }
  if (!Number.isSafeInteger(expected.nowMs) || expected.nowMs < 0) {
    throw new Error("Phase 3 marker trusted clock must be a finite safe integer");
  }
  const binding = validateInstalledBinding(expected.installedBinding);
  assertId(expected.approvalId, "installed approval ID");
  assertHash(expected.rollbackReleaseManifestSha256, "rollback release manifest hash");
  const snapshot = validateSnapshot(expected.journalSnapshot, binding, expected.approvalId);
  if (binding.actionJournalHeadSha256 !== snapshot.headSha256) {
    throw new Error("installed action journal head does not match the trusted snapshot");
  }
  assertExactObject(expected.partition, PARTITION_FIELDS, "Phase 3 partition identity");
  const fixedPartition = phase3PartitionIdentity(expected.partition.teamId, expected.partition.epoch);
  if (!sameCanonical(expected.partition, fixedPartition)) {
    throw new Error("Phase 3 partition identity is not the code-owned identity");
  }
  validateLeases(expected.leases, binding.stagingRunId);
  return {
    position: expected.position,
    nowMs: expected.nowMs,
    journalSnapshot: snapshot,
    installedBinding: binding,
    approvalId: expected.approvalId,
    rollbackReleaseManifestSha256: expected.rollbackReleaseManifestSha256,
    leases: expected.leases,
    partition: fixedPartition,
  };
}

function validateObservedAt(observedAt, completedAt, expected) {
  const completedMs = parseIso(completedAt, "marker completion time");
  const observedMs = parseIso(observedAt, "marker observation time");
  if (observedMs < completedMs) throw new Error("marker observation precedes action completion");
  if (observedMs > expected.nowMs + MAX_FUTURE_SKEW_MS) {
    throw new Error("marker observation is unreasonably in the future");
  }
  if (expected.nowMs - observedMs > MAX_MARKER_AGE_MS) {
    throw new Error("marker observation is stale");
  }
}

function validateReleaseTuple(value, binding) {
  assertExactObject(value, RELEASE_FIELDS, "Phase 3 marker release binding");
  assertCommitSha(value.candidateSha, "marker candidate SHA");
  assertImageDigest(value.imageDigest, "marker image digest");
  for (const field of [
    "releaseManifestSha256",
    "stagingTargetDescriptorSha256",
    "operatorBundleSha256",
    "stagingApprovalEnvelopeSha256",
  ]) assertHash(value[field], `marker release ${field}`);
  assertId(value.stagingRunId, "marker staging run ID");
  const installedTuple = Object.fromEntries(RELEASE_FIELDS.map((field) => [field, binding[field]]));
  if (!sameCanonical(value, installedTuple)) {
    throw new Error("marker release binding does not match the installed immutable release");
  }
}

function validateLabels(value, service, binding) {
  assertExactObject(value, LABEL_FIELDS, "container labels");
  const exact = {
    composeProject: "spx-staging",
    composeService: service,
    environment: "staging",
    releaseSha: binding.candidateSha,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    stagingRunId: binding.stagingRunId,
  };
  if (!sameCanonical(value, exact)) throw new Error("container labels do not match the installed release");
}

function validateIdentity(value, service, nodeId, binding, workerEnabled, options = {}) {
  const fields = options.cutoverEpoch === undefined
    ? (options.inline === true ? INLINE_IDENTITY_FIELDS : IDENTITY_FIELDS)
    : [...IDENTITY_FIELDS, "cutoverEpoch"];
  assertExactObject(value, fields, "container identity");
  if (
    value.service !== service ||
    value.nodeId !== nodeId ||
    value.status !== "running" ||
    value.health !== "healthy" ||
    value.imageId !== binding.imageDigest
  ) throw new Error("container identity does not match the fixed healthy service");
  validateLabels(value.labels, service, binding);
  if (options.inline !== true) {
    if (
      value.realWorkerEnabled !== workerEnabled ||
      value.settlementWorkerEnabled !== workerEnabled
    ) throw new Error("container worker flags do not match the action postcondition");
  }
  if (options.cutoverEpoch !== undefined && value.cutoverEpoch !== options.cutoverEpoch) {
    throw new Error("poller cutover epoch does not match the fixed partition");
  }
}

function validateControl(value, generation, partition, requiredState, requireAcknowledged) {
  assertExactObject(value, CONTROL_FIELDS, "Phase 3 publication control");
  if (
    value.state !== requiredState ||
    value.pollerNodeId !== partition.pollerNodeId ||
    value.isActive !== true ||
    value.activeEpoch !== partition.epoch ||
    value.activeGeneration !== generation ||
    value.publicationGeneration !== generation
  ) throw new Error("Phase 3 publication control does not match the fixed partition generation");
  assertPositiveSafeInteger(value.activeGeneration, "active generation");
  assertPositiveSafeInteger(value.publicationGeneration, "publication generation");
  if (requiredState === "enabled") {
    if (
      value.fenceJobId !== null ||
      value.ackNodeId !== null ||
      value.ackJobId !== null ||
      value.acknowledgedAt !== null
    ) throw new Error("enabled publication control must not contain a fence acknowledgment");
    return;
  }
  assertNonnegativeSafeInteger(value.fenceJobId, "fence job ID");
  const allNull =
    value.ackNodeId === null && value.ackJobId === null && value.acknowledgedAt === null;
  const allPresent =
    value.ackNodeId !== null && value.ackJobId !== null && value.acknowledgedAt !== null;
  if ((!allNull && !allPresent) || (requireAcknowledged && !allPresent)) {
    throw new Error("fenced publication acknowledgment tuple is incomplete");
  }
  if (allPresent) {
    if (value.ackNodeId !== partition.pollerNodeId) {
      throw new Error("fence acknowledgment node is invalid");
    }
    assertNonnegativeSafeInteger(value.ackJobId, "acknowledgment job ID");
    if (value.ackJobId < value.fenceJobId) throw new Error("acknowledgment precedes the fence");
    parseIso(value.acknowledgedAt, "fence acknowledgment time");
  }
}

function validateZeroDrain(value) {
  assertExactObject(value, DRAIN_FIELDS, "Phase 3 drain measurement");
  for (const field of DRAIN_FIELDS) {
    if (value[field] !== 0) throw new Error("Phase 3 drain counts must all be zero");
  }
}

function validateActionMeasurements(actionId, value, generation, expected) {
  const partition = expected.partition;
  const binding = expected.installedBinding;
  switch (actionId) {
    case "phase3-consumer-start-disabled":
      assertExactObject(value, ["consumer"], "consumer-start-disabled measurements");
      validateIdentity(value.consumer, partition.consumerService, partition.consumerNodeId, binding, false);
      break;
    case "phase3-legacy-lease-release":
      assertExactObject(value, ["lease"], "legacy-lease-release measurements");
      assertExactObject(
        value.lease,
        ["activeOwnerCount", "ownerNodeId", "legacyOwnerActive"],
        "released legacy lease measurement",
      );
      if (
        value.lease.activeOwnerCount !== 0 ||
        value.lease.ownerNodeId !== null ||
        value.lease.legacyOwnerActive !== false
      ) throw new Error("legacy owner lease has not been released");
      break;
    case "phase3-poller-start":
      assertExactObject(value, ["poller"], "poller-start measurements");
      validateIdentity(value.poller, partition.pollerService, partition.pollerNodeId, binding, false, {
        cutoverEpoch: partition.epoch,
      });
      break;
    case "phase3-publication-enable":
      assertExactObject(value, ["control"], "publication-enable measurements");
      validateControl(value.control, generation, partition, "enabled", false);
      break;
    case "phase3-execution-enable":
      assertExactObject(value, ["consumer"], "execution-enable measurements");
      validateIdentity(value.consumer, partition.consumerService, partition.consumerNodeId, binding, true);
      break;
    case "phase3-publication-fence":
      assertExactObject(value, ["control"], "publication-fence measurements");
      validateControl(value.control, generation, partition, "fenced", false);
      break;
    case "phase3-drain-or-quarantine":
      assertExactObject(value, ["control", "drain"], "drain-or-quarantine measurements");
      validateControl(value.control, generation, partition, "fenced", true);
      validateZeroDrain(value.drain);
      break;
    case "phase3-inline-owner-restore":
      assertExactObject(
        value,
        ["control", "drain", "lease", "services"],
        "inline-owner-restore measurements",
      );
      validateControl(value.control, generation, partition, "fenced", true);
      validateZeroDrain(value.drain);
      assertExactObject(
        value.lease,
        ["activeOwnerCount", "ownerNodeId", "status"],
        "restored inline lease",
      );
      if (
        value.lease.activeOwnerCount !== 1 ||
        value.lease.ownerNodeId !== partition.legacyNodeId ||
        value.lease.status !== "active"
      ) throw new Error("inline owner lease is not restored");
      assertExactObject(value.services, ["poller", "consumer", "inline"], "restored services");
      for (const [name, service, nodeId] of [
        ["poller", partition.pollerService, partition.pollerNodeId],
        ["consumer", partition.consumerService, partition.consumerNodeId],
      ]) {
        assertExactObject(value.services[name], ["service", "nodeId", "running"], `${name} stop state`);
        if (
          value.services[name].service !== service ||
          value.services[name].nodeId !== nodeId ||
          value.services[name].running !== false
        ) throw new Error(`${name} Phase 3 service is not stopped`);
      }
      validateIdentity(
        value.services.inline,
        partition.legacyService,
        partition.legacyNodeId,
        binding,
        false,
        { inline: true },
      );
      break;
    default:
      throw new Error("Phase 3 action ID is invalid");
  }
}

function validateActionWithExpected(value, expected) {
  assertExactObject(value, ACTION_FIELDS, "Phase 3 action measurement marker");
  scanMarker(value);
  if (value.schemaVersion !== 1 || !PHASE3_ACTION_SET.has(value.actionId)) {
    throw new Error("Phase 3 action marker identity is invalid");
  }
  const terminal = snapshotAction(expected.journalSnapshot, value.actionId);
  if (
    expected.position === "current" &&
    terminal.terminalRecordSha256 !== expected.journalSnapshot.headSha256
  ) throw new Error("current Phase 3 action is not the journal head terminal");
  if (
    value.mutationSha256 !== terminal.mutationSha256 ||
    value.terminalRecordSha256 !== terminal.terminalRecordSha256 ||
    value.completedAt !== terminal.completedAt
  ) throw new Error("Phase 3 marker does not match its authenticated journal terminal tuple");
  assertHash(value.mutationSha256, "marker mutation hash");
  assertHash(value.terminalRecordSha256, "marker terminal hash");
  validateObservedAt(value.observedAt, value.completedAt, expected);
  validateReleaseTuple(value.releaseBinding, expected.installedBinding);
  if (
    value.guardLeaseId !== expected.leases.guard.leaseId ||
    value.watchdogLeaseId !== expected.leases.watchdog.leaseId
  ) throw new Error("Phase 3 marker lease IDs do not match the fresh leases");
  if (value.teamId !== expected.partition.teamId || value.epoch !== expected.partition.epoch) {
    throw new Error("Phase 3 marker does not match the fixed canary partition");
  }
  if (NULL_GENERATION_ACTIONS.has(value.actionId)) {
    if (value.generation !== null) throw new Error("Phase 3 action generation must be null");
  } else {
    assertPositiveSafeInteger(value.generation, "Phase 3 action generation");
  }
  validateActionMeasurements(value.actionId, value.measurements, value.generation, expected);
  return freezeClone(value);
}

export function validatePhase3ActionMeasurement(value, expected, ...extra) {
  assertNoExtraArguments(extra, "validatePhase3ActionMeasurement");
  return validateActionWithExpected(value, validateExpected(expected));
}

function validateSchemaObservationMeasurements(value) {
  assertExactObject(value, [
    "candidateSchemaVersion",
    "schemaMaximum",
    "rollbackSchemaMinimum",
    "rollbackSchemaMaximum",
    "candidateSchemaRangeDeclared",
    "nMinusOneSchemaRangeDeclared",
    "migration035ChecksumMatches",
    "pendingMigrations",
    "runningMigrations",
    "failedMigrations",
    "observerReadOnly",
  ], "schema observation measurements");
  for (const field of [
    "candidateSchemaVersion",
    "schemaMaximum",
    "rollbackSchemaMinimum",
    "rollbackSchemaMaximum",
    "pendingMigrations",
    "runningMigrations",
    "failedMigrations",
  ]) assertNonnegativeSafeInteger(value[field], `schema observation ${field}`);
  for (const field of [
    "candidateSchemaRangeDeclared",
    "nMinusOneSchemaRangeDeclared",
    "migration035ChecksumMatches",
    "observerReadOnly",
  ]) {
    if (value[field] !== true) throw new Error(`schema observation ${field} must be true`);
  }
  if (
    value.pendingMigrations !== 0 ||
    value.runningMigrations !== 0 ||
    value.failedMigrations !== 0
  ) throw new Error("schema observation migration counts must all be zero");
  if (
    value.candidateSchemaVersion !== value.schemaMaximum ||
    value.rollbackSchemaMinimum > value.rollbackSchemaMaximum ||
    value.schemaMaximum < value.rollbackSchemaMinimum ||
    value.schemaMaximum > value.rollbackSchemaMaximum
  ) throw new Error("candidate schema is outside the declared rollback schema range");
}

function validateFenceObservationMeasurements(value, generation, partition) {
  assertExactObject(value, [
    "state",
    "publicationGeneration",
    "fenceJobId",
    "ackJobId",
    "pollerNodeId",
    "ackNodeId",
    "acknowledgedAt",
    "isActive",
    "observerReadOnly",
  ], "fence acknowledgment observation measurements");
  if (
    value.state !== "fenced" ||
    value.publicationGeneration !== generation ||
    value.pollerNodeId !== partition.pollerNodeId ||
    value.ackNodeId !== partition.pollerNodeId ||
    value.isActive !== true ||
    value.observerReadOnly !== true
  ) throw new Error("fence acknowledgment observation does not match the fixed poller");
  assertPositiveSafeInteger(value.publicationGeneration, "fence publication generation");
  assertNonnegativeSafeInteger(value.fenceJobId, "fence observation job ID");
  assertNonnegativeSafeInteger(value.ackJobId, "fence observation acknowledgment job ID");
  if (value.ackJobId < value.fenceJobId) throw new Error("fence observation acknowledgment precedes fence");
  parseIso(value.acknowledgedAt, "fence observation acknowledgment time");
}

function validateObservationWithExpected(value, expected) {
  assertExactObject(value, OBSERVATION_FIELDS, "Phase 3 observation marker");
  scanMarker(value);
  if (value.schemaVersion !== 1 || !OBSERVATION_IDS.includes(value.observationId)) {
    throw new Error("Phase 3 observation identity is invalid");
  }
  const requiredTerminalActionId = value.observationId === "phase3-schema-verify"
    ? "staging-gate-3-handoff"
    : "phase3-publication-fence";
  if (value.requiredTerminalActionId !== requiredTerminalActionId) {
    throw new Error("Phase 3 observation is bound to the wrong terminal action");
  }
  const terminal = snapshotAction(expected.journalSnapshot, requiredTerminalActionId);
  if (
    expected.position === "current" &&
    terminal.terminalRecordSha256 !== expected.journalSnapshot.headSha256
  ) throw new Error("current Phase 3 observation is not the journal head terminal");
  if (
    value.terminalRecordSha256 !== terminal.terminalRecordSha256 ||
    value.actionJournalHeadSha256 !== terminal.terminalRecordSha256
  ) throw new Error("Phase 3 observation terminal hashes do not match the authenticated action");
  if (
    value.stagingRunId !== expected.installedBinding.stagingRunId ||
    value.teamId !== expected.partition.teamId ||
    value.epoch !== expected.partition.epoch ||
    value.pollerNodeId !== expected.partition.pollerNodeId ||
    value.approvalEnvelopeSha256 !== expected.installedBinding.stagingApprovalEnvelopeSha256 ||
    value.releaseManifestSha256 !== expected.installedBinding.releaseManifestSha256 ||
    value.rollbackReleaseManifestSha256 !== expected.rollbackReleaseManifestSha256 ||
    value.targetDescriptorSha256 !== expected.installedBinding.stagingTargetDescriptorSha256 ||
    value.operatorBundleSha256 !== expected.installedBinding.operatorBundleSha256 ||
    value.guardLeaseId !== expected.leases.guard.leaseId ||
    value.watchdogLeaseId !== expected.leases.watchdog.leaseId
  ) throw new Error("Phase 3 observation binding, partition, release, or leases do not match");
  validateObservedAt(value.observedAt, terminal.completedAt, expected);
  if (value.observationId === "phase3-schema-verify") {
    if (value.generation !== null) throw new Error("schema observation generation must be null");
    validateSchemaObservationMeasurements(value.measurements);
  } else {
    assertPositiveSafeInteger(value.generation, "fence observation generation");
    validateFenceObservationMeasurements(value.measurements, value.generation, expected.partition);
  }
  return freezeClone(value);
}

export function validatePhase3ObservationMarker(value, expected, ...extra) {
  assertNoExtraArguments(extra, "validatePhase3ObservationMarker");
  return validateObservationWithExpected(value, validateExpected(expected));
}

function validateOptionsObject(options, allowed, label) {
  if (!isPlainObject(options)) throw new Error(`${label} options must be a plain object`);
  if (Object.getOwnPropertySymbols(options).length !== 0) {
    throw new Error(`${label} options contain an unknown symbol field`);
  }
  const keys = Object.keys(options).sort();
  const allowedSet = new Set(allowed);
  if (keys.some((key) => !allowedSet.has(key))) {
    throw new Error(`${label} options contain an unknown field`);
  }
  return keys;
}

function validateReadOptions(options, productionRoot, label) {
  const keys = validateOptionsObject(options, ["rootPath"], label);
  if (keys.length === 0) return { rootPath: productionRoot, testOverride: false };
  if (process.env.NODE_ENV !== "test") throw new Error(`${label} root override is test-only`);
  if (typeof options.rootPath !== "string" || !isAbsolute(options.rootPath)) {
    throw new Error(`${label} root override must be absolute`);
  }
  return { rootPath: resolve(options.rootPath), testOverride: true };
}

function validateWriteOptions(options, productionRoot, label) {
  const keys = validateOptionsObject(options, ["rootPath", "tempRootPath"], label);
  if (keys.length === 0) {
    return { rootPath: productionRoot, tempRootPath: TEMP_ROOT, testOverride: false };
  }
  if (keys.length !== 2 || !keys.includes("rootPath") || !keys.includes("tempRootPath")) {
    throw new Error("Phase 3 marker root and temporary root overrides must appear together");
  }
  if (process.env.NODE_ENV !== "test") throw new Error("Phase 3 marker root overrides are test-only");
  if (
    typeof options.rootPath !== "string" ||
    typeof options.tempRootPath !== "string" ||
    !isAbsolute(options.rootPath) ||
    !isAbsolute(options.tempRootPath)
  ) throw new Error("Phase 3 marker root overrides must be absolute");
  const rootPath = resolve(options.rootPath);
  const tempRootPath = resolve(options.tempRootPath);
  if (
    comparablePath(rootPath) === comparablePath(tempRootPath) ||
    comparablePath(dirname(rootPath)) !== comparablePath(dirname(tempRootPath))
  ) throw new Error("Phase 3 marker roots must be distinct sibling directories with one parent");
  return { rootPath, tempRootPath, testOverride: true };
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameInodeAndSize(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function expectedOwnerUid(testOverride) {
  if (!testOverride) return 0n;
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

function assertOwnerAndMode(status, mode, testOverride, label) {
  if (process.platform === "win32") return;
  if (Number(status.mode & 0o777n) !== mode) {
    throw new Error(`${label} must use mode 0${mode.toString(8)}`);
  }
  const expectedUid = expectedOwnerUid(testOverride);
  if (expectedUid !== null && status.uid !== expectedUid) {
    throw new Error(`${label} has invalid ownership`);
  }
}

async function secureDirectory(path, testOverride, label) {
  const requested = resolve(path);
  const before = await lstat(requested, { bigint: true });
  const canonical = await realpath(requested);
  const status = await lstat(requested, { bigint: true });
  if (
    !sameIdentity(before, status) ||
    comparablePath(canonical) !== comparablePath(requested) ||
    status.isSymbolicLink() ||
    !status.isDirectory()
  ) throw new Error(`${label} must be a canonical regular directory without symlinks`);
  assertOwnerAndMode(status, 0o700, testOverride, label);
  return { path: requested, status };
}

async function ensureSecureDirectory(path, parent, testOverride, label) {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700, recursive: false });
    created = true;
  } catch (error) {
    if (!errorCode(error, "EEXIST")) throw error;
  }
  if (created) await syncDirectory(parent.path);
  const directory = await secureDirectory(path, testOverride, label);
  const parentAfter = await secureDirectory(parent.path, testOverride, "Phase 3 marker parent root");
  if (!sameInode(parent.status, parentAfter.status)) {
    throw new Error("Phase 3 marker parent root identity changed during provisioning");
  }
  return directory;
}

async function provisionWriterDirectories(resolved, rootLabel) {
  const rootParent = dirname(resolved.rootPath);
  const tempParent = dirname(resolved.tempRootPath);
  if (comparablePath(rootParent) !== comparablePath(tempParent)) {
    throw new Error("Phase 3 marker roots must share one fixed parent");
  }
  const parent = await secureDirectory(
    rootParent,
    resolved.testOverride,
    "Phase 3 marker parent root",
  );
  const root = await ensureSecureDirectory(
    resolved.rootPath,
    parent,
    resolved.testOverride,
    rootLabel,
  );
  const tempRoot = await ensureSecureDirectory(
    resolved.tempRootPath,
    parent,
    resolved.testOverride,
    "Phase 3 temporary marker root",
  );
  const parentAfter = await secureDirectory(
    parent.path,
    resolved.testOverride,
    "Phase 3 marker parent root",
  );
  if (!sameInode(parent.status, parentAfter.status)) {
    throw new Error("Phase 3 marker parent root identity changed during provisioning");
  }
  return [root, tempRoot];
}

function assertSecureFileStatus(status, testOverride, label, allowEmpty, allowedNlinks) {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if ((!allowEmpty && status.size <= 0n) || status.size > BigInt(MAX_MARKER_BYTES)) {
    throw new Error(`${label} exceeds the marker size contract`);
  }
  assertOwnerAndMode(status, 0o600, testOverride, label);
  if (allowedNlinks && !allowedNlinks.includes(status.nlink)) {
    throw new Error(`${label} has an invalid hard-link count`);
  }
}

function errorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function stableReadFile(path, options) {
  const before = await lstat(path, { bigint: true });
  assertSecureFileStatus(
    before,
    options.testOverride,
    options.label,
    options.allowEmpty === true,
    options.allowedNlinks,
  );
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errorCode(error, "ELOOP")) throw new Error(`${options.label} symlink is forbidden`);
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    assertSecureFileStatus(
      opened,
      options.testOverride,
      options.label,
      options.allowEmpty === true,
      options.allowedNlinks,
    );
    if (!sameIdentity(before, opened)) throw new Error(`${options.label} changed before open`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_MARKER_BYTES) throw new Error(`${options.label} exceeds 64 KiB`);
    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      !sameIdentity(opened, afterOpen) ||
      !sameIdentity(afterOpen, afterPath) ||
      BigInt(bytes.byteLength) !== afterOpen.size
    ) throw new Error(`${options.label} changed during stable read`);
    return { bytes, status: afterPath };
  } finally {
    await handle.close();
  }
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function parseCanonicalMarker(bytes, label) {
  const text = decodeUtf8(bytes, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (text !== canonicalJson(value)) {
    throw new Error(`${label} must use immutable canonical JSON without duplicate keys`);
  }
  return { text, value };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readActionAtPath(path, actionId, expected, testOverride, allowedNlinks = [1n]) {
  const stable = await stableReadFile(path, {
    testOverride,
    label: `Phase 3 action marker ${actionId}`,
    allowedNlinks,
  });
  const parsed = parseCanonicalMarker(stable.bytes, `Phase 3 action marker ${actionId}`);
  const value = validateActionWithExpected(parsed.value, expected);
  if (value.actionId !== actionId) throw new Error("Phase 3 action marker filename and action ID differ");
  return freezeClone({
    actionId,
    path,
    value,
    bytes: parsed.text,
    sha256: sha256(stable.bytes),
  });
}

async function readObservationAtPath(
  path,
  observationId,
  expected,
  testOverride,
  allowedNlinks = [1n],
) {
  const stable = await stableReadFile(path, {
    testOverride,
    label: `Phase 3 observation marker ${observationId}`,
    allowedNlinks,
  });
  const parsed = parseCanonicalMarker(stable.bytes, `Phase 3 observation marker ${observationId}`);
  const value = validateObservationWithExpected(parsed.value, expected);
  if (value.observationId !== observationId) {
    throw new Error("Phase 3 observation filename and observation ID differ");
  }
  return freezeClone({
    observationId,
    path,
    value,
    bytes: parsed.text,
    sha256: sha256(stable.bytes),
  });
}

async function assertExactDirectoryFiles(root, names, testOverride, label) {
  const before = await lstat(root, { bigint: true });
  assertOwnerAndMode(before, 0o700, testOverride, label);
  const entries = await readdir(root, { withFileTypes: true });
  const expected = [...names].sort();
  const actual = entries.map((entry) => entry.name).sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) throw new Error(`${label} does not contain the exact required file set`);
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`${label} contains a non-regular or symlink entry`);
    }
  }
  const after = await lstat(root, { bigint: true });
  if (!sameIdentity(before, after)) throw new Error(`${label} changed during file-set validation`);
  return before;
}

function assertHistorical(expected, label) {
  if (expected.position !== "historical") throw new Error(`${label} requires historical validation`);
}

function assertCurrent(expected, label) {
  if (expected.position !== "current") throw new Error(`${label} requires current validation`);
}

export async function readPhase3ActionMeasurement(actionId, expected, options = {}, ...extra) {
  assertNoExtraArguments(extra, "readPhase3ActionMeasurement");
  if (!PHASE3_ACTION_SET.has(actionId)) throw new Error("Phase 3 action ID is invalid");
  const validatedExpected = validateExpected(expected);
  assertHistorical(validatedExpected, "Phase 3 action reader");
  const resolved = validateReadOptions(options, ACTION_ROOT, "Phase 3 action reader");
  const root = await secureDirectory(resolved.rootPath, resolved.testOverride, "Phase 3 action marker root");
  return readActionAtPath(
    join(root.path, `${actionId}.json`),
    actionId,
    validatedExpected,
    resolved.testOverride,
  );
}

export async function readPhase3ActionMeasurements(expected, options = {}, ...extra) {
  assertNoExtraArguments(extra, "readPhase3ActionMeasurements");
  const validatedExpected = validateExpected(expected);
  assertHistorical(validatedExpected, "Phase 3 all-action reader");
  const resolved = validateReadOptions(options, ACTION_ROOT, "Phase 3 all-action reader");
  const root = await secureDirectory(resolved.rootPath, resolved.testOverride, "Phase 3 action marker root");
  const filenames = PHASE3_ACTION_IDS.map((actionId) => `${actionId}.json`);
  const directoryBefore = await assertExactDirectoryFiles(
    root.path,
    filenames,
    resolved.testOverride,
    "Phase 3 action marker root",
  );
  const result = [];
  for (const actionId of PHASE3_ACTION_IDS) {
    result.push(await readActionAtPath(
      join(root.path, `${actionId}.json`),
      actionId,
      validatedExpected,
      resolved.testOverride,
    ));
  }
  await assertExactDirectoryFiles(
    root.path,
    filenames,
    resolved.testOverride,
    "Phase 3 action marker root",
  );
  const directoryAfter = await lstat(root.path, { bigint: true });
  if (!sameIdentity(directoryBefore, directoryAfter)) {
    throw new Error("Phase 3 action marker root changed while reading all markers");
  }
  return freezeClone(result);
}

export async function readPhase3ObservationMarker(
  observationId,
  expected,
  options = {},
  ...extra
) {
  assertNoExtraArguments(extra, "readPhase3ObservationMarker");
  if (!OBSERVATION_IDS.includes(observationId)) {
    throw new Error("Phase 3 observation ID is invalid");
  }
  const validatedExpected = validateExpected(expected);
  const resolved = validateReadOptions(
    options,
    OBSERVATION_ROOT,
    "Phase 3 observation reader",
  );
  const root = await secureDirectory(
    resolved.rootPath,
    resolved.testOverride,
    "Phase 3 observation marker root",
  );
  return readObservationAtPath(
    join(root.path, `${observationId}.json`),
    observationId,
    validatedExpected,
    resolved.testOverride,
  );
}

export async function readPhase3ObservationMarkers(expected, options = {}, ...extra) {
  assertNoExtraArguments(extra, "readPhase3ObservationMarkers");
  const validatedExpected = validateExpected(expected);
  assertHistorical(validatedExpected, "Phase 3 observation reader");
  const resolved = validateReadOptions(options, OBSERVATION_ROOT, "Phase 3 observation reader");
  const root = await secureDirectory(
    resolved.rootPath,
    resolved.testOverride,
    "Phase 3 observation marker root",
  );
  const filenames = OBSERVATION_IDS.map((observationId) => `${observationId}.json`);
  const directoryBefore = await assertExactDirectoryFiles(
    root.path,
    filenames,
    resolved.testOverride,
    "Phase 3 observation marker root",
  );
  const [schema, fence] = await Promise.all([
    readObservationAtPath(
      join(root.path, "phase3-schema-verify.json"),
      "phase3-schema-verify",
      validatedExpected,
      resolved.testOverride,
    ),
    readObservationAtPath(
      join(root.path, "phase3-fence-ack-wait.json"),
      "phase3-fence-ack-wait",
      validatedExpected,
      resolved.testOverride,
    ),
  ]);
  await assertExactDirectoryFiles(
    root.path,
    filenames,
    resolved.testOverride,
    "Phase 3 observation marker root",
  );
  const directoryAfter = await lstat(root.path, { bigint: true });
  if (!sameIdentity(directoryBefore, directoryAfter)) {
    throw new Error("Phase 3 observation marker root changed while reading markers");
  }
  return freezeClone({ schema, fence });
}

async function unlinkStableTemp(path, expectedStatus, tempRoot) {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error, "ENOENT")) return;
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameInodeAndSize(current, expectedStatus)
  ) {
    throw new Error("Phase 3 temporary marker identity changed before cleanup");
  }
  await unlink(path);
  await syncDirectory(tempRoot);
}

async function cleanupTemporaryAfterWrite(path, expectedStatus, tempRoot) {
  if (expectedStatus !== undefined) {
    await unlinkStableTemp(path, expectedStatus, tempRoot);
    return;
  }
  try {
    await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("Phase 3 temporary marker could not be authenticated for cleanup");
}

function recoveredMarkerIdentity(value, expected) {
  const hasActionId = isPlainObject(value) && Object.hasOwn(value, "actionId");
  const hasObservationId = isPlainObject(value) && Object.hasOwn(value, "observationId");
  if (hasActionId === hasObservationId) {
    throw new Error("Phase 3 temporary marker must contain exactly one marker identity");
  }
  const historicalExpected = { ...expected, position: "historical" };
  if (hasActionId) {
    const marker = validateActionWithExpected(value, historicalExpected);
    return { kind: "action", id: marker.actionId };
  }
  const marker = validateObservationWithExpected(value, historicalExpected);
  return { kind: "observation", id: marker.observationId };
}

async function recoveredDestinationRoot(root, kind, currentKind, testOverride) {
  if (kind === currentKind) return root;
  const sibling = join(
    dirname(root),
    basename(kind === "action" ? ACTION_ROOT : OBSERVATION_ROOT),
  );
  const secured = await secureDirectory(
    sibling,
    testOverride,
    `Phase 3 ${kind} marker root`,
  );
  return secured.path;
}

async function recoverTemporaryMarkers(
  root,
  tempRoot,
  expected,
  testOverride,
  currentKind,
) {
  const before = await lstat(tempRoot, { bigint: true });
  const entries = await readdir(tempRoot, { withFileTypes: true });
  if (entries.length > MAX_TEMP_ENTRIES) {
    throw new Error("Phase 3 temporary marker root exceeds its recovery entry limit");
  }
  for (const entry of entries) {
    if (!UUID_TEMP.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("Phase 3 temporary marker root contains an unexpected non-UUID entry");
    }
    const path = join(tempRoot, entry.name);
    const stable = await stableReadFile(path, {
      testOverride,
      label: "Phase 3 temporary marker",
      allowEmpty: true,
      allowedNlinks: [1n, 2n],
    });
    if (stable.status.nlink === 1n) {
      await unlinkStableTemp(path, stable.status, tempRoot);
      continue;
    }
    const parsed = parseCanonicalMarker(stable.bytes, "Phase 3 linked temporary marker");
    const marker = recoveredMarkerIdentity(parsed.value, expected);
    const destinationRoot = await recoveredDestinationRoot(
      root,
      marker.kind,
      currentKind,
      testOverride,
    );
    const destination = join(destinationRoot, `${marker.id}.json`);
    const installed = await stableReadFile(destination, {
      testOverride,
      label: "Phase 3 recovered destination marker",
      allowedNlinks: [2n],
    });
    if (
      installed.status.dev !== stable.status.dev ||
      installed.status.ino !== stable.status.ino ||
      !installed.bytes.equals(stable.bytes)
    ) throw new Error("Phase 3 linked temporary marker does not match its code-owned destination");
    await unlinkStableTemp(path, stable.status, tempRoot);
  }
  await syncDirectory(tempRoot);
  const after = await lstat(tempRoot, { bigint: true });
  if (!sameIdentity(before, after) && entries.length === 0) {
    throw new Error("Phase 3 temporary marker root changed during empty recovery scan");
  }
}

async function writePhase3Marker(value, expected, options, config) {
  const validatedExpected = validateExpected(expected);
  assertCurrent(validatedExpected, config.writerLabel);
  const validated = config.validate(value, validatedExpected);
  const resolved = validateWriteOptions(options, config.productionRoot, config.writerLabel);
  const [root, tempRoot] = await provisionWriterDirectories(resolved, config.rootLabel);
  if (root.status.dev !== tempRoot.status.dev) {
    throw new Error("Phase 3 marker and temporary roots must be on the same filesystem");
  }
  await recoverTemporaryMarkers(
    root.path,
    tempRoot.path,
    validatedExpected,
    resolved.testOverride,
    config.kind,
  );

  const text = canonicalJson(validated);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MARKER_BYTES) {
    throw new Error(`${config.markerLabel} exceeds 64 KiB`);
  }
  const markerId = config.idOf(validated);
  const destination = join(root.path, `${markerId}.json`);
  const temporary = join(tempRoot.path, `${randomUUID()}.tmp`);
  let handle;
  let temporaryStatus;
  let linked = false;
  let publishedStatus;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    const verifiedTemp = await stableReadFile(temporary, {
      testOverride: resolved.testOverride,
      label: `Phase 3 newly written temporary ${config.kind} marker`,
      allowedNlinks: [1n],
    });
    temporaryStatus = verifiedTemp.status;
    if (!verifiedTemp.bytes.equals(bytes)) {
      throw new Error("Phase 3 temporary marker bytes changed after fsync");
    }

    try {
      await link(temporary, destination);
      linked = true;
    } catch (error) {
      if (errorCode(error, "EXDEV")) {
        throw new Error("Phase 3 marker roots are cross-device; hard-link publication is required");
      }
      if (!errorCode(error, "EEXIST")) throw error;
      const existing = await config.readAtPath(
        destination,
        markerId,
        validatedExpected,
        resolved.testOverride,
        [1n],
      );
      if (existing.bytes !== text) {
        throw new Error(`${config.markerLabel} conflicts with the installed create-once marker`);
      }
    }

    if (linked) {
      await syncDirectory(root.path);
      const installed = await stableReadFile(destination, {
        testOverride: resolved.testOverride,
        label: `Phase 3 installed ${config.kind} marker`,
        allowedNlinks: [2n],
      });
      if (!installed.bytes.equals(bytes)) {
        throw new Error("Phase 3 installed marker differs from the fsynced temporary marker");
      }
      if (!sameInodeAndSize(installed.status, temporaryStatus)) {
        throw new Error("Phase 3 installed marker is not the fsynced temporary marker inode");
      }
      publishedStatus = installed.status;
      const parsed = parseCanonicalMarker(
        installed.bytes,
        `Phase 3 installed ${config.kind} marker`,
      );
      const installedValue = config.validate(parsed.value, validatedExpected);
      if (config.idOf(installedValue) !== markerId) {
        throw new Error("Phase 3 installed marker identity changed during publication");
      }
    }
  } finally {
    if (handle) {
      temporaryStatus = await handle.stat({ bigint: true }).catch(() => temporaryStatus);
      await handle.close();
    }
    await cleanupTemporaryAfterWrite(temporary, temporaryStatus, tempRoot.path);
  }
  if (linked) {
    const finalized = await stableReadFile(destination, {
      testOverride: resolved.testOverride,
      label: `Phase 3 finalized ${config.kind} marker`,
      allowedNlinks: [1n],
    });
    if (
      !sameInodeAndSize(finalized.status, temporaryStatus) ||
      !sameInodeAndSize(finalized.status, publishedStatus) ||
      !finalized.bytes.equals(bytes)
    ) throw new Error("Phase 3 finalized marker identity or bytes changed after cleanup");
    const parsed = parseCanonicalMarker(
      finalized.bytes,
      `Phase 3 finalized ${config.kind} marker`,
    );
    const finalizedValue = config.validate(parsed.value, validatedExpected);
    if (config.idOf(finalizedValue) !== markerId) {
      throw new Error("Phase 3 finalized marker identity changed after cleanup");
    }
  }
  return freezeClone({
    path: destination,
    sha256: sha256(bytes),
    value: validated,
  });
}

export async function writePhase3ActionMeasurement(value, expected, options = {}, ...extra) {
  assertNoExtraArguments(extra, "writePhase3ActionMeasurement");
  return writePhase3Marker(value, expected, options, {
    kind: "action",
    productionRoot: ACTION_ROOT,
    writerLabel: "Phase 3 action writer",
    rootLabel: "Phase 3 action marker root",
    markerLabel: "Phase 3 action marker",
    validate: validateActionWithExpected,
    idOf: (marker) => marker.actionId,
    readAtPath: readActionAtPath,
  });
}

export async function writePhase3ObservationMarker(value, expected, options = {}, ...extra) {
  assertNoExtraArguments(extra, "writePhase3ObservationMarker");
  return writePhase3Marker(value, expected, options, {
    kind: "observation",
    productionRoot: OBSERVATION_ROOT,
    writerLabel: "Phase 3 observation writer",
    rootLabel: "Phase 3 observation marker root",
    markerLabel: "Phase 3 observation marker",
    validate: validateObservationWithExpected,
    idOf: (marker) => marker.observationId,
    readAtPath: readObservationAtPath,
  });
}

function assertRuntimeSourceId(sourceId) {
  if (!PHASE3_RUNTIME_SOURCE_SET.has(sourceId)) {
    throw new Error("Phase 3 runtime source ID is invalid");
  }
}

function validateRuntimeSourceDocumentIdentity(sourceId, value, label) {
  const payloadField = RUNTIME_SOURCE_PAYLOAD_FIELDS[sourceId];
  if (!payloadField) throw new Error("Phase 3 runtime source document has an invalid source ID");
  scanRuntimeSource(value);
  assertExactObject(value, ["schemaVersion", "context", payloadField], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion must be exactly 1`);
  }
  if (!isPlainObject(value.context)) {
    throw new Error(`${label}.context must be a strict JSON record`);
  }
  if (!isPlainObject(value[payloadField])) {
    throw new Error(`${label}.${payloadField} must be a strict JSON record`);
  }
  return value;
}

function validateRuntimeSourceOptionsObject(options, allowed, label) {
  if (!isPlainObject(options)) throw new Error(`${label} options must be a plain object`);
  const keys = [];
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string") throw new Error(`${label} options contain an unknown symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${label} options must contain only enumerable data fields`);
    }
    if (!allowed.includes(key)) throw new Error(`${label} options contain an unknown field`);
    keys.push(key);
  }
  return keys.sort();
}

function validateRuntimeSourceReadOptions(options) {
  const keys = validateRuntimeSourceOptionsObject(
    options,
    ["rootPath"],
    "Phase 3 runtime source reader",
  );
  if (keys.length === 0) {
    return { rootPath: RUNTIME_SOURCE_ROOT, testOverride: false };
  }
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Phase 3 runtime source reader root override is test-only");
  }
  if (typeof options.rootPath !== "string" || !isAbsolute(options.rootPath)) {
    throw new Error("Phase 3 runtime source reader root override must be absolute");
  }
  return { rootPath: resolve(options.rootPath), testOverride: true };
}

function validateRuntimeSourceWriteOptions(options) {
  const keys = validateRuntimeSourceOptionsObject(
    options,
    ["rootPath", "tempRootPath"],
    "Phase 3 runtime source writer",
  );
  if (keys.length === 0) {
    return {
      rootPath: RUNTIME_SOURCE_ROOT,
      tempRootPath: RUNTIME_SOURCE_TEMP_ROOT,
      testOverride: false,
    };
  }
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Phase 3 runtime source writer root overrides are test-only");
  }
  if (keys.length !== 2 || !keys.includes("rootPath") || !keys.includes("tempRootPath")) {
    throw new Error("Phase 3 runtime source root and temporary root overrides must appear together");
  }
  if (
    typeof options.rootPath !== "string" ||
    typeof options.tempRootPath !== "string" ||
    !isAbsolute(options.rootPath) ||
    !isAbsolute(options.tempRootPath)
  ) {
    throw new Error("Phase 3 runtime source root overrides must be absolute");
  }
  const rootPath = resolve(options.rootPath);
  const tempRootPath = resolve(options.tempRootPath);
  if (
    comparablePath(rootPath) === comparablePath(tempRootPath) ||
    comparablePath(dirname(rootPath)) !== comparablePath(dirname(tempRootPath))
  ) {
    throw new Error("Phase 3 runtime source roots must be distinct sibling directories with one parent");
  }
  return { rootPath, tempRootPath, testOverride: true };
}

function runtimeSourceNoFollowFlag(testOverride, label) {
  if (constants.O_NOFOLLOW === undefined && !testOverride) {
    throw new Error(`${label} requires O_NOFOLLOW in production`);
  }
  return constants.O_NOFOLLOW ?? 0;
}

function assertRuntimeSourceFileStatus(
  status,
  testOverride,
  label,
  { allowEmpty = false, allowedNlinks = [1n], enforceMaximum = true } = {},
) {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  assertOwnerAndMode(status, 0o600, testOverride, label);
  if (!allowedNlinks.includes(status.nlink)) {
    throw new Error(`${label} has an invalid hard-link count`);
  }
  if (!allowEmpty && status.size <= 0n) throw new Error(`${label} must not be empty`);
  if (enforceMaximum && status.size > BigInt(MAX_RUNTIME_SOURCE_BYTES)) {
    throw new Error(`${label} exceeds the 128 KiB runtime source size contract`);
  }
}

async function stableReadRuntimeSourceFile(path, options) {
  const before = await lstat(path, { bigint: true });
  assertRuntimeSourceFileStatus(before, options.testOverride, options.label, options);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | runtimeSourceNoFollowFlag(options.testOverride, options.label),
    );
  } catch (error) {
    if (errorCode(error, "ELOOP")) throw new Error(`${options.label} symlink is forbidden`);
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    assertRuntimeSourceFileStatus(opened, options.testOverride, options.label, options);
    if (!sameIdentity(before, opened)) throw new Error(`${options.label} changed before open`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_RUNTIME_SOURCE_BYTES) {
      throw new Error(`${options.label} exceeds 128 KiB`);
    }
    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      !sameIdentity(opened, afterOpen) ||
      !sameIdentity(afterOpen, afterPath) ||
      BigInt(bytes.byteLength) !== afterOpen.size
    ) {
      throw new Error(`${options.label} changed during stable read`);
    }
    return { bytes, status: afterPath };
  } finally {
    await handle.close();
  }
}

function parseCanonicalRuntimeSource(bytes, label) {
  if (bytes.byteLength === 0) throw new Error(`${label} must not be empty`);
  const text = decodeUtf8(bytes, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  scanRuntimeSource(value);
  if (text !== canonicalJson(value)) {
    throw new Error(`${label} must use immutable canonical JSON without duplicate keys`);
  }
  return { text, value };
}

function parseCanonicalRuntimeSourceDocument(bytes, sourceId, label) {
  const parsed = parseCanonicalRuntimeSource(bytes, label);
  validateRuntimeSourceDocumentIdentity(sourceId, parsed.value, label);
  return parsed;
}

async function readRuntimeSourceAtPath(
  path,
  sourceId,
  testOverride,
  allowedNlinks = [1n],
) {
  if (basename(path) !== `${sourceId}.json`) {
    throw new Error("Phase 3 runtime source path does not match its fixed source mapping");
  }
  const stable = await stableReadRuntimeSourceFile(path, {
    testOverride,
    label: `Phase 3 runtime source ${sourceId}`,
    allowedNlinks,
  });
  const parsed = parseCanonicalRuntimeSourceDocument(
    stable.bytes,
    sourceId,
    `Phase 3 runtime source ${sourceId}`,
  );
  return {
    status: stable.status,
    record: freezeClone({
      sourceId,
      path,
      value: parsed.value,
      bytes: parsed.text,
      sha256: sha256(stable.bytes),
    }),
  };
}

async function ensureRuntimeSourceDirectory(path, parent, testOverride, label) {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700, recursive: false });
    created = true;
  } catch (error) {
    if (!errorCode(error, "EEXIST")) throw error;
  }
  if (created) await syncDirectory(parent.path);
  const directory = await secureDirectory(path, testOverride, label);
  await syncDirectory(directory.path);
  const parentAfter = await secureDirectory(parent.path, testOverride, `${label} parent`);
  if (!sameInode(parent.status, parentAfter.status)) {
    throw new Error(`${label} parent identity changed during provisioning`);
  }
  return directory;
}

async function provisionRuntimeSourceWriterDirectories(resolved) {
  if (resolved.testOverride) {
    const commonParentPath = dirname(resolved.rootPath);
    if (comparablePath(commonParentPath) !== comparablePath(dirname(resolved.tempRootPath))) {
      throw new Error("Phase 3 runtime source roots must share one fixed parent");
    }
    const commonParent = await secureDirectory(
      commonParentPath,
      true,
      "Phase 3 runtime source common parent",
    );
    const sourceRoot = await ensureRuntimeSourceDirectory(
      resolved.rootPath,
      commonParent,
      true,
      "Phase 3 runtime source root",
    );
    const refreshedParent = await secureDirectory(
      commonParent.path,
      true,
      "Phase 3 runtime source common parent",
    );
    const tempRoot = await ensureRuntimeSourceDirectory(
      resolved.tempRootPath,
      refreshedParent,
      true,
      "Phase 3 runtime source temporary root",
    );
    const parentAfter = await secureDirectory(
      commonParent.path,
      true,
      "Phase 3 runtime source common parent",
    );
    if (!sameInode(commonParent.status, parentAfter.status)) {
      throw new Error("Phase 3 runtime source common parent identity changed during provisioning");
    }
    return {
      sourceRoot: { ...sourceRoot, chain: { commonParent: parentAfter.status } },
      tempRoot,
    };
  }

  const rollout = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidence = await ensureRuntimeSourceDirectory(
    EVIDENCE_ROOT,
    rollout,
    false,
    "Phase 3 evidence root",
  );
  const sourceRoot = await ensureRuntimeSourceDirectory(
    RUNTIME_SOURCE_ROOT,
    evidence,
    false,
    "Phase 3 runtime source root",
  );
  const refreshedEvidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  const tempRoot = await ensureRuntimeSourceDirectory(
    RUNTIME_SOURCE_TEMP_ROOT,
    refreshedEvidence,
    false,
    "Phase 3 runtime source temporary root",
  );
  const rolloutAfter = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidenceAfter = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  if (!sameInode(rollout.status, rolloutAfter.status) || !sameInode(evidence.status, evidenceAfter.status)) {
    throw new Error("Phase 3 runtime source directory chain changed during provisioning");
  }
  return {
    sourceRoot: {
      ...sourceRoot,
      chain: { rollout: rolloutAfter.status, evidence: evidenceAfter.status },
    },
    tempRoot,
  };
}

async function authenticateRuntimeSourceWriterDirectories(
  resolved,
  expectedSourceRoot,
  expectedTempRoot,
) {
  await authenticateRuntimeSourceReaderDirectory(resolved, expectedSourceRoot);
  const tempRoot = await secureDirectory(
    resolved.tempRootPath,
    resolved.testOverride,
    "Phase 3 runtime source temporary root",
  );
  if (!sameInode(expectedTempRoot.status, tempRoot.status)) {
    throw new Error("Phase 3 runtime source temporary root identity changed between authentications");
  }
  if (resolved.testOverride) {
    const parent = await secureDirectory(
      dirname(resolved.tempRootPath),
      true,
      "Phase 3 runtime source common parent",
    );
    if (!sameInode(expectedSourceRoot.chain.commonParent, parent.status)) {
      throw new Error("Phase 3 runtime source writer parent identity changed between authentications");
    }
  } else {
    const evidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
    if (!sameInode(expectedSourceRoot.chain.evidence, evidence.status)) {
      throw new Error("Phase 3 runtime source writer evidence-root identity changed between authentications");
    }
  }
}

async function authenticateRuntimeSourceReaderDirectory(resolved, expected) {
  if (resolved.testOverride) {
    const commonParent = await secureDirectory(
      dirname(resolved.rootPath),
      true,
      "Phase 3 runtime source common parent",
    );
    const sourceRoot = await secureDirectory(
      resolved.rootPath,
      true,
      "Phase 3 runtime source root",
    );
    const parentAfter = await secureDirectory(
      commonParent.path,
      true,
      "Phase 3 runtime source common parent",
    );
    if (!sameInode(commonParent.status, parentAfter.status)) {
      throw new Error("Phase 3 runtime source common parent identity changed during authentication");
    }
    if (
      expected &&
      (!sameInode(expected.status, sourceRoot.status) ||
        !sameInode(expected.chain.commonParent, parentAfter.status))
    ) {
      throw new Error("Phase 3 runtime source parent or root identity changed between authentications");
    }
    return { ...sourceRoot, chain: { commonParent: parentAfter.status } };
  }

  const rollout = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  const sourceRoot = await secureDirectory(
    RUNTIME_SOURCE_ROOT,
    false,
    "Phase 3 runtime source root",
  );
  const rolloutAfter = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidenceAfter = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  if (!sameInode(rollout.status, rolloutAfter.status) || !sameInode(evidence.status, evidenceAfter.status)) {
    throw new Error("Phase 3 runtime source directory chain changed during authentication");
  }
  if (
    expected &&
    (!sameInode(expected.status, sourceRoot.status) ||
      !sameInode(expected.chain.rollout, rolloutAfter.status) ||
      !sameInode(expected.chain.evidence, evidenceAfter.status))
  ) {
    throw new Error("Phase 3 runtime source directory chain identity changed between authentications");
  }
  return {
    ...sourceRoot,
    chain: { rollout: rolloutAfter.status, evidence: evidenceAfter.status },
  };
}

async function inspectRuntimeSourceSet(
  sourceRoot,
  testOverride,
  { exact = false, allowedNlinks = [1n] } = {},
) {
  const before = await lstat(sourceRoot.path, { bigint: true });
  assertOwnerAndMode(before, 0o700, testOverride, "Phase 3 runtime source root");
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Phase 3 runtime source root must be a regular non-symlink directory");
  }
  if (!sameInode(sourceRoot.status, before)) {
    throw new Error("Phase 3 runtime source root identity changed after directory-chain authentication");
  }
  const entries = await readdir(sourceRoot.path, { withFileTypes: true });
  const allowedNames = new Set(PHASE3_RUNTIME_SOURCE_IDS.map((sourceId) => `${sourceId}.json`));
  for (const entry of entries) {
    if (!allowedNames.has(entry.name)) {
      throw new Error("Phase 3 runtime source root contains an unexpected entry");
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("Phase 3 runtime source root contains a non-regular or symlink entry");
    }
  }
  if (exact && entries.length !== PHASE3_RUNTIME_SOURCE_IDS.length) {
    throw new Error("Phase 3 runtime source root does not contain the exact five-file set");
  }
  const present = new Set(entries.map((entry) => entry.name));
  const records = {};
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    if (!present.has(`${sourceId}.json`)) continue;
    records[sourceId] = await readRuntimeSourceAtPath(
      join(sourceRoot.path, `${sourceId}.json`),
      sourceId,
      testOverride,
      allowedNlinks,
    );
  }
  const after = await lstat(sourceRoot.path, { bigint: true });
  assertOwnerAndMode(after, 0o700, testOverride, "Phase 3 runtime source root");
  if (!sameIdentity(before, after)) {
    throw new Error("Phase 3 runtime source root changed during stable file-set authentication");
  }
  return { status: after, records };
}

function sameRuntimeSourceSnapshot(left, right) {
  if (!sameIdentity(left.status, right.status)) return false;
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    const leftEntry = left.records[sourceId];
    const rightEntry = right.records[sourceId];
    if (Boolean(leftEntry) !== Boolean(rightEntry)) return false;
    if (
      leftEntry &&
      (!sameIdentity(leftEntry.status, rightEntry.status) ||
        leftEntry.record.bytes !== rightEntry.record.bytes ||
        leftEntry.record.sha256 !== rightEntry.record.sha256)
    ) return false;
  }
  return true;
}

async function unlinkAuthenticatedRuntimeTemp(
  path,
  expectedStatus,
  expectedNlink,
  tempRoot,
  testOverride,
) {
  const current = await lstat(path, { bigint: true });
  assertRuntimeSourceFileStatus(current, testOverride, "Phase 3 runtime source temporary file", {
    allowEmpty: true,
    allowedNlinks: [expectedNlink],
    enforceMaximum: false,
  });
  if (!sameIdentity(current, expectedStatus)) {
    throw new Error("Phase 3 runtime source temporary identity changed before cleanup");
  }
  await unlink(path);
  await syncDirectory(tempRoot);
}

async function removeUnpublishedRuntimeTemp(path, tempRoot, testOverride, createdStatus) {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error, "ENOENT")) return;
    throw error;
  }
  assertRuntimeSourceFileStatus(before, testOverride, "Phase 3 unpublished runtime source temporary", {
    allowEmpty: true,
    allowedNlinks: [1n],
    enforceMaximum: false,
  });
  if (createdStatus && !sameInode(before, createdStatus)) {
    throw new Error("Phase 3 unpublished runtime source temporary inode changed");
  }
  const after = await lstat(path, { bigint: true });
  if (!sameIdentity(before, after)) {
    throw new Error("Phase 3 unpublished runtime source temporary changed before cleanup");
  }
  await unlinkAuthenticatedRuntimeTemp(path, after, 1n, tempRoot, testOverride);
}

function recoveryDirentIdentity(entry) {
  return [
    entry.name,
    entry.isFile(),
    entry.isDirectory(),
    entry.isSymbolicLink(),
  ];
}

function sameRecoveryDirentSet(left, right) {
  const leftIdentities = left
    .map(recoveryDirentIdentity)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const rightIdentities = right
    .map(recoveryDirentIdentity)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return (
    leftIdentities.length === rightIdentities.length &&
    leftIdentities.every((identity, index) =>
      identity.length === rightIdentities[index].length &&
      identity.every((value, valueIndex) => value === rightIdentities[index][valueIndex]))
  );
}

async function authenticatePlannedRecoveryTempSet(
  tempRoot,
  tempBefore,
  entriesBefore,
  plans,
  testOverride,
  label,
) {
  const entriesAfter = await readdir(tempRoot.path, { withFileTypes: true });
  if (!sameRecoveryDirentSet(entriesBefore, entriesAfter)) {
    throw new Error(`${label} temporary entry set changed during recovery planning`);
  }
  for (const plan of plans) {
    const current = await lstat(plan.temporary, { bigint: true });
    assertRuntimeSourceFileStatus(current, testOverride, `${label} planned temporary`, {
      allowEmpty: true,
      allowedNlinks: [plan.nlink],
      enforceMaximum: false,
    });
    if (!sameIdentity(plan.tempStatus, current)) {
      throw new Error(`${label} planned temporary identity changed before execution`);
    }
  }
  const tempAfter = await secureDirectory(tempRoot.path, testOverride, `${label} temporary root`);
  if (!sameIdentity(tempBefore.status, tempAfter.status)) {
    throw new Error(`${label} temporary root changed during recovery planning`);
  }
}

async function planRuntimeSourceTempRecovery(sourceRoot, tempRoot, testOverride) {
  const tempBefore = await secureDirectory(
    tempRoot.path,
    testOverride,
    "Phase 3 runtime source temporary root",
  );
  const sourceBefore = await inspectRuntimeSourceSet(sourceRoot, testOverride, {
    allowedNlinks: [1n, 2n],
  });
  const entries = await readdir(tempRoot.path, { withFileTypes: true });
  if (entries.length > MAX_TEMP_ENTRIES) {
    throw new Error("Phase 3 runtime source temporary root exceeds its 64-entry recovery limit");
  }
  const parsedEntries = entries
    .map((entry) => {
      const match = RUNTIME_SOURCE_TEMP.exec(entry.name);
      if (!match || entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(
          "Phase 3 runtime source temporary root contains an unexpected source-qualified entry",
        );
      }
      return { entry, sourceId: match[1] };
    })
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  const plans = [];
  const linkedSourceIds = new Set();
  const linkedInodes = new Set();
  for (const { entry, sourceId } of parsedEntries) {
    const temporary = join(tempRoot.path, entry.name);
    const statusBefore = await lstat(temporary, { bigint: true });
    assertRuntimeSourceFileStatus(
      statusBefore,
      testOverride,
      "Phase 3 runtime source recovery temporary",
      { allowEmpty: true, allowedNlinks: [1n, 2n], enforceMaximum: false },
    );
    const statusAfter = await lstat(temporary, { bigint: true });
    if (!sameIdentity(statusBefore, statusAfter)) {
      throw new Error("Phase 3 runtime source recovery temporary identity is unstable");
    }
    if (statusAfter.nlink === 1n) {
      plans.push({ kind: "orphan", sourceId, temporary, tempStatus: statusAfter, nlink: 1n });
      continue;
    }
    if (linkedSourceIds.has(sourceId)) {
      throw new Error("Phase 3 runtime source recovery has ambiguous duplicate linked temporaries");
    }
    const stableTemp = await stableReadRuntimeSourceFile(temporary, {
      testOverride,
      label: `Phase 3 linked runtime source temporary ${sourceId}`,
      allowedNlinks: [2n],
    });
    if (!sameIdentity(statusAfter, stableTemp.status)) {
      throw new Error("Phase 3 linked runtime source temporary changed during planning");
    }
    parseCanonicalRuntimeSourceDocument(
      stableTemp.bytes,
      sourceId,
      `Phase 3 linked runtime source temporary ${sourceId}`,
    );
    const destination = join(sourceRoot.path, `${sourceId}.json`);
    const installed = await stableReadRuntimeSourceFile(destination, {
      testOverride,
      label: `Phase 3 recovered runtime source destination ${sourceId}`,
      allowedNlinks: [2n],
    });
    parseCanonicalRuntimeSourceDocument(
      installed.bytes,
      sourceId,
      `Phase 3 recovered runtime source destination ${sourceId}`,
    );
    if (
      !sameInodeAndSize(stableTemp.status, installed.status) ||
      !stableTemp.bytes.equals(installed.bytes)
    ) {
      throw new Error(
        "Phase 3 linked runtime source temporary does not match its fixed destination inode and bytes",
      );
    }
    const inodeKey = `${stableTemp.status.dev}:${stableTemp.status.ino}`;
    if (linkedInodes.has(inodeKey)) {
      throw new Error("Phase 3 runtime source recovery has an ambiguous duplicate linked inode");
    }
    linkedSourceIds.add(sourceId);
    linkedInodes.add(inodeKey);
    plans.push({
      kind: "linked",
      sourceId,
      temporary,
      destination,
      tempStatus: stableTemp.status,
      destinationStatus: installed.status,
      bytes: stableTemp.bytes,
      nlink: 2n,
    });
  }
  await authenticatePlannedRecoveryTempSet(
    tempRoot,
    tempBefore,
    entries,
    plans,
    testOverride,
    "Phase 3 runtime source recovery",
  );
  const sourceAfter = await inspectRuntimeSourceSet(sourceRoot, testOverride, {
    allowedNlinks: [1n, 2n],
  });
  if (!sameRuntimeSourceSnapshot(sourceBefore, sourceAfter)) {
    throw new Error("Phase 3 runtime source destination set changed during recovery planning");
  }
  return { plans, tempBefore };
}

async function executeRuntimeSourceTempRecoveryPlan(
  plan,
  sourceRoot,
  tempRoot,
  testOverride,
) {
  if (plan.kind === "orphan") {
    await unlinkAuthenticatedRuntimeTemp(
      plan.temporary,
      plan.tempStatus,
      1n,
      tempRoot.path,
      testOverride,
    );
    return;
  }
  const authenticatedTemp = await stableReadRuntimeSourceFile(plan.temporary, {
    testOverride,
    label: `Phase 3 re-authenticated linked runtime source temporary ${plan.sourceId}`,
    allowedNlinks: [2n],
  });
  const authenticatedDestination = await stableReadRuntimeSourceFile(plan.destination, {
    testOverride,
    label: `Phase 3 re-authenticated runtime source destination ${plan.sourceId}`,
    allowedNlinks: [2n],
  });
  parseCanonicalRuntimeSourceDocument(
    authenticatedTemp.bytes,
    plan.sourceId,
    `Phase 3 re-authenticated linked runtime source temporary ${plan.sourceId}`,
  );
  parseCanonicalRuntimeSourceDocument(
    authenticatedDestination.bytes,
    plan.sourceId,
    `Phase 3 re-authenticated runtime source destination ${plan.sourceId}`,
  );
  if (
    !sameIdentity(authenticatedTemp.status, plan.tempStatus) ||
    !sameIdentity(authenticatedDestination.status, plan.destinationStatus) ||
    !sameInodeAndSize(authenticatedTemp.status, authenticatedDestination.status) ||
    !authenticatedTemp.bytes.equals(authenticatedDestination.bytes) ||
    !authenticatedTemp.bytes.equals(plan.bytes)
  ) {
    throw new Error("Phase 3 linked runtime source pair changed before recovery cleanup");
  }
  await syncDirectory(sourceRoot.path);
  const finalTempAuthentication = await stableReadRuntimeSourceFile(plan.temporary, {
    testOverride,
    label: `Phase 3 final linked runtime source temporary ${plan.sourceId}`,
    allowedNlinks: [2n],
  });
  const finalDestinationAuthentication = await stableReadRuntimeSourceFile(plan.destination, {
    testOverride,
    label: `Phase 3 final runtime source destination ${plan.sourceId}`,
    allowedNlinks: [2n],
  });
  if (
    !sameIdentity(finalTempAuthentication.status, authenticatedTemp.status) ||
    !sameIdentity(finalDestinationAuthentication.status, authenticatedDestination.status) ||
    !finalTempAuthentication.bytes.equals(finalDestinationAuthentication.bytes) ||
    !finalTempAuthentication.bytes.equals(plan.bytes)
  ) {
    throw new Error("Phase 3 linked runtime source pair changed during final authentication");
  }
  await unlinkAuthenticatedRuntimeTemp(
    plan.temporary,
    finalTempAuthentication.status,
    2n,
    tempRoot.path,
    testOverride,
  );
  const finalized = await stableReadRuntimeSourceFile(plan.destination, {
    testOverride,
    label: `Phase 3 recovered finalized runtime source ${plan.sourceId}`,
    allowedNlinks: [1n],
  });
  if (
    !sameInodeAndSize(finalized.status, finalDestinationAuthentication.status) ||
    !finalized.bytes.equals(finalDestinationAuthentication.bytes)
  ) {
    throw new Error("Phase 3 recovered runtime source changed after temporary cleanup");
  }
  parseCanonicalRuntimeSourceDocument(
    finalized.bytes,
    plan.sourceId,
    `Phase 3 recovered finalized runtime source ${plan.sourceId}`,
  );
}

async function recoverRuntimeSourceTemps(sourceRoot, tempRoot, testOverride) {
  const { plans, tempBefore } = await planRuntimeSourceTempRecovery(
    sourceRoot,
    tempRoot,
    testOverride,
  );
  for (const plan of plans) {
    await executeRuntimeSourceTempRecoveryPlan(
      plan,
      sourceRoot,
      tempRoot,
      testOverride,
    );
  }
  await syncDirectory(tempRoot.path);
  const remaining = await readdir(tempRoot.path);
  if (remaining.length !== 0) {
    throw new Error("Phase 3 runtime source temporary root changed during recovery");
  }
  await syncDirectory(sourceRoot.path);
  const tempAfter = await secureDirectory(
    tempRoot.path,
    testOverride,
    "Phase 3 runtime source temporary root",
  );
  if (!sameInode(tempBefore.status, tempAfter.status)) {
    throw new Error("Phase 3 runtime source temporary root identity changed during recovery");
  }
}

function runtimeSourceMissingError(sourceId) {
  const error = new Error(`Phase 3 runtime source ${sourceId} is missing`);
  error.code = "ENOENT";
  return error;
}

export async function readPhase3RuntimeSource(sourceId, options = {}) {
  if (arguments.length < 1 || arguments.length > 2 || (arguments.length === 2 && arguments[1] === undefined)) {
    throw new Error("readPhase3RuntimeSource received an invalid argument count");
  }
  assertRuntimeSourceId(sourceId);
  const resolved = validateRuntimeSourceReadOptions(options);
  const sourceRoot = await authenticateRuntimeSourceReaderDirectory(resolved);
  const before = await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride);
  if (!before.records[sourceId]) {
    const afterMissing = await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride);
    if (!sameRuntimeSourceSnapshot(before, afterMissing)) {
      throw new Error("Phase 3 runtime source set changed while confirming a missing source");
    }
    await authenticateRuntimeSourceReaderDirectory(resolved, sourceRoot);
    throw runtimeSourceMissingError(sourceId);
  }
  const after = await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride);
  if (!sameRuntimeSourceSnapshot(before, after)) {
    throw new Error("Phase 3 runtime source set changed during singular read");
  }
  await authenticateRuntimeSourceReaderDirectory(resolved, sourceRoot);
  return after.records[sourceId].record;
}

export async function readPhase3RuntimeSources(options = {}) {
  if (arguments.length > 1 || (arguments.length === 1 && arguments[0] === undefined)) {
    throw new Error("readPhase3RuntimeSources received an invalid argument count");
  }
  const resolved = validateRuntimeSourceReadOptions(options);
  const sourceRoot = await authenticateRuntimeSourceReaderDirectory(resolved);
  const before = await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride, { exact: true });
  const after = await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride, { exact: true });
  if (!sameRuntimeSourceSnapshot(before, after)) {
    throw new Error("Phase 3 exact-five runtime source set changed during aggregate read");
  }
  await authenticateRuntimeSourceReaderDirectory(resolved, sourceRoot);
  const aggregate = {};
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    const record = after.records[sourceId].record;
    aggregate[sourceId] = {
      value: record.value,
      bytes: record.bytes,
      sha256: record.sha256,
    };
  }
  return freezeClone(aggregate);
}

export async function writePhase3RuntimeSource(sourceId, value, options = {}) {
  if (
    arguments.length < 2 ||
    arguments.length > 3 ||
    (arguments.length === 3 && arguments[2] === undefined)
  ) {
    throw new Error("writePhase3RuntimeSource received an invalid argument count");
  }
  assertRuntimeSourceId(sourceId);
  validateRuntimeSourceDocumentIdentity(
    sourceId,
    value,
    `Phase 3 runtime source ${sourceId}`,
  );
  const canonical = canonicalJson(value);
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUNTIME_SOURCE_BYTES) {
    throw new Error("Phase 3 runtime source exceeds the 128 KiB byte-size contract");
  }
  parseCanonicalRuntimeSourceDocument(
    bytes,
    sourceId,
    `Phase 3 runtime source ${sourceId}`,
  );
  const resolved = validateRuntimeSourceWriteOptions(options);
  const { sourceRoot, tempRoot } = await provisionRuntimeSourceWriterDirectories(resolved);
  if (sourceRoot.status.dev !== tempRoot.status.dev) {
    throw new Error("Phase 3 runtime source roots are cross-device; hard-link publication is required");
  }
  await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride, {
    allowedNlinks: [1n, 2n],
  });
  await recoverRuntimeSourceTemps(sourceRoot, tempRoot, resolved.testOverride);
  await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride);

  const destination = join(sourceRoot.path, `${sourceId}.json`);
  const temporary = join(tempRoot.path, `${sourceId}.${randomUUID()}.tmp`);
  let handle;
  let createdStatus;
  let linked = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        runtimeSourceNoFollowFlag(
          resolved.testOverride,
          "Phase 3 runtime source temporary publication",
        ),
      0o600,
    );
    createdStatus = await handle.stat({ bigint: true });
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(tempRoot.path);

    const verifiedTemp = await stableReadRuntimeSourceFile(temporary, {
      testOverride: resolved.testOverride,
      label: `Phase 3 newly written runtime source temporary ${sourceId}`,
      allowedNlinks: [1n],
    });
    const verifiedParsed = parseCanonicalRuntimeSourceDocument(
      verifiedTemp.bytes,
      sourceId,
      `Phase 3 newly written runtime source temporary ${sourceId}`,
    );
    if (
      !verifiedTemp.bytes.equals(bytes) ||
      canonicalJson(verifiedParsed.value) !== canonical
    ) {
      throw new Error("Phase 3 runtime source temporary bytes changed after fsync");
    }
    createdStatus = verifiedTemp.status;

    try {
      await link(temporary, destination);
      linked = true;
    } catch (error) {
      if (errorCode(error, "EXDEV")) {
        throw new Error("Phase 3 runtime source roots are cross-device; hard-link publication is required");
      }
      if (!errorCode(error, "EEXIST")) throw error;
      const existing = await readRuntimeSourceAtPath(
        destination,
        sourceId,
        resolved.testOverride,
        [1n],
      );
      if (existing.record.bytes !== canonical) {
        throw new Error("Phase 3 runtime source conflicts with the installed create-once source");
      }
      await unlinkAuthenticatedRuntimeTemp(
        temporary,
        verifiedTemp.status,
        1n,
        tempRoot.path,
        resolved.testOverride,
      );
      const afterIdempotent = await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride);
      const stableExisting = afterIdempotent.records[sourceId];
      if (!stableExisting || stableExisting.record.bytes !== canonical) {
        throw new Error("Phase 3 idempotent runtime source changed during publication");
      }
      await authenticateRuntimeSourceWriterDirectories(
        resolved,
        sourceRoot,
        tempRoot,
      );
      return stableExisting.record;
    }

    await syncDirectory(sourceRoot.path);
    const installed = await stableReadRuntimeSourceFile(destination, {
      testOverride: resolved.testOverride,
      label: `Phase 3 installed runtime source ${sourceId}`,
      allowedNlinks: [2n],
    });
    const linkedTemp = await stableReadRuntimeSourceFile(temporary, {
      testOverride: resolved.testOverride,
      label: `Phase 3 linked runtime source temporary ${sourceId}`,
      allowedNlinks: [2n],
    });
    parseCanonicalRuntimeSourceDocument(
      installed.bytes,
      sourceId,
      `Phase 3 installed runtime source ${sourceId}`,
    );
    parseCanonicalRuntimeSourceDocument(
      linkedTemp.bytes,
      sourceId,
      `Phase 3 linked runtime source temporary ${sourceId}`,
    );
    if (
      !sameInodeAndSize(installed.status, linkedTemp.status) ||
      !sameInodeAndSize(installed.status, verifiedTemp.status) ||
      !installed.bytes.equals(bytes) ||
      !linkedTemp.bytes.equals(bytes)
    ) {
      throw new Error("Phase 3 installed runtime source is not the fsynced temporary inode and bytes");
    }

    const authenticatedInstalled = await stableReadRuntimeSourceFile(destination, {
      testOverride: resolved.testOverride,
      label: `Phase 3 re-authenticated installed runtime source ${sourceId}`,
      allowedNlinks: [2n],
    });
    const authenticatedTemp = await stableReadRuntimeSourceFile(temporary, {
      testOverride: resolved.testOverride,
      label: `Phase 3 re-authenticated linked runtime source temporary ${sourceId}`,
      allowedNlinks: [2n],
    });
    if (
      !sameInodeAndSize(authenticatedInstalled.status, authenticatedTemp.status) ||
      !sameInodeAndSize(authenticatedInstalled.status, installed.status) ||
      !authenticatedInstalled.bytes.equals(authenticatedTemp.bytes) ||
      !authenticatedInstalled.bytes.equals(bytes)
    ) {
      throw new Error("Phase 3 runtime source linked pair changed before cleanup");
    }
    await unlinkAuthenticatedRuntimeTemp(
      temporary,
      authenticatedTemp.status,
      2n,
      tempRoot.path,
      resolved.testOverride,
    );

    const finalized = await stableReadRuntimeSourceFile(destination, {
      testOverride: resolved.testOverride,
      label: `Phase 3 finalized runtime source ${sourceId}`,
      allowedNlinks: [1n],
    });
    const finalizedParsed = parseCanonicalRuntimeSourceDocument(
      finalized.bytes,
      sourceId,
      `Phase 3 finalized runtime source ${sourceId}`,
    );
    if (
      !sameInodeAndSize(finalized.status, authenticatedInstalled.status) ||
      !finalized.bytes.equals(bytes) ||
      canonicalJson(finalizedParsed.value) !== canonical
    ) {
      throw new Error("Phase 3 finalized runtime source identity or bytes changed after cleanup");
    }
    const after = await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride);
    const stableFinal = after.records[sourceId];
    if (
      !stableFinal ||
      !sameInodeAndSize(stableFinal.status, finalized.status) ||
      stableFinal.record.bytes !== canonical
    ) {
      throw new Error("Phase 3 runtime source set changed after publication");
    }
    await authenticateRuntimeSourceWriterDirectories(resolved, sourceRoot, tempRoot);
    return stableFinal.record;
  } catch (error) {
    if (handle) {
      createdStatus = await handle.stat({ bigint: true }).catch(() => createdStatus);
      await handle.close();
      handle = null;
    }
    if (!linked) {
      await removeUnpublishedRuntimeTemp(
        temporary,
        tempRoot.path,
        resolved.testOverride,
        createdStatus,
      );
    }
    throw error;
  }
}

const CAPACITY_OBSERVATION_FIELDS = Object.freeze([
  "schemaVersion",
  "context",
  "capacity",
  "productionObserver",
]);

function validateCapacityObservationCheckpointValue(value, label) {
  scanRuntimeSource(value);
  assertExactObject(value, CAPACITY_OBSERVATION_FIELDS, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion must be exactly 1`);
  }
  for (const field of ["context", "capacity", "productionObserver"]) {
    if (!isPlainObject(value[field])) {
      throw new Error(`${label}.${field} must be a plain object`);
    }
  }
  return value;
}

function parseCanonicalCapacityObservationCheckpoint(bytes, label) {
  const parsed = parseCanonicalRuntimeSource(bytes, label);
  validateCapacityObservationCheckpointValue(parsed.value, label);
  return parsed;
}

function validateCapacityObservationCheckpointReadOptions(options) {
  const keys = validateRuntimeSourceOptionsObject(
    options,
    ["rootPath"],
    "Phase 3 capacity observation checkpoint reader",
  );
  if (keys.length === 0) {
    return { rootPath: CAPACITY_OBSERVATION_ROOT, testOverride: false };
  }
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Phase 3 capacity observation checkpoint reader root override is test-only");
  }
  if (typeof options.rootPath !== "string" || !isAbsolute(options.rootPath)) {
    throw new Error("Phase 3 capacity observation checkpoint reader root override must be absolute");
  }
  return { rootPath: resolve(options.rootPath), testOverride: true };
}

function validateCapacityObservationCheckpointWriteOptions(options) {
  const keys = validateRuntimeSourceOptionsObject(
    options,
    ["rootPath", "tempRootPath"],
    "Phase 3 capacity observation checkpoint writer",
  );
  if (keys.length === 0) {
    return {
      rootPath: CAPACITY_OBSERVATION_ROOT,
      tempRootPath: CAPACITY_OBSERVATION_TEMP_ROOT,
      testOverride: false,
    };
  }
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Phase 3 capacity observation checkpoint writer root overrides are test-only");
  }
  if (keys.length !== 2 || !keys.includes("rootPath") || !keys.includes("tempRootPath")) {
    throw new Error(
      "Phase 3 capacity observation checkpoint root and temporary root overrides must appear together",
    );
  }
  if (
    typeof options.rootPath !== "string" ||
    typeof options.tempRootPath !== "string" ||
    !isAbsolute(options.rootPath) ||
    !isAbsolute(options.tempRootPath)
  ) {
    throw new Error("Phase 3 capacity observation checkpoint root overrides must be absolute");
  }
  const rootPath = resolve(options.rootPath);
  const tempRootPath = resolve(options.tempRootPath);
  if (
    comparablePath(rootPath) === comparablePath(tempRootPath) ||
    comparablePath(dirname(rootPath)) !== comparablePath(dirname(tempRootPath))
  ) {
    throw new Error(
      "Phase 3 capacity observation checkpoint roots must be distinct sibling directories with one parent",
    );
  }
  return { rootPath, tempRootPath, testOverride: true };
}

async function readCapacityObservationCheckpointAtPath(path, testOverride, allowedNlinks = [1n]) {
  if (basename(path) !== CAPACITY_OBSERVATION_FILE) {
    throw new Error("Phase 3 capacity observation checkpoint path does not match its fixed mapping");
  }
  const stable = await stableReadRuntimeSourceFile(path, {
    testOverride,
    label: "Phase 3 capacity observation checkpoint",
    allowedNlinks,
  });
  const parsed = parseCanonicalCapacityObservationCheckpoint(
    stable.bytes,
    "Phase 3 capacity observation checkpoint",
  );
  return {
    status: stable.status,
    record: freezeClone({
      path,
      value: parsed.value,
      bytes: parsed.text,
      sha256: sha256(stable.bytes),
    }),
  };
}

async function provisionCapacityObservationCheckpointWriterDirectories(resolved) {
  if (resolved.testOverride) {
    const commonParentPath = dirname(resolved.rootPath);
    if (comparablePath(commonParentPath) !== comparablePath(dirname(resolved.tempRootPath))) {
      throw new Error("Phase 3 capacity observation checkpoint roots must share one fixed parent");
    }
    const commonParent = await secureDirectory(
      commonParentPath,
      true,
      "Phase 3 capacity observation checkpoint common parent",
    );
    const checkpointRoot = await ensureRuntimeSourceDirectory(
      resolved.rootPath,
      commonParent,
      true,
      "Phase 3 capacity observation checkpoint root",
    );
    const refreshedParent = await secureDirectory(
      commonParent.path,
      true,
      "Phase 3 capacity observation checkpoint common parent",
    );
    const tempRoot = await ensureRuntimeSourceDirectory(
      resolved.tempRootPath,
      refreshedParent,
      true,
      "Phase 3 capacity observation checkpoint temporary root",
    );
    const parentAfter = await secureDirectory(
      commonParent.path,
      true,
      "Phase 3 capacity observation checkpoint common parent",
    );
    if (!sameInode(commonParent.status, parentAfter.status)) {
      throw new Error(
        "Phase 3 capacity observation checkpoint common parent identity changed during provisioning",
      );
    }
    return {
      checkpointRoot: { ...checkpointRoot, chain: { commonParent: parentAfter.status } },
      tempRoot,
    };
  }

  const rollout = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidence = await ensureRuntimeSourceDirectory(
    EVIDENCE_ROOT,
    rollout,
    false,
    "Phase 3 evidence root",
  );
  const checkpointRoot = await ensureRuntimeSourceDirectory(
    CAPACITY_OBSERVATION_ROOT,
    evidence,
    false,
    "Phase 3 capacity observation checkpoint root",
  );
  const refreshedEvidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  const tempRoot = await ensureRuntimeSourceDirectory(
    CAPACITY_OBSERVATION_TEMP_ROOT,
    refreshedEvidence,
    false,
    "Phase 3 capacity observation checkpoint temporary root",
  );
  const rolloutAfter = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidenceAfter = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  if (
    !sameInode(rollout.status, rolloutAfter.status) ||
    !sameInode(evidence.status, evidenceAfter.status)
  ) {
    throw new Error(
      "Phase 3 capacity observation checkpoint directory chain changed during provisioning",
    );
  }
  return {
    checkpointRoot: {
      ...checkpointRoot,
      chain: { rollout: rolloutAfter.status, evidence: evidenceAfter.status },
    },
    tempRoot,
  };
}

async function authenticateCapacityObservationCheckpointReaderDirectory(resolved, expected) {
  if (resolved.testOverride) {
    const commonParent = await secureDirectory(
      dirname(resolved.rootPath),
      true,
      "Phase 3 capacity observation checkpoint common parent",
    );
    const checkpointRoot = await secureDirectory(
      resolved.rootPath,
      true,
      "Phase 3 capacity observation checkpoint root",
    );
    const parentAfter = await secureDirectory(
      commonParent.path,
      true,
      "Phase 3 capacity observation checkpoint common parent",
    );
    if (!sameInode(commonParent.status, parentAfter.status)) {
      throw new Error(
        "Phase 3 capacity observation checkpoint common parent identity changed during authentication",
      );
    }
    if (
      expected &&
      (!sameInode(expected.status, checkpointRoot.status) ||
        !sameInode(expected.chain.commonParent, parentAfter.status))
    ) {
      throw new Error(
        "Phase 3 capacity observation checkpoint parent or root identity changed between authentications",
      );
    }
    return { ...checkpointRoot, chain: { commonParent: parentAfter.status } };
  }

  const rollout = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  const checkpointRoot = await secureDirectory(
    CAPACITY_OBSERVATION_ROOT,
    false,
    "Phase 3 capacity observation checkpoint root",
  );
  const rolloutAfter = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidenceAfter = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  if (
    !sameInode(rollout.status, rolloutAfter.status) ||
    !sameInode(evidence.status, evidenceAfter.status)
  ) {
    throw new Error(
      "Phase 3 capacity observation checkpoint directory chain changed during authentication",
    );
  }
  if (
    expected &&
    (!sameInode(expected.status, checkpointRoot.status) ||
      !sameInode(expected.chain.rollout, rolloutAfter.status) ||
      !sameInode(expected.chain.evidence, evidenceAfter.status))
  ) {
    throw new Error(
      "Phase 3 capacity observation checkpoint directory chain identity changed between authentications",
    );
  }
  return {
    ...checkpointRoot,
    chain: { rollout: rolloutAfter.status, evidence: evidenceAfter.status },
  };
}

async function authenticateCapacityObservationCheckpointWriterDirectories(
  resolved,
  expectedCheckpointRoot,
  expectedTempRoot,
) {
  await authenticateCapacityObservationCheckpointReaderDirectory(
    resolved,
    expectedCheckpointRoot,
  );
  const tempRoot = await secureDirectory(
    resolved.tempRootPath,
    resolved.testOverride,
    "Phase 3 capacity observation checkpoint temporary root",
  );
  if (!sameInode(expectedTempRoot.status, tempRoot.status)) {
    throw new Error(
      "Phase 3 capacity observation checkpoint temporary root identity changed between authentications",
    );
  }
  if (resolved.testOverride) {
    const parent = await secureDirectory(
      dirname(resolved.tempRootPath),
      true,
      "Phase 3 capacity observation checkpoint common parent",
    );
    if (!sameInode(expectedCheckpointRoot.chain.commonParent, parent.status)) {
      throw new Error(
        "Phase 3 capacity observation checkpoint writer parent identity changed between authentications",
      );
    }
  } else {
    const evidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
    if (!sameInode(expectedCheckpointRoot.chain.evidence, evidence.status)) {
      throw new Error(
        "Phase 3 capacity observation checkpoint writer evidence-root identity changed between authentications",
      );
    }
  }
}

async function inspectCapacityObservationCheckpointRoot(
  checkpointRoot,
  testOverride,
  { allowedNlinks = [1n] } = {},
) {
  const before = await lstat(checkpointRoot.path, { bigint: true });
  assertOwnerAndMode(before, 0o700, testOverride, "Phase 3 capacity observation checkpoint root");
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(
      "Phase 3 capacity observation checkpoint root must be a regular non-symlink directory",
    );
  }
  if (!sameInode(checkpointRoot.status, before)) {
    throw new Error(
      "Phase 3 capacity observation checkpoint root identity changed after directory-chain authentication",
    );
  }
  const entries = await readdir(checkpointRoot.path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== CAPACITY_OBSERVATION_FILE) {
      throw new Error("Phase 3 capacity observation checkpoint root contains an unexpected entry");
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        "Phase 3 capacity observation checkpoint root contains a non-regular or symlink entry",
      );
    }
  }
  const checkpoint = entries.length === 1
    ? await readCapacityObservationCheckpointAtPath(
        join(checkpointRoot.path, CAPACITY_OBSERVATION_FILE),
        testOverride,
        allowedNlinks,
      )
    : null;
  const after = await lstat(checkpointRoot.path, { bigint: true });
  assertOwnerAndMode(after, 0o700, testOverride, "Phase 3 capacity observation checkpoint root");
  if (!sameIdentity(before, after)) {
    throw new Error(
      "Phase 3 capacity observation checkpoint root changed during stable file-set authentication",
    );
  }
  return { status: after, checkpoint };
}

function sameCapacityObservationCheckpointSnapshot(left, right) {
  if (!sameIdentity(left.status, right.status)) return false;
  if (Boolean(left.checkpoint) !== Boolean(right.checkpoint)) return false;
  return !left.checkpoint || (
    sameIdentity(left.checkpoint.status, right.checkpoint.status) &&
    left.checkpoint.record.bytes === right.checkpoint.record.bytes &&
    left.checkpoint.record.sha256 === right.checkpoint.record.sha256
  );
}

async function planCapacityObservationCheckpointTempRecovery(
  checkpointRoot,
  tempRoot,
  testOverride,
) {
  const tempBefore = await secureDirectory(
    tempRoot.path,
    testOverride,
    "Phase 3 capacity observation checkpoint temporary root",
  );
  const checkpointBefore = await inspectCapacityObservationCheckpointRoot(
    checkpointRoot,
    testOverride,
    { allowedNlinks: [1n, 2n] },
  );
  const entries = await readdir(tempRoot.path, { withFileTypes: true });
  if (entries.length > MAX_TEMP_ENTRIES) {
    throw new Error(
      "Phase 3 capacity observation checkpoint temporary root exceeds its 64-entry recovery limit",
    );
  }
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    if (!CAPACITY_OBSERVATION_TEMP.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        "Phase 3 capacity observation checkpoint temporary root contains an unexpected checkpoint-qualified entry",
      );
    }
  }
  const plans = [];
  let linkedCheckpointSeen = false;
  for (const entry of sortedEntries) {
    const temporary = join(tempRoot.path, entry.name);
    const statusBefore = await lstat(temporary, { bigint: true });
    assertRuntimeSourceFileStatus(
      statusBefore,
      testOverride,
      "Phase 3 capacity observation checkpoint recovery temporary",
      { allowEmpty: true, allowedNlinks: [1n, 2n], enforceMaximum: false },
    );
    const statusAfter = await lstat(temporary, { bigint: true });
    if (!sameIdentity(statusBefore, statusAfter)) {
      throw new Error(
        "Phase 3 capacity observation checkpoint recovery temporary identity is unstable",
      );
    }
    if (statusAfter.nlink === 1n) {
      plans.push({ kind: "orphan", temporary, tempStatus: statusAfter, nlink: 1n });
      continue;
    }
    if (linkedCheckpointSeen) {
      throw new Error(
        "Phase 3 capacity observation checkpoint recovery has ambiguous duplicate linked temporaries",
      );
    }
    const stableTemp = await stableReadRuntimeSourceFile(temporary, {
      testOverride,
      label: "Phase 3 linked capacity observation checkpoint temporary",
      allowedNlinks: [2n],
    });
    if (!sameIdentity(statusAfter, stableTemp.status)) {
      throw new Error(
        "Phase 3 linked capacity observation checkpoint temporary changed during planning",
      );
    }
    parseCanonicalCapacityObservationCheckpoint(
      stableTemp.bytes,
      "Phase 3 linked capacity observation checkpoint temporary",
    );
    const destination = join(checkpointRoot.path, CAPACITY_OBSERVATION_FILE);
    const installed = await stableReadRuntimeSourceFile(destination, {
      testOverride,
      label: "Phase 3 recovered capacity observation checkpoint destination",
      allowedNlinks: [2n],
    });
    parseCanonicalCapacityObservationCheckpoint(
      installed.bytes,
      "Phase 3 recovered capacity observation checkpoint destination",
    );
    if (
      !sameInodeAndSize(stableTemp.status, installed.status) ||
      !stableTemp.bytes.equals(installed.bytes)
    ) {
      throw new Error(
        "Phase 3 linked capacity observation checkpoint temporary does not match its fixed destination inode and bytes",
      );
    }
    linkedCheckpointSeen = true;
    plans.push({
      kind: "linked",
      temporary,
      destination,
      tempStatus: stableTemp.status,
      destinationStatus: installed.status,
      bytes: stableTemp.bytes,
      nlink: 2n,
    });
  }
  await authenticatePlannedRecoveryTempSet(
    tempRoot,
    tempBefore,
    entries,
    plans,
    testOverride,
    "Phase 3 capacity observation checkpoint recovery",
  );
  const checkpointAfter = await inspectCapacityObservationCheckpointRoot(
    checkpointRoot,
    testOverride,
    { allowedNlinks: [1n, 2n] },
  );
  if (!sameCapacityObservationCheckpointSnapshot(checkpointBefore, checkpointAfter)) {
    throw new Error(
      "Phase 3 capacity observation checkpoint destination changed during recovery planning",
    );
  }
  return { plans, tempBefore };
}

async function executeCapacityObservationCheckpointTempRecoveryPlan(
  plan,
  checkpointRoot,
  tempRoot,
  testOverride,
) {
  if (plan.kind === "orphan") {
    await unlinkAuthenticatedRuntimeTemp(
      plan.temporary,
      plan.tempStatus,
      1n,
      tempRoot.path,
      testOverride,
    );
    return;
  }
  const authenticatedTemp = await stableReadRuntimeSourceFile(plan.temporary, {
    testOverride,
    label: "Phase 3 re-authenticated linked capacity observation checkpoint temporary",
    allowedNlinks: [2n],
  });
  const authenticatedDestination = await stableReadRuntimeSourceFile(plan.destination, {
    testOverride,
    label: "Phase 3 re-authenticated capacity observation checkpoint destination",
    allowedNlinks: [2n],
  });
  parseCanonicalCapacityObservationCheckpoint(
    authenticatedTemp.bytes,
    "Phase 3 re-authenticated linked capacity observation checkpoint temporary",
  );
  parseCanonicalCapacityObservationCheckpoint(
    authenticatedDestination.bytes,
    "Phase 3 re-authenticated capacity observation checkpoint destination",
  );
  if (
    !sameIdentity(authenticatedTemp.status, plan.tempStatus) ||
    !sameIdentity(authenticatedDestination.status, plan.destinationStatus) ||
    !sameInodeAndSize(authenticatedTemp.status, authenticatedDestination.status) ||
    !authenticatedTemp.bytes.equals(authenticatedDestination.bytes) ||
    !authenticatedTemp.bytes.equals(plan.bytes)
  ) {
    throw new Error(
      "Phase 3 linked capacity observation checkpoint pair changed before recovery cleanup",
    );
  }
  await syncDirectory(checkpointRoot.path);
  const finalTempAuthentication = await stableReadRuntimeSourceFile(plan.temporary, {
    testOverride,
    label: "Phase 3 final linked capacity observation checkpoint temporary",
    allowedNlinks: [2n],
  });
  const finalDestinationAuthentication = await stableReadRuntimeSourceFile(plan.destination, {
    testOverride,
    label: "Phase 3 final capacity observation checkpoint destination",
    allowedNlinks: [2n],
  });
  if (
    !sameIdentity(finalTempAuthentication.status, authenticatedTemp.status) ||
    !sameIdentity(finalDestinationAuthentication.status, authenticatedDestination.status) ||
    !finalTempAuthentication.bytes.equals(finalDestinationAuthentication.bytes) ||
    !finalTempAuthentication.bytes.equals(plan.bytes)
  ) {
    throw new Error(
      "Phase 3 linked capacity observation checkpoint pair changed during final authentication",
    );
  }
  await unlinkAuthenticatedRuntimeTemp(
    plan.temporary,
    finalTempAuthentication.status,
    2n,
    tempRoot.path,
    testOverride,
  );
  const finalized = await stableReadRuntimeSourceFile(plan.destination, {
    testOverride,
    label: "Phase 3 recovered finalized capacity observation checkpoint",
    allowedNlinks: [1n],
  });
  if (
    !sameInodeAndSize(finalized.status, finalDestinationAuthentication.status) ||
    !finalized.bytes.equals(finalDestinationAuthentication.bytes)
  ) {
    throw new Error(
      "Phase 3 recovered capacity observation checkpoint changed after temporary cleanup",
    );
  }
  parseCanonicalCapacityObservationCheckpoint(
    finalized.bytes,
    "Phase 3 recovered finalized capacity observation checkpoint",
  );
}

async function recoverCapacityObservationCheckpointTemps(
  checkpointRoot,
  tempRoot,
  testOverride,
) {
  const { plans, tempBefore } = await planCapacityObservationCheckpointTempRecovery(
    checkpointRoot,
    tempRoot,
    testOverride,
  );
  for (const plan of plans) {
    await executeCapacityObservationCheckpointTempRecoveryPlan(
      plan,
      checkpointRoot,
      tempRoot,
      testOverride,
    );
  }
  await syncDirectory(tempRoot.path);
  if ((await readdir(tempRoot.path)).length !== 0) {
    throw new Error(
      "Phase 3 capacity observation checkpoint temporary root changed during recovery",
    );
  }
  await syncDirectory(checkpointRoot.path);
  const tempAfter = await secureDirectory(
    tempRoot.path,
    testOverride,
    "Phase 3 capacity observation checkpoint temporary root",
  );
  if (!sameInode(tempBefore.status, tempAfter.status)) {
    throw new Error(
      "Phase 3 capacity observation checkpoint temporary root identity changed during recovery",
    );
  }
}

function capacityObservationCheckpointMissingError() {
  const error = new Error("Phase 3 capacity observation checkpoint is missing");
  error.code = "ENOENT";
  return error;
}

export async function readPhase3CapacityObservationCheckpoint(options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) {
    throw new Error("readPhase3CapacityObservationCheckpoint received an invalid argument count");
  }
  const resolved = validateCapacityObservationCheckpointReadOptions(options);
  const checkpointRoot = await authenticateCapacityObservationCheckpointReaderDirectory(resolved);
  const before = await inspectCapacityObservationCheckpointRoot(
    checkpointRoot,
    resolved.testOverride,
  );
  if (!before.checkpoint) {
    const afterMissing = await inspectCapacityObservationCheckpointRoot(
      checkpointRoot,
      resolved.testOverride,
    );
    if (!sameCapacityObservationCheckpointSnapshot(before, afterMissing)) {
      throw new Error(
        "Phase 3 capacity observation checkpoint set changed while confirming a missing checkpoint",
      );
    }
    await authenticateCapacityObservationCheckpointReaderDirectory(resolved, checkpointRoot);
    throw capacityObservationCheckpointMissingError();
  }
  const after = await inspectCapacityObservationCheckpointRoot(
    checkpointRoot,
    resolved.testOverride,
  );
  if (!sameCapacityObservationCheckpointSnapshot(before, after)) {
    throw new Error("Phase 3 capacity observation checkpoint changed during read");
  }
  await authenticateCapacityObservationCheckpointReaderDirectory(resolved, checkpointRoot);
  return after.checkpoint.record;
}

export async function writePhase3CapacityObservationCheckpoint(value, options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length < 1 ||
    arguments.length > 2 ||
    (arguments.length === 2 && arguments[1] === undefined)
  ) {
    throw new Error("writePhase3CapacityObservationCheckpoint received an invalid argument count");
  }
  validateCapacityObservationCheckpointValue(
    value,
    "Phase 3 capacity observation checkpoint",
  );
  const canonical = canonicalJson(value);
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUNTIME_SOURCE_BYTES) {
    throw new Error(
      "Phase 3 capacity observation checkpoint exceeds the 128 KiB byte-size contract",
    );
  }
  parseCanonicalCapacityObservationCheckpoint(
    bytes,
    "Phase 3 capacity observation checkpoint",
  );
  const resolved = validateCapacityObservationCheckpointWriteOptions(options);
  const { checkpointRoot, tempRoot } =
    await provisionCapacityObservationCheckpointWriterDirectories(resolved);
  if (checkpointRoot.status.dev !== tempRoot.status.dev) {
    throw new Error(
      "Phase 3 capacity observation checkpoint roots are cross-device; hard-link publication is required",
    );
  }
  await inspectCapacityObservationCheckpointRoot(checkpointRoot, resolved.testOverride, {
    allowedNlinks: [1n, 2n],
  });
  await recoverCapacityObservationCheckpointTemps(
    checkpointRoot,
    tempRoot,
    resolved.testOverride,
  );
  await inspectCapacityObservationCheckpointRoot(checkpointRoot, resolved.testOverride);

  const destination = join(checkpointRoot.path, CAPACITY_OBSERVATION_FILE);
  const temporary = join(
    tempRoot.path,
    `capacity-observation.${randomUUID()}.tmp`,
  );
  let handle;
  let createdStatus;
  let linked = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        runtimeSourceNoFollowFlag(
          resolved.testOverride,
          "Phase 3 capacity observation checkpoint temporary publication",
        ),
      0o600,
    );
    createdStatus = await handle.stat({ bigint: true });
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(tempRoot.path);

    const verifiedTemp = await stableReadRuntimeSourceFile(temporary, {
      testOverride: resolved.testOverride,
      label: "Phase 3 newly written capacity observation checkpoint temporary",
      allowedNlinks: [1n],
    });
    const verifiedParsed = parseCanonicalCapacityObservationCheckpoint(
      verifiedTemp.bytes,
      "Phase 3 newly written capacity observation checkpoint temporary",
    );
    if (
      !verifiedTemp.bytes.equals(bytes) ||
      canonicalJson(verifiedParsed.value) !== canonical
    ) {
      throw new Error(
        "Phase 3 capacity observation checkpoint temporary bytes changed after fsync",
      );
    }
    createdStatus = verifiedTemp.status;

    try {
      await link(temporary, destination);
      linked = true;
    } catch (error) {
      if (errorCode(error, "EXDEV")) {
        throw new Error(
          "Phase 3 capacity observation checkpoint roots are cross-device; hard-link publication is required",
        );
      }
      if (!errorCode(error, "EEXIST")) throw error;
      const existing = await readCapacityObservationCheckpointAtPath(
        destination,
        resolved.testOverride,
        [1n],
      );
      if (existing.record.bytes !== canonical) {
        throw new Error(
          "Phase 3 capacity observation checkpoint conflicts with the installed create-once checkpoint",
        );
      }
      await unlinkAuthenticatedRuntimeTemp(
        temporary,
        verifiedTemp.status,
        1n,
        tempRoot.path,
        resolved.testOverride,
      );
      const afterIdempotent = await inspectCapacityObservationCheckpointRoot(
        checkpointRoot,
        resolved.testOverride,
      );
      if (!afterIdempotent.checkpoint || afterIdempotent.checkpoint.record.bytes !== canonical) {
        throw new Error(
          "Phase 3 idempotent capacity observation checkpoint changed during publication",
        );
      }
      await authenticateCapacityObservationCheckpointWriterDirectories(
        resolved,
        checkpointRoot,
        tempRoot,
      );
      return afterIdempotent.checkpoint.record;
    }

    await syncDirectory(checkpointRoot.path);
    const installed = await stableReadRuntimeSourceFile(destination, {
      testOverride: resolved.testOverride,
      label: "Phase 3 installed capacity observation checkpoint",
      allowedNlinks: [2n],
    });
    const linkedTemp = await stableReadRuntimeSourceFile(temporary, {
      testOverride: resolved.testOverride,
      label: "Phase 3 linked capacity observation checkpoint temporary",
      allowedNlinks: [2n],
    });
    parseCanonicalCapacityObservationCheckpoint(
      installed.bytes,
      "Phase 3 installed capacity observation checkpoint",
    );
    parseCanonicalCapacityObservationCheckpoint(
      linkedTemp.bytes,
      "Phase 3 linked capacity observation checkpoint temporary",
    );
    if (
      !sameInodeAndSize(installed.status, linkedTemp.status) ||
      !sameInodeAndSize(installed.status, verifiedTemp.status) ||
      !installed.bytes.equals(bytes) ||
      !linkedTemp.bytes.equals(bytes)
    ) {
      throw new Error(
        "Phase 3 installed capacity observation checkpoint is not the fsynced temporary inode and bytes",
      );
    }

    const authenticatedInstalled = await stableReadRuntimeSourceFile(destination, {
      testOverride: resolved.testOverride,
      label: "Phase 3 re-authenticated installed capacity observation checkpoint",
      allowedNlinks: [2n],
    });
    const authenticatedTemp = await stableReadRuntimeSourceFile(temporary, {
      testOverride: resolved.testOverride,
      label: "Phase 3 re-authenticated linked capacity observation checkpoint temporary",
      allowedNlinks: [2n],
    });
    if (
      !sameInodeAndSize(authenticatedInstalled.status, authenticatedTemp.status) ||
      !sameInodeAndSize(authenticatedInstalled.status, installed.status) ||
      !authenticatedInstalled.bytes.equals(authenticatedTemp.bytes) ||
      !authenticatedInstalled.bytes.equals(bytes)
    ) {
      throw new Error(
        "Phase 3 capacity observation checkpoint linked pair changed before cleanup",
      );
    }
    await unlinkAuthenticatedRuntimeTemp(
      temporary,
      authenticatedTemp.status,
      2n,
      tempRoot.path,
      resolved.testOverride,
    );

    const finalized = await stableReadRuntimeSourceFile(destination, {
      testOverride: resolved.testOverride,
      label: "Phase 3 finalized capacity observation checkpoint",
      allowedNlinks: [1n],
    });
    const finalizedParsed = parseCanonicalCapacityObservationCheckpoint(
      finalized.bytes,
      "Phase 3 finalized capacity observation checkpoint",
    );
    if (
      !sameInodeAndSize(finalized.status, authenticatedInstalled.status) ||
      !finalized.bytes.equals(bytes) ||
      canonicalJson(finalizedParsed.value) !== canonical
    ) {
      throw new Error(
        "Phase 3 finalized capacity observation checkpoint identity or bytes changed after cleanup",
      );
    }
    const after = await inspectCapacityObservationCheckpointRoot(
      checkpointRoot,
      resolved.testOverride,
    );
    if (
      !after.checkpoint ||
      !sameInodeAndSize(after.checkpoint.status, finalized.status) ||
      after.checkpoint.record.bytes !== canonical
    ) {
      throw new Error(
        "Phase 3 capacity observation checkpoint set changed after publication",
      );
    }
    await authenticateCapacityObservationCheckpointWriterDirectories(
      resolved,
      checkpointRoot,
      tempRoot,
    );
    return after.checkpoint.record;
  } catch (error) {
    if (handle) {
      createdStatus = await handle.stat({ bigint: true }).catch(() => createdStatus);
      await handle.close();
      handle = null;
    }
    if (!linked) {
      await removeUnpublishedRuntimeTemp(
        temporary,
        tempRoot.path,
        resolved.testOverride,
        createdStatus,
      );
    }
    throw error;
  }
}

const PHASE3_SEMANTIC_FIELDS = Object.freeze([
  "schemaVersion",
  "release",
  "releaseEnvironment",
  "runtimeEnvironment",
  "drillMode",
  "composeProject",
  "stagingRunId",
  "approvalEnvelopeSha256",
  "targetDescriptor",
  "operatorBundle",
  "host",
  "guard",
  "baseline",
  "cutover",
  "runtime",
  "epoch",
  "fence",
  "drain",
  "rollback",
  "duplicates",
  "artifactBindings",
  "actionJournal",
  "timeline",
]);
const PHASE3_SEMANTIC_REQUIRED_ACTION_FIELDS = Object.freeze([
  "actionId",
  "status",
  "occurrences",
  "terminalRecordSha256",
  "completedAt",
  "measurementSha256",
]);
const PHASE3_SNAPSHOT_CONFIG = Object.freeze({
  label: "Phase 3 action journal snapshot",
  rootPath: PHASE3_SNAPSHOT_ROOT,
  tempRootPath: PHASE3_SNAPSHOT_TEMP_ROOT,
  file: PHASE3_SNAPSHOT_FILE,
  tempPrefix: "journal-snapshot",
  tempPattern: PHASE3_SNAPSHOT_TEMP,
  validate: validateRawPhase3ActionJournalSnapshot,
});
const PHASE3_SEMANTIC_CONFIG = Object.freeze({
  label: "Phase 3 semantic evidence",
  rootPath: PHASE3_SEMANTIC_ROOT,
  tempRootPath: PHASE3_SEMANTIC_TEMP_ROOT,
  file: PHASE3_SEMANTIC_FILE,
  tempPrefix: "phase3-rollout-evidence",
  tempPattern: PHASE3_SEMANTIC_TEMP,
  validate: validatePhase3SemanticEvidenceValue,
});

function assertExactEnumerableDataRecord(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
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

function scanSingletonJson(value, path = "$", seen = new Set()) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("Phase 3 singleton artifact contains secret-shaped content");
    }
    if (FORBIDDEN_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("Phase 3 singleton artifact contains a URL, endpoint, command, or SQL text");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw new Error("Phase 3 singleton artifact must be strict acyclic JSON");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`${path} has an invalid array prototype`);
    }
    const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) throw new Error(`${path} must be a dense array without extra fields`);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error(`${path}[${index}] must be an enumerable data property`);
      }
      scanSingletonJson(descriptor.value, `${path}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain JSON object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) throw new Error(`${path} fields must be enumerable data properties without symbols`);
    if (
      FORBIDDEN_PROTOTYPE_KEY.has(key) ||
      SECRET_KEY.test(key) ||
      /^(?:payloads?|messages?|errors?|bod(?:y|ies)|response[-_]?bod(?:y|ies)|environment[-_]?maps?|environment[-_]?variables?|urls?|endpoints?|commands?|sql)$/i.test(key)
    ) {
      throw new Error("Phase 3 singleton artifact contains a forbidden or secret field");
    }
    if (key === "environment" && isPlainObject(descriptor.value)) {
      throw new Error("Phase 3 singleton artifact contains a raw environment map");
    }
    scanSingletonJson(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function validateRawPhase3ActionJournalSnapshot(value, label = "Phase 3 action journal snapshot") {
  scanSingletonJson(value);
  assertExactEnumerableDataRecord(value, SNAPSHOT_FIELDS, label);
  if (value.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be exactly 1`);
  assertExactEnumerableDataRecord(value.binding, SNAPSHOT_BINDING_FIELDS, `${label} binding`);
  assertId(value.binding.approvalId, `${label} approval ID`);
  assertId(value.binding.stagingRunId, `${label} staging run ID`);
  for (const field of [
    "approvalEnvelopeSha256",
    "targetDescriptorSha256",
    "operatorBundleSha256",
  ]) assertHash(value.binding[field], `${label} binding ${field}`);
  assertPositiveSafeInteger(value.recordCount, `${label} record count`);
  assertHash(value.headSha256, `${label} head hash`);
  if (
    !Array.isArray(value.actions) ||
    value.actions.length !== REQUIRED_STAGING_ACTION_PLAN.length
  ) {
    throw new Error(`${label} actions must be the exact fixed 44-action plan`);
  }
  if (value.recordCount < value.actions.length) {
    throw new Error(`${label} record count is smaller than its action set`);
  }
  const actionIds = new Set();
  for (const [index, action] of value.actions.entries()) {
    const planned = REQUIRED_STAGING_ACTION_PLAN[index];
    assertExactEnumerableDataRecord(action, SNAPSHOT_ACTION_FIELDS, `${label} action`);
    if (action.sequence !== index + 1) throw new Error(`${label} sequence must be contiguous`);
    assertId(action.actionId, `${label} action ID`);
    assertId(action.scope, `${label} action scope`);
    if (!SNAPSHOT_KINDS.has(action.kind)) throw new Error(`${label} action kind is invalid`);
    assertHash(action.mutationSha256, `${label} mutation hash`);
    if (!sameCanonical({
      sequence: action.sequence,
      actionId: action.actionId,
      scope: action.scope,
      kind: action.kind,
      mutationSha256: action.mutationSha256,
    }, planned)) throw new Error(`${label} action identity differs from the fixed plan`);
    if (!SNAPSHOT_STATES.has(action.state)) throw new Error(`${label} action state is invalid`);
    assertNonnegativeSafeInteger(action.occurrences, `${label} action occurrences`);
    if (action.terminalRecordSha256 !== null) {
      assertHash(action.terminalRecordSha256, `${label} terminal hash`);
    }
    if (action.completedAt !== null) parseIso(action.completedAt, `${label} completion time`);
    if (action.reconciliationId !== null) assertId(action.reconciliationId, `${label} reconciliation ID`);
    if (action.reconciliationOutcome !== null) {
      assertId(action.reconciliationOutcome, `${label} reconciliation outcome`);
    }
    const terminal = action.state === "succeeded" || action.state === "reconciled";
    if (
      (terminal &&
        (action.occurrences !== 1 ||
          action.terminalRecordSha256 === null ||
          action.completedAt === null)) ||
      (!terminal &&
        (action.occurrences !== 0 ||
          action.terminalRecordSha256 !== null ||
          action.completedAt !== null)) ||
      (action.state === "reconciled" &&
        (action.reconciliationId === null || action.reconciliationOutcome !== "succeeded")) ||
      (action.state !== "reconciled" &&
        (action.reconciliationId !== null || action.reconciliationOutcome !== null))
    ) throw new Error(`${label} terminal and reconciliation fields are inconsistent`);
    if (actionIds.has(action.actionId)) throw new Error(`${label} contains a duplicate action ID`);
    actionIds.add(action.actionId);
  }
  return value;
}

export function validatePhase3PreGate4JournalSnapshot(value, expected, ...extra) {
  assertNoExtraArguments(extra, "validatePhase3PreGate4JournalSnapshot");
  scanSingletonJson(expected);
  assertExactEnumerableDataRecord(
    expected,
    ["installedBinding", "approvalId"],
    "Phase 3 pre-Gate-4 snapshot expected context",
  );
  const binding = validateInstalledBinding(expected.installedBinding);
  assertId(expected.approvalId, "Phase 3 pre-Gate-4 approval ID");
  validateRawPhase3ActionJournalSnapshot(value);
  if (
    value.binding.approvalId !== expected.approvalId ||
    value.binding.stagingRunId !== binding.stagingRunId ||
    value.binding.approvalEnvelopeSha256 !== binding.stagingApprovalEnvelopeSha256 ||
    value.binding.targetDescriptorSha256 !== binding.stagingTargetDescriptorSha256 ||
    value.binding.operatorBundleSha256 !== binding.operatorBundleSha256
  ) throw new Error("Phase 3 pre-Gate-4 snapshot binding or approval changed");
  const inlineSequence = 23;
  const expectedRecordCount = REQUIRED_STAGING_ACTION_PLAN.length + 2 * inlineSequence;
  if (
    value.actions.length !== REQUIRED_STAGING_ACTION_PLAN.length ||
    value.recordCount !== expectedRecordCount ||
    binding.actionJournalHeadSha256 !== value.headSha256
  ) throw new Error("Phase 3 pre-Gate-4 snapshot must have the exact 44-action/90-record head");
  const terminalHashes = new Set();
  for (const [index, action] of value.actions.entries()) {
    const planned = REQUIRED_STAGING_ACTION_PLAN[index];
    if (!sameCanonical({
      sequence: action.sequence,
      actionId: action.actionId,
      scope: action.scope,
      kind: action.kind,
      mutationSha256: action.mutationSha256,
    }, planned)) throw new Error("Phase 3 snapshot action identity differs from the fixed plan");
    if (action.sequence <= inlineSequence) {
      if (
        action.kind !== "forward" ||
        action.state !== "succeeded" ||
        action.occurrences !== 1 ||
        action.reconciliationId !== null ||
        action.reconciliationOutcome !== null
      ) throw new Error("Phase 3 snapshot prefix is not an ordinary succeeded terminal set");
      if (terminalHashes.has(action.terminalRecordSha256)) {
        throw new Error("Phase 3 snapshot contains a duplicate terminal hash");
      }
      terminalHashes.add(action.terminalRecordSha256);
    } else if (
      action.state !== "registered" ||
      action.occurrences !== 0 ||
      action.terminalRecordSha256 !== null ||
      action.completedAt !== null ||
      action.reconciliationId !== null ||
      action.reconciliationOutcome !== null
    ) throw new Error("Phase 3 post-prefix action is not an untouched registration");
  }
  const gate3 = value.actions[14];
  const phase3Actions = value.actions.slice(15, 23);
  const inlineRestore = phase3Actions.at(-1);
  if (
    gate3.actionId !== "staging-gate-3-handoff" ||
    inlineRestore?.actionId !== "phase3-inline-owner-restore" ||
    inlineRestore.terminalRecordSha256 !== value.headSha256 ||
    [...terminalHashes].filter((entry) => entry === value.headSha256).length !== 1
  ) throw new Error("Phase 3 inline restore is not the unique snapshot head");
  const windowStartedMs = parseIso(gate3.completedAt, "Gate 3 completion time");
  const windowEndedMs = parseIso(inlineRestore.completedAt, "inline restore completion time");
  if (windowStartedMs >= windowEndedMs) throw new Error("Phase 3 evidence window is not ordered");
  let previousPhase3Ms = windowStartedMs;
  for (const [index, action] of phase3Actions.entries()) {
    if (action.actionId !== PHASE3_ACTION_IDS[index]) {
      throw new Error("Phase 3 snapshot terminal order changed");
    }
    const completedMs = parseIso(action.completedAt, `${action.actionId} completion time`);
    if (completedMs <= windowStartedMs || completedMs < previousPhase3Ms || completedMs > windowEndedMs) {
      throw new Error("Phase 3 terminal is outside the exact evidence window or order");
    }
    previousPhase3Ms = completedMs;
  }
  return freezeClone({
    gate3,
    phase3Actions,
    inlineRestore,
    windowStartedAt: gate3.completedAt,
    windowEndedAt: inlineRestore.completedAt,
  });
}

function assertExactBooleanRecord(value, fields, label) {
  assertExactEnumerableDataRecord(value, fields, label);
  for (const field of fields) {
    if (typeof value[field] !== "boolean") throw new Error(`${label}.${field} must be boolean`);
  }
}

function validatePhase3SemanticEvidenceValue(value, label = "Phase 3 semantic evidence") {
  scanSingletonJson(value);
  assertExactEnumerableDataRecord(value, PHASE3_SEMANTIC_FIELDS, label);
  if (value.schemaVersion !== 2) throw new Error(`${label}.schemaVersion must be exactly 2`);
  validateReleaseBinding(value.release);
  assertCommitSha(value.release.candidateSha, `${label} release candidate SHA`);
  assertImageDigest(value.release.imageDigest, `${label} release image digest`);
  for (const field of [
    "releaseManifestSha256",
    "stagingTargetDescriptorSha256",
    "operatorBundleSha256",
    "stagingApprovalEnvelopeSha256",
    "actionJournalHeadSha256",
  ]) assertHash(value.release[field], `${label} release ${field}`);
  assertId(value.release.stagingRunId, `${label} release staging run ID`);
  if (
    value.release.environment !== "staging" ||
    value.release.topology !== "phase3" ||
    value.releaseEnvironment !== "staging" ||
    value.runtimeEnvironment !== "staging" ||
    value.drillMode !== "staging" ||
    value.composeProject !== "spx-staging"
  ) throw new Error(`${label} is not the exact staging environment tuple`);
  assertId(value.stagingRunId, `${label} staging run ID`);
  assertHash(value.approvalEnvelopeSha256, `${label} approval envelope hash`);
  assertExactEnumerableDataRecord(
    value.targetDescriptor,
    ["signed", "environment", "composeProject", "sha256"],
    `${label} target descriptor`,
  );
  if (
    value.targetDescriptor.signed !== true ||
    value.targetDescriptor.environment !== "staging" ||
    value.targetDescriptor.composeProject !== "spx-staging"
  ) throw new Error(`${label} target descriptor tuple is invalid`);
  assertHash(value.targetDescriptor.sha256, `${label} target descriptor hash`);
  assertExactEnumerableDataRecord(value.operatorBundle, ["installed", "sha256"], `${label} operator bundle`);
  if (value.operatorBundle.installed !== true) throw new Error(`${label} operator bundle is not installed`);
  assertHash(value.operatorBundle.sha256, `${label} operator bundle hash`);
  if (
    value.stagingRunId !== value.release.stagingRunId ||
    value.approvalEnvelopeSha256 !== value.release.stagingApprovalEnvelopeSha256 ||
    value.targetDescriptor.sha256 !== value.release.stagingTargetDescriptorSha256 ||
    value.operatorBundle.sha256 !== value.release.operatorBundleSha256
  ) throw new Error(`${label} immutable release bindings are inconsistent`);
  assertExactEnumerableDataRecord(value.host, ["a3HostIdentityMatches"], `${label} host`);
  if (value.host.a3HostIdentityMatches !== true) throw new Error(`${label} host identity does not match`);
  assertExactEnumerableDataRecord(
    value.guard,
    ["sameInstanceAsTask10", "heartbeatFresh", "watchdogFresh", "continuityGapMs"],
    `${label} guard`,
  );
  for (const field of ["sameInstanceAsTask10", "heartbeatFresh", "watchdogFresh"]) {
    if (value.guard[field] !== true) throw new Error(`${label} guard ${field} must be true`);
  }
  if (value.guard.continuityGapMs !== 0) throw new Error(`${label} continuity gap must be zero`);
  assertExactEnumerableDataRecord(
    value.baseline,
    ["sideEffectsEnabled", "consumerHealthy", "legacyLeaseOwnerExact", "runtimeIdentitiesExact"],
    `${label} baseline`,
  );
  if (
    value.baseline.sideEffectsEnabled !== false ||
    value.baseline.consumerHealthy !== true ||
    value.baseline.legacyLeaseOwnerExact !== true ||
    value.baseline.runtimeIdentitiesExact !== true
  ) throw new Error(`${label} baseline tuple is invalid`);
  assertExactEnumerableDataRecord(
    value.cutover,
    ["legacyLeaseReleased", "producerStartedAfterConsumer", "directPollerAccepts"],
    `${label} cutover`,
  );
  if (value.cutover.legacyLeaseReleased !== true || value.cutover.producerStartedAfterConsumer !== true) {
    throw new Error(`${label} cutover booleans are invalid`);
  }
  if (value.cutover.directPollerAccepts !== 0) {
    throw new Error(`${label} direct poller accepts must be zero`);
  }
  assertExactBooleanRecord(value.runtime, ["pollerHealthy", "consumerHealthy"], `${label} runtime`);
  if (value.runtime.pollerHealthy !== true || value.runtime.consumerHealthy !== true) {
    throw new Error(`${label} runtime health must be true`);
  }
  assertExactEnumerableDataRecord(
    value.epoch,
    ["teamId", "historyRetained", "activeEpoch", "activeGeneration", "staleEpochActions"],
    `${label} epoch`,
  );
  if (value.epoch.teamId !== 1 && value.epoch.teamId !== 2) throw new Error(`${label} team ID is invalid`);
  if (value.epoch.historyRetained !== true) throw new Error(`${label} history is not retained`);
  assertId(value.epoch.activeEpoch, `${label} active epoch`);
  assertPositiveSafeInteger(value.epoch.activeGeneration, `${label} active generation`);
  if (value.epoch.staleEpochActions !== 0) throw new Error(`${label} stale epoch actions must be zero`);
  assertExactEnumerableDataRecord(
    value.fence,
    ["state", "fenceJobId", "ackJobId", "generation", "pollerNodeMatches", "acknowledgedAt"],
    `${label} fence`,
  );
  if (value.fence.state !== "fenced" || value.fence.pollerNodeMatches !== true) {
    throw new Error(`${label} fence tuple is invalid`);
  }
  assertNonnegativeSafeInteger(value.fence.fenceJobId, `${label} fence job ID`);
  assertNonnegativeSafeInteger(value.fence.ackJobId, `${label} acknowledgment job ID`);
  assertPositiveSafeInteger(value.fence.generation, `${label} fence generation`);
  parseIso(value.fence.acknowledgedAt, `${label} acknowledged time`);
  if (
    value.fence.ackJobId < value.fence.fenceJobId ||
    value.fence.generation !== value.epoch.activeGeneration
  ) throw new Error(`${label} fence acknowledgment or generation is inconsistent`);
  assertExactEnumerableDataRecord(value.drain, DRAIN_FIELDS, `${label} drain`);
  for (const field of DRAIN_FIELDS) {
    if (value.drain[field] !== 0) throw new Error(`${label} drain ${field} must be zero`);
  }
  assertExactEnumerableDataRecord(value.rollback, ["inlineOwnerRestored"], `${label} rollback`);
  if (value.rollback.inlineOwnerRestored !== true) throw new Error(`${label} inline owner is not restored`);
  const duplicateFields = [
    "externalAttempts",
    "results",
    "history",
    "bookingHistory",
    "notifications",
    "budgetReservations",
    "settlements",
  ];
  assertExactEnumerableDataRecord(value.duplicates, duplicateFields, `${label} duplicates`);
  for (const field of duplicateFields) {
    if (value.duplicates[field] !== 0) throw new Error(`${label} duplicate ${field} must be zero`);
  }
  assertExactEnumerableDataRecord(
    value.artifactBindings,
    [
      "journalSnapshotSha256",
      "schemaObservationSha256",
      "fenceObservationSha256",
      "actionMeasurements",
      "finalSources",
    ],
    `${label} artifact bindings`,
  );
  for (const field of [
    "journalSnapshotSha256",
    "schemaObservationSha256",
    "fenceObservationSha256",
  ]) assertHash(value.artifactBindings[field], `${label} artifact ${field}`);
  if (
    !Array.isArray(value.artifactBindings.actionMeasurements) ||
    value.artifactBindings.actionMeasurements.length !== PHASE3_ACTION_IDS.length
  ) throw new Error(`${label} action measurement bindings are not the exact eight-entry set`);
  for (const [index, entry] of value.artifactBindings.actionMeasurements.entries()) {
    assertExactEnumerableDataRecord(entry, ["actionId", "sha256"], `${label} action binding`);
    if (entry.actionId !== PHASE3_ACTION_IDS[index]) throw new Error(`${label} action binding order changed`);
    assertHash(entry.sha256, `${label} action binding hash`);
  }
  assertExactEnumerableDataRecord(
    value.artifactBindings.finalSources,
    ["dbSha256", "runtimeSha256", "leaseContinuitySha256", "capacitySha256", "productionObserverSha256"],
    `${label} final sources`,
  );
  for (const field of [
    "dbSha256",
    "runtimeSha256",
    "leaseContinuitySha256",
    "capacitySha256",
    "productionObserverSha256",
  ]) assertHash(value.artifactBindings.finalSources[field], `${label} final source ${field}`);
  assertExactEnumerableDataRecord(
    value.actionJournal,
    ["headSha256", "snapshotSha256", "required", "pending", "ambiguous", "replayed", "extra"],
    `${label} action journal`,
  );
  assertHash(value.actionJournal.headSha256, `${label} action journal head`);
  assertHash(value.actionJournal.snapshotSha256, `${label} action journal snapshot hash`);
  if (!Array.isArray(value.actionJournal.required) || value.actionJournal.required.length !== PHASE3_ACTION_IDS.length) {
    throw new Error(`${label} required action journal set is not exact`);
  }
  const requiredTerminalHashes = new Set();
  let previousRequiredCompletionMs = Number.NEGATIVE_INFINITY;
  for (const [index, entry] of value.actionJournal.required.entries()) {
    assertExactEnumerableDataRecord(entry, PHASE3_SEMANTIC_REQUIRED_ACTION_FIELDS, `${label} required action`);
    if (
      entry.actionId !== PHASE3_ACTION_IDS[index] ||
      entry.status !== "succeeded" ||
      entry.occurrences !== 1
    ) throw new Error(`${label} required action is not an ordinary succeeded terminal`);
    assertHash(entry.terminalRecordSha256, `${label} required terminal hash`);
    assertHash(entry.measurementSha256, `${label} required measurement hash`);
    const completedMs = parseIso(entry.completedAt, `${label} required completion time`);
    if (completedMs < previousRequiredCompletionMs) {
      throw new Error(`${label} required terminal completion order changed`);
    }
    previousRequiredCompletionMs = completedMs;
    if (requiredTerminalHashes.has(entry.terminalRecordSha256)) {
      throw new Error(`${label} required terminal hash is duplicated`);
    }
    requiredTerminalHashes.add(entry.terminalRecordSha256);
    if (
      entry.measurementSha256 !== value.artifactBindings.actionMeasurements[index].sha256
    ) throw new Error(`${label} required measurement hash differs from its artifact binding`);
  }
  for (const field of ["pending", "ambiguous", "replayed", "extra"]) {
    if (value.actionJournal[field] !== 0) {
      throw new Error(`${label} action journal ${field} must be zero`);
    }
  }
  if (!Array.isArray(value.timeline) || value.timeline.length !== PHASE3_ACTION_IDS.length) {
    throw new Error(`${label} timeline is not the exact eight-entry set`);
  }
  for (const [index, entry] of value.timeline.entries()) {
    assertExactEnumerableDataRecord(entry, ["actionId", "completedAt"], `${label} timeline entry`);
    if (entry.actionId !== PHASE3_ACTION_IDS[index]) throw new Error(`${label} timeline order changed`);
    parseIso(entry.completedAt, `${label} timeline completion time`);
    if (entry.completedAt !== value.actionJournal.required[index].completedAt) {
      throw new Error(`${label} timeline differs from its required action terminal`);
    }
  }
  if (
    value.release.actionJournalHeadSha256 !== value.actionJournal.headSha256 ||
    value.actionJournal.snapshotSha256 !== value.artifactBindings.journalSnapshotSha256 ||
    value.actionJournal.headSha256 !==
      value.actionJournal.required.at(-1).terminalRecordSha256
  ) throw new Error(`${label} journal and artifact binding hashes are inconsistent`);
  return value;
}

function validateHistoricalReleaseTuple(value, label) {
  assertExactEnumerableDataRecord(value, RELEASE_FIELDS, label);
  assertCommitSha(value.candidateSha, `${label} candidate SHA`);
  assertImageDigest(value.imageDigest, `${label} image digest`);
  for (const field of [
    "releaseManifestSha256",
    "stagingTargetDescriptorSha256",
    "operatorBundleSha256",
    "stagingApprovalEnvelopeSha256",
  ]) assertHash(value[field], `${label} ${field}`);
  assertId(value.stagingRunId, `${label} staging run ID`);
  return {
    ...value,
    environment: "staging",
    topology: "phase3",
    composeProject: "spx-staging",
    actionJournalHeadSha256: hashPlaceholderForHistoricalValidation,
  };
}

const hashPlaceholderForHistoricalValidation = "f".repeat(64);

function validateHistoricalActionMarkerValue(value) {
  scanSingletonJson(value);
  assertExactEnumerableDataRecord(value, ACTION_FIELDS, "historical Phase 3 action marker");
  if (value.schemaVersion !== 1 || !PHASE3_ACTION_SET.has(value.actionId)) {
    throw new Error("historical Phase 3 action marker identity is invalid");
  }
  assertHash(value.mutationSha256, "historical action mutation hash");
  assertHash(value.terminalRecordSha256, "historical action terminal hash");
  const completedMs = parseIso(value.completedAt, "historical action completion time");
  const observedMs = parseIso(value.observedAt, "historical action observation time");
  if (observedMs < completedMs) throw new Error("historical action observation precedes completion");
  const binding = validateHistoricalReleaseTuple(value.releaseBinding, "historical action release");
  assertId(value.guardLeaseId, "historical action guard lease ID");
  assertId(value.watchdogLeaseId, "historical action watchdog lease ID");
  if (value.guardLeaseId === value.watchdogLeaseId) throw new Error("historical marker lease IDs must differ");
  if (value.teamId !== 1 && value.teamId !== 2) throw new Error("historical action team is invalid");
  assertId(value.epoch, "historical action epoch");
  const partition = phase3PartitionIdentity(value.teamId, value.epoch);
  if (NULL_GENERATION_ACTIONS.has(value.actionId)) {
    if (value.generation !== null) throw new Error("historical action generation must be null");
  } else {
    assertPositiveSafeInteger(value.generation, "historical action generation");
  }
  validateActionMeasurements(value.actionId, value.measurements, value.generation, {
    partition,
    installedBinding: binding,
  });
  return value;
}

function validateHistoricalObservationMarkerValue(value) {
  scanSingletonJson(value);
  assertExactEnumerableDataRecord(value, OBSERVATION_FIELDS, "historical Phase 3 observation marker");
  if (value.schemaVersion !== 1 || !OBSERVATION_IDS.includes(value.observationId)) {
    throw new Error("historical Phase 3 observation identity is invalid");
  }
  const required = value.observationId === "phase3-schema-verify"
    ? "staging-gate-3-handoff"
    : "phase3-publication-fence";
  if (value.requiredTerminalActionId !== required) {
    throw new Error("historical Phase 3 observation terminal identity is invalid");
  }
  assertHash(value.terminalRecordSha256, "historical observation terminal hash");
  assertHash(value.actionJournalHeadSha256, "historical observation journal head");
  if (value.actionJournalHeadSha256 !== value.terminalRecordSha256) {
    throw new Error("historical observation journal head differs from its terminal");
  }
  assertId(value.stagingRunId, "historical observation staging run ID");
  if (value.teamId !== 1 && value.teamId !== 2) throw new Error("historical observation team is invalid");
  assertId(value.epoch, "historical observation epoch");
  const partition = phase3PartitionIdentity(value.teamId, value.epoch);
  if (value.pollerNodeId !== partition.pollerNodeId) {
    throw new Error("historical observation poller identity is invalid");
  }
  for (const field of [
    "approvalEnvelopeSha256",
    "releaseManifestSha256",
    "rollbackReleaseManifestSha256",
    "targetDescriptorSha256",
    "operatorBundleSha256",
  ]) assertHash(value[field], `historical observation ${field}`);
  assertId(value.guardLeaseId, "historical observation guard lease ID");
  assertId(value.watchdogLeaseId, "historical observation watchdog lease ID");
  if (value.guardLeaseId === value.watchdogLeaseId) throw new Error("historical observation lease IDs must differ");
  parseIso(value.observedAt, "historical observation time");
  if (value.observationId === "phase3-schema-verify") {
    if (value.generation !== null) throw new Error("historical schema generation must be null");
    validateSchemaObservationMeasurements(value.measurements);
  } else {
    assertPositiveSafeInteger(value.generation, "historical fence generation");
    validateFenceObservationMeasurements(value.measurements, value.generation, partition);
  }
  return value;
}

async function readHistoricalActionAtPath(path, actionId, testOverride) {
  const stable = await stableReadFile(path, {
    testOverride,
    label: `historical Phase 3 action marker ${actionId}`,
    allowedNlinks: [1n],
  });
  const parsed = parseCanonicalMarker(stable.bytes, `historical Phase 3 action marker ${actionId}`);
  if (parsed.value.actionId !== actionId) {
    throw new Error("historical Phase 3 action marker filename and action ID differ");
  }
  validateHistoricalActionMarkerValue(parsed.value);
  return freezeClone({
    actionId,
    path,
    value: parsed.value,
    bytes: parsed.text,
    sha256: sha256(stable.bytes),
  });
}

async function readHistoricalObservationAtPath(path, observationId, testOverride) {
  const stable = await stableReadFile(path, {
    testOverride,
    label: `historical Phase 3 observation marker ${observationId}`,
    allowedNlinks: [1n],
  });
  const parsed = parseCanonicalMarker(
    stable.bytes,
    `historical Phase 3 observation marker ${observationId}`,
  );
  if (parsed.value.observationId !== observationId) {
    throw new Error("historical Phase 3 observation filename and observation ID differ");
  }
  validateHistoricalObservationMarkerValue(parsed.value);
  return freezeClone({
    observationId,
    path,
    value: parsed.value,
    bytes: parsed.text,
    sha256: sha256(stable.bytes),
  });
}

function validateHistoricalReadOptions(options, productionRoot, label) {
  const keys = validateRuntimeSourceOptionsObject(options, ["rootPath"], label);
  if (keys.length === 0) return { rootPath: productionRoot, testOverride: false };
  if (process.env.NODE_ENV !== "test") throw new Error(`${label} root override is test-only`);
  if (typeof options.rootPath !== "string" || !isAbsolute(options.rootPath)) {
    throw new Error(`${label} root override must be absolute`);
  }
  return { rootPath: resolve(options.rootPath), testOverride: true };
}

export async function readPhase3HistoricalActionMeasurementArtifacts(options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) throw new Error("readPhase3HistoricalActionMeasurementArtifacts received an invalid argument count");
  const resolved = validateHistoricalReadOptions(
    options,
    ACTION_ROOT,
    "historical Phase 3 action reader",
  );
  const root = await secureDirectory(resolved.rootPath, resolved.testOverride, "Phase 3 action marker root");
  const filenames = PHASE3_ACTION_IDS.map((actionId) => `${actionId}.json`);
  const directoryBefore = await assertExactDirectoryFiles(
    root.path,
    filenames,
    resolved.testOverride,
    "Phase 3 action marker root",
  );
  const before = [];
  for (const actionId of PHASE3_ACTION_IDS) {
    before.push(await readHistoricalActionAtPath(
      join(root.path, `${actionId}.json`),
      actionId,
      resolved.testOverride,
    ));
  }
  const after = [];
  for (const actionId of PHASE3_ACTION_IDS) {
    after.push(await readHistoricalActionAtPath(
      join(root.path, `${actionId}.json`),
      actionId,
      resolved.testOverride,
    ));
  }
  await assertExactDirectoryFiles(root.path, filenames, resolved.testOverride, "Phase 3 action marker root");
  const directoryAfter = await lstat(root.path, { bigint: true });
  if (!sameIdentity(directoryBefore, directoryAfter) || !sameCanonical(before, after)) {
    throw new Error("historical Phase 3 action artifact set changed during stable read");
  }
  return freezeClone(after);
}

export async function readPhase3HistoricalObservationMarkerArtifacts(options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) throw new Error("readPhase3HistoricalObservationMarkerArtifacts received an invalid argument count");
  const resolved = validateHistoricalReadOptions(
    options,
    OBSERVATION_ROOT,
    "historical Phase 3 observation reader",
  );
  const root = await secureDirectory(
    resolved.rootPath,
    resolved.testOverride,
    "Phase 3 observation marker root",
  );
  const filenames = OBSERVATION_IDS.map((observationId) => `${observationId}.json`);
  const directoryBefore = await assertExactDirectoryFiles(
    root.path,
    filenames,
    resolved.testOverride,
    "Phase 3 observation marker root",
  );
  const readSet = async () => ({
    schema: await readHistoricalObservationAtPath(
      join(root.path, "phase3-schema-verify.json"),
      "phase3-schema-verify",
      resolved.testOverride,
    ),
    fence: await readHistoricalObservationAtPath(
      join(root.path, "phase3-fence-ack-wait.json"),
      "phase3-fence-ack-wait",
      resolved.testOverride,
    ),
  });
  const before = await readSet();
  const after = await readSet();
  await assertExactDirectoryFiles(
    root.path,
    filenames,
    resolved.testOverride,
    "Phase 3 observation marker root",
  );
  const directoryAfter = await lstat(root.path, { bigint: true });
  if (!sameIdentity(directoryBefore, directoryAfter) || !sameCanonical(before, after)) {
    throw new Error("historical Phase 3 observation artifact set changed during stable read");
  }
  return freezeClone(after);
}

function validateSingletonReadOptions(options, config) {
  const keys = validateRuntimeSourceOptionsObject(
    options,
    ["rootPath"],
    `${config.label} reader`,
  );
  if (keys.length === 0) return { rootPath: config.rootPath, testOverride: false };
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`${config.label} reader root override is test-only`);
  }
  if (typeof options.rootPath !== "string" || !isAbsolute(options.rootPath)) {
    throw new Error(`${config.label} reader root override must be absolute`);
  }
  return { rootPath: resolve(options.rootPath), testOverride: true };
}

function validateSingletonWriteOptions(options, config) {
  const keys = validateRuntimeSourceOptionsObject(
    options,
    ["rootPath", "tempRootPath"],
    `${config.label} writer`,
  );
  if (keys.length === 0) {
    return {
      rootPath: config.rootPath,
      tempRootPath: config.tempRootPath,
      testOverride: false,
    };
  }
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`${config.label} writer root overrides are test-only`);
  }
  if (keys.length !== 2 || !keys.includes("rootPath") || !keys.includes("tempRootPath")) {
    throw new Error(`${config.label} root and temporary root overrides must appear together`);
  }
  if (
    typeof options.rootPath !== "string" ||
    typeof options.tempRootPath !== "string" ||
    !isAbsolute(options.rootPath) ||
    !isAbsolute(options.tempRootPath)
  ) throw new Error(`${config.label} root overrides must be absolute`);
  const rootPath = resolve(options.rootPath);
  const tempRootPath = resolve(options.tempRootPath);
  if (
    comparablePath(rootPath) === comparablePath(tempRootPath) ||
    comparablePath(dirname(rootPath)) !== comparablePath(dirname(tempRootPath))
  ) throw new Error(`${config.label} roots must be distinct sibling directories with one parent`);
  return { rootPath, tempRootPath, testOverride: true };
}

function validatePhase3ActionJournalSnapshotReadOptions(options) {
  return validateSingletonReadOptions(options, PHASE3_SNAPSHOT_CONFIG);
}

function validatePhase3ActionJournalSnapshotWriteOptions(options) {
  return validateSingletonWriteOptions(options, PHASE3_SNAPSHOT_CONFIG);
}

function validatePhase3SemanticEvidenceReadOptions(options) {
  return validateSingletonReadOptions(options, PHASE3_SEMANTIC_CONFIG);
}

function validatePhase3SemanticEvidenceWriteOptions(options) {
  return validateSingletonWriteOptions(options, PHASE3_SEMANTIC_CONFIG);
}

function phase3SingletonNoFollowFlag(testOverride, label) {
  if (constants.O_NOFOLLOW === undefined && !testOverride) {
    throw new Error(`${label} requires O_NOFOLLOW in production`);
  }
  return constants.O_NOFOLLOW ?? 0;
}

function assertPhase3SingletonFileStatus(
  status,
  testOverride,
  label,
  { allowEmpty = false, allowedNlinks = [1n], enforceMaximum = true } = {},
) {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  assertOwnerAndMode(status, 0o600, testOverride, label);
  if (!allowedNlinks.includes(status.nlink)) throw new Error(`${label} has an invalid hard-link count`);
  if (!allowEmpty && status.size <= 0n) throw new Error(`${label} must not be empty`);
  if (enforceMaximum && status.size > BigInt(MAX_PHASE3_SINGLETON_BYTES)) {
    throw new Error(`${label} exceeds the 512 KiB size contract`);
  }
}

async function stableReadPhase3SingletonFile(path, options) {
  const before = await lstat(path, { bigint: true });
  assertPhase3SingletonFileStatus(before, options.testOverride, options.label, options);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | phase3SingletonNoFollowFlag(options.testOverride, options.label),
    );
  } catch (error) {
    if (errorCode(error, "ELOOP")) throw new Error(`${options.label} symlink is forbidden`);
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    assertPhase3SingletonFileStatus(opened, options.testOverride, options.label, options);
    if (!sameIdentity(before, opened)) throw new Error(`${options.label} changed before open`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_PHASE3_SINGLETON_BYTES) {
      throw new Error(`${options.label} exceeds 512 KiB`);
    }
    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      !sameIdentity(opened, afterOpen) ||
      !sameIdentity(afterOpen, afterPath) ||
      BigInt(bytes.byteLength) !== afterOpen.size
    ) throw new Error(`${options.label} changed during stable read`);
    return { bytes, status: afterPath };
  } finally {
    await handle.close();
  }
}

function parseCanonicalPhase3Singleton(bytes, config, label = config.label) {
  if (bytes.byteLength === 0) throw new Error(`${label} must not be empty`);
  if (bytes.byteLength > MAX_PHASE3_SINGLETON_BYTES) throw new Error(`${label} exceeds 512 KiB`);
  const text = decodeUtf8(bytes, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  scanSingletonJson(value);
  if (text !== canonicalJson(value)) {
    throw new Error(`${label} must use canonical JSON without duplicate keys`);
  }
  config.validate(value, label);
  return { text, value };
}

async function readPhase3SingletonAtPath(
  path,
  config,
  testOverride,
  allowedNlinks = [1n],
) {
  if (basename(path) !== config.file) {
    throw new Error(`${config.label} path does not match its fixed mapping`);
  }
  const stable = await stableReadPhase3SingletonFile(path, {
    testOverride,
    label: config.label,
    allowedNlinks,
  });
  const parsed = parseCanonicalPhase3Singleton(stable.bytes, config);
  return {
    status: stable.status,
    record: freezeClone({
      path,
      value: parsed.value,
      bytes: parsed.text,
      sha256: sha256(stable.bytes),
    }),
  };
}

async function provisionPhase3SingletonWriterDirectories(resolved, config) {
  if (resolved.testOverride) {
    const commonParentPath = dirname(resolved.rootPath);
    const commonParent = await secureDirectory(
      commonParentPath,
      true,
      `${config.label} common parent`,
    );
    const artifactRoot = await ensureRuntimeSourceDirectory(
      resolved.rootPath,
      commonParent,
      true,
      `${config.label} root`,
    );
    const refreshedParent = await secureDirectory(
      commonParent.path,
      true,
      `${config.label} common parent`,
    );
    const tempRoot = await ensureRuntimeSourceDirectory(
      resolved.tempRootPath,
      refreshedParent,
      true,
      `${config.label} temporary root`,
    );
    const parentAfter = await secureDirectory(
      commonParent.path,
      true,
      `${config.label} common parent`,
    );
    if (!sameInode(commonParent.status, parentAfter.status)) {
      throw new Error(`${config.label} common parent changed during provisioning`);
    }
    return {
      artifactRoot: { ...artifactRoot, chain: { commonParent: parentAfter.status } },
      tempRoot,
    };
  }
  const rollout = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidence = await ensureRuntimeSourceDirectory(
    EVIDENCE_ROOT,
    rollout,
    false,
    "Phase 3 evidence root",
  );
  const artifactRoot = await ensureRuntimeSourceDirectory(
    config.rootPath,
    evidence,
    false,
    `${config.label} root`,
  );
  const refreshedEvidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  const tempRoot = await ensureRuntimeSourceDirectory(
    config.tempRootPath,
    refreshedEvidence,
    false,
    `${config.label} temporary root`,
  );
  const rolloutAfter = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidenceAfter = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  if (!sameInode(rollout.status, rolloutAfter.status) || !sameInode(evidence.status, evidenceAfter.status)) {
    throw new Error(`${config.label} directory chain changed during provisioning`);
  }
  return {
    artifactRoot: {
      ...artifactRoot,
      chain: { rollout: rolloutAfter.status, evidence: evidenceAfter.status },
    },
    tempRoot,
  };
}

async function authenticatePhase3SingletonReaderDirectory(resolved, config, expected) {
  if (resolved.testOverride) {
    const commonParent = await secureDirectory(
      dirname(resolved.rootPath),
      true,
      `${config.label} common parent`,
    );
    const artifactRoot = await secureDirectory(resolved.rootPath, true, `${config.label} root`);
    const parentAfter = await secureDirectory(
      commonParent.path,
      true,
      `${config.label} common parent`,
    );
    if (!sameInode(commonParent.status, parentAfter.status)) {
      throw new Error(`${config.label} common parent changed during authentication`);
    }
    if (
      expected &&
      (!sameInode(expected.status, artifactRoot.status) ||
        !sameInode(expected.chain.commonParent, parentAfter.status))
    ) throw new Error(`${config.label} parent or root changed between authentications`);
    return { ...artifactRoot, chain: { commonParent: parentAfter.status } };
  }
  const rollout = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  const artifactRoot = await secureDirectory(config.rootPath, false, `${config.label} root`);
  const rolloutAfter = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidenceAfter = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  if (!sameInode(rollout.status, rolloutAfter.status) || !sameInode(evidence.status, evidenceAfter.status)) {
    throw new Error(`${config.label} directory chain changed during authentication`);
  }
  if (
    expected &&
    (!sameInode(expected.status, artifactRoot.status) ||
      !sameInode(expected.chain.rollout, rolloutAfter.status) ||
      !sameInode(expected.chain.evidence, evidenceAfter.status))
  ) throw new Error(`${config.label} directory chain changed between authentications`);
  return {
    ...artifactRoot,
    chain: { rollout: rolloutAfter.status, evidence: evidenceAfter.status },
  };
}

async function authenticatePhase3SingletonWriterDirectories(
  resolved,
  config,
  expectedArtifactRoot,
  expectedTempRoot,
) {
  await authenticatePhase3SingletonReaderDirectory(resolved, config, expectedArtifactRoot);
  const tempRoot = await secureDirectory(
    resolved.tempRootPath,
    resolved.testOverride,
    `${config.label} temporary root`,
  );
  if (!sameInode(expectedTempRoot.status, tempRoot.status)) {
    throw new Error(`${config.label} temporary root changed between authentications`);
  }
  const parent = await secureDirectory(
    resolved.testOverride ? dirname(resolved.tempRootPath) : EVIDENCE_ROOT,
    resolved.testOverride,
    resolved.testOverride ? `${config.label} common parent` : "Phase 3 evidence root",
  );
  const expectedParent = resolved.testOverride
    ? expectedArtifactRoot.chain.commonParent
    : expectedArtifactRoot.chain.evidence;
  if (!sameInode(expectedParent, parent.status)) {
    throw new Error(`${config.label} writer parent changed during authentication`);
  }
}

async function inspectPhase3SingletonRoot(
  artifactRoot,
  config,
  testOverride,
  { allowedNlinks = [1n] } = {},
) {
  const before = await lstat(artifactRoot.path, { bigint: true });
  assertOwnerAndMode(before, 0o700, testOverride, `${config.label} root`);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`${config.label} root must be a regular non-symlink directory`);
  }
  if (!sameInode(artifactRoot.status, before)) {
    throw new Error(`${config.label} root changed after directory authentication`);
  }
  const entries = await readdir(artifactRoot.path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== config.file) throw new Error(`${config.label} root contains an unexpected entry`);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`${config.label} root contains a non-regular or symlink entry`);
    }
  }
  const artifact = entries.length === 1
    ? await readPhase3SingletonAtPath(
        join(artifactRoot.path, config.file),
        config,
        testOverride,
        allowedNlinks,
      )
    : null;
  const after = await lstat(artifactRoot.path, { bigint: true });
  assertOwnerAndMode(after, 0o700, testOverride, `${config.label} root`);
  if (!sameIdentity(before, after)) throw new Error(`${config.label} root changed during stable read`);
  return { status: after, artifact };
}

function samePhase3SingletonSnapshot(left, right) {
  if (!sameIdentity(left.status, right.status)) return false;
  if (Boolean(left.artifact) !== Boolean(right.artifact)) return false;
  return !left.artifact || (
    sameIdentity(left.artifact.status, right.artifact.status) &&
    left.artifact.record.bytes === right.artifact.record.bytes &&
    left.artifact.record.sha256 === right.artifact.record.sha256
  );
}

async function unlinkAuthenticatedPhase3SingletonTemp(
  path,
  expectedStatus,
  expectedNlink,
  tempRoot,
  testOverride,
  label,
) {
  const current = await lstat(path, { bigint: true });
  assertPhase3SingletonFileStatus(current, testOverride, label, {
    allowEmpty: true,
    allowedNlinks: [expectedNlink],
    enforceMaximum: false,
  });
  if (!sameIdentity(current, expectedStatus)) throw new Error(`${label} changed before cleanup`);
  await unlink(path);
  await syncDirectory(tempRoot);
}

async function removeUnpublishedPhase3SingletonTemp(
  path,
  tempRoot,
  testOverride,
  createdStatus,
  label,
) {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error, "ENOENT")) return;
    throw error;
  }
  assertPhase3SingletonFileStatus(before, testOverride, label, {
    allowEmpty: true,
    allowedNlinks: [1n],
    enforceMaximum: false,
  });
  if (createdStatus && !sameInode(before, createdStatus)) throw new Error(`${label} inode changed`);
  const after = await lstat(path, { bigint: true });
  if (!sameIdentity(before, after)) throw new Error(`${label} changed before cleanup`);
  await unlinkAuthenticatedPhase3SingletonTemp(
    path,
    after,
    1n,
    tempRoot,
    testOverride,
    label,
  );
}

async function planPhase3SingletonTempRecovery(artifactRoot, tempRoot, testOverride, config) {
  const tempBefore = await secureDirectory(
    tempRoot.path,
    testOverride,
    `${config.label} temporary root`,
  );
  const artifactBefore = await inspectPhase3SingletonRoot(
    artifactRoot,
    config,
    testOverride,
    { allowedNlinks: [1n, 2n] },
  );
  const entries = await readdir(tempRoot.path, { withFileTypes: true });
  if (entries.length > MAX_TEMP_ENTRIES) {
    throw new Error(`${config.label} temporary root exceeds its 64-entry recovery limit`);
  }
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    if (!config.tempPattern.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`${config.label} temporary root contains an unexpected qualified entry`);
    }
  }
  const plans = [];
  let linkedSeen = false;
  for (const entry of sortedEntries) {
    const temporary = join(tempRoot.path, entry.name);
    const statusBefore = await lstat(temporary, { bigint: true });
    assertPhase3SingletonFileStatus(statusBefore, testOverride, `${config.label} recovery temporary`, {
      allowEmpty: true,
      allowedNlinks: [1n, 2n],
      enforceMaximum: false,
    });
    const statusAfter = await lstat(temporary, { bigint: true });
    if (!sameIdentity(statusBefore, statusAfter)) {
      throw new Error(`${config.label} recovery temporary identity is unstable`);
    }
    if (statusAfter.nlink === 1n) {
      plans.push({ kind: "orphan", temporary, tempStatus: statusAfter, nlink: 1n });
      continue;
    }
    if (linkedSeen) throw new Error(`${config.label} recovery has duplicate linked temporaries`);
    const stableTemp = await stableReadPhase3SingletonFile(temporary, {
      testOverride,
      label: `${config.label} linked temporary`,
      allowedNlinks: [2n],
    });
    if (!sameIdentity(statusAfter, stableTemp.status)) {
      throw new Error(`${config.label} linked temporary changed during planning`);
    }
    parseCanonicalPhase3Singleton(stableTemp.bytes, config, `${config.label} linked temporary`);
    const destination = join(artifactRoot.path, config.file);
    const installed = await stableReadPhase3SingletonFile(destination, {
      testOverride,
      label: `${config.label} recovered destination`,
      allowedNlinks: [2n],
    });
    parseCanonicalPhase3Singleton(installed.bytes, config, `${config.label} recovered destination`);
    if (
      !sameInodeAndSize(stableTemp.status, installed.status) ||
      !stableTemp.bytes.equals(installed.bytes)
    ) throw new Error(`${config.label} linked temporary does not match its fixed destination`);
    linkedSeen = true;
    plans.push({
      kind: "linked",
      temporary,
      destination,
      tempStatus: stableTemp.status,
      destinationStatus: installed.status,
      bytes: stableTemp.bytes,
      nlink: 2n,
    });
  }
  if (artifactBefore.artifact?.status.nlink === 2n && !linkedSeen) {
    throw new Error(`${config.label} destination has an unaccounted hard link`);
  }
  await authenticatePlannedRecoveryTempSet(
    tempRoot,
    tempBefore,
    entries,
    plans,
    testOverride,
    `${config.label} recovery`,
  );
  const artifactAfter = await inspectPhase3SingletonRoot(
    artifactRoot,
    config,
    testOverride,
    { allowedNlinks: [1n, 2n] },
  );
  if (!samePhase3SingletonSnapshot(artifactBefore, artifactAfter)) {
    throw new Error(`${config.label} destination changed during recovery planning`);
  }
  return { plans, tempBefore };
}

function planPhase3ActionJournalSnapshotTempRecovery(artifactRoot, tempRoot, testOverride) {
  return planPhase3SingletonTempRecovery(
    artifactRoot,
    tempRoot,
    testOverride,
    PHASE3_SNAPSHOT_CONFIG,
  );
}

function planPhase3SemanticEvidenceTempRecovery(artifactRoot, tempRoot, testOverride) {
  return planPhase3SingletonTempRecovery(
    artifactRoot,
    tempRoot,
    testOverride,
    PHASE3_SEMANTIC_CONFIG,
  );
}

async function executePhase3SingletonTempRecoveryPlan(
  plan,
  artifactRoot,
  tempRoot,
  testOverride,
  config,
) {
  if (plan.kind === "orphan") {
    await unlinkAuthenticatedPhase3SingletonTemp(
      plan.temporary,
      plan.tempStatus,
      1n,
      tempRoot.path,
      testOverride,
      `${config.label} orphan temporary`,
    );
    return;
  }
  const authenticatedTemp = await stableReadPhase3SingletonFile(plan.temporary, {
    testOverride,
    label: `${config.label} re-authenticated linked temporary`,
    allowedNlinks: [2n],
  });
  const authenticatedDestination = await stableReadPhase3SingletonFile(plan.destination, {
    testOverride,
    label: `${config.label} re-authenticated destination`,
    allowedNlinks: [2n],
  });
  parseCanonicalPhase3Singleton(authenticatedTemp.bytes, config, `${config.label} linked temporary`);
  parseCanonicalPhase3Singleton(authenticatedDestination.bytes, config, `${config.label} destination`);
  if (
    !sameIdentity(authenticatedTemp.status, plan.tempStatus) ||
    !sameIdentity(authenticatedDestination.status, plan.destinationStatus) ||
    !sameInodeAndSize(authenticatedTemp.status, authenticatedDestination.status) ||
    !authenticatedTemp.bytes.equals(authenticatedDestination.bytes) ||
    !authenticatedTemp.bytes.equals(plan.bytes)
  ) throw new Error(`${config.label} linked pair changed before recovery cleanup`);
  await syncDirectory(artifactRoot.path);
  const finalTemp = await stableReadPhase3SingletonFile(plan.temporary, {
    testOverride,
    label: `${config.label} final linked temporary`,
    allowedNlinks: [2n],
  });
  const finalDestination = await stableReadPhase3SingletonFile(plan.destination, {
    testOverride,
    label: `${config.label} final destination`,
    allowedNlinks: [2n],
  });
  if (
    !sameIdentity(finalTemp.status, authenticatedTemp.status) ||
    !sameIdentity(finalDestination.status, authenticatedDestination.status) ||
    !finalTemp.bytes.equals(finalDestination.bytes) ||
    !finalTemp.bytes.equals(plan.bytes)
  ) throw new Error(`${config.label} linked pair changed during final authentication`);
  await unlinkAuthenticatedPhase3SingletonTemp(
    plan.temporary,
    finalTemp.status,
    2n,
    tempRoot.path,
    testOverride,
    `${config.label} linked temporary`,
  );
  const finalized = await stableReadPhase3SingletonFile(plan.destination, {
    testOverride,
    label: `${config.label} recovered finalized destination`,
    allowedNlinks: [1n],
  });
  if (!sameInodeAndSize(finalized.status, finalDestination.status) || !finalized.bytes.equals(plan.bytes)) {
    throw new Error(`${config.label} changed after recovery cleanup`);
  }
  parseCanonicalPhase3Singleton(finalized.bytes, config, `${config.label} finalized destination`);
}

async function recoverPhase3SingletonTemps(
  artifactRoot,
  tempRoot,
  testOverride,
  config,
  planner,
) {
  const { plans, tempBefore } = await planner(artifactRoot, tempRoot, testOverride);
  for (const plan of plans) {
    await executePhase3SingletonTempRecoveryPlan(
      plan,
      artifactRoot,
      tempRoot,
      testOverride,
      config,
    );
  }
  await syncDirectory(tempRoot.path);
  if ((await readdir(tempRoot.path)).length !== 0) {
    throw new Error(`${config.label} temporary root changed during recovery`);
  }
  await syncDirectory(artifactRoot.path);
  const tempAfter = await secureDirectory(tempRoot.path, testOverride, `${config.label} temporary root`);
  if (!sameInode(tempBefore.status, tempAfter.status)) {
    throw new Error(`${config.label} temporary root identity changed during recovery`);
  }
}

function phase3SingletonMissingError(config) {
  const error = new Error(`${config.label} is missing`);
  error.code = "ENOENT";
  return error;
}

async function readPhase3Singleton(options, config, optionValidator) {
  const resolved = optionValidator(options);
  const artifactRoot = await authenticatePhase3SingletonReaderDirectory(resolved, config);
  const before = await inspectPhase3SingletonRoot(artifactRoot, config, resolved.testOverride);
  if (!before.artifact) {
    const afterMissing = await inspectPhase3SingletonRoot(artifactRoot, config, resolved.testOverride);
    if (!samePhase3SingletonSnapshot(before, afterMissing)) {
      throw new Error(`${config.label} changed while confirming it is missing`);
    }
    await authenticatePhase3SingletonReaderDirectory(resolved, config, artifactRoot);
    throw phase3SingletonMissingError(config);
  }
  const after = await inspectPhase3SingletonRoot(artifactRoot, config, resolved.testOverride);
  if (!samePhase3SingletonSnapshot(before, after)) {
    throw new Error(`${config.label} changed during read`);
  }
  await authenticatePhase3SingletonReaderDirectory(resolved, config, artifactRoot);
  return after.artifact.record;
}

async function writePhase3Singleton(value, options, config, optionValidator, planner) {
  const resolved = optionValidator(options);
  config.validate(value, config.label);
  const canonical = canonicalJson(value);
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHASE3_SINGLETON_BYTES) {
    throw new Error(`${config.label} exceeds the 512 KiB byte-size contract`);
  }
  parseCanonicalPhase3Singleton(bytes, config);
  const { artifactRoot, tempRoot } = await provisionPhase3SingletonWriterDirectories(resolved, config);
  if (artifactRoot.status.dev !== tempRoot.status.dev) {
    throw new Error(`${config.label} roots are cross-device; hard-link publication is required`);
  }
  await inspectPhase3SingletonRoot(artifactRoot, config, resolved.testOverride, {
    allowedNlinks: [1n, 2n],
  });
  await recoverPhase3SingletonTemps(
    artifactRoot,
    tempRoot,
    resolved.testOverride,
    config,
    planner,
  );
  await inspectPhase3SingletonRoot(artifactRoot, config, resolved.testOverride);
  const destination = join(artifactRoot.path, config.file);
  const temporary = join(tempRoot.path, `${config.tempPrefix}.${randomUUID()}.tmp`);
  let handle;
  let createdStatus;
  let linked = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        phase3SingletonNoFollowFlag(resolved.testOverride, `${config.label} publication`),
      0o600,
    );
    createdStatus = await handle.stat({ bigint: true });
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(tempRoot.path);
    const verifiedTemp = await stableReadPhase3SingletonFile(temporary, {
      testOverride: resolved.testOverride,
      label: `${config.label} newly written temporary`,
      allowedNlinks: [1n],
    });
    const parsedTemp = parseCanonicalPhase3Singleton(
      verifiedTemp.bytes,
      config,
      `${config.label} newly written temporary`,
    );
    if (!verifiedTemp.bytes.equals(bytes) || canonicalJson(parsedTemp.value) !== canonical) {
      throw new Error(`${config.label} temporary bytes changed after fsync`);
    }
    createdStatus = verifiedTemp.status;
    try {
      await link(temporary, destination);
      linked = true;
    } catch (error) {
      if (errorCode(error, "EXDEV")) {
        throw new Error(`${config.label} roots are cross-device; hard-link publication is required`);
      }
      if (!errorCode(error, "EEXIST")) throw error;
      const existing = await readPhase3SingletonAtPath(
        destination,
        config,
        resolved.testOverride,
        [1n],
      );
      if (existing.record.bytes !== canonical) {
        throw new Error(`${config.label} conflicts with the installed create-once artifact`);
      }
      await unlinkAuthenticatedPhase3SingletonTemp(
        temporary,
        verifiedTemp.status,
        1n,
        tempRoot.path,
        resolved.testOverride,
        `${config.label} unpublished temporary`,
      );
      const afterIdempotent = await inspectPhase3SingletonRoot(
        artifactRoot,
        config,
        resolved.testOverride,
      );
      if (!afterIdempotent.artifact || afterIdempotent.artifact.record.bytes !== canonical) {
        throw new Error(`${config.label} changed during idempotent publication`);
      }
      await authenticatePhase3SingletonWriterDirectories(
        resolved,
        config,
        artifactRoot,
        tempRoot,
      );
      return afterIdempotent.artifact.record;
    }
    await syncDirectory(artifactRoot.path);
    const installed = await stableReadPhase3SingletonFile(destination, {
      testOverride: resolved.testOverride,
      label: `${config.label} installed destination`,
      allowedNlinks: [2n],
    });
    const linkedTemp = await stableReadPhase3SingletonFile(temporary, {
      testOverride: resolved.testOverride,
      label: `${config.label} linked temporary`,
      allowedNlinks: [2n],
    });
    parseCanonicalPhase3Singleton(installed.bytes, config, `${config.label} installed destination`);
    parseCanonicalPhase3Singleton(linkedTemp.bytes, config, `${config.label} linked temporary`);
    if (
      !sameInodeAndSize(installed.status, linkedTemp.status) ||
      !sameInodeAndSize(installed.status, verifiedTemp.status) ||
      !installed.bytes.equals(bytes) ||
      !linkedTemp.bytes.equals(bytes)
    ) throw new Error(`${config.label} destination is not the fsynced temporary inode and bytes`);
    const authenticatedInstalled = await stableReadPhase3SingletonFile(destination, {
      testOverride: resolved.testOverride,
      label: `${config.label} re-authenticated destination`,
      allowedNlinks: [2n],
    });
    const authenticatedTemp = await stableReadPhase3SingletonFile(temporary, {
      testOverride: resolved.testOverride,
      label: `${config.label} re-authenticated temporary`,
      allowedNlinks: [2n],
    });
    if (
      !sameInodeAndSize(authenticatedInstalled.status, authenticatedTemp.status) ||
      !sameInodeAndSize(authenticatedInstalled.status, installed.status) ||
      !authenticatedInstalled.bytes.equals(authenticatedTemp.bytes) ||
      !authenticatedInstalled.bytes.equals(bytes)
    ) throw new Error(`${config.label} linked pair changed before cleanup`);
    await unlinkAuthenticatedPhase3SingletonTemp(
      temporary,
      authenticatedTemp.status,
      2n,
      tempRoot.path,
      resolved.testOverride,
      `${config.label} linked temporary`,
    );
    const finalized = await stableReadPhase3SingletonFile(destination, {
      testOverride: resolved.testOverride,
      label: `${config.label} finalized destination`,
      allowedNlinks: [1n],
    });
    const parsedFinal = parseCanonicalPhase3Singleton(
      finalized.bytes,
      config,
      `${config.label} finalized destination`,
    );
    if (
      !sameInodeAndSize(finalized.status, authenticatedInstalled.status) ||
      !finalized.bytes.equals(bytes) ||
      canonicalJson(parsedFinal.value) !== canonical
    ) throw new Error(`${config.label} changed after temporary cleanup`);
    const after = await inspectPhase3SingletonRoot(artifactRoot, config, resolved.testOverride);
    if (
      !after.artifact ||
      !sameInodeAndSize(after.artifact.status, finalized.status) ||
      after.artifact.record.bytes !== canonical
    ) throw new Error(`${config.label} set changed after publication`);
    await authenticatePhase3SingletonWriterDirectories(
      resolved,
      config,
      artifactRoot,
      tempRoot,
    );
    return after.artifact.record;
  } catch (error) {
    if (handle) {
      createdStatus = await handle.stat({ bigint: true }).catch(() => createdStatus);
      await handle.close();
      handle = null;
    }
    if (!linked) {
      await removeUnpublishedPhase3SingletonTemp(
        temporary,
        tempRoot.path,
        resolved.testOverride,
        createdStatus,
        `${config.label} unpublished temporary`,
      );
    }
    throw error;
  }
}

async function authenticatePhase3SingletonRecoveryDirectories(resolved, config) {
  const artifactRoot = await authenticatePhase3SingletonReaderDirectory(resolved, config);
  const tempRoot = await secureDirectory(
    resolved.tempRootPath,
    resolved.testOverride,
    `${config.label} temporary root`,
  );
  if (artifactRoot.status.dev !== tempRoot.status.dev) {
    throw new Error(`${config.label} recovery roots are cross-device; hard-link recovery is forbidden`);
  }
  const parent = await secureDirectory(
    resolved.testOverride ? dirname(resolved.tempRootPath) : EVIDENCE_ROOT,
    resolved.testOverride,
    resolved.testOverride ? `${config.label} recovery common parent` : "Phase 3 evidence root",
  );
  const expectedParent = resolved.testOverride
    ? artifactRoot.chain.commonParent
    : artifactRoot.chain.evidence;
  if (!sameInode(expectedParent, parent.status)) {
    throw new Error(`${config.label} recovery parent changed during authentication`);
  }
  return { artifactRoot, tempRoot };
}

async function recoverPhase3SingletonStorage(options, config, optionValidator, planner) {
  const resolved = optionValidator(options);
  const availability = await inspectRecoveryRootPairAvailability(resolved, config.label);
  if (availability !== "present") return;
  const { artifactRoot, tempRoot } = await authenticatePhase3SingletonRecoveryDirectories(
    resolved,
    config,
  );
  await inspectPhase3SingletonRoot(artifactRoot, config, resolved.testOverride, {
    allowedNlinks: [1n, 2n],
  });
  await recoverPhase3SingletonTemps(
    artifactRoot,
    tempRoot,
    resolved.testOverride,
    config,
    planner,
  );
  await inspectPhase3SingletonRoot(artifactRoot, config, resolved.testOverride);
  await authenticatePhase3SingletonWriterDirectories(
    resolved,
    config,
    artifactRoot,
    tempRoot,
  );
}

export async function readPhase3ActionJournalSnapshot(options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) throw new Error("readPhase3ActionJournalSnapshot received an invalid argument count");
  return readPhase3Singleton(
    options,
    PHASE3_SNAPSHOT_CONFIG,
    validatePhase3ActionJournalSnapshotReadOptions,
  );
}

export async function writePhase3ActionJournalSnapshot(value, options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length < 1 ||
    arguments.length > 2 ||
    (arguments.length === 2 && arguments[1] === undefined)
  ) throw new Error("writePhase3ActionJournalSnapshot received an invalid argument count");
  return writePhase3Singleton(
    value,
    options,
    PHASE3_SNAPSHOT_CONFIG,
    validatePhase3ActionJournalSnapshotWriteOptions,
    planPhase3ActionJournalSnapshotTempRecovery,
  );
}

export async function recoverPhase3ActionJournalSnapshotStorage(options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) throw new Error("recoverPhase3ActionJournalSnapshotStorage received an invalid argument count");
  return recoverPhase3SingletonStorage(
    options,
    PHASE3_SNAPSHOT_CONFIG,
    validatePhase3ActionJournalSnapshotWriteOptions,
    planPhase3ActionJournalSnapshotTempRecovery,
  );
}

export async function readPhase3SemanticEvidence(options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) throw new Error("readPhase3SemanticEvidence received an invalid argument count");
  return readPhase3Singleton(
    options,
    PHASE3_SEMANTIC_CONFIG,
    validatePhase3SemanticEvidenceReadOptions,
  );
}

export async function writePhase3SemanticEvidence(value, options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length < 1 ||
    arguments.length > 2 ||
    (arguments.length === 2 && arguments[1] === undefined)
  ) throw new Error("writePhase3SemanticEvidence received an invalid argument count");
  return writePhase3Singleton(
    value,
    options,
    PHASE3_SEMANTIC_CONFIG,
    validatePhase3SemanticEvidenceWriteOptions,
    planPhase3SemanticEvidenceTempRecovery,
  );
}

export async function recoverPhase3SemanticEvidenceStorage(options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) throw new Error("recoverPhase3SemanticEvidenceStorage received an invalid argument count");
  return recoverPhase3SingletonStorage(
    options,
    PHASE3_SEMANTIC_CONFIG,
    validatePhase3SemanticEvidenceWriteOptions,
    planPhase3SemanticEvidenceTempRecovery,
  );
}

async function optionalRecoveryLstat(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function authenticateRecoveryParentChain(resolved, label) {
  if (resolved.testOverride) {
    const commonParent = await secureDirectory(
      dirname(resolved.rootPath),
      true,
      `${label} recovery common parent`,
    );
    return { commonParent: commonParent.status };
  }
  const rollout = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  const rolloutAfter = await secureDirectory(ROLLOUT_ROOT, false, "Phase 3 rollout root");
  const evidenceAfter = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
  if (
    !sameIdentity(rollout.status, rolloutAfter.status) ||
    !sameIdentity(evidence.status, evidenceAfter.status)
  ) {
    throw new Error(`${label} recovery parent chain changed during authentication`);
  }
  return { rollout: rolloutAfter.status, evidence: evidenceAfter.status };
}

function sameRecoveryParentChain(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && sameIdentity(left[key], right[key]))
  );
}

async function authenticateEmptyProvisionedRecoveryRoot(
  resolved,
  label,
  expectedRoot,
  expectedChain,
) {
  const rootBefore = await secureDirectory(
    resolved.rootPath,
    resolved.testOverride,
    `${label} recovery destination root`,
  );
  if (!sameIdentity(expectedRoot, rootBefore.status)) {
    throw new Error(`${label} recovery destination root changed before empty-root authentication`);
  }
  const entriesBefore = await readdir(rootBefore.path, { withFileTypes: true });
  if (entriesBefore.length !== 0) {
    throw new Error(
      `${label} recovery root pair is incomplete because the destination root is nonempty`,
    );
  }
  const chainBetween = await authenticateRecoveryParentChain(resolved, label);
  const rootAfter = await secureDirectory(
    resolved.rootPath,
    resolved.testOverride,
    `${label} recovery destination root`,
  );
  const entriesAfter = await readdir(rootAfter.path, { withFileTypes: true });
  const tempAfter = await optionalRecoveryLstat(resolved.tempRootPath);
  const chainAfter = await authenticateRecoveryParentChain(resolved, label);
  if (
    entriesAfter.length !== 0 ||
    tempAfter !== null ||
    !sameIdentity(rootBefore.status, rootAfter.status) ||
    !sameRecoveryParentChain(expectedChain, chainBetween) ||
    !sameRecoveryParentChain(chainBetween, chainAfter)
  ) {
    throw new Error(
      `${label} recovery empty destination-root state changed during authentication`,
    );
  }
}

async function inspectRecoveryRootPairAvailability(resolved, label) {
  const chainBefore = await authenticateRecoveryParentChain(resolved, label);
  const [rootBefore, tempBefore] = await Promise.all([
    optionalRecoveryLstat(resolved.rootPath),
    optionalRecoveryLstat(resolved.tempRootPath),
  ]);
  const chainBetween = await authenticateRecoveryParentChain(resolved, label);
  const [rootAfter, tempAfter] = await Promise.all([
    optionalRecoveryLstat(resolved.rootPath),
    optionalRecoveryLstat(resolved.tempRootPath),
  ]);
  const chainAfter = await authenticateRecoveryParentChain(resolved, label);
  if (
    !sameRecoveryParentChain(chainBefore, chainBetween) ||
    !sameRecoveryParentChain(chainBetween, chainAfter)
  ) {
    throw new Error(`${label} recovery parent chain changed while authenticating root absence`);
  }
  if (
    Boolean(rootBefore) !== Boolean(rootAfter) ||
    Boolean(tempBefore) !== Boolean(tempAfter) ||
    (rootBefore && !sameIdentity(rootBefore, rootAfter)) ||
    (tempBefore && !sameIdentity(tempBefore, tempAfter))
  ) {
    throw new Error(`${label} recovery root pair changed during stable authentication`);
  }
  if (!rootAfter && !tempAfter) return "absent";
  if (rootAfter && !tempAfter) {
    await authenticateEmptyProvisionedRecoveryRoot(
      resolved,
      label,
      rootAfter,
      chainAfter,
    );
    return "provisioned-root-only";
  }
  if (!rootAfter && tempAfter) {
    throw new Error(
      `${label} recovery root pair is incomplete; both roots must be present or both absent`,
    );
  }
  return "present";
}

async function authenticateRuntimeSourceRecoveryDirectories(resolved) {
  const sourceRoot = await authenticateRuntimeSourceReaderDirectory(resolved);
  const tempRoot = await secureDirectory(
    resolved.tempRootPath,
    resolved.testOverride,
    "Phase 3 runtime source temporary root",
  );
  if (sourceRoot.status.dev !== tempRoot.status.dev) {
    throw new Error(
      "Phase 3 runtime source recovery roots are cross-device; hard-link recovery is forbidden",
    );
  }
  if (resolved.testOverride) {
    const parent = await secureDirectory(
      dirname(resolved.tempRootPath),
      true,
      "Phase 3 runtime source recovery common parent",
    );
    if (!sameInode(sourceRoot.chain.commonParent, parent.status)) {
      throw new Error(
        "Phase 3 runtime source recovery parent identity changed during authentication",
      );
    }
  } else {
    const evidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
    if (!sameInode(sourceRoot.chain.evidence, evidence.status)) {
      throw new Error(
        "Phase 3 runtime source recovery evidence-root identity changed during authentication",
      );
    }
  }
  return { sourceRoot, tempRoot };
}

async function authenticateCapacityObservationCheckpointRecoveryDirectories(resolved) {
  const checkpointRoot =
    await authenticateCapacityObservationCheckpointReaderDirectory(resolved);
  const tempRoot = await secureDirectory(
    resolved.tempRootPath,
    resolved.testOverride,
    "Phase 3 capacity observation checkpoint temporary root",
  );
  if (checkpointRoot.status.dev !== tempRoot.status.dev) {
    throw new Error(
      "Phase 3 capacity observation checkpoint recovery roots are cross-device; hard-link recovery is forbidden",
    );
  }
  if (resolved.testOverride) {
    const parent = await secureDirectory(
      dirname(resolved.tempRootPath),
      true,
      "Phase 3 capacity observation checkpoint recovery common parent",
    );
    if (!sameInode(checkpointRoot.chain.commonParent, parent.status)) {
      throw new Error(
        "Phase 3 capacity observation checkpoint recovery parent identity changed during authentication",
      );
    }
  } else {
    const evidence = await secureDirectory(EVIDENCE_ROOT, false, "Phase 3 evidence root");
    if (!sameInode(checkpointRoot.chain.evidence, evidence.status)) {
      throw new Error(
        "Phase 3 capacity observation checkpoint recovery evidence-root identity changed during authentication",
      );
    }
  }
  return { checkpointRoot, tempRoot };
}

export async function recoverPhase3RuntimeSourceStorage(options = {}, ...extra) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) {
    throw new Error("recoverPhase3RuntimeSourceStorage received an invalid argument count");
  }
  const resolved = validateRuntimeSourceWriteOptions(options);
  const availability = await inspectRecoveryRootPairAvailability(
    resolved,
    "Phase 3 runtime source",
  );
  if (availability !== "present") return;
  const { sourceRoot, tempRoot } = await authenticateRuntimeSourceRecoveryDirectories(resolved);
  await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride, {
    allowedNlinks: [1n, 2n],
  });
  await recoverRuntimeSourceTemps(sourceRoot, tempRoot, resolved.testOverride);
  await inspectRuntimeSourceSet(sourceRoot, resolved.testOverride);
  await authenticateRuntimeSourceWriterDirectories(
    resolved,
    sourceRoot,
    tempRoot,
  );
}

export async function recoverPhase3CapacityObservationCheckpointStorage(
  options = {},
  ...extra
) {
  if (
    extra.length !== 0 ||
    arguments.length > 1 ||
    (arguments.length === 1 && arguments[0] === undefined)
  ) {
    throw new Error(
      "recoverPhase3CapacityObservationCheckpointStorage received an invalid argument count",
    );
  }
  const resolved = validateCapacityObservationCheckpointWriteOptions(options);
  const availability = await inspectRecoveryRootPairAvailability(
    resolved,
    "Phase 3 capacity observation checkpoint",
  );
  if (availability !== "present") return;
  const { checkpointRoot, tempRoot } =
    await authenticateCapacityObservationCheckpointRecoveryDirectories(resolved);
  await inspectCapacityObservationCheckpointRoot(checkpointRoot, resolved.testOverride, {
    allowedNlinks: [1n, 2n],
  });
  await recoverCapacityObservationCheckpointTemps(
    checkpointRoot,
    tempRoot,
    resolved.testOverride,
  );
  await inspectCapacityObservationCheckpointRoot(checkpointRoot, resolved.testOverride);
  await authenticateCapacityObservationCheckpointWriterDirectories(
    resolved,
    checkpointRoot,
    tempRoot,
  );
}
