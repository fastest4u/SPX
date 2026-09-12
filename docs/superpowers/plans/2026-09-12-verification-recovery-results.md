# Verification recovery implementation results

Initial implementation checkpoint on 2026-09-12 in `.worktrees/spx-review-20260911`, based on detached HEAD `7ee8fa52`. The checks below describe that checkpoint. Integration and deployment status are tracked in [PR #98](https://github.com/fastest4u/SPX/pull/98).

## Result

When an auto-accept response is followed by rate-limited or incomplete provider reads, the detached verification flow retains the job as indeterminate and retries reads until evidence resolves it. Positive status 2 proves ownership. Incomplete reads never prove a loss. Recovery does not repeat the accept POST.

- A per-team durable intent is written before POST; response, unresolved IDs, discovery, retry time and lease survive worker restart.
- Per-client reads share bounded concurrency, verification priority and cooldown from HTTP 429 or business retcode 130008001. Full valid Retry-After deadlines are preserved, including while an asynchronous admission guard is pending.
- Request ownership, history, rule progress, settlement and notification intents commit in one transaction. A repeated verification cannot decrement quota or downgrade known ownership.
- Both fast and detailed accept-all paths persist the available rule reservation before POST, including when one request ID is already known. Unknown outcomes keep that reservation across ticks and restarts until discovery can settle.
- Startup restores unresolved holds before new acceptance. Canonical ownership also prevents stale pending-tab snapshots or completed fast bookings from triggering another POST after restart.
- Paused/stopped workers and workers without their team lease cannot start another verification read. Terminal queue records leave process memory; durable notification retries remain available.
- Explicitly rejected requests can be admitted again by a later normal poll once complete evidence permits releasing quota/dedupe. Verification retries themselves remain read-only.
- Historical `indeterminate` history can be imported for read-only recovery. Old `failed` rows are not silently reclassified.

## Verification

Final commands completed after the source changes settled:

| Check | Result |
| --- | --- |
| `npm run build` | Exit 0, backend/frontend TypeScript checks and both bundles passed |
| `npm run lint` | Exit 0, zero warnings |
| `git diff --check` | Exit 0 |
| `npm test` | Exit 0, runner reports 126 passed / 0 failed / 126 total |

The runner's total includes two opt-in scripts (`admin-ui-e2e`, `user-ui-e2e`) that explicitly skipped because `RUN_E2E` was unset. The other 124 test files ran, including all three frontend browser fixture suites. No live provider acceptance, live database test, or production migration was used.

New regression coverage includes both teams, partial tab reads, eventual ownership, HTTP/business cooldowns, full Retry-After, asynchronous guard races, pause/restart fencing, atomic rollback, duplicate settlement, more than 500 durable holds, retryable dedupe release, known-ID/unknown-ID accept-all reservations and completed ownership admission.

During review, tests reproduced and then verified fixes for dropped reservation serialization, premature discovery closure, duplicate fast POST after restart and a cooldown race during an asynchronous guard. Browser fixtures also required an available loopback port: this machine rejects port 5173, and the installed Vite treats configured port 0 as its default. A shared test helper selects an OS-assigned IPv4 port; product frontend code and existing browser assertions were unchanged.

Local evidence logs are in `output/verification-recovery-final-tests.log` and `output/verification-recovery-final-build.log`. Component review reports are also under `output/`.

## PR #98 review fixes

The subsequent eight-category review identified four initial issues and one follow-up issue. Each was reproduced before its fix:

- P1: settled discovery requests leaving provider tabs reopened indeterminate work. Verification now excludes durable settled IDs and preserves prior ownership proof without fabricating current tab evidence. Both teams release the remaining reservation after partial settlement and restart, including previously lost requests disappearing.
- P1: a failed intent write before POST stranded ephemeral admission. Normal admission now rechecks failed preparation, releasing quota/dedupe only after the database confirms no pending intent. An unknown commit acknowledgement retains a non-expiring hold.
- P1: recovering a lost commit acknowledgement restored budget without restoring the runner's admission index. Recovery now adopts the persisted record; unknown preparations also protect booking/request admission through the same runner guard, including non-pending reconciliation. Twenty-one scenarios cover multiple matching rules, fast, ordinary and detailed accept-all paths, database recovery and response persistence failure.
- P2: recovery queried every due row even while both slots were occupied. Due reads now stop at capacity and fetch only enough rows for the available slots; startup still restores all holds.
- P2: imported ordinary jobs lacked metadata required by booking history. Provider verification now hydrates requested trips, preserves richer saved fields across sparse reads and excludes unrelated IDs. Both-team tests exercise the real Poller history save with `SAVE_TO_DB=true` through notification acknowledgement.

The additional regressions are `auto-accept-discovery-settled-recovery`, `pre-post-persistence-recovery`, `auto-accept-verification-capacity` and `auto-accept-historical-history-recovery`. See the PR checks and review report for the final integration gates.

## Rollout and limits

The rollout requires the additive `041_auto_accept_verification_jobs.sql` migration through the normal release process and the reviewed code on the API/TEAM 1 host and TEAM 2's assigned host, `147.50.240.44`. Verify queue recovery and newly resolved history for each team after startup.

The new table is aligned across Drizzle, runtime MySQL DDL, SQLite, migration generation and schema checks. The baseline migration was regenerated using the existing generator; it also includes the two preexisting source fields `rate_limit_notify_enabled` and `bidding_vehicle_type` that were absent from that baseline.

SQLite transaction/rollback and mocked-provider behavior were exercised locally. Live MySQL contention, actual provider recovery and delivery must be checked after an authorized rollout. Stable notification identities support replay through the existing notification subsystem; exactly-once external delivery is not claimed. Ambiguous accept-all jobs conservatively reserve quota while evidence remains incomplete. Repairing older falsely failed rows or preexisting split ownership/progress writes requires separate evidence-based reconciliation.

The original checkout's unrelated A3 work was not changed. Generated test output is review evidence, not part of the application source change.
