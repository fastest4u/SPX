import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const notificationPublisher = source("src/services/notification-publisher.ts");
const poller = source("src/controllers/poller.ts");
const lineBot = source("src/services/line-bot.ts");
const aiController = source("src/controllers/ai-controller.ts");

for (const [name, content] of [
  ["notification publisher", notificationPublisher],
  ["runtime metrics publisher", poller],
] as const) {
  assert.match(content, /resolveOutboundNodeSecret\s*\(/, `${name} must resolve the notification node secret`);
  assert.match(content, /nodeSecret:\s*env\.NOTIFICATION_NODE_SECRET/);
  assert.match(content, /legacySharedSecret:\s*env\.NOTIFIER_SHARED_SECRET/);
  assert.match(content, /nodeEnv:\s*env\.NODE_ENV/);
  assert.doesNotMatch(content, /sharedSecret:\s*env\.NOTIFIER_SHARED_SECRET\s*[,\n]/);
}

for (const [name, content, legacySecret] of [
  ["LINE OCR caller", lineBot, "NOTIFIER_SHARED_SECRET"],
  ["admin OCR caller", aiController, "OCR_SERVICE_ADMIN_SECRET"],
] as const) {
  assert.match(content, /resolveOutboundNodeSecret\s*\(/, `${name} must resolve the OCR node secret`);
  assert.match(content, /nodeSecret:\s*env\.OCR_NODE_SECRET/);
  assert.match(content, new RegExp(`legacySharedSecret:\\s*env\\.${legacySecret}`));
  assert.match(content, /nodeEnv:\s*env\.NODE_ENV/);
  assert.doesNotMatch(content, new RegExp(`sharedSecret:\\s*env\\.${legacySecret}\\s*[,\\n]`));
}

console.log("node-scoped-hmac-outbound-wiring: per-node caller secrets verified");
