---
aliases:
  - auto-accept-verify-queried-only-the-pending-tab-u2014-missed-accepted-requests-on-the-confirmed-tab
title: "Auto-accept verify queried only the pending tab \\u2014 missed accepted requests on the confirmed tab"
type: mistake
severity: high
status: open
occurred-date: 2026-05-25
agent: kiro-claude
area: auto-accept verify path
confidence: high
created: 2026-05-25
updated: 2026-06-01
tags:
  - area/auto-accept verify path
  - topic/memory-vault
---
## Problem
After SPX returned retcode\u22600 on a 3-request batch where 2 were actually accepted, the verify-after-accept code (added in commit 2647b70 on 2026-05-21) called fetchBookingRequestList with the env default request_tab_pending_confirmation=true. SPX moves accepted requests from the pending tab to the confirmed tab, so the fetch saw only the still-pending request. acceptedSet ended up empty, verifiedFailedIds covered the entire batch, and Discord/LINE was notified that all 3 failed even though 2 succeeded. Booking 2527287 at 2026-05-25T18:47:36 was the user-visible incident.

## Root Cause
Single API helper (fetchBookingRequestList) shared between the bidding poll and the partial-accept verify, with the tab flag bound to a global env (REQUEST_TAB_PENDING_CONFIRMATION=true). Verify needs the opposite tab (or both) but inherited the polling tab implicitly.

## Avoidance
When verifying a state change that may move records between SPX UI tabs (pending vs confirmed), fetch BOTH tabs and merge before filtering, OR use a tab-agnostic endpoint. Never reuse a single env-driven tab flag for both polling and post-action verification.

## References
- src/services/api-client.ts
- src/services/notifier.ts
- 05_Agent_Session_Logs/2026-05-21-Auto-Accept-Partial-Fix.md
- 05_Agent_Session_Logs/2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287.md
