---
title: Autonomous Self-Learning Pattern
type: insight
status: stable
created: 2026-05-14
updated: 2026-05-14
derived-from:
  - "[[Awakened-AI-System]]"
  - "[[Runbook-Multi-AI-Memory-Acceptance]]"
  - "[[AGENTS]]"
  - "[[2026-05-14-Autonomous-Self-Learning-Phase-1-2]]"
  - "[[2026-05-14-Codex-Auto-Hooks]]"
  - "[[2026-05-14-Codex-SPX-Skills]]"
confidence: medium
tags:
  - topic/agent-orchestration
  - topic/memory-vault
  - project/spx
---

# Autonomous Self-Learning Pattern

The SPX learning loop becomes more adaptive when it is split into explicit stages instead of one opaque agent pass:

1. Bootstrap context from vault rules and goals.
2. Select only the relevant source slice.
3. Execute the task.
4. Verify the result.
5. Log the outcome.
6. Promote repeated lessons into durable notes.
7. Compare recent logs to detect repeated claims, repeated failures, and repeated operational steps.
8. Feed those patterns back into runbooks, insight notes, or mistake notes.
9. Use evaluation runs to keep the loop honest.

This pattern reduces overconfidence and turns repeated experience into reusable project memory.

## Implementation Pattern

Recent SPX sessions show that autonomous learning works best as **guardrail-assisted human-reviewable automation**, not silent self-modification:

- Hooks and commands should inject context, remind the agent, or block obvious hazards.
- The agent still performs verification and session logging visibly.
- Repeated lessons should move from session logs into insights, runbooks, goals, or mistake notes.
- Draft helpers are safer than hard auto-writes because they reduce re-explanation without hiding changes from the user.
