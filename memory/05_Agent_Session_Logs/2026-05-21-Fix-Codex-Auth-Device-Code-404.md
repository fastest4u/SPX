---
title: 2026-05-21 - Fix SPX Codex auth device-code 404
type: session-log
session-date: 2026-05-21
agent: cascade
duration-minutes: 4
outcomes:
  - "Diagnosed screenshot error as SPX still calling the direct Auth0 device-code endpoint, which returned 404."
  - "Checked current Codex auth docs: browser ChatGPT login returns an auth URL, while device-code flow is handled through Codex app-server APIs rather than this direct endpoint."
  - Changed /api/ai/codex-auth/start to use the existing browser OAuth startCodexDeviceAuth flow instead of startDeviceCodeAuth.
  - Verified with npm run typecheck.
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Fix SPX Codex auth device-code 404

## TL;DR
- Diagnosed screenshot error as SPX still calling the direct Auth0 device-code endpoint, which returned 404.
- Checked current Codex auth docs: browser ChatGPT login returns an auth URL, while device-code flow is handled through Codex app-server APIs rather than this direct endpoint.
- Changed /api/ai/codex-auth/start to use the existing browser OAuth startCodexDeviceAuth flow instead of startDeviceCodeAuth.
- Verified with npm run typecheck.

## Goal
Fix SPX Codex auth device-code 404

## What Was Done
- Diagnosed screenshot error as SPX still calling the direct Auth0 device-code endpoint, which returned 404.
- Checked current Codex auth docs: browser ChatGPT login returns an auth URL, while device-code flow is handled through Codex app-server APIs rather than this direct endpoint.
- Changed /api/ai/codex-auth/start to use the existing browser OAuth startCodexDeviceAuth flow instead of startDeviceCodeAuth.
- Verified with npm run typecheck.

## Files Touched
- src/controllers/ai-controller.ts

## Decisions Made
- Use the existing browser OAuth flow as the smallest safe fix for device-code 404; do not change token storage, OAuth constants, or provider behavior.

## Open Follow-ups
- [ ] User should restart/reload the SPX backend/frontend and test Codex Login again from Settings.
- [ ] If browser OAuth also proves unstable in production, replace Codex auth dependency with an explicit OpenAI API key/service credential for LINE image OCR.
- [ ] No commit or deploy was performed.

## References
- src/controllers/ai-controller.ts
- Codex docs /openai/codex account/login/start
- npm run typecheck

## Verification
npm run typecheck passed.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
