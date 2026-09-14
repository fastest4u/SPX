#!/usr/bin/env node

import { createHash, createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  readEvidenceBundle,
  readEvidenceBytes,
  sha256Canonical,
} from "./lib/evidence-artifact.mjs";
import { openStagingActionLedger } from "./lib/staging-action-ledger.mjs";
import {
  installVerifiedReleaseBinding,
  loadInstalledStagingTrust,
} from "./lib/staging-installed-context.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "./lib/staging-action-plan.mjs";
import {
  deploymentTargetDescriptorArtifactSha256,
  verifyDeploymentTargetDescriptor,
} from "../src/services/deployment-target-descriptor.ts";
import { verifyOperatorBundleArchive } from "./build-operator-bundle.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIGRATION_PATTERN = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
const PLACEHOLDER_PATTERN = /(?:\bTODO\b|\bTBD\b|YYYY|HHMM|<[^>]+>|replace\s+this)/i;
const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SECRET_VALUE_PATTERN =
  /(?:\bBearer\s+\S+|\bBasic\s+\S+|\bsk-[A-Za-z0-9_-]{16,}|PRIVATE KEY-----)/i;
const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "approvalId",
  "stagingRunId",
  "nonce",
  "release",
  "migrations",
  "target",
  "policy",
  "actions",
  "provenance",
  "keyId",
  "signatureAlgorithm",
  "signedPayloadSha256",
  "signature",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, fields, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    const unknown = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    if (unknown.length > 0) throw new Error(`${label} contains an unknown field`);
    throw new Error(`${label} is missing required field ${missing[0]}`);
  }
}

