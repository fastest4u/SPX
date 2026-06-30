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
> - โหลดอัตโนมัติผ่าน `src/config/env.ts` สำหรับ bootstrap/process identity เท่านั้น
> - Runtime/operator settings โหลดจาก `app_settings` หลังเชื่อมต่อ DB
> - แก้ไขค่า runtime ผ่าน Settings UI และ Teams UI แทนการแก้ `.env`

## Bootstrap Env

These values remain in `.env`: `NODE_ENV`, `DB_MODE`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `SECRETS_KEY`.

## Database

| Variable | Type | Default | Required When |
|----------|------|---------|---------------|
| `DB_HOST` | string | — | DB-backed runtime config, dashboard, workers |
| `DB_PORT` | int | `3306` | — |
| `DB_USERNAME` | string | — | DB-backed runtime config, dashboard, workers |
| `DB_PASSWORD` | string | — | DB-backed runtime config, dashboard, workers |
| `DB_NAME` | string | — | DB-backed runtime config, dashboard, workers |
| `SECRETS_KEY` | string | — | Encrypt/decrypt DB-backed secrets |

## Process Identity Env

These values remain in Docker/service environment: `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_PORT`.

| Variable | Description |
|----------|-------------|
| `SPX_ROLE` | Process role: notifier, worker, or combined |
| `SPX_NODE_ID` | Stable runtime node id for health/status tracking |
| `SPX_NODE_NAME` | Optional display name for the runtime node |
| `RUN_TEAM_IDS` | Comma-separated team ids assigned to a worker process |
| `NOTIFIER_API_URL` | Worker-to-notifier internal notification endpoint |
| `NOTIFIER_LOCAL_SPOOL_PATH` | Local retry spool path for worker notification events |
| `HTTP_PORT` | Fastify HTTP port for the notifier/dashboard process |

## DB-First Settings

Operator settings such as `POLL_INTERVAL_MS`, `API_URL`, `AUTO_ACCEPT_ENABLED`, notification settings, auth signing secrets, and provider settings are stored in `app_settings`.

Team-scoped SPX credentials and LINE targets are stored encrypted on each `teams` row. Do not keep `COOKIE`, `DEVICE_ID`, `LINE_USER_ID`, or auto-accept success/failure LINE targets as global runtime env after migration.

Before removing legacy runtime values from production `.env`, deploy the DB-first build once with the old `.env` still present. Startup seeds missing `app_settings` rows from env, then later boots can run with only bootstrap/process env.

## Validation Rules

- URLs ต้องเป็น valid URL format
- Integer fields ต้องเป็นค่าบวก
- Dashboard secrets (`JWT_SECRET`, `COOKIE_SECRET`) ต้อง ≥ 32 characters
- Admin password ต้องแข็งแรงเพียงพอ
- CORS origins ต้องเป็น valid URLs
- `ADMIN_ROLE` ต้องเป็น `admin` หรือ `user`

## ดูเพิ่มเติม
- [[architecture]] — Feature flag system
- [[deployment]] — Production .env template
- [[production-cautions]] — ข้อควรระวังเรื่อง secrets
