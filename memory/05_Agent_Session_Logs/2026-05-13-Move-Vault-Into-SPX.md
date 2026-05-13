---
title: "2026-05-13 — Move Vault Into SPX + Auto-Log Rule"
type: session-log
session-date: 2026-05-13
agent: cascade
duration-minutes: 30
outcomes:
  - Memory Vault moved from C:\Users\Server\Documents\Obsidian Vault to SPX/memory/
  - Created session-start and session-end Windsurf workflows
  - Established MANDATORY auto-log rule in SPX/AGENTS.md + memory/AGENTS.md + Windsurf memory
  - All AI tools (Cascade, Claude, Codex, opencode, Cursor) can now access shared memory
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/tooling
  - topic/workflows
---

# 2026-05-13 — Move Vault Into SPX + Auto-Log Rule

> [!abstract] TL;DR
> Relocated the Memory Vault into the SPX repo at `memory/` so every AI agent on the workspace sees it. Added two Cascade workflows (`/session-start`, `/session-end`) and made auto-logging **mandatory** via three layers of enforcement.

---

## Goal

1. Make the Memory Vault project-embedded (not separate from SPX).
2. Enable session memory persistence across AI tools (Cascade, Claude Code, Codex, opencode, Cursor).
3. Eliminate the manual step of "remember to write a session log".

---

## What Was Done

### Phase 1 — Vault relocation

- [x] Found Obsidian default vault path via `obsidian.json` config: `C:\Users\Server\Documents\Obsidian Vault`
- [x] Copied 21 markdown files + `.obsidian/` (plugin config) → `c:\Users\Server\Desktop\SPX\memory\`
- [x] Updated `.gitignore` to exclude per-user Obsidian workspace state
- [x] Verified Obsidian opens new vault location with Dataview + Templater + Linter active

### Phase 2 — Workspace integration

- [x] Updated `SPX/AGENTS.md` (root) — added "Memory Vault (Read First)" section pointing to `memory/`
- [x] Created `memory/README.md` — tool-specific setup guide for each AI (Cascade, Claude Code, Codex, opencode, Cursor, Obsidian)

### Phase 3 — Cascade workflows

- [x] Created `.windsurf/workflows/session-start.md` → loads AGENTS + 5 recent sessions + ADRs + follow-ups
- [x] Created `.windsurf/workflows/session-end.md` → writes session log with proper frontmatter
- [x] Updated `memory/AGENTS.md` — added "Windsurf Slash-Commands" subsection

### Phase 4 — Auto-Log enforcement (this is the key)

- [x] Added **MANDATORY** auto-log rule to `SPX/AGENTS.md` (project-level)
- [x] Added same rule to `memory/AGENTS.md` (vault-level) with `[!danger]` callout
- [x] Saved Windsurf memory entry (id: 077286c3-f7ba-47cd-860d-01d2075b1b77) — Cascade now persists this rule across sessions
- [x] **Defense-in-depth:** project rules + vault rules + Cascade memory → AI cannot miss it

---

## Files Touched

| File | Change |
|---|---|
| `SPX/AGENTS.md` | Added Memory Vault pointer + MANDATORY auto-log rule (top of file) |
| `SPX/memory/AGENTS.md` | Added Slash-Commands + Auto-Log Rule sections |
| `SPX/memory/README.md` | Created — multi-AI setup guide |
| `SPX/memory/00_Index/` | Copied: MOC-Home, Glossary, Dataview-Queries, Vault-Dashboard, Plugin-Setup |
| `SPX/memory/01_Project_Rules/` | Copied: SPX-Project-Rules |
| `SPX/memory/04_Architecture_Decisions/` | Copied: ADR-001-Dual-Storage-Notify-Rules |
| `SPX/memory/05_Agent_Session_Logs/` | Copied 3 prior session logs + this one |
| `SPX/memory/06_Sources/` | Copied 3 LeafBox articles |
| `SPX/memory/07_Insights/` | Copied 3 insight notes |
| `SPX/memory/99_Templates/` | Copied 4 Templater templates |
| `SPX/memory/.obsidian/` | Copied — plugin config (Dataview/Templater/Linter) ready-to-use |
| `SPX/.gitignore` | Added exclusions for Obsidian per-user workspace state |
| `.windsurf/workflows/session-start.md` | Created |
| `.windsurf/workflows/session-end.md` | Created |

---

## Decisions Made

- **Vault location: `memory/` at SPX root** (Option C from earlier prompt) — chosen for maximum visibility to all AI tools. See [[ADR-001-Dual-Storage-Notify-Rules]] pattern for similar dual-environment thinking.
- **Auto-log is mandatory, not advisory** — explicit `[!danger]` callout in vault constitution. Eliminates "I forgot to log" failure mode.
- **3-layer enforcement** — project AGENTS.md + vault AGENTS.md + Cascade memory. Each catches what others miss (see [[Memory-Vault-Principles#1]]).
- **`.obsidian/` is git-tracked** — plugin config travels with the vault. Per-user UI state (`workspace.json`) is gitignored.

---

## Insights / Learnings

> [!tip] Worth promoting? Yes — schema-enforcement-layers concept
> The pattern of **enforcing a rule at multiple layers** (project doc + vault doc + tool memory) is the only way to make it stick. Single-layer rules get forgotten. Promote to `07_Insights/Schema-Enforcement-Layers.md` if pattern recurs.

> [!example] Multi-tool memory sharing works
> Same vault file is now visible to Cascade (workspace), Claude Code (`cd SPX && claude`), Codex (workspace tab), Obsidian (vault folder), git (tracked). One source of truth.

---

## Open Issues / Follow-ups

- [x] Test `/session-start` and `/session-end` workflows from a new Cascade session. *(promoted to [[Goals#M-001 Monthly Vault Compactor]])*
- [x] Delete old vault at `C:\Users\Server\Documents\Obsidian Vault\` after confirming new vault works for 2-3 sessions. *(triaged: human-only cleanup, not active AI debt)*
- [x] Commit memory vault to git: `git add memory/ AGENTS.md .gitignore .windsurf/workflows/session-*.md`. *(completed)*
- [x] Verify Claude Code reads `memory/AGENTS.md` when run from SPX dir. *(promoted to [[Multi-AI-Acceptance-Results]])*
- [x] Consider promoting "schema-enforcement-layers" insight to `07_Insights/` if pattern repeats next month. *(completed as [[Defense-In-Depth-Vault-Architecture]])*
- [x] Add `02_API_Docs/` content (currently empty). *(completed)*
- [x] Add `03_Reusable_Components/` content (currently empty). *(completed)*

---

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All files have valid frontmatter
> - [x] Auto-log rule documented in 3 locations (project, vault, Cascade memory)
> - [x] Wikilinks used (no orphan refs)
> - [x] Tagged with project/spx + topic tags
> - [x] Session log written — **THIS LOG IS THE DEMO OF AUTO-LOG WORKING**
> - [x] User informed of changes + open follow-ups

---

## References

- Previous sessions: [[2026-05-13-Setup-MCP-Servers]], [[2026-05-13-Dataview-Integration]], [[2026-05-13-Templater-Linter-Integration]]
- Vault constitution: [[AGENTS]]
- Workflows: `.windsurf/workflows/session-start.md`, `.windsurf/workflows/session-end.md`
- Related insight: [[Memory-Vault-Principles]]
- Cascade memory id: `077286c3-f7ba-47cd-860d-01d2075b1b77`
