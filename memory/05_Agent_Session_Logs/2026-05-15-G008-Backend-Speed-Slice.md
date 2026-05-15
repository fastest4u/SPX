---
title: "2026-05-15 — G008 Backend Speed Slice"
type: session-log
session-date: 2026-05-15
agent: cascade
duration-minutes: 25
outcomes:
  - Continued [[Goals#G-008 Lightweight Performance and Operator UX Roadmap]] Phase 2 with backend speed improvements.
  - Added batch booking history saves and bounded request-list page concurrency.
  - Added detail-job backpressure and streaming CSV responses to avoid avoidable runtime pressure.
created: 2026-05-15
updated: 2026-05-15
tags:
  - session-log
  - project/spx
  - topic/performance
  - topic/backend
---

# 2026-05-15 — G008 Backend Speed Slice

> [!abstract] TL;DR
> Continued G-008 Phase 2 by reducing DB round trips, bounding detail request-list page fan-out, adding simple detail-job backpressure, and streaming CSV responses without changing database schema.

## Goal

Continue [[Goals#G-008 Lightweight Performance and Operator UX Roadmap]] after Phase 1 telemetry by implementing a safe backend speed slice.

## What Was Done

- [x] Added `insertBookingHistories()` to `src/repositories/booking-history-repository.ts` for batch `INSERT IGNORE` writes.
- [x] Kept `insertBookingHistory()` and `saveBookingRequest()` for existing single-record call sites such as `db:test`.
- [x] Added `saveBookingRequests()` to `src/services/db-service.ts` so poller detail jobs save all extracted trips in one batch.
- [x] Updated `src/controllers/poller.ts` to batch DB saves, preserve inserted/skipped metrics, and warn on batch save errors.
- [x] Added `MAX_ACTIVE_DETAIL_JOBS` backpressure so new detail work is skipped when previous detail jobs are still saturated.
- [x] Added bounded request-list page concurrency in `src/services/api-client.ts` to replace unbounded `Promise.all` for remaining request-list pages.
- [x] Updated CSV report endpoints to stream generated CSV lines instead of assembling one response string.
- [x] Updated [[Goals]] progress for Phase 2.

## Files Touched

- `src/repositories/booking-history-repository.ts` — added batch insert helper and reused it for the single insert path.
- `src/services/db-service.ts` — added shared trip-to-history mapping and batch save service.
- `src/controllers/poller.ts` — switched detail-job DB persistence from per-trip saves to one batch save; added detail-job backpressure.
- `src/services/api-client.ts` — bounded request-list page fetch fan-out.
- `src/controllers/report-controller.ts` — streams metrics/history/audit CSV output.
- `memory/00_Index/Goals.md` — recorded G-008 Phase 2 backend speed progress.
- `memory/05_Agent_Session_Logs/2026-05-15-G008-Backend-Speed-Slice.md` — this session log.

## Decisions Made

- Did not change schema or migrations for this Phase 2 slice, so [[Mistake-003-Baseline-Migration-Drift]] does not require a migration regeneration step.
- Kept request-list page concurrency as a small local constant to avoid adding runtime settings before telemetry proves a need.
- Chose simple skip-and-warn backpressure for overlapping detail jobs rather than building a durable queue in this slice.

## Verification

- [x] `npm run typecheck` passed.
- [x] `npm run build` passed.
- [x] `npm run memory:verify` passed.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Batch DB saves can preserve inserted/skipped metrics | medium-high | confirmed by typecheck/build; live DB behavior not exercised to avoid inserting rows | Preserve single-record API and summarize batch affected rows |
| Bounded request-list page concurrency is safer than unbounded `Promise.all` | high | confirmed structurally by replacing page fan-out helper | Keep upstream API pressure bounded before tuning |

## Insights / Learnings

- Phase 2 backend speed can be split safely: batch persistence and bounded concurrency first, query/index changes only after telemetry proves need.
- Avoided [[Mistake-002-Stale-Memory-Docs-Overrode-Source]] by checking source before editing memory.
- Avoided [[Mistake-003-Baseline-Migration-Drift]] by not changing schema in this slice.

## Deferred Next Steps

- Consider safer CSV streaming for large history/audit exports if reports grow beyond the current capped reads.
- Review query/index health only after observing real telemetry and query patterns.

## References

- [[Goals]]
- [[2026-05-15-G008-Pipeline-Telemetry]]
- [[2026-05-14-SPX-Performance-UX-Roadmap]]
- [[Mistake-002-Stale-Memory-Docs-Overrode-Source]]
- [[Mistake-003-Baseline-Migration-Drift]]
