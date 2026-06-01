---
title: SPX Project Rules
type: rules
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:AGENTS.md + file:package.json + file:src/
confidence: high
created: 2026-05-13
updated: 2026-05-13
tags:
  - project/spx
  - rules
  - reference
aliases:
  - SPX Conventions
  - SPX Coding Standards
---

# SPX Project Rules

> [!abstract] What is SPX?
> A TypeScript/Node.js polling service that watches the SPX bidding API, detects new booking requests, optionally saves them to MySQL, sends Discord/LINE notifications, and auto-accepts matching rules.

> [!info] Source of truth
> This note mirrors the key rules from root `AGENTS.md`, `package.json`, and the current `src/` implementation. When repo behavior changes, update this note and [[SPX-System-Map]] together.

---

## Repository

- Path: `C:\Users\Server\Desktop\SPX`
- Language: TypeScript with `moduleResolution: NodeNext`
- Package manager: npm, single package, `package-lock.json`
- Primary app: backend poller + Fastify API + React/Vite SPA

---

## Sources of Truth

> [!important]
> Trust `package.json`, `tsconfig.json`, `src/`, and `docs/` over guesses.

- Edit `src/` for app changes.
- Ignored/generated/local: `dist/`, `data/`, `logs/`, `node_modules/`, `.env`, `notify-rules.json`.
- Do not read, print, copy, or commit `.env` secrets.

---

## Commands Cheatsheet

| Command | Purpose |
|---|---|
| `npm ci` | Install locked dependencies |
| `npm run typecheck` | Backend + frontend TypeScript checks |
| `npm run build` | Typecheck, bundle backend/scripts with esbuild, build frontend with Vite |
| `npm run dev` | Run backend (`HTTP_ENABLED=true tsx src/app.ts`) and Vite frontend concurrently |
| `npm run dev:backend` | Run only backend with HTTP enabled |
| `npm run dev:frontend` | Run only Vite frontend |
| `npm start -- 10` | Run `dist/app.js`; optional CLI interval is seconds |
| `npm run db:generate` | Build and regenerate `migrations/001_create_booking_requests.sql` |
| `npm run db:migrate` | Apply unapplied SQL migrations to MySQL |
| `npm run db:test` | Integration test against live SPX API + MySQL |
| `npm run flow:test` | `db:migrate` then `db:test` |
| `npm run flow:start` | migrate, build, then start `dist/app.js` |
| `npm run schema:verify` | Read-only MySQL schema drift check against the source schema contract |
| project-memory MCP tools | Verify Memory Vault health, notes, source truth, links, staleness, lifecycle, and follow-ups |
| `npm run verify` | Run the application production build gate |

> [!warning]
> `db:test` and `flow:test` require real API auth, network access, and MySQL. They can insert into `spx_booking_history`.

---

## Git Workflow

> [!danger] User preference
> Push completed fixes directly to `main`. Do not create feature branches or PRs unless the user explicitly asks for that workflow.

Production auto-deploy is push-based: push to `main`, server pulls, Docker rebuilds, container restarts.

---

## Required Env Vars

### Always

- `API_URL`
- `COOKIE`
- `DEVICE_ID`
- `APP_NAME`
- `REFERER`

### When DB-backed features are active

Required when `SAVE_TO_DB=true`, `HTTP_ENABLED=true`, or `AUTO_ACCEPT_ENABLED=true`:

- `DB_HOST`
- `DB_USERNAME`
- `DB_PASSWORD`
- `DB_NAME`
- `DB_PORT` defaults to `3306`
- `DB_MODE` defaults to `mysql`; use `memory` for SQLite in-memory tests

### Optional feature toggles

- `POLL_INTERVAL_MS` in milliseconds; CLI interval arg is seconds and overrides it.
- `FETCH_DETAILS`, `SAVE_TO_DB`
- `NOTIFY_ENABLED` and `NOTIFY_MODE` are legacy normal-notify settings; rule-match-only job notifications are disabled in current source
- `AUTO_ACCEPT_ENABLED`
- LINE OA: `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_USER_ID`
- LINEJS routing: `LINEJS_TEST_ENABLED` + target IDs
- Discord: `DISCORD_WEBHOOK_URL`
- HTTP: `HTTP_ENABLED`, `HTTP_PORT`, `HTTP_ALLOWED_ORIGINS`, `JWT_SECRET`, `COOKIE_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_ROLE`

