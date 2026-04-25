---
tags:
  - obsidian
  - spx
  - cheat-sheet
---

# SPX Cheat Sheet

## Quick start
```bash
npm install
npm run typecheck
npm run build
npm start
```

## Smoke test
```bash
npm run smoke:test
```

## Docker
```bash
docker compose up --build
```

## Key files
- `src/app.ts` — entry point
- `src/controllers/poller.ts` — worker loop
- `src/services/http-server.ts` — dashboard + API server
- `src/views/dashboard.ts` — dashboard HTML
- `src/public/dashboard.js` — dashboard client JS
- `src/config/env.ts` — env validation
- `src/db/client.ts` — DB pool and table creation
- `src/services/metrics.ts` — metrics snapshot
- `src/services/notify-rules.ts` — notification rules engine
- `src/services/notifier.ts` — Discord/LINE delivery
- `src/services/authz.ts` — role hierarchy

## Endpoints
- `GET /health`
- `GET /ready`
- `GET /metrics`
- `GET /assets/dashboard.js`

## Common env vars
- `API_URL`
- `COOKIE`
- `DEVICE_ID`
- `APP_NAME`
- `REFERER`
- `POLL_INTERVAL_MS`
- `HTTP_ENABLED`
- `HTTP_PORT`
- `HTTP_ALLOWED_ORIGINS`
- `DB_HOST`
- `DB_PORT`
- `DB_USERNAME`
- `DB_PASSWORD`
- `DB_NAME`

## Production cautions
- rate limit is in-memory
- settings save exits the process
- notification rules are file-based and single-instance oriented
- dashboard requires MySQL when `HTTP_ENABLED=true`
- settings secrets are redacted on read
- secrets should stay in `.env` or a secret manager
