import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  readEvidenceBundle,
  readEvidenceBytes,
  readEvidenceJson,
  sha256Canonical,
  validateReleaseBinding,
} from "./lib/evidence-artifact.mjs";
import { readAuthenticatedStagingActionJournalSnapshot } from "./lib/staging-action-ledger.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "./lib/staging-action-plan.mjs";
import {
  readPhase3ActionJournalSnapshot,
  readPhase3SemanticEvidence,
} from "./lib/phase3-staging-evidence.mjs";
import { loadInstalledReleaseBinding } from "./lib/staging-installed-context.mjs";
import { STAGING_GATE_PROOF_PATHS } from "./lib/staging-gate-evidence.mjs";
import {
  SERVICE_FAULT_EVIDENCE_MANIFEST,
  evaluateServiceFaultEvidence,
} from "./service-fault-evidence-check.mjs";
import {
  SERVICE_WORKER_EVIDENCE_MANIFEST,
  evaluateServiceWorkerEvidence,
} from "./service-worker-evidence-check.mjs";
import { verifyInstalledPhase3RolloutEvidence } from "./phase3-rollout-evidence-check.mjs";
import { evaluateNMinusOneEvidence } from "./phase4-n-minus-one-evidence-check.mjs";
import { evaluatePhase4Evidence } from "./phase4-rollout-evidence-check.mjs";
import {
  STAGING_GATE_ACTIONS,
  STAGING_GATE_EVIDENCE_PATHS,
  verifyHistoricalStagingGateEvidence,
} from "./staging-gate-evidence-check.mjs";

const INPUT_KEYS = ["releaseBinding", "gateEvidence", "stagingBundles", "guardClosed", "producer"];
const STAGING_RELEASE_BINDING_KEYS = [
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "environment",
  "topology",
  "composeProject",
  "operatorBundleSha256",
  "stagingTargetDescriptorSha256",
  "stagingApprovalEnvelopeSha256",
  "actionJournalHeadSha256",
  "stagingRunId",
];
const PRODUCTION_RELEASE_BINDING_KEYS = [
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "environment",
  "topology",
  "composeProject",
  "operatorBundleSha256",
  "targetDescriptorSha256",
  "productionIdentityApprovalSha256",
];
const GATE_KEYS = ["gate1", "gate2", "gate3", "gate4"];
const BUNDLE_KEYS = ["task9", "worker", "phase3", "phase4", "nMinusOne"];
const DIGEST_SOURCE_KEYS = ["sourceSha256", "checkerSha256"];
const PRODUCER_KEYS = [
  "repository",
  "environment",
  "workflow",
  "workflowSha",
  "workflowFileSha256",
];
const NONZERO_SHA256_PATTERN = /^(?!0{64}$)[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SECRET_VALUE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
];
const MAX_CANONICAL_OUTPUT_BYTES = 1024 * 1024;

export const STAGING_PROTECTED_EVIDENCE_FILENAME = "staging-protected-evidence.json";
export const STAGING_PROTECTED_EVIDENCE_ROOT = "/var/lib/spx-staging-rollout/evidence";
export const STAGING_PROTECTED_EVIDENCE_PRODUCER_CONTEXT =
  "/var/lib/spx-staging-rollout/protected-evidence-producer-context.json";

const INSTALLED_PORT_NAMES = [
  "loadReleaseBinding",
  "loadProducerContext",
  "readGateEvidence",
  "readTask9Evidence",
  "readWorkerEvidence",
  "readPhase3Evidence",
  "readPhase4Evidence",
  "readNMinusOneEvidence",
  "readActionJournal",
  "writeArtifact",
];
const NORMALIZED_SOURCE_KEYS = ["sourceSha256", "checkerSha256", "releaseBindingHeads"];
const NORMALIZED_PHASE4_SOURCE_KEYS = [...NORMALIZED_SOURCE_KEYS, "guardClosed"];
const JOURNAL_RESULT_KEYS = ["headSha256", "acceptedHistoricalHeads"];
const FORBIDDEN_PATH_OVERRIDE_ENV = [
  "SPX_STAGING_PROTECTED_EVIDENCE_ROOT",
  "SPX_STAGING_PROTECTED_EVIDENCE_PATH",
  "SPX_STAGING_PROTECTED_EVIDENCE_CONTEXT",
  "SPX_TASK9_EVIDENCE_ROOT",
];
const STAGING_ROLLOUT_ROOT = "/var/lib/spx-staging-rollout";
const TASK9_EVIDENCE_ROOT = `${STAGING_ROLLOUT_ROOT}/task9-evidence`;
const WORKER_EVIDENCE_DIRECTORY = `${STAGING_PROTECTED_EVIDENCE_ROOT}/worker-staging`;
const PHASE4_EVIDENCE_DIRECTORY = `${STAGING_PROTECTED_EVIDENCE_ROOT}/phase4-staging`;
const N_MINUS_ONE_EVIDENCE_DIRECTORY = `${STAGING_PROTECTED_EVIDENCE_ROOT}/phase4-n-minus-one-staging`;
const DRILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HISTORICAL_RELEASE_FIELDS = [
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "environment",
  "topology",
  "composeProject",
  "operatorBundleSha256",
  "stagingTargetDescriptorSha256",
  "stagingApprovalEnvelopeSha256",
  "stagingRunId",
];

function assertExactEnumerableRecord(label, value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  ) {
    throw new Error(`${label} must contain exactly the required fields`);
  }
}

