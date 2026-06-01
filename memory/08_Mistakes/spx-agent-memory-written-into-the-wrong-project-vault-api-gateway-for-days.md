---
title: "SPX agent memory written into the wrong project vault (api gateway) for days"
type: mistake
severity: medium
status: open
occurred-date: 2026-06-01
agent: cascade
area: memory / MCP project-memory configuration
confidence: high
created: 2026-06-01
updated: 2026-06-01
tags:
  - area/memory / MCP project-memory configuration
  - topic/memory-vault
---
## Problem
~17 SPX notes (16 session logs dated 2026-05-30 to 2026-06-01 plus 1 mistake note) were written into the 'api gateway' project's memory vault instead of the SPX vault. SPX project memory was silently fragmented across two vaults, so memory_recent/contextPack on SPX were missing days of real SPX feature/review/deploy work.

## Root Cause
The global Windsurf/Codex MCP config (~/.codeium/windsurf/mcp_config.json) hardcoded MEMORY_PROJECT_ROOT to a fixed project ('api gateway'), and Windsurf does not honor the per-workspace .windsurf/mcp.json override. So any agent doing SPX work through that host wrote its session logs to the fixed 'api gateway' vault regardless of the actual workspace.

## Avoidance
Set MEMORY_PROJECT_ROOT='dynamic' so the server resolves the active workspace via vault markers (memory/AGENTS.md). Always confirm vaultRoot from memory_sessionStart before trusting writes. Periodically scan other project vaults for misfiled notes (e.g. grep filenames for other project names like 'spx'/'bidding') and migrate them back with copy -> verify-on-disk -> reindex -> guarded delete.

## References
- 05_Agent_Session_Logs/2026-06-01-fix-mcp-project-memory-vault-resolution-to-spx-launcher-contract-bug.md
