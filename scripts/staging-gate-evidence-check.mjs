#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  canonicalJson,
  readEvidenceBytes,
  readEvidenceJson,
  validateReleaseBinding,
} from "./lib/evidence-artifact.mjs";
import {
  STAGING_GATE_ACTIONS as FIXED_STAGING_GATE_ACTIONS,
  STAGING_GATE_EVIDENCE_PATHS as FIXED_STAGING_GATE_EVIDENCE_PATHS,
  STAGING_GATE_PROOF_PATHS,
  PHASE3_GATE4_SOURCE_GRAPH,
  validateStagingGateProof,
} from "./lib/staging-gate-evidence.mjs";
import { loadStagingLeases } from "./lib/a3-staging-leases.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
  readPhase3ActionJournalSnapshot,
  readPhase3HistoricalActionMeasurementArtifacts,
  readPhase3HistoricalObservationMarkerArtifacts,
  readPhase3RuntimeSources,
  readPhase3SemanticEvidence,
} from "./lib/phase3-staging-evidence.mjs";
import {
  buildInstalledStagingComposePrefix,
  loadInstalledReleaseBinding,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";
import { verifyInstalledPhase3RolloutEvidence } from "./phase3-rollout-evidence-check.mjs";

const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60_000;
const ZERO_HASH = "0".repeat(64);
const CHECKER_PORT_NAMES = Object.freeze([
  "readProof",
  "readFixedPhase3SourceGraph",
  "verifyPhase3Semantic",
  "loadLeases",
]);
const IMMUTABLE_STAGING_RELEASE_FIELDS = Object.freeze([
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
const FIXED_PHASE3_SOURCE_IDS = Object.freeze([
  ...PHASE3_SEMANTIC_SOURCE_IDS,
  "phase3-semantic",
]);

export const STAGING_GATE_ACTIONS = FIXED_STAGING_GATE_ACTIONS;
const ACTIONS = new Map(STAGING_GATE_ACTIONS.map((action) => [action.actionId, action]));

export const STAGING_GATE_EVIDENCE_PATHS = FIXED_STAGING_GATE_EVIDENCE_PATHS;

export function buildStagingGateSemanticCommands(actionId, operatorRoot) {
  if (!ACTIONS.has(actionId)) throw new Error("fixed staging gate action is invalid");
  buildInstalledStagingComposePrefix(operatorRoot);
  const operatorScripts = `${operatorRoot}/scripts`;
  if (actionId === "staging-gate-2-worker") {
    return Object.freeze([Object.freeze([
      "/usr/bin/node",
      `${operatorScripts}/service-worker-evidence-check.mjs`,
      "--environment=staging",
      "--handoff-dir=/var/lib/spx-staging-rollout/evidence/worker-staging",
    ])]);
  }
  return Object.freeze([]);
}

function runSemanticCommands(actionId, operatorRoot) {
  for (const [executable, ...argv] of buildStagingGateSemanticCommands(actionId, operatorRoot)) {
    const result = spawnSync(executable, argv, {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5 * 60_000,
      maxBuffer: 512 * 1024,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error("fixed staging gate semantic evidence checker failed");
    }
    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new Error("fixed staging gate semantic evidence output is invalid");
    }
    if (output?.ok !== true) throw new Error("fixed staging gate semantic evidence was rejected");
  }
}

function exactKeys(value, keys) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()),
  );
}

function timestamp(value, nowMs) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed <= nowMs + MAX_FUTURE_SKEW_MS && nowMs - parsed <= MAX_EVIDENCE_AGE_MS;
}

function observationWithinCaptureSkew(observedAt, capturedAt) {
  return Date.parse(observedAt) <= Date.parse(capturedAt) + MAX_FUTURE_SKEW_MS;
}

function projectFixedSource(record) {
  return Object.freeze({
    value: record?.value,
    bytes: record?.bytes,
    sha256: record?.sha256,
  });
}

