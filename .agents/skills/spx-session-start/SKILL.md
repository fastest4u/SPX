---
name: spx-session-start
description: Load SPX Memory V2 startup context using project-memory MCP tools. Use when the user invokes `$spx-session-start`, asks for session-start, starts work in SPX, or wants the Codex equivalent of `/session-start`.
---

# /session-start - Tool-Native Memory V2 Startup

This workflow primes the agent with persistent SPX Project Memory V2 (`memory-v2/`, `projectId: 310f00ba-ff0f-47bc-9430-a3a838647462`, `releaseId: 5fae44bb-2cf3-4303-bb0c-4d6716e2c812`) without hooks, shell memory scripts, or manual V1 archive reads.

## When To Run

- At the start of every SPX work session.
- When switching back into SPX context.
- When the user says "session start", "load context", or invokes `$spx-session-start`.

## MCP Steps

1. Call `memory_sessionStart` as the **MANDATORY FIRST ACTION** before any other tool call (no arguments required: `{}`).
   - Optionally call `memory_v2Status` (`{}`) to confirm `projectId` is `310f00ba-ff0f-47bc-9430-a3a838647462`, `mode` is `"active"`, and `productionReady` is `true`.

2. Call `memory_contextPack` with `{ mode, taskArea }`:
   - Pick `mode`: `coding` (feature/refactor), `debugging` (bugs/errors), `deploy` (deploy/SSH/pipeline), `planning` (architecture), or `docs` (memory/vault).
   - Use a short `taskArea` (e.g. `deploy`, `poller`, `skills`, `database`, `memory-v2`).
   - Inspect `items[]`; call `memory_get` only for selected governed notes/records that need full body.

3. Call `memory_followUpRadar` with `{ taskArea }`:
   - Mention relevant open follow-ups to the user before editing code or taking risky actions.
   - Carry still-relevant follow-ups into `memory_sessionEnd.openFollowUps`.

4. Call `memory_lifecycleStatus` when resuming a long or interrupted thread, or `memory_recoverSession` if recovering a prior session lease.

5. If the user asks what to do next, call `memory_awaken` after startup context is loaded.

## Output

Summarize briefly in Thai when the user writes Thai:

```text
Memory V2 loaded from SPX store.
- Selected context: <N> items
- Relevant follow-ups: <N>
- Lifecycle: sessionStart/contextPack/followUpRadar recorded
Ready to continue.
```

## Rules

- Do not use removed npm memory scripts for startup context.
- Do not write to or manually scan the frozen V1 archive (`memory/`).
- Keep the summary short; cite governed V2 `recordId`s only when useful.
