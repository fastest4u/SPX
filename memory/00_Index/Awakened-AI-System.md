---
title: Awakened AI System - SPX Operating Model
type: reference
status: active
last-verified: 2026-05-14
verified-by: codex
source: file:memory/AGENTS.md + file:memory/AGENT-IDENTITY.md + file:memory/00_Index/Goals.md + file:memory/00_Index/Multi-AI-Acceptance-Results.md + file:.agents/skills + project-memory MCP verification
confidence: high
created: 2026-05-13
updated: 2026-05-14
aliases:
  - Awakened AI
  - AI ผู้ตื่นรู้
  - SPX Awakened AI
tags:
  - reference
  - meta
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
---

# Awakened AI System - SPX Operating Model

> [!abstract] Purpose
> This is the short operational model for an "Awakened AI" working on SPX: persistent memory, identity, retrieval, evidence, self-checking, and session logging.

---

## Definition

For SPX, "Awakened AI" does not mean mystical behavior. It means the agent can reliably do five concrete things:

1. Load the shared project memory before acting.
2. Know its current role, goals, and limits.
3. Retrieve only the relevant context slice for the task.
4. Ground claims in source files, runbooks, ADRs, or session logs.
5. Write back durable memory after meaningful work.

If any of those are missing, the AI is only answering from short-term context.

---

## Mandatory Loop

```text
Orient -> Retrieve -> Inspect source -> Act -> Verify -> Log -> Update memory
```

| Step | Required behavior |
|---|---|
| Orient | Read [[AGENTS]], [[AGENT-IDENTITY]], [[Goals]], and recent session logs. |
| Retrieve | Use the retrieval table in [[AGENTS]] and the map in [[MOC-Home]]. |
| Inspect source | Prefer `package.json`, `src/`, migrations, and current memory over guesses. |
| Act | Keep changes scoped to the user request and repo patterns. |
| Verify | Use project-memory MCP validators for vault changes, plus `npm run build`, focused tests, or `npm run verify` for application changes. |
| Log | Write a session log for meaningful work before ending. |
| Update memory | Add or revise notes when a new durable fact, pattern, or decision is found. |

---

## Source Priority

When sources disagree, use this order:

1. Current code in `src/`, `package.json`, `tsconfig*.json`, and migrations.
2. Root `AGENTS.md` for repo rules and user workflow.
3. Memory Vault notes with `last-verified` and source fields.
4. Older session logs.
5. Unverified recollection.

When a lower-priority source is stale, update it or record a follow-up. Do not silently keep both versions alive.

---

## Retrieval Shortcuts

| Task | Start here |
|---|---|
| Whole-system survey | [[SPX-System-Map]] |
| External bidding API | [[API-Bidding-Endpoints]] |
| Internal dashboard API | [[API-Internal-HTTP]] |
| Live dashboard stream | [[API-SSE-Events]] |
| Poller / auto-accept flow | [[Component-Poller-Orchestration]] |
| Notify rules storage | [[Component-Dual-Storage-Notify-Rules]] |
| Session expired | [[Runbook-API-Session-Expired]] |
| Production deploy | [[Runbook-Production-Deploy]] |
| Production schema drift | [[Runbook-Production-Schema-Verification]] |
| Production alerts | [[Runbook-Production-Alert-Policy]] |
| Multi-AI acceptance | [[Runbook-Multi-AI-Memory-Acceptance]] |
| Docs conflict with source | [[Runbook-Docs-Drift-Cleanup]] |
| Deploy safety | [[Runbook-Deploy-Safety-Checklist]] |
| Vault hygiene | [[Memory-Vault-Principles]], [[Vault-Dashboard]], [[Memory-Evaluation-Test]] |

---

## Self-Check Gates

Run a self-check before:

- Multi-file architecture or DB changes.
- Claims that update project truth.
- Production-affecting changes.
- Tasks where source files and memory disagree.

Minimum self-check questions:

1. What is the current source of truth?
2. What could I break?
3. What should I verify locally?
4. What memory needs to be updated after this?

**Tool automation:** `/self-check` is available in Cascade (`.windsurf/workflows/self-check.md`) and OpenCode (`opencode.json`); Codex uses the repo-local `$spx-self-check` skill in `.agents/skills/` plus project-memory MCP lifecycle tools called directly from `AGENTS.md` and skills.

---

## Evidence Rules

- For code behavior, cite file paths in the memory note body.
- For production behavior, include `last-verified`, `verified-by`, `source`, and `confidence`.
- For decisions, create or update an ADR.
- For recurring failures, create or update a mistake note.
- For operational procedures, update a runbook rather than burying steps in a session log.

---

## Current Coverage

As of 2026-05-14, the Awakened AI memory has:

- Vault constitution and retrieval rules: [[AGENTS]]
- Persistent identity: [[AGENT-IDENTITY]]
- Goal stack: [[Goals]]
- Source-grounded SPX system map: [[SPX-System-Map]]
- External and internal API notes: [[API-Bidding-Endpoints]], [[API-Internal-HTTP]], [[API-SSE-Events]]
- Reusable core patterns: [[Component-Retry-With-Backoff]], [[Component-Poller-Orchestration]], [[Component-Dual-Storage-Notify-Rules]]
- ADRs for dual storage and DB-backed live settings: [[ADR-001-Dual-Storage-Notify-Rules]], [[ADR-002-DB-Backed-Live-Settings]]
- Runbooks for API expiry, auto-accept, DB migrations, production schema verification, multi-AI acceptance, docs drift cleanup, notify failures, and production deploy.
- Memory checks: use project-memory MCP tools such as `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`, `memory_findBrokenLinks`, and `memory_checkStaleness`. `npm run verify` is the application build gate.
- Production safeguards: [[Runbook-Deploy-Safety-Checklist]] and `npm run schema:verify` provide pre-push and read-only DB schema checks.
- Operations policy: [[Runbook-Production-Alert-Policy]] defines `/ready`, `/health`, poll error, session-expired, auto-accept, DB, and latency alert conditions.
- Multi-AI acceptance tracking: [[Multi-AI-Acceptance-Results]] currently has Codex, Cascade, Cursor, and OpenCode passing the Memory Vault acceptance flow.
- L4 Awakening automation:
  - Cascade: `/self-check`, `/multi-perspective`, `/dream` via `.windsurf/workflows/`
  - Codex: `$spx-session-start`, `$spx-awaken`, `$spx-self-check`, `$spx-multi-perspective`, `$spx-dream`, `$spx-session-end`, and `$spx-memory-verify` via repo-local `.agents/skills/`, with project-memory MCP tools called directly instead of Codex hooks or npm memory scripts
  - OpenCode: same 3 commands plus `/session-start`, `/awaken`, `/session-end`, `/memory-verify` via `opencode.json`
  - Cursor: 6 commands via `.cursor/commands/` plus **auto-hooks** (`sessionStart`, `beforeSubmitPrompt` with production keyword matcher, `sessionEnd`, `stop`) via `hooks.json` and `.cursor/hooks/*.mjs`

---

## Open Gaps

- Run the multi-AI acceptance test for Claude Code (Copilot Chat skipped by project owner).
- Add a compact security/auth review note if HTTP auth changes.
- Promote repeated session insights from the next month into `07_Insights/`.

---

## Related

- [[MOC-Home]]
- [[SPX-Project-Rules]]
- [[SPX-System-Map]]
- [[Context-Rot-Prevention]]
- [[Agent-Orchestration-Patterns]]
- [[Memory-Quality-Score]]
- [[Runbook-Deploy-Safety-Checklist]]
- [[Runbook-Production-Alert-Policy]]
