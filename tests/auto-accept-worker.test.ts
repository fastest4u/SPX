import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { autoAcceptJobs } from "../src/db/schema.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
} from "../src/repositories/auto-accept-job-repository.js";
import {
  runAutoAcceptWorkerBatch,
  type AutoAcceptJobExecutionResult,
  type AutoAcceptJobExecutor,
} from "../src/services/auto-accept-worker.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function baseJob(overrides: Partial<Parameters<typeof enqueueAutoAcceptJob>[0]> = {}) {
  const identity = {
    teamId: overrides.teamId ?? 2,
    bookingId: overrides.bookingId ?? 2791810,
    requestId: overrides.requestId ?? 40288114,
    ruleId: overrides.ruleId ?? "rule-1",
    attemptKind: overrides.attemptKind ?? "pending_request" as const,
  };
  return {
    ...identity,
    payload: {
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
        acceptance_status: 1,
        listAgeMs: 1000,
      },
      ruleSnapshot: {
        need: 1,
        accept_all: false,
        enabled: true,
        fulfilled: false,
      },
      observedAt: "2030-01-01T00:00:00.000Z",
      pollerNodeId: "poller-01",
    },
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
    maxAttempts: overrides.maxAttempts,
    nextRunAt: overrides.nextRunAt,
    observedAt: overrides.observedAt ?? new Date("2030-01-01T00:00:00.000Z"),
    ...(overrides.payload ? { payload: overrides.payload } : {}),
  };
}

async function getJob(id: number) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(autoAcceptJobs)
    .where(eq(autoAcceptJobs.id, id))
    .limit(1);
  return row;
}

function createControllableClock(initial: Date) {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    set: (next: Date) => {
      current = new Date(next);
    },
  };
}

async function reclaimJobsAsSucceeded(input: {
  teamId: number;
  expectedCount: number;
  now: Date;
  claimToken: string;
}) {
  const summary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-reclaimer",
    teamIds: [input.teamId],
    limit: input.expectedCount,
    leaseMs: 1_000,
    now: input.now,
    claimTokenFactory: () => input.claimToken,
    execute: async () => ({
      outcome: "succeeded",
      resultStatus: "owned",
      reasonCode: "reclaimed_live_claim",
    }),
  });
  assert.equal(summary.claimed, input.expectedCount);
  assert.equal(summary.succeeded, input.expectedCount);
  assert.equal(summary.settleFailures, 0);
}

