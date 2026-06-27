# Win-First Auto-Accept Verify-After Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make trip-level SPX auto-accept submit the accept POST as early as possible, then verify ownership, history, progress, metrics, and LINE alerts off the booking-detail critical path.

**Architecture:** Keep rule matching, `NeedBudget`, and request dedupe synchronous before the accept POST. Split post-accept verification into reusable verifier/classifier code plus a small detached worker queue owned by `notifier.ts`. The existing inline behavior remains the default for compatibility; the poller opts into detached verification for pending-tab competitive accepts. Verification still fetches both SPX request-list tabs and counts only `request_acceptance_status=2` as a verified win.

**Tech Stack:** TypeScript, Node.js, Drizzle ORM, Fastify/SSE dashboard metrics, standalone `tsx` assertion tests, MySQL plus memory-mode SQLite test database.

---

## Source Contract

This plan implements `docs/superpowers/specs/2026-06-27-win-first-auto-accept-verify-after-design.md`.

Current evidence:

- `src/controllers/poller.ts` already starts auto-accept from request-list page callbacks, but it waits for `autoAcceptTasks` before releasing the booking detail slot.
- `src/services/notifier.ts` currently combines accept POST, both-tab verify, history writes, progress settlement, metrics, and LINE alerts in one operation.
- `tests/auto-accept-success-verify.test.ts` proves a raw successful accept response is not enough; both-tab verification must still run.
- `tests/auto-accept-ambiguous-timeout.test.ts` proves `httpStatus=0` must defer instead of firing a false failure alert.
- Fast booking-name `accept_all` already has an accept-first/reconcile-after shape in `src/controllers/poller.ts`; trip-level auto-accept should adopt that shape without changing `accept_all` behavior.

## File Structure

Add:

- `src/services/auto-accept-diagnostics.ts`
  - Owns reason-code types, trace IDs, compact evidence formatting, and failure-alert text helpers.
- `src/services/auto-accept-verifier.ts`
  - Owns both-tab verification fetches, status merging, and request outcome classification.
- `tests/auto-accept-verifier.test.ts`
  - Pure and API-backed verifier contract tests.
- `tests/auto-accept-detached-verify.test.ts`
  - Notifier detached-queue contract tests.
- `tests/poller-auto-accept-detached-verify.test.ts`
  - Poller critical-path contract test.
- `tests/auto-accept-history-diagnostics.test.ts`
  - Repository/schema diagnostics field test.
- `migrations/020_auto_accept_history_diagnostics.sql`
  - Adds queryable history diagnostics columns.

Modify:

- `src/services/notifier.ts`
  - Add `verificationMode`, queue orchestration, shared outcome finalization, richer failed-result fields.
- `src/controllers/poller.ts`
  - Use detached verification for pending-tab trip-level auto-accept only.
- `src/services/metrics.ts`
  - Add verification queue/latency counters and reason distribution.
- `src/frontend/types/index.ts`
  - Mirror the new metrics/history fields.
- `src/frontend/routes/index.tsx`
  - Show verify queue/latency beside accept RTT.
- `src/frontend/routes/auto-accept-history.tsx`
  - Surface failure reason, trace ID, and indeterminate status.
- `src/db/schema.ts`
- `src/db/client.ts`
- `src/db/client-memory.ts`
- `src/db/migration-sql.ts`
- `scripts/schema-verify.mjs`
- `src/repositories/auto-accept-repository.ts`
- Existing focused tests listed below.

Do not modify:

- `.env`
- `notify-rules.json`
- `src/frontend/routeTree.gen.ts`
- `dist/`
- `data/`
- `logs/`
- `node_modules/`

Do not commit, push, deploy, or create a PR unless the operator explicitly requests it.

---

### Task 1: Diagnostics Types And History Schema

