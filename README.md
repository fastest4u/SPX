# SPX Bidding Poller

ระบบ polling อัตโนมัติสำหรับดึง `Agency Booking Bidding List` จาก SPX พร้อม Web Dashboard สำหรับจัดการ rules, auto-accept, users, settings, history และ notifications

## ภาพรวม

- **Polling**: ดึง bidding list ตามรอบเวลา, ตรวจสอบ変化, ดึง request details, บันทึก DB, auto-accept, แจ้งเตือน
- **Dashboard**: React SPA + Fastify API, JWT auth, SSE real-time, admin/user RBAC

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ |
| Backend | Fastify + TypeScript |
| Database | MySQL (Drizzle ORM + mysql2), SQLite (memory mode) |
| Auth | @fastify/jwt, @fastify/cookie |
| Frontend | React 18 + TanStack Router + TanStack Query + Tailwind CSS |
| Build | esbuild + Vite |
| Deploy | Docker Compose, auto-deploy via git push |

## ฟีเจอร์

- **Real-time polling** — configurable interval
- **Notify rules** — dual storage (DB in production, JSON file in dev)
- **Auto-accept** — รับงานอัตโนมัติตาม rule + แจ้งเตือน + บันทึกประวัติ
- **Auto-accept history** — ตาราง `auto_accept_history` ดูย้อนหลังผ่าน Web UI
- **SSE real-time** — push metrics + rules ไป browser แบบリアルタイム
- **Web dashboard** — React SPA, JWT cookie auth, admin/user RBAC, rate limiting
- **Security** — security headers, CORS, rate limit, password strength
- **Graceful shutdown** — Fastify `onClose` hook, clean DB pool close
- **DB tools** — migration, generate, reset, smoke test

## โครงสร้าง

```
src/
├── app.ts                    # entrypoint
├── config/env.ts             # .env loader + validator
├── controllers/              # Fastify route handlers
│   ├── poller.ts             # polling loop + SSE broadcast
│   ├── rules-controller.ts   # notify rules CRUD
│   ├── auto-accept-history-controller.ts
│   ├── auth-controller.ts, users-controller.ts, settings-controller.ts
│   ├── dashboard-controller.ts, history-controller.ts
│   ├── audit-controller.ts, report-controller.ts, bidding-controller.ts
├── services/
│   ├── http-server.ts        # Fastify setup, CORS, rate limit, RBAC, onClose
│   ├── api-client.ts         # SPX API client, retry, multi-page fetch
│   ├── db-service.ts         # booking INSERT IGNORE
│   ├── notify-rules.ts       # dual-mode rule engine (DB/file)
│   ├── notifier.ts           # Discord/LINE notification, auto-accept flow
│   ├── metrics.ts            # polling metrics collector
│   ├── sse.ts                # SSE broadcaster singleton
│   ├── notify-controller.ts  # notification preview API
├── db/
│   ├── schema.ts             # Drizzle schema (MySQL)
│   ├── client.ts             # MySQL pool + Drizzle + runtime table creation
│   ├── client-memory.ts      # SQLite in-memory mirror
│   ├── migration-sql.ts      # SQL statement exports
├── repositories/
│   ├── booking-history-repository.ts, audit-repository.ts
│   ├── user-repository.ts, metrics-repository.ts
│   ├── auto-accept-repository.ts
├── frontend/
│   ├── main.tsx              # React entry
│   ├── routes/               # TanStack Router pages
│   ├── components/           # shared UI components + layout
│   ├── hooks/                # useAuth, useSse
│   ├── lib/                  # API client, utils
│   ├── types/                # TypeScript types
├── scripts/                  # db-migrate, db-reset, db-test, smoke-test
migrations/                   # SQL migration files
```

## การติดตั้ง

```bash
npm install
cp .env.example .env   # แก้ค่าให้ตรงกับ environment
```

## คำสั่ง

