---
description: Memory compactor — promote insights from session logs, dedupe, archive stale notes, refresh MOC. Run monthly.
---

# /dream — Memory Compactor

Inspired by Claude Code's **"Dreams"** feature ([[LeafBox-02-Claude-Code-Updates#4]]). When agents work for long periods, memory gets messy. This workflow tidies it up.

## When To Run

- **Monthly** (1st of each month) — default cadence.
- When `memory/05_Agent_Session_Logs/` has > 30 files.
- When AI starts citing contradicting information.
- Manually when the user wants a memory audit.

## Steps

1. **Open the Vault Dashboard** for live metrics:
   - `memory/00_Index/Vault-Dashboard.md`
   - Note: stale notes count, orphan count, total by type.

2. **Read the last month of session logs:**
   - `memory/05_Agent_Session_Logs/` sorted by date.
   - Skim each log's **"Insights / Learnings"** section.

3. **Find recurring insights** (appear in 2+ logs):
   - Group them by topic.
   - For each group → check if a `07_Insights/` note already exists.
   - If no → **create a new insight note** with template:

     ```yaml
     ---
     title: <Insight title>
     type: insight
     status: stable
     confidence: <high | medium | low>
     derived-from: [[YYYY-MM-DD-session-1]], [[YYYY-MM-DD-session-2]]
     created: <today>
     updated: <today>
     tags: [insight, topic/<name>, project/<name>]
     ---
     ```

   - If yes → append the new evidence + bump `updated:` date.

4. **Dedupe overlapping notes:**
   - Search for notes with identical or near-identical content.
   - Pick the canonical version → others get `status: superseded` + `superseded-by:`.

5. **Archive stale notes** (90+ days no edit, `status` not active):
   - Set `status: archived`.
   - Do NOT delete.

6. **Check ADR supersede chains:**
   - For each `ADR-NNN` with `status: superseded` → verify `superseded-by:` points to a real ADR.
   - For each `ADR-NNN` with `status: accepted` → verify it's not contradicted by a newer accepted ADR.

7. **Refresh MOC-Home if topology changed:**
   - New folders? → add section.
   - New tags emerged? → add tag query.

8. **Update Goals:**
   - `memory/00_Index/Goals.md`
   - Mark completed goals → move to "Recently Completed".
   - Surface blocked goals.

9. **Write a compactor session log:**
   - `memory/05_Agent_Session_Logs/YYYY-MM-DD-Dream-Compactor.md`
   - Document:
     - How many insights promoted
     - How many notes archived
     - How many duplicates merged
     - What MOC changed

10. **Report to user:**

    ```
    ## 🌙 Compactor complete

    **Insights promoted:** <N> (see 07_Insights/<files>)
    **Notes archived:** <N>
    **Duplicates merged:** <N>
    **ADR chains fixed:** <N>
    **MOC refreshed:** yes/no
    **Open follow-ups:** <N>

    Session log: memory/05_Agent_Session_Logs/YYYY-MM-DD-Dream-Compactor.md
    ```

## Rules

- **Never delete** — only archive or supersede. History is data.
- **Cite sources** when promoting insights — link to ≥ 2 session logs.
- **Preserve append-only invariant** — don't edit old session logs (write new note that supersedes).
- **Be conservative** — when unsure if it's stale, leave it.

## Anti-Patterns (Don't Do)

> [!failure] Bad compactor
> - Bulk archive based on date alone (some old notes are eternal).
> - Merge notes without leaving back-links.
> - Edit session logs to "fix" historical entries.
> - Delete tags without checking usage.

## Reference

- Philosophy: [[Context-Rot-Prevention]]
- Live dashboard: [[Vault-Dashboard]]
- Insight template: [[07_Insights/]] (see existing notes for shape)
- Concept source: [[LeafBox-02-Claude-Code-Updates#4]]
