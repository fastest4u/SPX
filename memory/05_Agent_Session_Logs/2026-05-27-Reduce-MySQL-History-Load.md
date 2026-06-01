---
aliases:
  - 2026-05-27-reduce-mysql-load-when-saving-spx-booking-history
title: 2026-05-27 - Reduce MySQL load when saving SPX booking history
type: session-log
session-date: 2026-05-27
agent: Codex
duration-minutes: 35
outcomes:
  - Added booking history batch dedupe before persistence so repeated request_id values in the same poll are skipped before DB work.
  - Added in-process TTL cache for seen booking history request IDs so repeated polls can skip both SELECT and INSERT for known records during the process lifetime.
  - Added MySQL prefilter SELECT against request_id unique index and narrowed INSERT IGNORE to only records not already known in cache or DB.
  - Preserved INSERT IGNORE as final race guard for concurrent writers.
  - Added focused repository helper test script for dedupe and known-ID filtering.
  - Verified with focused test and full npm typecheck.
created: 2026-05-27
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-05-27 - Reduce MySQL load when saving SPX booking history

## TL;DR
- Added booking history batch dedupe before persistence so repeated request_id values in the same poll are skipped before DB work.
- Added in-process TTL cache for seen booking history request IDs so repeated polls can skip both SELECT and INSERT for known records during the process lifetime.
- Added MySQL prefilter SELECT against request_id unique index and narrowed INSERT IGNORE to only records not already known in cache or DB.
- Preserved INSERT IGNORE as final race guard for concurrent writers.
- Added focused repository helper test script for dedupe and known-ID filtering.
- Verified with focused test and full npm typecheck.

## Goal
Reduce MySQL load when saving SPX booking history

## What Was Done
- Added booking history batch dedupe before persistence so repeated request_id values in the same poll are skipped before DB work.
- Added in-process TTL cache for seen booking history request IDs so repeated polls can skip both SELECT and INSERT for known records during the process lifetime.
- Added MySQL prefilter SELECT against request_id unique index and narrowed INSERT IGNORE to only records not already known in cache or DB.
- Preserved INSERT IGNORE as final race guard for concurrent writers.
- Added focused repository helper test script for dedupe and known-ID filtering.
- Verified with focused test and full npm typecheck.

## Files Touched
- src/repositories/booking-history-repository.ts
- src/scripts/test-booking-history-repository.ts

## Decisions Made
- Use local in-process cache first instead of introducing Dragonfly/Redis dependency for this narrow MySQL load reduction.
- Keep skipped count based on original input length minus inserted rows to preserve existing metrics contract.
- Keep memory DB mode simple by deduping within batch but avoiding shared MySQL seen-cache behavior.

## Open Follow-ups
- [ ] After deploy, watch metrics for lower trips_skipped DB churn and absence of booking-history-batch-save-failed deadlocks.
- [ ] Consider exposing cache hit / DB prefilter counts in metrics if operational visibility is needed.

## References
- src/repositories/booking-history-repository.ts
- src/scripts/test-booking-history-repository.ts

## Verification
npx tsx src\scripts\test-booking-history-repository.ts passed; npm run typecheck passed.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
