---
title: Auto Memory Digest
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-05-27-check-ci-deploy-status-after-pr-37-merge.md
  - 05_Agent_Session_Logs/2026-05-27-create-github-release-v1-0-0-for-async-booking-history-deployment.md
  - 05_Agent_Session_Logs/2026-05-27-explain-current-spx-runtime-flow-after-async-booking-history-release.md
  - 05_Agent_Session_Logs/2026-05-27-investigate-spx-production-auto-accept-not-keeping-up.md
  - 05_Agent_Session_Logs/2026-05-27-make-booking-history-persistence-asynchronous.md
  - 05_Agent_Session_Logs/2026-05-27-plan-fix-for-insert-ignore-duplicate-db-churn.md
  - 05_Agent_Session_Logs/2026-05-27-post-review-guard-for-async-booking-history-persistence.md
  - 05_Agent_Session_Logs/2026-05-27-reduce-mysql-load-when-saving-spx-booking-history.md
  - 05_Agent_Session_Logs/2026-05-27-set-zed-keymap-to-vs-code-behavior.md
  - 05_Agent_Session_Logs/2026-05-27-spx-review-async-booking-history-persistence-changes.md
  - 05_Agent_Session_Logs/2026-05-27-spx-review-full-flow-for-async-booking-history-persistence.md
  - 05_Agent_Session_Logs/2026-05-27-verify-production-after-async-booking-history-deploy.md
  - 05_Agent_Session_Logs/2026-05-13-Awaken-Slash-Command.md
  - 05_Agent_Session_Logs/2026-05-13-Awakened-AI-Hardening-Pass.md
  - 05_Agent_Session_Logs/2026-05-13-Awakening-Stack.md
  - 05_Agent_Session_Logs/2026-05-13-Dataview-Integration.md
  - 05_Agent_Session_Logs/2026-05-13-Dream-Compactor.md
  - 05_Agent_Session_Logs/2026-05-13-Full-Verify-Gate.md
  - 05_Agent_Session_Logs/2026-05-13-Local-Env-Setup.md
  - 05_Agent_Session_Logs/2026-05-13-Memory-Debt-And-Alert-Policy.md
  - 05_Agent_Session_Logs/2026-05-13-Memory-Quality-And-Deploy-Safety.md
  - 05_Agent_Session_Logs/2026-05-13-Memory-Verify-Gate.md
  - 05_Agent_Session_Logs/2026-05-13-Move-Vault-Into-SPX.md
  - 05_Agent_Session_Logs/2026-05-13-Multi-AI-Acceptance-Cascade.md
  - 05_Agent_Session_Logs/2026-05-13-Production-Schema-Verify.md
  - 05_Agent_Session_Logs/2026-05-13-Session-Threads-And-AI-Tool-Profiles.md
  - 05_Agent_Session_Logs/2026-05-13-Setup-MCP-Servers.md
  - 05_Agent_Session_Logs/2026-05-13-Strict-Review-Workflow-Gate.md
  - 05_Agent_Session_Logs/2026-05-13-System-Survey-Awakened-AI-Update.md
  - 05_Agent_Session_Logs/2026-05-13-Templater-Linter-Integration.md
confidence: medium
status: active
created: 2026-06-01
updated: 2026-06-01
tags:
  - digest
  - auto-compact
  - project/general
---
# Auto Memory Digest

Generated: 2026-06-01

> [!important]
> This note is generated from recent session logs. Keep durable architectural choices in ADRs and keep repeated lessons here or in dedicated insight notes.

