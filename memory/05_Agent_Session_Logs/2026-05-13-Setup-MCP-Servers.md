---
title: "2026-05-13 — Setup MCP Servers (GitHub, Context7, Obsidian)"
type: session-log
session-date: 2026-05-13
agent: cascade
duration-minutes: 50
outcomes:
  - GitHub MCP server connected and verified
  - Context7 MCP server installed
  - Obsidian MCP server installed and verified
  - Memory Vault bootstrapped with 14+ notes
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - topic/mcp
  - topic/tooling
  - topic/memory-vault
---

# 2026-05-13 — Setup MCP Servers + Vault Bootstrap

> [!abstract] TL;DR
> Fixed broken **GitHub MCP** (wrong env var name), installed **Context7 MCP** (remote), installed **Obsidian MCP** (npx + Local REST API plugin), then bootstrapped a full **Memory Vault** with rules, templates, sources, insights, and SPX project memory.

---

## Goal

1. Fix GitHub MCP showing error in Windsurf.
2. Add Context7 + Obsidian MCP servers.
3. Use Obsidian MCP to create AI-friendly knowledge vault based on 3 LeafBox Digest articles.

---

## What Was Done

### Phase 1 — GitHub MCP Fix

- [x] Diagnosed `Error` state in Windsurf MCP panel.
- [x] Confirmed Docker installed (`Docker version 29.4.3`).
- [x] Ran image manually → discovered required env is `GITHUB_PERSONAL_ACCESS_TOKEN`, **not** `github_token`.
- [x] Moved token from `env` block to Docker `-e` flag in `args[]`.
- [x] Verified with `mcp2_get_me` → returned `login: fastest4u` correctly.
- [x] Verified with `search_repositories` → returned 18 repos including `SPX`.

### Phase 2 — Context7 MCP

- [x] Tested `npx -y @upstash/context7-mcp@latest` → server starts on stdio.
- [x] Added `context7` block with `CONTEXT7_API_KEY` to `mcp_config.json`.
- [x] Status turned green after reload.

### Phase 3 — Obsidian MCP

- [x] Tested `npx -y obsidian-mcp-server` → fails without `OBSIDIAN_API_KEY` (expected).
- [x] User installed **Local REST API** plugin in Obsidian.
- [x] User enabled "Non-encrypted (HTTP) Server" (port 27123).
- [x] User generated API key + provided it.
- [x] Added `obsidian` block to `mcp_config.json`.
- [x] Verified via `mcp5_obsidian_list_notes` → returned vault root (`Welcome.md`, etc.).

### Phase 4 — Vault Bootstrap

Created **14 notes** across 8 folders:

| Folder | Files |
|---|---|
| Root | `AGENTS.md` |
| `00_Index/` | `MOC-Home.md`, `Glossary.md` |
| `01_Project_Rules/` | `SPX-Project-Rules.md` |
| `04_Architecture_Decisions/` | `ADR-001-Dual-Storage-Notify-Rules.md` |
| `05_Agent_Session_Logs/` | this file |
| `06_Sources/` | `LeafBox-01-Memory-Vault.md`, `LeafBox-02-Claude-Code-Updates.md`, `LeafBox-03-Obsidian-Memory-for-AI.md` |
| `07_Insights/` | `Memory-Vault-Principles.md`, `Agent-Orchestration-Patterns.md`, `Context-Rot-Prevention.md` |
| `99_Templates/` | `Template-Note.md`, `Template-ADR.md`, `Template-Session-Log.md`, `Template-Component.md` |

---

## Files Touched

| File | Change |
|---|---|
| `c:\Users\Server\.codeium\windsurf\mcp_config.json` | Added `context7`, `obsidian`; fixed `github-mcp-server` env via `-e` flag |
| Obsidian vault (15 files) | Bootstrapped — see table above |

---

## Decisions Made

- **Vault structure** — Adopted 8-folder layout (`00_*` to `07_*`, `99_*`) instead of pure 5-folder from LeafBox-01. Reason: separation of **Sources** (raw) vs **Insights** (distilled) vs **Templates** (schema). See [[Memory-Vault-Principles]].
- **Entry file** — Used `AGENTS.md` instead of `CLAUDE.md` for tool-agnostic naming. See [[AGENTS.md]].
- **One-fact-per-file** — Strict adoption; e.g. ADR is one note, not bundled with project rules. See [[Memory-Vault-Principles#3]].
- **Tag taxonomy** — Defined upfront in [[AGENTS.md#Tag Taxonomy]] to prevent tag explosion (see [[Context-Rot-Prevention]]).

---

## Insights / Learnings

> [!tip] Promotion candidates
> - **GitHub MCP env trap** — Docker `-e` flag is more reliable than config `env:` block on Windows. *(Worth a component note if seen again.)*
> - **Reload flow** — `Ctrl+Shift+P → Reload Window` is the only reliable way to restart MCP servers after config edit.
> - **Local REST API on HTTP** — Default HTTPS port 27124 has self-signed cert friction. Use HTTP port 27123 + the env override.

---

## Open Issues / Follow-ups

- [x] Consider installing **Dataview** plugin → auto-generate MOC sections in [[MOC-Home]]. *(completed)*
- [x] Add `02_API_Docs/` content for SPX bidding API endpoint reference. *(completed)*
- [x] Add `03_Reusable_Components/` notes for Poller pattern, DB migration pattern. *(completed)*
- [x] Set calendar reminder for **monthly compactor pass** (per [[Context-Rot-Prevention#Layer 4]]). *(promoted to [[Goals#M-001 Monthly Vault Compactor]])*
- [x] Document the MCP setup as a workflow `.windsurf/workflows/setup-mcp.md`? *(not planned; current setup is documented in memory notes)*

---

## Quality Checks (Outcome-Style Rubric)

> [!success] Self-evaluation
> - [x] All notes have valid YAML frontmatter
> - [x] All notes have `type:` field
> - [x] Tags follow [[AGENTS.md#Tag Taxonomy]]
> - [x] Wikilinks used between related notes (no orphans except templates)
> - [x] Session log written (this file)
> - [x] MOC-Home updated with new notes
> - [x] No file with > 1 unrelated H2

---

## References

- **MCP config:** `c:\Users\Server\.codeium\windsurf\mcp_config.json`
- **Vault root:** Obsidian default vault
- Sources read: [[LeafBox-01-Memory-Vault]], [[LeafBox-02-Claude-Code-Updates]], [[LeafBox-03-Obsidian-Memory-for-AI]]
- Related: [[AGENTS.md]], [[SPX-Project-Rules]], [[ADR-001-Dual-Storage-Notify-Rules]]
