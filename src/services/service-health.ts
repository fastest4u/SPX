import type { RuntimeRole, HttpSurface } from "./runtime-role.js";
import type { LineBotStatus } from "./line-bot.js";

export type ServiceHealthState = "ok" | "degraded" | "down";

export interface ServiceHealthSnapshot {
  service: string;
  role: RuntimeRole;
  nodeId: string;
  state: ServiceHealthState;
  checkedAt: string;
  details: Record<string, unknown>;
}

export interface ServiceReadinessResult {
  statusCode: 200 | 503;
  data: {
    ready: boolean;
    service: HttpSurface;
    state: ServiceHealthState;
    checkedAt: string;
    details: Record<string, unknown>;
    dependencies: ServiceHealthSnapshot[];
  };
}

export interface BuildServiceReadinessInput {
  surface: HttpSurface;
  role: RuntimeRole;
  nodeId: string;
  lineServiceUrl?: string;
  lineServiceRequestTimeoutMs?: number;
  ocrServiceUrl?: string;
  ocrServiceRequestTimeoutMs?: number;
  codexImageProvider?: string;
  codexImageModel?: string;
  codexImageTimeoutMs?: number;
  codexImageMaxBytes?: number;
  lineStatus?: LineBotStatus;
  lineImageListenerActive?: boolean;
  databaseReady?: boolean;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

const REDACTED_VALUE = "[redacted]";
const SENSITIVE_DETAIL_KEY = /(secret|token|password|cookie|authorization|credential|pincode)/i;
const SENSITIVE_TEXT_FRAGMENT =
  /\b(secret|token|password|cookie|authorization|credential|pincode)=\S+/gi;

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

export function redactServiceHealthDetails(value: unknown, key = ""): unknown {
  if (SENSITIVE_DETAIL_KEY.test(key)) return REDACTED_VALUE;
  if (typeof value === "string") {
    return value.replace(SENSITIVE_TEXT_FRAGMENT, "$1=[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactServiceHealthDetails(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactServiceHealthDetails(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function createServiceHealthSnapshot(input: {
  service: string;
  role: RuntimeRole;
  nodeId: string;
  state: ServiceHealthState;
  details?: Record<string, unknown>;
  checkedAt?: string;
}): ServiceHealthSnapshot {
  return {
    service: input.service,
    role: input.role,
    nodeId: input.nodeId,
    state: input.state,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    details: redactServiceHealthDetails(input.details ?? {}) as Record<string, unknown>,
  };
}

export function buildLineServiceHealthSnapshot(input: {
  role: RuntimeRole;
  nodeId: string;
  status: LineBotStatus;
  listenerActive: boolean;
  checkedAt?: string;
}): ServiceHealthSnapshot {
  const state: ServiceHealthState =
    input.status.enabled && input.status.authenticated ? "ok" : "degraded";
  return createServiceHealthSnapshot({
    service: "line-service",
    role: input.role,
    nodeId: input.nodeId,
    state,
    checkedAt: input.checkedAt,
    details: {
      enabled: input.status.enabled,
      authenticated: input.status.authenticated,
      listenerActive: input.listenerActive,
      qrRequired: Boolean(input.status.qrUrl || input.status.pincode),
      message: input.status.message,
    },
  });
}

export function buildOcrServiceHealthSnapshot(input: {
  role: RuntimeRole;
  nodeId: string;
  provider: string;
  model?: string;
  timeoutMs: number;
  maxBytes: number;
  checkedAt?: string;
}): ServiceHealthSnapshot {
  const providerOk =
    input.provider === "auto" ||
    input.provider === "codex-cli" ||
    input.provider === "codex-device";
  const numericOk =
    Number.isInteger(input.timeoutMs) &&
    input.timeoutMs > 0 &&
    Number.isInteger(input.maxBytes) &&
    input.maxBytes > 0;
  return createServiceHealthSnapshot({
    service: "ocr-service",
    role: input.role,
    nodeId: input.nodeId,
    state: providerOk && numericOk ? "ok" : "degraded",
    checkedAt: input.checkedAt,
    details: {
      provider: input.provider,
      modelConfigured: Boolean(input.model?.trim()),
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
    },
  });
}

export async function probeHttpServiceHealth(input: {
  service: string;
  role: RuntimeRole;
  nodeId: string;
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  checkedAt?: string;
}): Promise<ServiceHealthSnapshot> {
  const trimmedBaseUrl = input.baseUrl.trim();
  if (!trimmedBaseUrl) {
    return createServiceHealthSnapshot({
      service: input.service,
      role: input.role,
      nodeId: input.nodeId,
      state: "down",
      checkedAt: input.checkedAt,
      details: { configured: false },
    });
  }

  let url: URL;
  try {
    url = new URL("/health", trimmedBaseUrl);
  } catch (error) {
    return createServiceHealthSnapshot({
      service: input.service,
      role: input.role,
      nodeId: input.nodeId,
      state: "down",
      checkedAt: input.checkedAt,
      details: { configured: true, error: errorMessage(error) },
    });
  }

  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      signal: timeoutSignal(input.timeoutMs),
    });
    return createServiceHealthSnapshot({
      service: input.service,
      role: input.role,
      nodeId: input.nodeId,
      state: response.ok ? "ok" : "down",
      checkedAt: input.checkedAt,
      details: {
        configured: true,
        endpoint: `${url.origin}${url.pathname}`,
        status: response.status,
      },
    });
  } catch (error) {
    return createServiceHealthSnapshot({
      service: input.service,
      role: input.role,
      nodeId: input.nodeId,
      state: "down",
      checkedAt: input.checkedAt,
      details: {
        configured: true,
        endpoint: `${url.origin}${url.pathname}`,
        error: errorMessage(error),
      },
    });
  }
}

