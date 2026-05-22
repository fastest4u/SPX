---
description: Load Memory Vault context at session start — call mcp5_memory_sessionStart to load vault context, recent sessions, and open follow-ups automatically.
---

# /session-start — Load Memory Vault

This workflow primes the AI with persistent project memory before any work begins.

> **Auto-trigger:** Call this automatically on the first substantive user request in every new chat — no user prompt needed.

## Steps

1. **Call `mcp5_memory_sessionStart`**
   ```
   mcp5_memory_sessionStart({ mode: "auto", taskArea: "<inferred from first message>" })
   ```
   This single call loads vault context, recent sessions, open follow-ups, and active ADRs.

2. **Summarize to the user**
   - Report the last session topic + date
   - List any open follow-ups from previous sessions
   - State what you're ready to help with

3. **Do NOT start coding yet** — wait for the user's actual request.

## Rules

- Skip if the user explicitly says "skip context" or "fresh start".
- Use ONLY `mcp5_*` tools (project-memory MCP) — do NOT read vault files manually or use obsidian MCP.
- Keep the summary concise — reference paths, don't dump content.

## Reference

- `AGENTS.md` → Auto Memory Management section
- project-memory MCP: `mcp5_memory_sessionStart`
