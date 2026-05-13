---
title: SPX System Map - Runtime, Data, UI, and Memory
type: reference
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:src/app.ts + file:src/controllers/poller.ts + file:src/services/http-server.ts + file:src/services/api-client.ts + file:src/services/notify-rules.ts + file:src/services/notifier.ts + file:src/db/schema.ts
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - SPX System Map
  - System Map
  - SPX Runtime Map
tags:
  - reference
  - project/spx
  - area/architecture
  - topic/system-map
---

# SPX System Map

> [!abstract] TL;DR
> SPX is a Node/TypeScript poller plus Fastify/React dashboard. `Poller` calls the upstream bidding API, enriches booking details, persists write-once history, evaluates notify/auto-accept rules, sends notifications, and streams live metrics/rule changes to the Web UI over SSE.

---

## When To Read

Read this before:

- Changing poller, API client, rules, notifications, settings, or database code.
- Debugging production behavior that crosses multiple modules.
- Updating Memory Vault notes about SPX.
- Onboarding a new AI agent into the codebase.

---

## Boot Sequence

Source: `src/app.ts`

1. Import `src/config/env.ts`, which manually loads root `.env` without overriding existing process env values.
2. Parse optional CLI poll interval in seconds; it overrides `POLL_INTERVAL_MS`.
3. If DB is usable, migrate selected env settings into `app_settings`, then load DB-backed settings into the runtime `env` object.
4. Validate runtime config.
5. If DB-backed features are active, migrate `notify-rules.json` into MySQL when DB has no rules.
6. If HTTP is enabled, create the configured admin user if missing.
7. Construct `Poller` and call `poller.start()`.
8. Register shutdown hooks that call `poller.stop()`.

---

## Runtime Flags

| Flag | Effect |
|---|---|
| `FETCH_DETAILS=true` | Fetch booking overview/request list for each booking. |
| `SAVE_TO_DB=true` | Save extracted request rows to `spx_booking_history`. |
| `NOTIFY_ENABLED=true` | Evaluate rules and send notification channels. |
| `AUTO_ACCEPT_ENABLED=true` | Accept matching request IDs for enabled auto-accept rules. |
| `HTTP_ENABLED=true` | Start Fastify server and React dashboard. |
| `DB_MODE=memory` | Use SQLite in-memory client for tests instead of MySQL pool. |

Detail fetching is active when any of `FETCH_DETAILS`, `SAVE_TO_DB`, `NOTIFY_ENABLED`, or `AUTO_ACCEPT_ENABLED` is true.

---

## Poller Lifecycle

Source: `src/controllers/poller.ts`

`Poller.start()`:

- Starts HTTP server when `HTTP_ENABLED=true`.
- Starts metrics persistence every 5 minutes when `SAVE_TO_DB=true`.
- Runs an immediate tick, then schedules recurring ticks by interval.
- Skips work while `pollerControl.isPaused` is true.

`Poller.tick()`:

1. Calls `apiClient.fetch()` for bidding list pages.
2. Classifies the result as success, changed, unchanged, session expired, or error.
3. Updates `metrics`.
4. Broadcasts metrics over `sseBroadcaster`.
5. Sends session-expiry alerts with throttle when upstream auth expires.
6. Schedules detail work when detail features are enabled.

`Poller.stop()`:

- Stops interval/timers.
- Waits for active tick and detail batches.
- Closes SSE clients.
- Stops HTTP server.
- Closes DB pool.

---

## Bidding API Flow

Source: `src/services/api-client.ts`

`API_URL` must contain `/booking/bidding/list`. Other endpoints are derived by path replacement:

| Operation | Endpoint shape |
|---|---|
| List bookings | `POST /booking/bidding/list` |
| Booking overview | `GET /booking/bidding/booking_overview?id=<bookingId>` |
| Request list | `POST /booking/bidding/request/list` |
| Accept requests | `POST /booking/bidding/accept` |

The client fetches additional pages when API response `total > count`. Retrying uses exponential backoff for transient HTTP/network failures; session retcodes are treated as operator action, not retryable work. See [[API-Bidding-Endpoints]] and [[Component-Retry-With-Backoff]].

---

## Detail, Save, Notify, Auto-Accept

Source: `src/controllers/poller.ts`, `src/services/db-service.ts`, `src/services/notifier.ts`

For each booking from the list:

1. Fetch request-list rows from `booking/bidding/request/list`.
2. Optionally fetch booking overview for enrichment.
3. Extract normalized trip info.
4. Save rows to DB when enabled.
5. Evaluate notify rules and auto-accept rules.
6. Send notification results to Discord, LINE OA, and/or LINEJS.

Important details:

- DB `request_id` comes from request-list rows, not overview `vehicle_driver_info`.
- Booking history is write-once by `request_id`.
- Auto-accept uses `NeedBudget` to keep each rule from over-accepting within the same tick.
- Accept calls are grouped by booking and use a reduced retry budget because the endpoint mutates upstream state.
- Auto-accept results are recorded in `auto_accept_history`.

