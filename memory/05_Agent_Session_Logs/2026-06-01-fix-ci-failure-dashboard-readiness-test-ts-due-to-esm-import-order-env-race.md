---
title: "2026-06-01 - Fix CI failure: dashboard-readiness.test.ts due to ESM import order env race"
type: session-log
session-date: 2026-06-01
agent: codex
duration-minutes: 20
outcomes:
  - "CI root cause diagnosed: ESM import order caused env.ts to see DB_MODE='mysql' before the test set it to 'memory'"
  - "Single-line fix applied: moved env assignment above imports"
  - All 12 tests passing locally
  - "Build passes (typecheck + esbuild + vite)"
  - No auto-commit or deploy performed per repo policy
created: 2026-06-01
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-06-01 - Fix CI failure: dashboard-readiness.test.ts due to ESM import order env race

## TL;DR
- CI root cause diagnosed: ESM import order caused env.ts to see DB_MODE='mysql' before the test set it to 'memory'
- Single-line fix applied: moved env assignment above imports
- All 12 tests passing locally
- Build passes (typecheck + esbuild + vite)
- No auto-commit or deploy performed per repo policy

## Goal
Fix CI failure: dashboard-readiness.test.ts due to ESM import order env race

## What Was Done
- CI root cause diagnosed: ESM import order caused env.ts to see DB_MODE='mysql' before the test set it to 'memory'
- Single-line fix applied: moved env assignment above imports
- All 12 tests passing locally
- Build passes (typecheck + esbuild + vite)
- No auto-commit or deploy performed per repo policy

## Files Touched
- tests/dashboard-readiness.test.ts

## Decisions Made
- Move process.env.DB_MODE = 'memory' to line 1 in tests/dashboard-readiness.test.ts, above all import statements, to ensure env.ts sees 'memory' at module load time
- Do NOT auto-commit the fix; stop at verification and wait for user decision per repo policy

## Open Follow-ups
- [ ] User to decide when to commit the dashboard-readiness.test.ts fix and push to main

## References
- tests/dashboard-readiness.test.ts:1
- src/config/env.ts:115
- src/db/client.ts:1-52

## Verification
npm test (12/12 PASS) and npm run build (PASS) verified locally

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Root cause is module load ordering in ESM: env.ts reads process.env.DB_MODE at import time | high | CI test dashboard-readiness.test.ts failed on GitHub Actions because env.ts loaded DB_MODE as 'mysql' before process.env.DB_MODE was set to 'memory' | In ESM, all imports execute before top-level code. To control env-dependent module behavior in tests, set process.env BEFORE any import statements |
