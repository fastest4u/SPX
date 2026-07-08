import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  claimNotificationOutboxBatch,
  createNotificationEventAndOutbox,
} from "../src/repositories/notification-repository.js";
import { runNotificationDispatchOnce } from "../src/services/notification-dispatcher.js";
import { createNotificationLineSender } from "../src/services/notification-line-sender.js";
import { buildServiceReadiness } from "../src/services/service-health.js";

function buildEvent() {
  return {
    eventKey: "auto_accept_owned:team:2:booking:2791810:req:fault-isolation",
    schemaVersion: 1 as const,
    eventType: "auto_accept_result" as const,
    severity: "success" as const,
    teamId: 2,
    workerNodeId: "worker-ifn-01",
    traceId: "fault-trace-1",
    subjectType: "booking",
    subjectId: "2791810",
    payload: {
      schemaVersion: 1 as const,
      eventType: "auto_accept_result" as const,
      severity: "success" as const,
      teamId: 2,
      teamName: "IFN",
      bookingId: "2791810",
      requestIds: ["40288114"],
      status: "owned" as const,
      message: "accepted",
      occurredAt: new Date().toISOString(),
    },
  };
}

async function resetDb(): Promise<void> {
  await closePool();
  resetMemoryDb();
}

async function testReadinessIsolationRules(): Promise<void> {
  const downstreamFailure = async () => {
    throw new Error("line-service down token=secret");
  };

  const webApi = await buildServiceReadiness({
    surface: "web-api",
    role: "api",
    nodeId: "web-api-01",
    databaseReady: true,
    lineServiceUrl: "http://line-service.internal",
    ocrServiceUrl: "http://ocr-service.internal",
    lineServiceRequestTimeoutMs: 25,
    ocrServiceRequestTimeoutMs: 25,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: downstreamFailure,
  });

  assert.equal(webApi.statusCode, 200);
  assert.equal(webApi.data.ready, true);
  assert.equal(webApi.data.dependencies.length, 2);
  assert.equal(
    webApi.data.dependencies.every((item) => item.state === "down"),
    true,
  );
  assert.equal(JSON.stringify(webApi).includes("token=secret"), false);

  const notificationService = await buildServiceReadiness({
    surface: "notification-service",
    role: "notification-service",
    nodeId: "notification-service-01",
    lineServiceUrl: "http://line-service.internal",
    lineServiceRequestTimeoutMs: 25,
    checkedAt: "2026-07-07T00:00:00.000Z",
    fetchImpl: downstreamFailure,
  });

  assert.equal(notificationService.statusCode, 503);
  assert.equal(notificationService.data.ready, false);
  assert.equal(notificationService.data.dependencies[0]?.service, "line-service");
  assert.equal(notificationService.data.dependencies[0]?.state, "down");

  const lineService = await buildServiceReadiness({
    surface: "line-service",
    role: "line-service",
    nodeId: "line-service-01",
    ocrServiceUrl: "http://ocr-service.internal",
    ocrServiceRequestTimeoutMs: 25,
    checkedAt: "2026-07-07T00:00:00.000Z",
    lineStatus: {
      enabled: true,
      authenticated: true,
      message: "LINE Bot is connected",
    },
    lineImageListenerActive: true,
    fetchImpl: downstreamFailure,
  });

  assert.equal(lineService.statusCode, 200);
  assert.equal(lineService.data.ready, true);
  assert.equal(lineService.data.state, "down");
  assert.equal(
    lineService.data.dependencies.some(
      (item) => item.service === "ocr-service" && item.state === "down",
    ),
    true,
  );
}

async function testNotificationOutboxRetriesWhenRemoteLineServiceIsUnreachable(): Promise<void> {
  await resetDb();
  await createNotificationEventAndOutbox(buildEvent(), {
    targetType: "line_group",
    targetId: "C123",
    title: "success",
    message: "accepted",
  });

  const sender = createNotificationLineSender({
    lineServiceUrl: "http://127.0.0.1:9",
    sharedSecret: "test-shared-secret",
    nodeId: "notification-service-01",
    requestTimeoutMs: 50,
    allowLocalFallback: false,
  });

  const result = await runNotificationDispatchOnce({
    nodeId: "notification-service-01",
    batchSize: 5,
    lockMs: 30_000,
    sendLineMessage: sender,
  });

  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 1 });

  const retryableRows = await claimNotificationOutboxBatch(
    "retry-worker-01",
    5,
    30_000,
    new Date(Date.now() + 3_000),
  );
  assert.equal(retryableRows.length, 1);
  assert.equal(retryableRows[0].attempts, 1);
  assert.match(retryableRows[0].lastError ?? "", /fetch failed|ECONNREFUSED|bad port/i);
}

async function main(): Promise<void> {
  await testReadinessIsolationRules();
  await testNotificationOutboxRetriesWhenRemoteLineServiceIsUnreachable();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await closePool();
  });
