import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
  markAutoAcceptJobSettlementCheckpoint,
  type AutoAcceptAttemptKind,
  type AutoAcceptJobRow,
} from "../src/repositories/auto-accept-job-repository.js";
import {
  claimNotificationOutboxBatch,
  createNotificationEventAndOutbox,
} from "../src/repositories/notification-repository.js";
import { getBookingHistory } from "../src/repositories/booking-history-repository.js";
import { getAutoAcceptHistory } from "../src/repositories/auto-accept-repository.js";
import {
  runAutoAcceptWorkerBatch,
  type AutoAcceptJobExecutionContext,
  type AutoAcceptJobExecutionResult,
} from "../src/services/auto-accept-worker.js";
import {
  createAutoAcceptJobSettlementOperations,
  runAutoAcceptJobSettlementBatch,
  settleAutoAcceptJobFromCheckpoint,
  type AutoAcceptJobSettlementOperations,
  type AutoAcceptJobProgressSettlement,
  type AutoAcceptJobHistorySettlement,
  type AutoAcceptJobNotificationSettlement,
} from "../src/services/auto-accept-job-settlement.js";
import { normalizeNotificationEvent } from "../src/services/notification-events.js";
import { createNotificationPublisher } from "../src/services/notification-publisher.js";
import { createRule, readRules } from "../src/services/notify-rules.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function baseJob(overrides: {
  teamId?: number;
  bookingId?: number;
  requestId?: number;
  ruleId?: string;
  attemptKind?: AutoAcceptAttemptKind;
  payload?: Record<string, unknown>;
} = {}) {
  const identity = {
    teamId: overrides.teamId ?? 2,
    bookingId: overrides.bookingId ?? 2791810,
    requestId: overrides.requestId ?? 40288114,
    ruleId: overrides.ruleId ?? "rule-1",
    attemptKind: overrides.attemptKind ?? "pending_request",
  };
  const payload = {
    executionMode: "cutover",
    schemaVersion: 1,
    idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity),
    attemptKind: identity.attemptKind,
    teamId: identity.teamId,
    bookingId: identity.bookingId,
    requestId: identity.requestId,
    ruleId: identity.ruleId,
    ruleName: "Bangkok to Rayong",
    acceptAll: false,
    source: "pending_tab",
    trip: {
      request_id: identity.requestId,
      booking_id: identity.bookingId,
      origin: "Bangkok",
      destination: "Rayong",
      vehicle_type: "4W",
      acceptance_status: 2,
      listAgeMs: 1200,
    },
    ruleSnapshot: {
      need: 1,
      accept_all: false,
      enabled: true,
      fulfilled: false,
    },
    observedAt: "2030-01-01T00:00:00.000Z",
    pollerNodeId: "poller-01",
    ...overrides.payload,
  };
  return {
    ...identity,
    payload,
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

function createOperations(overrides: Partial<AutoAcceptJobSettlementOperations> = {}) {
  const progress: AutoAcceptJobProgressSettlement[] = [];
  const history: AutoAcceptJobHistorySettlement[] = [];
  const notifications: AutoAcceptJobNotificationSettlement[] = [];
  const operations: AutoAcceptJobSettlementOperations = {
    settleProgress: async (input) => {
      progress.push(input);
      await overrides.settleProgress?.(input);
    },
    writeHistory: async (input) => {
      history.push(input);
      await overrides.writeHistory?.(input);
    },
    enqueueNotification: async (input) => {
      notifications.push(input);
      await overrides.enqueueNotification?.(input);
    },
  };
  return { operations, progress, history, notifications };
}

function settlementContext(input: {
  row: AutoAcceptJobRow;
  renewals: boolean[];
  currentTimes?: Date[];
  checkpoints?: Array<Parameters<AutoAcceptJobExecutionContext["checkpointSettlement"]>[0]>;
  checkpointNowArguments?: Array<Date | undefined>;
}): AutoAcceptJobExecutionContext {
  let renewalIndex = 0;
  let currentTimeIndex = 0;
  return {
    row: input.row,
    claimToken: "direct-settlement-claim",
    ownerNodeId: "direct-settlement-worker",
    now: new Date("2030-01-01T00:10:00.000Z"),
    currentTime: () => {
      const value = input.currentTimes?.[currentTimeIndex];
      currentTimeIndex += 1;
      assert.ok(value, `unexpected currentTime call ${currentTimeIndex}`);
      return value;
    },
    renewClaim: async () => {
      const value = input.renewals[renewalIndex];
      renewalIndex += 1;
      assert.notEqual(value, undefined, `unexpected renewClaim call ${renewalIndex}`);
      return value;
    },
    checkpointResult: async () => true,
    checkpointSettlement: async (checkpoint, now) => {
      input.checkpoints?.push(checkpoint);
      input.checkpointNowArguments?.push(now);
      return true;
    },
  };
}

function assertSettlementClaimLost(result: AutoAcceptJobExecutionResult, retryDelayMs: number): void {
  assert.deepEqual(result, {
    outcome: "retry",
    reasonCode: "settlement_claim_lost",
    error: "settlement claim was lost before side effect",
    retryDelayMs,
    count: "verify",
  });
}

async function assertSideEffectOutlivesLeaseRecovery(input: {
  boundary: "progress" | "history";
  bookingId: number;
  requestId: number;
  claimAt: Date;
}): Promise<void> {
  await resetDb();
  const rule = await createRule(2, {
    name: `${input.boundary} lease-boundary rule`,
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 2,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const job = await checkpointOwnedForResume({
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: rule.id,
  });
  const claimExpiresAt = new Date(input.claimAt.getTime() + 60_000);
  let clockNow = input.claimAt;
  let notificationPublishAttempts = 0;
  const publisher = createNotificationPublisher({
    publish: async (envelope) => {
      notificationPublishAttempts += 1;
      const event = normalizeNotificationEvent(
        envelope.event,
        `${input.boundary}-lease-boundary-worker`,
        envelope.eventKey,
      );
      await createNotificationEventAndOutbox(event, {
        targetType: "line_group",
        targetId: `${input.boundary}-lease-boundary-line-group`,
        title: "Auto accept",
        message: envelope.event.message,
      });
      return { ok: true };
    },
  });
  const durableOperations = createAutoAcceptJobSettlementOperations({ publisher });
  const expiringOperations: AutoAcceptJobSettlementOperations = {
    settleProgress: async (settlement) => {
      await durableOperations.settleProgress(settlement);
      if (input.boundary === "progress") clockNow = claimExpiresAt;
    },
    writeHistory: async (settlement) => {
      await durableOperations.writeHistory(settlement);
      if (input.boundary === "history") clockNow = claimExpiresAt;
    },
    enqueueNotification: (settlement) => durableOperations.enqueueNotification(settlement),
  };

  const expiredOwner = `${input.boundary}-expired-worker`;
  const expiredToken = `${input.boundary}-expired-claim`;
  const expiredSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: expiredOwner,
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: input.claimAt,
    clock: () => clockNow,
    claimTokenFactory: () => expiredToken,
    operations: expiringOperations,
  });
  assert.equal(expiredSummary.claimed, 1);
  assert.equal(expiredSummary.succeeded, 0);
  assert.equal(expiredSummary.retried, 0);
  assert.equal(expiredSummary.settleFailures, 1);
  const expiredRow = await getAutoAcceptJobById(job.id);
  assert.ok(expiredRow);
  assert.equal(expiredRow.status, "claimed");
  assert.equal(
    expiredRow.progressSettledAt !== null,
    input.boundary === "history",
    "only a progress checkpoint completed before the history boundary",
  );
  assert.equal(expiredRow.historyWrittenAt, null);
  assert.equal(expiredRow.notificationEnqueuedAt, null);
  assert.equal(notificationPublishAttempts, 0, "the expired claimant must not continue to notification");
  const ruleAfterExpiry = (await readRules(2)).find((item) => item.id === rule.id);
  assert.ok(ruleAfterExpiry);
  assert.equal(ruleAfterExpiry.need, 1, "the completed progress side effect must remain durable");
  assert.equal(
    (await getAutoAcceptHistory(2, { limit: 20, sortBy: "id", sortDir: "asc" })).length,
    input.boundary === "history" ? 1 : 0,
    "only side effects completed before lease expiry may be durable",
  );
  assert.equal((await claimNotificationOutboxBatch(
    `${input.boundary}-pre-recovery-outbox-inspector`,
    5,
    60_000,
    claimExpiresAt,
  )).length, 0, "the expired claimant must not create notification outbox work");

  assert.equal(await markAutoAcceptJobSettlementCheckpoint({
    id: job.id,
    ownerNodeId: expiredOwner,
    claimToken: expiredToken,
    ...(input.boundary === "progress"
      ? { progressSettledAt: claimExpiresAt }
      : { historyWrittenAt: claimExpiresAt }),
    now: claimExpiresAt,
  }), false, `the expired claimant must not checkpoint ${input.boundary}`);

  const replacementAt = new Date(claimExpiresAt.getTime() + 1_000);
  const replacementSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: `${input.boundary}-replacement-worker`,
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: replacementAt,
    claimTokenFactory: () => `${input.boundary}-replacement-claim`,
    operations: durableOperations,
  });
  assert.equal(replacementSummary.claimed, 1);
  assert.equal(replacementSummary.succeeded, 1);
  const ruleAfterRecovery = (await readRules(2)).find((item) => item.id === rule.id);
  assert.ok(ruleAfterRecovery);
  assert.equal(ruleAfterRecovery.need, 1, "job-keyed progress replay must not decrement the rule twice");
  assert.equal(
    (await getAutoAcceptHistory(2, { limit: 20, sortBy: "id", sortDir: "asc" })).length,
    1,
    "job-keyed history replay must converge on one durable history row",
  );
  const outbox = await claimNotificationOutboxBatch(
    `${input.boundary}-post-recovery-outbox-inspector`,
    5,
    60_000,
    new Date(replacementAt.getTime() + 60_000),
  );
  assert.equal(outbox.length, 1, "replacement recovery must create one durable notification outbox row");
  assert.equal(outbox[0]?.eventKey, `auto_accept_owned:team:2:booking:${input.bookingId}:req:${input.requestId}`);
  assert.equal(notificationPublishAttempts, 1);
  const recoveredRow = await getAutoAcceptJobById(job.id);
  assert.ok(recoveredRow);
  assert.equal(recoveredRow.status, "succeeded");
  assert.ok(recoveredRow.progressSettledAt);
  assert.ok(recoveredRow.historyWrittenAt);
  assert.ok(recoveredRow.notificationEnqueuedAt);
}

