# Verification Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent components and local integration. No commits: repository policy overrides skill commit steps.

**Goal:** Verify accepted jobs reliably across rate limits and worker restarts for both teams.
**Architecture:** Durable per-team verification intents plus fenced, atomic request settlement; shared ApiClient read scheduling; poller recovery before new acceptance.
**Tech Stack:** Existing TypeScript, Drizzle/MySQL, SQLite test mode, standalone tsx tests.
**Spec:** docs/superpowers/specs/2026-09-12-verification-recovery-design.md

## Global Constraints
- Work in existing `.worktrees/spx-review-20260911` at 7ee8fa52; preserve original checkout's untracked A3.
- No credentials in queue/logs, no .env reads, no production calls, no commits or deploy.
- Retrying verification must never invoke accept POST. Unknown results retain quota and dedupe.

### Task 1: Provider scheduling
Files: src/services/api-client.ts, new src/services/provider-read-scheduler.ts, tests/provider-read-scheduler.test.ts and focused API client tests.
Interface: ApiClient.getRateLimitRetryAt(): number; withVerificationPriority<T>(read: () => Promise<T>): Promise<T>. All reads share cooldown on the client. A synchronous priority scope around call creation is sufficient if priority is captured per request. Respect pause/abort integration and Retry-After, including business retcode 130008001.
- [x] Write failing behavioral tests: `assert.equal(fetchCallsDuringCooldown, 0)`; order queued verification before detail; isolation of two clients; HTTP and business-rate-limit cases; POST remains non-retrying.
- [x] Run focused tests and record the expected failures.
- [x] Implement shared scheduler and API wiring with bounded read concurrency and jitter.
- [x] Run the focused tests and report method contract and limitations.

### Task 2: Durable repository and settlement
Files: new src/repositories/auto-accept-verification-repository.ts; schema, runtime/memory DDL, migration-sql, append-only migration, schema verification/generator integration; tests/auto-accept-verification-repository.test.ts.
Interface to agree before integration: persist job intent before POST; update accept response; recover/list jobs scoped to team; claim/reschedule with lease token; atomic per-request history/result/progress settlement; list all unresolved holds; historical unresolved recovery. Use AutoAcceptVerificationJob and AutoAcceptVerificationOutcome types. Export stable typed functions and report them to controller.
- [x] Write failing SQLite integration tests for team isolation, restart recovery, duplicate intent, fence mismatch and atomic/idempotent settlement. Example: settle the same accepted request twice and `assert.equal(rule.need, 1)` starting from 2.
- [x] Verify expected failures before implementation.
- [x] Implement persistent job/lease state and transactional settlement of only newly resolved requests. Reuse current schema conventions, handle global/team rule ownership consistently.
- [x] Verify migration parity and focused repository tests.

### Task 3: Classification, queue and poller integration
Files: src/services/auto-accept-verifier.ts, src/services/notifier.ts, src/controllers/poller.ts; focused verifier, notifier, budget and recovery tests.
- [x] Add regression: pending empty plus confirmed null yields `indeterminateRequestIds: [id]`, `failedRequestIds: []`, no dedupe release. Status 2 from a readable tab remains accepted. Conflicting evidence must not discard known ownership.
- [x] Run tests red, fix classification, run green.
- [x] Persist intent before detached POST; queue read-only attempts; reschedule unresolved IDs with backoff; use repository atomic settlement and stable notifications.
- [x] Restore quota/dedupe before poller run; drain recovery independently of list cooldown. Preserve shutdown and team pause fencing. Keep pending quota beyond old five-minute TTL.
- [x] Test partial batch retry does not duplicate success, restart makes no accept call, pause stops requests, DB errors fail closed.

### Task 4: Review and verification
- [x] Review full scoped diff for concurrency, ownership, persistence, migration and notification regressions; fix findings.
- [x] Run relevant regression suites, `npm run typecheck`, `git diff --check`.
- [x] Record implementation and outstanding production rollout/reconciliation in Memory MCP. Leave changes uncommitted for user review.
