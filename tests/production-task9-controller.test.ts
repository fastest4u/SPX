import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import {
  GATE6_TASK9_ONE_SHOT_CONTRACT,
  assertGate6Task9ContainerEnvironment,
  runProductionTask9,
  verifyProductionTask9PermitArtifact,
} from "../scripts/production-task9-controller.mjs";

const action = {
  gate6Id: "gate6-prod-001",
  scope: "task9-line-boundary",
  actionId: "task9-line-001",
  approvalSha256: "a".repeat(64),
  allowedMutationSha256: "b".repeat(64),
  releaseEnvironment: "production",
  runtimeEnvironment: "production",
  drillMode: "supervised-production",
  composeProject: "spx-production",
  envFile: "/root/SPX/.env",
  composeFiles: ["/root/SPX/docker-compose.yml"],
};
const permit = {
  permitId: "permit-line-001",
  service: "line-service",
};
const LINE_SIGNER_SHA = "7".repeat(40);

function signedPermitArtifact(
  issuanceNonce = "line-intent-001",
  releaseOrFixtureSha256 = "e".repeat(64),
) {
  const keys = generateKeyPairSync("ed25519");
  const payload = {
    schemaVersion: 1,
    permitId: "permit-line-001",
    gate6Id: "gate6-prod-001",
    gate6Nonce: "nonce-prod-001",
    envelopeCoreSha256: "c".repeat(64),
    actionId: "task9-line-001",
    actionSha256: "a".repeat(64),
    candidateSha: "d".repeat(40),
    service: "line-service",
    kind: "retryable-before-provider",
    teamId: 2,
    targetSha256: "e".repeat(64),
    fixtureSha256: null,
    releaseOrFixtureSha256,
    issuanceNonce,
    currentStage: "db-transition-stable",
    acceptedCheckerSha256: "f".repeat(64),
    oneMatch: 1,
    issuedAt: "2026-07-11T01:00:00.000Z",
    expiresAt: "2026-07-11T01:01:00.000Z",
    githubAttestation: {
      repository: "owner/SPX",
      environment: "production",
      jobWorkflowRef: `owner/SPX/.github/workflows/gate6-line-permit-signer.yml@${LINE_SIGNER_SHA}`,
      jobWorkflowSha: LINE_SIGNER_SHA,
      issuer: "https://token.actions.githubusercontent.com",
      audience: "spx-gate6-line-permit",
    },
  };
  const canonical = canonicalGate6Json(payload);
  return {
    permit: {
      ...payload,
      signature: {
        algorithm: "ed25519",
        keyId: "gate6-line-2026-07",
        signedPayloadSha256: createHash("sha256").update(canonical).digest("hex"),
        signatureBase64: sign(null, Buffer.from(canonical), keys.privateKey).toString("base64"),
      },
    },
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function successCase(): Promise<void> {
  const calls: string[] = [];
  const result = await runProductionTask9({
    action,
    permit,
    ledger: {
      async registerTask9Permit() { calls.push("register-and-consume"); return Object.freeze({ receipt: true }); },
      async disarmTask9Permit() { calls.push("disarm"); },
      async completeTask9PermitAction(_receipt: unknown, input: { status: string }) {
        calls.push(`complete:${input.status}`);
      },
    },
    verifyPermit: async () => ({ ok: true, permitBinding: { service: "line-service" } }),
    triggerExactRequest: async () => { calls.push("trigger"); },
    verifyConsumed: async () => { calls.push("verify-consumed"); return true; },
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(calls, [
    "register-and-consume", "trigger", "verify-consumed", "disarm", "complete:succeeded",
  ]);
}

async function finallyDisarms(): Promise<void> {
  const calls: string[] = [];
  await assert.rejects(
    () => runProductionTask9({
      action,
      permit,
      ledger: {
        async registerTask9Permit() { calls.push("register-and-consume"); return Object.freeze({ receipt: true }); },
        async disarmTask9Permit() { calls.push("disarm"); },
        async completeTask9PermitAction(_receipt: unknown, input: { status: string }) {
          calls.push(`complete:${input.status}`);
        },
      },
      verifyPermit: async () => ({ ok: true, permitBinding: { service: "line-service" } }),
      triggerExactRequest: async () => { throw new Error("request failed"); },
      verifyConsumed: async () => false,
    }),
    /request failed/,
  );
  assert.deepEqual(calls, ["register-and-consume", "disarm", "complete:ambiguous"]);
}

async function main(): Promise<void> {
  assert.deepEqual(GATE6_TASK9_ONE_SHOT_CONTRACT.networks, ["default", "gate6-control-internal"]);
  assert.deepEqual(GATE6_TASK9_ONE_SHOT_CONTRACT.secrets, [
    ["db_password_gate6_control", "/run/secrets/db_password"],
    ["gate6_task9_line_caller_secret", "/run/secrets/gate6_task9_line_caller_secret"],
    ["gate6_task9_ocr_caller_secret", "/run/secrets/gate6_task9_ocr_caller_secret"],
  ]);
  assert.equal(GATE6_TASK9_ONE_SHOT_CONTRACT.dockerSocket, false);
  assert.equal(GATE6_TASK9_ONE_SHOT_CONTRACT.providerCredentials, false);
  assert.deepEqual(assertGate6Task9ContainerEnvironment({
    DB_HOST: "gate6-db-proxy",
    DB_PORT: "3306",
    DB_NAME: "SPX",
    DB_USERNAME: "spx_gate6_control",
    DB_PASSWORD_FILE: "/run/secrets/db_password",
  }).database, "SPX");
  assert.throws(() => assertGate6Task9ContainerEnvironment({
    DB_HOST: "mysql.example.test",
    DB_PORT: "3306",
    DB_NAME: "SPX",
    DB_USERNAME: "spx_gate6_control",
    DB_PASSWORD_FILE: "/run/secrets/db_password",
  }), /container environment/i);
  assert.throws(() => assertGate6Task9ContainerEnvironment({
    DB_HOST: "gate6-db-proxy",
    DB_PORT: "3306",
    DB_NAME: "SPX",
    DB_USERNAME: "spx_gate6_control",
    DB_PASSWORD_FILE: "/run/secrets/db_password",
    OPENAI_API_KEY: "must-not-enter-task9",
  }), /provider credential/i);
  const source = readFileSync("scripts/production-task9-controller.mjs", "utf8");
  const compose = readFileSync("docker-compose.a3.yml", "utf8");
  const task9Service = compose.match(
    /^ {2}gate6-task9-controller:\r?\n[\s\S]*?(?=^ {2}[a-z0-9][a-z0-9-]+:\r?$|^configs:)/m,
  )?.[0] ?? "";
  assert.notEqual(task9Service, "", "gate6-task9-controller service is missing");
  assert.match(task9Service, /SPX_GATE6_DB_PASSWORD_SHA256:/);
  assert.match(task9Service, /SPX_GATE6_DB_CA_SHA256:/);
  assert.match(task9Service, /\/run\/config\/gate6-production-keyring\.json/);
  assert.match(task9Service, /\/run\/config\/gate6-task9-requests\.json/);
  assert.match(task9Service, /source:\s*\/var\/lib\/spx-gate6\/artifacts[\s\S]*target:\s*\/run\/gate6\/artifacts/);
  assert.match(task9Service, /source:\s*\/var\/lib\/spx-gate6\/actions[\s\S]*target:\s*\/run\/gate6\/actions/);
  assert.match(task9Service, /source:\s*\/var\/lib\/spx-gate6\/permits[\s\S]*target:\s*\/run\/gate6\/permits/);
  assert.match(source, /http:\/\/line-service:3002/);
  assert.match(source, /http:\/\/ocr-service:3004/);
  assert.match(source, /gate6_task9_line_caller_secret/);
  assert.match(source, /gate6_task9_ocr_caller_secret/);
  assert.match(source, /runVerifiedGate6AtomicController/);
  assert.doesNotMatch(source, /requires-verified-controller-context/);
  const signed = signedPermitArtifact();
  const verified = verifyProductionTask9PermitArtifact({
    permit: signed.permit,
    action: {
      ...action,
      gate6Id: "gate6-prod-001",
      actionId: "task9-line-001",
      envelopeCoreSha256: "c".repeat(64),
      candidateSha: "d".repeat(40),
      permitIntent: {
        permitId: "permit-line-001",
        service: "line-service",
        kind: "retryable-before-provider",
        teamId: 2,
        targetSha256: "e".repeat(64),
        fixtureSha256: null,
        releaseOrFixtureSha256: "e".repeat(64),
        issuanceNonce: "line-intent-001",
      },
    },
    envelope: {
      gate6Id: "gate6-prod-001",
      gate6Nonce: "nonce-prod-001",
      envelopeCoreSha256: "c".repeat(64),
      candidateSha: "d".repeat(40),
    },
    approvalSha256: "a".repeat(64),
    expectedCheckerSha256: "f".repeat(64),
    expectedRequestSha256: "e".repeat(64),
    repository: "owner/SPX",
    expectedSignerSha: LINE_SIGNER_SHA,
    publicKeys: { "gate6-line-2026-07": signed.publicKey },
    expectedKeyId: "gate6-line-2026-07",
    now: new Date("2026-07-11T01:00:20.000Z"),
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.permitBinding?.service, "line-service");
  for (const substituted of [
    signedPermitArtifact("line-intent-substituted"),
    signedPermitArtifact("line-intent-001", "9".repeat(64)),
  ]) {
    assert.equal(verifyProductionTask9PermitArtifact({
      permit: substituted.permit,
      action: {
        ...action,
        gate6Id: "gate6-prod-001",
        actionId: "task9-line-001",
        envelopeCoreSha256: "c".repeat(64),
        candidateSha: "d".repeat(40),
        permitIntent: {
          permitId: "permit-line-001",
          service: "line-service",
          kind: "retryable-before-provider",
          teamId: 2,
          targetSha256: "e".repeat(64),
          fixtureSha256: null,
          releaseOrFixtureSha256: "e".repeat(64),
          issuanceNonce: "line-intent-001",
        },
      },
      envelope: {
        gate6Id: "gate6-prod-001",
        gate6Nonce: "nonce-prod-001",
        envelopeCoreSha256: "c".repeat(64),
        candidateSha: "d".repeat(40),
      },
      approvalSha256: "a".repeat(64),
      expectedCheckerSha256: "f".repeat(64),
      expectedRequestSha256: "e".repeat(64),
      repository: "owner/SPX",
      expectedSignerSha: LINE_SIGNER_SHA,
      publicKeys: { "gate6-line-2026-07": substituted.publicKey },
      expectedKeyId: "gate6-line-2026-07",
      now: new Date("2026-07-11T01:00:20.000Z"),
    }).ok, false, "a re-signed permit must not substitute its signed intent binding");
  }
  assert.equal(verifyProductionTask9PermitArtifact({
    permit: { ...signed.permit, service: "ocr-service" },
    action: {}, envelope: {}, approvalSha256: "a".repeat(64),
    expectedCheckerSha256: "f".repeat(64), expectedRequestSha256: "e".repeat(64),
    repository: "owner/SPX", publicKeys: { "gate6-line-2026-07": signed.publicKey },
    now: new Date("2026-07-11T01:00:20.000Z"),
  }).ok, false);
  assert.equal(verifyProductionTask9PermitArtifact({
    permit: signed.permit,
    action: {
      ...action,
      gate6Id: "gate6-prod-001",
      actionId: "task9-line-001",
      envelopeCoreSha256: "c".repeat(64),
      candidateSha: "d".repeat(40),
      permitIntent: {
        permitId: "permit-line-001",
        service: "line-service",
        kind: "retryable-before-provider",
        teamId: 2,
        targetSha256: "e".repeat(64),
        fixtureSha256: null,
        releaseOrFixtureSha256: "e".repeat(64),
        issuanceNonce: "line-intent-001",
      },
    },
    envelope: {
      gate6Id: "gate6-prod-001",
      gate6Nonce: "nonce-prod-001",
      envelopeCoreSha256: "c".repeat(64),
      candidateSha: "d".repeat(40),
    },
    approvalSha256: "a".repeat(64),
    expectedCheckerSha256: "f".repeat(64),
    expectedRequestSha256: "e".repeat(64),
    repository: "owner/SPX",
    expectedSignerSha: LINE_SIGNER_SHA,
    publicKeys: {
      "gate6-line-2026-07": signed.publicKey,
      "gate6-ocr-2026-07": signed.publicKey,
    },
    expectedKeyId: "gate6-ocr-2026-07",
    now: new Date("2026-07-11T01:00:20.000Z"),
  }).ok, false, "a valid LINE permit must not be accepted through the OCR signer role");
  assert.equal(verifyProductionTask9PermitArtifact({
    permit: signed.permit,
    action: {
      ...action,
      gate6Id: "gate6-prod-001",
      actionId: "task9-line-001",
      envelopeCoreSha256: "c".repeat(64),
      candidateSha: "d".repeat(40),
      permitIntent: {
        permitId: "permit-line-001",
        service: "ocr-service",
        kind: "retryable-before-provider",
        teamId: 2,
        targetSha256: "e".repeat(64),
        fixtureSha256: null,
        releaseOrFixtureSha256: "e".repeat(64),
        issuanceNonce: "line-intent-001",
      },
    },
    envelope: {
      gate6Id: "gate6-prod-001",
      gate6Nonce: "nonce-prod-001",
      envelopeCoreSha256: "c".repeat(64),
      candidateSha: "d".repeat(40),
    },
    approvalSha256: "a".repeat(64),
    expectedCheckerSha256: "f".repeat(64),
    expectedRequestSha256: "e".repeat(64),
    repository: "owner/SPX",
    publicKeys: { "gate6-line-2026-07": signed.publicKey },
    expectedKeyId: "gate6-line-2026-07",
    now: new Date("2026-07-11T01:00:20.000Z"),
  }).ok, false, "the permit service must match the independently signed action intent service");
  await successCase();
  await finallyDisarms();
  await assert.rejects(
    () => runProductionTask9({
      action: { ...action, composeProject: "default" },
      permit,
      ledger: {},
      verifyPermit: async () => ({ ok: true }),
      triggerExactRequest: async () => {},
      verifyConsumed: async () => true,
    }),
    /production boundary/i,
  );
  console.log("production Task 9 controller tests passed");
}

void main();
