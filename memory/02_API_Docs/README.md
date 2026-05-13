---
title: API Docs Index — Bidding Provider + Internal HTTP API
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

# 📚 API Docs

> [!abstract] Purpose
> Reference notes for the **external Bidding API** that the poller consumes, and the **internal Fastify HTTP API** that the Web UI / dashboard talks to. Used by AI agents and humans before touching `src/services/api-client.ts` or `src/services/http-server.ts`.

> [!important] What lives here vs elsewhere
> | Question | Where |
> |---|---|
> | "What endpoint does the poller call?" | here |
> | "What request body does `/api/rules` accept?" | here |
> | "How do I refresh the session cookie?" | [[Runbook-API-Session-Expired]] |
> | "Why did we choose dual-storage for rules?" | [[ADR-001-Dual-Storage-Notify-Rules]] |
> | "How does retry/backoff work?" | code (`src/services/api-client.ts`) — link from here when documented |

---

## Index

```dataview
TABLE
  status AS "Status",
  last-verified AS "Last Verified",
  confidence AS "Confidence"
FROM "02_API_Docs"
WHERE type = "reference"
SORT file.name ASC
```

---

## Suggested Notes to Write (Backlog)

> [!todo] Promote each to a real note when first touched.
> - [ ] **API-Bidding-Endpoints.md** — full list of bidding provider endpoints used by poller (list, detail, accept). Cite `src/services/api-client.ts` + `.env` keys (`API_URL`, `COOKIE`, `DEVICE_ID`).
> - [ ] **API-Bidding-Auth.md** — auth model (cookie + device ID + retcode-based session detection).
> - [ ] **API-Internal-HTTP.md** — Fastify routes under `/api/*`, auth (JWT cookie + RBAC), rate limits.
> - [ ] **API-SSE-Events.md** — `/events` SSE stream payload shapes (rules update, metrics).
> - [ ] **API-Settings-Controller.md** — `.env` editor endpoint behavior + `process.exit(0)` restart contract.

## Conventions for API Doc Notes

Each note in this folder SHOULD be `type: reference` and include:

```yaml
---
title: API — <Endpoint or Topic>
type: reference
status: active
last-verified: YYYY-MM-DD
verified-by: <agent or human>
source: file:src/services/<path>.ts
confidence: high | medium | low
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [reference, area/api, project/spx, topic/<subtopic>]
---
```

Body sections:
1. **Endpoint** — method + URL pattern
2. **Inputs** — headers, env vars, request body shape
3. **Outputs** — success shape + known error retcodes
4. **Retry/error semantics** — link to retry code in `api-client.ts`
5. **Related** — runbook, ADR, mistake links

## Related

- [[AGENTS]] § Retrieval Protocol — when to read API docs
- [[Runbook-API-Session-Expired]]
- [[ADR-001-Dual-Storage-Notify-Rules]]
- Code: `src/services/api-client.ts`, `src/services/http-server.ts`
