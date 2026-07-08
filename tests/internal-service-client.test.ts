import assert from "node:assert/strict";
import {
  isRetryableInternalStatus,
  signedJsonPost,
} from "../src/services/internal-service-client.js";
import { verifyInternalSignature } from "../src/services/internal-auth.js";

const sharedSecret = "super-secret-value";
const nodeId = "notification-service-01";
const eventKey = "notification-outbox:123";
const url = "https://line.internal.example/internal/line/messages";
const requestBody = {
  targetId: "C123",
  text: "hello",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

async function testSignedJsonPostSendsSignedEnvelope(): Promise<void> {
  let capturedHeaders: Headers | undefined;
  let capturedBody = "";
  let signalSeen = false;

  const result = await signedJsonPost<typeof requestBody, { accepted: true }>({
    url,
    sharedSecret,
    nodeId,
    eventKey,
    body: requestBody,
    requestTimeoutMs: 25,
    fetchImpl: async (_url, init) => {
      capturedHeaders = new Headers(init.headers);
      capturedBody = String(init.body);
      signalSeen = init.signal instanceof AbortSignal;
      return jsonResponse({ status: "success", data: { accepted: true } }, 202);
    },
  });

  assert.deepEqual(result, { ok: true, status: 202, data: { accepted: true } });
  assert.equal(capturedBody, JSON.stringify(requestBody));
  assert.equal(capturedHeaders?.get("content-type"), "application/json");
  assert.equal(capturedHeaders?.get("x-spx-node-id"), nodeId);
  assert.equal(capturedHeaders?.get("idempotency-key"), eventKey);
  assert.equal(signalSeen, true);

  const timestamp = capturedHeaders?.get("x-spx-timestamp");
  const signature = capturedHeaders?.get("x-spx-signature");
  assert.equal(typeof timestamp, "string");
  assert.equal(typeof signature, "string");
  assert.deepEqual(
    verifyInternalSignature({
      body: capturedBody,
      timestamp: timestamp ?? "",
      nodeId,
      path: "/internal/line/messages",
      secret: sharedSecret,
      eventKey,
      signature: signature ?? "",
      now: new Date(timestamp ?? ""),
    }),
    { ok: true },
  );
}

async function testRetryableStatusClassification(): Promise<void> {
  assert.equal(isRetryableInternalStatus(undefined), true);
  assert.equal(isRetryableInternalStatus(408), true);
  assert.equal(isRetryableInternalStatus(429), true);
  assert.equal(isRetryableInternalStatus(500), true);
  assert.equal(isRetryableInternalStatus(503), true);
  assert.equal(isRetryableInternalStatus(400), false);
  assert.equal(isRetryableInternalStatus(401), false);
  assert.equal(isRetryableInternalStatus(403), false);
  assert.equal(isRetryableInternalStatus(422), false);
}

async function testHttpErrorKeepsBodyAndRetryableFlag(): Promise<void> {
  const retryable = await signedJsonPost<typeof requestBody, { accepted: true }>({
    url,
    sharedSecret,
    nodeId,
    body: requestBody,
    fetchImpl: async () => textResponse("line-service unavailable", 503),
  });

  assert.deepEqual(retryable, {
    ok: false,
    status: 503,
    error: "line-service unavailable",
    retryable: true,
  });

  const permanent = await signedJsonPost<typeof requestBody, { accepted: true }>({
    url,
    sharedSecret,
    nodeId,
    body: requestBody,
    fetchImpl: async () => textResponse("bad signature", 401),
  });

  assert.deepEqual(permanent, {
    ok: false,
    status: 401,
    error: "bad signature",
    retryable: false,
  });
}

async function testNetworkFailureIsRetryable(): Promise<void> {
  const result = await signedJsonPost<typeof requestBody, { accepted: true }>({
    url,
    sharedSecret,
    nodeId,
    body: requestBody,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });

  assert.deepEqual(result, {
    ok: false,
    error: "network down",
    retryable: true,
  });
}

async function main(): Promise<void> {
  await testSignedJsonPostSendsSignedEnvelope();
  await testRetryableStatusClassification();
  await testHttpErrorKeepsBodyAndRetryableFlag();
  await testNetworkFailureIsRetryable();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
