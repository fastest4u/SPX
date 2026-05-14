---
title: "2026-05-14 - Compact Agents Instructions"
type: session-log
session-date: 2026-05-14
agent: opencode
duration-minutes: 35
outcomes:
  - Audited executable repo config, deploy workflow, root docs, existing agent instructions, and representative source entrypoints.
  - Replaced root AGENTS.md with a compact, verified instruction set for future OpenCode sessions.
  - Removed stale guidance that claimed there was no CI workflow and highlighted current GitHub Actions deploy behavior.
created: 2026-05-14
updated: 2026-05-14
tags:
  - session-log
  - project/spx
  - topic/agent-instructions
  - topic/memory-vault
thread: agent-instructions
related-sessions:
  - "[[2026-05-13-Strict-Review-Workflow-Gate]]"
  - "[[2026-05-13-Full-Verify-Gate]]"
---

# 2026-05-14 - Compact Agents Instructions

> [!abstract] TL;DR
> Root `AGENTS.md` is now shorter and source-grounded. It keeps the Memory Vault workflow, true local gates, deploy behavior, runtime/env gotchas, and SPX architecture traps future agents are likely to miss.

## Goal

Create or update root `AGENTS.md` so future OpenCode sessions can ramp up quickly without stale or generic instructions.

## What Was Done

- [x] Read Memory Vault startup files and recent relevant session logs.
- [x] Audited `README.md`, `package.json`, `package-lock.json`, TypeScript configs, `vite.config.ts`, `.github/workflows/deploy.yml`, `Dockerfile`, `docker-compose.yml`, `.gitignore`, `.env.example`, `.npmrc`, root `AGENTS.md`, and strict review workflow.
- [x] Inspected representative source files for boot order, env loading, polling, API endpoint derivation, notify-rule storage, DB schema/runtime creation, settings redaction, HTTP server wiring, frontend route generation, and migration behavior.
- [x] Rewrote root `AGENTS.md` from 133 instruction lines to 53 compact lines while preserving verified high-signal guidance.

## Files Touched

- `AGENTS.md` - compacted and corrected repo-level agent instructions.
- `memory/05_Agent_Session_Logs/2026-05-14-Compact-Agents-Instructions.md` - this session log.

## Decisions Made

- Keep root `AGENTS.md` as the fast operational entrypoint and leave deeper Memory Vault schemas in `memory/AGENTS.md`.
- Treat `.github/workflows/deploy.yml` as the deploy source of truth because it proves the current CI/deploy behavior.
- Call out `LINE_NOTIFY_TOKEN` as stale documentation because current code uses `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_USER_ID` instead.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Root instructions claimed there was no CI workflow | high | Corrected after reading `.github/workflows/deploy.yml` | Trust executable workflow files over existing prose |

## Insights / Learnings

- Root `AGENTS.md` had useful SPX details but was mixing Memory Vault tutorial content with operational rules; compacting it makes stale claims easier to spot.
- `.env.example` and `README.md` still reference old LINE Notify naming, while `src/config/env.ts` defines the actual notification variables.

## Open Issues / Follow-ups

- [x] Consider updating `README.md` and `.env.example` later to replace stale `LINE_NOTIFY_TOKEN` references, if the user wants docs cleanup.

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All edited notes have updated `updated:` field
> - [x] Wikilinks added to related notes
> - [x] Tagged with at least 2 taxonomy tags
> - [x] No file with more than 1 unrelated H2
> - [x] Session log written

## References

- Root instructions: `AGENTS.md`
- Deploy workflow: `.github/workflows/deploy.yml`
- Runtime env: `src/config/env.ts`
- Boot flow: `src/app.ts`
- Polling orchestration: `src/controllers/poller.ts`
- Related Memory Vault rules: [[AGENTS]], [[SPX-Project-Rules]]