**Files:**
- Add: `migrations/020_auto_accept_history_diagnostics.sql`
- Add: `src/services/auto-accept-diagnostics.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/client-memory.ts`
- Modify: `src/db/migration-sql.ts`
- Modify: `scripts/schema-verify.mjs`
- Modify: `src/repositories/auto-accept-repository.ts`
- Modify: `src/frontend/types/index.ts`
- Add: `tests/auto-accept-history-diagnostics.test.ts`
- Modify: `tests/schema-consistency.test.ts` only if the existing schema consistency assertion needs a fixture update.

- [ ] Add `src/services/auto-accept-diagnostics.ts` with stable reason/status/trace/evidence types:

```ts
export const AUTO_ACCEPT_FAILURE_REASONS = [
  "lost_race",
  "session_expired",
  "accept_api_error",
  "accept_timeout_ambiguous",
  "verify_indeterminate",
  "verify_not_confirmed",
  "rule_budget_exhausted",
  "request_deduped",
] as const;

export type AutoAcceptFailureReason = typeof AUTO_ACCEPT_FAILURE_REASONS[number];
export type AutoAcceptHistoryStatus = "success" | "failed" | "indeterminate";
export type VerificationStatus = "verified_success" | "verified_failed" | "indeterminate";

export interface AutoAcceptEvidence {
  traceId: string;
  reason?: AutoAcceptFailureReason;
  verificationStatus: VerificationStatus;
  acceptRttMs?: number;
  listAgeMs?: number;
  verificationLatencyMs?: number;
  pendingTabRead: boolean;
  confirmedTabRead: boolean;
  observedStatuses: Record<number, number | null>;
  nextAction: string;
}

export function buildAutoAcceptTraceId(input: {
  teamId: number;
  bookingId: number;
  requestIds: number[];
  acceptStartedAt: number;
}): string;

export function summarizeAutoAcceptEvidence(evidence: AutoAcceptEvidence): string;
```

- [ ] Add `buildAutoAcceptFailureAlertText()` in the same diagnostics module so LINE text can be unit-tested without sending LINE:

```ts
export function buildAutoAcceptFailureAlertText(input: {
  now: Date;
  failures: Array<{
    bookingId: number;
    requestIds: number[];
    ruleName?: string;
    route?: string;
    vehicleType?: string;
    reason: AutoAcceptFailureReason;
    error: string;
    traceId?: string;
    acceptRttMs?: number;
    listAgeMs?: number;
    pendingTabRead?: boolean;
    confirmedTabRead?: boolean;
    nextAction?: string;
  }>;
}): string;
```

- [ ] Add `migrations/020_auto_accept_history_diagnostics.sql`:

```sql
ALTER TABLE auto_accept_history ADD COLUMN failure_reason VARCHAR(64) NULL AFTER error_message;
ALTER TABLE auto_accept_history ADD COLUMN trace_id VARCHAR(160) NULL AFTER failure_reason;
ALTER TABLE auto_accept_history ADD COLUMN accept_rtt_ms INT NULL AFTER trace_id;
ALTER TABLE auto_accept_history ADD COLUMN list_age_ms INT NULL AFTER accept_rtt_ms;
ALTER TABLE auto_accept_history ADD COLUMN verification_latency_ms INT NULL AFTER list_age_ms;
ALTER TABLE auto_accept_history ADD COLUMN verification_status VARCHAR(32) NULL AFTER verification_latency_ms;
ALTER TABLE auto_accept_history ADD COLUMN verified_at DATETIME NULL AFTER verification_status;
ALTER TABLE auto_accept_history ADD INDEX aah_team_reason_created_at_idx (team_id, failure_reason, created_at);
ALTER TABLE auto_accept_history ADD INDEX aah_trace_id_idx (trace_id);
```

