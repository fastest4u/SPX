import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import {
  internalOcrController,
  type InternalOcrControllerOptions,
} from "../src/controllers/internal-ocr-controller.js";
import {
  createInternalSignature,
  type InternalRequestReplayStore,
} from "../src/services/internal-auth.js";
import {
  OCR_INTERNAL_READ_LINE_IMAGE_PATH,
  type OcrLineImageRequest,
} from "../src/services/ocr-service-contract.js";
import {
  OCR_INTERNAL_ADMIN_COMPLETE_PATH,
  OCR_INTERNAL_ADMIN_LOGOUT_PATH,
  OCR_INTERNAL_ADMIN_START_PATH,
  OCR_INTERNAL_ADMIN_STATUS_PATH,
} from "../src/services/ocr-service-admin-contract.js";
import { LINE_IMAGE_EXAMPLE_OUTPUT } from "../src/services/line-image-extraction.js";

const sharedSecret = "super-secret-value";
const nodeId = "line-service-01";
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function signedHeaders(input: {
  path: string;
  body: string;
  timestamp?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    "content-type": "application/json",
    "x-spx-node-id": nodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body: input.body,
      timestamp,
      nodeId,
      path: input.path,
      secret: sharedSecret,
    }),
  };
}

function nodeSignedHeaders(input: {
  body: string;
  nodeId: string;
  path: string;
  requestId: string;
  secret: string;
  eventKey?: string;
}): Record<string, string> {
  const timestamp = new Date().toISOString();
  return {
    "content-type": "application/json",
    "x-spx-node-id": input.nodeId,
    "x-spx-request-id": input.requestId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body: input.body,
      timestamp,
      nodeId: input.nodeId,
      path: input.path,
      secret: input.secret,
      requestId: input.requestId,
      eventKey: input.eventKey,
    }),
    ...(input.eventKey ? { "idempotency-key": input.eventKey } : {}),
  };
}

async function withController<T>(
  options: Omit<InternalOcrControllerOptions, "sharedSecret">,
  fn: (app: ReturnType<typeof Fastify>) => Promise<T>,
): Promise<T> {
  const app = Fastify({ logger: false });
  await app.register(internalOcrController, {
    prefix: "/internal",
    sharedSecret,
    ...options,
  });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function testSignedReadSucceeds(): Promise<void> {
  const calls: Array<{ imagePath: string; mimeType: string; timeoutMs: number }> = [];
  const request: OcrLineImageRequest = {
    imageBase64: pngBytes.toString("base64"),
    mimeType: "image/png",
    traceId: "trace-1",
    chatId: "C123",
    senderId: "U123",
  };
  const rawBody = JSON.stringify(request);

  await withController(
    {
      timeoutMs: 1234,
      prompt: "test prompt",
      readLineImage: async ({ imagePath, mimeType, timeoutMs }) => {
        calls.push({ imagePath, mimeType, timeoutMs });
        assert.deepEqual(await readFile(imagePath), pngBytes);
        return {
          text: LINE_IMAGE_EXAMPLE_OUTPUT,
          attempts: 1,
          validation: { ok: true, parsed: {} as never },
        };
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        headers: signedHeaders({ path: OCR_INTERNAL_READ_LINE_IMAGE_PATH, body: rawBody }),
        payload: rawBody,
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), {
        status: "success",
        data: {
          text: LINE_IMAGE_EXAMPLE_OUTPUT,
          attempts: 1,
          validation: { ok: true },
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.mimeType, "image/png");
      assert.equal(calls[0]?.timeoutMs, 1234);
    },
  );
}

async function testAuthFailureReturns401(): Promise<void> {
  await withController(
    {
      readLineImage: async () => {
        throw new Error("should not be called");
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        payload: JSON.stringify({ imageBase64: "aW1hZ2U=", mimeType: "image/png", traceId: "t" }),
        headers: { "content-type": "application/json" },
      });

      assert.equal(response.statusCode, 401);
      const body = JSON.parse(response.body) as { error_code: string };
      assert.equal(body.error_code, "INTERNAL_AUTH_FAILED");
    },
  );
}

async function testInvalidPayloadReturns400(): Promise<void> {
  const rawBody = JSON.stringify({ imageBase64: "not-base64", mimeType: "image/gif", traceId: "" });
  await withController(
    {
      readLineImage: async () => {
        throw new Error("should not be called");
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        payload: rawBody,
        headers: signedHeaders({ path: OCR_INTERNAL_READ_LINE_IMAGE_PATH, body: rawBody }),
      });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body) as { error_code: string };
      assert.equal(body.error_code, "INTERNAL_OCR_INVALID");
    },
  );
}

