import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInternalSignature } from "../src/services/internal-auth.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceCheckerPath = resolve(repoRoot, "scripts", "service-fault-evidence-check.mjs");
const confirmation = "I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER";
const sharedSecret = "test-ocr-shared-secret-must-not-print";
const drillId = "split-service-fault-drill-20260710-1409";
const nodeId = "prod-line-service-1";
const ocrPath = "/internal/ocr/line-image";
const fixtureSha256 = "cdf7dcb00ca85d93e950cba10ac707c6e27c1dca828673512831454fbd53f73c";

type ProbeOutput = Record<string, unknown>;
type ProbeRunResult = { exitCode: number; output: string | ProbeOutput };
type ProbeRunner = (input: {
  argv?: string[];
  env: Record<string, string>;
  dependencies: {
    fetch: typeof fetch;
    now: () => Date;
    resolveNodeSecret: () => Promise<string>;
    preflightStatePath: (drillId: string) => string;
  };
}) => Promise<ProbeRunResult>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function env(expectation: "preflight" | "down" | "up", overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: "production",
    TASK9_EXPECT: expectation,
    TASK9_DRILL_ID: drillId,
    TASK9_CONFIRM_SYNTHETIC_OCR: confirmation,
    SPX_ROLE: "line-service",
    SPX_NODE_ID: nodeId,
    OCR_SERVICE_URL: "http://ocr-service:3004",
    OCR_SERVICE_REQUEST_TIMEOUT_MS: "305000",
    HTTP_PORT: "3003",
    ...overrides,
  };
}

