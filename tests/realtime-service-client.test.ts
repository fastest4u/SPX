import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { verifyInternalSignature } from "../src/services/internal-auth.js";
import { createRealtimeServiceClient } from "../src/services/realtime-service-client.js";

class FakeDownstream extends EventEmitter {
  status: number | null = null;
  headers: Record<string, string> = {};
  writes: string[] = [];
  ended = 0;
  writeResults: boolean[] = [];
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  write(chunk: Uint8Array | string): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return this.writeResults.shift() ?? true;
  }
  end(): void {
    this.ended += 1;
  }
}

function successJson(data: unknown): Response {
  return new Response(JSON.stringify({ status: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(chunks: string[], onRead?: (count: number) => void): Response {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader() {
        return {
          async read() {
            onRead?.(index + 1);
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[index++]) };
          },
          async cancel() {
            return undefined;
          },
        };
      },
    },
  } as unknown as Response;
}

async function waitTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function main(): Promise<void> {
  const baseUrl = "http://realtime.internal:8080/internal/realtime";
  const sharedSecret = "client-secret";
  const nodeId = "web-api-1";
  let capturedUrl = "";
  let capturedBody = "";
  let capturedHeaders = new Headers();
  const client = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedBody = String(init.body);
      capturedHeaders = new Headers(init.headers);
      return successJson({ ok: true });
    },
  });
  const metricsBody = { scope: { kind: "team" as const, teamId: 2 } };
  assert.deepEqual(await client.readMetrics(metricsBody), { ok: true });
  assert.equal(capturedUrl, `${baseUrl}/read-models/metrics`);
  assert.equal(capturedHeaders.get("cookie"), null);
  assert.equal(capturedHeaders.get("authorization"), null);
  assert.equal(capturedHeaders.get("x-spx-node-id"), nodeId);
  assert.match(capturedHeaders.get("x-spx-request-id") ?? "", /^[0-9a-f-]{36}$/);
  const timestamp = capturedHeaders.get("x-spx-timestamp") ?? "";
  assert.deepEqual(verifyInternalSignature({
    body: capturedBody,
    timestamp,
    nodeId,
    path: "/internal/realtime/read-models/metrics",
    secret: sharedSecret,
    requestId: capturedHeaders.get("x-spx-request-id") ?? "",
    signature: capturedHeaders.get("x-spx-signature") ?? "",
    now: new Date(timestamp),
  }), { ok: true });

  const staticErrorClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    fetchImpl: async () => new Response("database password leaked upstream", { status: 503 }),
  });
  await assert.rejects(
    () => staticErrorClient.readRuntimeStatus({ scope: { kind: "admin" } }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Realtime service request failed/);
      assert.equal(error.message.includes("database password"), false);
      return true;
    },
  );

  const jsonTimers = new Map<number, () => void>();
  let jsonTimerId = 0;
  let jsonSignal: AbortSignal | null = null;
  const hangingReadClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    setTimeout: (callback) => {
      jsonTimerId += 1;
      jsonTimers.set(jsonTimerId, callback);
      return jsonTimerId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      jsonTimers.delete(timer as unknown as number);
    },
    fetchImpl: async (_url, init) => {
      jsonSignal = init.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        jsonSignal?.addEventListener("abort", () => reject(new Error("upstream timeout detail")), { once: true });
      });
    },
  });
  const hangingRead = hangingReadClient.readMetrics(metricsBody);
  assert.equal(jsonTimers.size, 1);
  jsonTimers.get(1)?.();
  await assert.rejects(hangingRead, /Realtime service request failed/);
  assert.equal(jsonSignal?.aborted, true);
  assert.equal(jsonTimers.size, 0, "finite JSON request timer must be cleared after timeout");

  const bodyTimers = new Map<number, () => void>();
  let bodyTimerId = 0;
  let bodySignal: AbortSignal | null = null;
  let markBodyReadStarted: (() => void) | undefined;
  const bodyReadStarted = new Promise<void>((resolve) => { markBodyReadStarted = resolve; });
  const hangingBodyClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    setTimeout: (callback) => {
      bodyTimerId += 1;
      bodyTimers.set(bodyTimerId, callback);
      return bodyTimerId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      bodyTimers.delete(timer as unknown as number);
    },
    fetchImpl: async (_url, init) => {
      bodySignal = init.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        json: async () => {
          markBodyReadStarted?.();
          return await new Promise((_resolve, reject) => {
            bodySignal?.addEventListener("abort", () => reject(new Error("body timeout detail")), { once: true });
          });
        },
      } as Response;
    },
  });
  const hangingBodyRead = hangingBodyClient.readMetrics(metricsBody);
  await bodyReadStarted;
  assert.equal(bodyTimers.size, 1, "JSON timer must remain active while reading the response body");
  bodyTimers.get(1)?.();
  await assert.rejects(hangingBodyRead, /Realtime service request failed/);
  assert.equal(bodySignal?.aborted, true);
  assert.equal(bodyTimers.size, 0);

  let readCount = 0;
  const relayClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    fetchImpl: async () => streamResponse(["one", "two"], (count) => { readCount = count; }),
  });
  const downstream = new FakeDownstream();
  downstream.writeResults = [false, true];
  const relay = relayClient.relayStream({
    body: { scope: { kind: "admin" }, lastEventId: "cursor-1" },
    downstream,
  });
  await waitTurn();
  assert.equal(readCount, 1, "relay must not read the next upstream chunk before downstream drain");
  downstream.emit("drain");
  const relayResult = await relay;
  assert.deepEqual(relayResult, { connected: true });
  assert.deepEqual(downstream.writes, ["one", "two"]);
  assert.equal(downstream.ended, 1);

  let preconnectSignal: AbortSignal | null = null;
  const preconnectClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    fetchImpl: async (_url, init) => {
      preconnectSignal = init.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        preconnectSignal?.addEventListener("abort", () => reject(new Error("browser closed")), { once: true });
      });
    },
  });
  const preconnectDownstream = new FakeDownstream();
  const preconnectRelay = preconnectClient.relayStream({
    body: { scope: { kind: "team", teamId: 2 } },
    downstream: preconnectDownstream,
  });
  await waitTurn();
  preconnectDownstream.emit("close");
  assert.deepEqual(await preconnectRelay, { connected: false, status: 503 });
  assert.equal(preconnectSignal?.aborted, true);
  assert.equal(preconnectDownstream.listenerCount("close"), 0);
  assert.equal(preconnectDownstream.status, null);
  assert.equal(preconnectDownstream.ended, 0);

  let upstreamSignal: AbortSignal | null = null;
  const closeClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    fetchImpl: async (_url, init) => {
      upstreamSignal = init.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: {
          getReader() {
            return {
              read: () => new Promise((resolve) => {
                upstreamSignal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
              }),
              cancel: async () => undefined,
            };
          },
        },
      } as unknown as Response;
    },
  });
  const closingDownstream = new FakeDownstream();
  const closingRelay = closeClient.relayStream({ body: { scope: { kind: "admin" } }, downstream: closingDownstream });
  await waitTurn();
  closingDownstream.emit("close");
  await closingRelay;
  assert.equal(upstreamSignal?.aborted, true);

  const unavailableDownstream = new FakeDownstream();
  const unavailableClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    fetchImpl: async () => new Response("unavailable secret", { status: 503 }),
  });
  assert.deepEqual(
    await unavailableClient.relayStream({ body: { scope: { kind: "admin" } }, downstream: unavailableDownstream }),
    { connected: false, status: 503 },
  );
  assert.equal(unavailableDownstream.status, null, "upstream failure must be returned before downstream headers");

  const capacityDownstream = new FakeDownstream();
  const capacityClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    fetchImpl: async () => new Response("capacity detail", { status: 429 }),
  });
  assert.deepEqual(
    await capacityClient.relayStream({ body: { scope: { kind: "admin" } }, downstream: capacityDownstream }),
    { connected: false, status: 429 },
  );
  assert.equal(capacityDownstream.status, null, "capacity must propagate before downstream SSE headers");

  const failedConnectDownstream = new FakeDownstream();
  const failedConnectClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    fetchImpl: async () => { throw new Error("connection secret"); },
  });
  assert.deepEqual(
    await failedConnectClient.relayStream({ body: { scope: { kind: "admin" } }, downstream: failedConnectDownstream }),
    { connected: false, status: 503 },
  );
  assert.equal(failedConnectDownstream.listenerCount("close"), 0, "failed connects must remove close listeners");

  const timers = new Map<number, () => void>();
  let timerId = 0;
  let establishedSignal: AbortSignal | null = null;
  const timerClient = createRealtimeServiceClient({
    baseUrl,
    sharedSecret,
    nodeId,
    connectTimeoutMs: 500,
    setTimeout: (callback) => {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as unknown as number);
    },
    fetchImpl: async (_url, init) => {
      establishedSignal = init.signal as AbortSignal;
      return streamResponse([]);
    },
  });
  const timerDownstream = new FakeDownstream();
  await timerClient.relayStream({ body: { scope: { kind: "admin" } }, downstream: timerDownstream });
  assert.equal(timers.size, 0, "connection timeout must be cleared after upstream headers");
  assert.equal(establishedSignal?.aborted, false, "established streams must not inherit a lifetime timeout");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