function normalizeInstalledSource(label, value, phase4 = false) {
  assertExactEnumerableRecord(
    label,
    value,
    phase4 ? NORMALIZED_PHASE4_SOURCE_KEYS : NORMALIZED_SOURCE_KEYS,
  );
  requireSha256(`${label} source hash`, value.sourceSha256);
  requireSha256(`${label} checker hash`, value.checkerSha256);
  if (
    !Array.isArray(value.releaseBindingHeads) ||
    value.releaseBindingHeads.length === 0 ||
    value.releaseBindingHeads.some((head) => !NONZERO_SHA256_PATTERN.test(head))
  ) {
    throw new Error(`${label} release binding heads are invalid`);
  }
  if (new Set(value.releaseBindingHeads).size !== value.releaseBindingHeads.length) {
    throw new Error(`${label} release binding heads are duplicated`);
  }
  if (phase4 && value.guardClosed !== true) {
    throw new Error("installed Phase 4 evidence did not close the staging guard");
  }
  return value;
}

function resolveInstalledExportInvocation(options) {
  if (FORBIDDEN_PATH_OVERRIDE_ENV.some((name) => Object.hasOwn(process.env, name))) {
    throw new Error("protected-evidence path overrides are forbidden");
  }
  const keys = Object.keys(options);
  if (keys.length === 0) return { now: new Date(), ports: defaultInstalledPorts() };
  if (
    process.env.NODE_ENV !== "test" ||
    canonicalJson(keys.sort()) !== canonicalJson(["now", "ports"])
  ) {
    throw new Error("installed protected-evidence export accepts no caller-selected options");
  }
  assertExactEnumerableRecord(
    "installed protected-evidence ports",
    options.ports,
    INSTALLED_PORT_NAMES,
  );
  for (const name of INSTALLED_PORT_NAMES) {
    if (typeof options.ports[name] !== "function") {
      throw new Error("installed protected-evidence ports must be functions");
    }
  }
  return { now: options.now, ports: options.ports };
}

export async function exportInstalledStagingProtectedEvidence(options = {}) {
  const { now, ports } = resolveInstalledExportInvocation(options);
  const releaseBinding = await ports.loadReleaseBinding();
  validateReleaseBinding(releaseBinding);
  if (releaseBinding.environment !== "staging") {
    throw new Error("installed protected-evidence export requires a staging release binding");
  }

  const [producer, gates, task9, worker, phase3, phase4, nMinusOne, journal] = await Promise.all([
    ports.loadProducerContext(releaseBinding),
    ports.readGateEvidence(releaseBinding),
    ports.readTask9Evidence(releaseBinding),
    ports.readWorkerEvidence(releaseBinding),
    ports.readPhase3Evidence(releaseBinding),
    ports.readPhase4Evidence(releaseBinding),
    ports.readNMinusOneEvidence(releaseBinding),
    ports.readActionJournal(releaseBinding),
  ]);

  assertExactEnumerableRecord("installed gate evidence", gates, GATE_KEYS);
  const normalizedGates = Object.fromEntries(
    GATE_KEYS.map((gate) => [gate, normalizeInstalledSource(`installed ${gate}`, gates[gate])]),
  );
  const normalizedSources = {
    task9: normalizeInstalledSource("installed Task 9 evidence", task9),
    worker: normalizeInstalledSource("installed worker evidence", worker),
    phase3: normalizeInstalledSource("installed Phase 3 evidence", phase3),
    phase4: normalizeInstalledSource("installed Phase 4 evidence", phase4, true),
    nMinusOne: normalizeInstalledSource("installed N-1 evidence", nMinusOne),
  };
  assertExactEnumerableRecord("installed action journal result", journal, JOURNAL_RESULT_KEYS);
  requireSha256("installed action journal head", journal.headSha256);
  if (journal.headSha256 !== releaseBinding.actionJournalHeadSha256) {
    throw new Error("installed release binding does not match the terminal action journal head");
  }
  if (!Array.isArray(journal.acceptedHistoricalHeads)) {
    throw new Error("installed action journal historical heads are invalid");
  }
  const acceptedHeads = new Set(journal.acceptedHistoricalHeads);
  acceptedHeads.add(journal.headSha256);
  for (const source of [...Object.values(normalizedGates), ...Object.values(normalizedSources)]) {
    for (const head of source.releaseBindingHeads) {
      if (!acceptedHeads.has(head)) {
        throw new Error(
          "installed evidence release binding head is outside the authenticated journal",
        );
      }
    }
  }

  const evidence = buildStagingProtectedEvidence(
    {
      releaseBinding,
      gateEvidence: Object.fromEntries(
        GATE_KEYS.map((gate) => [
          gate,
          {
            sourceSha256: normalizedGates[gate].sourceSha256,
            checkerSha256: normalizedGates[gate].checkerSha256,
          },
        ]),
      ),
      stagingBundles: Object.fromEntries(
        BUNDLE_KEYS.map((bundle) => [
          bundle,
          {
            sourceSha256: normalizedSources[bundle].sourceSha256,
            checkerSha256: normalizedSources[bundle].checkerSha256,
          },
        ]),
      ),
      guardClosed: true,
      producer,
    },
    { now },
  );
  const bytes = canonicalJson(evidence);
  const path = await ports.writeArtifact(STAGING_PROTECTED_EVIDENCE_FILENAME, bytes);
  return Object.freeze({ path, evidence });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactJsonRecord(label, value, expectedKeys) {
  const invalidRecord = () =>
    new Error(
      `${label} must be an exact JSON record containing exactly the required enumerable data properties`,
    );
  if (!isPlainObject(value)) throw invalidRecord();
  const actualKeys = Reflect.ownKeys(value);
  const expectedKeySets = Array.isArray(expectedKeys[0]) ? expectedKeys : [expectedKeys];
  const matchingExpectedKeys = expectedKeySets.find(
    (keys) => actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key)),
  );
  if (actualKeys.some((key) => typeof key !== "string") || matchingExpectedKeys === undefined) {
    throw invalidRecord();
  }
  for (const key of matchingExpectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw invalidRecord();
    }
  }
}

