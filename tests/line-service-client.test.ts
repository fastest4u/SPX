import assert from "node:assert/strict";
import {
  getLineServiceGroups,
  getLineServiceProfile,
  getLineServiceStorage,
  getLineServiceStatus,
  logoutLineService,
  requestLineServiceLogin,
  sendLineServiceMessage,
} from "../src/services/line-service-client.js";
import {
  LINE_INTERNAL_GROUPS_PATH,
  LINE_INTERNAL_LOGIN_PATH,
  LINE_INTERNAL_LOGOUT_PATH,
  LINE_INTERNAL_PROFILE_PATH,
  LINE_INTERNAL_SEND_PATH,
  LINE_INTERNAL_STORAGE_PATH,
  LINE_INTERNAL_STATUS_PATH,
} from "../src/services/line-service-contract.js";
import { verifyInternalSignature } from "../src/services/internal-auth.js";

const sharedSecret = "super-secret-value";
const nodeId = "notification-service-01";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

async function testSendsSignedLineRequest(): Promise<void> {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  let capturedBody = "";
  let signalSeen = false;

  const result = await sendLineServiceMessage(
    {
      baseUrl: "https://line.internal.example/",
      sharedSecret,
      nodeId,
      requestTimeoutMs: 25,
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = new Headers(init.headers);
        capturedBody = String(init.body);
        signalSeen = init.signal instanceof AbortSignal;
        return jsonResponse({
          status: "success",
          data: { sent: true, provider: "linejs", providerMessageId: "line-msg-1" },
        });
      },
    },
    { targetId: "C123", text: "hello", traceId: "trace-1", outboxId: 123 },
  );

  assert.deepEqual(result, {
    ok: true,
    providerMessageId: "line-msg-1",
    retryable: false,
  });
  assert.equal(capturedUrl, `https://line.internal.example${LINE_INTERNAL_SEND_PATH}`);
  assert.equal(
    capturedBody,
    JSON.stringify({ targetId: "C123", text: "hello", traceId: "trace-1", outboxId: 123 }),
  );
  assert.equal(capturedHeaders?.get("x-spx-node-id"), nodeId);
  assert.equal(capturedHeaders?.get("content-type"), "application/json");
  assert.equal(capturedHeaders?.get("idempotency-key"), "trace-1");
  assert.equal(signalSeen, true);

  const timestamp = capturedHeaders?.get("x-spx-timestamp");
  const signature = capturedHeaders?.get("x-spx-signature");
  assert.deepEqual(
    verifyInternalSignature({
      body: capturedBody,
      timestamp: timestamp ?? "",
      nodeId,
      path: LINE_INTERNAL_SEND_PATH,
      secret: sharedSecret,
      signature: signature ?? "",
      eventKey: "trace-1",
      now: new Date(timestamp ?? ""),
    }),
    { ok: true },
  );
}

async function testReadsSignedLineStatus(): Promise<void> {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  let capturedBody = "";

  const result = await getLineServiceStatus({
    baseUrl: "https://line.internal.example/",
    sharedSecret,
    nodeId,
    requestTimeoutMs: 25,
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedHeaders = new Headers(init.headers);
      capturedBody = String(init.body);
      return jsonResponse({
        status: "success",
        data: {
          enabled: true,
          authenticated: false,
          qrUrl: "https://qr.example/scan",
          pincode: "123456",
          listenerActive: true,
        },
      });
    },
  });

  assert.deepEqual(result, {
    ok: true,
    status: {
      enabled: true,
      authenticated: false,
      qrUrl: "https://qr.example/scan",
      pincode: "123456",
      listenerActive: true,
    },
    retryable: false,
  });
  assert.equal(capturedUrl, `https://line.internal.example${LINE_INTERNAL_STATUS_PATH}`);
  assert.equal(capturedBody, JSON.stringify({}));
  assert.equal(capturedHeaders?.get("x-spx-node-id"), nodeId);

  const timestamp = capturedHeaders?.get("x-spx-timestamp");
  const signature = capturedHeaders?.get("x-spx-signature");
  assert.deepEqual(
    verifyInternalSignature({
      body: capturedBody,
      timestamp: timestamp ?? "",
      nodeId,
      path: LINE_INTERNAL_STATUS_PATH,
      secret: sharedSecret,
      signature: signature ?? "",
      now: new Date(timestamp ?? ""),
    }),
    { ok: true },
  );
}

