---
title: "ADR-003 — Frontend Design System v2: Semantic Tokens, PageHeader, Shared SSE Provider"
type: adr
status: accepted
decision-date: 2026-05-23
confidence: high
supersedes: []
created: 2026-05-23
updated: 2026-05-23
aliases:
  - ADR-003
  - Frontend Design System v2
tags:
  - frontend
  - design-system
  - tailwind-v4
  - react-19
  - ui-ux
  - accessibility
---

# ADR-003 — Frontend Design System v2

## Context
SPX dashboard frontend (React 19 + Vite + Tailwind v4) had drifted into 12 routes with inconsistent visual language. Symptoms:
- Each route hand-rolled its own header (`<CardTitle className="text-white">`, ad-hoc icon chip, no breadcrumb).
- Color usage was rainbow: cyan/emerald/amber/rose/violet picked per page with no shared meaning.
- Mobile bottom-tab had 6 items (violates `bottom-nav-limit` ≤ 5).
- Tables had no density toggle, no column visibility, no bulk actions.
- Fonts loaded via CSS `@import` (render-blocking).
- SSE EventSource opened only by Dashboard; AppLayout could not show real-time status.
- Coachmark / first-run guidance was missing.
- Notification bell counter was hardcoded to 0.

We needed an Enterprise-grade overhaul without rewriting routes from scratch.

## Decision
Adopted a layered redesign in 4 phases, all executed in one session with `npm run typecheck` + `npm run build` gating each batch:

Phase 1 - Foundations
- Semantic CSS tokens in `src/frontend/index.css` (`--color-info|success|warning|danger`, `--color-*-soft`, `--color-*-border`, `--color-*-foreground`).
- Type scale (display/h1/h2/h3/body/small/micro), spacing rhythm (4pt), motion tokens, density vars, z-index scale, focus ring.
- Font preload in `index.html` (preconnect + preload), removed render-blocking CSS @import.
- Skip-link + `<main id="main-content">` landmark.
- New `<PageHeader>` component (icon + title + subtitle + meta + actions + breadcrumb). Applied to all 11 authenticated routes.
- Toast (sonner) styled via CSS variables instead of raw oklch.
- Mobile bottom-tab reduced from 6 → 5 (`bottom-nav-limit` rule).

Phase 2 - Reusable patterns
- `<StatCard>`, `<ErrorState>`, `<FilterChip>` UI primitives.
- DataTable v2: density toggle (compact/cozy/comfortable) persisted via `densityKey` localStorage, sticky header with `aria-sort`, semantic pagination buttons.
- `useSavedView<T>(key, initial)` hook with versioned `{v, ts, data}` envelope (Vercel `client-localstorage-schema`).
- Automated `scripts/sweep-semantic-colors.mjs` mapping cyan→info, emerald→success, amber→warning, rose/red→danger, violet→primary across 193 occurrences.

Phase 3 - Real data
- StatCard applied to Dashboard runtime, History summary, Settings summary.
- ErrorState applied to Users + History with refetch retry.
- Reports rewritten with `recharts` AreaChart (avg/p95 latency, 96 points) + 4 StatCards (success rate / avg / p95 / total).
- `useNotificationCount()` hook reading from MetricsSnapshot signals (session expired / unhealthy / paused / queue pressure > 100%).
- History switched filters + page size + sort to `useSavedView`.

Phase 4 - Layout-level polish
- `<SseProvider>` + `useSseStream()` consolidating EventSource (1 connection per session, multiple consumers).
- SSE indicator dot in topbar with click-to-reconnect.
- Bell icon → `<Link to="/notifications">` with real counter.
- DataTable v3: column visibility menu (per route, persisted), bulk actions toolbar with tri-state checkbox, `useTransition` wrapping sort handlers.
- `<Coachmark>` first-login tour (4 steps, dismiss persistent in localStorage).
- Keyboard shortcuts overlay triggered by `?`.
- "Show tour again" CTA in user menu.

Color rule: JSX MUST use semantic Tailwind utilities (`bg-info`, `text-success`, `border-[color:var(--color-warning-border)]`, `bg-[color:var(--color-danger-soft)]`) or brand `primary`. Raw rainbow palette (`cyan-300`, `emerald-400`, etc.) is banned in route/component JSX. Verified zero rainbow references in `src/frontend/{routes,components}` after sweep.

## Consequences
- All 11 routes now share a single visual language: header / KPI / table / filter / empty / error / loading patterns are reusable.
- Bundle still ships per-route chunks (dashboard 69 kB, settings 98 kB, reports 421 kB lazy with recharts).
- EventSource consumers can be added anywhere in authenticated tree without opening new connections — read via useSseStream().
- Density toggle + column visibility persist per-route in localStorage (`spx:density:<key>`, `spx:tablecols:<key>`); future schema bumps must increment version field.
- Coachmark dismissal persists per browser (`spx:coachmark:v1`); user can re-trigger via user menu.
- DataTable bulk actions are opt-in via `bulkActions` prop — current routes do not yet enable selection mode, so behavior is unchanged unless adopted.
- Settings still has long forms inside; the page header was modernized but the section editor was left intact pending a Phase 5 tab restructure.
- Light theme + system preference were intentionally deferred; tokens are dark-only. Adding light requires defining a `:root` light variant and a theme provider.
- Recharts adds ~300 kB to the Reports chunk; lazy-loaded so dashboard / login users do not pay the cost.
- Vercel React rule `rendering-conditional-render` (&& → ternary) was applied selectively where there was a real risk of `0`/`false` rendering; blanket conversion was rejected to keep churn low.
