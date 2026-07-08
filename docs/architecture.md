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

SPX Bidding Poller เป็นระบบ split-runtime ใน production. Legacy production ยังใช้ process `notifier` เป็น HTTP/dashboard + central notification hub และ process `worker-*` เป็น polling/auto-accept workers ต่อทีม. Target split-service topology แยก `web-api`, `notification-service`, `line-service`, `ocr-service`, และ workers ออกจากกันเพื่อให้ LINEJS/OCR ล่มแล้วไม่ดึง dashboard หรือ worker ลงไปด้วย. Local/dev ยังสามารถใช้ `SPX_ROLE=combined` เพื่อรันทุกอย่างใน process เดียวได้.

### 1) Polling Worker (Core Engine)

| Component              | File                                     | หน้าที่                                       |
| ---------------------- | ---------------------------------------- | --------------------------------------------- |
| Entry Point            | `src/app.ts`                             | Parse CLI args, validate config, start Poller |
| Orchestrator           | `src/controllers/poller.ts`              | จัดการ polling loop, tick, shutdown           |
| API Client             | `src/services/api-client.ts`             | เรียก SPX API + retry + error handling        |
| Data Processor         | `src/services/data-processor.ts`         | Detect change via FNV-1a hash                 |
| Booking Extractor      | `src/utils/booking-extractor.ts`         | แปลง raw API → `ExtractedTripInfo`            |
| DB Service             | `src/services/db-service.ts`             | Wrapper สำหรับ INSERT IGNORE                  |
| Notifier               | `src/services/notifier.ts`               | ส่ง Discord/LINE + auto-accept flow           |
| Rule Engine            | `src/services/notify-rules.ts`           | Match trips กับ rules, mark fulfilled         |
| Metrics                | `src/services/metrics.ts`                | Latency percentiles, success rate             |
| Error Classifier       | `src/utils/error-classifier.ts`          | จำแนก error เป็น 6 categories                 |
| Runtime Metrics Client | `src/services/runtime-metrics-client.ts` | ส่ง worker metrics เข้า notifier              |
| Team Runtime           | `src/services/team-runtime*.ts`          | จัดการ runtime ต่อทีม, leases, desired state  |

### 2) Web API / Notification / LINE / OCR Processes

| Component                        | File                                                  | หน้าที่                                                                                               |
| -------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| HTTP Server                      | `src/services/http-server.ts`                         | Fastify + CORS + JWT + Rate Limit + SPA serving or internal service surface by role                   |
| Auth Controller                  | `src/controllers/auth-controller.ts`                  | Login/Logout/Refresh/Me API                                                                           |
| Dashboard Controller             | `src/controllers/dashboard-controller.ts`             | Health + aggregated metrics + events API                                                              |
| Internal Notification Controller | `src/controllers/internal-notification-controller.ts` | รับ worker notification events และ runtime metrics                                                    |
| Internal LINE Controller         | `src/controllers/internal-line-controller.ts`         | รับ signed notification-service calls แล้วส่ง LINE ผ่าน LINEJS                                        |
| Internal OCR Controller          | `src/controllers/internal-ocr-controller.ts`          | รับ signed line-service image OCR calls แล้วเรียก Codex image reader                                  |
| Rules Controller                 | `src/controllers/rules-controller.ts`                 | CRUD notification rules API                                                                           |
| History Controller               | `src/controllers/history-controller.ts`               | Query booking history API                                                                             |
| Users Controller                 | `src/controllers/users-controller.ts`                 | User management API (admin)                                                                           |
| Teams Controller                 | `src/controllers/teams-controller.ts`                 | Team config + runtime desired-state controls                                                          |
| Settings Controller              | `src/controllers/settings-controller.ts`              | DB-first settings API                                                                                 |
| Audit Controller                 | `src/controllers/audit-controller.ts`                 | Audit log API                                                                                         |
| Report Controller                | `src/controllers/report-controller.ts`                | CSV export API                                                                                        |
| Bidding Controller               | `src/controllers/bidding-controller.ts`               | Manual booking accept API                                                                             |
| LINE Bot Controller              | `src/controllers/line-bot-controller.ts`              | Legacy local LINEJS fallback, plus split-mode proxy to line-service for authenticated LINE Bot routes |
| Notify Controller                | `src/services/notify-controller.ts`                   | Notification preview/test API                                                                         |
| Notification Sender              | `src/services/notification-line-sender.ts`            | เลือก remote line-service หรือ legacy local LINE fallback                                             |
| LINE Image Processor             | `src/services/line-image-processor.ts`                | เลือก remote OCR-service หรือ local OCR fallback แล้ว persist extraction                              |
| Service Health                   | `src/services/service-health.ts`                      | Shallow `/health`, strict `/ready`, downstream degraded status และ secret redaction                   |
| Authz                            | `src/services/authz.ts`                               | RBAC: `viewer` < `editor` < `admin`                                                                   |
| Runtime Metrics                  | `src/services/runtime-metrics.ts`                     | เก็บ worker snapshots ชั่วคราวและ aggregate ให้ admin dashboard                                       |

#### React SPA Frontend (`src/frontend/`)

