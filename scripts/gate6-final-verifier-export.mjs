#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildProductionCanaryEvidenceFromReceipts,
  verifyProductionCanaryEvidence,
} from "./production-canary-evidence-check.mjs";
import { canonicalJson } from "./lib/evidence-artifact.mjs";
import {
  GATE6_SEMANTIC_RECEIPT_ROOT,
  readGate6SemanticReceipt,
} from "./lib/gate6-semantic-receipt.mjs";

export const FINAL_VERIFIER_PATH = "/var/lib/spx-production-rollout/evidence/final-verifier.json";
export const FINAL_VERIFIER_PRODUCER_CONTEXT =
  "/var/lib/spx-production-rollout/final-verifier-producer-context.json";

const FINAL_VERIFIER_ROOT = dirname(FINAL_VERIFIER_PATH);
const FIXED_PRODUCTION_LOCK = "/var/lib/spx-production-mutation/lock.json";
const FIXED_MYSQL = "/usr/bin/mysql";
const FIXED_DB_CAPABILITY = "/var/lib/spx-gate6/gate6-control-db.json";
const FIXED_DB_PASSWORD = "/var/lib/spx-gate6/secrets/gate6-control-db-password";
const FIXED_DB_CA = "/var/lib/spx-gate6/config/db-ca.pem";
const FIXED_MYSQL_RUNTIME = "/run/spx-gate6-final-verifier";
const MAX_JSON_BYTES = 512 * 1024;
const MAX_MYSQL_OUTPUT_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DNS_NAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const PRODUCER_FIELDS = Object.freeze([
  "repository",
  "environment",
  "workflow",
  "workflowSha",
  "workflowFileSha256",
]);
const RECEIPTS = Object.freeze({
  dbTransition: "stage-accept-db-transition",
  task9: "stage-accept-task9",
  worker: "stage-accept-worker",
  phase3: "stage-accept-phase3",
  phase4: "stage-accept-phase4",
  preClose: "stage-accept-pre-close",
});
const RECEIPT_NAMES = Object.freeze(
  Object.values(RECEIPTS)
    .map((scope) => `${scope}.json`)
    .sort(),
);
const PRODUCTION_CONTEXT = Symbol("gate6-final-verifier-production-context");

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

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function modeOf(status) {
  return Number(status.mode) & 0o777;
}

function expectedOwner(isTestOverride) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return null;
  return isTestOverride ? process.getuid() : 0;
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
  return status;
}

async function readStableFile(
  path,
  { label, maximumBytes, allowedModes, owner, allowTrailingNewline = false },
) {
  await assertNoSymlinkParents(path, label);
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0n ||
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
    if (bytes.length === 0 || bytes.length > maximumBytes) {
      throw new Error(`${label} exceeds its size limit`);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(after, pathAfter)) {
      throw new Error(`${label} changed during stable read`);
    }
    if (!allowTrailingNewline && bytes.at(-1) === 0x0a) {
      throw new Error(`${label} must not contain a trailing newline`);
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

async function ensureDirectory(root, label, isTestOverride) {
  try {
    await mkdir(root, { mode: 0o700, recursive: false });
    await fsyncDirectory(dirname(root));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return validateDirectory(root, label, isTestOverride);
}

async function closedDirectory(root, allowedNames, label, isTestOverride) {
  await validateDirectory(root, label, isTestOverride);
  const allowed = new Set(allowedNames);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !allowed.has(entry.name)) {
      throw new Error(`${label} contains an unexpected or unsafe entry`);
    }
    const status = await lstat(join(root, entry.name), { bigint: true });
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`${label} contains an unsafe entry`);
    }
    if (process.platform !== "win32" && modeOf(status) !== 0o400) {
      throw new Error(`${label} files must have mode 0400`);
    }
    const owner = expectedOwner(isTestOverride);
    if (owner !== null && Number(status.uid) !== owner) {
      throw new Error(`${label} files must be root-owned`);
    }
  }
  return entries.map((entry) => entry.name).sort();
}

