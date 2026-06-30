---
title: Architecture
tags:
  - obsidian
  - spx
  - architecture
aliases:
  - โครงสร้างระบบ
---

# Architecture

## Overview

SPX Bidding Poller เป็นระบบ split-runtime ใน production: process `notifier` เป็น HTTP/dashboard + central notification hub และ process `worker-*` เป็น polling/auto-accept workers ต่อทีม. Local/dev ยังสามารถใช้ `SPX_ROLE=combined` เพื่อรันทุกอย่างใน process เดียวได้.

### 1) Polling Worker (Core Engine)

| Component | File | หน้าที่ |
|-----------|------|--------|
| Entry Point | `src/app.ts` | Parse CLI args, validate config, start Poller |
| Orchestrator | `src/controllers/poller.ts` | จัดการ polling loop, tick, shutdown |
| API Client | `src/services/api-client.ts` | เรียก SPX API + retry + error handling |
| Data Processor | `src/services/data-processor.ts` | Detect change via FNV-1a hash |
| Booking Extractor | `src/utils/booking-extractor.ts` | แปลง raw API → `ExtractedTripInfo` |
| DB Service | `src/services/db-service.ts` | Wrapper สำหรับ INSERT IGNORE |
| Notifier | `src/services/notifier.ts` | ส่ง Discord/LINE + auto-accept flow |
| Rule Engine | `src/services/notify-rules.ts` | Match trips กับ rules, mark fulfilled |
| Metrics | `src/services/metrics.ts` | Latency percentiles, success rate |
| Error Classifier | `src/utils/error-classifier.ts` | จำแนก error เป็น 6 categories |
| Runtime Metrics Client | `src/services/runtime-metrics-client.ts` | ส่ง worker metrics เข้า notifier |
| Team Runtime | `src/services/team-runtime*.ts` | จัดการ runtime ต่อทีม, leases, desired state |

### 2) Notifier / Dashboard Process

| Component | File | หน้าที่ |
|-----------|------|--------|
| HTTP Server | `src/services/http-server.ts` | Fastify + CORS + JWT + Rate Limit + SPA serving |
| Auth Controller | `src/controllers/auth-controller.ts` | Login/Logout/Refresh/Me API |
| Dashboard Controller | `src/controllers/dashboard-controller.ts` | Health + aggregated metrics + events API |
| Internal Notification Controller | `src/controllers/internal-notification-controller.ts` | รับ worker notification events และ runtime metrics |
| Rules Controller | `src/controllers/rules-controller.ts` | CRUD notification rules API |
| History Controller | `src/controllers/history-controller.ts` | Query booking history API |
| Users Controller | `src/controllers/users-controller.ts` | User management API (admin) |
| Teams Controller | `src/controllers/teams-controller.ts` | Team config + runtime desired-state controls |
| Settings Controller | `src/controllers/settings-controller.ts` | DB-first settings API |
| Audit Controller | `src/controllers/audit-controller.ts` | Audit log API |
| Report Controller | `src/controllers/report-controller.ts` | CSV export API |
| Bidding Controller | `src/controllers/bidding-controller.ts` | Manual booking accept API |
| Notify Controller | `src/services/notify-controller.ts` | Notification preview/test API |
| Authz | `src/services/authz.ts` | RBAC: `viewer` < `editor` < `admin` |
| Runtime Metrics | `src/services/runtime-metrics.ts` | เก็บ worker snapshots ชั่วคราวและ aggregate ให้ admin dashboard |

#### React SPA Frontend (`src/frontend/`)

| Component | File | หน้าที่ |
|-----------|------|--------|
| Entry Point | `src/frontend/main.tsx` | React 19 entry, QueryClient, Router |
| Root Layout | `src/frontend/routes/__root.tsx` | App shell, auth check, sidebar |
| Router | `src/frontend/routes/*.tsx` | 11 pages (Dashboard, History, Audit, Users, Settings, Notifications, Reports, LINE Bot, Auto-Accept History, Login) |
| UI Primitives | `src/frontend/components/ui/*.tsx` | Button, Card, Input, Dialog, Label, Skeleton, Avatar, Badge, Switch |
| Business Components | `src/frontend/components/*.tsx` | DataTable (with sorting), EmptyState, Sparkline, Breadcrumb, CreateRuleDialog, EditRuleDialog, DeleteConfirmDialog, VehicleTypeMultiSelect, SettingsLineBotSection |
| Layout | `src/frontend/components/layout/AppLayout.tsx` | Sidebar (collapsible sections, keyboard shortcuts), Top bar (breadcrumbs, Cmd+K search, notification bell, user dropdown), Mobile bottom tab bar |
| API Client | `src/frontend/lib/api.ts` | Typed fetch wrapper with auth handling |
| Auth Hook | `src/frontend/hooks/useAuth.ts` | Login/logout/auth state |
| SSE Hook | `src/frontend/hooks/useSse.ts` | Real-time metrics updates |
| Styles | `src/frontend/index.css` | Tailwind CSS v4 with custom theme, animations, glass morphism |

## Settings Storage

Settings เป็น DB-first:

```
Startup: bootstrap .env → connect DB → loadDbFirstSettingsIntoEnv() → validateRuntimeConfig()
Read:    readStoredSettings() = merge(catalog defaults, process.env, DB) — DB wins
Write:   Web UI → upsertAppSettings(DB) + reloadSettingsLive() → live/restart behavior ตาม metadata
```