function assertAllowedKeys(value, required, optional, label) {
  assertObject(value, label);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains an unknown field`);
  for (const key of required) {
    if (!(key in value)) throw new Error(`${label} is missing required field ${key}`);
  }
}

function assertPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
}

function assertId(value, label) {
  assertPattern(value, ID_PATTERN, label);
  if (PLACEHOLDER_PATTERN.test(value)) throw new Error(`${label} contains a placeholder`);
}

function scanNoPlaceholdersOrSecrets(value, path = "$", seen = new Set()) {
  if (typeof value === "string") {
    if (PLACEHOLDER_PATTERN.test(value)) throw new Error(`${path} contains a placeholder`);
    if (SECRET_VALUE_PATTERN.test(value)) throw new Error(`${path} contains secret-shaped content`);
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object") throw new Error(`${path} is not a JSON value`);
  if (seen.has(value)) throw new Error("approval envelope contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanNoPlaceholdersOrSecrets(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) throw new Error(`${path} contains a secret-shaped field`);
      scanNoPlaceholdersOrSecrets(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function unsignedEnvelope(envelope) {
  const payload = structuredClone(envelope);
  delete payload.signedPayloadSha256;
  delete payload.signature;
  return payload;
}

function parseEnvelope(envelope) {
  if (typeof envelope !== "string") return structuredClone(envelope);
  const parsed = JSON.parse(envelope);
  if (envelope !== canonicalJson(parsed)) {
    throw new Error("staging approval envelope must use canonical JSON");
  }
  return parsed;
}

function verifySignedDocument(document, trust, label) {
  assertObject(trust, "pinned trust");
  assertObject(trust.publicKeys, "pinned public keys");
  assertPattern(document.keyId, ID_PATTERN, `${label} key ID`);
  if (document.signatureAlgorithm !== "Ed25519") {
    throw new Error("signature algorithm must be Ed25519");
  }
  const publicKey = trust.publicKeys[document.keyId];
  if (typeof publicKey !== "string" && !isObject(publicKey)) {
    throw new Error("key ID is not pinned");
  }
  const payload = unsignedEnvelope(document);
  const canonicalPayload = canonicalJson(payload);
  const payloadSha256 = sha256Canonical(payload);
  if (document.signedPayloadSha256 !== payloadSha256) {
    throw new Error("signature payload digest mismatch");
  }
  if (
    typeof document.signature !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(document.signature)
  ) {
    throw new Error("signature is invalid");
  }
  const signature = Buffer.from(document.signature, "base64");
  if (signature.length !== 64) throw new Error("signature is invalid");
  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw new Error("key ID contains an invalid public key");
  }
  if (!verify(null, Buffer.from(canonicalPayload), key, signature)) {
    throw new Error(`${label} signature verification failed`);
  }
}

function verifyEnvelopeSignature(envelope, trust) {
  verifySignedDocument(envelope, trust, "staging approval");
}

function validatePinnedTrust(value) {
  assertExactKeys(
    value,
    [
      "publicKeys",
      "repository",
      "workflow",
      "workflowSha",
      "environment",
      "issuer",
      "audience",
      "subject",
      "workflowFileSha256",
      "targetDescriptor",
    ],
    "installed pinned trust",
  );
  assertObject(value.publicKeys, "installed pinned public keys");
  const keyEntries = Object.entries(value.publicKeys);
  if (keyEntries.length === 0) throw new Error("installed pinned public keys are required");
  for (const [keyId, publicKey] of keyEntries) {
    assertId(keyId, "installed pinned key ID");
    if (typeof publicKey !== "string" || publicKey.length > 16 * 1024) {
      throw new Error("installed pinned public key is invalid");
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) {
    throw new Error("installed pinned repository is invalid");
  }
  if (value.workflow !== ".github/workflows/staging-rollout-signer.yml") {
    throw new Error("installed pinned workflow is invalid");
  }
  assertPattern(value.workflowSha, COMMIT_SHA_PATTERN, "installed workflow SHA");
  if (
    value.environment !== "staging" ||
    value.issuer !== "https://token.actions.githubusercontent.com" ||
    value.audience !== "spx-staging-rollout" ||
    value.subject !== `repo:${value.repository}:environment:staging`
  ) {
    throw new Error("installed pinned OIDC trust is invalid");
  }
  assertPattern(value.workflowFileSha256, SHA256_PATTERN, "installed workflow file hash");
  assertExactKeys(
    value.targetDescriptor,
    [
      "keyId",
      "publicKey",
      "repository",
      "workflowRef",
      "environment",
      "subject",
      "audience",
      "issuer",
      "jobWorkflowRef",
      "signingWorkflowSourceSha",
      "signingWorkflowFileSha256",
    ],
    "installed target descriptor trust",
  );
  assertId(value.targetDescriptor.keyId, "target descriptor key ID");
  if (
    typeof value.targetDescriptor.publicKey !== "string" ||
    value.targetDescriptor.publicKey.length > 16 * 1024
  ) {
    throw new Error("target descriptor public key is invalid");
  }
  if (
    value.targetDescriptor.repository !== value.repository ||
    value.targetDescriptor.environment !== "staging" ||
    value.targetDescriptor.subject !== `repo:${value.repository}:environment:staging` ||
    value.targetDescriptor.issuer !== value.issuer ||
    value.targetDescriptor.workflowRef !== value.targetDescriptor.jobWorkflowRef
  ) {
    throw new Error("target descriptor pinned provenance is invalid");
  }
  assertPattern(
    value.targetDescriptor.signingWorkflowSourceSha,
    COMMIT_SHA_PATTERN,
    "target descriptor signing source SHA",
  );
  assertPattern(
    value.targetDescriptor.signingWorkflowFileSha256,
    SHA256_PATTERN,
    "target descriptor workflow file hash",
  );
  return value;
}

function validateRelease(release) {
  assertExactKeys(
    release,
    [
      "candidateSha",
      "candidateImageDigest",
      "rollbackSha",
      "rollbackImageDigest",
      "releaseManifestSha256",
      "rollbackReleaseManifestSha256",
      "operatorBundleSha256",
    ],
    "release",
  );
  assertPattern(release.candidateSha, COMMIT_SHA_PATTERN, "candidate SHA");
  assertPattern(release.candidateImageDigest, IMAGE_DIGEST_PATTERN, "candidate image digest");
  assertPattern(release.rollbackSha, COMMIT_SHA_PATTERN, "rollback SHA");
  assertPattern(release.rollbackImageDigest, IMAGE_DIGEST_PATTERN, "rollback image digest");
  assertPattern(release.releaseManifestSha256, SHA256_PATTERN, "release manifest hash");
  assertPattern(
    release.rollbackReleaseManifestSha256,
    SHA256_PATTERN,
    "rollback release manifest hash",
  );
  assertPattern(release.operatorBundleSha256, SHA256_PATTERN, "operator bundle hash");
}

function validateMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error("migrations must freeze a non-empty released migration set");
  }
  const filenames = new Set();
  migrations.forEach((migration, index) => {
    assertExactKeys(migration, ["filename", "sha256"], `migration ${index + 1}`);
    assertPattern(migration.filename, MIGRATION_PATTERN, "migration filename");
    if (filenames.has(migration.filename)) throw new Error("migration filenames must be unique");
    filenames.add(migration.filename);
    if (index > 0 && migrations[index - 1].filename >= migration.filename)
      throw new Error("migrations must be in canonical filename order");
    assertPattern(migration.sha256, SHA256_PATTERN, "migration checksum");
  });
}

function validateTarget(target) {
  assertExactKeys(
    target,
    [
      "environment",
      "composeProject",
      "database",
      "targetDescriptorSha256",
      "databaseTlsFingerprintSha256",
      "providerTargetFingerprintsSha256",
    ],
    "target",
  );
  if (
    target.environment !== "staging" ||
    target.composeProject !== "spx-staging" ||
    target.database !== "spx_staging"
  ) {
    throw new Error("approval envelope is staging only");
  }
  assertPattern(target.targetDescriptorSha256, SHA256_PATTERN, "target descriptor hash");
  assertPattern(target.databaseTlsFingerprintSha256, SHA256_PATTERN, "database TLS fingerprint");
  if (
    !Array.isArray(target.providerTargetFingerprintsSha256) ||
    target.providerTargetFingerprintsSha256.length === 0
  ) {
    throw new Error("provider target fingerprints are required");
  }
  target.providerTargetFingerprintsSha256.forEach((fingerprint) =>
    assertPattern(fingerprint, SHA256_PATTERN, "provider target fingerprint"),
  );
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp`);
  return time;
}

