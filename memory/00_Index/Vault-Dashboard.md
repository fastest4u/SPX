---
title: Vault Dashboard
type: dashboard
status: active
created: 2026-05-13
updated: 2026-05-13
tags:
  - meta
  - dashboard
aliases:
  - Dashboard
  - Vault Status
cssclasses:
  - dashboard
---

# Vault Dashboard

> [!abstract] Purpose
> Live health board for Memory Vault maintenance and Awakened AI quality checks.

---

## Automated Checks

Run from repo root:

```bash
npm run memory:verify
```

For code + memory changes, run the full repo gate:

```bash
npm run verify
```

Expected:

- `memory:check` exits 0 with no frontmatter, wikilink, Dataview, freshness, or stale-truth errors.
- `memory:eval` exits 0 with 100 percent retrieval coverage.
- `memory:verify` exits 0 only when both checks pass.
- `verify` exits 0 only when `memory:verify` and `build` both pass.

See [[Memory-Evaluation-Test]].

---

## Overview

### Total notes by type

```dataview
TABLE WITHOUT ID
  type AS "Type",
  length(rows) AS "Count"
FROM ""
WHERE type
GROUP BY type
SORT length(rows) DESC
```

### Total notes by status

```dataview
TABLE WITHOUT ID
  status AS "Status",
  length(rows) AS "Count"
FROM ""
WHERE type AND status
GROUP BY status
SORT length(rows) DESC
```

---

## Activity

### Edited in last 7 days

```dataview
TABLE
  file.mtime AS "When",
  type AS "Type"
FROM ""
WHERE file.mtime >= date(today) - dur(7 days) AND type
SORT file.mtime DESC
```

### Sessions this month

```dataview
TABLE
  agent AS "Agent",
  row["duration-minutes"] AS "Min",
  outcomes AS "Outcomes"
FROM "05_Agent_Session_Logs"
WHERE row["session-date"] >= date(today) - dur(30 days)
SORT row["session-date"] DESC
```

---

## Health Alerts

### Stale notes

```dataview
TABLE file.mtime AS "Last Edit", status
FROM ""
WHERE file.mtime < date(today) - dur(90 days)
  AND (status != "archived" OR !status)
  AND type
SORT file.mtime ASC
```

### Orphan notes

```dataview
LIST
FROM ""
WHERE length(file.inlinks) = 0
  AND type
  AND file.name != "MOC-Home"
  AND file.name != "AGENTS"
  AND file.name != "Vault-Dashboard"
  AND type != "template"
  AND type != "moc"
  AND type != "dashboard"
SORT file.name
```

### Missing frontmatter

```dataview
LIST
FROM ""
WHERE !type AND file.ext = "md"
SORT file.name
```

### Notes with no tags

```dataview
LIST
FROM ""
WHERE length(file.tags) = 0 AND type
SORT file.name
```

---

## Truth Maintenance

### Source-grounded references

```dataview
TABLE
  row["last-verified"] AS "Verified",
  row["verified-by"] AS "By",
  confidence AS "Confidence",
  source AS "Source"
FROM ""
WHERE type = "reference" OR type = "runbook" OR type = "component"
SORT row["last-verified"] DESC
```

### Open mistakes

```dataview
TABLE
  severity AS "Severity",
  area AS "Area",
  row["occurred-date"] AS "Occurred"
FROM "08_Mistakes"
WHERE type = "mistake" AND status = "open"
SORT row["occurred-date"] DESC
```

---

## Connectivity

### Most-linked-to notes

```dataview
TABLE length(file.inlinks) AS "Inbound"
FROM ""
WHERE length(file.inlinks) >= 2 AND type
SORT length(file.inlinks) DESC
LIMIT 10
```

### Most outgoing links

```dataview
TABLE length(file.outlinks) AS "Outbound"
FROM ""
WHERE length(file.outlinks) >= 5 AND type
SORT length(file.outlinks) DESC
LIMIT 10
```

---

## Outstanding Tasks

### Open tasks across session logs

```dataview
TASK
FROM "05_Agent_Session_Logs"
WHERE !completed
GROUP BY file.link
```

### Open tasks anywhere in vault

```dataview
TASK
FROM ""
WHERE !completed AND file.folder != "99_Templates"
GROUP BY file.link
```

---

## Maintenance Checklist

- [ ] Run `npm run memory:verify` for memory-only work, or `npm run verify` for code + memory work.
- [ ] Review stale notes and update or archive.
- [ ] Review orphan notes and link them from a hub.
- [ ] Review open mistake notes.
- [ ] Promote repeated session insights to `07_Insights/`.
- [ ] Update [[AGENTS]] if a retrieval pattern changed.
- [ ] Write a session log for the maintenance pass.

---

## Related

- [[MOC-Home]]
- [[Dataview-Queries]]
- [[Context-Rot-Prevention]]
- [[Memory-Evaluation-Test]]
- [[Runbook-Multi-AI-Memory-Acceptance]]
- [[AGENTS]]
