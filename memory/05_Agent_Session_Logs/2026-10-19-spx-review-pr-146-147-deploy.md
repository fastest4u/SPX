---
title: "2026-10-19 - spx-review-pr-146-147-deploy"
type: session-log
session-date: "2026-10-19"
agent: codex
outcomes:
  - "PR #146 merged (2fcb661): line-service OCR_SERVICE_URL opt-in; docs updated."
  - "PR #147 merged (39a481a): minimal dashboard header."
  - "Auto-deploy runs 39290013696 and 39290025488 succeeded; primary at 39a481a, /ready 200."
  - "spx-line-service-1 recreated: healthy, no remote OCR env, line-image-listener-started."
  - "Workers healthy: ifn (147.50.240.44), ptwl (45.154.26.83), krtk (primary)."
created: "2026-10-19"
updated: "2026-10-19"
tags:
  - session-log
  - project/general
---
# 2026-10-19 - spx-review-pr-146-147-deploy

## TL;DR
- PR #146 merged (2fcb661): line-service OCR_SERVICE_URL opt-in; docs updated.
- PR #147 merged (39a481a): minimal dashboard header.
- Auto-deploy runs 39290013696 and 39290025488 succeeded; primary at 39a481a, /ready 200.
- spx-line-service-1 recreated: healthy, no remote OCR env, line-image-listener-started.
- Workers healthy: ifn (147.50.240.44), ptwl (45.154.26.83), krtk (primary).

## Goal
spx-review-pr-146-147-deploy

## What Was Done
- PR #146 merged (2fcb661): line-service OCR_SERVICE_URL opt-in; docs updated.
- PR #147 merged (39a481a): minimal dashboard header.
- Auto-deploy runs 39290013696 and 39290025488 succeeded; primary at 39a481a, /ready 200.
- spx-line-service-1 recreated: healthy, no remote OCR env, line-image-listener-started.
- Workers healthy: ifn (147.50.240.44), ptwl (45.154.26.83), krtk (primary).

## Files Touched
- docker-compose.yml
- docs/env-reference.md
- docs/deployment.md
- src/frontend/components/ui/status-indicator.tsx
- src/frontend/routes/index.tsx
- src/frontend/lib/dashboard-runtime-state.ts
- src/frontend/components/ui/switch.tsx
- tests/frontend-dashboard-*.test.ts

## Decisions Made
- Split work into two PRs (#146 deploy fix, #147 dashboard UI) instead of one mixed PR.
- Used gh CLI fallback after GitHub MCP returned Bad credentials (user explicitly approved).
- Ran targeted local tests and relied on PR CI for the full sequential suite (local run would exceed 1 hour).

## Open Follow-ups
- [ ] GitHub MCP token invalid (Bad credentials) - rotate GITHUB_PERSONAL_ACCESS_TOKEN for github-mcp-server.
- [ ] spx-worker-krtk-1 (team 3, primary) ~50% polls rate-limited by SPX retcode=130008001 after restart (38 ok / 39 limited in 2 min); not touched by this change, needs separate investigation.
- [ ] Confirm a real LINE image is OCR'd successfully via local Codex OCR (codex-device-auth token expires 2026-10-29).
- [ ] npm run lint locally scans generated bundles (~70k errors) - consider ignoring output/ and caches in eslint config.

## References
- None

## Verification
Review findings (3x P3) fixed pre-commit; typecheck/build/eslint(changed files) + 10 targeted tests passed locally; PR CI Build Check (full npm test) passed on both PRs; deploy workflows success; production checks on all three hosts.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
