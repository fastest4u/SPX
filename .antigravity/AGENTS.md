# Antigravity instructions for this workspace (Project Memory V2)

This is the project-local AGENTS file Antigravity reads on every turn in this workspace.
The workspace runs **Project Memory V2** (`C:\Users\Server\Desktop\Awakened-AI-System\dist\v2.js`) backed by the append-only SQLite event store and `C:\Users\Server\Desktop\SPX\memory-v2` vault (`projectId: 310f00ba-ff0f-47bc-9430-a3a838647462`, `releaseId: 5fae44bb-2cf3-4303-bb0c-4d6716e2c812`). The legacy `C:\Users\Server\Desktop\SPX\memory` directory is a frozen read-only V1 archive (`0o444`) and must never be modified.

## Memory V2 Protocol: Mandatory Every Turn

Use the `project-memory` MCP server (V2) as the durable memory source for this project:

1. **Status / Readiness Check (Optional)**: Call `memory_v2Status` to inspect the active V2 store (`mode: "active"`, `productionReady: true`, `projectId: "310f00ba-ff0f-47bc-9430-a3a838647462"`).
2. **Task Start (MANDATORY)**: Call `memory_sessionStart` before other work (`topic` / `taskArea`). Save the returned `sessionId`, `leaseId`, `leaseToken`, and `fencingToken` for governed session operations.
3. **Context Gathering**: Call `memory_contextPack` for the current task area, and read full governed notes with `memory_get` or search with `memory_search` / `memory_list` / `memory_recent` / `memory_followUpRadar`.
4. **Pre-Flight Check**: Call `memory_selfCheck` before risky work or multi-file edits.
5. **During Work**: Record decisions with `memory_writeADR`, insights with `memory_writeInsight`, mistakes with `memory_writeMistake`, checkpoints with `memory_checkpoint`, and evidence with `memory_recordEvidenceBatch`. Use `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, and `memory_forgetEvidence` for governed lifecycle transitions.
6. **Task End (MANDATORY)**: Call `memory_sessionEnd` with `topic`, `outcomes`, `decisionsMade`, `filesTouched`, `openFollowUps`, and a concrete `verification` summary, then verify with `memory_verifyVault` / `memory_v2Status`.
