import { createHash, verify } from "node:crypto";
import { Buffer } from "node:buffer";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ENVELOPE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_RECOVERY_AFTER_ENVELOPE_MS = 6 * 60 * 60 * 1000;

export const MANDATORY_FORWARD_SCOPES = Object.freeze([
  "gate6-admit",
  "stage-accept-db-transition",
  "db-principal-prepare-realtime",
  "db-principal-prepare-line",
  "db-principal-prepare-notification",
  "db-principal-prepare-worker-ifn",
  "db-principal-prepare-worker-ptwl",
  "db-principal-prepare-web",
  "db-principal-prepare-phase3-control",
  "db-principal-verify-migrator",
  "db-principal-switch-realtime",
  "db-principal-switch-line",
  "db-principal-switch-notification",
  "db-principal-switch-worker-ifn",
  "db-principal-switch-worker-ptwl",
  "db-principal-switch-web",
  "stage-accept-task9",
  "task9-line-baseline",
  "task9-line-boundary",
  "task9-ocr-boundary",
  "stage-accept-worker",
  "worker-ifn-forward",
  "worker-ifn-reverse",
  "worker-ptwl-forward",
  "worker-ptwl-reverse",
  "stage-accept-phase3",
  "phase3-consumer-start-disabled",
  "phase3-legacy-lease-release",
  "phase3-poller-start",
  "phase3-publication-enable",
  "phase3-execution-enable",
  "phase3-publication-fence",
  "phase3-fence-ack-wait",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
  "stage-accept-phase4",
  "phase4-verify-expand-install",
  "phase4-realtime-start",
  "phase4-route-producer",
  "phase4-route-read",
  "phase4-route-stream",
  "phase4-route-local-rollback",
  "phase4-route-approved-final",
  "gate6-final-baseline",
  "stage-accept-pre-close",
  "gate6-seal-close",
  "gate6-release",
]);

export const COMPENSATION_PAIRINGS = Object.freeze({
  "db-principal-restore-realtime": "db-principal-switch-realtime",
  "db-principal-restore-line": "db-principal-switch-line",
  "db-principal-restore-notification": "db-principal-switch-notification",
  "db-principal-restore-worker-ifn": "db-principal-switch-worker-ifn",
  "db-principal-restore-worker-ptwl": "db-principal-switch-worker-ptwl",
  "db-principal-restore-web": "db-principal-switch-web",
  "db-principal-restore-phase3-control": "db-principal-prepare-phase3-control",
  "worker-ifn-restore-prior": "worker-ifn-forward",
  "worker-ptwl-restore-prior": "worker-ptwl-forward",
  "phase3-restore-inline-owner": "phase3-publication-enable",
  "phase4-restore-local-routing": "phase4-route-approved-final",
});

export const COMPENSATION_SCOPES = Object.freeze(Object.keys(COMPENSATION_PAIRINGS));
export const EMERGENCY_SCOPES = Object.freeze(["gate6-abort"]);

const CORE_KEYS = Object.freeze([
  "schemaVersion",
  "gate6Id",
  "releaseEnvironment",
  "runtimeEnvironment",
  "drillMode",
  "candidateSha",
  "candidateImageDigest",
  "rollbackSha",
  "rollbackImageDigest",
  "releaseManifestSha256",
  "productionTargetDescriptorSha256",
  "stagingTargetDescriptorSha256",
  "operatorBundleSha256",
  "installedOperatorBundleSha256",
  "topology",
  "serviceSetSha256",
  "productionDatabaseFingerprint",
  "productionProviderTargetFingerprints",
  "composeProject",
  "envFile",
  "composeFiles",
  "stagingBundles",
  "backupEvidenceSha256",
  "rpoMinutes",
  "rtoMinutes",
  "canaryTeamId",
  "canaryEpoch",
  "safeLineTargetSha256",
  "ocrFixtureSha256",
  "gate6Nonce",
  "monitorThresholdsSha256",
  "protectedInstallEvidenceSha256",
  "installedMigrationSetSha256",
  "installedSchemaVersion",
  "pendingReleasedMigrationCount",
  "issuedAt",
  "expiresAt",
  "approver",
  "githubAttestation",
]);

