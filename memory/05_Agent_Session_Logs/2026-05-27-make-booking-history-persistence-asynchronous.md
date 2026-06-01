---
title: 2026-05-27 - Make booking history persistence asynchronous
type: session-log
session-date: 2026-05-27
agent: Codex
duration-minutes: 45
outcomes:
  - Added BookingHistorySaveQueue to decouple booking history saves from the poller/detail critical path.
  - Queue enqueue returns immediately and serializes DB saves one batch at a time to avoid adding concurrent MySQL write pressure.
  - Poller now enqueues history saves instead of awaiting saveBookingRequests during processBookingDetails.
  - Poller shutdown now flushes queued history saves before closing DB and persists final metrics after active work completes.
  - Added focused queue test script proving a second enqueue waits behind an active save instead of running concurrently.
created: 2026-05-27
updated: 2026-05-27
tags:
  - session-log
  - project/general
---
# 2026-05-27 - Make booking history persistence asynchronous

## TL;DR
- Added BookingHistorySaveQueue to decouple booking history saves from the poller/detail critical path.
- Queue enqueue returns immediately and serializes DB saves one batch at a time to avoid adding concurrent MySQL write pressure.
- Poller now enqueues history saves instead of awaiting saveBookingRequests during processBookingDetails.
- Poller shutdown now flushes queued history saves before closing DB and persists final metrics after active work completes.
- Added focused queue test script proving a second enqueue waits behind an active save instead of running concurrently.

## Goal
Make booking history persistence asynchronous

## What Was Done
- Added BookingHistorySaveQueue to decouple booking history saves from the poller/detail critical path.
- Queue enqueue returns immediately and serializes DB saves one batch at a time to avoid adding concurrent MySQL write pressure.
- Poller now enqueues history saves instead of awaiting saveBookingRequests during processBookingDetails.
- Poller shutdown now flushes queued history saves before closing DB and persists final metrics after active work completes.
- Added focused queue test script proving a second enqueue waits behind an active save instead of running concurrently.

## Files Touched
- src/services/booking-history-save-queue.ts
- src/controllers/poller.ts
- src/scripts/test-booking-history-save-queue.ts

## Decisions Made
- Use a serialized in-process queue instead of unbounded fire-and-forget promises so history persistence does not block polling but also does not create multiple concurrent MySQL insert batches.
- Flush the queue during graceful shutdown to reduce risk of losing pending history records.
- Keep metrics accounting in Poller callbacks so inserted/skipped counts still update when async saves finish.

## Open Follow-ups
- [ ] After deploy, monitor whether active detail jobs release faster and whether dbSave latency no longer extends booking-detail job lifetime.
- [ ] Consider exposing history queue pendingCount/isSaving in runtime metrics if operational visibility is needed.
- [ ] If process crashes hard, any queued but unsaved history records can still be lost; use Dragonfly or durable queue only if that risk is unacceptable.

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
