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
npm run build       # typecheck + bundle
npm start -- 10     # start with 10s interval
```

> [!important] Database Migrations
> ถ้า `HTTP_ENABLED=true` หรือ `SAVE_TO_DB=true` ต้อง run migration ก่อน startup:
> ```bash
> npm run db:migrate
> ```
> แต่ระบบมี runtime `CREATE TABLE IF NOT EXISTS` เป็น safety net อยู่แล้ว

## Development Mode

```bash
npm run dev -- 10   # ts-node + 10s interval
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
- Base image: `node:18-slim`

## Production Checklist

> [!warning] สิ่งที่ต้องทำก่อน deploy production

- [ ] ตั้งค่า `.env` ครบทุกตัวแปร (ดู [[env-reference]])
- [ ] ใช้ process manager (PM2, systemd, Docker restart policy)
- [ ] Run `npm run db:migrate` ก่อน startup
- [ ] ตั้ง `HTTP_ALLOWED_ORIGINS` สำหรับ non-localhost domain
- [ ] ตั้ง `NODE_ENV=production` สำหรับ secure cookies
- [ ] Secrets ต้องอยู่ใน `.env` หรือ secret manager เท่านั้น
- [ ] Monitor `/health`, `/ready`, `/metrics` ผ่าน Uptime Kuma หรือ Datadog
- [ ] `notify-rules.json` ต้องมี controlled write access
- [ ] ตรวจว่า `npm run build` ผ่านก่อน release (includes typecheck)

## Process Manager

> [!tip] ทำไมต้องมี process manager?
> Settings UI เขียน `.env` แล้ว ==exit process ทันที== เพื่อ reload config
> ต้องมี auto-restart mechanism:
> - Docker: `restart: unless-stopped`
> - PM2: `pm2 start dist/app.js --name spx`
> - systemd: `Restart=always`

## ดูเพิ่มเติม
- [[env-reference]] — ตัวแปร environment ทั้งหมด
- [[production-cautions]] — ข้อควรระวังใน production
- [[cheatsheet]] — คำสั่ง npm ที่ใช้บ่อย
- [[architecture]] — โครงสร้างระบบ