function validatePolicy(policy, now) {
  assertExactKeys(
    policy,
    [
      "notBefore",
      "expiresAt",
      "maintenanceWindowId",
      "sideEffectPolicy",
      "evidencePolicy",
      "thresholds",
      "owners",
    ],
    "policy",
  );
  const notBefore = parseTimestamp(policy.notBefore, "notBefore");
  const expiresAt = parseTimestamp(policy.expiresAt, "expiresAt");
  if (expiresAt <= notBefore || expiresAt - notBefore > 24 * 60 * 60 * 1_000) {
    throw new Error("approval validity window is invalid");
  }
  if (now < notBefore) throw new Error("approval is not yet valid");
  if (now >= expiresAt) throw new Error("approval is expired");
  assertId(policy.maintenanceWindowId, "maintenance window ID");
  if (policy.sideEffectPolicy !== "controlled-staging-only") {
    throw new Error("side-effect policy must be controlled staging only");
  }
  if (policy.evidencePolicy !== "sanitized-attested-only") {
    throw new Error("evidence policy must require sanitized attestations");
  }
  assertExactKeys(
    policy.thresholds,
    [
      "maxCpuPercent",
      "minMemoryFreeBytes",
      "minMysqlConnectionsFree",
      "productionP95LatencyMs",
      "maxLatencyIncreasePercent",
    ],
    "thresholds",
  );
  const thresholds = policy.thresholds;
  if (
    !Number.isFinite(thresholds.maxCpuPercent) ||
    thresholds.maxCpuPercent < 0 ||
    thresholds.maxCpuPercent > 100
  ) {
    throw new Error("threshold maxCpuPercent is invalid");
  }
  if (!Number.isSafeInteger(thresholds.minMemoryFreeBytes) || thresholds.minMemoryFreeBytes < 0) {
    throw new Error("threshold minMemoryFreeBytes is invalid");
  }
  if (
    !Number.isSafeInteger(thresholds.minMysqlConnectionsFree) ||
    thresholds.minMysqlConnectionsFree < 0
  ) {
    throw new Error("threshold minMysqlConnectionsFree is invalid");
  }
  if (
    !Number.isFinite(thresholds.productionP95LatencyMs) ||
    thresholds.productionP95LatencyMs < 0
  ) {
    throw new Error("threshold productionP95LatencyMs is invalid");
  }
  if (
    !Number.isFinite(thresholds.maxLatencyIncreasePercent) ||
    thresholds.maxLatencyIncreasePercent < 0 ||
    thresholds.maxLatencyIncreasePercent > 100
  ) {
    throw new Error("threshold maxLatencyIncreasePercent is invalid");
  }
  assertExactKeys(policy.owners, ["rolloutOwner", "recoveryOwner"], "owners");
  assertId(policy.owners.rolloutOwner, "rollout owner");
  assertId(policy.owners.recoveryOwner, "recovery owner");
}

function validateActions(actions) {
  if (!Array.isArray(actions) || actions.length !== REQUIRED_STAGING_ACTION_PLAN.length) {
    throw new Error("ordered actions must exactly match the complete Gate 1-5 staging plan");
  }
  const actionIds = new Set();
  actions.forEach((action, index) => {
    assertAllowedKeys(
      action,
      ["sequence", "actionId", "scope", "kind", "mutationSha256"],
      ["compensatesActionId"],
      `action ${index + 1}`,
    );
    if (action.sequence !== index + 1)
      throw new Error("actions must use a contiguous ordered sequence");
    assertId(action.actionId, "action ID");
    assertId(action.scope, "action scope");
    if (actionIds.has(action.actionId)) throw new Error("action IDs must be unique");
    actionIds.add(action.actionId);
    if (!["forward", "compensation", "emergency"].includes(action.kind)) {
      throw new Error("action kind is invalid");
    }
    assertPattern(action.mutationSha256, SHA256_PATTERN, "action mutation hash");
    if (action.kind === "compensation") {
      assertId(action.compensatesActionId, "compensated action ID");
    } else if ("compensatesActionId" in action) {
      throw new Error("only compensation actions may name a compensated action");
    }
    if (canonicalJson(action) !== canonicalJson(REQUIRED_STAGING_ACTION_PLAN[index])) {
      throw new Error(`action ${index + 1} does not match the exact Gate 1-5 staging plan`);
    }
  });
}

function validateProvenance(envelope, trust, operatorBundleIndex) {
  const provenance = envelope.provenance;
  assertExactKeys(
    provenance,
    [
      "repository",
      "workflow",
      "workflowRef",
      "workflowSha",
      "jobWorkflowRef",
      "jobWorkflowSha",
      "workflowFileSha256",
      "environment",
      "issuer",
      "audience",
      "subject",
    ],
    "provenance",
  );
  const expectedRef = `${trust.repository}/${trust.workflow}@${trust.workflowSha}`;
  if (
    provenance.repository !== trust.repository ||
    provenance.workflow !== trust.workflow ||
    provenance.workflowRef !== expectedRef ||
    provenance.jobWorkflowRef !== expectedRef ||
    provenance.workflowSha !== trust.workflowSha ||
    provenance.jobWorkflowSha !== trust.workflowSha
  ) {
    throw new Error("workflow provenance must use the pinned trusted signer SHA");
  }
  if (
    provenance.environment !== trust.environment ||
    provenance.issuer !== trust.issuer ||
    provenance.audience !== trust.audience ||
    provenance.subject !== trust.subject
  ) {
    throw new Error("OIDC workflow subject claims do not match pinned trust");
  }
  const signerEntries = Array.isArray(operatorBundleIndex.files)
    ? operatorBundleIndex.files.filter((entry) => entry?.path === trust.workflow)
    : [];
  if (
    provenance.workflowFileSha256 !== trust.workflowFileSha256 ||
    signerEntries.length !== 1 ||
    signerEntries[0]?.sha256 !== provenance.workflowFileSha256
  ) {
    throw new Error("workflow file hash does not match the operator bundle");
  }
}

