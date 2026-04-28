export class AppError extends Error {
  public readonly isOperational: boolean;

  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly errorCode: string = "INTERNAL_ERROR",
    public readonly details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found", errorCode: string = "NOT_FOUND") {
    super(message, 404, errorCode);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "VALIDATION_ERROR", details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Not authenticated") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Insufficient permissions") {
    super(message, 403, "FORBIDDEN");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = "Too many requests", retryAfterMs?: number) {
    super(message, 429, "RATE_LIMITED", retryAfterMs ? { retryAfterMs } : undefined);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string = "Service unavailable") {
    super(message, 503, "SERVICE_UNAVAILABLE");
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError && error.isOperational === true;
}
