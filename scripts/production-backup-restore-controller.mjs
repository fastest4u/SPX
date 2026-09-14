#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Canonical } from "./lib/evidence-artifact.mjs";
import {
  PRODUCTION_BACKUP_CORE_KEYS,
  PRODUCTION_BACKUP_PRODUCER_KEYS,
  PRODUCTION_BACKUP_SIGNATURE_KEYS,
  verifyProductionBackupRestoreEvidence,
} from "./production-backup-restore-evidence.mjs";

export const BACKUP_ROOT = "/var/lib/spx-production-backup";
export const BACKUP_EXPORT_ROOT = "/var/lib/spx-production-backup/export";
export const BACKUP_EVIDENCE_FILE = "production-backup-restore-evidence.json";
export const BACKUP_SIGNATURE_FILE = "production-backup-restore-signature.json";
export const BACKUP_CONTEXT_FILE =
  "/var/lib/spx-production-backup/context/verified-backup-context.json";
export const ISOLATED_RESTORE_PROJECT_PREFIX = "spx-backup-restore-";

const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MYSQL_IMAGE = /^mysql@sha256:[0-9a-f]{64}$/;
const SECRET_VALUE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];

const CONTEXT_KEYS = Object.freeze([
  "schemaVersion",
  "operationId",
  "candidateSha",
  "releaseManifestSha256",
  "targetDescriptorSha256",
  "databaseFingerprint",
  "createdAt",
  "limits",
  "producer",
  "implementationSha256",
  "sourceCredentialSha256",
  "kmsCapabilitySha256",
  "kmsKeyId",
  "evidenceSigningKeyId",
  "isolatedMysqlImageDigest",
  "executableSha256",
]);
const LIMIT_KEYS = Object.freeze(["maximumAgeMinutes", "maximumRpoMinutes", "maximumRtoMinutes"]);
const EXECUTABLE_KEYS = Object.freeze(["mysqldump", "mysql", "docker", "kmsEnvelope"]);
const IMPLEMENTATION_KEYS = Object.freeze([
  "controllerSha256",
  "liveAdapterSha256",
  "invariantDefinitionsSha256",
  "isolatedComposeSha256",
]);
const QUIESCENCE_KEYS = Object.freeze([
  "phase",
  "observedAt",
  "hostLockState",
  "gate6DatabaseSlotState",
  "observationSha256",
]);
const FINGERPRINT_KEYS = Object.freeze(["databaseFingerprint", "capturedAt"]);
const BACKUP_KEYS = Object.freeze([
  "backupSha256",
  "encryptionMetadataSha256",
  "createdAt",
  "encrypted",
  "beforeDdl",
  "databaseFingerprint",
]);
const BOUNDARY_KEYS = Object.freeze([
  "environment",
  "productionRoutesPresent",
  "providerCredentialsPresent",
  "backgroundServicesPresent",
  "sharedWritableVolumesPresent",
]);
const RESTORE_KEYS = Object.freeze(["databaseFingerprint", "restoredSchemaSha256"]);
const INVARIANT_KEYS = Object.freeze(["invariantDefinitionsSha256", "invariantResultsSha256"]);
const ROW_DIGEST_KEYS = Object.freeze(["rowCountDigestSha256"]);
const TEARDOWN_KEYS = Object.freeze(["teardownProven", "destroyedAt"]);
const ADAPTER_METHODS = Object.freeze([
  "recoverAbandonedOperation",
  "assertMutationQuiescent",
  "readProductionFingerprint",
  "createEncryptedBackup",
  "startIsolatedRestore",
  "restoreBackup",
  "verifyFixedInvariants",
  "captureSanitizedRowCountDigest",
  "destroyIsolatedRestore",
  "signEvidenceCore",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactRecord(value, keys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must contain exact keys`);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    canonicalJson([...ownKeys].sort()) !== canonicalJson([...keys].sort())
  ) {
    throw new Error(`${label} must contain exact keys`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor)
    ) {
      throw new Error(`${label} must be a strict data record`);
    }
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function assertNoSecretShapedContent(value, label) {
  const visit = (current) => {
    if (typeof current === "string") {
      if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        throw new Error(`${label} contains secret-shaped content`);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (isPlainObject(current)) {
      for (const item of Object.values(current)) visit(item);
    }
  };
  visit(value);
}

function assertPositiveLimit(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function validateProducer(producer) {
  assertExactRecord(producer, PRODUCTION_BACKUP_PRODUCER_KEYS, "producer");
  if (
    producer.repository !== "fastest4u/SPX" ||
    producer.environment !== "production" ||
    producer.workflow !== ".github/workflows/trusted-production-backup-restore.yml" ||
    !SHA.test(producer.workflowSha ?? "")
  ) {
    throw new Error("producer identity is invalid");
  }
  for (const key of PRODUCTION_BACKUP_PRODUCER_KEYS.slice(4)) {
    assertSha256(producer[key], `producer ${key}`);
  }
}

function validateContext(context) {
  assertExactRecord(context, CONTEXT_KEYS, "production backup context");
  assertExactRecord(context.limits, LIMIT_KEYS, "production backup limits");
  assertExactRecord(context.executableSha256, EXECUTABLE_KEYS, "executable hashes");
  assertExactRecord(
    context.implementationSha256,
    IMPLEMENTATION_KEYS,
    "production backup implementation hashes",
  );
  validateProducer(context.producer);
  if (
    context.schemaVersion !== 1 ||
    !OPERATION_ID.test(context.operationId ?? "") ||
    !SHA.test(context.candidateSha ?? "") ||
    !DIGEST.test(context.databaseFingerprint ?? "") ||
    !SAFE_ID.test(context.kmsKeyId ?? "") ||
    !SAFE_ID.test(context.evidenceSigningKeyId ?? "") ||
    !MYSQL_IMAGE.test(context.isolatedMysqlImageDigest ?? "")
  ) {
    throw new Error("production backup context identity is invalid");
  }
  timestamp(context.createdAt, "production backup context creation time");
  for (const key of [
    "releaseManifestSha256",
    "targetDescriptorSha256",
    "sourceCredentialSha256",
    "kmsCapabilitySha256",
  ]) {
    assertSha256(context[key], `production backup context ${key}`);
  }
  for (const key of EXECUTABLE_KEYS) {
    assertSha256(context.executableSha256[key], `executable ${key}`);
  }
  for (const key of IMPLEMENTATION_KEYS) {
    assertSha256(context.implementationSha256[key], `implementation ${key}`);
  }
  for (const key of LIMIT_KEYS) assertPositiveLimit(context.limits[key], key);
  assertNoSecretShapedContent(context, "production backup context");
  return context;
}

function validateAdapter(adapter) {
  if (!isPlainObject(adapter)) throw new Error("production backup adapter is invalid");
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`production backup adapter method ${method} is required`);
    }
  }
}

function validateQuiescence(value, label, expectedPhase) {
  assertExactRecord(value, QUIESCENCE_KEYS, label);
  if (value.phase !== expectedPhase) {
    throw new Error(`${label} phase is invalid`);
  }
  if (value.hostLockState !== "absent" || value.gate6DatabaseSlotState !== "absent") {
    throw new Error(`${label} did not prove production mutation quiescent`);
  }
  assertSha256(value.observationSha256, `${label} observation hash`);
  timestamp(value.observedAt, `${label} observation time`);
  const core = {
    phase: expectedPhase,
    observedAt: value.observedAt,
    hostLockState: value.hostLockState,
    gate6DatabaseSlotState: value.gate6DatabaseSlotState,
  };
  if (value.observationSha256 !== sha256Canonical(core)) {
    throw new Error(`${label} observation hash is invalid`);
  }
  return {
    observedAt: value.observedAt,
    hostLockState: value.hostLockState,
    gate6DatabaseSlotState: value.gate6DatabaseSlotState,
    observationSha256: value.observationSha256,
  };
}

function validateFingerprint(value, expectedFingerprint) {
  assertExactRecord(value, FINGERPRINT_KEYS, "production database fingerprint");
  if (
    !DIGEST.test(value.databaseFingerprint ?? "") ||
    value.databaseFingerprint !== expectedFingerprint
  ) {
    throw new Error("production database fingerprint does not match the protected target");
  }
  timestamp(value.capturedAt, "production fingerprint capture time");
  return value;
}

function validateBackup(value, expectedFingerprint) {
  assertExactRecord(value, BACKUP_KEYS, "encrypted backup result");
  assertSha256(value.backupSha256, "encrypted backup hash");
  assertSha256(value.encryptionMetadataSha256, "encryption metadata hash");
  timestamp(value.createdAt, "backup creation time");
  if (value.databaseFingerprint !== expectedFingerprint) {
    throw new Error("production database fingerprint changed during backup capture");
  }
  if (value.encrypted !== true) throw new Error("production backup was not encrypted");
  if (value.beforeDdl !== true) throw new Error("production backup was not captured before DDL");
  return value;
}

function validateBoundary(value) {
  assertExactRecord(value, BOUNDARY_KEYS, "isolated restore boundary");
  if (
    value.environment !== "isolated" ||
    value.productionRoutesPresent !== false ||
    value.providerCredentialsPresent !== false ||
    value.backgroundServicesPresent !== false ||
    value.sharedWritableVolumesPresent !== false
  ) {
    throw new Error("isolated restore boundary is invalid");
  }
  return value;
}

function validateRestore(value, productionFingerprint) {
  assertExactRecord(value, RESTORE_KEYS, "isolated restore result");
  if (
    !DIGEST.test(value.databaseFingerprint ?? "") ||
    value.databaseFingerprint === productionFingerprint
  ) {
    throw new Error("isolated restore fingerprint must be distinct from production");
  }
  assertSha256(value.restoredSchemaSha256, "restored schema hash");
  return value;
}

function validateInvariants(value, expectedDefinitionsSha256) {
  assertExactRecord(value, INVARIANT_KEYS, "fixed invariant result");
  assertSha256(value.invariantDefinitionsSha256, "invariant definitions hash");
  assertSha256(value.invariantResultsSha256, "invariant results hash");
  if (value.invariantDefinitionsSha256 !== expectedDefinitionsSha256) {
    throw new Error("fixed invariant definitions do not match the protected producer");
  }
  return value;
}

function validateRowDigest(value) {
  assertExactRecord(value, ROW_DIGEST_KEYS, "sanitized row-count digest");
  assertSha256(value.rowCountDigestSha256, "sanitized row-count digest hash");
  return value;
}

function validateTeardown(value) {
  assertExactRecord(value, TEARDOWN_KEYS, "isolated restore teardown");
  timestamp(value.destroyedAt, "isolated restore teardown time");
  if (value.teardownProven !== true) throw new Error("isolated restore teardown was not proven");
  return value;
}

function validateSignature(signature, context, core) {
  assertExactRecord(signature, PRODUCTION_BACKUP_SIGNATURE_KEYS, "production backup signature");
  if (
    signature.schemaVersion !== 1 ||
    signature.algorithm !== "kms-sha256" ||
    signature.keyId !== context.evidenceSigningKeyId ||
    signature.subjectSha256 !== sha256Canonical(core) ||
    typeof signature.signatureBase64 !== "string"
  ) {
    throw new Error("production backup signature is invalid");
  }
  assertSha256(signature.subjectSha256, "production backup signature subject");
  const bytes = Buffer.from(signature.signatureBase64, "base64");
  if (bytes.length < 16 || bytes.toString("base64") !== signature.signatureBase64) {
    throw new Error("production backup signature bytes are invalid");
  }
  timestamp(signature.signedAt, "production backup signature time");
  assertNoSecretShapedContent(signature, "production backup signature");
  return signature;
}

function immutableClone(value) {
  const clone = JSON.parse(canonicalJson(value));
  const freeze = (current) => {
    if (current && typeof current === "object") {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(clone);
}

async function executeProductionBackupRestore(contextInput, adapter) {
  const context = immutableClone(validateContext(contextInput));
  validateAdapter(adapter);

  await adapter.recoverAbandonedOperation();
  const beforeCapture = immutableClone(
    validateQuiescence(
      await adapter.assertMutationQuiescent("before-capture"),
      "pre-capture quiescence",
      "before-capture",
    ),
  );
  const fingerprint = immutableClone(
    validateFingerprint(await adapter.readProductionFingerprint(), context.databaseFingerprint),
  );

  let backup;
  let boundary;
  let restore;
  let invariants;
  let rowDigest;
  let teardown;
  let afterTeardown;
  let operationError;
  let cleanupArmed = false;

  try {
    cleanupArmed = true;
    backup = immutableClone(
      validateBackup(
        await adapter.createEncryptedBackup({ context, productionFingerprint: fingerprint }),
        fingerprint.databaseFingerprint,
      ),
    );
    boundary = immutableClone(
      validateBoundary(await adapter.startIsolatedRestore({ context, backup })),
    );
    restore = immutableClone(
      validateRestore(
        await adapter.restoreBackup({ context, backup, boundary }),
        fingerprint.databaseFingerprint,
      ),
    );
    invariants = immutableClone(
      validateInvariants(
        await adapter.verifyFixedInvariants({ context, restore }),
        context.implementationSha256.invariantDefinitionsSha256,
      ),
    );
    rowDigest = immutableClone(
      validateRowDigest(await adapter.captureSanitizedRowCountDigest({ context, restore })),
    );
  } catch (error) {
    operationError = error;
  } finally {
    if (cleanupArmed) {
      try {
        teardown = immutableClone(
          validateTeardown(await adapter.destroyIsolatedRestore({ context })),
        );
      } catch (error) {
        if (operationError === undefined) operationError = error;
      }
      try {
        afterTeardown = immutableClone(
          validateQuiescence(
            await adapter.assertMutationQuiescent("after-teardown"),
            "post-teardown quiescence",
            "after-teardown",
          ),
        );
      } catch (error) {
        if (operationError === undefined) operationError = error;
      }
    }
  }
  if (operationError !== undefined) throw operationError;

  const contextCreatedAt = timestamp(context.createdAt, "production backup context creation time");
  const beforeObservedAt = timestamp(beforeCapture.observedAt, "pre-capture quiescence time");
  const fingerprintCapturedAt = timestamp(
    fingerprint.capturedAt,
    "production fingerprint capture time",
  );
  const createdAt = timestamp(backup.createdAt, "backup creation time");
  const destroyedAt = timestamp(teardown.destroyedAt, "isolated restore teardown time");
  const verifiedAt = timestamp(afterTeardown.observedAt, "post-teardown quiescence time");
  const rpoMinutes = (createdAt - fingerprintCapturedAt) / 60_000;
  const rtoMinutes = (verifiedAt - createdAt) / 60_000;
  if (
    contextCreatedAt > beforeObservedAt ||
    beforeObservedAt > fingerprintCapturedAt ||
    fingerprintCapturedAt > createdAt ||
    createdAt > destroyedAt ||
    destroyedAt > verifiedAt
  ) {
    throw new Error("production backup timestamp order is invalid");
  }
  if (rpoMinutes < 0 || rpoMinutes > context.limits.maximumRpoMinutes) {
    throw new Error("production backup RPO exceeds the protected limit");
  }
  if (rtoMinutes < 0 || rtoMinutes > context.limits.maximumRtoMinutes) {
    throw new Error("production backup RTO exceeds the protected limit");
  }
  if (verifiedAt - createdAt > context.limits.maximumAgeMinutes * 60_000) {
    throw new Error("production backup is stale at verification time");
  }

  const core = immutableClone({
    schemaVersion: 1,
    releaseEnvironment: "production",
    operationId: context.operationId,
    candidateSha: context.candidateSha,
    releaseManifestSha256: context.releaseManifestSha256,
    targetDescriptorSha256: context.targetDescriptorSha256,
    databaseFingerprint: fingerprint.databaseFingerprint,
    backupSha256: backup.backupSha256,
    encryptionMetadataSha256: backup.encryptionMetadataSha256,
    encrypted: true,
    fingerprintCapturedAt: fingerprint.capturedAt,
    createdAt: backup.createdAt,
    beforeDdl: true,
    isolatedRestore: {
      ...boundary,
      databaseFingerprint: restore.databaseFingerprint,
      restoredSchemaSha256: restore.restoredSchemaSha256,
      invariantDefinitionsSha256: invariants.invariantDefinitionsSha256,
      invariantResultsSha256: invariants.invariantResultsSha256,
      rowCountDigestSha256: rowDigest.rowCountDigestSha256,
      teardownProven: true,
      destroyedAt: teardown.destroyedAt,
    },
    quiescence: { beforeCapture, afterTeardown },
    rpoMinutes,
    rtoMinutes,
    verifiedAt: afterTeardown.observedAt,
    producer: context.producer,
  });
  assertExactRecord(core, PRODUCTION_BACKUP_CORE_KEYS, "production backup evidence core");
  assertNoSecretShapedContent(core, "production backup evidence core");

  const signature = immutableClone(
    validateSignature(await adapter.signEvidenceCore(core), context, core),
  );
  if (timestamp(signature.signedAt, "signature time") < verifiedAt) {
    throw new Error("production backup signature time precedes verification");
  }
  const evidence = immutableClone({ ...core, signatureSha256: sha256Canonical(signature) });
  verifyProductionBackupRestoreEvidence(evidence, signature, {
    candidateSha: context.candidateSha,
    releaseManifestSha256: context.releaseManifestSha256,
    targetDescriptorSha256: context.targetDescriptorSha256,
    databaseFingerprint: context.databaseFingerprint,
    evidenceSigningKeyId: context.evidenceSigningKeyId,
    invariantDefinitionsSha256: context.implementationSha256.invariantDefinitionsSha256,
    producer: context.producer,
    maximumAgeMinutes: context.limits.maximumAgeMinutes,
    maximumRpoMinutes: context.limits.maximumRpoMinutes,
    maximumRtoMinutes: context.limits.maximumRtoMinutes,
    now: new Date(signature.signedAt),
  });
  return Object.freeze({ evidence, signature });
}

export async function runProductionBackupRestore(context, adapter) {
  const result = await executeProductionBackupRestore(context, adapter);
  return result.evidence;
}

async function assertPrivateExportRoot(exportRoot) {
  const [status, canonical] = await Promise.all([
    lstat(exportRoot, { bigint: true }),
    realpath(exportRoot),
  ]);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    (process.platform !== "win32" &&
      (status.uid !== 0n || (Number(status.mode) & 0o777) !== 0o700)) ||
    resolve(canonical) !== resolve(exportRoot)
  ) {
    throw new Error("production backup export root is invalid");
  }
}

async function writeCreateOnce(path, value) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(Buffer.from(canonicalJson(value), "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function verifyStableCanonicalFile(path, value) {
  const expectedBytes = Buffer.from(canonicalJson(value), "utf8");
  if (expectedBytes.length > 256 * 1024) throw new Error("production backup artifact is too large");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size !== BigInt(expectedBytes.length) ||
      (process.platform !== "win32" &&
        (before.uid !== 0n || before.nlink !== 1n || (Number(before.mode) & 0o777) !== 0o400))
    ) {
      throw new Error("production backup artifact identity is invalid");
    }
    const actualBytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || !actualBytes.equals(expectedBytes)) {
      throw new Error("production backup artifact changed during stable read");
    }
  } finally {
    await handle.close();
  }
  return sha256Canonical(value);
}

async function syncDirectory(exportRoot) {
  if (process.platform === "win32") return;
  const directory = await open(
    exportRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeInstalledArtifacts(evidence, signature, exportRoot = BACKUP_EXPORT_ROOT) {
  await assertPrivateExportRoot(exportRoot);
  const signaturePath = join(exportRoot, BACKUP_SIGNATURE_FILE);
  const evidencePath = join(exportRoot, BACKUP_EVIDENCE_FILE);
  let wroteSignature = false;
  let wroteEvidence = false;
  try {
    await writeCreateOnce(signaturePath, signature);
    wroteSignature = true;
    await writeCreateOnce(evidencePath, evidence);
    wroteEvidence = true;
    const signatureSha256 = await verifyStableCanonicalFile(signaturePath, signature);
    const evidenceSha256 = await verifyStableCanonicalFile(evidencePath, evidence);
    await syncDirectory(exportRoot);
    return Object.freeze({ evidenceSha256, signatureSha256 });
  } catch (error) {
    if (wroteSignature) await unlink(signaturePath).catch(() => {});
    if (wroteEvidence) await unlink(evidencePath).catch(() => {});
    throw error;
  }
}

export async function writeProductionBackupRestoreArtifactsForTest(
  evidence,
  signature,
  exportRoot,
) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("test-only production backup artifact writer is forbidden");
  }
  if (typeof exportRoot !== "string" || resolve(exportRoot) !== exportRoot) {
    throw new Error("test-only production backup export root must be absolute");
  }
  return writeInstalledArtifacts(evidence, signature, exportRoot);
}

async function main() {
  if (process.argv.length !== 2) throw new Error("arguments are forbidden");
  const { createProductionBackupLiveAdapter, loadVerifiedBackupContext } =
    await import("./lib/production-backup-live-adapter.mjs");
  const context = await loadVerifiedBackupContext();
  const adapter = createProductionBackupLiveAdapter(context);
  const result = await executeProductionBackupRestore(context, adapter);
  await writeInstalledArtifacts(result.evidence, result.signature);
  process.stdout.write(
    `${canonicalJson({
      ok: true,
      evidenceSha256: sha256Canonical(result.evidence),
      files: [BACKUP_EVIDENCE_FILE, BACKUP_SIGNATURE_FILE].sort(),
    })}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('{"ok":false,"code":"production-backup-restore-failed"}\n');
    process.exitCode = 1;
  });
}
