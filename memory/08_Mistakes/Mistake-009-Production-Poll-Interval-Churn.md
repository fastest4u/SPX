---
aliases:
  - production-poll-interval-too-low-caused-api-db-churn-without-improving-auto-accept-wins
title: Production poll interval too low caused API/DB churn without improving auto-accept wins
type: mistake
severity: medium
status: open
occurred-date: 2026-05-27
agent: Codex
area: production auto-accept settings
confidence: high
created: 2026-05-27
updated: 2026-06-01
tags:
  - area/production auto-accept settings
  - topic/memory-vault
---
## Problem
Production DB-backed settings allowed POLL_INTERVAL_MS=300 and BOOKING_DETAIL_CONCURRENCY=50. The poller generated tens of thousands of booking detail cycles, huge skipped-row churn, and MySQL deadlocks while not guaranteeing wins against competing agencies.

## Root Cause
Runtime validation only requires POLL_INTERVAL_MS to be a positive integer, so operationally dangerous sub-second intervals are accepted. Production settings are loaded from DB and can override safer defaults live.

## Avoidance
Before lowering production polling below 1000ms, check metrics_snapshots deltas, docker logs for booking-history-batch-save-failed, and upstream latency. Add/keep a sane lower bound or operator warning for POLL_INTERVAL_MS and avoid high BOOKING_DETAIL_CONCURRENCY unless verified under load.

## References
- 09_Runbooks/Runbook-Auto-Accept-Debug.md
- 05_Agent_Session_Logs/2026-05-25-Auto-Accept-Dual-Tab-Verify.md
