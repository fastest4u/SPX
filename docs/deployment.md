---
title: Deployment
tags:
  - obsidian
  - spx
  - deployment
  - docker
aliases:
  - การ Deploy
  - Production Setup
---

# Deployment

## Local Run

```bash
npm install
npm run build       # backend (esbuild) + frontend (vite) → dist/
npm start -- 10     # start with 10s interval
```

> [!note] Frontend Build
> `npm run build` จะสร้างทั้ง backend (`dist/app.js`) และ frontend (`dist/public/index.html` + assets)
> Backend จะ serve SPA จาก `dist/public/` โดยอัตโนมัติเมื่อ `HTTP_ENABLED=true`

> [!important] Database Migrations
> ถ้า `HTTP_ENABLED=true` หรือ `SAVE_TO_DB=true` ต้อง run migration ก่อน startup:
> ```bash
> npm run db:migrate
> ```
> แต่ระบบมี runtime `CREATE TABLE IF NOT EXISTS` เป็น safety net อยู่แล้ว

## Development Mode

```bash
# Backend only (ts-node)
npm run dev:backend -- 10

# Frontend only (Vite dev server with proxy)
npm run dev:frontend

# Both backend + frontend (concurrently)
npm run dev
```

## Smoke Test

```bash
npm run smoke:test
```

> [!note] ต้อง start app ก่อน
> Smoke test ต้องการ app ที่ทำงานอยู่บน `http://127.0.0.1:3000`
> ตรวจ `/ready` และ static assets

## Docker

```bash
docker compose up --build
```

### Docker Image Details
- ==Multi-stage build== — runtime image มีแค่ built output
- Healthcheck ยิง `GET /ready` อัตโนมัติ
- Base image: `node:24-alpine`

### Production Services

Production compose runs one shared image as three services:

| Service | Role | Responsibility |
|---------|------|----------------|
| `notifier` | `SPX_ROLE=notifier` | HTTP/dashboard, migrations, internal notification API, central LINE delivery, runtime metrics aggregation |
| `worker-ifn` | `SPX_ROLE=worker`, `RUN_TEAM_IDS=2` | IFN polling/auto-accept worker |
| `worker-ptwl` | `SPX_ROLE=worker`, `RUN_TEAM_IDS=1` | PTWL polling/auto-accept worker |

Workers call the notifier over Docker networking. Notification events use `/internal/notification-events`; runtime telemetry uses `/internal/runtime-metrics`.

## DB-first config

Production loads config from MySQL `app_settings` after reading bootstrap env. `.env` should contain only bootstrap values such as `NODE_ENV`, `DB_MODE`, database connection fields, and `SECRETS_KEY`. Docker/service environment should keep process identity values such as `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, and `HTTP_PORT`.

Use the dashboard Settings and Teams pages to change SPX API, polling, auto-accept, notification, auth signing secrets, provider settings, and team credentials. Before reducing `.env`, deploy the DB-first build once with the existing `.env` so startup can seed missing `app_settings` rows. Verify `/ready`, worker healthchecks, and Settings page values. After that verification, remove runtime/operator values from `.env`.

Current production has completed that rollout: `.env` should stay bootstrap-only, runtime/operator settings should come from `app_settings`, and team credentials/LINE targets should come from encrypted `teams` fields.

## Post-Deploy Verification

Use read-only checks and avoid printing secret values:

```bash
git rev-parse --short HEAD
docker compose ps
curl -s http://127.0.0.1:3000/ready
docker compose logs --since=5m notifier | grep -c 'POST /internal/runtime-metrics 200'
docker compose logs --since=5m worker-ifn worker-ptwl | grep -c 'runtime-metrics-publish-failed\|runtime-metrics-url-invalid'
npm run schema:verify
```

Expected runtime state:
- `notifier`, `worker-ifn`, and `worker-ptwl` are running and healthy.
- `/ready` returns HTTP 200 with `ready: true`.
- `POST /internal/runtime-metrics 200` appears frequently in notifier logs.
- Worker logs have zero runtime-metrics publish/url failures.
- Admin Pipeline telemetry should update after the next worker metrics publish cycle; hard-refresh the dashboard if the browser still has stale UI state.

## Production Checklist

> [!warning] สิ่งที่ต้องทำก่อน deploy production

- [ ] ตั้งค่า `.env` เฉพาะ bootstrap values และตั้ง process identity values ใน Docker/service environment (ดู [[env-reference]])
- [ ] ใช้ process manager (PM2, systemd, Docker restart policy)
- [ ] Run `npm run db:migrate` ก่อน startup
- [ ] ตั้ง `HTTP_ALLOWED_ORIGINS` ผ่าน Settings สำหรับ non-localhost domain
- [ ] ตั้ง `NODE_ENV=production` สำหรับ secure cookies
- [ ] Runtime/operator secrets ต้องอยู่ใน `app_settings` หรือ team encrypted fields หลัง seed สำเร็จ
- [ ] Monitor `/health`, `/ready`, `/metrics` ผ่าน Uptime Kuma หรือ Datadog
- [ ] Verify notifier receives worker runtime metrics (`POST /internal/runtime-metrics 200`) after deploy
- [ ] `notify-rules.json` ต้องมี controlled write access เฉพาะ local/dev fallback; production rules อยู่ใน DB
- [ ] ตรวจว่า `npm run build` ผ่านก่อน release (includes typecheck + frontend build)
- [ ] ตรวจว่า `dist/public/` มี `index.html` และ assets ครบ

## Process Manager

> [!tip] Settings reload behavior
> Settings API เขียน DB แล้ว sync กลับเข้า process env ตาม metadata ของแต่ละ key: บางค่าเป็น live reload, บางค่าต้อง restart worker, และ security/auth/runtime binding เช่น `JWT_SECRET`, `COOKIE_SECRET`, `NOTIFIER_SHARED_SECRET`, `NOTIFIER_AUTH_MODE`, `HTTP_ENABLED`, และ `HTTP_ALLOWED_ORIGINS` ต้อง restart process.
> การใช้ process manager (Docker, PM2, systemd) ยังแนะนำสำหรับ crash recovery, restart orchestration, และ availability ทั่วไป

## Frontend Build Output

```
dist/
├── app.js              # Backend bundle
├── scripts/            # CLI scripts
└── public/             # SPA static files
    ├── index.html      # React SPA entry
    └── assets/         # JS/CSS chunks (hashed)
        ├── index-xxx.js
        └── index-xxx.css
```

Backend serve ไฟล์เหล่านี้ผ่าน `@fastify/static` + catch-all route สำหรับ client-side routing

## ดูเพิ่มเติม
- [[env-reference]] — ตัวแปร environment ทั้งหมด
- [[production-cautions]] — ข้อควรระวังใน production
- [[cheatsheet]] — คำสั่ง npm ที่ใช้บ่อย
- [[architecture]] — โครงสร้างระบบ
