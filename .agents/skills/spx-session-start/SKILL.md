---
name: spx-session-start
description: Load SPX Memory Vault startup context for Codex using project-memory MCP tools. Use when the user invokes `$spx-session-start`, asks for session-start, starts work in SPX, or wants the Codex equivalent of `/session-start`.
---

# /session-start - Tool-Native Memory Startup

This workflow primes Codex with persistent SPX project memory without hooks, shell memory scripts, or manual vault reads.

## When To Run

- At the start of every SPX work session.
- When switching back into SPX context.
- When the user says "session start", "load context", or invokes `$spx-session-start`.

## MCP Steps

1. Call `memory_sessionStart` as the **MANDATORY FIRST ACTION** before any other tool call (no arguments required: `{}`).
   - Confirm `vaultRoot` is `C:\Users\Server\Desktop\SPX\memory`. Stop and report if it is not.

2. Call `memory_contextPack` with `{ mode, taskArea }`:
   - Pick `mode`: `coding` (feature/refactor), `debugging` (bugs/errors), `deploy` (deploy/SSH/pipeline), `planning` (architecture), or `docs` (memory/vault).
   - Use a short `taskArea` (e.g. `deploy`, `poller`, `skills`, `database`).
   - Read `contextPack.selected[]`; call `memory_get` only for selected notes that need full body.

3. Call `memory_followUpRadar` with `{ taskArea }`:
   - Mention relevant open follow-ups to the user before editing code or taking risky actions.
   - Carry still-relevant follow-ups into `memory_sessionEnd.openFollowUps`.

4. Call `memory_lifecycleStatus` when resuming a long or interrupted thread.

5. If the user asks what to do next, call `memory_awaken` after startup context is loaded.

## Output

Summarize briefly in Thai when the user writes Thai:

```text
Memory loaded from SPX vault.
- Selected context: <N> notes
- Relevant follow-ups: <N>
- Lifecycle: sessionStart/contextPack/followUpRadar recorded
Ready to continue.
```

## Rules

- Do not use removed npm memory scripts for startup context.
- Do not manually read broad vault folders when MCP retrieval can select context.
- Keep the summary short; link to exact notes only when useful.
