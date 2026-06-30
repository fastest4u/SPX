---
title: AGENTS.md — Memory Vault Entry Point
type: rules
version: 1.0.0
status: active
created: 2026-05-13
updated: 2026-06-30
tags:
  - meta
  - agent-rules
  - entry-point
aliases:
  - CLAUDE.md
  - AI Rules
  - Vault Constitution
---

# AGENTS.md

> [!important] Read This First
> This is the **constitution** of the Memory Vault. Every AI agent (Claude Code, Codex, Cascade, Cursor, etc.) MUST read this file at session start before making decisions.

## Identity & Purpose

This vault is the **persistent long-term memory** of the developer + AI team for the [[SPX-Project-Rules|SPX project]] and general AI-workflow knowledge.

**Goals:**
- Eliminate repeated context-explanation across sessions.
- Capture *decisions*, *insights*, and *conventions* once — re-use forever.
- Stay tool-agnostic: plain Markdown, no DB, no lock-in.

## How To Use This Vault

> [!tip] The Two Most Important Files
> 1. **This file** (`AGENTS.md`) — rules, schema, conventions.
> 2. [[MOC-Home]] — map of content; the navigation hub.

### Session Start Checklist (every agent, every session)

1. Read this file (`AGENTS.md`) — load rules.
2. Open [[MOC-Home]] — orient on what exists.
3. Search by tag or path for the *current* working area.
4. If the user mentions a project, open the matching MOC (e.g. SPX → [[SPX-Project-Rules]]).
5. Log significant decisions to `05_Agent_Session_Logs/` before ending the session.

### Windsurf Slash-Commands (shortcuts)

> [!success] Cascade users can automate session management
> - `/session-start` — auto-load vault (AGENTS, recent sessions, ADRs, open follow-ups)
> - `/session-end` — auto-write session log with proper frontmatter
> - `/awaken` — AI self-introspection: analyze project state and suggest next steps
> - `/strict-pr-review-8-category` — strict PR/review/merge gate for production-impacting changes
>
> Workflow source: `.windsurf/workflows/session-{start,end}.md`, `.windsurf/workflows/awaken.md`, and `.windsurf/workflows/strict-pr-review-8-category.md`

### OpenCode Slash-Commands (shortcuts)

> [!success] OpenCode users can use repo-local commands from `opencode.json`
> - `/session-start` — read Memory Vault startup context and summarize current state
> - `/awaken` — review Awakened AI status, risks, gaps, and next actions
> - `/session-end` — write the required session log and run the right verification gate
> - `/memory-verify` — call `memory_verifyVault` and targeted project-memory MCP validators, then summarize memory health
>
> Config source: `opencode.json`. Restart OpenCode after editing this file because config is not hot-reloaded.

### 🤖 Auto-Log Rule (MANDATORY for all AI)

> [!danger] AI MUST auto-write session logs without waiting for the user to ask
> When you finish any **meaningful chunk of work**, immediately create a session log in `05_Agent_Session_Logs/YYYY-MM-DD-<Topic>.md`. **Do not wait for the user to say `/session-end`.**

**Auto-log triggers (any one fires the rule):**

- Completed a feature, bug fix, or refactor
- Made an architectural decision (also create ADR)
- Set up tooling (MCP, plugins, configs)
- Resolved a debugging investigation
- User says: "done", "เสร็จแล้ว", "ok merge", "ship it", "save this"
- Approaching session token/context limit

**Skip auto-log for:**

- Pure Q&A with no code/config changes
- Trivial typo fixes
- User explicitly says "don't log this"

**Minimum log content:**

```yaml
---
title: "<YYYY-MM-DD> — <Topic with spaces>"
type: session-log
session-date: <YYYY-MM-DD>
agent: <cascade | claude | codex | cursor>
duration-minutes: <estimate>
outcomes: [<list>]
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [session-log, project/<name>]
---
```

Sections: **TL;DR · Goal · What Was Done · Files Touched · Decisions Made · Open Follow-ups · References**

