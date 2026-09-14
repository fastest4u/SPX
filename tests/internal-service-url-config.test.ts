import assert from "node:assert/strict";
import {
  normalizeLineServiceUrl,
  normalizeNotifierApiUrl,
  normalizeOcrServiceUrl,
} from "../src/config/env.js";

assert.equal(
  normalizeNotifierApiUrl("http://notification-service:3002"),
  "http://notification-service:3002/internal/notification-events",
);
assert.equal(
  normalizeNotifierApiUrl("http://notification-service:3002/internal/"),
  "http://notification-service:3002/internal/notification-events",
);
assert.equal(
  normalizeNotifierApiUrl("http://notification-service:3002/internal/notification-events"),
  "http://notification-service:3002/internal/notification-events",
);
assert.equal(normalizeLineServiceUrl("http://line-service:3003/"), "http://line-service:3003");
assert.equal(normalizeOcrServiceUrl("https://ocr.internal.example/"), "https://ocr.internal.example");
assert.equal(normalizeLineServiceUrl(""), "");

for (const normalize of [normalizeNotifierApiUrl, normalizeLineServiceUrl, normalizeOcrServiceUrl]) {
  assert.throws(() => normalize("ftp://internal.example"), /http/);
  assert.throws(() => normalize("https://user:password@internal.example"), /credentials/);
  assert.throws(() => normalize("https://internal.example?token=secret"), /query|fragment/);
  assert.throws(() => normalize("https://internal.example/#debug"), /query|fragment/);
}

assert.throws(
  () => normalizeNotifierApiUrl("https://notification.internal.example/wrong"),
  /notification-events/,
);
assert.throws(() => normalizeLineServiceUrl("https://line.internal.example/internal"), /origin|path/);
assert.throws(() => normalizeOcrServiceUrl("https://ocr.internal.example/internal/ocr"), /origin|path/);

console.log("internal-service-url-config: strict internal URL contracts verified");
