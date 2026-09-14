#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson, readEvidenceJson } from "./lib/evidence-artifact.mjs";
import {
  PHASE3_ACTION_IDS,
  phase3PartitionIdentity,
  readPhase3ActionMeasurement,
  readPhase3ObservationMarker,
  validatePhase3ActionMeasurement,
} from "./lib/phase3-staging-evidence.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases } from "./lib/a3-staging-leases.mjs";
import {
  loadInstalledStagingActionCapability,
  loadStagingDatabaseCredential,
} from "./lib/staging-action-capability.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";
import { validateStagingPhase3EvidencePayload } from "./staging-phase3-db-controller.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EPOCH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const OBSERVATION_EVIDENCE_ROOT = "/var/lib/spx-staging-rollout/phase3-observations";
const ACTION_IDENTITIES = Object.freeze([
  ["phase3-consumer-start-disabled", "consumer-start-disabled"],
  ["phase3-legacy-lease-release", "legacy-lease-release"],
  ["phase3-poller-start", "poller-start"],
  ["phase3-publication-enable", "publication-enable"],
  ["phase3-execution-enable", "execution-enable"],
  ["phase3-publication-fence", "publication-fence"],
  ["phase3-drain-or-quarantine", "drain-or-quarantine"],
  ["phase3-inline-owner-restore", "inline-owner-restore"],
]);

export const PHASE3_STAGING_ACTIONS = Object.freeze(
  ACTION_IDENTITIES.map(([actionId, transition]) => Object.freeze({
    actionId,
    scope: actionId,
    transition,
  })),
);
export const PHASE3_STAGING_OBSERVATIONS = Object.freeze([
  "phase3-schema-verify",
  "phase3-fence-ack-wait",
]);
const OBSERVATION_TERMINALS = Object.freeze({
  "phase3-schema-verify": "staging-gate-3-handoff",
  "phase3-fence-ack-wait": "phase3-publication-fence",
});
const ACTIONS = new Map(PHASE3_STAGING_ACTIONS.map((action) => [action.actionId, action]));
const TRUSTED_TRANSITION_STEPS = new WeakSet();

function trustedApprovalId(context) {
  const verifiedApprovalId = context?.verified?.approvalId;
  const envelopeApprovalId = context?.envelope?.approvalId;
  if (
    !RUN_ID.test(verifiedApprovalId ?? "") ||
    !RUN_ID.test(envelopeApprovalId ?? "") ||
    verifiedApprovalId !== envelopeApprovalId
  ) throw new Error("installed staging approval identity changed");
  return verifiedApprovalId;
}

function fixedPartition(phase3) {
  if (![1, 2].includes(phase3?.canaryTeamId) || !EPOCH.test(phase3?.canaryEpoch ?? "")) {
    throw new Error("release-bound staging Phase 3 canary team and epoch are required");
  }
  return Object.freeze({
    partition: phase3.canaryTeamId === 1 ? "ptwl" : "ifn",
    ...phase3PartitionIdentity(phase3.canaryTeamId, phase3.canaryEpoch),
  });
}

export function parseStagingPhase3Invocation(argv, environment = process.env) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("fixed staging Phase 3 actions accept zero caller arguments");
  }
  const action = ACTIONS.get(environment.SPX_STAGING_ACTION_ID);
  if (
    !action ||
    environment.SPX_STAGING_ACTION_SCOPE !== action.scope ||
    !RUN_ID.test(environment.SPX_STAGING_RUN_ID ?? "")
  ) {
    throw new Error("inherited staging Phase 3 action context is invalid");
  }
  return Object.freeze({ ...action, stagingRunId: environment.SPX_STAGING_RUN_ID });
}

function transitionStep(partition, transition, epoch, operatorRoot) {
  const step = {
    ...partition,
    transition,
    epoch,
    composePrefix: Object.freeze(buildInstalledStagingComposePrefix(operatorRoot)),
    disabledOverlay: `${operatorRoot}/deploy/staging-phase3-disabled.yml`,
    enabledOverlay: `${operatorRoot}/deploy/staging-phase3-enabled.yml`,
  };
  TRUSTED_TRANSITION_STEPS.add(step);
  return Object.freeze(step);
}

export function buildStagingPhase3Transitions(actionId, capability, operatorRoot) {
  const action = ACTIONS.get(actionId);
  if (!action) throw new Error("fixed staging Phase 3 action is invalid");
  const phase3 = capability?.phase3;
  const partition = fixedPartition(phase3);
  return Object.freeze([
    transitionStep(partition, action.transition, phase3.canaryEpoch, operatorRoot),
  ]);
}

function releaseMigrations(releaseManifest) {
  if (!Array.isArray(releaseManifest?.migrations) || releaseManifest.migrations.length === 0) {
    throw new Error("release-bound staging migration manifest is required");
  }
  const migrations = releaseManifest.migrations.map((migration) => Object.freeze({
    filename: migration.name,
    sha256: migration.sha256,
  }));
  const maximum = Math.max(...migrations.map(({ filename }) => Number(filename.slice(0, 3))));
  if (
    !Number.isSafeInteger(maximum) ||
    releaseManifest.schema?.max !== maximum ||
    !Number.isSafeInteger(releaseManifest.schema?.min) ||
    releaseManifest.schema.min < 0 ||
    releaseManifest.schema.min > maximum ||
    !migrations.some(({ filename }) =>
      filename === "035_create_auto_accept_publication_controls.sql")
  ) {
    throw new Error("release-bound staging schema range or migration 035 is invalid");
  }
  return Object.freeze(migrations);
}

