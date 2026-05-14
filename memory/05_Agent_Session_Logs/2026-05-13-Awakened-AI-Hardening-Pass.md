---
title: "2026-05-13 - Awakened AI Hardening Pass"
type: session-log
session-date: 2026-05-13
agent: codex
duration-minutes: 75
outcomes:
  - Added deterministic memory evaluation and stale-truth detection.
  - Added ADR/runbooks/mistake notes for settings, schema drift, and multi-AI acceptance.
  - Updated navigation, goals, and dashboards to expose the new hardening workflow.
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
thread: system-survey
related-sessions:
  - "[[2026-05-13-System-Survey-Awakened-AI-Update]]"
  - "[[2026-05-13-Setup-MCP-Servers]]"
---

# 2026-05-13 - Awakened AI Hardening Pass

> [!abstract] TL;DR
> Strengthened the Awakened AI memory system with automated retrieval evaluation, stale-truth detection, a DB-backed settings ADR, production schema verification, multi-AI acceptance testing, and two mistake notes.

## Goal

Continue improving the Awakened AI Memory Vault beyond source-grounded docs by adding automated self-checks and operational hardening.

## What Was Done

- [x] Added `scripts/memory-eval.mjs` and `npm run memory:eval`.
- [x] Extended `scripts/memory-check.mjs` to fail active docs containing known stale SPX truth claims.
- [x] Added [[Memory-Evaluation-Test]] to document the evaluation matrix.
- [x] Added [[ADR-002-DB-Backed-Live-Settings]].
- [x] Added [[Runbook-Production-Schema-Verification]].
- [x] Added [[Runbook-Multi-AI-Memory-Acceptance]].
- [x] Added [[Mistake-002-Stale-Memory-Docs-Overrode-Source]].
- [x] Added [[Mistake-003-Baseline-Migration-Drift]].
- [x] Updated [[MOC-Home]], [[Vault-Dashboard]], [[Goals]], [[Awakened-AI-System]], [[SPX-System-Map]], [[SPX-Project-Rules]], [[AGENTS]], and runbook indexes.
- [x] Updated stale notification runbooks from old token naming to current LINE OA/LINEJS/Discord behavior.

## Files Touched

- `scripts/memory-check.mjs` - stale truth detector.
- `scripts/memory-eval.mjs` - deterministic retrieval coverage evaluation.
- `package.json` - `memory:eval` script.
- `AGENTS.md` - memory check/eval command documentation.
- `memory/00_Index/Memory-Evaluation-Test.md` - new evaluation reference.
- `memory/04_Architecture_Decisions/ADR-002-DB-Backed-Live-Settings.md` - new ADR.
- `memory/09_Runbooks/Runbook-Production-Schema-Verification.md` - new runbook.
- `memory/09_Runbooks/Runbook-Multi-AI-Memory-Acceptance.md` - new runbook.
- `memory/08_Mistakes/Mistake-002-Stale-Memory-Docs-Overrode-Source.md` - new mistake note.
- `memory/08_Mistakes/Mistake-003-Baseline-Migration-Drift.md` - new mistake note.
- Existing memory indexes/runbooks - navigation and stale content updates.

## Decisions Made

- Treat `memory:eval` as the acceptance test for core Awakened AI retrieval coverage.
- Treat known stale high-risk project claims as `memory:check` errors in active docs.
- Keep historical notes such as session logs, ADRs, mistakes, and sources excluded from stale-claim enforcement.

## Insights / Learnings

- The new stale detector immediately found two old runbook references to outdated notification env naming.
- A deterministic note/term evaluation is enough to catch missing memory coverage before involving an AI model.
- Production schema drift needs a dedicated runbook because filename-tracked migrations make edited baseline SQL insufficient for already-applied databases.

## Open Issues / Follow-ups

- [x] Run [[Runbook-Multi-AI-Memory-Acceptance]] with Claude Code, Cursor, and Cascade. *(promoted to [[Goals#G-001 Bullet-Proof Memory Vault System]] and [[Multi-AI-Acceptance-Results]])*
- [x] Consider adding CI or pre-commit wiring for `npm run memory:check` and `npm run memory:eval`. *(promoted to [[Goals#G-007 Verification Automation]])*
- [x] Add an SSE broadcaster component note if SSE internals change again. *(promoted to [[Goals#G-005 Reusable Component Coverage]])*

## Quality Checks

> [!success] Verification
> - [x] `npm run memory:check` passed.
> - [x] `npm run memory:eval` passed at 100 percent (8/8).
> - [x] `npm run build` passed. Vite still reports the existing chunk-size warning.

## References

- [[Memory-Evaluation-Test]]
- [[ADR-002-DB-Backed-Live-Settings]]
- [[Runbook-Production-Schema-Verification]]
- [[Runbook-Multi-AI-Memory-Acceptance]]
- [[Mistake-002-Stale-Memory-Docs-Overrode-Source]]
- [[Mistake-003-Baseline-Migration-Drift]]