function parseCanonicalJson(bytes, label, allowTrailingNewline = false) {
  const text = bytes.toString("utf8");
  const source = allowTrailingNewline && text.endsWith("\n") ? text.slice(0, -1) : text;
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (canonicalJson(value) !== source || text !== `${source}${allowTrailingNewline ? "\n" : ""}`) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function validateProducer(value) {
  exactObject(value, PRODUCER_FIELDS, "final-verifier producer");
  if (
    value.repository !== "fastest4u/SPX" ||
    value.environment !== "production" ||
    value.workflow !== ".github/workflows/gate6-final-verifier-exporter.yml" ||
    !COMMIT_SHA.test(value.workflowSha ?? "") ||
    !SHA256.test(value.workflowFileSha256 ?? "")
  ) {
    throw new Error("final-verifier producer metadata is invalid");
  }
  return deepFreeze(structuredClone(value));
}

function validateSnapshot(snapshot, gate6Id, nowMs) {
  if (
    !isPlainObject(snapshot) ||
    !isPlainObject(snapshot.run) ||
    !isPlainObject(snapshot.slot) ||
    !Array.isArray(snapshot.actions)
  ) {
    throw new Error("Gate 6 final-verifier snapshot is invalid");
  }
  const { run, slot } = snapshot;
  if (
    run.gate6Id !== gate6Id ||
    run.releaseEnvironment !== "production" ||
    run.runtimeEnvironment !== "production" ||
    run.drillMode !== "supervised-production" ||
    run.composeProject !== "spx-production" ||
    !COMMIT_SHA.test(run.candidateSha ?? "") ||
    !IMAGE_DIGEST.test(run.candidateImageDigest ?? "") ||
    !SHA256.test(run.productionTargetDescriptorSha256 ?? "") ||
    !SHA256.test(run.operatorBundleSha256 ?? "") ||
    run.status !== "sealed-verifying" ||
    run.currentStage !== "sealed-verifying" ||
    !Number.isSafeInteger(run.stageVersion) ||
    run.stageVersion < 1 ||
    run.acceptedCheckerName !== "gate6-seal-close" ||
    !SHA256.test(run.acceptedCheckerSha256 ?? "") ||
    !SHA256.test(run.terminalEvidenceSha256 ?? "") ||
    run.acceptedCheckerSha256 !== run.terminalEvidenceSha256 ||
    run.monitorStatus !== "green" ||
    run.supervisorStatus !== "green"
  ) {
    throw new Error("Gate 6 final-verifier run is not safely sealed");
  }
  for (const [value, label] of [
    [run.monitorLeaseExpiresAt, "monitor lease"],
    [run.supervisorLeaseExpiresAt, "supervisor lease"],
    [run.emergencySupervisorLeaseExpiresAt, "emergency supervisor lease"],
    [run.expiresAt, "run expiry"],
  ]) {
    if (exactIso(value, `Gate 6 final-verifier ${label}`) <= nowMs) {
      throw new Error(`Gate 6 final-verifier ${label} is expired`);
    }
  }
  if (
    slot.ownerType !== "gate6" ||
    slot.ownerId !== gate6Id ||
    slot.state !== "sealed-verifying" ||
    !Number.isSafeInteger(slot.version) ||
    slot.version < 1 ||
    slot.uncompensatedWork !== false ||
    slot.releaseSha !== run.candidateSha ||
    slot.targetDescriptorSha256 !== run.productionTargetDescriptorSha256 ||
    slot.operatorBundleSha256 !== run.operatorBundleSha256 ||
    exactIso(slot.heartbeatAt, "Gate 6 final-verifier slot heartbeat") > nowMs ||
    exactIso(slot.expiresAt, "Gate 6 final-verifier slot expiry") <= nowMs
  ) {
    throw new Error("Gate 6 final-verifier slot is not safely sealed");
  }
  if (!Number.isSafeInteger(snapshot.activePermitCount) || snapshot.activePermitCount !== 0) {
    throw new Error("Gate 6 final-verifier active permit remains");
  }
  return snapshot;
}

function snapshotStableCore(snapshot) {
  const clone = structuredClone(snapshot);
  delete clone.run.monitorLeaseExpiresAt;
  delete clone.run.supervisorLeaseExpiresAt;
  delete clone.slot.heartbeatAt;
  clone.actions.sort((left, right) =>
    `${left.scope}\0${left.actionId}`.localeCompare(`${right.scope}\0${right.actionId}`),
  );
  return clone;
}

function validateStableSnapshots(initial, final) {
  if (canonicalJson(snapshotStableCore(final)) !== canonicalJson(snapshotStableCore(initial))) {
    throw new Error("Gate 6 sealed snapshot changed while producing the final verifier");
  }
  if (
    exactIso(final.run.monitorLeaseExpiresAt, "final monitor lease") <
      exactIso(initial.run.monitorLeaseExpiresAt, "initial monitor lease") ||
    exactIso(final.run.supervisorLeaseExpiresAt, "final supervisor lease") <
      exactIso(initial.run.supervisorLeaseExpiresAt, "initial supervisor lease") ||
    exactIso(final.slot.heartbeatAt, "final slot heartbeat") <
      exactIso(initial.slot.heartbeatAt, "initial slot heartbeat")
  ) {
    throw new Error("Gate 6 sealed leases moved backwards while producing the final verifier");
  }
}

function validateHostLock(lock, snapshot, nowMs) {
  if (
    !isPlainObject(lock) ||
    lock.schemaVersion !== 3 ||
    lock.state !== "gate6-active" ||
    lock.targetHash !== snapshot.run.productionTargetDescriptorSha256 ||
    !isPlainObject(lock.protectedInstall) ||
    lock.protectedInstall.releaseSha !== snapshot.run.candidateSha ||
    lock.protectedInstall.targetDescriptorSha256 !==
      snapshot.run.productionTargetDescriptorSha256 ||
    lock.protectedInstall.operatorBundleSha256 !== snapshot.run.operatorBundleSha256 ||
    !Number.isSafeInteger(lock.protectedInstall.slotVersion) ||
    lock.protectedInstall.slotVersion < 1 ||
    !isPlainObject(lock.handoff) ||
    lock.handoff.gate6Id !== snapshot.run.gate6Id ||
    lock.handoff.transferTokenSha256 !== lock.protectedInstall.transferTokenSha256 ||
    !Number.isSafeInteger(lock.handoff.expectedSlotVersion) ||
    lock.handoff.expectedSlotVersion !== lock.protectedInstall.slotVersion ||
    !Number.isSafeInteger(lock.handoff.slotVersion) ||
    lock.handoff.slotVersion !== lock.handoff.expectedSlotVersion + 1 ||
    lock.handoff.slotVersion > snapshot.slot.version ||
    !isPlainObject(lock.lease) ||
    typeof lock.lease.owner !== "string" ||
    lock.lease.owner.length === 0 ||
    exactIso(lock.lease.heartbeatAt, "production host-lock heartbeat") > nowMs ||
    exactIso(lock.lease.expiresAt, "production host-lock lease expiry") <= nowMs ||
    !Number.isSafeInteger(lock.revision) ||
    lock.revision < 1 ||
    exactIso(lock.updatedAt, "production host-lock update") > nowMs
  ) {
    throw new Error("production host lock does not bind the sealed Gate 6 run");
  }
}

function stableHostLockCore(lock) {
  const value = structuredClone(lock);
  delete value.lease;
  delete value.revision;
  delete value.updatedAt;
  return value;
}

function validateStableHostLocks(initial, final) {
  if (canonicalJson(stableHostLockCore(final)) !== canonicalJson(stableHostLockCore(initial))) {
    throw new Error("production host lock changed while producing the final verifier");
  }
  if (
    final.revision < initial.revision ||
    exactIso(final.updatedAt, "final production host-lock update") <
      exactIso(initial.updatedAt, "initial production host-lock update") ||
    exactIso(final.lease.heartbeatAt, "final production host-lock heartbeat") <
      exactIso(initial.lease.heartbeatAt, "initial production host-lock heartbeat") ||
    exactIso(final.lease.expiresAt, "final production host-lock lease") <
      exactIso(initial.lease.expiresAt, "initial production host-lock lease")
  ) {
    throw new Error("production host-lock revision or lease moved backwards");
  }
}

async function readReceiptSet(root, gate6Id) {
  const values = {};
  for (const [name, scope] of Object.entries(RECEIPTS)) {
    const loaded = await readGate6SemanticReceipt(scope, { root });
    if (loaded.receipt.gate6Id !== gate6Id) {
      throw new Error(`Gate 6 final-verifier receipt identity mismatch: ${scope}`);
    }
    values[name] = loaded;
  }
  return values;
}

function receiptBodies(values) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      { receipt: value.receipt, sha256: value.sha256 },
    ]),
  );
}