export function buildStagingPhase3ObservationPayload(input) {
  const requiredTerminalActionId = OBSERVATION_TERMINALS[input?.observationId];
  const binding = input?.context?.installedBinding;
  const releaseManifest = input?.context?.artifacts?.releaseManifest;
  const rollbackReleaseManifest = input?.context?.artifacts?.rollbackReleaseManifest;
  const phase3 = input?.capability?.phase3;
  const partition = fixedPartition(phase3);
  if (
    !requiredTerminalActionId ||
    input.requiredTerminalActionId !== requiredTerminalActionId ||
    binding?.stagingRunId !== input?.leases?.stagingRunId ||
    !input.leases?.guard?.leaseId ||
    !input.leases?.watchdog?.leaseId ||
    input.leases.guard.leaseId === input.leases.watchdog.leaseId
  ) {
    throw new Error("fixed staging Phase 3 observation context is invalid");
  }
  const migrations = releaseMigrations(releaseManifest);
  const rollbackMigrations = releaseMigrations(rollbackReleaseManifest);
  if (
    input.context?.verified?.rollbackReleaseManifestSha256 !==
      input.context?.envelope?.release?.rollbackReleaseManifestSha256 ||
    releaseManifest.schema.max < rollbackReleaseManifest.schema.min ||
    releaseManifest.schema.max > rollbackReleaseManifest.schema.max
  ) {
    throw new Error("signed staging rollback manifest is not the exact declared N-1 range");
  }
  return Object.freeze({
    schemaVersion: 1,
    observationId: input.observationId,
    requiredTerminalActionId,
    teamId: partition.teamId,
    epoch: phase3.canaryEpoch,
    pollerNodeId: partition.pollerNodeId,
    releaseContext: Object.freeze({
      candidateSha: binding.candidateSha,
      imageDigest: binding.imageDigest,
      releaseManifestSha256: binding.releaseManifestSha256,
      stagingTargetDescriptorSha256: binding.stagingTargetDescriptorSha256,
      operatorBundleSha256: binding.operatorBundleSha256,
      stagingApprovalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
      actionJournalHeadSha256: binding.actionJournalHeadSha256,
      stagingRunId: binding.stagingRunId,
      guardLeaseId: input.leases.guard.leaseId,
      watchdogLeaseId: input.leases.watchdog.leaseId,
      schema: Object.freeze({
        min: releaseManifest.schema.min,
        max: releaseManifest.schema.max,
      }),
      migrations,
      rollbackReleaseManifestSha256:
        input.context.verified.rollbackReleaseManifestSha256,
      rollbackSchema: Object.freeze({
        min: rollbackReleaseManifest.schema.min,
        max: rollbackReleaseManifest.schema.max,
      }),
      rollbackMigrations,
    }),
    connection: input.database,
  });
}

function ordinarySucceededEvidenceTerminal(snapshot, actionId, requireHead = false) {
  const matches = Array.isArray(snapshot?.actions)
    ? snapshot.actions.filter((entry) => entry?.actionId === actionId)
    : [];
  const terminal = matches.length === 1 ? matches[0] : null;
  if (
    !terminal ||
    terminal.kind !== "forward" ||
    terminal.state !== "succeeded" ||
    terminal.occurrences !== 1 ||
    terminal.reconciliationId !== null ||
    terminal.reconciliationOutcome !== null ||
    !HASH.test(terminal.mutationSha256 ?? "") ||
    !HASH.test(terminal.terminalRecordSha256 ?? "") ||
    (requireHead && terminal.terminalRecordSha256 !== snapshot?.headSha256)
  ) {
    throw new Error(`the ${actionId} action is not exactly one ordinary succeeded terminal`);
  }
  canonicalTimestamp(terminal.completedAt, `${actionId} completion timestamp`);
  return terminal;
}

export function buildStagingPhase3EvidencePayload(input, ...extra) {
  if (
    extra.length !== 0 ||
    !hasExactFields(input, [
      "context",
      "capability",
      "journalSnapshot",
      "finalActionMeasurement",
      "leases",
      "observerDatabase",
    ])
  ) {
    throw new Error("fixed staging Phase 3 final evidence builder input is invalid");
  }
  const binding = input.context?.installedBinding;
  const approvalId = trustedApprovalId(input.context);
  const rollbackReleaseManifestSha256 =
    input.context?.verified?.rollbackReleaseManifestSha256;
  const fixed = fixedPartition(input.capability?.phase3);
  const partition = phase3PartitionIdentity(fixed.teamId, fixed.epoch);
  const marker = input.finalActionMeasurement;
  const markerObservedMs = Date.parse(marker?.observedAt ?? "");
  const trustedNowMs = Date.now();
  if (
    marker?.actionId !== "phase3-inline-owner-restore" ||
    !Number.isSafeInteger(markerObservedMs) ||
    markerObservedMs < 0 ||
    !Number.isSafeInteger(trustedNowMs) ||
    trustedNowMs < 0 ||
    !HASH.test(rollbackReleaseManifestSha256 ?? "")
  ) {
    throw new Error("authenticated final Phase 3 action marker is invalid");
  }
  const validatedMarker = validatePhase3ActionMeasurement(marker, {
    position: "current",
    journalSnapshot: input.journalSnapshot,
    installedBinding: binding,
    approvalId,
    rollbackReleaseManifestSha256,
    leases: input.leases,
    partition,
    nowMs: trustedNowMs,
  });
  const gate3Terminal = ordinarySucceededEvidenceTerminal(
    input.journalSnapshot,
    "staging-gate-3-handoff",
  );
  const inlineRestoreTerminal = ordinarySucceededEvidenceTerminal(
    input.journalSnapshot,
    "phase3-inline-owner-restore",
    true,
  );
  if (
    binding?.stagingRunId !== input.leases?.stagingRunId ||
    binding?.actionJournalHeadSha256 !== input.journalSnapshot?.headSha256 ||
    validatedMarker.teamId !== partition.teamId ||
    validatedMarker.epoch !== partition.epoch ||
    validatedMarker.terminalRecordSha256 !== inlineRestoreTerminal.terminalRecordSha256 ||
    validatedMarker.completedAt !== inlineRestoreTerminal.completedAt ||
    !Number.isSafeInteger(validatedMarker.generation) ||
    validatedMarker.generation < 1 ||
    Date.parse(gate3Terminal.completedAt) >= Date.parse(inlineRestoreTerminal.completedAt)
  ) {
    throw new Error("authenticated staging Phase 3 final evidence window is invalid");
  }
  const payload = {
    schemaVersion: 1,
    evidenceId: "phase3-gate4-final",
    teamId: partition.teamId,
    epoch: partition.epoch,
    generation: validatedMarker.generation,
    pollerNodeId: partition.pollerNodeId,
    expectedOwnerNodeId: partition.legacyNodeId,
    windowStartedAt: gate3Terminal.completedAt,
    windowEndedAt: inlineRestoreTerminal.completedAt,
    connection: input.observerDatabase,
  };
  validateStagingPhase3EvidencePayload(payload);
  return freezeClone(payload);
}

const ACTION_OBSERVATION_REQUIREMENTS = Object.freeze({
  "phase3-consumer-start-disabled": Object.freeze({
    observationId: "phase3-schema-verify",
    requiredTerminalActionId: "staging-gate-3-handoff",
    exactHead: true,
  }),
  "phase3-drain-or-quarantine": Object.freeze({
    observationId: "phase3-fence-ack-wait",
    requiredTerminalActionId: "phase3-publication-fence",
    exactHead: true,
  }),
  "phase3-inline-owner-restore": Object.freeze({
    observationId: "phase3-fence-ack-wait",
    requiredTerminalActionId: "phase3-publication-fence",
    exactHead: false,
  }),
});

