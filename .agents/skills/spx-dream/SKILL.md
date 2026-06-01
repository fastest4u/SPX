---
name: spx-dream
description: Compact SPX Memory Vault by promoting recurring session lessons into insights, runbooks, goals, or mistake notes using project-memory MCP tools. Use when the user invokes `$spx-dream`, asks for dream/compactor, monthly memory cleanup, or when session logs exceed roughly 30 files.
---

# /dream - MCP Memory Compactor

Use project-memory MCP maintenance tools to tidy long-running memory without shell memory scripts.

## When To Run

- Monthly or after many sessions.
- When session logs exceed roughly 30 files.
- When agents cite conflicting memory.
- When the user asks for a memory audit or compaction.

## MCP Steps

1. Call `memory_lifecycleStatus`.
2. Call `memory_contextPack` in `docs` mode for memory-vault maintenance.
3. Call `memory_compactVault`.
   - Use dry run first for broad compaction.
   - Use real write only when the promoted digest/notes are useful.
4. Call maintenance checks as needed:
   - `memory_findDuplicates`
   - `memory_findBrokenLinks`
   - `memory_checkStaleness`
   - `memory_verifySourceTruth`
5. Promote durable lessons with:
   - `memory_writeInsight`
   - `memory_writeMistake`
   - `memory_writeADR`
   - `memory_createFromTemplate`
6. Call `memory_verifyVault`.
7. Close with `memory_sessionEnd`.

## Rules

- Never delete historical memory; archive or supersede when the tool supports it.
- Do not use removed npm memory scripts for compaction verification.
- Preserve source links and confidence levels.
