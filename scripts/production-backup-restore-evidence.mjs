#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Canonical } from "./lib/evidence-artifact.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SECRET_VALUE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];

export const PRODUCTION_BACKUP_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "releaseEnvironment",
  "operationId",
  "candidateSha",
  "releaseManifestSha256",
  "targetDescriptorSha256",
  "databaseFingerprint",
  "backupSha256",
  "encryptionMetadataSha256",
  "encrypted",
  "fingerprintCapturedAt",
  "createdAt",
  "beforeDdl",
  "isolatedRestore",
  "quiescence",
  "rpoMinutes",
  "rtoMinutes",
  "verifiedAt",
  "producer",
  "signatureSha256",
]);

export const PRODUCTION_BACKUP_CORE_KEYS = Object.freeze(
  PRODUCTION_BACKUP_EVIDENCE_KEYS.filter((key) => key !== "signatureSha256"),
);

export const PRODUCTION_BACKUP_SIGNATURE_KEYS = Object.freeze([
  "schemaVersion",
  "algorithm",
  "keyId",
  "subjectSha256",
  "signatureBase64",
  "signedAt",
]);

export const PRODUCTION_BACKUP_PRODUCER_KEYS = Object.freeze([
  "repository",
  "environment",
  "workflow",
  "workflowSha",
  "workflowFileSha256",
]);

const ISOLATED_RESTORE_KEYS = Object.freeze([
  "environment",
  "databaseFingerprint",
  "productionRoutesPresent",
  "providerCredentialsPresent",
  "backgroundServicesPresent",
  "sharedWritableVolumesPresent",
  "restoredSchemaSha256",
  "invariantDefinitionsSha256",
  "invariantResultsSha256",
  "rowCountDigestSha256",
  "teardownProven",
  "destroyedAt",
]);