async function checkpointOwnedForResume(input: {
  bookingId?: number;
  requestId?: number;
  ruleId?: string;
  attemptKind?: AutoAcceptAttemptKind;
  payload?: Record<string, unknown>;
  progressSettledAt?: Date;
  historyWrittenAt?: Date;
}) {
  const job = await enqueueAutoAcceptJob(baseJob({
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: input.ruleId,
    attemptKind: input.attemptKind,
    payload: input.payload,
  }));
  const summary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "checkpoint-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => `checkpoint-${job.id}`,
    execute: async ({ checkpointResult, checkpointSettlement }) => {
      assert.equal(await checkpointResult({
        resultStatus: "owned",
        resultReasonCode: "verified_owned",
        winningAttemptTraceId: `aa:2:${job.bookingId}:${job.requestId}:2030`,
      }, new Date("2030-01-01T00:01:01.000Z")), true);
      if (input.progressSettledAt || input.historyWrittenAt) {
        assert.equal(await checkpointSettlement({
          ...(input.progressSettledAt ? { progressSettledAt: input.progressSettledAt } : {}),
          ...(input.historyWrittenAt ? { historyWrittenAt: input.historyWrittenAt } : {}),
        }, new Date("2030-01-01T00:01:02.000Z")), true);
      }
      return {
        outcome: "retry",
        reasonCode: "settlement_pending",
        error: "settlement pending after canonical result",
        retryDelayMs: 1,
        count: "verify",
      };
    },
  });
  assert.equal(summary.retried, 1);
  return job;
}

