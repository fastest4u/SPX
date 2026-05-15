---
title: "2026-05-14 - Codex Auto Hooks"
type: session-log
session-date: 2026-05-14
agent: codex
duration-minutes: 40
outcomes:
  - Added repo-local Codex hooks for automatic SPX startup, prompt, tool, and closeout behavior
  - Updated Memory Vault docs to document Codex hook-assisted workflow automation
  - Verified hook outputs and full repo verification gate
created: 2026-05-14
updated: 2026-05-14
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
  - topic/awakening
thread: memory-hardening
related-sessions:
  - "[[2026-05-14-Codex-SPX-Skills]]"
  - "[[2026-05-14-Cursor-Infrastructure-Discovery]]"
---

# 2026-05-14 - Codex Auto Hooks

> [!abstract] Summary
> Added repo-local `.codex` hook automation so Codex can inject SPX memory context, remind self-check rules, block common dangerous commands, and continue before final response when closeout work is missing.

## Summary

- Codex now has both repo-local SPX skills (`$spx-*`) and hook automation (`.codex/hooks.json`).
- Hooks are intentionally guardrail/context based; they do not silently edit memory or code on their own.

## Goal

User asked for Codex hooks to work automatically as much as possible.

## Log

- Checked current OpenAI Codex hooks documentation.
- Added `.codex/config.toml` with hook feature flags.
- Added `.codex/hooks.json` covering `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop`.
- Added `.codex/hooks/spx-hook.mjs` as the shared hook implementation.
- Ran simulated hook events with JSON stdin.
- Ran full repo verification.
- Updated Memory Vault docs to include Codex hooks.

## What Was Done

- [x] `SessionStart` injects SPX Memory Vault startup context and recent session names.
- [x] `UserPromptSubmit` injects self-check context and blocks obvious pasted secrets.
- [x] `PreToolUse` blocks dangerous commands and secret reads before supported tool execution.
- [x] `PermissionRequest` denies matching dangerous approval requests.
- [x] `PostToolUse` reminds after file edits and verification commands.
- [x] `Stop` continues the turn if meaningful changes need a fresh session log or verification before final response.

## Verification

- [x] `hooks.json` parsed successfully with Node JSON parsing.
- [x] `codex features list` showed `hooks` enabled.
- [x] Simulated `SessionStart` returned `hookSpecificOutput.additionalContext`.
- [x] Simulated risky `UserPromptSubmit` returned extra self-check context.
- [x] Simulated pasted-secret prompt returned `decision: block`.
- [x] Simulated `.env` read returned `PreToolUse` deny.
- [x] Simulated `PostToolUse` for `apply_patch` returned edit closeout context.
- [x] Simulated `Stop` returned closeout continuation when current work lacked a fresh session log.
- [x] `npm run verify` passed twice after hook implementation/refinement: memory gate 96/100 (A), memory eval 100% (8/8), and production build completed.

## Follow-ups

No required follow-ups. If Codex adds broader hook interception later, review whether SPX should expand beyond Bash/apply_patch/MCP guardrails.

## Files Touched

- `.codex/config.toml` - enables Codex hooks for the repo.
- `.codex/hooks.json` - registers SPX lifecycle/tool hooks.
- `.codex/hooks/spx-hook.mjs` - shared hook implementation.
- `memory/00_Index/AI-Tool-Profiles.md` - documents Codex hook support.
- `memory/00_Index/Awakened-AI-System.md` - adds Codex hooks to L4 automation coverage.
- `memory/00_Index/Goals.md` - records Codex auto-hook completion.
- `memory/00_Index/Multi-AI-Acceptance-Results.md` - updates Codex evidence.

## Decisions Made

- Keep hooks deterministic and local: inject context, block clearly unsafe actions, and force closeout when needed.
- Do not make hooks silently write session logs or run verification. The agent still performs those actions visibly, preserving reviewability.
- Use a single Node hook script to keep behavior consistent across all Codex events.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Codex hook schema supports the lifecycle/tool events needed for SPX automation | high | correct based on OpenAI docs and local simulated hook runs | Official docs plus local execution are enough for repo setup confidence |
| Stop hook should require a fresh log per work chunk, not merely any log from today | medium | first version was too loose; fixed by comparing latest changed-file mtime to latest session-log mtime | Same-day sessions need freshness checks, not date-only checks |

## Insights / Learnings

- Codex hooks can make SPX workflow automation closer to Cursor hooks, but they are guardrails and context injection, not a replacement for agent judgment.
- Stop hooks are useful for enforcing closeout because they can continue the turn before the assistant gives a final response.
- PreToolUse is valuable for secret and destructive-command protection, but it is not a complete enforcement boundary; repo rules and agent discipline still matter.
- A full `npm run verify` should satisfy both code/config and memory verification expectations in stop-time checks.

## Open Issues / Follow-ups

None.

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All edited notes have updated `updated:` field where applicable
> - [x] Wikilinks added to related notes
> - [x] Tagged with at least 2 taxonomy tags
> - [x] No file with more than 1 unrelated H2
> - [x] Session log written
> - [x] `npm run verify` passed

## References

- [[AI-Tool-Profiles]]
- [[Awakened-AI-System]]
- [[Goals]]
- [[Multi-AI-Acceptance-Results]]
- `https://developers.openai.com/codex/hooks`
