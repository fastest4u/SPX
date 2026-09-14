import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { internalLineController, type InternalLineControllerOptions } from "../src/controllers/internal-line-controller.js";
import { internalOcrController } from "../src/controllers/internal-ocr-controller.js";
import { DurableInternalRequestReplayGuard } from "../src/repositories/internal-request-replay-repository.js";
import { FileInternalRequestReplayGuard } from "../src/services/file-internal-request-replay.js";
import { createInternalSignature, type NodeSecretKeyRing } from "../src/services/internal-auth.js";
import { getLineServiceStatus, sendLineServiceMessage } from "../src/services/line-service-client.js";
import { readLineImageViaOcrService } from "../src/services/ocr-service-client.js";

const active = "synthetic-active-boundary-key";
const previous = "synthetic-previous-boundary-key";
const legacy = "synthetic-legacy-boundary-key";
const admin = "synthetic-admin-boundary-key";
const nodeId = "notification-boundary";
const sendPath = "/internal/line/messages";
const sendBody = { targetId: "target-1", text: "title\nmessage", traceId: "event-1", outboxId: 1,
  providerRequestId: "provider-1", providerStartedAt: "2030-06-29 09:00:03" };
type Captured = { url: string; payload: string; headers: Record<string, string> };

function transport(app: FastifyInstance, captures: Captured[]) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const captured = { url: new URL(url).pathname, payload: String(init.body), headers: Object.fromEntries(new Headers(init.headers)) };
    captures.push(captured);
    const response = await app.inject({ method: "POST", ...captured });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
}

function signed(path: string, body: unknown, secret: string, sender = nodeId, requestId: string | undefined = randomUUID()): Captured {
  const payload = JSON.stringify(body);
  const timestamp = new Date().toISOString();
  return { url: path, payload, headers: {
    "content-type": "application/json", "x-spx-node-id": sender, "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({ body: payload, timestamp, nodeId: sender, path, secret, requestId: requestId || undefined }),
    ...(requestId ? { "x-spx-request-id": requestId } : {}),
  } };
}

async function testOcrActualClientBoundary() {
  const ledgerDir = await mkdtemp(join(tmpdir(), "spx-ocr-client-boundary-"));
  let reads = 0;
  const captures: Captured[] = [];
  const createApp = async () => {
    const app = Fastify();
    await app.register(internalOcrController, { prefix: "/internal", nodeSecrets: new Map([["line-boundary", { active }]]),
      readAllowedNodeIds: new Set(["line-boundary"]), replayGuard: new FileInternalRequestReplayGuard({ ledgerDir }),
      readLineImage: async () => { reads++; return { text: "synthetic OCR", attempts: 1, validation: { ok: true } }; } });
    return app;
  };
  let app = await createApp();
  try {
    const options = { baseUrl: "http://ocr.invalid", nodeId: "line-boundary", sharedSecret: active, requestTimeoutMs: 1000, fetchImpl: transport(app, captures) };
    const request = { imageBase64: "aW1hZ2U=", mimeType: "image/png" as const, traceId: "same-ocr-trace" };
    assert.equal((await readLineImageViaOcrService(options, request)).ok, true, "actual OCR client must pass per-node receiver auth");
    assert.equal((await readLineImageViaOcrService(options, request)).ok, true);
    assert.ok(captures[0]!.headers["x-spx-request-id"]);
    assert.notEqual(captures[0]!.headers["x-spx-request-id"], captures[1]!.headers["x-spx-request-id"]);
    assert.equal(reads, 2);
    await app.close();
    app = await createApp();
    assert.equal((await app.inject({ method: "POST", ...captures[0]! })).statusCode, 409, "OCR file ledger rejects captured request after restart");
    assert.equal(reads, 2);
  } finally { await app.close(); await rm(ledgerDir, { recursive: true, force: true }); }
}

