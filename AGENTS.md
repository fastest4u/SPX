# AGENTS.md

## 🧠 Memory Vault (Read First)

This project has a persistent **Memory Vault** at [`memory/`](./memory/). It contains the long-term knowledge that all AI agents (Cascade, Claude Code, Codex, opencode, Cursor, Copilot) share for this project.

**Session start checklist for every AI agent:**
1. Read [`memory/AGENTS.md`](./memory/AGENTS.md) — vault constitution & conventions.
2. Open [`memory/00_Index/MOC-Home.md`](./memory/00_Index/MOC-Home.md) — navigation hub.
3. Check [`memory/05_Agent_Session_Logs/`](./memory/05_Agent_Session_Logs/) for recent context.
4. Use [`memory/99_Templates/`](./memory/99_Templates/) when creating new notes.

See [`memory/README.md`](./memory/README.md) for tool-specific setup (Claude Code, Cursor, Obsidian, etc.).

---

## 🤖 Auto-Log Session Rule (MANDATORY)

> **AI agents MUST automatically write a session log to `memory/05_Agent_Session_Logs/YYYY-MM-DD-Topic.md` after completing any meaningful work — without waiting for the user to ask.**

### When to auto-log (any of these triggers)

- ✅ Completed a feature or bug fix (code committed/changed)
- ✅ Made an architectural decision (always log + create ADR)
- ✅ Resolved a debugging session
- ✅ Set up tooling (MCP servers, plugins, configs)
- ✅ Refactored a non-trivial module
- ✅ User says: "done", "เสร็จแล้ว", "ok merge", "ship it", etc.
- ✅ Approaching session token limit (proactively save state)

### When NOT to log

- ❌ Pure Q&A (user just asked a question, no work done)
- ❌ Trivial single-line fixes (typos)
- ❌ User explicitly says "don't log this"

### How to auto-log

1. Pick topic name (kebab-case): `Fix-Auto-Accept-Race`, `Add-Discord-Embed`, etc.
2. Filename: `memory/05_Agent_Session_Logs/YYYY-MM-DD-<Topic>.md` (today's date).
3. Use frontmatter schema from `memory/99_Templates/Template-Session-Log.md`.
4. Fill these sections at minimum: **TL;DR · Goal · What Was Done · Files Touched · Decisions Made · Open Follow-ups**.
5. Use wikilinks `[[...]]` for in-vault references.
6. Run after writing: report path + outcome count to user.

### Reference

- Workflow: `.windsurf/workflows/session-end.md` (Cascade `/session-end` slash command)
- Template: `memory/99_Templates/Template-Session-Log.md`
- Vault rules: `memory/AGENTS.md`

---

The rest of this file = **project-specific rules** for SPX code.

---

## Sources Of Truth
- Trust `package.json`, `tsconfig.json`, `src/`, and `docs/` over guesses; there is no CI workflow, lint config, formatter config, or unit-test script.
- Edit `src/`; `dist/`, `data/`, `logs/`, `node_modules/`, and `.env` are ignored/generated or local-only.
- This is a single npm package using `package-lock.json`, not a workspace.

## Commands
- `npm ci` installs locked dependencies.
- `npm run build` is the main local verification; it runs backend + frontend typechecks, bundles backend entry/scripts with `esbuild`, then runs Vite frontend build into `dist/`.
- `npm run dev` runs the backend with `HTTP_ENABLED=true tsx src/app.ts` and the Vite frontend dev server concurrently.
- `npm run dev:backend` runs only the backend; `npm run dev:frontend` runs only Vite.
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
- Notification env vars: `NOTIFY_ENABLED=true` activates notifications; requires at least one channel: `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_USER_ID`, `DISCORD_WEBHOOK_URL`, or `LINEJS_TEST_ENABLED=true` with a target ID. `NOTIFY_MODE` controls batch vs per-match notification (`batch` or `each`, default `batch`).
- `AUTO_ACCEPT_ENABLED=true` enables auto-accept: the poller will automatically accept bidding requests matching enabled rules with `auto_accept` flag; auto-accept events are recorded in `auto_accept_history` table.
- Rule-based notifications use a dual storage mode:
  - **DEV** (`NODE_ENV !== "production"`, or no DB flags): reads/writes `notify-rules.json` at project root.
  - **PROD** (`NODE_ENV === "production"` + DB flags): reads/writes `notify_rules` MySQL table; JSON file is used only for one-time migration on first startup.
- Each rule has: `id`, `name`, `origins`, `destinations`, `vehicle_types`, `need`, `enabled`, `fulfilled`, `auto_accept`, `auto_accepted`.
- When trips match, the rule is auto-fulfilled and Discord/LINE notification is sent. SSE broadcasts rules changes to connected Web UI clients in real-time.
- Web UI settings are DB-backed through `app_settings`. `SettingsController` redacts secrets on read, preserves masked secrets on write, calls `reloadSettingsLive()`, and applies changed settings without `process.exit(0)`.
- `HTTP_ENABLED=true` starts a Fastify server on `HTTP_PORT` (default 3000) exposing the MVC-based Web UI and API routes under `/api`; `HTTP_ALLOWED_ORIGINS` optionally allows comma-separated non-localhost CORS origins.

## Architecture Notes
- `src/app.ts` loads `.env`, migrates selected env settings into `app_settings` when DB is usable, reloads DB-backed settings into `env`, validates config, migrates `notify-rules.json` into DB when active, creates the admin user when HTTP is enabled, constructs `Poller`, then starts the polling loop.
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
