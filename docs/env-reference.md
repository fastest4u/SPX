---
tags:
  - obsidian
  - spx
  - env
---

# Env Reference

## Required base values
- `API_URL`
- `COOKIE`
- `DEVICE_ID`
- `APP_NAME`
- `REFERER`

## Worker controls
- `POLL_INTERVAL_MS`
- `FETCH_DETAILS`
- `SAVE_TO_DB`
- `NOTIFY_ENABLED`
- `NOTIFY_MODE`
- `NOTIFY_MIN_TRIPS`
- `NOTIFY_ORIGINS`
- `NOTIFY_DESTINATIONS`
- `NOTIFY_VEHICLE_TYPES`

## Database
- `DB_HOST`
- `DB_PORT`
- `DB_USERNAME`
- `DB_PASSWORD`
- `DB_NAME`
- Required when either `SAVE_TO_DB=true` or `HTTP_ENABLED=true`

## Dashboard auth
- `HTTP_ENABLED`
- `HTTP_PORT`
- `HTTP_ALLOWED_ORIGINS` - comma-separated full browser origins allowed by CORS; localhost is always allowed
- `JWT_SECRET`
- `COOKIE_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_ROLE`

## Common production defaults
- `HTTP_PORT=3000`
- `NOTIFY_MODE=batch`
- `ADMIN_ROLE=admin`
- `HTTP_ALLOWED_ORIGINS=https://your-dashboard-domain.example`
- secrets should be long random values

## Validation rules
- URLs must be valid
- integer fields must be positive where required
- dashboard secrets must be at least 32 chars
- admin password must be strong enough
- CORS origins must be valid URLs
- `ADMIN_ROLE` must be `admin`, `editor`, or `viewer`
