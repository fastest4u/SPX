import { createHash, verify as verifySignature } from "node:crypto";

import { canonicalGate6Json } from "../../src/services/gate6-approval-runtime.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_KEYS = Object.freeze([
  "schemaVersion", "gate6Id", "gate6Nonce", "envelopeCoreSha256", "candidateSha",
  "scope", "kind", "actionId", "pairedActionId", "allowedMutationSha256",
  "currentStage", "acceptedCheckerSha256", "priorGrantsSha256",
  "positiveGrantProofSha256", "forbiddenGrantProofSha256",
  "observationStartedAt", "observationEndedAt", "observationWindowMinutes",
  "backupEvidenceSha256", "rollbackOwner", "issuedAt", "expiresAt",
  "githubAttestation", "signature",
]);
const SHARED_KEYS = Object.freeze([
  "gate6Id", "gate6Nonce", "envelopeCoreSha256", "candidateSha", "currentStage",
  "acceptedCheckerSha256", "priorGrantsSha256", "positiveGrantProofSha256",
  "forbiddenGrantProofSha256", "observationStartedAt", "observationEndedAt",
  "observationWindowMinutes", "backupEvidenceSha256", "rollbackOwner", "issuedAt",
]);

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Gate 6 post-proof time is invalid");
  }
  return parsed;
}

function verifyActionSignature(action, keyring) {
  if (!exactKeys(action.signature, ["algorithm", "keyId", "signedPayloadSha256", "signatureBase64"])) {
    throw new Error("Gate 6 post-proof signature fields are invalid");
  }
  const { signature, ...payload } = action;
  const canonical = canonicalGate6Json(payload);
  const payloadSha256 = createHash("sha256").update(canonical).digest("hex");
  const publicKey = keyring.keys?.[signature.keyId];
  const signatureBytes = Buffer.from(signature.signatureBase64 ?? "", "base64");
  if (
    signature.algorithm !== "ed25519"
    || signature.keyId !== keyring.keyIds?.postproof
    || signature.signedPayloadSha256 !== payloadSha256
    || typeof publicKey !== "string"
    || signatureBytes.byteLength !== 64
    || !verifySignature(null, Buffer.from(canonical), publicKey, signatureBytes)
  ) throw new Error("Gate 6 post-proof signature is invalid");
  return createHash("sha256").update(canonicalGate6Json(action)).digest("hex");
}

function validateAction(action, expected, envelope, keyring, nowMs) {
  const mutationSha256 = createHash("sha256").update(canonicalGate6Json({
    schemaVersion: 1,
    scope: action?.scope,
    candidateSha: action?.candidateSha,
    targetDescriptorSha256: envelope?.productionTargetDescriptorSha256,
    priorGrantsSha256: action?.priorGrantsSha256,
    positiveGrantProofSha256: action?.positiveGrantProofSha256,
    forbiddenGrantProofSha256: action?.forbiddenGrantProofSha256,
    backupEvidenceSha256: action?.backupEvidenceSha256,
  })).digest("hex");
  if (
    !exactKeys(action, ACTION_KEYS)
    || action.schemaVersion !== 1
    || action.gate6Id !== envelope.gate6Id
    || action.gate6Nonce !== envelope.gate6Nonce
    || action.envelopeCoreSha256 !== envelope.envelopeCoreSha256
    || action.candidateSha !== envelope.candidateSha
    || !COMMIT_SHA.test(action.candidateSha ?? "")
    || action.scope !== expected.scope
    || action.kind !== expected.kind
    || action.pairedActionId !== expected.pairedActionId
    || !ID.test(action.actionId ?? "")
    || action.allowedMutationSha256 !== mutationSha256
    || action.currentStage !== "pre-close-accepted"
    || ![
      action.envelopeCoreSha256,
      action.acceptedCheckerSha256,
      action.priorGrantsSha256,
      action.positiveGrantProofSha256,
      action.forbiddenGrantProofSha256,
      action.backupEvidenceSha256,
    ].every((value) => SHA256.test(value ?? ""))
    || action.backupEvidenceSha256 !== envelope.backupEvidenceSha256
    || !ID.test(action.rollbackOwner ?? "")
    || !Number.isSafeInteger(action.observationWindowMinutes)
    || action.observationWindowMinutes < 1
    || action.observationWindowMinutes > 24 * 60
  ) throw new Error("Gate 6 post-proof action binding is invalid");
  const observationStart = exactTime(action.observationStartedAt);
  const observationEnd = exactTime(action.observationEndedAt);
  const issuedAt = exactTime(action.issuedAt);
  const expiresAt = exactTime(action.expiresAt);
  if (
    observationEnd - observationStart < action.observationWindowMinutes * 60_000
    || observationEnd > issuedAt
    || issuedAt > nowMs
    || nowMs >= expiresAt
  ) throw new Error("Gate 6 post-proof observation or validity window is invalid");
  if (!exactKeys(action.githubAttestation, [
    "repository", "environment", "jobWorkflowRef", "jobWorkflowSha", "issuer", "audience",
  ])) throw new Error("Gate 6 post-proof attestation fields are invalid");
  if (
    action.githubAttestation.repository !== keyring.repository
    || action.githubAttestation.environment !== "production"
    || action.githubAttestation.jobWorkflowRef
      !== `${keyring.repository}/.github/workflows/gate6-postproof-principal-signer.yml@${keyring.signerWorkflowShas.postproof}`
    || action.githubAttestation.jobWorkflowSha !== keyring.signerWorkflowShas.postproof
    || action.githubAttestation.issuer !== "https://token.actions.githubusercontent.com"
    || action.githubAttestation.audience !== "spx-gate6-postproof-principal"
  ) throw new Error("Gate 6 post-proof attestation is invalid");
  return { approvalSha256: verifyActionSignature(action, keyring), issuedAt, expiresAt };
}

