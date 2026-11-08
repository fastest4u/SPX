---
title: "2026-10-20 - line-bot-ocr-spam-fix"
type: session-log
session-date: "2026-10-20"
agent: antigravity
duration-minutes: 20
outcomes:
  - "Identified root cause of the 22:42 OCR failure spam on Primary (spx-notifier-1 running a duplicate LINE listener alongside spx-line-service-1 and replaying 11h of historical image operations on LEGY push reconnect)."
  - Implemented single-owner guard in line-image-listener-runtime.ts when LINE_SERVICE_URL is set.
  - "Added stale message age filter (5m), message ID deduplication, and sequential image processing queue in line-bot.ts."
  - Verified with unit tests and npm run typecheck.
created: "2026-10-20"
updated: "2026-10-20"
tags:
  - session-log
  - project/general
---
# 2026-10-20 - line-bot-ocr-spam-fix

## TL;DR
- Identified root cause of the 22:42 OCR failure spam on Primary (spx-notifier-1 running a duplicate LINE listener alongside spx-line-service-1 and replaying 11h of historical image operations on LEGY push reconnect).
- Implemented single-owner guard in line-image-listener-runtime.ts when LINE_SERVICE_URL is set.
- Added stale message age filter (5m), message ID deduplication, and sequential image processing queue in line-bot.ts.
- Verified with unit tests and npm run typecheck.

## Goal
line-bot-ocr-spam-fix

## What Was Done
- Identified root cause of the 22:42 OCR failure spam on Primary (spx-notifier-1 running a duplicate LINE listener alongside spx-line-service-1 and replaying 11h of historical image operations on LEGY push reconnect).
- Implemented single-owner guard in line-image-listener-runtime.ts when LINE_SERVICE_URL is set.
- Added stale message age filter (5m), message ID deduplication, and sequential image processing queue in line-bot.ts.
- Verified with unit tests and npm run typecheck.

## Files Touched
- src/services/line-image-listener-runtime.ts
- src/app.ts
- src/services/line-bot.ts
- tests/line-image-listener-runtime.test.ts
- tests/line-image-listener.test.ts

## Decisions Made
- Disable local LINE client and image listener on notifier/combined roles when LINE_SERVICE_URL is configured so line-service is the sole owner of the LEGY push stream.
- Filter out incoming LINE messages older than 5 minutes (stale sync replays) and deduplicate by message ID in attachImageListener.
- Serialize incoming LINE image downloads and OCR processing via an in-memory promise queue to prevent concurrent OBS rate-limit bursts.

## Open Follow-ups
- [ ] Commit, merge, and deploy the fix to Primary (45.83.207.139) once the user approves/requests deployment (e.g., via /spx-review).

## References
- src/services/line-image-listener-runtime.ts
- src/services/line-bot.ts
- src/app.ts

## Verification
npx tsx tests/line-image-listener-runtime.test.ts && npx tsx tests/line-image-listener.test.ts && npm run typecheck passed with 0 errors.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