- [ ] Update runtime MySQL table creation in `src/db/client.ts` with the new nullable columns and indexes.
- [ ] Add `ensureMysqlColumn()` calls in `src/db/client.ts` for all six new columns.
- [ ] Add `ensureMysqlIndex()` calls in `src/db/client.ts` for `aah_team_reason_created_at_idx` and `aah_trace_id_idx`.
- [ ] Update memory-mode SQLite DDL in `src/db/client-memory.ts` with equivalent nullable columns and indexes.
- [ ] Update Drizzle schema in `src/db/schema.ts`:

```ts
failureReason: varchar("failure_reason", { length: 64 }),
traceId: varchar("trace_id", { length: 160 }),
acceptRttMs: int("accept_rtt_ms"),
listAgeMs: int("list_age_ms"),
verificationLatencyMs: int("verification_latency_ms"),
verificationStatus: varchar("verification_status", { length: 32 }),
verifiedAt: datetime("verified_at"),
```

- [ ] Update `src/db/migration-sql.ts` table DDL with the same columns/indexes for generated schema parity.
- [ ] Update `scripts/schema-verify.mjs` expected column/index map.
- [ ] Extend `AutoAcceptRecord`, `AutoAcceptHistoryUpdate`, and `dbRowToItem()` in `src/repositories/auto-accept-repository.ts`:

```ts
status: "success" | "failed" | "indeterminate";
failureReason?: AutoAcceptFailureReason | null;
traceId?: string | null;
acceptRttMs?: number | null;
listAgeMs?: number | null;
verificationLatencyMs?: number | null;
verificationStatus?: VerificationStatus | null;
verifiedAt?: Date | string | null;
```

- [ ] Keep `errorMessage` truncated to 1000 chars and `traceId` truncated to 160 chars.
- [ ] Add `AutoAcceptHistoryItem` fields in `src/frontend/types/index.ts`; include `status: 'success' | 'failed' | 'indeterminate'`.
- [ ] Add `tests/auto-accept-history-diagnostics.test.ts` that inserts one failed row with `failureReason`, `traceId`, `acceptRttMs`, `listAgeMs`, `verificationLatencyMs`, `verificationStatus`, and `verifiedAt`, then asserts `getAutoAcceptHistory()` returns those fields.
- [ ] Run `npm test -- auto-accept-history-diagnostics` and confirm it passes after implementation.
- [ ] Run `npm test -- schema-consistency`.

### Task 2: Verifier And Classification Contract

**Files:**
- Add: `src/services/auto-accept-verifier.ts`
- Add: `tests/auto-accept-verifier.test.ts`

- [ ] Implement a verifier module that is independent of notification delivery and rule progress writes.
- [ ] Define these input/output contracts:

```ts
export interface AutoAcceptVerificationJob {
  teamId: number;
  ruleId: string;
  ruleName: string;
  bookingId: number;
  requestIds: number[];
  trips: TripLike[];
  claimToken: ClaimToken;
  acceptResult: {
    ok: boolean;
    httpStatus: number;
    retcode?: number;
    message?: string;
    error?: string;
  };
  acceptStartedAt: number;
  acceptFinishedAt: number;
  acceptRttMs: number;
  listAgeMs?: number;
  ambiguousAccept: boolean;
  acceptAll: boolean;
  traceId: string;
}

export interface AutoAcceptVerifiedRequest {
  requestId: number;
  status: "accepted" | "failed" | "indeterminate";
  reason?: AutoAcceptFailureReason;
  observedStatus: number | null;
  terminal: boolean;
  releaseRequestDedupe: boolean;
  releaseBudget: boolean;
}

export interface AutoAcceptVerificationOutcome {
  job: AutoAcceptVerificationJob;
  verificationStatus: VerificationStatus;
  acceptedRequestIds: number[];
  failedRequestIds: number[];
  indeterminateRequestIds: number[];
  requests: AutoAcceptVerifiedRequest[];
  evidence: AutoAcceptEvidence;
}
```

- [ ] `verifyAutoAcceptJob(apiClient, job)` must fetch both tabs with:

```ts
const [pendingList, confirmedList] = await Promise.all([
  apiClient.fetchBookingRequestList(job.bookingId, { tabPendingConfirmation: true }),
  apiClient.fetchBookingRequestList(job.bookingId, { tabPendingConfirmation: false }),
]);
```

- [ ] Merge tab statuses by `request_id`; if the same request appears twice, keep the highest-progress status.
- [ ] Count only status `2` as `accepted`.
- [ ] Do not count status `6` as a verified win.
- [ ] If both tab reads return `null`/`undefined` or both reads throw, classify all request IDs as `verify_indeterminate`.
- [ ] If `job.ambiguousAccept` is true and no status `2` is observed on the first readable verification pass, wait `AMBIGUOUS_VERIFY_RECHECK_DELAY_MS` inside the detached verification worker and fetch both tabs one more time before final classification.
- [ ] If the ambiguous recheck observes status `2`, classify the request as a verified win.
- [ ] If `job.ambiguousAccept` is true and no status `2` is observed after the delayed recheck, classify as `accept_timeout_ambiguous` and `indeterminate`, not normal `failed`.
- [ ] If tab data is readable and the request is observed with a non-2 terminal/non-pending status, classify `lost_race`.
- [ ] If tab data is readable and selected request IDs are absent from both tabs, classify `verify_not_confirmed`.
- [ ] If accept response text indicates auth/session expiry, classify `session_expired`; use this only when no verified win was found.
- [ ] Otherwise classify clear non-success accept responses as `accept_api_error`.
- [ ] Request lifecycle flags:
  - Verified success: `terminal=true`, `releaseRequestDedupe=false`, `releaseBudget=false`.
  - `lost_race` and `verify_not_confirmed`: `terminal=true`, `releaseRequestDedupe=false`, `releaseBudget=true`.
  - `verify_indeterminate` and `accept_timeout_ambiguous`: `terminal=false`, `releaseRequestDedupe=true`, `releaseBudget=false`.
  - `session_expired` and `accept_api_error`: `terminal=false`, `releaseRequestDedupe=true`, `releaseBudget=true`.
- [ ] Add tests:
  - both tabs fetched and status `2` is a verified win;
  - status `6` is not a win;
  - confirmed-tab status `4` becomes `lost_race`;
  - both tab reads unavailable becomes `verify_indeterminate`;
  - `httpStatus=0` plus first readable non-2 status performs one delayed recheck before final classification;
  - `httpStatus=0` plus delayed recheck status `2` becomes a verified win;
  - `httpStatus=0` plus readable non-2 status after recheck becomes `accept_timeout_ambiguous`;
  - a clear auth/session error becomes `session_expired`;
  - `buildAutoAcceptFailureAlertText()` includes reason, booking ID, request IDs, accept RTT, list age, tab evidence, trace ID, and next action.
- [ ] Run `npm test -- auto-accept-verifier`.

### Task 3: Detached Verification Queue In Notifier

**Files:**
- Modify: `src/services/notifier.ts`
- Add: `tests/auto-accept-detached-verify.test.ts`
- Modify: `tests/auto-accept-success-verify.test.ts`
- Modify: `tests/auto-accept-ambiguous-timeout.test.ts`
- Modify: `tests/auto-accept-accept-all.test.ts` only if result typing requires it.

- [ ] Extend `AutoAcceptOptions`:

```ts
interface AutoAcceptOptions {
  teamId?: number;
  notificationContext?: TeamNotificationContext;
  deferSideEffects?: boolean;
  needBudget?: NeedBudget;
  autoAcceptRules?: NotifyRule[];
  verificationMode?: "inline" | "detached";
}
```

- [ ] Extend `AutoAcceptResult` and `AutoAcceptRuleRunResult` with:

```ts
pendingVerification: number;
```

- [ ] Keep default behavior as `verificationMode ?? "inline"` so existing tests and non-pending auto-accept behavior continue to get terminal `accepted`/`failed`/`deferredRequests` results.
- [ ] Create a small queue in `notifier.ts`:

```ts
const AUTO_ACCEPT_VERIFY_CONCURRENCY = 2;
const autoAcceptVerifyQueue: AutoAcceptVerificationJob[] = [];
let activeAutoAcceptVerifyJobs = 0;
```

- [ ] Add `enqueueAutoAcceptVerification(job, options)` that pushes jobs, records queue metrics, and starts workers with max concurrency 2.
- [ ] Add `export async function awaitAutoAcceptVerificationIdle(timeoutMs = 5_000): Promise<void>` for deterministic tests.
- [ ] Do not expose queue mutation outside `notifier.ts` except the idle helper.
- [ ] In `acceptAutoAcceptMatch()`, after the accept POST result is available and `verificationMode === "detached"`:
  - build one `AutoAcceptVerificationJob` per booking entry;
  - include `traceId`, `acceptStartedAt`, `acceptFinishedAt`, `acceptRttMs`, `listAgeMs` when available from the trip/list snapshot, raw accept response, `claimToken`, `acceptAll`, selected trips, and selected request IDs;
  - enqueue the job;
  - return immediately with `pendingVerification += requestIds.length`, no terminal `accepted`/`failed` rows, and no `deferredRequests` for the enqueued request IDs.
- [ ] Preserve immediate failures that occur before an accept POST is attempted:
  - `rule_budget_exhausted` and `request_deduped` should be logged/metriced but should not send LINE failure alerts.
  - Missing `booking_id`/`request_id` remains a skip with warning.
- [ ] Extract the existing post-verify side effects into a shared helper used by inline and detached paths:

```ts
async function finalizeAutoAcceptVerificationOutcome(input: {
  teamId: number;
  outcome: AutoAcceptVerificationOutcome;
  notificationContext?: TeamNotificationContext;
  needBudget?: NeedBudget;
  deferSideEffects: boolean;
}): Promise<{
  accepted: AcceptedTrip[];
  failed: AutoAcceptResult["failed"];
  deferredRequests: number;
}>;
```

- [ ] `finalizeAutoAcceptVerificationOutcome()` must:
  - write success history rows for verified wins;
  - write failed history rows for terminal verified failures;
  - write `indeterminate` history rows for `verify_indeterminate` and `accept_timeout_ambiguous`;
  - call `applyAutoAcceptProgress()` only for verified wins;
  - settle `NeedBudget` only after the progress update commits;
  - release budget immediately for verified non-success requests with `releaseBudget=true`;
  - release request dedupe only when `releaseRequestDedupe=true`;
  - keep terminal lost-race/verify-not-confirmed request keys consumed so non-pending retry does not fire another doomed POST;
  - remember accepted request keys for verified wins;
  - send success LINE notifications only for verified wins;
  - send failure LINE alerts only for `status === "failed"` outcomes, not `indeterminate`;
  - include reason/evidence from `buildAutoAcceptFailureAlertText()`.
- [ ] Make `failed` result entries richer while preserving existing fields:

```ts
failed: Array<{
  bookingId: number;
  requestIds: number[];
  error: string;
  reason?: AutoAcceptFailureReason;
  traceId?: string;
  acceptRttMs?: number;
  listAgeMs?: number;
  pendingTabRead?: boolean;
  confirmedTabRead?: boolean;
  nextAction?: string;
}>;
```

