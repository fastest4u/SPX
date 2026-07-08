import { signedJsonPost } from "./internal-service-client.js";
import type { NotificationEventInput } from "./notification-events.js";
import type { NotificationSpool, NotificationSpoolEntry } from "./notification-spool.js";

export interface PublishNotificationEventInput {
  url: string;
  sharedSecret: string;
  nodeId: string;
  eventKey: string;
  event: NotificationEventInput;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  spool?: NotificationSpool;
  requestTimeoutMs?: number;
}

export type PublishNotificationEventResult =
  | { ok: true; duplicate: boolean; status: number }
  | { ok: false; status?: number; error: string };

export interface SendSpooledNotificationEventInput {
  entry: NotificationSpoolEntry;
  sharedSecret: string;
  nodeId?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
}

async function appendToSpool(
  input: PublishNotificationEventInput,
  headers: Record<string, string>,
  body: string,
): Promise<void> {
  if (!input.spool) return;
  await input.spool.append({
    eventKey: input.eventKey,
    url: input.url,
    headers,
    body,
  });
}

function stableSpoolHeaders(input: { nodeId: string; eventKey: string }): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-spx-node-id": input.nodeId,
    "idempotency-key": input.eventKey,
  };
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const normalizedName = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  return match?.[1];
}

function notificationFailureResult(input: {
  status?: number;
  error: string;
}): PublishNotificationEventResult {
  if (input.status === undefined) return { ok: false, error: input.error };
  return { ok: false, status: input.status, error: input.error };
}

export async function publishNotificationEvent(
  input: PublishNotificationEventInput,
): Promise<PublishNotificationEventResult> {
  const body = JSON.stringify(input.event);
  const sent = await signedJsonPost<NotificationEventInput, { duplicate?: unknown }>({
    url: input.url,
    sharedSecret: input.sharedSecret,
    body: input.event,
    nodeId: input.nodeId,
    eventKey: input.eventKey,
    fetchImpl: input.fetchImpl,
    requestTimeoutMs: input.requestTimeoutMs,
  });

  if (!sent.ok && sent.retryable) {
    await appendToSpool(input, stableSpoolHeaders(input), body);
  }

  if (sent.ok) {
    return { ok: true, duplicate: Boolean(sent.data?.duplicate), status: sent.status };
  }
  return notificationFailureResult(sent);
}

export async function sendSpooledNotificationEvent(
  input: SendSpooledNotificationEventInput,
): Promise<PublishNotificationEventResult> {
  const nodeId = input.nodeId ?? getHeader(input.entry.headers, "x-spx-node-id");
  if (nodeId === undefined || nodeId.trim() === "") {
    return { ok: false, error: "missing x-spx-node-id" };
  }

  let body: NotificationEventInput;
  try {
    body = JSON.parse(input.entry.body) as NotificationEventInput;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const sent = await signedJsonPost<NotificationEventInput, { duplicate?: unknown }>({
    url: input.entry.url,
    sharedSecret: input.sharedSecret,
    body,
    nodeId,
    eventKey: input.entry.eventKey,
    fetchImpl: input.fetchImpl,
    requestTimeoutMs: input.requestTimeoutMs,
  });
  if (sent.ok) {
    return { ok: true, duplicate: Boolean(sent.data?.duplicate), status: sent.status };
  }
  return notificationFailureResult(sent);
}
