import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  COMPENSATION_PAIRINGS,
  COMPENSATION_SCOPES,
  EMERGENCY_SCOPES,
  MANDATORY_FORWARD_SCOPES,
  canonicalGate6Json,
  createGate6ActionIndex,
  createGate6EnvelopeCore,
  validateGate6Envelope,
} from "../src/services/gate6-approval.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY_ID = "gate6-production-test";
const FIXTURE_KEY_ID = "gate6-production-test-fixture";
const fixturePrivateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from("gate6-production-fixture-seed!!!", "utf8"),
  ]),
  format: "der",
  type: "pkcs8",
});
const fixturePublicKey = createPublicKey(fixturePrivateKey);
const H = (character: string): string => character.repeat(64);
const SIGNER_SHA = "9".repeat(40);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const releasedChecksums = JSON.parse(readFileSync(
  new URL("../migrations/released-checksums.json", import.meta.url),
  "utf8",
)) as Record<string, string>;
const RELEASED_SCHEMA_MAXIMUM = Math.max(...Object.keys(releasedChecksums).map((name) => {
  const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name);
  assert.ok(match, `invalid released migration name: ${name}`);
  return Number.parseInt(match[1], 10);
}));

function signature(payload: unknown) {
  const canonical = canonicalGate6Json(payload);
  return {
    algorithm: "ed25519" as const,
    keyId: KEY_ID,
    signedPayloadSha256: sha256(canonical),
    signatureBase64: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
  };
}

function completeUnsignedCore() {
  return {
    schemaVersion: 1,
    gate6Id: "gate6-20260710-01",
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    candidateSha: "a".repeat(40),
    candidateImageDigest: `sha256:${H("b")}`,
    rollbackSha: "c".repeat(40),
    rollbackImageDigest: `sha256:${H("d")}`,
    releaseManifestSha256: H("e"),
    productionTargetDescriptorSha256: H("f"),
    stagingTargetDescriptorSha256: H("0"),
    operatorBundleSha256: H("1"),
    installedOperatorBundleSha256: H("1"),
    topology: "split",
    serviceSetSha256: H("2"),
    productionDatabaseFingerprint: `sha256:${H("f")}`,
    productionProviderTargetFingerprints: [`sha256:${H("1")}`],
    composeProject: "spx-production",
    envFile: "/root/SPX/.env",
    composeFiles: ["/root/SPX/docker-compose.yml"],
    stagingBundles: {
      task9Sha256: H("2"),
      workerSha256: H("3"),
      phase3Sha256: H("4"),
      phase4Sha256: H("5"),
      nMinusOneSha256: H("6"),
    },
    backupEvidenceSha256: H("7"),
    rpoMinutes: 5,
    rtoMinutes: 20,
    canaryTeamId: 2,
    canaryEpoch: "gate6-ifn-20260710",
    safeLineTargetSha256: H("8"),
    ocrFixtureSha256: H("9"),
    gate6Nonce: "nonce-20260710-01",
    monitorThresholdsSha256: H("0"),
    protectedInstallEvidenceSha256: H("a"),
    installedMigrationSetSha256: H("b"),
    installedSchemaVersion: RELEASED_SCHEMA_MAXIMUM,
    pendingReleasedMigrationCount: 0,
    issuedAt: "2026-07-10T16:55:00.000Z",
    expiresAt: "2026-07-10T18:00:00.000Z",
    approver: "protected-environment-reviewer",
    githubAttestation: {
      repository: "owner/SPX",
      environment: "production",
      jobWorkflowRef: `owner/SPX/.github/workflows/gate6-envelope-signer.yml@${SIGNER_SHA}`,
      jobWorkflowSha: SIGNER_SHA,
      workflowFileSha256: H("c"),
      workflowRunId: "123456",
      issuer: "https://token.actions.githubusercontent.com",
      audience: "spx-gate6",
      artifactSha256: H("a"),
    },
  };
}

function signedEnvelope() {
  const core = completeUnsignedCore();
  const envelopeCoreSha256 = sha256(canonicalGate6Json(createGate6EnvelopeCore(core)));
  const allScopes = [...MANDATORY_FORWARD_SCOPES, ...COMPENSATION_SCOPES, ...EMERGENCY_SCOPES];
  const actionIdByScope = new Map(allScopes.map((scope, index) => [
    scope,
    `gate6-20260710-${String(index + 1).padStart(3, "0")}`,
  ]));
  const actionApprovals = allScopes.map((scope) => {
    const kind = COMPENSATION_SCOPES.includes(scope as never)
      ? "compensation"
      : EMERGENCY_SCOPES.includes(scope as never) ? "emergency" : "forward";
    const permitIntent = scope === "task9-line-boundary"
      ? {
          permitId: "gate6-line-once-001",
          service: "line-service",
          kind: "retryable-before-provider",
          teamId: 2,
          targetSha256: H("8"),
          fixtureSha256: null,
          releaseOrFixtureSha256: H("e"),
          issuanceNonce: "line-intent-001",
        }
      : scope === "task9-ocr-boundary"
        ? {
            permitId: "gate6-ocr-once-001",
            service: "ocr-service",
            kind: "retryable-before-provider",
            teamId: 2,
            targetSha256: null,
            fixtureSha256: H("9"),
            releaseOrFixtureSha256: H("9"),
            issuanceNonce: "ocr-intent-001",
          }
        : undefined;
    const payload = {
      gate6Id: core.gate6Id,
      scope,
      kind,
      actionId: actionIdByScope.get(scope),
      envelopeCoreSha256,
      candidateSha: core.candidateSha,
      runtimeEnvironment: "production",
      drillMode: "supervised-production",
      allowedMutationSha256: sha256(`mutation:${scope}`),
      rollbackScope: `${scope}:rollback`,
      pairedActionId: kind === "compensation"
        ? actionIdByScope.get(COMPENSATION_PAIRINGS[scope])
        : null,
      issuedAt: core.issuedAt,
      expiresAt: kind === "forward" ? core.expiresAt : "2026-07-10T20:30:00.000Z",
    };
    const signedPayload = permitIntent === undefined ? payload : { ...payload, permitIntent };
    return { ...signedPayload, signature: signature(signedPayload) };
  });
  const actionIndexSha256 = sha256(canonicalGate6Json(createGate6ActionIndex(actionApprovals)));
  const outerPayload = { envelopeCoreSha256, actionIndexSha256 };
  return {
    ...core,
    envelopeCoreSha256,
    actionIndexSha256,
    actionApprovals,
    signature: signature(outerPayload),
  };
}

