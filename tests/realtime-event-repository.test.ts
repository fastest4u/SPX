import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { createRealtimeEnvelope, type RealtimeEnvelopeV1 } from "../src/services/realtime-contract.js";
import {
  REALTIME_REPLAY_RETENTION_EVENT_LIMIT,
  REALTIME_REPLAY_RETENTION_MS,
  getRealtimeEventByEventId,
  listRealtimeEventsForReplay,
  persistRealtimeEnvelope,
  pruneReplayableRealtimeEvents,
} from "../src/repositories/realtime-event-repository.js";

async function resetDb(): Promise<void> {
  await closePool();
  resetMemoryDb();
}

function teamEnvelope(overrides: Partial<RealtimeEnvelopeV1> = {}): RealtimeEnvelopeV1 {
  return {
    ...createRealtimeEnvelope({
      id: "metrics.snapshot:team-2:1",
      type: "metrics.snapshot",
      payloadVersion: 1,
      payload: { totalRequests: 1 },
      source: { service: "worker", nodeId: "worker-1", role: "worker" },
      scope: { kind: "team", teamId: 2 },
      subject: { type: "team", id: "2", teamId: 2 },
      traceId: "trace-team-2",
      replayable: true,
      idempotencyKey: "metrics:snapshot:team:2:1",
      emittedAt: "2030-01-01T00:00:00.000Z",
      now: new Date("2030-01-01T00:00:01.000Z"),
    }),
    ...overrides,
  };
}

function adminEnvelope(overrides: Partial<RealtimeEnvelopeV1> = {}): RealtimeEnvelopeV1 {
  return {
    ...createRealtimeEnvelope({
      id: "runtime.node.changed:admin:1",
      type: "runtime.node.changed",
      payloadVersion: 1,
      payload: { nodeId: "worker-1" },
      source: { service: "web-api", nodeId: "web-api-1", role: "api" },
      scope: { kind: "admin" },
      replayable: true,
      idempotencyKey: "runtime:node:worker-1:1",
      emittedAt: "2030-01-01T00:00:02.000Z",
      now: new Date("2030-01-01T00:00:03.000Z"),
    }),
    ...overrides,
  };
}

function retentionTeamEnvelope(teamId: number, sequence: number, replayable = true): RealtimeEnvelopeV1 {
  return teamEnvelope({
    id: `metrics.snapshot:team-${teamId}:retention:${sequence}`,
    scope: { kind: "team", teamId },
    subject: { type: "team", id: String(teamId), teamId },
    idempotencyKey: `metrics:snapshot:team:${teamId}:retention:${sequence}`,
    replayable,
  });
}

