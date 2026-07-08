import type { SendLineMessageResult } from "./notification-dispatcher.js";
import { signedJsonPost } from "./internal-service-client.js";
import {
  LINE_INTERNAL_GROUPS_PATH,
  LINE_INTERNAL_LOGIN_PATH,
  LINE_INTERNAL_LOGOUT_PATH,
  LINE_INTERNAL_PROFILE_PATH,
  LINE_INTERNAL_SEND_PATH,
  LINE_INTERNAL_STORAGE_PATH,
  LINE_INTERNAL_STATUS_PATH,
  type LineServiceGroupsResponse,
  type LineServiceLoginResponse,
  type LineServiceLogoutRequest,
  type LineServiceLogoutResponse,
  type LineServiceProfileResponse,
  type LineServiceSendRequest,
  type LineServiceSendResponse,
  type LineServiceStorageResponse,
  type LineServiceStatusResponse,
} from "./line-service-contract.js";

export interface LineServiceClientOptions {
  baseUrl: string;
  sharedSecret: string;
  nodeId: string;
  requestTimeoutMs: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export type LineServiceMessageResult = SendLineMessageResult & {
  retryable: boolean;
};

export type LineServiceStatusResult =
  | { ok: true; status: LineServiceStatusResponse; retryable: false }
  | { ok: false; error: string; retryable: boolean };

export type LineServiceLoginResult =
  | { ok: true; status: LineServiceLoginResponse; retryable: false }
  | { ok: false; error: string; retryable: boolean };

export type LineServiceGroupsResult =
  | { ok: true; groups: LineServiceGroupsResponse; retryable: false }
  | { ok: false; error: string; retryable: boolean };

export type LineServiceProfileResult =
  | { ok: true; profile: LineServiceProfileResponse; retryable: false }
  | { ok: false; error: string; retryable: boolean };

export type LineServiceStorageResult =
  | { ok: true; storage: LineServiceStorageResponse; retryable: false }
  | { ok: false; error: string; retryable: boolean };

export type LineServiceLogoutResult =
  | { ok: true; logout: LineServiceLogoutResponse; retryable: false }
  | { ok: false; error: string; retryable: boolean };

function lineServiceUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

async function signedLineServicePost<TBody, TData>(
  options: LineServiceClientOptions,
  path: string,
  body: TBody,
  eventKey?: string,
): Promise<
  { ok: true; data: TData; retryable: false } | { ok: false; error: string; retryable: boolean }
> {
  let url: string;
  try {
    url = lineServiceUrl(options.baseUrl, path);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  const result = await signedJsonPost<TBody, TData>({
    url,
    sharedSecret: options.sharedSecret,
    nodeId: options.nodeId,
    body,
    eventKey,
    fetchImpl: options.fetchImpl,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      retryable: result.retryable,
    };
  }

  return {
    ok: true,
    data: result.data,
    retryable: false,
  };
}

export async function sendLineServiceMessage(
  options: LineServiceClientOptions,
  request: LineServiceSendRequest,
): Promise<LineServiceMessageResult> {
  const result = await signedLineServicePost<LineServiceSendRequest, LineServiceSendResponse>(
    options,
    LINE_INTERNAL_SEND_PATH,
    request,
    request.traceId,
  );

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      retryable: result.retryable,
    };
  }

  return {
    ok: true,
    providerMessageId: result.data.providerMessageId,
    retryable: false,
  };
}

export async function getLineServiceStatus(
  options: LineServiceClientOptions,
): Promise<LineServiceStatusResult> {
  const result = await signedLineServicePost<Record<string, never>, LineServiceStatusResponse>(
    options,
    LINE_INTERNAL_STATUS_PATH,
    {},
  );

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      retryable: result.retryable,
    };
  }

  return {
    ok: true,
    status: result.data,
    retryable: false,
  };
}

export async function requestLineServiceLogin(
  options: LineServiceClientOptions,
): Promise<LineServiceLoginResult> {
  const result = await signedLineServicePost<Record<string, never>, LineServiceLoginResponse>(
    options,
    LINE_INTERNAL_LOGIN_PATH,
    {},
  );
  if (!result.ok) return result;
  return { ok: true, status: result.data, retryable: false };
}

export async function getLineServiceGroups(
  options: LineServiceClientOptions,
): Promise<LineServiceGroupsResult> {
  const result = await signedLineServicePost<Record<string, never>, LineServiceGroupsResponse>(
    options,
    LINE_INTERNAL_GROUPS_PATH,
    {},
  );
  if (!result.ok) return result;
  return { ok: true, groups: result.data, retryable: false };
}

export async function getLineServiceProfile(
  options: LineServiceClientOptions,
): Promise<LineServiceProfileResult> {
  const result = await signedLineServicePost<Record<string, never>, LineServiceProfileResponse>(
    options,
    LINE_INTERNAL_PROFILE_PATH,
    {},
  );
  if (!result.ok) return result;
  return { ok: true, profile: result.data, retryable: false };
}

export async function getLineServiceStorage(
  options: LineServiceClientOptions,
): Promise<LineServiceStorageResult> {
  const result = await signedLineServicePost<Record<string, never>, LineServiceStorageResponse>(
    options,
    LINE_INTERNAL_STORAGE_PATH,
    {},
  );
  if (!result.ok) return result;
  return { ok: true, storage: result.data, retryable: false };
}

export async function logoutLineService(
  options: LineServiceClientOptions,
  request: LineServiceLogoutRequest,
): Promise<LineServiceLogoutResult> {
  const result = await signedLineServicePost<LineServiceLogoutRequest, LineServiceLogoutResponse>(
    options,
    LINE_INTERNAL_LOGOUT_PATH,
    request,
  );
  if (!result.ok) return result;
  return { ok: true, logout: result.data, retryable: false };
}