function observationEvidenceFilename(observationId) {
  if (!PHASE3_STAGING_OBSERVATIONS.includes(observationId)) {
    throw new Error("fixed staging Phase 3 observation evidence ID is invalid");
  }
  return `${observationId}.json`;
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

function hasExactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== fields.length ||
    ownKeys.some((key) => typeof key !== "string")
  ) return false;
  const expected = new Set(fields);
  if (expected.size !== fields.length) return false;
  for (const key of ownKeys) {
    if (!expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) return false;
  }
  return true;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function assertSchemaObservationMeasurements(value) {
  const fields = [
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
  ];
  if (!hasExactFields(value, fields)) {
    throw new Error("staging Phase 3 schema observation measurement shape is invalid");
  }
  for (const field of [
    "candidateSchemaVersion",
    "schemaMaximum",
    "rollbackSchemaMinimum",
    "rollbackSchemaMaximum",
    "pendingMigrations",
    "runningMigrations",
    "failedMigrations",
  ]) nonnegativeInteger(value[field], `schema observation ${field}`);
  if (
    value.candidateSchemaRangeDeclared !== true ||
    value.nMinusOneSchemaRangeDeclared !== true ||
    value.migration035ChecksumMatches !== true ||
    value.observerReadOnly !== true ||
    value.pendingMigrations !== 0 ||
    value.runningMigrations !== 0 ||
    value.failedMigrations !== 0 ||
    value.candidateSchemaVersion !== value.schemaMaximum ||
    value.rollbackSchemaMinimum > value.rollbackSchemaMaximum ||
    value.schemaMaximum < value.rollbackSchemaMinimum ||
    value.schemaMaximum > value.rollbackSchemaMaximum
  ) throw new Error("staging Phase 3 schema observation measurements are invalid");
  return value;
}

function assertFenceObservationMeasurements(value, generation, pollerNodeId) {
  const fields = [
    "state",
    "publicationGeneration",
    "fenceJobId",
    "ackJobId",
    "pollerNodeId",
    "ackNodeId",
    "acknowledgedAt",
    "isActive",
    "observerReadOnly",
  ];
  if (!hasExactFields(value, fields)) {
    throw new Error("staging Phase 3 fence observation measurement shape is invalid");
  }
  nonnegativeInteger(value.fenceJobId, "fence observation job ID");
  nonnegativeInteger(value.ackJobId, "fence observation acknowledgment job ID");
  if (
    value.state !== "fenced" ||
    value.publicationGeneration !== generation ||
    !Number.isSafeInteger(value.publicationGeneration) ||
    value.publicationGeneration <= 0 ||
    value.pollerNodeId !== pollerNodeId ||
    value.ackNodeId !== pollerNodeId ||
    value.ackJobId < value.fenceJobId ||
    value.isActive !== true ||
    value.observerReadOnly !== true
  ) throw new Error("staging Phase 3 fence observation measurements are invalid");
  canonicalTimestamp(value.acknowledgedAt, "fence observation acknowledgment timestamp");
  return value;
}

function assertObservationResult(result, expected) {
  const fields = [
    "ok",
    "observationId",
    "requiredTerminalActionId",
    "teamId",
    "epoch",
    "pollerNodeId",
    "generation",
    "observedAt",
    "measurements",
  ];
  if (
    !hasExactFields(result, fields) ||
    result.ok !== true ||
    result.observationId !== expected.observationId ||
    result.requiredTerminalActionId !== expected.requiredTerminalActionId ||
    result.teamId !== expected.teamId ||
    result.epoch !== expected.epoch ||
    result.pollerNodeId !== expected.pollerNodeId
  ) throw new Error("staging Phase 3 observation result shape or binding is invalid");
  canonicalTimestamp(result.observedAt, "staging Phase 3 observation timestamp");
  if (result.observationId === "phase3-schema-verify") {
    if (result.generation !== null) {
      throw new Error("staging Phase 3 schema observation generation is invalid");
    }
    assertSchemaObservationMeasurements(result.measurements);
  } else {
    if (!Number.isSafeInteger(result.generation) || result.generation <= 0) {
      throw new Error("staging Phase 3 fence observation generation is invalid");
    }
    assertFenceObservationMeasurements(
      result.measurements,
      result.generation,
      result.pollerNodeId,
    );
  }
  return result;
}

export function buildStagingPhase3ObservationMarker(input) {
  const binding = input?.context?.installedBinding;
  const verified = input?.context?.verified;
  const snapshot = input?.journalSnapshot;
  const observed = input?.observed;
  const partition = fixedPartition(input?.capability?.phase3);
  const matches = Array.isArray(snapshot?.actions)
    ? snapshot.actions.filter((action) => action.actionId === input?.requiredTerminalActionId)
    : [];
  const journal = matches.length === 1 ? matches[0] : null;
  if (
    OBSERVATION_TERMINALS[input?.observationId] !== input?.requiredTerminalActionId ||
    journal?.actionId !== input.requiredTerminalActionId ||
    journal?.terminalRecordSha256 !== snapshot?.headSha256 ||
    !HASH.test(journal?.terminalRecordSha256 ?? "") ||
    binding?.actionJournalHeadSha256 !== snapshot.headSha256 ||
    binding?.stagingRunId !== input?.leases?.stagingRunId ||
    !input.leases?.guard?.leaseId ||
    !input.leases?.watchdog?.leaseId ||
    input.leases.guard.leaseId === input.leases.watchdog.leaseId ||
    !HASH.test(verified?.rollbackReleaseManifestSha256 ?? "")
  ) {
    throw new Error("fixed staging Phase 3 observation evidence is invalid");
  }
  assertObservationResult(observed, {
    observationId: input.observationId,
    requiredTerminalActionId: input.requiredTerminalActionId,
    teamId: partition.teamId,
    epoch: partition.epoch,
    pollerNodeId: partition.pollerNodeId,
  });
  return freezeClone({
    schemaVersion: 1,
    observationId: input.observationId,
    requiredTerminalActionId: input.requiredTerminalActionId,
    terminalRecordSha256: journal.terminalRecordSha256,
    actionJournalHeadSha256: snapshot.headSha256,
    stagingRunId: binding.stagingRunId,
    teamId: partition.teamId,
    epoch: partition.epoch,
    pollerNodeId: partition.pollerNodeId,
    approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
    releaseManifestSha256: binding.releaseManifestSha256,
    rollbackReleaseManifestSha256: verified.rollbackReleaseManifestSha256,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    guardLeaseId: input.leases.guard.leaseId,
    watchdogLeaseId: input.leases.watchdog.leaseId,
    generation: observed.generation,
    observedAt: observed.observedAt,
    measurements: observed.measurements,
  });
}

