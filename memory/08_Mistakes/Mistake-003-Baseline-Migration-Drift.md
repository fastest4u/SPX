---
title: Mistake-003 - Baseline Migration Drift
type: mistake
severity: high
status: resolved
occurred-date: 2026-05-13
resolved-date: 2026-05-13
created: 2026-05-13
updated: 2026-05-13
agent: codex
area: area/db
confidence: high
aliases:
  - Mistake-003
  - M-003
  - Baseline migration drift
tags:
  - mistake
  - project/spx
  - area/db
  - topic/migration
  - severity/high
---

# Mistake-003 - Baseline Migration Drift

> [!abstract] One-liner
> The generated baseline migration file lagged behind `src/db/schema.ts` and runtime table creation, so a fresh install could miss current columns and tables.

---

## What Happened

The source survey found that `src/db/schema.ts` and runtime SQL included newer tables/columns, while `migrations/001_create_booking_requests.sql` did not include everything needed by the current app.

The baseline was corrected for fresh installs, but existing production databases that already recorded the baseline filename in `schema_migrations` will not be altered by that edit.

---

## Root Cause

SPX has schema definitions in multiple places:

- `src/db/schema.ts`
- `src/db/migration-sql.ts`
- `migrations/*.sql`
- runtime SQL in `src/db/client.ts`
- memory-mode SQL in `src/db/client-memory.ts`

One path changed without all other schema representations being re-generated and verified.

---

## Correct Pattern

When schema changes:

```text
schema.ts
  -> migration-sql.ts
  -> npm run db:generate
  -> migrations/*.sql
  -> client.ts runtime SQL
  -> client-memory.ts
  -> Runbook-Production-Schema-Verification
```

For already-applied production migrations, create a new forward migration instead of relying on an edited baseline.

---

## Time Lost

About 15 minutes of audit and regeneration.

---

## How AI Should Avoid This

> [!tip] Pre-flight checklist
> 1. Search for the table/column in all schema locations.
> 2. Run `npm run db:generate` after editing `src/db/migration-sql.ts`.
> 3. Run `npm run build`.
> 4. For production, follow [[Runbook-Production-Schema-Verification]].

---

## How To Detect Recurrence

Symptoms:

- Fresh install lacks a table used by code.
- App log says "Unknown column".
- `schema_migrations` shows baseline applied, but `information_schema.columns` differs from `src/db/schema.ts`.
- Memory docs mention a column that baseline SQL does not create.

---

## Related

- [[Runbook-Production-Schema-Verification]]
- [[Runbook-DB-Migration]]
- [[SPX-System-Map]]
- [[2026-05-13-System-Survey-Awakened-AI-Update]]
