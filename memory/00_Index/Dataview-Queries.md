---
title: Dataview Queries Cheatsheet
type: reference
status: active
created: 2026-05-13
updated: 2026-05-13
tags:
  - meta
  - reference
  - topic/dataview
aliases:
  - DQL Cheatsheet
  - Vault Queries
---

# 🔍 Dataview Queries Cheatsheet

> [!abstract] Purpose
> Copy-paste-ready Dataview queries for this vault. Every query respects the [[AGENTS|frontmatter schema]].

> [!info] Quick syntax recap
> - **DQL** (this page) — `TABLE | LIST | TASK | CALENDAR` in ` ```dataview ` blocks.
> - **DataviewJS** — JS API in ` ```dataviewjs ` blocks (advanced, not covered here).

---

## 🆕 Recent Activity

### Last 10 edited notes

````markdown
```dataview
TABLE file.mtime AS "Modified", type, status
FROM ""
WHERE type
SORT file.mtime DESC
LIMIT 10
```
````

### Edited this week

````markdown
```dataview
TABLE file.mtime AS "Modified", type
FROM ""
WHERE file.mtime >= date(today) - dur(7 days) AND type
SORT file.mtime DESC
```
````

### Edited today

````markdown
```dataview
LIST
FROM ""
WHERE file.mtime >= date(today)
SORT file.mtime DESC
```
````

---

## 🗂️ By Folder

### All sessions

````markdown
```dataview
TABLE agent, duration-minutes AS "Min", outcomes
FROM "05_Agent_Session_Logs"
WHERE type = "session-log"
SORT row["session-date"] DESC
```
````

### All ADRs by status

````markdown
```dataview
TABLE status, decision-date AS "Decided"
FROM "04_Architecture_Decisions"
WHERE type = "adr"
SORT row["decision-date"] DESC
```
````

### Accepted ADRs only

````markdown
```dataview
LIST
FROM "04_Architecture_Decisions"
WHERE type = "adr" AND status = "accepted"
SORT row["decision-date"] DESC
```
````

### All insights with high confidence

````markdown
```dataview
TABLE confidence, derived-from
FROM "07_Insights"
WHERE confidence = "high"
SORT file.name
```
````

### All sources

````markdown
```dataview
TABLE source-author AS "Author", source-date AS "Date", ingested-date AS "Ingested"
FROM "06_Sources"
SORT row["ingested-date"] DESC
```
````

---

## 🏷️ By Tag

### All SPX project notes

````markdown
```dataview
TABLE type, status
FROM #project/spx
SORT file.mtime DESC
```
````

### Anything tagged with memory-vault topic

````markdown
```dataview
LIST
FROM #topic/memory-vault
SORT file.name
```
````

### Cross-tag (SPX AND DB)

````markdown
```dataview
LIST
FROM #project/spx AND #area/db
SORT file.name
```
````

### Inclusive (SPX OR notify area)

````markdown
```dataview
LIST
FROM #project/spx OR #area/notify
```
````

---

## 🩺 Health & Maintenance

### Notes without `updated` field

````markdown
```dataview
LIST
FROM ""
WHERE type AND !updated
SORT file.name
```
````

### Notes without tags

````markdown
```dataview
LIST
FROM ""
WHERE length(file.tags) = 0 AND type
SORT file.name
```
````

### Stale notes (90+ days, not archived)

````markdown
```dataview
TABLE file.mtime AS "Last Edit", status
FROM ""
WHERE file.mtime < date(today) - dur(90 days)
  AND (status != "archived" OR !status)
  AND type
SORT file.mtime ASC
```
````

### Orphan notes (no inbound wikilinks)

````markdown
```dataview
LIST
FROM ""
WHERE length(file.inlinks) = 0
  AND type
  AND file.name != "MOC-Home"
  AND file.name != "AGENTS"
SORT file.name
```
````

### Most-linked-to notes (hub detection)

````markdown
```dataview
TABLE length(file.inlinks) AS "Inbound Links"
FROM ""
WHERE length(file.inlinks) >= 3
SORT length(file.inlinks) DESC
LIMIT 10
```
````

### Broken supersede chain (ADRs)

````markdown
```dataview
TABLE supersedes
FROM "04_Architecture_Decisions"
WHERE supersedes
```
````

---

## 📈 Statistics

### Note count by type

````markdown
```dataview
TABLE length(rows) AS "Count"
FROM ""
WHERE type
GROUP BY type
SORT length(rows) DESC
```
````

### Note count by tag (top-level only)

````markdown
```dataview
TABLE length(rows) AS "Notes"
FROM ""
WHERE type
FLATTEN file.etags AS tag
GROUP BY tag
SORT length(rows) DESC
LIMIT 20
```
````

### Sessions per agent

````markdown
```dataview
TABLE length(rows) AS "Sessions", sum(rows["duration-minutes"]) AS "Total Min"
FROM "05_Agent_Session_Logs"
WHERE type = "session-log"
GROUP BY agent
SORT length(rows) DESC
```
````

---

## ✅ Task Queries

### Open tasks across the vault

````markdown
```dataview
TASK
FROM ""
WHERE !completed
GROUP BY file.link
```
````

### Open tasks in session logs

````markdown
```dataview
TASK
FROM "05_Agent_Session_Logs"
WHERE !completed
GROUP BY file.link
```
````

### Completed tasks today

````markdown
```dataview
TASK
FROM ""
WHERE completed AND completion >= date(today)
```
````

---

## 🔧 Inline Field Queries

When notes have **inline fields** like `priority:: high` in body:

````markdown
```dataview
TABLE priority, status
FROM ""
WHERE priority = "high"
```
````

---

## 🪄 DataviewJS (Advanced)

### Render link to most recent session

````markdown
```dataviewjs
const pages = dv.pages('"05_Agent_Session_Logs"')
  .where(p => p.type === "session-log")
  .sort(p => p["session-date"], 'desc');
dv.paragraph(`Most recent: ${pages[0].file.link}`);
```
````

### Custom session table with computed duration totals

````markdown
```dataviewjs
const sessions = dv.pages('"05_Agent_Session_Logs"');
const total = sessions.array().reduce((sum, s) => sum + (s["duration-minutes"] || 0), 0);
dv.paragraph(`Total session time: ${total} min (${(total/60).toFixed(1)} hr)`);
```
````

---

## 💡 Tips

> [!tip] Performance
> - Specify `FROM "folder"` instead of `FROM ""` whenever possible.
> - Use `WHERE type` to skip non-vault files like `.base`.
> - `LIMIT` early when exploring queries.

> [!warning] Frontmatter gotchas
> - **Hyphenated fields** like `decision-date` and `derived-from` must be **quoted** in DQL when used in `WHERE` or accessed via dot:
>     `WHERE this["decision-date"] = ...`
> - In `TABLE` headers, hyphenated names work directly.
> - `tags` field auto-flattens to `file.etags` (with `#` prefix).

> [!example] Refreshing queries
> Dataview re-runs queries on file save. Press `Ctrl+R` (or wait a beat) if a query feels stale.

---

## Related

- [[MOC-Home]] — uses many of these queries
- [[Vault-Dashboard]] — live health board built from these
- [[AGENTS]] — frontmatter schema that powers it all
