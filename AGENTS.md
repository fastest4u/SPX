# AGENTS.md

## Sources Of Truth
- Trust `package.json`, `tsconfig.json`, `src/`, and `docs/` over guesses; there is no CI workflow, lint config, formatter config, or unit-test script.
- Edit `src/`; `dist/`, `data/`, `logs/`, `node_modules/`, and `.env` are ignored/generated or local-only.
- This is a single npm package using `package-lock.json`, not a workspace.

## Commands
- `npm ci` installs locked dependencies.
- `npm run build` is the main local verification; it runs `tsc --noEmit`, then `esbuild` to bundle and minify `src/app.ts` into a single `dist/app.js` file, keeping dependencies external.
- `npm run dev -- 10` runs `src/app.ts` via `ts-node` with an optional polling interval in seconds.
- `npm start -- 10` runs `dist/app.js`; run `npm run build` first if `dist/` may be stale.
- `npm run db:generate` builds, then rewrites `migrations/001_create_booking_requests.sql` from `src/db/migration-sql.ts`.
- `npm run db:migrate` builds, then applies semicolon-delimited statements from `migrations/*.sql` to MySQL and records filenames in `schema_migrations`.
- `npm run db:test` builds, calls the live bidding API, fetches the first booking request list, saves one request row, and prints latest DB rows.
- `npm run flow:test` runs `db:migrate` then `db:test`; `npm run flow:start` migrates, builds, then starts `dist/app.js`.

## Git Workflow Preference
- User preference for this repository: push completed fixes directly to `main` only. Do not create feature branches or PRs unless the user explicitly asks for branch/PR review workflow.
- Production server has auto-deploy: push → main → server auto git-pulls, rebuilds Docker, and restarts.

## Runtime Env
- `src/config/env.ts` manually loads root `.env` if present and does not override existing `process.env` values.
- Required API env vars are `API_URL`, `COOKIE`, `DEVICE_ID`, `APP_NAME`, and `REFERER`.
- DB env vars `DB_HOST`, `DB_USERNAME`, `DB_PASSWORD`, and `DB_NAME` are required when `SAVE_TO_DB=true`, `HTTP_ENABLED=true`, or `AUTO_ACCEPT_ENABLED=true`; `DB_PORT` defaults to `3306`. `DB_MODE` defaults to `mysql` (use `memory` for SQLite in-memory testing).
- `POLL_INTERVAL_MS` is milliseconds, but the CLI interval argument is seconds and overrides it.
- `FETCH_DETAILS=true`, `SAVE_TO_DB=true`, or `NOTIFY_ENABLED=true` makes the poller request `booking/bidding/request/list` for every returned booking.
- Notification env vars: `NOTIFY_ENABLED=true` activates notifications; requires `LINE_NOTIFY_TOKEN` and/or `DISCORD_WEBHOOK_URL`. `NOTIFY_MODE` controls batch vs per-match notification (`batch` or `each`, default `batch`).
- `AUTO_ACCEPT_ENABLED=true` enables auto-accept: the poller will automatically accept bidding requests matching enabled rules with `auto_accept` flag; auto-accept events are recorded in `auto_accept_history` table.
- Rule-based notifications use a dual storage mode:
  - **DEV** (`NODE_ENV !== "production"`, or no DB flags): reads/writes `notify-rules.json` at project root.
  - **PROD** (`NODE_ENV === "production"` + DB flags): reads/writes `notify_rules` MySQL table; JSON file is used only for one-time migration on first startup.
- Each rule has: `id`, `name`, `origins`, `destinations`, `vehicle_types`, `need`, `enabled`, `fulfilled`, `auto_accept`, `auto_accepted`.
- When trips match, the rule is auto-fulfilled and Discord/LINE notification is sent. SSE broadcasts rules changes to connected Web UI clients in real-time.
- The system settings (`.env`) can be modified via the Web UI (`SettingsController`), which automatically overwrites the `.env` file and triggers an immediate `process.exit(0)` to restart the server (Docker auto-restarts via `restart: unless-stopped`).
- `HTTP_ENABLED=true` starts a Fastify server on `HTTP_PORT` (default 3000) exposing the MVC-based Web UI and API routes under `/api`; `HTTP_ALLOWED_ORIGINS` optionally allows comma-separated non-localhost CORS origins.

