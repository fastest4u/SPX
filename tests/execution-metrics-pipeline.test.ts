import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { MetricsCollector, teamMetricsCollector } from "../src/services/metrics.js";
import { ApiClient } from "../src/services/api-client.js";
import { env } from "../src/config/env.js";
import { createRule } from "../src/services/notify-rules.js";
import { publishAutoAcceptJob } from "../src/services/auto-accept-job-publisher.js";
import { startAutoAcceptJobRealWorkerLoop } from "../src/services/auto-accept-job-real-execution-loop.js";
import { createRuntimeRealtimePublisher } from "../src/services/runtime-realtime-publisher.js";
import {
  createPersistentInProcessRealtimePublisher,
  createSseRealtimeTransport,
} from "../src/services/realtime-publisher.js";
import { internalRealtimeController } from "../src/controllers/internal-realtime-controller.js";
import { internalRealtimeReadController } from "../src/controllers/internal-realtime-read-controller.js";
import { dashboardController } from "../src/controllers/dashboard-controller.js";
import { SseBroadcaster } from "../src/services/sse.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import { listExecutionMetricsRecords } from "../src/repositories/realtime-execution-metrics-repository.js";
import type { MetricsSnapshot } from "../src/services/metrics.js";
const secret = "synthetic-pipeline-secret-at-least32";
async function producer() {
  const [nodeId, teamText, countText, url] = process.argv.slice(3);
  const teamId = Number(teamText);
  const count = Number(countText);
  const nativeFetch = globalThis.fetch;
  resetMemoryDb();
  Object.assign(env, { API_URL: "https://provider.example.test/booking/bidding/list" });
  let posts = 0;
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(
      new URL(String(url)).hostname,
      "provider.example.test",
      "all provider calls are synthetic",
    );
    requests++;
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("/accept")) {
      posts++;
      await new Promise((resolve) => setTimeout(resolve, count * 15));
      return Response.json({ retcode: 0 });
    }
    return Response.json({
      retcode: 0,
      data: {
        total: 1,
        request_list: [
          {
            request_id: body.booking_id + 1,
            booking_id: body.booking_id,
            request_acceptance_status: 2,
          },
        ],
      },
    });
  };
  for (let i = 0; i < count; i++) {
    const rule = await createRule(teamId, {
      name: `fixture-${i}`,
      origins: ["A"],
      destinations: ["B"],
      vehicle_types: ["4W"],
      need: 1,
      enabled: true,
      fulfilled: false,
      auto_accepted: false,
    });
    const bookingId = 1000 + i * 10;
    const result = await publishAutoAcceptJob({
      teamId,
      bookingId,
      requestId: bookingId + 1,
      ruleId: rule.id,
      ruleName: rule.name,
      executionMode: "cutover",
      attemptKind: "pending_request",
      acceptAll: false,
      source: "pending_tab",
      pollerNodeId: "fixture-poller",
      firstMatchedAtMs: Date.now() - 20,
      trip: {
        request_id: bookingId + 1,
        booking_id: bookingId,
        origin: "A",
        destination: "B",
        vehicle_type: "4W",
        acceptance_status: 1,
      },
      ruleSnapshot: { need: 1, accept_all: false, enabled: true, fulfilled: false },
    });
    assert.equal(result.published, true);
  }
  let delivered!: () => void;
  const publication = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const realtimePublisher = createRuntimeRealtimePublisher({
    remote: {
      url,
      sharedSecret: secret,
      nodeId,
      requestTimeoutMs: 10_000,
      fetchImpl: async (u, init) => {
        const response = await nativeFetch(u, init);
        assert.equal(response.status, 200, await response.clone().text());
        delivered();
        return response;
      },
    },
  });
  const loop = startAutoAcceptJobRealWorkerLoop({
    nodeId,
    teamIds: [teamId],
    batchSize: 10,
    leaseMs: 60_000,
    intervalMs: 60_000,
    realtimePublisher,
    metricsPublication: "dedicated",
    ambiguousRecheckDelayMs: 0,
    apiClientForTeam: async () =>
      new ApiClient({
        credentials: { spxCookie: "synthetic", spxDeviceId: "synthetic" },
        metricsCollector: teamMetricsCollector(teamId),
      }),
    newExternalAttemptPolicyForTeam: async () => true,
  });
  try {
    await Promise.race([
      publication,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("no execution publication")), 20_000);
        timer.unref();
      }),
    ]);
    assert.equal(
      posts,
      count,
      "each genuine admitted business job POSTs exactly once across repeated batches",
    );
    const raw = teamMetricsCollector(teamId).snapshot();
    assert.equal(raw.operations.acceptRtt.count, count);
    assert.equal(raw.operations.firstMatchToAcceptStart.count, count);
    console.log(
      `PRODUCER_RESULT ${JSON.stringify({ nodeId, teamId, posts, requests, acceptRtt: raw.operations.acceptRtt })}`,
    );
  } finally {
    loop.stop();
    globalThis.fetch = nativeFetch;
    await closePool();
  }
}
function response() {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  return {
    writes,
    raw: Object.assign(emitter, {
      writableEnded: false,
      destroyed: false,
      writeHead() {},
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      end() {},
    }),
  };
}
function child(
  nodeId: string,
  teamId: number,
  count: number,
  url: string,
): Promise<{ requests: number; acceptRtt: { avg: number; count: number } }> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(import.meta.url),
        "--producer",
        nodeId,
        String(teamId),
        String(count),
        url,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          SPX_TEST_SKIP_ENV_FILE: "1",
          DB_MODE: "memory",
          SECRETS_KEY: "synthetic-pipeline-key",
        },
        windowsHide: true,
      },
    );
    let output = "";
    processChild.stdout.on("data", (chunk) => {
      output += chunk;
    });
    processChild.stderr.on("data", (chunk) => {
      output += chunk;
    });
    processChild.on("error", reject);
    processChild.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`producer ${nodeId} exit ${code}: ${output}`));
      const result = output.match(/PRODUCER_RESULT (.+)/)?.[1];
      if (!result) return reject(new Error(output));
      console.log(`pipeline ${result}`);
      resolve(JSON.parse(result));
    });
  });
}
async function main() {
  resetMemoryDb();
  const app = Fastify({ logger: false });
  const broadcaster = new SseBroadcaster();
  const team1 = response(),
    team2 = response();
  let user = { id: 10, username: "synthetic", role: "user", teamId: 1 as number | null };
  app.decorateRequest("jwtVerify", async () => user);
  const publisher = createPersistentInProcessRealtimePublisher(
    createSseRealtimeTransport(broadcaster),
  );
  await app.register(internalRealtimeController, {
    prefix: "/internal/realtime",
    publisher,
    sharedSecret: secret,
    allowedNodes: new Map([
      ["exec-a", new Set([1])],
      ["exec-b", new Set([1])],
      ["exec-c", new Set([2])],
    ]),
  });
  await app.register(internalRealtimeReadController, {
    prefix: "/internal/realtime",
    sharedSecret: secret,
    trustedNodeIds: new Set(["reader", "admin"]),
    adminNodeIds: new Set(["admin"]),
    allowedNodeTeams: new Map([["reader", new Set([1, 2])]]),
    listExpectedTeamIds: async () => [1, 2],
    loadRuntimeStatus: async () => ({}),
  });
  await app.register(dashboardController);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    await broadcaster.addClient(team1.raw as never, { teamId: 1 });
    await broadcaster.addClient(team2.raw as never, { teamId: 2 });
    for (const teamId of [1, 2]) {
      const poller = new MetricsCollector({ teamId });
      poller.recordPoll(7, true, "ok", 1);
      await publisher.publishSnapshot({
        type: "metrics.snapshot",
        payloadVersion: 1,
        scope: { kind: "team", teamId },
        source: { service: "poller-service", role: "poller-service", nodeId: "poller" },
        payload: poller.snapshot(),
      });
    }
    const address = app.server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/internal/realtime/events`;
    const results = await Promise.all([
      child("exec-a", 1, 1, url),
      child("exec-b", 1, 2, url),
      child("exec-c", 2, 3, url),
    ]);
    const records = await listExecutionMetricsRecords();
    assert.equal(records.length, 3);
    assert.equal(
      getRawMemoryDb().prepare("SELECT COUNT(*) AS n FROM realtime_metrics_read_models").get()!.n,
      2,
    );
    const read = async (teamId: number | null) => {
      const path = "/internal/realtime/read-models/metrics";
      const body = JSON.stringify({
        scope: teamId === null ? { kind: "admin" } : { kind: "team", teamId },
      });
      const nodeId = teamId === null ? "admin" : "reader",
        timestamp = new Date().toISOString(),
        requestId = `pipeline-${teamId}`;
      const r = await app.inject({
        method: "POST",
        url: path,
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-spx-node-id": nodeId,
          "x-spx-timestamp": timestamp,
          "x-spx-request-id": requestId,
          "x-spx-signature": createInternalSignature({
            body,
            path,
            nodeId,
            timestamp,
            requestId,
            secret,
          }),
        },
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().data;
    };
    const scoped = await read(1);
    const other = await read(2);
    const admin = await read(null);
    assert.equal(scoped.metrics.operations.acceptRtt.count, 3);
    assert.equal(other.metrics.operations.acceptRtt.count, 3);
    assert.equal(admin.metrics.operations.acceptRtt.count, 6);
    assert.equal(
      scoped.metrics.operations.acceptRtt.avg,
      Math.round((results[0].acceptRtt.avg + results[1].acceptRtt.avg * 2) / 3),
    );
    assert.equal(scoped.metrics.upstream.requests, results[0].requests + results[1].requests);
    assert.equal(
      admin.metrics.upstream.requests,
      results.reduce((sum, r) => sum + r.requests, 0),
    );
    assert.equal(admin.metrics.upstream.connectionPools.length, 4);
    assert.equal(admin.teams.length, 2);
    assert.equal(scoped.metrics.polling.totalRequests, 1);
    for (const [client, teamId] of [
      [team1, 1],
      [team2, 2],
    ] as const) {
      const frames = client.writes
        .filter((w) => w.includes("event: metrics.snapshot"))
        .map((w) => JSON.parse(w.match(/data: (.+)/)![1]));
      assert.ok(frames.length >= 2);
      assert.ok(frames.every((f) => f.scope.teamId === teamId));
      assert.equal(
        (frames.at(-1)!.payload as MetricsSnapshot).operations.acceptRtt.count,
        3,
        "actual team SSE delivery includes execution data",
      );
    }
    const local = await app.inject({ url: "/metrics" });
    assert.equal(local.statusCode, 200);
    assert.equal(local.json().data.operations.acceptRtt.count, 3);
    user = { ...user, role: "admin", teamId: null };
    const localAdmin = await app.inject({ url: "/metrics" });
    assert.equal(localAdmin.json().data.operations.acceptRtt.count, 6);
    console.log(
      "execution-metrics-pipeline: real subprocess loops/ApiClient POSTs → signed loopback ingest → durable projection → scoped/admin HTTP + actual SSE + local dashboard passed",
    );
  } finally {
    broadcaster.closeAll();
    await app.close();
    await closePool();
  }
}
(process.argv[2] === "--producer" ? producer() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
