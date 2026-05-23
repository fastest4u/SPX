---
title: "Use Memoized UI Primitives + Shared Provider Hooks for Multi-Route Consistency"
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-05-15-G008-Operator-UX-Phase-5.md
  - 05_Agent_Session_Logs/2026-05-15-G008-Route-Code-Splitting.md
confidence: high
status: active
created: 2026-05-23
updated: 2026-05-23
tags:
  - frontend
  - design-system
  - react
  - patterns
  - ui-ux
---
When a multi-route SPA has drifted into per-route ad-hoc styling, the highest-leverage pattern is:

1. **Build small UI primitives first** (`<PageHeader>`, `<StatCard>`, `<ErrorState>`, `<FilterChip>`) — each one is <150 LOC, accepts `tone` prop with semantic variants, and uses `React.memo` where re-render cost matters (StatCard especially, since it lives inside dashboards that re-render on SSE tick).
2. **Define semantic CSS tokens in one place** (`index.css` `:root` + `@theme inline`) and ban raw color utilities from JSX. Enforce via grep audit — a one-shot sweep script (`scripts/sweep-semantic-colors.mjs`) can map 193 occurrences in seconds with conservative regex.
3. **Migrate routes top-down** — replace headers first (highest visibility), then table summary tiles, then filters, then loading/error/empty states. Each step is a separate batch with `npm run typecheck` between them.
4. **Consolidate effectful hooks via context** — when a hook (like `useSse`) opens an external resource (EventSource, WebSocket), wrap it in a Provider + thin `useXStream()` consumer hook. This prevents accidental N connections when multiple components want the same data.
5. **Persist user preferences with versioned localStorage envelopes** — `{v: 1, ts, data}` shape lets future schema changes drop stale data without crashing. Apply to density, column visibility, saved views, coachmark dismissal.

The pattern compounds: every new route can now be built with `<PageHeader>` + `<DataTable densityKey="...">` + semantic tones and inherits consistency for free. Onboarding (coachmark) and progressive disclosure (`?` keyboard overlay) are the cheap wins that close the perceived-quality gap with Linear / Vercel Dashboard.

Anti-pattern observed and avoided: blanket `&&` → ternary conversion across all JSX. Vercel's `rendering-conditional-render` rule targets cases where the LHS could be `0` or `false`; converting safe boolean-LHS expressions creates noise without value. Apply the rule where risk exists (`.length &&`, numeric counts), not as a stylistic blanket.
