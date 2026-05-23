---
title: "2026-05-23 - Frontend UI/UX redesign Phase 1-4 (semantic tokens + PageHeader + DataTable v3 + SseProvider + Coachmark)"
type: session-log
session-date: 2026-05-23
agent: claude-opus-4.7
duration-minutes: 120
outcomes:
  - "All 11 authenticated routes share `<PageHeader>` with consistent icon / title / subtitle / breadcrumb / actions layout."
  - "Zero rainbow color references (cyan-/emerald-/amber-/rose-/violet-) remain in `src/frontend/{routes,components}` JSX after a sweep verified by grep."
  - "DataTable v3 supports density toggle, column visibility, sort with `useTransition`, sticky header with `aria-sort`, bulk-action toolbar."
  - "New UI primitives shipped: `<StatCard>` (memoized, 6 tones), `<ErrorState>` (retry + collapsible details), `<FilterChip>` (semantic tones), `<Coachmark>` (4-step tour, dismiss persistent), `<PageHeader>`."
  - "Reports route gained recharts AreaChart of latency history + 4 StatCards (success rate / avg / p95 / total requests)."
  - "Bell counter is now wired to real warnings (session expired / unhealthy / paused / queue pressure)."
  - "SSE feed now flows through a single `<SseProvider>` so AppLayout shows live status dot + reconnect button alongside dashboard consumers."
  - "Coachmark first-login tour ships, dismissable, re-triggerable from user menu."
  - "Keyboard shortcuts overlay triggered by `?` (skips when typing in inputs)."
  - "Mobile bottom-tab reduced from 6 to 5 items per `bottom-nav-limit` accessibility rule."
  - "Skip-to-content link, focus ring, `<main id=main-content>` landmark added."
  - "Font loading moved to HTML preconnect + preload to remove render-blocking CSS `@import`."
  - "`useSavedView<T>` hook with versioned localStorage envelope (Vercel `client-localstorage-schema`)."
  - "`scripts/sweep-semantic-colors.mjs` ran 193 mappings across 11 files in seconds."
  - "Full backend + frontend `npm run typecheck` passes; `npm run build` produces a clean production bundle (dashboard 69 kB, settings 98 kB, reports 421 kB lazy)."
created: 2026-05-23
updated: 2026-05-23
tags:
  - session-log
  - project/general
---
# 2026-05-23 - Frontend UI/UX redesign Phase 1-4 (semantic tokens + PageHeader + DataTable v3 + SseProvider + Coachmark)

## TL;DR
- All 11 authenticated routes share `<PageHeader>` with consistent icon / title / subtitle / breadcrumb / actions layout.
- Zero rainbow color references (cyan-/emerald-/amber-/rose-/violet-) remain in `src/frontend/{routes,components}` JSX after a sweep verified by grep.
- DataTable v3 supports density toggle, column visibility, sort with `useTransition`, sticky header with `aria-sort`, bulk-action toolbar.
- New UI primitives shipped: `<StatCard>` (memoized, 6 tones), `<ErrorState>` (retry + collapsible details), `<FilterChip>` (semantic tones), `<Coachmark>` (4-step tour, dismiss persistent), `<PageHeader>`.
- Reports route gained recharts AreaChart of latency history + 4 StatCards (success rate / avg / p95 / total requests).
- Bell counter is now wired to real warnings (session expired / unhealthy / paused / queue pressure).
- SSE feed now flows through a single `<SseProvider>` so AppLayout shows live status dot + reconnect button alongside dashboard consumers.
- Coachmark first-login tour ships, dismissable, re-triggerable from user menu.
- Keyboard shortcuts overlay triggered by `?` (skips when typing in inputs).
- Mobile bottom-tab reduced from 6 to 5 items per `bottom-nav-limit` accessibility rule.
- Skip-to-content link, focus ring, `<main id=main-content>` landmark added.
- Font loading moved to HTML preconnect + preload to remove render-blocking CSS `@import`.
- `useSavedView<T>` hook with versioned localStorage envelope (Vercel `client-localstorage-schema`).
- `scripts/sweep-semantic-colors.mjs` ran 193 mappings across 11 files in seconds.
- Full backend + frontend `npm run typecheck` passes; `npm run build` produces a clean production bundle (dashboard 69 kB, settings 98 kB, reports 421 kB lazy).

