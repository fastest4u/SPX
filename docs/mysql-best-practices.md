---
tags:
  - mysql
  - database
  - spx
---

# SPX MySQL Notes

## Table Design
- `spx_booking_history` uses InnoDB with `utf8mb4_0900_ai_ci` for Thai/Unicode route names.
- `id` and `request_id` are `BIGINT UNSIGNED`; all IDs from the SPX API are positive external IDs.
- `booking_id` is `BIGINT UNSIGNED NULL` with `booking_id_idx` for cross-referencing requests to bookings.
- `booking_name`, `agency_name` are `VARCHAR(255) NULL` for booking context captured at first insert.
- `acceptance_status`, `assignment_status` are `INT NULL` for tracking request states at capture time.
- `created_at` uses `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` to avoid `TIMESTAMP` timezone conversion surprises.
- `request_id_idx` is unique and is the idempotency guard — records are inserted once and never updated.
- `created_at_idx` supports latest-row checks such as `ORDER BY created_at DESC LIMIT 5`.

## Insert-Only Semantics
- Records are written once when a job first appears via `INSERT IGNORE`.
- If the same `request_id` is seen again, the row is silently skipped (not updated).
- This preserves the original snapshot from when the job was first detected.

## Migrations
- `migrations/001_create_booking_requests.sql` is the fresh-install table definition (base columns).
- `migrations/002_harden_booking_history_mysql.sql` upgrades existing tables to unsigned IDs, `DATETIME`, target collation, and the `created_at` index.
- `migrations/003_add_booking_details.sql` adds `booking_id`, `booking_name`, `agency_name`, `acceptance_status`, `assignment_status`, and `booking_id_idx`.
- `src/scripts/db-migrate.ts` executes each semicolon-delimited statement in a migration file; keep migration SQL simple and avoid stored procedures/custom delimiters.

## Schema Sources (keep in sync)
1. `src/db/schema.ts` — Drizzle schema definition (source of truth for TypeScript types).
2. `src/db/migration-sql.ts` — Raw SQL template for initial table creation.
3. `src/db/client.ts` → `createSpxBookingHistoryTable()` — Runtime DDL fallback.
4. `migrations/*.sql` — Migration files applied via `db:migrate`.

## Query Patterns
- Inserts use `INSERT IGNORE` and rely on the unique `request_id` constraint; no `SELECT` before `INSERT`.
- Prefer focused selects over `SELECT *` when adding operational checks.
- Use `EXPLAIN` for new queries over `spx_booking_history`, especially queries that sort or filter by date.

## Operational Checks
- `npm run db:migrate` applies migrations and records filenames in `schema_migrations`.
- `npm run db:test` inserts or detects one live request row; it requires real API auth and MySQL.
- For table shape verification, use `SHOW CREATE TABLE spx_booking_history` and confirm all indexes exist.
