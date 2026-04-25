---
title: SPX Cheat Sheet
tags:
  - obsidian
  - spx
  - cheat-sheet
  - commands
aliases:
  - คำสั่งที่ใช้บ่อย
  - Quick Reference
---

# SPX Cheat Sheet

## 🚀 Quick Start

```bash
npm ci                # install locked dependencies
npm run build         # typecheck + bundle (dist/app.js)
npm start -- 10       # start with 10s poll interval
```

## 🛠️ Development

```bash
npm run dev -- 10     # ts-node dev mode (10s interval)
npm run build         # verify: tsc --noEmit + esbuild
```

## 🗄️ Database

```bash
npm run db:generate   # regenerate migration SQL from schema
npm run db:migrate    # apply migrations to MySQL
npm run db:test       # live API + DB integration test
npm run flow:test     # db:migrate + db:test
npm run flow:start    # db:migrate + build + start
```

> [!warning] Integration tests ต้องการ
> `db:test` และ `flow:test` ต้องการ real API auth, network, และ MySQL
> สามารถ INSERT rows ลง `spx_booking_history` ได้จริง

## 🐳 Docker

```bash
docker compose up --build
```

## 🔍 Smoke Test

```bash
npm run smoke:test    # app ต้อง run อยู่ที่ :3000 ก่อน
```

## 📁 Key Files

| File | หน้าที่ |
|------|---------|
| `src/app.ts` | Entry point |
| `src/controllers/poller.ts` | Polling worker loop |
| `src/services/http-server.ts` | Fastify + API server |
| `src/services/api-client.ts` | SPX API + retry |
| `src/services/notifier.ts` | Discord/LINE + auto-accept |
| `src/services/notify-rules.ts` | Rule engine |
| `src/services/metrics.ts` | Metrics collector |
| `src/utils/error-classifier.ts` | Error categorization |
| `src/db/client.ts` | DB pool + pool stats |
| `src/config/env.ts` | Env validation |
| `src/views/dashboard.ts` | Dashboard HTML |
| `src/public/dashboard.js` | Dashboard client JS |

## 🌐 Health Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | ❌ | Uptime, error rate, session health, pool stats |
| `GET /ready` | ❌ | DB + pool + session checks (503 on failure) |
| `GET /metrics` | ❌ | Full MetricsSnapshot JSON |
| `GET /metrics/history` | ❌ | Historical snapshots (persistent) |

## ⚙️ Essential Env Vars

> [!tip] ดู [[env-reference]] สำหรับรายละเอียดครบ

```env
# Required
API_URL=...
COOKIE=...
DEVICE_ID=...
APP_NAME=...
REFERER=...

# Worker
POLL_INTERVAL_MS=10000
FETCH_DETAILS=true
SAVE_TO_DB=true
NOTIFY_ENABLED=true
AUTO_ACCEPT_ENABLED=false

# Dashboard
HTTP_ENABLED=true
HTTP_PORT=3000
```

## ⚠️ Production Reminders

> [!caution] จำไว้เสมอ
> - Rate limit อยู่ใน memory → restart แล้วหาย
> - Settings save → exit process → ต้องมี auto-restart
> - `notify-rules.json` ไม่ safe สำหรับ multi-instance writes
> - Dashboard ต้องการ MySQL แม้ `SAVE_TO_DB=false`
> - Secrets ต้องอยู่ใน `.env` เท่านั้น — ==ห้าม commit==

ดู [[production-cautions]] สำหรับรายละเอียด

## ดูเพิ่มเติม
- [[deployment]] — Production deployment guide
- [[api-routes]] — API endpoint reference
- [[architecture]] — System architecture
