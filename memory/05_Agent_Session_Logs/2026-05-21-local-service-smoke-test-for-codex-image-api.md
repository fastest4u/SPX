---
title: 2026-05-21 - Local service smoke test for Codex image API
type: session-log
session-date: 2026-05-21
agent: opencode
duration-minutes: 18
outcomes:
  - "Added and ran a local-only Fastify smoke test for `/api/ai/read-image`."
  - "Verified `CODEX_IMAGE_MODEL=gpt-5.5` works with local Codex CLI auth."
  - "Fixed Windows spawning by using the Codex JS entrypoint through Node instead of spawning `codex.cmd` directly."
  - "Fixed Codex CLI prompt/image argument order and added `--add-dir` for the temp image folder so the read-only sandbox can access uploaded images."
  - "Local service smoke test returned HTTP 200 with text `OK`."
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Local service smoke test for Codex image API

## TL;DR
- Added and ran a local-only Fastify smoke test for `/api/ai/read-image`.
- Verified `CODEX_IMAGE_MODEL=gpt-5.5` works with local Codex CLI auth.
- Fixed Windows spawning by using the Codex JS entrypoint through Node instead of spawning `codex.cmd` directly.
- Fixed Codex CLI prompt/image argument order and added `--add-dir` for the temp image folder so the read-only sandbox can access uploaded images.
- Local service smoke test returned HTTP 200 with text `OK`.

## Goal
Local service smoke test for Codex image API

## What Was Done
- Added and ran a local-only Fastify smoke test for `/api/ai/read-image`.
- Verified `CODEX_IMAGE_MODEL=gpt-5.5` works with local Codex CLI auth.
- Fixed Windows spawning by using the Codex JS entrypoint through Node instead of spawning `codex.cmd` directly.
- Fixed Codex CLI prompt/image argument order and added `--add-dir` for the temp image folder so the read-only sandbox can access uploaded images.
- Local service smoke test returned HTTP 200 with text `OK`.

## Files Touched
- .env
- src/services/codex-image-reader.ts
- tests/codex-image-reader.test.ts
- tests/ai-local-service-smoke.ts

## Decisions Made
- Use `CODEX_IMAGE_MODEL=gpt-5.5` in local `.env`.
- Keep using Codex CLI as the callable boundary because opencode agent/runtime auth is not exposed as a stable backend service interface.

## Open Follow-ups
- [ ] If the user wants to avoid Codex CLI entirely, evaluate either explicit OpenAI API key integration or a custom opencode bridge/plugin/app-server approach.

## References
- src/services/codex-image-reader.ts
- tests/ai-local-service-smoke.ts

## Verification
`codex exec --ephemeral --sandbox read-only --model gpt-5.5 "Reply only with OK"` passed. `npx tsx tests/codex-image-reader.test.ts`, `npx tsx tests/ai-local-service-smoke.ts`, `npm run typecheck`, and `npm run build` passed. Build still reports existing Vite NODE_ENV warning.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| The Fastify endpoint works as a local service with Codex CLI and gpt-5.5. | high | Local smoke test returned HTTP 200 and `OK`. | Codex CLI image calls on Windows need Node entrypoint spawning, prompt before image args, and `--add-dir` for temp files under read-only sandbox. |