const options = {
  now: new Date("2026-07-10T17:00:00.000Z"),
  installedSchemaMaximum: RELEASED_SCHEMA_MAXIMUM,
  publicKeys: { [KEY_ID]: publicKey },
  expectedKeyId: KEY_ID,
  expectedAttestation: {
    repository: "owner/SPX",
    environment: "production",
    issuer: "https://token.actions.githubusercontent.com",
    audience: "spx-gate6",
    signerWorkflowPath: "owner/SPX/.github/workflows/gate6-envelope-signer.yml",
    signerWorkflowSha: SIGNER_SHA,
    workflowFileSha256: H("c"),
  },
};

const completeFixture = JSON.parse(readFileSync(
  new URL("./fixtures/gate6-envelope.complete.json", import.meta.url),
  "utf8",
));
assert.deepEqual(
  completeFixture.actionApprovals.map((action: { scope: string }) => action.scope),
  [...MANDATORY_FORWARD_SCOPES, ...COMPENSATION_SCOPES, ...EMERGENCY_SCOPES],
);
assert.equal(completeFixture.installedSchemaVersion, RELEASED_SCHEMA_MAXIMUM);
assert.equal(completeFixture.composeProject, "spx-production");
assert.deepEqual(validateGate6Envelope(completeFixture, {
  now: new Date("2026-07-10T17:00:00.000Z"),
  installedSchemaMaximum: RELEASED_SCHEMA_MAXIMUM,
  publicKeys: { [FIXTURE_KEY_ID]: fixturePublicKey },
  expectedKeyId: FIXTURE_KEY_ID,
  expectedAttestation: {
    repository: "owner/SPX",
    environment: "production",
    issuer: "https://token.actions.githubusercontent.com",
    audience: "spx-gate6",
    signerWorkflowPath: `owner/SPX/.github/workflows/gate6-envelope-signer.yml`,
    signerWorkflowSha: "a".repeat(40),
    workflowFileSha256: H("c"),
  },
}), {
  ok: true,
  envelopeCoreSha256: completeFixture.envelopeCoreSha256,
  actionIndexSha256: completeFixture.actionIndexSha256,
});

const valid = signedEnvelope();
assert.notEqual(valid.candidateSha, valid.githubAttestation.jobWorkflowSha);
assert.deepEqual(validateGate6Envelope(valid, options), {
  ok: true,
  envelopeCoreSha256: valid.envelopeCoreSha256,
  actionIndexSha256: valid.actionIndexSha256,
});
assert.equal(
  validateGate6Envelope(valid, {
    ...options,
    expectedAttestation: {
      ...options.expectedAttestation,
      signerWorkflowSha: "8".repeat(40),
    },
  }).ok,
  false,
  "the reusable signer SHA must be independently pinned from the candidate SHA",
);

for (const [field, value] of [
  ["releaseEnvironment", "supervised-production"],
  ["runtimeEnvironment", "staging"],
  ["drillMode", "production"],
  ["composeProject", "spx"],
] as const) {
  const tampered = { ...valid, [field]: value };
  assert.equal(validateGate6Envelope(tampered, options).ok, false, field);
}

const missing = { ...valid } as Record<string, unknown>;
delete missing.backupEvidenceSha256;
assert.equal(validateGate6Envelope(missing, options).ok, false);
assert.equal(validateGate6Envelope({ ...valid, extra: true }, options).ok, false);
assert.equal(validateGate6Envelope({
  ...valid,
  installedSchemaVersion: RELEASED_SCHEMA_MAXIMUM - 1,
}, options).ok, false);
assert.equal(validateGate6Envelope({ ...valid, candidateSha: "f".repeat(40) }, options).ok, false);
assert.equal(validateGate6Envelope({ ...valid, actionApprovals: valid.actionApprovals.slice(1) }, options).ok, false);

const lineIndex = valid.actionApprovals.findIndex((action) => action.scope === "task9-line-boundary");
const crossService = structuredClone(valid);
crossService.actionApprovals[lineIndex].permitIntent.service = "ocr-service";
assert.equal(validateGate6Envelope(crossService, options).ok, false);

const unknownKey = structuredClone(valid);
unknownKey.signature.keyId = "unknown-key";
assert.equal(validateGate6Envelope(unknownKey, options).ok, false);
assert.equal(validateGate6Envelope(valid, {
  ...options,
  expectedKeyId: "gate6-wrong-role-test",
  publicKeys: {
    ...options.publicKeys,
    "gate6-wrong-role-test": publicKey,
  },
}).ok, false, "a valid signature must not be accepted through a different signer role");

console.log("gate6 approval tests passed");
