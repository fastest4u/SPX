---
title: Multi-AI Acceptance Results
type: reference
status: active
last-verified: 2026-05-14
verified-by: opencode
source: file:memory/09_Runbooks/Runbook-Multi-AI-Memory-Acceptance.md + terminal:npm run memory:eval + native OpenCode session
confidence: high
created: 2026-05-13
updated: 2026-05-14
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

| Agent       | Status  | Last tested | Evidence                                                   | Notes                                                                                                                                                 |
| ----------- | ------- | ----------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | pass    | 2026-05-13  | `npm run memory:verify`, `npm run verify`                  | Reads root `AGENTS.md`, uses Memory Vault, writes session logs, and passed deterministic retrieval tests.                                             |
| Cascade     | pass    | 2026-05-13  | 4-step acceptance test completed                           | Auto-reads AGENTS.md on `/session-start`, reads Goals, summarizes last session log, created Inbox test note. Native slash command support.            |
| Claude Code | pending | 2026-05-13  | CLI not detected in current shell                          | Needs a native Claude Code session in `C:\Users\Server\Desktop\SPX`.                                                                                  |
| Cursor      | pass    | 2026-05-14  | Native Cursor session in this repo; `npm run memory:verify` scored 100% | Read `AGENTS.md`, `MOC-Home`, `Awakened-AI-System`, and the runbook; confirmed the vault health gate and source-grounded acceptance flow.                                           |
| Copilot     | skipped | 2026-05-14  | Not used by the project owner                              | Copilot Chat lacks file write capability and cannot write session logs or read arbitrary markdown files; not suitable for vault-aware work. |
| OpenCode    | pass    | 2026-05-14  | Native OpenCode session; `npm run memory:eval` scored 100%; `opencode.json` commands added | Read startup files, cited evidence notes, confirmed `app_settings`/`reloadSettingsLive()`, `NeedBudget`, schema drift checks, Memory Vault gates, and repo-local commands. |
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
