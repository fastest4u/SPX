import assert from "node:assert/strict";
import { classifyPollingError, formatClassifiedError } from "../src/utils/error-classifier.js";

// Session/auth expiry by retcode wins over HTTP status.
{
  const c = classifyPollingError(200, "boom", 10001);
  assert.equal(c.category, "session_expired");
  assert.equal(c.retryable, false);
  assert.equal(c.retcode, 10001);
}

// Session expiry by HTTP status.
for (const status of [401, 403]) {
  const c = classifyPollingError(status, undefined);
  assert.equal(c.category, "session_expired");
  assert.equal(c.retryable, false);
}

// Rate limiting is retryable.
{
  const c = classifyPollingError(429);
  assert.equal(c.category, "rate_limited");
  assert.equal(c.retryable, true);
}

// Network: httpStatus 0 and timeout codes are retryable network errors.
for (const status of [0, 408, 425]) {
  const c = classifyPollingError(status);
  assert.equal(c.category, "network");
  assert.equal(c.retryable, true);
}

// 5xx server errors are retryable api_error.
{
  const c = classifyPollingError(503);
  assert.equal(c.category, "api_error");
  assert.equal(c.retryable, true);
}

// Other 4xx are non-retryable validation errors.
{
  const c = classifyPollingError(422);
  assert.equal(c.category, "validation");
  assert.equal(c.retryable, false);
}

// Non-zero retcode with 200 status is a non-retryable api_error.
{
  const c = classifyPollingError(200, undefined, 5);
  assert.equal(c.category, "api_error");
  assert.equal(c.retryable, false);
}

// Clean success-ish input falls through to unknown.
{
  const c = classifyPollingError(200, undefined, 0);
  assert.equal(c.category, "unknown");
}

// formatClassifiedError omits undefined optionals.
{
  const formatted = formatClassifiedError(classifyPollingError(429, "slow down"));
  assert.equal(formatted.errorCategory, "rate_limited");
  assert.equal(formatted.httpStatus, 429);
  assert.equal("retcode" in formatted, false);
}

console.log("error-classifier: all assertions passed");