function dataPropertyValue(record, key) {
  return Object.getOwnPropertyDescriptor(record, key).value;
}

function assertNormalizedInputRecords(input) {
  assertExactJsonRecord("protected evidence input", input, INPUT_KEYS);

  const releaseBinding = dataPropertyValue(input, "releaseBinding");
  assertExactJsonRecord("release binding", releaseBinding, [
    STAGING_RELEASE_BINDING_KEYS,
    PRODUCTION_RELEASE_BINDING_KEYS,
  ]);

  const gateEvidence = dataPropertyValue(input, "gateEvidence");
  assertExactJsonRecord("gateEvidence", gateEvidence, GATE_KEYS);
  for (const gate of GATE_KEYS) {
    assertExactJsonRecord(
      `gateEvidence.${gate}`,
      dataPropertyValue(gateEvidence, gate),
      DIGEST_SOURCE_KEYS,
    );
  }

  const stagingBundles = dataPropertyValue(input, "stagingBundles");
  assertExactJsonRecord("stagingBundles", stagingBundles, BUNDLE_KEYS);
  for (const bundle of BUNDLE_KEYS) {
    assertExactJsonRecord(
      `stagingBundles.${bundle}`,
      dataPropertyValue(stagingBundles, bundle),
      DIGEST_SOURCE_KEYS,
    );
  }

  assertExactJsonRecord("producer", dataPropertyValue(input, "producer"), PRODUCER_KEYS);
}

function assertNoSecretShapedContent(value, seen = new Set()) {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error("protected evidence input contains secret-shaped content");
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object" || seen.has(value)) {
    throw new Error("protected evidence input must be acyclic JSON-compatible data");
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error("protected evidence input contains a non-JSON property key");
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error("protected evidence input contains a secret-shaped field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new Error("protected evidence input contains a non-JSON accessor property");
    }
    assertNoSecretShapedContent(descriptor.value, seen);
  }
  seen.delete(value);
}

