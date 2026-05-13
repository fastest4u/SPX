---
title: Runbook - Production Schema Verification
type: runbook
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:src/db/schema.ts + file:src/db/client.ts + file:migrations/001_create_booking_requests.sql + file:scripts/schema-verify.mjs
confidence: high
severity-when-applies: high
related-adrs:
  - [[ADR-001-Dual-Storage-Notify-Rules]]
  - [[ADR-002-DB-Backed-Live-Settings]]
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Production Schema Verification
  - Schema Drift Check
tags:
  - runbook
  - project/spx
  - area/db
  - topic/migration
  - topic/production
---

# Runbook - Production Schema Verification

> [!abstract] Use this when
> Use this when code/schema docs changed, a migration baseline changed, production insert errors mention unknown columns, or a new deployment needs proof that MySQL matches `src/db/schema.ts`.

---

## Safety Rules

> [!danger] Secrets
> Do not print `.env`, DB passwords, cookies, tokens, or container environment. Use interactive password prompts or server-local client config.

> [!warning] Migration reality
> `schema_migrations` tracks filenames. Editing an already-applied baseline SQL file improves fresh installs but does not automatically alter an existing production database.

---

## Automated Read-Only Check

Run from repo root when DB env vars point to the target MySQL database:

```bash
npm run schema:verify
```

Expected result:

- The command connects to MySQL using `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, and `DB_NAME`.
- It queries `information_schema` only.
- It compares table columns and indexes against the current source schema contract.
- It exits non-zero if required tables, columns, types, nullability, defaults, or indexes drift.

The command does not print DB passwords, cookies, or token values.

---

## Source Schema Checklist

Current source-of-truth files:

- `src/db/schema.ts`
- `src/db/migration-sql.ts`
- `migrations/001_create_booking_requests.sql`
- `src/db/client.ts`
- `src/db/client-memory.ts`

Important tables:

- `spx_booking_history`
- `notify_rules`
- `auto_accept_history`
- `metrics_snapshots`
- `line_bot_sessions`
- `app_settings`
- `users`
- `audit_logs`
- `schema_migrations`

---

## Read-Only Verification SQL

Run from a trusted MySQL session on the production server.

```sql
SELECT name, created_at
FROM schema_migrations
ORDER BY name;
```

```sql
SELECT table_name, column_name, column_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name IN (
    'spx_booking_history',
    'notify_rules',
    'auto_accept_history',
    'metrics_snapshots',
    'line_bot_sessions',
    'app_settings',
    'users',
    'audit_logs'
  )
ORDER BY table_name, ordinal_position;
```

```sql
SHOW CREATE TABLE spx_booking_history;
SHOW CREATE TABLE notify_rules;
SHOW CREATE TABLE auto_accept_history;
SHOW CREATE TABLE metrics_snapshots;
SHOW CREATE TABLE app_settings;
```

---

## Expected `spx_booking_history` Columns

- `id`
- `request_id`
- `booking_id`
- `booking_name`
- `agency_name`
- `route`
- `origin`
- `destination`
- `cost_type`
- `trip_type`
- `shift_type`
- `vehicle_type`
- `standby_datetime`
- `acceptance_status`
- `assignment_status`
- `created_at`

Required indexes:

- unique `request_id_idx`
- `booking_id_idx`
- `created_at_idx`

---

## Drift Response

If production is missing additive columns or tables:

1. Stop and record exact missing objects.
2. Confirm whether `schema_migrations` already contains the baseline migration filename.
3. Create a new forward migration file instead of relying on edits to an already-applied baseline.
4. Back up production DB before applying DDL.
5. Apply with `npm run db:migrate` through the normal deployment flow or a controlled server session.
6. Re-run the read-only verification SQL.

If drift is destructive or ambiguous, do not auto-fix. Escalate with the observed schema diff.

---

## Common Findings

| Finding | Meaning | Action |
|---|---|---|
| `schema_migrations` has `001_create_booking_requests.sql` but columns are missing | Baseline was applied before columns were added | Add a new migration with `ALTER TABLE`. |
| `metrics_snapshots` missing | Metrics persistence table was added after baseline | Add/create migration or rely on runtime ensure only if acceptable. |
| `app_settings` missing | Dashboard settings cannot persist | Apply dashboard table migration before enabling HTTP settings. |
| Unknown column in app logs | Runtime code expects newer schema | Verify source schema and create forward migration. |

---

## Post-Verification

- [ ] Update session log with schema status.
- [ ] Update [[Runbook-DB-Migration]] if procedure changes.
- [ ] Update [[Mistake-003-Baseline-Migration-Drift]] if this failure recurs.

---

## Related

- [[Runbook-DB-Migration]]
- [[SPX-System-Map]]
- [[ADR-002-DB-Backed-Live-Settings]]
- [[Mistake-003-Baseline-Migration-Drift]]
- [[Runbook-Deploy-Safety-Checklist]]