function assertObservationEvidence(evidence, requirement, input, leases) {
  const binding = input?.binding;
  const expectedFields = [
    "schemaVersion", "observationId", "requiredTerminalActionId",
    "terminalRecordSha256", "actionJournalHeadSha256", "stagingRunId",
    "teamId", "epoch", "pollerNodeId",
    "approvalEnvelopeSha256", "releaseManifestSha256",
    "rollbackReleaseManifestSha256", "targetDescriptorSha256",
    "operatorBundleSha256", "guardLeaseId", "watchdogLeaseId", "generation",
    "observedAt", "measurements",
  ];
  const phase3 = input?.capability?.phase3;
  const partition = fixedPartition(phase3);
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    canonicalJson(Object.keys(evidence).sort()) !== canonicalJson(expectedFields.sort()) ||
    evidence.schemaVersion !== 1 ||
    evidence.observationId !== requirement.observationId ||
    evidence.requiredTerminalActionId !== requirement.requiredTerminalActionId ||
    !HASH.test(evidence.terminalRecordSha256 ?? "") ||
    evidence.terminalRecordSha256 !== evidence.actionJournalHeadSha256 ||
    evidence.stagingRunId !== binding?.stagingRunId ||
    evidence.teamId !== partition.teamId ||
    evidence.epoch !== phase3.canaryEpoch ||
    evidence.pollerNodeId !== partition.pollerNodeId ||
    evidence.approvalEnvelopeSha256 !== binding?.stagingApprovalEnvelopeSha256 ||
    evidence.releaseManifestSha256 !== binding?.releaseManifestSha256 ||
    evidence.rollbackReleaseManifestSha256 !== input?.rollbackReleaseManifestSha256 ||
    evidence.targetDescriptorSha256 !== binding?.stagingTargetDescriptorSha256 ||
    evidence.operatorBundleSha256 !== binding?.operatorBundleSha256 ||
    evidence.guardLeaseId !== leases.guard.leaseId ||
    evidence.watchdogLeaseId !== leases.watchdog.leaseId ||
    (requirement.exactHead &&
      evidence.actionJournalHeadSha256 !== binding?.actionJournalHeadSha256)
  ) {
    throw new Error("staging Phase 3 observation evidence binding or journal head changed");
  }
  canonicalTimestamp(evidence.observedAt, "staging Phase 3 observation evidence timestamp");
  if (requirement.observationId === "phase3-fence-ack-wait") {
    if (!Number.isSafeInteger(evidence.generation) || evidence.generation <= 0) {
      throw new Error("staging Phase 3 observation generation is invalid");
    }
    assertFenceObservationMeasurements(
      evidence.measurements,
      evidence.generation,
      partition.pollerNodeId,
    );
    return evidence.generation;
  }
  if (evidence.generation !== null) {
    throw new Error("staging Phase 3 schema observation generation is invalid");
  }
  assertSchemaObservationMeasurements(evidence.measurements);
  return undefined;
}

function bindExpectedGeneration(step, expectedGeneration) {
  if (expectedGeneration === undefined) return step;
  const bound = Object.freeze({ ...step, expectedGeneration });
  TRUSTED_TRANSITION_STEPS.add(bound);
  return bound;
}

function assertFreshContinuousLeases(leases, stagingRunId, previous) {
  if (
    leases?.stagingRunId !== stagingRunId ||
    leases?.guard?.state !== "armed" ||
    leases?.watchdog?.state !== "armed" ||
    !leases.guard.leaseId ||
    !leases.watchdog.leaseId ||
    leases.guard.leaseId === leases.watchdog.leaseId ||
    !Number.isFinite(leases.maxAgeMs) ||
    leases.maxAgeMs <= 0 ||
    !Number.isFinite(leases.guard.heartbeatAgeMs) ||
    leases.guard.heartbeatAgeMs < 0 ||
    !Number.isFinite(leases.watchdog.heartbeatAgeMs) ||
    leases.watchdog.heartbeatAgeMs < 0 ||
    leases.guard.heartbeatAgeMs > leases.maxAgeMs ||
    leases.watchdog.heartbeatAgeMs > leases.maxAgeMs ||
    (previous && (
      previous.guard.leaseId !== leases.guard.leaseId ||
      previous.watchdog.leaseId !== leases.watchdog.leaseId
    ))
  ) {
    throw new Error("the same fresh continuous staging guard/watchdog leases are required");
  }
  return leases;
}

export async function executeStagingPhase3Action(input, ports = {}) {
  if (
    !ACTIONS.has(input?.inherited?.actionId) ||
    input.inherited.stagingRunId !== input?.binding?.stagingRunId ||
    typeof ports.loadLeases !== "function" ||
    typeof ports.executeTransition !== "function"
  ) {
    throw new Error("verified staging Phase 3 execution capability is required");
  }
  const before = assertFreshContinuousLeases(
    await ports.loadLeases(input.binding.stagingRunId),
    input.binding.stagingRunId,
  );
  const requirement = ACTION_OBSERVATION_REQUIREMENTS[input.inherited.actionId];
  let expectedGeneration;
  if (requirement) {
    if (typeof ports.loadObservationEvidence !== "function") {
      throw new Error("required staging Phase 3 observation evidence is unavailable");
    }
    const evidence = await ports.loadObservationEvidence(requirement.observationId);
    expectedGeneration = assertObservationEvidence(evidence, requirement, input, before);
  }
  const steps = buildStagingPhase3Transitions(
    input.inherited.actionId,
    input.capability,
    input.operatorRoot,
  ).map((step) => bindExpectedGeneration(step, expectedGeneration));
  for (const step of steps) {
    const result = await ports.executeTransition(step);
    if (result?.ok !== true || result?.transition !== step.transition) {
      throw new Error("staging Phase 3 transition postcondition failed");
    }
  }
  assertFreshContinuousLeases(
    await ports.loadLeases(input.binding.stagingRunId),
    input.binding.stagingRunId,
    before,
  );
  return { ok: true, actionId: input.inherited.actionId, transitionCount: steps.length };
}