const OUTER_KEYS = Object.freeze([
  ...CORE_KEYS,
  "envelopeCoreSha256",
  "actionIndexSha256",
  "actionApprovals",
  "signature",
]);

const ACTION_KEYS = Object.freeze([
  "gate6Id",
  "scope",
  "kind",
  "actionId",
  "envelopeCoreSha256",
  "candidateSha",
  "runtimeEnvironment",
  "drillMode",
  "allowedMutationSha256",
  "rollbackScope",
  "pairedActionId",
  "issuedAt",
  "expiresAt",
  "signature",
]);

const PERMIT_INTENT_KEYS = Object.freeze([
  "permitId",
  "service",
  "kind",
  "teamId",
  "targetSha256",
  "fixtureSha256",
  "releaseOrFixtureSha256",
  "issuanceNonce",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeCanonical(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON requires finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("canonical JSON cannot contain cycles");
    seen.add(value);
    const normalized = value.map((item) => normalizeCanonical(item, seen));
    seen.delete(value);
    return normalized;
  }
  if (!isPlainObject(value)) throw new Error("canonical JSON accepts only plain JSON values");
  if (seen.has(value)) throw new Error("canonical JSON cannot contain cycles");
  seen.add(value);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new Error("canonical JSON cannot contain undefined");
    normalized[key] = normalizeCanonical(value[key], seen);
  }
  seen.delete(value);
  return normalized;
}

export function canonicalGate6Json(value) {
  return JSON.stringify(normalizeCanonical(value, new Set()));
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalGate6Json(value)).digest("hex");
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function strictKeys(value, required, optional, label) {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  for (const key of actual) if (!allowed.has(key)) throw new Error(`${label} contains an unknown field`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing a required field`);
}

function requireString(value, label, pattern = undefined) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid`);
  }
}

function requireHash(value, label) {
  requireString(value, label, SHA256);
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid`);
}

function timestamp(value, label) {
  requireString(value, label);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} is invalid`);
  return parsed;
}

function withoutSignature(value) {
  const { signature: _signature, ...payload } = value;
  return payload;
}

function validateSignature(signature, payload, publicKeys, label, expectedKeyId = undefined) {
  const value = requirePlainObject(signature, `${label} signature`);
  strictKeys(value, ["algorithm", "keyId", "signedPayloadSha256", "signatureBase64"], [], `${label} signature`);
  if (value.algorithm !== "ed25519") throw new Error(`${label} signature algorithm is invalid`);
  requireString(value.keyId, `${label} signature key ID`, SAFE_ID);
  if (expectedKeyId !== undefined && value.keyId !== expectedKeyId) {
    throw new Error(`${label} signature key ID is not authorized for this signer role`);
  }
  requireHash(value.signedPayloadSha256, `${label} signed payload hash`);
  requireString(value.signatureBase64, `${label} signature bytes`);
  const publicKey = publicKeys?.[value.keyId];
  if (!publicKey) throw new Error(`${label} signature key is not pinned`);
  const canonical = canonicalGate6Json(payload);
  if (sha256Canonical(payload) !== value.signedPayloadSha256) {
    throw new Error(`${label} signed payload hash mismatch`);
  }
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(value.signatureBase64, "base64");
  } catch {
    throw new Error(`${label} signature bytes are invalid`);
  }
  if (signatureBytes.byteLength !== 64 || !verify(null, Buffer.from(canonical), publicKey, signatureBytes)) {
    throw new Error(`${label} signature verification failed`);
  }
}

export function createGate6EnvelopeCore(input) {
  const core = {};
  for (const key of CORE_KEYS) {
    if (!Object.hasOwn(input, key)) throw new Error("Gate 6 envelope core is incomplete");
    core[key] = input[key];
  }
  return core;
}

export function createGate6ActionIndex(actions) {
  if (!Array.isArray(actions)) throw new Error("Gate 6 actions must be an array");
  return actions.map((action) => ({
    scope: action.scope,
    kind: action.kind,
    actionId: action.actionId,
    actionSha256: sha256Canonical(action),
  }));
}

