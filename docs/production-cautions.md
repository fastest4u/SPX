---
title: Production Cautions
tags:
  - obsidian
  - spx
  - production
  - cautions
aliases:
  - ข้อควรระวัง Production
  - Operational Risks
---

# Production Cautions

> [!danger] อ่านก่อน deploy
> เอกสารนี้รวมข้อควรระวังที่ ==ต้องรู้== ก่อน deploy ระบบ SPX ขึ้น production
> ละเลยข้อใดข้อหนึ่งอาจทำให้ระบบล่มหรือข้อมูลรั่วไหล

## 1) Rate Limit เป็น In-Memory

> [!warning] ไม่ persist ข้าม restart
> - Rate limit buckets อยู่ใน memory — restart แล้วหาย
> - ไม่ share ข้าม instance → ถ้า scale horizontally ต้องใช้ shared storage (Redis)
> - Expired buckets ถูก cleanup อัตโนมัติทุก 60 วินาที
> - Role-based limits: viewer=120, editor=180, admin=300 req/min

## 2) Settings Page ทำให้ Process Exit

> [!caution] Auto-restart required
> - บันทึก settings → เขียน `.env` → `process.exit(0)` ทันที
> - ==ต้องมี process manager== (PM2, Docker restart, systemd)
> - API response redact secret values — ปล่อย masked values ไว้จะไม่เขียนทับ secret เดิม

ดู [[deployment#Process Manager]] สำหรับ setup

## 3) Notification Rules เป็น File-Based

> [!note] Single-instance limitation
> - `notify-rules.json` เหมาะสำหรับ single-instance
> - Writes เป็น atomic แต่ concurrent writes จาก multiple instances ยัง risky
> - Dashboard update/delete rules โดยใช้ stable `id` ไม่ใช่ array index
> - ถ้าต้อง scale → migrate ไป DB-backed rules

## 4) Dashboard ต้องการ MySQL เสมอ

> [!important] DB required even without SAVE_TO_DB
> - `HTTP_ENABLED=true` ต้องการ DB config แม้ `SAVE_TO_DB=false`
> - เพราะ `users` table และ `audit_logs` อยู่ใน MySQL
> - `/ready` return 503 ทันทีหาก DB ไม่ available

ดู [[database-schema]] สำหรับ schema details

## 5) Smoke Test ≠ Unit Test

> [!note] Deploy verification only
> - ตรวจ readiness (`/ready`) และ static asset serving
> - ไม่ได้ทดสอบ business logic
> - ==ไม่ทดแทน automated unit/integration tests==

## 6) Static Assets ต้อง Build ก่อน

- `npm run build` จะ copy `src/public/` → `dist/public/`
- ถ้า build เปลี่ยน → ตรวจว่า assets ยังเสิร์ฟได้ถูกต้อง
- Dashboard JS bundle อยู่ที่ `/assets/dashboard.js`

## 7) Secrets ห้ามหลุดลง Notes/Commits

> [!danger] Security
> - ใช้ `.env` locally, secret manager ใน production
> - ==ห้าม== read, print, commit, copy ค่าจาก `.env` ลงใน code, logs, หรือ docs
> - `COOKIE` เป็น session token จริงของ SPX Agency Portal

## 8) Metrics Endpoint เป็น Public

> [!warning] Network exposure
> - `/metrics`, `/health`, `/ready` ไม่ต้อง authentication
> - Expose เฉพาะ trusted network หรือใส่ reverse proxy rule
> - `/metrics/history` ก็เป็น public เช่นกัน

## 9) Session Cookie หมดอายุได้

> [!caution] SPX Cookie Expiry
> - SPX API ใช้ session cookie — หมดอายุแล้วระบบ poll ไม่ได้
> - ระบบจะส่ง alert ผ่าน Discord/LINE (throttle 10 นาที)
> - Health check จะแสดง `status: "degraded"` เมื่อ errors ติดต่อกัน ≥ 5 ครั้ง
> - แก้: เข้า SPX Portal → copy cookie ใหม่ → อัปเดตผ่าน Settings UI

## 10) Connection Pool ต้อง Monitor

> [!tip] Pool Saturation Warning
> - Default `connectionLimit: 10`
> - `/ready` จะแสดง pool status: `ok` | `warning` (>70%) | `saturated` (>90%) | `queued`
> - ถ้ามี queued requests → return 503

ดู [[api-routes]] สำหรับ endpoint reference

## ดูเพิ่มเติม
- [[deployment]] — Production checklist
- [[env-reference]] — ตัวแปรที่ต้องตั้ง
- [[error-handling]] — Error classification
- [[architecture]] — ภาพรวมระบบ
