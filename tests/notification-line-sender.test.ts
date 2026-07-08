import assert from "node:assert/strict";
import { createNotificationLineSender } from "../src/services/notification-line-sender.js";

async function testRemoteLineServiceUsedWhenConfigured(): Promise<void> {
  const calls: string[] = [];
  const sender = createNotificationLineSender({
    lineServiceUrl: "https://line.internal.example",
    sharedSecret: "secret",
    nodeId: "notification-service-01",
    requestTimeoutMs: 25,
    allowLocalFallback: false,
    sendRemoteLineMessage: async (_options, request) => {
      calls.push(`${request.targetId}:${request.text}`);
      return { ok: true, providerMessageId: "line-msg-1", retryable: false };
    },
  });

  assert.deepEqual(await sender("C123", "hello"), {
    ok: true,
    providerMessageId: "line-msg-1",
    retryable: false,
  });
  assert.deepEqual(calls, ["C123:hello"]);
}

async function testLocalFallbackAllowedAfterRemoteFailure(): Promise<void> {
  const calls: string[] = [];
  const sender = createNotificationLineSender({
    lineServiceUrl: "https://line.internal.example",
    sharedSecret: "secret",
    nodeId: "notifier-01",
    requestTimeoutMs: 25,
    allowLocalFallback: true,
    sendRemoteLineMessage: async () => ({ ok: false, error: "line-service down", retryable: true }),
    sendLocalLineMessage: async (targetId, text) => {
      calls.push(`${targetId}:${text}`);
      return { ok: true };
    },
  });

  assert.deepEqual(await sender("C123", "hello"), { ok: true });
  assert.deepEqual(calls, ["C123:hello"]);
}

async function testMissingLineServiceUrlWithoutFallbackFails(): Promise<void> {
  const sender = createNotificationLineSender({
    lineServiceUrl: "",
    sharedSecret: "secret",
    nodeId: "notification-service-01",
    requestTimeoutMs: 25,
    allowLocalFallback: false,
  });

  assert.deepEqual(await sender("C123", "hello"), {
    ok: false,
    error: "LINE_SERVICE_URL is required",
    retryable: false,
  });
}

async function main(): Promise<void> {
  await testRemoteLineServiceUsedWhenConfigured();
  await testLocalFallbackAllowedAfterRemoteFailure();
  await testMissingLineServiceUrlWithoutFallbackFails();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