function validateAttestation(core, expected) {
  const attestation = requirePlainObject(core.githubAttestation, "GitHub attestation");
  strictKeys(attestation, [
    "repository",
    "environment",
    "jobWorkflowRef",
    "jobWorkflowSha",
    "workflowFileSha256",
    "workflowRunId",
    "issuer",
    "audience",
    "artifactSha256",
  ], [], "GitHub attestation");
  for (const field of ["repository", "environment", "jobWorkflowRef", "workflowRunId", "issuer", "audience"]) {
    requireString(attestation[field], `GitHub attestation ${field}`);
  }
  requireString(attestation.jobWorkflowSha, "GitHub attestation job workflow SHA", COMMIT_SHA);
  requireHash(attestation.workflowFileSha256, "GitHub workflow file hash");
  requireHash(attestation.artifactSha256, "GitHub artifact hash");
  if (expected) {
    for (const field of ["repository", "environment", "issuer", "audience", "workflowFileSha256"]) {
      if (expected[field] !== undefined && attestation[field] !== expected[field]) {
        throw new Error(`GitHub attestation ${field} mismatch`);
      }
    }
    if (expected.signerWorkflowPath !== undefined && expected.signerWorkflowSha === undefined) {
      throw new Error("GitHub signer workflow SHA is required with its path");
    }
    if (expected.signerWorkflowSha !== undefined) {
      requireString(expected.signerWorkflowSha, "expected GitHub signer workflow SHA", COMMIT_SHA);
      if (attestation.jobWorkflowSha !== expected.signerWorkflowSha) {
        throw new Error("GitHub signer workflow SHA mismatch");
      }
    }
    if (
      expected.signerWorkflowPath !== undefined
      && attestation.jobWorkflowRef !== `${expected.signerWorkflowPath}@${expected.signerWorkflowSha}`
    ) throw new Error("GitHub signer workflow identity mismatch");
  }
}

function validateCore(core, options) {
  strictKeys(core, CORE_KEYS, [], "Gate 6 envelope core");
  if (core.schemaVersion !== 1) throw new Error("Gate 6 schema version is unsupported");
  requireString(core.gate6Id, "Gate 6 ID", SAFE_ID);
  requireString(core.gate6Nonce, "Gate 6 nonce", SAFE_ID);
  if (
    core.releaseEnvironment !== "production"
    || core.runtimeEnvironment !== "production"
    || core.drillMode !== "supervised-production"
  ) throw new Error("Gate 6 production discriminators are invalid");
  if (
    core.composeProject !== "spx-production"
    || core.envFile !== "/root/SPX/.env"
    || canonicalGate6Json(core.composeFiles) !== canonicalGate6Json(["/root/SPX/docker-compose.yml"])
  ) throw new Error("Gate 6 production Compose boundary is invalid");
  requireString(core.candidateSha, "candidate SHA", COMMIT_SHA);
  requireString(core.rollbackSha, "rollback SHA", COMMIT_SHA);
  requireString(core.candidateImageDigest, "candidate image digest", IMAGE_DIGEST);
  requireString(core.rollbackImageDigest, "rollback image digest", IMAGE_DIGEST);
  for (const field of [
    "releaseManifestSha256",
    "productionTargetDescriptorSha256",
    "stagingTargetDescriptorSha256",
    "operatorBundleSha256",
    "installedOperatorBundleSha256",
    "serviceSetSha256",
    "backupEvidenceSha256",
    "safeLineTargetSha256",
    "ocrFixtureSha256",
    "monitorThresholdsSha256",
    "protectedInstallEvidenceSha256",
    "installedMigrationSetSha256",
  ]) requireHash(core[field], `Gate 6 ${field}`);
  if (core.operatorBundleSha256 !== core.installedOperatorBundleSha256) {
    throw new Error("installed operator bundle differs from the release bundle");
  }
  if (core.topology !== "split") throw new Error("Gate 6 topology is invalid");
  requireString(core.productionDatabaseFingerprint, "production database fingerprint", IMAGE_DIGEST);
  if (
    !Array.isArray(core.productionProviderTargetFingerprints)
    || core.productionProviderTargetFingerprints.length === 0
  ) throw new Error("production provider target fingerprints are required");
  for (const fingerprint of core.productionProviderTargetFingerprints) {
    requireString(fingerprint, "production provider target fingerprint", IMAGE_DIGEST);
  }
  const stagingBundles = requirePlainObject(core.stagingBundles, "staging bundles");
  strictKeys(stagingBundles, ["task9Sha256", "workerSha256", "phase3Sha256", "phase4Sha256", "nMinusOneSha256"], [], "staging bundles");
  for (const [name, hash] of Object.entries(stagingBundles)) requireHash(hash, `staging bundle ${name}`);
  requireInteger(core.rpoMinutes, "RPO minutes", 1);
  requireInteger(core.rtoMinutes, "RTO minutes", 1);
  requireInteger(core.canaryTeamId, "canary team", 1);
  requireString(core.canaryEpoch, "canary epoch", SAFE_ID);
  requireInteger(core.installedSchemaVersion, "installed schema version", 1);
  requireInteger(options.installedSchemaMaximum, "released schema maximum", 1);
  if (core.installedSchemaVersion !== options.installedSchemaMaximum) {
    throw new Error("installed schema is not the exact released maximum");
  }
  if (core.pendingReleasedMigrationCount !== 0) throw new Error("released migrations remain pending");
  requireString(core.approver, "Gate 6 approver", SAFE_ID);
  const issuedAt = timestamp(core.issuedAt, "Gate 6 issuance time");
  const expiresAt = timestamp(core.expiresAt, "Gate 6 expiry");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_ENVELOPE_TTL_MS) {
    throw new Error("Gate 6 envelope TTL is invalid");
  }
  const now = (options.now ?? new Date()).getTime();
  if (now < issuedAt || now >= expiresAt) throw new Error("Gate 6 envelope is not currently valid");
  validateAttestation(core, options.expectedAttestation);
  for (const [field, expected] of Object.entries(options.expectedBindings ?? {})) {
    if (core[field] !== expected) throw new Error(`Gate 6 ${field} binding mismatch`);
  }
}