export async function readFixedPhase3SourceGraph(...callerArguments) {
  if (callerArguments.length !== 0) {
    throw new Error("fixed Phase 3 source graph reader accepts zero arguments");
  }
  const [snapshot, observations, actions, runtimeSources, semantic] = await Promise.all([
    readPhase3ActionJournalSnapshot(),
    readPhase3HistoricalObservationMarkerArtifacts(),
    readPhase3HistoricalActionMeasurementArtifacts(),
    readPhase3RuntimeSources(),
    readPhase3SemanticEvidence(),
  ]);
  if (!Array.isArray(actions) || actions.length !== PHASE3_ACTION_IDS.length) {
    throw new Error("fixed Phase 3 action source graph is incomplete");
  }
  const graph = {
    "phase3-journal-snapshot": projectFixedSource(snapshot),
    "phase3-schema-marker": projectFixedSource(observations?.schema),
    "phase3-fence-marker": projectFixedSource(observations?.fence),
  };
  for (const [index, actionId] of PHASE3_ACTION_IDS.entries()) {
    graph[`phase3-action:${actionId}`] = projectFixedSource(actions[index]);
  }
  for (const sourceId of [
    "db-final",
    "runtime-final",
    "lease-continuity",
    "capacity",
    "production-observer",
  ]) {
    graph[`phase3-${sourceId}`] = projectFixedSource(runtimeSources?.[sourceId]);
  }
  graph["phase3-semantic"] = projectFixedSource(semantic);
  if (canonicalJson(Object.keys(graph)) !== canonicalJson(FIXED_PHASE3_SOURCE_IDS)) {
    throw new Error("fixed Phase 3 source graph order changed");
  }
  return Object.freeze(graph);
}

export function parseStagingGateInvocation(argv, environment = process.env) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("fixed staging gate accepts zero caller arguments");
  }
  const action = ACTIONS.get(environment.SPX_STAGING_ACTION_ID);
  if (
    !action ||
    environment.SPX_STAGING_ACTION_SCOPE !== action.scope ||
    typeof environment.SPX_STAGING_RUN_ID !== "string" ||
    !RUN_ID.test(environment.SPX_STAGING_RUN_ID)
  ) {
    throw new Error("inherited fixed staging gate context is invalid");
  }
  return Object.freeze({ ...action, stagingRunId: environment.SPX_STAGING_RUN_ID });
}

function releaseBindingMatches(value, installedBinding, actionId) {
  validateReleaseBinding(value);
  validateReleaseBinding(installedBinding);
  if (actionId !== "staging-gate-4-phase3") {
    return canonicalJson(value) === canonicalJson(installedBinding);
  }
  return IMMUTABLE_STAGING_RELEASE_FIELDS.every((field) =>
    value[field] === installedBinding[field]);
}

export function validateStagingGateEvidence(value, installedBinding, actionId, options = {}) {
  const action = ACTIONS.get(actionId);
  const nowMs = options.nowMs ?? Date.now();
  if (!action || !exactKeys(value, [
    "schemaVersion",
    "actionId",
    "gate",
    "stagingRunId",
    "capturedAt",
    "releaseBinding",
    "proofs",
  ])) {
    throw new Error("durable staging gate evidence is invalid");
  }
  if (
    value.schemaVersion !== 1 ||
    value.actionId !== action.actionId ||
    value.gate !== action.gate ||
    value.stagingRunId !== installedBinding?.stagingRunId ||
    value.releaseBinding?.environment !== "staging" ||
    value.releaseBinding?.composeProject !== "spx-staging" ||
    !releaseBindingMatches(value.releaseBinding, installedBinding, actionId) ||
    !timestamp(value.capturedAt, nowMs)
  ) {
    throw new Error("durable staging gate release binding or staging identity is invalid");
  }
  if (
    !Array.isArray(value.proofs) ||
    value.proofs.length !== action.requiredProofs.length ||
    value.proofs.some((proof, index) =>
      !exactKeys(proof, ["name", "ok", "observedAt", "evidenceSha256"]) ||
      proof.name !== action.requiredProofs[index] ||
      proof.ok !== true ||
      !timestamp(proof.observedAt, nowMs) ||
      !HASH.test(proof.evidenceSha256 ?? "") ||
      /^0{64}$/.test(proof.evidenceSha256)
    )
  ) {
    throw new Error("durable staging gate proof coverage or evidence hash is invalid");
  }
  if (value.proofs.some((proof) =>
    !observationWithinCaptureSkew(proof.observedAt, value.capturedAt)
  )) {
    throw new Error("durable staging gate proof observation is after the allowed capture skew");
  }
  return { ok: true, actionId, proofCount: value.proofs.length };
}

function checkerPorts(callerArguments) {
  if (callerArguments.length === 0) {
    return Object.freeze({
      readProof: (actionId, name) => {
        const path = STAGING_GATE_PROOF_PATHS[actionId]?.[name];
        if (!path) throw new Error("fixed staging gate proof path is invalid");
        return readEvidenceBytes(path, { maxFileBytes: 512 * 1024 });
      },
      readFixedPhase3SourceGraph,
      verifyPhase3Semantic: (input) => verifyInstalledPhase3RolloutEvidence(input),
      loadLeases: (stagingRunId) => loadStagingLeases(stagingRunId),
    });
  }
  if (process.env.NODE_ENV !== "test" || callerArguments.length !== 1) {
    throw new Error("caller-selected staging gate checker ports are forbidden");
  }
  const ports = callerArguments[0];
  if (!exactKeys(ports, CHECKER_PORT_NAMES)) {
    throw new Error("staging gate checker ports must be the exact complete record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  if (CHECKER_PORT_NAMES.some((name) =>
    !descriptors[name] ||
    !Object.hasOwn(descriptors[name], "value") ||
    typeof descriptors[name].value !== "function"
  )) throw new Error("staging gate checker ports must be complete functions");
  return Object.freeze(Object.fromEntries(
    CHECKER_PORT_NAMES.map((name) => [name, descriptors[name].value]),
  ));
}

