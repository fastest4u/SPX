---
title: Open Follow-Ups — Aggregated Task Dashboard
type: dashboard
status: active
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Follow-ups
  - Open Tasks
  - TODO Aggregator
tags:
  - meta
  - moc
  - tasks
---

# 📋 Open Follow-Ups (Vault-Wide)

> [!abstract] Why this page exists
> Session logs are immutable history. But their `- [ ]` checkboxes are **live tasks** — and they get lost across files. This dashboard aggregates every unchecked task so nothing falls through the cracks.

> [!important] How to use
> 1. **Read** the relevant section before starting work to see pending items.
> 2. **Resolve** a task → return to its source session log → check the box (`- [x]`).
> 3. **Promote** a recurring or large task → move to [[Goals]] as G-NNN.
> 4. **Refresh dataview** in Obsidian to update this page (auto on file change).

---

## 🔥 All Open Tasks (Session Logs)

```dataview
TASK
FROM "05_Agent_Session_Logs"
WHERE !completed AND !checked
GROUP BY file.link
SORT file.mtime DESC
```

---

## 🧨 Open Mistake Resolutions

```dataview
TABLE
  severity AS "Severity",
  area AS "Area",
  occurred-date AS "Occurred"
FROM "08_Mistakes"
WHERE type = "mistake" AND status = "open"
SORT row["occurred-date"] DESC
```

---

## 🎯 Active Goals Snapshot

```dataview
TABLE WITHOUT ID
  file.link AS "Goal Note",
  status AS "Status",
  updated AS "Last Updated"
FROM "00_Index"
WHERE file.name = "Goals"
```

→ Open the [[Goals]] note for full goal stack.

---

## 📊 Aggregate Stats

```dataviewjs
const sessions = dv.pages('"05_Agent_Session_Logs"');
let total = 0, completed = 0;
for (const s of sessions) {
  for (const t of (s.file.tasks || [])) {
    total++;
    if (t.completed) completed++;
  }
}
const open = total - completed;
const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
dv.paragraph(`**${open}** open · **${completed}** done · **${pct}%** completion rate (${total} total tasks across ${sessions.length} sessions)`);
```

---

## 🗓️ Stale Open Tasks (Sessions > 30 days, still has open tasks)

```dataviewjs
const sessions = dv.pages('"05_Agent_Session_Logs"')
  .where(s => s["session-date"]);
const cutoff = dv.date("today").minus(dv.duration("30 days"));
const stale = sessions.where(s => {
  const tasks = s.file.tasks || [];
  const hasOpen = tasks.some(t => !t.completed);
  return hasOpen && s["session-date"] < cutoff;
});
dv.table(
  ["Session", "Date", "Open tasks"],
  stale.map(s => [
    s.file.link,
    s["session-date"],
    (s.file.tasks || []).filter(t => !t.completed).length
  ])
);
```

> [!warning] Triage rule
> If a session log has open tasks > 30 days old:
> 1. **Do** it (if still relevant), or
> 2. **Promote** to [[Goals]] (if long-term), or
> 3. **Strike-through** in the original log with a follow-up note explaining why it's abandoned.

---

## 🔧 Maintenance Rules

> [!success] When AI completes a follow-up
> 1. Open the original session log
> 2. Change `- [ ]` to `- [x]`
> 3. **Don't add new info** to old logs — append a new session log if the resolution is substantial
> 4. Update this dashboard's `updated:` field

> [!failure] DON'T
> - Delete tasks from old session logs (history is sacred)
> - Edit task wording (use strike-through if obsolete)
> - Move tasks between logs (keep them at point of origin)

---

## Related

- [[MOC-Home]] — vault navigation
- [[Goals]] — long-term goal stack (promote recurring tasks here)
- [[Vault-Dashboard]] — health metrics
- [[AGENTS]] — vault constitution
