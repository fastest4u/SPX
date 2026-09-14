process.env.DB_MODE = "memory";
process.env.LINE_SERVICE_URL = "";
process.env.OCR_SERVICE_URL = "";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthUser } from "../src/services/authz.js";
import type { MetricsSnapshot } from "../src/services/metrics.js";
import type {
  RealtimeReadGateway,
  RealtimeReadRequestBody,
  RealtimeStreamRelayResult,
} from "../src/services/realtime-service-client.js";

class FakeRealtimeReadGateway implements RealtimeReadGateway {
  metricsBodies: RealtimeReadRequestBody[] = [];
  historyBodies: RealtimeReadRequestBody[] = [];
  runtimeBodies: RealtimeReadRequestBody[] = [];
  streamBodies: RealtimeReadRequestBody[] = [];
  metricsResult: unknown;
  historyResult: unknown = [];
  runtimeResult: unknown = {};
  streamResult: RealtimeStreamRelayResult = { connected: false, status: 429 };
  failReads = false;
  failStream = false;

  async readMetrics<T = unknown>(body: RealtimeReadRequestBody): Promise<T> {
    this.metricsBodies.push(body);
    if (this.failReads) throw new Error("remote metrics secret");
    return this.metricsResult as T;
  }

  async readMetricsHistory<T = unknown>(body: RealtimeReadRequestBody): Promise<T> {
    this.historyBodies.push(body);
    if (this.failReads) throw new Error("remote history secret");
    return this.historyResult as T;
  }

  async readRuntimeStatus<T = unknown>(body: RealtimeReadRequestBody): Promise<T> {
    this.runtimeBodies.push(body);
    if (this.failReads) throw new Error("remote runtime secret");
    return this.runtimeResult as T;
  }

  async relayStream(input: {
    body: RealtimeReadRequestBody;
    downstream: Parameters<RealtimeReadGateway["relayStream"]>[0]["downstream"];
  }): Promise<RealtimeStreamRelayResult> {
    this.streamBodies.push(input.body);
    if (this.failStream) throw new Error("remote stream auth secret");
    return this.streamResult;
  }
}

async function snapshot(teamId: number, requests: number): Promise<MetricsSnapshot> {
  const { MetricsCollector } = await import("../src/services/metrics.js");
  const collector = new MetricsCollector({ teamId, teamName: `Team ${teamId}` });
  for (let index = 0; index < requests; index += 1) {
    collector.recordPoll(20, true, "same", 1);
  }
  return collector.snapshot();
}

function summary(scope: { kind: "admin" } | { kind: "team"; teamId: number }, metrics: MetricsSnapshot | null) {
  const staleTeamIds = scope.kind === "team" && metrics ? [scope.teamId] : [];
  const missingTeamIds = scope.kind === "team" && !metrics ? [scope.teamId] : [];
  return {
    generatedAt: "2030-01-01T00:00:00.000Z",
    scope,
    aggregateMode: scope.kind === "team" ? "single-team" : "fresh-workers-only",
    freshness: {
      status: metrics ? (scope.kind === "team" ? "stale" : "fresh") : "missing",
      staleAfterMs: 120_000,
      sourceNodeIds: metrics ? ["worker-cached"] : [],
      staleTeamIds,
      missingTeamIds,
    },
    metrics,
  };
}

function historyRow(teamId: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    teamId,
    uptime: 90,
    totalRequests: 7,
    successCount: 6,
    errorCount: 1,
    successRate: "85.71",
    latencyAvg: 20,
    latencyP95: 30,
    latencyP99: 35,
    totalRecordsSeen: 12,
    changesDetected: 2,
    tripsInserted: 1,
    tripsSkipped: 1,
    createdAt: "2030-01-01 07:00:00",
    ...overrides,
  };
}

async function createDashboardApp(user: AuthUser, gateway?: RealtimeReadGateway) {
  const Fastify = (await import("fastify")).default;
  const { dashboardController } = await import("../src/controllers/dashboard-controller.js");
  const app = Fastify({ logger: false });
  app.decorateRequest("jwtVerify", async () => user);
  await app.register(dashboardController, { realtimeReadGateway: gateway } as never);
  return app;
}

