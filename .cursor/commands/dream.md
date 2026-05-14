---
description: Memory compactor — promote insights from session logs, dedupe, archive stale notes, refresh MOC. Run monthly.
---

# /dream — Memory Compactor

## When To Run

- Monthly (1st of each month) — default cadence.
- When `memory/05_Agent_Session_Logs/` has > 30 files.
- When AI starts citing contradicting information.
- When the user wants a memory audit.

## Steps

1. Open `memory/00_Index/Vault-Dashboard.md` for live metrics.
2. Read the last month of session logs in `memory/05_Agent_Session_Logs/`.
3. Find recurring insights (appear in 2+ logs):
   - Group by topic.
   - Check if a `07_Insights/` note already exists.
   - If no → create a new insight note.
   - If yes → append new evidence + bump `updated:` date.
4. Dedupe overlapping notes:
   - Pick the canonical version → others get `status: superseded` + `superseded-by:`.
5. Archive stale notes (90+ days no edit, `status` not active):
   - Set `status: archived`.
   - Do NOT delete.
6. Check ADR supersede chains:
   - Verify `superseded-by:` points to a real ADR.
   - Verify accepted ADRs are not contradicted by newer accepted ADRs.
7. Refresh `memory/00_Index/MOC-Home.md` if topology changed.
8. Update `memory/00_Index/Goals.md`:
   - Mark completed goals → move to "Recently Completed".
   - Surface blocked goals.
9. Write a compactor session log:
   - `memory/05_Agent_Session_Logs/YYYY-MM-DD-Dream-Compactor.md`
   - Document insights promoted, notes archived, duplicates merged, MOC changes.

## Rules

- Never delete — only archive or supersede.
- Cite sources when promoting insights — link to ≥ 2 session logs.
- Preserve append-only invariant — don't edit old session logs.
- Be conservative — when unsure if it's stale, leave it.

## Output

```text
## 🌙 Compactor complete

**Insights promoted:** <N>
**Notes archived:** <N>
**Duplicates merged:** <N>
**ADR chains fixed:** <N>
**MOC refreshed:** yes/no
**Open follow-ups:** <N>

Session log: memory/05_Agent_Session_Logs/YYYY-MM-DD-Dream-Compactor.md
```
