---
title: Auto Memory Digest
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-10-21-spx-review-pr-149-single-line-ocr-listener.md
  - 05_Agent_Session_Logs/2026-10-20-line-bot-ocr-spam-fix.md
  - 05_Agent_Session_Logs/2026-10-19-dashboard-header-minimal-redesign.md
  - 05_Agent_Session_Logs/2026-10-19-line-service-ocr-fix.md
  - 05_Agent_Session_Logs/2026-10-19-spx-review-pr-146-147-deploy.md
  - 05_Agent_Session_Logs/2026-05-25-Auto-Accept-Dual-Tab-Verify.md
  - 05_Agent_Session_Logs/2026-05-25-PR36-Auto-Accept-Review-Merge.md
  - 05_Agent_Session_Logs/2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287.md
  - 05_Agent_Session_Logs/2026-05-27-Async-Booking-History-Persistence.md
  - 05_Agent_Session_Logs/2026-05-27-Async-History-PR37-Flow.md
  - 05_Agent_Session_Logs/2026-05-27-Async-History-Review-Guard.md
  - 05_Agent_Session_Logs/2026-05-27-Async-History-Review.md
  - 05_Agent_Session_Logs/2026-05-27-Insert-Ignore-Churn-Plan.md
  - 05_Agent_Session_Logs/2026-05-27-PR37-CI-Deploy-Status.md
  - 05_Agent_Session_Logs/2026-05-27-Production-Async-History-Verify.md
  - 05_Agent_Session_Logs/2026-05-27-Production-Auto-Accept-Lag.md
  - 05_Agent_Session_Logs/2026-05-27-Reduce-MySQL-History-Load.md
  - 05_Agent_Session_Logs/2026-05-27-Release-V100-Async-History.md
  - 05_Agent_Session_Logs/2026-05-27-SPX-Runtime-Flow-Async-History.md
  - 05_Agent_Session_Logs/2026-05-27-Zed-VS-Code-Keymap.md
  - 05_Agent_Session_Logs/2026-05-30-Bidding-API-Payload-Shape.md
  - 05_Agent_Session_Logs/2026-05-30-Bidding-Vehicle-Type-Payload.md
  - 05_Agent_Session_Logs/2026-05-30-GitHub-CLI-PR-Flow.md
  - 05_Agent_Session_Logs/2026-05-30-Live-Bidding-Payload-Retry.md
  - 05_Agent_Session_Logs/2026-05-30-Live-Bidding-Vehicle-Payload-Test.md
  - 05_Agent_Session_Logs/2026-05-30-Review-Skill-Lifecycle-Check.md
  - 05_Agent_Session_Logs/2026-05-30-SPX-Review-MCP-Path.md
  - 05_Agent_Session_Logs/2026-05-30-SPX-Review-Only-Workflow.md
  - 05_Agent_Session_Logs/2026-05-30-SPX-Review-Skill-Consolidation.md
  - 05_Agent_Session_Logs/2026-05-30-Vehicle-Filter-Review-Merge.md
confidence: medium
status: active
created: "2026-06-01"
updated: "2026-10-20"
tags:
  - digest
  - auto-compact
  - project/general
---
# Auto Memory Digest

Generated: 2026-10-20

> [!important]
> This note is generated from recent session logs. Keep durable architectural choices in ADRs and keep repeated lessons here or in dedicated insight notes.