async function main(): Promise<void> {
  const { closePool } = await import("../src/db/client.js");
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { upsertRealtimeMetricsReadModel } = await import(
    "../src/repositories/realtime-metrics-read-model-repository.js"
  );
  const { insertMetricsSnapshot } = await import("../src/repositories/metrics-repository.js");
  const { clearRuntimeMetricsSnapshots } = await import("../src/services/runtime-metrics.js");
  const { runtimeStatusController } = await import("../src/controllers/runtime-status-controller.js");
  const { buildRuntimeStatusReadModel } = await import("../src/services/runtime-status-read-model.js");
  const { relayDashboardRealtimeStream } = await import("../src/controllers/dashboard-controller.js");
  const { createRealtimeServiceClient } = await import("../src/services/realtime-service-client.js");
  const Fastify = (await import("fastify")).default;

  const teamSnapshot = await snapshot(2, 7);
  const historySecret = "history-internal-secret-must-not-leak";
  const expectedHistoryRow = historyRow(2);
  const teamGateway = new FakeRealtimeReadGateway();
  teamGateway.metricsResult = summary({ kind: "team", teamId: 2 }, teamSnapshot);
  teamGateway.historyResult = [{ ...expectedHistoryRow, internalDebug: historySecret }];
  const teamApp = await createDashboardApp({
    id: 2,
    username: "team-user",
    role: "user",
    teamId: 2,
  }, teamGateway);
  try {
    const metricsResponse = await teamApp.inject({
      method: "GET",
      url: "/metrics?teamId=99",
      headers: {
        cookie: "token=browser-cookie-secret",
        authorization: "Bearer browser-jwt-secret",
        "x-spx-node-id": "browser-controlled-node",
      },
    });
    assert.equal(metricsResponse.statusCode, 200);
    assert.deepEqual(metricsResponse.json().data, teamSnapshot, "public metrics shape must remain a snapshot");
    assert.deepEqual(teamGateway.metricsBodies, [{ scope: { kind: "team", teamId: 2 } }]);

    const historyResponse = await teamApp.inject({
      method: "GET",
      url: "/metrics/history?limit=25&teamId=99",
    });
    assert.equal(historyResponse.statusCode, 200);
    assert.deepEqual(historyResponse.json().data, [expectedHistoryRow]);
    assert.equal(historyResponse.body.includes(historySecret), false);
    assert.deepEqual(teamGateway.historyBodies, [{ scope: { kind: "team", teamId: 2 }, limit: 25 }]);

    const streamResponse = await teamApp.inject({
      method: "GET",
      url: "/events",
      headers: { "last-event-id": "cursor-team-2" },
    });
    assert.equal(streamResponse.statusCode, 429, "upstream capacity must propagate before SSE headers");
    assert.equal(streamResponse.json().error_code, "REALTIME_STREAM_UNAVAILABLE");
    assert.deepEqual(teamGateway.streamBodies, [{
      scope: { kind: "team", teamId: 2 },
      lastEventId: "cursor-team-2",
    }]);
  } finally {
    await teamApp.close();
  }

  const upstreamRequests: Array<{ url: string; body: string; headers: Headers }> = [];
  const signedClient = createRealtimeServiceClient({
    baseUrl: "http://realtime.internal/internal/realtime",
    sharedSecret: "internal-only-secret",
    nodeId: "web-api-fixed-node",
    connectTimeoutMs: 500,
    fetchImpl: async (url, init) => {
      upstreamRequests.push({
        url,
        body: String(init.body),
        headers: new Headers(init.headers),
      });
      if (url.endsWith("/stream")) return new Response("capacity", { status: 429 });
      return new Response(JSON.stringify({
        status: "success",
        data: summary({ kind: "team", teamId: 2 }, teamSnapshot),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const signedClientApp = await createDashboardApp(
    { id: 2, username: "team", role: "user", teamId: 2 },
    signedClient,
  );
  try {
    const browserHeaders = {
      cookie: "token=browser-cookie-secret",
      authorization: "Bearer browser-jwt-secret",
      "x-spx-node-id": "browser-controlled-node",
    };
    const metricsResponse = await signedClientApp.inject({
      method: "GET",
      url: "/metrics?teamId=99",
      headers: browserHeaders,
    });
    assert.equal(metricsResponse.statusCode, 200);
    const streamResponse = await signedClientApp.inject({
      method: "GET",
      url: "/events",
      headers: { ...browserHeaders, "last-event-id": "browser-cursor" },
    });
    assert.equal(streamResponse.statusCode, 429);
    assert.equal(upstreamRequests.length, 2);
    for (const request of upstreamRequests) {
      assert.equal(request.headers.get("cookie"), null);
      assert.equal(request.headers.get("authorization"), null);
      assert.equal(request.headers.get("x-spx-node-id"), "web-api-fixed-node");
      assert.notEqual(request.headers.get("x-spx-node-id"), "browser-controlled-node");
    }
    assert.deepEqual(JSON.parse(upstreamRequests[0]!.body), { scope: { kind: "team", teamId: 2 } });
    assert.deepEqual(JSON.parse(upstreamRequests[1]!.body), {
      scope: { kind: "team", teamId: 2 },
      lastEventId: "browser-cursor",
    });
  } finally {
    await signedClientApp.close();
  }

  const adminSnapshot = await snapshot(9, 4);
  const adminAggregateSnapshot = {
    ...adminSnapshot,
    teamId: null,
    teamName: "All teams",
  };
  const adminGateway = new FakeRealtimeReadGateway();
  adminGateway.metricsResult = summary({ kind: "team", teamId: 9 }, adminSnapshot);
  const adminApp = await createDashboardApp({
    id: 1,
    username: "admin",
    role: "admin",
    teamId: null,
  }, adminGateway);
  try {
    const response = await adminApp.inject({ method: "GET", url: "/metrics?teamId=9" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(adminGateway.metricsBodies, [{ scope: { kind: "team", teamId: 9 } }]);
    adminGateway.metricsResult = summary({ kind: "admin" }, adminAggregateSnapshot);
    const aggregateResponse = await adminApp.inject({ method: "GET", url: "/metrics" });
    assert.equal(aggregateResponse.statusCode, 200);
    assert.equal(aggregateResponse.json().data.teamId, null);
    assert.deepEqual(adminGateway.metricsBodies.at(-1), { scope: { kind: "admin" } });
    adminGateway.historyResult = [];
    const historyResponse = await adminApp.inject({ method: "GET", url: "/metrics/history?limit=5" });
    assert.equal(historyResponse.statusCode, 200);
    assert.deepEqual(adminGateway.historyBodies.at(-1), { scope: { kind: "admin" }, limit: 5 });
    const streamResponse = await adminApp.inject({ method: "GET", url: "/events" });
    assert.equal(streamResponse.statusCode, 429);
    assert.deepEqual(adminGateway.streamBodies.at(-1), { scope: { kind: "admin" } });
  } finally {
    await adminApp.close();
  }

  const malformedGateway = new FakeRealtimeReadGateway();
  malformedGateway.metricsResult = {
    ...summary({ kind: "team", teamId: 2 }, teamSnapshot),
    metrics: { polling: { totalRequests: 999 } },
  };
  malformedGateway.historyResult = { rows: [] };
  const malformedApp = await createDashboardApp({ id: 2, username: "team", role: "user", teamId: 2 }, malformedGateway);
  try {
    const metricsResponse = await malformedApp.inject({ method: "GET", url: "/metrics" });
    assert.equal(metricsResponse.statusCode, 503, "malformed remote metrics must fail closed");
    const historyResponse = await malformedApp.inject({ method: "GET", url: "/metrics/history" });
    assert.equal(historyResponse.statusCode, 503, "malformed remote history must fail closed");
  } finally {
    await malformedApp.close();
  }

  const crossTeamHistoryGateway = new FakeRealtimeReadGateway();
  crossTeamHistoryGateway.metricsResult = summary({ kind: "team", teamId: 2 }, teamSnapshot);
  crossTeamHistoryGateway.historyResult = [historyRow(3, { id: 99, totalRequests: 999 })];
  const crossTeamHistoryApp = await createDashboardApp(
    { id: 2, username: "team", role: "user", teamId: 2 },
    crossTeamHistoryGateway,
  );
  try {
    const response = await crossTeamHistoryApp.inject({ method: "GET", url: "/metrics/history" });
    assert.equal(response.statusCode, 503, "team history must reject cross-team upstream rows");
  } finally {
    await crossTeamHistoryApp.close();
  }

  const missingGateway = new FakeRealtimeReadGateway();
  missingGateway.metricsResult = summary({ kind: "team", teamId: 2 }, null);
  const missingApp = await createDashboardApp({ id: 2, username: "team", role: "user", teamId: 2 }, missingGateway);
  try {
    const response = await missingApp.inject({ method: "GET", url: "/metrics" });
    assert.equal(response.statusCode, 503, "missing metrics must not be invented as a zero snapshot");
    assert.equal(response.json().error_code, "REALTIME_READ_UNAVAILABLE");
  } finally {
    await missingApp.close();
  }

  const inconsistentFreshnessGateway = new FakeRealtimeReadGateway();
  const inconsistentSummary = summary({ kind: "team", teamId: 2 }, teamSnapshot);
  inconsistentSummary.freshness.status = "missing";
  inconsistentFreshnessGateway.metricsResult = inconsistentSummary;
  const inconsistentFreshnessApp = await createDashboardApp(
    { id: 2, username: "team", role: "user", teamId: 2 },
    inconsistentFreshnessGateway,
  );
  try {
    const response = await inconsistentFreshnessApp.inject({ method: "GET", url: "/metrics" });
    assert.equal(response.statusCode, 503, "missing freshness cannot carry a metrics snapshot");
  } finally {
    await inconsistentFreshnessApp.close();
  }

  const failedGateway = new FakeRealtimeReadGateway();
  failedGateway.failReads = true;
  failedGateway.streamResult = { connected: false, status: 503 };
  const failedApp = await createDashboardApp({ id: 2, username: "team", role: "user", teamId: 2 }, failedGateway);
  try {
    const metricsResponse = await failedApp.inject({ method: "GET", url: "/metrics" });
    assert.equal(metricsResponse.statusCode, 503);
    assert.equal(metricsResponse.body.includes("remote metrics secret"), false);
    const historyResponse = await failedApp.inject({ method: "GET", url: "/metrics/history" });
    assert.equal(historyResponse.statusCode, 503);
    const readyResponse = await failedApp.inject({ method: "GET", url: "/ready" });
    assert.equal(readyResponse.statusCode, 200, "realtime read failure must not affect web readiness");
  } finally {
    await failedApp.close();
  }

  const streamFailureGateway = new FakeRealtimeReadGateway();
  streamFailureGateway.failStream = true;
  const streamFailureApp = await createDashboardApp(
    { id: 2, username: "team", role: "user", teamId: 2 },
    streamFailureGateway,
  );
  try {
    const response = await streamFailureApp.inject({ method: "GET", url: "/events" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error_code, "REALTIME_STREAM_UNAVAILABLE");
    assert.equal(response.body.includes("remote stream auth secret"), false);

    streamFailureGateway.failStream = false;
    streamFailureGateway.streamResult = { connected: false, status: 401 };
    const internalAuthFailure = await streamFailureApp.inject({ method: "GET", url: "/events" });
    assert.equal(internalAuthFailure.statusCode, 503, "internal auth failures must not look like browser auth failures");
  } finally {
    await streamFailureApp.close();
  }

  const unassignedGateway = new FakeRealtimeReadGateway();
  const unassignedApp = await createDashboardApp(
    { id: 4, username: "unassigned", role: "user", teamId: null },
    unassignedGateway,
  );
  try {
    for (const url of ["/metrics", "/metrics/history", "/events"]) {
      const response = await unassignedApp.inject({ method: "GET", url });
      assert.equal(response.statusCode, 403, `${url} requires an assigned team`);
    }
    assert.equal(unassignedGateway.metricsBodies.length, 0);
    assert.equal(unassignedGateway.historyBodies.length, 0);
    assert.equal(unassignedGateway.streamBodies.length, 0);
  } finally {
    await unassignedApp.close();
  }

  await closePool();
  resetMemoryDb();
  clearRuntimeMetricsSnapshots();
  const staleSnapshot = await snapshot(2, 13);
  await upsertRealtimeMetricsReadModel({
    teamId: 2,
    sourceNodeId: "worker-stale-cache",
    snapshot: staleSnapshot,
    emittedAt: new Date("2020-01-01T00:00:00.000Z"),
    receivedAt: new Date("2020-01-01T00:00:01.000Z"),
    updatedAt: new Date("2020-01-01T00:00:02.000Z"),
  });
  await insertMetricsSnapshot(staleSnapshot, 2);
  const localCachedApp = await createDashboardApp({ id: 2, username: "team", role: "user", teamId: 2 });
  try {
    const response = await localCachedApp.inject({ method: "GET", url: "/metrics" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.polling.totalRequests, 13, "stale durable team cache stays visible");
    const historyResponse = await localCachedApp.inject({ method: "GET", url: "/metrics/history" });
    assert.equal(historyResponse.statusCode, 200);
    const [localHistoryRow] = historyResponse.json().data;
    assert.deepEqual(
      Object.keys(localHistoryRow).sort(),
      Object.keys(expectedHistoryRow).sort(),
      "local and remote history expose the same allowlisted fields",
    );
    assert.equal(typeof localHistoryRow.successRate, "string");
    assert.equal(typeof localHistoryRow.createdAt, "string");
  } finally {
    await localCachedApp.close();
  }

  const localMissingApp = await createDashboardApp({ id: 3, username: "missing", role: "user", teamId: 3 });
  try {
    const response = await localMissingApp.inject({ method: "GET", url: "/metrics" });
    assert.equal(response.statusCode, 503);
  } finally {
    await localMissingApp.close();
  }

  const runtimeSecret = "runtime-gateway-secret-must-not-leak";
  const builtRuntimeStatus = buildRuntimeStatusReadModel({
    scope: { kind: "admin" },
    generatedAt: "2030-01-01T00:00:00.000Z",
    records: {
      nodes: [{
        nodeId: "remote-node",
        role: "worker",
        hostname: "runtime-host",
        pid: 123,
        version: "v1",
        lastHeartbeatAt: "2030-01-01T00:00:00.000Z",
        metadataJson: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }] as never,
      leases: [{
        teamId: 2,
        ownerNodeId: "remote-node",
        ownerRole: "worker",
        leaseToken: "already-projected-away",
        leaseExpiresAt: "2030-01-01T00:01:00.000Z",
        heartbeatAt: "2030-01-01T00:00:00.000Z",
        status: "running",
        lastError: null,
        startedAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }] as never,
      notifications: { queued: 1 },
      serviceHealth: [],
      providerDeliveryRows: [],
      ocrSummary: { completedExtractions: 0, lastCompletedAt: null },
      autoAcceptJobSummary: {
        total: 0,
        byStatus: {
          pending: 0,
          claimed: 0,
          retrying: 0,
          verifying: 0,
          succeeded: 0,
          failed: 0,
          indeterminate: 0,
          dead_letter: 0,
          cancelled: 0,
        },
        byAttemptKind: {
          pending_request: 0,
          non_pending_probe: 0,
          fast_accept_all: 0,
          own_status_reconcile: 0,
        },
        claimableCount: 0,
        expiredClaimCount: 0,
        inFlightCount: 0,
        terminalCount: 0,
        settlementPendingCount: 0,
        budgetReservations: {
          activeCount: 0,
          staleCount: 0,
          oldestHeldAt: null,
          oldestHeldAgeMs: null,
          staleTtlMs: 0,
        },
        deadLetters: {
          total: 0,
          byReasonCode: {
            invalid_payload: 0,
            identity_mismatch: 0,
            configuration_error: 0,
            execution_failure: 0,
            verification_indeterminate: 0,
            progress_persistence_failure: 0,
            result_persistence_failure: 0,
            history_persistence_failure: 0,
            notification_persistence_failure: 0,
            unsupported_job: 0,
            other: 0,
          },
          groups: [],
        },
      },
    },
  });
  const mysqlTimestamp = "2030-01-01 07:00:00";
  const compatibleRuntimeStatus = {
    ...builtRuntimeStatus,
    nodes: builtRuntimeStatus.nodes.map((node) => ({
      ...node,
      lastHeartbeatAt: mysqlTimestamp,
      createdAt: mysqlTimestamp,
      updatedAt: mysqlTimestamp,
    })),
  };
  const runtimeGateway = new FakeRealtimeReadGateway();
  runtimeGateway.runtimeResult = {
    ...compatibleRuntimeStatus,
    internalDebug: runtimeSecret,
    nodes: compatibleRuntimeStatus.nodes.map((node) => ({
      ...node,
      metadataJson: JSON.stringify({ token: runtimeSecret }),
    })),
    leases: compatibleRuntimeStatus.leases.map((lease) => ({
      ...lease,
      leaseToken: runtimeSecret,
      lastError: runtimeSecret,
    })),
    readModels: {
      ...compatibleRuntimeStatus.readModels,
      privateDebug: runtimeSecret,
    },
  };
  const runtimeApp = Fastify({ logger: false });
  await runtimeApp.register(runtimeStatusController, { realtimeReadGateway: runtimeGateway } as never);
  try {
    const response = await runtimeApp.inject({ method: "GET", url: "/status" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, compatibleRuntimeStatus);
    assert.equal(response.body.includes(runtimeSecret), false);
    assert.deepEqual(runtimeGateway.runtimeBodies, [{ scope: { kind: "admin" } }]);
  } finally {
    await runtimeApp.close();
  }

  const currentAutoAcceptJobs = compatibleRuntimeStatus.readModels.autoAcceptJobs;
  assert.ok(currentAutoAcceptJobs);
  const { deadLetters: _currentDeadLetters, ...legacyAutoAcceptJobs } = currentAutoAcceptJobs;
  runtimeGateway.runtimeResult = {
    ...compatibleRuntimeStatus,
    readModels: {
      ...compatibleRuntimeStatus.readModels,
      autoAcceptJobs: legacyAutoAcceptJobs,
    },
  };
  const legacyRuntimeApp = Fastify({ logger: false });
  await legacyRuntimeApp.register(runtimeStatusController, { realtimeReadGateway: runtimeGateway } as never);
  try {
    const response = await legacyRuntimeApp.inject({ method: "GET", url: "/status" });
    assert.equal(response.statusCode, 200, "older realtime snapshots without deadLetters must remain readable");
    assert.deepEqual(response.json().data.readModels.autoAcceptJobs, {
      ...legacyAutoAcceptJobs,
      deadLetters: null,
    });
  } finally {
    await legacyRuntimeApp.close();
  }

  const futureAttemptRuntimeStatus = {
    ...compatibleRuntimeStatus,
    readModels: {
      ...compatibleRuntimeStatus.readModels,
      autoAcceptJobs: {
        ...currentAutoAcceptJobs,
        total: 1,
        byStatus: {
          ...currentAutoAcceptJobs.byStatus,
          dead_letter: 1,
        },
        terminalCount: 1,
        deadLetters: {
          total: 1,
          byReasonCode: {
            ...currentAutoAcceptJobs.deadLetters.byReasonCode,
            invalid_payload: 1,
          },
          groups: [
            { teamId: 2, attemptKind: "other", reasonCode: "invalid_payload", count: 1 },
          ],
        },
      },
    },
  };
  runtimeGateway.runtimeResult = futureAttemptRuntimeStatus;
  const futureAttemptRuntimeApp = Fastify({ logger: false });
  await futureAttemptRuntimeApp.register(runtimeStatusController, { realtimeReadGateway: runtimeGateway } as never);
  try {
    const response = await futureAttemptRuntimeApp.inject({ method: "GET", url: "/status" });
    assert.equal(response.statusCode, 200, "closed public other attempt kind must pass projection");
    assert.deepEqual(
      response.json().data.readModels.autoAcceptJobs.deadLetters.groups,
      [{ teamId: 2, attemptKind: "other", reasonCode: "invalid_payload", count: 1 }],
    );
  } finally {
    await futureAttemptRuntimeApp.close();
  }

  runtimeGateway.failReads = true;
  const failedRuntimeApp = Fastify({ logger: false });
  await failedRuntimeApp.register(runtimeStatusController, { realtimeReadGateway: runtimeGateway } as never);
  try {
    const response = await failedRuntimeApp.inject({ method: "GET", url: "/status" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes("remote runtime secret"), false);
  } finally {
    await failedRuntimeApp.close();
  }

  runtimeGateway.failReads = false;
  runtimeGateway.runtimeResult = [];
  const malformedRuntimeApp = Fastify({ logger: false });
  await malformedRuntimeApp.register(runtimeStatusController, { realtimeReadGateway: runtimeGateway } as never);
  try {
    const response = await malformedRuntimeApp.inject({ method: "GET", url: "/status" });
    assert.equal(response.statusCode, 503, "malformed runtime status must fail closed");
  } finally {
    await malformedRuntimeApp.close();
  }

  const failedLocalRuntimeApp = Fastify({ logger: false });
  await failedLocalRuntimeApp.register(runtimeStatusController, {
    loadLocalRuntimeStatus: async () => {
      throw new Error("local database password must stay private");
    },
  } as never);
  try {
    const response = await failedLocalRuntimeApp.inject({ method: "GET", url: "/status" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error_code, "REALTIME_READ_UNAVAILABLE");
    assert.equal(response.body.includes("local database password"), false);
  } finally {
    await failedLocalRuntimeApp.close();
  }

  const destroyedWrites: string[] = [];
  const destroyedDownstream = {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead(status: number) {
      destroyedWrites.push(`status:${status}`);
      this.headersSent = true;
    },
    write(chunk: Uint8Array | string) {
      destroyedWrites.push(String(chunk));
      return true;
    },
    end() {
      destroyedWrites.push("end");
      this.writableEnded = true;
    },
    on() {},
    off() {},
  };
  const closeBeforeConnectGateway = {
    ...new FakeRealtimeReadGateway(),
    async relayStream(input: Parameters<RealtimeReadGateway["relayStream"]>[0]) {
      (input.downstream as typeof destroyedDownstream).destroyed = true;
      return { connected: false as const, status: 503 };
    },
  } as RealtimeReadGateway;
  await relayDashboardRealtimeStream({
    gateway: closeBeforeConnectGateway,
    body: { scope: { kind: "team", teamId: 2 } },
    downstream: destroyedDownstream,
  });
  assert.deepEqual(destroyedWrites, [], "preconnect browser close must not write to a destroyed response");

  const httpServerSource = readFileSync(resolve(process.cwd(), "src/services/http-server.ts"), "utf8");
  assert.match(httpServerSource, /realtimeReadGateway\?: RealtimeReadGateway/);
  assert.match(httpServerSource, /dashboardController,\s*\{\s*realtimeReadGateway:/);
  assert.match(httpServerSource, /runtimeStatusController,\s*\{\s*prefix:\s*"\/runtime",\s*realtimeReadGateway:/);

  await closePool();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
