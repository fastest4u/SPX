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
>
> - โหลดอัตโนมัติผ่าน `src/config/env.ts` สำหรับ bootstrap/process identity เท่านั้น
> - Runtime/operator settings โหลดจาก `app_settings` หลังเชื่อมต่อ DB
> - แก้ไขค่า runtime ผ่าน Settings UI และ Teams UI แทนการแก้ `.env`; process-local boot flags and peer service client settings such as `HTTP_ENABLED` and `LINE_SERVICE_URL` stay in Docker/service environment

## Bootstrap Env

These values remain in `.env`: `NODE_ENV`, `DB_MODE`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `SECRETS_KEY`.

## Database

| Variable      | Type   | Default | Required When                                |
| ------------- | ------ | ------- | -------------------------------------------- |
| `DB_HOST`     | string | —       | DB-backed runtime config, dashboard, workers |
| `DB_PORT`     | int    | `3306`  | —                                            |
| `DB_USERNAME` | string | —       | DB-backed runtime config, dashboard, workers |
| `DB_PASSWORD` | string | —       | DB-backed runtime config, dashboard, workers |
| `DB_NAME`     | string | —       | DB-backed runtime config, dashboard, workers |
| `SECRETS_KEY` | string | —       | Encrypt/decrypt DB-backed secrets            |

## Process Identity Env

These values remain in Docker/service environment: `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_ENABLED`, `HTTP_PORT`, `LINE_SERVICE_URL`, `LINE_SERVICE_SEND_SECRET`, `LINE_SERVICE_ADMIN_SECRET`, `LINE_SERVICE_REQUEST_TIMEOUT_MS`, `OCR_SERVICE_URL`, `OCR_SERVICE_REQUEST_TIMEOUT_MS`.

| Variable                          | Description                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `SPX_ROLE`                        | Process role: `api`, `worker`, `notifier`, `combined`, `notification-service`, `line-service`, or `ocr-service` |
| `SPX_NODE_ID`                     | Stable runtime node id for health/status tracking                                                               |
| `SPX_NODE_NAME`                   | Optional display name for the runtime node                                                                      |
| `RUN_TEAM_IDS`                    | Comma-separated team ids assigned to a worker process                                                           |
| `NOTIFIER_API_URL`                | Worker-to-notifier internal notification endpoint                                                               |
| `NOTIFIER_LOCAL_SPOOL_PATH`       | Local retry spool path for worker notification events                                                           |
| `HTTP_ENABLED`                    | Process-local HTTP boot flag; keep `false` for workers and `true` for HTTP surfaces                             |
| `HTTP_PORT`                       | Fastify HTTP port for the notifier/dashboard process                                                            |
| `LINE_SERVICE_URL`                | Process-local URL for callers that must reach split `line-service`                                              |
| `LINE_SERVICE_SEND_SECRET`        | Process-local notification-service-to-line-service send signing secret; keep off DB-backed shared settings      |
| `LINE_SERVICE_ADMIN_SECRET`       | Process-local web-api-to-line-service admin/status signing secret; keep off DB-backed shared settings           |
| `LINE_SERVICE_REQUEST_TIMEOUT_MS` | Process-local timeout for signed calls to split `line-service`                                                  |
| `OCR_SERVICE_URL`                 | Process-local URL for callers that must reach split `ocr-service`                                               |
| `OCR_SERVICE_REQUEST_TIMEOUT_MS`  | Process-local timeout for signed calls to split `ocr-service`                                                   |

HTTP surface by role:

| Role                   | HTTP Surface                  | Notes                                                                                               |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `api`                  | web API/dashboard             | Serves dashboard, public health/readiness, authenticated API routes, and SPA assets                 |
| `notifier`             | web API/dashboard             | Legacy compatibility role; also runs notification dispatch                                          |
| `combined`             | web API/dashboard             | Local/development role that keeps current all-in-one behavior                                       |
| `worker`               | none                          | Does not expose HTTP; publishes to `NOTIFIER_API_URL`                                               |
| `notification-service` | internal notification service | Exposes signed notification intake, runtime metrics intake, and health/readiness                    |
| `line-service`         | internal LINE service         | Exposes signed LINE send/status/admin routes plus health/readiness; does not serve dashboard routes |
| `ocr-service`          | internal OCR service          | Exposes signed LINE image OCR route plus health/readiness; does not serve dashboard routes          |

`SPX_NODE_ID` is required for distributed roles: `worker`, `notifier`, `notification-service`, `line-service`, and `ocr-service`. Dashboard auth settings such as `JWT_SECRET`, `COOKIE_SECRET`, and `ADMIN_PASSWORD` are required only for roles that expose the web API/dashboard surface.

For split-service production, each running process must have a unique `SPX_NODE_ID`, including each worker machine. Keep `RUN_TEAM_IDS` explicit and non-overlapping by default; for example, `worker-ifn` can run `RUN_TEAM_IDS=2` while `worker-ptwl` runs `RUN_TEAM_IDS=1`.

Internal service URLs:

| Variable                          | Used By                                    | Example                                                                                                                                              |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFIER_API_URL`                | workers                                    | `http://notification-service:3002/internal/notification-events` in split mode, or `http://notifier:3000/internal/notification-events` in legacy mode |
| `LINE_SERVICE_URL`                | notification-service, web API proxy routes | `http://line-service:3003`                                                                                                                           |
| `LINE_SERVICE_SEND_SECRET`        | web API, notification-service, and line-service | generated per split cutover                                                                                                                     |
| `LINE_SERVICE_ADMIN_SECRET`       | web API and line-service only             | generated per split cutover                                                                                                                         |
| `LINE_SERVICE_REQUEST_TIMEOUT_MS` | notification-service, web API proxy routes | `1500`                                                                                                                                               |
| `OCR_SERVICE_URL`                 | line-service                               | `http://ocr-service:3004`                                                                                                                            |
| `OCR_SERVICE_REQUEST_TIMEOUT_MS`  | line-service                               | `305000`                                                                                                                                             |

