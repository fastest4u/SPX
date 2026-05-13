---
title: API Docs Index - Bidding Provider + Internal HTTP API
type: index
status: active
created: 2026-05-13
updated: 2026-05-13
aliases:
  - API Docs
tags:
  - meta
  - moc
  - area/api
  - project/spx
---

# API Docs

> [!abstract] Purpose
> Reference notes for the upstream SPX bidding API and the internal Fastify HTTP/SSE API used by the dashboard.

---

## Index

```dataview
TABLE
  status AS "Status",
  row["last-verified"] AS "Last Verified",
  confidence AS "Confidence"
FROM "02_API_Docs"
WHERE type = "reference"
SORT file.name ASC
```

---

## Current Notes

- [[API-Bidding-Endpoints]] - upstream bidding list, overview, request-list, and accept endpoints.
- [[API-Internal-HTTP]] - Fastify routes, auth, RBAC, rate limits, and response envelopes.
- [[API-SSE-Events]] - `/events` stream, event payloads, and frontend reconnect behavior.

---

## Backlog

- [ ] `API-Bidding-Auth.md` - auth model, cookie/device ID behavior, and retcode session detection.
- [ ] `API-Settings-Controller.md` - settings API and DB-backed live reload contract if it grows beyond [[API-Internal-HTTP]].

---

## Conventions

Each note in this folder should be `type: reference` and include truth-maintenance fields:

```yaml
last-verified: YYYY-MM-DD
verified-by: <agent or human>
source: file:src/services/<path>.ts
confidence: high | medium | low | guess
```

Body sections should cover endpoint/path, inputs, outputs, retry/error semantics, and related runbooks.

---

## Related

- [[SPX-System-Map]]
- [[Component-Retry-With-Backoff]]
- [[Runbook-API-Session-Expired]]
- [[ADR-001-Dual-Storage-Notify-Rules]]