function validateAttestation(
  attestation,
  trust,
  expectedWorkflow,
  workflowSha,
  expectedDigest,
  label,
) {
  assertExactKeys(
    attestation,
    [
      "repository",
      "workflow",
      "workflowSha",
      "environment",
      "issuer",
      "audience",
      "subject",
      "subjectDigestSha256",
    ],
    label,
  );
  if (
    attestation.repository !== trust.repository ||
    attestation.workflow !== expectedWorkflow ||
    attestation.workflowSha !== workflowSha ||
    attestation.environment !== trust.environment ||
    attestation.issuer !== trust.issuer ||
    attestation.audience !== trust.audience ||
    attestation.subject !== trust.subject
  ) {
    throw new Error(`${label} OIDC workflow subject claims do not match pinned trust`);
  }
  if (attestation.subjectDigestSha256 !== expectedDigest) {
    throw new Error(`${label} subject digest does not match the verified artifact`);
  }
}

function actionArtifactFilename(action) {
  return `${String(action.sequence).padStart(3, "0")}-${action.actionId}.action.json`;
}

function validateSignedActionArtifacts(envelope, trust, artifacts) {
  const envelopeSha256 = sha256Canonical(envelope);
  const actionIndex = assertObject(artifacts.actionIndex, "signed action index");
  verifySignedDocument(actionIndex, trust, "action index");
  assertExactKeys(
    actionIndex,
    [
      "schemaVersion",
      "artifactType",
      "approvalId",
      "stagingRunId",
      "envelopeSha256",
      "actions",
      "keyId",
      "signatureAlgorithm",
      "signedPayloadSha256",
      "signature",
    ],
    "signed action index",
  );
  if (
    actionIndex.schemaVersion !== 1 ||
    actionIndex.artifactType !== "spx-staging-action-index" ||
    actionIndex.approvalId !== envelope.approvalId ||
    actionIndex.stagingRunId !== envelope.stagingRunId ||
    actionIndex.envelopeSha256 !== envelopeSha256 ||
    actionIndex.keyId !== envelope.keyId ||
    !Array.isArray(actionIndex.actions) ||
    actionIndex.actions.length !== envelope.actions.length
  ) {
    throw new Error("signed action index is not bound to the approval envelope");
  }
  validateAttestation(
    artifacts.actionIndexAttestation,
    trust,
    trust.workflow,
    trust.workflowSha,
    sha256Canonical(actionIndex),
    "action index attestation",
  );

  const actionArtifacts = assertObject(artifacts.actionArtifacts, "signed action artifacts");
  const actionAttestations = assertObject(
    artifacts.actionAttestations,
    "signed action artifact attestations",
  );
  const expectedFilenames = envelope.actions.map(actionArtifactFilename);
  assertExactKeys(actionArtifacts, expectedFilenames, "signed action artifacts");
  assertExactKeys(actionAttestations, expectedFilenames, "signed action artifact attestations");

  for (const [index, action] of envelope.actions.entries()) {
    const filename = expectedFilenames[index];
    const indexEntry = assertObject(actionIndex.actions[index], `action index entry ${index + 1}`);
    assertExactKeys(
      indexEntry,
      ["sequence", "actionId", "scope", "filename", "artifactSha256"],
      `action index entry ${index + 1}`,
    );
    const artifact = assertObject(actionArtifacts[filename], `signed action artifact ${index + 1}`);
    verifySignedDocument(artifact, trust, `action artifact ${index + 1}`);
    assertExactKeys(
      artifact,
      [
        "schemaVersion",
        "artifactType",
        "approvalId",
        "stagingRunId",
        "envelopeSha256",
        "action",
        "keyId",
        "signatureAlgorithm",
        "signedPayloadSha256",
        "signature",
      ],
      `signed action artifact ${index + 1}`,
    );
    const artifactSha256 = sha256Canonical(artifact);
    if (
      indexEntry.sequence !== action.sequence ||
      indexEntry.actionId !== action.actionId ||
      indexEntry.scope !== action.scope ||
      indexEntry.filename !== filename ||
      indexEntry.artifactSha256 !== artifactSha256 ||
      artifact.schemaVersion !== 1 ||
      artifact.artifactType !== "spx-staging-action" ||
      artifact.approvalId !== envelope.approvalId ||
      artifact.stagingRunId !== envelope.stagingRunId ||
      artifact.envelopeSha256 !== envelopeSha256 ||
      artifact.keyId !== envelope.keyId ||
      canonicalJson(artifact.action) !== canonicalJson(action)
    ) {
      throw new Error(`signed action artifact ${index + 1} is not exactly bound to the index`);
    }
    validateAttestation(
      actionAttestations[filename],
      trust,
      trust.workflow,
      trust.workflowSha,
      artifactSha256,
      `action artifact ${index + 1} attestation`,
    );
  }
}

function validateOperatorBundleIndex(value) {
  assertExactKeys(value, ["schemaVersion", "format", "files"], "operator bundle index");
  if (value.schemaVersion !== 1 || value.format !== "ustar") {
    throw new Error("operator bundle index version or format is invalid");
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("operator bundle index files are required");
  }
  const paths = new Set();
  for (const entry of value.files) {
    assertExactKeys(entry, ["path", "sha256", "size", "mode"], "operator bundle file");
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      paths.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.mode !== "0644"
    ) {
      throw new Error("operator bundle file metadata is invalid");
    }
    assertHashLike(entry.sha256, "operator bundle file hash");
    paths.add(entry.path);
  }
}

