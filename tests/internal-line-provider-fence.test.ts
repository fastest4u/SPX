import assert from "node:assert/strict";
import Fastify from "fastify";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { internalLineController, type InternalLineServiceDependencies } from "../src/controllers/internal-line-controller.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import { completeNotificationProviderSend, reconcileNotificationProviderDelivery } from "../src/repositories/notification-repository.js";

const secret = "synthetic-test-only";
const path = "/internal/line/messages";
const fence = { outboxId: 1, providerRequestId: "request-1", providerStartedAt: "2030-06-29 09:00:03" };
const body = { targetId: "target-1", text: "title\nmessage", traceId: "event-1", ...fence };
function inject(app: ReturnType<typeof Fastify>, value = body, nodeId = "worker", requestId?: string) {
  const payload = JSON.stringify(value);
  const timestamp = new Date().toISOString();
  return app.inject({ method: "POST", url: path, payload, headers: {
    "content-type": "application/json", "x-spx-node-id": nodeId, "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({ body: payload, timestamp, nodeId, path, secret, requestId }),
    ...(requestId ? { "x-spx-request-id": requestId } : {}),
  } });
}
async function appFor(send: InternalLineServiceDependencies["sendMessage"]) {
  const app = Fastify();
  await app.register(internalLineController, { prefix: "/internal", sharedSecret: secret, adminSharedSecret: secret,
    requireOutboxFence: true, sendAllowedNodeIds: new Set(["worker"]),
    line: { isEnabled: () => true, sendMessage: send } as InternalLineServiceDependencies });
  return app;
}
async function reset() {
  await closePool(); resetMemoryDb();
  getRawMemoryDb().prepare(`INSERT INTO notification_outbox
    (id,event_key,team_id,target_type,target_id,event_type,severity,title,message,payload_json,status,attempts,locked_by,provider_request_id,provider_started_at)
    VALUES (1,'event-1',2,'line_group','target-1','auto_accept_result','success','title','message','{}','provider_sending',0,'worker','request-1','2030-06-29 09:00:03')`).run();
}
async function main() {
  await reset();
  let sends = 0;
  let app = await appFor(async () => { sends++; return { ok: true }; });
  try {
    assert.equal((await inject(app, { ...body, providerRequestId: "old-request" })).statusCode, 409);
    assert.equal((await inject(app, { ...body, targetId: "wrong-target" })).statusCode, 409);
    assert.equal((await inject(app, body, "rogue-worker")).statusCode, 401);
    assert.equal(sends, 0);
    assert.equal((await inject(app)).statusCode, 200);
    assert.equal(sends, 1);
  } finally { await app.close(); }
  app = await appFor(async () => { sends++; return { ok: true }; });
  try { assert.equal((await inject(app)).statusCode, 200); assert.equal(sends, 1); } finally { await app.close(); }

  await reset();
  app = await appFor(async () => { sends++; return { ok: true }; });
  try {
    assert.equal((await inject(app, body, "worker", "signed-request-1")).statusCode, 200);
    const replay = await inject(app, body, "worker", "signed-request-1");
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error_code, "INTERNAL_REQUEST_REPLAYED");
  } finally { await app.close(); }

  await reset();
  let release!: () => void;
  let entered!: () => void;
  const enteredProvider = new Promise<void>(resolve => { entered = resolve; });
  const releaseProvider = new Promise<void>(resolve => { release = resolve; });
  app = await appFor(async () => { sends++; entered(); await releaseProvider; return { ok: true }; });
  const first = inject(app);
  await enteredProvider;
  const other = await appFor(async () => { sends++; return { ok: true }; });
  try {
    assert.equal((await inject(other)).statusCode, 409, "fresh controller cannot replay consumed provider execution");
    await completeNotificationProviderSend({ ...fence, nodeId: "worker", outcome: "ambiguous" });
    release();
    assert.equal((await first).statusCode, 200, "late provider success can finish its own exact fence");
    assert.equal((getRawMemoryDb().prepare("SELECT status FROM notification_outbox").get() as { status: string }).status, "sent");
  } finally { release(); await app.close(); await other.close(); }

  await reset();
  getRawMemoryDb().prepare("UPDATE notification_outbox SET provider_execution_started_at='2030-06-29 09:00:04'").run();
  app = await appFor(async () => { sends++; return { ok: true }; });
  const before = sends;
  try {
    assert.equal((await inject(app)).statusCode, 409, "crash after provider dispatch cannot resend");
    assert.equal(sends, before);
    await reconcileNotificationProviderDelivery({ outboxId: 1, action: "requeue_not_sent", expectedStatus: "provider_sending", providerRequestId: fence.providerRequestId,
      expectedProviderStartedAt: fence.providerStartedAt, actor: { userId: 1, username: "admin", teamId: null }, evidenceReference: "console-proof-1", reason: "Provider confirms no delivery" });
    assert.equal((await inject(app)).statusCode, 409, "old in-flight request cannot send after reconciliation cleared fence");
    assert.equal(sends, before);
  } finally { await app.close(); }
  console.log("internal LINE fence: stale identity, restart, concurrent replay, crash and late success verified");
}
main().catch(error => { console.error(error); process.exit(1); });
