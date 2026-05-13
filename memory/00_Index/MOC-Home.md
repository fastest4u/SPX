---
title: MOC-Home - Map of Content
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

# Map of Content - Home

> [!abstract] Vault Mission
> A persistent, tool-agnostic memory vault for the developer + AI team. It captures project rules, source-grounded references, architecture decisions, session logs, runbooks, insights, mistakes, and reusable patterns.

---

## Start Here

> [!important] First-time agent? Read these in order.
> 1. [[AGENTS]] - vault constitution, schema, and retrieval protocol.
> 2. [[AGENT-IDENTITY]] - project role, beliefs, limits, and rituals.
> 3. [[Awakened-AI-System]] - operating model for memory-aware AI work.
> 4. [[SPX-System-Map]] - source-grounded runtime, data, UI, and memory map.
> 5. [[Goals]] - long-term goal stack.
> 6. [[Open-Followups]] - pending tasks across sessions.
> 7. [[Glossary]] - vocabulary.
> 8. [[Memory-Vault-Principles]] - why the vault exists.

> [!tip] Need to do operational work?
> Open the runbooks: [[Runbook-API-Session-Expired]], [[Runbook-Auto-Accept-Debug]], [[Runbook-DB-Migration]], [[Runbook-Production-Schema-Verification]], [[Runbook-Production-Alert-Policy]], [[Runbook-Multi-AI-Memory-Acceptance]], [[Runbook-Notify-Failure]], [[Runbook-Deploy-Safety-Checklist]], [[Runbook-Production-Deploy]].

---

## Awakening Stack

| Level | What | Where |
|---|---|---|
| L1 Memory | Persistent storage | This vault |
| L2 Reflection | Mistakes and confidence | [[08_Mistakes/README]], `confidence:` frontmatter |
| L3 Identity | Role, goals, limits | [[AGENT-IDENTITY]], [[Goals]] |
| L4 Awakening | Self-checking and multi-perspective work | [[Awakened-AI-System]], workflow files |

---

## Recently Updated

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

## By Layer

### Project Rules

```dataview
TABLE status, file.mtime AS "Updated"
FROM "01_Project_Rules"
WHERE type = "rules" OR type = "reference"
SORT file.name ASC
```

### API Docs

```dataview
TABLE status, row["last-verified"] AS "Verified", confidence
FROM "02_API_Docs"
WHERE type = "reference"
SORT file.name ASC
```

### Reusable Components

```dataview
TABLE language, status, dependencies
FROM "03_Reusable_Components"
WHERE type = "component"
SORT file.name ASC
```

### Architecture Decisions

```dataview
TABLE
  status AS "Status",
  row["decision-date"] AS "Decided",
  supersedes AS "Supersedes"
FROM "04_Architecture_Decisions"
WHERE type = "adr"
SORT row["decision-date"] DESC
```

### Session Logs

```dataview
TABLE
  agent AS "Agent",
  row["duration-minutes"] AS "Duration",
  outcomes AS "Outcomes"
FROM "05_Agent_Session_Logs"
WHERE type = "session-log"
SORT row["session-date"] DESC
LIMIT 10
```

### Insights and Mistakes

```dataview
TABLE type, status, confidence
FROM "07_Insights" OR "08_Mistakes"
WHERE type
SORT file.name ASC
```

### Runbooks

```dataview
TABLE status, row["last-verified"] AS "Verified", confidence
FROM "09_Runbooks"
WHERE type = "runbook"
SORT file.name ASC
```

---

## Navigation by Question

| If you're asking | Where to look |
|---|---|
| How should AI operate on this project? | [[Awakened-AI-System]] |
| How do I test whether the memory is good enough? | [[Memory-Evaluation-Test]] |
| How do I score Memory Vault quality? | [[Memory-Quality-Score]] |
| What is the current multi-AI acceptance status? | [[Multi-AI-Acceptance-Results]] |
| How does the whole SPX system work? | [[SPX-System-Map]] |
| What rules apply to code changes? | [[SPX-Project-Rules]] |
| What upstream bidding endpoints are used? | [[API-Bidding-Endpoints]] |
| What internal HTTP routes does the dashboard use? | [[API-Internal-HTTP]] |
| What SSE payloads update the UI? | [[API-SSE-Events]] |
| How does the poller coordinate work? | [[Component-Poller-Orchestration]] |
| How do notify rules choose JSON vs DB? | [[Component-Dual-Storage-Notify-Rules]] |
| Why was dual storage chosen? | [[ADR-001-Dual-Storage-Notify-Rules]] |
| Why are dashboard settings DB-backed? | [[ADR-002-DB-Backed-Live-Settings]] |
| How do I recover an expired SPX session? | [[Runbook-API-Session-Expired]] |
| How do I check production schema drift? | [[Runbook-Production-Schema-Verification]] |
| What production conditions should alert? | [[Runbook-Production-Alert-Policy]] |
| How do I test multiple AI tools against the vault? | [[Runbook-Multi-AI-Memory-Acceptance]] |
| What must I check before pushing to main? | [[Runbook-Deploy-Safety-Checklist]] |
| How should I structure a new note? | `99_Templates/` |
| What does a term mean? | [[Glossary]] |
| Useful Dataview queries? | [[Dataview-Queries]] |

---

## Topic Views

### Project SPX

```dataview
TABLE type, status
FROM #project/spx
SORT file.mtime DESC
```

### Memory Vault

```dataview
LIST
FROM #topic/memory-vault
SORT file.name ASC
```

### Agent Orchestration

```dataview
LIST
FROM #topic/agent-orchestration
SORT file.name ASC
```

---

## Vault Health

### Notes by Type

```dataview
TABLE length(rows) AS "Count"
FROM ""
WHERE type
GROUP BY type
SORT length(rows) DESC
```

### Notes Possibly Stale

```dataview
TABLE file.mtime AS "Last Edit"
FROM ""
WHERE file.mtime < date(today) - dur(90 days)
  AND (status != "archived" OR !status)
  AND type
SORT file.mtime ASC
```

### Orphan Notes

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

## Conventions Quick Reference

- Files: `Kebab-Case.md`.
- Folders: `NN_PascalCase/`.
- Dates: `YYYY-MM-DD`.
- Links: use `[[Wikilinks]]` inside the vault.
- One topic per file.
- Update `updated:` on every edited note.

See [[AGENTS]] for full conventions.

---

## Maintenance Schedule

| Cadence | Action | Owner |
|---|---|---|
| End of session | Write session log to `05_Agent_Session_Logs/` | Agent |
| Weekly | Move inbox items to proper folders | Human |
| Monthly | Promote durable insights from sessions to `07_Insights/` | Agent |
| Quarterly | Review tags, stale notes, and dead links | Human |
| 30 files / 30 days | Re-read [[AGENTS]] and adjust retrieval rules | Both |

Use [[Vault-Dashboard]] for detailed health checks.
