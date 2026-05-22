---
title: "Fix: Auto-Accept Partial Accept Bug"
type: session-log
session-date: 2026-05-21
agent: cascade
duration-minutes: 25
created: 2026-05-21
updated: 2026-05-21
outcomes:
  - Diagnosed auto-accept false-failure notification bug
  - Implemented verify-after-accept logic using fetchBookingRequestList
  - Typecheck passed
tags:
  - session-log
  - project/spx
  - area/auto-accept
  - topic/bug-fix
---

## TL;DR

SPX API partially accepts batched requests (accepts some, fails others) but returns `retcode≠0`. The system treated the entire batch as failed and sent a failure notification even though some requests were accepted. Fixed by verifying actual `request_acceptance_status` after any failed API response.

## Goal

Fix auto-accept notification reporting based on actual accepted status, not API retcode alone.

## What Was Done

1. SSHed into `root@45.83.207.139`, queried `auto_accept_history` — found `accepted_count=0, status=failed` for both bookings
2. Cross-checked `spx_booking_history` — all requests showed `acceptance_status=1` (waiting = still in bidding list, not "accepted")
3. User confirmed via SPX screenshot: requests 32569106 + 32569028 ARE accepted (`Accepted` + `Assignment Complete`)
4. Root cause: SPX API accepts partial batch (32569106 ✅, 32569028 ✅, 32568950 ❌) then returns `retcode≠0`; code at line 430-432 in `api-client.ts` returns `ok: false` for any non-zero retcode
5. **Fix**: Modified `acceptAutoAcceptMatch` in `notifier.ts` — after any `ok=false`, call `fetchBookingRequestList` and filter by `request_acceptance_status === 2` to get actually-accepted IDs; split into `verifiedAcceptedIds` and `verifiedFailedIds`; send success notification for accepted, failure only for truly unaccepted

## Files Touched

- `src/services/notifier.ts` — replaced accept+failure block with verify-after-accept pattern

## Decisions Made

- Verify via `fetchBookingRequestList` on EVERY failed accept attempt (adds one extra API call per failed booking — acceptable given poll interval)
- `verifiedAcceptedIds` → `status: "success"` in history, success notification
- `verifiedFailedIds` → `status: "failed"` in history, failure notification only if non-empty
- Empty list from verification → fallback to full failure (safe default)

## Open Follow-ups

- [ ] Deploy to production server
- [ ] Monitor logs for `auto-accept-partial-verified` to confirm fix works in production

## References

- [[Runbook-Production-Deploy]]
