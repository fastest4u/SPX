---
tags:
  - obsidian
  - spx
  - deployment
---

# Deployment

## Local run
```bash
npm install
npm run typecheck
npm run build
npm start
```

If `HTTP_ENABLED=true` or `SAVE_TO_DB=true`, run migrations before startup:

```bash
npm run db:migrate
```

## Smoke test
```bash
npm run smoke:test
```

> App must already be running on `http://127.0.0.1:3000`

## Docker
```bash
docker compose up --build
```

## Docker image
- multi-stage build
- runtime image only contains built output
- healthcheck hits `/ready`

## Recommended production setup
- run under Docker or a process manager
- keep secrets outside version control
- use persistent MySQL
- run `npm run db:migrate` before starting a new release
- monitor `/health`, `/ready`, and `/metrics`
- keep `notify-rules.json` and `.env` under controlled write access
- set `HTTP_ALLOWED_ORIGINS` when accessing the dashboard from a non-localhost domain
- use `restart: unless-stopped`, PM2, systemd, or an orchestrator because settings save intentionally exits the process
- use `npm run build` for release verification because it includes TypeScript typecheck
