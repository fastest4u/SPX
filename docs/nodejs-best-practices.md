---
tags:
  - nodejs
  - best-practices
  - spx
---

# SPX Node.js Best Practices

## Runtime Boundaries
- Startup validates required API env vars, numeric env vars, URL syntax, and the expected bidding-list API path before polling starts.
- The CLI polling interval is seconds: `npm run dev -- 10`. `POLL_INTERVAL_MS` remains milliseconds.
- External API payloads are checked in `ApiClient` before they enter the polling and DB layers.
- Saved `request_id` values come from `booking/bidding/request/list`, not `booking_overview.vehicle_driver_info`.
- Do not copy `.env` values into docs, logs, commits, or examples.

## Async Polling
- `Poller` uses a one-shot `setTimeout` scheduled after each tick completes, not `setInterval`, so slow API/detail/DB work cannot overlap the next polling round.
- Keep detail fetching intentionally sequential unless rate limits and DB write behavior are known; `Promise.all` over every booking could amplify API load.
- Top-level startup errors are caught in `src/app.ts` and printed without a stack trace by default.
- `Poller.stop()` waits for the active tick, stops the HTTP server, then closes the MySQL pool, so SIGINT/SIGTERM does not interrupt an in-flight DB write.

## API Resilience
- All API calls use `fetchWithRetry()` with exponential backoff (3 retries, base delay 1s, jitter).
- Session expiry is detected from API retcodes (401, 403, -1, 10001, 10002) and reported as polling errors.
- The `setCookie()` method on `ApiClient` allows runtime cookie rotation without restarting the process.

## Backend Worker Layers
- This project is a polling worker with an optional lightweight HTTP server for health/metrics.
- `src/controllers/poller.ts` orchestrates the worker loop, metrics recording, and request flow.
- `src/services/` owns API integration, notifications, metrics, and business decisions such as duplicate handling.
- `src/repositories/` owns direct database writes and should stay free of polling/API logic.

## Notifications
- `notify-rules.json` at project root defines stateful search orders (rules). Each rule specifies `origins`, `destinations`, `vehicle_types`, `need` (truck count), `enabled`, and `fulfilled`.
- `notify-rules.ts` loads rules (re-reads file every 30s), matches ALL trips from the SPX API against active rules, and auto-fulfills rules when `need` is met.
- `notifier.ts` sends Discord rich embeds and LINE plain text when rules are fulfilled. Discord uses the webhook embed API for clean formatting.
- Notification failures are logged as warnings, never crash the polling loop.
- Users can add/remove/edit/reset rules by editing `notify-rules.json` — no restart needed.

## Observability
- `metrics.ts` tracks latency percentiles (p50/p95/p99), success rate, trip insert/skip counts.
- `http-server.ts` exposes the Web UI, `/health`, `/metrics`, and `/api/rules` using **Fastify**.

## Database Writes
- `saveBookingRequest()` uses INSERT IGNORE — records are written once when a job first appears and never updated.
- `ensureSpxBookingHistoryTable()` shares one initialization promise so concurrent saves do not duplicate startup DDL work.
- `closePool()` is the single MySQL shutdown path for scripts and the long-running poller.
- Keep `src/db/schema.ts`, `src/db/migration-sql.ts`, and `migrations/*.sql` aligned for schema changes.

## Verification
- Use `npm run build` as the default local check; it runs strict TypeScript and emits `dist/`.
- Use `npm run db:test` or `npm run flow:test` only when real API auth, network access, and MySQL are available. They can insert rows into `spx_booking_history`.

## Follow-Up Ideas
- Add focused unit tests for env parsing, API response guards, and duplicate-key handling if this project gets a test script.
- Add request timeouts with `AbortController` if the live API sometimes hangs longer than the polling interval.