## High-Signal Outcomes
- Checked GitHub Actions runs for main after PR #37 merge commit 839e3cc.
- Confirmed latest CI and Deploy workflow run for 839e3cc completed successfully.
- Identified run URL for follow-up verification.
- Created GitHub Release v1.0.0 for repository fastest4u/SPX.
- Release targets commit 839e3ccc8570cc81eee07e3c68924b3dfb72e288, the same commit verified on production after PR #37.
- Release notes summarize async booking history persistence, MySQL load reduction, queue guardrails, and verification commands.
- Fetched remote tags locally; refs/tags/v1.0.0 exists and points to 839e3cc.
- Checked latest GitHub Actions runs; no new deploy run was triggered by the release, latest remains successful main push run 26491079802.
- Explained current runtime flow: poller fetches booking list, schedules bounded background detail jobs, prioritizes origin-matching bookings, starts auto-accept from detail results, and enqueues history persistence asynchronously.
- Clarified that booking history no longer blocks auto-accept/detail critical path, but auto-accept tasks are still awaited inside their detail job while the poll loop continues subject to active detail job limits.
- Documented important operational caveats: in-process history queue is not durable across hard crashes, queue overflow logs booking-history-queue-drop, and durable queues like Dragonfly/Redis remain a future option if zero-loss history is required.
- SSH read-only investigation of production server root@45.83.207.139.
- Confirmed container healthy, production commit fb2fb1b matches local HEAD, /health and /ready pass, session healthy, no poll failures.
- Found production DB settings POLL_INTERVAL_MS=300 and BOOKING_DETAIL_CONCURRENCY=50 updated by admin on 2026-05-27T02:51:21Z.
- Metrics show about 776-793 polls per 5 minutes after change, tens of thousands of skipped rows per 5 minutes, and recent MySQL deadlock logs from booking history batch save.
- Auto-accept failure example 2536624 showed accept call fired immediately and SPX returned partial success: 1 accepted, 3 already timeout/accepted by another agency.
- Added BookingHistorySaveQueue to decouple booking history saves from the poller/detail critical path.
- Queue enqueue returns immediately and serializes DB saves one batch at a time to avoid adding concurrent MySQL write pressure.
- Poller now enqueues history saves instead of awaiting saveBookingRequests during processBookingDetails.
- Poller shutdown now flushes queued history saves before closing DB and persists final metrics after active work completes.
- Added focused queue test script proving a second enqueue waits behind an active save instead of running concurrently.
- Explained that INSERT IGNORE should remain as a final race-condition guard, not the primary duplicate filter.
- Recommended app-side dedupe plus DB prefilter before insert to avoid submitting known duplicate request_ids on every poll.
- Tied recommendation to recent production finding: sub-second polling created huge skipped-row churn and occasional MySQL deadlocks.
- Ran post-review self-check after memory lifecycle reported missing selfCheck for the review session.
- Confirmed verification had already passed for queue tests, repository tests, typecheck, and build.
- Added booking history batch dedupe before persistence so repeated request_id values in the same poll are skipped before DB work.
- Added in-process TTL cache for seen booking history request IDs so repeated polls can skip both SELECT and INSERT for known records during the process lifetime.
- Added MySQL prefilter SELECT against request_id unique index and narrowed INSERT IGNORE to only records not already known in cache or DB.
- Preserved INSERT IGNORE as final race guard for concurrent writers.