---

## Rules Engine

Source: `src/services/notify-rules.ts`

Rule shape:

```text
id, name, origins, destinations, vehicle_types, need,
enabled, fulfilled, auto_accept, auto_accepted
```

Storage mode:

- Development or non-DB mode: `notify-rules.json`
- Production with DB flags: `notify_rules` MySQL table

The JSON file can be migrated into DB once when DB has no existing rules. Rule changes broadcast an SSE `rules` event so the dashboard stays live. See [[Component-Dual-Storage-Notify-Rules]] and [[ADR-001-Dual-Storage-Notify-Rules]].

---

## HTTP and Web UI

Source: `src/services/http-server.ts`, `src/frontend/`

Fastify serves:

- Public auth routes under `/api/login`, `/api/logout`, `/api/refresh`, `/api/me`.
- Public dashboard health routes: `/health`, `/ready`, `/metrics`, `/events`, `/line-quota`, `/system/pause`, `/system/resume`.
- Authenticated API scope under `/api/*`.
- Static React SPA from `dist/`, with catch-all routing for non-API paths.

Roles:

- `user`: rules, notifications, bidding accept, LINE Bot, history, reports.
- `admin`: all user routes plus users, settings, audit logs, auto-accept history.

Frontend:

- React 19 + TanStack Router/Query + Vite.
- `src/frontend/lib/api.ts` is the API client.
- `src/frontend/hooks/useSse.ts` consumes live metrics, rules, and session-expired events.
- Dashboard route `/` updates cached rules from SSE.

See [[API-Internal-HTTP]] and [[API-SSE-Events]].

---

## Database Model

Source: `src/db/schema.ts`, `src/db/client.ts`, `src/db/client-memory.ts`

| Table | Purpose |
|---|---|
| `spx_booking_history` | Write-once captured booking request rows. |
| `users` | Dashboard accounts and roles. |
| `audit_logs` | Dashboard actions. |
| `notify_rules` | DB-backed notify/auto-accept rules. |
| `auto_accept_history` | Every auto-accept attempt/result. |
| `metrics_snapshots` | Periodic poller metrics history. |
| `line_bot_sessions` | LINEJS auth token/session state. |
| `app_settings` | DB-backed live runtime settings. |
| `schema_migrations` | Applied SQL migration filenames. |

Schema definitions exist in multiple places and must stay aligned:

- `src/db/schema.ts`
- `src/db/migration-sql.ts`
- `migrations/*.sql`
- runtime table SQL in `src/db/client.ts`
- `src/db/client-memory.ts`

---

## Settings Model

Source: `src/controllers/settings-controller.ts`, `src/services/settings.ts`

Settings are DB-backed through `app_settings`.

- `readStoredSettings()` merges defaults, env, and DB settings depending on environment.
- `writeSettings()` upserts DB settings and updates runtime env.
- `reloadSettingsLive()` reloads DB settings into the mutable `env` object.
- Secret fields are redacted in controller responses and masked values are not written back.

This is recorded in [[ADR-002-DB-Backed-Live-Settings]].

---

## Notifications

Source: `src/services/notifier.ts`, `src/services/line-bot.ts`

Channels:

- Discord webhook rich embeds.
- LINE Official Account push messages.
- LINEJS QR-login client for user/group routing.

Notification paths:

- Rule matches can send batch or per-match messages.
- Auto-accept success/failure messages can use separate LINEJS targets.
- Session expiry alerts are throttled and also broadcast over SSE.
- LINE quota lookup is cached for 60 seconds.

---

## Operational Checks

Use:

- `npm run memory:check` after Memory Vault edits.
- `npm run memory:eval` after core Memory Vault topology or retrieval changes.
- `npm run build` after code or type changes.
- `npm run db:generate` after `src/db/migration-sql.ts` changes.
- `npm run db:migrate` only when you intend to touch a real MySQL target.

Runbooks:

- [[Runbook-API-Session-Expired]]
- [[Runbook-Auto-Accept-Debug]]
- [[Runbook-DB-Migration]]
- [[Runbook-Production-Schema-Verification]]
- [[Runbook-Multi-AI-Memory-Acceptance]]
- [[Runbook-Notify-Failure]]
- [[Runbook-Production-Deploy]]

---

## Open Gaps

- Internal API docs were added from source, but should be refreshed whenever controllers change.
- Frontend type definitions in `src/frontend/types/index.ts` should be checked when backend response shapes change.
- Existing production databases may have historical migrations already marked applied; runtime `ensure*` functions cover many tables but cannot alter every stale column automatically.

---

## Related

- [[Awakened-AI-System]]
- [[SPX-Project-Rules]]
- [[API-Internal-HTTP]]
- [[API-SSE-Events]]
- [[ADR-002-DB-Backed-Live-Settings]]
- [[Memory-Evaluation-Test]]
- [[Component-Poller-Orchestration]]
- [[Component-Dual-Storage-Notify-Rules]]
- [[Goals]]