---

## Architecture Quick Map

```text
src/
  app.ts                         entrypoint and boot sequence
  config/env.ts                  env loading and validation
  controllers/poller.ts          polling loop, details, DB saves, auto-accept, SSE
  services/
    api-client.ts                SPX bidding API client and retry behavior
    db-service.ts                write-once booking history saves
    notifier.ts                  Discord, LINE OA, LINEJS notifications
    notify-rules.ts              dual-mode rules engine
    metrics.ts                   runtime metrics collector
    sse.ts                       SSE broadcaster singleton
    http-server.ts               Fastify, auth, RBAC, static SPA
    settings.ts                  DB-backed live settings
  db/
    schema.ts                    Drizzle schema
    migration-sql.ts             generated migration SQL source
    client.ts                    mysql2 pool and runtime table creation
    client-memory.ts             SQLite memory-mode schema
```

Read [[SPX-System-Map]] before broad changes.

---

## Critical Conventions

### TypeScript

`moduleResolution: NodeNext` means local relative imports in `.ts` files must keep the `.js` suffix.

```typescript
import { Foo } from "./services/foo.js";
```

### MySQL Compatibility

- Production targets MySQL 5.7 compatibility.
- DDL defaults use `CURRENT_TIMESTAMP`, not `(UTC_TIMESTAMP())`.
- Boolean DB fields use `INT` with `0`/`1`.
- Keep `src/db/schema.ts`, `src/db/migration-sql.ts`, `migrations/*.sql`, runtime SQL in `src/db/client.ts`, and memory-mode SQL in `src/db/client-memory.ts` aligned.

### Notify Rules Dual Storage

| Mode | Storage |
|---|---|
| DEV (`NODE_ENV !== "production"` or no DB flags) | `notify-rules.json` |
| PROD (`NODE_ENV === "production"` + DB flags) | `notify_rules` MySQL table |

JSON is used for one-time migration when DB is active and DB has no existing rules. See [[ADR-001-Dual-Storage-Notify-Rules]] and [[Component-Dual-Storage-Notify-Rules]].

### DB Save Semantics

`spx_booking_history` is write-once by `request_id`. Inserts use `INSERT IGNORE`; existing rows are not updated.

### DB-Backed Live Settings

`SettingsController` reads/writes selected runtime settings through `app_settings`, redacts secrets on read, preserves masked secrets on write, calls `reloadSettingsLive()`, and applies changed settings without `process.exit(0)`.

Sources: `src/controllers/settings-controller.ts`, `src/services/settings.ts`.

---

## Gotchas

- `request_id` comes from `booking/bidding/request/list`, not `booking_overview.vehicle_driver_info`.
- Root `poll-bidding.js` is legacy CommonJS; prefer `src/`.
- `data/` is captured local output, not stable fixtures.
- `notify-rules.json` is ignored; Docker creates and persists it through a host volume.
- State-changing accept calls intentionally use a smaller retry budget than read calls.
- Before pushing to `main`, use [[Runbook-Deploy-Safety-Checklist]] and do not stage local Obsidian state like `memory/.obsidian/graph.json`.

---

## Production Server

| Field | Value |
|---|---|
| Host | `root@45.83.207.139` |
| Stack | Docker Compose at `/root/SPX/docker-compose.yml` |
| Deploy | push to `main`, server pulls and rebuilds |
| Health | `GET /ready` every 30 seconds |

Alert policy: [[Runbook-Production-Alert-Policy]] defines alert conditions for `/ready`, `/health`, poll error rate, session expiry, auto-accept failures, DB connectivity, and poll latency.

---

## Related

- [[SPX-System-Map]]
- [[Awakened-AI-System]]
- [[API-Bidding-Endpoints]]
- [[API-Internal-HTTP]]
- [[API-SSE-Events]]
- [[ADR-001-Dual-Storage-Notify-Rules]]
- [[ADR-002-DB-Backed-Live-Settings]]
- [[Component-Poller-Orchestration]]
- [[Component-Dual-Storage-Notify-Rules]]
- [[Runbook-Production-Schema-Verification]]
- [[Runbook-Production-Alert-Policy]]
- [[Runbook-Multi-AI-Memory-Acceptance]]
- [[Runbook-Production-Deploy]]