function validateStableReceipts(initial, final) {
  for (const name of Object.keys(RECEIPTS)) {
    if (
      final[name].path !== initial[name].path ||
      final[name].sha256 !== initial[name].sha256 ||
      canonicalJson(final[name].receipt) !== canonicalJson(initial[name].receipt)
    ) {
      throw new Error(`Gate 6 final-verifier receipt changed: ${name}`);
    }
  }
}

async function writeFinalVerifier(path, bytes, root, isTestOverride) {
  let created = false;
  let handle;
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
    label: "durable final-verifier artifact",
    maximumBytes: MAX_JSON_BYTES,
    allowedModes: [0o400],
    owner: expectedOwner(isTestOverride),
  });
  if (!reopened.equals(bytes) || sha256(reopened) !== sha256(bytes)) {
    throw new Error("final-verifier artifact conflicts with durable canonical bytes");
  }
}

export function parseFinalVerifierCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("final-verifier CLI is zero-argument only");
  }
  return {};
}

export async function exportFinalVerifier(context = {}) {
  const isTestOverride = process.env.NODE_ENV === "test";
  if (!isPlainObject(context)) throw new Error("final-verifier context is invalid");
  if (!isTestOverride && context[PRODUCTION_CONTEXT] !== true) {
    throw new Error("final-verifier requires the fixed production context");
  }
  const gate6Id = context.gate6Id;
  if (typeof gate6Id !== "string" || !SAFE_ID.test(gate6Id)) {
    throw new Error("final-verifier Gate 6 ID is invalid");
  }
  if (
    !isPlainObject(context.ledger) ||
    typeof context.ledger.getFinalVerifierSnapshot !== "function" ||
    typeof context.readHostLock !== "function"
  ) {
    throw new Error("final-verifier read adapters are invalid");
  }
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) {
    throw new Error("final-verifier clock is invalid");
  }
  const nowMs = context.now.getTime();
  const producer = validateProducer(context.producer);
  const receiptRoot = resolve(isTestOverride ? context.receiptRoot : GATE6_SEMANTIC_RECEIPT_ROOT);
  const exportRoot = resolve(isTestOverride ? context.exportRoot : FINAL_VERIFIER_ROOT);
  if (
    isTestOverride &&
    (typeof context.receiptRoot !== "string" || typeof context.exportRoot !== "string")
  ) {
    throw new Error("final-verifier test roots are invalid");
  }
  if (
    !isTestOverride &&
    (receiptRoot !== resolve(GATE6_SEMANTIC_RECEIPT_ROOT) ||
      exportRoot !== resolve(FINAL_VERIFIER_ROOT))
  ) {
    throw new Error("final-verifier roots are fixed");
  }
  const outputPath = join(exportRoot, basename(FINAL_VERIFIER_PATH));
  if (basename(outputPath) !== "final-verifier.json") {
    throw new Error("final-verifier output path is invalid");
  }

  await ensureDirectory(exportRoot, "final-verifier export root", isTestOverride);
  const initialExportNames = await closedDirectory(
    exportRoot,
    ["final-verifier.json"],
    "final-verifier export root",
    isTestOverride,
  );
  if (initialExportNames.length > 1) {
    throw new Error("final-verifier export root contains conflicting artifacts");
  }
  const receiptRootIdentity = await validateDirectory(
    receiptRoot,
    "Gate 6 semantic receipt root",
    isTestOverride,
  );
  const initialReceiptNames = await closedDirectory(
    receiptRoot,
    RECEIPT_NAMES,
    "Gate 6 semantic receipt root",
    isTestOverride,
  );
  if (canonicalJson(initialReceiptNames) !== canonicalJson(RECEIPT_NAMES)) {
    throw new Error("Gate 6 final-verifier receipt set is missing or unexpected");
  }

  const initialSnapshot = validateSnapshot(
    await context.ledger.getFinalVerifierSnapshot(gate6Id),
    gate6Id,
    nowMs,
  );
  const initialLock = await context.readHostLock();
  validateHostLock(initialLock, initialSnapshot, nowMs);
  const initialReceipts = await readReceiptSet(receiptRoot, gate6Id);
  const candidateEvidence = buildProductionCanaryEvidenceFromReceipts(
    initialSnapshot,
    receiptBodies(initialReceipts),
  );
  const verified = verifyProductionCanaryEvidence(candidateEvidence, { phase: "final" });

  const finalSnapshot = validateSnapshot(
    await context.ledger.getFinalVerifierSnapshot(gate6Id),
    gate6Id,
    nowMs,
  );
  validateStableSnapshots(initialSnapshot, finalSnapshot);
  const finalLock = await context.readHostLock();
  validateHostLock(finalLock, finalSnapshot, nowMs);
  validateStableHostLocks(initialLock, finalLock);
  const finalReceiptNames = await closedDirectory(
    receiptRoot,
    RECEIPT_NAMES,
    "Gate 6 semantic receipt root",
    isTestOverride,
  );
  if (canonicalJson(finalReceiptNames) !== canonicalJson(initialReceiptNames)) {
    throw new Error("Gate 6 final-verifier receipt root changed");
  }
  const finalReceipts = await readReceiptSet(receiptRoot, gate6Id);
  validateStableReceipts(initialReceipts, finalReceipts);
  const finalReceiptRootIdentity = await lstat(receiptRoot, { bigint: true });
  if (!sameIdentity(receiptRootIdentity, finalReceiptRootIdentity)) {
    throw new Error("Gate 6 final-verifier receipt root was replaced or changed");
  }
  const finalExportNames = await closedDirectory(
    exportRoot,
    ["final-verifier.json"],
    "final-verifier export root",
    isTestOverride,
  );
  if (canonicalJson(finalExportNames) !== canonicalJson(initialExportNames)) {
    throw new Error("final-verifier export root changed before publish");
  }

  const result = deepFreeze({ ...verified, producer });
  const bytes = Buffer.from(canonicalJson(result), "utf8");
  if (bytes.length === 0 || bytes.length > MAX_JSON_BYTES) {
    throw new Error("final-verifier artifact is oversized");
  }
  await writeFinalVerifier(outputPath, bytes, exportRoot, isTestOverride);
  const publishedNames = await closedDirectory(
    exportRoot,
    ["final-verifier.json"],
    "final-verifier export root",
    isTestOverride,
  );
  if (canonicalJson(publishedNames) !== canonicalJson(["final-verifier.json"])) {
    throw new Error("final-verifier export root is not closed after publish");
  }
  return result;
}

