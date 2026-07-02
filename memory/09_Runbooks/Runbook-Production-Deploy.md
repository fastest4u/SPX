---
title: Runbook — Production Deploy / Auto-Deploy Failure
type: runbook
status: active
last-verified: 2026-07-02
verified-by: codex
source: file:docker-compose.yml + file:.github/workflows/deploy.yml + root AGENTS.md Deployments section
confidence: high
severity-when-applies: critical
related-adrs: []
created: 2026-05-13
updated: 2026-07-02
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
- Production service container in restart loop
- `GET /ready` returns 5xx or times out
- Application logs show "ECONNREFUSED" or unhandled errors on startup

## Pre-Flight Check

For normal planned pushes to `main`, start with [[Runbook-Deploy-Safety-Checklist]].

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
docker compose logs --tail=200 notifier worker-ifn worker-ptwl  # recent service logs
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
docker compose logs -f notifier worker-ifn worker-ptwl
# Look for: notifier /ready health, worker startup, and first poll success
```

## Verify

- [ ] `curl -s http://localhost:3000/ready` returns `200 OK`
- [ ] `docker compose ps` shows `notifier` as healthy and both workers running/healthy
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
- Safety checklist: [[Runbook-Deploy-Safety-Checklist]]
- Architecture: [[ADR-001-Dual-Storage-Notify-Rules]]
- Related mistakes: search `08_Mistakes/` for `area: deploy`

## Changelog

- **2026-05-13** — Initial version. Verified procedure matches current `docker-compose.yml`.
- **2026-07-02** — Updated service references for split runtime: `notifier`, `worker-ifn`, and `worker-ptwl`.
