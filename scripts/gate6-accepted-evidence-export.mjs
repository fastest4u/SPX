#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import {
  GATE6_SEMANTIC_RECEIPT_ROOT,
  readGate6SemanticReceipt,
} from "./lib/gate6-semantic-receipt.mjs";

export const ACCEPTED_EVIDENCE_EXPORT_ROOT = "/var/lib/spx-production-rollout/export/accepted";

export const ACCEPTED_EVIDENCE_PATHS = Object.freeze({
  "db-transition":
    "/var/lib/spx-production-rollout/export/accepted/accepted-db-transition-evidence.json",
  "pre-close": "/var/lib/spx-production-rollout/export/accepted/accepted-pre-close-evidence.json",
});

const FIXED_PRODUCER_CONTEXT =
  "/var/lib/spx-production-rollout/accepted-evidence-producer-context.json";
const FIXED_GATE6_ENVELOPE = "/var/lib/spx-gate6/artifacts/gate6-envelope.json";
const FIXED_PRODUCTION_LOCK = "/var/lib/spx-production-mutation/lock.json";
const FIXED_MYSQL = "/usr/bin/mysql";
const FIXED_DB_CAPABILITY = "/var/lib/spx-gate6/gate6-control-db.json";
const FIXED_DB_PASSWORD = "/var/lib/spx-gate6/secrets/gate6-control-db-password";
const FIXED_DB_CA = "/var/lib/spx-gate6/config/db-ca.pem";
const FIXED_MYSQL_RUNTIME = "/run/spx-gate6-accepted-evidence";
const MAX_JSON_BYTES = 256 * 1024;
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAX_MYSQL_OUTPUT_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DNS_NAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const SECRET_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SECRET_VALUE = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];
const PRODUCTION_CONTEXT = Symbol("accepted-evidence-production-context");

const PRIOR_PRE_CLOSE_SCOPES = Object.freeze([
  "stage-accept-db-transition",
  "stage-accept-task9",
  "stage-accept-worker",
  "stage-accept-phase3",
  "stage-accept-phase4",
]);

const PHASES = Object.freeze({
  "db-transition": Object.freeze({
    scope: "stage-accept-db-transition",
    expectedStage: "admitted",
    nextStage: "db-transition-stable",
    checkerName: "db-transition-production-evidence",
    filename: "accepted-db-transition-evidence.json",
    allowedReceiptScopes: Object.freeze(["stage-accept-db-transition"]),
  }),
  "pre-close": Object.freeze({
    scope: "stage-accept-pre-close",
    expectedStage: "final-baseline-stable",
    nextStage: "pre-close-accepted",
    checkerName: "pre-close-production-evidence",
    filename: "accepted-pre-close-evidence.json",
    allowedReceiptScopes: Object.freeze([...PRIOR_PRE_CLOSE_SCOPES, "stage-accept-pre-close"]),
  }),
});

const BINDING_FIELDS = Object.freeze([
  "actionStatus",
  "afterEvidenceSha256",
  "runStatus",
  "currentStage",
  "acceptedCheckerName",
  "acceptedCheckerSha256",
  "slotOwnerType",
  "slotOwnerId",
  "slotState",
  "slotVersion",
  "monitorStatus",
  "monitorLeaseExpiresAt",
  "supervisorStatus",
  "supervisorLeaseExpiresAt",
]);
const SAFETY_FIELDS = Object.freeze([
  "gate6Id",
  "candidateSha",
  "activePermitCount",
  "uncompensatedWork",
]);
const PRODUCER_FIELDS = Object.freeze([
  "repository",
  "environment",
  "workflow",
  "workflowSha",
  "workflowFileSha256",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactIso(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function scanSafeJson(value, path = "$", seen = new Set()) {
  if (typeof value === "string") {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("accepted evidence contains secret-shaped content");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`accepted evidence ${path} is invalid JSON`);
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new Error(`accepted evidence ${path} is not plain JSON`);
  }
  if (seen.has(value)) throw new Error("accepted evidence contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanSafeJson(child, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        throw new Error("accepted evidence contains a secret-shaped field");
      }
      scanSafeJson(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function expectedOwner(isTestOverride) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return null;
  return isTestOverride && process.env.NODE_ENV === "test" ? process.getuid() : 0;
}

function modeOf(status) {
  return Number(status.mode) & 0o777;
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

async function assertNoSymlinkParents(path, label) {
  const absolute = resolve(path);
  const volumeRoot = parse(absolute).root;
  const components = absolute
    .slice(volumeRoot.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = volumeRoot;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const status = await lstat(current, { bigint: true });
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${label} must not traverse a symlink or non-directory`);
    }
  }
}

async function validateDirectory(root, label, isTestOverride) {
  await assertNoSymlinkParents(join(root, ".directory-sentinel"), label);
  const status = await lstat(root, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
  if (process.platform !== "win32" && modeOf(status) !== 0o700) {
    throw new Error(`${label} mode must be 0700`);
  }
  const owner = expectedOwner(isTestOverride);
  if (owner !== null && Number(status.uid) !== owner) {
    throw new Error(`${label} must be root-owned`);
  }
}

async function readStableFile(
  path,
  { label, maximumBytes, allowedModes, owner = 0, allowEmpty = false },
) {
  await assertNoSymlinkParents(path, label);
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (!allowEmpty && before.size === 0n) ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  if (process.platform !== "win32" && !allowedModes.includes(modeOf(before))) {
    throw new Error(`${label} mode is invalid`);
  }
  if (owner !== null && process.platform !== "win32" && Number(before.uid) !== owner) {
    throw new Error(`${label} must be root-owned`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > maximumBytes || (!allowEmpty && bytes.length === 0)) {
      throw new Error(`${label} exceeds its size limit`);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(after, pathAfter)) {
      throw new Error(`${label} changed during stable read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(root) {
  const handle = await open(root, constants.O_RDONLY);
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    }
  } finally {
    await handle.close();
  }
}

async function ensureExportRoot(root, isTestOverride) {
  try {
    await mkdir(root, { mode: 0o700, recursive: false });
    await fsyncDirectory(dirname(root));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await validateDirectory(root, "accepted export root", isTestOverride);
}

async function assertClosedDirectory(root, allowedNames, label, isTestOverride) {
  await validateDirectory(root, label, isTestOverride);
  const allowed = new Set(allowedNames);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`${label} entries must be regular files, not nested or symlinked entries`);
    }
    if (!allowed.has(entry.name)) throw new Error(`${label} contains an unexpected file`);
    const status = await lstat(join(root, entry.name), { bigint: true });
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`${label} entries must be regular files, not nested or symlinked entries`);
    }
    if (process.platform !== "win32" && modeOf(status) !== 0o400) {
      throw new Error(`${label} file mode must be 0400`);
    }
    const owner = expectedOwner(isTestOverride);
    if (owner !== null && Number(status.uid) !== owner) {
      throw new Error(`${label} files must be root-owned`);
    }
  }
  return entries.map((entry) => entry.name).sort();
}

