---
aliases:
  - 2026-05-27-plan-fix-for-insert-ignore-duplicate-db-churn
title: 2026-05-27 - Plan fix for INSERT IGNORE duplicate DB churn
type: session-log
session-date: 2026-05-27
agent: Codex
duration-minutes: 4
outcomes:
  - "Explained that INSERT IGNORE should remain as a final race-condition guard, not the primary duplicate filter."
  - Recommended app-side dedupe plus DB prefilter before insert to avoid submitting known duplicate request_ids on every poll.
  - "Tied recommendation to recent production finding: sub-second polling created huge skipped-row churn and occasional MySQL deadlocks."
created: 2026-05-27
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-05-27 - Plan fix for INSERT IGNORE duplicate DB churn

## TL;DR
- Explained that INSERT IGNORE should remain as a final race-condition guard, not the primary duplicate filter.
- Recommended app-side dedupe plus DB prefilter before insert to avoid submitting known duplicate request_ids on every poll.
- Tied recommendation to recent production finding: sub-second polling created huge skipped-row churn and occasional MySQL deadlocks.

## Goal
Plan fix for INSERT IGNORE duplicate DB churn

## What Was Done
- Explained that INSERT IGNORE should remain as a final race-condition guard, not the primary duplicate filter.
- Recommended app-side dedupe plus DB prefilter before insert to avoid submitting known duplicate request_ids on every poll.
- Tied recommendation to recent production finding: sub-second polling created huge skipped-row churn and occasional MySQL deadlocks.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] Implement insertBookingHistories optimization: dedupe incoming batch by requestId, SELECT existing request_ids, then INSERT IGNORE only missing rows.
- [ ] Consider adding a lower bound/operator warning for POLL_INTERVAL_MS to prevent sub-second DB/API churn.

## References
- 08_Mistakes/Mistake-009-Production-Poll-Interval-Churn.md

## Verification
Planning-only answer based on current repository code and memory context; no files changed.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