- [ ] Record `metrics.recordAutoAccept(true)` only for verified wins.
- [ ] Record `metrics.recordAutoAccept(false)` only for verified terminal failures, not indeterminate jobs.
- [ ] Leave `tests/auto-accept-success-verify.test.ts` and `tests/auto-accept-ambiguous-timeout.test.ts` in inline mode and ensure they still pass.
- [ ] Add `tests/auto-accept-detached-verify.test.ts`:
  - accept POST is called;
  - `acceptAndNotifyMatchedRules(... verificationMode: "detached", deferSideEffects: true)` resolves before a gated verification fetch resolves;
  - immediate result has `pendingVerification === 1`, `accepted.length === 0`, `failed.length === 0`, `deferredRequests === 0`, `notified === false`;
  - after releasing the gate and calling `awaitAutoAcceptVerificationIdle()`, success history/progress are written;
  - a detached lost race writes a failed history row with `failureReason: "lost_race"`;
  - a detached ambiguous timeout writes `status: "indeterminate"` and does not call normal failure alert logic.
- [ ] Run:
  - `npm test -- auto-accept-detached-verify`
  - `npm test -- auto-accept-success-verify`
  - `npm test -- auto-accept-ambiguous-timeout`
  - `npm test -- auto-accept-accept-all`

### Task 4: Poller Critical-Path Integration

**Files:**
- Modify: `src/controllers/poller.ts`
- Add: `tests/poller-auto-accept-detached-verify.test.ts`
- Modify: `tests/poller-streaming-early-accept.test.ts` only if the helper expectations need updating.
- Modify: `tests/poller-nonpending-accept.test.ts` only if result typing requires it.

- [ ] In `runAutoAcceptForTrips()`, pass `verificationMode: "detached"`:

```ts
const result = await acceptAndNotifyMatchedRules(trips, this.apiClient, {
  teamId: this.teamId,
  notificationContext: this.notificationContext,
  autoAcceptRules: this.tickAutoAcceptRules,
  deferSideEffects: true,
  needBudget: this.tickNeedBudget,
  verificationMode: "detached",
});
```

- [ ] Keep `runNonPendingAcceptAttempt()` inline for this slice. It intentionally returns terminal status to seed `nonPendingAttemptedKeys`, and it is not the primary competitive pending-tab path.
- [ ] Update `runAutoAcceptForTrips()` cleanliness semantics:
  - `failed.length > 0` remains not clean;
  - `deferredRequests > 0` remains not clean;
  - `pendingVerification > 0` is clean because the accept POST has already been submitted and verification is detached.
- [ ] Do not wait for `awaitAutoAcceptVerificationIdle()` in production poller flow.
- [ ] Preserve existing seeding of `nonPendingAttemptedKeys` for inline terminal outcomes; detached verifier keeps terminal request dedupe internally to suppress duplicate lost-race attempts.
- [ ] Add `tests/poller-auto-accept-detached-verify.test.ts`:
  - process one booking with a page callback match;
  - assert accept POST happens before any post-accept verification fetch;
  - gate verification fetches and assert `processOneBooking()` resolves before the gate opens;
  - open the gate, call `awaitAutoAcceptVerificationIdle()`, and assert history/progress eventually reflect the verifier result.
- [ ] Run:
  - `npm test -- poller-auto-accept-detached-verify`
  - `npm test -- poller-streaming-early-accept`
  - `npm test -- poller-nonpending-accept`
  - `npm test -- poller-accept-all-list-name`

### Task 5: Metrics And Dashboard Visibility

**Files:**
- Modify: `src/services/metrics.ts`
- Modify: `src/frontend/types/index.ts`
- Modify: `src/frontend/routes/index.tsx`
- Modify: `src/frontend/routes/auto-accept-history.tsx`
- Modify: `tests/metrics-scheduling.test.ts`

- [ ] Extend `TimedOperation` backend and frontend unions:

```ts
| "autoAcceptVerify"
| "acceptToVerify"
| "listAgeMs"
```

- [ ] Add auto-accept verification metrics:

```ts
export interface AutoAcceptVerificationMetrics {
  queued: number;
  active: number;
  completed: number;
  indeterminate: number;
  maxQueueDepth: number;
  failuresByReason: Record<AutoAcceptFailureReason, number>;
}
```

- [ ] Extend `MetricsSnapshot["autoAccept"]` with:

