#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_STATE_DIR = "/var/lib/spx-production-mutation";
const LOCK_FILE = "lock.json";
const UPDATE_GUARD_DIRECTORY = ".update-guard";
const UPDATE_GUARD_TTL_MS = 120_000;
const MAX_LOCK_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ALLOWED_OPERATION_TYPES = new Set([
  "adoption",
  "install",
  "gate6",
  "emergency",
  "rollback",
  "reconcile",
]);
const ALLOWED_STATES = new Set([
  "adopting",
  "installing",
  "installed-awaiting-gate6",
  "handoff-pending",
  "gate6-active",
  "recovering",
  "terminal",
]);
const INITIAL_STATE_BY_OPERATION = new Map([
  ["adoption", "adopting"],
  ["install", "installing"],
  ["gate6", "gate6-active"],
  ["emergency", "gate6-active"],
  ["rollback", "recovering"],
  ["reconcile", "recovering"],
]);
const TERMINAL_KINDS = new Set(["healthy-baseline", "rollback-restored"]);
const PROTECTED_INSTALL_WATCHDOG_OWNER = "systemd:spx-protected-install-watchdog";

function fail(code) {
  throw new Error(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, code = "production-mutation-lock-invalid") {
  if (!isObject(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function assertPattern(value, pattern, code = "production-mutation-lock-invalid") {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
}

function isoFromMs(value) {
  if (!Number.isFinite(value)) fail("production-mutation-lock-invalid");
  return new Date(value).toISOString();
}

function parseIso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail("production-mutation-lock-invalid");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("production-mutation-lock-invalid");
  }
  return milliseconds;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function secureDirectory(stateDir, allowNonRoot) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let stat;
  try {
    stat = lstatSync(stateDir);
  } catch {
    fail("production-mutation-lock-storage-invalid");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    fail("production-mutation-lock-storage-invalid");
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) fail("production-mutation-lock-storage-invalid");
    if (!allowNonRoot && stat.uid !== 0) fail("production-mutation-lock-storage-invalid");
  }
}

function fsyncDirectory(path) {
  // Windows does not permit fsync on directory handles. Production is Linux;
  // file data is still flushed in Windows-hosted contract tests.
  if (process.platform === "win32") return;
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (written <= 0) fail("production-mutation-lock-write-failed");
    offset += written;
  }
}

function writeNewFileDurably(path, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function replaceFileDurably(path, value) {
  const temporary = join(dirname(path), `.${LOCK_FILE}.${process.pid}.${randomUUID()}`);
  try {
    writeNewFileDurably(temporary, value);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
        fsyncDirectory(dirname(path));
      } catch {
        // A leftover temp file is inert and retains fail-closed permissions.
      }
    }
  }
}

function removeStaleGuardDirectory(path) {
  const entries = readdirSync(path);
  if (entries.some((entry) => entry !== "guard.json")) {
    fail("production-mutation-lock-storage-invalid");
  }
  const record = join(path, "guard.json");
  if (existsSync(record)) unlinkSync(record);
  rmdirSync(path);
}

function acquireUpdateGuard(stateDir, allowNonRoot) {
  const path = join(stateDir, UPDATE_GUARD_DIRECTORY);
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeNewFileDurably(join(path, "guard.json"), {
        schemaVersion: 1,
        owner,
        createdAt: new Date().toISOString(),
      });
      fsyncDirectory(stateDir);
      return { path, owner };
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
        (process.platform !== "win32" && !allowNonRoot && stat.uid !== 0)
      ) {
        fail("production-mutation-lock-storage-invalid");
      }
      if (Date.now() - stat.mtimeMs <= UPDATE_GUARD_TTL_MS) {
        fail("production-mutation-lock-busy");
      }
      const stalePath = join(stateDir, `.update-guard.stale.${randomUUID()}`);
      try {
        renameSync(path, stalePath);
        fsyncDirectory(stateDir);
      } catch {
        fail("production-mutation-lock-busy");
      }
      removeStaleGuardDirectory(stalePath);
      fsyncDirectory(stateDir);
    }
  }
  fail("production-mutation-lock-busy");
}

function releaseUpdateGuard(stateDir, guard, allowNonRoot) {
  const recordPath = join(guard.path, "guard.json");
  const record = readSecureJson(recordPath, allowNonRoot);
  if (
    !isObject(record) ||
    record.schemaVersion !== 1 ||
    record.owner !== guard.owner ||
    typeof record.createdAt !== "string"
  ) {
    fail("production-mutation-lock-storage-invalid");
  }
  unlinkSync(recordPath);
  rmdirSync(guard.path);
  fsyncDirectory(stateDir);
}

async function withUpdateGuard(stateDir, allowNonRoot, operation) {
  const guard = acquireUpdateGuard(stateDir, allowNonRoot);
  let operationError;
  let result;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    releaseUpdateGuard(stateDir, guard, allowNonRoot);
  } catch (releaseError) {
    if (!operationError) throw releaseError;
  }
  if (operationError) throw operationError;
  return result;
}

function readSecureJson(path, allowNonRoot) {
  let descriptor;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size <= 0n ||
      before.size > BigInt(MAX_LOCK_BYTES) ||
      (process.platform !== "win32" && Number(before.mode & 0o077n) !== 0) ||
      (process.platform !== "win32" && !allowNonRoot && before.uid !== 0n)
    ) {
      fail("production-mutation-lock-invalid");
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      fail("production-mutation-lock-invalid");
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.length ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      fail("production-mutation-lock-invalid");
    }
    const source = bytes.toString("utf8");
    const parsed = JSON.parse(source);
    if (`${canonicalJson(parsed)}\n` !== source) fail("production-mutation-lock-invalid");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "production-mutation-lock-invalid") throw error;
    fail("production-mutation-lock-invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateRollbackIdentity(value) {
  assertExactKeys(value, ["project", "releaseHash", "imageDigest", "serviceSetHash", "configHash"]);
  if (value.project !== "spx" && value.project !== "spx-production") {
    fail("production-mutation-lock-invalid");
  }
  assertPattern(value.releaseHash, SHA256_PATTERN);
  assertPattern(value.imageDigest, IMAGE_DIGEST_PATTERN);
  assertPattern(value.serviceSetHash, SHA256_PATTERN);
  assertPattern(value.configHash, SHA256_PATTERN);
}

function validateLease(value) {
  assertExactKeys(value, ["owner", "heartbeatAt", "expiresAt"]);
  assertPattern(value.owner, ID_PATTERN);
  const heartbeat = parseIso(value.heartbeatAt);
  const expiry = parseIso(value.expiresAt);
  if (expiry <= heartbeat || expiry - heartbeat > 24 * 60 * 60 * 1_000) {
    fail("production-mutation-lock-invalid");
  }
}

