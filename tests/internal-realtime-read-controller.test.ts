process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "internal-realtime-read-test-key";

import assert from "node:assert/strict";
import Fastify from "fastify";
import { internalRealtimeReadController } from "../src/controllers/internal-realtime-read-controller.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import { MetricsCollector } from "../src/services/metrics.js";
import type { RuntimeMetricsRecord } from "../src/services/runtime-metrics.js";
import { SseBroadcaster } from "../src/services/sse.js";

const sharedSecret = "s".repeat(32);
const adminNodeId = "web-api-1";
const teamNodeId = "team-proxy-2";

let requestSequence = 0;

function signedHeaders(
  path: string,
  body: string,
  nodeId: string,
  secret = sharedSecret,
  requestId = `realtime-read-${++requestSequence}`,
): Record<string, string> {
  const timestamp = new Date().toISOString();
  return {
    "content-type": "application/json",
    "x-spx-node-id": nodeId,
    "x-spx-request-id": requestId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({ body, timestamp, nodeId, path, secret, requestId }),
  };
}

function snapshot(teamId: number, requests: number) {
  const collector = new MetricsCollector({ teamId, teamName: `Team ${teamId}` });
  for (let index = 0; index < requests; index += 1) collector.recordPoll(50, true, "same", 1);
  return collector.snapshot();
}

const now = Date.parse("2030-01-01T00:00:00.000Z");
const metricRecords: RuntimeMetricsRecord[] = [2, 3].map((teamId) => ({
  teamId,
  nodeId: `worker-${teamId}`,
  emittedAt: now - 2_000,
  receivedAt: now - 1_000,
  updatedAt: now - 500,
  snapshot: snapshot(teamId, teamId),
}));

