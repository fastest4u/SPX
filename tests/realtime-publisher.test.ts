import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { getRealtimeEventByEventId } from "../src/repositories/realtime-event-repository.js";
import { getRealtimeMetricsReadModelByTeamId } from "../src/repositories/realtime-metrics-read-model-repository.js";
import type { RealtimeEnvelopeV1, RealtimePublishInput } from "../src/services/realtime-contract.js";
import { MetricsCollector } from "../src/services/metrics.js";
import {
  InProcessRealtimePublisher,
  createPersistentInProcessRealtimePublisher,
  createPersistentRealtimePublisher,
  createSseRealtimeTransport,
  publishRealtimeWithLegacy,
  type LegacyRealtimeEvent,
  type RealtimeTransport,
} from "../src/services/realtime-publisher.js";

type BroadcastCall =
  | { method: "broadcast"; event: string; teamId?: number; data: unknown }
  | { method: "broadcastAdmin"; event: string; data: unknown }
  | { method: "broadcastEnvelope"; envelope: RealtimeEnvelopeV1 };

class FakeTransport implements RealtimeTransport {
  envelopes: RealtimeEnvelopeV1[] = [];
  legacyEvents: LegacyRealtimeEvent[] = [];

  async publishEnvelope(envelope: RealtimeEnvelopeV1): Promise<void> {
    this.envelopes.push(envelope);
  }

  async publishLegacy(event: LegacyRealtimeEvent): Promise<void> {
    this.legacyEvents.push(event);
  }
}

