---
title: "2026-05-23 - Bake project-memory MCP lifecycle into Kiro hooks + steering"
type: session-log
session-date: 2026-05-23
agent: claude-opus-4.7
outcomes:
  - "Created `.kiro/steering/memory-lifecycle.md` (always-included) cataloguing all `mcp_project_memory_*` tools by phase + sessionEnd payload template + quality-gate failure modes."
  - "Hook `spx-risk-gate-on-prompt.kiro.hook` v2 in place: fires on every promptSubmit and reminds agent to follow the 7-step lifecycle (classify → selfCheck → sessionStart → contextPack → followUpRadar → work → sessionEnd)."
  - "`.kiro/steering/risk-gate.md` (from earlier) still acts as the HIGH/MEDIUM/LOW classifier the hook references."
  - "Closed the long-running follow-up `Setup Auto project-memory MCP Session Management` from 2026-05-21 — the AGENTS.md/workflow auto-management work is now committed in steering form."
created: 2026-05-23
updated: 2026-05-23
tags:
  - session-log
  - project/general
---
# 2026-05-23 - Bake project-memory MCP lifecycle into Kiro hooks + steering

## TL;DR
- Created `.kiro/steering/memory-lifecycle.md` (always-included) cataloguing all `mcp_project_memory_*` tools by phase + sessionEnd payload template + quality-gate failure modes.
- Hook `spx-risk-gate-on-prompt.kiro.hook` v2 in place: fires on every promptSubmit and reminds agent to follow the 7-step lifecycle (classify → selfCheck → sessionStart → contextPack → followUpRadar → work → sessionEnd).
- `.kiro/steering/risk-gate.md` (from earlier) still acts as the HIGH/MEDIUM/LOW classifier the hook references.
- Closed the long-running follow-up `Setup Auto project-memory MCP Session Management` from 2026-05-21 — the AGENTS.md/workflow auto-management work is now committed in steering form.

## Goal
Bake project-memory MCP lifecycle into Kiro hooks + steering

## What Was Done
- Created `.kiro/steering/memory-lifecycle.md` (always-included) cataloguing all `mcp_project_memory_*` tools by phase + sessionEnd payload template + quality-gate failure modes.
- Hook `spx-risk-gate-on-prompt.kiro.hook` v2 in place: fires on every promptSubmit and reminds agent to follow the 7-step lifecycle (classify → selfCheck → sessionStart → contextPack → followUpRadar → work → sessionEnd).
- `.kiro/steering/risk-gate.md` (from earlier) still acts as the HIGH/MEDIUM/LOW classifier the hook references.
- Closed the long-running follow-up `Setup Auto project-memory MCP Session Management` from 2026-05-21 — the AGENTS.md/workflow auto-management work is now committed in steering form.

## Files Touched
- .kiro/hooks/spx-risk-gate-on-prompt.kiro.hook
- .kiro/steering/risk-gate.md
- .kiro/steering/memory-lifecycle.md

## Decisions Made
- Bake the full project-memory MCP lifecycle into Kiro hooks + steering instead of relying on AGENTS.md alone, because Layer 3 (selfCheck) was getting skipped under context pressure during the frontend redesign session.
- Use 3-layer defense: (1) `promptSubmit` hook with full memory lifecycle reminder injected on every user prompt, (2) `risk-gate.md` always-included steering for HIGH/MEDIUM/LOW classification table, (3) `memory-lifecycle.md` always-included steering with full tool catalogue + sessionEnd payload schema + quality-gate failure modes.
- Hook v2 covers all 7 steps (classify → selfCheck → sessionStart → contextPack → followUpRadar → work → sessionEnd+writeADR/Mistake/Insight) so the next agent invocation does not need to re-derive the flow.
- Steering catalogues all 22 `mcp_project_memory_*` tools grouped by phase (START 4 / DURING 5 / END 4 / MAINTENANCE 9) with sessionEnd payload template and explicit anti-patterns.

## Open Follow-ups
- [ ] Try the next risky task (e.g. multi-file refactor or production deploy) and confirm the agent now calls memory_selfCheck before the first tool use — if not, hook is not firing.
- [ ] Run memory_lifecycleStatus periodically to confirm quality-gate scores trend up after this change.
- [ ] Consider mirroring the same lifecycle gate into `.cursor/hooks/session-start.mjs` and `.codex/hooks/spx-hook.mjs` so all three IDE entrypoints behave identically.

## References
- memory/05_Agent_Session_Logs/2026-05-21-Auto-Project-Memory-MCP-Setup.md
- AGENTS.md
- .kiro/steering/risk-gate.md
- .kiro/steering/memory-lifecycle.md
- .kiro/hooks/spx-risk-gate-on-prompt.kiro.hook

## Verification
Steering file written and confirmed by user via auto-include rule injection on next turn; hook v2 already on disk from prior turn; followUpRadar called this session surfaced the matching 2026-05-21 follow-up confirming continuity.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Three layers (hook + risk-gate steering + memory-lifecycle steering) is enough to prevent agents from forgetting selfCheck/sessionStart/sessionEnd | high | Confirmed: hook v2 was already on disk pre-session, steering memory-lifecycle.md created this session. Both load automatically (always-included steering + promptSubmit hook). | Defense-in-depth for agent compliance: active push (hook on prompt) + passive context (always-included steering) + doctrine (AGENTS.md). Single-layer reminders get ignored under context pressure. |
| Calling sessionStart + contextPack + followUpRadar before tool work surfaces relevant prior work | high | memory_followUpRadar surfaced the 2026-05-21 'Setup Auto project-memory MCP Session Management' follow-up which was the antecedent for this exact work — confirming the lifecycle gate already pays for itself. | followUpRadar is the highest-leverage start-phase tool. Without it, agents redo work or miss continuity. Make it mandatory, not optional. |
