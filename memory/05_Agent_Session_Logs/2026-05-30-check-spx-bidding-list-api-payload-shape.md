---
title: 2026-05-30 - Check SPX bidding list API payload shape
type: session-log
session-date: 2026-05-30
agent: Codex
duration-minutes: 8
outcomes:
  - "Confirmed current SPX client sends only pageno, count, request_tab_pending_confirmation, and request_ctime_start to /api/line_haul/agency/booking/bidding/list."
  - Confirmed vehicle_type is present in response/detail model types but not in the BiddingRequest request type or api-client body for bidding/list.
  - No code changes made.
created: 2026-05-30
updated: 2026-05-30
tags:
  - session-log
  - project/spx
---
# 2026-05-30 - Check SPX bidding list API payload shape

## TL;DR
- Confirmed current SPX client sends only pageno, count, request_tab_pending_confirmation, and request_ctime_start to /api/line_haul/agency/booking/bidding/list.
- Confirmed vehicle_type is present in response/detail model types but not in the BiddingRequest request type or api-client body for bidding/list.
- No code changes made.

## Goal
Check SPX bidding list API payload shape

## What Was Done
- Confirmed current SPX client sends only pageno, count, request_tab_pending_confirmation, and request_ctime_start to /api/line_haul/agency/booking/bidding/list.
- Confirmed vehicle_type is present in response/detail model types but not in the BiddingRequest request type or api-client body for bidding/list.
- No code changes made.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] If upstream SPX API must filter by vehicle_type, verify with a live non-mutating list request and then add an optional vehicle_type config/body field.

## References
- src/models/types.ts
- src/services/api-client.ts
- poll-bidding.js
- .env.example

## Verification
Searched source, scripts, README, and .env.example for bidding/list and vehicle_type payload usage.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
