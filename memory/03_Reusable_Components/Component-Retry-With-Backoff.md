---
title: Component — Retry with Exponential Backoff (HTTP)
type: component
language: typescript
status: reusable
dependencies: []
last-verified: 2026-05-13
verified-by: cascade
source: file:src/services/api-client.ts
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - fetchWithRetry
  - retry backoff
  - api-client retry
tags:
  - component
  - project/spx
  - language/typescript
  - topic/http
  - topic/resilience
---

# Component — Retry with Exponential Backoff

## What It Does

Wraps `fetch()` with **3 retries** of exponentially increasing delay plus jitter, retrying only on:

- **Network errors** (any thrown exception from `fetch`)
- **Retryable HTTP statuses**: `408 Request Timeout`, `425 Too Early`, `429 Too Many Requests`, `5xx`

Non-retryable HTTP statuses (e.g. `400`, `401`, `404`) return immediately on the first attempt — backoff never masks an auth or schema bug.

## Where It Lives

- File: `src/services/api-client.ts`
- Function: `fetchWithRetry(url, options, label, retries = 3)`
- Helpers: `isRetryableStatus(status)`, `sleep(ms)`
- Constants: `MAX_RETRIES = 3`, `BASE_DELAY_MS = 1000`

```ts
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  label: string,
  retries = MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok && attempt < retries && isRetryableStatus(response.status)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn("retryable-response", { label, url, attempt: attempt + 1, status: response.status, delayMs: Math.round(delay) });
        await sleep(delay);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn("retryable-error", { label, url, attempt: attempt + 1, delayMs: Math.round(delay), error: lastError.message });
        await sleep(delay);
      }
    }
  }
  throw lastError ?? new Error(`Failed to fetch ${label}`);
}
```

## Backoff Schedule

| Attempt | Base delay (ms) | Max with jitter (ms) |
|---|---|---|
| 1st retry | 1000 | ~1500 |
| 2nd retry | 2000 | ~2500 |
| 3rd retry | 4000 | ~4500 |
| Total worst-case | ~8500 ms | ~8500 ms |

Formula: `delay = BASE_DELAY_MS * 2^attempt + random(0, 500)`.

## When To Use

Reach for `fetchWithRetry` when:

- Calling **any external HTTP API** that has transient failure modes (timeouts, rate limits, gateway hiccups)
- The endpoint is **idempotent or deliberately bounded on retry** — `GET` is safe; `POST` should only use this helper when duplicate behavior is understood or the retry count is explicitly reduced.
- You want **logged retry events** (the `label` parameter shows up in `[api-client] retryable-response` log lines)

Concrete usages already in the codebase:

| Caller | Endpoint | Retries | Why |
|---|---|---|---|
| `fetchBiddingListPage` | `POST /booking/bidding/list` | 3 | Polled loop — transient failures common |
| `fetchBookingOverview` | `GET /booking/bidding/booking_overview` | 3 | Detail enrichment — best-effort |
| `fetchBookingRequestListPage` | `POST /booking/bidding/request/list` | 3 | Same |
| `acceptBookingRequests` | `POST /booking/bidding/accept` | **1** (override) | One retry only — accept is state-changing and provider duplicate behavior is not assumed |

## When NOT To Use

- **Non-idempotent writes** that the server doesn't deduplicate (would create duplicate records).
- **Internal HTTP calls within the same Node process** — those have no real network failure; just call the function.
- **Auth-failing requests** (401 / 403) — these mean session/token issues. The retcode-expiry check in `ApiClient.fetch` is the right place; backoff only delays the inevitable. See [[Runbook-API-Session-Expired]].
- **Endpoints with strict rate budgets** where retries would compound usage. Use a queue/limiter instead.

## Retcode-Expiry Detection (Adjacent Pattern)

`fetchWithRetry` only checks **HTTP status**. The bidding API also returns `retcode` in JSON for app-level failures. The retcode-expiry guard lives in `ApiClient.fetch`:

```ts
const SESSION_EXPIRED_CODES = new Set([401, 403, -1, 10001, 10002]);
// ...
const retcode = getRetcode(data);
if (retcode !== null && SESSION_EXPIRED_CODES.has(retcode)) {
  return { success: false, error: `Session expired (retcode=${retcode}): ...` };
}
```

> [!important] Don't retry on session expiry
> If you add a new endpoint, propagate the same pattern — call `fetchWithRetry` once, then inspect retcode and bail with a clear "session expired" error. Don't put session retcodes into `isRetryableStatus`. The fix is "refresh cookie" (operator action), not "wait and try again".

## Example — New Endpoint

```ts
async fetchSomethingNew(): Promise<SomeShape | null> {
  try {
    const response = await fetchWithRetry(
      this.someUrl,
      { method: "GET", headers: this.headers },
      "something-new"
    );
    if (!response.ok) return null;
    const data: unknown = await response.json();
    // shape-check data
    return isSomeShape(data) ? data : null;
  } catch (err) {
    logger.warn("something-new-failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
```

## Tuning Parameters

| Constant | Value | When to change |
|---|---|---|
| `MAX_RETRIES` | 3 | Increase if upstream has high transient-failure rate; decrease for tight latency budgets |
| `BASE_DELAY_MS` | 1000 | Increase if hitting `429` rate limits; decrease for low-latency paths |
| Jitter range | `[0, 500)` ms | Increase if many parallel callers stampede on the same downstream |

> [!tip] Per-call retry override
> `acceptBookingRequests` passes `1` as the 4th arg. Use this for endpoints where you want a tighter or looser retry budget than the global default.

## Failure Modes

| Symptom | Likely Cause | Action |
|---|---|---|
| `[api-client] retryable-response status=429` repeating | Rate-limited | Lower `POLL_INTERVAL_MS` is **wrong** — instead reduce parallel page fetches or back off `MAX_RETRIES` |
| `[api-client] retryable-error error=...` flooding logs | Network instability | Check container DNS / outbound; if intermittent, consider raising `BASE_DELAY_MS` |
| Final throw `Failed to fetch <label>` | All retries exhausted | Logs show the per-attempt delays — confirm we actually waited; check upstream incident |

## Related

- [[Runbook-API-Session-Expired]] — when retries can't help (cookie expired)
- [[Runbook-Auto-Accept-Debug]] — debugging accept-call failures
- [[02_API_Docs/API-Bidding-Endpoints|API — Bidding Endpoints]] — full endpoint shape reference
- [[AGENT-IDENTITY]] § Standing Beliefs — "Retries cannot fix auth bugs"
- Code: `src/services/api-client.ts`, `src/utils/logger.ts`
