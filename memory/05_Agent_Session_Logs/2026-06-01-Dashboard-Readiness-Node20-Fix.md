---
aliases:
  - 2026-06-01-fix-github-actions-dashboard-readiness-ci-failure-on-node-20
title: 2026-06-01 - Fix GitHub Actions dashboard readiness CI failure on Node 20
type: session-log
session-date: 2026-06-01
agent: codex
duration-minutes: 55
outcomes:
  - "Diagnosed GitHub Actions run 26738635707 as Build Check/Test failure, with Deploy Production skipped because build failed."
  - "Confirmed DB_MODE issue was fixed; remaining failure was dashboard-readiness.test.ts receiving /health 200 on Node 20/Linux despite local Node 24 passing."
  - "Reproduced the failure in Docker node:20.20.2-bookworm and identified a tsx/Node 20 module singleton duplication pattern between the test metrics import and dashboard-controller metrics import."
  - Refactored dashboard health response calculation into buildDashboardHealthResponse and updated dashboard-readiness.test.ts to assert degraded health via that shared helper while still verifying /ready route returns 200.
  - "Removed diagnostic console logging from dashboard-controller.ts, db/client.ts, and dashboard-readiness.test.ts."
  - "Verified the CI-equivalent gate in Docker Node 20: npm run lint, npm run build, and npm test all passed with 12/12 tests."
created: 2026-06-01
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-06-01 - Fix GitHub Actions dashboard readiness CI failure on Node 20

## TL;DR
- Diagnosed GitHub Actions run 26738635707 as Build Check/Test failure, with Deploy Production skipped because build failed.
- Confirmed DB_MODE issue was fixed; remaining failure was dashboard-readiness.test.ts receiving /health 200 on Node 20/Linux despite local Node 24 passing.
- Reproduced the failure in Docker node:20.20.2-bookworm and identified a tsx/Node 20 module singleton duplication pattern between the test metrics import and dashboard-controller metrics import.
- Refactored dashboard health response calculation into buildDashboardHealthResponse and updated dashboard-readiness.test.ts to assert degraded health via that shared helper while still verifying /ready route returns 200.
- Removed diagnostic console logging from dashboard-controller.ts, db/client.ts, and dashboard-readiness.test.ts.
- Verified the CI-equivalent gate in Docker Node 20: npm run lint, npm run build, and npm test all passed with 12/12 tests.

## Goal
Fix GitHub Actions dashboard readiness CI failure on Node 20

## What Was Done
- Diagnosed GitHub Actions run 26738635707 as Build Check/Test failure, with Deploy Production skipped because build failed.
- Confirmed DB_MODE issue was fixed; remaining failure was dashboard-readiness.test.ts receiving /health 200 on Node 20/Linux despite local Node 24 passing.
- Reproduced the failure in Docker node:20.20.2-bookworm and identified a tsx/Node 20 module singleton duplication pattern between the test metrics import and dashboard-controller metrics import.
- Refactored dashboard health response calculation into buildDashboardHealthResponse and updated dashboard-readiness.test.ts to assert degraded health via that shared helper while still verifying /ready route returns 200.
- Removed diagnostic console logging from dashboard-controller.ts, db/client.ts, and dashboard-readiness.test.ts.
- Verified the CI-equivalent gate in Docker Node 20: npm run lint, npm run build, and npm test all passed with 12/12 tests.

## Files Touched
- src/controllers/dashboard-controller.ts
- src/db/client.ts
- tests/dashboard-readiness.test.ts

## Decisions Made
- Do not switch CI to Node 24 as the primary fix because the test should pass on the current Node 20 CI runtime and production-adjacent runtime too.
- Use a pure exported health response helper to avoid brittle test coupling to a singleton that tsx can duplicate under Node 20/Linux.
- Do not commit, push, or deploy automatically; leave the code fix local for the user to decide per repo policy.

## Open Follow-ups
- [ ] Commit and push the local fix when the user is ready so GitHub Actions can rerun against the corrected branch/main.
- [ ] Optionally update .github/workflows/deploy.yml from actions/setup-node@v5/node 20 to setup-node@v6/node 24 after deciding production/runtime version alignment.
- [ ] Existing untracked prior session log and memory MCP state remain in the working tree; review/stage intentionally before any commit.

## References
- None

## Verification
Docker Node 20 CI-equivalent gate passed: npm run lint, npm run build, and npm test (12/12 PASS). Targeted dashboard-readiness also passed locally and in Docker Node 20.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
