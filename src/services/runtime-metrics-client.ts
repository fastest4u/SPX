import type { MetricsSnapshot } from "./metrics.js";
import { createInternalSignature } from "./internal-auth.js";

export interface PublishRuntimeMetricsSnapshotInput {
  url: string;
  sharedSecret: string;
  nodeId: string;
  snapshot: MetricsSnapshot;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
}

export type PublishRuntimeMetricsSnapshotResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string };

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runtimeMetricsUrlFromNotificationUrl(notificationUrl: string): string {
  const url = new URL(notificationUrl);
  url.pathname = url.pathname.replace(/\/notification-events$/, "/runtime-metrics");
  return url.toString();
}

export async function publishRuntimeMetricsSnapshot(
  input: PublishRuntimeMetricsSnapshotInput,
): Promise<PublishRuntimeMetricsSnapshotResult> {
  const body = JSON.stringify(input.snapshot);
  const timestamp = new Date().toISOString();
  const path = new URL(input.url).pathname;
  const signature = createInternalSignature({
    body,
    timestamp,
    nodeId: input.nodeId,
    path,
    secret: input.sharedSecret,
  });
  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-spx-node-id": input.nodeId,
        "x-spx-timestamp": timestamp,
        "x-spx-signature": signature,
      },
      body,
      signal: timeoutSignal(input.requestTimeoutMs),
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: await response.text() };
  }
  return { ok: true, status: response.status };
}