async function testReadFailureReturnsRetryable503(): Promise<void> {
  const rawBody = JSON.stringify({
    imageBase64: pngBytes.toString("base64"),
    mimeType: "image/png",
    traceId: "trace-1",
  });
  await withController(
    {
      readLineImage: async () => {
        throw new Error("codex unavailable");
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        payload: rawBody,
        headers: signedHeaders({ path: OCR_INTERNAL_READ_LINE_IMAGE_PATH, body: rawBody }),
      });

      assert.equal(response.statusCode, 503);
      const body = JSON.parse(response.body) as {
        error_code: string;
        details?: { retryable?: boolean };
      };
      assert.equal(body.error_code, "OCR_READ_FAILED");
      assert.equal(body.details?.retryable, true);
      assert.equal(response.body.includes("C123"), false);
    },
  );
}

async function testNodeScopedReadBindsRequestIdAndEventKey(): Promise<void> {
  const nodeSecret = "node-scoped-read-secret";
  const rawBody = JSON.stringify({
    imageBase64: pngBytes.toString("base64"),
    mimeType: "image/png",
    traceId: "node-trace",
  });
  let reads = 0;
  const app = Fastify({ logger: false });
  await app.register(internalOcrController, {
    prefix: "/internal",
    nodeSecrets: new Map([[nodeId, { active: nodeSecret }]]),
    readAllowedNodeIds: new Set([nodeId]),
    adminAllowedNodeIds: new Set(),
    readLineImage: async () => {
      reads += 1;
      return {
        text: LINE_IMAGE_EXAMPLE_OUTPUT,
        attempts: 1,
        validation: { ok: true, parsed: {} as never },
      };
    },
  });
  try {
    const eventKey = "ocr-event-1";
    const validHeaders = nodeSignedHeaders({
      body: rawBody,
      nodeId,
      path: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      requestId: "ocr-request-1",
      secret: nodeSecret,
      eventKey,
    });
    const accepted = await app.inject({
      method: "POST",
      url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      headers: validHeaders,
      payload: rawBody,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);

    const reboundRequestId = await app.inject({
      method: "POST",
      url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      headers: { ...validHeaders, "x-spx-request-id": "ocr-request-2" },
      payload: rawBody,
    });
    assert.equal(reboundRequestId.statusCode, 401, reboundRequestId.body);

    const reboundEventKey = await app.inject({
      method: "POST",
      url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      headers: { ...validHeaders, "idempotency-key": "ocr-event-2" },
      payload: rawBody,
    });
    assert.equal(reboundEventKey.statusCode, 401, reboundEventKey.body);
    assert.equal(reads, 1);
  } finally {
    await app.close();
  }
}

async function testNodeAuthorizationAndReplayDenyBeforeWork(): Promise<void> {
  const readNodeId = "line-reader-01";
  const adminNodeId = "web-admin-01";
  const rogueNodeId = "rogue-01";
  const secrets = new Map([
    [readNodeId, { active: "read-node-secret" }],
    [adminNodeId, { active: "admin-node-secret" }],
    [rogueNodeId, { active: "rogue-node-secret" }],
  ]);
  const rawBody = JSON.stringify({
    imageBase64: pngBytes.toString("base64"),
    mimeType: "image/png",
    traceId: "denied-trace",
  });
  let replayCalls = 0;
  let reads = 0;
  let authStatusCalls = 0;
  const replayGuard: InternalRequestReplayStore = {
    async consume() {
      replayCalls += 1;
      return { ok: true };
    },
  };
  const app = Fastify({ logger: false });
  await app.register(internalOcrController, {
    prefix: "/internal",
    nodeSecrets: secrets,
    readAllowedNodeIds: new Set([readNodeId]),
    adminAllowedNodeIds: new Set([adminNodeId]),
    replayGuard,
    readLineImage: async () => {
      reads += 1;
      return {
        text: LINE_IMAGE_EXAMPLE_OUTPUT,
        attempts: 1,
        validation: { ok: true, parsed: {} as never },
      };
    },
    authService: {
      getStatus: async () => {
        authStatusCalls += 1;
        return {
          authenticated: true,
          expiresAt: Date.parse("2026-09-13T00:00:00.000Z"),
          authPath: "C:\\sensitive\\codex-device-auth.json",
        };
      },
      startBrowser: async () => ({ authorizationUrl: "https://example.test", state: "s", redirectUri: "http://localhost" }),
      startDevice: async () => ({ userCode: "CODE", verificationUri: "https://example.test", expiresIn: 600 }),
      complete: async () => ({ authenticated: true as const, expiresAt: Date.now() }),
      logout: async () => undefined,
    },
  });
  try {
    const rogue = await app.inject({
      method: "POST",
      url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      headers: nodeSignedHeaders({
        body: rawBody,
        nodeId: rogueNodeId,
        path: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        requestId: "rogue-request",
        secret: secrets.get(rogueNodeId)!.active,
      }),
      payload: rawBody,
    });
    assert.equal(rogue.statusCode, 403, rogue.body);
    assert.equal(replayCalls, 0);
    assert.equal(reads, 0);

    const adminBody = JSON.stringify({ kind: "status" });
    const readNodeAdmin = await app.inject({
      method: "POST",
      url: OCR_INTERNAL_ADMIN_STATUS_PATH,
      headers: nodeSignedHeaders({
        body: adminBody,
        nodeId: readNodeId,
        path: OCR_INTERNAL_ADMIN_STATUS_PATH,
        requestId: "read-node-admin-request",
        secret: secrets.get(readNodeId)!.active,
      }),
      payload: adminBody,
    });
    assert.equal(readNodeAdmin.statusCode, 403, readNodeAdmin.body);
    assert.equal(replayCalls, 0);
    assert.equal(authStatusCalls, 0);

    const adminStatus = await app.inject({
      method: "POST",
      url: OCR_INTERNAL_ADMIN_STATUS_PATH,
      headers: nodeSignedHeaders({
        body: adminBody,
        nodeId: adminNodeId,
        path: OCR_INTERNAL_ADMIN_STATUS_PATH,
        requestId: "admin-status-request",
        secret: secrets.get(adminNodeId)!.active,
      }),
      payload: adminBody,
    });
    assert.equal(adminStatus.statusCode, 200, adminStatus.body);
    assert.deepEqual(JSON.parse(adminStatus.body).data, {
      authenticated: true,
      provider: "codex-device",
      expiresAt: "2026-09-13T00:00:00.000Z",
    });
    assert.doesNotMatch(adminStatus.body, /authPath|sensitive/i);
    assert.equal(replayCalls, 1);
    assert.equal(authStatusCalls, 1);
  } finally {
    await app.close();
  }
}

async function testReplayAndCapacityFailuresDenyBeforeProviderWork(): Promise<void> {
  const nodeSecret = "node-scoped-replay-secret";
  const rawBody = JSON.stringify({
    imageBase64: pngBytes.toString("base64"),
    mimeType: "image/png",
    traceId: "replay-trace",
  });
  for (const expected of [
    { reason: "replay" as const, status: 409, code: "INTERNAL_REPLAY_DETECTED" },
    { reason: "capacity" as const, status: 429, code: "INTERNAL_REPLAY_CAPACITY" },
  ]) {
    let reads = 0;
    const app = Fastify({ logger: false });
    await app.register(internalOcrController, {
      prefix: "/internal",
      nodeSecrets: new Map([[nodeId, { active: nodeSecret }]]),
      readAllowedNodeIds: new Set([nodeId]),
      adminAllowedNodeIds: new Set(),
      replayGuard: { consume: async () => ({ ok: false, reason: expected.reason }) },
      readLineImage: async () => {
        reads += 1;
        throw new Error("must not run");
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        headers: nodeSignedHeaders({
          body: rawBody,
          nodeId,
          path: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
          requestId: `ocr-${expected.reason}-request`,
          secret: nodeSecret,
        }),
        payload: rawBody,
      });
      assert.equal(response.statusCode, expected.status, response.body);
      assert.equal(JSON.parse(response.body).error_code, expected.code);
      assert.equal(reads, 0);
    } finally {
      await app.close();
    }
  }
}

async function testNodeScopedAdminRoutesPreserveProviderAuthOperations(): Promise<void> {
  const adminNodeId = "web-admin-02";
  const nodeSecret = "admin-operations-node-secret";
  const calls: string[] = [];
  const app = Fastify({ logger: false });
  await app.register(internalOcrController, {
    prefix: "/internal",
    nodeSecrets: new Map([[adminNodeId, { active: nodeSecret }]]),
    readAllowedNodeIds: new Set(),
    adminAllowedNodeIds: new Set([adminNodeId]),
    authService: {
      getStatus: async () => ({ authenticated: false }),
      startBrowser: async () => {
        calls.push("start-browser");
        return { authorizationUrl: "https://example.test/browser", state: "state", redirectUri: "http://localhost" };
      },
      startDevice: async () => {
        calls.push("start-device");
        return { userCode: "ABCD", verificationUri: "https://example.test/device", expiresIn: 600 };
      },
      complete: async (input) => {
        calls.push(`complete:${input}`);
        return { authenticated: true, expiresAt: 1_789_257_600_000 };
      },
      logout: async () => {
        calls.push("logout");
      },
    },
  });
  try {
    const requests = [
      {
        path: OCR_INTERNAL_ADMIN_START_PATH,
        body: { kind: "start", mode: "device" },
        expected: { userCode: "ABCD", verificationUri: "https://example.test/device", expiresIn: 600, mode: "device" },
      },
      {
        path: OCR_INTERNAL_ADMIN_START_PATH,
        body: { kind: "start", mode: "browser" },
        expected: { authorizationUrl: "https://example.test/browser", state: "state", redirectUri: "http://localhost", mode: "browser" },
      },
      {
        path: OCR_INTERNAL_ADMIN_COMPLETE_PATH,
        body: { kind: "complete", input: "http://localhost/callback?code=safe" },
        expected: { authenticated: true, expiresAt: 1_789_257_600_000 },
      },
      {
        path: OCR_INTERNAL_ADMIN_LOGOUT_PATH,
        body: { kind: "logout" },
        expected: { loggedOut: true },
      },
    ] as const;
    for (const [index, request] of requests.entries()) {
      const rawBody = JSON.stringify(request.body);
      const response = await app.inject({
        method: "POST",
        url: request.path,
        headers: nodeSignedHeaders({
          body: rawBody,
          nodeId: adminNodeId,
          path: request.path,
          requestId: `admin-operation-${index}`,
          secret: nodeSecret,
        }),
        payload: rawBody,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(JSON.parse(response.body).data, request.expected);
    }
    assert.deepEqual(calls, [
      "start-device",
      "start-browser",
      "complete:http://localhost/callback?code=safe",
      "logout",
    ]);
  } finally {
    await app.close();
  }
}

async function testAdminProviderFailureIsRedacted(): Promise<void> {
  const adminNodeId = "web-admin-redaction";
  const nodeSecret = "admin-redaction-node-secret";
  const body = JSON.stringify({ kind: "status" });
  const app = Fastify({ logger: false });
  await app.register(internalOcrController, {
    prefix: "/internal",
    nodeSecrets: new Map([[adminNodeId, { active: nodeSecret }]]),
    readAllowedNodeIds: new Set(),
    adminAllowedNodeIds: new Set([adminNodeId]),
    authService: {
      getStatus: async () => {
        throw new Error("provider-token-must-not-leak");
      },
      startBrowser: async () => ({}),
      startDevice: async () => ({}),
      complete: async () => ({}),
      logout: async () => undefined,
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: OCR_INTERNAL_ADMIN_STATUS_PATH,
      headers: nodeSignedHeaders({
        body,
        nodeId: adminNodeId,
        path: OCR_INTERNAL_ADMIN_STATUS_PATH,
        requestId: "admin-redaction-request",
        secret: nodeSecret,
      }),
      payload: body,
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(JSON.parse(response.body).error_code, "OCR_ADMIN_FAILED");
    assert.doesNotMatch(response.body, /provider-token-must-not-leak/);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  await testSignedReadSucceeds();
  await testAuthFailureReturns401();
  await testInvalidPayloadReturns400();
  await testReadFailureReturnsRetryable503();
  await testNodeScopedReadBindsRequestIdAndEventKey();
  await testNodeAuthorizationAndReplayDenyBeforeWork();
  await testReplayAndCapacityFailuresDenyBeforeProviderWork();
  await testNodeScopedAdminRoutesPreserveProviderAuthOperations();
  await testAdminProviderFailureIsRedacted();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
