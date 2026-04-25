---
title: Env Reference
tags:
  - obsidian
  - spx
  - env
  - config
aliases:
  - ตัวแปร Environment
  - .env Reference
---

# Env Reference

> [!important] ไฟล์ `.env` ที่ root ของ project
> - โหลดอัตโนมัติผ่าน `src/config/env.ts`
> - ไม่ override ค่า `process.env` ที่มีอยู่แล้ว
> - สามารถแก้ไขผ่าน Settings UI (admin only) → ระบบ restart ทันที

## Required Base Values

| Variable | Description | ตัวอย่าง |
|----------|-------------|---------|
| `API_URL` | SPX bidding list API endpoint | `https://...` |
| `COOKIE` | Session cookie จาก browser | `SPC_...` |
| `DEVICE_ID` | Device identifier | `device_xxx` |
| `APP_NAME` | Application name header | `SPX App` |
| `REFERER` | Referer header | `https://...` |

> [!danger] Secrets
> `COOKIE` เป็น session token จริง — ==ห้ามเปิดเผยหรือ commit ลง git==

## Worker Controls

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `POLL_INTERVAL_MS` | int | — | Milliseconds ระหว่าง poll (CLI override เป็นวินาที) |
| `FETCH_DETAILS` | bool | `false` | แสดงรายละเอียด trip ใน console |
| `SAVE_TO_DB` | bool | `false` | บันทึก trip ลง MySQL |
| `NOTIFY_ENABLED` | bool | `false` | ส่ง notification |
| `NOTIFY_MODE` | string | `batch` | `batch` \| `each` — รวมหรือแยกข้อความ |
| `NOTIFY_MIN_TRIPS` | int | — | จำนวน trip ขั้นต่ำก่อนส่ง notification |
| `NOTIFY_ORIGINS` | string | — | Filter ต้นทาง (comma-separated) |
| `NOTIFY_DESTINATIONS` | string | — | Filter ปลายทาง |
| `NOTIFY_VEHICLE_TYPES` | string | — | Filter ประเภทรถ |
| `AUTO_ACCEPT_ENABLED` | bool | `false` | เปิดระบบรับงานอัตโนมัติ |

## Database

| Variable | Type | Default | Required When |
|----------|------|---------|---------------|
| `DB_HOST` | string | — | `SAVE_TO_DB` \| `HTTP_ENABLED` |
| `DB_PORT` | int | `3306` | — |
| `DB_USERNAME` | string | — | `SAVE_TO_DB` \| `HTTP_ENABLED` |
| `DB_PASSWORD` | string | — | `SAVE_TO_DB` \| `HTTP_ENABLED` |
| `DB_NAME` | string | — | `SAVE_TO_DB` \| `HTTP_ENABLED` |

## Dashboard Auth

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `HTTP_ENABLED` | bool | `false` | เปิด Web Dashboard |
| `HTTP_PORT` | int | `3000` | Port สำหรับ Fastify server |
| `HTTP_ALLOWED_ORIGINS` | string | — | Comma-separated CORS origins |
| `JWT_SECRET` | string | — | ≥ 32 chars, สำหรับ sign JWT |
| `COOKIE_SECRET` | string | — | ≥ 32 chars, สำหรับ sign cookie |
| `ADMIN_USERNAME` | string | `admin` | Default admin username |
| `ADMIN_PASSWORD` | string | — | Strong password required |
| `ADMIN_ROLE` | string | `admin` | `admin` \| `editor` \| `viewer` |
| `NODE_ENV` | string | — | `production` → secure cookies |

## Notification Channels

| Variable | Type | Required When | Description |
|----------|------|---------------|-------------|
| `LINE_NOTIFY_TOKEN` | string | `NOTIFY_ENABLED` | LINE Notify API token |
| `DISCORD_WEBHOOK_URL` | string | `NOTIFY_ENABLED` | Discord webhook URL |

> [!note] อย่างน้อย 1 channel
> ต้องตั้งค่าอย่างน้อย `LINE_NOTIFY_TOKEN` หรือ `DISCORD_WEBHOOK_URL` เมื่อ `NOTIFY_ENABLED=true`

## Validation Rules

- URLs ต้องเป็น valid URL format
- Integer fields ต้องเป็นค่าบวก
- Dashboard secrets (`JWT_SECRET`, `COOKIE_SECRET`) ต้อง ≥ 32 characters
- Admin password ต้องแข็งแรงเพียงพอ
- CORS origins ต้องเป็น valid URLs
- `ADMIN_ROLE` ต้องเป็น `admin`, `editor`, หรือ `viewer`
- CLI interval (วินาที) จะ override `POLL_INTERVAL_MS` (มิลลิวินาที)

## Common Production Defaults

```env
HTTP_PORT=3000
NOTIFY_MODE=batch
ADMIN_ROLE=admin
HTTP_ALLOWED_ORIGINS=https://your-dashboard-domain.example
NODE_ENV=production
```

## ดูเพิ่มเติม
- [[architecture]] — Feature flag system
- [[deployment]] — Production .env template
- [[production-cautions]] — ข้อควรระวังเรื่อง secrets