## Goal
Frontend UI/UX redesign Phase 1-4 (semantic tokens + PageHeader + DataTable v3 + SseProvider + Coachmark)

## What Was Done
- All 11 authenticated routes share `<PageHeader>` with consistent icon / title / subtitle / breadcrumb / actions layout.
- Zero rainbow color references (cyan-/emerald-/amber-/rose-/violet-) remain in `src/frontend/{routes,components}` JSX after a sweep verified by grep.
- DataTable v3 supports density toggle, column visibility, sort with `useTransition`, sticky header with `aria-sort`, bulk-action toolbar.
- New UI primitives shipped: `<StatCard>` (memoized, 6 tones), `<ErrorState>` (retry + collapsible details), `<FilterChip>` (semantic tones), `<Coachmark>` (4-step tour, dismiss persistent), `<PageHeader>`.
- Reports route gained recharts AreaChart of latency history + 4 StatCards (success rate / avg / p95 / total requests).
- Bell counter is now wired to real warnings (session expired / unhealthy / paused / queue pressure).
- SSE feed now flows through a single `<SseProvider>` so AppLayout shows live status dot + reconnect button alongside dashboard consumers.
- Coachmark first-login tour ships, dismissable, re-triggerable from user menu.
- Keyboard shortcuts overlay triggered by `?` (skips when typing in inputs).
- Mobile bottom-tab reduced from 6 to 5 items per `bottom-nav-limit` accessibility rule.
- Skip-to-content link, focus ring, `<main id=main-content>` landmark added.
- Font loading moved to HTML preconnect + preload to remove render-blocking CSS `@import`.
- `useSavedView<T>` hook with versioned localStorage envelope (Vercel `client-localstorage-schema`).
- `scripts/sweep-semantic-colors.mjs` ran 193 mappings across 11 files in seconds.
- Full backend + frontend `npm run typecheck` passes; `npm run build` produces a clean production bundle (dashboard 69 kB, settings 98 kB, reports 421 kB lazy).

## Files Touched
- src/frontend/index.css
- src/frontend/main.tsx
- index.html
- src/frontend/components/ui/page-header.tsx
- src/frontend/components/ui/stat-card.tsx
- src/frontend/components/ui/error-state.tsx
- src/frontend/components/ui/filter-chip.tsx
- src/frontend/components/ui/coachmark.tsx
- src/frontend/components/ui/badge.tsx
- src/frontend/components/ui/avatar.tsx
- src/frontend/components/ui/dialog.tsx
- src/frontend/components/DataTable.tsx
- src/frontend/components/EmptyState.tsx
- src/frontend/components/Breadcrumb.tsx
- src/frontend/components/CreateRuleDialog.tsx
- src/frontend/components/EditRuleDialog.tsx
- src/frontend/components/RulePreviewDialog.tsx
- src/frontend/components/DeleteConfirmDialog.tsx
- src/frontend/components/VehicleTypeMultiSelect.tsx
- src/frontend/components/SettingsLineBotSection.tsx
- src/frontend/components/layout/AppLayout.tsx
- src/frontend/hooks/useSavedView.ts
- src/frontend/hooks/useNotificationCount.ts
- src/frontend/hooks/useSseContext.tsx
- src/frontend/routes/__root.tsx
- src/frontend/routes/index.tsx
- src/frontend/routes/history.tsx
- src/frontend/routes/audit.tsx
- src/frontend/routes/users.tsx
- src/frontend/routes/notifications.tsx
- src/frontend/routes/reports.tsx
- src/frontend/routes/settings.tsx
- src/frontend/routes/line-bot.tsx
- src/frontend/routes/line-image-extractions.tsx
- src/frontend/routes/auto-accept-history.tsx
- src/frontend/routes/login.tsx
- scripts/sweep-semantic-colors.mjs