```bash
npm run dev -- 10     # run via ts-node (polling interval 10s)
npm run build          # typecheck + esbuild + vite
npm start -- 10        # run dist/app.js
npm run db:generate    # generate migration SQL
npm run db:migrate     # apply migrations
npm run db:test        # integration test
npm run flow:start     # migrate + build + start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_URL` | yes | — | Bidding list endpoint |
| `COOKIE` | yes | — | SPX session cookie |
| `DEVICE_ID` | yes | — | SPX device ID |
| `APP_NAME` | yes | — | SPX app name |
| `REFERER` | yes | — | SPX referer URL |
| `POLL_INTERVAL_MS` | no | 30000 | Polling interval in ms |
| `NODE_ENV` | no | development | `production` activates DB rule storage |
| `SAVE_TO_DB` | no | false | Save bookings to MySQL |
| `FETCH_DETAILS` | no | false | Fetch request details per booking |
| `HTTP_ENABLED` | no | false | Start Web UI + API |
| `HTTP_PORT` | no | 3000 | Web server port |
| `HTTP_ALLOWED_ORIGINS` | no | — | Extra CORS origins |
| `JWT_SECRET` | yes* | — | JWT signing secret (≥32 chars) |
| `COOKIE_SECRET` | yes* | — | Cookie signing secret (≥32 chars) |
| `ADMIN_USERNAME` | yes* | admin | Default admin username |
| `ADMIN_PASSWORD` | yes* | — | Default admin password (≥12 chars) |
| `ADMIN_ROLE` | no | admin | `admin` or `user` |
| `DB_HOST` | yes* | — | MySQL host |
| `DB_PORT` | no | 3306 | MySQL port |
| `DB_USERNAME` | yes* | — | MySQL user |
| `DB_PASSWORD` | yes* | — | MySQL password |
| `DB_NAME` | yes* | — | MySQL database |
| `DB_MODE` | no | mysql | `mysql` or `memory` (SQLite) |
| `NOTIFY_ENABLED` | no | false | Enable Discord/LINE notifications |
| `NOTIFY_MODE` | no | batch | `batch` or `each` |
| `LINE_NOTIFY_TOKEN` | no | — | LINE Notify token |
| `DISCORD_WEBHOOK_URL` | no | — | Discord webhook URL |
| `AUTO_ACCEPT_ENABLED` | no | false | Auto-accept matching requests |
| `BIDDING_PAGE_NO` | no | 1 | API page start |
| `BIDDING_PAGE_COUNT` | no | 100 | Items per page |
| `REQUEST_CTIME_START` | no | 1776358800 | Unix timestamp filter |

\* Required when `HTTP_ENABLED=true`, `SAVE_TO_DB=true`, or `AUTO_ACCEPT_ENABLED=true`

## Docker

```bash
docker compose up --build
```

- Container runs `db-migrate.js` before `app.js`
- Health check: `GET /ready` every 30s
- `notify-rules.json` created at build time, mounted as volume
- Production server: `root@45.83.207.139`, auto-deploy via git push

## Web Dashboard

```
http://localhost:3000
```

| หน้า | Path | Access |
|------|------|--------|
| Dashboard | `/` | user+ |
| ประวัติงาน | `/history` | user+ |
| แจ้งเตือน | `/notifications` | user+ |
| รายงาน | `/reports` | user+ |
| ประวัติการใช้งาน | `/audit` | admin |
| ประวัติรับงานอัตโนมัติ | `/auto-accept-history` | admin |
| จัดการผู้ใช้ | `/users` | admin |
| ตั้งค่า | `/settings` | admin |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | no | Health check |
| GET | `/ready` | no | Readiness (DB pool check) |
| GET | `/metrics` | no | Polling metrics snapshot |
| GET | `/events` | JWT | SSE stream (rules + metrics) |
| POST | `/api/login` | no | Login |
| POST | `/api/logout` | JWT | Logout |
| POST | `/api/refresh` | JWT | Refresh token |
| GET | `/api/me` | JWT | Current user |
| GET/POST | `/api/rules` | user+ | Rules CRUD |
| PUT/DELETE | `/api/rules/:id` | user+ | Rule update/delete |
| GET | `/api/history` | user+ | Booking history |
| GET | `/api/notifications/*` | user+ | Notification preview/test |
| GET | `/api/bidding/*` | user+ | Bidding list |
| GET | `/api/reports/*` | user+ | Reports |
| GET | `/api/audit-logs` | admin | Audit trail |
| GET | `/api/auto-accept-history` | admin | Auto-accept history |
| GET/POST | `/api/users` | admin | User management |
| PUT | `/api/users/:id/*` | admin | Update user |
| GET/PUT | `/api/settings` | admin | Env settings |
