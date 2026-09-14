#!/usr/bin/env node
import {
  createHash,
  createHmac,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import {
  consumeGate6MutationContext,
  PRODUCTION_COMPOSE,
} from "./lib/gate6-controller.mjs";
import {
  parseGate6ControllerArgs,
  runVerifiedGate6AtomicController,
  runVerifiedGate6ControllerMutation,
} from "./lib/gate6-cli-runtime.mjs";
import { readEvidenceBytes } from "./lib/evidence-artifact.mjs";

const TASK9_SCOPE_SERVICE = Object.freeze({
  "task9-line-boundary": "line-service",
  "task9-ocr-boundary": "ocr-service",
});
const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LINE_ORIGIN = "http://line-service:3002";
const OCR_ORIGIN = "http://ocr-service:3004";
const LINE_PATH = "/internal/line/messages";
const OCR_PATH = "/internal/ocr/line-image";
const LINE_NODE_ID = "prod-gate6-task9-line-controller-1";
const OCR_NODE_ID = "prod-gate6-task9-ocr-controller-1";
const LINE_SECRET_FILE = "/run/secrets/gate6_task9_line_caller_secret";
const OCR_SECRET_FILE = "/run/secrets/gate6_task9_ocr_caller_secret";
const REQUEST_CONFIG_FILE = "/run/config/gate6-task9-requests.json";
const OCR_FIXTURE_FILE = "/app/scripts/task9-ocr-fixture.png";

export const GATE6_TASK9_ONE_SHOT_CONTRACT = Object.freeze({
  service: "gate6-task9-controller",
  profile: "gate6",
  command: Object.freeze(["node", "scripts/production-task9-controller.mjs"]),
  database: Object.freeze({
    host: "gate6-db-proxy",
    port: "3306",
    name: "spx",
    passwordFile: "/run/secrets/db_password",
    principalEnv: "SPX_DB_USERNAME_GATE6_CONTROL",
  }),
  networks: Object.freeze(["default", "gate6-control-internal"]),
  secrets: Object.freeze([
    Object.freeze(["db_password_gate6_control", "/run/secrets/db_password"]),
    Object.freeze(["gate6_task9_line_caller_secret", LINE_SECRET_FILE]),
    Object.freeze(["gate6_task9_ocr_caller_secret", OCR_SECRET_FILE]),
  ]),
  readOnlyMounts: Object.freeze([
    Object.freeze(["SPX_DB_CA_PATH", "/run/config/db-ca.pem"]),
    Object.freeze(["SPX_GATE6_PRODUCTION_KEYRING_PATH", "/run/config/gate6-production-keyring.json"]),
    Object.freeze(["SPX_GATE6_TASK9_REQUEST_CONFIG_PATH", REQUEST_CONFIG_FILE]),
    Object.freeze(["/var/lib/spx-gate6/artifacts", "/run/gate6/artifacts"]),
    Object.freeze(["/var/lib/spx-gate6/actions", "/run/gate6/actions"]),
    Object.freeze(["/var/lib/spx-gate6/permits", "/run/gate6/permits"]),
  ]),
  dockerSocket: false,
  providerCredentials: false,
});

export function assertGate6Task9ContainerEnvironment(environment) {
  const forbidden = Object.keys(environment ?? {}).filter((key) =>
    /(?:^|_)(?:OPENAI|CODEX|ANTHROPIC|GOOGLE|AWS|LINEJS|DOCKER_HOST)(?:_|$)/.test(key),
  );
  if (forbidden.length > 0) throw new Error("Task 9 provider credential environment is forbidden");
  if (
    environment?.DB_HOST !== GATE6_TASK9_ONE_SHOT_CONTRACT.database.host
    || environment?.DB_PORT !== GATE6_TASK9_ONE_SHOT_CONTRACT.database.port
    || environment?.DB_NAME !== GATE6_TASK9_ONE_SHOT_CONTRACT.database.name
    || environment?.DB_PASSWORD_FILE !== GATE6_TASK9_ONE_SHOT_CONTRACT.database.passwordFile
    || !/^[A-Za-z0-9_]{1,64}$/.test(environment?.DB_USERNAME ?? "")
  ) throw new Error("Task 9 container environment is invalid");
  return Object.freeze({
    host: environment.DB_HOST,
    port: Number(environment.DB_PORT),
    database: environment.DB_NAME,
    username: environment.DB_USERNAME,
  });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!record(value)) throw new Error("Task 9 permit object is invalid");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Task 9 permit fields are invalid");
  }
}

