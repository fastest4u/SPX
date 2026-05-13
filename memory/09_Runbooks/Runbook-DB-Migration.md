---
title: Runbook — Database Migration (Add Column / Table)
type: runbook
status: active
last-verified: 2026-05-13
verified-by: human
source: file:src/db/schema.ts + file:src/db/migration-sql.ts
confidence: high
severity-when-applies: high
related-adrs: []
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Runbook-DB-Migration
  - DB Migration Runbook
tags:
  - runbook
  - project/spx
  - area/db
  - topic/migration
---

# Runbook — Database Migration

> [!important] Stack
> MySQL 5.7 production · Drizzle ORM · `mysql2` driver · plain `.sql` migrations applied via `db-migrate.js`

## Symptoms (When to use)

- Need to add/remove/change a column or table
- Schema in `src/db/schema.ts` diverges from prod
- New feature requires schema change

## Pre-Flight Check

> [!warning] Mistake watch
> Before writing DDL, check `08_Mistakes/` for known schema pitfalls. **MySQL 5.7 cannot use `(UTC_TIMESTAMP())` as DEFAULT** — use `CURRENT_TIMESTAMP` only.

> [!danger] Password handling for `mysql` / `mysqldump`
> Always use `-p` (no value) so MySQL prompts interactively. **Never** use `-pSECRET` because `ps aux` exposes it. Better: use a `~/.my.cnf` with `chmod 600` containing `[client]` credentials and drop `-p` entirely.

```bash
# Verify current schema state
npm run db:test  # smoke test — shows latest rows
mysql -h "$DB_HOST" -u "$DB_USERNAME" -p "$DB_NAME" -e "SHOW CREATE TABLE <table>"
# (password prompted; not echoed)
```

## Procedure

### 1. Update TypeScript schema

Edit:
- `src/db/schema.ts` — Drizzle schema definition
- `src/db/migration-sql.ts` — the SQL that `db:generate` writes out
- `src/db/client.ts` → `ensureDashboardTables()` if the table is created at runtime
- `src/db/client-memory.ts` if SQLite-mode also needs it

### 2. Generate migration SQL

```bash
npm run db:generate
# This builds + writes migrations/001_create_booking_requests.sql
```

### 3. Inspect the generated SQL

```bash
cat migrations/001_create_booking_requests.sql
# Verify:
#   - No (UTC_TIMESTAMP()) — use CURRENT_TIMESTAMP only
#   - InnoDB engine + utf8mb4_0900_ai_ci collation
#   - BIGINT UNSIGNED for IDs
#   - Semicolons end every statement
```

### 4. Test locally on a copy

```bash
# Backup current dev DB
mysqldump -h $DB_HOST -u $DB_USERNAME -p $DB_NAME > /tmp/spx-backup-$(date +%F).sql

# Apply migration
npm run db:migrate
```

### 5. Verify

```sql
-- Verify table structure
SHOW CREATE TABLE <table>;

-- Verify migrations table tracked it
SELECT * FROM schema_migrations ORDER BY id DESC LIMIT 5;
```

### 6. Production deploy

Schema changes deploy through normal git push → main → auto-deploy. The Dockerfile runs `db-migrate.js` **before** `app.js` so migrations are applied automatically.

> [!danger] Reversibility
> If migration is destructive (DROP COLUMN, DROP TABLE):
> 1. **Take backup first** — `mysqldump` on production
> 2. Consider **two-step** migration: add new → migrate data → remove old (multiple PRs)

## Verify (Post-Deploy)

- [ ] `npm run db:test` passes on production
- [ ] `schema_migrations` table contains the new filename
- [ ] Application logs show no schema errors for 60 seconds
- [ ] First poll after deploy writes successfully

## Rollback

```sql
-- Manual revert (only if migration is reversible)
ALTER TABLE <table> DROP COLUMN <col>;
DELETE FROM schema_migrations WHERE filename = '<NNN>_<name>.sql';
```

If unrevertable → restore from backup:

```bash
mysql -h $DB_HOST -u $DB_USERNAME -p $DB_NAME < /tmp/spx-backup-<date>.sql
```

## Common Failures

| Symptom | Cause | Fix |
|---|---|---|
| `DEFAULT '(UTC_TIMESTAMP())' invalid` | MySQL 5.7 doesn't support function defaults | Use `CURRENT_TIMESTAMP` |
| `Cannot add column ... in column list` | Duplicate column name | Check `SHOW CREATE TABLE` for current state |
| Migration filename already in `schema_migrations` | Previously applied | Skip — already done |
| `Foreign key constraint fails` | Referenced row doesn't exist | Migrate data first |

## References

- Schema source: `src/db/schema.ts`
- SQL generator: `src/db/migration-sql.ts`
- Runtime ensure: `src/db/client.ts → ensureDashboardTables()`
- MySQL 5.7 gotchas: root `AGENTS.md` → Gotchas section

## Changelog

- **2026-05-13** — Initial version.