function validateProducer(value) {
  exactObject(value, PRODUCER_FIELDS, "accepted evidence producer");
  scanSafeJson(value);
  if (
    value.repository !== "fastest4u/SPX" ||
    value.environment !== "production" ||
    value.workflow !== ".github/workflows/gate6-accepted-evidence-exporter.yml" ||
    !COMMIT_SHA.test(value.workflowSha ?? "") ||
    !SHA256.test(value.workflowFileSha256 ?? "")
  ) {
    throw new Error("accepted evidence producer metadata is invalid");
  }
  return deepFreeze(structuredClone(value));
}

function validateBinding(value, receipt, descriptor, nowMs) {
  exactObject(value, BINDING_FIELDS, "accepted Gate 6 semantic binding");
  if (value.actionStatus !== "succeeded") {
    throw new Error("accepted Gate 6 action has not succeeded");
  }
  if (!SHA256.test(value.afterEvidenceSha256 ?? "")) {
    throw new Error("accepted Gate 6 action evidence hash is invalid");
  }
  if (value.afterEvidenceSha256 !== receipt.acceptedCheckerSha256) {
    throw new Error("accepted Gate 6 action evidence does not match the checker receipt");
  }
  if (value.runStatus !== "active") throw new Error("accepted Gate 6 run is not active");
  if (value.currentStage !== descriptor.nextStage) {
    throw new Error("accepted Gate 6 current stage is not the exact required stage");
  }
  if (
    value.acceptedCheckerName !== receipt.checkerName ||
    !SHA256.test(value.acceptedCheckerSha256 ?? "") ||
    value.acceptedCheckerSha256 !== receipt.acceptedCheckerSha256
  ) {
    throw new Error("accepted Gate 6 checker binding does not match the receipt");
  }
  if (
    value.slotOwnerType !== "gate6" ||
    value.slotOwnerId !== receipt.gate6Id ||
    value.slotState !== "active" ||
    !Number.isSafeInteger(value.slotVersion) ||
    value.slotVersion < 1
  ) {
    throw new Error("accepted Gate 6 slot owner/state binding is invalid or inactive");
  }
  const monitorExpiry = exactIso(
    value.monitorLeaseExpiresAt,
    "accepted Gate 6 monitor lease expiry",
  );
  if (value.monitorStatus !== "green" || monitorExpiry <= nowMs) {
    throw new Error("accepted Gate 6 monitor must be green with an unexpired lease");
  }
  const supervisorExpiry = exactIso(
    value.supervisorLeaseExpiresAt,
    "accepted Gate 6 supervisor lease expiry",
  );
  if (value.supervisorStatus !== "green" || supervisorExpiry <= nowMs) {
    throw new Error("accepted Gate 6 supervisor must be green with an unexpired lease");
  }
  return value;
}

function validateStableBinding(initial, final) {
  for (const field of [
    "actionStatus",
    "afterEvidenceSha256",
    "runStatus",
    "currentStage",
    "acceptedCheckerName",
    "acceptedCheckerSha256",
    "slotOwnerType",
    "slotOwnerId",
    "slotState",
    "monitorStatus",
    "supervisorStatus",
  ]) {
    if (final[field] !== initial[field]) {
      throw new Error("accepted Gate 6 semantic binding changed while exporting");
    }
  }
  if (final.slotVersion < initial.slotVersion) {
    throw new Error("accepted Gate 6 slot version moved backwards while exporting");
  }
  if (
    exactIso(final.monitorLeaseExpiresAt, "accepted Gate 6 final monitor lease expiry") <
      exactIso(initial.monitorLeaseExpiresAt, "accepted Gate 6 initial monitor lease expiry") ||
    exactIso(final.supervisorLeaseExpiresAt, "accepted Gate 6 final supervisor lease expiry") <
      exactIso(initial.supervisorLeaseExpiresAt, "accepted Gate 6 initial supervisor lease expiry")
  ) {
    throw new Error("accepted Gate 6 lease moved backwards while exporting");
  }
}

