process.env.DB_MODE = "memory";

import assert from "node:assert/strict";
import { verifyInternalSignature } from "../src/services/internal-auth.js";
import type { RealtimeEnvelopeV1, RealtimePublishInput, RealtimePublishResult } from "../src/services/realtime-contract.js";
import { SignedHttpRealtimePublisher } from "../src/services/realtime-http-client.js";
import { PersistentRealtimePublisher, type LegacyRealtimeEvent, type RealtimeTransport } from "../src/services/realtime-publisher.js";
import { createRuntimeRealtimePublisher } from "../src/services/runtime-realtime-publisher.js";

class FakeTransport implements RealtimeTransport {
  envelopes: RealtimeEnvelopeV1[] = [];
  legacy: LegacyRealtimeEvent[] = [];
  publishEnvelope(envelope: RealtimeEnvelopeV1): void {
    this.envelopes.push(envelope);
  }
  publishLegacy(event: LegacyRealtimeEvent): void {
    this.legacy.push(event);
  }
}

function response(): Response {
  return new Response(JSON.stringify({
    status: "success",
    data: {
      accepted: true,
      duplicate: false,
      id: "remote-event-1",
      receivedAt: "2030-01-01T00:00:01.000Z",
      persisted: true,
    } satisfies RealtimePublishResult,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function input(nodeId: string): RealtimePublishInput<{ message: string }> {
  return {
    type: "session.expired",
    payloadVersion: 1,
    payload: { message: "expired" },
    source: { service: "worker", nodeId, role: "worker" },
    scope: { kind: "team", teamId: 2 },
    subject: { type: "team", id: "2", teamId: 2 },
    replayable: false,
  };
}

async function main(): Promise<void> {
  const localTransport = new FakeTransport();
  const local = createRuntimeRealtimePublisher({ localTransport });
  assert.ok(local instanceof PersistentRealtimePublisher);

  const url = "http://realtime.internal:8080/internal/realtime/events";
  const nodeId = "worker-ifn-1";
  const sharedSecret = "remote-secret-must-not-leak";
  let capturedUrl = "";
  let capturedBody = "";
  let capturedHeaders: Headers | null = null;
  const remote = createRuntimeRealtimePublisher({
    remote: {
      url,
      sharedSecret,
      nodeId,
      requestTimeoutMs: 250,
      fetchImpl: async (requestUrl, init) => {
        capturedUrl = requestUrl;
        capturedBody = String(init.body);
        capturedHeaders = new Headers(init.headers);
        return response();
      },
    },
  });
  assert.ok(remote instanceof SignedHttpRealtimePublisher);
  await remote.publish(input(nodeId));
  assert.equal(capturedUrl, url);
  assert.equal(capturedHeaders?.get("x-spx-node-id"), nodeId);
  assert.equal((JSON.parse(capturedBody) as RealtimePublishInput).source.nodeId, nodeId);
  const timestamp = capturedHeaders?.get("x-spx-timestamp") ?? "";
  const requestId = capturedHeaders?.get("x-spx-request-id") ?? "";
  assert.match(requestId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(verifyInternalSignature({
    body: capturedBody,
    timestamp,
    nodeId,
    path: "/internal/realtime/events",
    secret: sharedSecret,
    signature: capturedHeaders?.get("x-spx-signature") ?? "",
    requestId,
    now: new Date(timestamp),
  }), { ok: true });

  let mismatchedSourceFetches = 0;
  const mismatchPublisher = createRuntimeRealtimePublisher({
    remote: {
      url,
      sharedSecret,
      nodeId,
      requestTimeoutMs: 250,
      fetchImpl: async () => {
        mismatchedSourceFetches += 1;
        return response();
      },
    },
  });
  await assert.rejects(() => mismatchPublisher.publish(input("different-worker")), /source node.*signing node/i);
  assert.equal(mismatchedSourceFetches, 0);

  const partialConfigs = [
    { url },
    { url, sharedSecret },
    { url, sharedSecret, nodeId },
    { sharedSecret, nodeId, requestTimeoutMs: 250 },
  ];
  for (const partial of partialConfigs) {
    assert.throws(
      () => createRuntimeRealtimePublisher({ remote: partial }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /remote realtime configuration is incomplete/i);
        assert.equal(error.message.includes(sharedSecret), false);
        assert.equal(error.message.includes(url), false);
        return true;
      },
    );
  }
  assert.throws(
    () => createRuntimeRealtimePublisher({
      remote: { url: "not-a-url", sharedSecret, nodeId, requestTimeoutMs: 250 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /remote realtime URL is invalid/i);
      assert.equal(error.message.includes(sharedSecret), false);
      return true;
    },
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