> [!info] ไม่ต้อง restart
> `ApiClient` อ่าน `env` ทุกครั้งที่ fetch (ไม่ cache ใน constructor)  
> `Poller` อ่าน `POLL_INTERVAL_MS` ทุก tick ผ่าน `getIntervalMs()`  
> เมื่อ save settings → sync DB → process.env → env object → ระบบทำงานต่อด้วยค่าใหม่ทันที

## AppLayout Features

| Feature | Description |
|---------|-------------|
| Sidebar | Collapsible sections (Menu / Administration), active glow indicator, hover shortcut keys (⌘1-⌘9) |
| Top Bar | Breadcrumbs, Cmd+K quick search modal, notification bell, user avatar dropdown |
| Mobile | Bottom tab bar (5 tabs), hamburger-less navigation |
| Keyboard | `⌘B` toggle sidebar, `⌘K` quick search, `Esc` close modals |
| Loading | SkeletonTable / SkeletonCard on every data page |
| Empty | EmptyState component with icon + action button |

## Architecture Diagram

```mermaid
flowchart TD
  A["src/app.ts"] --> B["validateRuntimeConfig()"]
  B --> C["Poller.start()"]
  C --> D["ApiClient.fetch() — bidding list"]
  D --> E["DataProcessor.detectChange()"]
  E --> F{"Need details?"}
  F -->|No| G["Record metrics"]
  F -->|Yes| H["Fetch request list per booking"]
  H --> I["extractAllRequestListTrips()"]
  I --> J{"SAVE_TO_DB?"}
  J -->|Yes| K["INSERT IGNORE → spx_booking_history"]
  J -->|No| L["skip DB"]
  K --> M{"AUTO_ACCEPT?"}
  L --> M
  M -->|Yes| AA["acceptAndNotifyMatchedRules()"]
  M -->|No| N{"NOTIFY_ENABLED?"}
  AA --> N
  N -->|Yes| O["notifyMatchedRules()"]
  N -->|No| P["Record metrics + logs"]
  O --> P
  P --> RM["Worker publishes runtime snapshot"]
  RM --> IC["notifier /internal/runtime-metrics"]
  IC --> SSE["Admin/team SSE + /metrics aggregation"]

  A --> Q{"SPX_ROLE"}
  Q -->|notifier/combined| R["startHttpServer()"]
  Q -->|worker/combined| C
  R --> T["Dashboard + API + Assets"]
```

## Data Path

> [!info] Data Flow Direction
> `SPX API` → `ApiClient` → `Poller` → `Extractor` → `DB / Notifier / Metrics`
> 
> ข้อมูลไหลทิศทางเดียว ไม่มี feedback loop จาก DB กลับไป API

## Feature Flag System

ระบบใช้ DB-first settings เป็น feature flags หลัง startup seed สำเร็จ:

```
FETCH_DETAILS=true       → แสดงรายละเอียด trip ใน console
SAVE_TO_DB=true          → บันทึกลง MySQL
NOTIFY_ENABLED=true      → ส่ง notification
AUTO_ACCEPT_ENABLED=true → รับงานอัตโนมัติ
HTTP_ENABLED=true        → เปิด Web Dashboard ใน notifier/combined role
```

> [!info] Live Reload
> Settings แก้ไขผ่าน Web UI (`/settings`) → บันทึกลง DB → sync กลับเข้า `process.env` และ `env` object ทันที
> API credentials (COOKIE, DEVICE_ID, API_URL) อ่านจาก `env` ทุกครั้งที่ fetch — **ไม่ต้อง restart server**

> [!warning] Feature Dependencies
> - `SAVE_TO_DB`, `HTTP_ENABLED`, `AUTO_ACCEPT_ENABLED` ต้องการ DB config ทั้งหมด
> - `NOTIFY_ENABLED` ต้องการ LINE target/channel config หรือ `DISCORD_WEBHOOK_URL`
> - `HTTP_ENABLED` ต้องการ `JWT_SECRET`, `COOKIE_SECRET`, `ADMIN_PASSWORD`

## Runtime Roles

| Role | Starts HTTP | Runs pollers | Sends LINE centrally | Typical production service |
|------|-------------|--------------|----------------------|----------------------------|
| `notifier` | yes | no | yes | `notifier` |
| `worker` | no | yes, limited by `RUN_TEAM_IDS` | no, publishes events to notifier | `worker-ifn`, `worker-ptwl` |
| `combined` | yes | yes | local/central depending config | local/dev |
| `api` | yes | no | no | reserved/API-only |

Workers publish signed internal events to the notifier. Runtime metrics use the same worker-to-notifier boundary, so admin/all-team telemetry reflects worker process state instead of notifier-local zero counters.

## Supporting Layers

- [[env-reference|Config]] — `src/config/env.ts` — validation + .env loading
- [[database-schema|Database]] — `src/db/client.ts` — MySQL pool + Drizzle + auto-create tables
- **Repositories** — `src/repositories/*` — direct DB access layer
- **Services** — `src/services/*` — business logic layer  
- **Utils** — `src/utils/*` — logging, hashing, error classification