function requireSha256(label, value) {
  if (typeof value !== "string" || !NONZERO_SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a nonzero lowercase SHA-256`);
  }
}

function validateDigestSources(label, value) {
  requireSha256(`${label} sourceSha256`, value.sourceSha256);
  requireSha256(`${label} checkerSha256`, value.checkerSha256);
}

function validateInput(input) {
  assertNormalizedInputRecords(input);
  assertNoSecretShapedContent(input);

  validateReleaseBinding(input.releaseBinding);
  if (input.releaseBinding.environment !== "staging") {
    throw new Error("protected evidence requires a staging release binding");
  }
  requireSha256("image digest", input.releaseBinding.imageDigest.slice("sha256:".length));
  for (const field of [
    "releaseManifestSha256",
    "stagingTargetDescriptorSha256",
    "operatorBundleSha256",
    "stagingApprovalEnvelopeSha256",
    "actionJournalHeadSha256",
  ]) {
    requireSha256(`release binding ${field}`, input.releaseBinding[field]);
  }

  for (const gate of GATE_KEYS) {
    validateDigestSources(`gateEvidence.${gate}`, input.gateEvidence[gate]);
  }

  for (const bundle of BUNDLE_KEYS) {
    validateDigestSources(`stagingBundles.${bundle}`, input.stagingBundles[bundle]);
  }

  if (input.guardClosed !== true) throw new Error("guardClosed must be true");

  if (input.producer.repository !== "fastest4u/SPX") {
    throw new Error("producer repository must be fastest4u/SPX");
  }
  if (input.producer.environment !== "staging") {
    throw new Error("producer environment must be staging");
  }
  if (input.producer.workflow !== ".github/workflows/trusted-staging-protected-evidence.yml") {
    throw new Error("producer workflow must be the trusted protected-evidence workflow");
  }
  if (
    typeof input.producer.workflowSha !== "string" ||
    !COMMIT_SHA_PATTERN.test(input.producer.workflowSha)
  ) {
    throw new Error("producer workflow SHA must be a lowercase 40-character SHA");
  }
  requireSha256("producer workflowFileSha256", input.producer.workflowFileSha256);
}

function resolveCapturedAt(now) {
  if (!(now instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(now))) {
    throw new Error("capture time must be a valid Date");
  }
  try {
    return now.toISOString();
  } catch {
    throw new Error("capture time must be a valid Date");
  }
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}

function evidenceDigest(kind, releaseBindingSha256, evidence) {
  return sha256Canonical({
    schemaVersion: 1,
    kind,
    releaseBindingSha256,
    sourceSha256: evidence.sourceSha256,
    checkerSha256: evidence.checkerSha256,
  });
}

export function buildStagingProtectedEvidence(input, options = {}) {
  validateInput(input);
  const now = options.now ?? new Date();
  const capturedAt = resolveCapturedAt(now);
  const { releaseBinding, gateEvidence, stagingBundles } = input;
  const releaseBindingSha256 = sha256Canonical(releaseBinding);
  const phase4Sha256 = evidenceDigest("phase4", releaseBindingSha256, stagingBundles.phase4);
  const nMinusOneSha256 = evidenceDigest(
    "n-minus-one",
    releaseBindingSha256,
    stagingBundles.nMinusOne,
  );

  const output = {
    schemaVersion: 1,
    candidateSha: releaseBinding.candidateSha,
    imageDigest: releaseBinding.imageDigest,
    releaseManifestSha256: releaseBinding.releaseManifestSha256,
    stagingTargetDescriptorSha256: releaseBinding.stagingTargetDescriptorSha256,
    operatorBundleSha256: releaseBinding.operatorBundleSha256,
    stagingApprovalEnvelopeSha256: releaseBinding.stagingApprovalEnvelopeSha256,
    stagingRunId: releaseBinding.stagingRunId,
    composeProject: releaseBinding.composeProject,
    gateEvidenceSha256: {
      gate1: evidenceDigest("gate-1", releaseBindingSha256, gateEvidence.gate1),
      gate2: evidenceDigest("gate-2", releaseBindingSha256, gateEvidence.gate2),
      gate3: evidenceDigest("gate-3", releaseBindingSha256, gateEvidence.gate3),
      gate4: evidenceDigest("gate-4", releaseBindingSha256, gateEvidence.gate4),
      gate5: sha256Canonical({
        schemaVersion: 1,
        kind: "gate-5",
        releaseBindingSha256,
        phase4Sha256,
        nMinusOneSha256,
      }),
    },
    stagingBundles: {
      task9Sha256: evidenceDigest("task9", releaseBindingSha256, stagingBundles.task9),
      workerSha256: evidenceDigest("worker", releaseBindingSha256, stagingBundles.worker),
      phase3Sha256: evidenceDigest("phase3", releaseBindingSha256, stagingBundles.phase3),
      phase4Sha256,
      nMinusOneSha256,
    },
    actionJournalHeadSha256: releaseBinding.actionJournalHeadSha256,
    guardClosed: true,
    capturedAt,
    producer: {
      repository: input.producer.repository,
      environment: input.producer.environment,
      workflow: input.producer.workflow,
      workflowSha: input.producer.workflowSha,
      workflowFileSha256: input.producer.workflowFileSha256,
    },
  };

  if (Buffer.byteLength(canonicalJson(output), "utf8") > MAX_CANONICAL_OUTPUT_BYTES) {
    throw new Error("protected evidence canonical output exceeds one MiB");
  }
  if (capturedAt !== Date.prototype.toISOString.call(now)) {
    throw new Error("capture time must serialize as the Date's canonical ISO timestamp");
  }
  return deepFreeze(output);
}

function hashCheckerResult(label, result) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} checker rejected the installed evidence`);
  }
  return sha256Canonical(result);
}

function historicalBindingMatches(value, current) {
  validateReleaseBinding(value);
  return HISTORICAL_RELEASE_FIELDS.every((field) => value[field] === current[field]);
}

function requireHistoricalBinding(label, value, current) {
  if (!historicalBindingMatches(value, current)) {
    throw new Error(`${label} release binding does not match the installed staging release`);
  }
  return value.actionJournalHeadSha256;
}

function sameResolvedPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertTestPathBoundary(path, security) {
  if (security === undefined) return;
  if (
    process.env.NODE_ENV !== "test" ||
    security === null ||
    typeof security !== "object" ||
    Object.keys(security).length !== 1 ||
    typeof security.testRoot !== "string"
  ) {
    throw new Error("installed protected-evidence path security override is forbidden");
  }
  const root = resolve(security.testRoot);
  const candidate = resolve(path);
  const suffix = relative(root, candidate);
  if (suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new Error("installed protected-evidence test path escaped its temporary root");
  }
}

async function assertRootOwnedPath(path, kind, label, security = undefined) {
  assertTestPathBoundary(path, security);
  const resolved = resolve(path);
  const actual = resolve(await realpath(path));
  assertTestPathBoundary(actual, security);
  if (!sameResolvedPath(resolved, actual)) throw new Error(`${label} must not contain a symlink`);
  const status = await lstat(path, { bigint: true });
  const expectedKind = kind === "directory" ? status.isDirectory() : status.isFile();
  if (status.isSymbolicLink() || !expectedKind) {
    throw new Error(`${label} must be a regular ${kind}`);
  }
  if (
    security === undefined &&
    (Number(status.uid) !== 0 || (Number(status.mode & 0o777n) & 0o022) !== 0)
  ) {
    throw new Error(`${label} must be root-owned and not group/world writable`);
  }
  return status;
}

async function readRootOwnedCanonicalJson(
  path,
  label,
  maximumBytes = 64 * 1024,
  security = undefined,
) {
  await assertRootOwnedPath(dirname(path), "directory", `${label} parent`, security);
  await assertRootOwnedPath(path, "file", label, security);
  return readEvidenceJson(path, { requireCanonical: true, maxFileBytes: maximumBytes });
}

async function readRootOwnedBundle(directory, manifest, label, security = undefined) {
  const names = Object.keys(manifest);
  await assertRootOwnedPath(directory, "directory", label, security);
  for (const name of names) {
    await assertRootOwnedPath(join(directory, name), "file", `${label} file`, security);
  }
  const bundle = await readEvidenceBundle(directory, {
    allowedNames: names,
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
    rejectSecrets: false,
  });
  assertNoInstalledSourceSecrets(bundle);
  return bundle;
}