function validateProducerContext(value) {
  exactObject(
    value,
    ["schemaVersion", "gate6Id", "candidateSha", "productionTargetDescriptorSha256", "producer"],
    "fixed final-verifier producer context",
  );
  if (
    value.schemaVersion !== 1 ||
    !SAFE_ID.test(value.gate6Id ?? "") ||
    !COMMIT_SHA.test(value.candidateSha ?? "") ||
    !SHA256.test(value.productionTargetDescriptorSha256 ?? "")
  ) {
    throw new Error("fixed final-verifier producer context is invalid");
  }
  validateProducer(value.producer);
  return value;
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
    "final-verifier database capability",
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
    value.database !== "SPX" ||
    !/^[A-Za-z0-9_$-]{1,64}$/.test(value.username ?? "") ||
    value.targetDescriptorSha256 !== expectedTargetDescriptorSha256 ||
    !SHA256.test(value.passwordSha256 ?? "") ||
    !SHA256.test(value.caSha256 ?? "")
  ) {
    throw new Error("final-verifier database capability is invalid");
  }
  return value;
}

function renderMysqlDefaults(capability, password) {
  if (!/^[A-Za-z0-9_-]{32,1024}$/.test(password)) {
    throw new Error("final-verifier database credential is invalid");
  }
  return [
    "[client]",
    `host=${capability.host}`,
    `port=${capability.port}`,
    `user=${capability.username}`,
    `password=${password}`,
    "database=SPX",
    "protocol=TCP",
    "ssl-mode=VERIFY_IDENTITY",
    `ssl-ca=${FIXED_DB_CA}`,
    "",
  ].join("\n");
}