function validateTerminalPostcondition(value, state) {
  if (state !== "terminal") {
    if (value !== null) fail("production-mutation-lock-invalid");
    return;
  }
  assertExactKeys(value, ["kind", "hash", "recordedAt"]);
  if (!TERMINAL_KINDS.has(value.kind)) fail("production-mutation-lock-invalid");
  assertPattern(value.hash, SHA256_PATTERN);
  parseIso(value.recordedAt);
}

function validateProtectedInstall(value) {
  if (value === null) return;
  assertExactKeys(value, [
    "operationId",
    "transferTokenSha256",
    "protectedInstallEvidenceSha256",
    "releaseSha",
    "targetDescriptorSha256",
    "operatorBundleSha256",
    "installedMigrationSetSha256",
    "installedSchemaVersion",
    "slotVersion",
  ]);
  assertPattern(value.operationId, ID_PATTERN);
  assertPattern(value.transferTokenSha256, SHA256_PATTERN);
  assertPattern(value.protectedInstallEvidenceSha256, SHA256_PATTERN);
  assertPattern(value.releaseSha, /^[0-9a-f]{40}$/);
  assertPattern(value.targetDescriptorSha256, SHA256_PATTERN);
  assertPattern(value.operatorBundleSha256, SHA256_PATTERN);
  assertPattern(value.installedMigrationSetSha256, SHA256_PATTERN);
  if (!Number.isSafeInteger(value.installedSchemaVersion) || value.installedSchemaVersion < 1) {
    fail("production-mutation-lock-invalid");
  }
  if (!Number.isSafeInteger(value.slotVersion) || value.slotVersion < 1) {
    fail("production-mutation-lock-invalid");
  }
}

function validateInstallBootstrap(value) {
  if (value === null) return;
  assertExactKeys(value, [
    "operationId",
    "transferTokenSha256",
    "installIntentEvidenceSha256",
    "releaseSha",
    "targetDescriptorSha256",
    "operatorBundleSha256",
    "installedMigrationSetSha256",
    "installedSchemaVersion",
    "slotVersion",
  ]);
  assertPattern(value.operationId, ID_PATTERN);
  assertPattern(value.transferTokenSha256, SHA256_PATTERN);
  assertPattern(value.installIntentEvidenceSha256, SHA256_PATTERN);
  assertPattern(value.releaseSha, /^[0-9a-f]{40}$/);
  assertPattern(value.targetDescriptorSha256, SHA256_PATTERN);
  assertPattern(value.operatorBundleSha256, SHA256_PATTERN);
  assertPattern(value.installedMigrationSetSha256, SHA256_PATTERN);
  if (!Number.isSafeInteger(value.installedSchemaVersion) || value.installedSchemaVersion < 1) {
    fail("production-mutation-lock-invalid");
  }
  if (!Number.isSafeInteger(value.slotVersion) || value.slotVersion < 1) {
    fail("production-mutation-lock-invalid");
  }
}

function validateHandoff(value, state) {
  if (value === null) {
    if (state === "handoff-pending") fail("production-mutation-lock-invalid");
    return;
  }
  assertExactKeys(value, [
    "gate6Id",
    "transferTokenSha256",
    "expectedSlotVersion",
    "slotVersion",
    "recordedAt",
  ]);
  assertPattern(value.gate6Id, ID_PATTERN);
  assertPattern(value.transferTokenSha256, SHA256_PATTERN);
  if (!Number.isSafeInteger(value.expectedSlotVersion) || value.expectedSlotVersion < 1) {
    fail("production-mutation-lock-invalid");
  }
  if (
    value.slotVersion !== null &&
    (!Number.isSafeInteger(value.slotVersion) || value.slotVersion < 2)
  ) {
    fail("production-mutation-lock-invalid");
  }
  parseIso(value.recordedAt);
  if (state === "handoff-pending" && value.slotVersion !== null) {
    fail("production-mutation-lock-invalid");
  }
  if (state === "gate6-active" && value.slotVersion === null) {
    fail("production-mutation-lock-invalid");
  }
}

function validateLock(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "operationId",
    "operationType",
    "releaseHash",
    "targetHash",
    "state",
    "lease",
    "rollbackJournalHash",
    "rollbackIdentity",
    "installBootstrap",
    "protectedInstall",
    "handoff",
    "terminalPostcondition",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  if (value.schemaVersion !== 3) fail("production-mutation-lock-invalid");
  assertPattern(value.operationId, ID_PATTERN);
  if (!ALLOWED_OPERATION_TYPES.has(value.operationType)) fail("production-mutation-lock-invalid");
  if (!ALLOWED_STATES.has(value.state)) fail("production-mutation-lock-invalid");
  assertPattern(value.releaseHash, SHA256_PATTERN);
  assertPattern(value.targetHash, SHA256_PATTERN);
  assertPattern(value.rollbackJournalHash, SHA256_PATTERN);
  validateRollbackIdentity(value.rollbackIdentity);
  validateInstallBootstrap(value.installBootstrap);
  validateProtectedInstall(value.protectedInstall);
  validateHandoff(value.handoff, value.state);
  if (value.protectedInstall !== null) {
    if (value.protectedInstall.operationId !== value.operationId) {
      fail("production-mutation-lock-invalid");
    }
    if (value.protectedInstall.targetDescriptorSha256 !== value.targetHash) {
      fail("production-mutation-lock-invalid");
    }
  }
  if (value.installBootstrap !== null) {
    if (
      value.installBootstrap.operationId !== value.operationId ||
      value.installBootstrap.targetDescriptorSha256 !== value.targetHash ||
      value.protectedInstall !== null ||
      !["installing", "recovering"].includes(value.state)
    )
      fail("production-mutation-lock-invalid");
  }
  validateLease(value.lease);
  validateTerminalPostcondition(value.terminalPostcondition, value.state);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1)
    fail("production-mutation-lock-invalid");
  const createdAt = parseIso(value.createdAt);
  const updatedAt = parseIso(value.updatedAt);
  if (updatedAt < createdAt) fail("production-mutation-lock-invalid");
  return value;
}

function stateDirectory(options) {
  const stateDir = resolve(options.stateDir ?? DEFAULT_STATE_DIR);
  secureDirectory(stateDir, options.allowNonRoot === true);
  return stateDir;
}

function assertIdentity(lock, input) {
  if (
    lock.operationId !== input.operationId ||
    lock.releaseHash !== input.releaseHash ||
    lock.targetHash !== input.targetHash
  ) {
    fail("production-mutation-lock-identity-mismatch");
  }
}

export async function readProductionMutationLock(options = {}) {
  const stateDir = stateDirectory(options);
  const path = join(stateDir, LOCK_FILE);
  if (!existsSync(path)) {
    if (options.allowMissing === true) return null;
    fail("production-mutation-lock-missing");
  }
  return validateLock(readSecureJson(path, options.allowNonRoot === true));
}

