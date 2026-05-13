---
title: MOC-Home — Map of Content
type: moc
created: 2026-05-13
updated: 2026-05-13
tags:
  - meta
  - moc
  - navigation
aliases:
  - Home
  - Index
  - Vault Hub
cssclasses:
  - moc
---

# 🗺️ Map of Content — Home

> [!abstract] Vault Mission
> A persistent, tool-agnostic **memory vault** for the developer + AI team. Powered by Markdown, organised by convention, indexed by Dataview. Inspired by [[LeafBox-03-Obsidian-Memory-for-AI]].

> [!success] Dataview active
> Sections below auto-update from frontmatter. **Edit a note → MOC reflects it instantly.** No manual list maintenance.

---

## 🚪 Start Here

> [!important] First-time agent? Read these in order.
> 1. [[AGENTS]] — the vault constitution (rules + schema).
> 2. [[AGENT-IDENTITY]] — **who I am** on this project (role, beliefs, limits).
> 3. [[Goals]] — what I'm working toward (long-term goal stack).
> 4. [[Open-Followups]] — pending tasks across all sessions.
> 5. This page ([[MOC-Home]]) — the map.
> 6. [[Glossary]] — vocabulary.
> 7. [[Memory-Vault-Principles]] — *why* this exists.

> [!tip] Need to do operational work?
> Open [[09_Runbooks/]] — playbooks for predictable tasks (deploy, DB migration, API recovery, etc.)

## 🧠 Awakening Stack (Metacognition Layer)

> [!success] This vault is more than memory — it's a mind
> | Level | What | Where |
> |---|---|---|
> | **L1 Memory** | Persistent storage | This vault |
> | **L2 Reflection** | Mistakes + confidence | [[08_Mistakes/]], `confidence:` frontmatter |
> | **L3 Identity** | Role + goals | [[AGENT-IDENTITY]], [[Goals]] |
> | **L4 Awakening** | Self-check + dream + multi-perspective | `/self-check`, `/dream`, `/multi-perspective` workflows |

---

## 🆕 Recently Updated (Top 10)

```dataview
TABLE
  file.mtime AS "Modified",
  type AS "Type",
  status AS "Status"
FROM ""
WHERE file.name != "MOC-Home" AND type
SORT file.mtime DESC
LIMIT 10
```

---

## 📁 By Layer

### Layer 1 — Sources (Raw Input)

```dataview
TABLE
  source-author AS "Author",
  source-date AS "Source Date",
  ingested-date AS "Ingested"
FROM "06_Sources"
WHERE type = "source"
SORT row["ingested-date"] DESC
```

### Layer 2 — Memory (Distilled Knowledge)

#### 📐 Project Rules

```dataview
TABLE status, file.mtime AS "Updated"
FROM "01_Project_Rules"
WHERE type = "rules"
SORT file.name ASC
```

#### 🏛️ Architecture Decisions

```dataview
TABLE
  status AS "Status",
  decision-date AS "Decided",
  supersedes AS "Supersedes"
FROM "04_Architecture_Decisions"
WHERE type = "adr"
SORT row["decision-date"] DESC
```

#### 📝 Agent Session Logs

```dataview
TABLE
  agent AS "Agent",
  duration-minutes AS "Duration (m)",
  outcomes AS "Outcomes"
FROM "05_Agent_Session_Logs"
WHERE type = "session-log"
SORT row["session-date"] DESC
LIMIT 10
```

#### 💡 Insights

```dataview
TABLE
  confidence AS "Confidence",
  status AS "Status",
  derived-from AS "Derived From"
FROM "07_Insights"
WHERE type = "insight"
SORT file.name ASC
```

### Layer 3 — Schema (Rules + Templates)

```dataview
LIST
FROM "99_Templates"
SORT file.name ASC
```

Plus [[AGENTS]] at vault root.

---

## 🎯 By Topic (Tag-Driven)

### `#topic/memory-vault`

```dataview
LIST
FROM #topic/memory-vault
SORT file.name ASC
```

### `#project/spx`

```dataview
TABLE type, status
FROM #project/spx
SORT file.mtime DESC
```

### `#topic/agent-orchestration`

```dataview
LIST
FROM #topic/agent-orchestration
SORT file.name ASC
```

---

## 🧭 Navigation by Question

| If you're asking… | Where to look |
|---|---|
| "What rules apply to this code?" | [[SPX-Project-Rules]] or `#rules` |
| "Why did we build it this way?" | `04_Architecture_Decisions/` |
| "Has this been done before?" | `05_Agent_Session_Logs/` |
| "What article inspired this?" | `06_Sources/` |
| "How should I structure a new note?" | `99_Templates/` |
| "What does this term mean?" | [[Glossary]] |
| "Useful Dataview queries?" | [[Dataview-Queries]] |

---

## 📊 Vault Health

### Notes by Type

```dataview
TABLE length(rows) AS "Count"
FROM ""
WHERE type
GROUP BY type
SORT length(rows) DESC
```

### Notes Possibly Stale (no edits in 90+ days, not archived)

```dataview
TABLE file.mtime AS "Last Edit"
FROM ""
WHERE file.mtime < date(today) - dur(90 days)
  AND (status != "archived" OR !status)
  AND type
SORT file.mtime ASC
```

### Orphan Notes (no inbound links)

```dataview
LIST
FROM ""
WHERE length(file.inlinks) = 0
  AND file.name != "MOC-Home"
  AND file.name != "AGENTS"
  AND type != "template"
  AND type
SORT file.name
```

---

## 📐 Conventions Quick Reference

> [!info] One-screen reminder
> - **Naming** — `Kebab-Case.md` for files, `NN_PascalCase/` for folders.
> - **Dates** — `YYYY-MM-DD`.
> - **Links** — `[[Wikilinks]]` inside vault, `[text](url)` external.
> - **One topic per file** — when in doubt, split.
> - **Always update `updated:` field** on edit.

See [[AGENTS]] for full convention list.

---

## 🔮 Maintenance Schedule

| Cadence | Action | Owner |
|---|---|---|
| **End of session** | Write session log to `05_*` | Agent |
| **Weekly** | Move inbox items to proper folders | Human |
| **Monthly** | Promote insights from sessions → `07_Insights/` | Agent |
| **Quarterly** | Review tags, prune dead links | Human |
| **30 files / 30 days** | Re-read [[AGENTS]], adjust if needed | Both |

→ Use [[Vault-Dashboard]] for live status during maintenance passes.

---

> [!quote] Convention is the new schema. Filesystem is the new index. Dataview is the query.
> — Adapted from Obsidian Memory for AI SPEC-v3

%% Dataview makes this hub self-maintaining. Don't add manual lists — query instead. %%
