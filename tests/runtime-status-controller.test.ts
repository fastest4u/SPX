import assert from "node:assert/strict";
import Fastify from "fastify";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { runtimeStatusController } from "../src/controllers/runtime-status-controller.js";
import { createNotificationEventAndOutbox } from "../src/repositories/notification-repository.js";
import { tryAcquireLease, upsertRuntimeNode } from "../src/repositories/runtime-repository.js";

async function main(): Promise<void> {
  resetMemoryDb();
  await upsertRuntimeNode({
    nodeId: "notifier-01",
    role: "notifier",
    hostname: "status-test",
    pid: 1234,
  });
  const lease = await tryAcquireLease({
    teamId: 2,
    nodeId: "worker-02",
    role: "worker",
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:00:00.000Z"),
  });
  assert.equal(lease.acquired, true);
  await createNotificationEventAndOutbox({
    schemaVersion: 1,
    eventKey: "auto_accept_owned:team:2:booking:2791810:req:40288114",
    eventType: "auto_accept_result",
    severity: "success",
    teamId: 2,
    workerNodeId: "worker-02",
    traceId: "aa:2:2791810:40288114:1",
    subjectType: "booking",
    subjectId: "2791810",
    payload: {
      schemaVersion: 1,
      eventType: "auto_accept_result",
      severity: "success",
      teamId: 2,
      teamName: "PTWL",
      bookingId: "2791810",
      requestIds: ["40288114"],
      status: "owned",
      message: "accepted",
      occurredAt: "2030-06-29T07:00:01.000Z",
    },
  }, {
    targetType: "line_group",
    targetId: "C123",
    title: "PTWL Auto-Accept success",
    message: "accepted",
  });

  const app = Fastify({ logger: false });
  try {
    await app.register(runtimeStatusController, { prefix: "/runtime" });

    const response = await app.inject({ method: "GET", url: "/runtime/status" });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(body.status, "success");
    assert.ok(Array.isArray(body.data.nodes));
    assert.ok(Array.isArray(body.data.leases));
    assert.equal(body.data.nodes.length, 1);
    assert.equal(body.data.nodes[0].nodeId, "notifier-01");
    assert.equal(body.data.leases.length, 1);
    assert.equal(body.data.leases[0].teamId, 2);
    assert.deepEqual(body.data.notifications, { queued: 1 });
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
