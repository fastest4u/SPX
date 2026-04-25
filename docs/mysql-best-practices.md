---
title: MySQL Best Practices
tags:
  - obsidian
  - spx
  - mysql
  - database
aliases:
  - MySQL Patterns
  - Database Notes
---

# SPX MySQL Notes

## Table Design

> [!note] Design Decisions
> - InnoDB engine + `utf8mb4_0900_ai_ci` สำหรับ Thai/Unicode route names
> - `DATETIME` แทน `TIMESTAMP` เพื่อหลีกเลี่ยง timezone conversion
> - `BIGINT UNSIGNED` สำหรับ IDs จาก SPX API (positive external IDs)

| Convention | Rationale |
|------------|-----------|
| `BIGINT UNSIGNED` for IDs | SPX API IDs เป็นค่าบวกขนาดใหญ่ |
| `VARCHAR(255) NULL` for names | Capture context แต่ไม่บังคับ |
| `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` | หลีกเลี่ยง TZ issues |
| Unique index on `request_id` | Idempotency guard |
| Index on `created_at` | Support `ORDER BY ... DESC LIMIT N` |

ดู [[database-schema]] สำหรับ full schema reference

## Insert-Only Semantics

> [!important] Write-Once Pattern
> ```sql
> INSERT IGNORE INTO spx_booking_history (...) VALUES (...)
> ```
> - Records เขียนครั้งเดียวเมื่อ job ปรากฏครั้งแรก
> - ถ้า `request_id` ซ้ำ → silently skip (ไม่ update)
> - ==Preserves original snapshot== ณ เวลาที่ detect ครั้งแรก
> - ผลลัพธ์: `acceptance_status` ที่เปลี่ยนทีหลัง DB จะไม่รู้

## Migrations

| Migration | หน้าที่ |
|-----------|---------|
| `001_create_booking_requests.sql` | Fresh-install table definition |
| `002_harden_booking_history_mysql.sql` | Upgrade → unsigned IDs, DATETIME, collation, indexes |
| `003_add_booking_details.sql` | เพิ่ม `booking_id`, `booking_name`, `agency_name`, statuses |

> [!tip] Migration Execution
> `src/scripts/db-migrate.ts` แยก SQL ด้วย semicolon → execute ทีละ statement
> หลีกเลี่ยง stored procedures/custom delimiters

## Schema Sources (ต้อง sync)

> [!warning] 4 แหล่งที่ต้องเปลี่ยนพร้อมกัน
> 1. `src/db/schema.ts` — Drizzle schema (TypeScript types)
> 2. `src/db/migration-sql.ts` — Raw SQL template
> 3. `src/db/client.ts` → runtime DDL — Runtime `CREATE TABLE IF NOT EXISTS`
> 4. `migrations/*.sql` — Migration files
>
> ==เปลี่ยน schema ต้องแก้ทั้ง 4 ที่==

## Query Patterns

- ✅ ใช้ `INSERT IGNORE` + unique constraint — ไม่ `SELECT` ก่อน `INSERT`
- ✅ ใช้ `like()` แทน `ilike()` — MySQL ไม่รองรับ `ilike` ของ PostgreSQL
- ✅ Focused selects — ไม่ใช้ `SELECT *` ในงาน operational
- ✅ `EXPLAIN` สำหรับ query ใหม่ที่ sort/filter by date

## Connection Pool

> [!note] Pool Monitoring (Phase 3)
> - Default `connectionLimit: 10`
> - `getPoolStats()` ดึง: total, idle, acquired, queued connections
> - `/ready` ตรวจ pool saturation → return 503 ถ้า queue > 0
> - Stats ถูกรวมใน `/health` response ด้วย

## Operational Checks

```bash
npm run db:migrate    # Apply migrations, record filenames in schema_migrations
npm run db:test       # Insert/detect one live request (needs real API + MySQL)
```

สำหรับ schema verification:
```sql
SHOW CREATE TABLE spx_booking_history;
-- ตรวจ indexes: request_id_idx, booking_id_idx, created_at_idx
```

## ดูเพิ่มเติม
- [[database-schema]] — Full table definitions + ER diagram
- [[architecture]] — Database position in system
- [[env-reference]] — DB config variables
- [[production-cautions]] — DB dependency warnings
