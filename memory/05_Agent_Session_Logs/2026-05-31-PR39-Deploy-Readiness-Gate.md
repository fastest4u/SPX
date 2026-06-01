---
aliases:
  - 2026-05-31-spx-review-pr-39-deploy-readiness-health-gate
title: 2026-05-31 - spx-review PR #39 deploy readiness health gate
type: session-log
session-date: 2026-05-31
agent: codex
duration-minutes: 18
outcomes:
  - Created PR #39 for fix/deploy-readiness-health-gate and requested Copilot review.
  - Found and fixed deploy readiness retry weakness by adding curl --retry-connrefused plus bounded connect/max/retry timing.
  - Verified focused readiness behavior and production build locally.
  - Squash-merged PR #39 into main at 6ea35fa.
  - "Confirmed production server source and container are on 6ea35fa, /ready returns 200, container health is healthy, and no booking history rows were inserted after the new container build timestamp."
created: 2026-05-31
updated: 2026-06-01
tags:
  - session-log
  - project/spx
---
# 2026-05-31 - spx-review PR #39 deploy readiness health gate

## TL;DR
- Created PR #39 for fix/deploy-readiness-health-gate and requested Copilot review.
- Found and fixed deploy readiness retry weakness by adding curl --retry-connrefused plus bounded connect/max/retry timing.
- Verified focused readiness behavior and production build locally.
- Squash-merged PR #39 into main at 6ea35fa.
- Confirmed production server source and container are on 6ea35fa, /ready returns 200, container health is healthy, and no booking history rows were inserted after the new container build timestamp.

## Goal
spx-review PR #39 deploy readiness health gate

## What Was Done
- Created PR #39 for fix/deploy-readiness-health-gate and requested Copilot review.
- Found and fixed deploy readiness retry weakness by adding curl --retry-connrefused plus bounded connect/max/retry timing.
- Verified focused readiness behavior and production build locally.
- Squash-merged PR #39 into main at 6ea35fa.
- Confirmed production server source and container are on 6ea35fa, /ready returns 200, container health is healthy, and no booking history rows were inserted after the new container build timestamp.

## Files Touched
- .github/workflows/deploy.yml
- src/controllers/dashboard-controller.ts
- tests/dashboard-readiness.test.ts

## Decisions Made
- Use /ready rather than /health as the production deploy rollback gate so upstream SPX session failures do not roll back otherwise healthy app deploys.
- Treat absent PR check runs as no CI configured for the PR branch and rely on local focused test plus npm run build.

## Open Follow-ups
- [ ] Production /health returned 503 after deployment because poller/session health is degraded; this is intentionally separate from /ready but still needs operational follow-up if live polling should be healthy.
- [ ] BIDDING_VEHICLE_TYPE is not explicitly set in the container environment; executable config defaults it to 13, so confirm whether the default is intended for production.

## References
- https://github.com/fastest4u/SPX/pull/39
- https://github.com/fastest4u/SPX/commit/6ea35fa12dd5754da9cb6b058441528afb28d452

## Verification
npx tsx tests\dashboard-readiness.test.ts passed; npm run build passed; GitHub PR #39 had no check runs configured and no unresolved review threads; production read-only checks: server HEAD 6ea35fa, spx-app-1 recreated from image created 2026-05-31T04:40:59Z, /ready HTTP 200, Docker health healthy, recent post-build vehicle_type aggregate returned [].

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
