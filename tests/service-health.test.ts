import assert from "node:assert/strict";
import {
  buildLineServiceHealthSnapshot,
  buildOcrServiceHealthSnapshot,
  buildServiceReadiness,
  createServiceHealthSnapshot,
  probeHttpServiceHealth,
} from "../src/services/service-health.js";
import { httpSurfaceForRole } from "../src/services/runtime-role.js";

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  assert.ok(signal, "expected readiness probes to carry an abort signal");
  return new Promise((_resolve, reject) => {
    const safetyTimer = setTimeout(() => reject(new Error("probe signal did not abort")), 2500);
    const abort = () => {
      clearTimeout(safetyTimer);
      reject(new Error("OCR service unavailable"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function completeBeforeAbort<T>(
  signal: AbortSignal | null | undefined,
  operation: Promise<T>,
): Promise<T> {
  assert.ok(signal, "expected readiness probes to carry an abort signal");
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("LINE readiness probe timed out"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function testSecretRedaction(): Promise<void> {
  const snapshot = createServiceHealthSnapshot({
    service: "test-service",
    role: "api",
    nodeId: "api-01",
    state: "ok",
    checkedAt: "2026-07-07T00:00:00.000Z",
    details: {
      token: "secret-token",
      nested: {
        password: "secret-password",
        safe: "visible",
      },
    },
  });

  assert.deepEqual(snapshot.details, {
    token: "[redacted]",
    nested: {
      password: "[redacted]",
      safe: "visible",
    },
  });
}

async function testLineStatusClassificationDoesNotLeakQr(): Promise<void> {
  const snapshot = buildLineServiceHealthSnapshot({
    role: "line-service",
    nodeId: "line-01",
    listenerActive: false,
    checkedAt: "2026-07-07T00:00:00.000Z",
    status: {
      enabled: true,
      authenticated: false,
      qrUrl: "https://line.example/secret-qr",
      pincode: "123456",
      message: "Waiting for QR scan",
    },
  });

  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.details.qrRequired, true);
  assert.equal(JSON.stringify(snapshot).includes("secret-qr"), false);
  assert.equal(JSON.stringify(snapshot).includes("123456"), false);
}

async function testOcrStatusClassificationDoesNotExposeTokens(): Promise<void> {
  const snapshot = buildOcrServiceHealthSnapshot({
    role: "ocr-service",
    nodeId: "ocr-01",
    provider: "codex-device",
    model: "gpt-5.5",
    timeoutMs: 300000,
    maxBytes: 10485760,
    checkedAt: "2026-07-07T00:00:00.000Z",
  });

  assert.equal(snapshot.state, "ok");
  assert.deepEqual(snapshot.details, {
    provider: "codex-device",
    modelConfigured: true,
    timeoutMs: 300000,
    maxBytes: 10485760,
  });
}

async function testProbeHttpHealth(): Promise<void> {
  const ok = await probeHttpServiceHealth({
    service: "line-service",
    role: "line-service",
    nodeId: "line-service",
    baseUrl: "https://line.internal.example",
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: async () => new Response(JSON.stringify({ status: "success" }), { status: 200 }),
  });
  assert.equal(ok.state, "ok");
  assert.equal(ok.details.status, 200);

  const down = await probeHttpServiceHealth({
    service: "line-service",
    role: "line-service",
    nodeId: "line-service",
    baseUrl: "https://line.internal.example",
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED token=secret");
    },
  });
  assert.equal(down.state, "down");
  assert.equal(JSON.stringify(down).includes("token=secret"), false);
}

async function testReadinessRules(): Promise<void> {
  const notificationReady = await buildServiceReadiness({
    surface: "notification-service",
    role: "notification-service",
    nodeId: "notification-01",
    lineServiceUrl: "https://line.internal.example",
    lineServiceRequestTimeoutMs: 25,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });
  assert.equal(notificationReady.statusCode, 200);
  assert.equal(notificationReady.data.ready, true);

  const notificationDown = await buildServiceReadiness({
    surface: "notification-service",
    role: "notification-service",
    nodeId: "notification-01",
    lineServiceUrl: "https://line.internal.example",
    lineServiceRequestTimeoutMs: 25,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: async () => {
      throw new Error("line-service down");
    },
  });
  assert.equal(notificationDown.statusCode, 503);
  assert.equal(notificationDown.data.ready, false);
  assert.equal(notificationDown.data.dependencies[0]?.state, "down");

  const notificationDegraded = await buildServiceReadiness({
    surface: "notification-service",
    role: "notification-service",
    nodeId: "notification-01",
    lineServiceUrl: "https://line.internal.example",
    lineServiceRequestTimeoutMs: 25,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: async () => new Response(JSON.stringify({ ready: false }), { status: 503 }),
  });
  assert.equal(notificationDegraded.statusCode, 503);
  assert.equal(notificationDegraded.data.ready, false);
  assert.equal(notificationDegraded.data.state, "degraded");
  assert.equal(notificationDegraded.data.dependencies[0]?.state, "degraded");

  const notificationDbDown = await buildServiceReadiness({
    surface: "notification-service",
    role: "notification-service",
    nodeId: "notification-01",
    lineServiceUrl: "https://line.internal.example",
    lineServiceRequestTimeoutMs: 25,
    databaseReady: false,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });
  assert.equal(notificationDbDown.statusCode, 503);
  assert.equal(notificationDbDown.data.ready, false);
  assert.equal(notificationDbDown.data.state, "down");
  assert.equal(notificationDbDown.data.details.database, "down");

  const webApiWithDownstreamDown = await buildServiceReadiness({
    surface: "web-api",
    role: "api",
    nodeId: "web-01",
    databaseReady: true,
    lineServiceUrl: "https://line.internal.example",
    lineServiceRequestTimeoutMs: 25,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: async () => {
      throw new Error("line-service down");
    },
  });
  assert.equal(webApiWithDownstreamDown.statusCode, 200);
  assert.equal(webApiWithDownstreamDown.data.ready, true);
  assert.equal(webApiWithDownstreamDown.data.dependencies[0]?.state, "down");
}

async function testNestedOptionalOcrTimeoutDoesNotCascadeReadiness(): Promise<void> {
  let observedLineReadiness: Awaited<ReturnType<typeof buildServiceReadiness>> | undefined;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const endpoint = new URL(url);
    if (endpoint.hostname === "ocr.internal.example") {
      return waitForAbort(init.signal);
    }
    if (endpoint.hostname === "line.internal.example" && endpoint.pathname === "/ready") {
      return completeBeforeAbort(
        init.signal,
        (async () => {
          observedLineReadiness = await buildServiceReadiness({
            surface: "line-service",
            role: "line-service",
            nodeId: "line-01",
            ocrServiceUrl: "https://ocr.internal.example",
            ocrServiceRequestTimeoutMs: 10_000,
            checkedAt: "2026-07-07T00:00:00.000Z",
            lineStatus: {
              enabled: true,
              authenticated: true,
              message: "LINE Bot is connected",
            },
            lineImageListenerActive: true,
            fetchImpl,
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          return new Response(JSON.stringify(observedLineReadiness.data), {
            status: observedLineReadiness.statusCode,
          });
        })(),
      );
    }
    throw new Error(`Unexpected readiness endpoint: ${url}`);
  };

  const notificationReadiness = await buildServiceReadiness({
    surface: "notification-service",
    role: "notification-service",
    nodeId: "notification-01",
    lineServiceUrl: "https://line.internal.example",
    lineServiceRequestTimeoutMs: 10_000,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl,
  });

  assert.equal(notificationReadiness.statusCode, 200);
  assert.equal(notificationReadiness.data.ready, true);
  assert.equal(observedLineReadiness?.statusCode, 200);
  assert.equal(observedLineReadiness?.data.ready, true);
  assert.equal(observedLineReadiness?.data.state, "down");
  assert.equal(observedLineReadiness?.data.dependencies[1]?.service, "ocr-service");
  assert.equal(observedLineReadiness?.data.dependencies[1]?.state, "down");

  const webReadiness = await buildServiceReadiness({
    surface: "web-api",
    role: "api",
    nodeId: "web-01",
    databaseReady: true,
    ocrServiceUrl: "https://ocr.internal.example",
    ocrServiceRequestTimeoutMs: 25,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: async () => {
      throw new Error("OCR service unavailable");
    },
  });
  assert.equal(webReadiness.statusCode, 200);
  assert.equal(webReadiness.data.ready, true);
  assert.equal(httpSurfaceForRole("worker"), null);
}

async function main(): Promise<void> {
  await testSecretRedaction();
  await testLineStatusClassificationDoesNotLeakQr();
  await testOcrStatusClassificationDoesNotExposeTokens();
  await testProbeHttpHealth();
  await testReadinessRules();
  await testNestedOptionalOcrTimeoutDoesNotCascadeReadiness();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
