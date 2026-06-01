---
title: 2026-06-01 - Disable Codex Hooks And Use Project Memory Directly
aliases:
  - 2026-06-01-disable-codex-hooks-and-use-project-memory-directly
  - 2026-06-01-disable-codex-hooks-and-use-project-memory-directly-2
  - 2026-06-01-disable-codex-hooks-and-use-project-memory-directly-3
  - 2026-06-01-disable-codex-hooks-for-project-memory-auto-lifecycle
  - 2026-06-01-disable-codex-hooks-for-project-memory-auto-lifecycle-2
type: session-log
session-date: 2026-06-01
agent: Codex
duration-minutes: 35
outcomes:
  - Disabled Codex hook execution by emptying .codex/hooks.json.
  - Turned off codex_hooks and hooks feature flags in .codex/config.toml while keeping project-memory MCP enabled.
  - "Updated AGENTS.md Auto Memory Management instructions from legacy mcp5_* names to current memory_* MCP tool names."
  - Documented no-hook Codex mode so agents call project-memory MCP directly through AGENTS.md and SPX skills.
  - Identified that failed closeout attempts came from stale in-memory MCP index during auto-compact after earlier memory filename renames.
created: 2026-06-01
updated: 2026-06-01
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/tooling
---
# 2026-06-01 - Disable Codex Hooks And Use Project Memory Directly

## TL;DR
- Disabled Codex hook execution by emptying .codex/hooks.json.
- Turned off codex_hooks and hooks feature flags in .codex/config.toml while keeping project-memory MCP enabled.
- Updated AGENTS.md Auto Memory Management instructions from legacy mcp5_* names to current memory_* MCP tool names.
- Documented no-hook Codex mode so agents call project-memory MCP directly through AGENTS.md and SPX skills.
- Identified that failed closeout attempts came from stale in-memory MCP index during auto-compact after earlier memory filename renames.

## Goal
Disable Codex Hooks And Use Project Memory Directly

## What Was Done
- Disabled Codex hook execution by emptying .codex/hooks.json.
- Turned off codex_hooks and hooks feature flags in .codex/config.toml while keeping project-memory MCP enabled.
- Updated AGENTS.md Auto Memory Management instructions from legacy mcp5_* names to current memory_* MCP tool names.
- Documented no-hook Codex mode so agents call project-memory MCP directly through AGENTS.md and SPX skills.
- Identified that failed closeout attempts came from stale in-memory MCP index during auto-compact after earlier memory filename renames.

## Files Touched
- .codex/hooks.json
- .codex/config.toml
- AGENTS.md
- memory/.memory-mcp/lifecycle.json
- memory/.memory-mcp/usage.json

## Decisions Made
- Use direct project-memory MCP tool calls as the source of truth for Codex memory lifecycle instead of Codex hooks.
- Keep .codex/hooks/spx-hook.mjs in the repo for reference, but make .codex/hooks.json contain no active hooks.

## Open Follow-ups
- [ ] Restart or reload Codex Desktop if the current running session still has hook or project-memory in-memory index settings cached.
- [ ] Existing unrelated dirty worktree changes remain unstaged and untouched.
- [ ] Memory score remains 80/100 because existing open mistakes and unchecked follow-ups remain; this task only removed hook dependence.

## References
- None

## Verification
node parsed .codex/hooks.json successfully; .codex/config.toml shows codex_hooks=false and hooks=false; git diff --check exited 0 with Windows LF/CRLF warnings only. Final npm run memory:verify passed after duplicate generated logs were cleaned up: memory:check healthy/no issues, files scanned 187; memory:eval 100% (8/8); memory:score 80/100 (C).

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