function metricsInput(overrides: Partial<RealtimePublishInput> = {}): RealtimePublishInput<{ total: number }> {
  return {
    type: "metrics.snapshot",
    payloadVersion: 1,
    payload: { total: 7 },
    source: { service: "worker", nodeId: "worker-ifn-1", role: "worker" },
    scope: { kind: "team", teamId: 2 },
    subject: { type: "team", id: "2", teamId: 2 },
    emittedAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function main(): Promise<void> {
  const transport = new FakeTransport();
  const publisher = new InProcessRealtimePublisher(transport);

  const result = await publisher.publish(metricsInput());
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.persisted, false);
  assert.equal(typeof result.id, "string");
  assert.equal(typeof result.receivedAt, "string");
  assert.equal(transport.envelopes.length, 1);
  assert.equal(transport.envelopes[0]?.id, result.id);
  assert.equal(transport.envelopes[0]?.receivedAt, result.receivedAt);
  assert.equal(transport.envelopes[0]?.envelopeVersion, 1);
  assert.equal(transport.envelopes[0]?.type, "metrics.snapshot");
  assert.deepEqual(transport.envelopes[0]?.payload, { total: 7 });
  assert.deepEqual(transport.envelopes[0]?.scope, { kind: "team", teamId: 2 });
  assert.equal(transport.envelopes[0]?.replayable, false);

  const replayableSnapshot = await publisher.publishSnapshot(metricsInput({
    replayable: true,
    idempotencyKey: "metrics:team:2:snapshot",
  }));
  assert.equal(transport.envelopes.at(-1)?.id, replayableSnapshot.id);
  assert.equal(transport.envelopes.at(-1)?.replayable, true);
  assert.equal(transport.envelopes.at(-1)?.idempotencyKey, "metrics:team:2:snapshot");

  await publisher.publishSnapshot(metricsInput({ replayable: undefined }));
  assert.equal(transport.envelopes.at(-1)?.replayable, false);

  const calls: BroadcastCall[] = [];
  const broadcaster = {
    broadcastEnvelope(envelope: RealtimeEnvelopeV1) {
      calls.push({ method: "broadcastEnvelope", envelope });
    },
    broadcast(event: { event: string; teamId?: number; data: unknown }) {
      calls.push({ method: "broadcast", ...event });
    },
    broadcastAdmin(event: { event: string; data: unknown }) {
      calls.push({ method: "broadcastAdmin", ...event });
    },
  };
  const sseTransport = createSseRealtimeTransport(broadcaster);

  await sseTransport.publishEnvelope(transport.envelopes[0]!);
  assert.deepEqual(calls.pop(), {
    method: "broadcastEnvelope",
    envelope: transport.envelopes[0],
  });

  const adminEnvelope = transport.envelopes[0] ? {
    ...transport.envelopes[0],
    scope: { kind: "admin" as const },
  } : null;
  await sseTransport.publishEnvelope(adminEnvelope!);
  assert.deepEqual(calls.pop(), {
    method: "broadcastEnvelope",
    envelope: adminEnvelope,
  });

  await sseTransport.publishLegacy({ event: "metrics", teamId: 2, data: { legacy: true } });
  assert.deepEqual(calls.pop(), {
    method: "broadcast",
    event: "metrics",
    teamId: 2,
    data: { legacy: true },
  });

  await sseTransport.publishLegacy({ event: "rules", adminOnly: true, data: { changed: true } });
  assert.deepEqual(calls.pop(), {
    method: "broadcastAdmin",
    event: "rules",
    data: { changed: true },
  });

  await sseTransport.publishLegacy({ event: "session-expired", data: { reason: "expired" } });
  assert.deepEqual(calls.pop(), {
    method: "broadcastAdmin",
    event: "session-expired",
    data: { reason: "expired" },
  });

  const dualTransport = new FakeTransport();
  const dualPublisher = new InProcessRealtimePublisher(dualTransport);
  const dualResult = await publishRealtimeWithLegacy(dualPublisher, metricsInput(), [
    { event: "metrics", teamId: 2, data: { total: 7 } },
    { event: "rules", adminOnly: true, data: { changed: true } },
  ]);
  assert.equal(dualResult.accepted, true);
  assert.equal(dualTransport.envelopes.length, 1);
  assert.deepEqual(dualTransport.legacyEvents, [
    { event: "metrics", teamId: 2, data: { total: 7 } },
    { event: "rules", adminOnly: true, data: { changed: true } },
  ]);

  await closePool();
  resetMemoryDb();

  const persistentTransport = new FakeTransport();
  const persistentPublisher = createPersistentRealtimePublisher(persistentTransport);
  const persistentInput = metricsInput({
    replayable: true,
    idempotencyKey: "metrics:persistent:team:2",
    payload: { total: 11 },
  });

  const persisted = await persistentPublisher.publish(persistentInput);
  assert.equal(persisted.accepted, true);
  assert.equal(persisted.duplicate, false);
  assert.equal(persisted.persisted, true);
  assert.equal(persistentTransport.envelopes.length, 1);
  assert.equal(persistentTransport.envelopes[0]?.id, persisted.id);

  const stored = await getRealtimeEventByEventId(persisted.id);
  assert.ok(stored);
  assert.equal(stored.idempotencyKey, "metrics:persistent:team:2");
  assert.equal(JSON.parse(stored.payloadJson).total, 11);

  const duplicate = await persistentPublisher.publish(metricsInput({
    replayable: true,
    idempotencyKey: "metrics:persistent:team:2",
    payload: { total: 99 },
  }));
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.persisted, true);
  assert.equal(duplicate.id, persisted.id);
  assert.equal(persistentTransport.envelopes.length, 1);

  const storedAfterDuplicate = await getRealtimeEventByEventId(persisted.id);
  assert.ok(storedAfterDuplicate);
  assert.equal(JSON.parse(storedAfterDuplicate.payloadJson).total, 11);

  const projectionOrder: string[] = [];
  const projectionTransport = new FakeTransport();
  const orderedPublisher = createPersistentRealtimePublisher(projectionTransport, {
    projectEnvelope(envelope) {
      assert.equal(envelope.envelopeVersion, 1);
      projectionOrder.push("projection");
    },
    async persistEnvelope(envelope) {
      projectionOrder.push("persistence");
      return {
        duplicate: false,
        row: {
          eventId: envelope.id,
          receivedAt: new Date(envelope.receivedAt),
          envelopeJson: JSON.stringify(envelope),
        } as never,
      };
    },
  });
  const originalProjectionPublish = projectionTransport.publishEnvelope.bind(projectionTransport);
  projectionTransport.publishEnvelope = async (envelope) => {
    projectionOrder.push("fanout");
    await originalProjectionPublish(envelope);
  };
  await orderedPublisher.publish(metricsInput({
    replayable: true,
    idempotencyKey: "metrics:projection-order:team:2",
  }));
  assert.deepEqual(projectionOrder, ["projection", "persistence", "fanout"]);

  let failedProjectionPersistCalls = 0;
  const failedProjectionTransport = new FakeTransport();
  const failedProjectionPublisher = createPersistentRealtimePublisher(failedProjectionTransport, {
    projectEnvelope() {
      throw new Error("projection unavailable");
    },
    async persistEnvelope() {
      failedProjectionPersistCalls += 1;
      throw new Error("must not persist");
    },
  });
  await assert.rejects(() => failedProjectionPublisher.publish(metricsInput()), /projection unavailable/);
  assert.equal(failedProjectionPersistCalls, 0);
  assert.equal(failedProjectionTransport.envelopes.length, 0);

  await closePool();
  resetMemoryDb();
  const defaultProjectionTransport = new FakeTransport();
  const defaultProjectionPublisher = createPersistentInProcessRealtimePublisher(defaultProjectionTransport);
  const fullSnapshotCollector = new MetricsCollector({ teamId: 2, teamName: "IFN" });
  fullSnapshotCollector.recordPoll(80, true, "same", 1);
  const fullSnapshot = fullSnapshotCollector.snapshot();
  const defaultProjectionResult = await defaultProjectionPublisher.publish({
    type: "metrics.snapshot",
    payloadVersion: 1,
    payload: fullSnapshot,
    source: { service: "worker", nodeId: "worker-ifn-default", role: "worker" },
    scope: { kind: "team", teamId: 2 },
    subject: { type: "team", id: "2", teamId: 2 },
    replayable: false,
  });
  assert.equal(defaultProjectionResult.persisted, false);
  assert.equal(await getRealtimeEventByEventId(defaultProjectionResult.id), null);
  assert.equal((await getRealtimeMetricsReadModelByTeamId(2))?.snapshot.polling.totalRequests, 1);
  assert.equal(defaultProjectionTransport.envelopes.length, 1);

  const eventCountBeforeRejectedDuplicate = (getRawMemoryDb()
    .prepare("SELECT COUNT(*) AS count FROM realtime_events")
    .get() as { count: number }).count;
  await assert.rejects(
    () => defaultProjectionPublisher.publish({
      type: "metrics.snapshot",
      payloadVersion: 1,
      payload: { ...fullSnapshot, polling: { ...fullSnapshot.polling, totalRequests: 99 } },
      source: { service: "worker", nodeId: "worker-ifn-default", role: "worker" },
      scope: { kind: "team", teamId: 2 },
      subject: { type: "team", id: "2", teamId: 2 },
      replayable: true,
      idempotencyKey: "metrics:team:2:deduplicated",
    }),
    /idempotencyKey.*latest projection/i,
  );
  assert.equal((getRawMemoryDb().prepare("SELECT COUNT(*) AS count FROM realtime_events").get() as { count: number }).count, eventCountBeforeRejectedDuplicate);
  assert.equal((await getRealtimeMetricsReadModelByTeamId(2))?.snapshot.polling.totalRequests, 1);
  assert.equal(defaultProjectionTransport.envelopes.length, 1);

  await closePool();
  resetMemoryDb();

  const persistentLegacyTransport = new FakeTransport();
  const persistentLegacyPublisher = createPersistentRealtimePublisher(persistentLegacyTransport);
  const persistentLegacyInput = metricsInput({
    replayable: true,
    idempotencyKey: "metrics:persistent-legacy:team:2",
    payload: { total: 22 },
  });
  const persistentLegacyEvents = [{ event: "metrics", teamId: 2, data: { total: 22 } }];
  await publishRealtimeWithLegacy(persistentLegacyPublisher, persistentLegacyInput, persistentLegacyEvents);
  assert.equal(persistentLegacyTransport.envelopes.length, 1);
  assert.deepEqual(persistentLegacyTransport.legacyEvents, persistentLegacyEvents);

  const persistentLegacyDuplicate = await publishRealtimeWithLegacy(
    persistentLegacyPublisher,
    { ...persistentLegacyInput, payload: { total: 220 } },
    [{ event: "metrics", teamId: 2, data: { total: 220 } }],
  );
  assert.equal(persistentLegacyDuplicate.duplicate, true);
  assert.equal(persistentLegacyTransport.envelopes.length, 1);
  assert.deepEqual(persistentLegacyTransport.legacyEvents, persistentLegacyEvents);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
