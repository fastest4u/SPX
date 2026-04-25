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

## Runtime Env
- `src/config/env.ts` manually loads root `.env` if present and does not override existing `process.env` values.
- Required API env vars are `API_URL`, `COOKIE`, `DEVICE_ID`, `APP_NAME`, and `REFERER`.
- DB env vars `DB_HOST`, `DB_USERNAME`, `DB_PASSWORD`, and `DB_NAME` are required when `SAVE_TO_DB=true` or `HTTP_ENABLED=true`; `DB_PORT` defaults to `3306`.
- `POLL_INTERVAL_MS` is milliseconds, but the CLI interval argument is seconds and overrides it.
- `FETCH_DETAILS=true`, `SAVE_TO_DB=true`, or `NOTIFY_ENABLED=true` makes the poller request `booking/bidding/request/list` for every returned booking.
- Notification env vars: `NOTIFY_ENABLED=true` activates notifications; requires `LINE_NOTIFY_TOKEN` and/or `DISCORD_WEBHOOK_URL`.
- Rule-based notifications: `notify-rules.json` at project root defines stateful search orders. Each rule has `origins`, `destinations`, `vehicle_types`, `need`, `enabled`, and `fulfilled`.
- When trips match, the rule is auto-fulfilled and Discord/LINE notification is sent.
- The system settings (`.env`) can be modified via the Web UI (`SettingsController`), which automatically overwrites the `.env` file and triggers an immediate `process.exit(0)` to restart the server (requires PM2/nodemon for auto-recovery).
- `HTTP_ENABLED=true` starts a Fastify server on `HTTP_PORT` (default 3000) exposing the MVC-based Web UI and API routes under `/api`; `HTTP_ALLOWED_ORIGINS` optionally allows comma-separated non-localhost CORS origins.

## Architecture Notes
- `src/app.ts` validates env, constructs `Poller`, then starts the polling loop.
- `src/controllers/poller.ts` owns polling, stats, list fetches, change detection, request-list detail printing, and optional DB saves.
- `src/services/api-client.ts` derives detail endpoints by replacing `/booking/bidding/list` in `API_URL`; update that logic if the list URL shape changes. All fetches use retry with exponential backoff (3 retries). Session expiry is detected from API retcodes.
- `src/services/db-service.ts` owns DB save semantics; uses INSERT IGNORE — records are written once when a job first appears and never updated.
- `src/services/notifier.ts` sends Discord rich embeds and LINE text messages when rules are fulfilled; uses `notify-rules.ts` for matching.
- `src/services/notify-rules.ts` is the stateful rule engine: loads/saves `notify-rules.json`, matches trips, auto-fulfills rules.
- `src/services/metrics.ts` collects polling metrics (latency percentiles, success rate, trip counts).
- `src/services/http-server.ts` handles the Fastify setup, CORS, rate limiting, RBAC, and registers modular MVC controllers (e.g. `auth-controller`, `settings-controller`, `rules-controller`, `dashboard-controller`).
- `Poller.stop()` is the graceful shutdown path; it stops the active tick and closes the MySQL pool.
- DB `request_id` values come from `booking/bidding/request/list`, not `booking_overview.vehicle_driver_info`.
- MySQL uses Drizzle with `mysql2`; keep `src/db/schema.ts`, `src/db/migration-sql.ts`, and `migrations/*.sql` in sync.
- `spx_booking_history` columns include `booking_id`, `booking_name`, `agency_name`, `acceptance_status`, `assignment_status` for booking context. Table stays InnoDB/`utf8mb4_0900_ai_ci`; `id` and `request_id` are `BIGINT UNSIGNED`, and `created_at` is `DATETIME` with `created_at_idx` for latest-row queries.
- `ensureSpxBookingHistoryTable()` also creates `spx_booking_history` at runtime, so schema changes may need both migration and runtime SQL updates.
- TypeScript uses `moduleResolution: "NodeNext"`; keep `.js` suffixes on local relative imports inside `.ts` files.

## Gotchas
- Do not read, print, commit, or copy secrets from `.env`.
- Treat root `poll-bidding.js` as a legacy standalone CommonJS script with hardcoded request headers; prefer the TypeScript app in `src/` for changes.
- `db:test` and `flow:test` are integration checks requiring real API auth, network access, and MySQL; they can insert into `spx_booking_history`.
- `data/` holds captured JSON output and is ignored; do not treat it as stable test fixtures.