function spawn(executable, argv, options = {}) {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  if (executable === "docker") {
    const contextProbe =
      options.contextProbe === true &&
      canonicalJson(argv) === canonicalJson(["context", "show"]);
    const pinnedToDefault = argv[0] === "--context" && argv[1] === "default";
    if (!contextProbe && !pinnedToDefault) {
      throw new Error("unpinned Docker invocation is forbidden");
    }
  }
  const result = spawnSync(executable, argv, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: options.input === undefined
      ? ["ignore", options.capture ? "pipe" : "ignore", "ignore"]
      : ["pipe", "pipe", "ignore"],
    input: options.input,
    timeout: options.timeout ?? 5 * 60_000,
    maxBuffer: 512 * 1024,
    env: options.env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("fixed staging Phase 3 subprocess failed");
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function runCompose(argv, composeEnv, capture = false) {
  return spawn("docker", ["--context", "default", ...argv], { env: composeEnv, capture });
}

function inspectLocalContainer(containerId) {
  const source = spawn("docker", [
    "--context",
    "default",
    "inspect",
    "--format",
    '{"environment":{{json .Config.Env}},"health":{{json .State.Health.Status}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"status":{{json .State.Status}}}',
    containerId,
  ], { capture: true, timeout: 30_000 });
  return JSON.parse(source);
}

function assertExecutionBinding(binding) {
  if (
    !COMMIT.test(binding?.candidateSha ?? "") ||
    !IMAGE.test(binding?.imageDigest ?? "") ||
    !HASH.test(binding?.stagingTargetDescriptorSha256 ?? "") ||
    !HASH.test(binding?.operatorBundleSha256 ?? "") ||
    !RUN_ID.test(binding?.stagingRunId ?? "")
  ) {
    throw new Error("staging Phase 3 execution identity binding is invalid");
  }
  return binding;
}

function exactContainerId(source) {
  const ids = typeof source === "string"
    ? source.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
  if (ids.length !== 1 || !CONTAINER_ID.test(ids[0])) {
    throw new Error("exactly one fixed staging Phase 3 container is required");
  }
  return ids[0];
}

function assertExecutionIdentity(identity, step, binding) {
  const labels = identity?.labels;
  if (
    identity?.status !== "running" ||
    identity?.health !== "healthy" ||
    identity?.imageId !== binding.imageDigest ||
    labels?.["com.docker.compose.project"] !== "spx-staging" ||
    labels?.["com.docker.compose.service"] !== step.consumerService ||
    labels?.["com.spx.environment"] !== "staging" ||
    labels?.["com.spx.release-sha"] !== binding.candidateSha ||
    labels?.["com.spx.target-descriptor-sha256"] !==
      binding.stagingTargetDescriptorSha256 ||
    labels?.["com.spx.operator-bundle-sha256"] !== binding.operatorBundleSha256 ||
    labels?.["com.spx.staging-run-id"] !== binding.stagingRunId
  ) {
    throw new Error("staging Phase 3 execution readiness or identity verification failed");
  }
}

function candidateDatabaseCommand(imageDigest) {
  return [
    "--context", "default", "run", "--rm", "-i", "--pull=never",
    "--network=spx-staging", "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true", "--pids-limit=64", "--memory=256m",
    "--cpus=0.25", imageDigest, "node", "scripts/staging-phase3-db-controller.mjs",
  ];
}

export function buildStagingPhase3DatabaseTransport(payload, binding) {
  return freezeClone({
    executable: "docker",
    argv: candidateDatabaseCommand(binding.imageDigest),
    input: canonicalJson(payload),
  });
}

function runDatabasePayload(payload, binding) {
  const transport = buildStagingPhase3DatabaseTransport(payload, binding);
  const source = spawn(transport.executable, transport.argv, {
    capture: true,
    input: transport.input,
  });
  return JSON.parse(source);
}

function runDatabaseTransition(step, runtime, databaseAction = step.transition) {
  const value = runDatabasePayload({
    schemaVersion: 1,
    action: databaseAction,
    teamId: step.teamId,
    epoch: step.epoch,
    pollerNodeId: step.pollerNodeId,
    expectedOwnerNodeId: step.legacyNodeId,
    expectedGeneration: step.expectedGeneration ?? null,
    connection: runtime.database,
  }, runtime.binding);
  if (value?.ok !== true || value?.action !== databaseAction) {
    throw new Error("staging Phase 3 database postcondition failed");
  }
  return value;
}

async function assertInstalledLocalDocker(ports) {
  if (ports.assertLocalDocker) {
    await ports.assertLocalDocker();
    return;
  }
  if (spawn("docker", ["context", "show"], { capture: true, contextProbe: true }) !== "default") {
    throw new Error("only the local default Docker context is allowed");
  }
}

export async function executeInstalledStagingPhase3Observation(input, ports = {}) {
  const binding = input?.context?.installedBinding;
  if (!binding || binding.stagingRunId !== input?.leases?.stagingRunId) {
    throw new Error("installed staging observation binding changed");
  }
  const capability = input.capability ?? (ports.loadCapability
    ? await ports.loadCapability(binding)
    : await loadInstalledStagingActionCapability(binding));
  await assertInstalledLocalDocker(ports);
  const database = ports.loadDatabase
    ? await ports.loadDatabase(capability)
    : await loadStagingDatabaseCredential(capability, "phase3-observer");
  const payload = buildStagingPhase3ObservationPayload({
    ...input,
    capability,
    database,
  });
  const result = ports.runDatabaseObservation
    ? await ports.runDatabaseObservation(payload, binding)
    : runDatabasePayload(payload, binding);
  try {
    assertObservationResult(result, {
      observationId: input.observationId,
      requiredTerminalActionId: input.requiredTerminalActionId,
      teamId: payload.teamId,
      epoch: payload.epoch,
      pollerNodeId: payload.pollerNodeId,
    });
    if (input.observationId === "phase3-schema-verify" && (
      result.measurements.candidateSchemaVersion !== payload.releaseContext.schema.max ||
      result.measurements.schemaMaximum !== payload.releaseContext.schema.max ||
      result.measurements.rollbackSchemaMinimum !== payload.releaseContext.rollbackSchema.min ||
      result.measurements.rollbackSchemaMaximum !== payload.releaseContext.rollbackSchema.max
    )) throw new Error("staging Phase 3 schema observation release range changed");
  } catch {
    throw new Error("staging Phase 3 observation postcondition failed");
  }
  return freezeClone(result);
}

const ACTION_MEASUREMENT_DATABASE_ACTIONS = new Set([
  "phase3-legacy-lease-release",
  "phase3-publication-enable",
  "phase3-publication-fence",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
]);
const ACTION_MEASUREMENT_DOCKER_ACTIONS = new Set([
  "phase3-consumer-start-disabled",
  "phase3-poller-start",
  "phase3-execution-enable",
  "phase3-inline-owner-restore",
]);
const ACTION_MEASUREMENT_RESULT_FIELDS = Object.freeze([
  "ok",
  "actionId",
  "teamId",
  "epoch",
  "generation",
  "measurements",
]);
const ACTION_MEASUREMENT_DB_FIELDS = Object.freeze({
  "phase3-legacy-lease-release": Object.freeze(["lease"]),
  "phase3-publication-enable": Object.freeze(["control"]),
  "phase3-publication-fence": Object.freeze(["control"]),
  "phase3-drain-or-quarantine": Object.freeze(["control", "drain"]),
  "phase3-inline-owner-restore": Object.freeze(["control", "drain", "lease"]),
});

function actionMeasurementTerminal(actionId, snapshot) {
  const matches = Array.isArray(snapshot?.actions)
    ? snapshot.actions.filter((entry) => entry?.actionId === actionId)
    : [];
  const terminal = matches.length === 1 ? matches[0] : null;
  if (
    !terminal ||
    terminal.kind !== "forward" ||
    terminal.state !== "succeeded" ||
    terminal.occurrences !== 1 ||
    terminal.reconciliationId !== null ||
    terminal.reconciliationOutcome !== null ||
    !HASH.test(terminal.mutationSha256 ?? "") ||
    !HASH.test(terminal.terminalRecordSha256 ?? "") ||
    terminal.terminalRecordSha256 !== snapshot?.headSha256 ||
    typeof terminal.completedAt !== "string"
  ) {
    throw new Error("the Phase 3 action is not the current ordinary succeeded terminal");
  }
  canonicalTimestamp(terminal.completedAt, "Phase 3 action completion timestamp");
  return terminal;
}

function actionMeasurementExpected(position, input) {
  return {
    position,
    journalSnapshot: input.journalSnapshot,
    installedBinding: input.installedBinding,
    approvalId: input.approvalId,
    rollbackReleaseManifestSha256: input.rollbackReleaseManifestSha256,
    leases: input.leases,
    partition: input.partition,
    nowMs: input.nowMs,
  };
}

function authenticatedMarkerGeneration(result, expectedId, label) {
  const marker = result?.value;
  const actualId = marker?.actionId ?? marker?.observationId;
  if (
    actualId !== expectedId ||
    !Number.isSafeInteger(marker?.generation) ||
    marker.generation <= 0
  ) throw new Error(`${label} generation is invalid`);
  return marker.generation;
}

function exactContainerIds(source) {
  if (typeof source !== "string") {
    throw new Error("fixed staging Phase 3 container list is invalid");
  }
  const ids = source.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID.test(id))) {
    throw new Error("fixed staging Phase 3 container identity is invalid");
  }
  return ids;
}