function validateSafety(value, receipt, candidateSha) {
  exactObject(value, SAFETY_FIELDS, "accepted Gate 6 pre-close safety binding");
  if (value.gate6Id !== receipt.gate6Id || value.candidateSha !== candidateSha) {
    throw new Error("accepted Gate 6 pre-close safety identity is invalid");
  }
  if (!Number.isSafeInteger(value.activePermitCount) || value.activePermitCount !== 0) {
    throw new Error("accepted Gate 6 pre-close requires zero active permits");
  }
  if (!Number.isSafeInteger(value.uncompensatedWork) || value.uncompensatedWork !== 0) {
    throw new Error("accepted Gate 6 pre-close requires zero uncompensated work");
  }
  return Object.freeze({ activePermitCount: 0, uncompensatedWork: 0 });
}

function validateReceiptPhase(receipt, descriptor, nowMs) {
  if (
    receipt.scope !== descriptor.scope ||
    receipt.expectedStage !== descriptor.expectedStage ||
    receipt.nextStage !== descriptor.nextStage ||
    receipt.checkerName !== descriptor.checkerName
  ) {
    throw new Error("accepted Gate 6 receipt phase/checker binding is invalid");
  }
  if (exactIso(receipt.checkedAt, "accepted Gate 6 receipt timestamp") > nowMs) {
    throw new Error("accepted Gate 6 receipt timestamp is in the future");
  }
}

function validateHostLock(lock, receipt, targetDescriptorSha256, nowMs) {
  if (!isPlainObject(lock)) throw new Error("fixed production mutation lock is invalid");
  const leaseExpiry = isPlainObject(lock.lease)
    ? exactIso(lock.lease.expiresAt, "fixed production mutation lock lease expiry")
    : Number.NaN;
  if (
    lock.schemaVersion !== 3 ||
    lock.state !== "gate6-active" ||
    lock.targetHash !== targetDescriptorSha256 ||
    !Number.isFinite(leaseExpiry) ||
    leaseExpiry <= nowMs ||
    !isPlainObject(lock.handoff) ||
    lock.handoff.gate6Id !== receipt.gate6Id ||
    !Number.isSafeInteger(lock.handoff.slotVersion) ||
    lock.handoff.slotVersion < 1
  ) {
    throw new Error("fixed production mutation lock does not match the active Gate 6 run");
  }
}

function hostLockStableIdentity(lock) {
  return {
    schemaVersion: lock.schemaVersion,
    operationId: lock.operationId,
    operationType: lock.operationType,
    releaseHash: lock.releaseHash,
    targetHash: lock.targetHash,
    state: lock.state,
    rollbackJournalHash: lock.rollbackJournalHash,
    rollbackIdentity: lock.rollbackIdentity,
    installBootstrap: lock.installBootstrap,
    protectedInstall: lock.protectedInstall,
    handoff: lock.handoff,
    terminalPostcondition: lock.terminalPostcondition,
    createdAt: lock.createdAt,
  };
}

function validateStableHostLock(initial, final) {
  if (
    canonicalJson(hostLockStableIdentity(final)) !== canonicalJson(hostLockStableIdentity(initial))
  ) {
    throw new Error("fixed production mutation lock identity changed while exporting");
  }
  if (
    !Number.isSafeInteger(initial.revision) ||
    !Number.isSafeInteger(final.revision) ||
    final.revision < initial.revision ||
    exactIso(final.updatedAt, "fixed production mutation lock final update") <
      exactIso(initial.updatedAt, "fixed production mutation lock initial update") ||
    exactIso(final.lease.expiresAt, "fixed production mutation lock final lease expiry") <
      exactIso(initial.lease.expiresAt, "fixed production mutation lock initial lease expiry")
  ) {
    throw new Error("fixed production mutation lock revision or lease moved backwards");
  }
}

function reconcileExistingEvidence(existing, current, nowMs) {
  exactObject(existing, Object.keys(current), "existing accepted evidence export");
  scanSafeJson(existing);
  const stable = (value) => {
    const projection = { ...value };
    delete projection.slotVersion;
    delete projection.monitorLeaseExpiresAt;
    delete projection.supervisorLeaseExpiresAt;
    return projection;
  };
  if (canonicalJson(stable(existing)) !== canonicalJson(stable(current))) {
    throw new Error("accepted evidence export conflicts with durable bytes");
  }
  if (
    !Number.isSafeInteger(existing.slotVersion) ||
    existing.slotVersion < 1 ||
    existing.slotVersion > current.slotVersion
  ) {
    throw new Error("accepted evidence export slot version conflicts with current state");
  }
  const existingMonitorExpiry = exactIso(
    existing.monitorLeaseExpiresAt,
    "existing accepted evidence monitor lease expiry",
  );
  const existingSupervisorExpiry = exactIso(
    existing.supervisorLeaseExpiresAt,
    "existing accepted evidence supervisor lease expiry",
  );
  if (
    existingMonitorExpiry <= nowMs ||
    existingSupervisorExpiry <= nowMs ||
    existingMonitorExpiry >
      exactIso(current.monitorLeaseExpiresAt, "current monitor lease expiry") ||
    existingSupervisorExpiry >
      exactIso(current.supervisorLeaseExpiresAt, "current supervisor lease expiry")
  ) {
    throw new Error("accepted evidence export lease conflicts with current state");
  }
  return deepFreeze(existing);
}