export function verifyGate6PostProofBundle(input) {
  try {
    const { bundle, envelope, keyring } = input;
    if (!exactKeys(bundle, ["schemaVersion", "revoke", "restore"]) || bundle.schemaVersion !== 1) {
      throw new Error("Gate 6 post-proof bundle is invalid");
    }
    if (
      !ID.test(envelope?.gate6Id ?? "")
      || !ID.test(envelope?.gate6Nonce ?? "")
      || !SHA256.test(envelope?.envelopeCoreSha256 ?? "")
      || !COMMIT_SHA.test(envelope?.candidateSha ?? "")
      || !SHA256.test(envelope?.backupEvidenceSha256 ?? "")
      || !SHA256.test(envelope?.productionTargetDescriptorSha256 ?? "")
      || !Number.isSafeInteger(envelope?.rtoMinutes)
      || envelope.rtoMinutes < 1
      || !ID.test(keyring?.repository ?? "") && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(keyring?.repository ?? "")
      || keyring?.keys === null
      || typeof keyring?.keys !== "object"
      || Array.isArray(keyring?.keys)
      || !ID.test(keyring?.keyIds?.postproof ?? "")
      || !COMMIT_SHA.test(keyring?.signerWorkflowShas?.postproof ?? "")
      || typeof keyring.keys[keyring.keyIds.postproof] !== "string"
    ) throw new Error("Gate 6 post-proof verification context is invalid");
    const nowMs = (input.now ?? new Date()).getTime();
    const revokeResult = validateAction(bundle.revoke, {
      scope: "db-principal-revoke-legacy",
      kind: "forward",
      pairedActionId: null,
    }, envelope, keyring, nowMs);
    const restoreResult = validateAction(bundle.restore, {
      scope: "db-principal-restore-legacy",
      kind: "compensation",
      pairedActionId: bundle.revoke.actionId,
    }, envelope, keyring, nowMs);
    for (const key of SHARED_KEYS) {
      if (bundle.revoke[key] !== bundle.restore[key]) {
        throw new Error("Gate 6 post-proof action pair binding differs");
      }
    }
    if (
      bundle.revoke.actionId === bundle.restore.actionId
      || revokeResult.expiresAt - revokeResult.issuedAt > 15 * 60_000
      || restoreResult.expiresAt - restoreResult.issuedAt > 6 * 60 * 60_000
      || restoreResult.expiresAt - nowMs < (envelope.rtoMinutes + 30) * 60_000
      || restoreResult.expiresAt <= revokeResult.expiresAt
    ) throw new Error("Gate 6 post-proof action TTLs are invalid");
    const durable = (action, approvalSha256, requiredStage) => Object.freeze({
      scope: action.scope,
      actionId: action.actionId,
      approvalSha256,
      allowedMutationSha256: action.allowedMutationSha256,
      kind: action.kind,
      pairedActionId: action.pairedActionId,
      predecessorActionIds: [],
      requiredStage,
      requiredCheckerSha256: action.acceptedCheckerSha256,
      expiresAt: action.expiresAt,
    });
    return Object.freeze({
      ok: true,
      acceptedCheckerSha256: bundle.revoke.acceptedCheckerSha256,
      priorGrantsSha256: bundle.revoke.priorGrantsSha256,
      positiveGrantProofSha256: bundle.revoke.positiveGrantProofSha256,
      forbiddenGrantProofSha256: bundle.revoke.forbiddenGrantProofSha256,
      backupEvidenceSha256: bundle.revoke.backupEvidenceSha256,
      rollbackOwner: bundle.revoke.rollbackOwner,
      revoke: durable(bundle.revoke, revokeResult.approvalSha256, "pre-close-accepted"),
      restore: durable(bundle.restore, restoreResult.approvalSha256, "revoked"),
    });
  } catch {
    return Object.freeze({ ok: false, code: "gate6-postproof-bundle-refused" });
  }
}