## High-Signal Outcomes
- Created, reviewed, and merged PR #149 (b2c3b73) to main after passing CI Build Check.
- Verified automated deployment of b2c3b73 across Primary (45.83.207.139), Worker 1 (147.50.240.44), and Worker 2 (45.154.26.83).
- Recreated spx-line-service-1 on Primary and confirmed spx-notifier-1 no longer starts a duplicate LINE image listener (NO_NOTIFIER_LISTENER).
- Identified root cause of the 22:42 OCR failure spam on Primary (spx-notifier-1 running a duplicate LINE listener alongside spx-line-service-1 and replaying 11h of historical image operations on LEGY push reconnect).
- Implemented single-owner guard in line-image-listener-runtime.ts when LINE_SERVICE_URL is set.
- Added stale message age filter (5m), message ID deduplication, and sequential image processing queue in line-bot.ts.
- Verified with unit tests and npm run typecheck.
- Minimal dashboard header implemented via TDD (RED confirmed, then GREEN).
- Browser tests updated to Thai labels, switch role and status accessible names; admin asserts no Unknown/Admin Console.
- Updated docker-compose.yml line-service configuration: OCR_SERVICE_URL made optional, removed depends_on ocr-service.
- Typecheck, node runtime config tests, and full production build passed successfully.
- PR #146 merged (2fcb661): line-service OCR_SERVICE_URL opt-in; docs updated.
- PR #147 merged (39a481a): minimal dashboard header.
- Auto-deploy runs 39290013696 and 39290025488 succeeded; primary at 39a481a, /ready 200.
- spx-line-service-1 recreated: healthy, no remote OCR env, line-image-listener-started.
- Workers healthy: ifn (147.50.240.44), ptwl (45.154.26.83), krtk (primary).
- Identified root cause: verify-after-partial-accept used request_tab_pending_confirmation = env (true) so accepted requests that moved to the confirmed tab were invisible โ’ acceptedSet empty โ’ notify reported full failure
- Fix landed (typecheck pass, no diagnostics): api-client.ts gains tabPendingConfirmation option (default = env), notifier.ts verify branch now fetches BOTH pending=true and pending=false in parallel and merges by max status before filtering status===2
- Behaviour preserved for full-success (skips verify) and full-failure (empty merge โ’ fallback) paths; only the partial path is corrected
- PR #36 fix: verify partial-accept against both pending and confirmed tabs created, reviewed under spx-strict-pr-review (no P0โ€“P2; one P3 already tracked), and squash-merged to main as commit fb2fb1b
- Main fast-forwarded to fb2fb1b; local fix branch cleaned up
- Verification gates: npm run typecheck pass, npm run build pass; getDiagnostics on both touched files clean
- Confirmed root cause: prod /opt/spx/src/services/notifier.ts is 335 lines dated Apr 26, missing verifiedAcceptedIds / partial-verified / fetchBookingRequestList โ€” pre-fix version
- Container image spx-app built 2026-05-25 12:55 +07 from stale source; bundled dist/app.js (no dist/services/) reflects same old logic
- Prod logs for booking 2527287 show auto-accept-calling -> auto-accept-failed with no partial-verified or verify-failed in between, matching old code path
- Local src/services/notifier.ts (560+ lines) has the fix landed but Deploy follow-up from 2026-05-21 session never closed
- Added BookingHistorySaveQueue to decouple booking history saves from the poller/detail critical path.
- Queue enqueue returns immediately and serializes DB saves one batch at a time to avoid adding concurrent MySQL write pressure.
- Poller now enqueues history saves instead of awaiting saveBookingRequests during processBookingDetails.
- Poller shutdown now flushes queued history saves before closing DB and persists final metrics after active work completes.