function assertNoInstalledSourceSecrets(value, seen = new Set()) {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error("installed evidence bundle contains secret-shaped content");
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object" || seen.has(value)) {
    throw new Error("installed evidence bundle must be acyclic JSON-compatible data");
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof child !== "boolean") {
      throw new Error("installed evidence bundle contains a secret-shaped field");
    }
    assertNoInstalledSourceSecrets(child, seen);
  }
  seen.delete(value);
}

async function assertExactDirectoryEntries(
  directory,
  expectedFiles,
  expectedDirectories,
  label,
  security = undefined,
) {
  await assertRootOwnedPath(directory, "directory", label, security);
  const entries = await readdir(directory, { withFileTypes: true });
  const expected = new Map([
    ...expectedFiles.map((name) => [name, "file"]),
    ...expectedDirectories.map((name) => [name, "directory"]),
  ]);
  if (entries.length !== expected.size) {
    throw new Error(`${label} contains an unexpected or missing entry`);
  }
  for (const entry of entries) {
    const kind = expected.get(entry.name);
    if (
      !kind ||
      entry.isSymbolicLink() ||
      (kind === "file" ? !entry.isFile() : !entry.isDirectory())
    ) {
      throw new Error(`${label} contains an unexpected entry type`);
    }
    await assertRootOwnedPath(join(directory, entry.name), kind, `${label} entry`, security);
  }
}

function installedBoundaryPath(boundary, fixedPath) {
  return boundary === undefined ? fixedPath : boundary.mapPath(fixedPath);
}

function installedBoundarySecurity(boundary) {
  return boundary?.security;
}

async function assertInstalledGateLayout(boundary = undefined) {
  const root = dirname(
    installedBoundaryPath(
      boundary,
      STAGING_GATE_EVIDENCE_PATHS[STAGING_GATE_ACTIONS[0].actionId],
    ),
  );
  const security = installedBoundarySecurity(boundary);
  await assertExactDirectoryEntries(
    root,
    STAGING_GATE_ACTIONS.map((action) => basename(STAGING_GATE_EVIDENCE_PATHS[action.actionId])),
    ["proofs"],
    "staging gate evidence root",
    security,
  );
  const proofsRoot = join(root, "proofs");
  await assertExactDirectoryEntries(
    proofsRoot,
    [],
    STAGING_GATE_ACTIONS.map((action) => action.actionId),
    "staging gate proof root",
    security,
  );
  for (const action of STAGING_GATE_ACTIONS) {
    const directory = join(proofsRoot, action.actionId);
    await assertExactDirectoryEntries(
      directory,
      Object.values(STAGING_GATE_PROOF_PATHS[action.actionId]).map((path) => basename(path)),
      [],
      `staging gate proof directory ${action.actionId}`,
      security,
    );
  }
}

function assemblePayloadBundle(bundle, manifest, currentBinding, label) {
  assertExactEnumerableRecord(label, bundle, Object.keys(manifest));
  let commonBinding;
  const evidence = Object.create(null);
  for (const [filename, key] of Object.entries(manifest)) {
    const wrapper = bundle[filename];
    assertExactEnumerableRecord(`${label} ${filename}`, wrapper, ["payload", "releaseBinding"]);
    validateReleaseBinding(wrapper.releaseBinding);
    if (
      commonBinding !== undefined &&
      canonicalJson(wrapper.releaseBinding) !== canonicalJson(commonBinding)
    ) {
      throw new Error(`${label} files do not share one exact release binding`);
    }
    commonBinding ??= wrapper.releaseBinding;
    if (key === "drillMetadata") {
      if (
        !wrapper.payload ||
        typeof wrapper.payload !== "object" ||
        Array.isArray(wrapper.payload)
      ) {
        throw new Error(`${label} drill metadata is invalid`);
      }
      Object.assign(evidence, wrapper.payload);
    } else {
      evidence[key] = wrapper.payload;
    }
  }
  return {
    evidence,
    binding: commonBinding,
    matchesCurrentRelease: historicalBindingMatches(commonBinding, currentBinding),
    sourceSha256: sha256Canonical(bundle),
  };
}

function singleEvidenceBundle(bundle, filename, currentBinding, label) {
  assertExactEnumerableRecord(label, bundle, [filename]);
  const wrapper = bundle[filename];
  assertExactEnumerableRecord(`${label} wrapper`, wrapper, ["evidence", "releaseBinding"]);
  const head = requireHistoricalBinding(label, wrapper.releaseBinding, currentBinding);
  return {
    evidence: wrapper.evidence,
    sourceSha256: sha256Canonical(bundle),
    releaseBindingHeads: [head],
  };
}

async function readInstalledGateEvidence(currentBinding, boundary = undefined) {
  await assertInstalledGateLayout(boundary);
  const result = {};
  for (const action of STAGING_GATE_ACTIONS) {
    const value = await readRootOwnedCanonicalJson(
      installedBoundaryPath(boundary, STAGING_GATE_EVIDENCE_PATHS[action.actionId]),
      `installed ${action.gate} aggregate`,
      512 * 1024,
      installedBoundarySecurity(boundary),
    );
    const checked = boundary?.gateCheckerPorts === undefined
      ? await verifyHistoricalStagingGateEvidence(value, currentBinding, action.actionId)
      : await verifyHistoricalStagingGateEvidence(
          value,
          currentBinding,
          action.actionId,
          boundary.gateCheckerPorts,
        );
    const key = action.gate.replace("-", "");
    result[key] = {
      sourceSha256: sha256Canonical(value),
      checkerSha256: hashCheckerResult(`installed ${action.gate}`, checked),
      releaseBindingHeads: [
        requireHistoricalBinding(`installed ${action.gate}`, value.releaseBinding, currentBinding),
      ],
    };
  }
  return result;
}

