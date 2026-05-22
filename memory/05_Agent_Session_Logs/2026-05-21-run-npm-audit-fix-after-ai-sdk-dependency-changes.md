---
title: 2026-05-21 - Run npm audit fix after AI SDK dependency changes
type: session-log
session-date: 2026-05-21
agent: opencode
duration-minutes: 8
outcomes:
  - "Ran `npm audit fix`; it upgraded non-breaking dependency ranges including `@evex/linejs` from 2.6.1 lockfile entry to 2.18.0 and `brace-expansion` to 5.0.6."
  - "Rechecked audit findings; 2 high vulnerabilities remain through `thrift@0.20.0` under `@evex/linejs`."
  - "Did not run `npm audit fix --force` because npm reports it would install `@jsr/evex__linejs@0.0.2`, a breaking downgrade."
  - "Verified `npm run typecheck` and `npm run build` still pass after audit fix."
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Run npm audit fix after AI SDK dependency changes

## TL;DR
- Ran `npm audit fix`; it upgraded non-breaking dependency ranges including `@evex/linejs` from 2.6.1 lockfile entry to 2.18.0 and `brace-expansion` to 5.0.6.
- Rechecked audit findings; 2 high vulnerabilities remain through `thrift@0.20.0` under `@evex/linejs`.
- Did not run `npm audit fix --force` because npm reports it would install `@jsr/evex__linejs@0.0.2`, a breaking downgrade.
- Verified `npm run typecheck` and `npm run build` still pass after audit fix.

## Goal
Run npm audit fix after AI SDK dependency changes

## What Was Done
- Ran `npm audit fix`; it upgraded non-breaking dependency ranges including `@evex/linejs` from 2.6.1 lockfile entry to 2.18.0 and `brace-expansion` to 5.0.6.
- Rechecked audit findings; 2 high vulnerabilities remain through `thrift@0.20.0` under `@evex/linejs`.
- Did not run `npm audit fix --force` because npm reports it would install `@jsr/evex__linejs@0.0.2`, a breaking downgrade.
- Verified `npm run typecheck` and `npm run build` still pass after audit fix.

## Files Touched
- package.json
- package-lock.json

## Decisions Made
- Do not apply `npm audit fix --force` without explicit approval because it would make a breaking dependency change to the LINE library.

## Open Follow-ups
- [ ] Decide whether to accept `npm audit fix --force` breaking downgrade for `@evex/linejs` or track/upstream a patched thrift dependency.

## References
- package.json
- package-lock.json

## Verification
`npm audit fix` completed; `npm audit --audit-level=moderate` still reports 2 high `thrift` vulnerabilities requiring `--force`; `npm run typecheck` passed; `npm run build` passed with existing Vite NODE_ENV warning.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Non-force audit fixes are applied and the remaining audit issue requires a breaking forced change. | high | npm audit output explicitly reported `npm audit fix --force` would install `@jsr/evex__linejs@0.0.2`, a breaking change. | Avoid force audit fixes on app dependencies without user approval and a targeted regression test plan. |
