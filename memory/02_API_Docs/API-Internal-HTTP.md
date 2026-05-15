---
title: API - Internal HTTP Dashboard Routes
type: reference
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:src/services/http-server.ts + file:src/controllers/*.ts + file:src/frontend/lib/api.ts
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Internal HTTP API
  - Dashboard API
  - Fastify API
tags:
  - reference
  - project/spx
  - area/api
  - area/auth
  - topic/http
---

# API - Internal HTTP Dashboard Routes

> [!abstract] Scope
> Source-grounded map of the Fastify routes used by the SPX React dashboard. These routes are internal to this app, not the upstream SPX bidding provider.

---

## Server Setup

Source: `src/services/http-server.ts`

- Fastify with CORS, signed cookies, JWT, form body parsing, static files, security headers, and rate limiting.
- JWT auth is cookie-based through signed `token` cookie.
- Static SPA is served from `dist/` with a non-API catch-all.
- `onClose` closes the DB pool.

Required when `HTTP_ENABLED=true`:

- `JWT_SECRET` length >= 32
- `COOKIE_SECRET` length >= 32
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD` length >= 12
- `ADMIN_ROLE` as `admin` or `user`

---

## Auth Routes

Registered under `/api`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/login` | public | Verify username/password, set signed JWT cookie. |
| `POST` | `/api/logout` | optional cookie | Clear cookie and audit logout if token is valid. |
| `POST` | `/api/refresh` | cookie | Issue a fresh 1-day JWT. |
| `GET` | `/api/me` | cookie | Return current user id, username, role. |

Source: `src/controllers/auth-controller.ts`

---

## Public Dashboard Routes

These are registered outside the `/api` authenticated scope. Some still verify JWT inside the handler.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health summary from metrics and session status. |
| `GET` | `/ready` | DB connectivity, pool saturation, and session readiness. |
| `GET` | `/metrics` | Current metrics snapshot. |
| `GET` | `/events` | JWT-authenticated SSE stream. |
| `GET` | `/metrics/history?limit=N` | Recent persisted metrics snapshots. |
| `GET` | `/line-quota` | LINE OA quota summary. |
| `POST` | `/system/pause` | JWT-authenticated pause poller. |
| `POST` | `/system/resume` | JWT-authenticated resume poller. |

Source: `src/controllers/dashboard-controller.ts`

See [[API-SSE-Events]] for `/events`.

---

## User Role API Scope

Authenticated `/api/*` routes with minimum role `user`.

### Rules

Prefix: `/api/rules`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/rules` | List notify/auto-accept rules. |
| `POST` | `/api/rules` | Create a rule. |
| `GET` | `/api/rules/:id` | Read one rule. |
| `PUT` | `/api/rules/:id` | Replace/update allowed rule fields. |
| `DELETE` | `/api/rules/:id` | Delete a rule. |

Body fields: `name`, `origins`, `destinations`, `vehicle_types`, `need`, `enabled`, `fulfilled`, `auto_accept`, `auto_accepted`.
`auto_accept` remains accepted for compatibility; current source treats enabled rules as auto-accept candidates and no longer supports rule-match-only job notifications.

Source: `src/controllers/rules-controller.ts`

### Notifications

Prefix: `/api/notifications`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/notifications/preview` | Build notification preview. |
| `POST` | `/api/notifications/test` | Send test notifications through configured channels. |

Source: `src/services/notify-controller.ts` and frontend client `src/frontend/lib/api.ts`.

### Bidding

Prefix: `/api/bidding`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/bidding/accept` | Manually accept request IDs for a booking. |

Body:

```json
{
  "bookingId": 123,
  "requestIds": [456],
  "confirm": true
}
```

Source: `src/controllers/bidding-controller.ts`

### LINE Bot

Prefix: `/api/line-bot`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/line-bot/status` | Current LINEJS auth state. |
| `POST` | `/api/line-bot/login` | Start QR login. |
| `POST` | `/api/line-bot/send` | Send message to user/group. |
| `GET` | `/api/line-bot/groups` | Fetch group chats. |
| `GET` | `/api/line-bot/profile` | Fetch authenticated profile. |
| `GET` | `/api/line-bot/storage` | Inspect auth/E2EE storage health. |
| `POST` | `/api/line-bot/logout` | Logout and optionally clear storage. |

Source: `src/controllers/line-bot-controller.ts`

### History and Reports

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/history` | List booking history rows with filters. |
| `GET` | `/api/history/paginated` | Paginated booking history. |
| `GET` | `/api/reports/metrics.csv` | Download metrics CSV. |
| `GET` | `/api/reports/history.csv` | Download history CSV. |
| `GET` | `/api/reports/audit.csv` | Download audit CSV. |

Sources: `src/controllers/history-controller.ts`, `src/controllers/report-controller.ts`

---

## Admin Role API Scope

Authenticated `/api/*` routes with minimum role `admin`.

| Prefix | Routes | Purpose |
|---|---|---|
| `/api/users` | `GET`, `POST`, `PUT /:id/password`, `PUT /:id/role`, `DELETE /:id` | Manage dashboard users. |
| `/api/settings` | `GET`, `POST` | Read/write DB-backed runtime settings. |
| `/api/audit-logs` | `GET`, `GET /paginated` | Read audit logs. |
| `/api/auto-accept-history` | `GET`, `GET /paginated` | Read auto-accept attempts. |

Sources:

- `src/controllers/users-controller.ts`
- `src/controllers/settings-controller.ts`
- `src/controllers/audit-controller.ts`
- `src/controllers/auto-accept-history-controller.ts`

---

## Response Envelope

Backend utilities in `src/utils/response.ts` use a standard shape:

```json
{
  "status": "success",
  "message": "optional",
  "data": {}
}
```

Paginated responses add `meta` with current page, per-page count, total items, and total pages.

Errors use:

```json
{
  "status": "error",
  "error_code": "CODE",
  "message": "Human readable",
  "details": {}
}
```

Frontend global handling redirects to `/login` on `401` for non-auth endpoints.

---

## Rate Limits

Source: `src/services/http-server.ts`

- `/api/login` has a stricter auth rate limit.
- Authenticated `/api/*` routes use an in-memory IP bucket.
- User/admin scopes add additional per-scope request limits.

Because limits are in memory, they reset on process restart and are not shared across replicas.

---

## Security Notes

- JWT is stored in a signed HTTP-only cookie named `token`.
- `secure` cookie flag is enabled in production.
- Settings API redacts secret values and preserves masked inputs.
- Audit logs are written for login/logout, rule changes, settings changes, user changes, manual accept, and pause/resume actions.

---

## Related

- [[SPX-System-Map]]
- [[API-SSE-Events]]
- [[SPX-Project-Rules]]
- [[Runbook-Production-Deploy]]
