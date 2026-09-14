import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
  canonicalFaultPermitJson,
  createProductionCanaryFaultGate,
  verifyProductionFaultPermit,
} from "../src/services/production-canary-fault.js";

const lineKeys = generateKeyPairSync("ed25519");
const ocrKeys = generateKeyPairSync("ed25519");
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const H = (character: string): string => character.repeat(64);
const CANDIDATE_SHA = "d".repeat(40);
const SIGNER_SHA = "9".repeat(40);

function signedPermit(service: "line-service" | "ocr-service") {
  const payload = {
    schemaVersion: 1,
    permitId: `permit-${service}-001`,
    gate6Id: "gate6-prod-001",
    gate6Nonce: "gate6-nonce-001",
    envelopeCoreSha256: H("a"),
    actionId: `task9-${service}-001`,
    actionSha256: H("b"),
    candidateSha: CANDIDATE_SHA,
    service,
    kind: "retryable-before-provider",
    teamId: 2,
    targetSha256: service === "line-service" ? sha256("safe-line-target") : null,
    fixtureSha256: service === "ocr-service" ? sha256("fixture-bytes") : null,
    releaseOrFixtureSha256: service === "line-service" ? H("e") : sha256("fixture-bytes"),
    issuanceNonce: `${service}-intent-001`,
    currentStage: "db-transition-stable",
    acceptedCheckerSha256: H("c"),
    oneMatch: 1,
    issuedAt: "2026-07-11T01:00:00.000Z",
    expiresAt: "2026-07-11T01:01:00.000Z",
    githubAttestation: {
      repository: "owner/SPX",
      environment: "production",
      jobWorkflowRef: `owner/SPX/.github/workflows/gate6-${service === "line-service" ? "line" : "ocr"}-permit-signer.yml@${SIGNER_SHA}`,
      jobWorkflowSha: SIGNER_SHA,
      issuer: "https://token.actions.githubusercontent.com",
      audience: `spx-gate6-${service === "line-service" ? "line" : "ocr"}-permit`,
    },
  };
  const keyId = service === "line-service" ? "gate6-line-test" : "gate6-ocr-test";
  const privateKey = service === "line-service" ? lineKeys.privateKey : ocrKeys.privateKey;
  const canonical = canonicalFaultPermitJson(payload);
  return {
    ...payload,
    signature: {
      algorithm: "ed25519",
      keyId,
      signedPayloadSha256: sha256(canonical),
      signatureBase64: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  };
}

function resignPermit(
  permit: ReturnType<typeof signedPermit>,
  mutation: (payload: Record<string, unknown>) => void,
) {
  const { signature, ...original } = permit;
  const payload = structuredClone(original) as Record<string, unknown>;
  const privateKey = permit.service === "line-service" ? lineKeys.privateKey : ocrKeys.privateKey;
  mutation(payload);
  const canonical = canonicalFaultPermitJson(payload);
  return {
    ...payload,
    signature: {
      ...signature,
      signedPayloadSha256: sha256(canonical),
      signatureBase64: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  } as ReturnType<typeof signedPermit>;
}

const activeContextBase = {
  gate6Id: "gate6-prod-001",
  gate6Nonce: "gate6-nonce-001",
  envelopeCoreSha256: H("a"),
  currentStage: "db-transition-stable",
  acceptedCheckerSha256: H("c"),
  teamId: 2,
  candidateSha: CANDIDATE_SHA,
  repository: "owner/SPX",
};

const line = signedPermit("line-service");
const ocr = signedPermit("ocr-service");
const activeContext = {
  ...activeContextBase,
  permitId: line.permitId,
  actionId: line.actionId,
  signedPermitSha256: sha256(canonicalFaultPermitJson(line)),
};
const activeOcrContext = {
  ...activeContextBase,
  permitId: ocr.permitId,
  actionId: ocr.actionId,
  signedPermitSha256: sha256(canonicalFaultPermitJson(ocr)),
};
assert.equal(verifyProductionFaultPermit(line, {
  service: "line-service",
  keyId: "gate6-line-test",
  publicKey: lineKeys.publicKey,
  activeContext,
  signerWorkflowSha: SIGNER_SHA,
  expectedRequestSha256: sha256("safe-line-target"),
  now: new Date("2026-07-11T01:00:20.000Z"),
}).ok, true);

assert.equal(verifyProductionFaultPermit(ocr, {
  service: "ocr-service",
  keyId: "gate6-ocr-test",
  publicKey: ocrKeys.publicKey,
  activeContext: activeOcrContext,
  signerWorkflowSha: SIGNER_SHA,
  expectedRequestSha256: sha256("fixture-bytes"),
  now: new Date("2026-07-11T01:00:20.000Z"),
}).ok, true, "OCR permits must verify against the independently pinned OCR signer SHA");

assert.equal(verifyProductionFaultPermit(line, {
  service: "line-service",
  keyId: "gate6-line-test",
  publicKey: lineKeys.publicKey,
  activeContext: { ...activeContext, signedPermitSha256: H("f") },
  signerWorkflowSha: SIGNER_SHA,
  expectedRequestSha256: sha256("safe-line-target"),
  now: new Date("2026-07-11T01:00:20.000Z"),
}).ok, false, "service verification must bind the exact permit registered by Gate 6 control");

assert.equal(verifyProductionFaultPermit(line, {
  service: "ocr-service",
  keyId: "gate6-ocr-test",
  publicKey: ocrKeys.publicKey,
  activeContext,
  signerWorkflowSha: SIGNER_SHA,
  expectedRequestSha256: sha256("fixture-bytes"),
  now: new Date("2026-07-11T01:00:20.000Z"),
}).ok, false, "LINE permit must never authorize OCR");

assert.equal(verifyProductionFaultPermit(line, {
  service: "line-service",
  keyId: "gate6-line-test",
  publicKey: lineKeys.publicKey,
  activeContext,
  signerWorkflowSha: SIGNER_SHA,
  expectedRequestSha256: sha256("different-target"),
  now: new Date("2026-07-11T01:00:20.000Z"),
}).ok, false);

assert.equal(verifyProductionFaultPermit(line, {
  service: "line-service",
  keyId: "gate6-line-test",
  publicKey: lineKeys.publicKey,
  activeContext,
  signerWorkflowSha: SIGNER_SHA,
  expectedRequestSha256: sha256("safe-line-target"),
  now: new Date("2026-07-11T01:01:00.000Z"),
}).ok, false);

assert.equal(verifyProductionFaultPermit(line, {
  service: "line-service",
  keyId: "gate6-line-test",
  publicKey: lineKeys.publicKey,
  activeContext: { ...activeContext, currentStage: "revoked" },
  signerWorkflowSha: SIGNER_SHA,
  expectedRequestSha256: sha256("safe-line-target"),
  now: new Date("2026-07-11T01:00:20.000Z"),
}).ok, false);

const candidateShaSignerPermit = resignPermit(line, (payload) => {
  const attestation = payload.githubAttestation as Record<string, unknown>;
  attestation.jobWorkflowSha = CANDIDATE_SHA;
  attestation.jobWorkflowRef = `owner/SPX/.github/workflows/gate6-line-permit-signer.yml@${CANDIDATE_SHA}`;
});
assert.equal(
  verifyProductionFaultPermit(candidateShaSignerPermit, {
    service: "line-service",
    keyId: "gate6-line-test",
    publicKey: lineKeys.publicKey,
    activeContext: {
      ...activeContext,
      permitId: candidateShaSignerPermit.permitId,
      actionId: candidateShaSignerPermit.actionId,
      signedPermitSha256: sha256(canonicalFaultPermitJson(candidateShaSignerPermit)),
    },
    signerWorkflowSha: SIGNER_SHA,
    expectedRequestSha256: sha256("safe-line-target"),
    now: new Date("2026-07-11T01:00:20.000Z"),
  }).ok,
  false,
  "an attestation signed at the candidate SHA must never satisfy the independently pinned signer SHA",
);

const candidateShaSignerOcrPermit = resignPermit(ocr, (payload) => {
  const attestation = payload.githubAttestation as Record<string, unknown>;
  attestation.jobWorkflowSha = CANDIDATE_SHA;
  attestation.jobWorkflowRef = `owner/SPX/.github/workflows/gate6-ocr-permit-signer.yml@${CANDIDATE_SHA}`;
});
assert.equal(
  verifyProductionFaultPermit(candidateShaSignerOcrPermit, {
    service: "ocr-service",
    keyId: "gate6-ocr-test",
    publicKey: ocrKeys.publicKey,
    activeContext: {
      ...activeOcrContext,
      permitId: candidateShaSignerOcrPermit.permitId,
      actionId: candidateShaSignerOcrPermit.actionId,
      signedPermitSha256: sha256(canonicalFaultPermitJson(candidateShaSignerOcrPermit)),
    },
    signerWorkflowSha: SIGNER_SHA,
    expectedRequestSha256: sha256("fixture-bytes"),
    now: new Date("2026-07-11T01:00:20.000Z"),
  }).ok,
  false,
  "OCR attestation must bind to the pinned signer SHA, not the candidate SHA",
);

async function testDurableGate(): Promise<void> {
  const consumed = new Set<string>();
  const controlClient = {
    async getActiveContext() { return activeContext; },
    async consumePermit(input: { permitId: string; signedPermitSha256: string }) {
      assert.equal(input.signedPermitSha256, activeContext.signedPermitSha256);
      if (consumed.has(input.permitId)) return false;
      consumed.add(input.permitId);
      return true;
    },
  };
  const encodedLinePermit = Buffer.from(canonicalFaultPermitJson(line)).toString("base64");
  const lineGate = createProductionCanaryFaultGate({
    service: "line-service",
    keyId: "gate6-line-test",
    publicKey: lineKeys.publicKey,
    signerWorkflowSha: SIGNER_SHA,
    controlClient,
    now: () => new Date("2026-07-11T01:00:20.000Z"),
  });
  assert.equal(await lineGate.shouldInjectLine({
    encodedPermit: encodedLinePermit,
    targetId: "safe-line-target",
  }), true);
  const restartedLineGate = createProductionCanaryFaultGate({
    service: "line-service",
    keyId: "gate6-line-test",
    publicKey: lineKeys.publicKey,
    signerWorkflowSha: SIGNER_SHA,
    controlClient,
    now: () => new Date("2026-07-11T01:00:21.000Z"),
  });
  assert.equal(await restartedLineGate.shouldInjectLine({
    encodedPermit: encodedLinePermit,
    targetId: "safe-line-target",
  }), false, "durable consumption must survive service restart");
  assert.equal(await restartedLineGate.shouldInjectLine({
    encodedPermit: undefined,
    targetId: "safe-line-target",
  }), false);
  const unavailableControlGate = createProductionCanaryFaultGate({
    service: "line-service",
    keyId: "gate6-line-test",
    publicKey: lineKeys.publicKey,
    signerWorkflowSha: SIGNER_SHA,
    controlClient: {
      async getActiveContext() { throw new Error("control unavailable"); },
      async consumePermit() { throw new Error("control unavailable"); },
    },
    now: () => new Date("2026-07-11T01:00:21.000Z"),
  });
  assert.equal(await unavailableControlGate.shouldInjectLine({
    encodedPermit: encodedLinePermit,
    targetId: "safe-line-target",
  }), false, "control-plane failure must not suppress ordinary provider delivery");
  console.log("production canary fault tests passed");
}

void testDurableGate();
