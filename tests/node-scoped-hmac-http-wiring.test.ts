import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const httpServer = readFileSync(resolve(root, "src/services/http-server.ts"), "utf8");
const configCatalog = readFileSync(resolve(root, "src/config/config-catalog.ts"), "utf8");

const notificationRegistration = httpServer.match(
  /app\.register\(internalNotificationController,[\s\S]*?\n\s*}\);/,
)?.[0] ?? "";
assert.match(notificationRegistration, /nodeSecrets:\s*env\.NOTIFICATION_NODE_SECRETS/);
assert.match(notificationRegistration, /allowedNodes:\s*env\.NOTIFICATION_ALLOWED_NODE_TEAMS/);
assert.match(
  notificationRegistration,
  /sharedSecret:\s*env\.NODE_ENV\s*===\s*"production"\s*&&\s*env\.DEPLOYMENT_MODE\s*!==\s*"legacy"\s*\?\s*undefined\s*:\s*\(?env\.NOTIFIER_SHARED_SECRET/,
);
assert.doesNotMatch(notificationRegistration, /sharedSecret:\s*env\.NOTIFIER_SHARED_SECRET\s*[,\n]/);

const ocrRegistration = httpServer.match(
  /app\.register\(internalOcrController,[\s\S]*?\n\s*}\);/,
)?.[0] ?? "";
assert.match(ocrRegistration, /nodeSecrets:\s*env\.OCR_NODE_SECRETS/);
assert.match(ocrRegistration, /readAllowedNodeIds:\s*env\.OCR_ALLOWED_LINE_NODE_IDS/);
assert.match(ocrRegistration, /adminAllowedNodeIds:\s*env\.OCR_ADMIN_NODE_IDS/);
assert.match(ocrRegistration, /sharedSecret:\s*env\.NODE_ENV\s*===\s*"production"\s*\?\s*undefined/);
assert.match(ocrRegistration, /adminSharedSecret:\s*env\.NODE_ENV\s*===\s*"production"\s*\?\s*undefined/);

const lineRegistration = httpServer.match(
  /app\.register\(internalLineController,[\s\S]*?\n\s*}\);/,
)?.[0] ?? "";
assert.match(lineRegistration, /sendAllowedNodeIds:\s*env\.LINE_SEND_ALLOWED_NODE_IDS/);
assert.match(lineRegistration, /adminAllowedNodeIds:\s*env\.LINE_ADMIN_ALLOWED_NODE_IDS/);
assert.match(lineRegistration, /requireOutboxFence:\s*env\.NODE_ENV\s*===\s*"production"/);

for (const key of [
  "NOTIFICATION_NODE_SECRET",
  "NOTIFICATION_NODE_SECRETS",
  "NOTIFICATION_ALLOWED_NODE_TEAMS",
  "OCR_NODE_SECRET",
  "OCR_NODE_SECRETS",
  "OCR_ALLOWED_LINE_NODE_IDS",
  "OCR_ADMIN_NODE_IDS",
  "LINE_SEND_ALLOWED_NODE_IDS",
  "LINE_ADMIN_ALLOWED_NODE_IDS",
]) {
  assert.match(configCatalog, new RegExp(`\\"${key}\\"`), `${key} must be process-local config`);
}

console.log("node-scoped-hmac-http-wiring: receiver key resolution verified");