async function loadDbCapability(expectedTargetDescriptorSha256) {
  const [configBytes, passwordBytes, caBytes] = await Promise.all([
    readStableFile(FIXED_DB_CAPABILITY, {
      label: "final-verifier database capability",
      maximumBytes: 16 * 1024,
      allowedModes: [0o400],
      owner: 0,
      allowTrailingNewline: true,
    }),
    readStableFile(FIXED_DB_PASSWORD, {
      label: "final-verifier database credential",
      maximumBytes: 16 * 1024,
      allowedModes: [0o400],
      owner: 0,
      allowTrailingNewline: true,
    }),
    readStableFile(FIXED_DB_CA, {
      label: "final-verifier database CA",
      maximumBytes: 1024 * 1024,
      allowedModes: [0o400, 0o444],
      owner: 0,
      allowTrailingNewline: true,
    }),
  ]);
  let config;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
  } catch {
    throw new Error("final-verifier database capability is invalid");
  }
  const capability = validateDbCapability(config, expectedTargetDescriptorSha256);
  if (
    sha256(passwordBytes) !== capability.passwordSha256 ||
    sha256(caBytes) !== capability.caSha256 ||
    !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(caBytes.toString("utf8"))
  ) {
    throw new Error("final-verifier database credential binding is invalid");
  }
  const password = passwordBytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,1024}$/.test(password)) {
    throw new Error("final-verifier database credential is invalid");
  }
  return Object.freeze({ capability: Object.freeze({ ...capability }), password });
}

