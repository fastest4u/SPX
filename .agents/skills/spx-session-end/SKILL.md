---
name: spx-session-end
description: Close meaningful SPX work by writing a Memory Vault session log and running project-memory MCP verification. Use when the user invokes `$spx-session-end`, asks for session-end, says done/finished/save this, or after code, docs, memory, or workflow changes.
---

# /session-end - Tool-Native Memory Closeout

This workflow persists the current session into long-term memory without hooks, shell memory scripts, or manual vault writes.

## When To Run

- After a meaningful chunk of work: feature, bug fix, docs update, memory update, or workflow/config change.
- Before ending a session.
- When the user says "save this", "log this session", "done", "finished", or "ship it".

## MCP Steps

1. Gather concrete closeout details:
   - `outcomes[]`
   - `decisionsMade[]`
   - `filesTouched[]`
   - `openFollowUps[]`
   - precise `verification`

2. Call `memory_sessionEnd` with `verify: true`.
   - Use `autoCompact: true` by default.
   - If the MCP process has a stale in-memory index and closeout fails during auto-compact, call `memory_reindex`, retry with `autoCompact: false`, then run `memory_verifyVault`.

3. Inspect the returned `qualityGate`.
   - If it says verification was skipped or missing, call `memory_verifyVault`.
   - If specific notes changed, call `memory_verifyNote`.
   - If source-backed claims changed, call `memory_verifySourceTruth`.
   - If links or stale claims are in scope, call `memory_findBrokenLinks` or `memory_checkStaleness`.

4. If a durable lesson emerged:
   - use `memory_writeADR` for architecture decisions,
   - use `memory_writeMistake` for reusable failure lessons,
   - use `memory_writeInsight` for recurring patterns.

## Output

Report:

```text
Session saved.
- Log: <path from memory_sessionEnd>
- Quality gate: pass/fail, score/grade if returned
- Vault verification: pass/fail, score/grade if run
- Follow-ups: <N>
```

## Rules

- Do not use removed npm memory scripts for normal Codex closeout.
- Do not manually create or edit session log files; use `memory_sessionEnd` or `memory_writeSessionLog`.
- Do not commit or push unless explicitly asked.
- Do not log secrets or `.env` values.
