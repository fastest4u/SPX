# SPX Bidding Poller

ระบบ polling อัตโนมัติสำหรับดึง `Agency Booking Bidding List` จาก SPX พร้อม Web Dashboard สำหรับจัดการ teams, rules, auto-accept, users, settings, history และ notifications

## ภาพรวม

- **Polling**: ดึง bidding list ตามรอบเวลา, ตรวจสอบ変化, ดึง request details, บันทึก DB, auto-accept, แจ้งเตือน
- **Split runtime**: production legacy แยกเป็น `notifier`, `worker-ifn`, และ `worker-ptwl`; target topology แยกต่อเป็น `web-api`, `notification-service`, `line-service`, `ocr-service`, และ workers
- **DB-first config**: `.env` เหลือ bootstrap/process identity; runtime settings และ team credentials อยู่ใน MySQL (`app_settings` + `teams`) และแก้ผ่าน Dashboard
- **Dashboard**: React SPA + Fastify API, JWT auth, SSE real-time, admin/user RBAC

## Tech Stack

| Layer    | Technology                                                 |
| -------- | ---------------------------------------------------------- |
| Runtime  | Node.js >=24.16.0                                          |
| Backend  | Fastify + TypeScript                                       |
| Database | MySQL (Drizzle ORM + mysql2), SQLite (memory mode)         |
| Auth     | @fastify/jwt, @fastify/cookie                              |
| Frontend | React 19 + TanStack Router + TanStack Query + Tailwind CSS |
| Build    | esbuild + Vite                                             |
| Deploy   | Docker Compose, auto-deploy via git push                   |

## ฟีเจอร์

- **Real-time polling** — configurable interval
- **Notify rules** — dual storage (DB in production, JSON file in dev)
- **Auto-accept** — รับงานอัตโนมัติตาม rule + แจ้งเตือน + บันทึกประวัติ
- **Auto-accept history** — ตาราง `auto_accept_history` ดูย้อนหลังผ่าน Web UI
- **SSE real-time** — push metrics + rules ไป browser แบบリアルタイム
- **Runtime telemetry bridge** — worker metrics ถูกส่งเข้า notifier เพื่อให้ admin/all-team dashboard เห็นค่าจาก worker process จริง
- **Web dashboard** — React SPA, JWT cookie auth, admin/user RBAC, team-scoped users, rate limiting
- **DB-first settings** — Settings UI และ Teams UI เป็น source of truth หลัง production seed สำเร็จ
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
│   ├── notifier.ts           # LINE/Discord notification, auto-accept flow
│   ├── notification-client.ts # worker-to-notifier internal notification publisher
│   ├── runtime-metrics*.ts   # worker runtime metrics bridge for dashboard/SSE
│   ├── team-runtime*.ts      # per-team worker runtime, leases, desired-state actions
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
npm ci
cp .env.example .env   # แก้ค่าให้ตรงกับ environment
```

## คำสั่ง

```bash
npm run dev            # backend (tsx, HTTP_ENABLED) + frontend (vite) via concurrently
npm run typecheck      # backend + frontend TypeScript checks
npm run lint           # ESLint, max warnings 0
npm run build          # typecheck + esbuild + vite
npm start -- 10        # run dist/app.js (polling interval 10s)
npm test               # run test suite (node --test via tsx)
npm run db:generate    # generate migration SQL
npm run db:migrate     # apply migrations
npm run db:test        # integration test (live MySQL)
npm run schema:verify  # read-only MySQL schema drift check
npm run verify         # production build gate
npm run flow:start     # migrate + build + start
```

## Configuration Model

Production is DB-first. `.env` is not the long-term source of truth for SPX credentials, polling, auto-accept, notification, or dashboard settings.

| Scope                     | Source of Truth           | Examples                                                                                                                 |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Bootstrap                 | `.env`                    | `NODE_ENV`, `DB_MODE`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`, `SECRETS_KEY`                      |
| Process identity          | Docker/service env        | `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_PORT` |
| Runtime/operator settings | MySQL `app_settings`      | `API_URL`, polling flags, auto-accept flags, notification settings, dashboard auth secrets, provider settings            |
| Team secrets/targets      | encrypted `teams` columns | SPX cookie/device credentials, default LINE target, auto-accept success/failure LINE targets                             |

First DB-first rollout should deploy once with the legacy `.env` still present so startup can seed missing DB rows. After `/ready`, worker healthchecks, schema verification, and Settings/Teams values are verified, production `.env` can be reduced to bootstrap-only values.

## Docker

```bash
docker compose up --build
```