function runEvidenceChecker(evidence: Record<string, unknown>, preloadPath: string): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [evidenceCheckerPath, `--fixture-json=${JSON.stringify(evidence)}`],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadPath).href}`.trim(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("exit", (status) => resolveRun({ status, stdout, stderr }));
  });
}

async function main() {
  const probeModule = (await import("../scripts/service-fault-ocr-boundary-probe.mjs")) as {
    runOcrBoundaryProbe?: ProbeRunner;
  };
  assert.equal(typeof probeModule.runOcrBoundaryProbe, "function");
  const runOcrBoundaryProbe = probeModule.runOcrBoundaryProbe as ProbeRunner;

  const tempRoot = await mkdtemp(resolve(tmpdir(), "spx-ocr-boundary-live-"));
  const preloadPath = resolve(tempRoot, "allow-unbound-evidence.mjs");
  await writeFile(preloadPath, "globalThis.__SPX_TEST_ALLOW_UNBOUND_EVIDENCE__ = true;\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  let nowMs = Date.parse("2026-07-10T08:07:30.000Z");
  let mode: "success" | "outage" | "malicious" = "success";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, init });
    if (url === "http://ocr-service:3004/internal/ocr/line-image") {
      if (mode === "outage") {
        return new Response(
          JSON.stringify({ rawResponse: "provider-outage-secret-must-not-print" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      if (mode === "malicious") {
        return new Response(
          JSON.stringify({
            status: "success",
            data: {
              text: "provider-text-must-not-print",
              validation: { ok: false, reason: "provider-secret-reason-must-not-print" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          status: "success",
          data: { text: "synthetic OCR result", validation: { ok: true } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "http://127.0.0.1:3003/health") return new Response("ok", { status: 200 });
    if (url === "http://127.0.0.1:3003/ready") {
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            ready: true,
            dependencies: [{ service: "ocr-service", state: mode === "outage" ? "down" : "ok" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const dependencies = {
    fetch: fetchMock,
    now: () => new Date(nowMs),
    resolveNodeSecret: async () => sharedSecret,
    preflightStatePath: (value: string) => resolve(tempRoot, `${sha256(value)}.json`),
  };

  try {
    const preflight = await runOcrBoundaryProbe({ env: env("preflight"), dependencies });
    assert.equal(preflight.exitCode, 0);
    assert.equal(typeof preflight.output, "object");
    const preflightOutput = preflight.output as ProbeOutput;
    assert.equal(preflightOutput.ok, true);
    assert.equal(preflightOutput.evidenceType, "ocr-preflight");
    assert.equal(preflightOutput.fixtureSha256, fixtureSha256);
    assert.equal(preflightOutput.boundaryStatus, "validated-success");
    assert.equal(preflightOutput.httpStatus, 200);
    assert.equal("validationClass" in preflightOutput, false);

    const ocrRequest = requests.find((request) => request.url.includes("/internal/ocr/line-image"));
    assert.ok(ocrRequest?.init);
    const body = String(ocrRequest.init.body);
    const headers = new Headers(ocrRequest.init.headers);
    const timestamp = headers.get("x-spx-timestamp");
    const requestId = headers.get("x-spx-request-id");
    assert.equal(headers.get("x-spx-node-id"), nodeId);
    assert.equal(typeof timestamp, "string");
    assert.equal(typeof requestId, "string");
    assert.match(requestId as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(
      headers.get("x-spx-signature"),
      createInternalSignature({
        body,
        timestamp: timestamp as string,
        nodeId,
        path: ocrPath,
        secret: sharedSecret,
        requestId: requestId as string,
        nodeEnvironment: "production",
      }),
    );
    assert.notEqual(
      headers.get("x-spx-signature"),
      createInternalSignature({
        body,
        timestamp: timestamp as string,
        nodeId,
        path: ocrPath,
        secret: sharedSecret,
        requestId: requestId as string,
        nodeEnvironment: "test",
      }),
    );
    const requestBody = JSON.parse(body);
    assert.equal(requestBody.mimeType, "image/png");
    assert.equal(sha256(Buffer.from(requestBody.imageBase64, "base64")), fixtureSha256);
    assert.match(requestBody.traceId, new RegExp(`^fault-drill:${drillId}:ocr:[a-f0-9]{64}$`));
    assert.doesNotMatch(JSON.stringify(preflightOutput), /imageBase64|synthetic OCR result|test-ocr-shared-secret/);

    mode = "malicious";
    nowMs = Date.parse("2026-07-10T08:07:40.000Z");
    const malicious = await runOcrBoundaryProbe({
      env: env("preflight", { TASK9_DRILL_ID: `${drillId}-malicious` }),
      dependencies,
    });
    assert.equal(malicious.exitCode, 1);
    assert.equal((malicious.output as ProbeOutput).failureCode, "preflight_ocr_not_validated");
    assert.equal("validationClass" in (malicious.output as ProbeOutput), false);
    assert.doesNotMatch(
      JSON.stringify(malicious.output),
      /provider-secret-reason|provider-text|test-ocr-shared-secret/,
    );

    mode = "outage";
    nowMs = Date.parse("2026-07-10T08:09:00.000Z");
    const downRequestStart = requests.length;
    const down = await runOcrBoundaryProbe({ env: env("down"), dependencies });
    assert.equal(down.exitCode, 0);
    const downOutput = down.output as ProbeOutput;
    assert.equal(downOutput.evidenceType, "ocr-failure-observed");
    assert.equal(downOutput.boundaryStatus, "retryable-failure-observed");
    assert.equal(downOutput.httpStatus, 503);
    assert.deepEqual(
      requests.slice(downRequestStart).map((request) => request.url),
      [
        "http://ocr-service:3004/internal/ocr/line-image",
        "http://127.0.0.1:3003/health",
        "http://127.0.0.1:3003/ready",
      ],
    );
    assert.doesNotMatch(JSON.stringify(downOutput), /rawResponse|provider-outage-secret/);

    mode = "success";
    nowMs = Date.parse("2026-07-10T08:10:00.000Z");
    const up = await runOcrBoundaryProbe({ env: env("up"), dependencies });
    assert.equal(up.exitCode, 0);
    const upOutput = up.output as ProbeOutput;
    assert.equal(upOutput.evidenceType, "ocr-recovery-observed");
    assert.equal(upOutput.boundaryStatus, "validated-success");
    assert.equal(upOutput.httpStatus, 200);

    const transportRequestIds = requests
      .filter((request) => request.url === "http://ocr-service:3004/internal/ocr/line-image")
      .map((request) => new Headers(request.init?.headers).get("x-spx-request-id"));
    assert.equal(transportRequestIds.every((value) => typeof value === "string"), true);
    assert.equal(new Set(transportRequestIds).size, transportRequestIds.length);

    const requestCountBeforeMismatch = requests.length;
    const mismatchedNode = await runOcrBoundaryProbe({
      env: env("down", { SPX_NODE_ID: "prod-line-service-2" }),
      dependencies,
    });
    assert.equal(mismatchedNode.exitCode, 1);
    assert.equal((mismatchedNode.output as ProbeOutput).failureCode, "preflight_required");
    assert.equal(requests.length, requestCountBeforeMismatch);

    nowMs = Date.parse("2026-07-10T08:37:30.001Z");
    const stale = await runOcrBoundaryProbe({ env: env("up"), dependencies });
    assert.equal(stale.exitCode, 1);
    assert.equal((stale.output as ProbeOutput).failureCode, "preflight_required");
    assert.equal(requests.length, requestCountBeforeMismatch);

    const compatibility = await runEvidenceChecker(
      {
        drillId,
        ocrPreflight: preflightOutput,
        ocrFailureObserved: downOutput,
        ocrRecoveryObserved: upOutput,
      },
      preloadPath,
    );
    assert.equal(compatibility.status, 1, compatibility.stderr || compatibility.stdout);
    const compatibilityOutput = JSON.parse(compatibility.stdout);
    assert.ok(Array.isArray(compatibilityOutput.failedChecks), compatibility.stdout);
    assert.equal(compatibilityOutput.failedChecks.includes("ocrPreflight"), false);
    assert.equal(compatibilityOutput.failedChecks.includes("ocrFailureObserved"), false);
    assert.equal(compatibilityOutput.failedChecks.includes("ocrRecoveryObserved"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
