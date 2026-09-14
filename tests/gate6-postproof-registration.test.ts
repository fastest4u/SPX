import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { verifyGate6PostProofBundle } from "../scripts/lib/gate6-postproof-actions.mjs";
import {
  executeGate6PostProofRegistration,
  parseGate6RuntimeControlArgs,
} from "../scripts/gate6-runtime-control.mjs";

const H = (character: string): string => character.repeat(64);
const CANDIDATE = "a".repeat(40);
const POSTPROOF_SIGNER_SHA = "b".repeat(40);

function signedAction(
  scope: string,
  kind: "forward" | "compensation",
  actionId: string,
  pairedActionId: string | null,
  expiresAt: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  workflowName = "gate6-postproof-principal-signer.yml",
) {
  const allowedMutationSha256 = createHash("sha256").update(canonicalGate6Json({
    schemaVersion: 1,
    scope,
    candidateSha: CANDIDATE,
    targetDescriptorSha256: H("9"),
    priorGrantsSha256: H("5"),
    positiveGrantProofSha256: H("6"),
    forbiddenGrantProofSha256: H("7"),
    backupEvidenceSha256: H("8"),
  })).digest("hex");
  const payload = {
    schemaVersion: 1,
    gate6Id: "gate6-prod-001",
    gate6Nonce: "nonce-prod-001",
    envelopeCoreSha256: H("1"),
    candidateSha: CANDIDATE,
    scope,
    kind,
    actionId,
    pairedActionId,
    allowedMutationSha256,
    currentStage: "pre-close-accepted",
    acceptedCheckerSha256: H("4"),
    priorGrantsSha256: H("5"),
    positiveGrantProofSha256: H("6"),
    forbiddenGrantProofSha256: H("7"),
    observationStartedAt: "2026-07-11T00:30:00.000Z",
    observationEndedAt: "2026-07-11T01:00:00.000Z",
    observationWindowMinutes: 30,
    backupEvidenceSha256: H("8"),
    rollbackOwner: "on-call-primary",
    issuedAt: "2026-07-11T01:00:00.000Z",
    expiresAt,
    githubAttestation: {
      repository: "owner/SPX",
      environment: "production",
      jobWorkflowRef: `owner/SPX/.github/workflows/${workflowName}@${POSTPROOF_SIGNER_SHA}`,
      jobWorkflowSha: POSTPROOF_SIGNER_SHA,
      issuer: "https://token.actions.githubusercontent.com",
      audience: "spx-gate6-postproof-principal",
    },
  };
  const canonical = canonicalGate6Json(payload);
  return {
    ...payload,
    signature: {
      algorithm: "ed25519",
      keyId: "gate6-postproof-2026-07",
      signedPayloadSha256: createHash("sha256").update(canonical).digest("hex"),
      signatureBase64: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  };
}

async function main(): Promise<void> {
  assert.equal(parseGate6RuntimeControlArgs([
    "--action=register-postproof",
    "--envelope=/var/lib/spx-gate6/artifacts/gate6-envelope.json",
    "--release=/var/lib/spx-gate6/artifacts/release-manifest.json",
    "--postproof-bundle=/var/lib/spx-gate6/postproof/postproof-actions.json",
  ]).action, "register-postproof");
  const keys = generateKeyPairSync("ed25519");
  const revoke = signedAction(
    "db-principal-revoke-legacy", "forward", "revoke-legacy-001", null,
    "2026-07-11T01:05:00.000Z", keys.privateKey,
  );
  const restore = signedAction(
    "db-principal-restore-legacy", "compensation", "restore-legacy-001", revoke.actionId,
    "2026-07-11T02:30:00.000Z", keys.privateKey,
  );
  const envelope = {
    gate6Id: "gate6-prod-001",
    gate6Nonce: "nonce-prod-001",
    envelopeCoreSha256: H("1"),
    candidateSha: CANDIDATE,
    backupEvidenceSha256: H("8"),
    productionTargetDescriptorSha256: H("9"),
    rtoMinutes: 20,
  };
  const keyring = {
    repository: "owner/SPX",
    signerWorkflowShas: { postproof: POSTPROOF_SIGNER_SHA },
    keyIds: {
      postproof: "gate6-postproof-2026-07",
    },
    keys: {
      "gate6-postproof-2026-07": keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  };
  const verified = verifyGate6PostProofBundle({
    bundle: { schemaVersion: 1, revoke, restore },
    envelope,
    keyring,
    now: new Date("2026-07-11T01:01:00.000Z"),
  });
  assert.equal(verified.ok, true);
  assert.notEqual(CANDIDATE, POSTPROOF_SIGNER_SHA);
  assert.equal(verified.revoke.requiredStage, "pre-close-accepted");
  assert.equal(verified.restore.requiredStage, "revoked");

  const registrations: unknown[] = [];
  const result = await executeGate6PostProofRegistration({
    artifacts: { envelope, keyring },
    bundle: { schemaVersion: 1, revoke, restore },
    ledger: {
      async registerPostProofActions(input: unknown) {
        registrations.push(input);
        return { status: "registered" };
      },
    },
    now: new Date("2026-07-11T01:01:00.000Z"),
  });
  assert.equal(result.status, "registered");
  assert.equal(registrations.length, 1);

  assert.equal(verifyGate6PostProofBundle({
    bundle: { schemaVersion: 1, revoke: { ...revoke, priorGrantsSha256: H("9") }, restore },
    envelope,
    keyring,
    now: new Date("2026-07-11T01:01:00.000Z"),
  }).ok, false);
  const dispatcherRevoke = signedAction(
    "db-principal-revoke-legacy", "forward", "dispatcher-revoke-001", null,
    "2026-07-11T01:05:00.000Z", keys.privateKey, "gate6-postproof-principal.yml",
  );
  const dispatcherRestore = signedAction(
    "db-principal-restore-legacy", "compensation", "dispatcher-restore-001",
    dispatcherRevoke.actionId, "2026-07-11T02:30:00.000Z", keys.privateKey,
    "gate6-postproof-principal.yml",
  );
  assert.equal(verifyGate6PostProofBundle({
    bundle: { schemaVersion: 1, revoke: dispatcherRevoke, restore: dispatcherRestore },
    envelope,
    keyring,
    now: new Date("2026-07-11T01:01:00.000Z"),
  }).ok, false, "the dispatcher workflow must never be accepted as the OIDC signer identity");
  assert.equal(verifyGate6PostProofBundle({
    bundle: { schemaVersion: 1, revoke, restore },
    envelope,
    keyring: {
      ...keyring,
      keyIds: { postproof: "gate6-envelope-2026-07" },
      keys: {
        ...keyring.keys,
        "gate6-envelope-2026-07": keyring.keys["gate6-postproof-2026-07"],
      },
    },
    now: new Date("2026-07-11T01:01:00.000Z"),
  }).ok, false, "post-proof actions must use the pinned post-proof signer key id");
  assert.equal(verifyGate6PostProofBundle({
    bundle: { schemaVersion: 1, revoke, restore },
    envelope,
    keyring: {
      ...keyring,
      signerWorkflowShas: { postproof: "c".repeat(40) },
    },
    now: new Date("2026-07-11T01:01:00.000Z"),
  }).ok, false, "post-proof actions must bind the reusable signer snapshot, not the candidate");
  console.log("Gate 6 post-proof registration tests passed");
}

void main();