async function main() {
  await resetDb();

  const ordinaryPending = await enqueueAutoAcceptJob({
    ...baseJob({
      bookingId: 2791809,
      requestId: 40288113,
    }),
    observedAt: new Date("2030-01-01T00:01:30.000Z"),
  });
  const owned = await checkpointOwnedForResume({});
  const ownedOps = createOperations();
  const ownedSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:02:00.000Z"),
    claimTokenFactory: () => "settle-owned",
    operations: ownedOps.operations,
  });
  assert.equal(ownedSummary.claimed, 1);
  assert.equal(ownedSummary.succeeded, 1);
  const ordinaryPendingAfter = await getAutoAcceptJobById(ordinaryPending.id);
  assert.ok(ordinaryPendingAfter);
  assert.equal(ordinaryPendingAfter.status, "pending");
  assert.equal(ordinaryPendingAfter.verifyCount, 0);
  assert.deepEqual(ownedOps.progress.map((item) => ({
    teamId: item.teamId,
    ruleId: item.ruleId,
    acceptedCount: item.acceptedCount,
  })), [{ teamId: 2, ruleId: "rule-1", acceptedCount: 1 }]);
  assert.deepEqual(ownedOps.history.map((item) => item.record), [{
    ruleId: "rule-1",
    ruleName: "Bangkok to Rayong",
    bookingId: 2791810,
    requestIds: [40288114],
    acceptedCount: 1,
    origin: "Bangkok",
    destination: "Rayong",
    vehicleType: "4W",
    status: "success",
    traceId: "aa:2:2791810:40288114:2030",
    listAgeMs: 1200,
    verificationStatus: "verified_success",
    verifiedAt: new Date("2030-01-01T00:02:00.000Z"),
  }]);
  assert.deepEqual(ownedOps.notifications.map((item) => ({
    teamId: item.teamId,
    bookingId: item.bookingId,
    requestIds: item.requestIds,
    traceId: item.traceId,
  })), [{
    teamId: 2,
    bookingId: 2791810,
    requestIds: [40288114],
    traceId: "aa:2:2791810:40288114:2030",
  }]);
  const ownedAfter = await getAutoAcceptJobById(owned.id);
  assert.ok(ownedAfter);
  assert.equal(ownedAfter.status, "succeeded");
  assert.equal(ownedAfter.attemptCount, 0);
  assert.equal(ownedAfter.verifyCount, 1);
  assert.ok(ownedAfter.progressSettledAt);
  assert.ok(ownedAfter.historyWrittenAt);
  assert.ok(ownedAfter.notificationEnqueuedAt);

  await resetDb();

  const partial = await checkpointOwnedForResume({
    bookingId: 2791811,
    requestId: 40288115,
    progressSettledAt: new Date("2030-01-01T00:03:00.000Z"),
    historyWrittenAt: new Date("2030-01-01T00:03:01.000Z"),
  });
  const partialOps = createOperations();
  const partialSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:04:00.000Z"),
    claimTokenFactory: () => "settle-partial",
    operations: partialOps.operations,
  });
  assert.equal(partialSummary.succeeded, 1);
  assert.equal(partialOps.progress.length, 0);
  assert.equal(partialOps.history.length, 0);
  assert.equal(partialOps.notifications.length, 1);
  const partialAfter = await getAutoAcceptJobById(partial.id);
  assert.ok(partialAfter);
  assert.equal(partialAfter.status, "succeeded");
  assert.ok(partialAfter.progressSettledAt);
  assert.ok(partialAfter.historyWrittenAt);
  assert.ok(partialAfter.notificationEnqueuedAt);

  const retrying = await checkpointOwnedForResume({
    bookingId: 2791812,
    requestId: 40288116,
  });
  const retryOps = createOperations({
    writeHistory: async () => {
      throw new Error("history unavailable");
    },
  });
  const retrySummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:05:00.000Z"),
    claimTokenFactory: () => "settle-retry",
    retryDelayMsOnSettlementError: 45_000,
    operations: retryOps.operations,
  });
  assert.equal(retrySummary.retried, 1);
  assert.equal(retryOps.progress.length, 1);
  assert.equal(retryOps.history.length, 1);
  assert.equal(retryOps.notifications.length, 0);
  const retryAfter = await getAutoAcceptJobById(retrying.id);
  assert.ok(retryAfter);
  assert.equal(retryAfter.status, "retrying");
  assert.equal(retryAfter.lastReasonCode, "history_settlement_failed");
  assert.equal(retryAfter.verifyCount, 2);
  assert.ok(retryAfter.progressSettledAt);
  assert.equal(retryAfter.historyWrittenAt, null);
  assert.equal(retryAfter.notificationEnqueuedAt, null);

  const defaultOpsPublished: unknown[] = [];
  const defaultRule = await createRule(2, {
    name: "Bangkok to Rayong",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 2,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const defaultOps = createAutoAcceptJobSettlementOperations({
    publisher: {
      publish: async () => ({ ok: true }),
      autoAcceptOwned: async (input) => {
        defaultOpsPublished.push(input);
        return { ok: true };
      },
    },
  });
  const defaultJob = await checkpointOwnedForResume({
    bookingId: 2791813,
    requestId: 40288117,
    ruleId: defaultRule.id,
  });
  const defaultSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:05:30.000Z"),
    claimTokenFactory: () => "settle-default-ops",
    operations: defaultOps,
  });
  assert.equal(defaultSummary.succeeded, 1);
  assert.deepEqual(defaultOpsPublished, [{
    teamId: 2,
    teamName: "Team 2",
    bookingId: 2791813,
    requestIds: [40288117],
    traceId: "aa:2:2791813:40288117:2030",
    message: "SPX Auto-Accept สำเร็จ 1 รายการ\nbooking_id=2791813\nrequests=[40288117]\nroute=Bangkok -> Rayong\nvehicle=4W",
    evidence: {
      reasonCode: "verified_owned",
      source: "pending_tab",
      attemptKind: "pending_request",
    },
  }]);
  const defaultAfter = await getAutoAcceptJobById(defaultJob.id);
  assert.ok(defaultAfter);
  assert.equal(defaultAfter.status, "succeeded");
  assert.ok(defaultAfter.progressSettledAt);
  assert.ok(defaultAfter.historyWrittenAt);
  assert.ok(defaultAfter.notificationEnqueuedAt);

  await resetDb();
  const crashRule = await createRule(2, {
    name: "Bangkok to Rayong",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 2,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const crashPublished: unknown[] = [];
  const crashOps = createAutoAcceptJobSettlementOperations({
    publisher: {
      publish: async () => ({ ok: true }),
      autoAcceptOwned: async (input) => {
        crashPublished.push(input);
        return { ok: true };
      },
    },
  });
  const crashJob = await checkpointOwnedForResume({
    bookingId: 2791814,
    requestId: 40288118,
    ruleId: crashRule.id,
    attemptKind: "own_status_reconcile",
    payload: {
      source: "reconciliation",
      trip: {
        request_id: 40288118,
        booking_id: 2791814,
        booking_name: "Crash-gap booking",
        agency_name: "Crash-gap agency",
        route: "Bangkok -> Rayong",
        origin: "Bangkok",
        destination: "Rayong",
        cost_type: "contract",
        trip_type: "linehaul",
        shift_type: "day",
        vehicle_type: "4W",
        standby_datetime: "2030-01-01T06:00:00.000Z",
        acceptance_status: 2,
        assignment_status: 1,
        listAgeMs: 1200,
      },
    },
  });
  await crashOps.settleProgress({
    jobId: crashJob.id,
    teamId: 2,
    bookingId: 2791814,
    requestIds: [40288118],
    ruleId: crashRule.id,
    acceptedCount: 1,
    traceId: "aa:2:2791814:40288118:2030",
    reasonCode: "verified_owned",
  });
  await crashOps.writeHistory({
    jobId: crashJob.id,
    teamId: 2,
    record: {
      ruleId: crashRule.id,
      ruleName: "Bangkok to Rayong",
      bookingId: 2791814,
      requestIds: [40288118],
      acceptedCount: 1,
      origin: "Bangkok",
      destination: "Rayong",
      vehicleType: "4W",
      status: "success",
      traceId: "aa:2:2791814:40288118:2030",
      listAgeMs: 1200,
      verificationStatus: "verified_success",
      verifiedAt: new Date("2030-01-01T00:06:00.000Z"),
    },
  });
  const crashResumeSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:06:30.000Z"),
    claimTokenFactory: () => "settle-after-crash",
    operations: crashOps,
  });
  assert.equal(crashResumeSummary.succeeded, 1);
  const [crashRuleAfter] = (await readRules(2)).filter((item) => item.id === crashRule.id);
  assert.ok(crashRuleAfter);
  assert.equal(crashRuleAfter.need, 1);
  const crashHistory = await getAutoAcceptHistory(2, { limit: 20, sortBy: "id", sortDir: "asc" });
  assert.equal(crashHistory.length, 1);
  assert.deepEqual(
    (await getBookingHistory(2, { limit: 20, sortBy: "request_id", sortDir: "asc" })).map((row) => ({
      teamId: row.teamId,
      bookingId: row.bookingId,
      requestId: row.requestId,
    })),
    [{ teamId: 2, bookingId: 2791814, requestId: 40288118 }],
    "crash recovery must backfill booking history even when the auto-accept history ledger already exists",
  );
  assert.equal(crashPublished.length, 1);
  const crashAfter = await getAutoAcceptJobById(crashJob.id);
  assert.ok(crashAfter);
  assert.equal(crashAfter.status, "succeeded");
  assert.ok(crashAfter.progressSettledAt);
  assert.ok(crashAfter.historyWrittenAt);
  assert.ok(crashAfter.notificationEnqueuedAt);

  await resetDb();
  const fencedJob = await checkpointOwnedForResume({
    bookingId: 2791815,
    requestId: 40288119,
  });
  const fencedRow = await getAutoAcceptJobById(fencedJob.id);
  assert.ok(fencedRow);

  const beforeProgressOps = createOperations();
  const beforeProgressResult = await settleAutoAcceptJobFromCheckpoint(settlementContext({
    row: fencedRow,
    renewals: [false],
  }), {
    operations: beforeProgressOps.operations,
    retryDelayMsOnSettlementError: 45_000,
  });
  assertSettlementClaimLost(beforeProgressResult, 45_000);
  assert.equal(beforeProgressOps.progress.length, 0);
  assert.equal(beforeProgressOps.history.length, 0);
  assert.equal(beforeProgressOps.notifications.length, 0);

  const nonOwnedOps = createOperations();
  const nonOwnedResult = await settleAutoAcceptJobFromCheckpoint(settlementContext({
    row: {
      ...fencedRow,
      resultStatus: "failed",
      resultReasonCode: "verified_failed",
    },
    renewals: [false],
  }), {
    operations: nonOwnedOps.operations,
    retryDelayMsOnSettlementError: 47_000,
  });
  assertSettlementClaimLost(nonOwnedResult, 47_000);
  assert.equal(nonOwnedOps.progress.length, 0);
  assert.equal(nonOwnedOps.history.length, 0);
  assert.equal(nonOwnedOps.notifications.length, 0);

  const progressBoundaryOps = createOperations();
  const progressBoundaryCheckpoints: Array<Parameters<AutoAcceptJobExecutionContext["checkpointSettlement"]>[0]> = [];
  const progressBoundaryCheckpointNow: Array<Date | undefined> = [];
  const progressCompletedAt = new Date("2030-01-01T00:10:01.000Z");
  const progressBoundaryResult = await settleAutoAcceptJobFromCheckpoint(settlementContext({
    row: fencedRow,
    renewals: [true, false],
    currentTimes: [progressCompletedAt],
    checkpoints: progressBoundaryCheckpoints,
    checkpointNowArguments: progressBoundaryCheckpointNow,
  }), {
    operations: progressBoundaryOps.operations,
    retryDelayMsOnSettlementError: 45_000,
  });
  assertSettlementClaimLost(progressBoundaryResult, 45_000);
  assert.equal(progressBoundaryOps.progress.length, 1);
  assert.equal(progressBoundaryOps.history.length, 0);
  assert.equal(progressBoundaryOps.notifications.length, 0);
  assert.deepEqual(progressBoundaryCheckpoints, [{ progressSettledAt: progressCompletedAt }]);
  assert.deepEqual(progressBoundaryCheckpointNow, [undefined]);

  const notificationBoundaryOps = createOperations();
  const notificationBoundaryCheckpoints: Array<Parameters<AutoAcceptJobExecutionContext["checkpointSettlement"]>[0]> = [];
  const notificationBoundaryCheckpointNow: Array<Date | undefined> = [];
  const notificationBoundaryTimes = [
    new Date("2030-01-01T00:11:01.000Z"),
    new Date("2030-01-01T00:11:02.000Z"),
    new Date("2030-01-01T00:11:03.000Z"),
  ];
  const notificationBoundaryResult = await settleAutoAcceptJobFromCheckpoint(settlementContext({
    row: fencedRow,
    renewals: [true, true, false],
    currentTimes: notificationBoundaryTimes,
    checkpoints: notificationBoundaryCheckpoints,
    checkpointNowArguments: notificationBoundaryCheckpointNow,
  }), {
    operations: notificationBoundaryOps.operations,
    retryDelayMsOnSettlementError: 45_000,
  });
  assertSettlementClaimLost(notificationBoundaryResult, 45_000);
  assert.equal(notificationBoundaryOps.progress.length, 1);
  assert.equal(notificationBoundaryOps.history.length, 1);
  assert.equal(notificationBoundaryOps.notifications.length, 0);
  assert.equal(notificationBoundaryOps.history[0]?.record.verifiedAt?.getTime(), notificationBoundaryTimes[1]?.getTime());
  assert.deepEqual(notificationBoundaryCheckpoints, [
    { progressSettledAt: notificationBoundaryTimes[0] },
    { historyWrittenAt: notificationBoundaryTimes[2] },
  ]);
  assert.deepEqual(notificationBoundaryCheckpointNow, [undefined, undefined]);

  await assertSideEffectOutlivesLeaseRecovery({
    boundary: "progress",
    bookingId: 2791817,
    requestId: 40288121,
    claimAt: new Date("2030-01-01T00:12:00.000Z"),
  });
  await assertSideEffectOutlivesLeaseRecovery({
    boundary: "history",
    bookingId: 2791818,
    requestId: 40288122,
    claimAt: new Date("2030-01-01T00:14:00.000Z"),
  });

  await resetDb();
  const replayRule = await createRule(2, {
    name: "Settlement replay rule",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 2,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const replayJob = await checkpointOwnedForResume({
    bookingId: 2791816,
    requestId: 40288120,
    ruleId: replayRule.id,
  });
  const firstClaimAt = new Date("2030-01-01T00:20:00.000Z");
  const firstClaimExpiresAt = new Date("2030-01-01T00:21:00.000Z");
  let settlementClock = firstClaimAt;
  let notificationPublishAttempts = 0;
  const durablePublisher = createNotificationPublisher({
    publish: async (envelope) => {
      notificationPublishAttempts += 1;
      const event = normalizeNotificationEvent(envelope.event, "settlement-replay-worker", envelope.eventKey);
      await createNotificationEventAndOutbox(event, {
        targetType: "line_group",
        targetId: "settlement-replay-line-group",
        title: "Auto accept",
        message: envelope.event.message,
      });
      settlementClock = firstClaimExpiresAt;
      return { ok: true };
    },
  });
  const replayOperations = createAutoAcceptJobSettlementOperations({ publisher: durablePublisher });
  const expiredSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "expired-settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: firstClaimAt,
    clock: () => settlementClock,
    claimTokenFactory: () => "expired-settlement-claim",
    retryDelayMsOnSettlementError: 45_000,
    operations: replayOperations,
  });
  assert.equal(expiredSummary.claimed, 1);
  assert.equal(expiredSummary.succeeded, 0);
  assert.equal(expiredSummary.retried, 0);
  assert.equal(expiredSummary.settleFailures, 1);
  const expiredRow = await getAutoAcceptJobById(replayJob.id);
  assert.ok(expiredRow);
  assert.equal(expiredRow.status, "claimed");
  assert.ok(expiredRow.progressSettledAt);
  assert.ok(expiredRow.historyWrittenAt);
  assert.equal(expiredRow.notificationEnqueuedAt, null);
  assert.equal(await markAutoAcceptJobSettlementCheckpoint({
    id: replayJob.id,
    ownerNodeId: "expired-settlement-worker",
    claimToken: "expired-settlement-claim",
    notificationEnqueuedAt: firstClaimExpiresAt,
    now: firstClaimExpiresAt,
  }), false, "the expired claimant must not checkpoint the notification side effect");

  const resumedSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "replacement-settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:21:01.000Z"),
    claimTokenFactory: () => "replacement-settlement-claim",
    retryDelayMsOnSettlementError: 45_000,
    operations: replayOperations,
  });
  assert.equal(resumedSummary.claimed, 1);
  assert.equal(resumedSummary.succeeded, 1);
  assert.equal(notificationPublishAttempts, 2, "the missing checkpoint should make the replacement replay notification");
  const replayRuleAfter = (await readRules(2)).find((item) => item.id === replayRule.id);
  assert.ok(replayRuleAfter);
  assert.equal(replayRuleAfter.need, 1, "durable progress must be applied once across claimant replacement");
  const replayHistory = await getAutoAcceptHistory(2, { limit: 20, sortBy: "id", sortDir: "asc" });
  assert.equal(replayHistory.length, 1, "durable history must be applied once across claimant replacement");
  const durableOutbox = await claimNotificationOutboxBatch(
    "settlement-outbox-inspector",
    5,
    60_000,
    new Date("2030-01-01T00:22:00.000Z"),
  );
  assert.equal(durableOutbox.length, 1, "notification replay must converge on one durable outbox row");
  assert.equal(durableOutbox[0]?.eventKey, "auto_accept_owned:team:2:booking:2791816:req:40288120");
  const replayAfter = await getAutoAcceptJobById(replayJob.id);
  assert.ok(replayAfter);
  assert.equal(replayAfter.status, "succeeded");
  assert.ok(replayAfter.notificationEnqueuedAt);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