export async function acquireProductionMutationLock(options) {
  if (!isObject(options) || !isObject(options.request)) fail("production-mutation-lock-invalid");
  const stateDir = stateDirectory(options);
  const path = join(stateDir, LOCK_FILE);
  const request = options.request;
  assertExactKeys(request, [
    "operationId",
    "operationType",
    "releaseHash",
    "targetHash",
    "state",
    "rollbackJournalHash",
    "rollbackIdentity",
    "lease",
  ]);
  assertPattern(request.operationId, ID_PATTERN);
  if (!ALLOWED_OPERATION_TYPES.has(request.operationType)) fail("production-mutation-lock-invalid");
  if (request.state !== INITIAL_STATE_BY_OPERATION.get(request.operationType)) {
    fail("production-mutation-lock-invalid");
  }
  assertPattern(request.releaseHash, SHA256_PATTERN);
  assertPattern(request.targetHash, SHA256_PATTERN);
  assertPattern(request.rollbackJournalHash, SHA256_PATTERN);
  validateRollbackIdentity(request.rollbackIdentity);
  assertExactKeys(request.lease, ["owner", "durationMs"]);
  assertPattern(request.lease.owner, ID_PATTERN);
  if (
    !Number.isSafeInteger(request.lease.durationMs) ||
    request.lease.durationMs < 1_000 ||
    request.lease.durationMs > 24 * 60 * 60 * 1_000
  ) {
    fail("production-mutation-lock-invalid");
  }
  const nowMs = options.nowMs ?? Date.now();
  const now = isoFromMs(nowMs);
  const lock = validateLock({
    schemaVersion: 3,
    operationId: request.operationId,
    operationType: request.operationType,
    releaseHash: request.releaseHash,
    targetHash: request.targetHash,
    state: request.state,
    lease: {
      owner: request.lease.owner,
      heartbeatAt: now,
      expiresAt: isoFromMs(nowMs + request.lease.durationMs),
    },
    rollbackJournalHash: request.rollbackJournalHash,
    rollbackIdentity: structuredClone(request.rollbackIdentity),
    installBootstrap: null,
    protectedInstall: null,
    handoff: null,
    terminalPostcondition: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    try {
      writeNewFileDurably(path, lock);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        fail("production-mutation-lock-held");
      }
      throw error;
    }
    return lock;
  });
}

export async function verifyProductionMutationLock(options) {
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const lock = await readProductionMutationLock({ ...options, stateDir });
    assertIdentity(lock, options);
    if (lock.state === "terminal") fail("production-mutation-lock-terminal");
    const nowMs = options.nowMs ?? Date.now();
    if (parseIso(lock.lease.expiresAt) < nowMs) fail("production-mutation-lock-lease-expired");
    if (lock.lease.owner !== options.leaseOwner)
      fail("production-mutation-lock-lease-owner-mismatch");
    if (
      !Number.isSafeInteger(options.renewLeaseMs) ||
      options.renewLeaseMs < 1_000 ||
      options.renewLeaseMs > 24 * 60 * 60 * 1_000
    ) {
      fail("production-mutation-lock-invalid");
    }
    const updated = validateLock({
      ...lock,
      lease: {
        owner: options.leaseOwner,
        heartbeatAt: isoFromMs(nowMs),
        expiresAt: isoFromMs(nowMs + options.renewLeaseMs),
      },
      revision: lock.revision + 1,
      updatedAt: isoFromMs(nowMs),
    });
    replaceFileDurably(join(stateDir, LOCK_FILE), updated);
    return updated;
  });
}

export async function checkProductionMutationLock(options) {
  const lock = await readProductionMutationLock(options);
  assertIdentity(lock, options);
  if (lock.state === "terminal") fail("production-mutation-lock-terminal");
  const nowMs = options.nowMs ?? Date.now();
  if (parseIso(lock.lease.expiresAt) < nowMs) fail("production-mutation-lock-lease-expired");
  return lock;
}

function requireActiveLease(lock, options, nowMs) {
  if (lock.lease.owner !== options.leaseOwner) {
    fail("production-mutation-lock-lease-owner-mismatch");
  }
  if (parseIso(lock.lease.expiresAt) < nowMs) {
    fail("production-mutation-lock-lease-expired");
  }
}

function installBootstrapBinding(input) {
  assertExactKeys(input, [
    "operationId",
    "transferTokenSha256",
    "installIntentEvidenceSha256",
    "releaseSha",
    "targetDescriptorSha256",
    "operatorBundleSha256",
    "installedMigrationSetSha256",
    "installedSchemaVersion",
    "heartbeatAt",
    "expiresAt",
    "slotVersion",
  ]);
  parseIso(input.heartbeatAt);
  parseIso(input.expiresAt);
  const binding = {
    operationId: input.operationId,
    transferTokenSha256: input.transferTokenSha256,
    installIntentEvidenceSha256: input.installIntentEvidenceSha256,
    releaseSha: input.releaseSha,
    targetDescriptorSha256: input.targetDescriptorSha256,
    operatorBundleSha256: input.operatorBundleSha256,
    installedMigrationSetSha256: input.installedMigrationSetSha256,
    installedSchemaVersion: input.installedSchemaVersion,
    slotVersion: input.slotVersion,
  };
  validateInstallBootstrap(binding);
  return binding;
}

export async function markProductionInstallBootstrapOwned(options) {
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const lock = await readProductionMutationLock({ ...options, stateDir });
    assertIdentity(lock, options);
    if (lock.operationType !== "install") fail("production-mutation-lock-install-required");
    const binding = installBootstrapBinding(options.binding);
    if (
      binding.operationId !== lock.operationId ||
      binding.targetDescriptorSha256 !== lock.targetHash
    ) {
      fail("production-mutation-lock-identity-mismatch");
    }
    if (lock.state === "installing" && lock.installBootstrap !== null) {
      if (canonicalJson(lock.installBootstrap) !== canonicalJson(binding)) {
        fail("production-mutation-lock-install-bootstrap-conflict");
      }
      return lock;
    }
    const nowMs = options.nowMs ?? Date.now();
    requireActiveLease(lock, options, nowMs);
    if (
      lock.state !== "installing" ||
      lock.installBootstrap !== null ||
      lock.protectedInstall !== null ||
      lock.handoff !== null
    )
      fail("production-mutation-lock-install-bootstrap-conflict");
    const updated = validateLock({
      ...lock,
      installBootstrap: binding,
      revision: lock.revision + 1,
      updatedAt: isoFromMs(nowMs),
    });
    replaceFileDurably(join(stateDir, LOCK_FILE), updated);
    return updated;
  });
}

function validatePreparedHostIdentity(value) {
  assertExactKeys(
    value,
    ["operationId", "releaseSha", "targetDescriptorSha256", "operatorBundleSha256"],
    "production-mutation-lock-prepared-commit-invalid",
  );
  assertPattern(value.operationId, ID_PATTERN, "production-mutation-lock-prepared-commit-invalid");
  assertPattern(
    value.releaseSha,
    /^[0-9a-f]{40}$/,
    "production-mutation-lock-prepared-commit-invalid",
  );
  assertPattern(
    value.targetDescriptorSha256,
    SHA256_PATTERN,
    "production-mutation-lock-prepared-commit-invalid",
  );
  assertPattern(
    value.operatorBundleSha256,
    SHA256_PATTERN,
    "production-mutation-lock-prepared-commit-invalid",
  );
  return value;
}

