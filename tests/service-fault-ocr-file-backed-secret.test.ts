import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInternalSignature } from "../src/services/internal-auth.js";

const confirmation = "I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER";
const nodeId = "file-backed-line-service";
const secret = "file-backed-ocr-signing-value-must-not-print";
const ocrPath = "/internal/ocr/line-image";

type ProbeResult = { exitCode: number; output: string | Record<string, unknown> };
type ProbeRunner = (input: {
  argv?: string[];
  env: Record<string, string>;
  dependencies: {
    fetch: typeof fetch;
    now: () => Date;
    preflightStatePath: (drillId: string) => string;
  };
}) => Promise<ProbeResult>;

function probeEnv(drillId: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "production",
    TASK9_EXPECT: "preflight",
    TASK9_DRILL_ID: drillId,
    TASK9_CONFIRM_SYNTHETIC_OCR: confirmation,
    SPX_ROLE: "line-service",
    SPX_NODE_ID: nodeId,
    OCR_SERVICE_URL: "http://ocr-service:3004",
    OCR_SERVICE_REQUEST_TIMEOUT_MS: "305000",
    HTTP_PORT: "3003",
    OCR_NODE_SECRET: "",
    OCR_NODE_SECRET_FILE: "",
    NOTIFIER_SHARED_SECRET: "",
    NOTIFIER_SHARED_SECRET_FILE: "",
    ...overrides,
  };
}

async function main(): Promise<void> {
  const { runOcrBoundaryProbe } =
    (await import("../scripts/service-fault-ocr-boundary-probe.mjs")) as {
      runOcrBoundaryProbe: ProbeRunner;
    };
  const temp = await mkdtemp(resolve(tmpdir(), "spx-ocr-file-secret-"));
  const secretPath = resolve(temp, "node-signing-value");
  const legacySecretPath = resolve(temp, "legacy-signing-value");
  await writeFile(secretPath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(legacySecretPath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });

  let requestCount = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    requestCount += 1;
    assert.equal(String(input), "http://ocr-service:3004/internal/ocr/line-image");
    const body = String(init?.body);
    const headers = new Headers(init?.headers);
    const timestamp = headers.get("x-spx-timestamp");
    const requestId = headers.get("x-spx-request-id");
    assert.equal(typeof timestamp, "string");
    assert.equal(typeof requestId, "string");
    assert.equal(headers.get("x-spx-node-id"), nodeId);
    assert.equal(
      headers.get("x-spx-signature"),
      createInternalSignature({
        body,
        timestamp: timestamp as string,
        nodeId,
        path: ocrPath,
        secret,
        requestId: requestId as string,
        nodeEnvironment: "production",
      }),
    );
    return new Response(
      JSON.stringify({
        status: "success",
        data: { text: "synthetic result", validation: { ok: true } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const dependencies = {
    fetch: fetchMock,
    now: () => new Date("2026-07-10T08:07:30.000Z"),
    preflightStatePath: (drillId: string) => resolve(temp, `${drillId}.json`),
  };

  try {
    const fileBacked = await runOcrBoundaryProbe({
      env: probeEnv("ocr-file-backed", { OCR_NODE_SECRET_FILE: secretPath }),
      dependencies,
    });
    assert.equal(fileBacked.exitCode, 0);
    assert.equal((fileBacked.output as Record<string, unknown>).ok, true);
    assert.equal(requestCount, 1);
    assert.equal(JSON.stringify(fileBacked.output).includes(secretPath), false);
    assert.doesNotMatch(JSON.stringify(fileBacked.output), /OCR_NODE_SECRET|must-not-print/);

    const conflicting = await runOcrBoundaryProbe({
      env: probeEnv("ocr-file-conflict", {
        OCR_NODE_SECRET: secret,
        OCR_NODE_SECRET_FILE: secretPath,
      }),
      dependencies,
    });
    assert.equal(conflicting.exitCode, 1);
    assert.equal(
      (conflicting.output as Record<string, unknown>).failureCode,
      "node_secret_unavailable",
    );
    assert.equal(requestCount, 1);
    assert.equal(JSON.stringify(conflicting.output).includes(secretPath), false);
    assert.doesNotMatch(JSON.stringify(conflicting.output), /OCR_NODE_SECRET|must-not-print/);

    const productionLegacyOnly = await runOcrBoundaryProbe({
      env: probeEnv("ocr-legacy-rejected", {
        NOTIFIER_SHARED_SECRET_FILE: legacySecretPath,
      }),
      dependencies,
    });
    assert.equal(productionLegacyOnly.exitCode, 1);
    assert.equal(
      (productionLegacyOnly.output as Record<string, unknown>).failureCode,
      "node_secret_unavailable",
    );
    assert.equal(requestCount, 1);
    assert.equal(JSON.stringify(productionLegacyOnly.output).includes(legacySecretPath), false);
    assert.doesNotMatch(
      JSON.stringify(productionLegacyOnly.output),
      /NOTIFIER_SHARED_SECRET|must-not-print/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log("service-fault-ocr-file-backed-secret: signing and redaction verified"))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
