---
description: Multi-angle self-dialogue — AI evaluates a proposal from Optimizer, Critic, and Devil's Advocate perspectives before committing.
---

# /multi-perspective — Three-Angle Review

When facing a decision with 2+ plausible options, run this workflow. The AI plays **three roles** and outputs all three views, then makes a final call.

## When To Run

- Choosing between technical options (lib A vs lib B).
- Writing an ADR.
- Designing a non-trivial feature.
- User explicitly asks: "consider alternatives".
- Decision feels too easy (often means we're missing something).

## The Three Personas

| Persona | Job | Voice |
|---|---|---|
| 🟢 **Optimizer** | Find the best path forward, given constraints. | "The cleanest approach is..." |
| 🔴 **Critic** | Find what's wrong, weak, or risky. | "What if we missed..." |
| 🟣 **Devil's Advocate** | Argue the opposite of the current proposal. | "We should do the opposite because..." |

## Steps

1. **Frame the proposal** — one paragraph stating the current plan / question.

2. **Optimizer pass** — write 3-5 bullets:
   - Best implementation approach
   - Aligns with which goals / ADRs
   - Expected outcomes
   - Estimated effort

3. **Critic pass** — write 3-5 bullets:
   - What assumptions might be wrong?
   - What could break / fail?
   - What user need might be unaddressed?
   - What technical debt does this create?

4. **Devil's Advocate pass** — write 3-5 bullets:
   - What's the argument for **not** doing this?
   - What's the strongest alternative?
   - Why might the user actually want the opposite?

5. **Synthesis** — final answer:
   - State the **chosen path** (could be the original, or a new hybrid).
   - List the **2-3 strongest points** from each persona that influenced the choice.
   - Note **deferred risks** — things the Critic raised that we're consciously accepting.

6. **Output format:**

   ```markdown
   ## 🎭 Multi-Perspective Review

   ### Proposal
   <one paragraph>

   ### 🟢 Optimizer
   - <bullet>
   - <bullet>

   ### 🔴 Critic
   - <bullet>
   - <bullet>

   ### 🟣 Devil's Advocate
   - <bullet>
   - <bullet>

   ### Synthesis (Final Call)
   **Decision:** <chosen path>
   **Why this won:** <one paragraph>
   **Accepted risks:** <bullets — what Critic flagged that we accept>
   **Confidence:** <high | medium | low>
   ```

## Rules

- **Each persona must offer non-trivial points.** "Looks fine" is not a Critic.
- **Devil's Advocate must steel-man.** Don't strawman the opposing view.
- **Synthesis must cite which persona influenced it** — proves all 3 were heard.
- **Confidence after synthesis ≥ confidence before** — if not, the review failed.

## When To Skip

- Trivial tasks (rename a variable, fix a typo).
- User explicitly says "just do it".
- Decision is already covered by an existing ADR.

## Example

```
## 🎭 Multi-Perspective Review

### Proposal
Move notify-rules from JSON to MySQL in dev too, not just prod.

### 🟢 Optimizer
- Single code path — easier to maintain
- Transactional safety in dev catches bugs earlier
- Dev DB schema matches prod

### 🔴 Critic
- Dev now requires MySQL setup → friction for new contributors
- Tests in CI need MySQL service
- Existing notify-rules.json files become legacy junk

### 🟣 Devil's Advocate
- Why not go SQLite for dev? Same single-code-path benefit, no server.
- Or: keep JSON forever in dev — the abstraction already exists.

### Synthesis (Final Call)
**Decision:** Keep current dual-storage (JSON in dev, MySQL in prod). Reject the proposal.
**Why this won:** Optimizer's "single path" is genuine but Critic's friction concern + Devil's "SQLite would solve it differently" reveal the proposal isn't the best framing. [[ADR-001-Dual-Storage-Notify-Rules]] already justified this.
**Accepted risks:** Dev/prod schema drift — mitigated by `ensureDashboardTables()` parity check.
**Confidence:** high — supported by existing ADR.
```

## Reference

- [[Self-check]] workflow — confidence + mistake-aware (lighter)
- [[Agent-Orchestration-Patterns#Pattern 3 — Multi-Agent Orchestration]] — true multi-agent (heavier)
- Inspired by: Edward de Bono's "Six Thinking Hats" (compressed to 3)