After writing the log, report to user: `✅ Session saved → <path> · outcomes: <count>`.

### 🪞 Awakening Stack (Metacognition)

> [!important] This vault is more than memory — it's a mind
> The vault implements 4 levels of "awakening":
>
> | Level | What | Where |
> |---|---|---|
> | **L1: Memory** | Persistent storage | This vault (Markdown files) |
> | **L2: Reflection** | Know what I know / don't know / got wrong | `08_Mistakes/`, `confidence:` frontmatter |
> | **L3: Identity** | Have a role + goals across sessions | [[AGENT-IDENTITY]], [[Goals]] |
> | **L4: Awakening** | Multi-perspective + self-checking | Workflows `/self-check`, `/multi-perspective`, `/dream` |

### When AI MUST self-check

Run `/self-check` before:
- Any architectural change (multi-file)
- Any claim that becomes a decision
- Any task where you're tempted to feel confident without evidence

Run `/multi-perspective` when:
- Choosing between 2+ technical options
- Writing an ADR
- Decision feels "too easy"

Run `/dream`:
- Monthly (compactor pass)
- When session-log folder grows beyond ~30 files

Run `/strict-pr-review-8-category` before:
- Any user-requested PR, review, or merge workflow
- Production-impacting commit/push work that changes `src/`, DB schema/migrations, auth/security, auto-accept, notifications, deploy/Docker, or runtime settings/secrets handling

Skip strict PR review for:
- Pure Q&A
- Memory-only/docs-only maintenance with no production impact
- Trivial typo fixes
- Any step that would commit, push, create a PR, or merge when the user explicitly says not to

### Confidence is part of frontmatter

For `type: insight` and `type: mistake`, **always** include:

```yaml
confidence: high | medium | low | guess
```

For session logs and ADRs, include confidence in the **body** when stating non-obvious claims:

```markdown
> Confidence: medium — based on docs + 1 prior session, not benchmarked.
```

### Confidence Log (Session Logs)

Every session log MUST include a **Confidence Log** section tracking claims where stated confidence differed from actual correctness:

```markdown
## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| "File contains exact string X" | high | wrong — string format differed | Read file before editing |
| "No duplicate rows in MOC" | high | wrong — created duplicate | Re-read before claiming uniqueness |
```

**Why this matters:** Overconfidence is a recurring AI failure mode. Recording it creates a calibration dataset that future agents can use to avoid the same traps.

**When to log:**
- Claimed `confidence: high` but was wrong
- Assumed file content without reading
- Used bash syntax on Windows (or vice versa)
- Any claim that required correction by the user

**When to skip:**
- Trivial typos (no confidence claim involved)
- User explicitly asked to try something risky
- External API/network failures outside AI control

### Mistake-Awareness Rule

> [!danger] Before any task in a known-error area
> 1. Search `08_Mistakes/` for matching `area` or `tags`.
> 2. If a relevant mistake exists → **state it explicitly** in your plan: "I'm aware of [[Mistake-NNN]] and will avoid by X."
> 3. After completing the task without recurrence → cite it in session log under "Insights / Learnings".

### Identity Continuity Ritual

At session start, the AI should be able to answer (silently):

1. What's my role? → see [[AGENT-IDENTITY#My Role]]
2. What's the last session about? → check `05_Agent_Session_Logs/` top
3. What's currently active? → see [[Goals#Active Goals]]
4. What mistakes have I made? → scan `08_Mistakes/`

If you can't answer any of these, **run `/session-start` first**.

### 📡 Retrieval Protocol (What to read per task type)

> [!important] Before starting a task, read the matching cluster.
> Don't load everything — load **the relevant slice**.

