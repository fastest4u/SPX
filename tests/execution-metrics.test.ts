import assert from "node:assert/strict";
import Fastify from "fastify";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb, getRawMemoryDb } from "../src/db/client-memory.js";
import { internalRealtimeController } from "../src/controllers/internal-realtime-controller.js";
import { internalRealtimeReadController } from "../src/controllers/internal-realtime-read-controller.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import { MetricsCollector } from "../src/services/metrics.js";
import {
  createPersistentInProcessRealtimePublisher,
  createSseRealtimeTransport,
} from "../src/services/realtime-publisher.js";
import {
  listMergedRealtimeMetricsReadModels,
  projectRealtimeObservationsEnvelope,
} from "../src/repositories/realtime-execution-metrics-repository.js";
import { createRealtimeEnvelope } from "../src/services/realtime-contract.js";
import { getRealtimeMetricsReadModelByTeamId } from "../src/repositories/realtime-metrics-read-model-repository.js";
import type {
  RealtimeEnvelopeV1,
  RealtimePublishInput,
} from "../src/services/realtime-contract.js";

const secret = "synthetic-execution-metrics-secret-32";
const frames: RealtimeEnvelopeV1[] = [];
const adminFrames: unknown[] = [];
const app = Fastify({ logger: false });
let sequence = 0;
let now = Date.now();
function headers(body: string, nodeId: string, path: string) {
  const timestamp = new Date().toISOString();
  const requestId = `execution-metrics-${++sequence}`;
  return {
    "content-type": "application/json",
    "x-spx-node-id": nodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-request-id": requestId,
    "x-spx-signature": createInternalSignature({
      body,
      nodeId,
      path,
      timestamp,
      requestId,
      secret,
    }),
  };
}
function sample(teamId: number, count: number, ms: number, pool: string) {
  const collector = new MetricsCollector({ teamId });
  for (let i = 0; i < count; i++) {
    collector.recordOperation("acceptRtt", ms);
    collector.recordOperation("firstMatchToAcceptStart", ms * 2);
    collector.recordUpstreamRequest();
  }
  const snapshot = collector.snapshot();
  snapshot.upstream = {
    requests: count,
    connections: 1,
    reuseRatio: 0,
    connectionScope: "process",
    connectionPools: [{ id: pool, requests: count, connections: 1 }],
  };
  return snapshot;
}
function execution(
  teamId: number,
  nodeId: string,
  count: number,
  ms: number,
  emittedAt = now,
  startedAt = now - 1000,
  generation = "generation-1",
): RealtimePublishInput {
  const s = sample(teamId, count, ms, nodeId);
  return {
    type: "metrics.execution.snapshot" as RealtimePublishInput["type"],
    payloadVersion: 1,
    scope: { kind: "team", teamId },
    source: { service: "auto-accept-service", nodeId, role: "auto-accept-service" },
    emittedAt: new Date(emittedAt).toISOString(),
    replayable: false,
    payload: {
      teamId,
      generation,
      startedAt: new Date(startedAt).toISOString(),
      operations: {
        acceptRtt: s.operations.acceptRtt,
        firstMatchToAcceptStart: s.operations.firstMatchToAcceptStart,
      },
      upstream: s.upstream,
    },
  };
}
async function send(input: RealtimePublishInput) {
  const body = JSON.stringify(input);
  return app.inject({
    method: "POST",
    url: "/internal/realtime/events",
    payload: body,
    headers: headers(body, input.source.nodeId, "/internal/realtime/events"),
  });
}
async function read(teamId: number | null) {
  const body = JSON.stringify({
    scope: teamId === null ? { kind: "admin" } : { kind: "team", teamId },
  });
  const r = await app.inject({
    method: "POST",
    url: "/internal/realtime/read-models/metrics",
    payload: body,
    headers: headers(
      body,
      teamId === null ? "admin" : "reader",
      "/internal/realtime/read-models/metrics",
    ),
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data;
}
async function main() {
  resetMemoryDb();
  await app.register(internalRealtimeController, {
    prefix: "/internal/realtime",
    sharedSecret: secret,
    allowedNodes: new Map([
      ["poller", new Set([1, 2])],
      ["exec-a", new Set([1])],
      ["exec-b", new Set([1])],
      ["exec-c", new Set([2, 3])],
    ]),
    publisher: createPersistentInProcessRealtimePublisher(
      createSseRealtimeTransport({
        broadcastEnvelope: (e) => frames.push(e),
        broadcast: () => {},
        broadcastAdmin: () => {},
      }),
    ),
  });
  await app.register(internalRealtimeReadController, {
    prefix: "/internal/realtime",
    sharedSecret: secret,
    trustedNodeIds: new Set(["admin", "reader"]),
    adminNodeIds: new Set(["admin"]),
    allowedNodeTeams: new Map([["reader", new Set([1, 2, 3])]]),
    listExpectedTeamIds: async () => [1, 2, 3],
    loadRuntimeStatus: async () => ({}),
    now: () => new Date(now),
  });
  await app.ready();
  for (const teamId of [1, 2]) {
    const poll = sample(teamId, teamId, 10, "poller");
    poll.polling.totalRequests = 10;
    poll.polling.successCount = 10;
    poll.lastPoll.timestamp = new Date(now - 500).toISOString();
    assert.equal(
      (
        await send({
          type: "metrics.snapshot",
          payloadVersion: 1,
          payload: poll,
          scope: { kind: "team", teamId },
          source: { service: "poller-service", nodeId: "poller", role: "poller-service" },
        })
      ).statusCode,
      200,
    );
  }
  const primary = await getRealtimeMetricsReadModelByTeamId(1);
  const response = await send(execution(1, "exec-a", 2, 100));
  assert.equal(
    response.statusCode,
    200,
    `execution observations must be accepted through signed ingestion: ${response.body}`,
  );
  assert.equal((await send(execution(1, "exec-b", 3, 200))).statusCode, 200);
  assert.equal((await send(execution(2, "exec-c", 4, 300))).statusCode, 200);
  let team = await read(1);
  assert.equal(team.metrics.operations.acceptRtt.count, 6);
  assert.equal(team.metrics.operations.acceptRtt.avg, 135);
  assert.equal(team.metrics.operations.acceptRtt.p95, 200);
  assert.equal(team.metrics.upstream.requests, 6);
  assert.deepEqual(team.metrics.lastPoll, primary!.snapshot.lastPoll);
  assert.equal(team.teams[0].receivedAt, primary!.receivedAt);
  assert.deepEqual(
    await getRealtimeMetricsReadModelByTeamId(1),
    primary,
    "execution must not write the poll table",
  );
  assert.equal((await read(2)).metrics.operations.acceptRtt.count, 6);
  const aggregate = await read(null);
  const transport = createSseRealtimeTransport({
    broadcastEnvelope: (e) => adminFrames.push(e.payload),
    broadcast: () => {},
    broadcastAdmin: (e) => adminFrames.push(e.data),
  });
  await transport.publishLegacy({ event: "metrics", data: new MetricsCollector().snapshot() });
  assert.equal(
    (adminFrames.at(-1) as ReturnType<MetricsCollector["snapshot"]>).operations.acceptRtt.count,
    12,
    "legacy admin SSE must aggregate merged team snapshots",
  );
  await transport.publishEnvelope(
    createRealtimeEnvelope({
      type: "metrics.aggregate",
      payloadVersion: 1,
      payload: new MetricsCollector().snapshot(),
      source: { service: "realtime-service", role: "realtime-service", nodeId: "realtime" },
      scope: { kind: "admin" },
    }),
  );
  assert.equal(
    (adminFrames.at(-1) as ReturnType<MetricsCollector["snapshot"]>).operations.acceptRtt.count,
    12,
    "canonical admin SSE must aggregate merged teams",
  );
  assert.equal(aggregate.metrics.operations.acceptRtt.count, 12);
  assert.equal(aggregate.teams.length, 2);
  assert.deepEqual(aggregate.missingTeamIds, [3]);
  assert.equal(
    aggregate.metrics.upstream.connectionPools.length,
    4,
    "one physical poll pool across two teams",
  );
  await send(execution(1, "exec-a", 2, 100));
  await send(execution(1, "exec-a", 99, 999, now - 1));
  await send(execution(1, "exec-a", 88, 888));
  assert.equal(
    (await read(1)).metrics.operations.acceptRtt.count,
    6,
    "repeat, older, equal timestamps retain first observation",
  );
  await send(execution(1, "exec-a", 1, 400, now + 1, now, "generation-2"));
  await send(execution(1, "exec-a", 99, 999, now + 2, now - 1000));
  team = await read(1);
  assert.equal(
    team.metrics.operations.acceptRtt.count,
    5,
    "restart replaces old generation even if old samples arrive later",
  );
  assert.equal(
    frames
      .filter(
        (f) => f.type === "metrics.snapshot" && f.scope.kind === "team" && f.scope.teamId === 1,
      )
      .at(-1)!.payload &&
      (frames.at(-1)!.payload as ReturnType<MetricsCollector["snapshot"]>).operations.acceptRtt
        .count,
    5,
  );
  const repoll = {
    type: "metrics.snapshot",
    payloadVersion: 1,
    payload: primary!.snapshot,
    scope: { kind: "team", teamId: 1 },
    source: { service: "poller-service", nodeId: "poller", role: "poller-service" },
  } satisfies RealtimePublishInput;
  await send(repoll);
  assert.equal(
    (frames.at(-1)!.payload as ReturnType<MetricsCollector["snapshot"]>).operations.acceptRtt.count,
    5,
    "raw poll SSE retains execution overlay",
  );
  assert.equal(
    getRawMemoryDb().prepare("SELECT COUNT(*) AS n FROM realtime_execution_metrics").get()!.n,
    3,
  );
  const invalid = execution(1, "exec-a", 1, 1);
  (invalid.payload as { teamId: number }).teamId = 2;
  assert.notEqual((await send(invalid)).statusCode, 200);
  assert.equal((await send(execution(2, "exec-a", 1, 1))).statusCode, 403);
  assert.notEqual((await send(execution(1, "exec-a", 1, 1, now + 120_001))).statusCode, 200);
  const beforeOrphan = frames.length;
  assert.equal((await send(execution(3, "exec-c", 8, 800))).statusCode, 200);
  assert.equal(
    frames.length,
    beforeOrphan,
    "execution without primary produces no poll health frame",
  );
  assert.equal((await read(3)).teams.length, 0);
  assert.equal((await read(3)).metrics.polling.totalRequests, 0);
  for (const mutate of [
    (event: RealtimePublishInput) => {
      event.scope = { kind: "admin" };
    },
    (event: RealtimePublishInput) => {
      event.source.service = "poller-service";
    },
    (event: RealtimePublishInput) => {
      event.payload = { ...(event.payload as object), providerBody: { bookingId: 1 } };
    },
    (event: RealtimePublishInput) => {
      (
        event.payload as { operations: { acceptRtt: { count: number } } }
      ).operations.acceptRtt.count = -1;
    },
  ]) {
    const bad = execution(1, "exec-a", 1, 1);
    mutate(bad);
    assert.notEqual((await send(bad)).statusCode, 200, "invalid execution boundary is denied");
  }
  // Slight future skew is accepted, but receiver time still bounds freshness.
  const clock = Date.now();
  await projectRealtimeObservationsEnvelope(
    createRealtimeEnvelope({
      ...execution(1, "future", 9, 900, clock + 4000, clock - 1000),
      now: new Date(clock),
    }),
  );
  const freshFuture = (await listMergedRealtimeMetricsReadModels(clock)).find(
    (row) => row.teamId === 1,
  )!;
  assert.equal(freshFuture.snapshot.operations.acceptRtt.count, 14);
  const expired = (await listMergedRealtimeMetricsReadModels(clock + 120_001)).find(
    (row) => row.teamId === 1,
  )!;
  assert.equal(
    expired.snapshot.operations.acceptRtt.count,
    1,
    "future events expire by receiver-time TTL",
  );
  // Store obsolete producers via the same projection, then opportunistic ingest cleanup removes only old rows.
  const oldTime = clock - 700_000;
  await projectRealtimeObservationsEnvelope(
    createRealtimeEnvelope({
      ...execution(1, "retired", 4, 400, oldTime, oldTime - 1000),
      now: new Date(oldTime),
    }),
  );
  assert.equal(
    getRawMemoryDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM realtime_execution_metrics WHERE source_node_id = 'retired'",
      )
      .get()!.n,
    1,
  );
  await projectRealtimeObservationsEnvelope(
    createRealtimeEnvelope({
      ...execution(1, "cleanup", 1, 1, clock, clock - 1000),
      now: new Date(clock),
    }),
  );
  assert.equal(
    getRawMemoryDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM realtime_execution_metrics WHERE source_node_id = 'retired'",
      )
      .get()!.n,
    0,
  );
  assert.equal(
    getRawMemoryDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM realtime_execution_metrics WHERE source_node_id = 'exec-b'",
      )
      .get()!.n,
    1,
  );
  now = Date.now() + 120_002;
  assert.equal((await read(1)).teams.length, 0, "execution cannot refresh poll health");
  console.log(
    "execution-metrics: signed projection, team/admin reads, SSE, ordering, generation and scope passed",
  );
}
main()
  .finally(async () => {
    await app.close();
    await closePool();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
