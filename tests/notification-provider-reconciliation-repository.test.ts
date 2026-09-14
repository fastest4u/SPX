import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { claimNotificationOutboxBatch, completeNotificationProviderSend, listProviderDeliveryReadModelRows, listNotificationProviderReconciliationCandidates, reconcileNotificationProviderDelivery, type NotificationProviderReconciliationInput } from "../src/repositories/notification-repository.js";

const input: NotificationProviderReconciliationInput = {
  outboxId: 1, action: "mark_sent", expectedStatus: "delivery_ambiguous",
  providerRequestId: "request-1", expectedProviderStartedAt: "2030-06-29 09:00:03",
  actor: { userId: 17, username: "operator", teamId: null },
  evidenceReference: "LINE-console-123", reason: "Provider confirms delivery", providerMessageId: "message-1",
  now: new Date("2030-06-29T09:01:00Z"),
};

async function reset() {
  await closePool();
  resetMemoryDb();
  getRawMemoryDb().prepare(`INSERT INTO notification_outbox
    (id,event_key,team_id,target_type,target_id,event_type,severity,title,message,payload_json,status,attempts,provider_request_id,provider_started_at,updated_at)
    VALUES (1,'event-1',2,'line_group','secret-target','auto_accept_result','success','secret-title','secret-message','secret-payload','delivery_ambiguous',1,'request-1','2030-06-29 09:00:03','2030-06-29 09:00:04')`).run();
}
function row() { return getRawMemoryDb().prepare("SELECT * FROM notification_outbox WHERE id=1").get() as Record<string, unknown>; }
function audits() { return getRawMemoryDb().prepare("SELECT * FROM notification_provider_reconciliations").all() as Array<Record<string, unknown>>; }

async function main() {
  await reset();
  const candidates = await listNotificationProviderReconciliationCandidates();
  assert.deepEqual(candidates, [{ outboxId: 1, teamId: 2, status: "delivery_ambiguous", providerRequestId: "request-1", lockedBy: null, attempts: 1, providerStartedAt: "2030-06-29 09:00:03", updatedAt: "2030-06-29 09:00:04" }]);
  assert.doesNotMatch(JSON.stringify(candidates), /secret|payload|lastError/);
  for (const stale of [
    { providerRequestId: "request-old" }, { expectedProviderStartedAt: "2030-06-29 09:00:02" }, { expectedStatus: "provider_sending" },
  ]) {
    assert.deepEqual(await reconcileNotificationProviderDelivery({ ...input, ...stale }), { state: "conflict" });
    assert.equal(row().status, "delivery_ambiguous");
    assert.equal(audits().length, 0);
  }
  assert.deepEqual(await reconcileNotificationProviderDelivery(input), { state: "reconciled", status: "sent" });
  assert.equal(row().status, "sent");
  assert.equal(row().sent_at, "2030-06-29 09:01:00");
  assert.equal(audits().length, 1);
  assert.equal(audits()[0].actor_user_id, 17);
  assert.equal(audits()[0].evidence_reference, input.evidenceReference);
  assert.equal(audits()[0].reason, input.reason);
  assert.equal(audits()[0].provider_message_id, input.providerMessageId);
  assert.equal((getRawMemoryDb().prepare("SELECT status FROM notification_deliveries").get() as { status: string } | undefined)?.status, "reconciled_success");
  assert.deepEqual(await reconcileNotificationProviderDelivery(input), { state: "reconciled", status: "sent" });
  assert.equal(audits().length, 1);
  assert.deepEqual(await reconcileNotificationProviderDelivery({ ...input, action: "requeue_not_sent" }), { state: "conflict" });
  assert.deepEqual(await reconcileNotificationProviderDelivery({ ...input, reason: "Different operator evidence" }), { state: "conflict" });
  assert.deepEqual(await listNotificationProviderReconciliationCandidates(), []);
  assert.deepEqual(await claimNotificationOutboxBatch("worker", 10, 30000, new Date("2030-06-30")), []);

  await reset();
  const requeue = { ...input, action: "requeue_not_sent" as const, providerMessageId: undefined };
  assert.deepEqual(await reconcileNotificationProviderDelivery(requeue), { state: "reconciled", status: "queued" });
  assert.equal(row().provider_request_id, null);
  assert.equal(row().provider_started_at, null);
  assert.equal(row().locked_by, null);
  assert.equal((getRawMemoryDb().prepare("SELECT status FROM notification_deliveries").get() as { status: string } | undefined)?.status, "reconciled_not_sent");
  assert.deepEqual(await reconcileNotificationProviderDelivery(requeue), { state: "reconciled", status: "queued" });
  assert.equal(audits().length, 1);
  assert.equal((await claimNotificationOutboxBatch("worker", 10, 30000, new Date("2030-06-30"))).length, 1);
  getRawMemoryDb().prepare("UPDATE notification_outbox SET status='provider_sending', provider_request_id='request-2', provider_started_at='2030-06-30 00:00:01'").run();
  assert.deepEqual(await reconcileNotificationProviderDelivery(input), { state: "conflict" });
  assert.equal(row().provider_request_id, "request-2");

  await reset();
  getRawMemoryDb().exec("CREATE TRIGGER reject_reconciliation BEFORE INSERT ON notification_provider_reconciliations BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  await assert.rejects(reconcileNotificationProviderDelivery(input), /audit unavailable/);
  assert.equal(row().status, "delivery_ambiguous", "audit failure must roll back outbox transition");
  assert.equal(audits().length, 0);

  await reset();
  getRawMemoryDb().prepare("UPDATE notification_outbox SET status='provider_sending', locked_by='worker'").run();
  const completion = { outboxId: 1, nodeId: "worker", providerRequestId: "request-1", providerStartedAt: input.expectedProviderStartedAt, outcome: "sent" as const };
  assert.equal(await completeNotificationProviderSend({ ...completion, providerRequestId: "request-old" }), false);
  assert.equal(await completeNotificationProviderSend({ ...completion, providerStartedAt: "2030-06-29 09:00:02" }), false);
  assert.equal(await completeNotificationProviderSend({ ...completion, nodeId: "old-worker" }), false);
  assert.equal(row().status, "provider_sending");
  assert.equal(await completeNotificationProviderSend(completion), true);
  assert.equal(await completeNotificationProviderSend(completion), true);
  assert.equal(await completeNotificationProviderSend({ ...completion, outcome: "ambiguous" }), false);
  assert.equal((getRawMemoryDb().prepare("SELECT * FROM notification_deliveries").all()).length, 1);
  const window = { from: new Date("2000-01-01"), to: new Date("2040-01-01") };
  assert.equal((await listProviderDeliveryReadModelRows({ ...window, teamId: 2 })).length, 1);
  assert.equal((await listProviderDeliveryReadModelRows({ ...window, teamId: 3 })).length, 0, "delivery reads must respect team scope");
  console.log("notification reconciliation: exact fence, durable audit, rollback, redaction and retry verified");
}
main().catch(error => { console.error(error); process.exit(1); });
