---
title: API — Bidding Provider Endpoints (List / Overview / Request List / Accept)
type: reference
status: active
last-verified: 2026-05-13
verified-by: cascade
source: file:src/services/api-client.ts
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Bidding API
  - Bidding Endpoints
  - SPX External API
tags:
  - reference
  - project/spx
  - area/api
  - topic/bidding
---

# API — Bidding Provider Endpoints

> [!abstract] Scope
> Reference for the **4 bidding provider endpoints** the SPX poller calls. URLs are derived from `env.API_URL` by string-replacing the path. Auth = cookie + device-id headers. Retry semantics = [[Component-Retry-With-Backoff]] (3 retries, exponential backoff, except `accept` which uses 1).

> [!warning] Treat as upstream-controlled
> These are the **bidding provider's** endpoints, not ours. They can change shape, retcodes, or rate behavior at any time. Verify against `src/services/api-client.ts` whenever something looks off.

---

## URL Derivation

All URLs derive from a single env var:

```
API_URL = .../booking/bidding/list                                   ← list (the canonical one)
overviewBaseUrl   = .../booking/bidding/booking_overview            ← detail
requestListUrl    = .../booking/bidding/request/list                ← per-booking request list
acceptUrl         = .../booking/bidding/accept                      ← submit acceptance
```

If the upstream restructures URL paths, update the `replace(...)` calls in `ApiClient`'s getters (`overviewBaseUrl`, `requestListUrl`, `acceptUrl`).

---

## Common Headers (`buildHeaders` in `api-client.ts`)

| Header | Value | Source |
|---|---|---|
| `cookie` | `env.COOKIE` | `.env` (refresh via [[Runbook-API-Session-Expired]]) |
| `device-id` | `env.DEVICE_ID` | `.env` |
| `app` | `env.APP_NAME` | `.env` |
| `Referer` | `env.REFERER` | `.env` |
| `content-type` | `application/json;charset=UTF-8` | constant |
| `accept` / `accept-language` / `priority` / `sec-ch-*` | constants mimicking Chrome 147 | constant |

> [!important] Never commit / log full cookie
> The cookie header is ~1.8 KB and contains the session token. See [[AGENT-IDENTITY]] § Limits — secrets are forbidden in logs and in chat.

---

## Endpoint 1 — List Pending Bidding Requests

**`POST /booking/bidding/list`** (= `env.API_URL`)

Fetches a paginated list of bookings the account is eligible to bid on.

### Request body

```json
{
  "pageno": 1,
  "count": 20,
  "request_tab_pending_confirmation": true,
  "request_ctime_start": 1715000000
}
```

Defaults from `env.BIDDING_PAGE_NO`, `env.BIDDING_PAGE_COUNT`, `env.REQUEST_TAB_PENDING_CONFIRMATION`, `env.REQUEST_CTIME_START`.

### Response shape (success)

```json
{
  "retcode": 0,
  "message": "ok",
  "data": {
    "pageno": 1,
    "count": 20,
    "total": 47,
    "list": [ /* booking summary objects */ ]
  }
}
```

### Pagination

If `total > count`, `ApiClient.fetchRemainingBiddingListPages` issues parallel `POST` calls for pages `pageno+1..ceil(total/pageSize)` and concatenates `list[]`.

### Caller

`ApiClient.fetch(requestNumber)` — the canonical entry point invoked by `Poller` each tick.

---

## Endpoint 2 — Booking Overview (Detail)

**`GET /booking/bidding/booking_overview?id=<bookingId>`**

Fetches a single booking's full detail, including `vehicle_driver_info` array.

### Response shape

```json
{
  "retcode": 0,
  "message": "ok",
  "data": {
    "id": 12345,
    "vehicle_driver_info": [ /* per-driver entries */ ],
    /* other booking fields */
  }
}
```

### Caller

`ApiClient.fetchBookingOverview(bookingId)` — invoked best-effort when `FETCH_DETAILS=true` for enrichment. Returns `null` on shape mismatch or HTTP failure (no throw).

> [!note] Not the source of `request_id`
> Despite the name, this endpoint's `vehicle_driver_info` is **NOT** where `request_id` for DB writes comes from. Use **Endpoint 3 (request list)** for that — see SPX root `AGENTS.md` § Architecture Notes.

---

## Endpoint 3 — Booking Request List (per booking)

