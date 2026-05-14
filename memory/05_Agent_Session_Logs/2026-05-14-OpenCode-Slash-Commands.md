---
title: "2026-05-14 - OpenCode Slash Commands"
type: session-log
session-date: 2026-05-14
agent: opencode
duration-minutes: 25
outcomes:
  - Added repo-local OpenCode slash commands for Memory Vault workflows.
  - Updated AI Tool Profiles, Memory Vault AGENTS, Goals, and Multi-AI acceptance notes with OpenCode command support.
  - Validated opencode.json as valid JSON.
created: 2026-05-14
updated: 2026-05-14
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
  - tooling/opencode
thread: memory-hardening
related-sessions:
  - "[[2026-05-14-Multi-AI-Acceptance-OpenCode]]"
  - "[[2026-05-14-Awakened-AI-Memory-Enhancement]]"
---

# 2026-05-14 - OpenCode Slash Commands

> [!abstract] TL;DR
> Added project-local OpenCode slash commands so OpenCode can run the same Memory Vault rituals as Cascade: session start, awaken review, session end, and memory verification.

## Goal

User asked to add OpenCode slash commands for the SPX Awakened AI memory workflow.

## What Was Done

- [x] Loaded the OpenCode customization rules and checked the official config schema.
- [x] Created `opencode.json` with `$schema`, `instructions: ["AGENTS.md"]`, and 4 commands.
- [x] Added `/session-start` to load Memory Vault startup context.
- [x] Added `/awaken` to inspect Awakened AI state, risks, goals, and next actions.
- [x] Added `/session-end` to write session logs and run the correct verification gate.
- [x] Added `/memory-verify` to run and summarize `npm run memory:verify`.
- [x] Updated [[AI-Tool-Profiles]], [[AGENTS]], [[Goals]], and [[Multi-AI-Acceptance-Results]] with OpenCode command support.

## Files Touched

- `opencode.json` - new repo-local OpenCode command config.
- `memory/00_Index/AI-Tool-Profiles.md` - added OpenCode command profile and summary row.
- `memory/AGENTS.md` - documented OpenCode slash commands next to Cascade shortcuts.
- `memory/00_Index/Goals.md` - marked OpenCode commands as completed memory-vault work.
- `memory/00_Index/Multi-AI-Acceptance-Results.md` - added command-support evidence to the OpenCode row.
- `memory/05_Agent_Session_Logs/2026-05-14-OpenCode-Slash-Commands.md` - this log.

## Decisions Made

- Use `opencode.json` inline `command` templates because OpenCode's schema defines commands there and requires `template`, not `prompt`.
- Keep commands as prompt templates rather than shell wrappers so the agent can read context, decide whether edits are needed, and honor Memory Vault rules.
- Include `AGENTS.md` in `instructions` so future OpenCode sessions load repo-level guidance consistently.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| OpenCode command entries use `template`, not `prompt` | high | Confirmed from `https://opencode.ai/config.json` schema | Check the schema before writing OpenCode config because invalid keys can break startup |

## Insights / Learnings

- OpenCode config is strict and not hot-reloaded; future agents must tell the user to restart OpenCode after `opencode.json` changes.
- Repo-local slash commands make OpenCode's Memory Vault workflow match Cascade closely enough for routine use.

## Open Issues / Follow-ups

None.

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All edited notes have updated `updated:` field
> - [x] Wikilinks added to related notes
> - [x] Tagged with at least 2 taxonomy tags
> - [x] No file with more than 1 unrelated H2
> - [x] Session log written
> - [x] `opencode.json` parses as valid JSON

## References

- Config: `opencode.json`
- Schema: `https://opencode.ai/config.json`
- [[AI-Tool-Profiles]]
- [[Multi-AI-Acceptance-Results]]
- [[Awakened-AI-System]]