## Decisions To Remember
- No production SSH check was performed in this status-only check; GitHub Actions was the requested/current signal.
- Use a serialized in-process queue instead of unbounded fire-and-forget promises so history persistence does not block polling but also does not create multiple concurrent MySQL insert batches.
- Flush the queue during graceful shutdown to reduce risk of losing pending history records.
- Keep metrics accounting in Poller callbacks so inserted/skipped counts still update when async saves finish.
- No further code changes after post-review selfCheck.
- Use local in-process cache first instead of introducing Dragonfly/Redis dependency for this narrow MySQL load reduction.
- Keep skipped count based on original input length minus inserted rows to preserve existing metrics contract.
- Keep memory DB mode simple by deduping within batch but avoiding shared MySQL seen-cache behavior.
- Do not commit/push/PR/merge during spx-review because the repo instruction says not to perform those actions unless explicitly requested.
- Bound the in-process history queue at 50,000 unique pending request_ids to preserve auto-accept flow under MySQL slowness while preventing unbounded memory growth.
- Coalesce pending trips by request_id because history persistence is idempotent and repeated polls commonly carry the same request IDs.
- Committed only code/test files for the PR and left unrelated memory-vault working tree changes unstaged.
- Used GitHub REST API with Git Credential Manager token held in process memory and not printed because gh CLI was unavailable.
- Deleted the remote feature branch after successful squash merge.
- **Name it `/awaken`** (not `/next` or `/plan`) to fit the Awakened AI theme and the user's word "ตื่นรู้".
- **5-phase structure** ensures the AI loads strategic context before tactical, preventing myopic suggestions.
- **Top-3 output** prevents overwhelming the user while still giving options.
- **Optional code state (step 9-10)** because the workflow should work for pure memory/docs work too.
- ---
- Treat `memory:eval` as the acceptance test for core Awakened AI retrieval coverage.
- Treat known stale high-risk project claims as `memory:check` errors in active docs.
- Keep historical notes such as session logs, ADRs, mistakes, and sources excluded from stale-claim enforcement.
- **L2 mistake registry uses sequential ID `Mistake-NNN`** — like ADRs, IDs never reused. Future-proof and stable links.
- **`confidence:` is YAML for insights/mistakes, prose for sessions/ADRs** — different types have different verbosity needs.
- **Identity file lives at vault root, not `00_Index/`** — `AGENT-IDENTITY.md` is fundamental, deserves top-level visibility.
- **Three personas (not six)** in `/multi-perspective` — compressed from Six Thinking Hats. Optimizer + Critic + Devil's Advocate covers 80% of value at 50% of overhead.
- **Workflows are slash-commands, not auto-triggered** — keeps AI explicit. Auto-triggering would create surprise.
- **MOC manual lists are now legacy** — any future agent finding manual `- [[Note]]` lists in MOCs should consider replacing with Dataview queries.
- **`type` field is the primary filter** — every Dataview query in this vault uses `WHERE type` to skip `.base` and orphan files.
- **Hyphenated field gotcha documented** — `decision-date`, `derived-from`, etc. need bracket-syntax in `WHERE`.

## Open Follow-ups
- [ ] After production deploy, monitor booking-history-queue-drop logs; any nonzero drops mean MySQL is too slow/down for the history background workload.
- [ ] Consider a production health/commit check if the user wants server-level proof beyond GitHub Actions success.
- [ ] Continue monitoring production booking-history-queue-drop logs after release.
- [ ] Consider exposing queue depth/drop counters in metrics dashboard for easier production observation.
- [ ] Consider exposing history queue pendingCount/isSaving/dropped count in runtime metrics if operations need dashboard visibility.
- [ ] If zero-loss history is required across hard crashes, replace or supplement the in-process queue with Dragonfly/Redis or another durable queue.
- [ ] Decide whether to reduce production POLL_INTERVAL_MS to a safer value such as 1000-1500ms and BOOKING_DETAIL_CONCURRENCY to 8-20.
- [ ] Consider adding a code-level lower bound/operator warning for POLL_INTERVAL_MS to prevent sub-second production settings from causing API/DB churn.
- [ ] Consider metrics for operation latency/current runtime in persisted metrics so future production investigations do not require authenticated dashboard access.
- [ ] After deploy, monitor whether active detail jobs release faster and whether dbSave latency no longer extends booking-detail job lifetime.
- [ ] Consider exposing history queue pendingCount/isSaving in runtime metrics if operational visibility is needed.
- [ ] If process crashes hard, any queued but unsaved history records can still be lost; use Dragonfly or durable queue only if that risk is unacceptable.
- [ ] Implement insertBookingHistories optimization: dedupe incoming batch by requestId, SELECT existing request_ids, then INSERT IGNORE only missing rows.
- [ ] Consider adding a lower bound/operator warning for POLL_INTERVAL_MS to prevent sub-second DB/API churn.
- [ ] Keep the review follow-ups from the main spx-review session: monitor queue drops, consider queue runtime metrics, and use durable queue if zero-loss history is required.
- [ ] After deploy, watch metrics for lower trips_skipped DB churn and absence of booking-history-batch-save-failed deadlocks.
- [ ] Consider exposing cache hit / DB prefilter counts in metrics if operational visibility is needed.
- [ ] After deploy, monitor booking-history-queue-drop logs; any nonzero drops mean MySQL is too slow/down for the history background workload.
- [ ] Memory vault working tree still has unrelated generated/previous-session changes that were intentionally not included in PR #37.
- [ ] Keep monitoring booking-history-queue-drop; any nonzero count means history persistence is falling behind MySQL capacity.
- [ ] If auto-accept still misses work, next check should focus on poll timing, API latency, and accept request path rather than history persistence.