```ts
verifiedSuccessCount: number;
verifiedFailureCount: number;
pendingVerificationCount: number;
verification: AutoAcceptVerificationMetrics;
```

- [ ] Add collector methods:

```ts
recordAutoAcceptVerificationQueued(queueDepth: number): void;
recordAutoAcceptVerificationActive(active: number, queueDepth: number): void;
recordAutoAcceptVerificationCompleted(outcome: {
  status: VerificationStatus;
  reason?: AutoAcceptFailureReason;
  verificationLatencyMs: number;
  acceptToVerifyMs: number;
}): void;
```

- [ ] Record:
  - `autoAcceptVerify` latency from verification worker start to classified outcome;
  - `acceptToVerify` latency from accept finish to classified outcome;
  - `listAgeMs` when a newly seen booking/trip snapshot has enough timing data to compute it;
  - active/queue counts whenever jobs are enqueued, started, and completed.
- [ ] Keep existing `acceptRtt` unchanged; it remains the isolated accept POST round-trip metric from `api-client.ts`.
- [ ] Update `tests/metrics-scheduling.test.ts` to assert:
  - new operation buckets summarize correctly;
  - queued/active/completed/indeterminate counters update;
  - `failuresByReason.lost_race` increments for a verified failure;
  - empty counters are zeroed and never `NaN`.
- [ ] Update dashboard pipeline cards in `src/frontend/routes/index.tsx` to include:
  - `Verify queue`;
  - `Verify latency`;
  - `Accept->verify`;
  - reason distribution only if compact enough for the existing layout.
- [ ] Update `auto-accept-history` route columns/cards:
  - add `Reason`;
  - add `Trace`;
  - add `Verify status`;
  - render `indeterminate` with a neutral/warning tone rather than failure red.
- [ ] Run:
  - `npm test -- metrics-scheduling`
  - `npm run typecheck`

### Task 6: End-To-End Regression Gates

**Files:**
- Modify only if verification exposes a scoped defect.

- [ ] Run focused tests:

```powershell
npm test -- auto-accept-verifier
npm test -- auto-accept-detached-verify
npm test -- auto-accept-history-diagnostics
npm test -- auto-accept-success-verify
npm test -- auto-accept-ambiguous-timeout
npm test -- auto-accept-accept-all
npm test -- poller-auto-accept-detached-verify
npm test -- poller-streaming-early-accept
npm test -- poller-nonpending-accept
npm test -- poller-accept-all-list-name
npm test -- metrics-scheduling
npm test -- schema-consistency
```

- [ ] Run broader gates:

```powershell
npm run typecheck
npm run build
```

- [ ] Run whitespace/diff hygiene:

```powershell
git diff --check
git status --short
```

- [ ] Review the final diff for:
  - no `.env` or secret output;
  - no generated `src/frontend/routeTree.gen.ts` edits;
  - no deploy/commit/branch changes;
  - no unrelated formatting churn;
  - no verification work on the pending-tab booking detail critical path.

## Rollback Notes

- The poller opt-in is a single `verificationMode: "detached"` call site in `runAutoAcceptForTrips()`.
- If production shows unexpected queue behavior, remove that option to fall back to inline verification while leaving verifier/history diagnostics code in place.
- New history columns are nullable and backwards-compatible.

## Definition Of Done

- Pending-tab trip-level auto-accept submits the accept POST before post-accept verification fetches.
- Poller booking processing no longer waits on post-accept verification fetches in detached mode.
- Existing inline verification tests still pass.
- Both-tab verification still proves wins with status `2` only.
- Ambiguous timeouts become indeterminate without normal failure LINE noise.
- Lost races are visible with reason code, trace ID, accept RTT, tab evidence, history row, and metrics counter.
- Metrics show verify queue depth, verify latency, accept-to-verify latency, and failure reason distribution.
- Focused tests, typecheck, build, and diff hygiene pass.