function exactTime(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

export function verifyProductionTask9PermitArtifact(input) {
  try {
    const { permit, action, envelope } = input;
    exactKeys(permit, [
      "schemaVersion", "permitId", "gate6Id", "gate6Nonce", "envelopeCoreSha256",
      "actionId", "actionSha256", "candidateSha", "service", "kind", "teamId",
      "targetSha256", "fixtureSha256", "releaseOrFixtureSha256", "issuanceNonce",
      "currentStage", "acceptedCheckerSha256",
      "oneMatch", "issuedAt", "expiresAt", "githubAttestation", "signature",
    ]);
    const service = TASK9_SCOPE_SERVICE[action?.scope];
    const intent = action?.permitIntent;
    if (
      permit.schemaVersion !== 1
      || !service
      || permit.service !== service
      || permit.service !== intent?.service
      || !record(intent)
      || !ID.test(permit.permitId ?? "")
      || permit.permitId !== intent.permitId
      || permit.kind !== "retryable-before-provider"
      || permit.kind !== intent.kind
      || permit.gate6Id !== envelope?.gate6Id
      || permit.gate6Id !== action?.gate6Id
      || permit.gate6Nonce !== envelope?.gate6Nonce
      || permit.envelopeCoreSha256 !== envelope?.envelopeCoreSha256
      || permit.envelopeCoreSha256 !== action?.envelopeCoreSha256
      || permit.actionId !== action?.actionId
      || permit.actionSha256 !== input.approvalSha256
      || permit.candidateSha !== envelope?.candidateSha
      || permit.candidateSha !== action?.candidateSha
      || !SHA.test(permit.candidateSha ?? "")
      || permit.teamId !== intent.teamId
      || !Number.isSafeInteger(permit.teamId)
      || permit.teamId <= 0
      || permit.targetSha256 !== intent.targetSha256
      || permit.fixtureSha256 !== intent.fixtureSha256
      || permit.releaseOrFixtureSha256 !== intent.releaseOrFixtureSha256
      || !SHA256.test(permit.releaseOrFixtureSha256 ?? "")
      || permit.issuanceNonce !== intent.issuanceNonce
      || !ID.test(permit.issuanceNonce ?? "")
      || permit.currentStage !== "db-transition-stable"
      || permit.acceptedCheckerSha256 !== input.expectedCheckerSha256
      || !SHA256.test(permit.acceptedCheckerSha256 ?? "")
      || permit.oneMatch !== 1
    ) throw new Error("Task 9 permit binding is invalid");
    const expectedRequestField = service === "line-service" ? "targetSha256" : "fixtureSha256";
    const nullRequestField = service === "line-service" ? "fixtureSha256" : "targetSha256";
    if (permit[expectedRequestField] !== input.expectedRequestSha256 || permit[nullRequestField] !== null) {
      throw new Error("Task 9 request hash is invalid");
    }
    const issuedAt = exactTime(permit.issuedAt, "Task 9 permit issuance");
    const expiresAt = exactTime(permit.expiresAt, "Task 9 permit expiry");
    const now = (input.now ?? new Date()).getTime();
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 120_000 || now < issuedAt || now >= expiresAt) {
      throw new Error("Task 9 permit TTL is invalid");
    }
    exactKeys(permit.githubAttestation, [
      "repository", "environment", "jobWorkflowRef", "jobWorkflowSha", "issuer", "audience",
    ]);
    const serviceName = service === "line-service" ? "line" : "ocr";
    if (
      !SHA.test(input.expectedSignerSha ?? "")
      || permit.githubAttestation.repository !== input.repository
      || permit.githubAttestation.environment !== "production"
      || permit.githubAttestation.jobWorkflowRef
        !== `${input.repository}/.github/workflows/gate6-${serviceName}-permit-signer.yml@${input.expectedSignerSha}`
      || permit.githubAttestation.jobWorkflowSha !== input.expectedSignerSha
      || permit.githubAttestation.issuer !== "https://token.actions.githubusercontent.com"
      || permit.githubAttestation.audience !== `spx-gate6-${serviceName}-permit`
    ) throw new Error("Task 9 permit attestation is invalid");
    exactKeys(permit.signature, ["algorithm", "keyId", "signedPayloadSha256", "signatureBase64"]);
    const publicKey = input.publicKeys?.[permit.signature.keyId];
    const { signature: _signature, ...payload } = permit;
    const canonical = canonicalGate6Json(payload);
    const payloadSha256 = createHash("sha256").update(canonical).digest("hex");
    const signatureBytes = Buffer.from(permit.signature.signatureBase64 ?? "", "base64");
    if (
      permit.signature.algorithm !== "ed25519"
      || permit.signature.keyId !== input.expectedKeyId
      || typeof publicKey !== "string"
      || permit.signature.signedPayloadSha256 !== payloadSha256
      || signatureBytes.byteLength !== 64
      || !verifySignature(null, Buffer.from(canonical), publicKey, signatureBytes)
    ) throw new Error("Task 9 permit signature is invalid");
    return {
      ok: true,
      permitBinding: Object.freeze({
        permitId: permit.permitId,
        service,
        kind: permit.kind,
        teamId: permit.teamId,
        targetSha256: permit.targetSha256,
        fixtureSha256: permit.fixtureSha256,
        releaseOrFixtureSha256: permit.releaseOrFixtureSha256,
        issuanceNonce: permit.issuanceNonce,
        signedPermitSha256: createHash("sha256").update(canonicalGate6Json(permit)).digest("hex"),
        keyId: permit.signature.keyId,
        expiresAt: permit.expiresAt,
        expectedCheckerSha256: input.expectedCheckerSha256,
      }),
    };
  } catch {
    return { ok: false, code: "permit-unavailable" };
  }
}

