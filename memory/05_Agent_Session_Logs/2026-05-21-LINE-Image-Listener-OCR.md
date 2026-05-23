---
title: 2026-05-21 - Add LINE image listener for SPX group run sheet OCR
type: session-log
session-date: 2026-05-21
agent: codex
outcomes:
  - "Added startImageListener() to line-bot.ts that listens for incoming IMAGE messages in a target group, downloads the image, runs Codex OCR, and replies with the 5-field result."
  - Added LINE_IMAGE_LISTENER_CHAT_ID env var to env.ts.
  - Wired automatic listener startup in http-server.ts after server listen.
  - "Set LINE_IMAGE_LISTENER_CHAT_ID=c45d27c030d320964ae78634238184377 (SPX group) in .env."
  - Verified listener starts successfully and connects with restored auth token.
created: 2026-05-21
updated: 2026-05-21
tags:
  - session-log
  - project/general
---
# 2026-05-21 - Add LINE image listener for SPX group run sheet OCR

## TL;DR
- Added startImageListener() to line-bot.ts that listens for incoming IMAGE messages in a target group, downloads the image, runs Codex OCR, and replies with the 5-field result.
- Added LINE_IMAGE_LISTENER_CHAT_ID env var to env.ts.
- Wired automatic listener startup in http-server.ts after server listen.
- Set LINE_IMAGE_LISTENER_CHAT_ID=c45d27c030d320964ae78634238184377 (SPX group) in .env.
- Verified listener starts successfully and connects with restored auth token.

## Goal
Add LINE image listener for SPX group run sheet OCR

## What Was Done
- Added startImageListener() to line-bot.ts that listens for incoming IMAGE messages in a target group, downloads the image, runs Codex OCR, and replies with the 5-field result.
- Added LINE_IMAGE_LISTENER_CHAT_ID env var to env.ts.
- Wired automatic listener startup in http-server.ts after server listen.
- Set LINE_IMAGE_LISTENER_CHAT_ID=c45d27c030d320964ae78634238184377 (SPX group) in .env.
- Verified listener starts successfully and connects with restored auth token.

## Files Touched
- src/services/line-bot.ts
- src/config/env.ts
- src/services/http-server.ts
- .env
- tests/test-line-listener.ts
- tests/list-line-groups.ts

## Decisions Made
- Use a new env var LINE_IMAGE_LISTENER_CHAT_ID for the listener target group, separate from LINEJS_TEST_TARGET_ID used for outgoing notifications.
- Only respond to IMAGE messages, ignore other content types.
- Use the existing readImageWithCodex with default 5-field prompt.
- Start the listener automatically in http-server.ts after the server is listening.

## Open Follow-ups
- [ ] Test end-to-end: send a run sheet photo to the SPX group and verify the 5-field reply.
- [ ] Handle large images or timeout gracefully — currently hardcoded 120s timeout.
- [ ] Consider adding a reaction emoji when processing starts (e.g., message.react('NICE')).

## References
- 05_Agent_Session_Logs/2026-05-21-Codex-OCR-Output-Five-SPX-Fields.md

## Verification
npm run typecheck passed; test-line-listener.ts confirmed listener starts and connects to SPX group with restored auth token.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