async function writeAcceptedEvidence(path, bytes, root, isTestOverride) {
  let handle;
  let created = false;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o400,
    );
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
  if (created) await fsyncDirectory(root);
  const reopened = await readStableFile(path, {
    label: "accepted evidence export",
    maximumBytes: MAX_JSON_BYTES,
    allowedModes: [0o400],
    owner: expectedOwner(isTestOverride),
  });
  if (!reopened.equals(bytes)) {
    throw new Error("accepted evidence export conflicts with durable bytes");
  }
  if (sha256(reopened) !== sha256(bytes)) {
    throw new Error("accepted evidence export stable reopen hash mismatch");
  }
}

export function parseAcceptedEvidenceCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== "string") {
    throw new Error("accepted evidence CLI requires exactly one phase argument");
  }
  const match = /^--phase=(db-transition|pre-close)$/.exec(argv[0]);
  if (match === null) throw new Error("accepted evidence CLI phase argument is invalid");
  return match[1];
}

export async function exportAcceptedSemanticEvidence(phase, context = {}) {
  const descriptor = PHASES[phase];
  if (descriptor === undefined) throw new Error("accepted evidence phase is invalid");
  const testContext = process.env.NODE_ENV === "test";
  if (!testContext && context?.[PRODUCTION_CONTEXT] !== true) {
    throw new Error("production accepted evidence exporter requires fixed production context");
  }
  if (!isPlainObject(context)) throw new Error("accepted evidence context is invalid");
  exactObject(
    context,
    testContext
      ? ["candidateSha", "ledger", "now", "producer", "receiptRoot", "exportRoot"]
      : [
          "candidateSha",
          "targetDescriptorSha256",
          "expectedReceiptBinding",
          "hostLock",
          "ledger",
          "producer",
          "now",
        ],
    "accepted evidence context",
  );
  const isTestOverride = testContext;
  if (
    isTestOverride &&
    (typeof context.receiptRoot !== "string" || typeof context.exportRoot !== "string")
  ) {
    throw new Error("test accepted evidence roots are invalid");
  }
  const receiptRoot = resolve(isTestOverride ? context.receiptRoot : GATE6_SEMANTIC_RECEIPT_ROOT);
  const exportRoot = resolve(isTestOverride ? context.exportRoot : ACCEPTED_EVIDENCE_EXPORT_ROOT);
  if (
    !isTestOverride &&
    (receiptRoot !== resolve(GATE6_SEMANTIC_RECEIPT_ROOT) ||
      exportRoot !== resolve(ACCEPTED_EVIDENCE_EXPORT_ROOT))
  ) {
    throw new Error("production accepted evidence roots are fixed");
  }
  if (!COMMIT_SHA.test(context.candidateSha ?? "")) {
    throw new Error("accepted evidence candidate SHA is invalid");
  }
  if (
    !isPlainObject(context.ledger) ||
    typeof context.ledger.getAcceptedSemanticBinding !== "function"
  ) {
    throw new Error("accepted evidence ledger adapter is invalid");
  }
  const producer = validateProducer(context.producer);
  if (!(context.now instanceof Date)) throw new Error("accepted evidence clock is invalid");
  const now = new Date(context.now.getTime());
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("accepted evidence clock is invalid");

  await ensureExportRoot(exportRoot, isTestOverride);
  const initialExportNames = await assertClosedDirectory(
    exportRoot,
    [descriptor.filename],
    "accepted export root",
    isTestOverride,
  );
  const initialExportRootIdentity = await lstat(exportRoot, { bigint: true });
  const allowedReceiptNames = descriptor.allowedReceiptScopes.map((scope) => `${scope}.json`);
  const initialReceiptNames = await assertClosedDirectory(
    receiptRoot,
    allowedReceiptNames,
    "accepted receipt root",
    isTestOverride,
  );
  if (canonicalJson(initialReceiptNames) !== canonicalJson([...allowedReceiptNames].sort())) {
    throw new Error("accepted receipt root is missing the exact receipt file set");
  }
  const targetReceiptName = `${descriptor.scope}.json`;
  if (!initialReceiptNames.includes(targetReceiptName)) {
    throw new Error("accepted receipt root is missing the exact phase receipt file");
  }

  const initialReceiptRootIdentity = await lstat(receiptRoot, { bigint: true });
  const targetReceiptPath = join(receiptRoot, targetReceiptName);
  const initialReceiptIdentity = await lstat(targetReceiptPath, { bigint: true });
  const first = await readGate6SemanticReceipt(descriptor.scope, { root: receiptRoot });
  const receiptIdentityAfterFirstRead = await lstat(targetReceiptPath, { bigint: true });
  if (!sameIdentity(initialReceiptIdentity, receiptIdentityAfterFirstRead)) {
    throw new Error("accepted Gate 6 receipt changed or was replaced while opening");
  }
  validateReceiptPhase(first.receipt, descriptor, nowMs);
  if (!SAFE_ID.test(first.receipt.gate6Id) || !SAFE_ID.test(first.receipt.actionId)) {
    throw new Error("accepted Gate 6 receipt identity is invalid");
  }
  if (!isTestOverride) {
    if (
      !isPlainObject(context.expectedReceiptBinding) ||
      context.expectedReceiptBinding.gate6Id !== first.receipt.gate6Id ||
      context.expectedReceiptBinding.scope !== first.receipt.scope ||
      context.expectedReceiptBinding.actionId !== first.receipt.actionId
    ) {
      throw new Error("fixed Gate 6 receipt does not match the verified envelope action");
    }
    validateHostLock(context.hostLock, first.receipt, context.targetDescriptorSha256, nowMs);
  }

  const binding = await context.ledger.getAcceptedSemanticBinding(
    first.receipt.gate6Id,
    first.receipt.scope,
    first.receipt.actionId,
  );
  validateBinding(binding, first.receipt, descriptor, nowMs);

  let preCloseSafety = null;
  if (phase === "pre-close") {
    if (typeof context.ledger.getAcceptedSemanticSafetyBinding !== "function") {
      throw new Error("accepted Gate 6 pre-close safety ledger adapter is unavailable");
    }
    const safety = await context.ledger.getAcceptedSemanticSafetyBinding(first.receipt.gate6Id);
    preCloseSafety = validateSafety(safety, first.receipt, context.candidateSha);
  }

  const finalBinding = await context.ledger.getAcceptedSemanticBinding(
    first.receipt.gate6Id,
    first.receipt.scope,
    first.receipt.actionId,
  );
  validateBinding(finalBinding, first.receipt, descriptor, nowMs);
  validateStableBinding(binding, finalBinding);
  if (phase === "pre-close") {
    const finalSafety = await context.ledger.getAcceptedSemanticSafetyBinding(
      first.receipt.gate6Id,
    );
    validateSafety(finalSafety, first.receipt, context.candidateSha);
    if (
      canonicalJson(finalSafety) !==
      canonicalJson({
        gate6Id: first.receipt.gate6Id,
        candidateSha: context.candidateSha,
        activePermitCount: preCloseSafety.activePermitCount,
        uncompensatedWork: preCloseSafety.uncompensatedWork,
      })
    ) {
      throw new Error("accepted Gate 6 pre-close safety binding changed while exporting");
    }
  }

  const finalReceiptNames = await assertClosedDirectory(
    receiptRoot,
    allowedReceiptNames,
    "accepted receipt root",
    isTestOverride,
  );
  if (canonicalJson(finalReceiptNames) !== canonicalJson(initialReceiptNames)) {
    throw new Error("accepted receipt root changed while exporting");
  }
  const second = await readGate6SemanticReceipt(descriptor.scope, { root: receiptRoot });
  const finalReceiptIdentity = await lstat(targetReceiptPath, { bigint: true });
  const finalReceiptRootIdentity = await lstat(receiptRoot, { bigint: true });
  if (
    second.path !== first.path ||
    second.sha256 !== first.sha256 ||
    canonicalJson(second.receipt) !== canonicalJson(first.receipt) ||
    !sameIdentity(initialReceiptIdentity, finalReceiptIdentity) ||
    !sameIdentity(initialReceiptRootIdentity, finalReceiptRootIdentity)
  ) {
    throw new Error("accepted Gate 6 receipt changed or was replaced while exporting");
  }
  const finalExportNames = await assertClosedDirectory(
    exportRoot,
    [descriptor.filename],
    "accepted export root",
    isTestOverride,
  );
  if (canonicalJson(finalExportNames) !== canonicalJson(initialExportNames)) {
    throw new Error("accepted export root changed while exporting");
  }
  const finalExportRootIdentity = await lstat(exportRoot, { bigint: true });
  if (!sameIdentity(initialExportRootIdentity, finalExportRootIdentity)) {
    throw new Error("accepted export root changed while exporting");
  }

  if (!isTestOverride) {
    const finalLockBytes = await readStableFile(FIXED_PRODUCTION_LOCK, {
      label: "fixed production mutation lock",
      maximumBytes: MAX_JSON_BYTES,
      allowedModes: [0o600],
      owner: 0,
    });
    const finalHostLock = parseCanonicalHostLock(finalLockBytes);
    validateHostLock(finalHostLock, first.receipt, context.targetDescriptorSha256, nowMs);
    validateStableHostLock(context.hostLock, finalHostLock);
  }

  const evidence = deepFreeze({
    schemaVersion: 1,
    phase,
    candidateSha: context.candidateSha,
    gate6Id: first.receipt.gate6Id,
    scope: first.receipt.scope,
    actionId: first.receipt.actionId,
    expectedStage: first.receipt.expectedStage,
    nextStage: first.receipt.nextStage,
    currentStage: finalBinding.currentStage,
    checkerName: first.receipt.checkerName,
    checkerExecutableSha256: first.receipt.checkerExecutableSha256,
    checkerArgumentsSha256: first.receipt.checkerArgumentsSha256,
    checkerOutputSha256: first.receipt.checkerOutputSha256,
    acceptedCheckerName: finalBinding.acceptedCheckerName,
    acceptedCheckerSha256: first.receipt.acceptedCheckerSha256,
    receiptSha256: first.sha256,
    checkedAt: first.receipt.checkedAt,
    actionStatus: finalBinding.actionStatus,
    afterEvidenceSha256: finalBinding.afterEvidenceSha256,
    runStatus: finalBinding.runStatus,
    slotOwnerType: finalBinding.slotOwnerType,
    slotOwnerId: finalBinding.slotOwnerId,
    slotState: finalBinding.slotState,
    slotVersion: finalBinding.slotVersion,
    monitorStatus: finalBinding.monitorStatus,
    monitorLeaseExpiresAt: finalBinding.monitorLeaseExpiresAt,
    supervisorStatus: finalBinding.supervisorStatus,
    supervisorLeaseExpiresAt: finalBinding.supervisorLeaseExpiresAt,
    preCloseSafety,
    producer,
  });
  scanSafeJson(evidence);
  const bytes = Buffer.from(canonicalJson(evidence), "utf8");
  if (bytes.length === 0 || bytes.length > MAX_JSON_BYTES) {
    throw new Error("accepted evidence export is oversized");
  }
  const outputPath = join(exportRoot, descriptor.filename);
  if (basename(outputPath) !== descriptor.filename) {
    throw new Error("accepted evidence export path is invalid");
  }
  if (initialExportNames.length === 1) {
    const existingBytes = await readStableFile(outputPath, {
      label: "existing accepted evidence export",
      maximumBytes: MAX_JSON_BYTES,
      allowedModes: [0o400],
      owner: expectedOwner(isTestOverride),
    });
    const existing = parseCanonicalJson(existingBytes, "existing accepted evidence export");
    const reconciled = reconcileExistingEvidence(existing, evidence, nowMs);
    const namesAfterExistingRead = await assertClosedDirectory(
      exportRoot,
      [descriptor.filename],
      "accepted export root",
      isTestOverride,
    );
    if (canonicalJson(namesAfterExistingRead) !== canonicalJson(initialExportNames)) {
      throw new Error("accepted export root changed while reconciling durable evidence");
    }
    return reconciled;
  }
  await writeAcceptedEvidence(outputPath, bytes, exportRoot, isTestOverride);
  await assertClosedDirectory(
    exportRoot,
    [descriptor.filename],
    "accepted export root",
    isTestOverride,
  );
  return evidence;
}

function parseCanonicalJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (canonicalJson(value) !== bytes.toString("utf8")) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function parseCanonicalHostLock(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8").trimEnd());
  } catch {
    throw new Error("fixed production mutation lock is not valid JSON");
  }
  if (bytes.toString("utf8") !== `${canonicalJson(value)}\n`) {
    throw new Error("fixed production mutation lock is not canonical JSON");
  }
  return value;
}

function deriveEnvelopeBinding(envelope, phase) {
  if (
    !isPlainObject(envelope) ||
    envelope.schemaVersion !== 1 ||
    envelope.runtimeEnvironment !== "production" ||
    !SAFE_ID.test(envelope.gate6Id ?? "") ||
    !COMMIT_SHA.test(envelope.candidateSha ?? "") ||
    !SHA256.test(envelope.productionTargetDescriptorSha256 ?? "") ||
    !Array.isArray(envelope.actionApprovals)
  ) {
    throw new Error("fixed Gate 6 envelope binding is invalid");
  }
  const scope = PHASES[phase].scope;
  const matches = envelope.actionApprovals.filter(
    (action) =>
      isPlainObject(action) &&
      action.gate6Id === envelope.gate6Id &&
      action.candidateSha === envelope.candidateSha &&
      action.runtimeEnvironment === "production" &&
      action.kind === "forward" &&
      action.scope === scope &&
      SAFE_ID.test(action.actionId ?? ""),
  );
  if (matches.length !== 1) throw new Error("fixed Gate 6 envelope action is missing or ambiguous");
  return Object.freeze({
    gate6Id: envelope.gate6Id,
    candidateSha: envelope.candidateSha,
    targetDescriptorSha256: envelope.productionTargetDescriptorSha256,
    scope,
    actionId: matches[0].actionId,
  });
}

