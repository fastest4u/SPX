---
title: "2026-05-15 — G008 Query Health Indexes"
type: session-log
session-date: 2026-05-15
agent: cascade
duration-minutes: 35
outcomes:
  - Continued [[Goals#G-008 Lightweight Performance and Operator UX Roadmap]] Phase 3 database/query health.
  - Fixed auto-accept history filtering and added source-aligned query indexes.
  - Regenerated baseline migration and updated schema verification expectations.
created: 2026-05-15
updated: 2026-05-15
tags:
  - session-log
  - project/spx
  - topic/performance
  - topic/database
---

# 2026-05-15 — G008 Query Health Indexes

> [!abstract] TL;DR
> Continued G-008 Phase 3 by fixing auto-accept history filter application and adding narrowly-scoped indexes that match observed audit and auto-accept query patterns, with migration/schema verifier updates to avoid drift.

## Goal

Continue [[Goals#G-008 Lightweight Performance and Operator UX Roadmap]] Phase 3 database/query health without speculative schema changes.

## What Was Done

- [x] Fixed `getAutoAcceptHistory()` so filters use a `whereClause` in the actual Drizzle query chain, matching the paginated query path.
- [x] Added Drizzle schema indexes for audit log sort/filter patterns: `audit_created_at_idx`, `audit_username_created_at_idx`, and `audit_action_created_at_idx`.
- [x] Added `aah_status_created_at_idx` for auto-accept history status filtering plus created-at sorting.
- [x] Added runtime `ensureMysqlIndex()` guards so dashboard table creation can add missing indexes idempotently.
- [x] Mirrored indexes in the memory SQLite schema.
- [x] Added `migrations/012_add_query_health_indexes.sql` with idempotent `information_schema.STATISTICS` checks.
- [x] Regenerated `migrations/001_create_booking_requests.sql` via `npm run db:generate`.
- [x] Updated `scripts/schema-verify.mjs` expected schema for the new indexes.
- [x] Updated [[Goals]] progress for Phase 3.

## Files Touched

- `src/repositories/auto-accept-repository.ts` — fixed filter application for non-paginated auto-accept history.
- `src/db/schema.ts` — added source schema indexes for audit and auto-accept history query patterns.
- `src/db/client.ts` — added idempotent MySQL index creation during dashboard table setup.
- `src/db/client-memory.ts` — mirrored indexes in memory DB schema.
- `src/db/migration-sql.ts` — updated baseline table DDL for auto-accept status/created-at index.
- `scripts/schema-verify.mjs` — updated expected index contract.
- `migrations/001_create_booking_requests.sql` — regenerated baseline migration.
- `migrations/012_add_query_health_indexes.sql` — added idempotent migration for existing databases.
- `memory/00_Index/Goals.md` — recorded G-008 Phase 3 progress.
- `memory/05_Agent_Session_Logs/2026-05-15-G008-Query-Health-Indexes.md` — this session log.

## Decisions Made

- Added only indexes tied to current controller/repository patterns: audit created-at sorting, audit username/action filters with created-at sorting, and auto-accept status filtering with created-at sorting.
- Did not add B-tree indexes for `%term%` search patterns because leading-wildcard `LIKE` queries do not reliably benefit from normal indexes.
- Used a new idempotent migration instead of editing only generated baseline SQL, so existing databases can converge safely.

## Verification

- [x] `npm run typecheck` passed.
- [x] `npm run build` passed.
- [x] `npm run db:generate` passed and regenerated `migrations/001_create_booking_requests.sql`.
- `npm run db:migrate` was attempted after user approval but could not complete because the DB connection timed out with `connect ETIMEDOUT`; migration `012_add_query_health_indexes.sql` was not confirmed applied.
- `npm run schema:verify` could not complete because the DB connection timed out with `connect ETIMEDOUT`; no schema mismatch was observed because the check could not connect.
- [x] `npm run memory:verify` passed.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Auto-accept history non-paginated filters were not applied safely | medium | fixed by matching existing paginated query pattern and verified by typecheck/build | Prefer immutable query-chain style with explicit `whereClause` |
| New indexes are source-aligned | medium | index choices match current controller/repository filters and sort order; live DB verification timed out | Schema changes need source, migration, generated SQL, and verifier updates together |

## Insights / Learnings

- For G-008 Phase 3, query health can be improved without broad indexing by tying every index to a live query path.
- Avoided [[Mistake-003-Baseline-Migration-Drift]] by updating schema source, runtime DDL, generated migration, new migration, memory DB mirror, and schema verifier together.
- Live schema verification may be blocked by DB network reachability; record timeout separately from code verification.

## Operational Notes

- Re-run `npm run schema:verify` when the production MySQL host is reachable.
- Run `npm run db:migrate` only when intentionally ready to apply `012_add_query_health_indexes.sql` to the target database.

## References

- [[Goals]]
- [[2026-05-15-G008-Backend-Speed-Slice]]
- [[2026-05-15-G008-Pipeline-Telemetry]]
- [[Mistake-003-Baseline-Migration-Drift]]
- [[Runbook-Production-Schema-Verification]]
