import assert from "node:assert/strict";
import { verifyInternalSignature } from "../src/services/internal-auth.js";
import type {
  RealtimePublishInput,
  RealtimePublishResult,
} from "../src/services/realtime-contract.js";
import {
  RealtimePublishHttpError,
  createSignedHttpRealtimePublisher,
} from "../src/services/realtime-http-client.js";

const sharedSecret = "super-secret-value";
const nodeId = "worker-ifn-1";
const url = "https://web.internal.example/internal/realtime/events";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
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

async function expectHttpError(
  run: () => Promise<unknown>,
  expected: { retryable: boolean; status?: number; message: string },
): Promise<void> {
  await assert.rejects(
    run,
    (error: unknown) => {
      assert.ok(error instanceof RealtimePublishHttpError);
      assert.equal(error.retryable, expected.retryable);
      assert.equal(error.status, expected.status);
      assert.match(error.message, new RegExp(expected.message));
      return true;
    },
  );
}

async function testPublishSignsRealtimePost(): Promise<void> {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  let capturedBody = "";

  const publisher = createSignedHttpRealtimePublisher({
    url,
    sharedSecret,
    nodeId,
    requestTimeoutMs: 25,
    fetchImpl: async (requestUrl, init) => {
      capturedUrl = requestUrl;
      capturedHeaders = new Headers(init.headers);
      capturedBody = String(init.body);
      return jsonResponse({
        status: "success",
        data: {
          accepted: true,
          duplicate: false,
          id: "evt-1",
          receivedAt: "2030-01-01T00:00:01.000Z",
          persisted: false,
        } satisfies RealtimePublishResult,
      }, 202);
    },
  });

  const result = await publisher.publish(metricsInput());

  assert.deepEqual(result, {
    accepted: true,
    duplicate: false,
    id: "evt-1",
    receivedAt: "2030-01-01T00:00:01.000Z",
    persisted: false,
  });
  assert.equal(capturedUrl, url);
  assert.equal(capturedBody, JSON.stringify(metricsInput()));
  assert.equal(capturedHeaders?.get("x-spx-node-id"), nodeId);
  assert.equal(typeof capturedHeaders?.get("x-spx-timestamp"), "string");
  assert.equal(typeof capturedHeaders?.get("x-spx-signature"), "string");
  assert.match(capturedHeaders?.get("x-spx-request-id") ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(capturedHeaders?.get("idempotency-key"), null);

  const timestamp = capturedHeaders?.get("x-spx-timestamp");
  const signature = capturedHeaders?.get("x-spx-signature");
  assert.deepEqual(
    verifyInternalSignature({
      body: capturedBody,
      timestamp: timestamp ?? "",
      nodeId,
      path: "/internal/realtime/events",
      secret: sharedSecret,
      requestId: capturedHeaders?.get("x-spx-request-id") ?? "",
      signature: signature ?? "",
      now: new Date(timestamp ?? ""),
    }),
    { ok: true },
  );
}

async function testReplayablePublishUsesIdempotencyKeyInHeaderAndSignature(): Promise<void> {
  let capturedHeaders: Headers | undefined;
  let capturedBody = "";

  const publisher = createSignedHttpRealtimePublisher({
    url,
    sharedSecret,
    nodeId,
    fetchImpl: async (_requestUrl, init) => {
      capturedHeaders = new Headers(init.headers);
      capturedBody = String(init.body);
      return jsonResponse({
        status: "success",
        data: {
          accepted: true,
          duplicate: false,
          id: "evt-replayable",
          receivedAt: "2030-01-01T00:00:02.000Z",
          persisted: true,
        } satisfies RealtimePublishResult,
      });
    },
  });

  await publisher.publish(metricsInput({
    replayable: true,
    idempotencyKey: "metrics:team:2:snapshot",
  }));

  assert.equal(capturedHeaders?.get("idempotency-key"), "metrics:team:2:snapshot");
  const timestamp = capturedHeaders?.get("x-spx-timestamp");
  const signature = capturedHeaders?.get("x-spx-signature");
  const requestId = capturedHeaders?.get("x-spx-request-id");
  assert.deepEqual(
    verifyInternalSignature({
      body: capturedBody,
      timestamp: timestamp ?? "",
      nodeId,
      path: "/internal/realtime/events",
      secret: sharedSecret,
      eventKey: "metrics:team:2:snapshot",
      requestId: requestId ?? "",
      signature: signature ?? "",
      now: new Date(timestamp ?? ""),
    }),
    { ok: true },
  );
}

async function testPublishRejectsMismatchedSourceBeforeNetwork(): Promise<void> {
  let called = false;
  const publisher = createSignedHttpRealtimePublisher({
    url,
    sharedSecret,
    nodeId,
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ status: "success", data: {} });
    },
  });
  await assert.rejects(
    () => publisher.publish(metricsInput({ source: { service: "worker", nodeId: "other-worker", role: "worker" } })),
    /source node.*signing node/i,
  );
  assert.equal(called, false);
}

