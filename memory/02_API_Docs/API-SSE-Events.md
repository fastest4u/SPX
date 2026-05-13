---
title: API - SSE Events
type: reference
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:src/services/sse.ts + file:src/controllers/dashboard-controller.ts + file:src/frontend/hooks/useSse.ts + file:src/services/metrics.ts
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - SSE Events
  - Dashboard Events
  - Server-Sent Events
tags:
  - reference
  - project/spx
  - area/api
  - topic/sse
  - topic/realtime
---

# API - SSE Events

> [!abstract] Scope
> `/events` is the live dashboard stream. It sends metrics, rules, and session-expiry alerts from the backend to the React UI using Server-Sent Events.

---

## Endpoint

```text
GET /events
```

Source: `src/controllers/dashboard-controller.ts`

Authentication:

- The handler verifies JWT from signed cookie with `req.jwtVerify({ onlyCookie: true })`.
- Frontend opens `new EventSource("/events", { withCredentials: true })`.
- Unauthenticated clients receive `401`.

---

## Transport

Source: `src/services/sse.ts`

Response headers:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Connection behavior:

- Maximum clients: 50.
- If over capacity, the oldest connection is removed.
- Heartbeat comment is sent every 30 seconds.
- Dead clients are removed on write failure or close.
- `closeAll()` shuts down all clients during `Poller.stop()`.

---

## Event Envelope

Each event is encoded as:

```text
event: <event-name>
data: <JSON>
```

The broadcaster accepts:

```typescript
type SseEvent = {
  event: string;
  data: unknown;
};
```

---

## Event: `metrics`

Emitted by:

- Poller after each tick.
- Pause/resume handlers.

Payload source: `metrics.snapshot()` in `src/services/metrics.ts`.

High-level shape:

```json
{
  "isPaused": false,
  "uptime": 123,
  "startedAt": "2026-05-13T00:00:00.000Z",
  "polling": {
    "totalRequests": 1,
    "successCount": 1,
    "errorCount": 0,
    "successRate": 100,
    "latency": {
      "avg": 100,
      "min": 100,
      "max": 100,
      "p50": 100,
      "p95": 100,
      "p99": 100
    }
  },
  "data": {
    "totalRecordsSeen": 0,
    "changesDetected": 0,
    "tripsInserted": 0,
    "tripsSkipped": 0
  },
  "lastPoll": {
    "timestamp": "2026-05-13T00:00:00.000Z",
    "latencyMs": 100,
    "recordCount": 0,
    "status": "unchanged"
  },
  "database": null,
  "session": {
    "consecutiveErrors": 0,
    "lastSessionWarning": null,
    "isHealthy": true
  },
  "autoAccept": {
    "totalAttempts": 0,
    "successCount": 0,
    "failureCount": 0
  }
}
```

Frontend consumer: `src/frontend/hooks/useSse.ts`.

---

## Event: `rules`

Emitted by:

- Rule create/update/delete operations.
- Rule state/progress updates from notify/auto-accept flows.

Payload:

```json
[
  {
    "id": "rule-id",
    "name": "Rule name",
    "origins": ["A"],
    "destinations": ["B"],
    "vehicle_types": ["6W"],
    "need": 1,
    "enabled": true,
    "fulfilled": false,
    "auto_accept": true,
    "auto_accepted": false
  }
]
```

Frontend behavior:

- Dashboard calls `queryClient.setQueryData(["rules"], sseRules)` so rule cards update live.

---

## Event: `session-expired`

Emitted when upstream SPX API session expires.

Payload:

```json
{
  "message": "Session expired...",
  "timestamp": "2026-05-13T00:00:00.000Z"
}
```

Frontend behavior:

- Dashboard shows a toast prompting operator to update the SPX cookie in Settings.
- `metrics.lastPoll.status` can also be `session_expired`.

See [[Runbook-API-Session-Expired]].

---

## Reconnect Behavior

Frontend hook: `src/frontend/hooks/useSse.ts`

- Initial reconnect delay: 5 seconds.
- Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s.
- Max retries: 10.
- `reconnect()` resets retry count.

---

## Gotchas

- `/events` is not under `/api`, but still authenticates using the JWT cookie inside the handler.
- `EventSource` cannot send custom headers, so auth must stay cookie-based unless the transport changes.
- Event payload type drift can break the dashboard silently; update frontend types if `metrics.snapshot()` changes.
- SSE client count is process-local. Multiple replicas would each have their own client set.

---

## Related

- [[API-Internal-HTTP]]
- [[SPX-System-Map]]
- [[Component-Poller-Orchestration]]
- [[Runbook-API-Session-Expired]]
