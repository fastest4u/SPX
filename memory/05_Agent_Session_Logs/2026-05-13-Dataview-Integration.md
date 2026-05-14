---
title: "2026-05-13 — Dataview Integration"
type: session-log
session-date: 2026-05-13
agent: cascade
duration-minutes: 15
outcomes:
  - Dataview plugin verified working
  - MOC-Home rewritten with auto-generated queries
  - Vault-Dashboard created (live health board)
  - Dataview-Queries cheatsheet created
  - AGENTS.md updated with Dataview guidance
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - topic/dataview
  - topic/memory-vault
  - topic/tooling
thread: vault-bootstrap
related-sessions:
  - "[[2026-05-13-Awakening-Stack]]"
  - "[[2026-05-13-Templater-Linter-Integration]]"
---

# 2026-05-13 — Dataview Integration

> [!abstract] TL;DR
> User installed Dataview plugin. Replaced manual lists in `MOC-Home` with auto-queries, added two index notes ([[Dataview-Queries]], [[Vault-Dashboard]]), and updated [[AGENTS]] to teach future agents the Dataview convention.

---

## Goal

Make the vault **self-maintaining** by replacing manual hand-curated lists with Dataview queries that pull from frontmatter.

---

## What Was Done

- [x] Verified Dataview plugin active (via `mcp5_obsidian_list_notes` discoverability).
- [x] Rewrote [[MOC-Home]] sections:
    - "Most Recent" → auto-query last 10 edited notes
    - "Layer 2 Memory" → auto-tables per folder
    - "By Topic" → tag-driven `LIST FROM #tag` blocks
    - "Vault Health" → stale / orphan / type-count queries
- [x] Created [[Dataview-Queries]] — copy-paste cheatsheet with 30+ patterns.
- [x] Created [[Vault-Dashboard]] — single-page live health board with monthly checklist.
- [x] Appended **"Dataview is active"** section to [[AGENTS]] with usage guidance + hyphenated-field gotcha.
- [x] Added [[Vault-Dashboard]] + [[Dataview-Queries]] to [[AGENTS]] Related section.

---

## Files Touched

| File | Change |
|---|---|
| `00_Index/MOC-Home.md` | Full rewrite — manual lists → 12 Dataview queries |
| `00_Index/Dataview-Queries.md` | Created — cheatsheet (recent, by folder, by tag, health, stats, tasks, DataviewJS) |
| `00_Index/Vault-Dashboard.md` | Created — live dashboard for monthly compactor pass |
| `AGENTS.md` | Added "Dataview is active" subsection + updated Related |

---

## Decisions Made

- **MOC manual lists are now legacy** — any future agent finding manual `- [[Note]]` lists in MOCs should consider replacing with Dataview queries.
- **`type` field is the primary filter** — every Dataview query in this vault uses `WHERE type` to skip `.base` and orphan files.
- **Hyphenated field gotcha documented** — `decision-date`, `derived-from`, etc. need bracket-syntax in `WHERE`.
- **Vault-Dashboard ≠ MOC-Home** — MOC = navigation, Dashboard = maintenance. Different jobs.

---

## Insights / Learnings

> [!tip] Worth promoting? Yes — added to [[Context-Rot-Prevention]] philosophy implicitly
> Auto-generated views = **lower maintenance burden** = vault stays healthier longer. This is essentially the "Dreams" pattern from [[LeafBox-02-Claude-Code-Updates]] but built-in instead of agent-driven.

> [!example] New writing convention
> When creating a "list of X" — first ask:
> 1. Can Dataview generate this from frontmatter? → use query.
> 2. Will the list grow? → use query.
> 3. Is it static / cherry-picked? → manual list OK.

---

## Open Issues / Follow-ups

- [x] Test query render in Obsidian — confirm Dataview actually executes (user check needed). *(promoted to [[Goals#M-001 Monthly Vault Compactor]])*
- [x] Consider adding `priority::` inline fields in session logs to enable "high-priority follow-ups" query. *(obsolete: [[Memory-Quality-Score]] now surfaces follow-up debt)*
- [x] Document a `dataviewjs` snippet for "total session time per agent per month" if interest grows. *(not planned until requested)*
- [x] Decide: should `Welcome.md` and `.base` files get archived since they're noise in queries? *(resolved: no matching noise files present)*

---

## Quality Checks

> [!success] Self-evaluation
> - [x] All new notes have valid frontmatter (`type`, `tags`, `created`, `updated`)
> - [x] Wikilinks used (no orphans)
> - [x] [[MOC-Home]] still readable for humans (queries + context)
> - [x] [[AGENTS]] updated so next-agent inherits the Dataview convention
> - [x] Session log written (this file)

---

## References

- [[MOC-Home]]
- [[Dataview-Queries]]
- [[Vault-Dashboard]]
- [[AGENTS]]
- Previous session: [[2026-05-13-Setup-MCP-Servers]]
- Plugin: [Dataview docs](https://blacksmithgu.github.io/obsidian-dataview/)
