---
title: "2026-05-25 - Fix SPX auto-accept partial-failure verify to query both pending and confirmed tabs (booking 2527287 root cause)"
type: session-log
session-date: 2026-05-25
agent: kiro-claude
outcomes:
  - "Identified root cause: verify-after-partial-accept used request_tab_pending_confirmation = env (true) so accepted requests that moved to the confirmed tab were invisible → acceptedSet empty → notify reported full failure"
  - "Fix landed (typecheck pass, no diagnostics): api-client.ts gains tabPendingConfirmation option (default = env), notifier.ts verify branch now fetches BOTH pending=true and pending=false in parallel and merges by max status before filtering status===2"
  - "Behaviour preserved for full-success (skips verify) and full-failure (empty merge → fallback) paths; only the partial path is corrected"
created: 2026-05-25
updated: 2026-05-25
tags:
  - session-log
  - project/general
---
# 2026-05-25 - Fix SPX auto-accept partial-failure verify to query both pending and confirmed tabs (booking 2527287 root cause)

## TL;DR
- Identified root cause: verify-after-partial-accept used request_tab_pending_confirmation = env (true) so accepted requests that moved to the confirmed tab were invisible → acceptedSet empty → notify reported full failure
- Fix landed (typecheck pass, no diagnostics): api-client.ts gains tabPendingConfirmation option (default = env), notifier.ts verify branch now fetches BOTH pending=true and pending=false in parallel and merges by max status before filtering status===2
- Behaviour preserved for full-success (skips verify) and full-failure (empty merge → fallback) paths; only the partial path is corrected

## Goal
Fix SPX auto-accept partial-failure verify to query both pending and confirmed tabs (booking 2527287 root cause)

## What Was Done
- Identified root cause: verify-after-partial-accept used request_tab_pending_confirmation = env (true) so accepted requests that moved to the confirmed tab were invisible → acceptedSet empty → notify reported full failure
- Fix landed (typecheck pass, no diagnostics): api-client.ts gains tabPendingConfirmation option (default = env), notifier.ts verify branch now fetches BOTH pending=true and pending=false in parallel and merges by max status before filtering status===2
- Behaviour preserved for full-success (skips verify) and full-failure (empty merge → fallback) paths; only the partial path is corrected

## Files Touched
- src/services/api-client.ts
- src/services/notifier.ts

## Decisions Made
- Add optional tabPendingConfirmation flag to fetchBookingRequestList / fetchBookingRequestListPage instead of forcing pending=false in verify; default still follows env so all existing call sites are unchanged
- In verify branch, fetch BOTH tabs in parallel and merge with max status; an empty merge falls through to the existing safe fallback (notify all-failed)
- Did not commit, did not deploy — leave that to user per AGENTS.md policy

## Open Follow-ups
- [ ] User to commit + deploy the partial-verify fix to production (workflow: .github/workflows/deploy.yml)
- [ ] After deploy, watch logs on next batch failure for auto-accept-partial-verified with non-empty acceptedIds; also confirm Discord/LINE alert shows partial success+failure split rather than full failure
- [ ] Consider adding an integration smoke (mock SPX returning retcode≠0 + accepted-in-confirmed-tab) so this regression is caught by CI

## References
- src/services/api-client.ts:367-410, 462-486
- src/services/notifier.ts:444-498
- memory/05_Agent_Session_Logs/2026-05-21-Auto-Accept-Partial-Fix.md
- memory/05_Agent_Session_Logs/2026-05-25-diagnose-spx-auto-accept-partial-fail-report-on-prod-booking-2527287.md

## Verification
npm run typecheck \u2192 pass (backend + frontend); getDiagnostics on both touched files \u2192 clean. No build, no smoke run, no deploy.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Verify uses wrong tab causing acceptedSet to be empty | high | fetchBookingRequestList hard-coded request_tab_pending_confirmation = env value (true on prod), so verify call after partial-accept saw only the pending tab and missed the requests that were just accepted (which moved to the confirmed tab) | When SPX UI/data is split across tabs by status, every status-aware verify must fetch all relevant tabs or use a tab-agnostic endpoint |
| Fetching both tabs and merging by max status fixes the report without affecting the 100% success or 100% fail paths | high | Both source files compile clean and the prior session log evidences SPX returning retcode≠0 with partial accepts in real batches | Keep the empty-merge fallback path so a verify with two failed fetches still degrades to the safe "all failed" branch |
