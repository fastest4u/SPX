---
title: Reusable Components Index - SPX Patterns & Building Blocks
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

# Reusable Components

> [!abstract] Purpose
> Cataloged SPX patterns worth reusing or understanding before extending the codebase.

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

## Current Notes

- [[Component-Retry-With-Backoff]] - external HTTP retry/backoff behavior.
- [[Component-Poller-Orchestration]] - poller lifecycle, detail processing, auto-accept, metrics, and shutdown.
- [[Component-Dual-Storage-Notify-Rules]] - JSON vs MySQL rule storage and migration behavior.

---

## Backlog

- [ ] `Component-SSE-Broadcaster.md` - singleton `sseBroadcaster` and client lifecycle.
- [ ] `Component-MVC-Controller.md` - Fastify controller/service/repository split.
- [ ] `Component-INSERT-IGNORE-Dedupe.md` - write-once booking history semantics.

---

## Conventions

Each note in this folder should be `type: component` and include:

```yaml
language: typescript
status: experimental | reusable | deprecated
last-verified: YYYY-MM-DD
verified-by: <agent or human>
source: file:src/<path>.ts
confidence: high | medium | low | guess
```

Body sections should cover purpose, source files, when to use, when not to use, gotchas, and related docs.

---

## Related

- [[SPX-System-Map]]
- [[API-Internal-HTTP]]
- [[API-SSE-Events]]
- [[Runbook-DB-Migration]]
