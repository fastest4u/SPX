---
name: spx-memory-verify
description: Run and summarize the SPX Memory Vault health gate. Use when the user invokes `$spx-memory-verify`, asks for memory verify, asks whether memory is healthy, or after memory/vault edits.
---

# /memory-verify — Memory Vault Health Gate

Run the automated Memory Vault verification suite and report results.

## When To Run

- After creating or editing memory notes.
- After a compactor (`$spx-dream`) pass.
- When asked "is memory healthy?"
- Before claiming vault health status in an awaken report.

## Steps

1. **Run the primary gate:**
   ```bash
   npm run memory:verify
   ```

2. **Summarize results:**
   - `memory:check` — file count and structural issue status.
   - `memory:eval` — deterministic retrieval coverage score (target: 100%).
   - `memory:score` — quality grade (A/B/C/D), broken wikilinks, stale `last-verified` dates, open mistakes, unchecked follow-ups, and multi-AI acceptance count.

3. **If verification fails:**
   - Inspect the reported files.
   - Fix memory issues (missing frontmatter, broken links, stale dates).
   - Re-run `npm run memory:verify` to confirm the fix.

4. **If memory AND code both changed:**
   - Run `npm run verify` (full gate: memory + build) instead of just `memory:verify`.

5. **Report to user:**

   ```
   ## 🏥 Memory Vault Health

   **Gate:** pass / fail
   **Files checked:** <N>
   **Eval score:** <N>% (<N>/<N> tests)
   **Quality score:** <N>/100 (<grade>)
   **Broken links:** <N>
   **Stale dates:** <N>
   **Open mistakes:** <N>
   **Multi-AI acceptance:** <N>/6 pass

   <If failed: list specific issues and fixes applied>
   ```

## Rules

- Report pass/fail **first**, then metrics.
- Do not claim "memory is healthy" without running the command.
- If the command cannot run (sandbox restriction), state that clearly and report the last known score from session logs.

## Reference

- [[Memory-Quality-Score]] — scoring methodology
- [[Memory-Evaluation-Test]] — eval test details
- [[Vault-Dashboard]] — live health board
