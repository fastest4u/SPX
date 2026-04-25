---
title: SPX System Notes
tags:
  - obsidian
  - spx
  - documentation
  - system-design
aliases:
  - System Overview
  - ภาพรวมระบบ SPX
---

# SPX System Notes

## One-Line Summary

> [!abstract] TL;DR
> `SPX Bidding Poller` คือระบบ polling แบบอัตโนมัติสำหรับดึง bidding list จาก SPX, วิเคราะห์ข้อมูล, รับงานอัตโนมัติ, บันทึกลง MySQL, ส่ง notification ตาม rules, และมี web dashboard สำหรับบริหารจัดการ

## Current Architecture

### 1) Polling Worker

- **Entry point:** `src/app.ts`
- **Orchestrator:** `src/controllers/poller.ts`
- **Responsibilities:**
  - Validate runtime env
  - Start polling loop (one-shot `setTimeout` per tick)
  - Call SPX API with retry + exponential backoff
  - Detect data changes via ==FNV-1a hash==
  - Fetch booking request details when enabled
  - Save to DB when enabled (`INSERT IGNORE`)
  - Match rules → auto-accept / notify
  - Classify errors → session expiry alerts
  - Record metrics + persist to DB every 5 min
  - Handle graceful shutdown

### 2) Web Dashboard

- **HTTP server:** `src/services/http-server.ts` (Fastify 5)
- **Controllers:** ดู [[api-routes]] สำหรับ route map ครบ
- **Auth:** Cookie-based JWT via `@fastify/jwt`
- **Serves:** `/health`, `/ready`, `/metrics`, `/metrics/history`, `/assets/*`, `/api/*`

### 3) Database Layer

- **Client:** `src/db/client.ts` — MySQL pool + Drizzle + pool stats
- **Tables:** ดู [[database-schema]] สำหรับ schema ครบ 4 ตาราง
- **Style:**
  - Drizzle ORM + `mysql2`
  - Runtime table auto-creation (safety net)
  - `request_id` unique — `INSERT IGNORE` semantics
  - DB required when `SAVE_TO_DB=true` หรือ `HTTP_ENABLED=true`

### 4) Notifications

- **Rule engine:** `src/services/notify-rules.ts`
- **Notifier:** `src/services/notifier.ts`
- **Rules file:** `notify-rules.json`

> [!tip] Rule Matching
> - Rule มี stable `id` — API update/delete by id
> - Trips support ทั้ง English และ Thai field names
> - `NOTIFY_MODE=batch` → รวมข้อความ | `each` → แยกต่อ rule
> - Rules ถูก mark fulfilled หลัง notification สำเร็จ

ดู [[notification-system]] สำหรับรายละเอียด rule lifecycle

### 5) Auto-Accept Engine

- Match trips กับ rules ที่มี `auto_accept: true`
- เรียก SPX API ส่ง accept request จริง
- Retry 1 ครั้ง (delay 2s) เมื่อ fail
- Track metrics: attempts / success / failure

> [!danger] Accept แล้วยกเลิกไม่ได้
> Auto-accept ส่ง API จริงไปยัง SPX Portal

ดู [[auto-accept-engine]] สำหรับ flow diagram

### 6) Observability

| Component | File | หน้าที่ |
|-----------|------|---------|
| Metrics | `src/services/metrics.ts` | Latency percentiles, success rate, session health |
| Error Classifier | `src/utils/error-classifier.ts` | จำแนก error 6 categories |
| Logger | `src/utils/logger.ts` | Structured JSON logging |
| Pool Stats | `src/db/client.ts` | DB connection pool monitoring |
| Persistence | `src/repositories/metrics-repository.ts` | Persist snapshots ทุก 5 นาที |

- `/health` แสดง session health, pool status, auto-accept stats
- `/ready` ตรวจ 3 จุด: DB connectivity, pool saturation, session health
- `/metrics/history` ดึง persistent snapshots ย้อนหลัง

ดู [[error-handling]] สำหรับ error classification

### 7) Access Control

| Role | สิทธิ์ |
|------|-------|
| **viewer** | Read history, reports |
| **editor** | Manage rules, notifications, accept bookings |
| **admin** | Manage users, settings, audit logs |
| *public* | `/health`, `/ready`, `/metrics` |

- Auth: cookie-based JWT + signed cookies
- Rate limiting: role-based (120/180/300 req/min)
- Request tracing: `X-Request-Id` UUID header

## Runtime Flow (Summary)

1. `src/app.ts` reads CLI interval → validates env
2. `Poller.start()` begins worker loop
3. Each tick: fetch → classify errors → detect change → details → save → accept → notify
4. HTTP dashboard available when `HTTP_ENABLED=true`
5. Metrics persisted every 5 min + before shutdown
6. `SIGINT`/`SIGTERM` triggers graceful shutdown

ดู [[runtime-flow]] สำหรับ sequence diagrams

## Production Hardening %%Phase 3%%

- [x] Security headers (CSP, X-Frame-Options, etc.)
- [x] Role-based rate limiting with bucket cleanup
- [x] Cookie-based JWT auth
- [x] RBAC for API routes
- [x] `/health` + `/ready` + `/metrics` endpoints
- [x] DB pool monitoring + saturation detection
- [x] Session expiry alerts (Discord/LINE, 10-min throttle)
- [x] Auto-accept retry (1 retry, 2s delay)
- [x] Metrics persistence (every 5 min + shutdown)
- [x] Request ID tracing (`X-Request-Id`)
- [x] Docker + healthcheck + smoke test
- [x] Graceful shutdown chain
- [x] Atomic writes for `.env` and `notify-rules.json`
- [x] Settings redact secrets in API responses

## Commands

```bash
npm run build         # typecheck + bundle
npm run dev -- 10     # dev mode (10s)
npm start -- 10       # production (10s)
npm run db:migrate    # apply migrations
npm run db:test       # live integration test
npm run flow:start    # migrate + build + start
npm run smoke:test    # deploy verification
```

## ดูเพิ่มเติม
- [[architecture]] — Component diagram + data path
- [[runtime-flow]] — Sequence diagrams
- [[env-reference]] — Environment variables
- [[api-routes]] — HTTP API reference
- [[deployment]] — Production setup guide
- [[cheatsheet]] — Quick reference