async function readInstalledTask9Evidence(currentBinding, boundary = undefined) {
  const root = installedBoundaryPath(boundary, TASK9_EVIDENCE_ROOT);
  const security = installedBoundarySecurity(boundary);
  await assertRootOwnedPath(root, "directory", "Task 9 evidence root", security);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length === 0 || entries.length > 128) {
    throw new Error("Task 9 evidence root must contain bounded drill directories");
  }
  const terminal = [];
  for (const entry of entries) {
    if (!DRILL_ID_PATTERN.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Task 9 evidence root contains an invalid drill entry");
    }
    const directory = join(root, entry.name);
    const bundle = await readRootOwnedBundle(
      directory,
      SERVICE_FAULT_EVIDENCE_MANIFEST,
      "Task 9 evidence directory",
      security,
    );
    const assembled = assemblePayloadBundle(
      bundle,
      SERVICE_FAULT_EVIDENCE_MANIFEST,
      currentBinding,
      "Task 9 evidence bundle",
    );
    if (!assembled.matchesCurrentRelease) continue;
    if (assembled.evidence.drillId !== entry.name) {
      throw new Error("Task 9 drill directory does not match its bounded drill ID");
    }
    const checked = evaluateServiceFaultEvidence(assembled.evidence);
    if (checked.ok !== true) {
      throw new Error("Task 9 evidence for the installed release is not terminal");
    }
    terminal.push({ assembled, checked });
  }
  if (terminal.length !== 1) {
    throw new Error("exactly one terminal Task 9 drill must match the installed release");
  }
  const [{ assembled, checked }] = terminal;
  return {
    sourceSha256: assembled.sourceSha256,
    checkerSha256: hashCheckerResult("Task 9", checked),
    releaseBindingHeads: [assembled.binding.actionJournalHeadSha256],
  };
}

async function readInstalledWorkerEvidence(currentBinding, boundary = undefined) {
  const bundle = await readRootOwnedBundle(
    installedBoundaryPath(boundary, WORKER_EVIDENCE_DIRECTORY),
    SERVICE_WORKER_EVIDENCE_MANIFEST,
    "worker evidence directory",
    installedBoundarySecurity(boundary),
  );
  const assembled = assemblePayloadBundle(
    bundle,
    SERVICE_WORKER_EVIDENCE_MANIFEST,
    currentBinding,
    "worker evidence bundle",
  );
  if (!assembled.matchesCurrentRelease) {
    throw new Error("worker evidence release binding does not match the installed release");
  }
  const checked = evaluateServiceWorkerEvidence(assembled.evidence);
  return {
    sourceSha256: assembled.sourceSha256,
    checkerSha256: hashCheckerResult("worker evidence", checked),
    releaseBindingHeads: [assembled.binding.actionJournalHeadSha256],
  };
}

async function readInstalledPhase3Evidence(currentBinding) {
  const record = await readPhase3SemanticEvidence();
  if (
    !record ||
    typeof record.sha256 !== "string" ||
    createHash("sha256").update(record.bytes).digest("hex") !== record.sha256
  ) {
    throw new Error("installed Phase 3 source record is invalid");
  }
  const head = requireHistoricalBinding(
    "installed Phase 3 evidence",
    record.value?.release,
    currentBinding,
  );
  const checked = await verifyInstalledPhase3RolloutEvidence({
    expectedSemanticSha256: record.sha256,
  });
  return {
    sourceSha256: record.sha256,
    checkerSha256: hashCheckerResult("installed Phase 3 evidence", checked),
    releaseBindingHeads: [head],
  };
}

async function readInstalledPhase4Evidence(currentBinding, boundary = undefined) {
  const manifest = { "phase4-evidence.json": "evidence" };
  const bundle = await readRootOwnedBundle(
    installedBoundaryPath(boundary, PHASE4_EVIDENCE_DIRECTORY),
    manifest,
    "Phase 4 evidence directory",
    installedBoundarySecurity(boundary),
  );
  const source = singleEvidenceBundle(
    bundle,
    "phase4-evidence.json",
    currentBinding,
    "Phase 4 evidence",
  );
  const checked = evaluatePhase4Evidence(source.evidence);
  if (source.evidence?.actionJournal?.headSha256 !== currentBinding.actionJournalHeadSha256) {
    throw new Error("Phase 4 evidence is not bound to the terminal action journal head");
  }
  return {
    sourceSha256: source.sourceSha256,
    checkerSha256: hashCheckerResult("Phase 4 evidence", checked),
    releaseBindingHeads: [
      ...source.releaseBindingHeads,
      source.evidence.actionJournal.headSha256,
    ].filter((head, index, heads) => heads.indexOf(head) === index),
    guardClosed: source.evidence?.cleanup?.guardClosed === true,
  };
}

