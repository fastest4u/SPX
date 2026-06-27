# Win-First Auto-Accept Verify-After Design

## Goal

Maximize the chance that SPX auto-accept wins competitive bidding races while still verifying the real upstream outcome after the accept attempt.

The money path must be:

1. detect a rule-matching request;
2. claim rule budget and request dedupe synchronously;
3. send the SPX accept POST immediately;
4. verify, write history, update rule progress, and notify after the accept POST is already in flight or complete.

Verification proves the result. It must not become a pre-accept gate.

## Context

The current system already has several speed-oriented pieces:

- `Poller.processOneBooking()` starts auto-accept from request-list page callbacks as soon as matching trips are seen.
- `ApiClient.submitAcceptBookingRequest()` measures isolated `acceptRtt` and does not retry non-idempotent accept POSTs.
- `acceptAndNotifyMatchedRules()` verifies accepted requests against both pending and confirmed request-list tabs.
- Ambiguous timeout/network outcomes can be deferred instead of immediately counted as failure.
- Fast `accept_all` by booking name already submits first and reconciles details afterward.

The remaining design problem is that normal trip-level auto-accept still mixes accept, verify, side effects, and booking-slot cleanliness into one operation. That is correct but not ideal for winning races when verification requests compete with fresh accept work.

## Non-Goals

- Do not verify before sending accept.
- Do not retry non-idempotent accept POSTs automatically.
- Do not count `retcode=0` as proof of ownership without post-accept verification.
- Do not count `acceptance_status=6` as a verified win unless SPX ownership semantics are later proven.
- Do not change rule matching semantics in this slice.
- Do not add deploy, branch, commit, or production changes as part of the spec-only step.

## Recommended Architecture

### 1. Accept Attempt Stays On The Critical Path

When a pending-tab trip matches an enabled auto-accept rule:

- claim `NeedBudget` for the selected request IDs;
- claim request-level dedupe keys;
- group selected request IDs by booking;
- send `acceptBookingRequests()` or `acceptAllBookingRequests()` immediately.

The accept path may parse the accept response enough to classify clear auth/session/API errors, but it must not do extra request-list reads before the accept POST.

### 2. Detached Verification Work Queue

After each accept POST returns or times out, enqueue a verification job with:

- `teamId`;
- `ruleId` and `ruleName`;
- `bookingId`;
- selected `requestIds`;
- selected trip snapshots used for the original decision;
- `claimToken`;
- accept response fields: `ok`, `httpStatus`, `retcode`, `message`, `error`;
- `acceptStartedAt`, `acceptFinishedAt`, and `acceptRttMs`;
- `ambiguousAccept` boolean for timeout/network `httpStatus=0`;
- a trace ID such as `aa:${teamId}:${bookingId}:${requestIds.join("-")}:${acceptStartedAt}`.

Verification jobs run outside the booking detail slot. They use a small independent concurrency limit so request-list verification cannot starve fresh detail fetches or accept POSTs. A starting limit of 2 per process is enough for correctness while keeping the hot path clear. This can later become a setting if production data shows backlog.

### 3. Verify Against Both Tabs

Each verification job fetches both request-list tabs:

- pending confirmation tab;
- non-pending or confirmed tab.

The verifier merges statuses by `request_id` and treats only `request_acceptance_status=2` as a verified win. Other observed statuses are classified but do not decrement need as success.

If both tab fetches fail or throw, the result is `verify_indeterminate`, not `failed`.

### 4. Ambiguous Accept Policy

If the accept POST times out or throws before an HTTP response, the request may still commit upstream. For ambiguous accepts:

- wait a short settle delay before the first verify attempt;
- if status 2 is observed, record success;
- if status 2 is not observed but tabs were readable, keep the result `verify_indeterminate` for at least one delayed recheck before declaring a lost race;
- do not send a normal failure LINE alert until the verifier has enough evidence to classify the outcome.

This biases toward avoiding false failure alerts and false quota release for requests that might have committed server-side.

### 5. Rule Progress And NeedBudget Settlement

Verified success:

- insert or update auto-accept history as success;
- decrement rule need through `applyAutoAcceptProgress()`;
- settle the corresponding `NeedBudget` claim after the DB decrement commits;
- remember accepted request keys.

Verified failure:

- release request-level dedupe for retryable failure classes only;
- release `NeedBudget` when the verifier proves the request was not accepted;
- insert or update auto-accept history as failed with a reason code;
- send LINE failure alert with reason and evidence.

Verify indeterminate:

