---
title: 2026-05-21 - Setup Auto project-memory MCP Session Management
type: session-log
session-date: 2026-05-21
agent: cascade
duration-minutes: 10
outcomes:
  - "Updated AGENTS.md with auto session-start/end rules using mcp5_* tools"
  - Updated session-start.md workflow to use mcp5_memory_sessionStart
  - Updated session-end.md workflow to use mcp5_memory_sessionEnd with auto-trigger rules
  - Added no-auto-commit/deploy policy to AGENTS.md
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Setup Auto project-memory MCP Session Management

## TL;DR
- Updated AGENTS.md with auto session-start/end rules using mcp5_* tools
- Updated session-start.md workflow to use mcp5_memory_sessionStart
- Updated session-end.md workflow to use mcp5_memory_sessionEnd with auto-trigger rules
- Added no-auto-commit/deploy policy to AGENTS.md

## Goal
Setup Auto project-memory MCP Session Management

## What Was Done
- Updated AGENTS.md with auto session-start/end rules using mcp5_* tools
- Updated session-start.md workflow to use mcp5_memory_sessionStart
- Updated session-end.md workflow to use mcp5_memory_sessionEnd with auto-trigger rules
- Added no-auto-commit/deploy policy to AGENTS.md

## Files Touched
- AGENTS.md
- .windsurf/workflows/session-start.md
- .windsurf/workflows/session-end.md

## Decisions Made
- Use mcp5_* (project-memory MCP) exclusively for all memory operations — no obsidian MCP or manual file writes
- Auto-call mcp5_memory_sessionStart at start of every chat session
- Auto-call mcp5_memory_sessionEnd after any meaningful work, without waiting for user to ask
- Never auto-commit or auto-deploy — user controls when to push to production

## Open Follow-ups
- [ ] User to commit AGENTS.md + workflow changes when ready

## References
- None

## Verification
Not recorded

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
