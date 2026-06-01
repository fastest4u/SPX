---
title: Runbook - Autonomous Self-Learning
type: runbook
status: active
last-verified: 2026-05-14
verified-by: opencode
source: memory/00_Index/Awakened-AI-System.md + memory/AGENTS.md + project-memory MCP + .cursor/hooks.json
confidence: medium
created: 2026-05-14
updated: 2026-05-14
severity-when-applies: medium
tags:
  - runbook
  - topic/agent-orchestration
  - topic/memory-vault
  - project/spx
---

# Runbook - Autonomous Self-Learning

## Purpose
Keep the SPX learning loop explicit, persistent, and progressively more autonomous without losing verification discipline.

## Phase 1 — Make learning explicit
- Load startup context on session start.
- Run self-check for risky prompts and tasks.
- Close sessions with summary and log reminders.
- Keep memory health checks visible.

## Phase 2 — Make learning persistent
- Write session logs for meaningful work.
- Tag outcomes and follow-ups clearly.
- Capture repeated lessons as candidates for insight or mistake notes.
- Link related sessions and notes so retrieval improves.
- Use a session-log draft helper to preserve TL;DR, Goal, What Was Done, Files Touched, Decisions Made, Insights, and Open Issues.
- Surface repeated patterns from recent logs so they can be promoted instead of rediscovered.
- Promote recurring follow-ups into Goals or Open-Followups maintenance instead of leaving them buried in one session log.

## Phase 3 — Make learning adaptive
- Compare the last few session logs to identify repeated claims, repeated failures, and repeated operational steps.
- Promote recurring operational steps into reusable runbooks.
- Promote repeated lessons into insight notes when they are stable and source-grounded.
- Promote repeated mistakes into mistake notes when the failure pattern is worth preventing.
- Detect docs drift by comparing memory claims against the latest source files and verified notes.
- Revisit open follow-ups regularly and move long-lived items into Goals when they become durable work.
- Feed session-log summaries into the compactor workflow so the next session starts with a shorter, better signal.

## Phase 4 — Make learning autonomous
- Use workflow triggers to choose next actions.
- Rank tasks by goal debt, blockers, and impact.
- Surface hidden risks before work starts.
- Reduce manual re-explanation with better retrieval.
- Add a phase-4 hook helper that reads the latest Goals, Open-Followups, and session-log follow-ups to propose the next action.
- Prefer the highest-impact next step rather than the most recent open task.
- Make the next-step proposal explicit when the session ends so the user can continue without re-orienting.

## Phase 5 — Add multi-agent learning
- Let separate agents plan, execute, critique, and archive.
- Compare outputs across agents before promotion.
- Record which agent validated which claim.
- Use role-based summaries to decide whether a claim is ready for the memory vault.
- Treat disagreements between agents as a signal to keep the item as draft until verified.
- Prefer explicit planner / executor / critic / archivist roles over a single opaque agent pass.

## Phase 6 — Add background evaluation
- Run memory health checks regularly.
- Re-score memory quality after major changes.
- Detect stale claims, repeated mistakes, and missing promotions.
- Feed evaluation results back into goals and follow-ups.
- Pair `memory_verifyVault` with targeted project-memory MCP validators after major memory or workflow changes.
- Review `Vault-Dashboard` and the recent session logs for stale truth, unresolved mistakes, or unpromoted recurring work.
- Keep the re-verification cadence visible so background evaluation does not silently rot.

## Validation
- `memory_verifyVault`
- `memory_verifyNote` / `memory_verifySourceTruth` when specific notes or claims changed
- `memory_lifecycleStatus`
- `npm run verify` for application build changes

## Related
- [[Awakened-AI-System]]
- [[Multi-AI-Acceptance-Results]]
- [[Goals]]
- [[MOC-Home]]