function validateDbCapability(value, expectedTargetDescriptorSha256) {
  exactObject(
    value,
    [
      "schemaVersion",
      "host",
      "port",
      "database",
      "username",
      "sslServername",
      "targetDescriptorSha256",
      "passwordSha256",
      "caSha256",
    ],
    "accepted evidence database capability",
  );
  if (
    value.schemaVersion !== 1 ||
    typeof value.host !== "string" ||
    !DNS_NAME.test(value.host) ||
    isIP(value.host) !== 0 ||
    value.sslServername !== value.host ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    value.database !== "spx" ||
    !/^[A-Za-z0-9_$-]{1,64}$/.test(value.username ?? "") ||
    value.targetDescriptorSha256 !== expectedTargetDescriptorSha256 ||
    !SHA256.test(value.passwordSha256 ?? "") ||
    !SHA256.test(value.caSha256 ?? "")
  ) {
    throw new Error("accepted evidence database capability is invalid");
  }
  return value;
}

function renderMysqlDefaults(capability, password) {
  if (!/^[A-Za-z0-9_-]{32,1024}$/.test(password)) {
    throw new Error("accepted evidence database credential is invalid");
  }
  return [
    "[client]",
    `host=${capability.host}`,
    `port=${capability.port}`,
    `user=${capability.username}`,
    `password=${password}`,
    "database=spx",
    "protocol=TCP",
    "ssl-mode=VERIFY_IDENTITY",
    `ssl-ca=${FIXED_DB_CA}`,
    "",
  ].join("\n");
}

