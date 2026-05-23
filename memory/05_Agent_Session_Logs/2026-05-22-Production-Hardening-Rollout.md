---
title: "2026-05-22 - SPX production hardening rollout — set SECRETS_KEY, fix deploy workflow, dual-env templates, verify LINEJS auto-accept on production"
type: session-log
session-date: 2026-05-22
agent: kiro-claude
duration-minutes: 45
outcomes:
  - "Production live on commit 25e0d4f with SECRETS_KEY set, container healthy, /health returns ok, errorRate 0%"
  - "Deploy workflow no longer aborts at db:migrate — compose CMD handles it inside the running container"
  - "Local dev .env can run against production DB without competing with the prod poller (verified by reading the file back, all destructive flags = false)"
  - "LINEJS auto-accept notification path confirmed working on production: 3/3 test sends succeeded with average ~1s latency, including E2EE-off graceful fallback"
  - "Auto-accept history shows real successful auto-accepts as recent as 11:58 today (booking 2504099), proving the full pipeline (poll → accept → history → LINEJS notify) is alive"
created: 2026-05-22
updated: 2026-05-22
tags:
  - session-log
  - project/general
---
# 2026-05-22 - SPX production hardening rollout — set SECRETS_KEY, fix deploy workflow, dual-env templates, verify LINEJS auto-accept on production

## TL;DR
- Production live on commit 25e0d4f with SECRETS_KEY set, container healthy, /health returns ok, errorRate 0%
- Deploy workflow no longer aborts at db:migrate — compose CMD handles it inside the running container
- Local dev .env can run against production DB without competing with the prod poller (verified by reading the file back, all destructive flags = false)
- LINEJS auto-accept notification path confirmed working on production: 3/3 test sends succeeded with average ~1s latency, including E2EE-off graceful fallback
- Auto-accept history shows real successful auto-accepts as recent as 11:58 today (booking 2504099), proving the full pipeline (poll → accept → history → LINEJS notify) is alive

## Goal
SPX production hardening rollout — set SECRETS_KEY, fix deploy workflow, dual-env templates, verify LINEJS auto-accept on production

## What Was Done
- Production live on commit 25e0d4f with SECRETS_KEY set, container healthy, /health returns ok, errorRate 0%
- Deploy workflow no longer aborts at db:migrate — compose CMD handles it inside the running container
- Local dev .env can run against production DB without competing with the prod poller (verified by reading the file back, all destructive flags = false)
- LINEJS auto-accept notification path confirmed working on production: 3/3 test sends succeeded with average ~1s latency, including E2EE-off graceful fallback
- Auto-accept history shows real successful auto-accepts as recent as 11:58 today (booking 2504099), proving the full pipeline (poll → accept → history → LINEJS notify) is alive

## Files Touched
- .env
- .env.example
- .env.test
- .env.prod-backup
- .gitignore
- .github/workflows/deploy.yml
- /root/SPX/.env (production, via SSH)
- /root/SPX/.env.bak.* (production backup)

## Decisions Made
- Production .env: keep prod-side, append SECRETS_KEY (96-char hex random) + .env.bak.<timestamp> backup taken on server before edit
- Local .env: rewritten as dev-safe profile that connects to PRODUCTION MySQL (read live data) but with FETCH_DETAILS/SAVE_TO_DB/NOTIFY/AUTO_ACCEPT/LINEJS_TEST = false so the dev process never competes with the production poller
- Local secrets (JWT_SECRET / COOKIE_SECRET / SECRETS_KEY) are pulled from production .env via SSH so encrypted-at-rest values (LINE bot session, app_settings COOKIE) decrypt correctly in dev
- Local backup of previous prod .env saved as .env.prod-backup, gitignored alongside .env.*.backup
- Deploy workflow: dropped external 'docker compose run --rm app npm run db:migrate' step (production runtime image is dev-deps stripped, tsc was missing). Compose CMD already runs `db:migrate && app.js`, so single `compose up -d` is enough.
- deploy.yml now also rolls back source on `compose build` failure, in addition to the existing health-check rollback
- .env.example and .env.test updated to include SECRETS_KEY and document the AES-256-GCM fallback to JWT_SECRET+COOKIE_SECRET
- Verified LINEJS auto-accept channel end-to-end: POST /api/notifications/test → notifier.sendNotificationMessage → sendLineJsThenOa → @evex/linejs sendMessage. Three test rounds, HTTP 200 each, logs show notification-linejs-sent to groupMid c0...c858 with 981–1094ms latency
- E2EE-disabled groups fall back to plain text automatically (line-bot-e2ee-fallback-plain), confirming the existing fallback path works

## Open Follow-ups
- [ ] Login Settings UI on production and re-save SPX COOKIE so it lands encrypted at rest (currently still plaintext from migrateEnvSettingsToDb seed)
- [ ] Confirm LINE group c0...c858 received the three test messages sent at ~00:12 ICT 23 May 2026
- [ ] Consider promoting NODE_ENV=production guard so isProduction() in settings.ts cannot drift accidentally — right now any process.env.NODE_ENV mutation flips precedence rules
- [ ] Document in runbook: production .env now has SECRETS_KEY; rotating SECRETS_KEY invalidates encrypted LINE bot session + app_settings secrets (must re-paste through Settings UI)
- [x] PR #33 (chore: deploy workflow + env templates) merged → 25e0d4f deployed and healthy. No further deploy work needed unless workflow changes again.

## References
- src/services/notifier.ts
- src/services/line-bot.ts
- src/services/notify-controller.ts
- src/services/settings.ts
- src/utils/crypto.ts
- .github/workflows/deploy.yml
- memory/05_Agent_Session_Logs/2026-05-22-SPX-Security-Rules-Engine-Refactor.md

## Verification
npm run typecheck (pass), production /health (ok, errorRate 0), curl POST /api/notifications/test (HTTP 200 ×3 with notification-linejs-sent in app logs)

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
