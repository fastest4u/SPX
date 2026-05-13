---
title: SPX Project Rules
type: rules
status: active
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
> This note mirrors the key rules from the repository's `AGENTS.md`. When repo `AGENTS.md` is updated, update this note too.

---

## Repository

- **Path:** `c:\Users\Server\Desktop\SPX`
- **Git root:** same
- **Language:** TypeScript (`moduleResolution: NodeNext`)
- **Package manager:** npm (single package, `package-lock.json`)

---

## Sources of Truth

> [!important]
> Trust `package.json`, `tsconfig.json`, `src/`, and `docs/` over guesses.
> **No CI workflow, no lint config, no formatter config, no unit-test script.**

- Edit `src/`
- Ignored / generated: `dist/`, `data/`, `logs/`, `node_modules/`, `.env`

---

## Commands Cheatsheet

| Command | Purpose |
|---|---|
| `npm ci` | Install locked deps |
| `npm run build` | `tsc --noEmit` + `esbuild` bundle → `dist/app.js` |
| `npm run dev -- 10` | Run `src/app.ts` via `ts-node` (10 sec interval) |
| `npm start -- 10` | Run `dist/app.js` (build first if stale) |
| `npm run db:generate` | Build + regenerate `migrations/001_*.sql` |
| `npm run db:migrate` | Apply migrations to MySQL |
| `npm run db:test` | Integration test — hits live API + MySQL |
| `npm run flow:test` | `db:migrate` → `db:test` |
| `npm run flow:start` | migrate → build → start |

> [!warning]
> `db:test` and `flow:test` require real API auth + network + MySQL. They can insert into `spx_booking_history`.

---

## Git Workflow (User Preference)

> [!danger] STRICT RULE
> **Push completed fixes directly to `main` only.**
> Do NOT create feature branches or PRs unless the user explicitly asks for branch/PR review workflow.

**Why?** Production server has auto-deploy:
- push → main → server git-pulls → rebuilds Docker → restarts.

See also: `.windsurf/workflows/review.md` (used only when explicitly requested).

---

## Required Env Vars

### Always
- `API_URL`, `COOKIE`, `DEVICE_ID`, `APP_NAME`, `REFERER`

### When `SAVE_TO_DB=true` OR `HTTP_ENABLED=true` OR `AUTO_ACCEPT_ENABLED=true`
- `DB_HOST`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`
- `DB_PORT` (default `3306`)
- `DB_MODE` (default `mysql`, `memory` for SQLite in-memory test)

### Optional (feature toggles)
- `POLL_INTERVAL_MS` — ms; CLI arg (seconds) overrides
- `FETCH_DETAILS` / `SAVE_TO_DB` / `NOTIFY_ENABLED`
- `NOTIFY_MODE` (`batch` | `each`)
- `AUTO_ACCEPT_ENABLED`
- `LINE_NOTIFY_TOKEN` / `DISCORD_WEBHOOK_URL`
- `HTTP_ENABLED` / `HTTP_PORT` / `HTTP_ALLOWED_ORIGINS`

---

## Architecture Quick Map

```
src/
├── app.ts                       # entrypoint
├── config/env.ts                # env loading
├── controllers/poller.ts        # polling + stats + SSE
├── services/
│   ├── api-client.ts            # bidding API + retry
│   ├── db-service.ts            # INSERT IGNORE saves
│   ├── notifier.ts              # Discord embed + LINE text
│   ├── notify-rules.ts          # dual-mode rule engine
│   ├── metrics.ts               # latency, success rate
│   ├── sse.ts                   # SSE broadcaster
│   ├── http-server.ts           # Fastify + RBAC + JWT
│   └── auto-accept-repository.ts
└── db/
    ├── schema.ts                # Drizzle
    ├── migration-sql.ts
    ├── client.ts                # mysql2 pool
    └── client-memory.ts         # SQLite mirror
```

See [[ADR-001-Dual-Storage-Notify-Rules]] for the rule storage decision.

---

## Critical Conventions

### TypeScript

> [!important]
> `moduleResolution: NodeNext` — **all local relative imports must use `.js` suffix**.

```typescript
// ✅ correct
import { Foo } from './services/foo.js';

// ❌ wrong
import { Foo } from './services/foo';
```

### MySQL Compatibility

> [!warning] MySQL 5.7 in production
> - Use `CURRENT_TIMESTAMP` (NOT `(UTC_TIMESTAMP())`) in DDL `DEFAULT`.
> - Application queries can use `UTC_TIMESTAMP()`.
> - Use `INT(0/1)` for booleans in `notify_rules` table.

### Notify Rules (Dual Storage)

| Mode | Storage |
|---|---|
| **DEV** (`NODE_ENV !== "production"` or no DB flags) | `notify-rules.json` at project root |
| **PROD** (`NODE_ENV === "production"` + DB flags) | `notify_rules` MySQL table |

JSON file is used **only for one-time migration** on first prod startup.

See [[ADR-001-Dual-Storage-Notify-Rules]].

### DB Save Semantics

> [!info]
> Uses `INSERT IGNORE` — records written **once** when a job first appears, **never updated**.

### Settings Self-Restart

> [!warning]
> `SettingsController` writes `.env` → triggers `process.exit(0)` → Docker auto-restart.

---

## Gotchas

> [!danger] Don't
> - ❌ Read / print / commit / copy secrets from `.env`
> - ❌ Use legacy root `poll-bidding.js` — prefer `src/` TS app
> - ❌ Treat `data/` as stable test fixtures (captured JSON, ignored)
> - ❌ `notify-rules.json` is `.gitignore`d — Dockerfile creates at build time

> [!tip] Do
> - ✅ `request_id` comes from `booking/bidding/request/list`, NOT `booking_overview.vehicle_driver_info`
> - ✅ Keep `src/db/schema.ts`, `migration-sql.ts`, `migrations/*.sql`, runtime `client.ts` in sync
> - ✅ `ensureDashboardTables()` creates `notify_rules` + `auto_accept_history` at runtime too

---

## Production Server

| Field | Value |
|---|---|
| **Host** | `root@45.83.207.139` |
| **Stack** | Docker Compose at `/root/SPX/docker-compose.yml` |
| **Deploy** | git push → main → server pulls + rebuilds |
| **Health** | `GET /ready` every 30s |

---

## Related

- [[ADR-001-Dual-Storage-Notify-Rules]]
- [[2026-05-13-Setup-MCP-Servers]]
- [[Glossary#Poller]]
- [[Glossary#Auto-Accept]]
- [[AGENTS.md]] — vault-level rules