## Decisions To Remember
- Ensure only line-service owns the local LINE client and OCR image listener when LINE_SERVICE_URL is configured.
- Ignore stale replayed LINE messages (>5 minutes) and deduplicate message IDs in attachImageListener.
- Serialize incoming LINE image downloads and OCR processing via an in-memory promise queue.
- Disable local LINE client and image listener on notifier/combined roles when LINE_SERVICE_URL is configured so line-service is the sole owner of the LEGY push stream.
- Filter out incoming LINE messages older than 5 minutes (stale sync replays) and deduplicate by message ID in attachImageListener.
- Serialize incoming LINE image downloads and OCR processing via an in-memory promise queue to prevent concurrent OBS rate-limit bursts.
- Admin header shows system-wide aggregate status (getDashboardSystemStatus) instead of the permanently Unknown team-scoped status.
- One visible status (dot + Thai label + relative age); runtime reason and provider health moved to tooltip/accessible name; provider health shown visually only when degraded.
- Team enable/disable uses the existing Switch (role=switch) instead of a clickable pill; Admin Console badge removed.
- Chose Option 1: switch line-service to direct Local OCR by making OCR_SERVICE_URL default to empty string and removing ocr-service startup dependency.
- Split work into two PRs (#146 deploy fix, #147 dashboard UI) instead of one mixed PR.
- Used gh CLI fallback after GitHub MCP returned Bad credentials (user explicitly approved).
- Ran targeted local tests and relied on PR CI for the full sequential suite (local run would exceed 1 hour).
- Add optional tabPendingConfirmation flag to fetchBookingRequestList / fetchBookingRequestListPage instead of forcing pending=false in verify; default still follows env so all existing call sites are unchanged
- In verify branch, fetch BOTH tabs in parallel and merge with max status; an empty merge falls through to the existing safe fallback (notify all-failed)
- Did not commit, did not deploy โ€” leave that to user per AGENTS.md policy
- Branch fix/auto-accept-dual-tab-verify cut from main; one source commit + one memory commit so the squash message stays focused on the bug fix
- Used spx-strict-pr-review skill to grade across the 8 categories before allowing merge; build gate run locally before clicking merge
- Squash-merged PR #36 to main; deferred production deploy and post-deploy log monitoring to the user per AGENTS.md no-auto-deploy policy
- Did not deploy โ€” user only asked to investigate; flagged need to deploy fix from local to prod and asked for confirmation
- Used SSH key auth + read-only inspection (logs, file mtime, grep) on PROD; no writes, no restarts
- Use a serialized in-process queue instead of unbounded fire-and-forget promises so history persistence does not block polling but also does not create multiple concurrent MySQL insert batches.
- Flush the queue during graceful shutdown to reduce risk of losing pending history records.
- Keep metrics accounting in Poller callbacks so inserted/skipped counts still update when async saves finish.
- Committed only code/test files for the PR and left unrelated memory-vault working tree changes unstaged.
- Used GitHub REST API with Git Credential Manager token held in process memory and not printed because gh CLI was unavailable.
- Deleted the remote feature branch after successful squash merge.
- No further code changes after post-review selfCheck.
- Do not commit/push/PR/merge during spx-review because the repo instruction says not to perform those actions unless explicitly requested.
- Bound the in-process history queue at 50,000 unique pending request_ids to preserve auto-accept flow under MySQL slowness while preventing unbounded memory growth.

## Unresolved From Source Sessions
- (open) Commit, merge, and deploy the fix to Primary (45.83.207.139) once the user approves/requests deployment (e.g., via /spx-review). — [[05_Agent_Session_Logs/2026-10-20-line-bot-ocr-spam-fix|2026-10-20-line-bot-ocr-spam-fix.md]]
- (open) Not committed/deployed: dashboard header redesign and docker-compose OCR_SERVICE_URL fix await user approval. — [[05_Agent_Session_Logs/2026-10-19-dashboard-header-minimal-redesign|2026-10-19-dashboard-header-minimal-redesign.md]]
- (open) Desktop-width visual check in npm run dev not yet done (browser tests cover 390px mobile). — [[05_Agent_Session_Logs/2026-10-19-dashboard-header-minimal-redesign|2026-10-19-dashboard-header-minimal-redesign.md]]
- (open) Awaiting user approval to commit and deploy change to Primary host (45.83.207.139). — [[05_Agent_Session_Logs/2026-10-19-line-service-ocr-fix|2026-10-19-line-service-ocr-fix.md]]
- (open) GitHub MCP token invalid (Bad credentials) - rotate GITHUB_PERSONAL_ACCESS_TOKEN for github-mcp-server. — [[05_Agent_Session_Logs/2026-10-19-spx-review-pr-146-147-deploy|2026-10-19-spx-review-pr-146-147-deploy.md]]
- (open) spx-worker-krtk-1 (team 3, primary) ~50% polls rate-limited by SPX retcode=130008001 after restart (38 ok / 39 limited in 2 min); not touched by this change, needs separate investigation. — [[05_Agent_Session_Logs/2026-10-19-spx-review-pr-146-147-deploy|2026-10-19-spx-review-pr-146-147-deploy.md]]
- (open) Confirm a real LINE image is OCR'd successfully via local Codex OCR (codex-device-auth token expires 2026-10-29). — [[05_Agent_Session_Logs/2026-10-19-spx-review-pr-146-147-deploy|2026-10-19-spx-review-pr-146-147-deploy.md]]
- (open) npm run lint locally scans generated bundles (~70k errors) - consider ignoring output/ and caches in eslint config. — [[05_Agent_Session_Logs/2026-10-19-spx-review-pr-146-147-deploy|2026-10-19-spx-review-pr-146-147-deploy.md]]
- (open) User to commit + deploy the partial-verify fix to production (workflow: .github/workflows/deploy.yml) — [[05_Agent_Session_Logs/2026-05-25-Auto-Accept-Dual-Tab-Verify|2026-05-25-Auto-Accept-Dual-Tab-Verify.md]]
- (open) After deploy, watch logs on next batch failure for auto-accept-partial-verified with non-empty acceptedIds; also confirm Discord/LINE alert shows partial success+failure split rather than full failure — [[05_Agent_Session_Logs/2026-05-25-Auto-Accept-Dual-Tab-Verify|2026-05-25-Auto-Accept-Dual-Tab-Verify.md]]
- (open) Consider adding an integration smoke (mock SPX returning retcodeโ 0 + accepted-in-confirmed-tab) so this regression is caught by CI — [[05_Agent_Session_Logs/2026-05-25-Auto-Accept-Dual-Tab-Verify|2026-05-25-Auto-Accept-Dual-Tab-Verify.md]]
- (open) User to trigger production deploy via .github/workflows/deploy.yml so prod runs the dual-tab verify fix — [[05_Agent_Session_Logs/2026-05-25-PR36-Auto-Accept-Review-Merge|2026-05-25-PR36-Auto-Accept-Review-Merge.md]]
- (open) After deploy, monitor logs for auto-accept-partial-verified with non-empty acceptedIds and confirm the next partial-accept produces a split success+failure notification (no full-failure alert) — [[05_Agent_Session_Logs/2026-05-25-PR36-Auto-Accept-Review-Merge|2026-05-25-PR36-Auto-Accept-Review-Merge.md]]
- (open) Add an integration smoke that mocks SPX retcodeโ 0 with accepted requests appearing only on the confirmed tab so this regression class is caught by CI — [[05_Agent_Session_Logs/2026-05-25-PR36-Auto-Accept-Review-Merge|2026-05-25-PR36-Auto-Accept-Review-Merge.md]]
- (open) Carry over older follow-ups: deploy verify partial-accept fix and monitor auto-accept-partial-verified (closed by this PR pending production rollout) — [[05_Agent_Session_Logs/2026-05-25-PR36-Auto-Accept-Review-Merge|2026-05-25-PR36-Auto-Accept-Review-Merge.md]]
- (open) Deploy partial-accept verify fix to production (carry-over from 2026-05-21-Auto-Accept-Partial-Fix.md) — [[05_Agent_Session_Logs/2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287|2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287.md]]
- (open) After deploy, monitor logs for auto-accept-partial-verified / auto-accept-partial-success on next batch failure to confirm working in prod — [[05_Agent_Session_Logs/2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287|2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287.md]]
- (open) Update Open-Followups.md to reflect that prod still on Apr 26 source for notifier.ts — [[05_Agent_Session_Logs/2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287|2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287.md]]
- (open) After deploy, monitor whether active detail jobs release faster and whether dbSave latency no longer extends booking-detail job lifetime. — [[05_Agent_Session_Logs/2026-05-27-Async-Booking-History-Persistence|2026-05-27-Async-Booking-History-Persistence.md]]
- (open) Consider exposing history queue pendingCount/isSaving in runtime metrics if operational visibility is needed. — [[05_Agent_Session_Logs/2026-05-27-Async-Booking-History-Persistence|2026-05-27-Async-Booking-History-Persistence.md]]
- (open) If process crashes hard, any queued but unsaved history records can still be lost; use Dragonfly or durable queue only if that risk is unacceptable. — [[05_Agent_Session_Logs/2026-05-27-Async-Booking-History-Persistence|2026-05-27-Async-Booking-History-Persistence.md]]
- (open) After production deploy, monitor booking-history-queue-drop logs; any nonzero drops mean MySQL is too slow/down for the history background workload. — [[05_Agent_Session_Logs/2026-05-27-Async-History-PR37-Flow|2026-05-27-Async-History-PR37-Flow.md]]
- (open) Consider exposing history queue pendingCount/isSaving/dropped count in runtime metrics if operations need dashboard visibility. — [[05_Agent_Session_Logs/2026-05-27-Async-History-PR37-Flow|2026-05-27-Async-History-PR37-Flow.md]]
- (open) If zero-loss history is required across hard crashes, replace or supplement the in-process queue with Dragonfly/Redis or another durable queue. — [[05_Agent_Session_Logs/2026-05-27-Async-History-PR37-Flow|2026-05-27-Async-History-PR37-Flow.md]]
- (open) Memory vault working tree still has unrelated generated/previous-session changes that were intentionally not included in PR #37. — [[05_Agent_Session_Logs/2026-05-27-Async-History-PR37-Flow|2026-05-27-Async-History-PR37-Flow.md]]
- (open) Keep the review follow-ups from the main spx-review session: monitor queue drops, consider queue runtime metrics, and use durable queue if zero-loss history is required. — [[05_Agent_Session_Logs/2026-05-27-Async-History-Review-Guard|2026-05-27-Async-History-Review-Guard.md]]
- (open) After deploy, monitor booking-history-queue-drop logs; any nonzero drops mean MySQL is too slow/down for the history background workload. — [[05_Agent_Session_Logs/2026-05-27-Async-History-Review|2026-05-27-Async-History-Review.md]]
- (open) Implement insertBookingHistories optimization: dedupe incoming batch by requestId, SELECT existing request_ids, then INSERT IGNORE only missing rows. — [[05_Agent_Session_Logs/2026-05-27-Insert-Ignore-Churn-Plan|2026-05-27-Insert-Ignore-Churn-Plan.md]]
- (open) Consider adding a lower bound/operator warning for POLL_INTERVAL_MS to prevent sub-second DB/API churn. — [[05_Agent_Session_Logs/2026-05-27-Insert-Ignore-Churn-Plan|2026-05-27-Insert-Ignore-Churn-Plan.md]]
- (open) Consider a production health/commit check if the user wants server-level proof beyond GitHub Actions success. — [[05_Agent_Session_Logs/2026-05-27-PR37-CI-Deploy-Status|2026-05-27-PR37-CI-Deploy-Status.md]]

## Confidence Lessons
- PowerShell Set-Content regex replace is safe for a quick edit -> Never use Get-Content/Set-Content to edit UTF-8 files containing Thai on PS5; use the file edit tool.
- Verify uses wrong tab causing acceptedSet to be empty -> When SPX UI/data is split across tabs by status, every status-aware verify must fetch all relevant tabs or use a tab-agnostic endpoint
- Fetching both tabs and merging by max status fixes the report without affecting the 100% success or 100% fail paths -> Keep the empty-merge fallback path so a verify with two failed fetches still degrades to the safe "all failed" branch
- Strict review found no P0โ€“P2 and one acceptable P3 (no integration smoke) -> Lock in the smoke-test follow-up so the next regression of this exact class is caught by CI
- PR #36 merged cleanly to main, no conflict -> Branch-from-main + commit code/memory separately keeps the squash commit focused on the source change
- Prod is missing the partial-fix code -> When investigating a recurring bug pattern, verify deploy state on prod before assuming code is live; previous session left Deploy follow-up unchecked
- Bot accepted 2 of 3 requests as user reported -> Add a step to query auto_accept_history when verifying partial accepts; left as future improvement

## Verification Evidence
- GitHub Actions Run #39465950839 passed all 6 jobs (Build Check + Deploy to all 3 hosts); SSH verification confirmed commit b2c3b73 active on all containers and NO_NOTIFIER_LISTENER on spx-notifier-1.
- npx tsx tests/line-image-listener-runtime.test.ts && npx tsx tests/line-image-listener.test.ts && npm run typecheck passed with 0 errors.
- npm run typecheck exit 0; frontend-dashboard-team-control, frontend-rules-datatable, frontend-dashboard-runtime-browser (390x844), frontend-dashboard-clock-arrival-browser all passed; npm run build exit 0.
- npm run typecheck (exit 0), npx tsx tests/line-image-listener-processor.test.ts (exit 0), npx tsx tests/node-runtime-config.test.ts (exit 0), npm run build (exit 0)
- Review findings (3x P3) fixed pre-commit; typecheck/build/eslint(changed files) + 10 targeted tests passed locally; PR CI Build Check (full npm test) passed on both PRs; deploy workflows success; production checks on all three hosts.
- npm run typecheck \u2192 pass (backend + frontend); getDiagnostics on both touched files \u2192 clean. No build, no smoke run, no deploy.
- npm run typecheck \u2192 backend + frontend pass; npm run build \u2192 success (only chunk-size warning, pre-existing); strict 8-category review across Correctness, Security, Reliability, Performance, Maintainability, Architecture, Testing, Compatibility \u2192 no P0\u2013P2; squash merge via GitHub MCP \u2192 commit fb2fb1b on origin/main; local main fast-forwarded; feature branch deleted.
- SSH inspection only (read-only): docker ps healthy, log grep for booking 2527287, file mtime + line count + grep on /opt/spx source, docker inspect image. No code changes, no typecheck/build run.
- npx tsx src\scripts\test-booking-history-save-queue.ts passed; npx tsx src\scripts\test-booking-history-repository.ts passed; npm run typecheck passed; npm run build passed with existing Vite chunk-size warning.
- npx tsx src\scripts\test-booking-history-save-queue.ts passed; npx tsx src\scripts\test-booking-history-repository.ts passed; npm run typecheck passed; npm run build passed with existing Vite chunk-size warning; PR #37 closed merged=True merge_commit_sha=839e3ccc8570cc81eee07e3c68924b3dfb72e288.
- Post-review selfCheck completed; previous verification remained npx tsx queue/repository tests, npm run typecheck, and npm run build.
- Planning-only answer based on current repository code and memory context; no files changed.
- GitHub Actions API reported run id 26491079802 name 'CI and Deploy' event push head 839e3cc status=completed conclusion=success created_bkk=2026-05-27 11:37:44 updated_bkk=2026-05-27 11:39:53.
- Read-only SSH checks on root@45.83.207.139: git rev-parse/log in /root/SPX, docker compose ps, docker inspect health/restart count, curl /health and /ready, targeted docker logs grep counts since deploy, and docker stats single snapshot.
- Read-only SSH checks: docker compose ps, health/ready curl, git rev-parse, docker stats, filtered logs, and read-only MySQL queries inside app container. No production changes made.
- npx tsx src\scripts\test-booking-history-repository.ts passed; npm run typecheck passed.
- Verified via GitHub Releases API /releases/tags/v1.0.0, git fetch --tags, git show-ref --tags, git ls-remote --tags origin, and GitHub Actions runs API.
- Read current source in src/controllers/poller.ts, src/services/booking-history-save-queue.ts, and src/repositories/booking-history-repository.ts; cross-checked memory follow-ups from async history deployment/release.
- Verified settings.json now contains vim_mode=false and base_keymap=VSCode using Select-String. Did not print or edit secret setting values.
- Searched source, scripts, README, and .env.example for bidding/list and vehicle_type payload usage.

## Source Sessions
- [[05_Agent_Session_Logs/2026-10-21-spx-review-pr-149-single-line-ocr-listener|2026-10-21-spx-review-pr-149-single-line-ocr-listener.md]]
- [[05_Agent_Session_Logs/2026-10-20-line-bot-ocr-spam-fix|2026-10-20-line-bot-ocr-spam-fix.md]]
- [[05_Agent_Session_Logs/2026-10-19-dashboard-header-minimal-redesign|2026-10-19-dashboard-header-minimal-redesign.md]]
- [[05_Agent_Session_Logs/2026-10-19-line-service-ocr-fix|2026-10-19-line-service-ocr-fix.md]]
- [[05_Agent_Session_Logs/2026-10-19-spx-review-pr-146-147-deploy|2026-10-19-spx-review-pr-146-147-deploy.md]]
- [[05_Agent_Session_Logs/2026-05-25-Auto-Accept-Dual-Tab-Verify|2026-05-25-Auto-Accept-Dual-Tab-Verify.md]]
- [[05_Agent_Session_Logs/2026-05-25-PR36-Auto-Accept-Review-Merge|2026-05-25-PR36-Auto-Accept-Review-Merge.md]]
- [[05_Agent_Session_Logs/2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287|2026-05-25-SPX-Auto-Accept-Partial-Prod-2527287.md]]
- [[05_Agent_Session_Logs/2026-05-27-Async-Booking-History-Persistence|2026-05-27-Async-Booking-History-Persistence.md]]
- [[05_Agent_Session_Logs/2026-05-27-Async-History-PR37-Flow|2026-05-27-Async-History-PR37-Flow.md]]
- [[05_Agent_Session_Logs/2026-05-27-Async-History-Review-Guard|2026-05-27-Async-History-Review-Guard.md]]
- [[05_Agent_Session_Logs/2026-05-27-Async-History-Review|2026-05-27-Async-History-Review.md]]
- [[05_Agent_Session_Logs/2026-05-27-Insert-Ignore-Churn-Plan|2026-05-27-Insert-Ignore-Churn-Plan.md]]
- [[05_Agent_Session_Logs/2026-05-27-PR37-CI-Deploy-Status|2026-05-27-PR37-CI-Deploy-Status.md]]
- [[05_Agent_Session_Logs/2026-05-27-Production-Async-History-Verify|2026-05-27-Production-Async-History-Verify.md]]
- [[05_Agent_Session_Logs/2026-05-27-Production-Auto-Accept-Lag|2026-05-27-Production-Auto-Accept-Lag.md]]
- [[05_Agent_Session_Logs/2026-05-27-Reduce-MySQL-History-Load|2026-05-27-Reduce-MySQL-History-Load.md]]
- [[05_Agent_Session_Logs/2026-05-27-Release-V100-Async-History|2026-05-27-Release-V100-Async-History.md]]
- [[05_Agent_Session_Logs/2026-05-27-SPX-Runtime-Flow-Async-History|2026-05-27-SPX-Runtime-Flow-Async-History.md]]
- [[05_Agent_Session_Logs/2026-05-27-Zed-VS-Code-Keymap|2026-05-27-Zed-VS-Code-Keymap.md]]
- [[05_Agent_Session_Logs/2026-05-30-Bidding-API-Payload-Shape|2026-05-30-Bidding-API-Payload-Shape.md]]
- [[05_Agent_Session_Logs/2026-05-30-Bidding-Vehicle-Type-Payload|2026-05-30-Bidding-Vehicle-Type-Payload.md]]
- [[05_Agent_Session_Logs/2026-05-30-GitHub-CLI-PR-Flow|2026-05-30-GitHub-CLI-PR-Flow.md]]
- [[05_Agent_Session_Logs/2026-05-30-Live-Bidding-Payload-Retry|2026-05-30-Live-Bidding-Payload-Retry.md]]
- [[05_Agent_Session_Logs/2026-05-30-Live-Bidding-Vehicle-Payload-Test|2026-05-30-Live-Bidding-Vehicle-Payload-Test.md]]
- [[05_Agent_Session_Logs/2026-05-30-Review-Skill-Lifecycle-Check|2026-05-30-Review-Skill-Lifecycle-Check.md]]
- [[05_Agent_Session_Logs/2026-05-30-SPX-Review-MCP-Path|2026-05-30-SPX-Review-MCP-Path.md]]
- [[05_Agent_Session_Logs/2026-05-30-SPX-Review-Only-Workflow|2026-05-30-SPX-Review-Only-Workflow.md]]
- [[05_Agent_Session_Logs/2026-05-30-SPX-Review-Skill-Consolidation|2026-05-30-SPX-Review-Skill-Consolidation.md]]
- [[05_Agent_Session_Logs/2026-05-30-Vehicle-Filter-Review-Merge|2026-05-30-Vehicle-Filter-Review-Merge.md]]
