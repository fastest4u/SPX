import assert from "node:assert/strict";
import {
  assertSupportedRealtimeEnvelope,
  createRealtimeEnvelope,
  serializeSseEnvelope,
} from "../src/services/realtime-contract.js";

async function main(): Promise<void> {
  const envelope = createRealtimeEnvelope({
    type: "metrics.snapshot",
    payloadVersion: 1,
    payload: { polling: { totalRequests: 1 } },
    source: {
      service: "worker",
      nodeId: "worker-ifn-1",
      role: "worker",
    },
    scope: { kind: "team", teamId: 2 },
    subject: { type: "team", id: "2", teamId: 2 },
    traceId: "trace-1",
    emittedAt: "2030-01-01T00:00:00.000Z",
    now: new Date("2030-01-01T00:00:01.000Z"),
  });

  assert.equal(envelope.envelopeVersion, 1);
  assert.equal(envelope.type, "metrics.snapshot");
  assert.equal(envelope.payloadVersion, 1);
  assert.equal(envelope.emittedAt, "2030-01-01T00:00:00.000Z");
  assert.equal(envelope.receivedAt, "2030-01-01T00:00:01.000Z");
  assert.equal(envelope.replayable, false);
  assert.equal(envelope.scope.kind, "team");
  assert.equal(envelope.scope.kind === "team" ? envelope.scope.teamId : null, 2);
  assert.ok(envelope.id.length > 10);

  assertSupportedRealtimeEnvelope(envelope);

  const serialized = serializeSseEnvelope(envelope);
  assert.match(serialized, new RegExp(`^id: ${envelope.id}\\nevent: metrics\\.snapshot\\ndata: `));
  assert.ok(serialized.endsWith("\n\n"));
  const serializedData = JSON.parse(serialized.split("\ndata: ")[1]);
  assert.equal(serializedData.envelopeVersion, 1);
  assert.equal(serializedData.id, envelope.id);
  assert.deepEqual(serializedData.scope, { kind: "team", teamId: 2 });

  const resetFrame = serializeSseEnvelope(envelope, { resetLastEventId: true });
  assert.match(resetFrame, /^id:\nevent: metrics\.snapshot\n/);
  assert.doesNotMatch(resetFrame, /^id: metrics\.snapshot/);

  const replayable = createRealtimeEnvelope({
    type: "notification.queue.changed",
    payloadVersion: 1,
    payload: { queued: 1 },
    source: { service: "notification-service", nodeId: "notifier-1", role: "notification-service" },
    scope: { kind: "admin" },
    replayable: true,
    idempotencyKey: "notification:queue:1",
    now: new Date("2030-01-01T00:00:02.000Z"),
  });
  assert.equal(replayable.replayable, true);
  assert.equal(replayable.idempotencyKey, "notification:queue:1");
  assertSupportedRealtimeEnvelope(replayable);

  const webApiEnvelope = createRealtimeEnvelope({
    type: "read-model.resync-required",
    payloadVersion: 1,
    payload: { reason: "cursor_expired" },
    source: { service: "web-api", nodeId: "web-api-1", role: "api" },
    scope: { kind: "admin" },
    now: new Date("2030-01-01T00:00:03.000Z"),
  });
  assertSupportedRealtimeEnvelope(webApiEnvelope);

  const rulesChanged = createRealtimeEnvelope({
    type: "rules.changed",
    payloadVersion: 1,
    payload: [{ id: "rule-1", enabled: true }],
    source: { service: "web-api", nodeId: "web-api-1", role: "api" },
    scope: { kind: "team", teamId: 2 },
    subject: { type: "rules", id: "2", teamId: 2 },
    replayable: false,
  });
  assert.equal(rulesChanged.type, "rules.changed");
  assertSupportedRealtimeEnvelope(rulesChanged);

  for (const service of ["poller-service", "auto-accept-service"] as const) {
    const dedicatedServiceEnvelope = createRealtimeEnvelope({
      type: "runtime.node.changed",
      payloadVersion: 1,
      payload: { state: "running" },
      source: { service, nodeId: `${service}-1`, role: service },
      scope: { kind: "admin" },
    });
    assertSupportedRealtimeEnvelope(dedicatedServiceEnvelope);
    assert.equal(dedicatedServiceEnvelope.source.service, service);
  }

  assert.throws(
    () => createRealtimeEnvelope({
      type: "metrics.snapshot",
      payloadVersion: 1,
      payload: {},
      source: { service: "worker", nodeId: "", role: "worker" },
      scope: { kind: "team", teamId: 2 },
    }),
    /source.nodeId must be non-empty/,
  );
  assert.throws(
    () => createRealtimeEnvelope({
      type: "metrics.snapshot",
      payloadVersion: 1,
      payload: {},
      source: { service: "worker", nodeId: "worker-1", role: "worker" },
      scope: { kind: "team", teamId: 0 },
    }),
    /scope.teamId must be a positive integer/,
  );
  assert.throws(
    () => createRealtimeEnvelope({
      type: "notification.queue.changed",
      payloadVersion: 1,
      payload: {},
      source: { service: "notification-service", nodeId: "notifier-1", role: "notification-service" },
      scope: { kind: "admin" },
      replayable: true,
    }),
    /idempotencyKey is required for replayable events/,
  );
  assert.throws(
    () => createRealtimeEnvelope({
      type: "metrics.snapshot",
      payloadVersion: 1,
      payload: {},
      source: { service: "dashboard", nodeId: "dashboard-1", role: "dashboard" },
      scope: { kind: "admin" },
    }),
    /Unsupported realtime source service/,
  );
  assert.throws(
    () => assertSupportedRealtimeEnvelope({ ...envelope, envelopeVersion: 2 }),
    /Unsupported realtime envelope version/,
  );
  assert.throws(
    () => assertSupportedRealtimeEnvelope({ ...envelope, type: "legacy.metrics" }),
    /Unsupported realtime event type/,
  );
  assert.throws(
    () => assertSupportedRealtimeEnvelope({ ...envelope, payloadVersion: 2 }),
    /Unsupported realtime payload version/,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
