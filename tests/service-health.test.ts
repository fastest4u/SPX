import assert from "node:assert/strict";
import {
  buildLineServiceHealthSnapshot,
  buildOcrServiceHealthSnapshot,
  buildServiceReadiness,
  createServiceHealthSnapshot,
  probeHttpServiceHealth,
} from "../src/services/service-health.js";

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

async function main(): Promise<void> {
  await testSecretRedaction();
  await testLineStatusClassificationDoesNotLeakQr();
  await testOcrStatusClassificationDoesNotExposeTokens();
  await testProbeHttpHealth();
  await testReadinessRules();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
