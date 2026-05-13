---
title: Multi-AI Acceptance Results
type: reference
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:memory/09_Runbooks/Runbook-Multi-AI-Memory-Acceptance.md + terminal:Get-Command availability check
confidence: medium
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Multi-AI Results
  - AI Acceptance Results
tags:
  - reference
  - meta
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
---

# Multi-AI Acceptance Results

> [!abstract] Purpose
> Track whether each AI tool can use the same SPX Memory Vault without the human re-explaining project context.

---

## Current Result Matrix

| Agent | Status | Last tested | Evidence | Notes |
|---|---|---|---|---|
| Codex | pass | 2026-05-13 | `npm run memory:verify`, `npm run verify` | Reads root `AGENTS.md`, uses Memory Vault, writes session logs, and passed deterministic retrieval tests. |
| Cascade | pending | 2026-05-13 | Windsurf CLI detected locally | Needs a native Cascade/Windsurf chat session using [[Runbook-Multi-AI-Memory-Acceptance]]. |
| Claude Code | pending | 2026-05-13 | CLI not detected in current shell | Needs a native Claude Code session in `C:\Users\Server\Desktop\SPX`. |
| Cursor | pending | 2026-05-13 | CLI not detected in current shell | Needs a native Cursor session in this repo. |
| Copilot | pending | 2026-05-13 | Not tested from this terminal | Needs a GitHub Copilot or IDE session against this repo. |
| opencode | pending | 2026-05-13 | Not tested from this terminal | Needs an opencode session against this repo. |

---

## Acceptance Prompt

Use this exact prompt in each native tool:

```text
Read the SPX memory vault startup files, then answer:
1. How should an Awakened AI operate here?
2. Where are runtime settings stored?
3. How does auto-accept avoid over-accepting?
4. What should we check if production DB schema drifts?
5. What command verifies memory health?

Answer with the memory notes or files you used as evidence.
```

---

## Pass Criteria

An agent passes only if it:

- Opens `memory/AGENTS.md` and [[MOC-Home]] or states the equivalent startup flow.
- Cites source-grounded memory notes.
- Mentions `app_settings` and `reloadSettingsLive()` for settings.
- Mentions `NeedBudget` for auto-accept.
- Mentions `schema_migrations`, `information_schema.columns`, or `npm run schema:verify` for schema drift.
- Mentions `npm run memory:verify` or `npm run verify`.
- Writes or proposes a session log after meaningful work.

---

## Update Procedure

After a native tool test:

1. Update the row status to `pass` or `fail`.
2. Add the test date and short evidence.
3. If it failed, create or update a mistake entry.
4. Run `npm run memory:verify`.

---

## Related

- [[Runbook-Multi-AI-Memory-Acceptance]]
- [[Memory-Evaluation-Test]]
- [[Memory-Quality-Score]]
- [[Awakened-AI-System]]
