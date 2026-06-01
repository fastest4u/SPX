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

1. Call `memory_sessionStart`.
   - Use a short `taskArea`.
   - Pick `mode` from the task: `coding`, `debugging`, `deploy`, `planning`, or `docs`.
   - Confirm `vaultRoot` is `C:\Users\Server\Desktop\SPX\memory`. Stop and report if it is not.

2. Call `memory_contextPack`.
   - Use the same `taskArea` and mode.
   - Include ADRs, runbooks, mistakes, and recent sessions when useful.
   - Read `contextPack.selected[]`; call `memory_get` only for selected notes that need full body.

3. Call `memory_followUpRadar`.
   - Mention relevant open follow-ups before editing.
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
