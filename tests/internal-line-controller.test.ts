import assert from "node:assert/strict";
import Fastify from "fastify";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { claimNotificationOutboxBatch, createNotificationEventAndOutbox } from "../src/repositories/notification-repository.js";
import {
  internalLineController,
  type InternalLineControllerOptions,
} from "../src/controllers/internal-line-controller.js";
import {
  LINE_INTERNAL_SEND_PATH,
  LINE_INTERNAL_STATUS_PATH,
  type LineServiceSendRequest,
} from "../src/services/line-service-contract.js";
import { createInternalSignature } from "../src/services/internal-auth.js";

const sharedSecret = "super-secret-value";
const adminSharedSecret = "admin-secret-value";
const notificationNodeId = "notification-service-01";
const webApiNodeId = "prod-web-api-1";

function buildNotificationEvent(eventKey: string) {
  return {
    eventKey,
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

async function resetDb(): Promise<void> {
  await closePool();
  resetMemoryDb();
}

function signedHeaders(input: {
  path: string;
  body: string;
  eventKey?: string;
  nodeId?: string;
  secret?: string;
  timestamp?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const nodeId = input.nodeId ?? notificationNodeId;
  const secret = input.secret ?? sharedSecret;
  return {
    "content-type": "application/json",
    "x-spx-node-id": nodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body: input.body,
      timestamp,
      nodeId,
      path: input.path,
      secret,
      eventKey: input.eventKey,
    }),
    ...(input.eventKey ? { "idempotency-key": input.eventKey } : {}),
  };
}

async function withController<T>(
  options: Omit<InternalLineControllerOptions, "sharedSecret">,
  fn: (app: ReturnType<typeof Fastify>) => Promise<T>,
): Promise<T> {
  const app = Fastify({ logger: false });
  await app.register(internalLineController, {
    prefix: "/internal",
    sharedSecret,
    adminSharedSecret,
    ...options,
  });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function testSignedSendSucceeds(): Promise<void> {
  const calls: Array<{ targetId: string; text: string }> = [];
  const body: LineServiceSendRequest = {
    targetId: "C123456789-secret-target",
    text: "hello from notification-service",
    traceId: "trace-1",
    outboxId: 123,
  };
  const rawBody = JSON.stringify(body);
  const eventKey = "notification-outbox:123";

  await withController(
    {
      line: {
        isEnabled: () => true,
        getStatus: () => ({ enabled: true, authenticated: true, message: "connected" }),
        sendMessage: async (targetId, text) => {
          calls.push({ targetId, text });
          return { ok: true };
        },
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: LINE_INTERNAL_SEND_PATH,
        headers: signedHeaders({ path: LINE_INTERNAL_SEND_PATH, body: rawBody, eventKey }),
        payload: rawBody,
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), {
        status: "success",
        data: { sent: true, provider: "linejs" },
      });
      assert.deepEqual(calls, [{ targetId: body.targetId, text: body.text }]);
      assert.equal(response.body.includes(body.targetId), false);
    },
  );
}

async function testAuthFailureReturns401(): Promise<void> {
  await withController(
    {
      line: {
        isEnabled: () => true,
        getStatus: () => ({ enabled: true, authenticated: true, message: "connected" }),
        sendMessage: async () => ({ ok: true }),
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: LINE_INTERNAL_SEND_PATH,
        payload: JSON.stringify({ targetId: "C123", text: "hello" }),
        headers: { "content-type": "application/json" },
      });

      assert.equal(response.statusCode, 401);
      const body = JSON.parse(response.body) as { error_code: string };
      assert.equal(body.error_code, "INTERNAL_AUTH_FAILED");
    },
  );
}

async function testInvalidPayloadReturns400(): Promise<void> {
  const rawBody = JSON.stringify({ targetId: "C123" });
  await withController(
    {
      line: {
        isEnabled: () => true,
        getStatus: () => ({ enabled: true, authenticated: true, message: "connected" }),
        sendMessage: async () => ({ ok: true }),
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: LINE_INTERNAL_SEND_PATH,
        payload: rawBody,
        headers: signedHeaders({ path: LINE_INTERNAL_SEND_PATH, body: rawBody }),
      });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body) as { error_code: string };
      assert.equal(body.error_code, "INTERNAL_LINE_INVALID");
    },
  );
}

async function testDisabledLineReturnsRetryable503(): Promise<void> {
  let sendCalled = false;
  const rawBody = JSON.stringify({ targetId: "C123", text: "hello" });
  await withController(
    {
      line: {
        isEnabled: () => false,
        getStatus: () => ({ enabled: false, authenticated: false, message: "disabled" }),
        sendMessage: async () => {
          sendCalled = true;
          return { ok: true };
        },
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: LINE_INTERNAL_SEND_PATH,
        payload: rawBody,
        headers: signedHeaders({ path: LINE_INTERNAL_SEND_PATH, body: rawBody }),
      });

      assert.equal(response.statusCode, 503);
      assert.equal(sendCalled, false);
      const body = JSON.parse(response.body) as {
        error_code: string;
        details?: { retryable?: boolean };
      };
      assert.equal(body.error_code, "LINE_SERVICE_UNAVAILABLE");
      assert.equal(body.details?.retryable, true);
    },
  );
}