Split-service internal endpoints:

| Surface                | Endpoints                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification-service` | `POST /internal/notification-events`, `POST /internal/runtime-metrics`                                                                                                                                              |
| `line-service`         | `POST /internal/line/messages`, `POST /internal/line/status`, `POST /internal/line/login`, `POST /internal/line/groups`, `POST /internal/line/profile`, `POST /internal/line/storage`, `POST /internal/line/logout` |
| `ocr-service`          | `POST /internal/ocr/line-image`                                                                                                                                                                                     |

Worker-to-notification-service endpoints use `NOTIFIER_SHARED_SECRET`. Notification-service-to-line-service sends and the authenticated web API `/api/line-bot/send` proxy use `LINE_SERVICE_SEND_SECRET`, so workers cannot bypass the notification outbox and call LINE send directly with the worker notification secret. LINE status/admin endpoints use `LINE_SERVICE_ADMIN_SECRET` so workers and notification-service cannot spoof web-api admin actions with the shared notification secret. Public `/health` and `/ready` remain available on every HTTP surface for process and readiness checks.

When `LINE_SERVICE_URL` is configured, the web API's authenticated `/api/line-bot/*` routes proxy through the split `line-service` instead of loading local LINEJS state. Legacy local LINEJS fallback is used only when `LINE_SERVICE_URL` is unset.

Only the web API/dashboard service should be published publicly. Keep notification, LINE, and OCR service ports on the internal Docker network unless an operator explicitly exposes them on a private admin network.

## DB-First Settings

Operator settings such as `POLL_INTERVAL_MS`, `API_URL`, `AUTO_ACCEPT_ENABLED`, notification settings, internal notifier auth settings, dashboard auth signing secrets, and provider settings are stored in `app_settings`.

Important DB-first keys include:

| Setting                                                                                      | Purpose                                  |
| -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `API_URL`, `APP_NAME`, `REFERER`                                                             | SPX upstream request shape               |
| `POLL_INTERVAL_MS`, `FETCH_DETAILS`, `SAVE_TO_DB`, `AUTO_ACCEPT_ENABLED`                     | Polling and auto-accept behavior         |
| `JWT_SECRET`, `COOKIE_SECRET`, `ADMIN_*`, `HTTP_ALLOWED_ORIGINS`, `HTTP_TRUST_PROXY`         | Dashboard auth and HTTP runtime settings |
| `NOTIFIER_SHARED_SECRET`, `NOTIFIER_AUTH_MODE`                                               | Signed internal API auth                 |
| `NOTIFIER_REQUEST_TIMEOUT_MS`, `NOTIFIER_RETRY_MAX_ATTEMPTS`, `NOTIFIER_RETRY_BASE_DELAY_MS` | Worker publish timeout/retry behavior    |
| `LINE_CHANNEL_ACCESS_TOKEN`, `LINEJS_*`, `DISCORD_WEBHOOK_URL`                               | Notification providers                   |
| `CODEX_IMAGE_*`, `LINE_IMAGE_LISTENER_CHAT_ID`                                               | LINE image/OCR integration               |

Process identity keys such as `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_ENABLED`, `HTTP_PORT`, `LINE_SERVICE_URL`, `LINE_SERVICE_SEND_SECRET`, `LINE_SERVICE_ADMIN_SECRET`, `LINE_SERVICE_REQUEST_TIMEOUT_MS`, `OCR_SERVICE_URL`, and `OCR_SERVICE_REQUEST_TIMEOUT_MS` are intentionally not DB-first keys. They are process-local so workers can boot with `HTTP_ENABLED=false`, HTTP roles can boot with their own surfaces enabled, and each service role can keep its own identity, worker assignment, internal peer URLs, split LINE send/admin credentials, and bounded peer-call timeouts without mutating shared `app_settings`.

Team-scoped SPX credentials and LINE targets are stored encrypted on each `teams` row. Do not keep `COOKIE`, `DEVICE_ID`, `LINE_USER_ID`, or auto-accept success/failure LINE targets as global runtime env after migration.

Before removing legacy runtime values from production `.env`, deploy the DB-first build once with the old `.env` still present. Startup seeds missing `app_settings` rows from env, then later boots can run with only bootstrap/process env.

## Validation Rules

- URLs ต้องเป็น valid URL format
- Integer fields ต้องเป็นตัวเลขตาม contract ของแต่ละค่า; ส่วนใหญ่ต้องเป็นค่าบวก แต่บางค่าอนุญาต `0` หรือค่าว่างตาม `src/config/env.ts`
- Dashboard secrets (`JWT_SECRET`, `COOKIE_SECRET`) ต้อง ≥ 32 characters
- Admin password ต้องแข็งแรงเพียงพอ
- CORS origins ต้องเป็น valid URLs
- `ADMIN_ROLE` ต้องเป็น `admin` หรือ `user`

## ดูเพิ่มเติม

- [[architecture]] — Feature flag system
- [[deployment]] — Production .env template
- [[production-cautions]] — ข้อควรระวังเรื่อง secrets
