---
title: Runbook - Production Alert Policy
type: runbook
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:src/controllers/dashboard-controller.ts + file:src/services/metrics.ts + file:src/controllers/poller.ts + file:src/services/sse.ts
confidence: high
severity-when-applies: critical
related-adrs:
  - [[ADR-001-Dual-Storage-Notify-Rules]]
  - [[ADR-002-DB-Backed-Live-Settings]]
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Production Alert Policy
  - Alert Policy
  - Monitoring Policy
tags:
  - runbook
  - project/spx
  - area/deploy
  - area/ops
  - topic/production
  - topic/monitoring
---

# Runbook - Production Alert Policy

> [!abstract] Purpose
> Define what should alert operators for SPX production and which source signals prove the condition.

---

## Source Signals

| Signal | Source | Meaning |
|---|---|---|
| `GET /ready` | `src/controllers/dashboard-controller.ts` | Readiness check for DB connectivity plus current pool/session status payload. |
| `GET /health` | `src/controllers/dashboard-controller.ts` | Health check based on `metrics.snapshot()`; returns degraded when session health fails. |
| `GET /metrics` | `src/controllers/dashboard-controller.ts`, `src/services/metrics.ts` | Live polling, latency, DB pool, session, and auto-accept counters. |
| `GET /events` | `src/services/sse.ts`, [[API-SSE-Events]] | Dashboard SSE stream; emits `metrics`, `rules`, and `session-expired`. |
| Logs | `src/controllers/poller.ts`, repositories | Source for poll failures, DB save errors, metrics persistence failures, and auto-accept failures. |
| `auto_accept_history` | `src/repositories/auto-accept-repository.ts` | Durable record of auto-accept success/failed events. |

---

## Alert Rules

### `/ready` Fail

Severity: critical.

Trigger when:

- `GET /ready` returns non-200.
- Response has `ready=false`.
- Response `checks.database="error"`.

First response:

1. Open [[Runbook-Production-Deploy]].
2. Check container status and app logs.
3. Check DB reachability from the server.
4. If schema drift is suspected, run `npm run schema:verify`.

### `/health` Degraded

Severity: high.

Trigger when:

- `GET /health` returns 503.
- Response `status="degraded"`.
- Response `session.healthy=false` or `session.consecutiveErrors >= 5`.

First response:

1. Check whether upstream SPX API session expired.
2. Open [[Runbook-API-Session-Expired]].
3. Update the SPX cookie through Settings if required.

### Poll Error Rate High

Severity: warning to high.

Trigger when:

- `GET /metrics` has `polling.totalRequests >= 20` and `polling.successRate < 95` for 10 minutes.
- Critical if `polling.successRate < 80` or `session.consecutiveErrors >= 5`.

First response:

1. Check latest `poll-failed` logs.
2. Classify as upstream API, session, network, or DB side-effect issue.
3. If session-related, use [[Runbook-API-Session-Expired]].

### Session Expired

Severity: critical for operations.

Trigger when:

- SSE emits `session-expired`.
- Metrics has `session.lastSessionWarning` updated recently.
- Logs show `session-expiry-alert-sent`, `session-expiry-alert-not-sent`, or `session-expiry-alert-failed`.

Current implementation:

- The poller throttles session-expiry notification to once per 10 minutes.
- It broadcasts SSE `session-expired`.
- It calls `sendSessionExpiryNotification()`.

First response:

1. Replace the upstream SPX `COOKIE`.
2. Confirm `/health` returns healthy after the next successful poll.
3. Confirm notification channels did not all fail.

### Auto-Accept Failed

Severity: high when `AUTO_ACCEPT_ENABLED=true`.

Trigger when:

- `GET /metrics` shows `autoAccept.failureCount > 0`.
- New rows in `auto_accept_history` have `status="failed"`.
- Logs show `auto-accept-processing-failed` or `auto-accept-history-insert-failed`.

First response:

1. Open [[Runbook-Auto-Accept-Debug]].
2. Check upstream accept response and rule `NeedBudget`.
3. Confirm `request_id` values came from request-list rows.
4. Confirm failure notification channel was sent.

### DB Connection Fail

Severity: critical.

Trigger when:

- `/ready` has `checks.database="error"`.
- Logs show MySQL connection errors.
- Metrics DB pool stats show queued requests growing.
- `metrics-persist-failed` repeats.

First response:

1. Check DB host/container availability from production server.
2. Check connection pool saturation.
3. Run `npm run schema:verify` if the DB is reachable but writes fail.
4. Use [[Runbook-Production-Schema-Verification]] for drift.

### Poll Latency High

Severity: warning to high.

Trigger when:

- `GET /metrics` has `polling.latency.p95 > 10000` ms for 10 minutes.
- Critical if `polling.latency.p95 > 30000` ms or the poll interval cannot keep up.

First response:

1. Check upstream API latency.
2. Check `BOOKING_DETAIL_CONCURRENCY`.
3. Check DB save latency and notification side effects.
4. Consider pausing auto-accept if latency is paired with accept failures.

---

## Channel Policy

Use multiple channels where possible:

- External uptime monitor for `/ready`.
- Dashboard/SSE for live operator feedback.
- Discord or LINE for session expiry, auto-accept failures, and urgent operational messages.
- Server logs for forensic detail.

Do not put secrets in alert payloads. Alert messages should identify the failing subsystem, timestamp, and next runbook only.

---

## Verification Checklist

- [ ] `curl -fsS http://localhost:3000/ready` returns success on production.
- [ ] `curl -fsS http://localhost:3000/health` returns success when session is healthy.
- [ ] Dashboard receives `metrics` SSE updates.
- [ ] Session-expiry alert route is documented in [[Runbook-API-Session-Expired]].
- [ ] `npm run schema:verify` passes from a trusted environment.

---

## Related

- [[Runbook-Production-Deploy]]
- [[Runbook-Production-Schema-Verification]]
- [[Runbook-API-Session-Expired]]
- [[Runbook-Auto-Accept-Debug]]
- [[Runbook-Notify-Failure]]
- [[API-SSE-Events]]