function fixedServiceForRole(partition, role) {
  if (role === "consumer") return partition.consumerService;
  if (role === "poller") return partition.pollerService;
  if (role === "inline") return partition.legacyService;
  throw new Error("fixed staging Phase 3 service role is invalid");
}

function environmentMap(environment) {
  if (!Array.isArray(environment) || environment.some((entry) => typeof entry !== "string")) {
    throw new Error("fixed staging Phase 3 container environment is invalid");
  }
  const result = new Map();
  for (const entry of environment) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("fixed staging Phase 3 container environment is invalid");
    const key = entry.slice(0, separator);
    if (result.has(key)) throw new Error("fixed staging Phase 3 container environment is duplicated");
    result.set(key, entry.slice(separator + 1));
  }
  return result;
}

function projectActionLabels(labels, service, binding) {
  const expected = {
    composeProject: "spx-staging",
    composeService: service,
    environment: "staging",
    releaseSha: binding.candidateSha,
    targetDescriptorSha256: binding.stagingTargetDescriptorSha256,
    operatorBundleSha256: binding.operatorBundleSha256,
    stagingRunId: binding.stagingRunId,
  };
  const actual = {
    composeProject: labels?.["com.docker.compose.project"],
    composeService: labels?.["com.docker.compose.service"],
    environment: labels?.["com.spx.environment"],
    releaseSha: labels?.["com.spx.release-sha"],
    targetDescriptorSha256: labels?.["com.spx.target-descriptor-sha256"],
    operatorBundleSha256: labels?.["com.spx.operator-bundle-sha256"],
    stagingRunId: labels?.["com.spx.staging-run-id"],
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("fixed staging Phase 3 container labels are invalid");
  }
  return expected;
}

function projectActionIdentity(identity, role, partition, binding, options = {}) {
  const service = fixedServiceForRole(partition, role);
  const nodeId = role === "consumer"
    ? partition.consumerNodeId
    : role === "poller"
      ? partition.pollerNodeId
      : partition.legacyNodeId;
  if (
    !hasExactFields(identity, [
      "status", "paused", "restarting", "health", "imageId", "labels", "environment",
    ]) ||
    identity.status !== "running" ||
    identity.paused !== false ||
    identity.restarting !== false ||
    identity.health !== "healthy" ||
    identity.imageId !== binding.imageDigest
  ) throw new Error("fixed staging Phase 3 container health or image identity is invalid");
  const environment = environmentMap(identity.environment);
  if (environment.get("SPX_NODE_ID") !== nodeId) {
    throw new Error("fixed staging Phase 3 container node identity is invalid");
  }
  const projected = {
    service,
    nodeId,
    status: "running",
    health: "healthy",
    imageId: binding.imageDigest,
    labels: projectActionLabels(identity.labels, service, binding),
  };
  if (options.inline === true) return projected;
  const expectedFlag = options.workerEnabled === true ? "true" : "false";
  if (
    environment.get("AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED") !== expectedFlag ||
    environment.get("AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED") !== expectedFlag
  ) throw new Error("fixed staging Phase 3 container worker flags are invalid");
  const workerProjection = {
    ...projected,
    realWorkerEnabled: options.workerEnabled === true,
    settlementWorkerEnabled: options.workerEnabled === true,
  };
  if (role !== "poller") return workerProjection;
  if (environment.get("AUTO_ACCEPT_JOB_CUTOVER_EPOCH") !== partition.epoch) {
    throw new Error("fixed staging Phase 3 poller cutover epoch is invalid");
  }
  return { ...workerProjection, cutoverEpoch: partition.epoch };
}

function projectStoppedActionIdentity(identity, role, partition, binding) {
  const service = fixedServiceForRole(partition, role);
  const nodeId = role === "consumer" ? partition.consumerNodeId : partition.pollerNodeId;
  if (
    !hasExactFields(identity, [
      "status", "paused", "restarting", "health", "imageId", "labels", "environment",
    ]) ||
    identity.status !== "exited" ||
    identity.paused !== false ||
    identity.restarting !== false ||
    identity.imageId !== binding.imageDigest
  ) throw new Error("fixed staging Phase 3 stopped container state or image identity is invalid");
  const environment = environmentMap(identity.environment);
  if (environment.get("SPX_NODE_ID") !== nodeId) {
    throw new Error("fixed staging Phase 3 stopped container node identity is invalid");
  }
  projectActionLabels(identity.labels, service, binding);
  return { service, nodeId, running: false };
}

function assertActionDatabaseResult(result, actionId, partition) {
  if (
    !hasExactFields(result, ACTION_MEASUREMENT_RESULT_FIELDS) ||
    result.ok !== true ||
    result.actionId !== actionId ||
    result.teamId !== partition.teamId ||
    result.epoch !== partition.epoch ||
    !hasExactFields(result.measurements, ACTION_MEASUREMENT_DB_FIELDS[actionId])
  ) throw new Error("staging Phase 3 action measurement result shape or binding is invalid");
  if (actionId === "phase3-legacy-lease-release") {
    if (result.generation !== null) {
      throw new Error("staging Phase 3 legacy lease measurement generation is invalid");
    }
  } else if (!Number.isSafeInteger(result.generation) || result.generation <= 0) {
    throw new Error("staging Phase 3 action measurement generation is invalid");
  }
  return result;
}