## Confidence Lessons
- None

## Verification Evidence
- GitHub Actions API reported run id 26491079802 name 'CI and Deploy' event push head 839e3cc status=completed conclusion=success created_bkk=2026-05-27 11:37:44 updated_bkk=2026-05-27 11:39:53.
- Verified via GitHub Releases API /releases/tags/v1.0.0, git fetch --tags, git show-ref --tags, git ls-remote --tags origin, and GitHub Actions runs API.
- Read current source in src/controllers/poller.ts, src/services/booking-history-save-queue.ts, and src/repositories/booking-history-repository.ts; cross-checked memory follow-ups from async history deployment/release.
- Read-only SSH checks: docker compose ps, health/ready curl, git rev-parse, docker stats, filtered logs, and read-only MySQL queries inside app container. No production changes made.
- npx tsx src\scripts\test-booking-history-save-queue.ts passed; npx tsx src\scripts\test-booking-history-repository.ts passed; npm run typecheck passed; npm run build passed with existing Vite chunk-size warning.
- Planning-only answer based on current repository code and memory context; no files changed.
- Post-review selfCheck completed; previous verification remained npx tsx queue/repository tests, npm run typecheck, and npm run build.
- npx tsx src\scripts\test-booking-history-repository.ts passed; npm run typecheck passed.
- Verified settings.json now contains vim_mode=false and base_keymap=VSCode using Select-String. Did not print or edit secret setting values.
- npx tsx src\scripts\test-booking-history-save-queue.ts passed; npx tsx src\scripts\test-booking-history-repository.ts passed; npm run typecheck passed; npm run build passed with existing Vite chunk-size warning; PR #37 closed merged=True merge_commit_sha=839e3ccc8570cc81eee07e3c68924b3dfb72e288.
- Read-only SSH checks on root@45.83.207.139: git rev-parse/log in /root/SPX, docker compose ps, docker inspect health/restart count, curl /health and /ready, targeted docker logs grep counts since deploy, and docker stats single snapshot.

