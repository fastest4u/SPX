# AGENTS.md

## Memory Vault
- Before meaningful work, read `memory/AGENTS.md`, `memory/00_Index/MOC-Home.md`, and recent/relevant files in `memory/05_Agent_Session_Logs/`.
- After meaningful work, write `memory/05_Agent_Session_Logs/YYYY-MM-DD-<Topic>.md` from `memory/99_Templates/Template-Session-Log.md`; skip pure Q&A, trivial typos, or when the user says not to log.
- Run `npm run memory:verify` after Memory Vault edits; run `npm run verify` after code + memory changes.

## Sources Of Truth
- Trust executable config over prose: `package.json`, `tsconfig*.json`, `vite.config.ts`, `src/`, `migrations/`, `.github/workflows/deploy.yml`, `Dockerfile`, and `docker-compose.yml`.
- This is one npm package with `package-lock.json` v3; CI/Docker use Node 20, while the backend bundle targets Node 18.
- There is no ESLint/Prettier/Vitest/Jest config or unit-test script; use typecheck/build/schema/memory gates below instead of inventing commands.
- Edit app code under `src/` and schema changes under `migrations/`; do not edit `dist/`, `data/`, `logs/`, `node_modules/`, `.env`, `notify-rules.json`, or generated `src/frontend/routeTree.gen.ts`.
- `.npmrc` is required for the `@jsr` registry alias used by `@evex/linejs`.

## Commands
- `npm ci` installs locked dependencies.
- `npm run typecheck`, `npm run typecheck:backend`, and `npm run typecheck:frontend` are focused TypeScript checks.
- `npm run build` is the CI gate: backend + frontend typecheck, clear `dist/`, bundle backend/scripts with esbuild, then Vite build to `dist/public`.
- `npm run dev` runs `HTTP_ENABLED=true tsx src/app.ts` and Vite together; `npm run dev:backend` and `npm run dev:frontend` run one side.
- `npm start -- 10` runs `dist/app.js`; build first if `dist/` may be stale. The CLI interval arg is seconds, while `POLL_INTERVAL_MS` is milliseconds.
- `npm run db:generate` builds then rewrites `migrations/001_create_booking_requests.sql` from `src/db/migration-sql.ts`.
- `npm run db:migrate` builds then applies sorted `migrations/*.sql`, split on semicolons, and records names in `schema_migrations`.
- `npm run schema:verify` is read-only MySQL drift verification; it needs DB env vars and must never print secrets.
- `npm run db:test` and `npm run flow:test` call the live SPX API and MySQL and can insert into `spx_booking_history`.
- `npm run memory:check`, `memory:eval`, `memory:score`, and `memory:verify` are the Memory Vault gates.
- On Windows/PowerShell, package scripts that use POSIX env assignment or `cp` (`test:memory*`, `dev:memory`) may need an equivalent shell or manual `$env:DB_MODE = "memory"` setup.

## Runtime Env
- `src/config/env.ts` manually loads root `.env` without overriding existing `process.env`; never read, print, copy, or commit secret values.
- Required SPX API env vars are `API_URL`, `COOKIE`, `DEVICE_ID`, `APP_NAME`, and `REFERER`; `API_URL` must include `/booking/bidding/list`.
- DB env vars `DB_HOST`, `DB_USERNAME`, `DB_PASSWORD`, and `DB_NAME` are required when `SAVE_TO_DB=true`, `HTTP_ENABLED=true`, or `AUTO_ACCEPT_ENABLED=true`, unless `DB_MODE=memory`; `DB_PORT` defaults to `3306`.
- `HTTP_ENABLED=true` also requires `JWT_SECRET`, `COOKIE_SECRET`, and a strong `ADMIN_PASSWORD`; it starts Fastify on `HTTP_PORT` and serves the React SPA plus `/api` routes.
- `FETCH_DETAILS=true`, `SAVE_TO_DB=true`, `NOTIFY_ENABLED=true`, or `AUTO_ACCEPT_ENABLED=true` makes the poller fetch `booking/bidding/request/list` details for each returned booking.
- Notification env uses `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_USER_ID`, `DISCORD_WEBHOOK_URL`, or `LINEJS_TEST_ENABLED=true`; older `LINE_NOTIFY_TOKEN` docs/examples are not used by code.

## Architecture Gotchas
- `src/app.ts` boot order: migrate selected env settings to `app_settings`, load DB-backed settings, validate env, migrate `notify-rules.json` to DB if active, create admin user when HTTP is enabled, then start `Poller`.
- `Poller` owns polling, detail fetches, write-once DB saves, rule notifications, auto-accept, metrics, SSE broadcasts, HTTP startup, and graceful shutdown.
- `src/services/api-client.ts` derives overview/request-list/accept endpoints by replacing `/booking/bidding/list`; update that logic if the list URL shape changes.
- Booking history is write-once by `request_id` using insert-ignore semantics; `request_id` comes from `booking/bidding/request/list`, not `booking_overview.vehicle_driver_info`.
- Notify rules are file-backed in dev (`NODE_ENV !== "production"` or no DB feature flag) and MySQL-backed in production with `SAVE_TO_DB`, `HTTP_ENABLED`, or `AUTO_ACCEPT_ENABLED`; JSON is only a one-time migration source when DB rules are empty.
- DB-backed settings in `app_settings` redact secrets on read, preserve masked secrets on write, and reload live without `process.exit(0)`.
- Backend TypeScript uses `moduleResolution: "NodeNext"`; keep `.js` suffixes on local relative imports in `.ts` files.
- Frontend routes are TanStack Router files under `src/frontend/routes/`; let Vite regenerate `src/frontend/routeTree.gen.ts`.
- MySQL schema changes must keep `src/db/schema.ts`, `src/db/migration-sql.ts`, `migrations/*.sql`, runtime SQL in `src/db/client.ts`, and SQLite memory schema in `src/db/client-memory.ts` aligned.
- MySQL DDL must stay 5.7-compatible: use `CURRENT_TIMESTAMP` defaults, not `(UTC_TIMESTAMP())`; store booleans as `INT` `0`/`1`.
- Root `poll-bidding.js` is legacy CommonJS with hardcoded request headers; prefer the TypeScript app in `src/`.

## Workflow And Deploy
- User preference for this repo is direct-to-`main` for completed fixes; do not create branches/PRs unless explicitly asked, and never commit/push unless explicitly asked.
- GitHub Actions builds on `main` with `npm ci` + `npm run build`, then SSH deploys by hard-resetting `/root/SPX` to `origin/main`, running `docker compose down`, `docker compose up --build -d`, and checking `/health`.
- `docker-compose.yml` mounts `.env`, `notify-rules.json`, and `data/`; its command runs `node dist/scripts/db-migrate.js && node dist/app.js`. The bare Dockerfile `CMD` does not run migrations by itself.

## Strict Review Workflow Gate
- Use `.windsurf/workflows/strict-pr-review-8-category.md` before any user-requested PR, review, or merge workflow.
- Also use it before production-impacting commit/push work touching `src/`, DB schema/migrations, auth/security, auto-accept, notifications, Docker/deploy, or runtime settings/secrets.
- Skip it for pure Q&A, memory-only/docs-only maintenance without production impact, and trivial typo fixes.
- If the user explicitly says not to commit, push, create PRs, or merge, stop before any workflow step that performs those actions and ask before continuing.
