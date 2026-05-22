---
title: 2026-05-21 - Restrict Codex image OCR output to five SPX fields
type: session-log
session-date: 2026-05-21
agent: codex
duration-minutes: 20
outcomes:
  - "Changed the default Codex image prompt to return only five fields: วันที่, ชื่อคนขับ, ชื่อ Agency, ประเภทรถ, เส้นทาง."
  - Added a prompt contract assertion in tests/codex-image-reader.test.ts.
  - Adjusted tests/ai-local-service-smoke.ts so real image smoke tests use the endpoint default prompt when no prompt argument is provided.
  - "Verified the real image C:\\Users\\Server\\Downloads\\35706.jpg now returns exactly the requested five-line output and preserves the full driver line."
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Restrict Codex image OCR output to five SPX fields

## TL;DR
- Changed the default Codex image prompt to return only five fields: วันที่, ชื่อคนขับ, ชื่อ Agency, ประเภทรถ, เส้นทาง.
- Added a prompt contract assertion in tests/codex-image-reader.test.ts.
- Adjusted tests/ai-local-service-smoke.ts so real image smoke tests use the endpoint default prompt when no prompt argument is provided.
- Verified the real image C:\Users\Server\Downloads\35706.jpg now returns exactly the requested five-line output and preserves the full driver line.

## Goal
Restrict Codex image OCR output to five SPX fields

## What Was Done
- Changed the default Codex image prompt to return only five fields: วันที่, ชื่อคนขับ, ชื่อ Agency, ประเภทรถ, เส้นทาง.
- Added a prompt contract assertion in tests/codex-image-reader.test.ts.
- Adjusted tests/ai-local-service-smoke.ts so real image smoke tests use the endpoint default prompt when no prompt argument is provided.
- Verified the real image C:\Users\Server\Downloads\35706.jpg now returns exactly the requested five-line output and preserves the full driver line.

## Files Touched
- src/services/codex-image-reader.ts
- tests/codex-image-reader.test.ts
- tests/ai-local-service-smoke.ts

## Decisions Made
- Keep the existing optional custom prompt behavior, but make the default image upload behavior produce only the user's requested five fields.
- Strengthen prompt wording to copy the full value after ชื่อคนขับ: without summarizing or truncating.

## Open Follow-ups
- [ ] Manually test /api/ai/read-image through a real authenticated browser/API session if this will be used from the dashboard.
- [ ] If the endpoint becomes production-critical, consider replacing Codex CLI auth with an explicit service credential.
- [ ] Consider a later switch from codexExec to createCodexAppServer if per-request startup becomes too slow.

## References
- 05_Agent_Session_Logs/2026-05-21-codex-auth-image-reading-api-prototype.md
- 05_Agent_Session_Logs/2026-05-21-local-service-smoke-test-for-codex-image-api.md
- 05_Agent_Session_Logs/2026-05-21-replace-image-reading-with-vercel-ai-sdk-codex-auth-provider.md

## Verification
npx tsx tests/codex-image-reader.test.ts passed; npm run typecheck passed; npx tsx tests/ai-local-service-smoke.ts "C:\Users\Server\Downloads\35706.jpg" returned only the five requested fields with the full driver line.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| The default image prompt can be changed to enforce a five-field response without changing the controller contract. | high | Implemented by updating DEFAULT_CODEX_IMAGE_PROMPT and keeping optional custom prompts unchanged. | A prompt contract test is enough to guard this behavior because the provider call itself is external and non-deterministic. |
| The first five-field prompt would preserve the full driver line. | medium | Real smoke test initially shortened/misread the driver value; prompt was strengthened to copy the entire value after ชื่อคนขับ:. | For OCR field extraction, prompts must explicitly say copy the whole field value and do not summarize. |
