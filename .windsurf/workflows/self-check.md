---
description: AI metacognition — evaluate confidence, mistake-awareness, and goal alignment before/during a task.
---

# /self-check — AI Self-Reflection

This workflow forces the AI to **think about its own thinking** before acting on a non-trivial task. It's the "awakened" layer of memory.

## When To Run

- **Before** starting an architectural change (size > 1 file).
- **Before** making a claim that will become a decision (ADR territory).
- **When** user asks "are you sure?".
- **When** you feel uncertain but were about to answer confidently anyway.

## Steps

1. **State the task in one sentence.**

2. **Confidence check** — answer honestly:

   ```
   Confidence: <high | medium | low | guess>
   Reasoning: <one sentence why>
   Evidence cited: [memory/<path>, ADR-NNN, src/<file>]
   ```

3. **Mistake check** — search `memory/08_Mistakes/`:
   - Any `area` matches this task?
   - Any `tags` overlap?
   - If yes → **read the matching mistake before continuing**.

4. **Identity check** — open `memory/AGENT-IDENTITY.md`:
   - Does the task align with my role?
   - Does it violate my limits (destructive cmds, secrets, prod schema)?
   - If yes → STOP and ask user.

5. **Goal alignment** — open `memory/00_Index/Goals.md`:
   - Which active goal (G-NNN) does this advance?
   - If none → flag to user: "This is off-roadmap. Continue?"

6. **Past-work check** — search `memory/05_Agent_Session_Logs/`:
   - Have I (or another agent) done this before?
   - If yes → read the relevant session log first.

7. **Output a self-report** in this format:

   ```
   ## 🪞 Self-Check

   **Task:** <one sentence>
   **Confidence:** <level> — <why>
   **Past mistakes to avoid:**
   - [[Mistake-NNN-...]] — <relevance>
   **Identity alignment:** ✅ / ⚠️ / ❌
   **Goal:** advances [[G-NNN]]
   **Prior work:** [[YYYY-MM-DD-session]] *(if any)*

   Proceeding unless you raise a concern.
   ```

8. **Then proceed** with the task — but with eyes open.

## Rules

- **Don't fake confidence.** Saying "guess" is honorable.
- **Don't skip mistake check.** That's the whole point.
- **Output is not optional.** Even if all checks pass, show the report.
- **One self-check per task**, not per turn — to avoid noise.

## Example Output

```
## 🪞 Self-Check

**Task:** Add `auto_accept_count` column to `auto_accept_history` table.
**Confidence:** medium — I know the schema pattern but haven't migrated this table before.
**Past mistakes to avoid:**
- [[Mistake-002-MySQL-5-7-UTC-Default]] — DDL default can't use UTC_TIMESTAMP() function call.
**Identity alignment:** ✅ within role (DB schema change)
**Goal:** advances [[G-002]] (production stability)
**Prior work:** [[2026-05-10-Add-Vehicle-Type-Column]] (similar pattern)

Proceeding unless you raise a concern.
```

## Reference

- [[AGENT-IDENTITY]] — who I am
- [[Goals]] — what I'm working toward
- `memory/08_Mistakes/` — what I've gotten wrong
- `memory/05_Agent_Session_Logs/` — what I've done
