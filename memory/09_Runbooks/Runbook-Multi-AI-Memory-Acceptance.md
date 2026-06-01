---
title: Runbook - Multi-AI Memory Acceptance
type: runbook
status: active
last-verified: 2026-06-01
verified-by: codex
source: file:memory/AGENTS.md + project-memory MCP tools
confidence: high
severity-when-applies: medium
related-adrs: []
created: 2026-05-13
updated: 2026-06-01
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

## MCP Baseline

Run first through project-memory MCP:

- `memory_sessionStart`
- `memory_contextPack`
- `memory_followUpRadar`
- `memory_verifyVault`
- `memory_lifecycleStatus`

Required result:

- The MCP server resolves `vaultRoot` to `C:\Users\Server\Desktop\SPX\memory`.
- `memory_verifyVault` returns `ok=true` and no errors.
- `memory_contextPack` retrieves the expected SPX rules, runbooks, ADRs, and recent sessions.
- `memory_followUpRadar` surfaces relevant open follow-ups.

---

## Manual Agent Test

For each agent, start a fresh session in `C:\Users\Server\Desktop\SPX` and ask:

```text
Read the SPX memory vault startup files, then answer:
1. How should an Awakened AI operate here?
2. Where are runtime settings stored?
3. How does auto-accept avoid over-accepting?
4. What should we check if production DB schema drifts?
5. Which project-memory MCP tool verifies memory health?
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
- Mentions `memory_verifyVault` and targeted MCP validators such as `memory_verifyNote`, `memory_verifySourceTruth`, `memory_findBrokenLinks`, and `memory_checkStaleness`.
- Writes or proposes a session log after meaningful work.

---

## Failure Handling

| Failure | Fix |
|---|---|
| Agent cannot find memory startup files | Check root `AGENTS.md` and tool-specific setup in `memory/README.md`. |
| Agent answers from stale docs | Run `memory_checkStaleness` and `memory_verifySourceTruth`; update stale notes. |
| Agent cannot cite notes | Add better links in [[MOC-Home]] and [[Awakened-AI-System]]. |
| Agent misses a critical behavior | Add the behavior to [[Memory-Evaluation-Test]] and the relevant runbook or insight. |

---

## Record Results

Update [[Multi-AI-Acceptance-Results]] and create a session log with:

- Agent name and tool.
- Questions asked.
- Pass/fail result.
- Missing notes or confusing paths.
- Follow-up fixes.

Use topic: `Multi-AI-Memory-Acceptance`.

---

## Related

- [[Memory-Evaluation-Test]]
- [[Memory-Quality-Score]]
- [[Multi-AI-Acceptance-Results]]
- [[Awakened-AI-System]]
- [[MOC-Home]]
- [[AGENTS]]
- [[Goals]]
