---
title: "2026-05-14 - Repository Guidelines AGENTS"
type: session-log
session-date: 2026-05-14
agent: codex
duration-minutes: 25
outcomes:
  - Replaced root AGENTS.md with a concise repository contributor guide.
  - Grounded guide content in package scripts, source layout, git history, and Memory Vault rules.
created: 2026-05-14
updated: 2026-05-14
tags:
  - session-log
  - project/spx
  - topic/docs
  - topic/memory-vault
thread: docs-maintenance
---

# 2026-05-14 - Repository Guidelines AGENTS

> [!abstract] Summary
> Root `AGENTS.md` now matches the requested "Repository Guidelines" contributor-guide format while preserving SPX-specific commands, structure, safety notes, and Memory Vault workflow expectations.

## Summary

- Rewrote root `AGENTS.md` as a 391-word contributor guide.
- Used executable config and current repository files as source of truth.

## Goal

Generate a clear, concise `AGENTS.md` contributor guide for this repository.

## Log

- Loaded SPX Memory Vault startup context and docs-drift guidance.
- Read `package.json`, existing `AGENTS.md`, `README.md`, `tsconfig.json`, `vite.config.ts`, `.github/workflows/deploy.yml`, `.npmrc`, sampled backend/frontend source, and recent git log.
- Noted `rg` is unavailable in this PowerShell environment and used `Get-ChildItem` instead.
- Replaced root `AGENTS.md` with the requested guide and trimmed it to 391 words.

## What Was Done

- [x] Added project structure and module ownership guidance.
- [x] Listed build, development, schema, memory, and verification commands.
- [x] Documented style, testing, commit/PR, and security/agent rules.

## Verification

- [x] Confirmed `AGENTS.md` title is `Repository Guidelines`.
- [x] Confirmed word count is 391.
- [x] `npm run memory:verify` passed after this log; initial score was 95/100 only because this line was still unchecked during the run.

## Follow-ups

None.

## Files Touched

- `AGENTS.md` - replaced the previous long agent instruction file with the requested contributor guide.
- `memory/05_Agent_Session_Logs/2026-05-14-Repository-Guidelines-AGENTS.md` - this session log.

## Decisions Made

- Kept root guide concise and source-grounded rather than reproducing the full prior operational rule set.
- Preserved the Memory Vault startup/closeout rule in the guide because it remains active project workflow.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Root guide should be 200-400 words | high | first draft was 479 words, then trimmed to 391 | Verify word count before finalizing concise docs |

## Insights / Learnings

- Contributor guides should cite current scripts and source layout, not README examples when README content may be stale.

## Open Issues / Follow-ups

None.

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All edited notes have updated `updated:` field where applicable
> - [x] Wikilinks not required for this narrow docs log
> - [x] Tagged with at least 2 taxonomy tags
> - [x] No file with more than 1 unrelated H2
> - [x] Session log written

## References

- [[Runbook-Docs-Drift-Cleanup]]
- [[Source-Grounded-Documentation]]
- [[Mistake-002-Stale-Memory-Docs-Overrode-Source]]
