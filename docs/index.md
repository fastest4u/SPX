---
title: SPX Bidding Poller MOC
tags:
  - obsidian
  - spx
  - moc
aliases:
  - SPX MOC
  - SPX Home
---

# SPX Bidding Poller — Map of Content

จุดเริ่มต้นสำหรับอ่านเอกสารระบบ SPX Bidding Poller แบบเป็นลำดับ

## 📚 อ่านตามลำดับนี้

### พื้นฐาน
1. [[architecture]] — โครงสร้างระบบ, component map, data path
2. [[runtime-flow]] — ลำดับการทำงานจาก start → tick → shutdown
3. [[env-reference]] — ตัวแปร environment ทั้งหมด
4. [[api-routes]] — เส้นทาง HTTP API ทั้งหมดพร้อม role

### ระบบย่อย
5. [[notification-system]] — ระบบ Rule engine + Discord/LINE + Auto-Accept
6. [[database-schema]] — ตาราง MySQL ทั้ง 4 พร้อม index
7. [[auto-accept-engine]] — ขั้นตอน auto-accept อัตโนมัติ
8. [[error-handling]] — Error classification + retry strategy

### Operations
9. [[deployment]] — Docker, PM2, production checklist
10. [[production-cautions]] — ข้อควรระวังในการใช้งานจริง
11. [[cheatsheet]] — คำสั่ง npm ที่ใช้บ่อย

### Best Practices
12. [[obsidian-system]] — ระบบ Obsidian notes
13. [[nodejs-best-practices]] — Node.js patterns
14. [[mysql-best-practices]] — MySQL patterns
15. [[backend-worker-patterns]] — Worker patterns

## 🔑 Quick Summary

> [!abstract] ระบบนี้คืออะไร
> **SPX Bidding Poller** เป็น Full-stack TypeScript Application แบบ split-runtime ที่ทำหน้าที่:
> 1. Poll ข้อมูล booking จาก SPX Agency Portal API แบบ real-time
> 2. วิเคราะห์และจับคู่ trip กับ notification rules
> 3. รับงาน (accept) อัตโนมัติตามเงื่อนไข
> 4. แจ้งเตือนผ่าน central notifier ไปยัง LINE / Discord
> 5. บันทึกประวัติลง MySQL
> 6. ให้ **React SPA Web Dashboard** สำหรับบริหารจัดการ
> 7. เก็บ runtime/operator settings แบบ DB-first ผ่าน `app_settings` และ `teams`

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict, `NodeNext`) |
| Runtime | Node.js >=24.16.0 |
| Web Framework | Fastify 5 |
| Frontend | React 19 + TanStack Router + TanStack Query |
| UI Library | shadcn/ui + Tailwind CSS v4 |
| Charts | Recharts |
| ORM | Drizzle (mysql2) |
| Database | MySQL (InnoDB, `utf8mb4_0900_ai_ci`) |
| Backend Bundler | esbuild (minified, external packages) |
| Frontend Bundler | Vite 8 |
| Auth | JWT Cookie + bcrypt |
| Notifications | Central LINE/LINEJS + Discord Webhook |
| Dev Tools | concurrently (run backend+frontend together) |

## 📊 สถิติโปรเจกต์

- Production services: `notifier`, `worker-ifn`, `worker-ptwl`
- Runtime config: bootstrap `.env` + MySQL `app_settings` + encrypted team fields
- Frontend: React SPA served by the notifier process

## Notes
- เอกสารนี้เน้นให้เข้าใจระบบเร็ว
- ถ้าจะลงมือแก้ code ให้ดูไฟล์ใน `src/` คู่กับเอกสารนี้
- ทุกครั้งที่เพิ่ม feature ใหม่ ควรอัปเดตเอกสารที่เกี่ยวข้อง
