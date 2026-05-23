---
title: 2026-05-21 - Codex-auth image-reading API prototype
type: session-log
session-date: 2026-05-21
agent: opencode
duration-minutes: 25
outcomes:
  - Added authenticated POST /api/ai/read-image endpoint that accepts multipart images and shells out to Codex CLI using existing codex auth.
  - "Implemented Codex image reader service with read-only sandbox, ephemeral sessions, output-last-message capture, image MIME allowlist, timeout, and temp file cleanup."
  - Installed @fastify/multipart and registered it in the Fastify server.
  - Added a small node assert test for command construction and MIME validation.
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Codex-auth image-reading API prototype

## TL;DR
- Added authenticated POST /api/ai/read-image endpoint that accepts multipart images and shells out to Codex CLI using existing codex auth.
- Implemented Codex image reader service with read-only sandbox, ephemeral sessions, output-last-message capture, image MIME allowlist, timeout, and temp file cleanup.
- Installed @fastify/multipart and registered it in the Fastify server.
- Added a small node assert test for command construction and MIME validation.

## Goal
Codex-auth image-reading API prototype

## What Was Done
- Added authenticated POST /api/ai/read-image endpoint that accepts multipart images and shells out to Codex CLI using existing codex auth.
- Implemented Codex image reader service with read-only sandbox, ephemeral sessions, output-last-message capture, image MIME allowlist, timeout, and temp file cleanup.
- Installed @fastify/multipart and registered it in the Fastify server.
- Added a small node assert test for command construction and MIME validation.

## Files Touched
- package.json
- package-lock.json
- src/config/env.ts
- src/services/http-server.ts
- src/controllers/ai-controller.ts
- src/services/codex-image-reader.ts
- tests/codex-image-reader.test.ts

## Decisions Made
- Use Codex CLI auth via `codex exec` only as a prototype integration; no token files are read by the app.
- Expose the image read endpoint under authenticated user API scope at `/api/ai/read-image`.
- Use `--output-last-message` so API responses return the final model message instead of Codex CLI banners/logs.

## Open Follow-ups
- [ ] Manually test `/api/ai/read-image` with a real authenticated browser/API session and sample image.
- [ ] If this endpoint becomes production-critical, replace Codex CLI auth with an explicit OpenAI API key/service credential.

## References
- src/services/codex-image-reader.ts
- src/controllers/ai-controller.ts
- src/services/http-server.ts

## Verification
`npx tsx tests/codex-image-reader.test.ts`, `npm run typecheck`, and `npm run build` passed. `codex exec --ephemeral --sandbox read-only "Reply only with OK"` verified Codex CLI auth works, but emitted a deprecation warning for codex_hooks config.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Codex CLI auth can be used by spawning `codex exec` without reading auth token files directly. | medium | Verified with a simple `codex exec` command returning OK. | Use Codex CLI as an integration boundary for prototypes, but capture final output via `--output-last-message` because stdout contains banners/logs. |
