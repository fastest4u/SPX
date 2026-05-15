---
title: "2026-05-14 - SPX Performance UX Roadmap"
type: session-log
session-date: 2026-05-14
agent: codex
duration-minutes: 20
outcomes:
  - Recorded the frontend/backend performance and operator UX roadmap as a durable backlog goal.
  - Captured the decision to extend SPX's lightweight Tailwind/Radix/shadcn-style stack rather than add heavy UI frameworks.
created: 2026-05-14
updated: 2026-05-14
tags:
  - session-log
  - project/spx
  - topic/performance
  - topic/ui-ux
thread: product-roadmap
---

# 2026-05-14 - SPX Performance UX Roadmap

> [!abstract] Summary
> Saved the agreed next-development direction into [[Goals]] as G-008 so future SPX work can pick up the plan without re-discussion.

## Summary

- User asked what SPX should improve next for UI/UX and later clarified the system should stay lightweight.
- Source review showed the current frontend uses Tailwind CSS v4, local shadcn-style components, Radix primitives, lucide-react, TanStack Router/Query, sonner, and no Material/MUI dependency.
- The roadmap prioritizes measurement, backend pipeline speed, query health, frontend data-flow tuning, and operator-focused UX.

## Goal

Persist the performance and operator UX plan into the Memory Vault for later implementation.

## Log

- Reviewed current UI stack from `package.json`, `vite.config.ts`, `src/frontend/index.css`, `src/frontend/components/ui/*`, and frontend imports.
- Reviewed performance-relevant runtime files: `src/controllers/poller.ts`, `src/services/api-client.ts`, `src/services/metrics.ts`, `src/services/sse.ts`, `src/frontend/lib/api.ts`, `src/frontend/components/DataTable.tsx`, and `src/frontend/components/layout/AppLayout.tsx`.
- Updated [[Goals]] with G-008: Lightweight Performance and Operator UX Roadmap.

## What Was Done

- [x] Added G-008 backlog goal with source evidence and recommended implementation sequence.
- [x] Captured guardrails against adding heavy UI libraries.
- [x] Documented verification expectations for code, schema, and memory changes.

## Verification

- [x] `npm run memory:verify` passed after this log; first run scored 95/100 only because this verification checkbox was still unchecked.

## Follow-ups

None required before implementation. Next working session can start from G-008.

## Files Touched

- `memory/00_Index/Goals.md` - added G-008 roadmap.
- `memory/05_Agent_Session_Logs/2026-05-14-SPX-Performance-UX-Roadmap.md` - this session log.

## Decisions Made

- Optimize the current lightweight stack instead of adding MUI, AntD, Chakra, or another large UI framework.
- Measure backend/frontend bottlenecks before making deeper implementation changes.
- Prioritize operator workflows: Live Action Queue, Health Center, Rule dry-run/preview, and Unified Timeline.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Current UI stack is shadcn-style custom components, not Material/MUI | high | supported by package/import/config review | Distinguish installed libraries from copied component patterns |

## Insights / Learnings

- For SPX, perceived speed and operational clarity should be improved together: fast polling without a clear action surface still leaves the operator doing manual diagnosis.

## Open Issues / Follow-ups

None.

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All edited notes have updated `updated:` field where applicable
> - [x] Wikilinks added to related notes
> - [x] Tagged with at least 2 taxonomy tags
> - [x] No file with more than 1 unrelated H2
> - [x] Session log written

## References

- [[Goals]]
- [[SPX-System-Map]]