- Default legacy compose keeps `notifier` owning HTTP/dashboard, central LINE delivery, internal notification API, runtime-metrics aggregation, and the single migration run.
- `worker-ifn` runs `RUN_TEAM_IDS=2`; `worker-ptwl` runs `RUN_TEAM_IDS=1`.
- Legacy workers publish notification events to `http://notifier:3000/internal/notification-events` and runtime snapshots to `/internal/runtime-metrics`.
- Optional split-service compose is available with `web-api`, `notification-service`, `line-service`, `ocr-service`, `worker-ifn-split`, and `worker-ptwl-split`; in that mode workers publish to `http://notification-service:3002/internal/notification-events`.
- Only `web-api`/legacy `notifier` should be published publicly. `notification-service`, `line-service`, and `ocr-service` stay on Docker's internal network by default.
- Every process needs a unique `SPX_NODE_ID`; keep `RUN_TEAM_IDS` explicit and non-overlapping unless deliberately testing failover.
- The shared runtime image documents split-service HTTP ports `3000`, `3002`, `3003`, and `3004`; Compose still controls which ports are published or internal.
- Health checks: HTTP services use `GET /ready` on their configured `HTTP_PORT`; workers check the Node process.
- Fault-injection probe: `npm run service:fault-check` checks split-service `/health` and `/ready` without sending notifications or printing secrets. Run it from the host for public `web-api`, or from inside the Docker network with `docker compose --profile split exec -T web-api ...` to reach internal split services.
- Production deploy: GitHub Actions (`.github/workflows/deploy.yml`) over SSH on push to `main`, with build → deploy/restart → readiness gate → rollback.

## Web Dashboard

```
http://localhost:3000
```

| หน้า                   | Path                   | Access |
| ---------------------- | ---------------------- | ------ |
| Dashboard              | `/`                    | user+  |
| ประวัติงาน             | `/history`             | user+  |
| แจ้งเตือน              | `/notifications`       | user+  |
| รายงาน                 | `/reports`             | user+  |
| ประวัติการใช้งาน       | `/audit`               | admin  |
| ประวัติรับงานอัตโนมัติ | `/auto-accept-history` | admin  |
| ทีม                    | `/teams`               | admin  |
| จัดการผู้ใช้           | `/users`               | admin  |
| ตั้งค่า                | `/settings`            | admin  |

Admin users can view all teams. Non-admin users are scoped to their own `teamId` for history, rules, metrics, and SSE updates.

## API Endpoints

| Method     | Path                       | Auth  | Description                               |
| ---------- | -------------------------- | ----- | ----------------------------------------- |
| GET        | `/health`                  | no    | Health check                              |
| GET        | `/ready`                   | no    | Readiness for the current service surface |
| GET        | `/metrics`                 | JWT   | Polling/runtime metrics snapshot          |
| GET        | `/events`                  | JWT   | SSE stream (rules + metrics)              |
| POST       | `/api/login`               | no    | Login                                     |
| POST       | `/api/logout`              | JWT   | Logout                                    |
| POST       | `/api/refresh`             | JWT   | Refresh token                             |
| GET        | `/api/me`                  | JWT   | Current user                              |
| GET/POST   | `/api/rules`               | user+ | Rules CRUD                                |
| PUT/DELETE | `/api/rules/:id`           | user+ | Rule update/delete                        |
| GET        | `/api/history`             | user+ | Booking history                           |
| GET        | `/api/notifications/*`     | user+ | Notification preview/test                 |
| GET        | `/api/bidding/*`           | user+ | Bidding list                              |
| GET        | `/api/reports/*`           | user+ | Reports                                   |
| GET        | `/api/audit-logs`          | admin | Audit trail                               |
| GET        | `/api/auto-accept-history` | admin | Auto-accept history                       |
| GET/POST   | `/api/teams`               | admin | Team runtime/config management            |
| GET/POST   | `/api/users`               | admin | User management                           |
| PUT        | `/api/users/:id/*`         | admin | Update user                               |
| GET/PUT    | `/api/settings`            | admin | DB-first runtime settings                 |

Split-service internal endpoints are only registered on their matching internal surfaces:

| Service                | Method | Path                            | Purpose                                     |
| ---------------------- | ------ | ------------------------------- | ------------------------------------------- |
| `notification-service` | POST   | `/internal/notification-events` | Worker notification event intake            |
| `notification-service` | POST   | `/internal/runtime-metrics`     | Worker runtime metrics intake               |
| `line-service`         | POST   | `/internal/line/messages`       | Notification-service or authenticated web API LINEJS send command |
| `line-service`         | POST   | `/internal/line/status`         | Signed LINEJS status read                   |
| `line-service`         | POST   | `/internal/line/login`          | Signed QR login request                     |
| `line-service`         | POST   | `/internal/line/groups`         | Signed group list read                      |
| `line-service`         | POST   | `/internal/line/profile`        | Signed LINE profile read                    |
| `line-service`         | POST   | `/internal/line/storage`        | Signed LINE storage health read             |
| `line-service`         | POST   | `/internal/line/logout`         | Signed LINE logout command                  |
| `ocr-service`          | POST   | `/internal/ocr/line-image`      | Line-service image OCR request              |

These internal endpoints require signed service-auth headers and should stay on the Docker/private network.

When `LINE_SERVICE_URL` is set on the web API/legacy notifier, authenticated `/api/line-bot/*` routes proxy to the split `line-service`; `/api/line-bot/send` signs with `LINE_SERVICE_SEND_SECRET` and admin/status routes sign with `LINE_SERVICE_ADMIN_SECRET`. Legacy local LINEJS fallback is used only when `LINE_SERVICE_URL` is unset.