async function readInstalledNMinusOneEvidence(currentBinding, boundary = undefined) {
  const manifest = { "n-minus-one-evidence.json": "evidence" };
  const bundle = await readRootOwnedBundle(
    installedBoundaryPath(boundary, N_MINUS_ONE_EVIDENCE_DIRECTORY),
    manifest,
    "N-1 evidence directory",
    installedBoundarySecurity(boundary),
  );
  const source = singleEvidenceBundle(
    bundle,
    "n-minus-one-evidence.json",
    currentBinding,
    "N-1 evidence",
  );
  const checked = evaluateNMinusOneEvidence(source.evidence);
  const journalHead = source.evidence?.actionJournal?.headSha256;
  requireSha256("N-1 action journal head", journalHead);
  return {
    sourceSha256: source.sourceSha256,
    checkerSha256: hashCheckerResult("N-1 evidence", checked),
    releaseBindingHeads: [...source.releaseBindingHeads, journalHead].filter(
      (head, index, heads) => heads.indexOf(head) === index,
    ),
  };
}

function assertJournalBindingMatchesRelease(binding, releaseBinding) {
  if (
    binding?.stagingRunId !== releaseBinding.stagingRunId ||
    binding?.approvalEnvelopeSha256 !== releaseBinding.stagingApprovalEnvelopeSha256 ||
    binding?.targetDescriptorSha256 !== releaseBinding.stagingTargetDescriptorSha256 ||
    binding?.operatorBundleSha256 !== releaseBinding.operatorBundleSha256
  ) {
    throw new Error("authenticated action journal binding does not match the installed release");
  }
}

function validateTerminalJournalSnapshot(snapshot, releaseBinding) {
  if (
    snapshot?.headSha256 !== releaseBinding.actionJournalHeadSha256 ||
    !Array.isArray(snapshot.actions) ||
    snapshot.actions.length !== REQUIRED_STAGING_ACTION_PLAN.length
  ) {
    throw new Error("installed action journal is not the exact terminal staging plan");
  }
  const acceptedHistoricalHeads = [];
  for (const [index, expected] of REQUIRED_STAGING_ACTION_PLAN.entries()) {
    const actual = snapshot.actions[index];
    if (
      actual?.sequence !== expected.sequence ||
      actual?.actionId !== expected.actionId ||
      actual?.scope !== expected.scope ||
      actual?.kind !== expected.kind ||
      actual?.mutationSha256 !== expected.mutationSha256
    ) {
      throw new Error("installed action journal signed action sequence changed");
    }
    if (expected.kind === "emergency") {
      if (
        actual.state !== "registered" ||
        actual.occurrences !== 0 ||
        actual.terminalRecordSha256 !== null
      ) {
        throw new Error("installed action journal contains a used emergency action");
      }
      continue;
    }
    if (
      !["succeeded", "reconciled"].includes(actual.state) ||
      actual.occurrences !== 1 ||
      !NONZERO_SHA256_PATTERN.test(actual.terminalRecordSha256 ?? "")
    ) {
      throw new Error("installed action journal contains an open, failed, or ambiguous action");
    }
    if (
      actual.state === "reconciled" &&
      (actual.reconciliationOutcome !== "succeeded" || !actual.reconciliationId)
    ) {
      throw new Error("installed action journal contains an unverified reconciliation");
    }
    acceptedHistoricalHeads.push(actual.terminalRecordSha256);
  }
  const guardClose = snapshot.actions.find((action) => action.actionId === "guard-close");
  if (guardClose?.terminalRecordSha256 !== snapshot.headSha256) {
    throw new Error("guard-close is not the terminal action journal head");
  }
  return acceptedHistoricalHeads;
}

async function readInstalledActionJournal(currentBinding) {
  const historical = await readPhase3ActionJournalSnapshot();
  if (
    !historical?.value ||
    typeof historical.bytes !== "string" ||
    typeof historical.sha256 !== "string" ||
    historical.bytes !== canonicalJson(historical.value) ||
    createHash("sha256").update(historical.bytes).digest("hex") !== historical.sha256 ||
    !NONZERO_SHA256_PATTERN.test(historical.value.headSha256 ?? "")
  ) {
    throw new Error("installed historical action journal snapshot is invalid");
  }
  assertJournalBindingMatchesRelease(historical.value.binding, currentBinding);
  const snapshot = await readAuthenticatedStagingActionJournalSnapshot({
    binding: historical.value.binding,
    snapshot: historical.value,
  });
  const acceptedHistoricalHeads = validateTerminalJournalSnapshot(snapshot, currentBinding);
  acceptedHistoricalHeads.push(historical.value.headSha256, snapshot.headSha256);
  return {
    headSha256: snapshot.headSha256,
    acceptedHistoricalHeads: [...new Set(acceptedHistoricalHeads)],
  };
}

