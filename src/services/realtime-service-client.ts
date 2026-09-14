import { randomUUID } from "node:crypto";
import { createInternalSignature } from "./internal-auth.js";
import type { RealtimeScope } from "./realtime-contract.js";

export interface RealtimeReadRequestBody {
  scope: RealtimeScope;
  limit?: number;
  lastEventId?: string;
}

export interface RealtimeStreamDownstream {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Uint8Array | string): boolean;
  end(chunk?: string): void;
  on(event: "close" | "drain", listener: () => void): unknown;
  off(event: "close" | "drain", listener: () => void): unknown;
}

export interface RealtimeServiceClientOptions {
  baseUrl: string;
  sharedSecret: string;
  nodeId: string;
  connectTimeoutMs: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export type RealtimeStreamRelayResult =
  | { connected: true }
  | { connected: false; status: number };

export interface RealtimeReadGateway {
  readMetrics<T = unknown>(body: RealtimeReadRequestBody): Promise<T>;
  readMetricsHistory<T = unknown>(body: RealtimeReadRequestBody): Promise<T>;
  readRuntimeStatus<T = unknown>(body: RealtimeReadRequestBody): Promise<T>;
  relayStream(input: {
    body: RealtimeReadRequestBody;
    downstream: RealtimeStreamDownstream;
  }): Promise<RealtimeStreamRelayResult>;
}

export type RealtimeServiceClient = RealtimeReadGateway;

export class RealtimeServiceClientError extends Error {
  readonly status?: number;

  constructor(status?: number) {
    super(status === undefined
      ? "Realtime service request failed"
      : `Realtime service request failed with status ${status}`);
    this.name = "RealtimeServiceClientError";
    this.status = status;
  }
}

function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function signedRequest(input: {
  url: string;
  sharedSecret: string;
  nodeId: string;
  body: RealtimeReadRequestBody;
}): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(input.body);
  const timestamp = new Date().toISOString();
  const requestId = randomUUID();
  const path = new URL(input.url).pathname;
  const signature = createInternalSignature({
    body,
    timestamp,
    nodeId: input.nodeId,
    path,
    secret: input.sharedSecret,
    requestId,
  });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-spx-node-id": input.nodeId,
      "x-spx-request-id": requestId,
      "x-spx-timestamp": timestamp,
      "x-spx-signature": signature,
    },
  };
}

function responseData<T>(parsed: unknown): T {
  if (parsed && typeof parsed === "object" && "data" in parsed) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}

function waitForDrainOrClose(
  downstream: RealtimeStreamDownstream,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed()) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = () => {
      downstream.off("drain", onDrain);
      downstream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    downstream.on("drain", onDrain);
    downstream.on("close", onClose);
    if (isClosed()) onClose();
  });
}

export function createRealtimeServiceClient(options: RealtimeServiceClientOptions): RealtimeServiceClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;

  async function readJson<T>(suffix: string, body: RealtimeReadRequestBody): Promise<T> {
    const url = endpoint(options.baseUrl, suffix);
    const request = signedRequest({
      url,
      sharedSecret: options.sharedSecret,
      nodeId: options.nodeId,
      body,
    });
    const controller = new AbortController();
    const timer = options.connectTimeoutMs > 0
      ? scheduleTimeout(() => controller.abort(), options.connectTimeoutMs)
      : null;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      if (!response.ok) throw new RealtimeServiceClientError(response.status);
      try {
        return responseData<T>(await response.json());
      } catch (error) {
        if (error instanceof RealtimeServiceClientError) throw error;
        throw new RealtimeServiceClientError(response.status);
      }
    } catch (error) {
      if (error instanceof RealtimeServiceClientError) throw error;
      throw new RealtimeServiceClientError();
    } finally {
      if (timer !== null) cancelTimeout(timer);
    }
  }

  async function relayStream(input: {
    body: RealtimeReadRequestBody;
    downstream: RealtimeStreamDownstream;
  }): Promise<RealtimeStreamRelayResult> {
    const url = endpoint(options.baseUrl, "stream");
    const request = signedRequest({
      url,
      sharedSecret: options.sharedSecret,
      nodeId: options.nodeId,
      body: input.body,
    });
    const controller = new AbortController();
    let closed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const close = () => {
      closed = true;
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    };
    input.downstream.on("close", close);

    const timer = options.connectTimeoutMs > 0
      ? scheduleTimeout(() => controller.abort(), options.connectTimeoutMs)
      : null;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
    } catch {
      input.downstream.off("close", close);
      return { connected: false, status: 503 };
    } finally {
      if (timer !== null) cancelTimeout(timer);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
      input.downstream.off("close", close);
      await response.body?.cancel().catch(() => undefined);
      return { connected: false, status: response.ok ? 502 : response.status };
    }

    if (closed) {
      input.downstream.off("close", close);
      await response.body.cancel().catch(() => undefined);
      return { connected: true };
    }

    input.downstream.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reader = response.body.getReader();
    try {
      while (!closed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!input.downstream.write(chunk.value)) {
          await waitForDrainOrClose(input.downstream, () => closed);
        }
      }
      if (!closed) input.downstream.end();
      return { connected: true };
    } catch {
      if (!closed) input.downstream.end();
      return { connected: true };
    } finally {
      input.downstream.off("close", close);
      if (closed) await reader.cancel().catch(() => undefined);
    }
  }

  return {
    readMetrics: (body) => readJson("read-models/metrics", body),
    readMetricsHistory: (body) => readJson("read-models/metrics-history", body),
    readRuntimeStatus: (body) => readJson("read-models/runtime-status", body),
    relayStream,
  };
}