**`POST /booking/bidding/request/list`**

Returns the bidding **request_list** for a specific booking — these are the actual request rows that get persisted to `spx_booking_history` (column `request_id`).

### Request body

```json
{
  "request_tab_pending_confirmation": true,
  "booking_id": 12345,
  "pageno": 1,
  "count": 20
}
```

### Response shape

```json
{
  "retcode": 0,
  "message": "ok",
  "data": {
    "pageno": 1,
    "count": 20,
    "total": 5,
    "request_list": [
      { "request_id": 67890, /* ...  */ }
    ]
  }
}
```

### Pagination

Same as Endpoint 1 — `fetchBookingRequestList` fetches page 1 then page 2..N in parallel via `Promise.all`.

### Caller

- `ApiClient.fetchBookingRequestList(bookingId)`
- Triggered when any of `FETCH_DETAILS`, `SAVE_TO_DB`, `NOTIFY_ENABLED` is true (per root `AGENTS.md`).

---

## Endpoint 4 — Accept Booking Requests

**`POST /booking/bidding/accept`**

Submits acceptance for one or more `request_id` rows under a booking. Used by **auto-accept** when a rule matches.

### Request body

```json
{
  "booking_id": 12345,
  "accept_all": false,
  "request_id_list": [67890, 67891]
}
```

### Response shape (success)

```json
{
  "retcode": 0,
  "message": "ok",
  "data": { /* upstream-defined */ }
}
```

### Retry override

> [!warning] This endpoint uses **1 retry**, not 3
> `acceptBookingRequests` passes `1` as the retries override to `fetchWithRetry`. Reason: accept is a state-changing provider call, so the code deliberately avoids three repeated submissions. Duplicate/conflict behavior is provider-specific; handle non-OK HTTP status and non-zero `retcode` as returned by upstream rather than assuming a fixed duplicate status. See [[Component-Retry-With-Backoff]] § "When NOT To Use".

### Caller

`Poller` — invoked when an enabled rule matches a booking and `auto_accept = true`. Result rows go into `auto_accept_history`.

---

## Retcode Reference

> [!important] Session-expiry retcodes (do not retry)
> `SESSION_EXPIRED_CODES = { 401, 403, -1, 10001, 10002 }`. When any of these appear in the JSON `retcode`, callers should bail with a "Session expired" error. The fix is operator-side ([[Runbook-API-Session-Expired]]), not retry.

| Retcode | Meaning | Caller behavior |
|---|---|---|
| `0` | Success | Continue |
| `401` / `403` | Session expired | Bail; surface to log + (eventually) notify |
| `-1` | Generic upstream failure (often session) | Bail |
| `10001` / `10002` | Provider-specific session expiry | Bail |
| Any other non-zero | App-level failure | Bail with `message` field; do not retry |

HTTP-level retryable statuses are separate: `408`, `425`, `429`, `5xx` go through backoff. See [[Component-Retry-With-Backoff]].

---

## Cookie Override (Hot-Refresh Path)

`ApiClient.setCookie(cookie: string)` lets the Web UI Settings flow swap the cookie at runtime without restarting (currently unused — `process.exit(0)` triggers a Docker restart instead, see root `AGENTS.md` § "Runtime Env"). If the auto-restart approach is ever replaced, this is the hook.

---

## Failure Modes & Diagnostics

| Symptom | Likely Cause | Where to look |
|---|---|---|
| `Session expired (retcode=401)` looping | Cookie expired | [[Runbook-API-Session-Expired]] |
| `Unexpected bidding list response shape` | Upstream changed JSON | Inspect `normalizeApiResponse` — adapt or rev the schema |
| `bidding-list-page-failed` for page > 1 | Pagination edge case | Check `pageSize` math in `fetchRemainingBiddingListPages` |
| `Accept failed with retcode <N>` | Provider-specific business rule | Check `message`; log & continue |

---

## Related

- [[Component-Retry-With-Backoff]]
- [[Runbook-API-Session-Expired]]
- [[Runbook-Auto-Accept-Debug]]
- [[ADR-001-Dual-Storage-Notify-Rules]] — what we do with the matched bookings
- [[Mistake-001-Wrong-Env-Var-Name-GitHub-MCP]] — unrelated but a reminder that env-var naming bites
- Code: `src/services/api-client.ts`, `src/models/types.ts`, `src/config/env.ts`