async function main(): Promise<void> {
  const historyCalls: Array<{ limit: number; teamId?: number }> = [];
  const runtimeScopes: unknown[] = [];
  const app = Fastify({ logger: false });
  await app.register(internalRealtimeReadController, {
    prefix: "/internal/realtime",
    sharedSecret,
    trustedNodeIds: new Set([adminNodeId, teamNodeId]),
    adminNodeIds: new Set([adminNodeId]),
    allowedNodeTeams: new Map([[teamNodeId, new Set([2])]]),
    listMetricsRecords: async () => metricRecords,
    listExpectedTeamIds: async () => [2, 3],
    listMetricsHistory: async (input) => {
      historyCalls.push(input);
      return [{ teamId: input.teamId ?? null, totalRequests: 7 }];
    },
    loadRuntimeStatus: async (scope) => {
      runtimeScopes.push(scope);
      return { scope, ok: true };
    },
    now: () => new Date(now),
  });
  await app.ready();

  try {
    const metricsPath = "/internal/realtime/read-models/metrics";
    const teamBody = JSON.stringify({ scope: { kind: "team", teamId: 2 } });
    const teamResponse = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, teamBody, teamNodeId),
      payload: teamBody,
    });
    assert.equal(teamResponse.statusCode, 200);
    assert.equal(teamResponse.json().data.metrics.teamId, 2);
    assert.equal(teamResponse.json().data.metrics.polling.totalRequests, 2);

    const replayHeaders = signedHeaders(
      metricsPath,
      teamBody,
      teamNodeId,
      sharedSecret,
      "realtime-read-replayed-request",
    );
    const replayFirst = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: replayHeaders,
      payload: teamBody,
    });
    assert.equal(replayFirst.statusCode, 200);
    const replaySecond = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: replayHeaders,
      payload: teamBody,
    });
    assert.equal(replaySecond.statusCode, 409);
    assert.equal(replaySecond.json().error_code, "INTERNAL_REQUEST_REPLAYED");

    const tamperedBody = JSON.stringify({ scope: { kind: "team", teamId: 3 } });
    const tampered = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, teamBody, teamNodeId),
      payload: tamperedBody,
    });
    assert.equal(tampered.statusCode, 401, "signature must bind the exact scope body");

    const forbiddenTeam = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, tamperedBody, teamNodeId),
      payload: tamperedBody,
    });
    assert.equal(forbiddenTeam.statusCode, 403);

    const untrusted = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, teamBody, "unknown-node"),
      payload: teamBody,
    });
    assert.equal(untrusted.statusCode, 403);

    const adminBody = JSON.stringify({ scope: { kind: "admin" } });
    const adminMetrics = await app.inject({
      method: "POST",
      url: metricsPath,
      headers: signedHeaders(metricsPath, adminBody, adminNodeId),
      payload: adminBody,
    });
    assert.equal(adminMetrics.statusCode, 200);
    assert.equal(adminMetrics.json().data.metrics.polling.totalRequests, 5);

    const historyPath = "/internal/realtime/read-models/metrics-history";
    const historyBody = JSON.stringify({ scope: { kind: "team", teamId: 2 }, limit: 25 });
    const historyResponse = await app.inject({
      method: "POST",
      url: historyPath,
      headers: signedHeaders(historyPath, historyBody, teamNodeId),
      payload: historyBody,
    });
    assert.equal(historyResponse.statusCode, 200);
    assert.deepEqual(historyCalls, [{ limit: 25, teamId: 2 }]);
    assert.equal(historyResponse.json().data[0].teamId, 2);

    const oversizedHistoryBody = JSON.stringify({ scope: { kind: "team", teamId: 2 }, limit: 501 });
    const oversizedHistory = await app.inject({
      method: "POST",
      url: historyPath,
      headers: signedHeaders(historyPath, oversizedHistoryBody, teamNodeId),
      payload: oversizedHistoryBody,
    });
    assert.equal(oversizedHistory.statusCode, 400);

    const runtimePath = "/internal/realtime/read-models/runtime-status";
    const forbiddenRuntime = await app.inject({
      method: "POST",
      url: runtimePath,
      headers: signedHeaders(runtimePath, teamBody, teamNodeId),
      payload: teamBody,
    });
    assert.equal(forbiddenRuntime.statusCode, 403);
    const runtimeResponse = await app.inject({
      method: "POST",
      url: runtimePath,
      headers: signedHeaders(runtimePath, adminBody, adminNodeId),
      payload: adminBody,
    });
    assert.equal(runtimeResponse.statusCode, 200);
    assert.deepEqual(runtimeScopes, [{ kind: "admin" }]);
  } finally {
    await app.close();
  }

  const preflightApp = Fastify({ logger: false });
  await preflightApp.register(internalRealtimeReadController, {
    prefix: "/internal/realtime",
    sharedSecret,
    trustedNodeIds: new Set([adminNodeId]),
    adminNodeIds: new Set([adminNodeId]),
    allowedNodeTeams: new Map(),
    listMetricsRecords: async () => [],
    listExpectedTeamIds: async () => [],
    listMetricsHistory: async () => [],
    loadRuntimeStatus: async () => ({}),
    preflightReplayStore: async () => { throw new Error("mysql password must not leak"); },
  });
  await preflightApp.ready();
  try {
    const streamPath = "/internal/realtime/stream";
    const body = JSON.stringify({ scope: { kind: "admin" }, lastEventId: "cursor-1" });
    const tamperedCursorBody = JSON.stringify({ scope: { kind: "admin" }, lastEventId: "cursor-2" });
    const tamperedCursor = await preflightApp.inject({
      method: "POST",
      url: streamPath,
      headers: signedHeaders(streamPath, body, adminNodeId),
      payload: tamperedCursorBody,
    });
    assert.equal(tamperedCursor.statusCode, 401, "signature must bind the exact last-event cursor");

    const response = await preflightApp.inject({
      method: "POST",
      url: streamPath,
      headers: signedHeaders(streamPath, body, adminNodeId),
      payload: body,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes("mysql password must not leak"), false);
    assert.match(response.body, /REALTIME_REPLAY_UNAVAILABLE/);
    assert.doesNotMatch(response.headers["content-type"] ?? "", /text\/event-stream/);
  } finally {
    await preflightApp.close();
  }

  const capacityBroadcaster = new SseBroadcaster({ maxClients: 0 });
  const capacityApp = Fastify({ logger: false });
  await capacityApp.register(internalRealtimeReadController, {
    prefix: "/internal/realtime",
    sharedSecret,
    trustedNodeIds: new Set([adminNodeId]),
    adminNodeIds: new Set([adminNodeId]),
    allowedNodeTeams: new Map(),
    listMetricsRecords: async () => [],
    listExpectedTeamIds: async () => [],
    listMetricsHistory: async () => [],
    loadRuntimeStatus: async () => ({}),
    broadcaster: capacityBroadcaster,
  });
  await capacityApp.ready();
  try {
    const streamPath = "/internal/realtime/stream";
    const body = JSON.stringify({ scope: { kind: "admin" } });
    const response = await capacityApp.inject({
      method: "POST",
      url: streamPath,
      headers: signedHeaders(streamPath, body, adminNodeId),
      payload: body,
    });
    assert.equal(response.statusCode, 429);
    assert.match(response.body, /SSE_CAPACITY_EXCEEDED/);
    assert.doesNotMatch(response.headers["content-type"] ?? "", /text\/event-stream/);
  } finally {
    capacityBroadcaster.closeAll();
    await capacityApp.close();
  }

  const adminSecret = "read-admin-node-secret";
  const workerSecret = "read-worker-node-secret";
  const resolverApp = Fastify({ logger: false });
  await resolverApp.register(internalRealtimeReadController, {
    prefix: "/internal/realtime",
    sharedSecret,
    resolveSecretForNode: (nodeId) => new Map([
      [adminNodeId, adminSecret],
      [teamNodeId, workerSecret],
    ]).get(nodeId),
    trustedNodeIds: new Set([adminNodeId, teamNodeId]),
    adminNodeIds: new Set([adminNodeId]),
    allowedNodeTeams: new Map([[teamNodeId, new Set([2])]]),
    listMetricsRecords: async () => metricRecords,
    listExpectedTeamIds: async () => [2, 3],
    listMetricsHistory: async () => [],
    loadRuntimeStatus: async (scope) => ({ scope, ok: true }),
    now: () => new Date(now),
  });
  await resolverApp.ready();
  try {
    const path = "/internal/realtime/read-models/runtime-status";
    const body = JSON.stringify({ scope: { kind: "admin" } });
    const accepted = await resolverApp.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(path, body, adminNodeId, adminSecret),
      payload: body,
    });
    assert.equal(accepted.statusCode, 200, "the claimed admin node's own secret must authenticate");

    const impersonatedAdmin = await resolverApp.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(path, body, adminNodeId, workerSecret),
      payload: body,
    });
    assert.equal(
      impersonatedAdmin.statusCode,
      401,
      "a team-scoped node secret must not authenticate a claimed admin node id",
    );

    const sharedSecretImpersonation = await resolverApp.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(path, body, adminNodeId),
      payload: body,
    });
    assert.equal(
      sharedSecretImpersonation.statusCode,
      401,
      "the legacy shared secret must not authenticate a node that has a per-node mapping",
    );
  } finally {
    await resolverApp.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