function sqlTimestamp(column) {
  return `CONCAT(DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.'), LEFT(DATE_FORMAT(${column}, '%f'), 3), 'Z')`;
}

function finalSnapshotQuery(gate6Id) {
  if (!SAFE_ID.test(gate6Id ?? "")) throw new Error("final-verifier Gate 6 ID is invalid");
  return `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION READ ONLY;
START TRANSACTION WITH CONSISTENT SNAPSHOT;
SELECT JSON_OBJECT(
  'run', JSON_OBJECT(
    'gate6Id', r.gate6_id,
    'releaseEnvironment', r.release_environment,
    'runtimeEnvironment', r.runtime_environment,
    'drillMode', r.drill_mode,
    'composeProject', r.compose_project,
    'candidateSha', r.candidate_sha,
    'candidateImageDigest', r.candidate_image_digest,
    'productionTargetDescriptorSha256', r.production_target_descriptor_sha256,
    'operatorBundleSha256', r.operator_bundle_sha256,
    'status', r.status,
    'currentStage', r.current_stage,
    'stageVersion', r.stage_version,
    'acceptedCheckerName', r.accepted_checker_name,
    'acceptedCheckerSha256', r.accepted_checker_sha256,
    'terminalEvidenceSha256', r.terminal_evidence_sha256,
    'monitorStatus', r.monitor_status,
    'monitorLeaseExpiresAt', ${sqlTimestamp("r.monitor_lease_expires_at")},
    'supervisorStatus', r.supervisor_status,
    'supervisorLeaseExpiresAt', ${sqlTimestamp("r.supervisor_lease_expires_at")},
    'emergencySupervisorLeaseExpiresAt', ${sqlTimestamp("r.emergency_supervisor_lease_expires_at")},
    'expiresAt', ${sqlTimestamp("r.expires_at")}
  ),
  'slot', JSON_OBJECT(
    'ownerType', s.owner_type,
    'ownerId', s.owner_id,
    'state', s.state,
    'version', s.version,
    'uncompensatedWork', s.uncompensated_work,
    'releaseSha', s.release_sha,
    'targetDescriptorSha256', s.target_descriptor_sha256,
    'operatorBundleSha256', s.operator_bundle_sha256,
    'heartbeatAt', ${sqlTimestamp("s.heartbeat_at")},
    'expiresAt', ${sqlTimestamp("s.expires_at")}
  ),
  'actions', COALESCE((
    SELECT JSON_ARRAYAGG(JSON_OBJECT(
      'scope', a.scope,
      'actionId', a.action_id,
      'kind', a.kind,
      'pairedActionId', a.paired_action_id,
      'requiredStage', a.required_stage,
      'requiredCheckerSha256', a.required_checker_sha256,
      'status', a.status,
      'afterEvidenceSha256', a.after_evidence_sha256,
      'completedAt', IF(a.completed_at IS NULL, NULL, ${sqlTimestamp("a.completed_at")})
    )) FROM gate6_actions a WHERE a.gate6_id = r.gate6_id
  ), JSON_ARRAY()),
  'activePermitCount', (
    SELECT COUNT(*) FROM gate6_fault_permits p
    WHERE p.gate6_id = r.gate6_id AND p.status IN (BINARY 'armed', BINARY 'consumed')
  )
) FROM gate6_runs r
JOIN gate6_environment_slots s ON s.environment = BINARY 'production'
WHERE r.gate6_id = BINARY '${gate6Id}'
LIMIT 2;
COMMIT;`;
}