async function testSendFailureReturnsRetryable503WithoutTargetLeak(): Promise<void> {
  const rawBody = JSON.stringify({ targetId: "C123456789-secret-target", text: "hello" });
  await withController(
    {
      line: {
        isEnabled: () => true,
        getStatus: () => ({ enabled: true, authenticated: false, message: "qr required" }),
        sendMessage: async () => ({
          ok: false,
          error: "QR login required",
          qrUrl: "https://line.example/secret-qr",
          pincode: "123456",
        }),
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: LINE_INTERNAL_SEND_PATH,
        payload: rawBody,
        headers: signedHeaders({ path: LINE_INTERNAL_SEND_PATH, body: rawBody }),
      });

      assert.equal(response.statusCode, 503);
      const body = JSON.parse(response.body) as {
        error_code: string;
        details?: { retryable?: boolean; qrRequired?: boolean };
      };
      assert.equal(body.error_code, "LINE_SEND_FAILED");
      assert.equal(body.details?.retryable, true);
      assert.equal(body.details?.qrRequired, true);
      assert.equal(response.body.includes("C123456789-secret-target"), false);
      assert.equal(response.body.includes("secret-qr"), false);
      assert.equal(response.body.includes("123456"), false);
    },
  );
}

async function testSignedStatus(): Promise<void> {
  const rawBody = "{}";
  await withController(
    {
      line: {
        isEnabled: () => true,
        getStatus: () => ({
          enabled: true,
          authenticated: false,
          qrUrl: "https://line.example/qr",
          pincode: "246810",
          message: "Waiting for QR scan",
        }),
        sendMessage: async () => ({ ok: true }),
      },
      isListenerActive: () => true,
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: LINE_INTERNAL_STATUS_PATH,
        payload: rawBody,
        headers: signedHeaders({
          path: LINE_INTERNAL_STATUS_PATH,
          body: rawBody,
          nodeId: webApiNodeId,
          secret: adminSharedSecret,
        }),
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), {
        status: "success",
        data: {
          enabled: true,
          authenticated: false,
          qrUrl: "https://line.example/qr",
          pincode: "246810",
          listenerActive: true,
        },
      });
    },
  );
}

async function testSignedAdminRoutes(): Promise<void> {
  const calls: string[] = [];
  await withController(
    {
      line: {
        isEnabled: () => true,
        getStatus: () => ({ enabled: true, authenticated: true, message: "connected" }),
        sendMessage: async () => ({ ok: true }),
        requestQrLogin: async () => {
          calls.push("login");
          return {
            enabled: true,
            authenticated: false,
            qrUrl: "https://line.example/qr",
            pincode: "135790",
            message: "QR login initiated",
          };
        },
        getGroups: async () => {
          calls.push("groups");
          return { chats: [{ chatMid: "C123", chatName: "Dispatch" }] };
        },
        getProfile: async () => {
          calls.push("profile");
          return { displayName: "SPX Bot", mid: "u123", statusMessage: "ready" };
        },
        getStorageHealth: async () => {
          calls.push("storage");
          return {
            storagePath: "data/linejs-storage.json",
            exists: true,
            sizeBytes: 128,
            hasE2EEKeys: true,
            hasAuthState: true,
          };
        },
        logout: async (clearStorage?: boolean) => {
          calls.push(`logout:${String(clearStorage)}`);
        },
      },
      isListenerActive: () => true,
    },
    async (app) => {
      const requests = [
        { path: "/internal/line/login", body: "{}" },
        { path: "/internal/line/groups", body: "{}" },
        { path: "/internal/line/profile", body: "{}" },
        { path: "/internal/line/storage", body: "{}" },
        { path: "/internal/line/logout", body: JSON.stringify({ clearStorage: true }) },
      ];

      const responses = [];
      for (const request of requests) {
        responses.push(
          await app.inject({
            method: "POST",
            url: request.path,
            payload: request.body,
            headers: signedHeaders({
              path: request.path,
              body: request.body,
              nodeId: webApiNodeId,
              secret: adminSharedSecret,
            }),
          }),
        );
      }

      assert.deepEqual(
        responses.map((response) => response.statusCode),
        [200, 200, 200, 200, 200],
      );
      assert.deepEqual(JSON.parse(responses[0].body).data, {
        enabled: true,
        authenticated: false,
        qrUrl: "https://line.example/qr",
        pincode: "135790",
        listenerActive: true,
        message: "QR login initiated",
      });
      assert.deepEqual(JSON.parse(responses[1].body).data, {
        chats: [{ chatMid: "C123", chatName: "Dispatch" }],
      });
      assert.deepEqual(JSON.parse(responses[2].body).data, {
        displayName: "SPX Bot",
        mid: "u123",
        statusMessage: "ready",
      });
      assert.deepEqual(JSON.parse(responses[3].body).data, {
        storagePath: "data/linejs-storage.json",
        exists: true,
        sizeBytes: 128,
        hasE2EEKeys: true,
        hasAuthState: true,
      });
      assert.deepEqual(JSON.parse(responses[4].body).data, {
        loggedOut: true,
        clearStorage: true,
      });
      assert.deepEqual(calls, ["login", "groups", "profile", "storage", "logout:true"]);
    },
  );
}