function normalizeFixedPhase3SourceGraph(value) {
  if (
    !exactKeys(value, FIXED_PHASE3_SOURCE_IDS) ||
    canonicalJson(Object.keys(value)) !== canonicalJson(FIXED_PHASE3_SOURCE_IDS)
  ) throw new Error("fixed Phase 3 source graph is incomplete or reordered");
  const normalized = {};
  for (const sourceId of FIXED_PHASE3_SOURCE_IDS) {
    const record = value[sourceId];
    if (!exactKeys(record, ["value", "bytes", "sha256"])) {
      throw new Error("fixed Phase 3 source record shape is invalid");
    }
    let canonical;
    try {
      canonical = canonicalJson(record.value);
    } catch {
      throw new Error("fixed Phase 3 source record is not canonical JSON");
    }
    if (
      typeof record.bytes !== "string" ||
      record.bytes !== canonical ||
      typeof record.sha256 !== "string" ||
      !HASH.test(record.sha256) ||
      record.sha256 === ZERO_HASH ||
      createHash("sha256").update(record.bytes).digest("hex") !== record.sha256
    ) throw new Error("fixed Phase 3 source bytes or hash changed");
    normalized[sourceId] = record;
  }
  return normalized;
}

function validateFinalGate4Leases(leases, stagingRunId, continuityAfter) {
  if (
    !leases ||
    leases.stagingRunId !== stagingRunId ||
    !Number.isFinite(leases.maxAgeMs) ||
    leases.maxAgeMs <= 0 ||
    !continuityAfter ||
    typeof continuityAfter !== "object"
  ) throw new Error("fresh Gate 4 lease continuity is invalid");
  for (const role of ["guard", "watchdog"]) {
    const live = leases[role];
    const expected = continuityAfter[role];
    const liveBaselineIsValid = role === "guard"
      ? typeof live?.baselineP95LatencyMs === "number" &&
        Number.isFinite(live.baselineP95LatencyMs) &&
        live.baselineP95LatencyMs > 0
      : live?.baselineP95LatencyMs === null ||
        (typeof live?.baselineP95LatencyMs === "number" &&
          Number.isFinite(live.baselineP95LatencyMs) &&
          live.baselineP95LatencyMs > 0);
    const expectedBaselineIsValid = role === "guard"
      ? typeof expected?.baselineP95LatencyMs === "number" &&
        Number.isFinite(expected.baselineP95LatencyMs) &&
        expected.baselineP95LatencyMs > 0
      : expected?.baselineP95LatencyMs === null ||
        (typeof expected?.baselineP95LatencyMs === "number" &&
          Number.isFinite(expected.baselineP95LatencyMs) &&
          expected.baselineP95LatencyMs > 0);
    if (
      !live ||
      !expected ||
      live.role !== role ||
      live.state !== "armed" ||
      live.stagingRunId !== stagingRunId ||
      !Number.isFinite(live.heartbeatAgeMs) ||
      live.heartbeatAgeMs < 0 ||
      live.heartbeatAgeMs > leases.maxAgeMs ||
      live.leaseId !== expected.leaseId ||
      live.pid !== expected.pid ||
      live.startedMonotonicMs !== expected.startedMonotonicMs ||
      !liveBaselineIsValid ||
      !expectedBaselineIsValid ||
      live.baselineP95LatencyMs !== expected.baselineP95LatencyMs ||
      !Number.isSafeInteger(live.heartbeatMonotonicMs) ||
      live.heartbeatMonotonicMs < expected.heartbeatMonotonicMs
    ) throw new Error(`fresh Gate 4 ${role} lease continuity changed`);
  }
  if (leases.guard.leaseId === leases.watchdog.leaseId) {
    throw new Error("Gate 4 guard and watchdog lease identities must be distinct");
  }
}