function validatePermitIntent(action, core) {
  const intent = requirePlainObject(action.permitIntent, "Task 9 permit intent");
  strictKeys(intent, PERMIT_INTENT_KEYS, [], "Task 9 permit intent");
  requireString(intent.permitId, "Task 9 permit ID", SAFE_ID);
  requireString(intent.kind, "Task 9 permit kind", SAFE_ID);
  requireString(intent.issuanceNonce, "Task 9 issuance nonce", SAFE_ID);
  requireInteger(intent.teamId, "Task 9 team", 1);
  if (intent.teamId !== core.canaryTeamId) throw new Error("Task 9 team differs from the canary team");
  requireHash(intent.releaseOrFixtureSha256, "Task 9 release or fixture hash");
  if (action.scope === "task9-line-boundary") {
    if (intent.service !== "line-service" || intent.targetSha256 !== core.safeLineTargetSha256 || intent.fixtureSha256 !== null) {
      throw new Error("LINE permit intent is not isolated to the safe target");
    }
  } else if (
    intent.service !== "ocr-service"
    || intent.targetSha256 !== null
    || intent.fixtureSha256 !== core.ocrFixtureSha256
  ) throw new Error("OCR permit intent is not isolated to the fixture");
}

function validateActions(envelope, core, options) {
  if (!Array.isArray(envelope.actionApprovals)) throw new Error("Gate 6 action approvals are required");
  const expectedScopes = [...MANDATORY_FORWARD_SCOPES, ...COMPENSATION_SCOPES, ...EMERGENCY_SCOPES];
  if (envelope.actionApprovals.length !== expectedScopes.length) throw new Error("Gate 6 action scope set is incomplete");
  const actionByScope = new Map();
  const actionIds = new Set();
  for (let index = 0; index < envelope.actionApprovals.length; index += 1) {
    const action = requirePlainObject(envelope.actionApprovals[index], "Gate 6 action");
    const isTask9 = action.scope === "task9-line-boundary" || action.scope === "task9-ocr-boundary";
    strictKeys(action, ACTION_KEYS, isTask9 ? ["permitIntent"] : [], "Gate 6 action");
    if (action.scope !== expectedScopes[index]) throw new Error("Gate 6 action index order or scope is invalid");
    const expectedKind = index < MANDATORY_FORWARD_SCOPES.length
      ? "forward"
      : index < MANDATORY_FORWARD_SCOPES.length + COMPENSATION_SCOPES.length
        ? "compensation"
        : "emergency";
    if (action.kind !== expectedKind) throw new Error("Gate 6 action kind is invalid");
    requireString(action.actionId, "Gate 6 action ID", SAFE_ID);
    if (actionIds.has(action.actionId)) throw new Error("Gate 6 action ID is duplicated");
    actionIds.add(action.actionId);
    actionByScope.set(action.scope, action);
    if (
      action.gate6Id !== core.gate6Id
      || action.envelopeCoreSha256 !== envelope.envelopeCoreSha256
      || action.candidateSha !== core.candidateSha
      || action.runtimeEnvironment !== "production"
      || action.drillMode !== "supervised-production"
    ) throw new Error("Gate 6 action identity binding mismatch");
    requireHash(action.allowedMutationSha256, "Gate 6 allowed mutation hash");
    if (action.rollbackScope !== `${action.scope}:rollback` || action.rollbackScope.includes("*")) {
      throw new Error("Gate 6 rollback scope is invalid");
    }
    const issuedAt = timestamp(action.issuedAt, "Gate 6 action issuance time");
    const expiresAt = timestamp(action.expiresAt, "Gate 6 action expiry");
    if (issuedAt !== Date.parse(core.issuedAt) || expiresAt <= issuedAt) throw new Error("Gate 6 action TTL is invalid");
    if (expectedKind === "forward" && expiresAt > Date.parse(core.expiresAt)) {
      throw new Error("forward action outlives the Gate 6 envelope");
    }
    if (expectedKind !== "forward" && (
      expiresAt <= Date.parse(core.expiresAt)
      || expiresAt > Date.parse(core.expiresAt) + MAX_RECOVERY_AFTER_ENVELOPE_MS
    )) throw new Error("recovery action TTL is invalid");
    if (isTask9) validatePermitIntent(action, core);
    if (!isTask9 && Object.hasOwn(action, "permitIntent")) throw new Error("non-Task 9 action contains a permit intent");
    validateSignature(
      action.signature,
      withoutSignature(action),
      options.publicKeys,
      `Gate 6 action ${action.scope}`,
      options.expectedKeyId,
    );
  }
  for (const [compensationScope, forwardScope] of Object.entries(COMPENSATION_PAIRINGS)) {
    const compensation = actionByScope.get(compensationScope);
    const forward = actionByScope.get(forwardScope);
    if (!compensation || !forward || compensation.pairedActionId !== forward.actionId) {
      throw new Error("Gate 6 compensation pairing is invalid");
    }
    const minimumRecoveryMs = (core.rtoMinutes + (options.worstCaseRollbackMinutes ?? 30)) * 60 * 1000;
    if (Date.parse(compensation.expiresAt) - Date.parse(forward.expiresAt) < minimumRecoveryMs) {
      throw new Error("Gate 6 compensation validity is insufficient");
    }
  }
  for (const action of envelope.actionApprovals) {
    if (action.kind !== "compensation" && action.pairedActionId !== null) {
      throw new Error("non-compensation action has a paired action ID");
    }
  }
}

