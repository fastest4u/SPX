---
title: 2026-05-21 - Replace image reading with Vercel AI SDK Codex auth provider
type: session-log
session-date: 2026-05-21
agent: opencode
duration-minutes: 32
outcomes:
  - "Replaced manual Codex child-process orchestration in `src/services/codex-image-reader.ts` with Vercel AI SDK `generateText` and `ai-sdk-provider-codex-cli` using Codex auth."
  - "Kept existing `/api/ai/read-image` route behavior while passing image MIME type into the service."
  - "Installed `ai`, `ai-sdk-provider-codex-cli`, and `zod@4`; retained `@fastify/multipart` from the earlier image endpoint work."
  - Updated unit test expectations from CLI argv construction to AI SDK provider settings.
  - "Verified the API path through local Fastify smoke tests with both a sample PNG and `439805.jpg`."
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Replace image reading with Vercel AI SDK Codex auth provider

## TL;DR
- Replaced manual Codex child-process orchestration in `src/services/codex-image-reader.ts` with Vercel AI SDK `generateText` and `ai-sdk-provider-codex-cli` using Codex auth.
- Kept existing `/api/ai/read-image` route behavior while passing image MIME type into the service.
- Installed `ai`, `ai-sdk-provider-codex-cli`, and `zod@4`; retained `@fastify/multipart` from the earlier image endpoint work.
- Updated unit test expectations from CLI argv construction to AI SDK provider settings.
- Verified the API path through local Fastify smoke tests with both a sample PNG and `439805.jpg`.

## Goal
Replace image reading with Vercel AI SDK Codex auth provider

## What Was Done
- Replaced manual Codex child-process orchestration in `src/services/codex-image-reader.ts` with Vercel AI SDK `generateText` and `ai-sdk-provider-codex-cli` using Codex auth.
- Kept existing `/api/ai/read-image` route behavior while passing image MIME type into the service.
- Installed `ai`, `ai-sdk-provider-codex-cli`, and `zod@4`; retained `@fastify/multipart` from the earlier image endpoint work.
- Updated unit test expectations from CLI argv construction to AI SDK provider settings.
- Verified the API path through local Fastify smoke tests with both a sample PNG and `439805.jpg`.

## Files Touched
- package.json
- package-lock.json
- src/services/codex-image-reader.ts
- src/controllers/ai-controller.ts
- tests/codex-image-reader.test.ts
- tests/ai-local-service-smoke.ts

## Decisions Made
- Use `ai-sdk-provider-codex-cli` as the Codex auth integration instead of hand-built spawn logic.
- Use `codexExec` with `allowNpx`, `skipGitRepoCheck`, `approvalMode: never`, `sandboxMode: read-only`, and `logger: false`.
- Keep `CODEX_IMAGE_MODEL=gpt-5.5` as the local model setting.

## Open Follow-ups
- [ ] Consider a later switch from `codexExec` to `createCodexAppServer` if per-request process startup becomes too slow.

## References
- src/services/codex-image-reader.ts
- tests/ai-local-service-smoke.ts
- node_modules/ai-sdk-provider-codex-cli/README.md

## Verification
Watched updated unit test fail before implementation. Then `npx tsx tests/codex-image-reader.test.ts`, `npx tsx tests/ai-local-service-smoke.ts`, `npx tsx tests/ai-local-service-smoke.ts "C:\Users\Server\Desktop\SPX\439805.jpg" "อ่านรูปนี้ แล้วสรุปว่ามีอะไรในภาพ ตอบภาษาไทยแบบสั้น"`, `npm run typecheck`, and `npm run build` passed. Build still emits the existing Vite NODE_ENV warning; npm audit still reports 3 vulnerabilities and was not auto-fixed.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Vercel AI SDK Codex provider can replace the manual Codex spawn logic for the current image-reading endpoint. | high | Local smoke tests returned HTTP 200 for sample PNG and the real JPG after switching to `generateText` with `codexExec`. | Use community provider abstractions when available; they handle output capture/temp image handling better than project-specific spawn code. |
