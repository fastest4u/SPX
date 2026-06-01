---
title: 2026-05-27 - Investigate SPX production auto-accept not keeping up
type: session-log
session-date: 2026-05-27
agent: Codex
duration-minutes: 18
outcomes:
  - SSH read-only investigation of production server root@45.83.207.139.
  - "Confirmed container healthy, production commit fb2fb1b matches local HEAD, /health and /ready pass, session healthy, no poll failures."
  - "Found production DB settings POLL_INTERVAL_MS=300 and BOOKING_DETAIL_CONCURRENCY=50 updated by admin on 2026-05-27T02:51:21Z."
  - "Metrics show about 776-793 polls per 5 minutes after change, tens of thousands of skipped rows per 5 minutes, and recent MySQL deadlock logs from booking history batch save."
  - "Auto-accept failure example 2536624 showed accept call fired immediately and SPX returned partial success: 1 accepted, 3 already timeout/accepted by another agency."
created: 2026-05-27
updated: 2026-05-27
tags:
  - session-log
  - project/general
---
# 2026-05-27 - Investigate SPX production auto-accept not keeping up

## TL;DR
- SSH read-only investigation of production server root@45.83.207.139.
- Confirmed container healthy, production commit fb2fb1b matches local HEAD, /health and /ready pass, session healthy, no poll failures.
- Found production DB settings POLL_INTERVAL_MS=300 and BOOKING_DETAIL_CONCURRENCY=50 updated by admin on 2026-05-27T02:51:21Z.
- Metrics show about 776-793 polls per 5 minutes after change, tens of thousands of skipped rows per 5 minutes, and recent MySQL deadlock logs from booking history batch save.
- Auto-accept failure example 2536624 showed accept call fired immediately and SPX returned partial success: 1 accepted, 3 already timeout/accepted by another agency.

## Goal
Investigate SPX production auto-accept not keeping up

## What Was Done
- SSH read-only investigation of production server root@45.83.207.139.
- Confirmed container healthy, production commit fb2fb1b matches local HEAD, /health and /ready pass, session healthy, no poll failures.
- Found production DB settings POLL_INTERVAL_MS=300 and BOOKING_DETAIL_CONCURRENCY=50 updated by admin on 2026-05-27T02:51:21Z.
- Metrics show about 776-793 polls per 5 minutes after change, tens of thousands of skipped rows per 5 minutes, and recent MySQL deadlock logs from booking history batch save.
- Auto-accept failure example 2536624 showed accept call fired immediately and SPX returned partial success: 1 accepted, 3 already timeout/accepted by another agency.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] Decide whether to reduce production POLL_INTERVAL_MS to a safer value such as 1000-1500ms and BOOKING_DETAIL_CONCURRENCY to 8-20.
- [ ] Consider adding a code-level lower bound/operator warning for POLL_INTERVAL_MS to prevent sub-second production settings from causing API/DB churn.
- [ ] Consider metrics for operation latency/current runtime in persisted metrics so future production investigations do not require authenticated dashboard access.

## References
- 08_Mistakes/auto-accept-verify-queried-only-the-pending-tab-u2014-missed-accepted-requests-on-the-confirmed-tab.md
- 09_Runbooks/Runbook-Auto-Accept-Debug.md

## Verification
Read-only SSH checks: docker compose ps, health/ready curl, git rev-parse, docker stats, filtered logs, and read-only MySQL queries inside app container. No production changes made.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
