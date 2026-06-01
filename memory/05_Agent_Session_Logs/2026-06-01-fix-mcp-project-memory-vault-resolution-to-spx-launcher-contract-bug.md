---
title: "2026-06-01 - Fix MCP project-memory vault resolution to SPX + launcher contract bug"
type: session-log
session-date: 2026-06-01
agent: cascade
duration-minutes: 40
outcomes:
  - "Confirmed MCP project-memory now resolves to the SPX vault: sessionStart vaultRoot=c:/Users/Server/Desktop/SPX/memory with 158 files (was previously resolving to the api gateway vault / ~/memory)."
  - "Root cause of wrong vault: global ~/.codeium/windsurf/mcp_config.json hardcoded MEMORY_PROJECT_ROOT to the 'api gateway' project; Windsurf does NOT honor the workspace .windsurf/mcp.json override (confirmed across two reloads)."
  - "Found and fixed a real bug in scripts/mcp-memory-launcher.mjs: it set MEMORY_PROJECT_ROOT to <project>/memory, but the server expects the PROJECT ROOT (it appends /memory itself). The double /memory made the launcher resolve an empty vault."
  - "Verified the durable solution: MEMORY_PROJECT_ROOT='dynamic' + autoApprove for all memory_* tools (user-edited global config) resolves per-workspace via vault markers and works after a clean reload."
  - "Cleaned up: removed temporary diagnostic-log scaffolding from the launcher, kept the contract fix + env-var fallback; node --check passes (exit 0)."
created: 2026-06-01
updated: 2026-06-01
tags:
  - session-log
  - project/general
---
# 2026-06-01 - Fix MCP project-memory vault resolution to SPX + launcher contract bug

## TL;DR
- Confirmed MCP project-memory now resolves to the SPX vault: sessionStart vaultRoot=c:/Users/Server/Desktop/SPX/memory with 158 files (was previously resolving to the api gateway vault / ~/memory).
- Root cause of wrong vault: global ~/.codeium/windsurf/mcp_config.json hardcoded MEMORY_PROJECT_ROOT to the 'api gateway' project; Windsurf does NOT honor the workspace .windsurf/mcp.json override (confirmed across two reloads).
- Found and fixed a real bug in scripts/mcp-memory-launcher.mjs: it set MEMORY_PROJECT_ROOT to <project>/memory, but the server expects the PROJECT ROOT (it appends /memory itself). The double /memory made the launcher resolve an empty vault.
- Verified the durable solution: MEMORY_PROJECT_ROOT='dynamic' + autoApprove for all memory_* tools (user-edited global config) resolves per-workspace via vault markers and works after a clean reload.
- Cleaned up: removed temporary diagnostic-log scaffolding from the launcher, kept the contract fix + env-var fallback; node --check passes (exit 0).

## Goal
Fix MCP project-memory vault resolution to SPX + launcher contract bug

## What Was Done
- Confirmed MCP project-memory now resolves to the SPX vault: sessionStart vaultRoot=c:/Users/Server/Desktop/SPX/memory with 158 files (was previously resolving to the api gateway vault / ~/memory).
- Root cause of wrong vault: global ~/.codeium/windsurf/mcp_config.json hardcoded MEMORY_PROJECT_ROOT to the 'api gateway' project; Windsurf does NOT honor the workspace .windsurf/mcp.json override (confirmed across two reloads).
- Found and fixed a real bug in scripts/mcp-memory-launcher.mjs: it set MEMORY_PROJECT_ROOT to <project>/memory, but the server expects the PROJECT ROOT (it appends /memory itself). The double /memory made the launcher resolve an empty vault.
- Verified the durable solution: MEMORY_PROJECT_ROOT='dynamic' + autoApprove for all memory_* tools (user-edited global config) resolves per-workspace via vault markers and works after a clean reload.
- Cleaned up: removed temporary diagnostic-log scaffolding from the launcher, kept the contract fix + env-var fallback; node --check passes (exit 0).

## Files Touched
- scripts/mcp-memory-launcher.mjs
- C:/Users/Server/.codeium/windsurf/mcp_config.json (global, outside repo)

## Decisions Made
- Use MEMORY_PROJECT_ROOT='dynamic' (server workspace-marker auto-discovery) as the primary mechanism instead of a hardcoded path or the launcher wrapper, because dynamic resolves correctly on this Windsurf install.
- Keep scripts/mcp-memory-launcher.mjs as a corrected fallback (project-root contract fixed + env-var WORKSPACE_ROOT/PWD detection) per the existing open follow-up that wanted it retained.

## Open Follow-ups
- [ ] Optionally remove any stray SPX session log accidentally written into the api gateway / ~/memory vault during the earlier misconfiguration.
- [ ] When opening laravel/ or api gateway/, confirm dynamic resolution points to each project's own memory vault (expected via vault markers).
- [ ] Close the now-satisfied verification checkboxes in 2026-05-23-Memory-Vault-Cleanup-Phase-1-4.md (vaultRoot=SPX confirmed).

## References
- 05_Agent_Session_Logs/2026-05-23-Memory-Vault-Cleanup-Phase-1-4.md

## Verification
sessionStart vaultRoot=SPX/memory (158 files); memory_recent returns SPX session logs; node --check scripts/mcp-memory-launcher.mjs exit 0

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| The empty vault after switching the global config to the launcher meant Windsurf was launching the MCP server with cwd != workspace. | medium | The empty result was (at least also) caused by the launcher setting MEMORY_PROJECT_ROOT to the memory/ subfolder instead of the project root, producing a double /memory path. Dynamic resolution actually works on this install. | Verify the exact env-var contract a tool expects (here: project root vs memory folder) before blaming the host environment. The known-working hardcoded value was the ground-truth contract. |
