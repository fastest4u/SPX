---
aliases:
  - 2026-05-27-explain-current-spx-runtime-flow-after-async-booking-history-release
title: 2026-05-27 - Explain current SPX runtime flow after async booking history release
type: session-log
session-date: 2026-05-27
agent: Codex
duration-minutes: 6
outcomes:
  - "Explained current runtime flow: poller fetches booking list, schedules bounded background detail jobs, prioritizes origin-matching bookings, starts auto-accept from detail results, and enqueues history persistence asynchronously."
  - "Clarified that booking history no longer blocks auto-accept/detail critical path, but auto-accept tasks are still awaited inside their detail job while the poll loop continues subject to active detail job limits."
  - "Documented important operational caveats: in-process history queue is not durable across hard crashes, queue overflow logs booking-history-queue-drop, and durable queues like Dragonfly/Redis remain a future option if zero-loss history is required."
created: 2026-05-27
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-05-27 - Explain current SPX runtime flow after async booking history release

## TL;DR
- Explained current runtime flow: poller fetches booking list, schedules bounded background detail jobs, prioritizes origin-matching bookings, starts auto-accept from detail results, and enqueues history persistence asynchronously.
- Clarified that booking history no longer blocks auto-accept/detail critical path, but auto-accept tasks are still awaited inside their detail job while the poll loop continues subject to active detail job limits.
- Documented important operational caveats: in-process history queue is not durable across hard crashes, queue overflow logs booking-history-queue-drop, and durable queues like Dragonfly/Redis remain a future option if zero-loss history is required.

## Goal
Explain current SPX runtime flow after async booking history release

## What Was Done
- Explained current runtime flow: poller fetches booking list, schedules bounded background detail jobs, prioritizes origin-matching bookings, starts auto-accept from detail results, and enqueues history persistence asynchronously.
- Clarified that booking history no longer blocks auto-accept/detail critical path, but auto-accept tasks are still awaited inside their detail job while the poll loop continues subject to active detail job limits.
- Documented important operational caveats: in-process history queue is not durable across hard crashes, queue overflow logs booking-history-queue-drop, and durable queues like Dragonfly/Redis remain a future option if zero-loss history is required.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] Continue monitoring production booking-history-queue-drop logs after release.
- [ ] Consider exposing history queue pendingCount/isSaving/dropped count in runtime metrics if operations need dashboard visibility.
- [ ] If zero-loss history is required across hard crashes, replace or supplement the in-process queue with Dragonfly/Redis or another durable queue.

## References
- None

## Verification
Read current source in src/controllers/poller.ts, src/services/booking-history-save-queue.ts, and src/repositories/booking-history-repository.ts; cross-checked memory follow-ups from async history deployment/release.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
