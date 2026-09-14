#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import {
  canonicalJson,
  readEvidenceBundle,
  validateReleaseBinding,
} from "./lib/evidence-artifact.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_RUNTIME_SOURCE_IDS,
  phase3PartitionIdentity,
  readPhase3ActionJournalSnapshot,
  readPhase3HistoricalActionMeasurementArtifacts,
  readPhase3HistoricalObservationMarkerArtifacts,
  readPhase3RuntimeSources,
  readPhase3SemanticEvidence,
  validatePhase3PreGate4JournalSnapshot,
} from "./lib/phase3-staging-evidence.mjs";
import {
  loadInstalledStagingActionCapability,
  validateStagingActionCapability,
} from "./lib/staging-action-capability.mjs";
import { verifyStagingActionJournalSnapshotPrefix } from "./lib/staging-action-ledger.mjs";
import { loadInstalledReleaseBinding } from "./lib/staging-installed-context.mjs";
import { validatePhase3RuntimeSourceValue } from "./staging-phase3-runtime-evidence.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUIRED_ACTIONS = Object.freeze([
  "phase3-consumer-start-disabled",
  "phase3-legacy-lease-release",
  "phase3-poller-start",
  "phase3-publication-enable",
  "phase3-execution-enable",
  "phase3-publication-fence",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
]);
const DUPLICATE_KEYS = Object.freeze([
  "externalAttempts",
  "results",
  "history",
  "bookingHistory",
  "notifications",
  "budgetReservations",
  "settlements",
]);
const EVIDENCE_FILENAME = "phase3-rollout-evidence.json";
const HOST_IDENTITY_PATH = "/etc/spx-staging/host-identity.sha256";
const ZERO_HASH = "0".repeat(64);
const MAX_MARKER_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const INSTALLED_PORT_NAMES = Object.freeze([
  "loadContext",
  "loadCapability",
  "loadHostIdentity",
  "readSemantic",
  "readSnapshot",
  "readHistoricalObservationMarkerArtifacts",
  "readHistoricalActionMeasurementArtifacts",
  "readSources",
  "verifyJournalPrefix",
]);
const RELEASE_IDENTITY_FIELDS = Object.freeze([
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
const ACTION_MARKER_FIELDS = Object.freeze([
  "schemaVersion", "actionId", "mutationSha256", "terminalRecordSha256", "completedAt",
  "observedAt", "releaseBinding", "guardLeaseId", "watchdogLeaseId", "teamId", "epoch",
  "generation", "measurements",
]);
const OBSERVATION_MARKER_FIELDS = Object.freeze([
  "schemaVersion", "observationId", "requiredTerminalActionId", "terminalRecordSha256",
  "actionJournalHeadSha256", "stagingRunId", "teamId", "epoch", "pollerNodeId",
  "approvalEnvelopeSha256", "releaseManifestSha256", "rollbackReleaseManifestSha256",
  "targetDescriptorSha256", "operatorBundleSha256", "guardLeaseId", "watchdogLeaseId",
  "generation", "observedAt", "measurements",
]);
const MARKER_RELEASE_FIELDS = Object.freeze([
  "candidateSha", "imageDigest", "releaseManifestSha256", "stagingTargetDescriptorSha256",
  "operatorBundleSha256", "stagingApprovalEnvelopeSha256", "stagingRunId",
]);
const STAGING_TOP_LEVEL_FIELDS = Object.freeze([
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactDataRecord(value, fields) {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== fields.length ||
    ownKeys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor?.enumerable === true && "value" in descriptor && descriptor.value !== undefined;
  });
}

function assertExactDataRecord(value, fields, label) {
  if (!exactDataRecord(value, fields)) throw new Error(`${label} has an invalid field set`);
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
      throw new Error(`${label} contains an invalid array`);
    }
    const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new Error(`${label} contains a sparse or extended array`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${label} contains a non-data array member`);
      }
      assertStrictJson(descriptor.value, `${label}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains a non-plain object`);
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${label} contains a non-data property`);
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
  assertStrictJson(value, "installed Phase 3 evidence value");
  return deepFreeze(structuredClone(value));
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function ownDataValue(value, field, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a record`);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new Error(`${label}.${field} must be an enumerable data property`);
  }
  return descriptor.value;
}

function nonzeroHash(value) {
  return hash(value) && value !== ZERO_HASH;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function hash(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function zero(value) {
  return value === 0;
}

function allTrue(value, keys) {
  return isRecord(value) && keys.every((key) => value[key] === true);
}

function tupleValid(value, supervisedProduction) {
  if (supervisedProduction) {
    return value.releaseEnvironment === "production"
      && value.runtimeEnvironment === "production"
      && value.drillMode === "supervised-production"
      && value.composeProject === "spx-production";
  }
  return exactDataRecord(value, STAGING_TOP_LEVEL_FIELDS)
    && value.schemaVersion === 2
    && value.releaseEnvironment === "staging"
    && value.runtimeEnvironment === "staging"
    && value.drillMode === "staging"
    && value.composeProject === "spx-staging";
}

function releaseValid(value, supervisedProduction) {
  try {
    validateReleaseBinding(value.release);
  } catch {
    return false;
  }
  const expectedEnvironment = supervisedProduction ? "supervised-production" : "staging";
  return value.release.environment === expectedEnvironment
    && value.release.composeProject === value.composeProject
    && (supervisedProduction || value.release.topology === "phase3");
}

function targetBindingValid(value, supervisedProduction) {
  if (
    !(supervisedProduction
      ? isRecord(value.targetDescriptor)
      : exactDataRecord(
          value.targetDescriptor,
          ["signed", "environment", "composeProject", "sha256"],
        )) ||
    !(supervisedProduction
      ? isRecord(value.operatorBundle)
      : exactDataRecord(value.operatorBundle, ["installed", "sha256"]))
  ) return false;
  const descriptorHash = supervisedProduction
    ? value.release?.targetDescriptorSha256
    : value.release?.stagingTargetDescriptorSha256;
  return value.targetDescriptor.signed === true
    && value.targetDescriptor.environment === (supervisedProduction ? "production" : "staging")
    && value.targetDescriptor.composeProject === value.composeProject
    && hash(value.targetDescriptor.sha256)
    && value.targetDescriptor.sha256 === descriptorHash
    && value.operatorBundle.installed === true
    && hash(value.operatorBundle.sha256)
    && value.operatorBundle.sha256 === value.release?.operatorBundleSha256;
}

function stagingBindingValid(value) {
  return typeof value.stagingRunId === "string"
    && ID_PATTERN.test(value.stagingRunId)
    && value.stagingRunId === value.release?.stagingRunId
    && hash(value.approvalEnvelopeSha256)
    && value.approvalEnvelopeSha256 === value.release?.stagingApprovalEnvelopeSha256;
}

function productionBindingValid(value) {
  const production = value.production;
  return value.stagingRunId === null
    && hash(value.approvalEnvelopeSha256)
    && value.approvalEnvelopeSha256 === value.release?.productionIdentityApprovalSha256
    && isRecord(production)
    && hash(production.passingStagingBundleSha256)
    && hash(production.approvalSha256)
    && production.approvalSha256 === value.approvalEnvelopeSha256
    && Array.isArray(production.canaryTeamIds)
    && production.canaryTeamIds.length === 1
    && production.canaryTeamIds[0] === value.epoch?.teamId;
}

function guardValid(value, supervisedProduction) {
  if (supervisedProduction) {
    return allTrue(value.host, ["a3HostIdentityMatches", "productionHostUnchanged"])
      && allTrue(value.guard, ["sameInstanceAsTask10", "heartbeatFresh", "watchdogFresh"])
      && value.guard.continuityGapMs === 0;
  }
  const hostFields = supervisedProduction
    ? ["a3HostIdentityMatches", "productionHostUnchanged"]
    : ["a3HostIdentityMatches"];
  return exactDataRecord(value.host, hostFields)
    && allTrue(value.host, hostFields)
    && exactDataRecord(
      value.guard,
      ["sameInstanceAsTask10", "heartbeatFresh", "watchdogFresh", "continuityGapMs"],
    )
    && allTrue(value.guard, ["sameInstanceAsTask10", "heartbeatFresh", "watchdogFresh"])
    && value.guard.continuityGapMs === 0;
}

function baselineValid(value, supervisedProduction) {
  return (supervisedProduction
    ? isRecord(value.baseline)
    : exactDataRecord(
        value.baseline,
        ["sideEffectsEnabled", "consumerHealthy", "legacyLeaseOwnerExact", "runtimeIdentitiesExact"],
      ))
    && value.baseline.sideEffectsEnabled === false
    && allTrue(value.baseline, [
      "consumerHealthy",
      "legacyLeaseOwnerExact",
      "runtimeIdentitiesExact",
    ]);
}

function cutoverValid(value, supervisedProduction) {
  return (supervisedProduction
    ? isRecord(value.cutover)
    : exactDataRecord(
        value.cutover,
        ["legacyLeaseReleased", "producerStartedAfterConsumer", "directPollerAccepts"],
      ))
    && value.cutover.legacyLeaseReleased === true
    && value.cutover.directPollerAccepts === 0;
}

function runtimeValid(value, supervisedProduction) {
  return (supervisedProduction
    ? isRecord(value.runtime)
    : exactDataRecord(value.runtime, ["pollerHealthy", "consumerHealthy"]))
    && allTrue(value.runtime, ["pollerHealthy", "consumerHealthy"]);
}

function epochValid(value, supervisedProduction) {
  return (supervisedProduction
    ? isRecord(value.epoch)
    : exactDataRecord(
        value.epoch,
        ["teamId", "historyRetained", "activeEpoch", "activeGeneration", "staleEpochActions"],
      ))
    && (supervisedProduction
      ? positiveInteger(value.epoch.teamId)
      : value.epoch.teamId === 1 || value.epoch.teamId === 2)
    && value.epoch.historyRetained === true
    && typeof value.epoch.activeEpoch === "string"
    && ID_PATTERN.test(value.epoch.activeEpoch)
    && positiveInteger(value.epoch.activeGeneration)
    && value.epoch.staleEpochActions === 0;
}

function fenceValid(value, supervisedProduction) {
  return (supervisedProduction
    ? isRecord(value.fence)
    : exactDataRecord(
        value.fence,
        [
          "state", "fenceJobId", "ackJobId", "generation", "pollerNodeMatches",
          "acknowledgedAt",
        ],
      ))
    && value.fence.state === "fenced"
    && Number.isSafeInteger(value.fence.fenceJobId)
    && value.fence.fenceJobId >= 0
    && Number.isSafeInteger(value.fence.ackJobId)
    && value.fence.ackJobId >= value.fence.fenceJobId
    && value.fence.generation === value.epoch?.activeGeneration
    && value.fence.pollerNodeMatches === true
    && (supervisedProduction
      ? typeof value.fence.acknowledgedAt === "string"
        && Number.isFinite(Date.parse(value.fence.acknowledgedAt))
      : canonicalTimestamp(value.fence.acknowledgedAt));
}

function drainValid(value, supervisedProduction) {
  return (supervisedProduction
    ? isRecord(value.drain)
    : exactDataRecord(
        value.drain,
        ["queued", "liveClaims", "indeterminate", "unknown", "settlementPending"],
      ))
    && ["queued", "liveClaims", "indeterminate", "unknown", "settlementPending"]
      .every((key) => zero(value.drain[key]));
}

function duplicatesValid(value, supervisedProduction) {
  return (supervisedProduction
    ? isRecord(value.duplicates)
    : exactDataRecord(value.duplicates, DUPLICATE_KEYS))
    && Object.keys(value.duplicates).sort().join("\0") === [...DUPLICATE_KEYS].sort().join("\0")
    && DUPLICATE_KEYS.every((key) => zero(value.duplicates[key]));
}

function actionJournalValid(value, supervisedProduction) {
  const journal = value.actionJournal;
  if (
    !isRecord(journal)
    || !hash(journal.headSha256)
    || !Array.isArray(journal.required)
    || journal.required.length !== REQUIRED_ACTIONS.length
    || !zero(journal.pending)
    || !zero(journal.ambiguous)
    || !zero(journal.replayed)
    || !zero(journal.extra)
  ) return false;
  if (!supervisedProduction) {
    if (
      !exactDataRecord(
        journal,
        [
          "headSha256", "snapshotSha256", "required", "pending", "ambiguous", "replayed",
          "extra",
        ],
      ) ||
      !hash(journal.snapshotSha256) ||
      journal.headSha256 !== value.release?.actionJournalHeadSha256 ||
      journal.snapshotSha256 !== value.artifactBindings?.journalSnapshotSha256
    ) return false;
    const terminalHashes = journal.required.map((entry) => entry?.terminalRecordSha256);
    if (new Set(terminalHashes).size !== terminalHashes.length) return false;
  }
  return journal.required.every((entry, index) => {
    if (!supervisedProduction) {
      const binding = value.artifactBindings?.actionMeasurements?.[index];
      const timeline = value.timeline?.[index];
      return exactDataRecord(
        entry,
        [
          "actionId", "status", "occurrences", "terminalRecordSha256", "completedAt",
          "measurementSha256",
        ],
      )
        && entry.actionId === REQUIRED_ACTIONS[index]
        && entry.status === "succeeded"
        && entry.occurrences === 1
        && hash(entry.terminalRecordSha256)
        && canonicalTimestamp(entry.completedAt)
        && hash(entry.measurementSha256)
        && exactDataRecord(binding, ["actionId", "sha256"])
        && binding.actionId === entry.actionId
        && binding.sha256 === entry.measurementSha256
        && exactDataRecord(timeline, ["actionId", "completedAt"])
        && timeline.actionId === entry.actionId
        && timeline.completedAt === entry.completedAt;
    }
    if (
      !isRecord(entry)
      || entry.actionId !== REQUIRED_ACTIONS[index]
      || entry.occurrences !== 1
      || !["succeeded", "reconciled-succeeded"].includes(entry.status)
    ) return false;
    if (entry.status === "reconciled-succeeded") {
      return typeof entry.reconcileActionId === "string"
        && ID_PATTERN.test(entry.reconcileActionId)
        && entry.reconcileOccurrences === 1;
    }
    return Object.keys(entry).sort().join("\0") === [
      "actionId", "occurrences", "status",
    ].sort().join("\0");
  });
}

function timelineValid(value, supervisedProduction) {
  if (supervisedProduction && value.timeline === undefined) return true;
  if (!Array.isArray(value.timeline) || value.timeline.length !== REQUIRED_ACTIONS.length) return false;
  let previous = -Infinity;
  return value.timeline.every((entry, index) => {
    const timestamp = Date.parse(entry?.completedAt);
    const valid = (supervisedProduction || exactDataRecord(entry, ["actionId", "completedAt"]))
      && entry?.actionId === REQUIRED_ACTIONS[index]
      && (supervisedProduction
        ? typeof entry?.completedAt === "string" && Number.isFinite(timestamp)
        : canonicalTimestamp(entry?.completedAt))
      && Number.isFinite(timestamp)
      && timestamp >= previous;
    previous = timestamp;
    return valid;
  });
}

function artifactBindingsValid(value) {
  const bindings = value.artifactBindings;
  if (
    !exactDataRecord(
      bindings,
      [
        "journalSnapshotSha256", "schemaObservationSha256", "fenceObservationSha256",
        "actionMeasurements", "finalSources",
      ],
    ) ||
    !hash(bindings.journalSnapshotSha256) ||
    !hash(bindings.schemaObservationSha256) ||
    !hash(bindings.fenceObservationSha256) ||
    !Array.isArray(bindings.actionMeasurements) ||
    bindings.actionMeasurements.length !== REQUIRED_ACTIONS.length ||
    !bindings.actionMeasurements.every((entry, index) =>
      exactDataRecord(entry, ["actionId", "sha256"])
      && entry.actionId === REQUIRED_ACTIONS[index]
      && hash(entry.sha256)) ||
    !exactDataRecord(
      bindings.finalSources,
      [
        "dbSha256", "runtimeSha256", "leaseContinuitySha256", "capacitySha256",
        "productionObserverSha256",
      ],
    ) ||
    !Object.values(bindings.finalSources).every(hash)
  ) return false;
  const required = value.actionJournal?.required;
  return Array.isArray(required)
    && required.length === REQUIRED_ACTIONS.length
    && required.every((entry, index) =>
      entry?.measurementSha256 === bindings.actionMeasurements[index].sha256)
    && value.actionJournal?.snapshotSha256 === bindings.journalSnapshotSha256
    && required.at(-1)?.terminalRecordSha256 === value.actionJournal?.headSha256;
}

export function evaluatePhase3Evidence(value, options = {}) {
  const supervisedProduction = options.supervisedProduction === true;
  const failures = [];
  if (!isRecord(value) || !tupleValid(value, supervisedProduction)) {
    failures.push("ENVIRONMENT_TUPLE_INVALID");
  }
  if (!isRecord(value) || !releaseValid(value, supervisedProduction)) {
    failures.push("RELEASE_BINDING_INVALID");
  }
  if (!isRecord(value) || !targetBindingValid(value, supervisedProduction)) {
    failures.push("TARGET_OR_BUNDLE_BINDING_INVALID");
  }
  if (
    !isRecord(value)
    || !(supervisedProduction ? productionBindingValid(value) : stagingBindingValid(value))
  ) failures.push(supervisedProduction ? "PRODUCTION_APPROVAL_INVALID" : "STAGING_RUN_BINDING_INVALID");
  if (!isRecord(value) || !guardValid(value, supervisedProduction)) {
    failures.push("GUARD_CONTINUITY_INVALID");
  }
  if (!isRecord(value) || !baselineValid(value, supervisedProduction)) {
    failures.push("DISABLED_BASELINE_INVALID");
  }
  if (!isRecord(value) || !cutoverValid(value, supervisedProduction)) {
    failures.push("CUTOVER_STATE_INVALID");
  }
  if (value?.cutover?.producerStartedAfterConsumer !== true) {
    failures.push("CONSUMER_PRODUCER_ORDER_INVALID");
  }
  if (!isRecord(value) || !runtimeValid(value, supervisedProduction)) {
    failures.push("RUNTIME_CONFIDENCE_INVALID");
  }
  if (!isRecord(value) || !epochValid(value, supervisedProduction)) {
    failures.push("EPOCH_HISTORY_INVALID");
  }
  if (!isRecord(value) || !fenceValid(value, supervisedProduction)) {
    failures.push("FENCE_ACK_INVALID");
  }
  if (!isRecord(value) || !drainValid(value, supervisedProduction)) {
    failures.push("SCOPED_DRAIN_INVALID");
  }
  if (
    (!supervisedProduction && !exactDataRecord(value?.rollback, ["inlineOwnerRestored"])) ||
    value?.rollback?.inlineOwnerRestored !== true
  ) failures.push("INLINE_OWNER_NOT_RESTORED");
  if (!isRecord(value) || !duplicatesValid(value, supervisedProduction)) {
    failures.push("DUPLICATE_SIDE_EFFECTS_PRESENT");
  }
  if (
    !isRecord(value) ||
    (!supervisedProduction && !artifactBindingsValid(value)) ||
    !actionJournalValid(value, supervisedProduction) ||
    !timelineValid(value, supervisedProduction)
  ) {
    failures.push("ACTION_SEQUENCE_INVALID");
  }
  return { ok: failures.length === 0, failures };
}

function validateInstalledInvocation(input, callerArguments) {
  assertExactDataRecord(input, ["expectedSemanticSha256"], "installed Phase 3 verifier input");
  if (!nonzeroHash(input.expectedSemanticSha256)) {
    throw new Error("installed Phase 3 semantic hash is invalid");
  }
  if (callerArguments.length === 0) return null;
  if (process.env.NODE_ENV !== "test" || callerArguments.length !== 1) {
    throw new Error("caller-selected installed Phase 3 verifier ports are forbidden");
  }
  const ports = callerArguments[0];
  assertExactDataRecord(ports, INSTALLED_PORT_NAMES, "installed Phase 3 verifier test ports");
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  if (INSTALLED_PORT_NAMES.some((name) => typeof descriptors[name].value !== "function")) {
    throw new Error("installed Phase 3 verifier test ports must be complete functions");
  }
  return Object.freeze(Object.fromEntries(
    INSTALLED_PORT_NAMES.map((name) => [name, descriptors[name].value]),
  ));
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
      fileBefore.uid !== 0n || Number(fileBefore.mode & 0o777n) !== 0o400)
  ) throw new Error("installed A3 host identity file is not root-private");
  const handle = await open(
    HOST_IDENTITY_PATH,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
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
  const parentAfter = await lstat(parentPath, { bigint: true });
  if (parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) {
    throw new Error("installed A3 host identity directory changed");
  }
  const identity = text.trim();
  if ((text !== identity && text !== `${identity}\n`) || !nonzeroHash(identity)) {
    throw new Error("installed A3 host identity content is invalid");
  }
  return identity;
}

function defaultInstalledPorts(testPorts) {
  if (testPorts) return testPorts;
  return Object.freeze({
    loadContext: loadInstalledApprovedStagingContext,
    loadCapability: (binding) => loadInstalledStagingActionCapability(binding),
    loadHostIdentity: loadFixedHostIdentity,
    readSemantic: () => readPhase3SemanticEvidence(),
    readSnapshot: () => readPhase3ActionJournalSnapshot(),
    readHistoricalObservationMarkerArtifacts: () =>
      readPhase3HistoricalObservationMarkerArtifacts(),
    readHistoricalActionMeasurementArtifacts: () =>
      readPhase3HistoricalActionMeasurementArtifacts(),
    readSources: () => readPhase3RuntimeSources(),
    verifyJournalPrefix: ({ binding, snapshot }) =>
      verifyStagingActionJournalSnapshotPrefix({ binding, snapshot }),
  });
}

function validateInstalledContext(value) {
  assertExactDataRecord(
    value,
    ["installedBinding", "envelope", "artifacts", "verified", "descriptor"],
    "installed approved staging context",
  );
  const captured = deepFreeze({
    installedBinding: freezeClone(ownDataValue(
      value,
      "installedBinding",
      "installed approved staging context",
    )),
    envelope: freezeClone(ownDataValue(value, "envelope", "installed approved staging context")),
    verified: freezeClone(ownDataValue(value, "verified", "installed approved staging context")),
    descriptor: freezeClone(ownDataValue(value, "descriptor", "installed approved staging context")),
  });
  const binding = captured.installedBinding;
  validateReleaseBinding(binding);
  if (binding.environment !== "staging" || binding.composeProject !== "spx-staging") {
    throw new Error("installed release is not staging");
  }
  const approvalId = ownDataValue(captured.verified, "approvalId", "verified staging context");
  if (
    typeof approvalId !== "string" || !ID_PATTERN.test(approvalId) ||
    ownDataValue(captured.envelope, "approvalId", "staging envelope") !== approvalId
  ) throw new Error("installed staging approval identity changed");
  const rollbackReleaseManifestSha256 = ownDataValue(
    captured.verified,
    "rollbackReleaseManifestSha256",
    "verified staging context",
  );
  if (!nonzeroHash(rollbackReleaseManifestSha256)) {
    throw new Error("rollback release manifest hash is invalid");
  }
  const thresholds = ownDataValue(
    ownDataValue(captured.envelope, "policy", "staging envelope"),
    "thresholds",
    "staging approval policy",
  );
  const thresholdFields = [
    "maxCpuPercent", "minMemoryFreeBytes", "minMysqlConnectionsFree",
    "productionP95LatencyMs", "maxLatencyIncreasePercent",
  ];
  const approvedThresholds = {};
  for (const field of thresholdFields) {
    const threshold = ownDataValue(thresholds, field, "approved capacity thresholds");
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
      throw new Error("approved capacity threshold is invalid");
    }
    approvedThresholds[field] = threshold;
  }
  const descriptor = captured.descriptor;
  if (
    ownDataValue(descriptor, "releaseEnvironment", "staging descriptor") !== "staging" ||
    ownDataValue(descriptor, "runtimeEnvironment", "staging descriptor") !== "staging" ||
    ownDataValue(descriptor, "composeProject", "staging descriptor") !== "spx-staging"
  ) throw new Error("installed staging descriptor changed");
  const target = ownDataValue(descriptor, "target", "staging descriptor");
  const hostIdentitySha256 = ownDataValue(target, "hostIdentitySha256", "staging target");
  const productionObserverPolicySha256 = ownDataValue(
    target,
    "productionObserverPolicySha256",
    "staging target",
  );
  if (!nonzeroHash(hostIdentitySha256) || !nonzeroHash(productionObserverPolicySha256)) {
    throw new Error("installed staging target hashes changed");
  }
  for (const [field, expected] of Object.entries({
    envelopeSha256: binding.stagingApprovalEnvelopeSha256,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    stagingRunId: binding.stagingRunId,
  })) {
    const descriptorValue = Object.getOwnPropertyDescriptor(captured.verified, field);
    if (
      descriptorValue &&
      (!descriptorValue.enumerable || !("value" in descriptorValue) || descriptorValue.value !== expected)
    ) throw new Error("verified installed release identity changed");
  }
  return deepFreeze({
    binding,
    approvalId,
    rollbackReleaseManifestSha256,
    approvedThresholds,
    hostIdentitySha256,
    productionObserverPolicySha256,
  });
}

function normalizeStorageRecord(record, label) {
  assertExactDataRecord(record, ["path", "value", "bytes", "sha256"], label);
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error(`${label} path is invalid`);
  }
  const captured = freezeClone(record);
  if (
    typeof captured.bytes !== "string" ||
    captured.bytes !== canonicalJson(captured.value) ||
    captured.sha256 !== sha256Text(captured.bytes) ||
    !nonzeroHash(captured.sha256)
  ) throw new Error(`${label} stable bytes changed`);
  return captured;
}

function normalizeMarkerRecord(record, kind, id) {
  const idField = kind === "action" ? "actionId" : "observationId";
  assertExactDataRecord(record, [idField, "path", "value", "bytes", "sha256"], `${kind} marker record`);
  if (record[idField] !== id || typeof record.path !== "string" || record.path.length === 0) {
    throw new Error(`${kind} marker storage identity changed`);
  }
  const captured = freezeClone(record);
  if (
    captured.bytes !== canonicalJson(captured.value) ||
    captured.sha256 !== sha256Text(captured.bytes) ||
    !nonzeroHash(captured.sha256)
  ) throw new Error(`${kind} marker stable bytes changed`);
  return captured;
}

function normalizeObservationArtifacts(value) {
  assertExactDataRecord(value, ["schema", "fence"], "historical observation artifact set");
  return deepFreeze({
    schema: normalizeMarkerRecord(value.schema, "observation", "phase3-schema-verify"),
    fence: normalizeMarkerRecord(value.fence, "observation", "phase3-fence-ack-wait"),
  });
}

function normalizeActionArtifacts(value) {
  if (!Array.isArray(value) || value.length !== PHASE3_ACTION_IDS.length) {
    throw new Error("historical action artifact set is incomplete");
  }
  const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new Error("historical action artifact set is not a strict array");
  }
  return deepFreeze(PHASE3_ACTION_IDS.map((actionId, index) =>
    normalizeMarkerRecord(value[index], "action", actionId)));
}

function normalizeSourceArtifacts(value) {
  assertExactDataRecord(value, PHASE3_RUNTIME_SOURCE_IDS, "Phase 3 runtime source set");
  if (Object.keys(value).some((sourceId, index) => sourceId !== PHASE3_RUNTIME_SOURCE_IDS[index])) {
    throw new Error("Phase 3 runtime source order changed");
  }
  const result = {};
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    const record = value[sourceId];
    assertExactDataRecord(record, ["value", "bytes", "sha256"], `runtime source ${sourceId}`);
    const captured = freezeClone(record);
    if (
      captured.bytes !== canonicalJson(captured.value) ||
      captured.sha256 !== sha256Text(captured.bytes) ||
      !nonzeroHash(captured.sha256)
    ) throw new Error(`runtime source ${sourceId} stable bytes changed`);
    result[sourceId] = captured;
  }
  return deepFreeze(result);
}

function assertCanonicalTime(value, label) {
  if (!canonicalTimestamp(value)) throw new Error(`${label} is not a canonical timestamp`);
  return Date.parse(value);
}

function assertHistoricalObservedAt(observedAt, completedAt, captureAt) {
  const observedMs = assertCanonicalTime(observedAt, "historical marker observation time");
  const completedMs = assertCanonicalTime(completedAt, "historical marker completion time");
  const captureMs = assertCanonicalTime(captureAt, "historical evidence capture time");
  if (
    observedMs < completedMs ||
    observedMs > captureMs + MAX_FUTURE_SKEW_MS ||
    captureMs - observedMs > MAX_MARKER_AGE_MS
  ) throw new Error("historical marker observation is outside the authenticated capture window");
}

function expectedMarkerRelease(binding) {
  return Object.fromEntries(MARKER_RELEASE_FIELDS.map((field) => [field, binding[field]]));
}

function assertMarkerLabels(value, service, binding) {
  assertExactDataRecord(
    value,
    [
      "composeProject", "composeService", "environment", "releaseSha",
      "targetDescriptorSha256", "operatorBundleSha256", "stagingRunId",
    ],
    "historical marker labels",
  );
  const expected = {
    composeProject: "spx-staging",
    composeService: service,
    environment: "staging",
    releaseSha: binding.candidateSha,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    stagingRunId: binding.stagingRunId,
  };
  if (!canonicalEqual(value, expected)) throw new Error("historical marker labels changed");
}

function assertMarkerIdentity(value, service, nodeId, binding, workerEnabled, extra = {}) {
  const inline = extra.inline === true;
  const fields = inline
    ? ["service", "nodeId", "status", "health", "imageId", "labels"]
    : [
        "service", "nodeId", "status", "health", "imageId", "labels",
        "realWorkerEnabled", "settlementWorkerEnabled",
        ...(extra.cutoverEpoch === undefined ? [] : ["cutoverEpoch"]),
      ];
  assertExactDataRecord(value, fields, "historical marker runtime identity");
  if (
    value.service !== service || value.nodeId !== nodeId || value.status !== "running" ||
    value.health !== "healthy" || value.imageId !== binding.imageDigest
  ) throw new Error("historical marker runtime identity changed");
  assertMarkerLabels(value.labels, service, binding);
  if (!inline && (
    value.realWorkerEnabled !== workerEnabled ||
    value.settlementWorkerEnabled !== workerEnabled
  )) throw new Error("historical marker worker flags changed");
  if (extra.cutoverEpoch !== undefined && value.cutoverEpoch !== extra.cutoverEpoch) {
    throw new Error("historical marker cutover epoch changed");
  }
}

function assertMarkerControl(value, generation, partition, state, acknowledged) {
  assertExactDataRecord(
    value,
    [
      "state", "pollerNodeId", "isActive", "activeEpoch", "activeGeneration",
      "publicationGeneration", "fenceJobId", "ackNodeId", "ackJobId", "acknowledgedAt",
    ],
    "historical publication control",
  );
  if (
    value.state !== state || value.pollerNodeId !== partition.pollerNodeId ||
    value.isActive !== true || value.activeEpoch !== partition.epoch ||
    value.activeGeneration !== generation || value.publicationGeneration !== generation
  ) throw new Error("historical publication control changed");
  if (state === "enabled") {
    if ([value.fenceJobId, value.ackNodeId, value.ackJobId, value.acknowledgedAt]
      .some((member) => member !== null)) {
      throw new Error("historical enabled control contains a fence");
    }
    return;
  }
  if (!Number.isSafeInteger(value.fenceJobId) || value.fenceJobId < 0) {
    throw new Error("historical fence job ID is invalid");
  }
  if (acknowledged) {
    if (
      value.ackNodeId !== partition.pollerNodeId ||
      !Number.isSafeInteger(value.ackJobId) || value.ackJobId < value.fenceJobId ||
      !canonicalTimestamp(value.acknowledgedAt)
    ) throw new Error("historical fence acknowledgment changed");
  } else if ([value.ackNodeId, value.ackJobId, value.acknowledgedAt]
    .some((member) => member !== null)) {
    throw new Error("historical unacknowledged fence changed");
  }
}

function assertZeroDrain(value) {
  const fields = ["queued", "liveClaims", "indeterminate", "unknown", "settlementPending"];
  assertExactDataRecord(value, fields, "historical drain measurement");
  if (fields.some((field) => value[field] !== 0)) {
    throw new Error("historical drain is not empty");
  }
}

function assertHistoricalActionMeasurements(actionId, value, generation, partition, binding) {
  switch (actionId) {
    case "phase3-consumer-start-disabled":
      assertExactDataRecord(value, ["consumer"], "consumer-start-disabled measurements");
      assertMarkerIdentity(
        value.consumer,
        partition.consumerService,
        partition.consumerNodeId,
        binding,
        false,
      );
      break;
    case "phase3-legacy-lease-release":
      assertExactDataRecord(value, ["lease"], "legacy-lease-release measurements");
      assertExactDataRecord(
        value.lease,
        ["activeOwnerCount", "ownerNodeId", "legacyOwnerActive"],
        "released legacy lease",
      );
      if (
        value.lease.activeOwnerCount !== 0 || value.lease.ownerNodeId !== null ||
        value.lease.legacyOwnerActive !== false
      ) throw new Error("legacy lease was not released");
      break;
    case "phase3-poller-start":
      assertExactDataRecord(value, ["poller"], "poller-start measurements");
      assertMarkerIdentity(
        value.poller,
        partition.pollerService,
        partition.pollerNodeId,
        binding,
        false,
        { cutoverEpoch: partition.epoch },
      );
      break;
    case "phase3-publication-enable":
      assertExactDataRecord(value, ["control"], "publication-enable measurements");
      assertMarkerControl(value.control, generation, partition, "enabled", false);
      break;
    case "phase3-execution-enable":
      assertExactDataRecord(value, ["consumer"], "execution-enable measurements");
      assertMarkerIdentity(
        value.consumer,
        partition.consumerService,
        partition.consumerNodeId,
        binding,
        true,
      );
      break;
    case "phase3-publication-fence":
      assertExactDataRecord(value, ["control"], "publication-fence measurements");
      assertMarkerControl(value.control, generation, partition, "fenced", false);
      break;
    case "phase3-drain-or-quarantine":
      assertExactDataRecord(value, ["control", "drain"], "drain measurements");
      assertMarkerControl(value.control, generation, partition, "fenced", true);
      assertZeroDrain(value.drain);
      break;
    case "phase3-inline-owner-restore": {
      assertExactDataRecord(
        value,
        ["control", "drain", "lease", "services"],
        "inline restore measurements",
      );
      assertMarkerControl(value.control, generation, partition, "fenced", true);
      assertZeroDrain(value.drain);
      assertExactDataRecord(value.lease, ["activeOwnerCount", "ownerNodeId", "status"], "inline lease");
      if (
        value.lease.activeOwnerCount !== 1 || value.lease.ownerNodeId !== partition.legacyNodeId ||
        value.lease.status !== "active"
      ) throw new Error("inline lease was not restored");
      assertExactDataRecord(value.services, ["poller", "consumer", "inline"], "restored services");
      for (const [name, service, nodeId] of [
        ["poller", partition.pollerService, partition.pollerNodeId],
        ["consumer", partition.consumerService, partition.consumerNodeId],
      ]) {
        assertExactDataRecord(value.services[name], ["service", "nodeId", "running"], `${name} stop state`);
        if (
          value.services[name].service !== service || value.services[name].nodeId !== nodeId ||
          value.services[name].running !== false
        ) throw new Error(`${name} was not stopped`);
      }
      assertMarkerIdentity(
        value.services.inline,
        partition.legacyService,
        partition.legacyNodeId,
        binding,
        false,
        { inline: true },
      );
      break;
    }
    default:
      throw new Error("historical action ID changed");
  }
}

function assertHistoricalActions(actions, snapshot, projection, metadata, context, partition, captureAt) {
  for (const [index, actionId] of PHASE3_ACTION_IDS.entries()) {
    const marker = actions[index].value;
    const terminal = projection.phase3Actions[index];
    assertExactDataRecord(marker, ACTION_MARKER_FIELDS, `historical action ${actionId}`);
    if (
      marker.schemaVersion !== 1 || marker.actionId !== actionId ||
      marker.mutationSha256 !== terminal.mutationSha256 ||
      marker.terminalRecordSha256 !== terminal.terminalRecordSha256 ||
      marker.completedAt !== terminal.completedAt ||
      !canonicalEqual(marker.releaseBinding, expectedMarkerRelease(metadata.binding)) ||
      marker.guardLeaseId !== context.guardLeaseId ||
      marker.watchdogLeaseId !== context.watchdogLeaseId ||
      marker.teamId !== partition.teamId || marker.epoch !== partition.epoch ||
      (index < 3 ? marker.generation !== null : marker.generation !== context.generation)
    ) throw new Error("historical action terminal, release, partition, or lease changed");
    assertHistoricalObservedAt(marker.observedAt, marker.completedAt, captureAt);
    assertHistoricalActionMeasurements(
      actionId,
      marker.measurements,
      marker.generation,
      partition,
      metadata.binding,
    );
  }
  if (
    actions.at(-1).value.terminalRecordSha256 !== snapshot.headSha256 ||
    Date.parse(actions[2].value.completedAt) <= Date.parse(actions[0].value.completedAt)
  ) throw new Error("historical action ordering changed");
}

function assertHistoricalObservations(observations, projection, metadata, context, partition, captureAt) {
  const records = [observations.schema, observations.fence];
  const terminals = [projection.gate3, projection.phase3Actions[5]];
  const ids = ["phase3-schema-verify", "phase3-fence-ack-wait"];
  for (let index = 0; index < records.length; index += 1) {
    const marker = records[index].value;
    const terminal = terminals[index];
    assertExactDataRecord(marker, OBSERVATION_MARKER_FIELDS, `historical observation ${ids[index]}`);
    if (
      marker.schemaVersion !== 1 || marker.observationId !== ids[index] ||
      marker.requiredTerminalActionId !== terminal.actionId ||
      marker.terminalRecordSha256 !== terminal.terminalRecordSha256 ||
      marker.actionJournalHeadSha256 !== terminal.terminalRecordSha256 ||
      marker.stagingRunId !== metadata.binding.stagingRunId ||
      marker.teamId !== partition.teamId || marker.epoch !== partition.epoch ||
      marker.pollerNodeId !== partition.pollerNodeId ||
      marker.approvalEnvelopeSha256 !== metadata.binding.stagingApprovalEnvelopeSha256 ||
      marker.releaseManifestSha256 !== metadata.binding.releaseManifestSha256 ||
      marker.rollbackReleaseManifestSha256 !== metadata.rollbackReleaseManifestSha256 ||
      marker.targetDescriptorSha256 !== metadata.binding.stagingTargetDescriptorSha256 ||
      marker.operatorBundleSha256 !== metadata.binding.operatorBundleSha256 ||
      marker.guardLeaseId !== context.guardLeaseId || marker.watchdogLeaseId !== context.watchdogLeaseId ||
      (index === 0 ? marker.generation !== null : marker.generation !== context.generation)
    ) throw new Error("historical observation binding changed");
    assertHistoricalObservedAt(marker.observedAt, terminal.completedAt, captureAt);
  }
  const schema = observations.schema.value.measurements;
  assertExactDataRecord(
    schema,
    [
      "candidateSchemaVersion", "schemaMaximum", "rollbackSchemaMinimum", "rollbackSchemaMaximum",
      "candidateSchemaRangeDeclared", "nMinusOneSchemaRangeDeclared", "migration035ChecksumMatches",
      "pendingMigrations", "runningMigrations", "failedMigrations", "observerReadOnly",
    ],
    "historical schema observation",
  );
  if (
    schema.candidateSchemaVersion !== schema.schemaMaximum ||
    schema.rollbackSchemaMinimum > schema.rollbackSchemaMaximum ||
    schema.schemaMaximum < schema.rollbackSchemaMinimum || schema.schemaMaximum > schema.rollbackSchemaMaximum ||
    schema.candidateSchemaRangeDeclared !== true || schema.nMinusOneSchemaRangeDeclared !== true ||
    schema.migration035ChecksumMatches !== true || schema.observerReadOnly !== true ||
    schema.pendingMigrations !== 0 || schema.runningMigrations !== 0 || schema.failedMigrations !== 0
  ) throw new Error("historical schema observation changed");
  const fence = observations.fence.value.measurements;
  assertExactDataRecord(
    fence,
    [
      "state", "publicationGeneration", "fenceJobId", "ackJobId", "pollerNodeId", "ackNodeId",
      "acknowledgedAt", "isActive", "observerReadOnly",
    ],
    "historical fence observation",
  );
  if (
    fence.state !== "fenced" || fence.publicationGeneration !== context.generation ||
    !Number.isSafeInteger(fence.fenceJobId) || fence.fenceJobId < 0 ||
    !Number.isSafeInteger(fence.ackJobId) || fence.ackJobId < fence.fenceJobId ||
    fence.pollerNodeId !== partition.pollerNodeId || fence.ackNodeId !== partition.pollerNodeId ||
    !canonicalTimestamp(fence.acknowledgedAt) || fence.isActive !== true || fence.observerReadOnly !== true
  ) throw new Error("historical fence observation changed");
}

function validateSourceGraph(sources, metadata, capability, snapshot, projection) {
  const context = sources["db-final"].value?.context;
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    validatePhase3RuntimeSourceValue(sourceId, sources[sourceId].value, context);
    if (!canonicalEqual(sources[sourceId].value.context, context)) {
      throw new Error("Phase 3 runtime source contexts differ");
    }
  }
  if (
    context.stagingRunId !== metadata.binding.stagingRunId ||
    context.actionJournalHeadSha256 !== snapshot.headSha256 ||
    context.candidateSha !== metadata.binding.candidateSha ||
    context.imageDigest !== metadata.binding.imageDigest ||
    context.releaseManifestSha256 !== metadata.binding.releaseManifestSha256 ||
    context.rollbackReleaseManifestSha256 !== metadata.rollbackReleaseManifestSha256 ||
    context.stagingTargetDescriptorSha256 !== metadata.binding.stagingTargetDescriptorSha256 ||
    context.operatorBundleSha256 !== metadata.binding.operatorBundleSha256 ||
    context.stagingApprovalEnvelopeSha256 !== metadata.binding.stagingApprovalEnvelopeSha256 ||
    context.teamId !== capability.phase3.canaryTeamId ||
    context.epoch !== capability.phase3.canaryEpoch ||
    context.windowStartedAt !== projection.windowStartedAt ||
    context.windowEndedAt !== projection.windowEndedAt
  ) throw new Error("Phase 3 runtime source context changed");
  const database = sources["db-final"].value.database;
  if (
    database.ok !== true || database.control.state !== "fenced" ||
    database.control.generation !== context.generation || database.control.pollerNodeMatches !== true ||
    database.staleEpochActions !== 0 || database.directPollerAccepts !== 0 ||
    ["queued", "liveClaims", "indeterminate", "unknown", "settlementPending"]
      .some((field) => database.drain[field] !== 0) ||
    DUPLICATE_KEYS.some((field) => database.duplicates[field] !== 0)
  ) throw new Error("Phase 3 database source is not Gate 4 passing");
  const runtime = sources["runtime-final"].value.runtime;
  if (
    runtime.remainingPhase3RuntimeCount !== 0 ||
    !canonicalEqual(runtime.restoredLegacyOwner, database.inlineLease)
  ) throw new Error("Phase 3 runtime owner differs from database evidence");
  const continuity = sources["lease-continuity"].value.continuity;
  const capacity = sources.capacity.value.capacity;
  const observer = sources["production-observer"].value.productionObserver;
  const expectedApproved = {
    maxCpuPercent: metadata.approvedThresholds.maxCpuPercent,
    minMemoryFreeBytes: metadata.approvedThresholds.minMemoryFreeBytes,
    minMysqlConnectionsFree: metadata.approvedThresholds.minMysqlConnectionsFree,
    maxProductionP95LatencyMs: metadata.approvedThresholds.productionP95LatencyMs,
    maxLatencyIncreasePercent: metadata.approvedThresholds.maxLatencyIncreasePercent,
  };
  const increase = ((capacity.measurements.productionP95LatencyMs -
    capacity.measurements.productionBaselineP95LatencyMs) /
    capacity.measurements.productionBaselineP95LatencyMs) * 100;
  if (
    !canonicalEqual(capacity.thresholds.envelopeApproved, expectedApproved) ||
    observer.expectedPolicySha256 !== metadata.productionObserverPolicySha256 ||
    capacity.observedAt !== observer.observedAt ||
    capacity.measurements.productionP95LatencyMs !== observer.response.p95LatencyMs ||
    capacity.measurements.productionBaselineP95LatencyMs !==
      continuity.after.guard.baselineP95LatencyMs ||
    capacity.measurements.productionLatencyIncreasePercent !== increase ||
    Date.parse(capacity.observedAt) < Date.parse(context.windowEndedAt) ||
    capacity.ok !== true || capacity.failures.length !== 0 || observer.response.ready !== true ||
    observer.thresholdResult.absoluteP95WithinApprovedLimit !== true ||
    observer.thresholdResult.latencyIncreaseWithinApprovedLimit !== true ||
    observer.thresholdResult.passed !== true
  ) throw new Error("Phase 3 capacity or production observer source is not Gate 4 passing");
  return deepFreeze({ context, database, runtime, continuity, capacity, observer });
}

function assertContinuityGraph(continuity, observations, actions, context) {
  for (const role of ["guard", "watchdog"]) {
    for (const field of ["leaseId", "pid", "startedMonotonicMs", "baselineP95LatencyMs"]) {
      if (continuity.before[role][field] !== continuity.after[role][field]) {
        throw new Error("historical lease instance changed");
      }
    }
    if (continuity.after[role].heartbeatMonotonicMs < continuity.before[role].heartbeatMonotonicMs) {
      throw new Error("historical lease heartbeat decreased");
    }
  }
  if (
    continuity.before.guard.leaseId !== context.guardLeaseId ||
    continuity.before.watchdog.leaseId !== context.watchdogLeaseId ||
    continuity.sameInstance !== true || continuity.heartbeatNondecreasing !== true ||
    continuity.zeroGap !== true
  ) throw new Error("historical lease continuity changed");
  for (const [index, record] of [observations.schema, observations.fence].entries()) {
    const binding = continuity.markerBindings.observations[index];
    if (
      binding.observationId !== record.observationId || binding.markerSha256 !== record.sha256 ||
      binding.guardLeaseId !== context.guardLeaseId || binding.watchdogLeaseId !== context.watchdogLeaseId
    ) throw new Error("historical observation continuity binding changed");
  }
  for (const [index, record] of actions.entries()) {
    const binding = continuity.markerBindings.actions[index];
    if (
      binding.actionId !== record.actionId || binding.markerSha256 !== record.sha256 ||
      binding.guardLeaseId !== context.guardLeaseId || binding.watchdogLeaseId !== context.watchdogLeaseId
    ) throw new Error("historical action continuity binding changed");
  }
}

function expectedSemanticValue(metadata, capability, snapshotRecord, projection, observations, actions, sources) {
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
  return {
    schemaVersion: 2,
    release: {
      ...metadata.binding,
      actionJournalHeadSha256: snapshotRecord.value.headSha256,
    },
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
    drain: Object.fromEntries(
      ["queued", "liveClaims", "indeterminate", "unknown", "settlementPending"]
        .map((field) => [field, database.drain[field]]),
    ),
    rollback: { inlineOwnerRestored: true },
    duplicates: Object.fromEntries(DUPLICATE_KEYS.map((field) => [field, database.duplicates[field]])),
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

function assertSameRecord(left, right, label) {
  if (
    left.bytes !== right.bytes || left.sha256 !== right.sha256 ||
    !canonicalEqual(left.value, right.value)
  ) throw new Error(`${label} changed during final reread`);
}

function assertSameMarkerSet(left, right, label) {
  if (Array.isArray(left)) {
    for (const [index, record] of left.entries()) assertSameRecord(record, right[index], `${label} ${index}`);
    return;
  }
  assertSameRecord(left.schema, right.schema, `${label} schema`);
  assertSameRecord(left.fence, right.fence, `${label} fence`);
}

function assertSameSourceSet(left, right) {
  for (const sourceId of PHASE3_RUNTIME_SOURCE_IDS) {
    assertSameRecord(left[sourceId], right[sourceId], `Phase 3 source ${sourceId}`);
  }
}

async function verifyInstalled(input, callerArguments) {
  const testPorts = validateInstalledInvocation(input, callerArguments);
  const expectedSemanticSha256 = input.expectedSemanticSha256;
  const ports = defaultInstalledPorts(testPorts);

  const semantic = normalizeStorageRecord(
    await ports.readSemantic(),
    "installed Phase 3 semantic evidence",
  );
  if (
    semantic.sha256 !== expectedSemanticSha256 ||
    sha256Text(semantic.bytes) !== expectedSemanticSha256
  ) throw new Error("installed Phase 3 semantic evidence hash changed");

  const metadata = validateInstalledContext(await ports.loadContext());
  const capabilityValue = freezeClone(
    await ports.loadCapability(structuredClone(metadata.binding)),
  );
  validateStagingActionCapability(capabilityValue, metadata.binding);
  const partition = phase3PartitionIdentity(
    capabilityValue.phase3.canaryTeamId,
    capabilityValue.phase3.canaryEpoch,
  );
  const initialHostIdentity = await ports.loadHostIdentity();
  if (initialHostIdentity !== metadata.hostIdentitySha256 || !nonzeroHash(initialHostIdentity)) {
    throw new Error("installed A3 host identity changed");
  }

  const snapshot = normalizeStorageRecord(
    await ports.readSnapshot(),
    "installed Phase 3 journal snapshot",
  );
  const historicalBinding = {
    ...metadata.binding,
    actionJournalHeadSha256: snapshot.value.headSha256,
  };
  const projection = validatePhase3PreGate4JournalSnapshot(snapshot.value, {
    installedBinding: historicalBinding,
    approvalId: metadata.approvalId,
  });
  validateReleaseBinding(semantic.value?.release);
  if (
    semantic.value.release.environment !== "staging" ||
    semantic.value.release.actionJournalHeadSha256 !== snapshot.value.headSha256 ||
    RELEASE_IDENTITY_FIELDS.some((field) =>
      semantic.value.release[field] !== metadata.binding[field])
  ) throw new Error("historical semantic release identity changed");

  if (metadata.binding.actionJournalHeadSha256 === snapshot.value.headSha256) {
    if (semantic.value.release.actionJournalHeadSha256 !== metadata.binding.actionJournalHeadSha256) {
      throw new Error("direct installed journal head changed");
    }
  } else {
    const prefix = freezeClone(await ports.verifyJournalPrefix({
      binding: structuredClone(metadata.binding),
      snapshot: structuredClone(snapshot.value),
    }));
    assertExactDataRecord(
      prefix,
      ["ok", "prefixHeadSha256", "currentHeadSha256"],
      "journal prefix verification",
    );
    if (
      prefix.ok !== true ||
      prefix.prefixHeadSha256 !== snapshot.value.headSha256 ||
      prefix.currentHeadSha256 !== metadata.binding.actionJournalHeadSha256
    ) throw new Error("installed journal prefix authentication failed");
  }

  const sources = normalizeSourceArtifacts(await ports.readSources());
  const sourceGraph = validateSourceGraph(
    sources,
    metadata,
    capabilityValue,
    snapshot.value,
    projection,
  );
  const captureAt = sourceGraph.capacity.observedAt;
  const observations = normalizeObservationArtifacts(
    await ports.readHistoricalObservationMarkerArtifacts(),
  );
  const actions = normalizeActionArtifacts(
    await ports.readHistoricalActionMeasurementArtifacts(),
  );
  assertHistoricalObservations(
    observations,
    projection,
    metadata,
    sourceGraph.context,
    partition,
    captureAt,
  );
  assertHistoricalActions(
    actions,
    snapshot.value,
    projection,
    metadata,
    sourceGraph.context,
    partition,
    captureAt,
  );
  assertContinuityGraph(sourceGraph.continuity, observations, actions, sourceGraph.context);

  const fenceObservation = observations.fence.value.measurements;
  const finalControl = actions.at(-1).value.measurements.control;
  const finalLease = actions.at(-1).value.measurements.lease;
  const database = sourceGraph.database;
  if (
    database.control.fenceJobId !== fenceObservation.fenceJobId ||
    database.control.ackJobId !== fenceObservation.ackJobId ||
    database.control.acknowledgedAt !== fenceObservation.acknowledgedAt ||
    database.control.fenceJobId !== finalControl.fenceJobId ||
    database.control.ackJobId !== finalControl.ackJobId ||
    database.control.acknowledgedAt !== finalControl.acknowledgedAt ||
    database.inlineLease.ownerNodeId !== finalLease.ownerNodeId ||
    database.inlineLease.activeOwnerCount !== finalLease.activeOwnerCount
  ) throw new Error("historical database, marker, and restore evidence differ");

  const expectedSemantic = expectedSemanticValue(
    metadata,
    capabilityValue,
    snapshot,
    projection,
    observations,
    actions,
    sources,
  );
  if (!canonicalEqual(semantic.value, expectedSemantic)) {
    throw new Error("installed Phase 3 semantic evidence differs from its fixed artifact graph");
  }
  const result = evaluatePhase3Evidence(semantic.value);
  if (!result.ok) return result;

  const finalHostIdentity = await ports.loadHostIdentity();
  if (finalHostIdentity !== initialHostIdentity || finalHostIdentity !== metadata.hostIdentitySha256) {
    throw new Error("installed A3 host identity changed during verification");
  }
  const finalSnapshot = normalizeStorageRecord(
    await ports.readSnapshot(),
    "final Phase 3 journal snapshot",
  );
  const finalObservations = normalizeObservationArtifacts(
    await ports.readHistoricalObservationMarkerArtifacts(),
  );
  const finalActions = normalizeActionArtifacts(
    await ports.readHistoricalActionMeasurementArtifacts(),
  );
  const finalSources = normalizeSourceArtifacts(await ports.readSources());
  const finalSemantic = normalizeStorageRecord(
    await ports.readSemantic(),
    "final Phase 3 semantic evidence",
  );
  assertSameRecord(snapshot, finalSnapshot, "Phase 3 journal snapshot");
  assertSameMarkerSet(observations, finalObservations, "Phase 3 observations");
  assertSameMarkerSet(actions, finalActions, "Phase 3 actions");
  assertSameSourceSet(sources, finalSources);
  assertSameRecord(semantic, finalSemantic, "Phase 3 semantic evidence");
  if (
    finalSemantic.sha256 !== expectedSemanticSha256 ||
    sha256Text(finalSemantic.bytes) !== expectedSemanticSha256
  ) throw new Error("final Phase 3 semantic evidence hash changed");
  return result;
}

export async function verifyInstalledPhase3RolloutEvidence(input, ...callerArguments) {
  try {
    return await verifyInstalled(input, callerArguments);
  } catch {
    return { ok: false, failures: ["PHASE3_EVIDENCE_INVALID"] };
  }
}

function parseCli(argv) {
  const supervisedProduction = argv.includes("--supervised-production");
  const values = argv.filter((argument) => argument !== "--supervised-production");
  if (
    !supervisedProduction ||
    values.length !== 1 ||
    !values[0].startsWith("--dir=") ||
    values[0].length <= 6
  ) {
    throw new Error("Phase 3 evidence checker arguments are invalid");
  }
  return { dir: resolve(values[0].slice(6)), supervisedProduction };
}

async function loadAndVerifyEvidence(args) {
  const installed = await loadInstalledReleaseBinding({ environment: "supervised-production" });
  const bundle = await readEvidenceBundle(args.dir, {
    allowedNames: [EVIDENCE_FILENAME],
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 512 * 1024,
  });
  const evidence = bundle[EVIDENCE_FILENAME];
  validateReleaseBinding(evidence?.release, installed);

  return evidence;
}

async function main() {
  try {
    const args = parseCli(process.argv.slice(2));
    const evidence = await loadAndVerifyEvidence(args);
    const result = evaluatePhase3Evidence(evidence, args);
    process.stdout.write(`${canonicalJson(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`${canonicalJson({ ok: false, failures: ["PHASE3_EVIDENCE_INVALID"] })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
