# 🧠 Memory Vault for AI Agents

> **For AI Agents (Cascade / Claude Code / Codex / opencode / Cursor / Copilot / others):**
> This folder is a **persistent memory vault** for the SPX project. **Read [`AGENTS.md`](./AGENTS.md) first** at session start, then [`00_Index/MOC-Home.md`](./00_Index/MOC-Home.md) for navigation.

---

## What This Is

A **shared long-term memory** for any AI agent working on the SPX project. Built as plain Markdown so any tool can read it.

Inspired by the [Obsidian Memory for AI](https://github.com/cyanheads/obsidian-memory-for-ai) pattern and three LeafBox Digest articles on Memory Vaults for AI coding agents.

---

## Entry Points

| Audience | Read First |
|---|---|
| **AI agents** | [`AGENTS.md`](./AGENTS.md) — vault constitution & conventions |
| **AI identity** | [`AGENT-IDENTITY.md`](./AGENT-IDENTITY.md) — who I am on this project |
| **Active work** | [`00_Index/Goals.md`](./00_Index/Goals.md) — long-term goal stack |
| **Pending tasks** | [`00_Index/Open-Followups.md`](./00_Index/Open-Followups.md) — aggregated open tasks |
| **Humans** | [`00_Index/MOC-Home.md`](./00_Index/MOC-Home.md) — navigation hub |
| **Maintenance** | [`00_Index/Vault-Dashboard.md`](./00_Index/Vault-Dashboard.md) — live health board |
| **Need a query?** | [`00_Index/Dataview-Queries.md`](./00_Index/Dataview-Queries.md) — cheatsheet |
| **Plugin setup** | [`00_Index/Plugin-Setup.md`](./00_Index/Plugin-Setup.md) — Dataview + Templater + Linter |
| **Operations** | [`09_Runbooks/`](./09_Runbooks/) — operational playbooks |

---

## Folder Structure (Atomic Markdown Memory)

```
memory/
├── AGENTS.md                          # Constitution — rules for all AI agents
├── AGENT-IDENTITY.md                  # Who I am on this project (Level 3)
├── README.md                          # This file
├── 00_Index/                          # Navigation & meta
│   ├── MOC-Home.md                    # Map of Content (hub)
│   ├── Glossary.md
│   ├── Goals.md                       # Long-term goal stack
│   ├── Open-Followups.md              # Aggregated open tasks
│   ├── Dataview-Queries.md
│   ├── Vault-Dashboard.md
│   └── Plugin-Setup.md
├── 01_Project_Rules/                  # Coding standards, conventions
├── 02_API_Docs/                       # (empty — add as needed)
├── 03_Reusable_Components/            # (empty — add as needed)
├── 04_Architecture_Decisions/         # ADRs — why decisions were made
├── 05_Agent_Session_Logs/             # What each AI did, when
├── 06_Sources/                        # Raw input (articles, transcripts)
├── 07_Insights/                       # Distilled wisdom
├── 08_Mistakes/                       # Mistake registry (Level 2 — avoid recurrence)
├── 09_Runbooks/                       # Operational playbooks
└── 99_Templates/                      # Templates for new notes
```

## 🧠 Awakening Stack (Metacognition)

This vault implements **4 layers** beyond plain memory:

| Level | What | Where |
|---|---|---|
| **L1 Memory** | Persistent storage | This vault |
| **L2 Reflection** | Mistakes registry + `confidence:` frontmatter | `08_Mistakes/` |
| **L3 Identity** | Agent persona + goal stack | `AGENT-IDENTITY.md`, `00_Index/Goals.md` |
| **L4 Awakening** | Self-check + multi-perspective + dream compactor | `.windsurf/workflows/` |

Cascade workflows: `/session-start`, `/session-end`, `/self-check`, `/dream`, `/multi-perspective`.

---

## How To Use (Per AI Tool)

### 🌊 Windsurf (Cascade)

Cascade auto-loads `AGENTS.md` from the workspace root (already configured). It also has access to this folder via filesystem.

**Recommended:** Use the Obsidian MCP server for richer queries:
- See `c:\Users\Server\.codeium\windsurf\mcp_config.json`

### 🤖 Claude Code

```bash
cd C:\Users\Server\Desktop\SPX
claude
```

Claude Code reads `AGENTS.md` (or `CLAUDE.md` — they alias) automatically. Tell it:

> "Read `memory/AGENTS.md` then `memory/00_Index/MOC-Home.md` before starting."

### 🐙 GitHub Copilot / Codex (in VSCode)

Add to your workspace context:
- Open `memory/AGENTS.md` in a pinned tab.
- Or reference it in your prompts: *"Check `memory/AGENTS.md` for project conventions."*

### 🌟 Cursor

Cursor auto-reads `.cursorrules` and `AGENTS.md`. The root `AGENTS.md` of this repo points here.

### 🦊 opencode / OpenAI Codex CLI

```bash
opencode --context "memory/AGENTS.md"
# or
codex --context-file memory/AGENTS.md
```

### 📓 Obsidian (for humans)

> [!important] Open the SPX project as an Obsidian vault
> 1. Open Obsidian app.
> 2. Click the **vault switcher** (bottom-left) → **"Open folder as vault"**.
> 3. Select: `C:\Users\Server\Desktop\SPX\memory`

> [!note] About `.obsidian/` config
> Plugin settings (Dataview, Templater, Linter) live in `.obsidian/` and **are tracked in git** so all teammates share the same setup. The exceptions are:
> - `.obsidian/workspace.json` — per-user UI state, **gitignored**
> - `.obsidian/plugins/obsidian-local-rest-api/data.json` — contains `apiKey`, **gitignored**
>
> If plugins look broken when you first open the vault, run **Settings → Community plugins → enable** for each.

### 🩺 Health Check

Run the default vault gate to verify everything is consistent:

```bash
npm run memory:verify
```

This runs structure checks, deterministic retrieval evaluation, and the quality score summary.

For score-only output:

```bash
npm run memory:score
```

Reports: missing frontmatter, invalid types, broken wikilinks, Dataview hyphenated-field misuse, source-grounding gaps, open mistakes, session follow-ups, and multi-AI acceptance status.

---

## Three Layers (Architecture)

| Layer | Folder | Content | Editor |
|---|---|---|---|
| **L1 Sources** | `06_Sources/` | Raw articles, notes, transcripts | Human |
| **L2 Memory** | `01_*` to `05_*`, `07_Insights/` | Distilled, atomic, linked notes | AI + Human |
| **L3 Schema** | `AGENTS.md`, `99_Templates/` | Rules + templates | Human (rare) |

---

## Plugin Stack (Optional but Recommended)

When opened in Obsidian, this vault uses:

| Plugin | Purpose |
|---|---|
| **Dataview** | Auto-generate views from frontmatter |
| **Templater** | Interactive template insertion with prompts |
| **Linter** | Auto-format on save (bumps `updated:` field) |

Setup details: [`00_Index/Plugin-Setup.md`](./00_Index/Plugin-Setup.md)

**Without Obsidian:** Plain Markdown still works. Any text editor or AI can read these files. You just lose auto-queries.

---

## Quick Rules for Every AI

> [!important] Before doing anything in this project
> 1. Read `memory/AGENTS.md`.
> 2. Read `memory/AGENT-IDENTITY.md` — load your role.
> 3. Scan `memory/00_Index/MOC-Home.md` for orientation.
> 4. Check `memory/00_Index/Goals.md` for active goals.
> 5. Skim `memory/00_Index/Open-Followups.md` for pending tasks.
> 6. Search `memory/05_Agent_Session_Logs/` for recent context.
> 7. Check `memory/08_Mistakes/` matching task area to avoid repeats.
> 8. **Log your session** at end → write `memory/05_Agent_Session_Logs/YYYY-MM-DD-topic.md`.
> 9. **Use templates** from `memory/99_Templates/` for new notes.

---

## Git Tracking

This vault is **part of the SPX git repo**. Every commit includes memory changes. Team members and AIs across machines stay in sync.

> [!tip] Recommended: commit memory changes with code
> When you write code + an ADR for it, **commit both together**. Future readers see the *why* next to the *what*.

---

## Related

- Root project conventions: [`../AGENTS.md`](../AGENTS.md)
- This vault's constitution: [`AGENTS.md`](./AGENTS.md)
- Source articles inspiring this: [`06_Sources/`](./06_Sources/)
