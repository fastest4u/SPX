import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishNotificationEvent,
  sendSpooledNotificationEvent,
} from "../src/services/notification-client.js";
import {
  NotificationSpool,
  type NotificationSpoolEntry,
} from "../src/services/notification-spool.js";
import { verifyInternalSignature } from "../src/services/internal-auth.js";
import type { NotificationEventInput } from "../src/services/notification-events.js";

const event: NotificationEventInput = {
  schemaVersion: 1,
  eventType: "auto_accept_result",
  severity: "success",
  teamId: 2,
  teamName: "PTWL",
  bookingId: "2791810",
  requestIds: ["40288114"],
  status: "owned",
  reasonCode: "verified_owned",
  traceId: "aa:2:2791810:40288114:123",
  message: "PTWL accepted request 40288114.",
  occurredAt: "2026-06-29T04:24:04.000+07:00",
  evidence: { acceptRttMs: 82 },
};

const url = "https://notify.internal.example/internal/notification-events";
const sharedSecret = "super-secret-value";
const nodeId = "ptwl-worker-01";
const eventKey = "auto_accept_owned:team:2:booking:2791810:req:40288114";
const expectedBody = JSON.stringify(event);

async function withTempSpool<T>(fn: (spool: NotificationSpool) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spx-notification-spool-"));
  try {
    return await fn(new NotificationSpool(join(dir, "events.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

async function main(): Promise<void> {
  await withTempSpool(async (spool) => {
    let fetchCalls = 0;
    const result = await publishNotificationEvent({
      url,
      sharedSecret,
      nodeId,
      eventKey,
      event,
      spool,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("network down");
      },
    });

    assert.deepEqual(result, { ok: false, error: "network down" });
    assert.equal(fetchCalls, 1);

    const entries = await spool.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.eventKey, eventKey);
    assert.equal(entries[0]?.url, url);
    assert.equal(entries[0]?.body, expectedBody);
    assert.equal(entries[0]?.retryCount, 0);
    assert.equal(typeof entries[0]?.firstFailedAt, "string");
    assert.equal(typeof entries[0]?.nextRetryAt, "string");
    assert.equal(entries[0]?.headers["x-spx-timestamp"], undefined);
    assert.equal(entries[0]?.headers["x-spx-signature"], undefined);
    assert.equal(entries[0]?.headers["x-spx-node-id"], nodeId);
    assert.equal(entries[0]?.headers["idempotency-key"], eventKey);
  });

  await withTempSpool(async (spool) => {
    await spool.append({
      eventKey,
      url,
      headers: { "content-type": "application/json" },
      body: expectedBody,
    });

    const sentBodies: string[] = [];
    const result = await spool.flush(async (entry) => {
      sentBodies.push(entry.body);
      return true;
    });

    assert.deepEqual(result, { sent: 1, retained: 0 });
    assert.deepEqual(sentBodies, [expectedBody]);
    assert.deepEqual(await spool.readAll(), []);
  });

  await withTempSpool(async (spool) => {
    const result = await publishNotificationEvent({
      url,
      sharedSecret,
      nodeId,
      eventKey,
      event,
      spool,
      fetchImpl: async () => okResponse({ data: { duplicate: true } }, 200),
    });

    assert.deepEqual(result, { ok: true, duplicate: true, status: 200 });
    assert.deepEqual(await spool.readAll(), []);
  });

  await withTempSpool(async (spool) => {
    const result = await publishNotificationEvent({
      url,
      sharedSecret,
      nodeId,
      eventKey,
      event,
      spool,
      fetchImpl: async () => textResponse("notifier temporarily unavailable", 503),
    });

    assert.deepEqual(result, { ok: false, status: 503, error: "notifier temporarily unavailable" });

    const entries = await spool.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.eventKey, eventKey);
    assert.equal(entries[0]?.body, expectedBody);
    assert.equal(entries[0]?.headers["x-spx-timestamp"], undefined);
    assert.equal(entries[0]?.headers["x-spx-signature"], undefined);
  });

  await withTempSpool(async (spool) => {
    let capturedHeaders: Headers | undefined;
    let capturedBody = "";
    const result = await publishNotificationEvent({
      url,
      sharedSecret,
      nodeId,
      eventKey,
      event,
      spool,
      fetchImpl: async (_url, init) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = String(init?.body);
        return okResponse({ data: { duplicate: false } }, 200);
      },
    });

    assert.deepEqual(result, { ok: true, duplicate: false, status: 200 });
    assert.equal(capturedHeaders?.get("idempotency-key"), eventKey);
    assert.equal(capturedHeaders?.get("x-spx-node-id"), nodeId);
    assert.equal(capturedHeaders?.get("content-type"), "application/json");

    const timestamp = capturedHeaders?.get("x-spx-timestamp");
    const signature = capturedHeaders?.get("x-spx-signature");
    assert.equal(typeof timestamp, "string");
    assert.equal(typeof signature, "string");
    assert.deepEqual(
      verifyInternalSignature({
        body: capturedBody,
        timestamp: timestamp ?? "",
        nodeId,
        path: "/internal/notification-events",
        secret: sharedSecret,
        eventKey,
        signature: signature ?? "",
        now: new Date(timestamp ?? ""),
      }),
      { ok: true },
    );
  });

  await withTempSpool(async (spool) => {
    await spool.append({
      eventKey,
      url,
      headers: { "content-type": "application/json" },
      body: expectedBody,
    });

    const before = await spool.readAll();
    assert.equal(before.length, 1);
    const originalFirstFailedAt = before[0]?.firstFailedAt;
    const originalNextRetryAt = before[0]?.nextRetryAt;

    const afterFalseResult = await spool.flush(async () => false);

    const afterFalse = await spool.readAll();
    assert.deepEqual(afterFalseResult, { sent: 0, retained: 1 });
    assert.equal(afterFalse.length, 1);
    assert.equal(afterFalse[0]?.retryCount, 1);
    assert.equal(afterFalse[0]?.firstFailedAt, originalFirstFailedAt);
    assert.notEqual(afterFalse[0]?.nextRetryAt, originalNextRetryAt);
    assert.ok(Date.parse(afterFalse[0]?.nextRetryAt ?? "") > Date.now());

    const afterThrowResult = await spool.flush(
      async () => {
        throw new Error("still down");
      },
      new Date(Date.now() + 120_000),
    );

    const afterThrow = await spool.readAll();
    assert.deepEqual(afterThrowResult, { sent: 0, retained: 1 });
    assert.equal(afterThrow.length, 1);
    assert.equal(afterThrow[0]?.retryCount, 2);
  });

  const retainedEntry: NotificationSpoolEntry = {
    eventKey,
    url,
    headers: { "content-type": "application/json" },
    body: expectedBody,
    retryCount: 5,
    firstFailedAt: "2026-06-29T04:24:04.000Z",
    nextRetryAt: "2026-06-29T04:25:04.000Z",
  };

  await withTempSpool(async (spool) => {
    await spool.rewrite([retainedEntry]);
    const rewritten = await spool.readAll();
    assert.deepEqual(rewritten, [retainedEntry]);
  });

  await withTempSpool(async (spool) => {
    await spool.rewrite([retainedEntry]);
    const result = await spool.flush(async () => true);
    assert.deepEqual(result, { sent: 1, retained: 0 });
    assert.deepEqual(await spool.readAll(), []);
  });

  await withTempSpool(async (spool) => {
    const futureEntry = {
      ...retainedEntry,
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await spool.rewrite([futureEntry]);
    let sendAttempts = 0;
    const result = await spool.flush(async () => {
      sendAttempts += 1;
      return true;
    });
    assert.deepEqual(result, { sent: 0, retained: 1 });
    assert.equal(sendAttempts, 0);
    assert.deepEqual(await spool.readAll(), [futureEntry]);
  });

  await withTempSpool(async (spool) => {
    await spool.append({
      eventKey,
      url,
      headers: { "content-type": "application/json" },
      body: expectedBody,
    });

    const appendedDuringFlush = {
      eventKey: `${eventKey}:during-flush`,
      url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, requestIds: ["40288115"] }),
    };
    const result = await spool.flush(async () => {
      await spool.append(appendedDuringFlush);
      return true;
    });

    assert.deepEqual(result, { sent: 1, retained: 0 });
    const entries = await spool.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.eventKey, appendedDuringFlush.eventKey);
  });

  await withTempSpool(async (spool) => {
    await spool.append({
      eventKey,
      url,
      headers: { "content-type": "application/json" },
      body: expectedBody,
    });

    let entriesDuringSend: unknown[] = [];
    const result = await spool.flush(async () => {
      entriesDuringSend = await spool.readAll();
      return false;
    });

    assert.equal(entriesDuringSend.length, 1, "due entries must stay durable while delivery is in flight");
    assert.deepEqual(result, { sent: 0, retained: 1 });
    const entries = await spool.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.retryCount, 1);
  });

  await withTempSpool(async (spool) => {
    const result = await publishNotificationEvent({
      url,
      sharedSecret,
      nodeId,
      eventKey,
      event,
      spool,
      fetchImpl: async () => textResponse("bad signature", 401),
    });

    assert.deepEqual(result, { ok: false, status: 401, error: "bad signature" });
    assert.deepEqual(await spool.readAll(), [], "permanent auth/validation failures must not spool forever");
  });

  await withTempSpool(async (spool) => {
    let signalSeen = false;
    const result = await publishNotificationEvent({
      url,
      sharedSecret,
      nodeId,
      eventKey,
      event,
      spool,
      requestTimeoutMs: 25,
      fetchImpl: async (_url, init) => {
        signalSeen = init?.signal instanceof AbortSignal;
        return okResponse({ data: { duplicate: false } }, 200);
      },
    });

    assert.deepEqual(result, { ok: true, duplicate: false, status: 200 });
    assert.equal(signalSeen, true);
  });

  await withTempSpool(async (spool) => {
    const limited = new NotificationSpool((spool as unknown as { filePath: string }).filePath, {
      maxAttempts: 2,
      baseDelayMs: 1_000,
    });
    await limited.append({
      eventKey,
      url,
      headers: { "content-type": "application/json" },
      body: expectedBody,
      retryCount: 1,
      nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const result = await limited.flush(async () => false);
    assert.deepEqual(result, { sent: 0, retained: 0 });
    assert.deepEqual(await limited.readAll(), [], "entries at max attempts should be dropped");
  });

  await withTempSpool(async (spool) => {
    await spool.append({
      eventKey,
      url,
      headers: {
        "content-type": "application/json",
        "x-spx-node-id": nodeId,
        "idempotency-key": eventKey,
      },
      body: expectedBody,
    });
    const entry = (await spool.readAll())[0];
    assert.ok(entry);

    let capturedHeaders: Headers | undefined;
    let capturedBody = "";
    const result = await sendSpooledNotificationEvent({
      entry,
      sharedSecret,
      fetchImpl: async (_url, init) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = String(init?.body);
        return okResponse({ data: { duplicate: false } }, 200);
      },
    });

    assert.deepEqual(result, { ok: true, duplicate: false, status: 200 });
    assert.equal(capturedHeaders?.get("idempotency-key"), eventKey);
    assert.equal(capturedHeaders?.get("x-spx-node-id"), nodeId);
    assert.equal(capturedHeaders?.get("content-type"), "application/json");

    const timestamp = capturedHeaders?.get("x-spx-timestamp");
    const signature = capturedHeaders?.get("x-spx-signature");
    assert.equal(typeof timestamp, "string");
    assert.equal(typeof signature, "string");
    assert.deepEqual(
      verifyInternalSignature({
        body: capturedBody,
        timestamp: timestamp ?? "",
        nodeId,
        path: "/internal/notification-events",
        secret: sharedSecret,
        eventKey,
        signature: signature ?? "",
        now: new Date(timestamp ?? ""),
      }),
      { ok: true },
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
