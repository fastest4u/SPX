---
title: Runbooks Index — SPX Operational Playbooks
type: index
status: active
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Runbooks
  - Playbooks
  - Operations
tags:
  - meta
  - moc
  - runbook
  - project/spx
---

# 🛠️ Runbooks — SPX Operational Playbooks

> [!abstract] Purpose
> Step-by-step procedures for **predictable operational tasks**. When something needs to be done the same way every time, write a runbook. When AI gets paged, runbooks tell it exactly what to check.

> [!important] Runbooks vs ADRs vs Insights
> | Type | Answers | Example |
> |---|---|---|
> | **Runbook** | *"How do I do X?"* | "How to deploy SPX safely" |
> | **ADR** | *"Why did we choose X?"* | "Why dual-storage notify rules" |
> | **Insight** | *"What did we learn?"* | "Memory-Vault Principles" |

---

## Active Runbooks

```dataview
TABLE
  status AS "Status",
  last-verified AS "Last Verified",
  severity-when-applies AS "Severity"
FROM "09_Runbooks"
WHERE type = "runbook"
SORT row["last-verified"] DESC
```

---

## When To Read Which Runbook

| Situation | Runbook |
|---|---|
| Auto-deploy failed | [[Runbook-Production-Deploy]] |
| Need to add/change DB column | [[Runbook-DB-Migration]] |
| Need to check production schema drift | [[Runbook-Production-Schema-Verification]] |
| Auto-accept not firing for matching rules | [[Runbook-Auto-Accept-Debug]] |
| Poller logs "session expired" / 401 | [[Runbook-API-Session-Expired]] |
| Discord/LINE notifications stopped arriving | [[Runbook-Notify-Failure]] |
| Need to test Claude Code / Cursor / Cascade against the vault | [[Runbook-Multi-AI-Memory-Acceptance]] |

---

## Truth-Maintenance Rule for Runbooks

> [!danger] Runbooks decay. Verify them on a schedule.
> Every runbook has `last-verified: YYYY-MM-DD`. If older than **90 days** for production-critical runbooks → mark `status: outdated` and re-verify before next use.

When verifying a runbook:
1. Walk through the steps on a test environment (or carefully in prod with backup).
2. Update `last-verified:` to today.
3. Update `verified-by:` to your agent name.
4. If steps changed → bump `updated:` and add changelog entry at bottom.

---

## How To Add a New Runbook

1. Filename: `Runbook-<Kebab-Title>.md`
2. Copy a recent runbook as template
3. Required frontmatter:

   ```yaml
   ---
   title: Runbook — <What it does>
   type: runbook
   status: active
   last-verified: YYYY-MM-DD
   verified-by: <agent or human>
   severity-when-applies: low | medium | high | critical
   related-adrs: [[ADR-NNN-...]]
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   tags: [runbook, project/spx, area/<area>]
   ---
   ```

4. Required sections: **Symptoms · Pre-Flight Check · Procedure · Verify · Rollback · References**

---

## Related

- [[AGENTS]] — vault constitution (runbook type schema)
- [[Goals]] — operational stability is G-002
- [[Open-Followups]] — runbook tasks may appear here
