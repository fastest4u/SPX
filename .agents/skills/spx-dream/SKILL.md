---
name: spx-dream
description: Compact SPX Memory Vault by promoting recurring session lessons into insights, runbooks, goals, or mistake notes. Use when the user invokes `$spx-dream`, asks for dream/compactor, monthly memory cleanup, or when session logs exceed roughly 30 files.
---

# /dream — Memory Compactor

When agents work for long periods, memory gets messy. This workflow tidies it up.

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
   - If no → **create a new insight note** with proper frontmatter (`type: insight`, `confidence:`, `derived-from:`).
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

7. **Refresh MOC-Home if topology changed.**

8. **Update Goals:** Mark completed goals → move to "Recently Completed". Surface blocked goals.

9. **Run verification:** `npm run memory:verify`

10. **Write a compactor session log** documenting insights promoted, notes archived, duplicates merged, and MOC changes.

11. **Report to user:**

    ```
    ## 🌙 Compactor complete

    **Insights promoted:** <N>
    **Notes archived:** <N>
    **Duplicates merged:** <N>
    **ADR chains fixed:** <N>
    **MOC refreshed:** yes/no
    **Open follow-ups:** <N>
    ```

## Rules

- **Never delete** — only archive or supersede. History is data.
- **Cite sources** when promoting insights — link to ≥ 2 session logs.
- **Preserve append-only invariant** — don't edit old session logs.
- **Be conservative** — when unsure if it's stale, leave it.

## Anti-Patterns

- ❌ Bulk archive based on date alone (some old notes are eternal).
- ❌ Merge notes without leaving back-links.
- ❌ Edit session logs to "fix" historical entries.
- ❌ Delete tags without checking usage.

## Reference

- Philosophy: [[Context-Rot-Prevention]]
- Live dashboard: [[Vault-Dashboard]]
- Insight template: [[07_Insights/]] (see existing notes for shape)
