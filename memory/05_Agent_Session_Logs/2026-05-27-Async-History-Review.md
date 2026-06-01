---
aliases:
  - 2026-05-27-spx-review-async-booking-history-persistence-changes
title: 2026-05-27 - spx-review async booking history persistence changes
type: session-log
session-date: 2026-05-27
agent: Codex
duration-minutes: 25
outcomes:
  - Ran SPX review flow on the uncommitted async booking history persistence and MySQL load-reduction changes without committing/pushing due repo policy.
  - "Found one review issue: background history queue could accumulate duplicate/unbounded pending trips if MySQL became slow or unavailable."
  - "Added failing regression tests for queue coalescing and bounded backlog, then fixed BookingHistorySaveQueue to coalesce pending trips by request_id, skip active request_ids, cap pending trips, and log overflow drops."
  - "Re-ran focused tests, typecheck, and production build successfully."
created: 2026-05-27
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-05-27 - spx-review async booking history persistence changes

## TL;DR
- Ran SPX review flow on the uncommitted async booking history persistence and MySQL load-reduction changes without committing/pushing due repo policy.
- Found one review issue: background history queue could accumulate duplicate/unbounded pending trips if MySQL became slow or unavailable.
- Added failing regression tests for queue coalescing and bounded backlog, then fixed BookingHistorySaveQueue to coalesce pending trips by request_id, skip active request_ids, cap pending trips, and log overflow drops.
- Re-ran focused tests, typecheck, and production build successfully.

## Goal
spx-review async booking history persistence changes

## What Was Done
- Ran SPX review flow on the uncommitted async booking history persistence and MySQL load-reduction changes without committing/pushing due repo policy.
- Found one review issue: background history queue could accumulate duplicate/unbounded pending trips if MySQL became slow or unavailable.
- Added failing regression tests for queue coalescing and bounded backlog, then fixed BookingHistorySaveQueue to coalesce pending trips by request_id, skip active request_ids, cap pending trips, and log overflow drops.
- Re-ran focused tests, typecheck, and production build successfully.

## Files Touched
- src/services/booking-history-save-queue.ts
- src/controllers/poller.ts
- src/scripts/test-booking-history-save-queue.ts

## Decisions Made
- Do not commit/push/PR/merge during spx-review because the repo instruction says not to perform those actions unless explicitly requested.
- Bound the in-process history queue at 50,000 unique pending request_ids to preserve auto-accept flow under MySQL slowness while preventing unbounded memory growth.
- Coalesce pending trips by request_id because history persistence is idempotent and repeated polls commonly carry the same request IDs.

## Open Follow-ups
- [ ] After deploy, monitor booking-history-queue-drop logs; any nonzero drops mean MySQL is too slow/down for the history background workload.
- [ ] Consider exposing history queue pendingCount/isSaving/dropped count in runtime metrics if operations need dashboard visibility.
- [ ] If zero-loss history is required across hard crashes, replace or supplement the in-process queue with Dragonfly/Redis or another durable queue.

## References
- src/services/booking-history-save-queue.ts
- src/controllers/poller.ts
- src/scripts/test-booking-history-save-queue.ts

## Verification
npx tsx src\scripts\test-booking-history-save-queue.ts passed; npx tsx src\scripts\test-booking-history-repository.ts passed; npm run typecheck passed; npm run build passed with existing Vite chunk-size warning.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
