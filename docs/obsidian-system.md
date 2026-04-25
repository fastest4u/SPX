---
tags:
  - obsidian
  - spx
  - documentation
  - system-design
---

# SPX System Notes

## One-line summary
`SPX Bidding Poller` คือระบบ polling แบบอัตโนมัติสำหรับดึง bidding list จาก SPX, บันทึกลง MySQL, ส่ง notification ตาม rules, และมี web dashboard สำหรับจัดการระบบ

## Current architecture

### 1) Polling worker
- Entry point: `src/app.ts`
- Main orchestrator: `src/controllers/poller.ts`
- Responsibilities:
  - validate runtime env
  - start polling loop
  - call SPX API
  - detect data changes
  - fetch booking request details when enabled
  - save to DB when enabled
  - send notifications when enabled
  - record metrics
  - handle graceful shutdown

### 2) Web dashboard
- HTTP server: `src/services/http-server.ts`
- Dashboard controller: `src/controllers/dashboard-controller.ts`
- Login controller: `src/controllers/auth-controller.ts`
- Static assets:
  - HTML template: `src/views/dashboard.ts`
  - JS bundle-like static file: `src/public/dashboard.js`
- Serves:
  - `/health`
  - `/ready`
  - `/metrics`
  - `/assets/*`
  - `/api/*`

### 3) Database layer
- MySQL client: `src/db/client.ts`
- Repositories:
  - `src/repositories/user-repository.ts`
  - `src/repositories/booking-history-repository.ts`
  - `src/repositories/audit-repository.ts`
- Storage style:
  - Drizzle ORM + `mysql2`
  - runtime table creation for `spx_booking_history`
  - runtime table creation/repair for dashboard tables `users` and `audit_logs`
  - `request_id` is unique for booking history records
  - DB env is required when `SAVE_TO_DB=true` or `HTTP_ENABLED=true`

### 4) Notifications
- Rules engine: `src/services/notify-rules.ts`
- Notification orchestrator: `src/services/notifier.ts`
- Notification API controller: `src/services/notify-controller.ts`
- Rules file:
  - `notify-rules.json`
- Behaviour:
  - rules are matched against trips
  - extracted trip fields support both English aliases and Thai field names
  - matching rules can be auto-marked fulfilled
  - Discord webhook and LINE Notify are sent through real HTTP requests
  - `NOTIFY_MODE=batch` sends one grouped message; `NOTIFY_MODE=each` sends one message per matched rule
  - rules are marked fulfilled only after at least one notification channel succeeds

### 5) Observability
- Metrics collector: `src/services/metrics.ts`
- Logger: `src/utils/logger.ts`
- Exposed via dashboard and `/metrics`
- `/ready` checks MySQL and returns HTTP 503 when DB is unavailable

### 6) Access control
- Auth: cookie-based JWT via `@fastify/jwt` and signed cookies
- Roles: `viewer`, `editor`, `admin`
- Viewer: authenticated read access to history and reports
- Public monitoring endpoints: `/health`, `/ready`, `/metrics`
- Editor: manage rules and notification test endpoints
- Admin: manage users, settings, and audit logs

## Runtime flow

1. `src/app.ts` reads CLI interval and validates env
2. `Poller.start()` begins worker loop
3. Each tick:
   - fetch bidding list
   - detect change status
   - optionally fetch booking request list per booking
   - optionally save trips to MySQL
   - optionally match notification rules and send Discord/LINE notifications
4. HTTP dashboard is available when `HTTP_ENABLED=true`
5. SIGINT/SIGTERM triggers graceful shutdown

## Production hardening already in place
- Security headers
- Rate limiting with expired bucket cleanup
- Cookie-based JWT auth for dashboard
- Role-based authorization for sensitive API groups
- `/health` and `/ready` endpoints
- DB-backed readiness check
- Configurable CORS allowlist via `HTTP_ALLOWED_ORIGINS`
- Dockerfile with healthcheck
- docker-compose support
- Static asset serving from `dist/public`
- Smoke test script
- Graceful shutdown for worker and HTTP server
- Atomic writes for `.env` and `notify-rules.json`

## Important env vars

### Required base vars
- `API_URL`
- `COOKIE`
- `DEVICE_ID`
- `APP_NAME`
- `REFERER`

### Worker controls
- `POLL_INTERVAL_MS`
- `FETCH_DETAILS`
- `SAVE_TO_DB`
- `NOTIFY_ENABLED`
- `NOTIFY_MODE`

### DB
- `DB_HOST`
- `DB_PORT`
- `DB_USERNAME`
- `DB_PASSWORD`
- `DB_NAME`
- Required when `SAVE_TO_DB=true` or `HTTP_ENABLED=true`

### Dashboard auth
- `HTTP_ENABLED`
- `HTTP_PORT`
- `HTTP_ALLOWED_ORIGINS`
- `JWT_SECRET`
- `COOKIE_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_ROLE`

## Commands

```bash
npm run build
npm start
npm run smoke:test
npm run db:migrate
npm run db:test
npm run flow:start
```

## Deployment notes
- `Dockerfile` uses multi-stage build and healthcheck against `/ready`
- `docker-compose.yml` is available for local production-like runs
- `src/public/dashboard.js` must be copied into `dist/public/` during build
- `smoke:test` expects the app to already be listening on `http://127.0.0.1:3000`
- Run `npm run db:migrate` before production startup; runtime `CREATE TABLE IF NOT EXISTS` is a safety net, not the migration source of truth
- Set `HTTP_ALLOWED_ORIGINS` for non-localhost browser clients, using comma-separated full origins such as `https://ops.example.com`

## Key cautions
- Do not treat `notify-rules.json` as multi-writer safe if multiple app instances write it at the same time
- `rate limit` is in-memory only and resets on restart
- `settings` UI writes `.env` and exits the process, so a process manager is required for auto-restart
- Dashboard requires MySQL even when `SAVE_TO_DB=false`, because users and audit logs live in DB
- Keep `.env` secrets out of notes and commits
