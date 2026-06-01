---
aliases:
  - 2026-06-01-follow-up-fix-inject-db-mode-memory-into-test-runner-child-process-env-for-ci
title: "2026-06-01 - Follow-up fix: inject DB_MODE=memory into test runner child process env for CI"
type: session-log
session-date: 2026-06-01
agent: codex
duration-minutes: 15
outcomes:
  - "Diagnosed why PR #41 fix didn't work on CI: ESM import hoisting + Node.js 20 behavior"
  - "Applied robust fix: inject DB_MODE=memory into test runner child process environment"
  - Created and merged PR #42
  - All 12 tests passing locally
  - Deleted debug test file
created: 2026-06-01
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-06-01 - Follow-up fix: inject DB_MODE=memory into test runner child process env for CI

## TL;DR
- Diagnosed why PR #41 fix didn't work on CI: ESM import hoisting + Node.js 20 behavior
- Applied robust fix: inject DB_MODE=memory into test runner child process environment
- Created and merged PR #42
- All 12 tests passing locally
- Deleted debug test file

## Goal
Follow-up fix: inject DB_MODE=memory into test runner child process env for CI

## What Was Done
- Diagnosed why PR #41 fix didn't work on CI: ESM import hoisting + Node.js 20 behavior
- Applied robust fix: inject DB_MODE=memory into test runner child process environment
- Created and merged PR #42
- All 12 tests passing locally
- Deleted debug test file

## Files Touched
- scripts/run-tests.mjs

## Decisions Made
- Fix the root cause by injecting DB_MODE=memory into test runner child process env at spawn time
- Do NOT remove per-test process.env.DB_MODE assignments โ€” keep them as fallback for direct test execution
- Create PR #42 for the test runner fix and merge via gh CLI

## Open Follow-ups
- [ ] Monitor CI run on main after PR #42 merge to confirm dashboard-readiness.test.ts passes on GitHub Actions

## References
- scripts/run-tests.mjs:37
- tests/dashboard-readiness.test.ts:1-4
- src/config/env.ts:100-115

## Verification
npm test (12/12 PASS) and npm run lint (PASS) verified locally

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Moving process.env.DB_MODE before imports would fix the CI failure | high | CI still failed after moving process.env.DB_MODE before imports because ESM hoists static imports before module body code, and env.ts was being loaded via dynamic imports that still somehow saw DB_MODE as 'mysql' on CI (likely due to Node.js 20 ESM loader behavior differences or tsx transpilation) | Test-level process.env assignments are fragile across Node versions and ESM loaders. Inject test-specific env vars at the test runner spawn level instead |
| Static imports in ESM are hoisted and evaluated before module body code | high | Debug test with static import of env.ts proved ESM hoists imports before body code, confirming env.ts reads process.env before any test-level assignment can run | ESM module loading order is strict: parse -> load static deps -> execute body. Any env-dependent module must see the env var before it is loaded |
