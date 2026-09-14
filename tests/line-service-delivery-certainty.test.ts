import assert from "node:assert/strict";
import { sendLineServiceMessage } from "../src/services/line-service-client.js";

async function main() {
  const request = { targetId: "target", text: "message", outboxId: 1, providerRequestId: "attempt-1", providerStartedAt: "2030-06-29 09:00:03" };
  const options = { baseUrl: "https://synthetic.invalid", sharedSecret: "synthetic", nodeId: "worker", requestTimeoutMs: 100 };
  const unavailable = await sendLineServiceMessage({ ...options, fetchImpl: async () => new Response(JSON.stringify({ error_code: "LINE_SERVICE_UNAVAILABLE" }), { status: 503 }) }, request);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.deliveryCertainty, "not_sent");
  const conflict = await sendLineServiceMessage({ ...options, fetchImpl: async () => new Response(JSON.stringify({ error_code: "LINE_PROVIDER_FENCE_CONFLICT" }), { status: 409 }) }, request);
  assert.equal(conflict.ok, false);
  assert.notEqual(conflict.deliveryCertainty, "not_sent");
  const malformed = await sendLineServiceMessage({ ...options, fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }) }, request);
  assert.equal(malformed.ok, false, "HTTP success alone cannot prove provider delivery");
  assert.notEqual(malformed.deliveryCertainty, "not_sent");
  const timeout = await sendLineServiceMessage({ ...options, fetchImpl: async () => { throw new Error("timeout"); } }, request);
  assert.equal(timeout.ok, false);
  assert.notEqual(timeout.deliveryCertainty, "not_sent");
}
main().catch(error => { console.error(error); process.exit(1); });
