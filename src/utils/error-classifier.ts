/** Structured error classification for polling and API errors */

export type ErrorCategory =
  | "session_expired"
  | "network"
  | "rate_limited"
  | "api_error"
  | "validation"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retcode?: number;
  retryAfterMs?: number;
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 * Tolerant of: numeric ms (already a number), a seconds-string ("120"),
 * or an HTTP-date string. Numeric values are treated as seconds. Returns
 * undefined when the value is absent or cannot be parsed into a non-negative
 * delay.
 */
function parseRetryAfterMs(retryAfter?: string | number): number | undefined {
  if (retryAfter === undefined || retryAfter === null) {
    return undefined;
  }
  if (typeof retryAfter === "number") {
    return Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
  }
  const trimmed = retryAfter.trim();
  if (trimmed === "") {
    return undefined;
  }
  // Numeric string → delta-seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  // Otherwise try an HTTP-date and compute the delay relative to now.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - Date.now());
}

export function classifyPollingError(
  httpStatus: number,
  error?: string,
  retcode?: number | null,
  retryAfter?: string | number
): ClassifiedError {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  // Session / Auth expiry
  if (retcode !== null && retcode !== undefined && [401, 403, -1, 10001, 10002].includes(retcode)) {
    return { category: "session_expired", message: error || "Session expired", retryable: false, httpStatus, retcode };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { category: "session_expired", message: error || "Unauthorized", retryable: false, httpStatus };
  }

  // Rate limiting
  if (httpStatus === 429) {
    return {
      category: "rate_limited",
      message: error || "Rate limited",
      retryable: true,
      httpStatus,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  // Network errors
  if (httpStatus === 0) {
    return { category: "network", message: error || "Network error", retryable: true, httpStatus: 0 };
  }
  if (httpStatus === 408 || httpStatus === 425) {
    return { category: "network", message: error || "Timeout", retryable: true, httpStatus };
  }

  // Server errors (retryable)
  if (httpStatus >= 500) {
    return { category: "api_error", message: error || `Server error (HTTP ${httpStatus})`, retryable: true, httpStatus };
  }

  // Client errors (not retryable). A generic 4xx (already excluding
  // 401/403/429 handled above) that also carries a non-zero api `retcode`
  // is an app-level failure — keep it as `api_error` and preserve the
  // retcode rather than flattening it to `validation`.
  if (httpStatus >= 400) {
    if (retcode !== null && retcode !== undefined && retcode !== 0) {
      return { category: "api_error", message: error || `API error (retcode=${retcode})`, retryable: false, httpStatus, retcode };
    }
    return { category: "validation", message: error || `Client error (HTTP ${httpStatus})`, retryable: false, httpStatus };
  }

  // API-level errors
  if (retcode !== null && retcode !== undefined && retcode !== 0) {
    return { category: "api_error", message: error || `API error (retcode=${retcode})`, retryable: false, httpStatus, retcode };
  }

  return { category: "unknown", message: error || "Unknown error", retryable: false, httpStatus };
}

/** Format a classified error for structured logging */
export function formatClassifiedError(err: ClassifiedError): Record<string, unknown> {
  return {
    errorCategory: err.category,
    errorMessage: err.message,
    retryable: err.retryable,
    ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    ...(err.retcode !== undefined ? { retcode: err.retcode } : {}),
    ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
  };
}
