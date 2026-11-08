---
name: spx-session-end
description: Close meaningful SPX work by recording a governed Project Memory V2 session log and running V2 store verification. Use when the user invokes `$spx-session-end`, asks for session-end, says done/finished/save this, or after code, docs, memory, or workflow changes.
---

# /session-end - Tool-Native Memory V2 Closeout

This workflow persists the current session into Project Memory V2 (`memory-v2/`) without hooks, shell memory scripts, or manual file writes.

## When To Run

- After a meaningful chunk of work: feature, bug fix, docs update, memory update, or workflow/config change.
- Before ending a session.
- When the user says "save this", "log this session", "done", "finished", or "ship it".

## MCP Steps

1. Gather concrete closeout details:
   - `topic` (string, **REQUIRED**): Brief clear summary of what this session accomplished.
   - `outcomes` (string[]): Concrete accomplishments and state changes.
   - `decisionsMade` (string[]): Architectural, design, or configuration choices made.
   - `filesTouched` (string[]): Relative or absolute paths of modified/created files.
   - `openFollowUps` (string[]): Any pending unclosed tasks or next steps.
   - `verification` (string): Exact command line outputs, test counts, or SSH checks verifying success.
   - `agent` (string): e.g. `"antigravity"` or `"codex"`.
   - `date` (string, `"YYYY-MM-DD"`): Current session date.

2. If durable lessons or decisions emerged during the session, record them first:
   - `memory_writeADR` for architecture decisions,
   - `memory_writeMistake` for reusable failure lessons,
   - `memory_writeInsight` for recurring patterns,
   - `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, or `memory_forgetEvidence` for governed lifecycle transitions.

3. Call `memory_sessionEnd` with `{ topic, outcomes, decisionsMade, filesTouched, openFollowUps, verification, verify: true }`.
   - If a completed session needs an addendum or cancellation, use `memory_amendSessionEnd` or `memory_cancelSessionEnd`.

4. Call `memory_verifyVault` (and optionally `memory_v2Status`) to confirm store integrity and projection health:
   - If specific governed records changed, call `memory_verifyNote` or `memory_verifySourceTruth`.
   - If duplicate or stale claims are in scope, call `memory_findDuplicates` or `memory_checkStaleness`.

## Output

Report:

```text
Session saved to Project Memory V2.
- Session ID: <sessionId>
- Store verification: pass/fail
- Follow-ups: <N>
```

## Rules

- Do not use removed npm memory scripts for closeout.
- Never write directly to the frozen V1 archive (`memory/`).
- Do not commit or push unless explicitly asked.
- Do not log secrets or `.env` values.
