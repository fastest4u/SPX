import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { notificationOutbox } from "../src/db/schema.js";
import { createNotificationEventAndOutbox, claimNotificationOutboxBatch } from "../src/repositories/notification-repository.js";
import { runNotificationDispatchOnce } from "../src/services/notification-dispatcher.js";

type SendLineMessage = Parameters<typeof runNotificationDispatchOnce>[0]["sendLineMessage"];

function buildEvent(keySuffix: string) {
  return {
    eventKey: `auto_accept_owned:team:2:booking:2791810:req:${keySuffix}`,
    schemaVersion: 1 as const,
    eventType: "auto_accept_result" as const,
    severity: "success" as const,
    teamId: 2,
    workerNodeId: "worker-01",
    traceId: "trace-1",
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
    title: "success",
    message: "accepted",
  };
}

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

async function resetAndCreateOutbox(keySuffix: string) {
  await resetDb();
  await createNotificationEventAndOutbox(buildEvent(keySuffix), defaultOutbox());
}

async function claimRetryableLater() {
  return await claimNotificationOutboxBatch("retry-node", 5, 30_000, new Date(Date.now() + 3_000));
}

async function dispatchWith(sendLineMessage: SendLineMessage, options: Partial<Parameters<typeof runNotificationDispatchOnce>[0]> = {}) {
  return await runNotificationDispatchOnce({
    nodeId: "notifier-01",
    batchSize: 5,
    lockMs: 30_000,
    sendLineMessage,
    ...options,
  });
}

async function testSuccessfulDeliveryMarksSentOnce() {
  await resetAndCreateOutbox("40288114");
  const sent: string[] = [];
  const result = await dispatchWith(async (targetId, text) => {
    const [fenced] = await getDb().select().from(notificationOutbox);
    assert.equal(fenced.status, "provider_sending", "fence must commit before provider call");
    assert.ok(fenced.providerRequestId);
    assert.ok(fenced.providerStartedAt);
    sent.push(`${targetId}:${text}`);
    return { ok: true, providerMessageId: "msg-1" };
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(sent.length, 1);

  const claimedAgain = await claimNotificationOutboxBatch("notifier-01", 5, 30_000);
  assert.equal(claimedAgain.length, 0);
}

async function testFailedSendResultMarksRetryable() {
  await resetAndCreateOutbox("failed-result");

  const result = await dispatchWith(async () => ({ ok: false, error: "line down", deliveryCertainty: "not_sent" }));

  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 1 });
  const retry = await claimRetryableLater();
  assert.equal(retry.length, 1);
  assert.equal(retry[0].attempts, 1);
  assert.equal(retry[0].lastError, "line down");
}

async function testThrownSendIsAmbiguous() {
  await resetAndCreateOutbox("thrown-send");

  const result = await dispatchWith(async () => {
    throw new Error("line exploded");
  });

  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 1 });
  const retry = await claimRetryableLater();
  assert.equal(retry.length, 0);
  const [row] = await getDb().select().from(notificationOutbox);
  assert.equal(row.status, "delivery_ambiguous");
  assert.ok(row.providerRequestId);
}

async function testPermanentSendResultIsNotRetried() {
  await resetAndCreateOutbox("permanent-result");

  const result = await dispatchWith(async () => ({ ok: false, error: "bad line-service config", retryable: false, deliveryCertainty: "not_sent" }));

  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 1 });
  const retry = await claimRetryableLater();
  assert.equal(retry.length, 0);

  const db = await getDb();
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.eventKey, buildEvent("permanent-result").eventKey));
  assert.equal(row?.status, "failed_terminal");
  assert.equal(row?.attempts, 1);
  assert.equal(row?.lastError, "bad line-service config");
}

async function testUnknownFailureIsNotRetried() {
  await resetAndCreateOutbox("unknown-failure");
  await dispatchWith(async () => ({ ok: false, error: "request timed out", retryable: true }));
  assert.equal((await claimRetryableLater()).length, 0);
  const [row] = await getDb().select().from(notificationOutbox);
  assert.equal(row.status, "delivery_ambiguous");
  await resetAndCreateOutbox("unknown-permanent");
  await dispatchWith(async () => ({ ok: false, error: "invalid response after provider call", retryable: false }));
  const [unknown] = await getDb().select().from(notificationOutbox);
  assert.equal(unknown.status, "delivery_ambiguous", "retry classification is not delivery certainty");
}

async function testStaleDeliveredMarkIsNotCounted() {
  await resetAndCreateOutbox("stale-delivered");
  let reclaimed = 0;

  const result = await dispatchWith(async () => {
    const rows = await claimNotificationOutboxBatch("notifier-02", 5, 30_000, new Date(Date.now() + 31_000));
    reclaimed = rows.length;
    return { ok: true, providerMessageId: "late-msg" };
  });

  assert.equal(reclaimed, 0);
  assert.deepEqual(result, { claimed: 1, sent: 1, failed: 0 });
}

async function testBlankNodeIdThrows() {
  await resetDb();
  await assert.rejects(
    () => dispatchWith(async () => ({ ok: true }), { nodeId: "  " }),
    /nodeId is required/,
  );
}

async function testBatchSizeNonPositiveReturnsZeros() {
  await resetAndCreateOutbox("zero-batch");
  let sendCalled = false;

  const result = await dispatchWith(async () => {
    sendCalled = true;
    return { ok: true };
  }, { batchSize: 0 });

  assert.deepEqual(result, { claimed: 0, sent: 0, failed: 0 });
  assert.equal(sendCalled, false);
}

async function testLockMsNonPositiveThrows() {
  await resetDb();
  await assert.rejects(
    () => dispatchWith(async () => ({ ok: true }), { lockMs: 0 }),
    /lockMs must be greater than 0/,
  );
}

async function testSendLineMessageMustBeFunction() {
  await resetDb();
  await assert.rejects(
    () => runNotificationDispatchOnce({
      nodeId: "notifier-01",
      batchSize: 5,
      lockMs: 30_000,
      sendLineMessage: undefined as unknown as SendLineMessage,
    }),
    /sendLineMessage must be a function/,
  );
}

async function main() {
  const failures: string[] = [];
  const tests: Array<[string, () => Promise<void>]> = [
    ["successful delivery marks sent once", testSuccessfulDeliveryMarksSentOnce],
    ["failed send result marks retryable", testFailedSendResultMarksRetryable],
    ["thrown send stays ambiguous without retry", testThrownSendIsAmbiguous],
    ["permanent send result is not retried", testPermanentSendResultIsNotRetried],
    ["unknown failure is not retried", testUnknownFailureIsNotRetried],
    ["provider attempt cannot be reclaimed after lease expiry", testStaleDeliveredMarkIsNotCounted],
    ["blank nodeId throws", testBlankNodeIdThrows],
    ["batchSize non-positive returns zeros", testBatchSizeNonPositiveReturnsZeros],
    ["lockMs non-positive throws", testLockMsNonPositiveThrows],
    ["sendLineMessage must be function", testSendLineMessageMustBeFunction],
  ];

  for (const [name, test] of tests) {
    try {
      await test();
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      failures.push(`${name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
