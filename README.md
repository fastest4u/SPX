# SPX Bidding Poller

`SPX Bidding Poller` เป็นระบบ polling แบบอัตโนมัติสำหรับดึงข้อมูล `Agency Booking Bidding List` จาก SPX พร้อม web dashboard สำหรับจัดการ rules, users, settings, history, audit logs, notifications และ reports

## ภาพรวมระบบ

ระบบนี้ทำงาน 2 ส่วนหลัก

- **Polling service**
  - ดึงข้อมูล bidding list ตามรอบเวลา
  - ตรวจสอบการเปลี่ยนแปลงของข้อมูล
  - ดึง booking request details เพิ่มเมื่อเปิดใช้งาน
  - บันทึกข้อมูลลง MySQL เมื่อเปิด `SAVE_TO_DB`
  - ส่ง notification เมื่อเปิด `NOTIFY_ENABLED`

- **Web dashboard**
  - Login ด้วย cookie-based JWT
  - จัดการ rules, users, settings, history, audit logs, notifications, และ reports
  - แสดง metrics และ health/ready endpoints

---

## ฟีเจอร์หลัก

- **Real-time polling**
  - ตั้ง polling interval ได้ผ่าน `.env` หรือ CLI
- **Notification rules**
  - รองรับการ match rules จาก `notify-rules.json`
  - มีสถานะ `enabled` และ `fulfilled`
- **Web dashboard**
  - ใช้ Fastify + JWT + signed cookies
  - มีหน้า dashboard และ login แยกกัน
- **Database storage**
  - ใช้ MySQL 8+ และ Drizzle ORM
  - สร้างตาราง `spx_booking_history` อัตโนมัติถ้ายังไม่มี
- **Production hardening**
  - มี security headers
  - มี rate limit แบบ in-memory
  - มี role-based access control สำหรับ API สำคัญ
  - มี graceful shutdown
  - มี `/health` และ DB-backed `/ready`
  - มี Dockerfile และ docker-compose
  - มี smoke test สำหรับตรวจ deployment

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Backend:** Fastify, TypeScript
- **Database:** MySQL, Drizzle ORM, mysql2
- **Auth:** @fastify/jwt, @fastify/cookie
- **Static assets:** @fastify/static
- **Build:** esbuild
- **UI:** Bootstrap 5, DataTables, vanilla JS

---

## โครงสร้างสำคัญใน codebase

- `src/app.ts` — entrypoint ของแอป
- `src/controllers/poller.ts` — orchestration ของ polling loop
- `src/services/http-server.ts` — web server และ route registration
- `src/views/dashboard.ts` — HTML ของ dashboard
- `src/public/dashboard.js` — JavaScript ฝั่ง dashboard
- `src/config/env.ts` — อ่านและ validate config
- `src/db/client.ts` — MySQL pool และ Drizzle client
- `src/services/metrics.ts` — metrics collector
- `src/services/notifier.ts` — notification orchestration
- `src/services/notify-rules.ts` — rules engine สำหรับ notification
- `src/scripts/smoke-test.ts` — smoke test สำหรับ production deployment

---

## การติดตั้ง

1. ติดตั้ง dependencies

```bash
npm install
```

2. สร้างไฟล์ `.env`

- คัดลอกจากไฟล์ตัวอย่างถ้ามี
- หรือสร้างใหม่ตาม environment ที่ต้องใช้

---

## ตัวอย่างค่า `.env`

```env
API_URL=https://example.com/booking/bidding/list
COOKIE=your-cookie-value
DEVICE_ID=your-device-id
APP_NAME=SPX
REFERER=https://example.com/
POLL_INTERVAL_MS=30000
FETCH_DETAILS=false
SAVE_TO_DB=false
NOTIFY_ENABLED=false
HTTP_ENABLED=true
HTTP_PORT=3000
HTTP_ALLOWED_ORIGINS=https://your-dashboard-domain.example
JWT_SECRET=change-this-to-a-long-secret
COOKIE_SECRET=change-this-to-a-long-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=very-strong-password
ADMIN_ROLE=admin
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=password
DB_NAME=spx
LINE_NOTIFY_TOKEN=
DISCORD_WEBHOOK_URL=
NOTIFY_MODE=batch
NOTIFY_MIN_TRIPS=1
NOTIFY_ORIGINS=
NOTIFY_DESTINATIONS=
NOTIFY_VEHICLE_TYPES=
```

---

## คำสั่งใช้งาน

### Build

```bash
npm run build
```

คำสั่งนี้จะ
- ตรวจ TypeScript ด้วย `tsc --noEmit`
- bundle TypeScript ไปที่ `dist/`
- copy static assets ไปที่ `dist/public/`

### Run

```bash
npm start
```

### Smoke test

```bash
npm run smoke:test
```

> หมายเหตุ: ต้องมีแอปรันอยู่ที่ `http://127.0.0.1:3000` ก่อน

### Database tools

```bash
npm run db:generate
npm run db:migrate
npm run db:test
```

### Flow helpers

```bash
npm run flow:test
npm run flow:start
```

---

## Docker

### Build image

```bash
docker build -t spx-bidding-poller .
```

### Run with docker compose

```bash
docker compose up --build
```

Docker image มี healthcheck ที่ตรวจ endpoint `/ready`

---

## Web dashboard

เมื่อเปิด `HTTP_ENABLED=true` ระบบจะเปิด dashboard ที่

```text
http://localhost:3000
```

### หน้าหลักใน dashboard

- รายการค้นหาทั้งหมด
- ประวัติงานใน DB
- ประวัติการใช้งาน
- จัดการผู้ใช้งาน
- ตั้งค่าระบบ
- แจ้งเตือน
- รายงาน

---

## Health endpoints

- `GET /health` — health check ขั้นพื้นฐาน
- `GET /ready` — readiness สำหรับ deployment และ smoke test
- `GET /metrics` — snapshot metrics ของ polling

---

## หมายเหตุด้าน production

- การ rate limit ตอนนี้ยังเป็นแบบ in-memory
- `notify-rules.json` เป็นไฟล์ state ของ rules engine และเหมาะกับ single-instance
- dashboard ต้องใช้ MySQL เมื่อเปิด `HTTP_ENABLED=true` แม้ `SAVE_TO_DB=false`
- settings ที่บันทึกผ่าน dashboard จะเขียนค่าลง `.env` และ trigger restart ผ่าน `process.exit(0)`
- settings API จะแสดงค่า secret แบบ masked และไม่เขียนทับค่าเดิมถ้าส่ง masked value กลับมา
- ถ้าใช้งาน production หลาย instance ควรย้าย state สำคัญบางส่วนไป DB หรือ secret store

---

## คำสั่งเริ่มต้นแบบแนะนำ

```bash
npm install
npm run build
npm start
```

หรือถ้าใช้ Docker

```bash
docker compose up --build
```