function validatePreparedHostCommit(value) {
  assertExactKeys(
    value,
    [
      "operationId",
      "releaseSha",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "protectedInstallEvidenceSha256",
      "heartbeatAt",
      "expiresAt",
      "expectedCurrentVersion",
      "expectedNextVersion",
    ],
    "production-mutation-lock-prepared-commit-invalid",
  );
  validatePreparedHostIdentity({
    operationId: value.operationId,
    releaseSha: value.releaseSha,
    targetDescriptorSha256: value.targetDescriptorSha256,
    operatorBundleSha256: value.operatorBundleSha256,
  });
  assertPattern(
    value.protectedInstallEvidenceSha256,
    SHA256_PATTERN,
    "production-mutation-lock-prepared-commit-invalid",
  );
  const heartbeat = parseIso(value.heartbeatAt);
  const expires = parseIso(value.expiresAt);
  if (expires <= heartbeat || expires - heartbeat > 24 * 60 * 60 * 1_000) {
    fail("production-mutation-lock-prepared-commit-invalid");
  }
  if (
    !Number.isSafeInteger(value.expectedCurrentVersion) ||
    value.expectedCurrentVersion < 1 ||
    !Number.isSafeInteger(value.expectedNextVersion) ||
    value.expectedNextVersion !== value.expectedCurrentVersion + 1
  ) {
    fail("production-mutation-lock-prepared-commit-version-invalid");
  }
  return value;
}

function hostInstallIdentityMatches(lock, identity, binding) {
  return (
    lock.operationType === "install" &&
    lock.operationId === identity.operationId &&
    lock.targetHash === identity.targetDescriptorSha256 &&
    binding !== null &&
    binding.operationId === identity.operationId &&
    binding.releaseSha === identity.releaseSha &&
    binding.targetDescriptorSha256 === identity.targetDescriptorSha256 &&
    binding.operatorBundleSha256 === identity.operatorBundleSha256
  );
}

function exactPreparedFinalHostLock(lock, binding) {
  return (
    lock.state === "installed-awaiting-gate6" &&
    lock.revision === binding.expectedNextVersion &&
    lock.installBootstrap === null &&
    lock.handoff === null &&
    hostInstallIdentityMatches(lock, binding, lock.protectedInstall) &&
    lock.protectedInstall.protectedInstallEvidenceSha256 ===
      binding.protectedInstallEvidenceSha256 &&
    lock.lease.heartbeatAt === binding.heartbeatAt &&
    lock.lease.expiresAt === binding.expiresAt
  );
}

function exactPreparedCurrentHostLock(lock, binding) {
  return (
    lock.state === "installing" &&
    lock.revision === binding.expectedCurrentVersion &&
    lock.installBootstrap !== null &&
    lock.protectedInstall === null &&
    lock.handoff === null &&
    hostInstallIdentityMatches(lock, binding, lock.installBootstrap) &&
    lock.installBootstrap.installIntentEvidenceSha256 !== binding.protectedInstallEvidenceSha256 &&
    parseIso(lock.lease.heartbeatAt) < parseIso(binding.heartbeatAt) &&
    parseIso(lock.lease.expiresAt) >= parseIso(binding.heartbeatAt) &&
    parseIso(lock.updatedAt) < parseIso(binding.heartbeatAt)
  );
}

function preparedHostResult(lock) {
  const installed = lock.state === "installed-awaiting-gate6";
  const source = installed ? lock.protectedInstall : lock.installBootstrap;
  return {
    operationId: lock.operationId,
    state: lock.state,
    version: lock.revision,
    protectedInstallEvidenceSha256: installed
      ? source.protectedInstallEvidenceSha256
      : source.installIntentEvidenceSha256,
    heartbeatAt: lock.lease.heartbeatAt,
    expiresAt: lock.lease.expiresAt,
    releaseSha: source.releaseSha,
    targetDescriptorSha256: source.targetDescriptorSha256,
    operatorBundleSha256: source.operatorBundleSha256,
    installedMigrationSetSha256: source.installedMigrationSetSha256,
    installedSchemaVersion: source.installedSchemaVersion,
  };
}

export async function previewProductionInstallHostLockCommit(options) {
  if (!isObject(options) || !isObject(options.identity)) {
    fail("production-mutation-lock-prepared-commit-invalid");
  }
  const identity = validatePreparedHostIdentity(options.identity);
  const lock = await readProductionMutationLock(options);
  if (
    lock.state !== "installing" ||
    lock.installBootstrap === null ||
    lock.protectedInstall !== null ||
    lock.handoff !== null ||
    !hostInstallIdentityMatches(lock, identity, lock.installBootstrap)
  ) {
    fail("production-mutation-lock-prepared-commit-identity-mismatch");
  }
  return {
    current: { operationId: identity.operationId, state: "installing", version: lock.revision },
    next: {
      operationId: identity.operationId,
      state: "installed-awaiting-gate6",
      version: lock.revision + 1,
    },
  };
}

export async function commitProductionInstallHostLock(options) {
  if (!isObject(options) || !isObject(options.binding)) {
    fail("production-mutation-lock-prepared-commit-invalid");
  }
  const binding = validatePreparedHostCommit(options.binding);
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const lock = await readProductionMutationLock({ ...options, stateDir });
    if (exactPreparedFinalHostLock(lock, binding)) {
      return {
        status: "installed-awaiting-gate6",
        hostLockVersion: binding.expectedNextVersion,
        idempotent: true,
      };
    }
    if (
      lock.state !== "installing" ||
      lock.revision !== binding.expectedCurrentVersion ||
      lock.installBootstrap === null ||
      lock.protectedInstall !== null ||
      lock.handoff !== null ||
      !hostInstallIdentityMatches(lock, binding, lock.installBootstrap) ||
      parseIso(lock.lease.heartbeatAt) >= parseIso(binding.heartbeatAt) ||
      parseIso(lock.lease.expiresAt) < parseIso(binding.heartbeatAt) ||
      parseIso(lock.updatedAt) >= parseIso(binding.heartbeatAt)
    ) {
      fail("production-mutation-lock-prepared-commit-binding-mismatch");
    }
    const bootstrap = lock.installBootstrap;
    const updated = validateLock({
      ...lock,
      state: "installed-awaiting-gate6",
      installBootstrap: null,
      protectedInstall: {
        operationId: bootstrap.operationId,
        transferTokenSha256: bootstrap.transferTokenSha256,
        protectedInstallEvidenceSha256: binding.protectedInstallEvidenceSha256,
        releaseSha: bootstrap.releaseSha,
        targetDescriptorSha256: bootstrap.targetDescriptorSha256,
        operatorBundleSha256: bootstrap.operatorBundleSha256,
        installedMigrationSetSha256: bootstrap.installedMigrationSetSha256,
        installedSchemaVersion: bootstrap.installedSchemaVersion,
        slotVersion: bootstrap.slotVersion + 1,
      },
      lease: {
        owner: lock.lease.owner,
        heartbeatAt: binding.heartbeatAt,
        expiresAt: binding.expiresAt,
      },
      revision: binding.expectedNextVersion,
      updatedAt: binding.heartbeatAt,
    });
    replaceFileDurably(join(stateDir, LOCK_FILE), updated);
    return {
      status: "installed-awaiting-gate6",
      hostLockVersion: binding.expectedNextVersion,
      idempotent: false,
    };
  });
}

