---
title: 2026-06-01 - Remove Memory Scripts And Use MCP Tools
aliases:
  - 2026-06-01-remove-memory-scripts-and-use-mcp-tools
type: session-log
session-date: 2026-06-01
agent: Codex
duration-minutes: 45
outcomes:
  - "Removed runnable npm Memory Vault scripts from package.json: memory:check, memory:eval, memory:score, and memory:verify."
  - Changed npm run verify to run the application build gate only.
  - "Deleted scripts/memory-check.mjs, scripts/memory-eval.mjs, and scripts/memory-score.mjs."
  - "Updated active AGENTS, SPX skills, Memory Vault index/rules/runbooks, and related notes so normal memory lifecycle and verification use project-memory MCP tools instead of removed scripts."
created: 2026-06-01
updated: 2026-06-01
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/tooling
---
# 2026-06-01 - Remove Memory Scripts And Use MCP Tools

## TL;DR
- Removed runnable npm Memory Vault scripts from package.json: memory:check, memory:eval, memory:score, and memory:verify.
- Changed npm run verify to run the application build gate only.
- Deleted scripts/memory-check.mjs, scripts/memory-eval.mjs, and scripts/memory-score.mjs.
- Updated active AGENTS, SPX skills, Memory Vault index/rules/runbooks, and related notes so normal memory lifecycle and verification use project-memory MCP tools instead of removed scripts.

## Goal
Remove Memory Scripts And Use MCP Tools

## What Was Done
- Removed runnable npm Memory Vault scripts from package.json: memory:check, memory:eval, memory:score, and memory:verify.
- Changed npm run verify to run the application build gate only.
- Deleted scripts/memory-check.mjs, scripts/memory-eval.mjs, and scripts/memory-score.mjs.
- Updated active AGENTS, SPX skills, Memory Vault index/rules/runbooks, and related notes so normal memory lifecycle and verification use project-memory MCP tools instead of removed scripts.

## Files Touched
- package.json
- scripts/memory-check.mjs
- scripts/memory-eval.mjs
- scripts/memory-score.mjs
- AGENTS.md
- .agents/skills/spx-session-start/SKILL.md
- .agents/skills/spx-session-end/SKILL.md
- .agents/skills/spx-memory-verify/SKILL.md
- .agents/skills/spx-self-check/SKILL.md
- .agents/skills/spx-dream/SKILL.md
- .agents/skills/spx-awaken/SKILL.md
- memory/README.md
- memory/AGENTS.md
- memory/00_Index/Awakened-AI-System.md
- memory/00_Index/Goals.md
- memory/00_Index/Memory-Evaluation-Test.md
- memory/00_Index/Memory-Quality-Score.md
- memory/00_Index/Multi-AI-Acceptance-Results.md
- memory/00_Index/Session-Threads.md
- memory/00_Index/Vault-Dashboard.md
- memory/01_Project_Rules/SPX-Project-Rules.md
- memory/01_Project_Rules/SPX-System-Map.md
- memory/04_Architecture_Decisions/ADR-002-DB-Backed-Live-Settings.md
- memory/07_Insights/Auto-Memory-Digest.md
- memory/07_Insights/Defense-In-Depth-Vault-Architecture.md
- memory/08_Mistakes/Mistake-002-Stale-Memory-Docs-Overrode-Source.md
- memory/09_Runbooks/Runbook-Autonomous-Self-Learning.md
- memory/09_Runbooks/Runbook-Deploy-Safety-Checklist.md
- memory/09_Runbooks/Runbook-Docs-Drift-Cleanup.md
- memory/09_Runbooks/Runbook-Multi-AI-Memory-Acceptance.md

## Decisions Made
- Memory lifecycle and verification are now MCP-native: use memory_verifyVault and targeted project-memory validators instead of npm memory scripts.
- Historical script-era references remain only when they are explicitly described as retired history or in old session logs/mistake examples.

## Open Follow-ups
- [ ] Current Codex session may still have stale stop-hook cache that asks for npm run memory:verify; restart/reload Codex Desktop so removed scripts and disabled hooks are fully reflected.
- [ ] MCP memory_verifyVault still reports 5 known template frontmatter warnings under memory/99_Templates.
- [ ] Existing unrelated dirty worktree changes remain unstaged and untouched.

## References
- None

## Verification
Confirmed package.json has no memory:* scripts and verify is npm run build; confirmed scripts/memory-check.mjs, scripts/memory-eval.mjs, and scripts/memory-score.mjs no longer exist; rg found no active runnable memory script references outside explicit retired-history wording; git diff --check passed with Windows LF/CRLF warnings only. project-memory MCP verification: memory_reindex indexed 189 notes; memory_verifyVault ok=true, filesScanned=189, score=72, grade=D, errors=0, warnings=5 template frontmatter warnings; memory_verifyNote passed for updated Memory Evaluation, Memory Quality, Multi-AI Acceptance, Goals, and Session Threads notes. Full build gate: npm run verify passed, now running npm run build only; Vite/esbuild emitted existing non-fatal CSS/minified chunk warnings.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