function assertHashLike(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function validateArtifactBindings(envelope, trust, artifacts, now) {
  assertObject(artifacts, "verified artifacts");
  const releaseManifest = assertObject(artifacts.releaseManifest, "release manifest");
  const rollbackReleaseManifest = assertObject(
    artifacts.rollbackReleaseManifest,
    "rollback release manifest",
  );
  const targetDescriptor = assertObject(artifacts.targetDescriptor, "target descriptor");
  const operatorBundleIndex = assertObject(artifacts.operatorBundleIndex, "operator bundle index");
  if (
    !Buffer.isBuffer(artifacts.operatorBundle) &&
    !(artifacts.operatorBundle instanceof Uint8Array)
  ) {
    throw new Error("operator bundle artifact bytes are required");
  }
  validateOperatorBundleIndex(operatorBundleIndex);
  if (sha256Canonical(releaseManifest) !== envelope.release.releaseManifestSha256) {
    throw new Error("release manifest hash does not match the artifact");
  }
  if (
    sha256Canonical(rollbackReleaseManifest) !==
      envelope.release.rollbackReleaseManifestSha256
  ) {
    throw new Error("rollback release manifest hash does not match the artifact");
  }
  if (
    deploymentTargetDescriptorArtifactSha256(targetDescriptor) !==
    envelope.target.targetDescriptorSha256
  ) {
    throw new Error("target descriptor hash does not match the artifact");
  }
  if (
    createHash("sha256").update(artifacts.operatorBundle).digest("hex") !==
    envelope.release.operatorBundleSha256
  ) {
    throw new Error("operator bundle hash does not match the artifact");
  }
  const releaseMigrations = Array.isArray(releaseManifest.migrations)
    ? releaseManifest.migrations.map((migration) => ({
        filename: migration?.name,
        sha256: migration?.sha256,
      }))
    : null;
  const rollbackMigrations = Array.isArray(rollbackReleaseManifest.migrations)
    ? rollbackReleaseManifest.migrations.map((migration) => ({
        filename: migration?.name,
        sha256: migration?.sha256,
      }))
    : null;
  if (
    releaseManifest.sourceSha !== envelope.release.candidateSha ||
    releaseManifest.imageId !== envelope.release.candidateImageDigest ||
    releaseManifest.operatorBundleSha256 !== envelope.release.operatorBundleSha256 ||
    canonicalJson(releaseMigrations) !== canonicalJson(envelope.migrations)
  ) {
    throw new Error("release manifest is not bound to the approval release");
  }
  validateMigrations(rollbackMigrations);
  const candidateMaximum = Math.max(
    ...releaseMigrations.map((migration) => Number(migration.filename.slice(0, 3))),
  );
  const rollbackMaximum = Math.max(
    ...rollbackMigrations.map((migration) => Number(migration.filename.slice(0, 3))),
  );
  const rollbackMigrationMap = new Map(
    rollbackMigrations.map((migration) => [migration.filename, migration.sha256]),
  );
  const rollbackCoversCandidate = releaseMigrations.every((migration) =>
    rollbackMigrationMap.get(migration.filename) === migration.sha256);
  if (
    rollbackReleaseManifest.sourceSha !== envelope.release.rollbackSha ||
    rollbackReleaseManifest.imageId !== envelope.release.rollbackImageDigest ||
    !Number.isSafeInteger(releaseManifest.schema?.min) ||
    !Number.isSafeInteger(releaseManifest.schema?.max) ||
    !Number.isSafeInteger(rollbackReleaseManifest.schema?.min) ||
    !Number.isSafeInteger(rollbackReleaseManifest.schema?.max) ||
    candidateMaximum !== releaseManifest.schema.max ||
    rollbackMaximum !== rollbackReleaseManifest.schema.max ||
    !rollbackCoversCandidate ||
    releaseManifest.schema.max < rollbackReleaseManifest.schema.min ||
    releaseManifest.schema.max > rollbackReleaseManifest.schema.max
  ) {
    throw new Error(
      "exact rollback release manifest migration coverage is not compatible with the current schema",
    );
  }
  assertObject(trust.targetDescriptor, "target descriptor pinned trust");
  let descriptor;
  try {
    descriptor = verifyDeploymentTargetDescriptor({
      artifact: targetDescriptor,
      attestation: artifacts.targetDescriptorAttestation,
      trust: {
        ...trust.targetDescriptor,
        releaseManifestSha256: envelope.release.releaseManifestSha256,
        operatorBundleSha256: envelope.release.operatorBundleSha256,
        releaseSourceSha: envelope.release.candidateSha,
        imageId: envelope.release.candidateImageDigest,
        imageTag: `spx-app:${envelope.release.candidateSha}`,
        targetFactsSha256: targetDescriptor.descriptor?.targetFactsSha256,
        operatorBundleIndex,
        now,
      },
    });
  } catch (error) {
    throw new Error("target descriptor verification failed", { cause: error });
  }
  if (
    descriptor.releaseEnvironment !== "staging" ||
    descriptor.runtimeEnvironment !== "staging" ||
    descriptor.composeProject !== "spx-staging" ||
    descriptor.database.name !== "spx_staging" ||
    descriptor.database.tlsFingerprintSha256 !== envelope.target.databaseTlsFingerprintSha256 ||
    canonicalJson(descriptor.providerTargetFingerprints) !==
      canonicalJson(envelope.target.providerTargetFingerprintsSha256) ||
    descriptor.target.canonicalPaths.releaseRoot !== "/opt/spx-staging/release" ||
    descriptor.target.canonicalPaths.environmentFile !== "/etc/spx-staging/runtime.env" ||
    descriptor.target.canonicalPaths.stateRoot !== "/var/lib/spx-staging-rollout"
  ) {
    throw new Error("target descriptor is not an immutable staging-only target");
  }
  validateProvenance(envelope, trust, operatorBundleIndex);
  validateAttestation(
    artifacts.approvalAttestation,
    trust,
    trust.workflow,
    trust.workflowSha,
    sha256Canonical(envelope),
    "approval attestation",
  );
  validateSignedActionArtifacts(envelope, trust, artifacts);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export async function verifyStagingRolloutEnvelope(envelopeInput, artifacts, options = {}) {
  const pinnedTrust = validatePinnedTrust(await loadInstalledStagingTrust());
  const envelope = parseEnvelope(envelopeInput);
  assertObject(envelope, "approval envelope");
  verifyEnvelopeSignature(envelope, pinnedTrust);
  assertExactKeys(envelope, TOP_LEVEL_FIELDS, "approval envelope");
  if (envelope.schemaVersion !== 1) throw new Error("unsupported approval envelope schema version");
  assertId(envelope.approvalId, "approval ID");
  assertId(envelope.stagingRunId, "staging run ID");
  assertId(envelope.nonce, "approval nonce");
  validateRelease(envelope.release);
  validateMigrations(envelope.migrations);
  validateTarget(envelope.target);
  const nowValue = options.now instanceof Date ? options.now.getTime() : Date.now();
  if (!Number.isFinite(nowValue)) throw new Error("verification time is invalid");
  validatePolicy(envelope.policy, nowValue);
  validateActions(envelope.actions);
  scanNoPlaceholdersOrSecrets(unsignedEnvelope(envelope));
  validateArtifactBindings(envelope, pinnedTrust, artifacts, new Date(nowValue));

  return deepFreeze({
    approvalId: envelope.approvalId,
    stagingRunId: envelope.stagingRunId,
    envelopeSha256: sha256Canonical(envelope),
    releaseManifestSha256: envelope.release.releaseManifestSha256,
    rollbackReleaseManifestSha256:
      envelope.release.rollbackReleaseManifestSha256,
    targetDescriptorSha256: envelope.target.targetDescriptorSha256,
    operatorBundleSha256: envelope.release.operatorBundleSha256,
    candidateSha: envelope.release.candidateSha,
    imageDigest: envelope.release.candidateImageDigest,
    environment: envelope.target.environment,
    composeProject: envelope.target.composeProject,
    topology: artifacts.targetDescriptor.descriptor.topology,
    actions: structuredClone(envelope.actions),
    envelope: structuredClone(envelope),
  });
}

export async function verifyEnvelope(envelope, artifacts, options = {}) {
  await verifyStagingRolloutEnvelope(envelope, artifacts, options);
  return true;
}

export async function openVerifiedStagingRollout({
  envelope,
  artifacts,
  verificationOptions = {},
  ledgerOptions = {},
}) {
  const verified = await verifyStagingRolloutEnvelope(envelope, artifacts, verificationOptions);
  const binding = {
    approvalId: verified.approvalId,
    stagingRunId: verified.stagingRunId,
    approvalEnvelopeSha256: verified.envelopeSha256,
    targetDescriptorSha256: verified.targetDescriptorSha256,
    operatorBundleSha256: verified.operatorBundleSha256,
  };
  const verifiedActions = new WeakSet();
  const actions = verified.actions.map((action) => {
    const contextAction = Object.freeze({
      ...binding,
      ...action,
      notBefore: verified.envelope.policy.notBefore,
      expiresAt: verified.envelope.policy.expiresAt,
    });
    verifiedActions.add(contextAction);
    return contextAction;
  });
  const { persistReleaseBinding = false, ...actionLedgerOptions } = ledgerOptions;
  const externalReconciliationVerifier = actionLedgerOptions.verifyReconciliation;
  const ledger = await openStagingActionLedger({
    ...actionLedgerOptions,
    binding,
    actions,
    verifyAction(action) {
      if (!verifiedActions.has(action))
        throw new Error("action was not inherited from verified approval");
      return true;
    },
    verifyReconciliation:
      typeof externalReconciliationVerifier === "function"
        ? externalReconciliationVerifier
        : () => {
            throw new Error("signed reconciliation verifier is not configured");
          },
  });

  async function persistCurrentReleaseBinding() {
    if (persistReleaseBinding !== true) return;
    await installVerifiedReleaseBinding({
      candidateSha: verified.candidateSha,
      imageDigest: verified.imageDigest,
      releaseManifestSha256: verified.releaseManifestSha256,
      environment: verified.environment,
      topology: verified.topology,
      composeProject: verified.composeProject,
      stagingTargetDescriptorSha256: verified.targetDescriptorSha256,
      operatorBundleSha256: verified.operatorBundleSha256,
      stagingApprovalEnvelopeSha256: verified.envelopeSha256,
      actionJournalHeadSha256: await ledger.head(),
      stagingRunId: verified.stagingRunId,
    });
  }
  await persistCurrentReleaseBinding();

  class OpaqueActionContext {
    #action;
    #used = false;

    constructor(action) {
      this.#action = action;
      Object.freeze(this);
    }

    async run(...callerArguments) {
      if (callerArguments.length > 0) {
        throw new Error("verified action contexts run only their fixed signed operation");
      }
      if (this.#used) throw new Error("verified action context cannot be reused");
      this.#used = true;
      if (this.#action.kind === "compensation") {
        await ledger.compensate(this.#action);
      } else {
        await ledger.consume(this.#action);
      }
      await persistCurrentReleaseBinding();
      return true;
    }
  }

  const contexts = new Map(
    actions.map((action) => [action.actionId, new OpaqueActionContext(action)]),
  );
  let closed = false;
  return Object.freeze({
    action(actionId) {
      if (closed) throw new Error("verified staging rollout is closed");
      const context = contexts.get(actionId);
      if (!context) throw new Error("action is not approved by this staging envelope");
      return context;
    },
    async head() {
      if (closed) throw new Error("verified staging rollout is closed");
      return ledger.head();
    },
    async snapshot(...callerArguments) {
      if (closed) throw new Error("verified staging rollout is closed");
      if (callerArguments.length > 0) {
        throw new Error("verified staging rollout snapshot accepts zero arguments");
      }
      return ledger.snapshot();
    },
    async close() {
      if (closed) return;
      closed = true;
      await ledger.close();
    },
  });
}

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseCanonicalArtifactBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (text !== canonicalJson(value)) throw new Error(`${label} must use canonical JSON`);
  return value;
}

async function readCanonicalCliArtifact(path, label, maxFileBytes = 256 * 1024) {
  const bytes = await readEvidenceBytes(path, { maxFileBytes });
  return { bytes, value: parseCanonicalArtifactBytes(bytes, label) };
}

function actionAttestationFilename(actionFilename) {
  return `${actionFilename}.attestation.json`;
}

function actionBundleNamesFromIndex(index) {
  const requiredActionCount = REQUIRED_STAGING_ACTION_PLAN.length;
  if (
    !isObject(index) ||
    !Array.isArray(index.actions) ||
    index.actions.length !== requiredActionCount
  ) {
    throw new Error("action index does not contain the fixed action set");
  }
  const names = [];
  const seen = new Set();
  for (const entry of index.actions) {
    if (!isObject(entry)) throw new Error("action index entry is invalid");
    const expected = `${String(entry.sequence).padStart(3, "0")}-${entry.actionId}.action.json`;
    if (
      !Number.isInteger(entry.sequence) ||
      entry.sequence < 1 ||
      entry.sequence > requiredActionCount ||
      typeof entry.actionId !== "string" ||
      !ID_PATTERN.test(entry.actionId) ||
      entry.filename !== expected ||
      entry.filename !== basename(entry.filename) ||
      seen.has(entry.filename)
    ) {
      throw new Error("action index filename is invalid");
    }
    seen.add(entry.filename);
    names.push(entry.filename, actionAttestationFilename(entry.filename));
  }
  return names;
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeStagedArtifact(root, name, bytes) {
  if (name !== basename(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) {
    throw new Error("safe artifact stage filename is invalid");
  }
  const path = join(root, name);
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

async function stageVerifiedCliArtifacts(entries) {
  const root = await mkdtemp(join(tmpdir(), "spx-staging-approval-verify-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const paths = {};
  try {
    for (const entry of entries) {
      if (paths[entry.name]) throw new Error("safe artifact stage filename is duplicated");
      paths[entry.name] = await writeStagedArtifact(root, entry.name, entry.bytes);
    }
    await syncDirectory(root);
    return { root, paths };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function verifyPublishedArtifact(path, repository, workflow, signerDigest) {
  const command = process.platform === "win32" ? "gh.exe" : "gh";
  const result = spawnSync(
    command,
    [
      "attestation",
      "verify",
      resolve(path),
      "--repo",
      repository,
      "--signer-repo",
      repository,
      "--signer-workflow",
      `${repository}/${workflow}`,
      "--signer-digest",
      signerDigest,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  if (result.error || result.status !== 0) {
    throw new Error("published GitHub artifact attestation verification failed");
  }
}

export function verifyStagedStagingRolloutArtifactProvenance(
  paths,
  trust,
  verify = verifyPublishedArtifact,
) {
  if (!paths || typeof paths !== "object" || typeof verify !== "function") {
    throw new Error("fixed staged artifact provenance inputs are invalid");
  }
  const specifications = [
    ["approval-envelope.json", trust.repository, trust.workflow, trust.workflowSha],
    ["approval-attestation.json", trust.repository, trust.workflow, trust.workflowSha],
    ["action-index.json", trust.repository, trust.workflow, trust.workflowSha],
    ["action-index-attestation.json", trust.repository, trust.workflow, trust.workflowSha],
    [
      "target-descriptor.json",
      trust.targetDescriptor.repository,
      ".github/workflows/deployment-target-descriptor-signer.yml",
      trust.targetDescriptor.signingWorkflowSourceSha,
    ],
    [
      "target-descriptor-attestation.json",
      trust.targetDescriptor.repository,
      ".github/workflows/deployment-target-descriptor-signer.yml",
      trust.targetDescriptor.signingWorkflowSourceSha,
    ],
    [
      "release-manifest.json",
      trust.repository,
      ".github/workflows/trusted-release-artifact.yml",
      trust.workflowSha,
    ],
    [
      "rollback-release-manifest.json",
      trust.repository,
      ".github/workflows/trusted-release-artifact.yml",
      trust.workflowSha,
    ],
    [
      "operator-bundle-index.json",
      trust.repository,
      ".github/workflows/trusted-release-artifact.yml",
      trust.workflowSha,
    ],
    [
      "operator-bundle.tar",
      trust.repository,
      ".github/workflows/trusted-release-artifact.yml",
      trust.workflowSha,
    ],
  ];
  for (const [name, repository, workflow, signerDigest] of specifications) {
    if (typeof paths[name] !== "string" || paths[name].length === 0) {
      throw new Error(`staged ${name} path is required for provenance verification`);
    }
    verify(paths[name], repository, workflow, signerDigest);
  }
  return true;
}

async function runCli() {
  const required = [
    "envelope",
    "release-manifest",
    "rollback-release-manifest",
    "target-descriptor",
    "operator-bundle-index",
    "operator-bundle",
    "approval-attestation",
    "target-descriptor-attestation",
    "action-index",
    "action-index-attestation",
    "action-dir",
  ];
  const values = Object.fromEntries(required.map((name) => [name, argValue(name)]));
  if (required.some((name) => !values[name])) {
    throw new Error("all verified staging approval artifact paths are required");
  }
  const trust = validatePinnedTrust(await loadInstalledStagingTrust());
  const envelopeArtifact = await readCanonicalCliArtifact(values.envelope, "approval envelope");
  const envelope = envelopeArtifact.value;
  assertObject(envelope.release, "approval release");
  assertPattern(envelope.release.candidateSha, COMMIT_SHA_PATTERN, "candidate SHA");
  const releaseManifestArtifact = await readCanonicalCliArtifact(
    values["release-manifest"],
    "release manifest",
  );
  const rollbackReleaseManifestArtifact = await readCanonicalCliArtifact(
    values["rollback-release-manifest"],
    "rollback release manifest",
  );
  const targetDescriptorArtifact = await readCanonicalCliArtifact(
    values["target-descriptor"],
    "target descriptor",
  );
  const operatorBundleIndexArtifact = await readCanonicalCliArtifact(
    values["operator-bundle-index"],
    "operator bundle index",
  );
  const operatorBundleBytes = await readEvidenceBytes(values["operator-bundle"], {
    maxFileBytes: 64 * 1024 * 1024,
  });
  const approvalAttestationArtifact = await readCanonicalCliArtifact(
    values["approval-attestation"],
    "approval attestation claims",
  );
  const targetDescriptorAttestationArtifact = await readCanonicalCliArtifact(
    values["target-descriptor-attestation"],
    "target descriptor attestation claims",
  );
  const actionIndexArtifact = await readCanonicalCliArtifact(
    values["action-index"],
    "action index",
  );
  const actionIndexAttestationArtifact = await readCanonicalCliArtifact(
    values["action-index-attestation"],
    "action index attestation claims",
  );
  const actionBundleNames = actionBundleNamesFromIndex(actionIndexArtifact.value);
  const actionBundle = await readEvidenceBundle(values["action-dir"], {
    allowedNames: actionBundleNames,
    maxTotalBytes: 2 * 1024 * 1024,
  });

  const fixedEntries = [
    { name: "approval-envelope.json", ...envelopeArtifact },
    { name: "release-manifest.json", ...releaseManifestArtifact },
    { name: "rollback-release-manifest.json", ...rollbackReleaseManifestArtifact },
    { name: "target-descriptor.json", ...targetDescriptorArtifact },
    { name: "operator-bundle-index.json", ...operatorBundleIndexArtifact },
    { name: "operator-bundle.tar", bytes: operatorBundleBytes },
    { name: "approval-attestation.json", ...approvalAttestationArtifact },
    {
      name: "target-descriptor-attestation.json",
      ...targetDescriptorAttestationArtifact,
    },
    { name: "action-index.json", ...actionIndexArtifact },
    { name: "action-index-attestation.json", ...actionIndexAttestationArtifact },
    ...actionBundleNames.map((name) => ({
      name,
      bytes: Buffer.from(canonicalJson(actionBundle[name])),
    })),
  ];
  const stage = await stageVerifiedCliArtifacts(fixedEntries);
  try {
    verifyOperatorBundleArchive({
      archivePath: stage.paths["operator-bundle.tar"],
      indexPath: stage.paths["operator-bundle-index.json"],
    });
    verifyStagedStagingRolloutArtifactProvenance(stage.paths, trust);
    const verifyStaged = (name, repository, workflow, signerDigest) =>
      verifyPublishedArtifact(stage.paths[name], repository, workflow, signerDigest);
    for (const name of actionBundleNames) {
      verifyStaged(name, trust.repository, trust.workflow, trust.workflowSha);
    }

    const actionArtifacts = {};
    const actionAttestations = {};
    for (const entry of actionIndexArtifact.value.actions) {
      actionArtifacts[entry.filename] = actionBundle[entry.filename];
      actionAttestations[entry.filename] = actionBundle[actionAttestationFilename(entry.filename)];
    }
    const artifacts = {
      releaseManifest: releaseManifestArtifact.value,
      rollbackReleaseManifest: rollbackReleaseManifestArtifact.value,
      targetDescriptor: targetDescriptorArtifact.value,
      operatorBundleIndex: operatorBundleIndexArtifact.value,
      operatorBundle: operatorBundleBytes,
      approvalAttestation: approvalAttestationArtifact.value,
      targetDescriptorAttestation: targetDescriptorAttestationArtifact.value,
      actionIndex: actionIndexArtifact.value,
      actionIndexAttestation: actionIndexAttestationArtifact.value,
      actionArtifacts,
      actionAttestations,
    };
    const rollout = await openVerifiedStagingRollout({
      envelope,
      artifacts,
      ledgerOptions: { persistReleaseBinding: true },
    });
    try {
      console.log(
        JSON.stringify({
          ok: true,
          approvalId: envelope.approvalId,
          stagingRunId: envelope.stagingRunId,
          envelopeSha256: sha256Canonical(envelope),
          actionJournalHeadSha256: await rollout.head(),
        }),
      );
    } finally {
      await rollout.close();
    }
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  runCli().catch(() => {
    console.log(JSON.stringify({ ok: false, reason: "staging-rollout-approval-invalid" }));
    process.exitCode = 1;
  });
}
