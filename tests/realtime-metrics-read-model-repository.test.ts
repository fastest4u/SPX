process.env.DB_MODE = "memory";

import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import {
  getRealtimeMetricsReadModelByTeamId,
  listRealtimeMetricsReadModels,
  projectRealtimeMetricsEnvelope,
} from "../src/repositories/realtime-metrics-read-model-repository.js";
import { createRealtimeEnvelope } from "../src/services/realtime-contract.js";
import { MetricsCollector, type MetricsSnapshot } from "../src/services/metrics.js";

function snapshot(teamId: number, totalRequests: number): MetricsSnapshot {
  const collector = new MetricsCollector({ teamId, teamName: `Team ${teamId}` });
  for (let index = 0; index < totalRequests; index += 1) {
    collector.recordPoll(50 + index, true, "same", 3);
  }
  return collector.snapshot();
}

function metricsEnvelope(input: {
  teamId?: number;
  nodeId?: string;
  snapshot?: unknown;
  emittedAt?: string;
  receivedAt?: string;
}) {
  const teamId = input.teamId ?? 2;
  return createRealtimeEnvelope({
    type: "metrics.snapshot",
    payloadVersion: 1,
    payload: input.snapshot ?? snapshot(teamId, 1),
    source: { service: "worker", nodeId: input.nodeId ?? "worker-ifn-1", role: "worker" },
    scope: { kind: "team", teamId },
    subject: { type: "team", id: String(teamId), teamId },
    emittedAt: input.emittedAt ?? "2030-01-01T00:00:00.000Z",
    now: new Date(input.receivedAt ?? "2030-01-01T00:00:01.000Z"),
  });
}

async function main(): Promise<void> {
  await closePool();
  resetMemoryDb();

  const unsafePayload = {
    ...snapshot(2, 1),
    accessToken: "must-not-persist",
    ACCESS_TOKEN: "must-not-persist",
    polling: {
      ...snapshot(2, 1).polling,
      cookie: "must-not-persist",
      Authorization: "must-not-persist",
    },
  } as unknown;
  const inserted = await projectRealtimeMetricsEnvelope(metricsEnvelope({ snapshot: unsafePayload }));
  assert.equal(inserted.projected, true);
  if (!inserted.projected) throw new Error("expected metrics projection");
  assert.equal(inserted.outcome, "inserted");
  assert.equal(inserted.record.teamId, 2);
  assert.equal(inserted.record.nodeId, "worker-ifn-1");
  assert.equal(inserted.record.receivedAt, Date.parse("2030-01-01T00:00:01.000Z"));
  assert.equal(inserted.record.snapshot.polling.totalRequests, 1);
  assert.equal("accessToken" in inserted.record.snapshot, false);
  assert.equal("cookie" in inserted.record.snapshot.polling, false);

  const raw = getRawMemoryDb()
    .prepare("SELECT snapshot_json FROM realtime_metrics_read_models WHERE team_id = ?")
    .get(2) as { snapshot_json: string };
  const storedSnapshot = JSON.parse(raw.snapshot_json) as Record<string, unknown>;
  assert.equal("accessToken" in storedSnapshot, false);
  assert.equal("ACCESS_TOKEN" in storedSnapshot, false);
  assert.equal("Authorization" in (storedSnapshot.polling as object), false);

  const stale = await projectRealtimeMetricsEnvelope(metricsEnvelope({
    nodeId: "worker-stale",
    snapshot: snapshot(2, 99),
    receivedAt: "2030-01-01T00:00:00.999Z",
  }));
  assert.equal(stale.projected, true);
  if (!stale.projected) throw new Error("expected stale metrics projection result");
  assert.equal(stale.outcome, "stale");
  assert.equal(stale.record.nodeId, "worker-ifn-1");
  assert.equal(stale.record.snapshot.polling.totalRequests, 1);

  const equalConflict = await projectRealtimeMetricsEnvelope(metricsEnvelope({
    nodeId: "worker-equal-conflict",
    snapshot: snapshot(2, 50),
    emittedAt: "2030-01-01T00:00:00.500Z",
    receivedAt: "2030-01-01T00:00:01.000Z",
  }));
  assert.equal(equalConflict.projected, true);
  if (!equalConflict.projected) throw new Error("expected equal metrics projection result");
  assert.equal(equalConflict.outcome, "equal_received_at_retained");
  assert.equal(equalConflict.record.nodeId, "worker-ifn-1");

  const idempotent = await projectRealtimeMetricsEnvelope(metricsEnvelope({
    snapshot: unsafePayload,
    receivedAt: "2030-01-01T00:00:01.000Z",
  }));
  assert.equal(idempotent.projected, true);
  if (!idempotent.projected) throw new Error("expected idempotent metrics projection result");
  assert.equal(idempotent.outcome, "idempotent");

  const updated = await projectRealtimeMetricsEnvelope(metricsEnvelope({
    nodeId: "worker-ifn-2",
    snapshot: snapshot(2, 2),
    emittedAt: "2030-01-01T00:00:01.500Z",
    receivedAt: "2030-01-01T00:00:02.000Z",
  }));
  assert.equal(updated.projected, true);
  if (!updated.projected) throw new Error("expected updated metrics projection result");
  assert.equal(updated.outcome, "updated");
  assert.equal(updated.record.nodeId, "worker-ifn-2");
  assert.equal(updated.record.snapshot.polling.totalRequests, 2);

  const read = await getRealtimeMetricsReadModelByTeamId(2);
  assert.ok(read);
  assert.equal(read.snapshot.teamId, 2);
  assert.equal(read.receivedAt, Date.parse("2030-01-01T00:00:02.000Z"));
  assert.equal(Number.isFinite(read.updatedAt), true);

  await projectRealtimeMetricsEnvelope(metricsEnvelope({ teamId: 1, nodeId: "worker-ptwl-1" }));
  assert.deepEqual((await listRealtimeMetricsReadModels()).map((record) => record.teamId), [1, 2]);

  const ignored = await projectRealtimeMetricsEnvelope(createRealtimeEnvelope({
    type: "runtime.node.changed",
    payloadVersion: 1,
    payload: { status: "ready" },
    source: { service: "web-api", nodeId: "web-1", role: "web-api" },
    scope: { kind: "admin" },
    now: new Date("2030-01-01T00:00:03.000Z"),
  }));
  assert.deepEqual(ignored, { projected: false, reason: "not-metrics-snapshot" });

  await assert.rejects(
    () => projectRealtimeMetricsEnvelope(createRealtimeEnvelope({
      type: "metrics.snapshot",
      payloadVersion: 1,
      payload: snapshot(2, 1),
      source: { service: "worker", nodeId: "worker-ifn-1", role: "worker" },
      scope: { kind: "admin" },
      now: new Date("2030-01-01T00:00:03.000Z"),
    })),
    /team scope/,
  );
  await assert.rejects(
    () => projectRealtimeMetricsEnvelope(metricsEnvelope({ snapshot: { teamId: 2 } })),
    /metrics snapshot/i,
  );
  await assert.rejects(
    () => projectRealtimeMetricsEnvelope(metricsEnvelope({ teamId: 2, snapshot: snapshot(3, 1) })),
    /teamId.*scope/i,
  );
  await assert.rejects(
    () => projectRealtimeMetricsEnvelope({
      ...metricsEnvelope({ receivedAt: "2030-01-01T00:00:04.000Z" }),
      replayable: true,
      idempotencyKey: "metrics:team:2:deduplicated",
    }),
    /idempotencyKey.*latest projection/i,
  );

  await closePool();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