export function validateGate6Envelope(value, options = {}) {
  try {
    const envelope = requirePlainObject(value, "Gate 6 envelope");
    strictKeys(envelope, OUTER_KEYS, [], "Gate 6 envelope");
    const core = createGate6EnvelopeCore(envelope);
    validateCore(core, options);
    requireHash(envelope.envelopeCoreSha256, "Gate 6 envelope core hash");
    const coreHash = sha256Canonical(core);
    if (envelope.envelopeCoreSha256 !== coreHash) throw new Error("Gate 6 envelope core hash mismatch");
    validateActions(envelope, core, options);
    requireHash(envelope.actionIndexSha256, "Gate 6 action index hash");
    const actionIndexHash = sha256Canonical(createGate6ActionIndex(envelope.actionApprovals));
    if (envelope.actionIndexSha256 !== actionIndexHash) throw new Error("Gate 6 action index hash mismatch");
    validateSignature(
      envelope.signature,
      { envelopeCoreSha256: coreHash, actionIndexSha256: actionIndexHash },
      options.publicKeys,
      "Gate 6 outer envelope",
      options.expectedKeyId,
    );
    return { ok: true, envelopeCoreSha256: coreHash, actionIndexSha256: actionIndexHash };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Gate 6 envelope validation failed",
    };
  }
}
