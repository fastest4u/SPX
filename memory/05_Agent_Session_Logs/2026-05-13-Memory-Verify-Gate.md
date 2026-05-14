---
title: "2026-05-13 - Memory Verify Gate"
type: session-log
session-date: 2026-05-13
agent: codex
duration-minutes: 20
outcomes:
  - Added one-command Memory Vault verification gate.
  - Updated memory docs to make `memory:verify` the default post-edit check.
  - Verified the new gate and full build.
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - topic/memory-vault
thread: verification
related-sessions:
  - "[[2026-05-13-Full-Verify-Gate]]"
  - "[[2026-05-13-Memory-Quality-And-Deploy-Safety]]"
---

# 2026-05-13 - Memory Verify Gate

> [!abstract] TL;DR
> Added `npm run memory:verify` as the single default Memory Vault health gate. It runs `memory:check` and `memory:eval` in sequence.

## Goal

Create one command that validates the Awakened AI memory system after Memory Vault edits.

## What Was Done

- [x] Added `memory:verify` to `package.json`.
- [x] Updated root `AGENTS.md` and memory docs to prefer `npm run memory:verify`.
- [x] Updated [[Memory-Evaluation-Test]], [[Vault-Dashboard]], [[SPX-Project-Rules]], [[Awakened-AI-System]], [[Goals]], [[AGENTS]], and [[Runbook-Multi-AI-Memory-Acceptance]].

## Files Touched

- `package.json` - added `memory:verify`.
- `AGENTS.md` - documented the new command.
- `memory/00_Index/Memory-Evaluation-Test.md` - added one-command gate usage.
- `memory/00_Index/Vault-Dashboard.md` - switched automated checks to `memory:verify`.
- `memory/01_Project_Rules/SPX-Project-Rules.md` - added command to cheatsheet.
- `memory/00_Index/Awakened-AI-System.md`, `memory/00_Index/Goals.md`, `memory/AGENTS.md`, `memory/09_Runbooks/Runbook-Multi-AI-Memory-Acceptance.md` - linked the new gate.

## Decisions Made

- `memory:verify` runs memory-only checks (`memory:check` and `memory:eval`), while `npm run build` remains the app/code verification command.

## Open Issues / Follow-ups

- [x] Run [[Runbook-Multi-AI-Memory-Acceptance]] with Claude Code, Cursor, and Cascade. *(promoted to [[Goals#G-001 Bullet-Proof Memory Vault System]])*
- [x] Consider a broader `npm run verify` only if the repo needs a single code + memory gate. *(completed)*

## Quality Checks

> [!success] Verification
> - [x] `npm run memory:verify` passed.
> - [x] `npm run build` passed. Vite still reports the existing chunk-size warning.

## References

- [[Memory-Evaluation-Test]]
- [[Vault-Dashboard]]
- [[Awakened-AI-System]]
