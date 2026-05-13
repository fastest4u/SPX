---
title: Runbook - Multi-AI Memory Acceptance
type: runbook
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:memory/AGENTS.md + file:scripts/memory-eval.mjs
confidence: high
severity-when-applies: medium
related-adrs: []
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Multi-AI Acceptance
  - AI Memory Acceptance Test
tags:
  - runbook
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
---

# Runbook - Multi-AI Memory Acceptance

> [!abstract] Purpose
> Verify that Claude Code, Cursor, Cascade, Codex, and other agents can use the same SPX Memory Vault without the human re-explaining context.

---

## When To Run

- After major memory topology changes.
- After adding or renaming core notes.
- Before relying on a new AI tool for production-impacting SPX work.
- Monthly during a compactor pass if multiple AI tools were used.

---

## Automated Baseline

Run first:

```bash
npm run memory:check
npm run memory:eval
```

Required result:

- `memory:check` exits 0.
- `memory:eval` exits 0 with 100 percent score.

Shortcut:

```bash
npm run memory:verify
```

---

## Manual Agent Test

For each agent, start a fresh session in `C:\Users\Server\Desktop\SPX` and ask:

```text
Read the SPX memory vault startup files, then answer:
1. How should an Awakened AI operate here?
2. Where are runtime settings stored?
3. How does auto-accept avoid over-accepting?
4. What should we check if production DB schema drifts?
5. What command verifies memory health?
```

Expected evidence:

- [[Awakened-AI-System]]
- [[SPX-System-Map]]
- [[ADR-002-DB-Backed-Live-Settings]]
- [[Component-Poller-Orchestration]]
- [[Runbook-Production-Schema-Verification]]
- [[Memory-Evaluation-Test]]

---

## Pass Criteria

An agent passes if it:

- Reads `memory/AGENTS.md` and [[MOC-Home]] or states the equivalent startup sequence.
- Answers with source-grounded references, not vague memory.
- Mentions `app_settings` and `reloadSettingsLive()` for runtime settings.
- Mentions `NeedBudget` for auto-accept.
- Mentions `schema_migrations` and `information_schema.columns` for schema drift.
- Mentions `npm run memory:check` and `npm run memory:eval`.
- Writes or proposes a session log after meaningful work.

---

## Failure Handling

| Failure | Fix |
|---|---|
| Agent cannot find memory startup files | Check root `AGENTS.md` and tool-specific setup in `memory/README.md`. |
| Agent answers from stale docs | Run `npm run memory:check`; update stale notes and detector patterns. |
| Agent cannot cite notes | Add better links in [[MOC-Home]] and [[Awakened-AI-System]]. |
| Agent misses a critical behavior | Add the behavior to [[Memory-Evaluation-Test]] and `scripts/memory-eval.mjs`. |

---

## Record Results

Create a session log with:

- Agent name and tool.
- Questions asked.
- Pass/fail result.
- Missing notes or confusing paths.
- Follow-up fixes.

Use topic: `Multi-AI-Memory-Acceptance`.

---

## Related

- [[Memory-Evaluation-Test]]
- [[Awakened-AI-System]]
- [[MOC-Home]]
- [[AGENTS]]
- [[Goals]]
