import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { notificationDeliveries, notificationEvents } from "../src/db/schema.js";
import {
  claimNotificationOutboxBatch,
  createNotificationEventAndOutbox,
  markNotificationDelivered,
  markNotificationFailed,
} from "../src/repositories/notification-repository.js";

function buildEvent(keySuffix: string) {
  return {
    schemaVersion: 1 as const,
    eventKey: `auto_accept_owned:team:2:booking:2791810:req:${keySuffix}`,
    eventType: "auto_accept_result" as const,
    severity: "success" as const,
    teamId: 2,
    workerNodeId: "ptwl-worker-01",
    traceId: "aa:2:2791810:40288114:1",
    subjectType: "booking",
    subjectId: "2791810",
    payload: {
      schemaVersion: 1 as const,
      eventType: "auto_accept_result" as const,
      severity: "success" as const,
      teamId: 2,
      teamName: "PTWL",
      bookingId: "2791810",
      requestIds: ["40288114"],
      status: "owned" as const,
      message: "accepted",
      occurredAt: new Date().toISOString(),
    },
  };
}

function defaultOutbox() {
  return {
    targetType: "line_group",
    targetId: "C123",
    title: "PTWL Auto-Accept success",
    message: "accepted",
  };
}

async function deliveryRows(outboxId: number) {
  const db = await getDb();
  return await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.outboxId, outboxId))
    .orderBy(notificationDeliveries.id);
}

async function createAndClaim(eventKeySuffix: string, nodeId: string, now: Date, lockMs = 30_000) {
  const event = buildEvent(eventKeySuffix);
  const created = await createNotificationEventAndOutbox(event, defaultOutbox());
  const [claimed] = await claimNotificationOutboxBatch(nodeId, 5, lockMs, now);
  assert.ok(claimed);
  assert.equal(claimed.id, created.outboxId);
  return claimed;
}

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

async function main() {
  await resetDb();
  const event = buildEvent("40288114");
  const first = await createNotificationEventAndOutbox(event, defaultOutbox());
  assert.equal(first.duplicate, false);
  assert.equal(first.outboxStatus, "queued");

  const duplicate = await createNotificationEventAndOutbox(event, defaultOutbox());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.outboxId, first.outboxId);
  assert.equal(duplicate.outboxStatus, "queued");

  await resetDb();
  const strandedEvent = buildEvent("stranded-event");
  const db = await getDb();
  await db.insert(notificationEvents).values({
    eventKey: strandedEvent.eventKey,
    schemaVersion: strandedEvent.schemaVersion,
    eventType: strandedEvent.eventType,
    severity: strandedEvent.severity,
    teamId: strandedEvent.teamId,
    workerNodeId: strandedEvent.workerNodeId,
    traceId: strandedEvent.traceId,
    subjectType: strandedEvent.subjectType,
    subjectId: strandedEvent.subjectId,
    payloadJson: JSON.stringify(strandedEvent.payload),
  });
  const healed = await createNotificationEventAndOutbox(strandedEvent, defaultOutbox());
  assert.equal(healed.duplicate, true);
  assert.equal(healed.outboxStatus, "queued");

  await resetDb();
  await createNotificationEventAndOutbox(event, defaultOutbox());
  const baselineNow = new Date("2030-06-29T07:00:00.000Z");
  const claimed = await claimNotificationOutboxBatch("notifier-01", 5, 30_000, baselineNow);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].eventKey, event.eventKey);

  await markNotificationFailed(claimed[0].id, "notifier-01", "line down", 1000, new Date("2030-06-29T07:00:01.000Z"));
  const retry = await claimNotificationOutboxBatch("notifier-01", 5, 30_000, new Date("2030-06-29T07:00:03.000Z"));
  assert.equal(retry.length, 1);

  await markNotificationDelivered(retry[0].id, "notifier-01", "linejs", "msg-1", new Date("2030-06-29T07:00:04.000Z"));
  const deliveredRows = await deliveryRows(retry[0].id);
  assert.equal(deliveredRows.at(-1)?.status, "success");
  const empty = await claimNotificationOutboxBatch("notifier-01", 5, 30_000, new Date("2030-06-29T07:00:05.000Z"));
  assert.equal(empty.length, 0);

  await resetDb();
  const lockStart = new Date("2030-06-29T08:00:00.000Z");
  const locked = await createAndClaim("lock-reclaim", "node-1", lockStart, 30_000);
  const early = await claimNotificationOutboxBatch("node-2", 5, 30_000, new Date("2030-06-29T08:00:10.000Z"));
  assert.equal(early.length, 0);
  const reclaimed = await claimNotificationOutboxBatch("node-2", 5, 30_000, new Date("2030-06-29T08:00:31.000Z"));
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].id, locked.id);
  assert.equal(reclaimed[0].lockedBy, "node-2");

  await resetDb();
  const optionalProviderRow = await createAndClaim("optional-provider-message", "node-1", lockStart);
  assert.equal(await markNotificationDelivered(optionalProviderRow.id, "node-1", "linejs"), true);
  const optionalProviderDeliveries = await deliveryRows(optionalProviderRow.id);
  assert.equal(optionalProviderDeliveries.length, 1);
  assert.equal(optionalProviderDeliveries[0].status, "success");
  assert.equal(optionalProviderDeliveries[0].providerMessageId, null);

  await resetDb();
  const staleDeliveredRow = await createAndClaim("stale-delivered", "old-node", lockStart, 30_000);
  const stolenForDelivery = await claimNotificationOutboxBatch("new-node", 5, 30_000, new Date("2030-06-29T08:00:31.000Z"));
  assert.equal(stolenForDelivery.length, 1);
  assert.equal(await markNotificationDelivered(staleDeliveredRow.id, "old-node", "linejs", "old-msg"), false);
  assert.equal((await deliveryRows(staleDeliveredRow.id)).length, 0);

  await resetDb();
  const staleFailedRow = await createAndClaim("stale-failed", "old-node", lockStart, 30_000);
  const stolenForFailure = await claimNotificationOutboxBatch("new-node", 5, 30_000, new Date("2030-06-29T08:00:31.000Z"));
  assert.equal(stolenForFailure.length, 1);
  assert.equal(await markNotificationFailed(staleFailedRow.id, "old-node", "old error", 1000, new Date("2030-06-29T08:00:32.000Z")), false);
  assert.equal((await deliveryRows(staleFailedRow.id)).length, 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
