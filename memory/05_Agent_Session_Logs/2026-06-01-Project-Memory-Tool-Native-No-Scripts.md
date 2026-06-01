---
title: 2026-06-01 - Project Memory Tool Native Auto Without Scripts
aliases:
  - 2026-06-01-project-memory-tool-native-auto-without-scripts
type: session-log
session-date: 2026-06-01
agent: Codex
duration-minutes: 35
outcomes:
  - Updated root AGENTS.md so Codex treats project-memory MCP tools as the default memory interface without hooks or npm memory scripts.
  - "Added an authoritative project-memory tool map covering startup/context, read/search, risk/verification, maintenance, structured writing, and vault transfer/bootstrap tools."
  - Rewrote SPX Codex memory skills to call project-memory MCP tools directly instead of manually reading broad vault folders or running npm memory scripts.
  - Created a durable insight note for the Codex project-memory tool-native auto protocol using memory_writeInsight.
created: 2026-06-01
updated: 2026-06-01
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
  - topic/tooling
---
# 2026-06-01 - Project Memory Tool Native Auto Without Scripts

## TL;DR
- Updated root AGENTS.md so Codex treats project-memory MCP tools as the default memory interface without hooks or npm memory scripts.
- Added an authoritative project-memory tool map covering startup/context, read/search, risk/verification, maintenance, structured writing, and vault transfer/bootstrap tools.
- Rewrote SPX Codex memory skills to call project-memory MCP tools directly instead of manually reading broad vault folders or running npm memory scripts.
- Created a durable insight note for the Codex project-memory tool-native auto protocol using memory_writeInsight.

## Goal
Project Memory Tool Native Auto Without Scripts

## What Was Done
- Updated root AGENTS.md so Codex treats project-memory MCP tools as the default memory interface without hooks or npm memory scripts.
- Added an authoritative project-memory tool map covering startup/context, read/search, risk/verification, maintenance, structured writing, and vault transfer/bootstrap tools.
- Rewrote SPX Codex memory skills to call project-memory MCP tools directly instead of manually reading broad vault folders or running npm memory scripts.
- Created a durable insight note for the Codex project-memory tool-native auto protocol using memory_writeInsight.

## Files Touched
- AGENTS.md
- .agents/skills/spx-session-start/SKILL.md
- .agents/skills/spx-session-end/SKILL.md
- .agents/skills/spx-memory-verify/SKILL.md
- .agents/skills/spx-self-check/SKILL.md
- .agents/skills/spx-dream/SKILL.md
- .agents/skills/spx-awaken/SKILL.md
- memory/07_Insights/codex-project-memory-tool-native-auto-protocol.md

## Decisions Made
- Codex should auto-select project-memory tools by task intent rather than calling every tool on every turn.
- For normal memory lifecycle and verification, Codex should use MCP tools such as memory_verifyVault and targeted validators; npm memory scripts are reserved for explicit script/CI parity requests.

## Open Follow-ups
- [ ] Existing MCP memory_verifyVault warning count remains 5 for template files under memory/99_Templates missing frontmatter.
- [ ] Existing unrelated dirty worktree changes remain unstaged and untouched.
- [ ] Consider updating legacy Memory Vault docs that still describe historical hook/script workflows if the user wants all old prose fully refreshed.

## References
- None

## Verification
Used project-memory MCP only for memory verification: memory_indexNote indexed the new insight; memory_verifyNote passed for 07_Insights/codex-project-memory-tool-native-auto-protocol.md and this session log; memory_reindex indexed 189 notes; memory_verifyVault returned ok=true with 189 files scanned, 0 errors, 5 warnings, score 72, grade D. git diff --check passed for AGENTS.md and the edited SPX skill files with Windows LF/CRLF warnings only. rg confirmed the edited SPX skills now route memory verification/lifecycle through memory_* tools and mention npm memory scripts only as explicit-request exceptions.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
