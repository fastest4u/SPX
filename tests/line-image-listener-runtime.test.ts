import assert from "node:assert/strict";
import {
  shouldStartLineImageListener,
  startLineImageListenerForRole,
} from "../src/services/line-image-listener-runtime.js";

assert.equal(shouldStartLineImageListener("line-service", "C123"), true);
assert.equal(shouldStartLineImageListener("combined", "C123"), true);
assert.equal(shouldStartLineImageListener("line-service", " "), false);
assert.equal(shouldStartLineImageListener("api", "C123"), false);
assert.equal(shouldStartLineImageListener("notification-service", "C123"), false);
assert.equal(shouldStartLineImageListener("notifier", "C123"), false);

async function main(): Promise<void> {
  const started: string[] = [];
  const logs: Array<{ event: string; meta: Record<string, unknown> }> = [];

  const didStart = await startLineImageListenerForRole({
    role: "line-service",
    nodeId: "line-service-01",
    chatId: "C123456789-secret-chat",
    startImageListener: async (chatId) => {
      started.push(chatId);
    },
    logger: {
      info: (event, meta) => logs.push({ event, meta }),
      error: (event, meta) => logs.push({ event, meta }),
    },
  });

  assert.equal(didStart, true);
  assert.deepEqual(started, ["C123456789-secret-chat"]);
  assert.equal(logs[0]?.event, "line-image-listener-started");
  assert.equal(logs[0]?.meta.role, "line-service");
  assert.equal(logs[0]?.meta.nodeId, "line-service-01");
  assert.equal(String(logs[0]?.meta.chatId).includes("secret-chat"), false);

  const skipped = await startLineImageListenerForRole({
    role: "notification-service",
    nodeId: "notification-service-01",
    chatId: "C123",
    startImageListener: async (chatId) => {
      started.push(chatId);
    },
  });

  assert.equal(skipped, false);
  assert.deepEqual(started, ["C123456789-secret-chat"]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
