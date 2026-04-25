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

function normalizeMeta(meta: unknown): string {
  if (meta === undefined) return "";
  if (meta instanceof Error) {
    return JSON.stringify({ name: meta.name, message: meta.message, stack: meta.stack });
  }
  if (typeof meta === "string") return meta;
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (level < minLevel) return;
  const record = {
    ts: now(),
    level: LEVEL_NAMES[level],
    message,
    ...(meta === undefined ? {} : { meta }),
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
  logger.info("polling-started", { url, intervalSec, startedAt: now() });
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
