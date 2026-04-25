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
}

export function classifyPollingError(
  httpStatus: number,
  error?: string,
  retcode?: number | null
): ClassifiedError {
  // Session / Auth expiry
  if (retcode !== null && retcode !== undefined && [401, 403, -1, 10001, 10002].includes(retcode)) {
    return { category: "session_expired", message: error || "Session expired", retryable: false, httpStatus, retcode };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { category: "session_expired", message: error || "Unauthorized", retryable: false, httpStatus };
  }

  // Rate limiting
  if (httpStatus === 429) {
    return { category: "rate_limited", message: error || "Rate limited", retryable: true, httpStatus };
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

  // Client errors (not retryable)
  if (httpStatus >= 400) {
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
  };
}
