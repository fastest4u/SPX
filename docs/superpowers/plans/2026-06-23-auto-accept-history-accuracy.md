# Auto Accept History Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each behavior change. Keep the accept hot path fast; do not deploy or commit unless the operator explicitly requests it.

**Goal:** Make `auto_accept_history` accurate for every accept path without slowing competitive `accept_all` calls.

**Architecture:** Keep the existing fast booking-name `accept_all` POST on the hot path. Write an initial history row for observability, then run a detached post-accept reconcile that fetches both SPX request-list tabs, verifies owned accepted requests, updates that same history row with exact request IDs/details, and sends the same success notification used by normal auto-accept. Manual admin `accept_all` continues to use before/after reconciliation and writes team-scoped history.

**Tech Stack:** TypeScript, Node.js, Drizzle ORM, standalone `tsx` assertion tests.

---

### Task 1: Fast `accept_all` Reconcile Contract

**Files:**
- Modify: `tests/poller-accept-all-list-name.test.ts`

- [x] Add a failing test proving route-matched fast `accept_all` does not fetch detail before the SPX accept call.
- [x] In the same test, prove a detached reconcile fetches pending and confirmed tabs after accept and updates `auto_accept_history` with exact request IDs, accepted count, route, and vehicle type.
- [x] Run `npm test -- poller-accept-all-list-name` and confirm it fails before implementation.

### Task 2: Repository Support For Updating The Same History Row

**Files:**
- Modify: `src/repositories/auto-accept-repository.ts`

- [x] Add an insert helper that returns the created history row ID without changing existing call sites.
- [x] Add a team-scoped update helper for reconciled details so a row can only be updated for its own `team_id`.
- [x] Keep existing list/query behavior unchanged for admin and non-admin scopes.

### Task 3: Poller Detached Reconciliation

**Files:**
- Modify: `src/controllers/poller.ts`

- [x] After a successful fast booking-name `accept_all`, insert a preliminary success history row immediately.
- [x] Start a detached reconcile task that fetches pending and confirmed request-list tabs after accept, extracts owned accepted trips, and updates the same row with exact details.
- [x] Send the auto-accept success notification only when reconciled accepted trips are present.
- [x] Preserve current failure handling and avoid blocking the original `accept_all` return path on reconcile.
- [x] Avoid counting or notifying stale pre-existing accepted trips when the reconcile cannot prove they belong to this accept attempt.

### Task 4: Verification

**Files:**
- Modify only if verification reveals a scoped defect.

- [x] Run `npm test -- poller-accept-all-list-name`.
- [x] Run `npm test -- bidding-controller-accept-all`.
- [x] Run `npm test -- auto-accept-accept-all`.
- [x] Run `npm test -- auto-accept-success-verify`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run `git diff --check` on touched source/test/plan files.
- [x] Review the diff for secrets, generated files, unrelated churn, and accidental deploy/commit changes.