function assertProductionAction(action) {
  if (
    action?.releaseEnvironment !== "production"
    || action?.runtimeEnvironment !== "production"
    || action?.drillMode !== "supervised-production"
  ) throw new Error("Task 9 production discriminator mismatch");
  if (
    action.composeProject !== PRODUCTION_COMPOSE.project
    || action.envFile !== PRODUCTION_COMPOSE.envFile
    || JSON.stringify(action.composeFiles) !== JSON.stringify(PRODUCTION_COMPOSE.files)
  ) throw new Error("Task 9 production boundary mismatch");
}

export async function runProductionTask9({
  action,
  permit,
  ledger,
  verifyPermit,
  triggerExactRequest,
  verifyConsumed,
  now = new Date(),
}) {
  assertProductionAction(action);
  const expectedService = TASK9_SCOPE_SERVICE[action.scope];
  if (!expectedService || permit?.service !== expectedService) throw new Error("Task 9 scope/service mismatch");
  const verified = await verifyPermit(permit, action);
  if (!verified?.ok || verified.permitBinding?.service !== expectedService) {
    throw new Error("Task 9 permit verification failed");
  }
  if (typeof ledger?.registerTask9Permit !== "function") throw new Error("Task 9 durable ledger is unavailable");
  if (typeof ledger?.disarmTask9Permit !== "function" || typeof ledger?.completeTask9PermitAction !== "function") {
    throw new Error("Task 9 durable completion ledger is unavailable");
  }
  let receipt;
  let result;
  let failure;
  try {
    receipt = await ledger.registerTask9Permit({ action, permit, verifiedPermit: verified, now });
    await triggerExactRequest({ service: expectedService, permitId: permit.permitId });
    if (await verifyConsumed({ permitId: permit.permitId, service: expectedService }) !== true) {
      throw new Error("Task 9 durable permit consumption was not proven");
    }
    result = { status: "succeeded", service: expectedService, permitId: permit.permitId };
  } catch (error) {
    failure = error;
  }
  if (receipt) {
    try {
      await ledger.disarmTask9Permit(receipt, { now: new Date() });
    } catch (error) {
      failure ??= error;
    }
    const status = failure ? "ambiguous" : "succeeded";
    const afterEvidenceSha256 = createHash("sha256")
      .update(`task9:${action.scope}:${permit.permitId}:${status}`)
      .digest("hex");
    try {
      await ledger.completeTask9PermitAction(receipt, {
        status,
        afterEvidenceSha256,
        now: new Date(),
      });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return result;
}

function canonicalField(name, value) {
  return `${name}:${Buffer.byteLength(value, "utf8")}:${value}`;
}

function internalHeaders({ nodeId, secret, path, body, eventKey }) {
  const timestamp = new Date().toISOString();
  const requestId = `gate6-task9-${randomUUID()}`;
  const payload = [
    "spx-hmac-v2",
    canonicalField("timestamp", timestamp),
    canonicalField("nodeId", nodeId),
    canonicalField("path", path),
    canonicalField("requestId", requestId),
    canonicalField("eventKey", eventKey ?? ""),
    canonicalField("body", body),
  ].join("\n");
  return {
    "content-type": "application/json",
    "x-spx-node-id": nodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-request-id": requestId,
    "x-spx-signature": createHmac("sha256", secret).update(payload).digest("hex"),
    ...(eventKey ? { "idempotency-key": eventKey } : {}),
  };
}

function validateLineRequest(value, label) {
  exactKeys(value, ["targetId", "text", "traceId", "outboxId"]);
  if (
    typeof value.targetId !== "string"
    || value.targetId.length === 0
    || value.targetId.length > 255
    || typeof value.text !== "string"
    || value.text.length === 0
    || value.text.length > 5_000
    || !ID.test(value.traceId ?? "")
    || !Number.isSafeInteger(value.outboxId)
    || value.outboxId <= 0
  ) throw new Error(`${label} is invalid`);
  return value;
}

function requestMutationSha256(value) {
  return createHash("sha256").update(canonicalGate6Json(value)).digest("hex");
}

async function boundedJson(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error("Task 9 response is invalid");
  const value = JSON.parse(bytes.toString("utf8"));
  if (!record(value)) throw new Error("Task 9 response is invalid");
  return value;
}

export async function createProductionTask9RequestAdapter(options = {}) {
  const read = options.readFileImpl ?? readFile;
  const fetchImpl = options.fetchImpl ?? fetch;
  const [configText, lineSecretText, ocrSecretText, fixtureBytes] = await Promise.all([
    read(REQUEST_CONFIG_FILE, "utf8"),
    read(LINE_SECRET_FILE, "utf8"),
    read(OCR_SECRET_FILE, "utf8"),
    read(OCR_FIXTURE_FILE),
  ]);
  const config = JSON.parse(configText);
  exactKeys(config, ["schemaVersion", "lineBaseline", "lineBoundary", "ocrBoundary"]);
  if (config.schemaVersion !== 1) throw new Error("Task 9 request configuration is invalid");
  const lineBaseline = validateLineRequest(config.lineBaseline, "Task 9 LINE baseline request");
  const lineBoundary = validateLineRequest(config.lineBoundary, "Task 9 LINE boundary request");
  exactKeys(config.ocrBoundary, ["traceId", "mimeType"]);
  if (!ID.test(config.ocrBoundary.traceId ?? "") || config.ocrBoundary.mimeType !== "image/png") {
    throw new Error("Task 9 OCR boundary request is invalid");
  }
  const lineSecret = lineSecretText.trim();
  const ocrSecret = ocrSecretText.trim();
  if (lineSecret.length < 32 || ocrSecret.length < 32 || lineSecret === ocrSecret) {
    throw new Error("Task 9 caller secrets are invalid");
  }

  function details(actionName) {
    if (actionName === "line-baseline" || actionName === "line-boundary-retry") {
      const request = actionName === "line-baseline" ? lineBaseline : lineBoundary;
      const body = JSON.stringify({
        targetId: request.targetId,
        text: request.text,
        traceId: request.traceId,
        outboxId: request.outboxId,
      });
      return {
        service: "line-service",
        expectedRequestSha256: createHash("sha256").update(request.targetId).digest("hex"),
        mutationSha256: requestMutationSha256({
          service: "line-service",
          path: LINE_PATH,
          nodeId: LINE_NODE_ID,
          bodySha256: createHash("sha256").update(body).digest("hex"),
          expectedStatus: actionName === "line-baseline" ? 200 : 503,
        }),
        async trigger(encodedPermit) {
          const response = await fetchImpl(`${LINE_ORIGIN}${LINE_PATH}`, {
            method: "POST",
            headers: {
              ...internalHeaders({
                nodeId: LINE_NODE_ID,
                secret: lineSecret,
                path: LINE_PATH,
                body,
                eventKey: request.traceId,
              }),
              ...(encodedPermit ? { "x-spx-gate6-permit": encodedPermit } : {}),
            },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          const responseBody = await boundedJson(response);
          if (actionName === "line-baseline") {
            if (!response.ok) throw new Error("Task 9 LINE baseline request failed");
          } else if (response.status !== 503 || responseBody?.error?.code !== "LINE_GATE6_RETRYABLE_FAULT") {
            throw new Error("Task 9 LINE retryable boundary was not observed");
          }
          return { status: response.status };
        },
      };
    }
    if (actionName !== "ocr-boundary-recovery") throw new Error("unknown Task 9 request action");
    const body = JSON.stringify({
      imageBase64: Buffer.from(fixtureBytes).toString("base64"),
      mimeType: "image/png",
      traceId: config.ocrBoundary.traceId,
    });
    return {
      service: "ocr-service",
      expectedRequestSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
      mutationSha256: requestMutationSha256({
        service: "ocr-service",
        path: OCR_PATH,
        nodeId: OCR_NODE_ID,
        bodySha256: createHash("sha256").update(body).digest("hex"),
        expectedStatus: 503,
      }),
      async trigger(encodedPermit) {
        const response = await fetchImpl(`${OCR_ORIGIN}${OCR_PATH}`, {
          method: "POST",
          headers: {
            ...internalHeaders({
              nodeId: OCR_NODE_ID,
              secret: ocrSecret,
              path: OCR_PATH,
              body,
            }),
            ...(encodedPermit ? { "x-spx-gate6-permit": encodedPermit } : {}),
          },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        await boundedJson(response);
        if (response.status !== 503) throw new Error("Task 9 OCR retryable boundary was not observed");
        return { status: response.status };
      },
    };
  }
  return Object.freeze({ details });
}

async function canonicalPermitFile(path) {
  const bytes = await readEvidenceBytes(resolve(path));
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  if (text !== canonicalGate6Json(value)) throw new Error("Task 9 permit must use canonical JSON");
  return value;
}

function productionAction(artifacts) {
  return {
    ...artifacts.action,
    approvalSha256: artifacts.approvalSha256,
    releaseEnvironment: artifacts.envelope.releaseEnvironment,
    runtimeEnvironment: artifacts.envelope.runtimeEnvironment,
    drillMode: artifacts.envelope.drillMode,
    composeProject: artifacts.envelope.composeProject,
    envFile: artifacts.envelope.envFile,
    composeFiles: artifacts.envelope.composeFiles,
  };
}

async function main() {
  try {
    assertGate6Task9ContainerEnvironment(process.env);
    const args = parseGate6ControllerArgs(process.argv.slice(2), {
      actions: ["line-baseline", "line-boundary-retry", "ocr-boundary-recovery"],
      extraArguments: ["permit"],
    });
    const scopeByAction = {
      "line-baseline": "task9-line-baseline",
      "line-boundary-retry": "task9-line-boundary",
      "ocr-boundary-recovery": "task9-ocr-boundary",
    };
    const expectedScope = scopeByAction[args.action];
    const requestAdapter = await createProductionTask9RequestAdapter();
    const request = requestAdapter.details(args.action);
    let result;
    if (args.action === "line-baseline") {
      if (args.permit) throw new Error("Task 9 baseline cannot accept a permit");
      result = await runVerifiedGate6ControllerMutation({
        args,
        databaseRuntime: "container",
        expectedScopes: [expectedScope],
        execute: async ({ context, artifacts }) => {
          if (artifacts.action.scope !== expectedScope || artifacts.action.allowedMutationSha256 !== request.mutationSha256) {
            throw new Error("Task 9 baseline mutation binding mismatch");
          }
          const identity = consumeGate6MutationContext(context, expectedScope);
          if (identity.scope !== expectedScope) throw new Error("Task 9 baseline action scope mismatch");
          await request.trigger(null);
          return { status: "succeeded", service: request.service };
        },
      });
    } else {
      if (!args.permit) throw new Error("Task 9 boundary requires a permit");
      result = await runVerifiedGate6AtomicController({
        args,
        databaseRuntime: "container",
        expectedScopes: [expectedScope],
        execute: async ({ artifacts, ledger, now }) => {
          if (artifacts.action.scope !== expectedScope || artifacts.action.allowedMutationSha256 !== request.mutationSha256) {
            throw new Error("Task 9 boundary mutation binding mismatch");
          }
          const binding = await ledger.getActionBinding(
            artifacts.envelope.gate6Id,
            artifacts.action.scope,
            artifacts.action.actionId,
          );
          if (binding.expectedStage !== "db-transition-stable" || !SHA256.test(binding.expectedCheckerSha256 ?? "")) {
            throw new Error("Task 9 accepted checker binding is invalid");
          }
          const permit = await canonicalPermitFile(args.permit);
          const verified = verifyProductionTask9PermitArtifact({
            permit,
            action: artifacts.action,
            envelope: artifacts.envelope,
            approvalSha256: artifacts.approvalSha256,
            expectedCheckerSha256: binding.expectedCheckerSha256,
            expectedRequestSha256: request.expectedRequestSha256,
            repository: artifacts.keyring.repository,
            expectedSignerSha: expectedScope === "task9-line-boundary"
              ? artifacts.keyring.signerWorkflowShas.linePermit
              : artifacts.keyring.signerWorkflowShas.ocrPermit,
            publicKeys: artifacts.keyring.keys,
            expectedKeyId: expectedScope === "task9-line-boundary"
              ? artifacts.keyring.keyIds.linePermit
              : artifacts.keyring.keyIds.ocrPermit,
            now,
          });
          if (!verified.ok) throw new Error("Task 9 permit verification failed");
          const encodedPermit = Buffer.from(canonicalGate6Json(permit)).toString("base64");
          let receipt;
          const atomicLedger = {
            async registerTask9Permit() {
              const permitBinding = verified.permitBinding;
              receipt = await ledger.registerTask9Permit({
                gate6Id: artifacts.envelope.gate6Id,
                scope: artifacts.action.scope,
                actionId: artifacts.action.actionId,
                approvalSha256: artifacts.approvalSha256,
                allowedMutationSha256: artifacts.action.allowedMutationSha256,
                permitId: permitBinding.permitId,
                service: permitBinding.service,
                kind: permitBinding.kind,
                teamId: permitBinding.teamId,
                drillSha256: artifacts.approvalSha256,
                targetSha256: permitBinding.targetSha256,
                fixtureSha256: permitBinding.fixtureSha256,
                signedPermitSha256: permitBinding.signedPermitSha256,
                keyId: permitBinding.keyId,
                expectedCheckerSha256: permitBinding.expectedCheckerSha256,
                expiresAt: permitBinding.expiresAt,
                now,
              });
              return receipt;
            },
            disarmTask9Permit: (...parameters) => ledger.disarmTask9Permit(...parameters),
            completeTask9PermitAction: (...parameters) => ledger.completeTask9PermitAction(...parameters),
          };
          return runProductionTask9({
            action: productionAction(artifacts),
            permit,
            ledger: atomicLedger,
            verifyPermit: async () => verified,
            triggerExactRequest: () => request.trigger(encodedPermit),
            verifyConsumed: async () => receipt && await ledger.getTask9PermitStatus(receipt) === "consumed",
            now,
          });
        },
      });
    }
    process.stdout.write(`${canonicalGate6Json({ ok: true, result })}\n`);
  } catch {
    process.stdout.write('{"code":"production-task9-control-refused","ok":false}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
