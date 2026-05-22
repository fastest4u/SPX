---
description: Save Memory Vault state at session end — call mcp5_memory_sessionEnd automatically after meaningful work completes.
---

# /session-end — Save Session to Memory Vault

This workflow persists the current session into long-term memory so the next session can resume seamlessly.

> **Auto-trigger:** Call this automatically after ANY meaningful work completes — do NOT wait for the user to ask.

## When To Run (auto-triggers)

- Completed a feature, bug fix, or refactor
- Made an architectural decision (also call `mcp5_memory_writeADR`)
- Resolved a debugging session
- User says "done", "เสร็จแล้ว", "save this", "ship it"
- Approaching context limit

## Steps

1. **Call `mcp5_memory_sessionEnd`**
   ```
   mcp5_memory_sessionEnd({
     topic: "<short kebab-case topic>",
     agent: "cascade",
     outcomes: ["<concrete outcome 1>", "<concrete outcome 2>"],
     filesTouched: ["src/path/to/file.ts"],
     decisionsMade: ["<decision>"],
     openFollowUps: ["<follow-up>"],
     durationMinutes: <estimate>
   })
   ```

2. **If an architectural decision was made**, also call `mcp5_memory_writeADR` with the decision details.

3. **If a mistake pattern was identified**, also call `mcp5_memory_writeMistake`.

4. **Report to user**
   ```
   ✅ Session saved → <path> · outcomes: <count>
   ```

## Rules

- Use ONLY `mcp5_*` tools — do NOT write files manually or use obsidian MCP.
- Be concrete in outcomes — "Fixed partial-accept bug in acceptAutoAcceptMatch" not "fixed bug".
- Do NOT auto-commit or auto-deploy after saving — the user decides when to commit.

## Reference

- `AGENTS.md` → Auto Memory Management section
- project-memory MCP: `mcp5_memory_sessionEnd`, `mcp5_memory_writeADR`, `mcp5_memory_writeMistake`