async function loadDbCapability(expectedTargetDescriptorSha256) {
  const [configBytes, passwordBytes, caBytes] = await Promise.all([
    readStableFile(FIXED_DB_CAPABILITY, {
      label: "accepted evidence database capability",
      maximumBytes: 16 * 1024,
      allowedModes: [0o400],
      owner: 0,
    }),
    readStableFile(FIXED_DB_PASSWORD, {
      label: "accepted evidence database credential",
      maximumBytes: 16 * 1024,
      allowedModes: [0o400],
      owner: 0,
    }),
    readStableFile(FIXED_DB_CA, {
      label: "accepted evidence database CA",
      maximumBytes: 1024 * 1024,
      allowedModes: [0o400, 0o444],
      owner: 0,
    }),
  ]);
  let config;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
  } catch {
    throw new Error("accepted evidence database capability is invalid");
  }
  const capability = validateDbCapability(config, expectedTargetDescriptorSha256);
  if (
    sha256(passwordBytes) !== capability.passwordSha256 ||
    sha256(caBytes) !== capability.caSha256 ||
    !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(caBytes.toString("utf8"))
  ) {
    throw new Error("accepted evidence database credential binding is invalid");
  }
  const password = passwordBytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,1024}$/.test(password)) {
    throw new Error("accepted evidence database credential is invalid");
  }
  return Object.freeze({ capability: Object.freeze({ ...capability }), password });
}

function parseMysqlJson(source, label) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_MYSQL_OUTPUT_BYTES) {
    throw new Error(`${label} output is invalid`);
  }
  const lines = source.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length !== 1) throw new Error(`${label} is missing or ambiguous`);
  try {
    const value = JSON.parse(lines[0]);
    if (!isPlainObject(value)) throw new Error("not-object");
    return value;
  } catch {
    throw new Error(`${label} output is invalid`);
  }
}