async function writeInstalledArtifact(filename, bytes, boundary = undefined) {
  if (filename !== STAGING_PROTECTED_EVIDENCE_FILENAME || typeof bytes !== "string") {
    throw new Error("protected-evidence writer accepts only the fixed canonical artifact");
  }
  const outputRoot = installedBoundaryPath(boundary, STAGING_PROTECTED_EVIDENCE_ROOT);
  const security = installedBoundarySecurity(boundary);
  await assertRootOwnedPath(
    outputRoot,
    "directory",
    "protected-evidence output root",
    security,
  );
  const path = join(outputRoot, filename);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let handle;
  let created = false;
  try {
    handle = await open(path, flags, 0o400);
    created = true;
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") {
      const parent = await open(
        outputRoot,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    const status = await assertRootOwnedPath(
      path,
      "file",
      "protected-evidence artifact",
      security,
    );
    if (security === undefined && Number(status.mode & 0o777n) !== 0o400) {
      throw new Error("protected-evidence artifact must use mode 0400");
    }
    return path;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(path).catch(() => undefined);
    throw error;
  }
}

function defaultInstalledPorts() {
  return Object.freeze({
    loadReleaseBinding: () => loadInstalledReleaseBinding({ environment: "staging" }),
    loadProducerContext: () =>
      readRootOwnedCanonicalJson(
        STAGING_PROTECTED_EVIDENCE_PRODUCER_CONTEXT,
        "protected-evidence producer context",
      ),
    readGateEvidence: readInstalledGateEvidence,
    readTask9Evidence: readInstalledTask9Evidence,
    readWorkerEvidence: readInstalledWorkerEvidence,
    readPhase3Evidence: readInstalledPhase3Evidence,
    readPhase4Evidence: readInstalledPhase4Evidence,
    readNMinusOneEvidence: readInstalledNMinusOneEvidence,
    readActionJournal: readInstalledActionJournal,
    writeArtifact: writeInstalledArtifact,
  });
}

export function createStagingProtectedEvidenceInstalledTestAdapter(options) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("installed protected-evidence test adapter is unavailable");
  }
  assertExactEnumerableRecord("installed protected-evidence test adapter", options, [
    "rootPath",
    "phase3SourceGraph",
    "verifyPhase3Semantic",
  ]);
  if (
    typeof options.rootPath !== "string" ||
    options.rootPath.length === 0 ||
    typeof options.verifyPhase3Semantic !== "function"
  ) {
    throw new Error("installed protected-evidence test adapter options are invalid");
  }
  const rootPath = resolve(options.rootPath);
  const security = Object.freeze({ testRoot: rootPath });
  const mapPath = (fixedPath) => {
    const normalizedPath =
      typeof fixedPath === "string" ? fixedPath.replaceAll("\\", "/") : fixedPath;
    if (
      typeof normalizedPath !== "string" ||
      !normalizedPath.startsWith("/") ||
      normalizedPath.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("installed protected-evidence test path is invalid");
    }
    const path = join(rootPath, ...normalizedPath.split("/").filter(Boolean));
    assertTestPathBoundary(path, security);
    return path;
  };
  const gateCheckerPorts = Object.freeze({
    async readProof(actionId, name) {
      const fixedPath = STAGING_GATE_PROOF_PATHS[actionId]?.[name];
      if (!fixedPath) throw new Error("fixed staging gate proof path is invalid");
      const path = mapPath(fixedPath);
      await assertRootOwnedPath(dirname(path), "directory", "installed staging gate proof parent", security);
      await assertRootOwnedPath(path, "file", "installed staging gate proof", security);
      return readEvidenceBytes(path, { maxFileBytes: 512 * 1024 });
    },
    async readFixedPhase3SourceGraph() {
      return structuredClone(options.phase3SourceGraph);
    },
    verifyPhase3Semantic: options.verifyPhase3Semantic,
    async loadLeases() {
      throw new Error("historical installed gate validation must not load live leases");
    },
  });
  const boundary = Object.freeze({ mapPath, security, gateCheckerPorts });
  return Object.freeze({
    fixedPath: mapPath,
    loadReleaseBinding: () =>
      readRootOwnedCanonicalJson(
        mapPath("/var/lib/spx-staging-rollout/verified-release-binding.json"),
        "installed staging release binding",
        256 * 1024,
        security,
      ),
    loadProducerContext: () =>
      readRootOwnedCanonicalJson(
        mapPath(STAGING_PROTECTED_EVIDENCE_PRODUCER_CONTEXT),
        "protected-evidence producer context",
        64 * 1024,
        security,
      ),
    readGateEvidence: (currentBinding) => readInstalledGateEvidence(currentBinding, boundary),
    readTask9Evidence: (currentBinding) => readInstalledTask9Evidence(currentBinding, boundary),
    readWorkerEvidence: (currentBinding) => readInstalledWorkerEvidence(currentBinding, boundary),
    readPhase4Evidence: (currentBinding) => readInstalledPhase4Evidence(currentBinding, boundary),
    readNMinusOneEvidence: (currentBinding) =>
      readInstalledNMinusOneEvidence(currentBinding, boundary),
    validateActionJournalSnapshot(snapshot, currentBinding) {
      assertJournalBindingMatchesRelease(snapshot?.binding, currentBinding);
      const acceptedHistoricalHeads = validateTerminalJournalSnapshot(snapshot, currentBinding);
      acceptedHistoricalHeads.push(snapshot.headSha256);
      return Object.freeze({
        headSha256: snapshot.headSha256,
        acceptedHistoricalHeads: Object.freeze([...new Set(acceptedHistoricalHeads)]),
      });
    },
    writeArtifact: (filename, bytes) => writeInstalledArtifact(filename, bytes, boundary),
  });
}

async function main(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("staging protected-evidence CLI accepts zero arguments");
  }
  const result = await exportInstalledStagingProtectedEvidence();
  process.stdout.write(
    `${canonicalJson({
      ok: true,
      filename: STAGING_PROTECTED_EVIDENCE_FILENAME,
      sha256: sha256Canonical(result.evidence),
    })}\n`,
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write(
      `${canonicalJson({
        ok: false,
        code: "staging-protected-evidence-export-failed",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
