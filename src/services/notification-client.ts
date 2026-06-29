import { createInternalSignature } from "./internal-auth.js";
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

function stableSpoolHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    "content-type": headers["content-type"],
    "x-spx-node-id": headers["x-spx-node-id"],
    "idempotency-key": headers["idempotency-key"],
  };
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const normalizedName = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  return match?.[1];
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function shouldSpoolFailure(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

async function sendSignedNotificationEvent(input: {
  url: string;
  sharedSecret: string;
  nodeId: string;
  eventKey: string;
  body: string;
  contentType?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
}): Promise<{ headers: Record<string, string>; result: PublishNotificationEventResult }> {
  const path = new URL(input.url).pathname;
  const timestamp = new Date().toISOString();
  const signature = createInternalSignature({
    body: input.body,
    timestamp,
    nodeId: input.nodeId,
    path,
    secret: input.sharedSecret,
    eventKey: input.eventKey,
  });
  const headers: Record<string, string> = {
    "content-type": input.contentType ?? "application/json",
    "x-spx-node-id": input.nodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": signature,
    "idempotency-key": input.eventKey,
  };
  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: "POST",
      headers,
      body: input.body,
      signal: timeoutSignal(input.requestTimeoutMs),
    });
  } catch (error) {
    return { headers, result: { ok: false, error: errorMessage(error) } };
  }

  if (!response.ok) {
    const error = await response.text();
    return { headers, result: { ok: false, status: response.status, error } };
  }

  const json = (await response.json()) as { data?: { duplicate?: unknown } };
  return {
    headers,
    result: { ok: true, duplicate: Boolean(json.data?.duplicate), status: response.status },
  };
}

export async function publishNotificationEvent(
  input: PublishNotificationEventInput,
): Promise<PublishNotificationEventResult> {
  const body = JSON.stringify(input.event);
  const sent = await sendSignedNotificationEvent({
    url: input.url,
    sharedSecret: input.sharedSecret,
    body,
    nodeId: input.nodeId,
    eventKey: input.eventKey,
    fetchImpl: input.fetchImpl,
    requestTimeoutMs: input.requestTimeoutMs,
  });

  if (!sent.result.ok && shouldSpoolFailure(sent.result.status)) {
    await appendToSpool(input, stableSpoolHeaders(sent.headers), body);
  }

  return sent.result;
}

export async function sendSpooledNotificationEvent(
  input: SendSpooledNotificationEventInput,
): Promise<PublishNotificationEventResult> {
  const nodeId = input.nodeId ?? getHeader(input.entry.headers, "x-spx-node-id");
  if (nodeId === undefined || nodeId.trim() === "") {
    return { ok: false, error: "missing x-spx-node-id" };
  }

  const sent = await sendSignedNotificationEvent({
    url: input.entry.url,
    sharedSecret: input.sharedSecret,
    body: input.entry.body,
    nodeId,
    eventKey: input.entry.eventKey,
    contentType: getHeader(input.entry.headers, "content-type"),
    fetchImpl: input.fetchImpl,
    requestTimeoutMs: input.requestTimeoutMs,
  });
  return sent.result;
}
