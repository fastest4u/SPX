#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { posix } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Canonical } from "./lib/evidence-artifact.mjs";
import {
  commitPreparedGate6SlotWithMysqlClient,
  previewPreparedGate6SlotWithMysqlClient,
  readPreparedGate6SlotWithMysqlClient,
} from "./protected-install-watchdog.mjs";
import {
  commitProductionInstallHostLock,
  previewProductionInstallHostLockCommit,
  readProductionInstallHostLockCommit,
} from "./production-mutation-host-lock.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIGRATION = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const KMS_TIMEOUT_MS = 30 * 1_000;
const KMS_EXECUTABLE = "/usr/local/libexec/spx-kms-envelope";
const KMS_CAPABILITY_FILE = "/run/credentials/spx-protected-install-evidence-kms.json";
const KMS_ENV = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: "/nonexistent" });
const SECRET_VALUE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];

export const PROTECTED_INSTALL_PATHS = Object.freeze({
  root: "/var/lib/spx-protected-install",
  contextRoot: "/var/lib/spx-protected-install/context",
  preparedRoot: "/var/lib/spx-protected-install/prepared",
  committedRoot: "/var/lib/spx-protected-install/committed",
  exportRoot: "/var/lib/spx-protected-install/export",
  evidenceExport: "/var/lib/spx-protected-install/export/protected-install-evidence.json",
  signatureExport: "/var/lib/spx-protected-install/export/protected-install-signature.json",
});

const REQUIRED_CONTEXT_FILES = Object.freeze([
  "verified-install-context.json",
  "verified-producer-context.json",
  "verified-backup-evidence-summary.json",
  "verified-migration-receipt.json",
  "verified-online-ddl-receipts.json",
  "verified-grant-evidence.json",
  "verified-service-activation-journal.json",
  "verified-watchdog-journal.json",
  "verified-health-evidence.json",
  "verified-watermark-evidence.json",
  "verified-rollback-readiness.json",
  "verified-signing-context.json",
]);

export const PROTECTED_INSTALL_INPUT_FILES = Object.freeze({
  root: PROTECTED_INSTALL_PATHS.contextRoot,
  required: REQUIRED_CONTEXT_FILES,
  signingIntentFile: "protected-install-signing-intent.json",
  signatureFile: "protected-install-signature.json",
});

export const PROTECTED_INSTALL_BASELINE_SERVICES = Object.freeze([
  "web-api",
  "notification-service",
  "line-service",
  "ocr-service",
  "worker-ifn-split",
  "worker-ptwl-split",
]);