async function testPublishRejectsReplayableWithoutIdempotencyKeyBeforeNetwork(): Promise<void> {
  let called = false;
  const publisher = createSignedHttpRealtimePublisher({
    url,
    sharedSecret,
    nodeId,
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ status: "success", data: {} });
    },
  });

  await assert.rejects(
    () => publisher.publish(metricsInput({ replayable: true, idempotencyKey: undefined })),
    /idempotencyKey is required for replayable events/,
  );
  assert.equal(called, false);
}

async function testHttp400ThrowsPermanentError(): Promise<void> {
  const publisher = createSignedHttpRealtimePublisher({
    url,
    sharedSecret,
    nodeId,
    fetchImpl: async () => textResponse("bad realtime request", 400),
  });

  await expectHttpError(
    () => publisher.publish(metricsInput()),
    { retryable: false, status: 400, message: "INTERNAL_HTTP_400" },
  );
}

async function testHttp503ThrowsRetryableError(): Promise<void> {
  const publisher = createSignedHttpRealtimePublisher({
    url,
    sharedSecret,
    nodeId,
    fetchImpl: async () => textResponse("realtime unavailable", 503),
  });

  await expectHttpError(
    () => publisher.publish(metricsInput()),
    { retryable: true, status: 503, message: "INTERNAL_HTTP_503" },
  );
}

async function testNetworkFailureThrowsRetryableError(): Promise<void> {
  const publisher = createSignedHttpRealtimePublisher({
    url,
    sharedSecret,
    nodeId,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });

  await expectHttpError(
    () => publisher.publish(metricsInput()),
    { retryable: true, message: "INTERNAL_NETWORK_ERROR" },
  );
}

async function testPublishSnapshotDefaultsReplayableFalse(): Promise<void> {
  let capturedBody = "";
  const publisher = createSignedHttpRealtimePublisher({
    url,
    sharedSecret,
    nodeId,
    fetchImpl: async (_requestUrl, init) => {
      capturedBody = String(init.body);
      return jsonResponse({
        status: "success",
        data: {
          accepted: true,
          duplicate: false,
          id: "evt-snapshot",
          receivedAt: "2030-01-01T00:00:03.000Z",
          persisted: false,
        } satisfies RealtimePublishResult,
      });
    },
  });

  await publisher.publishSnapshot(metricsInput({ replayable: undefined }));

  assert.equal(JSON.parse(capturedBody).replayable, false);
}

async function main(): Promise<void> {
  await testPublishSignsRealtimePost();
  await testReplayablePublishUsesIdempotencyKeyInHeaderAndSignature();
  await testPublishRejectsMismatchedSourceBeforeNetwork();
  await testPublishRejectsReplayableWithoutIdempotencyKeyBeforeNetwork();
  await testHttp400ThrowsPermanentError();
  await testHttp503ThrowsRetryableError();
  await testNetworkFailureThrowsRetryableError();
  await testPublishSnapshotDefaultsReplayableFalse();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
