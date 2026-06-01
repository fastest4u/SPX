---
aliases:
  - 2026-05-27-verify-production-after-async-booking-history-deploy
title: 2026-05-27 - Verify production after async booking history deploy
type: session-log
session-date: 2026-05-27
agent: Codex
duration-minutes: 20
outcomes:
  - "Production /root/SPX is running merged commit 839e3cc (feat: make booking history persistence asynchronous #37)."
  - "spx-app-1 container is running and Docker health is healthy with restartCount=0."
  - "/health and /ready endpoints returned success/ready with errorRate=0 and consecutiveErrors=0."
  - "Post-deploy logs showed no booking-history queue drops, async save failures, batch save failures, deadlocks, poll failures, or backpressure events."
  - "Resource snapshot was acceptable: CPU about 58.64%, memory about 96 MiB of 1.921 GiB."
created: 2026-05-27
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-05-27 - Verify production after async booking history deploy

## TL;DR
- Production /root/SPX is running merged commit 839e3cc (feat: make booking history persistence asynchronous #37).
- spx-app-1 container is running and Docker health is healthy with restartCount=0.
- /health and /ready endpoints returned success/ready with errorRate=0 and consecutiveErrors=0.
- Post-deploy logs showed no booking-history queue drops, async save failures, batch save failures, deadlocks, poll failures, or backpressure events.
- Resource snapshot was acceptable: CPU about 58.64%, memory about 96 MiB of 1.921 GiB.

## Goal
Verify production after async booking history deploy

## What Was Done
- Production /root/SPX is running merged commit 839e3cc (feat: make booking history persistence asynchronous #37).
- spx-app-1 container is running and Docker health is healthy with restartCount=0.
- /health and /ready endpoints returned success/ready with errorRate=0 and consecutiveErrors=0.
- Post-deploy logs showed no booking-history queue drops, async save failures, batch save failures, deadlocks, poll failures, or backpressure events.
- Resource snapshot was acceptable: CPU about 58.64%, memory about 96 MiB of 1.921 GiB.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] Keep monitoring booking-history-queue-drop; any nonzero count means history persistence is falling behind MySQL capacity.
- [ ] Consider exposing queue depth/drop counters in metrics dashboard for easier production observation.
- [ ] If auto-accept still misses work, next check should focus on poll timing, API latency, and accept request path rather than history persistence.

## References
- GitHub Actions run 26491079802 succeeded for commit 839e3cc
- PR #37 https://github.com/fastest4u/SPX/pull/37

## Verification
Read-only SSH checks on root@45.83.207.139: git rev-parse/log in /root/SPX, docker compose ps, docker inspect health/restart count, curl /health and /ready, targeted docker logs grep counts since deploy, and docker stats single snapshot.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