## Source Sessions
- [[05_Agent_Session_Logs/2026-05-27-check-ci-deploy-status-after-pr-37-merge|2026-05-27-check-ci-deploy-status-after-pr-37-merge.md]]
- [[05_Agent_Session_Logs/2026-05-27-create-github-release-v1-0-0-for-async-booking-history-deployment|2026-05-27-create-github-release-v1-0-0-for-async-booking-history-deployment.md]]
- [[05_Agent_Session_Logs/2026-05-27-explain-current-spx-runtime-flow-after-async-booking-history-release|2026-05-27-explain-current-spx-runtime-flow-after-async-booking-history-release.md]]
- [[05_Agent_Session_Logs/2026-05-27-investigate-spx-production-auto-accept-not-keeping-up|2026-05-27-investigate-spx-production-auto-accept-not-keeping-up.md]]
- [[05_Agent_Session_Logs/2026-05-27-make-booking-history-persistence-asynchronous|2026-05-27-make-booking-history-persistence-asynchronous.md]]
- [[05_Agent_Session_Logs/2026-05-27-plan-fix-for-insert-ignore-duplicate-db-churn|2026-05-27-plan-fix-for-insert-ignore-duplicate-db-churn.md]]
- [[05_Agent_Session_Logs/2026-05-27-post-review-guard-for-async-booking-history-persistence|2026-05-27-post-review-guard-for-async-booking-history-persistence.md]]
- [[05_Agent_Session_Logs/2026-05-27-reduce-mysql-load-when-saving-spx-booking-history|2026-05-27-reduce-mysql-load-when-saving-spx-booking-history.md]]
- [[05_Agent_Session_Logs/2026-05-27-set-zed-keymap-to-vs-code-behavior|2026-05-27-set-zed-keymap-to-vs-code-behavior.md]]
- [[05_Agent_Session_Logs/2026-05-27-spx-review-async-booking-history-persistence-changes|2026-05-27-spx-review-async-booking-history-persistence-changes.md]]
- [[05_Agent_Session_Logs/2026-05-27-spx-review-full-flow-for-async-booking-history-persistence|2026-05-27-spx-review-full-flow-for-async-booking-history-persistence.md]]
- [[05_Agent_Session_Logs/2026-05-27-verify-production-after-async-booking-history-deploy|2026-05-27-verify-production-after-async-booking-history-deploy.md]]
- [[05_Agent_Session_Logs/2026-05-13-Awaken-Slash-Command|2026-05-13-Awaken-Slash-Command.md]]
- [[05_Agent_Session_Logs/2026-05-13-Awakened-AI-Hardening-Pass|2026-05-13-Awakened-AI-Hardening-Pass.md]]
- [[05_Agent_Session_Logs/2026-05-13-Awakening-Stack|2026-05-13-Awakening-Stack.md]]
- [[05_Agent_Session_Logs/2026-05-13-Dataview-Integration|2026-05-13-Dataview-Integration.md]]
- [[05_Agent_Session_Logs/2026-05-13-Dream-Compactor|2026-05-13-Dream-Compactor.md]]
- [[05_Agent_Session_Logs/2026-05-13-Full-Verify-Gate|2026-05-13-Full-Verify-Gate.md]]
- [[05_Agent_Session_Logs/2026-05-13-Local-Env-Setup|2026-05-13-Local-Env-Setup.md]]
- [[05_Agent_Session_Logs/2026-05-13-Memory-Debt-And-Alert-Policy|2026-05-13-Memory-Debt-And-Alert-Policy.md]]
- [[05_Agent_Session_Logs/2026-05-13-Memory-Quality-And-Deploy-Safety|2026-05-13-Memory-Quality-And-Deploy-Safety.md]]
- [[05_Agent_Session_Logs/2026-05-13-Memory-Verify-Gate|2026-05-13-Memory-Verify-Gate.md]]
- [[05_Agent_Session_Logs/2026-05-13-Move-Vault-Into-SPX|2026-05-13-Move-Vault-Into-SPX.md]]
- [[05_Agent_Session_Logs/2026-05-13-Multi-AI-Acceptance-Cascade|2026-05-13-Multi-AI-Acceptance-Cascade.md]]
- [[05_Agent_Session_Logs/2026-05-13-Production-Schema-Verify|2026-05-13-Production-Schema-Verify.md]]
- [[05_Agent_Session_Logs/2026-05-13-Session-Threads-And-AI-Tool-Profiles|2026-05-13-Session-Threads-And-AI-Tool-Profiles.md]]
- [[05_Agent_Session_Logs/2026-05-13-Setup-MCP-Servers|2026-05-13-Setup-MCP-Servers.md]]
- [[05_Agent_Session_Logs/2026-05-13-Strict-Review-Workflow-Gate|2026-05-13-Strict-Review-Workflow-Gate.md]]
- [[05_Agent_Session_Logs/2026-05-13-System-Survey-Awakened-AI-Update|2026-05-13-System-Survey-Awakened-AI-Update.md]]
- [[05_Agent_Session_Logs/2026-05-13-Templater-Linter-Integration|2026-05-13-Templater-Linter-Integration.md]]