const QUIESCENCE_KEYS = Object.freeze(["beforeCapture", "afterTeardown"]);
const QUIESCENCE_OBSERVATION_KEYS = Object.freeze([
  "observedAt",
  "hostLockState",
  "gate6DatabaseSlotState",
  "observationSha256",
]);
const EXPECTED_POLICY_KEYS = Object.freeze([
  "candidateSha",
  "releaseManifestSha256",
  "targetDescriptorSha256",
  "databaseFingerprint",
  "evidenceSigningKeyId",
  "invariantDefinitionsSha256",
  "producer",
  "maximumAgeMinutes",
  "maximumRpoMinutes",
  "maximumRtoMinutes",
  "now",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (
    !isPlainObject(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  ) {
    throw new Error(`${label} must contain exact keys`);
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

function assertNoSecretShapedContent(value, label = "production backup evidence") {
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

function assertProducer(value, expected) {
  assertExactKeys(value, PRODUCTION_BACKUP_PRODUCER_KEYS, "production backup producer");
  if (
    value.repository !== "fastest4u/SPX" ||
    value.environment !== "production" ||
    value.workflow !== ".github/workflows/trusted-production-backup-restore.yml" ||
    !SHA.test(value.workflowSha ?? "")
  ) {
    throw new Error("production backup producer identity is invalid");
  }
  for (const key of PRODUCTION_BACKUP_PRODUCER_KEYS.slice(4)) {
    assertSha256(value[key], `production backup producer ${key}`);
  }
  if (!isPlainObject(expected) || canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("production backup producer does not match the protected producer");
  }
}

function assertQuiescenceObservation(value, label, phase) {
  assertExactKeys(value, QUIESCENCE_OBSERVATION_KEYS, label);
  if (value.hostLockState !== "absent" || value.gate6DatabaseSlotState !== "absent") {
    throw new Error(`${label} did not prove production mutation quiescent`);
  }
  assertSha256(value.observationSha256, `${label} hash`);
  const observedAt = timestamp(value.observedAt, `${label} time`);
  if (
    value.observationSha256 !==
    sha256Canonical({
      phase,
      observedAt: value.observedAt,
      hostLockState: value.hostLockState,
      gate6DatabaseSlotState: value.gate6DatabaseSlotState,
    })
  ) {
    throw new Error(`${label} observation hash is invalid`);
  }
  return observedAt;
}

function assertSignatureShape(signature) {
  assertExactKeys(signature, PRODUCTION_BACKUP_SIGNATURE_KEYS, "production backup signature");
  if (
    signature.schemaVersion !== 1 ||
    signature.algorithm !== "kms-sha256" ||
    typeof signature.keyId !== "string" ||
    !SAFE_KEY_ID.test(signature.keyId)
  ) {
    throw new Error("production backup signature identity is invalid");
  }
  assertSha256(signature.subjectSha256, "production backup signature subject");
  if (typeof signature.signatureBase64 !== "string" || signature.signatureBase64.length > 16_384) {
    throw new Error("production backup signature bytes are invalid");
  }
  const bytes = Buffer.from(signature.signatureBase64, "base64");
  if (bytes.length < 16 || bytes.toString("base64") !== signature.signatureBase64) {
    throw new Error("production backup signature bytes are invalid");
  }
  const decodedText = bytes.toString("utf8");
  if (!decodedText.includes("\uFFFD"))
    assertNoSecretShapedContent(decodedText, "production backup signature");
  return timestamp(signature.signedAt, "production backup signature time");
}

function assertExpectedPolicy(expected) {
  assertExactKeys(expected, EXPECTED_POLICY_KEYS, "production backup expected policy");
  if (
    !SHA.test(expected.candidateSha ?? "") ||
    !SHA256.test(expected.releaseManifestSha256 ?? "") ||
    !SHA256.test(expected.targetDescriptorSha256 ?? "") ||
    !DIGEST.test(expected.databaseFingerprint ?? "") ||
    !SHA256.test(expected.invariantDefinitionsSha256 ?? "") ||
    typeof expected.evidenceSigningKeyId !== "string" ||
    !SAFE_KEY_ID.test(expected.evidenceSigningKeyId) ||
    !(expected.now instanceof Date) ||
    !Number.isFinite(expected.now.getTime()) ||
    !Number.isFinite(expected.maximumAgeMinutes) ||
    expected.maximumAgeMinutes <= 0 ||
    !Number.isFinite(expected.maximumRpoMinutes) ||
    expected.maximumRpoMinutes <= 0 ||
    !Number.isFinite(expected.maximumRtoMinutes) ||
    expected.maximumRtoMinutes <= 0
  ) {
    throw new Error("production backup expected policy is invalid");
  }
  assertProducer(expected.producer, expected.producer);
}

export function evidenceCoreFromFinal(evidence) {
  assertExactKeys(evidence, PRODUCTION_BACKUP_EVIDENCE_KEYS, "production backup evidence");
  const core = {};
  for (const key of PRODUCTION_BACKUP_CORE_KEYS) core[key] = evidence[key];
  return core;
}

export function verifyProductionBackupRestoreEvidence(evidence, signature, expected) {
  assertExactKeys(evidence, PRODUCTION_BACKUP_EVIDENCE_KEYS, "production backup evidence");
  assertSignatureShape(signature);
  assertExpectedPolicy(expected);
  assertNoSecretShapedContent(evidence);
  assertNoSecretShapedContent(signature, "production backup signature");

  if (
    evidence.schemaVersion !== 1 ||
    evidence.releaseEnvironment !== "production" ||
    !OPERATION_ID.test(evidence.operationId ?? "") ||
    !SHA.test(evidence.candidateSha ?? "") ||
    !DIGEST.test(evidence.databaseFingerprint ?? "") ||
    evidence.encrypted !== true
  ) {
    throw new Error("production backup evidence identity is invalid");
  }
  for (const key of [
    "releaseManifestSha256",
    "targetDescriptorSha256",
    "backupSha256",
    "encryptionMetadataSha256",
    "signatureSha256",
  ]) {
    assertSha256(evidence[key], `production backup evidence ${key}`);
  }
  if (
    evidence.candidateSha !== expected.candidateSha ||
    evidence.releaseManifestSha256 !== expected.releaseManifestSha256 ||
    evidence.targetDescriptorSha256 !== expected.targetDescriptorSha256 ||
    evidence.databaseFingerprint !== expected.databaseFingerprint ||
    signature.keyId !== expected.evidenceSigningKeyId
  ) {
    throw new Error("production backup evidence binding is invalid");
  }
  assertProducer(evidence.producer, expected.producer);

  if (evidence.beforeDdl !== true) {
    throw new Error("production backup was not proven before DDL");
  }

  const restore = evidence.isolatedRestore;
  assertExactKeys(restore, ISOLATED_RESTORE_KEYS, "isolated restore evidence");
  if (
    restore.environment !== "isolated" ||
    restore.productionRoutesPresent !== false ||
    restore.providerCredentialsPresent !== false ||
    restore.backgroundServicesPresent !== false ||
    restore.sharedWritableVolumesPresent !== false ||
    restore.teardownProven !== true ||
    !DIGEST.test(restore.databaseFingerprint ?? "") ||
    restore.databaseFingerprint === evidence.databaseFingerprint
  ) {
    throw new Error("isolated restore boundary or teardown was not proven");
  }
  for (const key of [
    "restoredSchemaSha256",
    "invariantDefinitionsSha256",
    "invariantResultsSha256",
    "rowCountDigestSha256",
  ]) {
    assertSha256(restore[key], `isolated restore ${key}`);
  }
  if (restore.invariantDefinitionsSha256 !== expected.invariantDefinitionsSha256) {
    throw new Error("isolated restore invariant definitions are not producer-bound");
  }

  assertExactKeys(evidence.quiescence, QUIESCENCE_KEYS, "production backup quiescence");
  const beforeQuiescence = assertQuiescenceObservation(
    evidence.quiescence.beforeCapture,
    "pre-capture quiescence",
    "before-capture",
  );
  const afterQuiescence = assertQuiescenceObservation(
    evidence.quiescence.afterTeardown,
    "post-teardown quiescence",
    "after-teardown",
  );
  const fingerprintCapturedAt = timestamp(
    evidence.fingerprintCapturedAt,
    "production fingerprint capture time",
  );
  const createdAt = timestamp(evidence.createdAt, "backup creation time");
  const destroyedAt = timestamp(restore.destroyedAt, "isolated restore teardown time");
  const verifiedAt = timestamp(evidence.verifiedAt, "backup verification time");
  const signedAt = timestamp(signature.signedAt, "production backup signature time");
  if (
    beforeQuiescence > fingerprintCapturedAt ||
    fingerprintCapturedAt > createdAt ||
    createdAt > destroyedAt ||
    destroyedAt > afterQuiescence ||
    verifiedAt !== afterQuiescence ||
    signedAt < verifiedAt
  ) {
    throw new Error("production backup evidence or signature time order is invalid");
  }

  const exactRpoMinutes = (createdAt - fingerprintCapturedAt) / 60_000;
  const exactRtoMinutes = (verifiedAt - createdAt) / 60_000;
  if (
    evidence.rpoMinutes !== exactRpoMinutes ||
    evidence.rtoMinutes !== exactRtoMinutes ||
    !Number.isFinite(evidence.rpoMinutes) ||
    evidence.rpoMinutes < 0 ||
    evidence.rpoMinutes > expected.maximumRpoMinutes ||
    !Number.isFinite(evidence.rtoMinutes) ||
    evidence.rtoMinutes < 0 ||
    evidence.rtoMinutes > expected.maximumRtoMinutes
  ) {
    throw new Error("backup RPO/RTO exceeds approval or does not match timestamps");
  }
  const now = expected.now.getTime();
  if (now < verifiedAt || now - createdAt > expected.maximumAgeMinutes * 60_000) {
    throw new Error("backup evidence is stale or temporally invalid");
  }
  if (signedAt > now) {
    throw new Error("production backup signature is future-dated");
  }

  const core = evidenceCoreFromFinal(evidence);
  if (signature.subjectSha256 !== sha256Canonical(core)) {
    throw new Error("production backup signature subject does not bind the evidence core");
  }
  if (evidence.signatureSha256 !== sha256Canonical(signature)) {
    throw new Error("production backup signature hash does not bind the signature file");
  }

  return Object.freeze({
    ok: true,
    evidenceSha256: sha256Canonical(evidence),
    backupSha256: evidence.backupSha256,
    verifiedAt: evidence.verifiedAt,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write('{"ok":false,"code":"backup-evidence-requires-signed-inputs"}\n');
  process.exitCode = 1;
}
