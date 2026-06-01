---
aliases:
  - merged-feature-not-deployed-left-production-running-stale-spx-code
title: Merged feature not deployed left production running stale SPX code
type: mistake
severity: high
status: open
occurred-date: 2026-05-31
agent: codex
area: production deploy / runtime verification
confidence: high
created: 2026-05-31
updated: 2026-06-01
tags:
  - project/spx
  - area/production deploy / runtime verification
  - topic/memory-vault
---
## Problem
Production kept recording 4WH booking history after the BIDDING_VEHICLE_TYPE filter had been merged because the server repository/container was still running the pre-filter commit.

## Root Cause
The review/merge workflow did not require a post-merge production head/container/runtime verification, and deployment/restart remained pending after merge.

## Avoidance
After any production-relevant merge, run a read-only production check comparing local/remote HEAD to server /root/SPX HEAD, container build contents, runtime env/app_settings keys, and a behavior/DB aggregate. Report deployment pending instead of claiming production behavior is active.

## References
- .agents/skills/spx-review/SKILL.md
- 05_Agent_Session_Logs/2026-05-30-Bidding-Vehicle-Type-Payload.md
