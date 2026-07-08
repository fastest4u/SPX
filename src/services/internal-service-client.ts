import { createInternalSignature } from "./internal-auth.js";

export interface SignedJsonRequestInput<TBody> {
  url: string;
  sharedSecret: string;
  nodeId: string;
  body: TBody;
  eventKey?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
}

export type SignedJsonRequestResult<TData> =
  | { ok: true; status: number; data: TData }
  | { ok: false; status?: number; error: string; retryable: boolean };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function responseData<TData>(parsed: unknown): TData {
  if (parsed && typeof parsed === "object" && "data" in parsed) {
    return (parsed as { data: TData }).data;
  }
  return parsed as TData;
}

export function isRetryableInternalStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

export async function signedJsonPost<TBody, TData>(
  input: SignedJsonRequestInput<TBody>,
): Promise<SignedJsonRequestResult<TData>> {
  let path: string;
  try {
    path = new URL(input.url).pathname;
  } catch (error) {
    return { ok: false, error: errorMessage(error), retryable: false };
  }

  const body = JSON.stringify(input.body);
  const timestamp = new Date().toISOString();
  const signature = createInternalSignature({
    body,
    timestamp,
    nodeId: input.nodeId,
    path,
    secret: input.sharedSecret,
    eventKey: input.eventKey,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-spx-node-id": input.nodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": signature,
  };
  if (input.eventKey !== undefined) {
    headers["idempotency-key"] = input.eventKey;
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: "POST",
      headers,
      body,
      signal: timeoutSignal(input.requestTimeoutMs),
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error), retryable: true };
  }

  if (!response.ok) {
    const error = await response.text();
    return {
      ok: false,
      status: response.status,
      error,
      retryable: isRetryableInternalStatus(response.status),
    };
  }

  try {
    const parsed = (await response.json()) as unknown;
    return { ok: true, status: response.status, data: responseData<TData>(parsed) };
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      error: errorMessage(error),
      retryable: isRetryableInternalStatus(response.status),
    };
  }
}
