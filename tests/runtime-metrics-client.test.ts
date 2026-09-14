import assert from "node:assert/strict";
import { publishRuntimeMetricsSnapshot } from "../src/services/runtime-metrics-client.js";
import { MetricsCollector } from "../src/services/metrics.js";
import { verifyInternalSignature } from "../src/services/internal-auth.js";

async function main(): Promise<void> {
  const nodeId = "runtime-metrics-worker-01";
  const sharedSecret = "runtime-metrics-node-secret";
  const url = "https://notification.internal/internal/runtime-metrics";
  const snapshot = new MetricsCollector({ teamId: 2, teamName: "PTWL" }).snapshot();
  let capturedHeaders = new Headers();
  let capturedBody = "";
  const result = await publishRuntimeMetricsSnapshot({
    url,
    sharedSecret,
    nodeId,
    snapshot,
    fetchImpl: async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ status: "success", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(result, { ok: true, status: 200 });
  const timestamp = capturedHeaders.get("x-spx-timestamp") ?? "";
  const requestId = capturedHeaders.get("x-spx-request-id") ?? "";
  assert.match(requestId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(verifyInternalSignature({
    body: capturedBody,
    timestamp,
    nodeId,
    path: "/internal/runtime-metrics",
    secret: sharedSecret,
    requestId,
    signature: capturedHeaders.get("x-spx-signature") ?? "",
    now: new Date(timestamp),
  }), { ok: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
