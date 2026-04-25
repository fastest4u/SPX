---
tags:
  - obsidian
  - spx
  - production
  - cautions
---

# Production Cautions

## 1) Rate limit is in-memory
- resets on restart
- not shared across multiple instances
- expired buckets are cleaned up, but this is still per-process protection
- if scaling horizontally, move to shared storage

## 2) Settings page restarts process
- saving settings writes to `.env`
- process exits after save
- requires a process manager or container restart policy
- API responses redact secret values; leave masked values unchanged to keep existing secrets

## 3) Notification rules are file-based
- `notify-rules.json` is useful for single-instance setups
- writes are atomic, but concurrent writes from multiple app instances are still risky
- dashboard updates/deletes rules by stable rule `id`, not table row index
- DB-backed rules are better for scale

## 4) Dashboard depends on MySQL
- `HTTP_ENABLED=true` needs DB config even when `SAVE_TO_DB=false`
- users and audit logs are stored in MySQL
- `/ready` returns 503 if DB is unavailable

## 5) Smoke test is a deploy check, not a unit test
- it verifies readiness and static asset serving
- it does not replace automated unit/integration tests

## 6) Static assets should be built with app
- `npm run build` copies `src/public` to `dist/public`
- if build changes, verify assets still serve correctly

## 7) Secrets must stay out of notes and commits
- use `.env` locally
- use secret manager in production

## 8) Metrics endpoint is public
- `/metrics` is intended for monitoring
- expose it only on trusted networks or behind a reverse proxy rule if needed
