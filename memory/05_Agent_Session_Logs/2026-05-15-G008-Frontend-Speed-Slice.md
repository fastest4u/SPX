---
title: "2026-05-15 — G008 Frontend Speed Slice"
type: session-log
session-date: 2026-05-15
agent: cascade
duration-minutes: 35
outcomes:
  - Continued [[Goals#G-008 Lightweight Performance and Operator UX Roadmap]] Phase 4 frontend speed.
  - Tuned TanStack Query freshness and paginated-query behavior.
  - Moved paginated table sorting to server-backed query params and replaced quick search full reloads with router navigation.
created: 2026-05-15
updated: 2026-05-15
tags:
  - session-log
  - project/spx
  - topic/performance
  - topic/frontend
---

# 2026-05-15 — G008 Frontend Speed Slice

> [!abstract] TL;DR
> Continued G-008 Phase 4 by reducing avoidable frontend refetches, smoothing paginated route transitions with TanStack Query previous-data placeholders, moving paginated table sorting to server query params, debouncing filters, and avoiding full-page reloads from quick search.

## Goal

Continue [[Goals#G-008 Lightweight Performance and Operator UX Roadmap]] Phase 4 frontend speed without changing the UI architecture or adding heavy libraries.

## What Was Done

- [x] Set global TanStack Query defaults to `staleTime: 60_000` and `refetchOnWindowFocus: false` in `src/frontend/main.tsx`.
- [x] Added a shared `useDebouncedValue()` hook for route filters.
- [x] Updated history, audit, and auto-accept-history routes to use `keepPreviousData`, route-specific `staleTime`, debounced filters, and server-backed sort params.
- [x] Extended `DataTable` with optional controlled sorting so paginated tables can avoid sorting only the current page client-side.
- [x] Kept `DataTable` local sorting behavior for existing non-controlled use cases.
- [x] Replaced quick search `window.location.href` with TanStack Router `navigate()` to avoid full page reloads.
- [x] Tuned freshness for dashboard, users, settings, and LINE Bot queries.
- [x] Updated [[Goals]] progress for Phase 4.

## Files Touched

- `src/frontend/main.tsx` — adjusted QueryClient defaults.
- `src/frontend/hooks/useDebouncedValue.ts` — added shared debounce hook.
- `src/frontend/components/DataTable.tsx` — added optional controlled sorting mode.
- `src/frontend/routes/history.tsx` — debounced filters, previous-data placeholder, server-backed sorting.
- `src/frontend/routes/audit.tsx` — debounced filters, previous-data placeholder, server-backed sorting.
- `src/frontend/routes/auto-accept-history.tsx` — debounced filters, previous-data placeholder, server-backed sorting.
- `src/frontend/components/layout/AppLayout.tsx` — changed quick search to router navigation.
- `src/frontend/routes/index.tsx` — route-specific freshness for dashboard queries.
- `src/frontend/routes/users.tsx` — freshness for user list.
- `src/frontend/routes/settings.tsx` — freshness for settings query.
- `src/frontend/routes/line-bot.tsx` — freshness for LINE Bot status/groups.
- `memory/00_Index/Goals.md` — recorded G-008 Phase 4 progress.
- `memory/05_Agent_Session_Logs/2026-05-15-G008-Frontend-Speed-Slice.md` — this session log.

## Decisions Made

- Used TanStack Query v5 `placeholderData: keepPreviousData` rather than deprecated `keepPreviousData: true`.
- Did not attempt route-level code splitting in this slice because generated TanStack route tree changes are broader and the current build warning existed before this work.
- Used server-backed sorting only for columns supported by backend sort enums to avoid invalid query params.

## Verification

- [x] `npm run typecheck` passed.
- [x] `npm run build` passed.
- [x] `npm run memory:verify` passed.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| TanStack Query v5 should use `placeholderData: keepPreviousData` for paginated previous data | medium-high | confirmed via Context7 docs and typecheck/build | Check current library docs before editing data-fetch options |
| DataTable can support server-backed sorting without breaking local sorting | medium | verified by TypeScript build; runtime UI not browser-tested in this slice | Keep controlled and uncontrolled modes separate |

## Insights / Learnings

- Frontend speed improvements are safest when split into query freshness, pagination smoothness, and navigation behavior before larger bundle/code-splitting work.
- Server-backed sorting is important for paginated tables; client-side sorting on a single page can mislead users and adds unnecessary render work.
- Quick search should use router navigation to preserve SPA state and avoid avoidable reload cost.

## Operational Notes

- Consider browser-testing history/audit/auto-accept-history sorting and quick search after starting the dev server.
- Consider route-level code splitting as a separate Phase 4 follow-up if bundle size remains a priority.

## References

- [[Goals]]
- [[2026-05-15-G008-Query-Health-Indexes]]
- [[2026-05-15-G008-Backend-Speed-Slice]]
- [[2026-05-15-G008-Pipeline-Telemetry]]