function normalizeSystemSnapshot(value) {
  if (!isPlainObject(value) || !isPlainObject(value.run) || !isPlainObject(value.slot)) {
    throw new Error("final-verifier database snapshot is invalid");
  }
  value.run.stageVersion = Number(value.run.stageVersion);
  value.slot.version = Number(value.slot.version);
  value.slot.uncompensatedWork = Number(value.slot.uncompensatedWork) === 1;
  value.activePermitCount = Number(value.activePermitCount);
  if (!Array.isArray(value.actions)) throw new Error("final-verifier actions are invalid");
  value.actions.sort((left, right) =>
    `${left.scope}\0${left.actionId}`.localeCompare(`${right.scope}\0${right.actionId}`),
  );
  return value;
}

async function executeSnapshotQuery(loaded, gate6Id) {
  await ensureDirectory(FIXED_MYSQL_RUNTIME, "final-verifier MySQL runtime", false);
  const existing = await readdir(FIXED_MYSQL_RUNTIME);
  if (existing.length !== 0) {
    throw new Error("final-verifier MySQL runtime contains an orphan credential file");
  }
  const defaultsPath = join(
    FIXED_MYSQL_RUNTIME,
    `final-verifier-${randomBytes(16).toString("hex")}.cnf`,
  );
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
        "--database=SPX",
        "--connect-timeout=5",
        "--batch",
        "--raw",
        "--skip-column-names",
        `--execute=${finalSnapshotQuery(gate6Id)}`,
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
      throw new Error("final-verifier system mysql client is unavailable");
    }
    if (result?.error || result?.status !== 0 || typeof result.stdout !== "string") {
      throw new Error("final-verifier consistent snapshot query failed");
    }
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_MYSQL_OUTPUT_BYTES) {
      throw new Error("final-verifier consistent snapshot output is oversized");
    }
    const lines = result.stdout.split(/\r?\n/).filter((line) => line !== "");
    if (lines.length !== 1) {
      throw new Error("final-verifier consistent snapshot is missing or ambiguous");
    }
    try {
      return normalizeSystemSnapshot(JSON.parse(lines[0]));
    } catch (error) {
      if (error?.message?.startsWith("final-verifier")) throw error;
      throw new Error("final-verifier consistent snapshot output is invalid");
    }
  } finally {
    await handle?.close();
    if (created) {
      await unlink(defaultsPath);
      await fsyncDirectory(FIXED_MYSQL_RUNTIME);
    }
  }
}

async function loadFixedProductionContext() {
  const contextBytes = await readStableFile(FINAL_VERIFIER_PRODUCER_CONTEXT, {
    label: "fixed final-verifier producer context",
    maximumBytes: MAX_JSON_BYTES,
    allowedModes: [0o400],
    owner: 0,
  });
  const fixed = validateProducerContext(
    parseCanonicalJson(contextBytes, "fixed final-verifier producer context"),
  );
  const loadedDb = await loadDbCapability(fixed.productionTargetDescriptorSha256);
  return {
    [PRODUCTION_CONTEXT]: true,
    gate6Id: fixed.gate6Id,
    producer: fixed.producer,
    now: new Date(),
    ledger: Object.freeze({
      async getFinalVerifierSnapshot(gate6Id) {
        if (gate6Id !== fixed.gate6Id) {
          throw new Error("fixed final-verifier Gate 6 ID changed");
        }
        const snapshot = await executeSnapshotQuery(loadedDb, gate6Id);
        if (
          snapshot.run.candidateSha !== fixed.candidateSha ||
          snapshot.run.productionTargetDescriptorSha256 !== fixed.productionTargetDescriptorSha256
        ) {
          throw new Error("fixed final-verifier release binding mismatch");
        }
        return snapshot;
      },
    }),
    async readHostLock() {
      const bytes = await readStableFile(FIXED_PRODUCTION_LOCK, {
        label: "fixed production host lock",
        maximumBytes: MAX_JSON_BYTES,
        allowedModes: [0o600],
        owner: 0,
        allowTrailingNewline: true,
      });
      return parseCanonicalJson(bytes, "fixed production host lock", true);
    },
  };
}

async function main() {
  parseFinalVerifierCliArgs(process.argv.slice(2));
  const context = await loadFixedProductionContext();
  await exportFinalVerifier(context);
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write("gate6-final-verifier-export-failed\n");
    process.exitCode = 1;
  });
}