async function main() {
  await resetDb();

  const teamTwoJob = await enqueueAutoAcceptJob(baseJob());
  const teamThreeJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 3,
    bookingId: 2791811,
    requestId: 40288115,
  }));

  const executed: number[] = [];
  const successExecutor: AutoAcceptJobExecutor = async ({ row, claimToken, ownerNodeId }) => {
    executed.push(row.id);
    assert.equal(claimToken, "claim-success");
    assert.equal(ownerNodeId, "auto-worker-a");
    return {
      outcome: "succeeded",
      resultStatus: "owned",
      reasonCode: "verified_owned",
      winningAttemptTraceId: "aa:2:2791810:40288114:2030",
      progressSettledAt: new Date("2030-01-01T00:02:00.000Z"),
      historyWrittenAt: new Date("2030-01-01T00:02:01.000Z"),
      notificationEnqueuedAt: new Date("2030-01-01T00:02:02.000Z"),
    };
  };

  const successSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-a",
    teamIds: [2],
    limit: 5,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "claim-success",
    execute: successExecutor,
  });
  assert.deepEqual(successSummary, {
    claimed: 1,
    succeeded: 1,
    failed: 0,
    indeterminate: 0,
    cancelled: 0,
    retried: 0,
    deadLettered: 0,
    executorErrors: 0,
    settleFailures: 0,
    checkpointed: 0,
    checkpointFailures: 0,
  });
  assert.deepEqual(executed, [teamTwoJob.id]);
  const completed = await getJob(teamTwoJob.id);
  assert.ok(completed);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.resultStatus, "owned");
  assert.equal(completed.resultReasonCode, "verified_owned");
  assert.equal(completed.claimToken, null);
  assert.ok(completed.progressSettledAt);
  assert.ok(completed.historyWrittenAt);
  assert.ok(completed.notificationEnqueuedAt);
  const untouchedOtherTeam = await getJob(teamThreeJob.id);
  assert.ok(untouchedOtherTeam);
  assert.equal(untouchedOtherTeam.status, "pending");

  const retryJob = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791812,
    requestId: 40288116,
  }));
  const retrySummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-b",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:03:00.000Z"),
    claimTokenFactory: () => "claim-retry",
    execute: async () => ({
      outcome: "retry",
      reasonCode: "verify_indeterminate",
      error: "tabs unavailable",
      retryDelayMs: 15_000,
      count: "verify",
    }),
  });
  assert.equal(retrySummary.retried, 1);
  const retrying = await getJob(retryJob.id);
  assert.ok(retrying);
  assert.equal(retrying.status, "retrying");
  assert.equal(retrying.claimToken, null);
  assert.equal(retrying.verifyCount, 1);
  assert.equal(retrying.lastReasonCode, "verify_indeterminate");

  const checkpointWorkerJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 8,
    bookingId: 2791817,
    requestId: 40288121,
  }));
  const checkpointWorkerSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-checkpoint",
    teamIds: [8],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:04:00.000Z"),
    claimTokenFactory: () => "claim-worker-checkpoint",
    execute: async ({ checkpointResult, checkpointSettlement }) => {
      assert.equal(await checkpointResult({
        resultStatus: "owned",
        resultReasonCode: "verified_owned",
        winningAttemptTraceId: "aa:2:2791817:40288121:2030",
      }, new Date("2030-01-01T00:04:01.000Z")), true);
      assert.equal(await checkpointSettlement({
        progressSettledAt: new Date("2030-01-01T00:04:02.000Z"),
      }, new Date("2030-01-01T00:04:02.000Z")), true);
      return {
        outcome: "retry",
        reasonCode: "settlement_pending",
        error: "history and notification still pending",
        retryDelayMs: 120_000,
        count: "verify",
      };
    },
  });
  assert.equal(checkpointWorkerSummary.retried, 1);
  assert.equal(checkpointWorkerSummary.executorErrors, 0);
  const checkpointWorkerRetry = await getJob(checkpointWorkerJob.id);
  assert.ok(checkpointWorkerRetry);
  assert.equal(checkpointWorkerRetry.status, "retrying");
  assert.equal(checkpointWorkerRetry.verifyCount, 1);
  assert.equal(checkpointWorkerRetry.claimToken, null);
  assert.equal(checkpointWorkerRetry.resultStatus, "owned");
  assert.equal(checkpointWorkerRetry.resultReasonCode, "verified_owned");
  assert.equal(checkpointWorkerRetry.winningAttemptTraceId, "aa:2:2791817:40288121:2030");
  assert.ok(checkpointWorkerRetry.progressSettledAt);
  assert.equal(checkpointWorkerRetry.historyWrittenAt, null);
  assert.equal(checkpointWorkerRetry.notificationEnqueuedAt, null);
  assert.equal(checkpointWorkerRetry.completedAt, null);

  const checkpointOnlyJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 9,
    bookingId: 2791818,
    requestId: 40288122,
  }));
  const checkpointOnlySummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-checkpoint-only",
    teamIds: [9],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:04:30.000Z"),
    claimTokenFactory: () => "claim-worker-checkpoint-only",
    execute: async () => ({
      outcome: "checkpoint",
      checkpoint: "canonical_result",
      resultStatus: "owned",
      reasonCode: "verified_owned",
      winningAttemptTraceId: "aa:9:2791818:40288122:2030",
      progressSettledAt: new Date("2030-01-01T00:04:31.000Z"),
    }),
  });
  assert.equal(checkpointOnlySummary.checkpointed, 1);
  assert.equal(checkpointOnlySummary.succeeded, 0);
  assert.equal(checkpointOnlySummary.settleFailures, 0);
  const checkpointOnly = await getJob(checkpointOnlyJob.id);
  assert.ok(checkpointOnly);
  assert.equal(checkpointOnly.status, "verifying");
  assert.equal(checkpointOnly.claimToken, "claim-worker-checkpoint-only");
  assert.equal(checkpointOnly.resultStatus, "owned");
  assert.equal(checkpointOnly.resultReasonCode, "verified_owned");
  assert.equal(checkpointOnly.winningAttemptTraceId, "aa:9:2791818:40288122:2030");
  assert.ok(checkpointOnly.progressSettledAt);
  assert.equal(checkpointOnly.completedAt, null);

  const deadJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 4,
    bookingId: 2791813,
    requestId: 40288117,
  }));
  const deadSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-c",
    teamIds: [4],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:05:00.000Z"),
    claimTokenFactory: () => "claim-dead",
    execute: async () => ({
      outcome: "dead_letter",
      reasonCode: "malformed_payload",
      error: "schemaVersion missing",
    }),
  });
  assert.equal(deadSummary.deadLettered, 1);
  const deadLettered = await getJob(deadJob.id);
  assert.ok(deadLettered);
  assert.equal(deadLettered.status, "dead_letter");
  assert.equal(deadLettered.lastReasonCode, "malformed_payload");

  const throwingJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 5,
    bookingId: 2791814,
    requestId: 40288118,
  }));
  const throwingSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-d",
    teamIds: [5],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:07:00.000Z"),
    claimTokenFactory: () => "claim-throw",
    execute: async () => {
      throw new Error("executor exploded");
    },
  });
  assert.equal(throwingSummary.executorErrors, 1);
  assert.equal(throwingSummary.retried, 1);
  const thrownRetry = await getJob(throwingJob.id);
  assert.ok(thrownRetry);
  assert.equal(thrownRetry.status, "retrying");
  assert.equal(thrownRetry.lastReasonCode, "worker_execution_error");
  assert.equal(thrownRetry.attemptCount, 1);
  assert.equal(thrownRetry.claimToken, null);

  const longTokenJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 6,
    bookingId: 2791815,
    requestId: 40288119,
  }));
  const overlongToken = "x".repeat(120);
  const longTokenSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-e",
    teamIds: [6],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:09:00.000Z"),
    claimTokenFactory: () => overlongToken,
    execute: async ({ claimToken, renewClaim }) => {
      assert.equal(claimToken.length, 80);
      assert.equal(await renewClaim(120_000, new Date("2030-01-01T00:09:10.000Z")), true);
      return {
        outcome: "succeeded",
        resultStatus: "owned",
        reasonCode: "verified_owned",
      };
    },
  });
  assert.equal(longTokenSummary.succeeded, 1);
  assert.equal(longTokenSummary.settleFailures, 0);
  const longTokenCompleted = await getJob(longTokenJob.id);
  assert.ok(longTokenCompleted);
  assert.equal(longTokenCompleted.status, "succeeded");
  assert.equal(longTokenCompleted.claimToken, null);

  const exhaustedRetryJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 7,
    bookingId: 2791816,
    requestId: 40288120,
    maxAttempts: 1,
  }));
  const exhaustedRetrySummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-f",
    teamIds: [7],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:11:00.000Z"),
    claimTokenFactory: () => "claim-exhausted-retry",
    execute: async () => ({
      outcome: "retry",
      reasonCode: "accept_api_error",
      error: "SPX unavailable",
      retryDelayMs: 10_000,
      count: "attempt",
    }),
  });
  assert.equal(exhaustedRetrySummary.retried, 0);
  assert.equal(exhaustedRetrySummary.deadLettered, 1);
  const exhaustedRetry = await getJob(exhaustedRetryJob.id);
  assert.ok(exhaustedRetry);
  assert.equal(exhaustedRetry.status, "dead_letter");
  assert.equal(exhaustedRetry.lastReasonCode, "accept_api_error");

  const crossingExpiryCases: Array<{
    name: string;
    teamId: number;
    bookingId: number;
    requestId: number;
    execution: AutoAcceptJobExecutionResult;
  }> = [
    {
      name: "retry",
      teamId: 20,
      bookingId: 2791820,
      requestId: 40288124,
      execution: {
        outcome: "retry",
        reasonCode: "crossed_expiry_retry",
        retryDelayMs: 5_000,
        count: "verify",
      },
    },
    {
      name: "completion",
      teamId: 21,
      bookingId: 2791821,
      requestId: 40288125,
      execution: {
        outcome: "succeeded",
        resultStatus: "owned",
        reasonCode: "crossed_expiry_completion",
      },
    },
    {
      name: "checkpoint",
      teamId: 22,
      bookingId: 2791822,
      requestId: 40288126,
      execution: {
        outcome: "checkpoint",
        checkpoint: "canonical_result",
        resultStatus: "owned",
        reasonCode: "crossed_expiry_checkpoint",
      },
    },
    {
      name: "dead-letter",
      teamId: 23,
      bookingId: 2791823,
      requestId: 40288127,
      execution: {
        outcome: "dead_letter",
        reasonCode: "crossed_expiry_dead_letter",
      },
    },
  ];

  for (const [index, testCase] of crossingExpiryCases.entries()) {
    const job = await enqueueAutoAcceptJob(baseJob({
      teamId: testCase.teamId,
      bookingId: testCase.bookingId,
      requestId: testCase.requestId,
    }));
    const claimedAt = new Date(new Date("2030-01-02T00:00:00.000Z").getTime() + index * 60_000);
    const expiresAt = new Date(claimedAt.getTime() + 1_000);
    const clock = createControllableClock(claimedAt);
    let executorCalls = 0;

    const staleSummary = await runAutoAcceptWorkerBatch({
      ownerNodeId: `auto-worker-expired-${testCase.name}`,
      teamIds: [testCase.teamId],
      limit: 1,
      leaseMs: 1_000,
      now: claimedAt,
      clock: clock.now,
      claimTokenFactory: () => `claim-expired-${testCase.name}`,
      execute: async () => {
        executorCalls++;
        clock.set(expiresAt);
        return testCase.execution;
      },
    });

    assert.equal(executorCalls, 1);
    assert.equal(staleSummary.claimed, 1);
    assert.equal(
      testCase.execution.outcome === "checkpoint"
        ? staleSummary.checkpointFailures
        : staleSummary.settleFailures,
      1,
      `${testCase.name} must lose its claim at exact expiry`,
    );
    if (testCase.execution.outcome === "retry") assert.equal(staleSummary.retried, 0);
    else if (testCase.execution.outcome === "checkpoint") assert.equal(staleSummary.checkpointed, 0);
    else if (testCase.execution.outcome === "dead_letter") assert.equal(staleSummary.deadLettered, 0);
    else assert.equal(staleSummary.succeeded, 0);

    const expired = await getJob(job.id);
    assert.ok(expired);
    assert.equal(expired.status, "claimed");
    assert.equal(expired.claimToken, `claim-expired-${testCase.name}`);

    await reclaimJobsAsSucceeded({
      teamId: testCase.teamId,
      expectedCount: 1,
      now: expiresAt,
      claimToken: `claim-reclaimed-${testCase.name}`,
    });
    const reclaimed = await getJob(job.id);
    assert.ok(reclaimed);
    assert.equal(reclaimed.status, "succeeded");
  }

  const throwingExpiryJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 24,
    bookingId: 2791824,
    requestId: 40288128,
  }));
  const throwingClaimedAt = new Date("2030-01-02T01:00:00.000Z");
  const throwingExpiresAt = new Date(throwingClaimedAt.getTime() + 1_000);
  const throwingClock = createControllableClock(throwingClaimedAt);
  const throwingExpirySummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-expired-throw",
    teamIds: [24],
    limit: 1,
    leaseMs: 1_000,
    now: throwingClaimedAt,
    clock: throwingClock.now,
    claimTokenFactory: () => "claim-expired-throw",
    execute: async () => {
      throwingClock.set(throwingExpiresAt);
      throw new Error("executor crossed expiry");
    },
  });
  assert.equal(throwingExpirySummary.executorErrors, 1);
  assert.equal(throwingExpirySummary.retried, 0);
  assert.equal(throwingExpirySummary.settleFailures, 1);
  const throwingExpired = await getJob(throwingExpiryJob.id);
  assert.ok(throwingExpired);
  assert.equal(throwingExpired.status, "claimed");
  await reclaimJobsAsSucceeded({
    teamId: 24,
    expectedCount: 1,
    now: throwingExpiresAt,
    claimToken: "claim-reclaimed-throw",
  });

  const firstBatchJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 25,
    bookingId: 2791825,
    requestId: 40288129,
  }));
  const secondBatchJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 25,
    bookingId: 2791826,
    requestId: 40288130,
  }));
  const batchClaimedAt = new Date("2030-01-02T02:00:00.000Z");
  const batchPastExpiry = new Date(batchClaimedAt.getTime() + 1_001);
  const batchClock = createControllableClock(batchClaimedAt);
  const batchExecutorCalls: number[] = [];
  const expiredBatchSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-expired-batch",
    teamIds: [25],
    limit: 2,
    leaseMs: 1_000,
    now: batchClaimedAt,
    clock: batchClock.now,
    claimTokenFactory: () => "claim-expired-batch",
    execute: async ({ row }) => {
      batchExecutorCalls.push(row.id);
      if (row.id === firstBatchJob.id) batchClock.set(batchPastExpiry);
      return {
        outcome: "succeeded",
        resultStatus: "owned",
        reasonCode: "batch_execution_finished",
      };
    },
  });
  assert.equal(expiredBatchSummary.claimed, 2);
  assert.deepEqual(batchExecutorCalls, [firstBatchJob.id]);
  assert.equal(expiredBatchSummary.succeeded, 0);
  assert.equal(expiredBatchSummary.settleFailures, 2);
  const firstExpiredBatchRow = await getJob(firstBatchJob.id);
  const secondExpiredBatchRow = await getJob(secondBatchJob.id);
  assert.ok(firstExpiredBatchRow);
  assert.ok(secondExpiredBatchRow);
  assert.equal(firstExpiredBatchRow.status, "claimed");
  assert.equal(secondExpiredBatchRow.status, "claimed");
  await reclaimJobsAsSucceeded({
    teamId: 25,
    expectedCount: 2,
    now: batchPastExpiry,
    claimToken: "claim-reclaimed-batch",
  });

  const liveClockJob = await enqueueAutoAcceptJob(baseJob({
    teamId: 26,
    bookingId: 2791827,
    requestId: 40288131,
  }));
  const liveClaimedAt = new Date("2030-01-02T03:00:00.000Z");
  const liveClock = createControllableClock(liveClaimedAt);
  const liveSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "auto-worker-live-clock",
    teamIds: [26],
    limit: 1,
    leaseMs: 1_000,
    now: liveClaimedAt,
    clock: liveClock.now,
    claimTokenFactory: () => "claim-live-clock",
    execute: async () => {
      liveClock.set(new Date(liveClaimedAt.getTime() + 500));
      return {
        outcome: "succeeded",
        resultStatus: "owned",
        reasonCode: "live_clock_completion",
      };
    },
  });
  assert.equal(liveSummary.succeeded, 1);
  assert.equal(liveSummary.settleFailures, 0);
  const liveCompleted = await getJob(liveClockJob.id);
  assert.ok(liveCompleted);
  assert.equal(liveCompleted.status, "succeeded");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