export async function readProductionInstallHostLockCommit(options) {
  if (!isObject(options) || !isObject(options.binding)) {
    fail("production-mutation-lock-prepared-commit-invalid");
  }
  const binding = validatePreparedHostCommit(options.binding);
  const lock = await readProductionMutationLock(options);
  if (!exactPreparedFinalHostLock(lock, binding) && !exactPreparedCurrentHostLock(lock, binding)) {
    fail("production-mutation-lock-prepared-commit-binding-mismatch");
  }
  return preparedHostResult(lock);
}

function protectedInstallBinding(input) {
  assertExactKeys(input, [
    "operationId",
    "transferTokenSha256",
    "protectedInstallEvidenceSha256",
    "releaseSha",
    "targetDescriptorSha256",
    "operatorBundleSha256",
    "installedMigrationSetSha256",
    "installedSchemaVersion",
    "heartbeatAt",
    "expiresAt",
    "slotVersion",
  ]);
  parseIso(input.heartbeatAt);
  parseIso(input.expiresAt);
  const binding = {
    operationId: input.operationId,
    transferTokenSha256: input.transferTokenSha256,
    protectedInstallEvidenceSha256: input.protectedInstallEvidenceSha256,
    releaseSha: input.releaseSha,
    targetDescriptorSha256: input.targetDescriptorSha256,
    operatorBundleSha256: input.operatorBundleSha256,
    installedMigrationSetSha256: input.installedMigrationSetSha256,
    installedSchemaVersion: input.installedSchemaVersion,
    slotVersion: input.slotVersion,
  };
  validateProtectedInstall(binding);
  return binding;
}

export async function markProductionInstallAwaitingGate6(options) {
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const lock = await readProductionMutationLock({ ...options, stateDir });
    assertIdentity(lock, options);
    const nowMs = options.nowMs ?? Date.now();
    if (lock.operationType !== "install") fail("production-mutation-lock-install-required");
    const binding = protectedInstallBinding(options.binding);
    if (
      binding.operationId !== lock.operationId ||
      binding.targetDescriptorSha256 !== lock.targetHash
    ) {
      fail("production-mutation-lock-identity-mismatch");
    }
    if (lock.state === "installed-awaiting-gate6") {
      if (
        canonicalJson(lock.protectedInstall) !== canonicalJson(binding) ||
        lock.handoff !== null
      ) {
        fail("production-mutation-lock-protected-install-conflict");
      }
      return lock;
    }
    requireActiveLease(lock, options, nowMs);
    if (lock.state !== "installing" || lock.protectedInstall !== null || lock.handoff !== null) {
      fail("production-mutation-lock-protected-install-conflict");
    }
    if (lock.installBootstrap !== null) {
      const bootstrap = lock.installBootstrap;
      if (
        bootstrap.operationId !== binding.operationId ||
        bootstrap.transferTokenSha256 !== binding.transferTokenSha256 ||
        bootstrap.releaseSha !== binding.releaseSha ||
        bootstrap.targetDescriptorSha256 !== binding.targetDescriptorSha256 ||
        bootstrap.operatorBundleSha256 !== binding.operatorBundleSha256 ||
        bootstrap.installedMigrationSetSha256 !== binding.installedMigrationSetSha256 ||
        bootstrap.installedSchemaVersion !== binding.installedSchemaVersion ||
        bootstrap.slotVersion + 1 !== binding.slotVersion
      )
        fail("production-mutation-lock-protected-install-conflict");
    }
    const updated = validateLock({
      ...lock,
      state: "installed-awaiting-gate6",
      installBootstrap: null,
      protectedInstall: binding,
      revision: lock.revision + 1,
      updatedAt: isoFromMs(nowMs),
    });
    replaceFileDurably(join(stateDir, LOCK_FILE), updated);
    return updated;
  });
}

export async function beginProductionMutationGate6Handoff(options) {
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const lock = await readProductionMutationLock({ ...options, stateDir });
    assertIdentity(lock, options);
    const nowMs = options.nowMs ?? Date.now();
    requireActiveLease(lock, options, nowMs);
    assertPattern(options.gate6Id, ID_PATTERN);
    assertPattern(options.transferTokenSha256, SHA256_PATTERN);
    if (!Number.isSafeInteger(options.expectedSlotVersion) || options.expectedSlotVersion < 1) {
      fail("production-mutation-lock-invalid");
    }
    if (
      lock.state !== "installed-awaiting-gate6" ||
      lock.protectedInstall === null ||
      lock.handoff !== null ||
      lock.protectedInstall.transferTokenSha256 !== options.transferTokenSha256 ||
      lock.protectedInstall.slotVersion !== options.expectedSlotVersion
    )
      fail("production-mutation-lock-handoff-binding-mismatch");
    const updated = validateLock({
      ...lock,
      state: "handoff-pending",
      handoff: {
        gate6Id: options.gate6Id,
        transferTokenSha256: options.transferTokenSha256,
        expectedSlotVersion: options.expectedSlotVersion,
        slotVersion: null,
        recordedAt: isoFromMs(nowMs),
      },
      revision: lock.revision + 1,
      updatedAt: isoFromMs(nowMs),
    });
    replaceFileDurably(join(stateDir, LOCK_FILE), updated);
    return updated;
  });
}

function assertObservedProtectedInstallSlot(slot, lock) {
  const binding = lock.protectedInstall;
  if (
    !isObject(slot) ||
    slot.environment !== "production" ||
    slot.owner_type !== "protected-install" ||
    slot.owner_id !== lock.operationId ||
    slot.operation_id !== lock.operationId ||
    slot.transfer_token_sha256 !== binding.transferTokenSha256 ||
    slot.state !== "installed-awaiting-gate6" ||
    slot.version !== binding.slotVersion ||
    slot.protected_install_evidence_sha256 !== binding.protectedInstallEvidenceSha256 ||
    slot.release_sha !== binding.releaseSha ||
    slot.target_descriptor_sha256 !== binding.targetDescriptorSha256 ||
    slot.operator_bundle_sha256 !== binding.operatorBundleSha256 ||
    slot.installed_migration_set_sha256 !== binding.installedMigrationSetSha256 ||
    slot.installed_schema_version !== binding.installedSchemaVersion
  )
    fail("production-mutation-lock-handoff-slot-mismatch");
}

