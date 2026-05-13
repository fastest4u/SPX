---
title: Component - Poller Orchestration
type: component
language: typescript
status: reusable
dependencies: []
last-verified: 2026-05-13
verified-by: codex
source: file:src/controllers/poller.ts
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Poller Tick
  - Poller Lifecycle
  - Graceful Poller
tags:
  - component
  - project/spx
  - language/typescript
  - area/api
  - topic/polling
  - topic/auto-accept
---

# Component - Poller Orchestration

> [!abstract] Purpose
> The `Poller` class coordinates periodic SPX API polling, detail fetching, DB writes, notifications, auto-accept, metrics, SSE, HTTP lifecycle, and graceful shutdown.

---

## When To Use

Reach for this pattern when:

- Adding a new per-poll workflow that depends on bidding list results.
- Debugging auto-accept, notification, session-expiry, or detail-fetch behavior.
- Changing shutdown semantics.
- Adding metrics or dashboard live updates.

Do not bypass `Poller` for background tasks that depend on poller state; wire them into the lifecycle so pause/resume and stop behavior remain coherent.

---

## Key Responsibilities

Source: `src/controllers/poller.ts`

| Responsibility | Mechanism |
|---|---|
| Schedule work | Immediate tick plus `setInterval`. |
| Pause/resume | Reads `pollerControl.isPaused`. |
| Fetch list | Calls `ApiClient.fetch()`. |
| Detect change | Compares current response to last serialized payload. |
| Detail jobs | Fetches request list and optional overview per booking. |
| Concurrency | Bounded `mapWithConcurrency` using `BOOKING_DETAIL_CONCURRENCY`. |
| Persistence | Calls `saveBookingRequest()` when `SAVE_TO_DB=true`. |
| Notify | Calls notifier rule matching when enabled. |
| Auto-accept | Uses rule matching and `NeedBudget` before accept calls. |
| Metrics | Records latency, status, data counts, auto-accept results. |
| SSE | Broadcasts metrics, rules, and session-expired events. |
| Shutdown | Waits active tick/detail jobs, closes SSE, HTTP, DB pool. |

---

## Lifecycle

```text
start()
  -> start HTTP server if enabled
  -> start metrics persistence if enabled
  -> tick immediately
  -> set recurring interval

tick()
  -> fetch list
  -> classify success/error/session
  -> update metrics and SSE
  -> schedule detail processing if needed

stop()
  -> clear interval and metrics timer
  -> wait active work
  -> close SSE, HTTP, DB
```

---

## Detail Pipeline

Detail processing is active when any of these features are enabled:

- `FETCH_DETAILS`
- `SAVE_TO_DB`
- `NOTIFY_ENABLED`
- `AUTO_ACCEPT_ENABLED`

The poller:

1. Extracts booking IDs from list response.
2. Fetches request-list rows per booking.
3. Optionally fetches overview for enriched fields.
4. Extracts normalized trip info.
5. Saves to DB if enabled.
6. Applies auto-accept before normal notifications when needed.
7. Sends remaining notifications.

Auto-accept can use a fast/deferred split so likely matching origins are processed earlier.

---

## Auto-Accept Guardrails

Source: `src/services/notifier.ts` and `src/controllers/poller.ts`

- Only enabled rules with `auto_accept=true` are candidates.
- Auto-accept works on upstream `request_id` values from `booking/bidding/request/list`.
- `NeedBudget` tracks how many requests each rule can still accept during the current poll cycle.
- Requests already accepted in memory are deduped by request key.
- Accept calls are grouped by booking ID.
- Results are recorded in `auto_accept_history`.
- Success/failure notifications are sent through configured channels.

---

## Failure Semantics

| Failure | Behavior |
|---|---|
| Upstream session expired | Mark poll status `session_expired`, throttle alert, broadcast SSE, do not retry forever. |
| List fetch transient error | Retry in `ApiClient`, then record error metrics if exhausted. |
| Detail fetch failure | Log/warn and continue other bookings. |
| DB save failure | Return save result with action `error`; poller continues. |
| Auto-accept failure | Record failed auto-accept history and notify failure channel. |

---

## Extension Rules

- Keep new per-booking work inside the bounded detail concurrency path.
- Do not add unbounded `Promise.all` over booking lists.
- Update `metrics` and SSE payload docs if adding user-visible state.
- If a new DB table is needed, update schema, migration SQL, runtime SQL, memory DB, and runbooks together.
- Add session-expiry handling for new upstream API calls.

---

## Related

- [[SPX-System-Map]]
- [[API-Bidding-Endpoints]]
- [[API-SSE-Events]]
- [[Component-Retry-With-Backoff]]
- [[Component-Dual-Storage-Notify-Rules]]
- [[Runbook-Auto-Accept-Debug]]
