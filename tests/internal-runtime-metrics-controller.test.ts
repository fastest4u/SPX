process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "internal-runtime-metrics-controller-test-key";

import assert from "node:assert/strict";
import Fastify from "fastify";
import { internalNotificationController } from "../src/controllers/internal-notification-controller.js";
import { MetricsCollector } from "../src/services/metrics.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import {
  clearRuntimeMetricsSnapshots,
  runtimeMetricsSnapshotFor,
} from "../src/services/runtime-metrics.js";

const sharedSecret = "runtime-metrics-secret";
const nodeId = "prod-worker-ifn-1";
const internalPath = "/internal/runtime-metrics";

function signRuntimeMetricsBody(body: string, timestamp: string, signingNodeId = nodeId): string {
  return createInternalSignature({
    body,
    timestamp,
    nodeId: signingNodeId,
    path: internalPath,
    secret: sharedSecret,
  });
}

async function main(): Promise<void> {
  clearRuntimeMetricsSnapshots();

  const collector = new MetricsCollector({ teamId: 2, teamName: "IFN" });
  collector.recordPoll(95, true, "same", 10);
  collector.recordOperation("acceptRtt", 130);
  const snapshot = collector.snapshot();
  const body = JSON.stringify(snapshot);
  const timestamp = new Date().toISOString();

  const app = Fastify({ logger: false });
  try {
    await app.register(internalNotificationController, {
      prefix: "/internal",
      sharedSecret,
      allowedNodes: new Map([[nodeId, new Set([2])]]),
    });
    await app.ready();

    const unsignedResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-metrics",
      headers: {
        "content-type": "application/json",
        "x-spx-node-id": nodeId,
        "x-spx-timestamp": timestamp,
      },
      payload: body,
    });
    assert.equal(unsignedResponse.statusCode, 401);
    assert.equal(runtimeMetricsSnapshotFor(new MetricsCollector().snapshot(), 2).polling.totalRequests, 0);

    const forbiddenResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-metrics",
      headers: {
        "content-type": "application/json",
        "x-spx-node-id": "prod-worker-ptwl-1",
        "x-spx-timestamp": timestamp,
        "x-spx-signature": signRuntimeMetricsBody(body, timestamp, "prod-worker-ptwl-1"),
      },
      payload: body,
    });
    assert.equal(forbiddenResponse.statusCode, 403);
    assert.equal(runtimeMetricsSnapshotFor(new MetricsCollector().snapshot(), 2).polling.totalRequests, 0);

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-metrics",
      headers: {
        "content-type": "application/json",
        "x-spx-node-id": nodeId,
        "x-spx-timestamp": timestamp,
        "x-spx-signature": signRuntimeMetricsBody(body, timestamp),
      },
      payload: body,
    });

    const responseBody = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(responseBody.status, "success");
    assert.equal(responseBody.data.teamId, 2);
    assert.equal(responseBody.data.nodeId, nodeId);

    const stored = runtimeMetricsSnapshotFor(new MetricsCollector().snapshot(), 2);
    assert.equal(stored.teamId, 2);
    assert.equal(stored.polling.totalRequests, 1);
    assert.equal(stored.operations.acceptRtt.avg, 130);
  } finally {
    await app.close();
    clearRuntimeMetricsSnapshots();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
