# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SPX Bidding Poller: a single Node process that polls the SPX Agency Booking Bidding List API in a loop, detects changes, extracts trips, optionally saves to MySQL, auto-accepts jobs matching rules, sends Discord/LINE notifications, and (when `HTTP_ENABLED`) serves a React SPA dashboard + REST API from the same process. Backend is MVC TypeScript; frontend is a Vite-built React 19 SPA.

The richest existing reference is `docs/` (architecture, runtime-flow, env-reference, api-routes, notification-system, database-schema, auto-accept-engine, deployment). Prose is largely Thai; code/identifiers are English. Note `docs/` can lag the code — e.g. it describes roles as `viewer/editor/admin`, but the actual model is only `user | admin` (`src/services/authz.ts`). Trust the source over the docs when they disagree.

## Commands

- Build: `npm run build` (typecheck → esbuild bundles backend entrypoints to `dist/` with `--packages=external` → `vite build` for the SPA into `dist/public`)
- Typecheck: `npm run typecheck` (runs `typecheck:backend` = `tsc --noEmit`, then `typecheck:frontend` against `tsconfig.frontend-check.json` — the root `tsconfig.json` *excludes* `src/frontend`)
- Lint: `npm run lint` (`eslint . --max-warnings 0`; `lint:fix` to autofix)
- Format: `npm run format` / `npm run format:check`
- Dev (both servers): `npm run dev` — `concurrently` runs backend (`tsx src/app.ts` with `HTTP_ENABLED=true`) + Vite frontend
- Tests: `npm test` (runs every `tests/*.test.ts`). Single test by substring: `npm test -- error-classifier`
- Schema drift check: `npm run schema:verify` (read-only; compares live MySQL against the expected contract in `scripts/schema-verify.mjs`)
- DB lifecycle (build first, then run from `dist/`): `npm run db:migrate`, `db:reset`, `db:test`, `db:generate`
- In-memory quick run: `npm run test:memory:quick` (SQLite, no MySQL needed)

## Test architecture