async function verifyStagingGateEvidenceInternal(
  value,
  installedBinding,
  actionId,
  historical,
  callerArguments,
) {
  const validationBinding = historical === true && actionId !== "staging-gate-4-phase3"
    ? {
        ...installedBinding,
        actionJournalHeadSha256: value?.releaseBinding?.actionJournalHeadSha256,
      }
    : installedBinding;
  const result = validateStagingGateEvidence(value, validationBinding, actionId);
  const ports = checkerPorts(callerArguments);
  const validatedProofs = [];
  for (const proof of value.proofs) {
    const bytes = await ports.readProof(actionId, proof.name);
    if (
      !Buffer.isBuffer(bytes) ||
      createHash("sha256").update(bytes).digest("hex") !== proof.evidenceSha256
    ) {
      throw new Error("durable staging gate proof content hash changed");
    }
    let proofValue;
    let proofText;
    try {
      proofText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      proofValue = JSON.parse(proofText);
    } catch {
      throw new Error("durable staging gate proof is not valid canonical JSON");
    }
    if (proofText !== canonicalJson(proofValue)) {
      throw new Error("durable staging gate proof is not canonical JSON");
    }
    const validatedProof = validateStagingGateProof(
      proofValue,
      validationBinding,
      actionId,
      proof.name,
    );
    if (validatedProof.observedAt !== proof.observedAt) {
      throw new Error("durable staging gate proof observation does not match the aggregate");
    }
    if (canonicalJson(validatedProof.releaseBinding) !== canonicalJson(value.releaseBinding)) {
      throw new Error("durable staging gate proof historical binding differs from the aggregate");
    }
    validatedProofs.push(validatedProof);
  }
  if (actionId !== "staging-gate-4-phase3") return result;

  const sourceGraph = normalizeFixedPhase3SourceGraph(
    await ports.readFixedPhase3SourceGraph(),
  );
  const historicalSnapshotHead =
    sourceGraph["phase3-journal-snapshot"].value?.headSha256;
  if (
    typeof historicalSnapshotHead !== "string" ||
    !HASH.test(historicalSnapshotHead) ||
    historicalSnapshotHead === ZERO_HASH ||
    value.releaseBinding.actionJournalHeadSha256 !== historicalSnapshotHead
  ) {
    throw new Error(
      "Gate 4 historical release binding does not match the authenticated snapshot head",
    );
  }
  const covered = new Set();
  for (const proof of validatedProofs) {
    const expectedIds = PHASE3_GATE4_SOURCE_GRAPH[proof.proofName];
    for (const [index, source] of proof.sourceEvidence.entries()) {
      if (
        source.id !== expectedIds[index] ||
        source.sha256 !== sourceGraph[source.id].sha256
      ) throw new Error("Gate 4 proof source content hash changed");
      covered.add(source.id);
    }
  }
  covered.delete("phase3-semantic");
  if (
    covered.size !== PHASE3_SEMANTIC_SOURCE_IDS.length ||
    PHASE3_SEMANTIC_SOURCE_IDS.some((sourceId) => !covered.has(sourceId))
  ) throw new Error("Gate 4 proof source graph orphaned a Task 4 source");

  const semanticResult = await ports.verifyPhase3Semantic({
    expectedSemanticSha256: sourceGraph["phase3-semantic"].sha256,
  });
  if (semanticResult?.ok !== true) {
    throw new Error("fixed Gate 4 Phase 3 semantic evidence was rejected");
  }
  const continuityAfter =
    sourceGraph["phase3-lease-continuity"].value?.continuity?.after;
  if (historical !== true) {
    const leases = await ports.loadLeases(value.releaseBinding.stagingRunId);
    validateFinalGate4Leases(
      leases,
      value.releaseBinding.stagingRunId,
      continuityAfter,
    );
  }
  return result;
}

export async function verifyStagingGateEvidence(
  value,
  installedBinding,
  actionId,
  ...callerArguments
) {
  return verifyStagingGateEvidenceInternal(
    value,
    installedBinding,
    actionId,
    false,
    callerArguments,
  );
}

export async function verifyHistoricalStagingGateEvidence(
  value,
  installedBinding,
  actionId,
  ...callerArguments
) {
  return verifyStagingGateEvidenceInternal(
    value,
    installedBinding,
    actionId,
    true,
    callerArguments,
  );
}

async function main() {
  try {
    const inherited = parseStagingGateInvocation(process.argv.slice(2));
    const binding = await loadInstalledReleaseBinding({ environment: "staging" });
    const operatorRoot = await loadInstalledStagingOperatorRoot(binding);
    if (binding.stagingRunId !== inherited.stagingRunId) {
      throw new Error("installed staging run binding changed");
    }
    const evidence = await readEvidenceJson(STAGING_GATE_EVIDENCE_PATHS[inherited.actionId], {
      requireCanonical: true,
      maxFileBytes: 512 * 1024,
    });
    const result = await verifyStagingGateEvidence(evidence, binding, inherited.actionId);
    runSemanticCommands(inherited.actionId, operatorRoot);
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch {
    process.stdout.write(`${canonicalJson({ ok: false, failures: ["STAGING_GATE_EVIDENCE_REJECTED"] })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("staging-gate-evidence-check.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
