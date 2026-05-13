---
title: Runbook — Production Deploy / Auto-Deploy Failure
type: runbook
status: active
last-verified: 2026-05-13
verified-by: human
source: file:docker-compose.yml + root AGENTS.md Deployments section
confidence: high
severity-when-applies: critical
related-adrs: []
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Runbook-Production-Deploy
  - Deploy Runbook
tags:
  - runbook
  - project/spx
  - area/deploy
  - topic/docker
---

# Runbook — Production Deploy / Auto-Deploy Failure

> [!important] Production Server
> `root@45.83.207.139` — Docker Compose at `/root/SPX/docker-compose.yml`

## Symptoms (When to use this runbook)

- Push to `main` succeeded locally but production didn't update
- Production container in restart loop
- `GET /ready` returns 5xx or times out
- Application logs show "ECONNREFUSED" or unhandled errors on startup

## Pre-Flight Check

```bash
# Verify your changes are pushed
git status
git log -1 origin/main --oneline

# Confirm last successful deploy was working
ssh root@45.83.207.139 'docker ps --filter "name=spx" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
```

## Procedure

### 1. SSH to server

```bash
ssh root@45.83.207.139
cd /root/SPX
```

### 2. Inspect deploy state

```bash
git log -1 --oneline               # what commit is checked out?
git fetch origin
git log HEAD..origin/main --oneline  # any commits pending pull?
docker compose ps                   # are containers running?
docker compose logs --tail=200 app  # recent app logs
```

### 3. Manual git pull (if auto-pull failed)

```bash
git pull --ff-only origin main
```

### 4. Rebuild + restart

```bash
docker compose down
docker compose up -d --build
```

### 5. Tail logs to confirm clean startup

```bash
docker compose logs -f app
# Look for: "Server listening on port 3000" + first poll success
```

## Verify

- [ ] `curl -s http://localhost:3000/ready` returns `200 OK`
- [ ] `docker compose ps` shows `app` as `healthy`
- [ ] Discord/LINE receives first poll within `POLL_INTERVAL_MS`
- [ ] No `ERROR` in logs for 60 seconds

## Rollback (if new deploy is broken)

```bash
# Find last good commit
git log --oneline -10

# Checkout previous version
git checkout <previous-good-sha>

# Force rebuild
docker compose down
docker compose up -d --build

# After fix, return to main
git checkout main
```

## Common Failures

| Symptom | Likely Cause | Fix |
|---|---|---|
| `Cannot find module '...'` on startup | `npm ci` failed or `dist/` not rebuilt | Force `--no-cache` rebuild |
| `ECONNREFUSED mysql` | DB host down or wrong env | Check `.env`, verify MySQL container/host |
| `notify-rules.json EBUSY` | Docker overlay lock | See [[ADR-001-Dual-Storage-Notify-Rules]] |
| Container starts then exits | Migration failed | Run `db-migrate.js` manually inside container |
| Health check fails | `/ready` route broken | Check `src/services/http-server.ts` |

## References

- Root `AGENTS.md` → Deployments section
- Architecture: [[ADR-001-Dual-Storage-Notify-Rules]]
- Related mistakes: search `08_Mistakes/` for `area: deploy`

## Changelog

- **2026-05-13** — Initial version. Verified procedure matches current `docker-compose.yml`.
