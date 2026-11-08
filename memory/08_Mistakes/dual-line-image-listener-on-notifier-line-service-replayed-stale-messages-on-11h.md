---
title: "Dual LINE image listener on notifier + line-service replayed stale messages on 11h LEGY push reconnect"
type: mistake
severity: high
status: open
occurred-date: "2026-10-20"
agent: antigravity
area: line-bot / line-image-listener
confidence: high
created: "2026-10-20"
updated: "2026-10-20"
tags:
  - area/line-bot / line-image-listener
  - topic/memory-vault
---
## Problem
LINE group suddenly received 28+ 'อ่านรูปไม่สำเร็จ: OCR failed. Please try again.' replies at 22:42 (15:42 UTC) when nobody had sent any new images.

## Root Cause
spx-notifier-1 (SPX_ROLE=notifier) started a duplicate local LINE image listener even though LINE_SERVICE_URL=http://line-service:3003 was configured and spx-line-service-1 was already running. While spx-line-service-1 received real-time events, spx-notifier-1's LEGY HTTP/2 push stream sat at a stale revision for ~11 hours and replayed ~30 historical image operations in a 1.3s burst upon reconnect, triggering LINE OBS rate limits and non-image error responses.

## Avoidance
1) Gate local LINE client/listener startup in line-image-listener-runtime.ts so notifier/combined roles do not start a local listener when LINE_SERVICE_URL is configured. 2) Filter incoming LINE messages by createdTime age (max 5m) and deduplicate message IDs in attachImageListener, and serialize image downloads/OCR via a queue.

## References
- src/services/line-image-listener-runtime.ts
- src/services/line-bot.ts
- src/app.ts
