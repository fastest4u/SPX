---
name: spx-awaken
description: Assess current SPX project state and recommend next actions from Project Memory V2 evidence using project-memory MCP tools. Use when the user invokes `$spx-awaken`, asks to awaken, asks what to do next, or wants the Codex equivalent of `/awaken`.
---

# /awaken - MCP Memory V2 Next-Step Introspection

Use Project Memory V2 MCP retrieval to assess state and recommend next actions.

## When To Run

- At the start of a work session when the next task is unclear.
- After completing a feature and asking what comes next.
- When stuck.
- During weekly planning.

## MCP Steps

1. Call `memory_v2Status` (`{}`) and `memory_awaken` with a focused prompt.
2. Call `memory_contextPack` in `planning` or `docs` mode for the relevant area.
3. Call `memory_followUpRadar` to rank open follow-ups.
4. Call `memory_lifecycleStatus` to inspect active session state.
5. Use `memory_search`, `memory_recent`, `memory_list`, or `memory_get` only for targeted governed records.
6. Before stating store health, call `memory_verifyVault`.

## Output

Use Thai when the user writes Thai:

```text
Current SPX state (Memory V2):
- Active direction: <summary>
- Relevant follow-ups: <N>
- Store health: pass/fail

Top next actions:
1. <action> - <why> - <evidence>
2. <action> - <why> - <evidence>
3. <action> - <why> - <evidence>
```

## Rules

- Do not use removed npm memory scripts for awaken reports.
- Do not recommend completed work; check follow-up and governed record evidence first.
- Every recommendation should cite memory evidence.