## Decisions Made
- Adopt 4-phase incremental redesign rather than big-bang rewrite, with typecheck + build gate after each batch.
- Brand color stays cream gold #e8c76a; theme stays dark-only (light + system deferred to future ADR).
- Ban raw rainbow Tailwind colors from JSX; allow only semantic tokens (info/success/warning/danger) + primary.
- Use `<SseProvider>` + `useSseStream()` instead of multiple direct `useSse('/events')` calls to guarantee single EventSource.
- Persist user prefs (density, column visibility, saved views, coachmark) in localStorage with versioned envelopes.
- Recharts lives only in Reports route to keep initial bundle small.
- Skip blanket `&&` → ternary conversion; apply Vercel `rendering-conditional-render` rule selectively where `0`/`false` could leak.
- DataTable bulk actions are opt-in; existing routes were not switched to selection mode this session.

## Open Follow-ups
- [ ] Browser-test the redesigned dashboard end-to-end (focus order, mobile bottom tabs, ⌘K, ?, coachmark first-login, SSE reconnect).
- [ ] Verify density toggle + column visibility persistence across hard reloads on each table route.
- [ ] Apply `<DataTable bulkActions={...}>` to History (e.g., bulk export selected) and Users (bulk delete) once product confirms desired actions.
- [ ] Restructure Settings into proper tab content components; current page header is modernized but the long form body wasn't refactored.
- [ ] Consider adding light theme + system preference now that semantic tokens are in place (write a follow-up ADR before scope expands).
- [ ] Write a Phase 5 plan: drag-and-drop rule reorder on Dashboard, real charts on Dashboard (success rate gauge), notifications drawer with feed.
- [ ] Audit `text-white` hover states left in AppLayout — confirm they read correctly in screen readers (likely fine; cosmetic only).

## References
- 04_Architecture_Decisions/frontend-design-system-v2-semantic-tokens-pageheader-shared-sse-provider.md
- 07_Insights/use-memoized-ui-primitives-shared-provider-hooks-for-multi-route-consistency.md

## Verification
Not recorded

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Vite + Tailwind v4 will pick up new semantic tokens (`bg-info`, `text-success`, etc.) from `@theme inline` automatically | high | Confirmed: build passed cleanly across all 4 phases without manual config changes; new utilities resolved as expected. | Tailwind v4 `@theme inline` exposes any `--color-<name>` token as `bg-<name>` / `text-<name>` / `border-<name>` utilities. No tailwind.config.ts required. |
| Bulk regex sweep of color classes in JSX would not break syntax | medium | Sweep ran cleanly for 193 occurrences. Separately, an aggressive PowerShell regex on inline arrow-function setters DID break the JSX shape (`{ { updateView(...) }}` instead of `{ updateView(...) }`); had to fix manually. | For Tailwind class atoms, regex sweeps are safe. For setter migrations inside JSX expression containers, prefer explicit str_replace blocks — the brace counting is too easy to get wrong with regex. |
| Switching dashboard from `useSse('/events')` to `useSseStream()` would not change behavior | high | Confirmed. Dashboard chunk shrank 71 → 69 kB and EventSource count dropped from `N consumers` (potential) to 1 fixed. | Provider pattern is a free correctness win for any effectful hook with external resources. Apply pre-emptively instead of waiting for `O(n)` connection bugs. |
| Recharts in Reports route would lazy-load via Vite's auto code-split | high | Confirmed: reports chunk is 421 kB standalone, dashboard initial bundle stays at 69 kB. | TanStack Router file-based routes auto-split per file; large libraries used in one route don't pollute initial bundle as long as they're imported only there. |
| Coachmark dismiss should persist per-browser via localStorage | high | Implemented as `spx:coachmark:v1`. Reset CTA wired through `resetCoachmark()` + `window.location.reload()`. | For one-shot UI state (tour seen, banner dismissed), a flat boolean key is sufficient; reserve versioned envelopes for structured data that may evolve. |