async function testSignedLineAdminRequests(): Promise<void> {
  const captures: Array<{ url: string; body: string; headers: Headers }> = [];
  const options = {
    baseUrl: "https://line.internal.example/",
    sharedSecret,
    nodeId,
    requestTimeoutMs: 25,
    fetchImpl: async (url: string, init: RequestInit) => {
      captures.push({
        url,
        body: String(init.body),
        headers: new Headers(init.headers),
      });
      if (url.endsWith(LINE_INTERNAL_LOGIN_PATH)) {
        return jsonResponse({
          status: "success",
          data: {
            enabled: true,
            authenticated: false,
            qrUrl: "https://qr.example/scan",
            pincode: "123456",
            listenerActive: true,
            message: "QR login initiated",
          },
        });
      }
      if (url.endsWith(LINE_INTERNAL_GROUPS_PATH)) {
        return jsonResponse({
          status: "success",
          data: { chats: [{ chatMid: "C123", chatName: "Dispatch" }] },
        });
      }
      if (url.endsWith(LINE_INTERNAL_PROFILE_PATH)) {
        return jsonResponse({
          status: "success",
          data: { displayName: "SPX Bot", mid: "u123", statusMessage: "ready" },
        });
      }
      if (url.endsWith(LINE_INTERNAL_STORAGE_PATH)) {
        return jsonResponse({
          status: "success",
          data: {
            storagePath: "data/linejs-storage.json",
            exists: true,
            sizeBytes: 128,
            hasE2EEKeys: true,
            hasAuthState: true,
          },
        });
      }
      if (url.endsWith(LINE_INTERNAL_LOGOUT_PATH)) {
        return jsonResponse({
          status: "success",
          data: { loggedOut: true, clearStorage: true },
        });
      }
      return textResponse("unexpected path", 404);
    },
  };

  const login = await requestLineServiceLogin(options);
  const groups = await getLineServiceGroups(options);
  const profile = await getLineServiceProfile(options);
  const storage = await getLineServiceStorage(options);
  const logout = await logoutLineService(options, { clearStorage: true });

  assert.equal(login.ok, true);
  assert.equal(groups.ok, true);
  assert.equal(profile.ok, true);
  assert.equal(storage.ok, true);
  assert.equal(logout.ok, true);
  assert.deepEqual(
    captures.map((capture) => capture.url),
    [
      `https://line.internal.example${LINE_INTERNAL_LOGIN_PATH}`,
      `https://line.internal.example${LINE_INTERNAL_GROUPS_PATH}`,
      `https://line.internal.example${LINE_INTERNAL_PROFILE_PATH}`,
      `https://line.internal.example${LINE_INTERNAL_STORAGE_PATH}`,
      `https://line.internal.example${LINE_INTERNAL_LOGOUT_PATH}`,
    ],
  );
  assert.deepEqual(
    captures.map((capture) => capture.body),
    [
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify({ clearStorage: true }),
    ],
  );

  for (const capture of captures) {
    const path = new URL(capture.url).pathname;
    const timestamp = capture.headers.get("x-spx-timestamp");
    const signature = capture.headers.get("x-spx-signature");
    assert.deepEqual(
      verifyInternalSignature({
        body: capture.body,
        timestamp: timestamp ?? "",
        nodeId,
        path,
        secret: sharedSecret,
        signature: signature ?? "",
        now: new Date(timestamp ?? ""),
      }),
      { ok: true },
    );
  }
}

async function testRetryableAndPermanentFailures(): Promise<void> {
  const retryable = await sendLineServiceMessage(
    {
      baseUrl: "https://line.internal.example",
      sharedSecret,
      nodeId,
      requestTimeoutMs: 25,
      fetchImpl: async () => textResponse("line-service down", 503),
    },
    { targetId: "C123", text: "hello" },
  );
  assert.deepEqual(retryable, {
    ok: false,
    error: "line-service down",
    retryable: true,
  });

  const permanent = await sendLineServiceMessage(
    {
      baseUrl: "https://line.internal.example",
      sharedSecret,
      nodeId,
      requestTimeoutMs: 25,
      fetchImpl: async () => textResponse("bad signature", 401),
    },
    { targetId: "C123", text: "hello" },
  );
  assert.deepEqual(permanent, {
    ok: false,
    error: "bad signature",
    retryable: false,
  });
}

async function testInvalidBaseUrlIsPermanentFailure(): Promise<void> {
  const result = await sendLineServiceMessage(
    {
      baseUrl: "not a url",
      sharedSecret,
      nodeId,
      requestTimeoutMs: 25,
    },
    { targetId: "C123", text: "hello" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
}

async function main(): Promise<void> {
  await testSendsSignedLineRequest();
  await testReadsSignedLineStatus();
  await testSignedLineAdminRequests();
  await testRetryableAndPermanentFailures();
  await testInvalidBaseUrlIsPermanentFailure();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