function installBootstrapBindingFromSlot(slot, lock) {
  if (
    !isObject(slot) ||
    slot.environment !== "production" ||
    slot.owner_type !== "protected-install" ||
    slot.owner_id !== lock.operationId ||
    slot.operation_id !== lock.operationId ||
    slot.state !== "installing" ||
    !Number.isSafeInteger(slot.version) ||
    slot.version < 1 ||
    Number(slot.uncompensated_work) !== 0
  )
    fail("production-mutation-lock-install-bootstrap-slot-mismatch");
  const binding = {
    operationId: lock.operationId,
    transferTokenSha256: slot.transfer_token_sha256,
    installIntentEvidenceSha256: slot.protected_install_evidence_sha256,
    releaseSha: slot.release_sha,
    targetDescriptorSha256: slot.target_descriptor_sha256,
    operatorBundleSha256: slot.operator_bundle_sha256,
    installedMigrationSetSha256: slot.installed_migration_set_sha256,
    installedSchemaVersion: slot.installed_schema_version,
    slotVersion: slot.version,
  };
  validateInstallBootstrap(binding);
  if (binding.targetDescriptorSha256 !== lock.targetHash) {
    fail("production-mutation-lock-install-bootstrap-slot-mismatch");
  }
  return binding;
}

export async function reconcileProductionInstallBootstrapSlot(options) {
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const lock = await readProductionMutationLock({ ...options, stateDir });
    if (lock.operationType !== "install" || !["installing", "recovering"].includes(lock.state)) {
      fail("production-mutation-lock-install-bootstrap-reconcile-invalid");
    }
    if (options.watchdogOwner !== PROTECTED_INSTALL_WATCHDOG_OWNER) {
      fail("production-mutation-lock-protected-install-watchdog-invalid");
    }
    if (
      !Number.isSafeInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 1_000 ||
      options.leaseDurationMs > 24 * 60 * 60 * 1_000
    )
      fail("production-mutation-lock-invalid");
    const binding = installBootstrapBindingFromSlot(options.observedSlot, lock);
    if (
      lock.installBootstrap !== null &&
      canonicalJson(lock.installBootstrap) !== canonicalJson(binding)
    ) {
      fail("production-mutation-lock-install-bootstrap-slot-mismatch");
    }
    if (lock.protectedInstall !== null || lock.handoff !== null) {
      fail("production-mutation-lock-install-bootstrap-reconcile-invalid");
    }
    const nowMs = options.nowMs ?? Date.now();
    const reconciled = validateLock({
      ...lock,
      state: "installing",
      installBootstrap: binding,
      lease: {
        owner: options.watchdogOwner,
        heartbeatAt: isoFromMs(nowMs),
        expiresAt: isoFromMs(nowMs + options.leaseDurationMs),
      },
      revision: lock.revision + 1,
      updatedAt: isoFromMs(nowMs),
    });
    replaceFileDurably(join(stateDir, LOCK_FILE), reconciled);
    return reconciled;
  });
}

export async function reconcileProductionInstallAwaitingGate6(options) {
  if (!isObject(options) || !isObject(options.binding)) {
    fail("production-mutation-lock-protected-install-prepared-commit-required");
  }
  await commitProductionInstallHostLock(options);
  return readProductionMutationLock(options);
}

export async function reconcileProductionMutationGate6Handoff(options) {
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const lock = await readProductionMutationLock({ ...options, stateDir });
    assertIdentity(lock, options);
    const nowMs = options.nowMs ?? Date.now();
    requireActiveLease(lock, options, nowMs);
    if (
      lock.state !== "handoff-pending" ||
      lock.protectedInstall === null ||
      lock.handoff === null
    ) {
      fail("production-mutation-lock-handoff-not-pending");
    }
    const slot = options.observedSlot;
    if (slot?.owner_type === "protected-install") {
      assertObservedProtectedInstallSlot(slot, lock);
      const restored = validateLock({
        ...lock,
        state: "installed-awaiting-gate6",
        handoff: null,
        revision: lock.revision + 1,
        updatedAt: isoFromMs(nowMs),
      });
      replaceFileDurably(join(stateDir, LOCK_FILE), restored);
      return { outcome: "install-owner-restored", lock: restored };
    }
    if (
      !isObject(slot) ||
      slot.environment !== "production" ||
      slot.owner_type !== "gate6" ||
      slot.owner_id !== lock.handoff.gate6Id ||
      slot.operation_id !== lock.operationId ||
      slot.transfer_token_sha256 !== null ||
      slot.state !== "active" ||
      slot.version !== lock.handoff.expectedSlotVersion + 1
    )
      fail("production-mutation-lock-handoff-slot-mismatch");
    assertPattern(options.gate6LeaseOwner, ID_PATTERN);
    if (
      !Number.isSafeInteger(options.gate6LeaseDurationMs) ||
      options.gate6LeaseDurationMs < 1_000 ||
      options.gate6LeaseDurationMs > 24 * 60 * 60 * 1_000
    )
      fail("production-mutation-lock-invalid");
    const completed = validateLock({
      ...lock,
      state: "gate6-active",
      handoff: {
        ...lock.handoff,
        slotVersion: slot.version,
        recordedAt: isoFromMs(nowMs),
      },
      lease: {
        owner: options.gate6LeaseOwner,
        heartbeatAt: isoFromMs(nowMs),
        expiresAt: isoFromMs(nowMs + options.gate6LeaseDurationMs),
      },
      revision: lock.revision + 1,
      updatedAt: isoFromMs(nowMs),
    });
    replaceFileDurably(join(stateDir, LOCK_FILE), completed);
    return { outcome: "gate6-owner-completed", lock: completed };
  });
}

export async function markProductionMutationTerminal(options) {
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const lock = await readProductionMutationLock({ ...options, stateDir });
    assertIdentity(lock, options);
    if (lock.state === "terminal") fail("production-mutation-lock-terminal");
    if (lock.installBootstrap !== null || lock.protectedInstall !== null) {
      fail("production-mutation-lock-protected-install-handoff-required");
    }
    assertExactKeys(options.terminalPostcondition, ["kind", "hash"]);
    if (!TERMINAL_KINDS.has(options.terminalPostcondition.kind)) {
      fail("production-mutation-lock-invalid");
    }
    assertPattern(options.terminalPostcondition.hash, SHA256_PATTERN);
    const nowMs = options.nowMs ?? Date.now();
    if (lock.lease.owner !== options.leaseOwner) {
      fail("production-mutation-lock-lease-owner-mismatch");
    }
    if (parseIso(lock.lease.expiresAt) < nowMs) {
      fail("production-mutation-lock-lease-expired");
    }
    const updated = validateLock({
      ...lock,
      state: "terminal",
      terminalPostcondition: {
        kind: options.terminalPostcondition.kind,
        hash: options.terminalPostcondition.hash,
        recordedAt: isoFromMs(nowMs),
      },
      revision: lock.revision + 1,
      updatedAt: isoFromMs(nowMs),
    });
    replaceFileDurably(join(stateDir, LOCK_FILE), updated);
    return updated;
  });
}