## Architecture Notes
- `src/app.ts` validates env, calls `migrateJsonToDb()` (when DB is active), constructs `Poller`, then starts the polling loop.
- `src/controllers/poller.ts` owns polling, stats, list fetches, change detection, request-list detail printing, optional DB saves, auto-accept flow, and SSE broadcasting.
- `src/services/api-client.ts` derives detail endpoints by replacing `/booking/bidding/list` in `API_URL`; update that logic if the list URL shape changes. All fetches use retry with exponential backoff (3 retries). Session expiry is detected from API retcodes. Automatically fetches multiple pages when `total > count` in API response.
- `src/services/db-service.ts` owns DB save semantics; uses INSERT IGNORE — records are written once when a job first appears and never updated.
- `src/services/notifier.ts` sends Discord rich embeds and LINE text messages for both rule match notifications and auto-accept results. Inserts auto-accept history records via `auto-accept-repository.ts`.
- `src/services/notify-rules.ts` is the dual-mode rule engine: uses MySQL `notify_rules` table in production, `notify-rules.json` file in development. All functions are async. Fixes `EBUSY` file-lock on Docker overlay by falling back to direct write.
- `src/services/metrics.ts` collects polling metrics (latency percentiles, success rate, trip counts, auto-accept counts).
- `src/services/sse.ts` singleton `sseBroadcaster` pushes real-time rules and metrics to Web UI clients via Server-Sent Events over `/events` (JWT-authenticated).
- `src/services/http-server.ts` handles the Fastify setup, CORS, rate limiting, RBAC, JWT auth (cookie-based), security headers, and registers modular MVC controllers. Includes `onClose` hook for clean DB pool shutdown.
- `Poller.stop()` is the graceful shutdown path; it stops the active tick, closes SSE connections, stops HTTP server, and closes the MySQL pool.
- DB `request_id` values come from `booking/bidding/request/list`, not `booking_overview.vehicle_driver_info`.
- MySQL uses Drizzle with `mysql2`; keep `src/db/schema.ts`, `src/db/migration-sql.ts`, `migrations/*.sql`, and runtime SQL in `src/db/client.ts` in sync. `src/db/client-memory.ts` mirrors schema for SQLite `DB_MODE=memory`.
- `spx_booking_history` columns include `booking_id`, `booking_name`, `agency_name`, `acceptance_status`, `assignment_status`, `route`, `origin`, `destination`, `vehicle_type`. Table stays InnoDB/`utf8mb4_0900_ai_ci`; `id` and `request_id` are `BIGINT UNSIGNED`, `created_at` is `DATETIME` with `created_at_idx`.
- `notify_rules` stores rules as DB rows; boolean fields (`enabled`, `fulfilled`, `auto_accept`, `auto_accepted`) use `INT(0/1)` for MySQL 5.7 compatibility; array fields (`origins`, `destinations`, `vehicle_types`) are JSON-stringified in `VARCHAR(4000)`.
- `auto_accept_history` records every auto-accept event with `rule_id`, `rule_name`, `booking_id`, `request_ids` (JSON array), `status` (`success`/`failed`), `origin`, `destination`, `vehicle_type`, and `created_at`.
- `ensureDashboardTables()` in `client.ts` also creates `notify_rules` and `auto_accept_history` at runtime, so schema changes may need both migration and runtime SQL updates.
- TypeScript uses `moduleResolution: "NodeNext"`; keep `.js` suffixes on local relative imports inside `.ts` files.

## Deployments (Production Server)
- Server: `root@45.83.207.139`
- Stack: Docker Compose (`/root/SPX/docker-compose.yml`)
- Auto-deploy via git push → main triggers server to pull, rebuild Docker, restart.
- Dockerfile creates empty `notify-rules.json` during build (`RUN echo '[]'`). Host file is mounted as volume for persistence.
- Container command runs `db-migrate.js` before `app.js` to apply new migrations.
- Health check: `GET /ready` every 30s → returns 200 if container is healthy.

## Gotchas
- Do not read, print, commit, or copy secrets from `.env`.
- Treat root `poll-bidding.js` as a legacy standalone CommonJS script with hardcoded request headers; prefer the TypeScript app in `src/` for changes.
- `db:test` and `flow:test` are integration checks requiring real API auth, network access, and MySQL; they can insert into `spx_booking_history`.
- `data/` holds captured JSON output and is ignored; do not treat it as stable test fixtures.
- MySQL 5.7: use `CURRENT_TIMESTAMP` (not `(UTC_TIMESTAMP())`) in DDL `DEFAULT` clauses. Application-level queries can use `UTC_TIMESTAMP()`.
- `notify-rules.json` is `.gitignore`d — the Dockerfile creates it at build time, and the volume mount persists it on the host.
