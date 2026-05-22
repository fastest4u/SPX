---
title: "2026-05-22 - SPX critical security and rules-engine refactor — remove search-only mode + harden auth, secrets, CSP, CORS, CSV, deploy"
type: session-log
session-date: 2026-05-22
agent: kiro-claude
duration-minutes: 35
outcomes:
  - "Phase A: removed search-only feature; every enabled rule auto-accepts."
  - "Phase B: fixed 14 critical issues (auth/CSRF/CORS/CSP/CSV-injection/timeouts/secrets-at-rest/deploy-rollback)."
  - npm run typecheck passes.
  - "npm run build passes (dist bundle clean)."
created: 2026-05-22
updated: 2026-05-22
tags:
  - session-log
  - project/general
---
# 2026-05-22 - SPX critical security and rules-engine refactor — remove search-only mode + harden auth, secrets, CSP, CORS, CSV, deploy

## TL;DR
- Phase A: removed search-only feature; every enabled rule auto-accepts.
- Phase B: fixed 14 critical issues (auth/CSRF/CORS/CSP/CSV-injection/timeouts/secrets-at-rest/deploy-rollback).
- npm run typecheck passes.
- npm run build passes (dist bundle clean).

## Goal
SPX critical security and rules-engine refactor — remove search-only mode + harden auth, secrets, CSP, CORS, CSV, deploy

## What Was Done
- Phase A: removed search-only feature; every enabled rule auto-accepts.
- Phase B: fixed 14 critical issues (auth/CSRF/CORS/CSP/CSV-injection/timeouts/secrets-at-rest/deploy-rollback).
- npm run typecheck passes.
- npm run build passes (dist bundle clean).

## Files Touched
- src/services/notify-rules.ts
- src/controllers/rules-controller.ts
- src/frontend/types/index.ts
- src/frontend/components/CreateRuleDialog.tsx
- src/frontend/components/EditRuleDialog.tsx
- src/frontend/lib/api.ts
- src/repositories/booking-history-repository.ts
- src/repositories/user-repository.ts
- src/controllers/auth-controller.ts
- src/repositories/jwt-blacklist-repository.ts
- src/services/http-server.ts
- src/controllers/dashboard-controller.ts
- src/controllers/report-controller.ts
- src/services/api-client.ts
- src/services/notifier.ts
- src/utils/crypto.ts
- src/services/line-bot.ts
- src/repositories/line-bot-session-repository.ts
- src/repositories/app-settings-repository.ts
- src/services/settings.ts
- .github/workflows/deploy.yml

## Decisions Made
- Removed search-only mode: every enabled rule auto-accepts. auto_accept field kept on the wire for backward compat, removed from UI/input.
- Authenticated /metrics, /metrics/history, /events, /line-quota; gated /system/pause and /system/resume to admin role; kept /health and /ready public.
- Replaced CSP unsafe-inline script with per-request nonce; tightened CSP with frame-ancestors none, base-uri self, object-src none.
- Strict CORS in production: localhost is only allowed when NODE_ENV != production.
- Login response no longer returns the JWT body. Added jti-based server-side revocation via jwt_blacklist table (memory-mode supported).
- Default admin password no longer baked in. createAdminUserIfNotExists requires explicit username/password >=12 chars. bcrypt rounds bumped to 12.
- CSV exports prefix dangerous leading characters (=+-@\t\r) with apostrophe to block formula injection.
- Outbound fetch (api-client + notifier) wrapped with AbortSignal timeouts (15s default, 10s for accept, 5s for line quota).
- Booking history insert routes through Drizzle in DB_MODE=memory; mysql2 path retains INSERT IGNORE batch.
- Settings writes validated via validateRuntimeConfig before persist; live reload logs validation errors instead of silently corrupting env.
- Secrets-at-rest (LINE bot session DB, line bot auth token file, app_settings COOKIE/tokens) now AES-256-GCM via SECRETS_KEY (or JWT_SECRET+COOKIE_SECRET fallback).
- Deploy workflow runs migrations before container swap, builds before bringing up new containers, and rolls back to previous commit on health check failure.

## Open Follow-ups
- [ ] After deploy: re-login LINE bot QR (auth-token format changed to encrypted-at-rest)
- [ ] After deploy: re-paste SPX COOKIE in Settings UI so it persists encrypted
- [ ] Set SECRETS_KEY env var in production (>=16 chars) to decouple secret encryption from JWT/COOKIE secret rotation
- [ ] Frontend SSE/UI: confirm /metrics now requires auth — adjust unauthenticated dashboard panels accordingly
- [ ] Add automated test for rule CRUD without auto_accept field

## References
- None

## Verification
npm run typecheck (pass), npm run build (pass)

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