| Component           | File                                           | หน้าที่                                                                                                                                                            |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry Point         | `src/frontend/main.tsx`                        | React 19 entry, QueryClient, Router                                                                                                                                |
| Root Layout         | `src/frontend/routes/__root.tsx`               | App shell, auth check, sidebar                                                                                                                                     |
| Router              | `src/frontend/routes/*.tsx`                    | 11 pages (Dashboard, History, Audit, Users, Settings, Notifications, Reports, LINE Bot, Auto-Accept History, Login)                                                |
| UI Primitives       | `src/frontend/components/ui/*.tsx`             | Button, Card, Input, Dialog, Label, Skeleton, Avatar, Badge, Switch                                                                                                |
| Business Components | `src/frontend/components/*.tsx`                | DataTable (with sorting), EmptyState, Sparkline, Breadcrumb, CreateRuleDialog, EditRuleDialog, DeleteConfirmDialog, VehicleTypeMultiSelect, SettingsLineBotSection |
| Layout              | `src/frontend/components/layout/AppLayout.tsx` | Sidebar (collapsible sections, keyboard shortcuts), Top bar (breadcrumbs, Cmd+K search, notification bell, user dropdown), Mobile bottom tab bar                   |
| API Client          | `src/frontend/lib/api.ts`                      | Typed fetch wrapper with auth handling                                                                                                                             |
| Auth Hook           | `src/frontend/hooks/useAuth.ts`                | Login/logout/auth state                                                                                                                                            |
| SSE Hook            | `src/frontend/hooks/useSse.ts`                 | Real-time metrics updates                                                                                                                                          |
| Styles              | `src/frontend/index.css`                       | Tailwind CSS v4 with custom theme, animations, glass morphism                                                                                                      |

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

| Feature  | Description                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------ |
| Sidebar  | Collapsible sections (Menu / Administration), active glow indicator, hover shortcut keys (⌘1-⌘9) |
| Top Bar  | Breadcrumbs, Cmd+K quick search modal, notification bell, user avatar dropdown                   |
| Mobile   | Bottom tab bar (5 tabs), hamburger-less navigation                                               |
| Keyboard | `⌘B` toggle sidebar, `⌘K` quick search, `Esc` close modals                                       |
| Loading  | SkeletonTable / SkeletonCard on every data page                                                  |
| Empty    | EmptyState component with icon + action button                                                   |

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

ระบบใช้ DB-first settings เป็น feature flags หลัง startup seed สำเร็จ ส่วน process-local boot flags เช่น `HTTP_ENABLED` อยู่ใน Docker/service environment:

```
FETCH_DETAILS=true       → แสดงรายละเอียด trip ใน console
SAVE_TO_DB=true          → บันทึกลง MySQL
NOTIFY_ENABLED=true      → ส่ง notification
AUTO_ACCEPT_ENABLED=true → รับงานอัตโนมัติ
HTTP_ENABLED=true        → เปิด HTTP surface ของ role นั้น ๆ จาก service env
```

> [!info] Live Reload
> Settings แก้ไขผ่าน Web UI (`/settings`) → บันทึกลง DB → sync กลับเข้า `process.env` และ `env` object ทันที ยกเว้น process-local boot flags เช่น `HTTP_ENABLED`
> API credentials (COOKIE, DEVICE_ID, API_URL) อ่านจาก `env` ทุกครั้งที่ fetch — **ไม่ต้อง restart server**

> [!warning] Feature Dependencies
>
> - `SAVE_TO_DB`, `HTTP_ENABLED`, `AUTO_ACCEPT_ENABLED` ต้องการ DB config ทั้งหมด
> - `NOTIFY_ENABLED` ต้องการ LINE target/channel config หรือ `DISCORD_WEBHOOK_URL`
> - `HTTP_ENABLED` ต้องการ `JWT_SECRET`, `COOKIE_SECRET`, `ADMIN_PASSWORD`

## Runtime Roles

| Role                   | Starts HTTP                        | Runs pollers                   | Owns LINEJS                                  | Owns OCR                   | Typical production service    |
| ---------------------- | ---------------------------------- | ------------------------------ | -------------------------------------------- | -------------------------- | ----------------------------- |
| `notifier`             | yes, web API/dashboard             | no                             | yes, legacy local fallback                   | local OCR fallback         | legacy `notifier`             |
| `api`                  | yes, web API/dashboard             | no                             | no                                           | no                         | target `web-api`              |
| `notification-service` | yes, internal notification surface | no                             | no, calls `LINE_SERVICE_URL`                 | no                         | target `notification-service` |
| `line-service`         | yes, internal LINE surface         | no                             | yes                                          | optional remote OCR client | target `line-service`         |
| `ocr-service`          | yes, internal OCR surface          | no                             | no                                           | yes                        | target `ocr-service`          |
| `worker`               | no                                 | yes, limited by `RUN_TEAM_IDS` | no, publishes events to notification service | no                         | `worker-ifn`, `worker-ptwl`   |
| `combined`             | yes, web API/dashboard             | yes                            | yes                                          | local OCR fallback         | local/dev                     |

Workers publish signed internal events to `notifier` in legacy topology or `notification-service` in split topology. Runtime metrics use the same worker-to-notifier boundary, so admin/all-team telemetry reflects worker process state instead of notifier-local zero counters.

When `LINE_SERVICE_URL` is configured, dashboard-facing `/api/line-bot/*` routes use signed calls to `line-service` so the web API does not load or own local LINEJS state in split mode.

Health semantics:

- `/health` is shallow process-alive status.
- `/ready` is strict for the current service surface.
- Web API readiness does not fail just because downstream LINE/OCR services are degraded; those appear as downstream service health fields.
- Notification-service readiness fails if the required line-service endpoint is unreachable.
- Line-service readiness reports LINEJS/OCR degradation without serving dashboard routes, and OCR-service readiness reports provider configuration without exposing provider secrets.

## Supporting Layers

- [[env-reference|Config]] — `src/config/env.ts` — validation + .env loading
- [[database-schema|Database]] — `src/db/client.ts` — MySQL pool + Drizzle + auto-create tables
- **Repositories** — `src/repositories/*` — direct DB access layer
- **Services** — `src/services/*` — business logic layer
- **Utils** — `src/utils/*` — logging, hashing, error classification
