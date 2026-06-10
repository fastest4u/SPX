import { env } from "../config/env.js";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

let minLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function now(): string {
  return new Date().toISOString();
}

function serializeError(error: Error, depth = 0): Record<string, unknown> {
  return {
    // Enumerable own props first (mysql2 code/errno, AppError statusCode,
    // Node syscall info) — the fields below override any collisions.
    ...(error as unknown as Record<string, unknown>),
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined
      ? {}
      : {
          cause:
            error.cause instanceof Error
              ? depth < 2
                ? serializeError(error.cause, depth + 1)
                : error.cause.message
              : String(error.cause),
        }),
  };
}

// Error properties are non-enumerable, so JSON.stringify emits `{}` for any
// Error passed as meta (or nested one level inside a meta object) unless we
// expand it first.
function normalizeMeta(meta: unknown): unknown {
  if (meta instanceof Error) {
    return serializeError(meta);
  }
  if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
    const entries = Object.entries(meta as Record<string, unknown>);
    if (entries.some(([, value]) => value instanceof Error)) {
      return Object.fromEntries(
        entries.map(([key, value]) => [key, value instanceof Error ? serializeError(value) : value])
      );
    }
  }
  return meta;
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (level < minLevel) return;
  const record = {
    ts: now(),
    level: LEVEL_NAMES[level],
    message,
    ...(meta === undefined ? {} : { meta: normalizeMeta(meta) }),
  };
  const line = JSON.stringify(record);
  if (level >= LogLevel.ERROR) {
    console.error(line);
  } else if (level === LogLevel.WARN) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => log(LogLevel.DEBUG, message, meta),
  info: (message: string, meta?: unknown) => log(LogLevel.INFO, message, meta),
  warn: (message: string, meta?: unknown) => log(LogLevel.WARN, message, meta),
  error: (message: string | Error, meta?: unknown) => {
    if (message instanceof Error) {
      log(LogLevel.ERROR, message.message, message);
      return;
    }
    log(LogLevel.ERROR, message, meta);
  },
};

export function formatHeader(title: string, url: string, intervalSec: number): void {
  console.log(title);
  if (!env.HTTP_ENABLED) {
    logger.info("polling-started", { url, intervalSec, startedAt: now() });
  }
}

export function formatFooter(stats: { totalRequests: number; errorCount: number }): void {
  logger.info("polling-stopped", { ...stats, stoppedAt: now() });
}

export function formatRequestLine(reqNum: number): string {
  return JSON.stringify({ ts: now(), level: "INFO", message: "requesting", requestNumber: reqNum });
}

export function formatStatus(
  latency: number,
  status: "ok" | "changed" | "same" | "first" | "error",
  recordCount: number | null
): string {
  return JSON.stringify({ ts: now(), level: "INFO", message: "poll-status", latencyMs: latency, status, recordCount });
}