export async function collectConfiguredDownstreamHealth(input: {
  role: RuntimeRole;
  nodeId: string;
  lineServiceUrl?: string;
  lineServiceRequestTimeoutMs?: number;
  ocrServiceUrl?: string;
  ocrServiceRequestTimeoutMs?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  checkedAt?: string;
}): Promise<ServiceHealthSnapshot[]> {
  const checks: Array<Promise<ServiceHealthSnapshot>> = [];
  if (input.lineServiceUrl?.trim()) {
    checks.push(
      probeHttpServiceHealth({
        service: "line-service",
        role: "line-service",
        nodeId: "line-service",
        baseUrl: input.lineServiceUrl,
        timeoutMs: input.lineServiceRequestTimeoutMs,
        fetchImpl: input.fetchImpl,
        checkedAt: input.checkedAt,
      }),
    );
  }
  if (input.ocrServiceUrl?.trim()) {
    checks.push(
      probeHttpServiceHealth({
        service: "ocr-service",
        role: "ocr-service",
        nodeId: "ocr-service",
        baseUrl: input.ocrServiceUrl,
        timeoutMs: input.ocrServiceRequestTimeoutMs,
        fetchImpl: input.fetchImpl,
        checkedAt: input.checkedAt,
      }),
    );
  }
  return Promise.all(checks);
}

function strongestState(states: ServiceHealthState[]): ServiceHealthState {
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  return "ok";
}

export async function buildServiceReadiness(
  input: BuildServiceReadinessInput,
): Promise<ServiceReadinessResult> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const dependencies: ServiceHealthSnapshot[] = [];
  let state: ServiceHealthState = "ok";
  let ready = true;
  const details: Record<string, unknown> = {};

  if (input.surface === "web-api") {
    const databaseReady = input.databaseReady ?? true;
    details.database = databaseReady ? "ok" : "down";
    dependencies.push(
      ...(await collectConfiguredDownstreamHealth({
        role: input.role,
        nodeId: input.nodeId,
        lineServiceUrl: input.lineServiceUrl,
        lineServiceRequestTimeoutMs: input.lineServiceRequestTimeoutMs,
        ocrServiceUrl: input.ocrServiceUrl,
        ocrServiceRequestTimeoutMs: input.ocrServiceRequestTimeoutMs,
        fetchImpl: input.fetchImpl,
        checkedAt,
      })),
    );
    ready = databaseReady;
    state = databaseReady ? "ok" : "down";
  } else if (input.surface === "notification-service") {
    const lineDependency = await probeHttpServiceHealth({
      service: "line-service",
      role: "line-service",
      nodeId: "line-service",
      baseUrl: input.lineServiceUrl ?? "",
      timeoutMs: input.lineServiceRequestTimeoutMs,
      fetchImpl: input.fetchImpl,
      checkedAt,
    });
    dependencies.push(lineDependency);
    ready = lineDependency.state === "ok";
    state = ready ? "ok" : "down";
  } else if (input.surface === "line-service") {
    const lineStatus = input.lineStatus ?? {
      enabled: false,
      authenticated: false,
      message: "LINE Bot status unavailable",
    };
    const line = buildLineServiceHealthSnapshot({
      role: input.role,
      nodeId: input.nodeId,
      status: lineStatus,
      listenerActive: input.lineImageListenerActive ?? false,
      checkedAt,
    });
    dependencies.push(line);
    dependencies.push(
      ...(await collectConfiguredDownstreamHealth({
        role: input.role,
        nodeId: input.nodeId,
        ocrServiceUrl: input.ocrServiceUrl,
        ocrServiceRequestTimeoutMs: input.ocrServiceRequestTimeoutMs,
        fetchImpl: input.fetchImpl,
        checkedAt,
      })),
    );
    const coreState = line.state;
    ready = coreState === "ok";
    state = strongestState([coreState, ...dependencies.slice(1).map((item) => item.state)]);
  } else {
    const ocr = buildOcrServiceHealthSnapshot({
      role: input.role,
      nodeId: input.nodeId,
      provider: input.codexImageProvider ?? "auto",
      model: input.codexImageModel,
      timeoutMs: input.codexImageTimeoutMs ?? 0,
      maxBytes: input.codexImageMaxBytes ?? 0,
      checkedAt,
    });
    dependencies.push(ocr);
    ready = ocr.state === "ok";
    state = ocr.state;
  }

  return {
    statusCode: ready ? 200 : 503,
    data: {
      ready,
      service: input.surface,
      state,
      checkedAt,
      details: redactServiceHealthDetails(details) as Record<string, unknown>,
      dependencies,
    },
  };
}
