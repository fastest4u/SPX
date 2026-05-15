---
title: "2026-05-15 - G008 Route Code Splitting"
type: session-log
session-date: 2026-05-15
agent: opencode
duration-minutes: 25
outcomes:
  - Continued [[Goals#G-008 Lightweight Performance and Operator UX Roadmap]] with Phase 6 bundle/runtime polish.
  - Enabled TanStack Router route-level code splitting and converted route files to `createFileRoute`.
  - Reduced the built main frontend chunk from about 633 kB to about 427 kB and removed the Vite large chunk warning.
created: 2026-05-15
updated: 2026-05-15
tags:
  - session-log
  - project/spx
  - topic/performance
  - topic/frontend
---

# 2026-05-15 - G008 Route Code Splitting

> [!abstract] TL;DR
> Phase 6 focused on bundle/runtime polish after Phase 5: route files now use TanStack Router's file-route pattern and Vite auto code splitting emits separate chunks for dashboard routes instead of one large frontend bundle.

## Goal

If Phase 5 is complete, continue with a concrete Phase 6 follow-up. The selected Phase 6 was route-level code splitting because the production build still warned about a 633 kB frontend chunk.

## What Was Done

- [x] Enabled `autoCodeSplitting: true` in `vite.config.ts` for the TanStack Router Vite plugin.
- [x] Converted route files from manual `createRoute` + `rootRoute` imports to `createFileRoute` so the plugin can split route modules.
- [x] Verified build output now includes separate chunks such as `history`, `settings`, `users`, `line-bot`, `audit`, `notifications`, and `reports`.
- [x] Updated [[Goals]] to add and mark complete Phase 6 bundle/runtime polish.

## Files Touched

- `vite.config.ts` - enabled TanStack Router auto code splitting.
- `src/frontend/routes/index.tsx` - converted dashboard route to `createFileRoute`.
- `src/frontend/routes/history.tsx` - converted to `createFileRoute`.
- `src/frontend/routes/audit.tsx` - converted to `createFileRoute`.
- `src/frontend/routes/auto-accept-history.tsx` - converted to `createFileRoute`.
- `src/frontend/routes/line-bot.tsx` - converted to `createFileRoute`.
- `src/frontend/routes/login.tsx` - converted to `createFileRoute`.
- `src/frontend/routes/notifications.tsx` - converted to `createFileRoute`.
- `src/frontend/routes/reports.tsx` - converted to `createFileRoute`.
- `src/frontend/routes/settings.tsx` - converted to `createFileRoute`.
- `src/frontend/routes/users.tsx` - converted to `createFileRoute`.
- `memory/00_Index/Goals.md` - recorded Phase 6.
- `memory/05_Agent_Session_Logs/2026-05-15-G008-Route-Code-Splitting.md` - this session log.

## Decisions Made

- Treated Phase 6 as bundle/runtime polish because Phase 5 was complete and the build itself showed a concrete bundle-size follow-up.
- Used TanStack Router's built-in file-route code-splitting path instead of adding another dependency or manual React lazy wrappers.
- Did not edit generated `src/frontend/routeTree.gen.ts` manually.

## Verification

- [x] `npm run build` passed; main frontend chunk dropped from about 633 kB to about 427 kB and no Vite large chunk warning was emitted.
- [x] `npm run verify` passed.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Enabling `autoCodeSplitting` alone should split routes | medium | incomplete because existing routes used manual `createRoute`; conversion to `createFileRoute` was needed | Check generated build output, not config intent |
| Route-level code splitting would reduce the main chunk | medium-high | build output confirmed main JS chunk dropped to about 427 kB and route chunks were emitted separately | TanStack Router plugin works once route files follow file-route conventions |

## Open Follow-ups

- [ ] Browser-test route navigation after code splitting, especially admin-only routes and direct URL refreshes.

## References

- [[Goals]]
- [[2026-05-15-G008-Frontend-Speed-Slice]]
- [[2026-05-15-G008-Operator-UX-Phase-5]]