async function executeMysqlQuery(loaded, query, label) {
  await ensureExportRoot(FIXED_MYSQL_RUNTIME, false);
  const nonce = randomBytes(16).toString("hex");
  const defaultsPath = join(FIXED_MYSQL_RUNTIME, `accepted-evidence-${nonce}.cnf`);
  const defaultsBytes = Buffer.from(
    renderMysqlDefaults(loaded.capability, loaded.password),
    "utf8",
  );
  let handle;
  let created = false;
  try {
    handle = await open(
      defaultsPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o400,
    );
    created = true;
    await handle.writeFile(defaultsBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const result = spawnSync(
      FIXED_MYSQL,
      [
        `--defaults-extra-file=${defaultsPath}`,
        "--protocol=TCP",
        `--host=${loaded.capability.host}`,
        `--port=${loaded.capability.port}`,
        `--user=${loaded.capability.username}`,
        "--ssl-mode=VERIFY_IDENTITY",
        `--ssl-ca=${FIXED_DB_CA}`,
        "--database=spx",
        "--connect-timeout=5",
        "--batch",
        "--raw",
        "--skip-column-names",
        `--execute=${query}`,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: MAX_MYSQL_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
        env: {
          HOME: FIXED_MYSQL_RUNTIME,
          LANG: "C",
          LC_ALL: "C",
          XDG_CONFIG_HOME: FIXED_MYSQL_RUNTIME,
        },
      },
    );
    if (result?.error?.code === "ENOENT") {
      throw new Error("accepted evidence system mysql client is unavailable");
    }
    if (result?.error || result?.status !== 0 || typeof result.stdout !== "string") {
      throw new Error(`${label} query failed`);
    }
    return parseMysqlJson(result.stdout, label);
  } finally {
    await handle?.close();
    if (created) {
      await unlink(defaultsPath);
      await fsyncDirectory(FIXED_MYSQL_RUNTIME);
    }
  }
}

function sqlTimestamp(column) {
  return `CONCAT(DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.'), LEFT(DATE_FORMAT(${column}, '%f'), 3), 'Z')`;
}

function acceptedBindingQuery(gate6Id, scope, actionId) {
  for (const [value, label] of [
    [gate6Id, "Gate 6 ID"],
    [scope, "Gate 6 semantic scope"],
    [actionId, "Gate 6 semantic action ID"],
  ]) {
    if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  }
  return `SELECT JSON_OBJECT(
  'actionStatus', a.status,
  'afterEvidenceSha256', a.after_evidence_sha256,
  'runStatus', r.status,
  'currentStage', r.current_stage,
  'acceptedCheckerName', r.accepted_checker_name,
  'acceptedCheckerSha256', r.accepted_checker_sha256,
  'slotOwnerType', s.owner_type,
  'slotOwnerId', s.owner_id,
  'slotState', s.state,
  'slotVersion', s.version,
  'monitorStatus', r.monitor_status,
  'monitorLeaseExpiresAt', ${sqlTimestamp("r.monitor_lease_expires_at")},
  'supervisorStatus', r.supervisor_status,
  'supervisorLeaseExpiresAt', ${sqlTimestamp("r.supervisor_lease_expires_at")}
) FROM gate6_actions a
JOIN gate6_runs r ON r.gate6_id = a.gate6_id
JOIN gate6_environment_slots s ON s.environment = BINARY 'production'
WHERE a.gate6_id = BINARY '${gate6Id}'
  AND a.scope = BINARY '${scope}'
  AND a.action_id = BINARY '${actionId}'
LIMIT 2`;
}

function safetyBindingQuery(gate6Id) {
  if (typeof gate6Id !== "string" || !SAFE_ID.test(gate6Id)) {
    throw new Error("Gate 6 ID is invalid");
  }
  return `SELECT JSON_OBJECT(
  'gate6Id', r.gate6_id,
  'candidateSha', r.candidate_sha,
  'activePermitCount', (
    SELECT COUNT(*) FROM gate6_fault_permits p
    WHERE p.gate6_id = r.gate6_id AND p.status IN (BINARY 'armed', BINARY 'consumed')
  ),
  'uncompensatedWork', s.uncompensated_work
) FROM gate6_runs r
JOIN gate6_environment_slots s ON s.environment = BINARY 'production'
WHERE r.gate6_id = BINARY '${gate6Id}'
LIMIT 2`;
}

async function createSystemMysqlLedger(expectedTargetDescriptorSha256) {
  const loaded = await loadDbCapability(expectedTargetDescriptorSha256);
  return Object.freeze({
    async getAcceptedSemanticBinding(gate6Id, scope, actionId) {
      const value = await executeMysqlQuery(
        loaded,
        acceptedBindingQuery(gate6Id, scope, actionId),
        "accepted Gate 6 semantic binding",
      );
      if (Object.hasOwn(value, "slotVersion")) value.slotVersion = Number(value.slotVersion);
      return value;
    },
    async getAcceptedSemanticSafetyBinding(gate6Id) {
      const value = await executeMysqlQuery(
        loaded,
        safetyBindingQuery(gate6Id),
        "accepted Gate 6 pre-close safety binding",
      );
      if (Object.hasOwn(value, "activePermitCount")) {
        value.activePermitCount = Number(value.activePermitCount);
      }
      if (Object.hasOwn(value, "uncompensatedWork")) {
        value.uncompensatedWork = Number(value.uncompensatedWork);
      }
      return value;
    },
  });
}

async function loadFixedProductionContext(phase) {
  const [producerBytes, envelopeBytes, lockBytes] = await Promise.all([
    readStableFile(FIXED_PRODUCER_CONTEXT, {
      label: "fixed accepted evidence producer context",
      maximumBytes: MAX_JSON_BYTES,
      allowedModes: [0o400],
      owner: 0,
    }),
    readStableFile(FIXED_GATE6_ENVELOPE, {
      label: "fixed Gate 6 envelope",
      maximumBytes: MAX_ENVELOPE_BYTES,
      allowedModes: [0o400],
      owner: 0,
    }),
    readStableFile(FIXED_PRODUCTION_LOCK, {
      label: "fixed production mutation lock",
      maximumBytes: MAX_JSON_BYTES,
      allowedModes: [0o600],
      owner: 0,
    }),
  ]);
  const producer = parseCanonicalJson(producerBytes, "fixed accepted evidence producer context");
  const envelope = parseCanonicalJson(envelopeBytes, "fixed Gate 6 envelope");
  const hostLock = parseCanonicalHostLock(lockBytes);
  const binding = deriveEnvelopeBinding(envelope, phase);
  const receipt = await readGate6SemanticReceipt(PHASES[phase].scope);
  if (
    receipt.receipt.gate6Id !== binding.gate6Id ||
    receipt.receipt.scope !== binding.scope ||
    receipt.receipt.actionId !== binding.actionId
  ) {
    throw new Error("fixed Gate 6 receipt does not match the verified envelope action");
  }
  const now = new Date();
  validateHostLock(hostLock, receipt.receipt, binding.targetDescriptorSha256, now.getTime());
  const ledger = await createSystemMysqlLedger(binding.targetDescriptorSha256);
  return {
    [PRODUCTION_CONTEXT]: true,
    candidateSha: binding.candidateSha,
    targetDescriptorSha256: binding.targetDescriptorSha256,
    expectedReceiptBinding: binding,
    hostLock,
    ledger,
    producer,
    now,
  };
}

async function main() {
  const phase = parseAcceptedEvidenceCliArgs(process.argv.slice(2));
  const context = await loadFixedProductionContext(phase);
  await exportAcceptedSemanticEvidence(phase, context);
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write("gate6-accepted-evidence-export-failed\n");
    process.exitCode = 1;
  });
}