- release request-level dedupe so later polls can retry if the request remains pending;
- keep the `NeedBudget` claim held until either a later verification resolves it or the existing claim TTL expires;
- write a non-success history/evidence row only if it helps operator diagnosis without counting as final failure;
- avoid noisy failure alerts.

### 6. Failure Reason Taxonomy

Each verified non-success result should have one stable reason code:

- `lost_race`: SPX shows the request is no longer pending and not owned by us.
- `session_expired`: accept response or list verification indicates auth/session failure.
- `accept_api_error`: SPX returned a clear non-success response before verification found ownership.
- `accept_timeout_ambiguous`: accept timed out and verification has not proven final ownership.
- `verify_indeterminate`: both verification tabs failed or verification threw.
- `verify_not_confirmed`: tabs were readable, but selected request IDs did not show status 2.
- `rule_budget_exhausted`: request was not sent because local budget was already claimed.
- `request_deduped`: request was already in-flight or previously terminal in this process.

The taxonomy should be used in logs, history, metrics, and LINE alerts so operations can see whether the bot is losing because of speed, session/auth, SPX API behavior, or local protection logic.

## Data Flow

1. Poller fetches bidding list.
2. Fast lane schedules new bookings before recurring scans.
3. Request-list page callback extracts trips from each page.
4. Matching trips are sent to auto-accept immediately.
5. Auto-accept claims budget and dedupe keys.
6. API client sends the accept POST and records `acceptRtt`.
7. Auto-accept enqueues verification with a trace ID and returns control to the poller without waiting for request-list verification side effects.
8. Verification worker fetches both tabs under separate concurrency.
9. Verification worker classifies success, failure, or indeterminate.
10. Side effects run from the classified result: history, rule progress, budget settlement or release, metrics, and LINE alert.

## Operator Experience

LINE failure alerts should be shorter but more useful than the current generic failure text. Each alert should include:

- reason code;
- booking ID and selected request IDs;
- rule name;
- route and vehicle type when available;
- `acceptRttMs`;
- list age or booking age when available;
- whether verification read pending tab, confirmed tab, or neither;
- next action in plain language.

Examples:

- `lost_race`: "SPX shows another agency took this request before our verify. Check listAgeMs and acceptRtt."
- `session_expired`: "Refresh the SPX cookie/device credentials for this team."
- `verify_indeterminate`: "No final failure yet. Verification could not read SPX tabs; the bot will retry/reconcile."

Auto-accept history should store enough of the same fields to make the latest failures reviewable from the dashboard without digging through server logs.

## Metrics

Add counters or dimensions for:

- accepted verified wins;
- verified failures by reason code;
- indeterminate verification backlog;
- verification queue depth;
- verification latency;
- accept-to-verify latency;
- acceptRtt p50/p95/p99;
- detailToFirstMatch p50/p95/p99;
- listAgeMs for newly seen booking rows;
- cooldown skipped versus concurrency skipped.

The success metric should be verified wins, not raw accept response success.

## Correctness Constraints

- Verification must keep using both tabs.
- History and LINE notifications must not change the upstream accept outcome.
- Notification failure must not turn an SPX accept success into failure.
- DB write failure must not block the accept POST path.
- NeedBudget must not over-grant across ticks while verification is pending.
- Ambiguous accepts must not be double-submitted automatically.
- A later successful verification must be able to correct an earlier indeterminate state.

## Testing

Use focused tests before broader gates:

- trip-level auto-accept sends the accept POST before any post-accept verification fetch;
- verification jobs run through a separate queue/concurrency path;
- successful post-accept verify decrements rule need and writes success history;
- clear lost race writes failed history with `lost_race` and releases budget;
- ambiguous timeout defers failure and does not send a normal failure alert immediately;
- both-tab verify still detects accepted requests moved out of the pending tab;
- LINE alert text includes reason code and next action;
- fast `accept_all` behavior remains accept-first and reconcile-after.

After targeted tests pass, run:

- `npm run typecheck`;
- `npm run build`;
- relevant auto-accept tests from `npm test -- auto-accept`, `npm test -- poller`, and accept-all targeted tests.

## Rollout And Validation

Deploy validation should watch:

- verified auto-accept win rate;
- failure reason distribution;
- `listAgeMs`;
- `detailToFirstMatch`;
- `acceptRtt`;
- verification queue depth and lag;
- cooldown churn;
- LINE failure alert volume.

The change is successful when failure alerts become less noisy, verified win rate does not regress, and the top failure reasons are visible without manual log archaeology.