| Task type | MUST read | SHOULD read | Search for |
|---|---|---|---|
| **DB schema change / migration** | [[SPX-Project-Rules#Database]], [[ADR-001-Dual-Storage-Notify-Rules]] | Runbook [[Runbook-DB-Migration]] | `area/db` in `08_Mistakes/`, recent `session-log` with `area/db` |
| **Auto-accept logic** | [[ADR-001-Dual-Storage-Notify-Rules]] | Runbook [[Runbook-Auto-Accept-Debug]] | `tag:topic/auto-accept` in sessions + mistakes |
| **API client / polling** | [[SPX-Project-Rules#Architecture]] | Runbook [[Runbook-API-Session-Expired]] | `area/api` in mistakes, `session-log` referencing `api-client.ts` |
| **Whole-system survey / onboarding** | [[Awakened-AI-System]], [[SPX-System-Map]] | [[API-Internal-HTTP]], [[API-SSE-Events]], [[Component-Poller-Orchestration]] | recent `session-log` with `topic/system-map` or `topic/memory-vault` |
| **Notify (Discord/LINE)** | `notify-rules` section in [[SPX-Project-Rules]] | Runbook [[Runbook-Notify-Failure]] | `area/notify` in mistakes |
| **Deploy / Docker / production** | Deploy section in root `AGENTS.md`, [[Runbook-Deploy-Safety-Checklist]] | Runbook [[Runbook-Production-Deploy]] | recent `session-log` with `topic/deploy` |
| **PR / strict review / production-impacting push** | root `AGENTS.md`, [[Runbook-Deploy-Safety-Checklist]], `/strict-pr-review-8-category` workflow | Runbook [[Runbook-Production-Deploy]], [[Memory-Quality-Score]] | `npm run verify`, `git status --short`, matching `08_Mistakes/` entries |
| **MCP / tooling setup** | [[Plugin-Setup]] | [[2026-05-13-Setup-MCP-Servers]] | `tooling/mcp` in mistakes |
| **Vault hygiene / memory** | [[AGENTS]] (this file), [[Memory-Vault-Principles]] | [[Vault-Dashboard]] | recent mistakes with `topic/memory-vault` |
| **Docs / instruction drift** | [[Runbook-Docs-Drift-Cleanup]], [[Source-Grounded-Documentation]] | [[Mistake-002-Stale-Memory-Docs-Overrode-Source]] | stale notification env names, old command summaries, or settings restart claims |
| **Memory evaluation / multi-AI testing** | [[Memory-Evaluation-Test]], [[Memory-Quality-Score]], [[Runbook-Multi-AI-Memory-Acceptance]] | [[Awakened-AI-System]], [[Vault-Dashboard]], [[Multi-AI-Acceptance-Results]] | `memory_verifyVault` + targeted MCP validators |
| **Architectural decision** | [[Goals]] active items | Latest ADRs in `04_Architecture_Decisions/` | similar prior ADRs |
| **Any task** (always) | [[AGENT-IDENTITY]], [[Goals#Active Goals]] | Last 3 entries in `05_Agent_Session_Logs/` | matching `08_Mistakes/` entries |

> [!tip] Retrieval discipline saves tokens
> Reading 3 targeted files beats reading 30 random files. The protocol above is the **default** — deviate only when the task is clearly novel.

### When to update retrieval protocol

When you discover a new task pattern that benefits from a specific cluster of memory:

1. Add a row to the table above.
2. Reference in your next session log under "Insights / Learnings".
3. After 2 sessions confirm the pattern → promote to [[07_Insights/]].

## Vault Topology (3-Layer Architecture)

Based on the **Obsidian Memory for AI** pattern:

| Layer | Folder | Purpose | Who Edits |
|---|---|---|---|
| **L1: Sources** | `06_Sources/` | Raw input — articles, notes, transcripts | Human |
| **L2: Memory** | `01_*` to `05_*`, `07_Insights/` | AI-maintained wiki: rules, APIs, components, decisions, sessions, insights | AI + Human |
| **L3: Schema** | `AGENTS.md`, `99_Templates/` | Rules + templates the AI follows | Human (rare) |

## Folder Conventions

```
AGENT-IDENTITY.md          # Who I am on this project (Level 3 Identity)
00_Index/                  # MOC + Glossary + Goals + Open-Followups + Dataview cheatsheet
01_Project_Rules/          # Coding standards, git workflow, communication
02_API_Docs/               # External + internal API documentation
03_Reusable_Components/    # Patterns, snippets, building blocks
04_Architecture_Decisions/ # ADRs — why we built it this way
05_Agent_Session_Logs/     # What was done in each session
06_Sources/                # Original articles, raw input
07_Insights/               # Synthesized knowledge from sources
08_Mistakes/               # Mistake registry — what to avoid (Level 2 Reflection)
09_Runbooks/               # Operational playbooks for predictable tasks
99_Templates/              # File templates for consistency
```

> [!warning] Naming Rules
> - **Files** — `Kebab-Case-Or-Title-Case.md`. No spaces in critical files.
> - **Folders** — `NN_PascalCase/` (numeric prefix = display order).
> - **Dates** — ISO format `YYYY-MM-DD` only.
> - **One topic per file** (Atomic Markdown principle).
>
> **Per-folder filename schema (checked by project-memory MCP verification and agent review):**
>
> | Folder | Pattern | Example |
> |---|---|---|
> | `04_Architecture_Decisions/` | `ADR-NNN-Title-Case-Words.md` | `ADR-003-Frontend-Design-System-V2.md` |
> | `05_Agent_Session_Logs/` | `YYYY-MM-DD-Title-Case-Words.md` (max 8 words) | `2026-05-23-Frontend-Design-System-V2-Merge.md` |
> | `08_Mistakes/` | `Mistake-NNN-Title-Case-Words.md` | `Mistake-007-Edit-Without-Verifying-File.md` |
> | `09_Runbooks/` | `Runbook-Title-Case-Words.md` | `Runbook-Production-Deploy.md` |
> | `07_Insights/` | `Title-Case-Words.md` | `Memory-Vault-Principles.md` |
> | `03_Reusable_Components/` | `Component-Title-Case-Words.md` | `Component-Poller-Orchestration.md` |
>
> **Rules for session log titles:**
> 1. Use Title-Case (each significant word capitalized).
> 2. Hyphens between words, no underscores or spaces.
> 3. Maximum **8 words** after the date — distill the topic, do not paste the full task description.
> 4. Bad: `2026-05-21-add-line-image-listener-for-spx-group-run-sheet-ocr.md` (10 lowercase words).
> 5. Good: `2026-05-21-LINE-Image-Listener-OCR-Persistence.md` (6 Title-Case words).

## Frontmatter Schema (Required)

Every note MUST have YAML frontmatter. Minimum fields:

```yaml
---
title: <Human-readable title>
type: <see allowed types below>
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [<tag>, <tag>]
---
```

### Allowed `type` values

| Type | Where used | Lifecycle |
|---|---|---|
| `note` | Generic note (default) | active → archived |
| `index` | Folder readme (e.g. `08_Mistakes/README.md`) | active |
| `moc` | Map of Content (e.g. [[MOC-Home]]) | active |
| `dashboard` | Live status board (e.g. [[Vault-Dashboard]]) | active |
| `reference` | Reusable reference (e.g. [[Dataview-Queries]], [[Plugin-Setup]]) | active |
| `rules` | Project / coding rules ([[SPX-Project-Rules]]) | active |
| `glossary` | Term definitions ([[Glossary]]) | active |
| `identity` | Agent persona ([[AGENT-IDENTITY]]) | active |
| `goals` | Long-term goal stack ([[Goals]]) | active |
| `adr` | Architecture Decision Record | proposed → accepted → superseded |
| `session-log` | Per-session work record | always immutable (append-only) |
| `component` | Reusable code pattern/snippet | experimental → reusable → deprecated |
| `source` | Raw input (article, transcript, doc) | active |
| `insight` | Distilled wisdom from sources/sessions | stable → superseded |
| `mistake` | Failure mode + how to avoid | open → resolved |
| `runbook` | Operational playbook | active → outdated |

### Type-specific extra fields

| Type | Required extra | Optional extra |
|---|---|---|
| `adr` | `status`, `decision-date`, `confidence` | `supersedes`, `superseded-by` |
| `session-log` | `session-date`, `agent`, `outcomes` | `duration-minutes` |
| `component` | `language`, `status` | `dependencies` |
| `source` | `source-url`, `source-author`, `source-date`, `ingested-date` | `source-id` |
| `insight` | `derived-from`, `confidence` | `status` |
| `mistake` | `severity`, `status`, `occurred-date`, `agent`, `area`, `confidence` | `resolved-date` |
| `runbook` | `status`, `last-verified`, `severity-when-applies` | `related-adrs` |
| `goals` | `status` | — |
| `identity` | `status` | — |
| `moc` / `dashboard` / `reference` / `glossary` / `rules` / `index` | — | `aliases` |

### Truth-maintenance fields (apply to any type making factual claims)

For notes documenting **production behavior, server config, APIs, or external services**, include:

```yaml
last-verified: YYYY-MM-DD      # When we last confirmed this is true
verified-by: <agent or human>  # Who confirmed
source: <URL | file:path | session-log-link>  # Where the truth came from
confidence: high | medium | low | guess
```

> [!warning] Stale truth check
> Notes with `last-verified` older than **90 days** should be flagged on [[Vault-Dashboard]]. Re-verify before relying on them.

### Hyphenated field rule (Dataview)

> [!danger] Dataview interprets `field-name` as subtraction (`field` minus `name`).
> **Always quote hyphenated fields** in DQL and DataviewJS:
> - DQL: `WHERE row["session-date"] > date(today) - dur(30 days)` (not `WHERE session-date`)
> - JS: `p["duration-minutes"]` (not `p.duration-minutes`)
> - SORT in DQL: `SORT row["session-date"] DESC`

## Tag Taxonomy

Use **nested tags** for hierarchy. Examples:

- `#project/spx` — SPX-related
- `#project/general` — general/cross-project
- `#area/api`, `#area/db`, `#area/notify`, `#area/auth`
- `#topic/memory-vault`, `#topic/agent-orchestration`
- `#status/active`, `#status/archived`, `#status/wip`

> [!example] Good Tagging
> ```yaml
> tags:
>   - project/spx
>   - area/db
>   - topic/migration
>   - status/active
> ```

## Writing Rules for AI

> [!success] DO
> - **Use wikilinks** `[[Note Name]]` between notes — Obsidian tracks renames.
> - **Use callouts** for emphasis (`> [!note]`, `> [!warning]`, etc.).
> - **One fact per file** when in doubt — split rather than merge.
> - **Update `updated:` frontmatter** on every edit.
> - **Log session work** to `05_Agent_Session_Logs/` before stopping.
> - **Cite sources** with `[[06_Sources/...]]` when stating non-obvious facts.

> [!failure] DON'T
> - ❌ Create duplicate notes — search first.
> - ❌ Use inline lists where Markdown lists fit (readability).
> - ❌ Dump raw API responses — summarize and link.
> - ❌ Mix multiple topics in one note (violates Atomic principle).
> - ❌ Edit `99_Templates/` mid-session unless the schema itself changed.

## Memory Hygiene (Anti-Context-Rot)

> [!quote] Cloudflare on Agent Memory
> "Context window getting bigger ≠ better. The real game is who retrieves the **right** context at the **right** time."

**Rules to prevent context rot:**

1. **Compactor pass** — Once per month, AI scans `05_Agent_Session_Logs/` and promotes important insights to `07_Insights/`.
2. **Deprecation > Deletion** — Set `status: archived` instead of deleting.
3. **Supersede chains** — New ADR with `supersedes: [[ADR-NNN]]`, old ADR with `superseded-by: [[ADR-MMM]]`.
4. **Inbox pattern** — Quick captures go to `00_Index/Inbox.md`, then move to proper folder weekly.

## Search Patterns AI Should Use

| Need | Tool / Query |
|---|---|
| Find by topic | Search tag `#topic/<name>` |
| Find all ADRs | `path:04_Architecture_Decisions/` |
| Find recent sessions | `path:05_Agent_Session_Logs/ sort:modified` |
| Find related to X | Search wikilink `[[X]]` |
| Find what changed today | `updated: today` (frontmatter query) |

### Plugin Stack (2026-05-13)

> [!success] Plugin status
> - **Dataview** — ACTIVE — auto-generate views from frontmatter (use for any list/count task)
> - **Templater** — ACTIVE — interactive template insertion with prompts + auto-rename/move
> - **Linter** — INSTALLED but NOT auto-running (`lintOnSave: false`, `yaml-timestamp.enabled: false`). Use project-memory MCP verification tools for vault health.

**Setup details:** see [[Plugin-Setup]].

### Note Creation Workflow

> [!important] Always create notes via Templater
> 1. `Ctrl+N` to create blank note.
> 2. `Ctrl+Shift+T` (or your Templater hotkey) → pick a template.
> 3. Answer prompts → file is renamed and moved to the right folder automatically.

**Available templates** (in `99_Templates/`):
- `Template-Note` — generic note
- `Template-ADR` — architecture decision
- `Template-Session-Log` — agent session log
- `Template-Component` — reusable component

### `updated:` Field Maintenance

> [!warning] You DO need to update `updated:` manually when editing a note
> The Obsidian Linter plugin is installed but **NOT** configured to auto-bump timestamps in this vault (`lintOnSave: false`). Two options going forward:
>
> **Option A (current default):** Update `updated: YYYY-MM-DD` by hand whenever you edit a note. Use `memory_checkStaleness` and `memory_verifyNote` when freshness matters.
>
> **Option B (if you prefer auto-bump):** Open Obsidian Settings → Linter → enable `Lint on save` and the `YAML timestamp` rule with `Date Modified Key = updated`. Then this section should be flipped back to "Linter handles it."
>
> Whichever option is in force, **this section must match the actual `.obsidian/plugins/obsidian-linter/data.json` state.** If you toggle the plugin, also flip the docs.

### Dataview Usage

Use Dataview for any "find / list / count" task that depends on frontmatter.

**When to reach for Dataview vs manual search:**

| Task | Use |
|---|---|
| "List all ADRs by status" | Dataview |
| "What sessions happened this month?" | Dataview |
| "Find that one note about X" | Wikilink / search |
| "Show me orphan notes" | Dataview |

**Quick query patterns:**

````markdown
```dataview
TABLE status, file.mtime AS "Updated"
FROM "04_Architecture_Decisions"
WHERE type = "adr"
SORT row["decision-date"] DESC
```

```dataview
LIST
FROM #project/spx
SORT file.name
```
````

> [!warning] Hyphenated frontmatter fields
> Fields like `decision-date`, `derived-from`, `session-date` must be **quoted** in `WHERE` clauses:
> ```dataview
> WHERE this["decision-date"] >= date("2026-01-01")
> ```

See [[Dataview-Queries]] for the full cheatsheet, and [[Vault-Dashboard]] for a live health board.

## When To Update This File

> [!danger] AGENTS.md is the constitution
> Only update when:
> - A new folder is added to the vault.
> - A new file type / template is introduced.
> - A naming convention changes.
> - Tag taxonomy expands.
>
> All changes MUST be logged in `05_Agent_Session_Logs/` with rationale.

## Related

- [[MOC-Home]] — Map of Content
- [[Vault-Dashboard]] — live health board
- [[Plugin-Setup]] — Dataview + Templater + Linter config
- [[Dataview-Queries]] — query cheatsheet
- [[Memory-Vault-Principles]] — why this vault exists
- [[Context-Rot-Prevention]] — how we keep memory clean
- [[Template-Note]] — start a new note from here

---

> [!info] Living Document
> Last reviewed: 2026-05-13. Next review: when vault hits 50 files or 30 days, whichever first.