async function testLineActualClientBoundary() {
  await closePool(); resetMemoryDb();
  getRawMemoryDb().prepare(`INSERT INTO notification_outbox
    (id,event_key,team_id,target_type,target_id,event_type,severity,title,message,payload_json,status,attempts,locked_by,provider_request_id,provider_started_at)
    VALUES (1,'event-1',2,'line_group','target-1','auto_accept_result','success','title','message','{}','provider_sending',0,'notification-boundary','provider-1','2030-06-29 09:00:03')`).run();
  let sends = 0;
  const captures: Captured[] = [];
  const keys = new Map<string, NodeSecretKeyRing>([[nodeId, { active, previous, previousExpiresAt: new Date(Date.now() + 60_000).toISOString() }],
    ["denied-boundary", { active: "synthetic-denied-key" }]]);
  const createApp = async (overrides: Partial<InternalLineControllerOptions> = {}) => {
    const app = Fastify();
    await app.register(internalLineController, { prefix: "/internal", sharedSecret: legacy, adminSharedSecret: admin,
      nodeSecrets: keys, sendAllowedNodeIds: new Set([nodeId]), adminAllowedNodeIds: new Set(["web-boundary"]),
      requireOutboxFence: true, replayGuard: new DurableInternalRequestReplayGuard(),
      line: { isEnabled: () => true, getStatus: () => ({ enabled: true, authenticated: true }),
        sendMessage: async () => { sends++; return { ok: true }; } } as InternalLineControllerOptions["line"], ...overrides });
    return app;
  };
  let app = await createApp();
  try {
    const options = { baseUrl: "http://line.invalid", nodeId, sharedSecret: active, requestTimeoutMs: 1000, fetchImpl: transport(app, captures) };
    assert.equal((await sendLineServiceMessage(options, sendBody)).ok, true, "actual LINE client must pass per-node receiver auth");
    assert.equal(sends, 1);
    assert.equal((await sendLineServiceMessage(options, sendBody)).ok, true, "fresh transport ID may read the same completed provider fence");
    assert.equal(sends, 1);
    assert.ok(captures[0]!.headers["x-spx-request-id"]);
    assert.notEqual(captures[0]!.headers["x-spx-request-id"], captures[1]!.headers["x-spx-request-id"]);
    await app.close(); app = await createApp();
    assert.equal((await app.inject({ method: "POST", ...captures[0]! })).statusCode, 409, "LINE database ledger rejects captured request after restart");
    assert.equal(sends, 1);
    assert.equal((await app.inject({ method: "POST", ...signed(sendPath, sendBody, previous) })).statusCode, 200, "unexpired previous key works");
    keys.set(nodeId, { active, previous, previousExpiresAt: new Date(Date.now() - 1).toISOString() });
    assert.equal((await app.inject({ method: "POST", ...signed(sendPath, sendBody, previous) })).statusCode, 401, "expired previous key fails");
    assert.equal((await app.inject({ method: "POST", ...signed(sendPath, sendBody, legacy) })).statusCode, 401, "shared secret never falls back with node keys");
    assert.equal((await app.inject({ method: "POST", ...signed(sendPath, sendBody, active, "unknown-boundary") })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", ...signed(sendPath, sendBody, "synthetic-denied-key", "denied-boundary") })).statusCode, 401);
    const missingId = signed(sendPath, sendBody, active, nodeId, "");
    assert.equal((await app.inject({ method: "POST", ...missingId })).statusCode, 401, "node-key mode rejects legacy request without ID");
    const tampered = structuredClone(captures[0]!);
    tampered.headers["x-spx-request-id"] = randomUUID();
    assert.equal((await app.inject({ method: "POST", ...tampered })).statusCode, 401, "request ID is signed");
    assert.equal((await getLineServiceStatus({ ...options, nodeId: "web-boundary", sharedSecret: admin, fetchImpl: transport(app, captures) })).ok, true);
    assert.equal((await getLineServiceStatus({ ...options, nodeId: "web-boundary", fetchImpl: transport(app, captures) })).ok, false, "send key cannot authorize admin");
    assert.equal((await app.inject({ method: "POST", ...signed("/internal/line/status", {}, admin, "web-boundary", "") })).statusCode, 401, "node-key production boundary also requires replay ID for admin");
    assert.equal(sends, 1);
    await app.close();
    app = await createApp({ replayGuard: { consume: async () => { throw new Error("synthetic replay outage"); } } });
    assert.equal((await app.inject({ method: "POST", ...signed(sendPath, sendBody, active) })).statusCode, 503);
    assert.equal(sends, 1);
    await app.close();
    app = await createApp({ nodeSecrets: new Map() });
    assert.equal((await app.inject({ method: "POST", ...signed(sendPath, sendBody, legacy) })).statusCode, 401, "empty explicit map cannot enable shared fallback");
    await app.close();
    await assert.rejects(createApp({ replayGuard: undefined }), /replay store/i, "node-key boundary must not silently use process-local replay protection");
  } finally { await app.close(); await closePool(); resetMemoryDb(); }
}

async function main() {
  await testOcrActualClientBoundary();
  await testLineActualClientBoundary();
  console.log("LINE/OCR actual client boundaries: request IDs, node keys, rotation, durable replay, provider fence and admin isolation passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