export async function reconcileProductionMutationLock(options = {}) {
  const stateDir = stateDirectory(options);
  return withUpdateGuard(stateDir, options.allowNonRoot === true, async () => {
    const path = join(stateDir, LOCK_FILE);
    if (!existsSync(path)) return { outcome: "unlocked", lock: null };
    const lock = await readProductionMutationLock({ ...options, stateDir });
    const nowMs = options.nowMs ?? Date.now();
    if (lock.state === "terminal") {
      const terminalDirectory = join(stateDir, "terminal");
      secureDirectory(terminalDirectory, options.allowNonRoot === true);
      const archivePath = join(terminalDirectory, `${lock.operationId}.json`);
      if (existsSync(archivePath)) {
        const archived = validateLock(readSecureJson(archivePath, options.allowNonRoot === true));
        if (canonicalJson(archived) !== canonicalJson(lock)) {
          fail("production-mutation-lock-terminal-conflict");
        }
      } else {
        writeNewFileDurably(archivePath, lock);
      }
      unlinkSync(path);
      fsyncDirectory(stateDir);
      return { outcome: "cleared-terminal", lock };
    }

    const expired = parseIso(lock.lease.expiresAt) < nowMs;
    if (!expired && (lock.state !== "recovering" || lock.lease.owner !== options.reconcilerOwner)) {
      return { outcome: "held", lock };
    }
    if (
      lock.operationType === "install" &&
      (lock.installBootstrap !== null || lock.state === "installed-awaiting-gate6")
    ) {
      return { outcome: "protected-install-prepared-commit-required", lock };
    }
    assertPattern(options.reconcilerOwner, ID_PATTERN);
    if (
      !Number.isSafeInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 1_000 ||
      options.leaseDurationMs > 24 * 60 * 60 * 1_000
    ) {
      fail("production-mutation-lock-invalid");
    }
    const fencedRecoveryOutcome = new Map([
      ["handoff-pending", "handoff-reconciliation-required"],
      ["gate6-active", "gate6-reconciliation-required"],
    ]).get(lock.state);
    if (fencedRecoveryOutcome !== undefined) {
      const fenced = validateLock({
        ...lock,
        lease: {
          owner: options.reconcilerOwner,
          heartbeatAt: isoFromMs(nowMs),
          expiresAt: isoFromMs(nowMs + options.leaseDurationMs),
        },
        revision: lock.revision + 1,
        updatedAt: isoFromMs(nowMs),
      });
      replaceFileDurably(path, fenced);
      return { outcome: fencedRecoveryOutcome, lock: fenced };
    }
    const recovering = validateLock({
      ...lock,
      state: "recovering",
      lease: {
        owner: options.reconcilerOwner,
        heartbeatAt: isoFromMs(nowMs),
        expiresAt: isoFromMs(nowMs + options.leaseDurationMs),
      },
      revision: lock.revision + 1,
      updatedAt: isoFromMs(nowMs),
    });
    replaceFileDurably(path, recovering);
    return { outcome: "recovery-required", lock: recovering };
  });
}

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) fail("production-mutation-lock-cli-invalid");
    const separator = arg.indexOf("=");
    const key = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (key === "" || value === "" || key in values) fail("production-mutation-lock-cli-invalid");
    values[key] = value;
  }
  return values;
}

function requiredArg(values, key, pattern = null) {
  const value = values[key];
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    fail("production-mutation-lock-cli-invalid");
  }
  return value;
}

function assertCliKeys(values, allowed) {
  const allowedSet = new Set(allowed);
  if (Object.keys(values).some((key) => !allowedSet.has(key))) {
    fail("production-mutation-lock-cli-invalid");
  }
}

function cliRoot(values) {
  const root = values.root ?? DEFAULT_STATE_DIR;
  if (root !== DEFAULT_STATE_DIR && process.env.NODE_ENV !== "test") {
    fail("production-mutation-lock-cli-invalid");
  }
  return { stateDir: root, allowNonRoot: root !== DEFAULT_STATE_DIR };
}

