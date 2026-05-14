---
title: Mistakes Registry
type: index
status: active
created: 2026-05-13
updated: 2026-05-13
tags:
  - meta
  - mistakes
  - learning
aliases:
  - Mistake Registry
  - Lessons Learned
---

# 🧨 Mistakes Registry

> [!abstract] Purpose
> Permanent record of mistakes made by AI agents (or humans) on the SPX project. **Future AI agents read this BEFORE attempting similar work** to avoid repeating errors.

> [!quote] Philosophy
> "Smart people learn from their mistakes. Wise people learn from others' mistakes."
> A vault is wise when it learns from past sessions.

---

## When To Add a Mistake

> [!success] Add a mistake entry when
> - AI took a wrong path that wasted significant time
> - A bug was caused by a wrong assumption
> - A tool/library was misused
> - A convention was violated unintentionally
> - User had to correct AI's plan
> - **Confidence was high but the claim was wrong** (always log in session Confidence Log, create Mistake if pattern could recur)

> [!tip] Mistake Escalation Threshold
> - First occurrence → log in session Confidence Log
> - Second occurrence (same pattern) → create or update Mistake note
> - Third occurrence → create Runbook or update ADR if architectural
> 
> User explicitly requested: "ทุกครั้งที่ AI ผิด ให้บันทึกทันที" — this means log in Confidence Log always; create Mistake note when the pattern is non-trivial.

> [!failure] Skip these
> - Simple typos (just fix them)
> - One-off transient errors
> - Things explicitly experimental

---

## Filename Convention

```
Mistake-NNN-Short-Kebab-Topic.md
```

- `NNN` = zero-padded 3-digit sequential
- **Never renumber** — once given, mistake ID is permanent
- Short title in kebab-case

**Examples:**
- `Mistake-001-Wrong-Env-Var-Name.md`
- `Mistake-002-Forgot-Js-Suffix-Import.md`

---

## Mistakes Index

```dataview
TABLE
  severity AS "Severity",
  status AS "Status",
  area AS "Area",
  occurred-date AS "When"
FROM "08_Mistakes"
WHERE type = "mistake"
SORT row["occurred-date"] DESC
```

## Top Mistake Patterns (Aggregate)

```dataview
TABLE length(rows) AS "Count"
FROM "08_Mistakes"
WHERE type = "mistake"
GROUP BY area
SORT length(rows) DESC
```

---

## How AI Should Use This

> [!important] Before starting any task
> 1. Search `08_Mistakes/` for matching `area` or `tags`.
> 2. Read 1-2 most relevant entries.
> 3. State explicitly: "I see Mistake-NNN warns about X — I will avoid it by Y."

> [!example] In session log
> Add to "Insights / Learnings":
> ```markdown
> - Avoided [[Mistake-NNN-...]] by checking <thing> first.
> ```

---

## Related

- [[Template-Mistake]] — template for new entries
- [[Memory-Vault-Principles]] — why we maintain memory
- [[Context-Rot-Prevention]] — why we don't delete old entries