export async function captureInstalledPhase3ActionMeasurement(input, ports = {}) {
  if (
    !hasExactFields(input, ["actionId", "journalSnapshot", "leases"]) ||
    !PHASE3_ACTION_IDS.includes(input.actionId)
  ) throw new Error("fixed staging Phase 3 action measurement input is invalid");
  const loadApprovedContext = ports.loadApprovedContext ?? loadInstalledApprovedStagingContext;
  const context = await loadApprovedContext();
  const binding = context?.installedBinding;
  const approvalId = trustedApprovalId(context);
  const rollbackReleaseManifestSha256 = context?.verified?.rollbackReleaseManifestSha256;
  if (
    binding?.stagingRunId !== input.leases?.stagingRunId ||
    binding?.actionJournalHeadSha256 !== input.journalSnapshot?.headSha256 ||
    !HASH.test(rollbackReleaseManifestSha256 ?? "")
  ) throw new Error("installed staging Phase 3 action measurement binding changed");
  actionMeasurementTerminal(input.actionId, input.journalSnapshot);
  assertFreshContinuousLeases(input.leases, binding.stagingRunId);
  const now = ports.now ?? Date.now;
  const readNowMs = typeof now === "function" ? now() : Number.NaN;
  if (!Number.isSafeInteger(readNowMs) || readNowMs < 0) {
    throw new Error("trusted staging Phase 3 action measurement clock is invalid");
  }
  const loadCapability = ports.loadCapability ?? loadInstalledStagingActionCapability;
  const capability = await loadCapability(binding);
  const partition = phase3PartitionIdentity(
    capability?.phase3?.canaryTeamId,
    capability?.phase3?.canaryEpoch,
  );
  const expectedInput = {
    journalSnapshot: input.journalSnapshot,
    installedBinding: binding,
    approvalId,
    rollbackReleaseManifestSha256,
    leases: input.leases,
    partition,
    nowMs: readNowMs,
  };
  const historicalExpected = actionMeasurementExpected("historical", expectedInput);
  const readAction = ports.readActionMeasurement ?? readPhase3ActionMeasurement;
  const readObservation = ports.readObservationMarker ?? readPhase3ObservationMarker;
  let predecessorGeneration;
  if (["phase3-execution-enable", "phase3-publication-fence"].includes(input.actionId)) {
    predecessorGeneration = authenticatedMarkerGeneration(
      await readAction("phase3-publication-enable", historicalExpected),
      "phase3-publication-enable",
      "authenticated publication-enable marker",
    );
  } else if (["phase3-drain-or-quarantine", "phase3-inline-owner-restore"].includes(input.actionId)) {
    predecessorGeneration = authenticatedMarkerGeneration(
      await readObservation("phase3-fence-ack-wait", historicalExpected),
      "phase3-fence-ack-wait",
      "authenticated fence observation marker",
    );
  }

  await assertInstalledLocalDocker(ports);

  let databaseResult;
  if (ACTION_MEASUREMENT_DATABASE_ACTIONS.has(input.actionId)) {
    const loadObserverDatabase = ports.loadObserverDatabase ?? ((loadedCapability) =>
      loadStagingDatabaseCredential(loadedCapability, "phase3-observer"));
    const connection = await loadObserverDatabase(capability);
    const expectedGeneration = [
      "phase3-drain-or-quarantine",
      "phase3-inline-owner-restore",
    ].includes(input.actionId)
      ? predecessorGeneration
      : null;
    const payload = {
      schemaVersion: 1,
      actionId: input.actionId,
      teamId: partition.teamId,
      epoch: partition.epoch,
      expectedGeneration,
      connection,
    };
    const runMeasurement = ports.runDatabaseMeasurement ?? ((value) =>
      runDatabasePayload(value, binding));
    databaseResult = assertActionDatabaseResult(
      await runMeasurement(payload, binding),
      input.actionId,
      partition,
    );
    if (
      predecessorGeneration !== undefined &&
      databaseResult.generation !== predecessorGeneration
    ) throw new Error("staging Phase 3 action measurement generation changed");
  }

  let listFixedServiceContainerIds;
  let inspectFixedContainer;
  if (ACTION_MEASUREMENT_DOCKER_ACTIONS.has(input.actionId)) {
    if (ports.listFixedServiceContainerIds) {
      listFixedServiceContainerIds = ports.listFixedServiceContainerIds;
    } else {
      const operatorRoot = await loadInstalledStagingOperatorRoot(binding);
      const prefix = buildInstalledStagingComposePrefix(operatorRoot);
      const composeEnv = buildInstalledStagingComposeEnvironment(binding, operatorRoot);
      listFixedServiceContainerIds = (role) => runCompose([
        ...prefix,
        "ps",
        "--all",
        "-q",
        fixedServiceForRole(partition, role),
      ], composeEnv, true);
    }
    inspectFixedContainer = ports.inspectFixedContainer ?? inspectLocalContainer;
  }

  async function fixedServiceInventory(role) {
    const ids = exactContainerIds(await listFixedServiceContainerIds(role));
    const identities = await Promise.all(ids.map((id) => inspectFixedContainer(id)));
    return { ids, identities };
  }

  async function runningIdentity(role, options) {
    const inventory = await fixedServiceInventory(role);
    if (inventory.ids.length !== 1) {
      throw new Error("exactly one fixed staging Phase 3 running container is required");
    }
    return projectActionIdentity(
      inventory.identities[0],
      role,
      partition,
      binding,
      options,
    );
  }

  async function requireStopped(role) {
    const inventory = await fixedServiceInventory(role);
    if (inventory.ids.length !== 1) {
      throw new Error("exactly one fixed staging Phase 3 stopped container is required");
    }
    return projectStoppedActionIdentity(inventory.identities[0], role, partition, binding);
  }

  let generation = null;
  let measurements;
  if (input.actionId === "phase3-consumer-start-disabled") {
    measurements = { consumer: await runningIdentity("consumer", { workerEnabled: false }) };
  } else if (input.actionId === "phase3-legacy-lease-release") {
    measurements = databaseResult.measurements;
  } else if (input.actionId === "phase3-poller-start") {
    measurements = { poller: await runningIdentity("poller", { workerEnabled: false }) };
  } else if (input.actionId === "phase3-publication-enable") {
    generation = databaseResult.generation;
    measurements = databaseResult.measurements;
  } else if (input.actionId === "phase3-execution-enable") {
    generation = predecessorGeneration;
    measurements = { consumer: await runningIdentity("consumer", { workerEnabled: true }) };
  } else if (input.actionId === "phase3-publication-fence") {
    generation = databaseResult.generation;
    measurements = databaseResult.measurements;
  } else if (input.actionId === "phase3-drain-or-quarantine") {
    generation = databaseResult.generation;
    measurements = databaseResult.measurements;
  } else {
    generation = databaseResult.generation;
    measurements = {
      ...databaseResult.measurements,
      services: {
        poller: await requireStopped("poller"),
        consumer: await requireStopped("consumer"),
        inline: await runningIdentity("inline", { inline: true }),
      },
    };
  }
  const observedNowMs = now();
  if (!Number.isSafeInteger(observedNowMs) || observedNowMs < 0) {
    throw new Error("trusted staging Phase 3 action measurement clock is invalid");
  }
  const terminal = actionMeasurementTerminal(input.actionId, input.journalSnapshot);
  const marker = {
    schemaVersion: 1,
    actionId: input.actionId,
    mutationSha256: terminal.mutationSha256,
    terminalRecordSha256: terminal.terminalRecordSha256,
    completedAt: terminal.completedAt,
    observedAt: new Date(observedNowMs).toISOString(),
    releaseBinding: {
      candidateSha: binding.candidateSha,
      imageDigest: binding.imageDigest,
      releaseManifestSha256: binding.releaseManifestSha256,
      stagingTargetDescriptorSha256: binding.stagingTargetDescriptorSha256,
      operatorBundleSha256: binding.operatorBundleSha256,
      stagingApprovalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
      stagingRunId: binding.stagingRunId,
    },
    guardLeaseId: input.leases.guard.leaseId,
    watchdogLeaseId: input.leases.watchdog.leaseId,
    teamId: partition.teamId,
    epoch: partition.epoch,
    generation,
    measurements,
  };
  return validatePhase3ActionMeasurement(
    marker,
    actionMeasurementExpected("current", { ...expectedInput, nowMs: observedNowMs }),
  );
}

