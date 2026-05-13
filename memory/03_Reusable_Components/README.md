---
title: Reusable Components Index — SPX Patterns & Building Blocks
type: index
status: active
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Reusable Components
  - Components
tags:
  - meta
  - moc
  - project/spx
  - topic/patterns
---

# 🧩 Reusable Components

> [!abstract] Purpose
> Cataloged **patterns and code building blocks** used in SPX that are worth reusing. Each entry documents the pattern, where it lives in `src/`, and when to reach for it. This is distinct from API docs (external/HTTP contracts) and runbooks (operational procedures).

> [!important] Reusable vs one-off
> A component lands here when:
> - It's been used in 2+ places, OR
> - A new AI agent should clearly understand the pattern before extending the code, OR
> - It encodes a non-obvious decision (e.g. retry semantics, dual-storage, SSE singleton).

---

## Index

```dataview
TABLE
  language AS "Lang",
  status AS "Status",
  dependencies AS "Deps"
FROM "03_Reusable_Components"
WHERE type = "component"
SORT file.name ASC
```

---

## Suggested Components to Document (Backlog)

> [!todo] Top candidates from current codebase
> - [ ] **Component-Retry-With-Backoff.md** — exponential backoff helper used by `api-client.ts` (3 retries, session-expiry detection).
> - [ ] **Component-Dual-Storage-Repository.md** — DEV (JSON file) vs PROD (MySQL) selection — pattern used by `notify-rules.ts` and `auto-accept-repository.ts`. See [[ADR-001-Dual-Storage-Notify-Rules]].
> - [ ] **Component-SSE-Broadcaster.md** — singleton `sseBroadcaster` in `src/services/sse.ts` with JWT-authenticated subscribe + per-topic emit.
> - [ ] **Component-Poller-Tick.md** — the polling loop pattern in `src/controllers/poller.ts` (start/stop, graceful shutdown via `Poller.stop()`).
> - [ ] **Component-MVC-Controller.md** — Fastify route + controller + service split used across `src/controllers/*-controller.ts`.
> - [ ] **Component-INSERT-IGNORE-Dedupe.md** — write-once semantics in `db-service.ts` for booking requests.

## Conventions for Component Notes

Each note in this folder SHOULD be `type: component` and include:

```yaml
---
title: Component — <Pattern Name>
type: component
language: typescript
status: experimental | reusable | deprecated
dependencies: [package-name, ...]
last-verified: YYYY-MM-DD          # optional but encouraged
verified-by: <agent or human>
source: file:src/<path>.ts
confidence: high | medium | low    # how certain we are this is current
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [component, project/spx, topic/<subtopic>, language/typescript]
---
```

Body sections:
1. **What it does** — one paragraph
2. **Where it lives** — file + key exports
3. **When to use** — task patterns that should reach for it
4. **When NOT to use** — anti-patterns / alternatives
5. **Example** — minimal usage
6. **Related** — ADRs, runbooks, mistakes

## Related

- [[AGENTS]] § Retrieval Protocol — when to read components
- [[02_API_Docs/]] — for external HTTP contracts (not patterns)
- [[09_Runbooks/]] — for operational procedures (not patterns)
- Code root: `src/`