async function runCliOnce(values) {
  const action = requiredArg(
    values,
    "action",
    /^(?:acquire|verify|install-bootstrap|installed-awaiting-gate6|terminal|reconcile)$/,
  );
  const root = cliRoot(values);
  if (action === "reconcile") {
    assertCliKeys(values, [
      "action",
      "root",
      "reconciler-owner",
      "lease-duration-ms",
      "watch",
      "interval-ms",
    ]);
    return reconcileProductionMutationLock({
      ...root,
      reconcilerOwner: values["reconciler-owner"] ?? "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: Number(values["lease-duration-ms"] ?? 30_000),
    });
  }
  const operationId = requiredArg(values, "operation-id", ID_PATTERN);
  const releaseHash = requiredArg(values, "release-sha256", SHA256_PATTERN);
  const targetHash = requiredArg(values, "target-sha256", SHA256_PATTERN);
  if (action === "acquire") {
    assertCliKeys(values, [
      "action",
      "root",
      "operation-id",
      "operation-type",
      "release-sha256",
      "target-sha256",
      "watchdog-until",
      "lease-seconds",
      "watchdog-owner",
      "rollback-journal-sha256",
      "rollback-project",
      "rollback-release-sha256",
      "rollback-image",
      "rollback-service-set-sha256",
      "rollback-config-sha256",
    ]);
    const operationType = requiredArg(
      values,
      "operation-type",
      /^(?:adoption|install|gate6|emergency|rollback|reconcile)$/,
    );
    if (values["watchdog-until"] !== undefined && values["lease-seconds"] !== undefined) {
      fail("production-mutation-lock-cli-invalid");
    }
    const durationMs =
      values["lease-seconds"] !== undefined
        ? Number(values["lease-seconds"]) * 1_000
        : Date.parse(requiredArg(values, "watchdog-until")) - Date.now();
    const rollbackJournalHash = requiredArg(values, "rollback-journal-sha256", SHA256_PATTERN);
    if (
      operationType === "install" &&
      (values["rollback-release-sha256"] === undefined ||
        values["rollback-service-set-sha256"] === undefined ||
        values["rollback-config-sha256"] === undefined)
    ) {
      fail("production-mutation-lock-verified-rollback-required");
    }
    return acquireProductionMutationLock({
      ...root,
      request: {
        operationId,
        operationType,
        releaseHash,
        targetHash,
        state: INITIAL_STATE_BY_OPERATION.get(operationType),
        rollbackJournalHash,
        rollbackIdentity: {
          project: values["rollback-project"] ?? "spx",
          releaseHash: values["rollback-release-sha256"] ?? releaseHash,
          imageDigest: requiredArg(values, "rollback-image", IMAGE_DIGEST_PATTERN),
          serviceSetHash: values["rollback-service-set-sha256"] ?? targetHash,
          configHash: values["rollback-config-sha256"] ?? rollbackJournalHash,
        },
        lease: {
          owner: values["watchdog-owner"] ?? `workflow:${operationId}`,
          durationMs,
        },
      },
    });
  }
  if (action === "verify") {
    assertCliKeys(values, [
      "action",
      "root",
      "operation-id",
      "release-sha256",
      "target-sha256",
      "watchdog-until",
      "lease-seconds",
      "watchdog-owner",
    ]);
    if (values["watchdog-until"] === undefined && values["lease-seconds"] === undefined) {
      return checkProductionMutationLock({
        ...root,
        operationId,
        releaseHash,
        targetHash,
      });
    }
    if (values["watchdog-until"] !== undefined && values["lease-seconds"] !== undefined) {
      fail("production-mutation-lock-cli-invalid");
    }
    const renewLeaseMs =
      values["lease-seconds"] !== undefined
        ? Number(values["lease-seconds"]) * 1_000
        : Date.parse(requiredArg(values, "watchdog-until")) - Date.now();
    return verifyProductionMutationLock({
      ...root,
      operationId,
      releaseHash,
      targetHash,
      leaseOwner: values["watchdog-owner"] ?? `workflow:${operationId}`,
      renewLeaseMs,
    });
  }
  if (action === "install-bootstrap") {
    assertCliKeys(values, [
      "action",
      "root",
      "operation-id",
      "release-sha256",
      "target-sha256",
      "lease-owner",
      "source-sha",
      "transfer-token-sha256",
      "install-intent-evidence-sha256",
      "operator-bundle-sha256",
      "installed-migration-set-sha256",
      "installed-schema-version",
      "slot-version",
      "heartbeat-at",
      "expires-at",
    ]);
    return markProductionInstallBootstrapOwned({
      ...root,
      operationId,
      releaseHash,
      targetHash,
      leaseOwner: values["lease-owner"] ?? `workflow:${operationId}`,
      binding: {
        operationId,
        transferTokenSha256: requiredArg(values, "transfer-token-sha256", SHA256_PATTERN),
        installIntentEvidenceSha256: requiredArg(
          values,
          "install-intent-evidence-sha256",
          SHA256_PATTERN,
        ),
        releaseSha: requiredArg(values, "source-sha", /^[0-9a-f]{40}$/),
        targetDescriptorSha256: targetHash,
        operatorBundleSha256: requiredArg(values, "operator-bundle-sha256", SHA256_PATTERN),
        installedMigrationSetSha256: requiredArg(
          values,
          "installed-migration-set-sha256",
          SHA256_PATTERN,
        ),
        installedSchemaVersion: Number(requiredArg(values, "installed-schema-version", /^\d+$/)),
        heartbeatAt: requiredArg(values, "heartbeat-at"),
        expiresAt: requiredArg(values, "expires-at"),
        slotVersion: Number(requiredArg(values, "slot-version", /^\d+$/)),
      },
    });
  }
  if (action === "installed-awaiting-gate6") {
    assertCliKeys(values, [
      "action",
      "root",
      "operation-id",
      "release-sha256",
      "target-sha256",
      "lease-owner",
      "source-sha",
      "transfer-token-sha256",
      "protected-install-evidence-sha256",
      "operator-bundle-sha256",
      "installed-migration-set-sha256",
      "installed-schema-version",
      "slot-version",
      "heartbeat-at",
      "expires-at",
    ]);
    return markProductionInstallAwaitingGate6({
      ...root,
      operationId,
      releaseHash,
      targetHash,
      leaseOwner: values["lease-owner"] ?? `workflow:${operationId}`,
      binding: {
        operationId,
        transferTokenSha256: requiredArg(values, "transfer-token-sha256", SHA256_PATTERN),
        protectedInstallEvidenceSha256: requiredArg(
          values,
          "protected-install-evidence-sha256",
          SHA256_PATTERN,
        ),
        releaseSha: requiredArg(values, "source-sha", /^[0-9a-f]{40}$/),
        targetDescriptorSha256: targetHash,
        operatorBundleSha256: requiredArg(values, "operator-bundle-sha256", SHA256_PATTERN),
        installedMigrationSetSha256: requiredArg(
          values,
          "installed-migration-set-sha256",
          SHA256_PATTERN,
        ),
        installedSchemaVersion: Number(requiredArg(values, "installed-schema-version", /^\d+$/)),
        heartbeatAt: requiredArg(values, "heartbeat-at"),
        expiresAt: requiredArg(values, "expires-at"),
        slotVersion: Number(requiredArg(values, "slot-version", /^\d+$/)),
      },
    });
  }
  assertCliKeys(values, [
    "action",
    "root",
    "operation-id",
    "release-sha256",
    "target-sha256",
    "postcondition",
    "postcondition-sha256",
    "lease-owner",
  ]);
  const postcondition = requiredArg(values, "postcondition", /^(?:healthy|rolled-back)$/);
  let postconditionHash = values["postcondition-sha256"];
  if (postcondition === "rolled-back" && postconditionHash === undefined) {
    fail("production-mutation-lock-rollback-evidence-required");
  }
  if (postconditionHash === undefined) {
    const lock = await readProductionMutationLock(root);
    assertIdentity(lock, { operationId, releaseHash, targetHash });
    postconditionHash = postcondition === "healthy" ? lock.targetHash : lock.rollbackJournalHash;
  }
  return markProductionMutationTerminal({
    ...root,
    operationId,
    releaseHash,
    targetHash,
    leaseOwner: values["lease-owner"] ?? `workflow:${operationId}`,
    terminalPostcondition: {
      kind: postcondition === "healthy" ? "healthy-baseline" : "rollback-restored",
      hash: requiredArg({ value: postconditionHash }, "value", SHA256_PATTERN),
    },
  });
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const watch = values.watch === "true";
  if (values.watch !== undefined && values.watch !== "true" && values.watch !== "false") {
    fail("production-mutation-lock-cli-invalid");
  }
  if (!watch) {
    const result = await runCliOnce(values);
    console.log(JSON.stringify({ ok: true, outcome: result.outcome ?? result.state }));
    return;
  }
  if (values.action !== "reconcile") fail("production-mutation-lock-cli-invalid");
  const intervalMs = Number(values["interval-ms"] ?? 5_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) {
    fail("production-mutation-lock-cli-invalid");
  }
  let stopped = false;
  process.once("SIGTERM", () => {
    stopped = true;
  });
  process.once("SIGINT", () => {
    stopped = true;
  });
  while (!stopped) {
    await runCliOnce(values);
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => {
    console.error("production-mutation-lock-failed");
    process.exitCode = 1;
  });
}