async function testAdminRoutesRejectSharedSecretSpoofingWebApiNode(): Promise<void> {
  let loginCalled = false;
  await withController(
    {
      line: {
        isEnabled: () => true,
        getStatus: () => ({ enabled: true, authenticated: true, message: "connected" }),
        sendMessage: async () => ({ ok: true }),
        requestQrLogin: async () => {
          loginCalled = true;
          return { enabled: true, authenticated: true, message: "connected" };
        },
      },
    },
    async (app) => {
      const rawBody = "{}";
      const response = await app.inject({
        method: "POST",
        url: "/internal/line/login",
        payload: rawBody,
        headers: signedHeaders({
          path: "/internal/line/login",
          body: rawBody,
          nodeId: webApiNodeId,
          secret: sharedSecret,
        }),
      });

      assert.equal(response.statusCode, 401);
      assert.equal(loginCalled, false);
      const body = JSON.parse(response.body) as { error_code: string };
      assert.equal(body.error_code, "INTERNAL_AUTH_FAILED");
    },
  );
}

async function testRepeatedOutboxIdDoesNotSendTwice(): Promise<void> {
  let sendCount = 0;
  const body: LineServiceSendRequest = {
    targetId: "C123456789-secret-target",
    text: "hello once",
    traceId: "trace-dedupe",
    outboxId: 456,
  };
  const rawBody = JSON.stringify(body);
  const eventKey = "notification-outbox:456";

  await withController(
    {
      line: {
        isEnabled: () => true,
        getStatus: () => ({ enabled: true, authenticated: true, message: "connected" }),
        sendMessage: async () => {
          sendCount += 1;
          return { ok: true };
        },
      },
    },
    async (app) => {
      for (let i = 0; i < 2; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: LINE_INTERNAL_SEND_PATH,
          headers: signedHeaders({ path: LINE_INTERNAL_SEND_PATH, body: rawBody, eventKey }),
          payload: rawBody,
        });
        assert.equal(response.statusCode, 200);
      }
      assert.equal(sendCount, 1);
    },
  );
}

async function testSentOutboxIdDedupesAfterControllerRestart(): Promise<void> {
  await resetDb();
  const eventKey = "auto_accept_owned:team:2:booking:2791810:req:durable-line-dedupe";
  const created = await createNotificationEventAndOutbox(buildNotificationEvent(eventKey), {
    targetType: "line_group",
    targetId: "C123456789-secret-target",
    title: "success",
    message: "accepted",
  });
  const [claimed] = await claimNotificationOutboxBatch(notificationNodeId, 5, 30_000);
  assert.equal(claimed?.id, created.outboxId);

  let sendCount = 0;
  const body: LineServiceSendRequest = {
    targetId: "C123456789-secret-target",
    text: "hello once durably",
    traceId: eventKey,
    outboxId: created.outboxId,
  };
  const rawBody = JSON.stringify(body);
  const line = {
    isEnabled: () => true,
    getStatus: () => ({ enabled: true, authenticated: true, message: "connected" }),
    sendMessage: async () => {
      sendCount += 1;
      return { ok: true };
    },
  };

  for (let i = 0; i < 2; i += 1) {
    await withController(
      { line },
      async (app) => {
        const response = await app.inject({
          method: "POST",
          url: LINE_INTERNAL_SEND_PATH,
          headers: signedHeaders({ path: LINE_INTERNAL_SEND_PATH, body: rawBody, eventKey }),
          payload: rawBody,
        });
        assert.equal(response.statusCode, 200);
      },
    );
  }

  assert.equal(sendCount, 1);
}

async function main(): Promise<void> {
  await testSignedSendSucceeds();
  await testAuthFailureReturns401();
  await testInvalidPayloadReturns400();
  await testDisabledLineReturnsRetryable503();
  await testSendFailureReturnsRetryable503WithoutTargetLeak();
  await testSignedStatus();
  await testSignedAdminRoutes();
  await testAdminRoutesRejectSharedSecretSpoofingWebApiNode();
  await testRepeatedOutboxIdDoesNotSendTwice();
  await testSentOutboxIdDedupesAfterControllerRestart();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
