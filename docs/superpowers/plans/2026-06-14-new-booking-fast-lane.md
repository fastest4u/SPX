# New Booking Fast Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give newly observed SPX bookings reserved access to detail-fetch capacity so recurring bookings cannot delay their first match and Accept attempt.

**Architecture:** Add a small pure scheduling utility for reserve sizing and stable lane partitioning. Integrate it into `Poller.scheduleBookingDetails` with a persistent pending-fast-lane set and separate lane inflight counters while preserving the existing detail-processing and auto-accept paths.

**Tech Stack:** TypeScript, Node.js, standalone `tsx` assertion tests.

---

### Task 1: Define Fast-Lane Scheduling Behavior

**Files:**
- Create: `tests/booking-fast-lane.test.ts`
- Create: `src/utils/booking-fast-lane.ts`

- [x] Write a failing test proving a concurrency limit of 8 reserves 2 slots, limits 2-4 reserve 1 slot, limit 1 reserves none, and partitioning keeps fast-lane bookings first without disturbing order within either lane.
- [x] Run `npm test -- booking-fast-lane` and confirm it fails because `src/utils/booking-fast-lane.ts` does not exist.
- [x] Implement `fastLaneReserveForConcurrency()` and `partitionBookingsByFastLane()`.
- [x] Run `npm test -- booking-fast-lane` and confirm it passes.

### Task 2: Reserve Capacity for Newly Observed Bookings

**Files:**
- Create: `tests/poller-fast-lane.test.ts`
- Modify: `src/controllers/poller.ts`

- [x] Write a failing poller scheduling test with concurrency 4. Prime four startup bookings and hold their detail promises open; assert only three background jobs launch. Add a fifth unseen booking and assert it launches immediately while the fourth old booking remains blocked.
- [x] Run `npm test -- poller-fast-lane` and confirm the old scheduler launches all four startup bookings, causing the assertion to fail.
- [x] Add a bounded `pendingFastLaneBookingIds` set and separate fast/background inflight counters.
- [x] During list freshness processing, queue unseen post-startup IDs and retain them across transient list omissions until launch or bounded FIFO eviction.
- [x] Partition origin-ordered bookings into fast and background lanes.
- [x] Allow fast work up to total concurrency and background work only up to `total - reserve`.
- [x] Remove a pending ID only when its detail task launches; decrement the matching lane counter in `finally`.
- [x] Emit an aggregate `booking-fast-lane-scheduled` log when new work is queued, launched, pending, or blocked.
- [x] Run `npm test -- poller-fast-lane` and confirm it passes.

### Task 3: Regression Verification

**Files:**
- Modify only if verification reveals a defect in the scoped implementation.

- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run `git diff --check`.
- [x] Review the diff to confirm no generated files, secrets, or unrelated dirty-worktree changes were modified.
- [x] Do not commit, push, or deploy unless the operator explicitly requests it.