async function assertPrivateDirectory(path, mode) {
  const canonicalPath = resolve(path);
  const actualPath = resolve(await realpath(path));
  const matches = process.platform === "win32"
    ? canonicalPath.toLowerCase() === actualPath.toLowerCase()
    : canonicalPath === actualPath;
  const stat = await lstat(path, { bigint: true });
  if (!matches || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("staging Phase 3 observation evidence directory is invalid");
  }
  if (
    process.platform !== "win32" &&
    (Number(stat.mode & 0o777n) !== mode || Number(stat.uid) !== 0)
  ) {
    throw new Error("staging Phase 3 observation evidence directory is not root-private");
  }
}

async function assertPrivateEvidenceFile(path) {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("staging Phase 3 observation evidence file is invalid");
  }
  if (
    process.platform !== "win32" &&
    (Number(stat.mode & 0o777n) !== 0o600 || Number(stat.uid) !== 0)
  ) {
    throw new Error("staging Phase 3 observation evidence file is not root-private");
  }
}

export async function loadInstalledStagingPhase3ObservationEvidence(observationId) {
  await assertPrivateDirectory(OBSERVATION_EVIDENCE_ROOT, 0o700);
  const path = join(
    OBSERVATION_EVIDENCE_ROOT,
    observationEvidenceFilename(observationId),
  );
  await assertPrivateEvidenceFile(path);
  return readEvidenceJson(path, { requireCanonical: true, maxFileBytes: 16 * 1024 });
}

export async function executeStagingPhase3Transition(step, runtime) {
  if (!step || !TRUSTED_TRANSITION_STEPS.has(step)) {
    throw new Error("a fixed trusted staging Phase 3 transition is required");
  }
  const prefix = step.composePrefix;
  const executeCompose = runtime.runCompose ?? ((argv, capture = false) =>
    runCompose(argv, runtime.composeEnv, capture));
  const executeDatabase = runtime.runDatabaseTransition ?? ((currentStep, databaseAction) =>
    runDatabaseTransition(currentStep, runtime, databaseAction));
  if (step.transition === "consumer-start-disabled") {
    const configured = JSON.parse(await executeCompose([
      ...prefix, "-f", step.disabledOverlay, "--profile", "phase3", "config", "--format", "json",
    ], true));
    const environment = configured.services?.[step.consumerService]?.environment;
    if (
      environment?.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED !== "false" ||
      environment?.AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED !== "false"
    ) throw new Error("staging Phase 3 consumer is not disabled");
    await executeCompose([
      ...prefix, "-f", step.disabledOverlay, "--profile", "phase3", "up", "-d",
      "--no-deps", "--force-recreate", step.consumerService,
    ]);
  } else if (step.transition === "legacy-lease-release") {
    await executeCompose([...prefix, "stop", "--timeout", "120", step.legacyService]);
    await executeDatabase(step, step.transition);
  } else if (step.transition === "poller-start") {
    await executeCompose([
      ...prefix, "--profile", "phase3", "up", "-d", "--no-deps", step.pollerService,
    ]);
  } else if (step.transition === "execution-enable") {
    const binding = assertExecutionBinding(runtime.binding);
    const configured = JSON.parse(await executeCompose([
      ...prefix, "-f", step.enabledOverlay, "--profile", "phase3",
      "config", "--format", "json",
    ], true));
    const environment = configured.services?.[step.consumerService]?.environment;
    if (
      environment?.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED !== "true" ||
      environment?.AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED !== "true"
    ) throw new Error("staging Phase 3 execution worker flags are not enabled");
    await executeCompose([
      ...prefix, "-f", step.enabledOverlay, "--profile", "phase3", "up", "-d",
      "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "120",
      step.consumerService,
    ]);
    const containerId = exactContainerId(await executeCompose([
      ...prefix, "ps", "-q", step.consumerService,
    ], true));
    const identity = typeof runtime.inspectService === "function"
      ? await runtime.inspectService(containerId)
      : inspectLocalContainer(containerId);
    assertExecutionIdentity(identity, step, binding);
  } else if ([
    "publication-enable",
    "publication-fence",
    "drain-or-quarantine",
  ].includes(step.transition)) {
    await executeDatabase(step, step.transition);
  } else if (step.transition === "inline-owner-restore") {
    await executeDatabase(step, "inline-owner-restore-precheck");
    await executeCompose([
      ...prefix, "stop", "--timeout", "120", step.pollerService, step.consumerService,
    ]);
    await executeCompose([
      ...prefix, "--profile", "split", "up", "-d", "--no-deps", step.legacyService,
    ]);
    await executeDatabase(step, "inline-owner-restore");
  } else {
    throw new Error("unknown staging Phase 3 transition");
  }
  return { ok: true, transition: step.transition };
}

async function main() {
  try {
    const inherited = parseStagingPhase3Invocation(process.argv.slice(2));
    const context = await loadInstalledApprovedStagingContext();
    const binding = context.installedBinding;
    if (binding.stagingRunId !== inherited.stagingRunId) {
      throw new Error("installed staging run binding changed");
    }
    const operatorRoot = await loadInstalledStagingOperatorRoot(binding);
    const capability = await loadInstalledStagingActionCapability(binding);
    await assertInstalledLocalDocker({});
    const database = await loadStagingDatabaseCredential(capability, "phase3-control");
    const composeEnv = buildInstalledStagingComposeEnvironment(binding, operatorRoot);
    const result = await executeStagingPhase3Action(
      {
        inherited,
        capability,
        operatorRoot,
        binding,
        rollbackReleaseManifestSha256: context.verified.rollbackReleaseManifestSha256,
      },
      {
        loadLeases: loadStagingLeases,
        executeTransition: (step) => executeStagingPhase3Transition(
          step,
          { binding, database, composeEnv },
        ),
        loadObservationEvidence: loadInstalledStagingPhase3ObservationEvidence,
      },
    );
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch {
    process.stdout.write('{"failures":["STAGING_PHASE3_ACTION_REJECTED"],"ok":false}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("staging-phase3-action-handler.mjs")) {
  void main();
}
