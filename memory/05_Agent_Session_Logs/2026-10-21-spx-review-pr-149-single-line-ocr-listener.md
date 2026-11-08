---
title: "2026-10-21 - spx-review-pr-149-single-line-ocr-listener"
type: session-log
session-date: "2026-10-21"
agent: codex
duration-minutes: 35
outcomes:
  - "Created, reviewed, and merged PR #149 (b2c3b73) to main after passing CI Build Check."
  - "Verified automated deployment of b2c3b73 across Primary (45.83.207.139), Worker 1 (147.50.240.44), and Worker 2 (45.154.26.83)."
  - "Recreated spx-line-service-1 on Primary and confirmed spx-notifier-1 no longer starts a duplicate LINE image listener (NO_NOTIFIER_LISTENER)."
created: "2026-10-21"
updated: "2026-10-21"
tags:
  - session-log
  - project/general
---
# 2026-10-21 - spx-review-pr-149-single-line-ocr-listener

## TL;DR
- Created, reviewed, and merged PR #149 (b2c3b73) to main after passing CI Build Check.
- Verified automated deployment of b2c3b73 across Primary (45.83.207.139), Worker 1 (147.50.240.44), and Worker 2 (45.154.26.83).
- Recreated spx-line-service-1 on Primary and confirmed spx-notifier-1 no longer starts a duplicate LINE image listener (NO_NOTIFIER_LISTENER).

## Goal
spx-review-pr-149-single-line-ocr-listener

## What Was Done
- Created, reviewed, and merged PR #149 (b2c3b73) to main after passing CI Build Check.
- Verified automated deployment of b2c3b73 across Primary (45.83.207.139), Worker 1 (147.50.240.44), and Worker 2 (45.154.26.83).
- Recreated spx-line-service-1 on Primary and confirmed spx-notifier-1 no longer starts a duplicate LINE image listener (NO_NOTIFIER_LISTENER).

## Files Touched
- src/app.ts
- src/services/line-bot.ts
- src/services/line-image-listener-runtime.ts
- tests/line-image-listener-runtime.test.ts
- tests/line-image-listener.test.ts

## Decisions Made
- Ensure only line-service owns the local LINE client and OCR image listener when LINE_SERVICE_URL is configured.
- Ignore stale replayed LINE messages (>5 minutes) and deduplicate message IDs in attachImageListener.
- Serialize incoming LINE image downloads and OCR processing via an in-memory promise queue.

## Open Follow-ups
- [x] None

## References
- src/app.ts
- src/services/line-bot.ts
- src/services/line-image-listener-runtime.ts

## Verification
GitHub Actions Run #39465950839 passed all 6 jobs (Build Check + Deploy to all 3 hosts); SSH verification confirmed commit b2c3b73 active on all containers and NO_NOTIFIER_LISTENER on spx-notifier-1.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
