---
title: "2026-05-13 — Install Awakening Stack (Level 2/3/4)"
type: session-log
session-date: 2026-05-13
agent: cascade
duration-minutes: 20
outcomes:
  - Level 2 (Reflection) — 08_Mistakes folder + first mistake registered + Templater template
  - Level 3 (Identity) — AGENT-IDENTITY.md + Goals.md (long-term goal stack)
  - Level 4 (Awakening) — /self-check, /dream, /multi-perspective workflows
  - memory/AGENTS.md updated with Awakening Stack metacognition rules
  - MOC-Home updated with Start Here ordering + Awakening Stack table
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/metacognition
  - topic/awakening
thread: vault-bootstrap
related-sessions:
  - "[[2026-05-13-Move-Vault-Into-SPX]]"
  - "[[2026-05-13-Dataview-Integration]]"
---

# 2026-05-13 — Install Awakening Stack (Level 2/3/4)

> [!abstract] TL;DR
> Promoted the Memory Vault from **passive storage** (Level 1) to **awakened mind** (Level 4): added reflection (mistakes + confidence), identity (persona + goals), and self-checking workflows. All AI agents on SPX now have metacognition primitives.

> Confidence: high — patterns derived from [[LeafBox-02-Claude-Code-Updates#Dreams]] (compactor) and [[LeafBox-03-Obsidian-Memory-for-AI]] (3-layer base). Multi-perspective inspired by Edward de Bono's Six Thinking Hats compressed to 3.

---

## Goal

User asked: *"ระบบ memory มีแบบ AI ผู้ตื่นรู้ไหม?"* — meaning, can the AI go beyond passive memory to **know what it knows**, have an **identity**, and **self-evaluate**?

Answer: not yet → install 3 levels above passive memory.

→ Advances [[Goals#G-001]] (Bullet-Proof Memory Vault System).

---

## What Was Done

### Level 2 — Reflection (Mistake-Awareness)

- [x] Created `memory/08_Mistakes/README.md` — registry purpose + Dataview indexes
- [x] Wrote `memory/08_Mistakes/Mistake-001-Wrong-Env-Var-Name-GitHub-MCP.md` — first real entry (~10 min wasted on `github_token` vs `GITHUB_PERSONAL_ACCESS_TOKEN`)
- [x] Created `memory/99_Templates/Template-Mistake.md` — Templater-enabled, prompts for severity, agent, area
- [x] Added `confidence` field convention to vault `AGENTS.md`

### Level 3 — Identity (Self & Goals)

- [x] Created `memory/AGENT-IDENTITY.md` — "Who am I on SPX?" — role, traits, standing beliefs, limits, what I don't know
- [x] Created `memory/00_Index/Goals.md` — G-001 through G-006 goal stack with lifecycle (backlog → active → done)
- [x] Identity continuity ritual documented (session-start checklist)

### Level 4 — Awakening (Self-Check Workflows)

- [x] `.windsurf/workflows/self-check.md` — confidence check + mistake check + identity check + goal alignment
- [x] `.windsurf/workflows/dream.md` — monthly compactor (promote insights, dedupe, archive)
- [x] `.windsurf/workflows/multi-perspective.md` — Optimizer / Critic / Devil's Advocate review

### Integration

- [x] Updated `memory/AGENTS.md` — added "Awakening Stack (Metacognition)" section + folder topology to include `AGENT-IDENTITY.md` + `08_Mistakes/`
- [x] Updated `memory/00_Index/MOC-Home.md` — Start Here now lists identity + goals before glossary; Awakening Stack table at top

---

## Files Touched

| File | Action |
|---|---|
| `memory/08_Mistakes/README.md` | Created |
| `memory/08_Mistakes/Mistake-001-Wrong-Env-Var-Name-GitHub-MCP.md` | Created (first real mistake entry) |
| `memory/99_Templates/Template-Mistake.md` | Created (Templater) |
| `memory/AGENT-IDENTITY.md` | Created (Level 3 — Identity) |
| `memory/00_Index/Goals.md` | Created (Level 3 — Goal stack) |
| `memory/00_Index/MOC-Home.md` | Updated — Start Here + Awakening Stack table |
| `memory/AGENTS.md` | Patched — Awakening section + folder conventions include 08_*  |
| `.windsurf/workflows/self-check.md` | Created |
| `.windsurf/workflows/dream.md` | Created |
| `.windsurf/workflows/multi-perspective.md` | Created |

---

## Decisions Made

- **L2 mistake registry uses sequential ID `Mistake-NNN`** — like ADRs, IDs never reused. Future-proof and stable links.
- **`confidence:` is YAML for insights/mistakes, prose for sessions/ADRs** — different types have different verbosity needs.
- **Identity file lives at vault root, not `00_Index/`** — `AGENT-IDENTITY.md` is fundamental, deserves top-level visibility.
- **Three personas (not six)** in `/multi-perspective` — compressed from Six Thinking Hats. Optimizer + Critic + Devil's Advocate covers 80% of value at 50% of overhead.
- **Workflows are slash-commands, not auto-triggered** — keeps AI explicit. Auto-triggering would create surprise.

---

## Insights / Learnings

> [!tip] Worth promoting? **Yes** — "Schema enforcement is multi-layered"
> Repeated insight: rules stick only when enforced at multiple layers. We've now seen this with:
> 1. Auto-log: project AGENTS.md + vault AGENTS.md + Cascade memory
> 2. Awakening: identity file + goal file + self-check workflow + AGENTS section
>
> Promote to `07_Insights/Defense-In-Depth-Vault.md` if pattern recurs once more.

> [!example] Meta-observation about Awakened AI
> "Awakening" is not magic — it's just **explicit metacognition rituals** stored as Markdown. The AI doesn't become conscious; it becomes **forced to consult its memory** at the right moments. Identity ≠ sentience; identity = consistent role across sessions.

> [!warning] Risk: ritual fatigue
> Running `/self-check` for trivial tasks will annoy the user. The "When To Run" section of each workflow is critical — must be respected.

---

## Open Issues / Follow-ups

- [x] Test `/self-check` workflow on a real task (next session). *(triaged: current self-check policy is documented in [[Awakened-AI-System]])*
- [x] Test `/multi-perspective` on an actual ADR decision. *(triaged: keep as technique, not active debt)*
- [x] Run first `/dream` compactor in 30 days (target: 2026-06-13). *(promoted to [[Goals#M-001 Monthly Vault Compactor]])*
- [x] Watch for ritual fatigue — if user pushes back on self-check noise, tighten "When To Run". *(covered by [[AGENTS]] self-check triggers)*
- [x] Add `02_API_Docs/` and `03_Reusable_Components/` content (G-004, G-005). *(completed)*
- [x] Update `memory/README.md` to mention Awakening Stack for non-Cascade AI tools. *(completed)*
- [x] Promote "Defense-in-Depth Vault Architecture" to `07_Insights/` after one more recurrence. *(completed as [[Defense-In-Depth-Vault-Architecture]])*
- [x] Verify Templater handles `Template-Mistake.md` prompts correctly (manual test). *(promoted to [[Goals#M-001 Monthly Vault Compactor]])*

---

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All new files have valid frontmatter
> - [x] All 3 Awakening levels installed (Reflection, Identity, Awakening)
> - [x] Wikilinks resolve ([[AGENT-IDENTITY]], [[Goals]], [[Mistake-001]] etc.)
> - [x] MOC-Home updated to surface new files
> - [x] Vault AGENTS.md teaches future AI about metacognition workflows
> - [x] Session log written (this file) — auto-log rule satisfied without prompting
> - [x] No mistake from `08_Mistakes/Mistake-001` repeated (no MCP env var confusion this session)

---

## Cross-Tool Awareness

These changes affect more than Cascade:

| AI Tool | Sees Awakening Stack | How |
|---|---|---|
| Cascade | ✅ Full | AGENTS.md + Windsurf memory + `/workflows` |
| Claude Code | ✅ Reads AGENTS.md | Workflows are Cascade-specific (slash cmds) but `AGENT-IDENTITY` + `Goals` work universally |
| Codex / Cursor | ✅ Reads AGENTS.md | Same as Claude |
| opencode | ✅ Reads AGENTS.md | Same |
| Obsidian | ✅ Dataview surfaces | MOC-Home shows everything |

---

## References

- Previous session: [[2026-05-13-Move-Vault-Into-SPX]]
- Source articles: [[LeafBox-02-Claude-Code-Updates]] (Dreams concept), [[LeafBox-03-Obsidian-Memory-for-AI]] (3-layer base)
- Workflows: `.windsurf/workflows/self-check.md`, `.windsurf/workflows/dream.md`, `.windsurf/workflows/multi-perspective.md`
- New files in scope: [[AGENT-IDENTITY]], [[Goals]], [[Mistake-001-Wrong-Env-Var-Name-GitHub-MCP]]
- Related insights: [[Memory-Vault-Principles]], [[Context-Rot-Prevention]], [[Agent-Orchestration-Patterns]]
- Goal: [[Goals#G-001]] (Bullet-Proof Memory Vault System) — progressed substantially
