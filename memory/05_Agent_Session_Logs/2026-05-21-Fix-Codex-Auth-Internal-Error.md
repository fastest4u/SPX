---
title: 2026-05-21 - Fix SPX Codex auth INTERNAL_SERVER_ERROR handling
type: session-log
session-date: 2026-05-21
agent: cascade
duration-minutes: 8
outcomes:
  - Diagnosed SPX Codex login toast as backend /api/ai/codex-auth/start returning raw Fastify INTERNAL_SERVER_ERROR when OpenAI/Auth0 device-code start fails.
  - Added backend error mapping for Codex auth start failures so provider 5xx/network errors return 503 CODEX_AUTH_PROVIDER_UNAVAILABLE with a Thai operator-friendly message.
  - Updated Settings Codex login toast to show Thai guidance and suggest codex-cli fallback when the OpenAI/Codex login service is temporarily unavailable.
  - Verified with npm run typecheck.
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Fix SPX Codex auth INTERNAL_SERVER_ERROR handling

## TL;DR
- Diagnosed SPX Codex login toast as backend /api/ai/codex-auth/start returning raw Fastify INTERNAL_SERVER_ERROR when OpenAI/Auth0 device-code start fails.
- Added backend error mapping for Codex auth start failures so provider 5xx/network errors return 503 CODEX_AUTH_PROVIDER_UNAVAILABLE with a Thai operator-friendly message.
- Updated Settings Codex login toast to show Thai guidance and suggest codex-cli fallback when the OpenAI/Codex login service is temporarily unavailable.
- Verified with npm run typecheck.

## Goal
Fix SPX Codex auth INTERNAL_SERVER_ERROR handling

## What Was Done
- Diagnosed SPX Codex login toast as backend /api/ai/codex-auth/start returning raw Fastify INTERNAL_SERVER_ERROR when OpenAI/Auth0 device-code start fails.
- Added backend error mapping for Codex auth start failures so provider 5xx/network errors return 503 CODEX_AUTH_PROVIDER_UNAVAILABLE with a Thai operator-friendly message.
- Updated Settings Codex login toast to show Thai guidance and suggest codex-cli fallback when the OpenAI/Codex login service is temporarily unavailable.
- Verified with npm run typecheck.

## Files Touched
- src/controllers/ai-controller.ts
- src/frontend/routes/settings.tsx

## Decisions Made
- Keep the fix narrow: do not change auth tokens, OAuth constants, provider selection behavior, or production deployment.
- Treat INTERNAL_SERVER_ERROR/5xx/network failures from Codex auth start as provider-unavailable instead of leaking raw internal error text to the UI.

## Open Follow-ups
- [ ] If Codex auth remains unstable for production LINE image OCR, switch production usage from Codex device/CLI auth to an explicit OpenAI API key or service credential.
- [ ] User should choose when to commit/deploy these changes; no commit or deploy was performed.

## References
- src/controllers/ai-controller.ts
- src/frontend/routes/settings.tsx
- npm run typecheck

## Verification
npm run typecheck passed.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