const PRODUCER_FIELDS = [
  "repository",
  "environment",
  "workflow",
  "workflowSha",
  "workflowFileSha256",
];
const OWNED_LOCK_FIELDS = ["operationId", "state", "version"];
const CORE_FIELDS = [
  "schemaVersion",
  "releaseEnvironment",
  "operationId",
  "candidateSha",
  "candidateImageDigest",
  "rollbackSha",
  "rollbackImageDigest",
  "releaseManifestSha256",
  "rollbackReleaseManifestSha256",
  "productionTargetDescriptorSha256",
  "releaseOperatorBundleSha256",
  "installedOperatorBundleSha256",
  "databaseFingerprint",
  "beforeSchema",
  "afterSchema",
  "installedMigrationSetSha256",
  "pendingReleasedMigrationCount",
  "backupRestoreEvidenceSha256",
  "backupSha256",
  "onlineDdl",
  "activatedServices",
  "serviceActivationJournalSha256",
  "positiveGrantProofSha256",
  "forbiddenGrantProofSha256",
  "bootstrapPrincipalEvidenceSha256",
  "hostLock",
  "databaseSlot",
  "watchdog",
  "healthEvidenceSha256",
  "watermarkEvidenceSha256",
  "rollbackReadinessSha256",
  "finalLease",
  "issuedAt",
  "producer",
];
const SIGNATURE_FIELDS = [
  "schemaVersion",
  "algorithm",
  "keyId",
  "subjectSha256",
  "signatureBase64",
  "signedAt",
];
const SIGNING_CONTEXT_FIELDS = [
  "schemaVersion",
  "kmsExecutableSha256",
  "kmsCapabilitySha256",
  "evidenceSigningKeyId",
  "signedAt",
];
const PREPARED_FIELDS = ["core", "signatureRequest", "expectedHostLock", "expectedDatabaseSlot"];
const RECORD_FIELDS = [
  "schemaVersion",
  "operationId",
  "releaseSha",
  "releaseManifestSha256",
  "targetDescriptorSha256",
  "operatorBundleSha256",
  "installedMigrationSetSha256",
  "installedSchemaVersion",
  "evidenceCoreSha256",
  "signatureSha256",
  "protectedInstallEvidenceSha256",
  "expectedHostLock",
  "expectedDatabaseSlot",
  "heartbeatAt",
  "expiresAt",
];
const PREPARED_FILE_NAMES = [
  "evidence-core.json",
  "protected-install-signature.json",
  "protected-install-evidence.json",
  "prepared-commit.json",
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} must contain exactly the canonical fields`);
  }
  return value;
}

function exactObjectWithOptional(value, required, optional, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  const keys = Object.keys(value);
  if (
    required.some((key) => !(key in value)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error(`${label} must contain exactly the canonical fields`);
  return value;
}

function pattern(value, expression, label) {
  if (typeof value !== "string" || !expression.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} timestamp is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return milliseconds;
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function scanSecretValues(value, seen = new Set()) {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((candidate) => candidate.test(value))) {
      throw new Error("protected install evidence contains a secret-shaped value");
    }
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value !== "object")
    throw new Error("protected install evidence is not JSON-compatible");
  if (seen.has(value)) throw new Error("protected install evidence contains a cycle");
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    scanSecretValues(child, seen);
  }
  seen.delete(value);
}

function validateProducer(value) {
  exactObject(value, PRODUCER_FIELDS, "protected install producer metadata");
  if (
    value.repository !== "fastest4u/SPX" ||
    value.environment !== "production" ||
    value.workflow !== ".github/workflows/trusted-deploy.yml"
  )
    throw new Error("protected install producer metadata is invalid");
  pattern(value.workflowSha, COMMIT_SHA, "protected install producer workflow SHA");
  pattern(value.workflowFileSha256, SHA256, "protected install producer workflow file hash");
}

function validateRelease(value) {
  exactObject(
    value,
    ["sourceSha", "imageId", "operatorBundleSha256", "schema", "migrations", "migrationSetSha256"],
    "protected install release manifest",
  );
  pattern(value.sourceSha, COMMIT_SHA, "protected install candidate SHA");
  pattern(value.imageId, IMAGE_DIGEST, "protected install candidate image");
  pattern(value.operatorBundleSha256, SHA256, "protected install release operator bundle");
  exactObject(value.schema, ["min", "max"], "protected install release schema");
  safeInteger(value.schema.min, 0, "protected install release minimum schema");
  safeInteger(value.schema.max, 1, "protected install release maximum schema");
  if (value.schema.min > value.schema.max)
    throw new Error("protected install release schema range is invalid");
  if (!Array.isArray(value.migrations) || value.migrations.length === 0) {
    throw new Error("protected install released migration set is invalid");
  }
  let previous = null;
  const names = new Set();
  const migrations = value.migrations.map((item) => {
    exactObject(item, ["name", "sha256"], "protected install released migration");
    pattern(item.name, MIGRATION, "protected install released migration name");
    pattern(item.sha256, SHA256, "protected install released migration checksum");
    if (names.has(item.name) || (previous !== null && previous >= item.name)) {
      throw new Error("protected install released migrations must be uniquely ordered");
    }
    names.add(item.name);
    previous = item.name;
    return item;
  });
  const highest = Math.max(...migrations.map((item) => Number(item.name.slice(0, 3))));
  if (highest !== value.schema.max)
    throw new Error("protected install release maximum schema mismatch");
  const migrationSetSha256 = createHash("sha256")
    .update(migrations.map((item) => `${item.name}:${item.sha256}`).join("\n"))
    .digest("hex");
  if (value.migrationSetSha256 !== migrationSetSha256) {
    throw new Error("protected install migration set hash mismatch");
  }
}

function validateOwnedReceipt(value, label) {
  exactObject(value, OWNED_LOCK_FIELDS, label);
  pattern(value.operationId, SAFE_ID, `${label} operation`);
  if (value.state !== "installed-awaiting-gate6") throw new Error(`${label} state is invalid`);
  safeInteger(value.version, 1, `${label} version`);
}

function validateSignatureBase64(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 16_384 ||
    !BASE64.test(value)
  ) {
    throw new Error("protected install signature value is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength < 16 || decoded.toString("base64") !== value) {
    throw new Error("protected install signature value is invalid");
  }
  const decodedText = decoded.toString("utf8");
  if (
    !decodedText.includes("\uFFFD") &&
    SECRET_VALUE_PATTERNS.some((candidate) => candidate.test(decodedText))
  ) {
    throw new Error("protected install signature contains a secret-shaped value");
  }
  return value;
}

function validateSignature(signatureFile, core, keyId) {
  exactObject(signatureFile, SIGNATURE_FIELDS, "protected install signature file");
  if (signatureFile.schemaVersion !== 1 || signatureFile.algorithm !== "kms-sha256") {
    throw new Error("protected install signature metadata is invalid");
  }
  pattern(signatureFile.keyId, SAFE_ID, "protected install signature key");
  if (signatureFile.keyId !== keyId) throw new Error("protected install signature key mismatch");
  pattern(signatureFile.subjectSha256, SHA256, "protected install signature subject");
  if (signatureFile.subjectSha256 !== sha256Canonical(core)) {
    throw new Error("protected install signature subject does not match the evidence core");
  }
  validateSignatureBase64(signatureFile.signatureBase64);
  const signedAt = timestamp(signatureFile.signedAt, "protected install signature");
  if (signedAt < timestamp(core.issuedAt, "protected install issuance")) {
    throw new Error("protected install signature predates the evidence core");
  }
}

function onlineDdlReceipt(receipt, classified) {
  exactObject(
    receipt,
    [
      "migration",
      "migrationSha256",
      "tableSizeBucket",
      "algorithm",
      "lock",
      "implicitFallback",
      "durationMs",
      "maximumDurationMs",
      "latencyBudgetPassed",
      "ioBudgetPassed",
      "connectionBudgetPassed",
      "rehearsalMysqlVersion",
    ],
    "protected install online DDL receipt",
  );
  pattern(receipt.migration, MIGRATION, "protected install online DDL migration");
  pattern(receipt.migrationSha256, SHA256, "protected install online DDL checksum");
  if (
    receipt.migration !== classified.migration ||
    receipt.migrationSha256 !== classified.migrationSha256 ||
    receipt.algorithm !== classified.algorithm ||
    receipt.lock !== classified.lock ||
    !["INSTANT", "INPLACE"].includes(receipt.algorithm) ||
    receipt.lock !== "NONE" ||
    receipt.implicitFallback !== false ||
    typeof receipt.tableSizeBucket !== "string" ||
    receipt.tableSizeBucket.length < 1 ||
    typeof receipt.rehearsalMysqlVersion !== "string" ||
    receipt.rehearsalMysqlVersion.length < 1 ||
    !Number.isFinite(receipt.durationMs) ||
    !Number.isFinite(receipt.maximumDurationMs) ||
    receipt.durationMs < 0 ||
    receipt.maximumDurationMs < 0 ||
    receipt.durationMs > receipt.maximumDurationMs ||
    receipt.latencyBudgetPassed !== true ||
    receipt.ioBudgetPassed !== true ||
    receipt.connectionBudgetPassed !== true
  )
    throw new Error("protected install online DDL evidence is invalid");
  return {
    migration: receipt.migration,
    migrationSha256: receipt.migrationSha256,
    tableSizeBucket: receipt.tableSizeBucket,
    algorithm: receipt.algorithm,
    lock: "NONE",
    implicitFallback: false,
    durationMs: receipt.durationMs,
    maximumDurationMs: receipt.maximumDurationMs,
    headroomMs: receipt.maximumDurationMs - receipt.durationMs,
    latencyBudgetPassed: true,
    ioBudgetPassed: true,
    connectionBudgetPassed: true,
    rehearsalMysqlVersion: receipt.rehearsalMysqlVersion,
    budgetsPassed: true,
  };
}

function assembleCore(input) {
  scanSecretValues(input);
  exactObject(
    input,
    [
      "schemaVersion",
      "releaseEnvironment",
      "operationId",
      "releaseManifestSha256",
      "release",
      "rollback",
      "target",
      "installed",
      "backupEvidence",
      "migrationReceipt",
      "classifiedPendingAlters",
      "onlineDdlReceipts",
      "grantEvidence",
      "serviceActivationJournal",
      "watchdogJournal",
      "healthEvidence",
      "watermarkEvidence",
      "rollbackReadiness",
      "hostLock",
      "databaseSlot",
      "finalLease",
      "issuedAt",
      "producer",
    ],
    "protected install evidence input",
  );
  if (input.schemaVersion !== 1 || input.releaseEnvironment !== "production") {
    throw new Error("protected install production discriminator is invalid");
  }
  pattern(input.operationId, SAFE_ID, "protected install operation ID");
  pattern(input.releaseManifestSha256, SHA256, "protected install release manifest hash");
  validateRelease(input.release);

  exactObject(
    input.rollback,
    ["releaseManifestSha256", "sourceSha", "imageId", "schema"],
    "protected install rollback release",
  );
  pattern(input.rollback.releaseManifestSha256, SHA256, "protected install rollback manifest hash");
  pattern(input.rollback.sourceSha, COMMIT_SHA, "protected install rollback SHA");
  pattern(input.rollback.imageId, IMAGE_DIGEST, "protected install rollback image");
  exactObject(input.rollback.schema, ["min", "max"], "protected install rollback schema");
  safeInteger(input.rollback.schema.min, 0, "protected install rollback minimum schema");
  safeInteger(input.rollback.schema.max, 1, "protected install rollback maximum schema");
  if (
    input.release.schema.max < input.rollback.schema.min ||
    input.release.schema.max > input.rollback.schema.max
  )
    throw new Error("protected install rollback schema is incompatible");

  exactObject(
    input.target,
    [
      "descriptorSha256",
      "releaseManifestSha256",
      "releaseSourceSha",
      "imageId",
      "operatorBundleSha256",
      "databaseFingerprint",
    ],
    "protected install production target",
  );
  pattern(input.target.descriptorSha256, SHA256, "protected install target descriptor hash");
  pattern(input.target.databaseFingerprint, IMAGE_DIGEST, "protected install database fingerprint");
  if (
    input.target.releaseManifestSha256 !== input.releaseManifestSha256 ||
    input.target.releaseSourceSha !== input.release.sourceSha ||
    input.target.imageId !== input.release.imageId ||
    input.target.operatorBundleSha256 !== input.release.operatorBundleSha256
  )
    throw new Error("protected install target descriptor release binding mismatch");

  exactObject(
    input.installed,
    [
      "candidateSha",
      "imageDigest",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "databaseFingerprint",
      "schemaVersion",
      "migrationSetSha256",
    ],
    "protected install installed identity",
  );
  if (
    input.installed.candidateSha !== input.release.sourceSha ||
    input.installed.imageDigest !== input.release.imageId
  )
    throw new Error("protected install candidate image identity mismatch");
  if (input.installed.targetDescriptorSha256 !== input.target.descriptorSha256) {
    throw new Error("protected install target descriptor mismatch");
  }
  if (input.installed.operatorBundleSha256 !== input.release.operatorBundleSha256) {
    throw new Error("protected install release/installed operator bundle mismatch");
  }
  if (input.installed.databaseFingerprint !== input.target.databaseFingerprint) {
    throw new Error("protected install database fingerprint mismatch");
  }
  if (
    input.installed.schemaVersion !== input.release.schema.max ||
    input.installed.migrationSetSha256 !== input.release.migrationSetSha256
  )
    throw new Error("protected install installed schema or migration set mismatch");

  exactObject(
    input.backupEvidence,
    [
      "evidenceSha256",
      "candidateSha",
      "releaseManifestSha256",
      "targetDescriptorSha256",
      "databaseFingerprint",
      "backupSha256",
      "beforeDdl",
      "encrypted",
      "isolatedRestore",
      "teardownProven",
    ],
    "protected install backup evidence",
  );
  pattern(input.backupEvidence.evidenceSha256, SHA256, "protected install backup evidence hash");
  pattern(input.backupEvidence.backupSha256, SHA256, "protected install backup hash");
  if (
    input.backupEvidence.candidateSha !== input.release.sourceSha ||
    input.backupEvidence.releaseManifestSha256 !== input.releaseManifestSha256 ||
    input.backupEvidence.targetDescriptorSha256 !== input.target.descriptorSha256 ||
    input.backupEvidence.databaseFingerprint !== input.target.databaseFingerprint ||
    input.backupEvidence.beforeDdl !== true ||
    input.backupEvidence.encrypted !== true ||
    input.backupEvidence.isolatedRestore !== true ||
    input.backupEvidence.teardownProven !== true
  )
    throw new Error("protected install backup evidence binding mismatch");

  exactObject(
    input.migrationReceipt,
    [
      "ok",
      "beforeSchema",
      "afterSchema",
      "installedMigrationSetSha256",
      "pendingReleasedMigrationCount",
      "backupRestoreEvidenceSha256",
      "rollbackSchemaCompatible",
      "checksumSetExact",
    ],
    "protected install migration receipt",
  );
  safeInteger(input.migrationReceipt.beforeSchema, 0, "protected install before schema");
  if (
    input.migrationReceipt.ok !== true ||
    input.migrationReceipt.afterSchema !== input.release.schema.max ||
    input.migrationReceipt.beforeSchema > input.migrationReceipt.afterSchema
  )
    throw new Error("protected install before/after schema receipt mismatch");
  if (input.migrationReceipt.installedMigrationSetSha256 !== input.release.migrationSetSha256) {
    throw new Error("protected install migration set receipt mismatch");
  }
  if (input.migrationReceipt.pendingReleasedMigrationCount !== 0) {
    throw new Error("protected install pending released migration count is not zero");
  }
  if (input.migrationReceipt.backupRestoreEvidenceSha256 !== input.backupEvidence.evidenceSha256) {
    throw new Error("protected install backup receipt hash mismatch");
  }
  if (
    input.migrationReceipt.rollbackSchemaCompatible !== true ||
    input.migrationReceipt.checksumSetExact !== true
  )
    throw new Error("protected install rollback/checksum migration receipt is invalid");

  if (
    !Array.isArray(input.classifiedPendingAlters) ||
    !Array.isArray(input.onlineDdlReceipts) ||
    input.classifiedPendingAlters.length !== input.onlineDdlReceipts.length
  )
    throw new Error("protected install online DDL receipt coverage mismatch");
  const releaseChecksums = new Map(
    input.release.migrations.map((item) => [item.name, item.sha256]),
  );
  const onlineDdl = input.classifiedPendingAlters.map((classified, index) => {
    exactObject(
      classified,
      ["migration", "migrationSha256", "algorithm", "lock"],
      "protected install classified ALTER",
    );
    if (
      releaseChecksums.get(classified.migration) !== classified.migrationSha256 ||
      !["INSTANT", "INPLACE"].includes(classified.algorithm) ||
      classified.lock !== "NONE"
    )
      throw new Error("protected install classified online DDL is invalid");
    return onlineDdlReceipt(input.onlineDdlReceipts[index], classified);
  });

  exactObject(
    input.grantEvidence,
    [
      "operationId",
      "positiveGrantProofSha256",
      "forbiddenGrantProofSha256",
      "bootstrapPrincipalEvidenceSha256",
    ],
    "protected install grant evidence",
  );
  if (input.grantEvidence.operationId !== input.operationId) {
    throw new Error("protected install grant operation mismatch");
  }
  pattern(
    input.grantEvidence.positiveGrantProofSha256,
    SHA256,
    "protected install positive grant proof",
  );
  pattern(
    input.grantEvidence.forbiddenGrantProofSha256,
    SHA256,
    "protected install forbidden grant proof",
  );
  pattern(
    input.grantEvidence.bootstrapPrincipalEvidenceSha256,
    SHA256,
    "protected install bootstrap principal proof",
  );

  exactObject(
    input.serviceActivationJournal,
    ["operationId", "phase34ProfilesStopped", "entries", "journalSha256"],
    "protected install service activation journal",
  );
  if (
    input.serviceActivationJournal.operationId !== input.operationId ||
    input.serviceActivationJournal.phase34ProfilesStopped !== true ||
    !Array.isArray(input.serviceActivationJournal.entries) ||
    input.serviceActivationJournal.entries.length !== PROTECTED_INSTALL_BASELINE_SERVICES.length
  )
    throw new Error("protected install service activation journal is invalid");
  input.serviceActivationJournal.entries.forEach((entry, index) => {
    exactObject(
      entry,
      ["service", "activated", "identityVerified", "ready", "watermarkPassed"],
      "protected install service activation entry",
    );
    if (
      entry.service !== PROTECTED_INSTALL_BASELINE_SERVICES[index] ||
      entry.activated !== true ||
      entry.identityVerified !== true ||
      entry.ready !== true ||
      entry.watermarkPassed !== true
    )
      throw new Error("protected install service activation order or postcondition is invalid");
  });
  const serviceJournalCore = {
    operationId: input.serviceActivationJournal.operationId,
    phase34ProfilesStopped: input.serviceActivationJournal.phase34ProfilesStopped,
    entries: input.serviceActivationJournal.entries,
  };
  if (input.serviceActivationJournal.journalSha256 !== sha256Canonical(serviceJournalCore)) {
    throw new Error("protected install service activation journal hash mismatch");
  }

  exactObject(
    input.watchdogJournal,
    [
      "operationId",
      "startedAt",
      "firstMutationAt",
      "lastHeartbeatAt",
      "finalizedAt",
      "startedBeforeMutation",
      "continuous",
      "terminal",
      "journalSha256",
    ],
    "protected install watchdog journal",
  );
  if (input.watchdogJournal.operationId !== input.operationId) {
    throw new Error("protected install watchdog operation mismatch");
  }
  const watchdogTimes = [
    timestamp(input.watchdogJournal.startedAt, "protected install watchdog start"),
    timestamp(input.watchdogJournal.firstMutationAt, "protected install first mutation"),
    timestamp(input.watchdogJournal.lastHeartbeatAt, "protected install watchdog heartbeat"),
    timestamp(input.watchdogJournal.finalizedAt, "protected install watchdog finalization"),
  ];
  if (
    input.watchdogJournal.startedBeforeMutation !== true ||
    input.watchdogJournal.continuous !== true ||
    input.watchdogJournal.terminal !== true ||
    !(
      watchdogTimes[0] < watchdogTimes[1] &&
      watchdogTimes[1] <= watchdogTimes[2] &&
      watchdogTimes[2] <= watchdogTimes[3]
    )
  )
    throw new Error("protected install watchdog continuity is invalid");
  const watchdogCore = {
    operationId: input.watchdogJournal.operationId,
    startedAt: input.watchdogJournal.startedAt,
    firstMutationAt: input.watchdogJournal.firstMutationAt,
    lastHeartbeatAt: input.watchdogJournal.lastHeartbeatAt,
    finalizedAt: input.watchdogJournal.finalizedAt,
    startedBeforeMutation: input.watchdogJournal.startedBeforeMutation,
    continuous: input.watchdogJournal.continuous,
    terminal: input.watchdogJournal.terminal,
  };
  if (input.watchdogJournal.journalSha256 !== sha256Canonical(watchdogCore)) {
    throw new Error("protected install watchdog journal hash mismatch");
  }

  exactObject(
    input.healthEvidence,
    ["operationId", "candidateSha", "imageDigest", "activatedServices", "evidenceSha256", "passed"],
    "protected install health evidence",
  );
  if (
    input.healthEvidence.operationId !== input.operationId ||
    input.healthEvidence.candidateSha !== input.release.sourceSha ||
    input.healthEvidence.imageDigest !== input.release.imageId ||
    !same(input.healthEvidence.activatedServices, PROTECTED_INSTALL_BASELINE_SERVICES) ||
    input.healthEvidence.passed !== true
  )
    throw new Error("protected install health evidence is invalid");
  pattern(input.healthEvidence.evidenceSha256, SHA256, "protected install health evidence hash");

  exactObject(
    input.watermarkEvidence,
    ["operationId", "activatedServices", "evidenceSha256", "passed"],
    "protected install watermark evidence",
  );
  if (
    input.watermarkEvidence.operationId !== input.operationId ||
    !same(input.watermarkEvidence.activatedServices, PROTECTED_INSTALL_BASELINE_SERVICES) ||
    input.watermarkEvidence.passed !== true
  )
    throw new Error("protected install watermark evidence is invalid");
  pattern(
    input.watermarkEvidence.evidenceSha256,
    SHA256,
    "protected install watermark evidence hash",
  );

  exactObject(
    input.rollbackReadiness,
    [
      "operationId",
      "rollbackSha",
      "rollbackImageDigest",
      "evidenceSha256",
      "schemaCompatible",
      "ready",
    ],
    "protected install rollback readiness",
  );
  if (
    input.rollbackReadiness.operationId !== input.operationId ||
    input.rollbackReadiness.rollbackSha !== input.rollback.sourceSha ||
    input.rollbackReadiness.rollbackImageDigest !== input.rollback.imageId ||
    input.rollbackReadiness.schemaCompatible !== true ||
    input.rollbackReadiness.ready !== true
  )
    throw new Error("protected install rollback readiness is invalid");
  pattern(
    input.rollbackReadiness.evidenceSha256,
    SHA256,
    "protected install rollback readiness hash",
  );

  exactObject(
    input.hostLock,
    [
      "operationId",
      "state",
      "version",
      "releaseSha",
      "targetDescriptorSha256",
      "operatorBundleSha256",
    ],
    "protected install host-lock pre-state",
  );
  exactObject(
    input.databaseSlot,
    [
      "operationId",
      "state",
      "version",
      "releaseSha",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "installedMigrationSetSha256",
      "installedSchemaVersion",
    ],
    "protected install database-slot pre-state",
  );
  for (const [label, state] of [
    ["host lock", input.hostLock],
    ["database slot", input.databaseSlot],
  ]) {
    if (
      state.operationId !== input.operationId ||
      state.state !== "installing" ||
      state.releaseSha !== input.release.sourceSha ||
      state.targetDescriptorSha256 !== input.target.descriptorSha256 ||
      state.operatorBundleSha256 !== input.installed.operatorBundleSha256
    )
      throw new Error(`protected install ${label} operation or identity mismatch`);
    safeInteger(state.version, 1, `protected install ${label} current version`);
  }
  if (
    input.databaseSlot.installedMigrationSetSha256 !== input.release.migrationSetSha256 ||
    input.databaseSlot.installedSchemaVersion !== input.release.schema.max
  )
    throw new Error("protected install database slot installed schema mismatch");
  const expectedHostLock = {
    operationId: input.operationId,
    state: "installed-awaiting-gate6",
    version: input.hostLock.version + 1,
  };
  const expectedDatabaseSlot = {
    operationId: input.operationId,
    state: "installed-awaiting-gate6",
    version: input.databaseSlot.version + 1,
  };

  exactObject(input.finalLease, ["heartbeatAt", "expiresAt"], "protected install final lease");
  const heartbeatAt = timestamp(input.finalLease.heartbeatAt, "protected install final heartbeat");
  const expiresAt = timestamp(input.finalLease.expiresAt, "protected install final expiry");
  const issuedAt = timestamp(input.issuedAt, "protected install issuance");
  if (
    heartbeatAt <= watchdogTimes[3] ||
    expiresAt <= heartbeatAt ||
    expiresAt - heartbeatAt > 24 * 60 * 60 * 1_000 ||
    issuedAt !== heartbeatAt
  )
    throw new Error("protected install final lease or heartbeat is invalid");
  validateProducer(input.producer);

  const core = {
    schemaVersion: 1,
    releaseEnvironment: "production",
    operationId: input.operationId,
    candidateSha: input.release.sourceSha,
    candidateImageDigest: input.release.imageId,
    rollbackSha: input.rollback.sourceSha,
    rollbackImageDigest: input.rollback.imageId,
    releaseManifestSha256: input.releaseManifestSha256,
    rollbackReleaseManifestSha256: input.rollback.releaseManifestSha256,
    productionTargetDescriptorSha256: input.target.descriptorSha256,
    releaseOperatorBundleSha256: input.release.operatorBundleSha256,
    installedOperatorBundleSha256: input.installed.operatorBundleSha256,
    databaseFingerprint: input.target.databaseFingerprint,
    beforeSchema: input.migrationReceipt.beforeSchema,
    afterSchema: input.migrationReceipt.afterSchema,
    installedMigrationSetSha256: input.migrationReceipt.installedMigrationSetSha256,
    pendingReleasedMigrationCount: 0,
    backupRestoreEvidenceSha256: input.backupEvidence.evidenceSha256,
    backupSha256: input.backupEvidence.backupSha256,
    onlineDdl,
    activatedServices: [...PROTECTED_INSTALL_BASELINE_SERVICES],
    serviceActivationJournalSha256: input.serviceActivationJournal.journalSha256,
    positiveGrantProofSha256: input.grantEvidence.positiveGrantProofSha256,
    forbiddenGrantProofSha256: input.grantEvidence.forbiddenGrantProofSha256,
    bootstrapPrincipalEvidenceSha256: input.grantEvidence.bootstrapPrincipalEvidenceSha256,
    hostLock: expectedHostLock,
    databaseSlot: expectedDatabaseSlot,
    watchdog: {
      journalSha256: input.watchdogJournal.journalSha256,
      startedAt: input.watchdogJournal.startedAt,
      firstMutationAt: input.watchdogJournal.firstMutationAt,
      lastHeartbeatAt: input.watchdogJournal.lastHeartbeatAt,
      finalizedAt: input.watchdogJournal.finalizedAt,
      startedBeforeMutation: true,
      continuous: true,
      terminal: true,
    },
    healthEvidenceSha256: input.healthEvidence.evidenceSha256,
    watermarkEvidenceSha256: input.watermarkEvidence.evidenceSha256,
    rollbackReadinessSha256: input.rollbackReadiness.evidenceSha256,
    finalLease: {
      heartbeatAt: input.finalLease.heartbeatAt,
      expiresAt: input.finalLease.expiresAt,
    },
    issuedAt: input.issuedAt,
    producer: { ...input.producer },
  };
  return { core, expectedHostLock, expectedDatabaseSlot };
}

function validateCore(core) {
  exactObject(core, CORE_FIELDS, "protected install evidence core");
  scanSecretValues(core);
  if (core.schemaVersion !== 1 || core.releaseEnvironment !== "production") {
    throw new Error("protected install evidence core discriminator is invalid");
  }
  pattern(core.operationId, SAFE_ID, "protected install evidence operation");
  pattern(core.candidateSha, COMMIT_SHA, "protected install evidence candidate SHA");
  pattern(core.candidateImageDigest, IMAGE_DIGEST, "protected install evidence candidate image");
  pattern(core.rollbackSha, COMMIT_SHA, "protected install evidence rollback SHA");
  pattern(core.rollbackImageDigest, IMAGE_DIGEST, "protected install evidence rollback image");
  for (const field of [
    "releaseManifestSha256",
    "rollbackReleaseManifestSha256",
    "productionTargetDescriptorSha256",
    "releaseOperatorBundleSha256",
    "installedOperatorBundleSha256",
    "installedMigrationSetSha256",
    "backupRestoreEvidenceSha256",
    "backupSha256",
    "serviceActivationJournalSha256",
    "positiveGrantProofSha256",
    "forbiddenGrantProofSha256",
    "bootstrapPrincipalEvidenceSha256",
    "healthEvidenceSha256",
    "watermarkEvidenceSha256",
    "rollbackReadinessSha256",
  ])
    pattern(core[field], SHA256, `protected install evidence ${field}`);
  pattern(
    core.databaseFingerprint,
    IMAGE_DIGEST,
    "protected install evidence database fingerprint",
  );
  safeInteger(core.beforeSchema, 0, "protected install evidence before schema");
  safeInteger(core.afterSchema, 1, "protected install evidence after schema");
  if (core.beforeSchema > core.afterSchema || core.pendingReleasedMigrationCount !== 0) {
    throw new Error("protected install evidence schema/pending receipt is invalid");
  }
  if (!same(core.activatedServices, PROTECTED_INSTALL_BASELINE_SERVICES)) {
    throw new Error("protected install evidence baseline service set is invalid");
  }
  if (!Array.isArray(core.onlineDdl))
    throw new Error("protected install evidence online DDL is invalid");
  for (const item of core.onlineDdl) {
    exactObject(
      item,
      [
        "migration",
        "migrationSha256",
        "tableSizeBucket",
        "algorithm",
        "lock",
        "implicitFallback",
        "durationMs",
        "maximumDurationMs",
        "headroomMs",
        "latencyBudgetPassed",
        "ioBudgetPassed",
        "connectionBudgetPassed",
        "rehearsalMysqlVersion",
        "budgetsPassed",
      ],
      "protected install evidence online DDL receipt",
    );
    if (
      !MIGRATION.test(item.migration) ||
      !SHA256.test(item.migrationSha256) ||
      !["INSTANT", "INPLACE"].includes(item.algorithm) ||
      item.lock !== "NONE" ||
      item.implicitFallback !== false ||
      item.budgetsPassed !== true ||
      item.latencyBudgetPassed !== true ||
      item.ioBudgetPassed !== true ||
      item.connectionBudgetPassed !== true ||
      !Number.isFinite(item.durationMs) ||
      !Number.isFinite(item.maximumDurationMs) ||
      item.durationMs < 0 ||
      item.durationMs > item.maximumDurationMs ||
      item.headroomMs !== item.maximumDurationMs - item.durationMs
    )
      throw new Error("protected install evidence online DDL receipt is invalid");
  }
  validateOwnedReceipt(core.hostLock, "protected install evidence host lock");
  validateOwnedReceipt(core.databaseSlot, "protected install evidence database slot");
  if (
    core.hostLock.operationId !== core.operationId ||
    core.databaseSlot.operationId !== core.operationId
  ) {
    throw new Error("protected install evidence state operation mismatch");
  }
  exactObject(
    core.watchdog,
    [
      "journalSha256",
      "startedAt",
      "firstMutationAt",
      "lastHeartbeatAt",
      "finalizedAt",
      "startedBeforeMutation",
      "continuous",
      "terminal",
    ],
    "protected install evidence watchdog",
  );
  pattern(core.watchdog.journalSha256, SHA256, "protected install evidence watchdog journal");
  const watchdogTimes = [
    timestamp(core.watchdog.startedAt, "protected install evidence watchdog start"),
    timestamp(core.watchdog.firstMutationAt, "protected install evidence first mutation"),
    timestamp(core.watchdog.lastHeartbeatAt, "protected install evidence watchdog heartbeat"),
    timestamp(core.watchdog.finalizedAt, "protected install evidence watchdog finalization"),
  ];
  if (
    core.watchdog.startedBeforeMutation !== true ||
    core.watchdog.continuous !== true ||
    core.watchdog.terminal !== true ||
    !(
      watchdogTimes[0] < watchdogTimes[1] &&
      watchdogTimes[1] <= watchdogTimes[2] &&
      watchdogTimes[2] <= watchdogTimes[3]
    )
  )
    throw new Error("protected install evidence watchdog continuity is invalid");
  exactObject(
    core.finalLease,
    ["heartbeatAt", "expiresAt"],
    "protected install evidence final lease",
  );
  const heartbeat = timestamp(core.finalLease.heartbeatAt, "protected install evidence heartbeat");
  const expiry = timestamp(core.finalLease.expiresAt, "protected install evidence expiry");
  if (
    heartbeat <= watchdogTimes[3] ||
    expiry <= heartbeat ||
    expiry - heartbeat > 24 * 60 * 60 * 1_000 ||
    timestamp(core.issuedAt, "protected install evidence issuance") !== heartbeat
  )
    throw new Error("protected install evidence final lease is invalid");
  validateProducer(core.producer);
  return core;
}

export function prepareProtectedInstallEvidenceCommit(input, signingContext) {
  const { core, expectedHostLock, expectedDatabaseSlot } = assembleCore(input);
  const trustedSigningContext = validateSigningContextForCore(signingContext, core);
  const prepared = {
    core,
    signatureRequest: {
      schemaVersion: 1,
      algorithm: "kms-sha256",
      keyId: trustedSigningContext.evidenceSigningKeyId,
      subjectSha256: sha256Canonical(core),
    },
    expectedHostLock,
    expectedDatabaseSlot,
  };
  return deepFreeze(prepared);
}

function evidenceFromPrepared(prepared, signatureFile) {
  validatePrepared(prepared);
  validateSignature(signatureFile, prepared.core, prepared.signatureRequest.keyId);
  return deepFreeze({
    ...prepared.core,
    signatureSha256: sha256Canonical(signatureFile),
  });
}

export function assembleProtectedInstallEvidence(input) {
  exactObjectWithOptional(
    input,
    [
      "schemaVersion",
      "releaseEnvironment",
      "operationId",
      "releaseManifestSha256",
      "release",
      "rollback",
      "target",
      "installed",
      "backupEvidence",
      "migrationReceipt",
      "classifiedPendingAlters",
      "onlineDdlReceipts",
      "grantEvidence",
      "serviceActivationJournal",
      "watchdogJournal",
      "healthEvidence",
      "watermarkEvidence",
      "rollbackReadiness",
      "hostLock",
      "databaseSlot",
      "finalLease",
      "issuedAt",
      "producer",
      "signingContext",
      "signatureFile",
    ],
    [],
    "protected install signed evidence input",
  );
  const { signatureFile, signingContext, ...unsigned } = input;
  const prepared = prepareProtectedInstallEvidenceCommit(unsigned, signingContext);
  return evidenceFromPrepared(prepared, signatureFile);
}

function validatePrepared(prepared) {
  exactObject(prepared, PREPARED_FIELDS, "protected install prepared evidence");
  validateCore(prepared.core);
  exactObject(
    prepared.signatureRequest,
    ["schemaVersion", "algorithm", "keyId", "subjectSha256"],
    "protected install signature request",
  );
  if (
    prepared.signatureRequest.schemaVersion !== 1 ||
    prepared.signatureRequest.algorithm !== "kms-sha256" ||
    prepared.signatureRequest.subjectSha256 !== sha256Canonical(prepared.core)
  )
    throw new Error("protected install prepared signature request mismatch");
  pattern(
    prepared.signatureRequest.keyId,
    SAFE_ID,
    "protected install prepared signature request key",
  );
  validateOwnedReceipt(
    prepared.expectedHostLock,
    "protected install prepared host-lock prediction",
  );
  validateOwnedReceipt(
    prepared.expectedDatabaseSlot,
    "protected install prepared database-slot prediction",
  );
  if (!same(prepared.expectedHostLock, prepared.core.hostLock)) {
    throw new Error("protected install host-lock prediction mismatch");
  }
  if (!same(prepared.expectedDatabaseSlot, prepared.core.databaseSlot)) {
    throw new Error("protected install database-slot prediction mismatch");
  }
}

export function verifyProtectedInstallEvidence(evidence, expected) {
  exactObject(evidence, [...CORE_FIELDS, "signatureSha256"], "protected install evidence");
  const { signatureSha256, ...core } = evidence;
  validateCore(core);
  pattern(signatureSha256, SHA256, "protected install evidence signature hash");
  exactObject(
    expected,
    [
      "operationId",
      "candidateSha",
      "candidateImageDigest",
      "rollbackSha",
      "rollbackImageDigest",
      "releaseManifestSha256",
      "rollbackReleaseManifestSha256",
      "productionTargetDescriptorSha256",
      "releaseOperatorBundleSha256",
      "installedOperatorBundleSha256",
      "databaseFingerprint",
      "backupRestoreEvidenceSha256",
      "producer",
      "hostLock",
      "databaseSlot",
      "signatureFile",
    ],
    "protected install verification expectation",
  );
  const directFields = [
    "operationId",
    "candidateSha",
    "candidateImageDigest",
    "rollbackSha",
    "rollbackImageDigest",
    "releaseManifestSha256",
    "rollbackReleaseManifestSha256",
    "productionTargetDescriptorSha256",
    "releaseOperatorBundleSha256",
    "installedOperatorBundleSha256",
    "databaseFingerprint",
    "backupRestoreEvidenceSha256",
  ];
  for (const field of directFields) {
    if (core[field] !== expected[field]) {
      throw new Error(
        `protected install evidence ${field} does not match the verified expectation`,
      );
    }
  }
  if (!same(core.producer, expected.producer))
    throw new Error("protected install producer metadata mismatch");
  if (!same(core.hostLock, expected.hostLock) || !same(core.databaseSlot, expected.databaseSlot)) {
    throw new Error("protected install evidence post-state receipt mismatch");
  }
  validateSignature(expected.signatureFile, core, expected.signatureFile.keyId);
  if (signatureSha256 !== sha256Canonical(expected.signatureFile)) {
    throw new Error("protected install evidence signature-file digest mismatch");
  }
  return {
    ok: true,
    evidenceSha256: sha256Canonical(evidence),
    installedSchemaVersion: core.afterSchema,
    installedMigrationSetSha256: core.installedMigrationSetSha256,
  };
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

const nodeFilePort = {
  async exists(path) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  },
  async ensureDirectory(path, mode, options = {}) {
    if (options.exclusive === true) {
      await mkdir(path, { mode });
    } else {
      await mkdir(path, { recursive: true, mode });
    }
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("protected install state directory is not a regular directory");
    }
    if ((status.mode & 0o077) !== 0)
      throw new Error("protected install state directory is not private");
  },
  async assertPrivateDirectory(path) {
    const status = await lstat(path, { bigint: true });
    if (
      status.isSymbolicLink() ||
      !status.isDirectory() ||
      (Number(status.mode) & 0o777) !== 0o700 ||
      (process.platform !== "win32" && status.uid !== 0n)
    ) {
      throw new Error("protected install fixed context directory metadata is invalid");
    }
    return {
      dev: String(status.dev),
      ino: String(status.ino),
      mode: Number(status.mode),
      uid: String(status.uid),
      mtimeNs: String(status.mtimeNs),
      ctimeNs: String(status.ctimeNs),
    };
  },
  async list(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error("protected install prepared directory contains a non-regular entry");
      }
    }
    return entries.map((entry) => entry.name).sort();
  },
  async createOnce(path, bytes, mode) {
    const descriptor = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    try {
      await descriptor.writeFile(bytes);
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
  },
  async readStable(path) {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
      throw new Error("protected install prepared file must be one regular non-symlink file");
    }
    if ((Number(before.mode) & 0o777) !== 0o400) {
      throw new Error("protected install prepared file mode is invalid");
    }
    if (process.platform !== "win32" && before.uid !== 0n) {
      throw new Error("protected install prepared file must be root-owned");
    }
    if (before.size > BigInt(MAX_FILE_BYTES))
      throw new Error("protected install prepared file is too large");
    const descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await descriptor.stat({ bigint: true });
      if (!sameIdentity(before, opened))
        throw new Error("protected install prepared file identity changed");
      const bytes = await descriptor.readFile();
      const after = await descriptor.stat({ bigint: true });
      if (!sameIdentity(opened, after) || after.size !== BigInt(bytes.byteLength)) {
        throw new Error("protected install prepared file changed while read");
      }
      return bytes;
    } finally {
      await descriptor.close();
    }
  },
  async fsyncDirectory(path) {
    if (process.platform === "win32") return;
    const descriptor = await open(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
  },
  async renameDirectory(from, to) {
    if (await this.exists(to))
      throw new Error("protected install committed archive already exists");
    await rename(from, to);
  },
  async removeIncompleteDirectory(path, names) {
    for (const name of names) await unlink(posix.join(path, name));
    await rmdir(path);
  },
};

function parseCanonicalBytes(bytes, label) {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error(`${label} exceeds its size limit`);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new Error(`${label} is not valid UTF-8 canonical JSON`);
  }
  if (buffer.toString("utf8") !== canonicalJson(value))
    throw new Error(`${label} is not canonical JSON`);
  return value;
}

function buildRecord(prepared, signatureFile, evidence) {
  return {
    schemaVersion: 1,
    operationId: prepared.core.operationId,
    releaseSha: prepared.core.candidateSha,
    releaseManifestSha256: prepared.core.releaseManifestSha256,
    targetDescriptorSha256: prepared.core.productionTargetDescriptorSha256,
    operatorBundleSha256: prepared.core.installedOperatorBundleSha256,
    installedMigrationSetSha256: prepared.core.installedMigrationSetSha256,
    installedSchemaVersion: prepared.core.afterSchema,
    evidenceCoreSha256: sha256Canonical(prepared.core),
    signatureSha256: sha256Canonical(signatureFile),
    protectedInstallEvidenceSha256: sha256Canonical(evidence),
    expectedHostLock: {
      currentVersion: prepared.expectedHostLock.version - 1,
      nextVersion: prepared.expectedHostLock.version,
    },
    expectedDatabaseSlot: {
      currentVersion: prepared.expectedDatabaseSlot.version - 1,
      nextVersion: prepared.expectedDatabaseSlot.version,
    },
    heartbeatAt: prepared.core.finalLease.heartbeatAt,
    expiresAt: prepared.core.finalLease.expiresAt,
  };
}

function validateRecord(record) {
  exactObject(record, RECORD_FIELDS, "protected install prepared commit record");
  if (record.schemaVersion !== 1)
    throw new Error("protected install prepared commit version is invalid");
  pattern(record.operationId, SAFE_ID, "protected install prepared commit operation");
  pattern(record.releaseSha, COMMIT_SHA, "protected install prepared commit release");
  for (const field of [
    "releaseManifestSha256",
    "targetDescriptorSha256",
    "operatorBundleSha256",
    "installedMigrationSetSha256",
    "evidenceCoreSha256",
    "signatureSha256",
    "protectedInstallEvidenceSha256",
  ])
    pattern(record[field], SHA256, `protected install prepared commit ${field}`);
  safeInteger(record.installedSchemaVersion, 1, "protected install prepared commit schema");
  for (const [label, versions] of [
    ["host lock", record.expectedHostLock],
    ["database slot", record.expectedDatabaseSlot],
  ]) {
    exactObject(
      versions,
      ["currentVersion", "nextVersion"],
      `protected install prepared commit ${label} versions`,
    );
    safeInteger(
      versions.currentVersion,
      1,
      `protected install prepared commit ${label} current version`,
    );
    if (versions.nextVersion !== versions.currentVersion + 1) {
      throw new Error(`protected install prepared commit ${label} next version is invalid`);
    }
  }
  const heartbeat = timestamp(record.heartbeatAt, "protected install prepared commit heartbeat");
  const expiry = timestamp(record.expiresAt, "protected install prepared commit expiry");
  if (expiry <= heartbeat || expiry - heartbeat > 24 * 60 * 60 * 1_000) {
    throw new Error("protected install prepared commit lease is invalid");
  }
}

function expectedPreparedBytes(prepared, signatureFile, evidence, record) {
  return new Map([
    ["evidence-core.json", Buffer.from(canonicalJson(prepared.core), "utf8")],
    ["protected-install-signature.json", Buffer.from(canonicalJson(signatureFile), "utf8")],
    ["protected-install-evidence.json", Buffer.from(canonicalJson(evidence), "utf8")],
    ["prepared-commit.json", Buffer.from(canonicalJson(record), "utf8")],
  ]);
}

async function readCompleteCommit(directory, files, expectedBytes, expectedRecord) {
  const names = await files.list(directory);
  if (!same(names, [...PREPARED_FILE_NAMES].sort())) {
    throw new Error("protected install prepared directory is incomplete or contains extra files");
  }
  const loaded = new Map();
  for (const name of PREPARED_FILE_NAMES) {
    const bytes = Buffer.from(await files.readStable(posix.join(directory, name)));
    parseCanonicalBytes(bytes, `protected install prepared ${name}`);
    loaded.set(name, bytes);
  }
  const record = parseCanonicalBytes(
    loaded.get("prepared-commit.json"),
    "protected install prepared commit record",
  );
  validateRecord(record);
  if (!same(record, expectedRecord))
    throw new Error("protected install prepared commit binding mismatch");
  for (const [name, expected] of expectedBytes) {
    if (!loaded.get(name).equals(expected)) {
      throw new Error(`protected install prepared ${name} hash or bytes mismatch`);
    }
  }
  if (
    record.evidenceCoreSha256 !==
      createHash("sha256").update(loaded.get("evidence-core.json")).digest("hex") ||
    record.signatureSha256 !==
      createHash("sha256").update(loaded.get("protected-install-signature.json")).digest("hex") ||
    record.protectedInstallEvidenceSha256 !==
      createHash("sha256").update(loaded.get("protected-install-evidence.json")).digest("hex")
  )
    throw new Error("protected install prepared file hash mismatch");
  return { record, loaded };
}

async function createCompleteCommit(directory, files, expectedBytes) {
  const names = await files.list(directory);
  if (names.length !== 0)
    throw new Error("protected install prepared directory is incomplete or conflicting");
  for (const name of PREPARED_FILE_NAMES.slice(0, -1)) {
    const path = posix.join(directory, name);
    await files.createOnce(path, expectedBytes.get(name), 0o400);
    const reopened = Buffer.from(await files.readStable(path));
    if (!reopened.equals(expectedBytes.get(name)))
      throw new Error("protected install prepared file changed after creation");
  }
  await files.fsyncDirectory(directory);
  const recordName = PREPARED_FILE_NAMES.at(-1);
  const recordPath = posix.join(directory, recordName);
  await files.createOnce(recordPath, expectedBytes.get(recordName), 0o400);
  const recordReopened = Buffer.from(await files.readStable(recordPath));
  if (!recordReopened.equals(expectedBytes.get(recordName))) {
    throw new Error("protected install prepared commit changed after creation");
  }
  await files.fsyncDirectory(directory);
  await files.fsyncDirectory(PROTECTED_INSTALL_PATHS.preparedRoot);
}

function validateInstallingState(state, record, versions, label) {
  if (
    !isPlainObject(state) ||
    state.operationId !== record.operationId ||
    state.state !== "installing" ||
    state.version !== versions.currentVersion ||
    state.protectedInstallEvidenceSha256 === record.protectedInstallEvidenceSha256
  )
    throw new Error(
      `protected install incomplete prepare cannot be recovered from the ${label} state`,
    );
}

async function recoverIncompletePrepare(directory, names, files, expectedBytes, record, ports) {
  const allowedPartial = new Set(PREPARED_FILE_NAMES.slice(0, -1));
  if (names.includes("prepared-commit.json") || names.some((name) => !allowedPartial.has(name)))
    throw new Error("protected install prepared directory is incomplete or conflicting");
  for (const name of names) {
    const bytes = Buffer.from(await files.readStable(posix.join(directory, name)));
    if (!bytes.equals(expectedBytes.get(name))) {
      throw new Error("protected install incomplete prepared file hash or bytes mismatch");
    }
    parseCanonicalBytes(bytes, `protected install incomplete prepared ${name}`);
  }
  const databaseBinding = stateBinding(record, "database");
  const hostBinding = stateBinding(record, "host");
  const databaseState = await ports.readDatabaseSlot(databaseBinding);
  const hostState = await ports.readHostLock(hostBinding);
  validateInstallingState(databaseState, record, record.expectedDatabaseSlot, "database slot");
  validateInstallingState(hostState, record, record.expectedHostLock, "host lock");
  await files.removeIncompleteDirectory(directory, names);
  await files.fsyncDirectory(PROTECTED_INSTALL_PATHS.preparedRoot);
}

function stateBinding(record, kind) {
  const versions = kind === "database" ? record.expectedDatabaseSlot : record.expectedHostLock;
  const binding = {
    operationId: record.operationId,
    releaseSha: record.releaseSha,
    targetDescriptorSha256: record.targetDescriptorSha256,
    operatorBundleSha256: record.operatorBundleSha256,
    protectedInstallEvidenceSha256: record.protectedInstallEvidenceSha256,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
    expectedCurrentVersion: versions.currentVersion,
    expectedNextVersion: versions.nextVersion,
  };
  if (kind === "database") {
    binding.installedMigrationSetSha256 = record.installedMigrationSetSha256;
    binding.installedSchemaVersion = record.installedSchemaVersion;
  }
  return binding;
}

function validateCommittedState(state, record, expectedReceipt, label) {
  if (
    !isPlainObject(state) ||
    state.operationId !== record.operationId ||
    state.state !== "installed-awaiting-gate6" ||
    state.version !== expectedReceipt.version ||
    state.protectedInstallEvidenceSha256 !== record.protectedInstallEvidenceSha256 ||
    state.heartbeatAt !== record.heartbeatAt ||
    state.expiresAt !== record.expiresAt
  )
    throw new Error(`protected install ${label} post-state reconciliation mismatch`);
  const receipt = { operationId: state.operationId, state: state.state, version: state.version };
  if (!same(receipt, expectedReceipt)) {
    throw new Error(`protected install ${label} sanitized receipt prediction mismatch`);
  }
}

async function ensureExportFile(files, path, bytes) {
  if (await files.exists(path)) {
    const existing = Buffer.from(await files.readStable(path));
    if (!existing.equals(bytes))
      throw new Error("protected install export file conflicts with prepared bytes");
    return;
  }
  await files.createOnce(path, bytes, 0o400);
  const reopened = Buffer.from(await files.readStable(path));
  if (!reopened.equals(bytes))
    throw new Error("protected install export file changed after creation");
}

async function publishExports(files, evidenceBytes, signatureBytes) {
  await files.ensureDirectory(PROTECTED_INSTALL_PATHS.exportRoot, 0o700);
  const before = await files.list(PROTECTED_INSTALL_PATHS.exportRoot);
  const allowed = new Set(["protected-install-evidence.json", "protected-install-signature.json"]);
  if (before.some((name) => !allowed.has(name))) {
    throw new Error("protected install export directory contains an unexpected file");
  }
  await ensureExportFile(files, PROTECTED_INSTALL_PATHS.evidenceExport, evidenceBytes);
  await ensureExportFile(files, PROTECTED_INSTALL_PATHS.signatureExport, signatureBytes);
  await files.fsyncDirectory(PROTECTED_INSTALL_PATHS.exportRoot);
  const after = await files.list(PROTECTED_INSTALL_PATHS.exportRoot);
  if (!same(after, [...allowed].sort()))
    throw new Error("protected install export file set is incomplete");
}

function validateSigningContextFields(value) {
  exactObject(value, SIGNING_CONTEXT_FIELDS, "protected install signing context");
  if (value.schemaVersion !== 1) {
    throw new Error("protected install signing context version is invalid");
  }
  for (const [field, label] of [
    ["kmsExecutableSha256", "executable"],
    ["kmsCapabilitySha256", "capability"],
  ]) {
    pattern(value[field], SHA256, `protected install KMS ${label} hash`);
    if (/^0{64}$/.test(value[field])) {
      throw new Error(`protected install KMS ${label} hash is invalid`);
    }
  }
  pattern(value.evidenceSigningKeyId, SAFE_ID, "protected install signing context key");
  timestamp(value.signedAt, "protected install signing context");
  return value;
}

function validateSigningContextForCore(value, core) {
  validateCore(core);
  const validated = validateSigningContextFields(value);
  if (
    timestamp(validated.signedAt, "protected install signing context") <
    timestamp(core.issuedAt, "protected install issuance")
  ) {
    throw new Error("protected install signing context predates the evidence core");
  }
  return validated;
}

function validateSigningContext(value, prepared) {
  const validated = validateSigningContextForCore(value, prepared.core);
  if (validated.evidenceSigningKeyId !== prepared.signatureRequest.keyId) {
    throw new Error("protected install signing context key mismatch");
  }
  return validated;
}

function composeFixedContextInput(documents) {
  const install = exactObject(
    documents.get("verified-install-context.json"),
    [
      "schemaVersion",
      "releaseEnvironment",
      "operationId",
      "releaseManifestSha256",
      "release",
      "rollback",
      "target",
      "installed",
      "hostLock",
      "databaseSlot",
      "finalLease",
      "issuedAt",
    ],
    "protected install fixed install context",
  );
  const onlineDdl = exactObject(
    documents.get("verified-online-ddl-receipts.json"),
    ["classifiedPendingAlters", "onlineDdlReceipts"],
    "protected install fixed online DDL context",
  );
  return {
    ...install,
    backupEvidence: documents.get("verified-backup-evidence-summary.json"),
    migrationReceipt: documents.get("verified-migration-receipt.json"),
    classifiedPendingAlters: onlineDdl.classifiedPendingAlters,
    onlineDdlReceipts: onlineDdl.onlineDdlReceipts,
    grantEvidence: documents.get("verified-grant-evidence.json"),
    serviceActivationJournal: documents.get("verified-service-activation-journal.json"),
    watchdogJournal: documents.get("verified-watchdog-journal.json"),
    healthEvidence: documents.get("verified-health-evidence.json"),
    watermarkEvidence: documents.get("verified-watermark-evidence.json"),
    rollbackReadiness: documents.get("verified-rollback-readiness.json"),
    producer: documents.get("verified-producer-context.json"),
  };
}

async function loadFixedContext(files) {
  if (typeof files.assertPrivateDirectory !== "function") {
    throw new Error("protected install fixed context directory port is required");
  }
  const beforeDirectory = await files.assertPrivateDirectory(PROTECTED_INSTALL_PATHS.contextRoot);
  const names = await files.list(PROTECTED_INSTALL_PATHS.contextRoot);
  const required = [...REQUIRED_CONTEXT_FILES].sort();
  const withIntent = [...required, PROTECTED_INSTALL_INPUT_FILES.signingIntentFile].sort();
  const withIntentAndSignature = [
    ...withIntent,
    PROTECTED_INSTALL_INPUT_FILES.signatureFile,
  ].sort();
  if (!same(names, required) && !same(names, withIntent) && !same(names, withIntentAndSignature)) {
    throw new Error("protected install fixed context file set is missing or contains extra files");
  }

  const documents = new Map();
  for (const name of REQUIRED_CONTEXT_FILES) {
    const bytes = await files.readStable(posix.join(PROTECTED_INSTALL_PATHS.contextRoot, name));
    documents.set(name, parseCanonicalBytes(bytes, `protected install fixed context ${name}`));
  }
  let signingIntent = null;
  if (names.includes(PROTECTED_INSTALL_INPUT_FILES.signingIntentFile)) {
    const intentBytes = await files.readStable(
      posix.join(
        PROTECTED_INSTALL_PATHS.contextRoot,
        PROTECTED_INSTALL_INPUT_FILES.signingIntentFile,
      ),
    );
    signingIntent = parseCanonicalBytes(
      intentBytes,
      "protected install fixed context signing intent",
    );
  }
  let signatureFile = null;
  if (names.includes(PROTECTED_INSTALL_INPUT_FILES.signatureFile)) {
    const signatureBytes = await files.readStable(
      posix.join(PROTECTED_INSTALL_PATHS.contextRoot, PROTECTED_INSTALL_INPUT_FILES.signatureFile),
    );
    signatureFile = parseCanonicalBytes(
      signatureBytes,
      "protected install fixed context signature",
    );
  }

  const afterNames = await files.list(PROTECTED_INSTALL_PATHS.contextRoot);
  const afterDirectory = await files.assertPrivateDirectory(PROTECTED_INSTALL_PATHS.contextRoot);
  if (!same(names, afterNames) || !same(beforeDirectory, afterDirectory)) {
    throw new Error("protected install fixed context directory changed or was replaced while read");
  }
  return { documents, signingIntent, signatureFile };
}

async function hashFixedTrustedFile(path, options) {
  const before = await lstat(path, { bigint: true });
  const mode = Number(before.mode & 0o777n);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(options.maximumBytes) ||
    (process.platform !== "win32" && before.uid !== 0n) ||
    (process.platform !== "win32" && options.mode !== undefined && mode !== options.mode) ||
    (process.platform !== "win32" && options.mode === undefined && (mode & 0o022) !== 0) ||
    (process.platform !== "win32" && options.executable === true && (mode & 0o100) === 0)
  ) {
    throw new Error("protected install fixed KMS file metadata is invalid");
  }
  const descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await descriptor.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("protected install fixed KMS file identity is invalid");
    }
    const digest = createHash("sha256");
    const stream = descriptor.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk);
    const after = await descriptor.stat({ bigint: true });
    if (!sameIdentity(opened, after)) {
      throw new Error("protected install fixed KMS file changed while read");
    }
    return digest.digest("hex");
  } finally {
    await descriptor.close();
  }
}

function normalizeFixedKmsSignatureOutput(output) {
  if (typeof output !== "string") {
    throw new Error("protected install fixed KMS signing output is invalid");
  }
  let signatureBase64 = output.trim();
  if (signatureBase64.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(signatureBase64);
    } catch {
      throw new Error("protected install fixed KMS signing output is invalid");
    }
    exactObject(parsed, ["signatureBase64"], "protected install fixed KMS signing output");
    signatureBase64 = parsed.signatureBase64;
  }
  return validateSignatureBase64(signatureBase64);
}

async function signWithFixedKms(request, signingContext) {
  const [executableSha256, capabilitySha256] = await Promise.all([
    hashFixedTrustedFile(KMS_EXECUTABLE, {
      maximumBytes: MAX_EXECUTABLE_BYTES,
      executable: true,
    }),
    hashFixedTrustedFile(KMS_CAPABILITY_FILE, {
      maximumBytes: MAX_FILE_BYTES,
      mode: 0o400,
    }),
  ]);
  if (
    executableSha256 !== signingContext.kmsExecutableSha256 ||
    capabilitySha256 !== signingContext.kmsCapabilitySha256
  ) {
    throw new Error("protected install fixed KMS digest binding mismatch");
  }
  const result = spawnSync(
    KMS_EXECUTABLE,
    [
      "sign",
      "--capability-file",
      KMS_CAPABILITY_FILE,
      "--key-id",
      signingContext.evidenceSigningKeyId,
      "--subject-sha256",
      request.subjectSha256,
    ],
    {
      cwd: "/",
      encoding: "utf8",
      env: { ...KMS_ENV },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: KMS_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("protected install fixed KMS signing failed");
  }
  return normalizeFixedKmsSignatureOutput(result.stdout);
}

function databasePreviewIdentity(input) {
  return {
    operationId: input.operationId,
    releaseSha: input.release.sourceSha,
    targetDescriptorSha256: input.target.descriptorSha256,
    operatorBundleSha256: input.installed.operatorBundleSha256,
    installedMigrationSetSha256: input.installed.migrationSetSha256,
    installedSchemaVersion: input.installed.schemaVersion,
  };
}

function hostPreviewIdentity(input) {
  return {
    operationId: input.operationId,
    releaseSha: input.release.sourceSha,
    targetDescriptorSha256: input.target.descriptorSha256,
    operatorBundleSha256: input.installed.operatorBundleSha256,
  };
}

function validateStatePreview(value, expectedCurrent, expectedNext, label) {
  exactObject(value, ["current", "next"], `protected install ${label} preview`);
  exactObject(
    value.current,
    ["operationId", "state", "version"],
    `protected install ${label} current preview`,
  );
  exactObject(
    value.next,
    ["operationId", "state", "version"],
    `protected install ${label} next preview`,
  );
  if (!same(value.current, expectedCurrent) || !same(value.next, expectedNext)) {
    throw new Error(`protected install ${label} preview prediction mismatch`);
  }
}

async function previewFixedState(input, prepared, ports) {
  const database = await ports.previewDatabaseSlot(databasePreviewIdentity(input));
  validateStatePreview(
    database,
    {
      operationId: input.operationId,
      state: "installing",
      version: input.databaseSlot.version,
    },
    prepared.expectedDatabaseSlot,
    "database-slot",
  );
  const host = await ports.previewHostLock(hostPreviewIdentity(input));
  validateStatePreview(
    host,
    {
      operationId: input.operationId,
      state: "installing",
      version: input.hostLock.version,
    },
    prepared.expectedHostLock,
    "host-lock",
  );
}

function signatureCommitMaterials(prepared, signatureFile) {
  const evidence = evidenceFromPrepared(prepared, signatureFile);
  const record = buildRecord(prepared, signatureFile, evidence);
  validateRecord(record);
  return {
    evidence,
    record,
    expectedBytes: expectedPreparedBytes(prepared, signatureFile, evidence, record),
  };
}

async function readPartialPreparedSignature(directory, names, prepared, files) {
  const validPrefixes = PREPARED_FILE_NAMES.slice(0, -1).map((_, index) =>
    PREPARED_FILE_NAMES.slice(0, index + 1).sort(),
  );
  if (
    names.includes("prepared-commit.json") ||
    (names.length > 0 && !validPrefixes.some((prefix) => same(names, prefix)))
  ) {
    throw new Error("protected install prepared directory is incomplete or conflicting");
  }
  if (names.includes("evidence-core.json")) {
    const coreBytes = Buffer.from(
      await files.readStable(posix.join(directory, "evidence-core.json")),
    );
    parseCanonicalBytes(coreBytes, "protected install incomplete prepared evidence core");
    if (!coreBytes.equals(Buffer.from(canonicalJson(prepared.core), "utf8"))) {
      throw new Error("protected install incomplete prepared evidence core conflicts with context");
    }
  }
  if (!names.includes("protected-install-signature.json")) return null;
  const signatureBytes = await files.readStable(
    posix.join(directory, "protected-install-signature.json"),
  );
  const signatureFile = parseCanonicalBytes(
    signatureBytes,
    "protected install incomplete prepared signature",
  );
  const materials = signatureCommitMaterials(prepared, signatureFile);
  if (names.includes("protected-install-evidence.json")) {
    const evidenceBytes = Buffer.from(
      await files.readStable(posix.join(directory, "protected-install-evidence.json")),
    );
    parseCanonicalBytes(evidenceBytes, "protected install incomplete prepared evidence");
    if (!evidenceBytes.equals(materials.expectedBytes.get("protected-install-evidence.json"))) {
      throw new Error("protected install incomplete prepared evidence conflicts with signature");
    }
  }
  return signatureFile;
}

async function inspectExistingCommit(prepared, files) {
  const preparedDirectory = posix.join(
    PROTECTED_INSTALL_PATHS.preparedRoot,
    prepared.core.operationId,
  );
  const committedDirectory = posix.join(
    PROTECTED_INSTALL_PATHS.committedRoot,
    prepared.core.operationId,
  );
  const preparedExists = await files.exists(preparedDirectory);
  const committedExists = await files.exists(committedDirectory);
  if (preparedExists && committedExists) {
    throw new Error("protected install prepared and committed archives conflict");
  }
  if (!preparedExists && !committedExists) {
    return { completeSignature: null, partialSignature: null };
  }
  const directory = committedExists ? committedDirectory : preparedDirectory;
  const names = await files.list(directory);
  if (!same(names, [...PREPARED_FILE_NAMES].sort())) {
    if (committedExists) {
      throw new Error("protected install committed archive is incomplete or conflicting");
    }
    return {
      completeSignature: null,
      partialSignature: await readPartialPreparedSignature(directory, names, prepared, files),
    };
  }
  const signatureFile = parseCanonicalBytes(
    await files.readStable(posix.join(directory, "protected-install-signature.json")),
    "protected install archived signature",
  );
  const materials = signatureCommitMaterials(prepared, signatureFile);
  await readCompleteCommit(directory, files, materials.expectedBytes, materials.record);
  return { completeSignature: signatureFile, partialSignature: null };
}

function signingIntentFor(prepared) {
  return {
    schemaVersion: prepared.signatureRequest.schemaVersion,
    algorithm: prepared.signatureRequest.algorithm,
    keyId: prepared.signatureRequest.keyId,
    subjectSha256: prepared.signatureRequest.subjectSha256,
  };
}

function validateSigningIntent(value, prepared) {
  exactObject(
    value,
    ["schemaVersion", "algorithm", "keyId", "subjectSha256"],
    "protected install signing intent",
  );
  const expected = signingIntentFor(prepared);
  if (!same(value, expected)) {
    throw new Error("protected install signing intent request binding mismatch");
  }
  return value;
}

async function persistFixedSigningIntent(files, prepared) {
  const expected = signingIntentFor(prepared);
  const path = posix.join(
    PROTECTED_INSTALL_PATHS.contextRoot,
    PROTECTED_INSTALL_INPUT_FILES.signingIntentFile,
  );
  const expectedBytes = Buffer.from(canonicalJson(expected), "utf8");
  let created = false;
  if (!(await files.exists(path))) {
    try {
      await files.createOnce(path, expectedBytes, 0o400);
      created = true;
    } catch (error) {
      if (!(await files.exists(path))) throw error;
    }
  }
  const reopened = Buffer.from(await files.readStable(path));
  const persisted = parseCanonicalBytes(reopened, "protected install fixed signing intent");
  validateSigningIntent(persisted, prepared);
  if (!reopened.equals(expectedBytes)) {
    throw new Error("protected install signing intent create-once conflict");
  }
  await files.fsyncDirectory(PROTECTED_INSTALL_PATHS.contextRoot);
  const names = await files.list(PROTECTED_INSTALL_PATHS.contextRoot);
  const withIntent = [
    ...REQUIRED_CONTEXT_FILES,
    PROTECTED_INSTALL_INPUT_FILES.signingIntentFile,
  ].sort();
  const withSignature = [...withIntent, PROTECTED_INSTALL_INPUT_FILES.signatureFile].sort();
  if (!same(names, withIntent) && !same(names, withSignature)) {
    throw new Error("protected install fixed context changed during signing-intent persistence");
  }
  await files.assertPrivateDirectory(PROTECTED_INSTALL_PATHS.contextRoot);
  return { signingIntent: persisted, created };
}

async function persistFixedSignature(files, prepared, signatureFile) {
  const intentPath = posix.join(
    PROTECTED_INSTALL_PATHS.contextRoot,
    PROTECTED_INSTALL_INPUT_FILES.signingIntentFile,
  );
  const persistedIntent = parseCanonicalBytes(
    await files.readStable(intentPath),
    "protected install fixed signing intent",
  );
  validateSigningIntent(persistedIntent, prepared);
  const path = posix.join(
    PROTECTED_INSTALL_PATHS.contextRoot,
    PROTECTED_INSTALL_INPUT_FILES.signatureFile,
  );
  const expectedBytes = Buffer.from(canonicalJson(signatureFile), "utf8");
  if (!(await files.exists(path))) {
    try {
      await files.createOnce(path, expectedBytes, 0o400);
    } catch (error) {
      if (!(await files.exists(path))) throw error;
    }
  }
  const reopened = Buffer.from(await files.readStable(path));
  const persisted = parseCanonicalBytes(reopened, "protected install fixed persisted signature");
  if (!reopened.equals(expectedBytes) || !same(persisted, signatureFile)) {
    throw new Error("protected install fixed signature create-once conflict");
  }
  await files.fsyncDirectory(PROTECTED_INSTALL_PATHS.contextRoot);
  const names = await files.list(PROTECTED_INSTALL_PATHS.contextRoot);
  const expectedNames = [
    ...REQUIRED_CONTEXT_FILES,
    PROTECTED_INSTALL_INPUT_FILES.signingIntentFile,
    PROTECTED_INSTALL_INPUT_FILES.signatureFile,
  ].sort();
  if (!same(names, expectedNames)) {
    throw new Error(
      "protected install fixed context file set changed during signature persistence",
    );
  }
  await files.assertPrivateDirectory(PROTECTED_INSTALL_PATHS.contextRoot);
  return persisted;
}

function defaultFixedCliPorts() {
  return {
    files: nodeFilePort,
    previewDatabaseSlot: (identity) => previewPreparedGate6SlotWithMysqlClient(identity),
    previewHostLock: (identity) => previewProductionInstallHostLockCommit({ identity }),
    sign: signWithFixedKms,
    finalizeDatabaseSlot: (binding) => commitPreparedGate6SlotWithMysqlClient(binding),
    finalizeHostLock: (binding) => commitProductionInstallHostLock({ binding }),
    readDatabaseSlot: (binding) => readPreparedGate6SlotWithMysqlClient(binding),
    readHostLock: (binding) => readProductionInstallHostLockCommit({ binding }),
  };
}

function validateFixedCliPorts(ports) {
  if (!ports || typeof ports !== "object") {
    throw new Error("protected install fixed CLI ports are required");
  }
  for (const method of [
    "previewDatabaseSlot",
    "previewHostLock",
    "sign",
    "finalizeDatabaseSlot",
    "finalizeHostLock",
    "readDatabaseSlot",
    "readHostLock",
  ]) {
    if (typeof ports[method] !== "function") {
      throw new Error(`protected install fixed CLI port ${method} is required`);
    }
  }
  const files = ports.files ?? nodeFilePort;
  for (const method of [
    "exists",
    "assertPrivateDirectory",
    "ensureDirectory",
    "list",
    "createOnce",
    "readStable",
    "fsyncDirectory",
    "renameDirectory",
    "removeIncompleteDirectory",
  ]) {
    if (typeof files[method] !== "function") {
      throw new Error(`protected install fixed CLI file port ${method} is required`);
    }
  }
  return { ...ports, files };
}

export async function runProtectedInstallEvidenceCli(options = {}) {
  exactObjectWithOptional(options, [], ["testPorts"], "protected install fixed CLI options");
  if (options.testPorts !== undefined && process.env.NODE_ENV !== "test") {
    throw new Error("protected install fixed CLI test ports are forbidden outside tests");
  }
  const ports = validateFixedCliPorts(options.testPorts ?? defaultFixedCliPorts());
  const loaded = await loadFixedContext(ports.files);
  const input = composeFixedContextInput(loaded.documents);
  const signingContext = loaded.documents.get("verified-signing-context.json");
  const prepared = prepareProtectedInstallEvidenceCommit(input, signingContext);
  validateSigningContext(signingContext, prepared);
  if (loaded.signingIntent !== null) {
    validateSigningIntent(loaded.signingIntent, prepared);
  }
  const existing = await inspectExistingCommit(prepared, ports.files);

  let signatureFile = existing.completeSignature;
  if (signatureFile !== null) {
    if (loaded.signatureFile !== null && !same(loaded.signatureFile, signatureFile)) {
      throw new Error("protected install fixed signature conflicts with the prepared archive");
    }
    await persistFixedSigningIntent(ports.files, prepared);
  } else {
    if (
      loaded.signatureFile !== null &&
      existing.partialSignature !== null &&
      !same(loaded.signatureFile, existing.partialSignature)
    ) {
      throw new Error("protected install fixed signature conflicts with incomplete prepared bytes");
    }
    signatureFile = loaded.signatureFile ?? existing.partialSignature;
    if (signatureFile !== null) {
      evidenceFromPrepared(prepared, signatureFile);
      await persistFixedSigningIntent(ports.files, prepared);
    } else if (loaded.signingIntent !== null) {
      throw new Error(
        "protected install signing intent is indeterminate without a durable signature or archive",
      );
    }
    await previewFixedState(input, prepared, ports);
    if (signatureFile === null) {
      const intent = await persistFixedSigningIntent(ports.files, prepared);
      if (!intent.created) {
        throw new Error(
          "protected install signing intent was created concurrently and is indeterminate",
        );
      }
      await checkpoint(ports, "signing-intent-durable");
      const signatureBase64 = normalizeFixedKmsSignatureOutput(
        await ports.sign(prepared.signatureRequest, signingContext),
      );
      signatureFile = {
        schemaVersion: 1,
        algorithm: "kms-sha256",
        keyId: prepared.signatureRequest.keyId,
        subjectSha256: prepared.signatureRequest.subjectSha256,
        signatureBase64,
        signedAt: signingContext.signedAt,
      };
      evidenceFromPrepared(prepared, signatureFile);
    }
  }

  signatureFile = await persistFixedSignature(ports.files, prepared, signatureFile);
  const result = await commitProtectedInstallEvidence(prepared, signatureFile, ports);
  return {
    ok: true,
    evidenceSha256: result.evidenceSha256,
    installedSchemaVersion: result.evidence.afterSchema,
    installedMigrationSetSha256: result.evidence.installedMigrationSetSha256,
  };
}

function validatePorts(ports) {
  if (!isPlainObject(ports)) throw new Error("protected install commit ports are required");
  for (const method of [
    "finalizeDatabaseSlot",
    "finalizeHostLock",
    "readDatabaseSlot",
    "readHostLock",
  ]) {
    if (typeof ports[method] !== "function")
      throw new Error(`protected install commit port ${method} is required`);
  }
  const files = ports.files ?? nodeFilePort;
  for (const method of [
    "exists",
    "ensureDirectory",
    "list",
    "createOnce",
    "readStable",
    "fsyncDirectory",
    "renameDirectory",
    "removeIncompleteDirectory",
  ]) {
    if (typeof files[method] !== "function")
      throw new Error(`protected install file port ${method} is required`);
  }
  return files;
}

async function checkpoint(ports, name) {
  if (ports.checkpoint !== undefined) {
    if (typeof ports.checkpoint !== "function")
      throw new Error("protected install checkpoint port is invalid");
    await ports.checkpoint(name);
  }
}

export async function commitProtectedInstallEvidence(prepared, signatureFile, ports) {
  validatePrepared(prepared);
  const files = validatePorts(ports);
  const evidence = evidenceFromPrepared(prepared, signatureFile);
  const record = buildRecord(prepared, signatureFile, evidence);
  validateRecord(record);
  const expectedBytes = expectedPreparedBytes(prepared, signatureFile, evidence, record);
  const preparedDirectory = posix.join(PROTECTED_INSTALL_PATHS.preparedRoot, record.operationId);
  const committedDirectory = posix.join(PROTECTED_INSTALL_PATHS.committedRoot, record.operationId);

  await files.ensureDirectory(PROTECTED_INSTALL_PATHS.root, 0o700);
  await files.ensureDirectory(PROTECTED_INSTALL_PATHS.preparedRoot, 0o700);
  await files.ensureDirectory(PROTECTED_INSTALL_PATHS.committedRoot, 0o700);

  let archiveAlreadyCommitted = await files.exists(committedDirectory);
  if (archiveAlreadyCommitted) {
    await readCompleteCommit(committedDirectory, files, expectedBytes, record);
  } else if (await files.exists(preparedDirectory)) {
    const names = await files.list(preparedDirectory);
    if (same(names, [...PREPARED_FILE_NAMES].sort())) {
      await readCompleteCommit(preparedDirectory, files, expectedBytes, record);
    } else {
      await recoverIncompletePrepare(preparedDirectory, names, files, expectedBytes, record, ports);
      await files.ensureDirectory(preparedDirectory, 0o700, { exclusive: true });
      await createCompleteCommit(preparedDirectory, files, expectedBytes);
      await readCompleteCommit(preparedDirectory, files, expectedBytes, record);
    }
  } else {
    try {
      await files.ensureDirectory(preparedDirectory, 0o700, { exclusive: true });
    } catch (error) {
      if (!(await files.exists(preparedDirectory))) throw error;
    }
    if ((await files.list(preparedDirectory)).length === 0) {
      await createCompleteCommit(preparedDirectory, files, expectedBytes);
    }
    await readCompleteCommit(preparedDirectory, files, expectedBytes, record);
  }
  await checkpoint(ports, "prepared-commit-durable");

  const databaseBinding = stateBinding(record, "database");
  const hostBinding = stateBinding(record, "host");
  if (!archiveAlreadyCommitted) {
    await ports.finalizeDatabaseSlot(databaseBinding);
    await checkpoint(ports, "database-slot-committed");
    await ports.finalizeHostLock(hostBinding);
    await checkpoint(ports, "host-lock-committed");
  }
  const databaseState = await ports.readDatabaseSlot(databaseBinding);
  const hostState = await ports.readHostLock(hostBinding);
  validateCommittedState(databaseState, record, prepared.expectedDatabaseSlot, "database slot");
  validateCommittedState(hostState, record, prepared.expectedHostLock, "host lock");
  await checkpoint(ports, "post-state-reconciled");

  await publishExports(
    files,
    expectedBytes.get("protected-install-evidence.json"),
    expectedBytes.get("protected-install-signature.json"),
  );
  await checkpoint(ports, "exports-durable");

  if (!archiveAlreadyCommitted) {
    await files.renameDirectory(preparedDirectory, committedDirectory);
    await files.fsyncDirectory(PROTECTED_INSTALL_PATHS.preparedRoot);
    await files.fsyncDirectory(PROTECTED_INSTALL_PATHS.committedRoot);
    archiveAlreadyCommitted = true;
  }
  await checkpoint(ports, "prepared-commit-archived");
  return { evidence, evidenceSha256: record.protectedInstallEvidenceSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runMain = async () => {
    if (process.argv.length !== 2) {
      throw new Error("protected install evidence CLI accepts no arguments");
    }
    const result = await runProtectedInstallEvidenceCli();
    process.stdout.write(`${canonicalJson(result)}\n`);
  };
  runMain().catch(() => {
    process.stderr.write("protected-install-evidence-failed\n");
    process.exitCode = 1;
  });
}