`scripts/run-tests.mjs` is a custom runner — there is no Jest/Vitest. Each `tests/*.test.ts` is a self-contained `tsx` executable that throws or `process.exit(1)` on failure; the runner spawns each **in its own process** (so module singletons / `process.chdir` don't leak) with `DB_MODE=memory` injected into the child env. Files not ending in `.test.ts` (e.g. `*-smoke.ts`) are intentionally skipped by the runner. When writing a test, make it runnable standalone and rely on memory-mode DB.

## Module system (important)

`tsconfig` is `module: NodeNext` / strict. **Backend imports use explicit `.js` extensions even for `.ts` source files** (e.g. `import { env } from "./config/env.js"`). Match this — extensionless or `.ts` imports will break the build. Frontend (`src/frontend`) is compiled by Vite separately and does not follow this convention.

## Runtime model

`src/app.ts` → loads/validates config → constructs `Poller` (`src/controllers/poller.ts`) → `poller.start()`.

- **Single loop, serialized ticks:** `Poller.run()` awaits one `tick()` then `setTimeout`s the next. Ticks never overlap, so a low `POLL_INTERVAL_MS` cannot busy-loop. Resource ceiling is `BOOKING_DETAIL_CONCURRENCY` (capped at 50 in validation), not the interval.
- **Do not floor `POLL_INTERVAL_MS`.** It is the operator's lever — a lower interval wins more bidding jobs and is a deliberate competitive advantage. `env.ts` only checks it is a positive integer; keep it that way. (See memory `poll-interval-no-floor`.)
- **Detail fetch is backpressured:** at most `MAX_ACTIVE_DETAIL_JOBS` (2) concurrent detail-processing jobs; per-booking de-dup via `activeDetailBookingIds`. Auto-accept-matching bookings get a "fast lane" ahead of deferred ones.
- **DB writes are async/queued** through `BookingHistorySaveQueue`; flushed on shutdown.
- **Graceful shutdown** (`SIGINT`/`SIGTERM`/uncaught): stop timer → await active tick + detail jobs → flush save queue → persist final metrics → close SSE → close HTTP → close DB pool.

Data path is one-directional: `SPX API → ApiClient → Poller → booking-extractor → DB / Notifier / Metrics`.

## Two run modes via feature flags

Flags (`.env` + DB `app_settings`): `FETCH_DETAILS`, `SAVE_TO_DB`, `NOTIFY_ENABLED`, `AUTO_ACCEPT_ENABLED`, `HTTP_ENABLED`. `SAVE_TO_DB`, `HTTP_ENABLED`, and `AUTO_ACCEPT_ENABLED` all require DB config (MySQL creds, or `DB_MODE=memory`). `HTTP_ENABLED` additionally requires `JWT_SECRET`, `COOKIE_SECRET` (≥32 chars each) and `ADMIN_PASSWORD` (≥12 chars) — see `validateRuntimeConfig()` in `src/config/env.ts`.

## Settings & live reload (no restart)

Settings persist in the `app_settings` table. On startup: `.env` → `process.env` → `loadDbSettingsIntoEnv()` (DB overrides env). Saving via the dashboard upserts to DB and calls a live reload that syncs back into `process.env`/`env`. The `env` object is read fresh on every poll (ApiClient does not cache credentials; `Poller.getIntervalMs()` re-reads each tick), so config changes take effect immediately. When adding a setting, wire it through `src/services/settings.ts` if it must be live-editable.

## Database

`src/db/client.ts` abstracts two backends behind one Drizzle API: `DB_MODE=mysql` (mysql2 pool) or `DB_MODE=memory` (SQLite via `client-memory.ts`, used by all tests). There are **two complementary schema mechanisms**:
- **Versioned SQL migrations** in `migrations/*.sql`, applied in sorted order by `npm run db:migrate` (`src/scripts/db-migrate.ts`), each in a transaction and tracked in the `schema_migrations` table (idempotent — already-applied files are skipped). This is the canonical schema history for MySQL.
- **Runtime idempotent table creation** in `client.ts` (`ensureDashboardTables()` / `ensureSpxBookingHistoryTable()` using `CREATE TABLE IF NOT EXISTS` + `SHOW COLUMNS`/`information_schema` guards) so the app self-heals on boot even without a migration run.

When you change a table's shape, keep all three in sync: add a `migrations/NNN_*.sql` file, update the `CREATE TABLE` DDL in `client.ts`, and update the `EXPECTED_SCHEMA` contract in `scripts/schema-verify.mjs` — otherwise `npm run schema:verify` (and CI) will flag drift. Repositories in `src/repositories/*` are the only direct DB-access layer; services call repositories.

## HTTP server structure

`src/services/http-server.ts` registers everything. Plugin/auth layering:
- Public: `authController` (`/api/login` etc.), `dashboardController` (`/health`, `/ready` stay public; `/metrics`, `/events` SSE, `/system/*` require auth).
- Authenticated (`/api/*` with cookie JWT, server-side revocation via `jwt-blacklist-repository`): history, reports.
- `user` role + rate bucket: rules, notifications, bidding, line-bot, ai, line-image-extractions.
- `admin` role + rate bucket: users, settings, audit-logs, reports (audit), auto-accept-history.

Roles are `user | admin` only (`hasRole` uses ordered `["user","admin"]`). Per-route in-memory rate limiting (no external store), per-request CSP nonce injected into the SPA `index.html`, security headers on every response. The SPA is served by a `/*` catch-all that returns `index.html` for non-API/non-asset routes.

## Frontend architecture

The SPA (`src/frontend/`) is compiled separately by Vite and is only tangentially related to backend conventions.

- **Routing**: TanStack Router with file-based routes under `src/frontend/routes/`. The router codegen plugin (run on `npm run dev`/`npm run build`) regenerates `src/frontend/routeTree.gen.ts` — never hand-edit that file. Adding a page means adding a file in `routes/`.
- **UI components**: shadcn/ui (Radix primitives + Tailwind classes) live in `src/frontend/components/ui/`. Extend from there rather than importing Radix directly.
- **Backend communication**: REST calls via `src/frontend/lib/api.ts`; real-time push via SSE hooks `src/frontend/hooks/useSse.ts` / `useSseContext.tsx` (backed by the `/events` endpoint in `dashboardController`).
- **Auth state**: managed by `useAuth.ts`; JWT is stored in a `HttpOnly` cookie, not `localStorage`.

## Conventions

- Errors: throw `AppError` subclasses (`src/utils/errors.ts`); the Fastify error handler maps them to `{ statusCode, errorCode, message }` via `sendError` (`src/utils/response.ts`). Available subclasses: `NotFoundError` (404), `ValidationError` (400), `UnauthorizedError` (401), `ForbiddenError` (403), `ConflictError` (409), `RateLimitError` (429), `ServiceUnavailableError` (503). Use the structured `logger` (`src/utils/logger.ts`) with an event name + context object, not `console.log`, in server paths.
- Config is centralized in the frozen `env` object; never read `process.env` directly elsewhere — add to `env.ts` and validate in `validateRuntimeConfig()`.

## notify-rules.json vs DB

`notify-rules.json` is the file-based fallback used only in development (non-production, or when `SAVE_TO_DB`/`HTTP_ENABLED`/`AUTO_ACCEPT_ENABLED` are all false). In production with a DB active, rules live in the `notify_rules` table and the file is ignored. The app auto-manages the file when it is in file mode, so do not hand-edit it — changes would be overwritten. The `auto_accept` field on `NotifyRule` is always `true` (every enabled rule auto-accepts); it is kept on the wire only for backward compatibility.

## CI/CD

Push to `main` triggers `.github/workflows/deploy.yml`: lint → build → test → SSH deploy. The deploy script on the server does: capture rollback SHA → `docker compose build` → `docker compose up` (which runs `db:migrate` then starts the app) → readiness poll at `/ready`. If build or readiness fails, `git reset --hard <previous SHA>` and re-deploy the old image. Never force-push `main`.

## Do not edit

Generated / runtime / secret artifacts — never hand-edit or commit changes to: `src/frontend/routeTree.gen.ts` (TanStack Router codegen), `dist/`, `data/`, `logs/`, `node_modules/`, `.env`, and `notify-rules.json`. Never read, print, copy, or commit secret values from `.env`. When prose docs and executable config (`src/config/env.ts`, `package.json`) disagree, trust the code.

## Commit & deploy policy

After code changes, stop at **typecheck passing** and explain what changed. **Do not auto-commit, push, branch, open PRs, merge, or deploy unless the user explicitly asks** — the repo preference is direct-to-`main`, and the user decides when to commit and when to ship to production. Recent history uses Conventional Commit prefixes (`fix:`, `feat:`, `docs:`, `chore:`); keep commits scoped and imperative.

## Auto Memory Management (project-memory MCP)

Use the `project-memory` MCP server for all SPX cross-session memory. The server is named `project-memory`; its memory tools are auto-approved locally by `.claude/settings.local.json` via `mcp__project-memory__memory_*`. The vault root must be `C:\Users\Server\Desktop\SPX\memory`; if `memory_sessionStart` reports any other vault root, stop and surface the routing issue.

Do not use obsidian MCP, manual vault file writes, Codex hooks, Claude file-based auto-memory, or removed `npm run memory:*` scripts for SPX lifecycle work. Pick the smallest useful set of project-memory tools per task; do not call every tool every turn.

### Tool map

- Startup/context: `memory_sessionStart`, `memory_contextPack`, `memory_followUpRadar`, `memory_awaken`, `memory_lifecycleStatus`
- Read/search: `memory_search`, `memory_get`, `memory_list`, `memory_recent`
- Risk and verification: `memory_selfCheck`, `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`
- Maintenance: `memory_findBrokenLinks`, `memory_findDuplicates`, `memory_checkStaleness`, `memory_reindex`, `memory_indexNote`, `memory_compactVault`
- Structured writing: `memory_sessionEnd`, `memory_writeSessionLog`, `memory_writeADR`, `memory_writeMistake`, `memory_writeInsight`, `memory_createFromTemplate`
- Vault transfer/bootstrap: `memory_export`, `memory_import`, `memory_bootstrapProject`

### Lifecycle

**Hooks are off by design — this file IS the driver.** Mirrors the Codex setup: `.codex/config.toml` sets `codex_hooks = false`/`hooks = false` and `.codex/hooks.json` is empty, and `AGENTS.md` drives the loop purely through instructions. Run this lifecycle yourself on every session; the user should not have to ask. **Do not add a SessionStart/Stop hook (or any file-based auto-memory) to enforce it** — that contradicts the workspace's deliberate no-hook decision. Reliability comes from following the layers below, backstopped by the `memory_sessionEnd` quality gate.

**Layer 1 — Session start (first substantive request):** call `memory_sessionStart`, then `memory_contextPack`. Infer `mode` from intent — `coding` (feature/refactor), `debugging` (error/bug), `deploy` (commit/push/production), `planning` (architecture/design), `docs` (memory/docs/vault) — plus a short `taskArea`. Confirm `vaultRoot` is `C:\Users\Server\Desktop\SPX\memory`; if it is anything else, stop and surface the routing issue.

**Layer 2 — Before work (every task):** call `memory_followUpRadar` for the task area and mention relevant unclosed follow-ups to the user before proceeding.

**Layer 3 — Before risky work:** call `memory_selfCheck` *up front* (not after). Risky = production deploy / SSH / `docker compose`, DB schema or migrations, auth/secrets/`.env`, MCP config, multi-file refactors in `src/services` or `src/controllers`, any `notify-rules.json` or auto-accept change. The `memory_sessionEnd` quality gate flags a skipped selfCheck after the fact — treat that as a backstop, not the plan.

**Layer 4 — Session end (after meaningful work):** call `memory_sessionEnd` with concrete `outcomes`, `decisionsMade`, `filesTouched`, `openFollowUps`, and precise verification evidence. Fire it automatically when you finish a feature/fix/refactor, when approaching the context limit, or when the user signals completion — e.g. "done" / "เสร็จแล้ว" / "save this" / "ship it". Also write durable memory the same way (never by hand-editing vault notes): `memory_writeADR` for a decision that should outlive the task, `memory_writeMistake` when a new bug pattern was found, `memory_writeInsight` when the same pattern has appeared in ≥2 prior sessions. If `memory_sessionEnd` cannot verify internally, call `memory_verifyVault` and record that result in both the reply and the session log.

During every layer: auto-select targeted retrieval, verification, maintenance, and writing tools by intent; pick the smallest useful set and prefer ADRs, mistakes, runbooks, and recent sessions over broad vault reads.

## Library docs (Context7 MCP)

When the user asks about any library, framework, SDK, API, CLI, or cloud service — even well-known ones — use the Context7 MCP (`resolve-library-id` → `query-docs`) to fetch current docs before answering; prefer it over web search and over training-data recall. Skip it for refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Communication style (pordee)

`.cursor/rules/pordee.mdc` defines a terse Thai response mode the user may toggle with `พอดี` / `/pordee` (off: `หยุดพอดี`). When active, keep it for every response. It never applies to code blocks, commit messages, PR/review text, error messages, file paths, identifiers, or stack traces — those stay exact/English.



claude --resume 9abecc53-1187-4e9f-b34d-cd3aa031425d
