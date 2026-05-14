---
title: Defense In Depth Vault Architecture
type: insight
status: stable
derived-from:
  - [[2026-05-13-Awakening-Stack]]
  - [[2026-05-13-Vault-Hardening-Pass-2]]
  - [[2026-05-13-Vault-Hardening-Pass-3]]
  - [[2026-05-13-Vault-Production-Hardening]]
  - [[2026-05-13-Session-Threads-And-AI-Tool-Profiles]]
  - [[2026-05-14-Awakened-AI-Memory-Enhancement]]
  - [[2026-05-14-OpenCode-Slash-Commands]]
confidence: high
created: 2026-05-13
updated: 2026-05-14
aliases:
  - Defense-in-Depth Vault
  - Schema Enforcement Layers
tags:
  - insight
  - project/spx
  - topic/memory-vault
  - topic/verification
---

# Defense In Depth Vault Architecture

> [!abstract] Insight
> A memory system stays reliable when the same critical rule is enforced at multiple layers: source, instructions, tool-local commands, memory notes, automated checks, and session logs.

---

## Pattern

Single-layer instructions decay. The durable pattern is:

```text
document -> instruct -> enforce -> verify -> log
```

For SPX this means:

| Layer | Example |
|---|---|
| Source truth | `src/`, `package.json`, migrations, runtime SQL |
| Startup instructions | root `AGENTS.md`, `memory/AGENTS.md` |
| Tool-local commands | `.windsurf/workflows/*.md`, `opencode.json` |
| Navigable memory | [[MOC-Home]], [[SPX-System-Map]], runbooks, ADRs |
| Automated checks | `npm run memory:verify`, `npm run verify`, `npm run schema:verify` |
| Reflection | [[08_Mistakes/README]], session logs, [[Memory-Quality-Score]] |

---

## Why It Matters

Agents forget context, tools change, and old docs go stale. Repeating a critical rule across layers is not duplication when each layer catches a different failure mode.

Examples:

- Root `AGENTS.md` tells every agent to read the vault.
- [[Memory-Evaluation-Test]] verifies core retrieval coverage.
- [[Memory-Quality-Score]] shows stale notes and unresolved follow-ups.
- [[Runbook-Deploy-Safety-Checklist]] prevents unchecked push-to-main deploys.
- [[Runbook-Docs-Drift-Cleanup]] turns source-vs-doc reconciliation into an executable routine.
- `opencode.json` gives OpenCode the same memory rituals Cascade gets from workflow files.
- [[Mistake-002-Stale-Memory-Docs-Overrode-Source]] records why source-grounding matters.

---

## Design Rule

When a behavior is production-critical or memory-critical:

1. Put the source truth in code or config.
2. Document it in the smallest relevant memory note.
3. Add it to a runbook or ADR if it affects operations or architecture.
4. Add tool-local commands or workflows when the tool can enforce the ritual directly.
5. Add an automated check when feasible.
6. Log the session that introduced the rule.

---

## Related

- [[Awakened-AI-System]]
- [[Memory-Quality-Score]]
- [[Runbook-Deploy-Safety-Checklist]]
- [[Mistake-002-Stale-Memory-Docs-Overrode-Source]]