async function main(): Promise<void> {
  await resetDb();

  const first = await persistRealtimeEnvelope(teamEnvelope());
  assert.equal(first.duplicate, false);
  assert.equal(first.row.eventId, "metrics.snapshot:team-2:1");
  assert.equal(first.row.idempotencyKey, "metrics:snapshot:team:2:1");
  assert.equal(first.row.eventType, "metrics.snapshot");
  assert.equal(first.row.payloadVersion, 1);
  assert.equal(first.row.envelopeVersion, 1);
  assert.equal(first.row.scopeKind, "team");
  assert.equal(first.row.teamId, 2);
  assert.equal(first.row.subjectType, "team");
  assert.equal(first.row.subjectId, "2");
  assert.equal(first.row.sourceService, "worker");
  assert.equal(first.row.sourceNodeId, "worker-1");
  assert.equal(first.row.sourceRole, "worker");
  assert.equal(first.row.traceId, "trace-team-2");
  assert.equal(first.row.replayable, 1);
  assert.equal(JSON.parse(first.row.payloadJson).totalRequests, 1);
  assert.equal(JSON.parse(first.row.envelopeJson).id, "metrics.snapshot:team-2:1");

  const byEventId = await getRealtimeEventByEventId("metrics.snapshot:team-2:1");
  assert.ok(byEventId);
  assert.equal(byEventId.id, first.row.id);

  const duplicateEvent = await persistRealtimeEnvelope(teamEnvelope({
    payload: { totalRequests: 99 },
    receivedAt: "2030-01-01T00:00:10.000Z",
  }));
  assert.equal(duplicateEvent.duplicate, true);
  assert.equal(duplicateEvent.row.id, first.row.id);
  assert.equal(JSON.parse(duplicateEvent.row.payloadJson).totalRequests, 1);

  const duplicateIdempotency = await persistRealtimeEnvelope(teamEnvelope({
    id: "metrics.snapshot:team-2:different-event-id",
    payload: { totalRequests: 123 },
  }));
  assert.equal(duplicateIdempotency.duplicate, true);
  assert.equal(duplicateIdempotency.row.id, first.row.id);
  assert.equal(await getRealtimeEventByEventId("metrics.snapshot:team-2:different-event-id"), null);

  const admin = await persistRealtimeEnvelope(adminEnvelope());
  assert.equal(admin.duplicate, false);

  const team3 = await persistRealtimeEnvelope(teamEnvelope({
    id: "metrics.snapshot:team-3:1",
    scope: { kind: "team", teamId: 3 },
    subject: { type: "team", id: "3", teamId: 3 },
    idempotencyKey: "metrics:snapshot:team:3:1",
    traceId: "trace-team-3",
  }));
  assert.equal(team3.duplicate, false);

  await assert.rejects(
    () => persistRealtimeEnvelope(teamEnvelope({
      id: "metrics.snapshot:team-2:1",
      idempotencyKey: "metrics:snapshot:team:3:1",
    })),
    /Realtime event identity conflict/,
  );

  const nonReplayable = await persistRealtimeEnvelope({
    ...createRealtimeEnvelope({
      id: "metrics.aggregate:team-2:not-replayable",
      type: "metrics.aggregate",
      payloadVersion: 1,
      payload: { window: "minute" },
      source: { service: "worker", nodeId: "worker-1", role: "worker" },
      scope: { kind: "team", teamId: 2 },
      replayable: false,
      emittedAt: "2030-01-01T00:00:04.000Z",
      now: new Date("2030-01-01T00:00:05.000Z"),
    }),
  });
  assert.equal(nonReplayable.duplicate, false);

  const teamReplay = await listRealtimeEventsForReplay({ scope: { kind: "team", teamId: 2 }, limit: 10 });
  assert.deepEqual(teamReplay.map((row) => row.eventId), ["metrics.snapshot:team-2:1"]);

  const adminReplay = await listRealtimeEventsForReplay({ scope: { kind: "admin" }, limit: 10 });
  assert.deepEqual(adminReplay.map((row) => row.eventId), [
    "metrics.snapshot:team-2:1",
    "runtime.node.changed:admin:1",
    "metrics.snapshot:team-3:1",
  ]);

  const team3Replay = await listRealtimeEventsForReplay({ scope: { kind: "team", teamId: 3 }, afterId: first.row.id, limit: 10 });
  assert.deepEqual(team3Replay.map((row) => row.eventId), ["metrics.snapshot:team-3:1"]);

  await assert.rejects(
    () => persistRealtimeEnvelope({ ...teamEnvelope(), envelopeVersion: 2 } as unknown as RealtimeEnvelopeV1),
    /Unsupported realtime envelope version/,
  );

  await resetDb();
  assert.equal(REALTIME_REPLAY_RETENTION_MS, 10 * 60 * 1000);
  assert.equal(REALTIME_REPLAY_RETENTION_EVENT_LIMIT, 2_000);

  for (const sequence of [1, 2, 3]) {
    await persistRealtimeEnvelope(retentionTeamEnvelope(2, sequence));
  }
  await pruneReplayableRealtimeEvents({
    now: new Date("2030-01-01T00:10:00.000Z"),
    minimumRetainedEvents: 2,
  });
  assert.equal(await getRealtimeEventByEventId("metrics.snapshot:team-2:retention:1"), null);
  assert.ok(await getRealtimeEventByEventId("metrics.snapshot:team-2:retention:2"));
  assert.ok(await getRealtimeEventByEventId("metrics.snapshot:team-2:retention:3"));

  await resetDb();
  for (const sequence of [1, 2, 3]) {
    await persistRealtimeEnvelope(retentionTeamEnvelope(4, sequence));
  }
  for (const sequence of [1, 2, 3, 4]) {
    await persistRealtimeEnvelope(adminEnvelope({
      id: `runtime.node.changed:admin:retention:${sequence}`,
      idempotencyKey: `runtime:node:retention:${sequence}`,
    }));
  }
  await pruneReplayableRealtimeEvents({
    now: new Date("2030-01-01T00:10:00.000Z"),
    minimumRetainedEvents: 4,
  });
  for (const sequence of [1, 2, 3]) {
    assert.ok(await getRealtimeEventByEventId(`metrics.snapshot:team-4:retention:${sequence}`));
  }

  await resetDb();
  await persistRealtimeEnvelope(adminEnvelope({
    id: "runtime.node.changed:admin:retention:old",
    idempotencyKey: "runtime:node:retention:old",
  }));
  await persistRealtimeEnvelope(retentionTeamEnvelope(2, 1));
  await persistRealtimeEnvelope(retentionTeamEnvelope(2, 2));
  await pruneReplayableRealtimeEvents({
    now: new Date("2030-01-01T00:10:00.000Z"),
    minimumRetainedEvents: 2,
  });
  assert.equal(await getRealtimeEventByEventId("runtime.node.changed:admin:retention:old"), null);

  await resetDb();
  await persistRealtimeEnvelope(retentionTeamEnvelope(2, 0, false));
  for (const sequence of [1, 2, 3]) {
    await persistRealtimeEnvelope(retentionTeamEnvelope(2, sequence));
  }
  await pruneReplayableRealtimeEvents({
    now: new Date("2030-01-01T00:10:00.000Z"),
    minimumRetainedEvents: 2,
  });
  assert.ok(await getRealtimeEventByEventId("metrics.snapshot:team-2:retention:0"));

  await resetDb();
  for (const sequence of [1, 2, 3]) {
    await persistRealtimeEnvelope(retentionTeamEnvelope(2, sequence));
  }
  await pruneReplayableRealtimeEvents({ now: new Date(), minimumRetainedEvents: 2 });
  for (const sequence of [1, 2, 3]) {
    assert.ok(await getRealtimeEventByEventId(`metrics.snapshot:team-2:retention:${sequence}`));
  }

  await assert.rejects(
    () => pruneReplayableRealtimeEvents({ minimumRetainedEvents: 0 }),
    /positive whole number/,
  );
  await assert.rejects(
    () => pruneReplayableRealtimeEvents({ now: new Date("invalid") }),
    /now must be a valid Date/,
  );
  await assert.rejects(
    () => pruneReplayableRealtimeEvents({ now: "invalid" as unknown as Date }),
    /now must be a valid Date/,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
