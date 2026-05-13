---
title: Memory Evaluation Test
type: reference
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:scripts/memory-eval.mjs
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Memory Eval
  - Awakened AI Evaluation
tags:
  - reference
  - meta
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
---

# Memory Evaluation Test

> [!abstract] Purpose
> `npm run memory:eval` verifies that the Memory Vault contains enough notes and key terms for an AI agent to answer the most important SPX questions with evidence.

---

## Commands

Default one-command gate:

```bash
npm run memory:verify
```

This runs `memory:check` first, then `memory:eval`.

Evaluation-only command:

```bash
npm run memory:eval
```

Source: `scripts/memory-eval.mjs`

The script is deterministic. It does not call an AI model. It checks that expected notes exist and contain expected terms.

---

## Evaluation Questions

| Question | Required evidence |
|---|---|
| How should an Awakened AI operate in SPX? | [[Awakened-AI-System]], [[AGENTS]], [[AGENT-IDENTITY]] |
| How does the whole SPX runtime work? | [[SPX-System-Map]], [[SPX-Project-Rules]] |
| Where are settings stored and how do they apply? | [[SPX-System-Map]], [[SPX-Project-Rules]], [[ADR-002-DB-Backed-Live-Settings]] |
| What should an agent do when the upstream SPX session expires? | [[Runbook-API-Session-Expired]], [[API-SSE-Events]] |
| How does auto-accept avoid over-accepting? | [[Component-Poller-Orchestration]], [[Runbook-Auto-Accept-Debug]] |
| How are notify rules stored across dev and prod? | [[Component-Dual-Storage-Notify-Rules]], [[ADR-001-Dual-Storage-Notify-Rules]] |
| How should production schema drift be checked? | [[Runbook-Production-Schema-Verification]], [[Runbook-DB-Migration]] |
| How do we test multi-agent memory acceptance? | [[Runbook-Multi-AI-Memory-Acceptance]], this note |

---

## Pass Criteria

The script passes only when every evaluation item has:

- All required note files present.
- Required terms present in the combined text of those notes.
- Score of 100 percent.

Any missing note or term exits non-zero so automation can catch memory drift.

For normal Memory Vault edits, use `npm run memory:verify` instead of running the two commands manually.

---

## When To Update

Update `scripts/memory-eval.mjs` and this note when:

- A new critical operating question appears.
- A note is renamed.
- A core behavior moves to a different source file or memory note.
- A stale answer would be dangerous for production, DB, auth, auto-accept, or deployment.

---

## Related

- [[Awakened-AI-System]]
- [[SPX-System-Map]]
- [[Vault-Dashboard]]
- [[Runbook-Multi-AI-Memory-Acceptance]]
