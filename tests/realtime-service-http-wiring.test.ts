process.env.DB_MODE = "memory";
process.env.NODE_ENV = "test";
process.env.SECRETS_KEY = "realtime-service-http-wiring-test-key";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { env } from "../src/config/env.js";
import { createHttpServer } from "../src/services/http-server.js";
import { createInternalSignature, type NodeSecretKeyRing } from "../src/services/internal-auth.js";
import type { RealtimePublisher } from "../src/services/realtime-contract.js";

const clusterSharedSecret = "realtime-service-cluster-secret-must-not-verify-inbound";
const adminSecret = "realtime-service-admin-node-secret";
const workerSecret = "realtime-service-worker-node-secret";
const adminNodeId = "web-api-01";
const workerNodeId = "poller-02";

function signedHeaders(path: string, body: string, nodeId: string, secret: string, eventKey?: string) {
  const timestamp = new Date().toISOString();
  const requestId = `realtime-http-${randomUUID()}`;
  return {
    "content-type": "application/json",
    ...(eventKey ? { "idempotency-key": eventKey } : {}),
    "x-spx-node-id": nodeId,
    "x-spx-request-id": requestId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body,
      timestamp,
      nodeId,
      path,
      secret,
      eventKey,
      requestId,
    }),
  };
}

