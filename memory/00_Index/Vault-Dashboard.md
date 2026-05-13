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

# 📊 Vault Dashboard

> [!abstract] Purpose
> Live health board for the vault. Run through this during **monthly compactor passes** (see [[Context-Rot-Prevention]]).

---

## 🟢 Overview

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

## 📈 Activity

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
  duration-minutes AS "Min",
  outcomes AS "Outcomes"
FROM "05_Agent_Session_Logs"
WHERE row["session-date"] >= date(today) - dur(30 days)
SORT row["session-date"] DESC
```

---

## 🚨 Health Alerts

### ⚠️ Stale notes (90+ days, not archived)

```dataview
TABLE file.mtime AS "Last Edit", status
FROM ""
WHERE file.mtime < date(today) - dur(90 days)
  AND (status != "archived" OR !status)
  AND type
SORT file.mtime ASC
```

### 🕳️ Orphan notes (no inbound links)

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

### ❌ Missing frontmatter

```dataview
LIST
FROM ""
WHERE !type AND file.name != "Welcome" AND file.ext = "md"
SORT file.name
```

### 🏷️ Notes with no tags

```dataview
LIST
FROM ""
WHERE length(file.tags) = 0 AND type
SORT file.name
```

---

## 🔗 Connectivity

### Most-linked-to notes (vault hubs)

```dataview
TABLE length(file.inlinks) AS "Inbound"
FROM ""
WHERE length(file.inlinks) >= 2 AND type
SORT length(file.inlinks) DESC
LIMIT 10
```

### Most outgoing links (well-connected sources)

```dataview
TABLE length(file.outlinks) AS "Outbound"
FROM ""
WHERE length(file.outlinks) >= 5 AND type
SORT length(file.outlinks) DESC
LIMIT 10
```

---

## 🏛️ Architecture Decisions

### All ADRs by status

```dataview
TABLE
  status AS "Status",
  decision-date AS "Decided",
  supersedes AS "Supersedes",
  superseded-by AS "Superseded By"
FROM "04_Architecture_Decisions"
WHERE type = "adr"
SORT row["decision-date"] DESC
```

---

## 💡 Insights Library

```dataview
TABLE
  confidence AS "Confidence",
  status AS "Status",
  length(derived-from) AS "Sources"
FROM "07_Insights"
WHERE type = "insight"
SORT file.name
```

---

## ✅ Outstanding Tasks

### Open tasks across all session logs

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

## 📅 Maintenance Checklist

Use this on the **1st of each month**:

- [ ] Review `Stale notes` section above → archive or update.
- [ ] Review `Orphan notes` → link to MOC or relevant note, or delete.
- [ ] Review `Missing frontmatter` → fix or remove.
- [ ] Review `Notes with no tags` → add at least 2 tags.
- [ ] Read last month's session logs in [[MOC-Home#📝 Agent Session Logs]] → promote recurring insights to `07_Insights/`.
- [ ] Update [[AGENTS]] if any new pattern emerged.
- [ ] Write a session log titled `YYYY-MM-DD-Monthly-Compactor.md`.

---

## Related

- [[MOC-Home]] — navigation hub
- [[Dataview-Queries]] — query reference
- [[Context-Rot-Prevention]] — why we maintain
- [[AGENTS]] — vault rules
