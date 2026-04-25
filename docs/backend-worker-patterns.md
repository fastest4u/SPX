---
tags:
  - nodejs
  - backend
  - worker
  - spx
---

# SPX Backend Worker Patterns

## Architecture Fit
- This app is a Node.js polling worker, not a REST/GraphQL server; the built-in HTTP server is opt-in (`HTTP_ENABLED=true`) and only serves health/metrics.
- The useful backend pattern here is layered code: controller/orchestrator, services, repositories, config, and db.

## Layers
- `src/app.ts` is the process boundary: parse CLI args, validate env, start the worker.
- `src/controllers/poller.ts` orchestrates polling, signal handling, metrics recording, and when to call services.
- `src/services/api-client.ts` owns SPX HTTP calls, response-shape validation, retry with exponential backoff, and session expiry detection.
- `src/services/db-service.ts` owns save semantics; uses INSERT IGNORE for insert-once-never-update behavior.
- `src/services/notify-rules.ts` is the stateful rule engine: loads `notify-rules.json`, matches trips against rules, auto-fulfills and writes state back.
- `src/services/notifier.ts` sends Discord rich embeds and LINE text messages when rules are fulfilled.
- `src/services/metrics.ts` collects polling metrics (latency percentiles, success rate, trip counts) as a shared singleton.
- `src/services/http-server.ts` exposes Web UI, `/health`, `/metrics`, and `/api/rules` via Fastify.
- `src/repositories/booking-history-repository.ts` owns direct SQL insert calls with INSERT IGNORE.
- `src/db/client.ts` owns MySQL pool lifecycle and runtime table creation.

## Shutdown
- SIGINT/SIGTERM should call `Poller.stop()`.
- `Poller.stop()` waits for the active tick, prints the footer, stops the HTTP server, then calls `closePool()`.
- Scripts should use `closePool()` in `finally` instead of calling `getPool().end()` directly.

## Error Handling
- Expected duplicate request saves return `skipped` instead of throwing through the worker loop.
- Unexpected DB/API failures should be logged without exposing `.env` values or cookies.
- Keep external API validation in `ApiClient` so downstream layers only receive known response shapes.
- API calls use retry with exponential backoff (3 retries, base delay 1s with jitter).
- Session expiry is detected from API retcodes (401, 403, -1, 10001, 10002) and reported as errors.

## What Not To Add Yet
- No Express/Fastify middleware, CORS, Helmet, or auth — the built-in HTTP server is minimal and read-only.
- No DI container is needed while the dependency graph stays this small.
- No queue worker is needed unless polling starts producing work that outlives a single tick.