async function main(): Promise<void> {
  const original = {
    sharedSecret: env.REALTIME_SHARED_SECRET,
    trusted: env.REALTIME_TRUSTED_NODE_IDS,
    admin: env.REALTIME_ADMIN_NODE_IDS,
    allowed: env.REALTIME_ALLOWED_NODE_TEAMS,
    nodeSecrets: env.REALTIME_NODE_SECRETS,
  };
  const mutableEnv = env as typeof env & {
    REALTIME_SHARED_SECRET: string;
    REALTIME_TRUSTED_NODE_IDS: Set<string>;
    REALTIME_ADMIN_NODE_IDS: Set<string>;
    REALTIME_ALLOWED_NODE_TEAMS: Map<string, Set<number>>;
    REALTIME_NODE_SECRETS: ReadonlyMap<string, NodeSecretKeyRing>;
  };
  mutableEnv.REALTIME_SHARED_SECRET = clusterSharedSecret;
  mutableEnv.REALTIME_TRUSTED_NODE_IDS = new Set([adminNodeId, workerNodeId]);
  mutableEnv.REALTIME_ADMIN_NODE_IDS = new Set([adminNodeId]);
  mutableEnv.REALTIME_ALLOWED_NODE_TEAMS = new Map([[workerNodeId, new Set([2])]]);
  mutableEnv.REALTIME_NODE_SECRETS = new Map([
    [adminNodeId, { active: adminSecret }],
    [workerNodeId, { active: workerSecret }],
  ]);

  const published: unknown[] = [];
  const publisher: RealtimePublisher = {
    async publish(input) {
      published.push(input);
      return {
        accepted: true,
        duplicate: false,
        id: input.idempotencyKey ?? "event-1",
        receivedAt: "2030-01-01T00:00:00.000Z",
        persisted: true,
      };
    },
    async publishSnapshot(input) {
      return this.publish(input);
    },
  };

  const app = await createHttpServer({
    surface: "realtime-service",
    role: "realtime-service",
    runtimeMetricsRealtimePublisher: publisher,
    loadRealtimeRuntimeStatus: async (scope) => ({ scope, service: "realtime-service" }),
  });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/ready" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/settings" })).statusCode, 404);
    assert.equal(
      (await app.inject({ method: "POST", url: "/internal/notification-events", payload: {} })).statusCode,
      404,
    );

    const eventPath = "/internal/realtime/events";
    const eventKey = "runtime:node:poller-02";
    const eventBody = JSON.stringify({
      type: "runtime.node.changed",
      payloadVersion: 1,
      payload: { state: "fresh" },
      source: { service: "poller-service", nodeId: workerNodeId, role: "poller-service" },
      scope: { kind: "team", teamId: 2 },
      replayable: true,
      idempotencyKey: eventKey,
    });
    const accepted = await app.inject({
      method: "POST",
      url: eventPath,
      headers: signedHeaders(eventPath, eventBody, workerNodeId, workerSecret, eventKey),
      payload: eventBody,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(published.length, 1);

    const dashboardSnapshotBody = JSON.stringify({
      type: "metrics.snapshot",
      payloadVersion: 1,
      payload: { polling: { totalRequests: 12 } },
      source: { service: "web-api", nodeId: adminNodeId, role: "web-api" },
      scope: { kind: "team", teamId: 2 },
      subject: { type: "team", id: "2", teamId: 2 },
      replayable: false,
    });
    const dashboardSnapshot = await app.inject({
      method: "POST",
      url: eventPath,
      headers: signedHeaders(eventPath, dashboardSnapshotBody, adminNodeId, adminSecret),
      payload: dashboardSnapshotBody,
    });
    assert.equal(
      dashboardSnapshot.statusCode,
      200,
      "configured admin publishers must be able to publish team-scoped dashboard snapshots",
    );
    assert.equal(published.length, 2);

    const forbiddenWorkerEventKey = "runtime:node:poller-02:team-3";
    const forbiddenWorkerBody = JSON.stringify({
      type: "runtime.node.changed",
      payloadVersion: 1,
      payload: { state: "fresh" },
      source: { service: "poller-service", nodeId: workerNodeId, role: "poller-service" },
      scope: { kind: "team", teamId: 3 },
      replayable: true,
      idempotencyKey: forbiddenWorkerEventKey,
    });
    const forbiddenWorkerPublish = await app.inject({
      method: "POST",
      url: eventPath,
      headers: signedHeaders(
        eventPath,
        forbiddenWorkerBody,
        workerNodeId,
        workerSecret,
        forbiddenWorkerEventKey,
      ),
      payload: forbiddenWorkerBody,
    });
    assert.equal(forbiddenWorkerPublish.statusCode, 403);
    assert.equal(published.length, 2);

    const untrustedNodeId = "untrusted-03";
    const untrustedBody = JSON.stringify({
      type: "runtime.node.changed",
      payloadVersion: 1,
      payload: { state: "fresh" },
      source: { service: "worker", nodeId: untrustedNodeId, role: "worker" },
      scope: { kind: "team", teamId: 2 },
      replayable: false,
    });
    const untrustedPublish = await app.inject({
      method: "POST",
      url: eventPath,
      headers: signedHeaders(
        eventPath,
        untrustedBody,
        untrustedNodeId,
        "untrusted-node-secret",
      ),
      payload: untrustedBody,
    });
    assert.equal(untrustedPublish.statusCode, 401);
    assert.equal(published.length, 2);

    const metricsPath = "/internal/realtime/read-models/metrics";
    const metricsBody = JSON.stringify({ scope: { kind: "admin" } });
    const metrics = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, metricsBody, adminNodeId, adminSecret),
      payload: metricsBody,
    });
    assert.equal(metrics.statusCode, 200, metrics.body);

    const statusPath = "/internal/realtime/read-models/runtime-status";
    const statusBody = JSON.stringify({ scope: { kind: "admin" } });
    const status = await app.inject({
      method: "POST",
      url: statusPath,
      headers: signedHeaders(statusPath, statusBody, adminNodeId, adminSecret),
      payload: statusBody,
    });
    assert.equal(status.statusCode, 200, status.body);
    assert.deepEqual(status.json().data, {
      scope: { kind: "admin" },
      service: "realtime-service",
    });

    const forbiddenTeamBody = JSON.stringify({ scope: { kind: "team", teamId: 3 } });
    const forbiddenTeam = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, forbiddenTeamBody, workerNodeId, workerSecret),
      payload: forbiddenTeamBody,
    });
    assert.equal(forbiddenTeam.statusCode, 403);

    const impersonatedAdmin = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, metricsBody, adminNodeId, workerSecret),
      payload: metricsBody,
    });
    assert.equal(impersonatedAdmin.statusCode, 401);

    const oldClusterSecret = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, metricsBody, adminNodeId, clusterSharedSecret),
      payload: metricsBody,
    });
    assert.equal(
      oldClusterSecret.statusCode,
      401,
      "realtime-service must never accept the cluster-wide outbound secret for inbound authentication",
    );
  } finally {
    await app.close();
    mutableEnv.REALTIME_SHARED_SECRET = original.sharedSecret;
    mutableEnv.REALTIME_TRUSTED_NODE_IDS = original.trusted;
    mutableEnv.REALTIME_ADMIN_NODE_IDS = original.admin;
    mutableEnv.REALTIME_ALLOWED_NODE_TEAMS = original.allowed;
    mutableEnv.REALTIME_NODE_SECRETS = original.nodeSecrets;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
