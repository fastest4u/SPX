import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const notification = read("scripts/service-fault-publish-notification.mjs");
const ocr = read("scripts/service-fault-ocr-boundary-probe.mjs");

assert.match(notification, /NOTIFICATION_NODE_SECRET/);
assert.match(notification, /nodeEnvironment\s*===\s*["']production["']/);
assert.match(notification, /spx-hmac-v2/);
assert.match(notification, /x-spx-request-id/);
assert.doesNotMatch(notification, /SELECT setting_value FROM app_settings/);
assert.doesNotMatch(notification, /mysql2\/promise/);

assert.match(ocr, /OCR_NODE_SECRET/);
assert.match(ocr, /nodeEnvironment\s*===\s*["']production["']/);
assert.match(ocr, /spx-hmac-v2/);
assert.match(ocr, /x-spx-request-id/);
assert.doesNotMatch(ocr, /SELECT setting_value FROM app_settings/);
assert.doesNotMatch(ocr, /mysql2\/promise/);

console.log("node-scoped-hmac-guardrail-wiring: drill callers use process-local node keys");
