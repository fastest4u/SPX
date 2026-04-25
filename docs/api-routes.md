---
title: API Routes
tags:
  - obsidian
  - spx
  - api
  - routes
aliases:
  - เส้นทาง API
---

# API Routes

## Route Map

> [!note] RBAC Hierarchy
> `viewer` < `editor` < `admin` — role ที่สูงกว่าสืบทอดสิทธิ์ทั้งหมดของ role ที่ต่ำกว่า

### Public (ไม่ต้อง login)

| Method | Path | Controller | หน้าที่ |
|--------|------|-----------|--------|
| `GET` | `/` | `dashboard-controller` | Dashboard HTML (ถ้ามี cookie) หรือ Login page |
| `GET` | `/health` | `dashboard-controller` | Health check — uptime, lastPoll, errorRate |
| `GET` | `/ready` | `dashboard-controller` | DB readiness — `SELECT 1` |
| `GET` | `/metrics` | `dashboard-controller` | Full MetricsSnapshot JSON |
| `GET` | `/metrics/history` | `dashboard-controller` | Historical metrics snapshots (persistent) |
| `POST` | `/api/login` | `auth-controller` | JWT cookie login |
| `POST` | `/api/logout` | `auth-controller` | Clear cookie |
| `POST` | `/api/refresh` | `auth-controller` | Refresh JWT token (extend session) |
| `GET` | `/api/me` | `auth-controller` | Current user info (id, username, role) |

### Viewer+ (ต้อง login)

| Method | Path | Controller | หน้าที่ |
|--------|------|-----------|--------|
| `GET` | `/api/history` | `history-controller` | Query booking history with filters |
| `GET` | `/api/reports/metrics.csv` | `report-controller` | Export metrics CSV |
| `GET` | `/api/reports/history.csv` | `report-controller` | Export history CSV |
| `GET` | `/api/reports/audit.csv` | `report-controller` | Export audit CSV |

### Editor+ (ต้องเป็น editor ขึ้นไป)

| Method | Path | Controller | หน้าที่ |
|--------|------|-----------|--------|
| `GET` | `/api/rules` | `rules-controller` | List all notification rules |
| `POST` | `/api/rules` | `rules-controller` | Create new rule |
| `GET` | `/api/rules/:id` | `rules-controller` | Get single rule |
| `PUT` | `/api/rules/:id` | `rules-controller` | Update rule |
| `DELETE` | `/api/rules/:id` | `rules-controller` | Delete rule |
| `POST` | `/api/notifications/preview` | `notify-controller` | Preview notification message |
| `POST` | `/api/notifications/test` | `notify-controller` | Send test notification |
| `POST` | `/api/bidding/accept` | `bidding-controller` | Manual booking accept |

### Admin Only

| Method | Path | Controller | หน้าที่ |
|--------|------|-----------|--------|
| `GET` | `/api/users` | `users-controller` | List all users |
| `POST` | `/api/users` | `users-controller` | Create user |
| `PUT` | `/api/users/:id/password` | `users-controller` | Change password |
| `PUT` | `/api/users/:id/role` | `users-controller` | Change role |
| `DELETE` | `/api/users/:id` | `users-controller` | Delete user |
| `GET` | `/api/settings` | `settings-controller` | Read current settings (secrets redacted) |
| `POST` | `/api/settings` | `settings-controller` | Save settings → restart server |
| `GET` | `/api/audit-logs` | `audit-controller` | Query audit logs |

## Security Features

> [!important] Security Stack
> - **Rate Limiting**: 120 req/min per IP (10 req/min for `/api/login`)
> - **JWT**: 1-day expiry, httpOnly cookie, signed, SameSite=strict
> - **Security Headers**: X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy
> - **CORS**: Localhost always allowed + configurable `HTTP_ALLOWED_ORIGINS`
> - **Password**: bcrypt hash, min 12 characters
> - **Audit Trail**: ทุกการกระทำสำคัญถูก log ลง `audit_logs` table

## Accept API (bidding-controller)

```json
POST /api/bidding/accept
{
  "bookingId": 12345,
  "requestIds": [67890, 67891],
  "confirm": true
}
```

> [!warning] ข้อควรระวัง
> - `confirm: true` เป็น required field — ป้องกันการ accept โดยไม่ตั้งใจ
> - ทุกการ accept ถูก log ลง audit ทั้ง success และ failure
> - ใช้ singleton `ApiClient` เพื่อ share headers/cookies

## History Query Parameters

```
GET /api/history?limit=200&search=NERC&origin=กรุงเทพ&destination=สุวรรณภูมิ&vehicleType=4ล้อ&sortBy=created_at&sortDir=desc
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 200 | จำนวนแถว (max 1000) |
| `search` | string | — | ค้นหาทุกฟิลด์ |
| `bookingId` | int | — | Filter by booking_id |
| `origin` | string | — | Filter ต้นทาง (LIKE) |
| `destination` | string | — | Filter ปลายทาง (LIKE) |
| `vehicleType` | string | — | Filter ประเภทรถ (LIKE) |
| `sortBy` | enum | `created_at` | `created_at` \| `request_id` |
| `sortDir` | enum | `desc` | `asc` \| `desc` |
