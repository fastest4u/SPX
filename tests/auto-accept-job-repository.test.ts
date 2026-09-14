import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { autoAcceptJobs, notifyRules } from "../src/db/schema.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  claimAutoAcceptJobs,
  enqueueAutoAcceptJob,
  getAutoAcceptJobQueueSummary,
  getAutoAcceptJobByIdempotencyKey,
  markAutoAcceptJobResultCheckpoint,
  markAutoAcceptJobCompleted,
  markAutoAcceptJobDeadLetter,
  markAutoAcceptJobRetrying,
  markAutoAcceptJobSettlementCheckpoint,
  markAutoAcceptJobVerifying,
  renewAutoAcceptJobClaim,
} from "../src/repositories/auto-accept-job-repository.js";
import {
  releaseAutoAcceptRuleBudgetOnce,
  reserveAutoAcceptRuleBudgetOnce,
  settleAutoAcceptProgressOnce,
} from "../src/repositories/auto-accept-job-settlement-repository.js";
import {
  acknowledgePublicationFence,
  advancePublicationEpoch,
  enablePublication,
  fencePublication,
} from "../src/repositories/auto-accept-publication-control-repository.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function baseJob(overrides: Partial<Parameters<typeof enqueueAutoAcceptJob>[0]> = {}) {
  const identity = {
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288114,
    ruleId: "rule-1",
    attemptKind: "pending_request" as const,
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
    ...overrides,
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

async function seedSummaryJob(input: {
  teamId: number;
  bookingId: number;
  requestId: number;
  ruleId: string;
  attemptKind: Parameters<typeof enqueueAutoAcceptJob>[0]["attemptKind"];
  status: "pending" | "dead_letter";
  reasonCode: string | null;
  payloadSentinel: string;
  errorSentinel: string;
  traceSentinel: string;
}) {
  const identity = {
    teamId: input.teamId,
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: input.ruleId,
    attemptKind: input.attemptKind,
  };
  const job = await enqueueAutoAcceptJob(baseJob({
    ...identity,
    payload: {
      ...baseJob().payload,
      ...identity,
      idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity),
      payloadSentinel: input.payloadSentinel,
    },
  }));
  const db = await getDb();
  await db
    .update(autoAcceptJobs)
    .set({
      status: input.status,
      lastReasonCode: input.reasonCode,
      lastError: input.errorSentinel,
      winningAttemptTraceId: input.traceSentinel,
      claimOwner: `claim-owner-${input.bookingId}`,
      claimToken: `claim-token-${input.requestId}`,
      completedAt: input.status === "dead_letter" ? new Date("2030-01-01T00:30:00.000Z") : null,
    })
    .where(eq(autoAcceptJobs.id, job.id));
  return job;
}

type ActiveClaimMutationInput = {
  id: number;
  ownerNodeId: string;
  claimToken: string;
  now: Date;
};

type ActiveClaimMutationFamily = {
  name: string;
  mutate: (input: ActiveClaimMutationInput) => Promise<boolean>;
};

const activeClaimMutationFamilies: ActiveClaimMutationFamily[] = [
  {
    name: "renew",
    mutate: async (input) => await renewAutoAcceptJobClaim({
      ...input,
      leaseMs: 30_000,
    }),
  },
  {
    name: "verifying",
    mutate: async (input) => await markAutoAcceptJobVerifying(input),
  },
  {
    name: "result checkpoint",
    mutate: async (input) => await markAutoAcceptJobResultCheckpoint({
      ...input,
      resultStatus: "owned",
      resultReasonCode: "verified_owned",
      winningAttemptTraceId: `fence:${input.id}:result`,
    }),
  },
  {
    name: "settlement checkpoint",
    mutate: async (input) => await markAutoAcceptJobSettlementCheckpoint({
      ...input,
      progressSettledAt: input.now,
    }),
  },
  {
    name: "retry",
    mutate: async (input) => await markAutoAcceptJobRetrying({
      ...input,
      reasonCode: "active_claim_fence_retry",
      retryDelayMs: 30_000,
      count: "verify",
    }),
  },
  {
    name: "completion",
    mutate: async (input) => await markAutoAcceptJobCompleted({
      ...input,
      status: "cancelled",
      resultStatus: "unknown",
      resultReasonCode: "active_claim_fence_complete",
    }),
  },
  {
    name: "dead-letter",
    mutate: async (input) => await markAutoAcceptJobDeadLetter({
      ...input,
      reasonCode: "active_claim_fence_dead_letter",
    }),
  },
];

async function enqueueClaimedFenceJob(input: {
  caseId: number;
  ownerNodeId: string;
  claimToken: string;
  claimedAt: Date;
  leaseMs: number;
}) {
  const teamId = 1000 + input.caseId;
  const bookingId = 3_000_000 + input.caseId;
  const requestId = 4_000_000 + input.caseId;
  const job = await enqueueAutoAcceptJob(baseJob({
    teamId,
    bookingId,
    requestId,
    payload: {
      ...baseJob().payload,
      teamId,
      bookingId,
      requestId,
    },
  }));
  const claimed = await claimAutoAcceptJobs({
    ownerNodeId: input.ownerNodeId,
    claimToken: input.claimToken,
    teamIds: [teamId],
    limit: 1,
    leaseMs: input.leaseMs,
    now: input.claimedAt,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, job.id);
  return job;
}

async function assertStoredClaimTokenNormalization() {
  const claimedAt = new Date("2035-01-01T00:10:00.000Z");
  const ownerNodeId = "long-token-owner";
  const storedToken = "t".repeat(80);
  const originalToken = `${storedToken}-original-suffix`;
  const job = await enqueueClaimedFenceJob({
    caseId: 50,
    ownerNodeId,
    claimToken: originalToken,
    claimedAt,
    leaseMs: 10_000,
  });
  assert.equal((await getJob(job.id))?.claimToken, storedToken);

  assert.equal(await renewAutoAcceptJobClaim({
    id: job.id,
    ownerNodeId,
    claimToken: originalToken,
    leaseMs: 10_000,
    now: new Date("2035-01-01T00:10:01.000Z"),
  }), true, "the original long token must authorize its stored 80-character claim token");
  assert.equal(await renewAutoAcceptJobClaim({
    id: job.id,
    ownerNodeId,
    claimToken: `${storedToken}-different-suffix`,
    leaseMs: 10_000,
    now: new Date("2035-01-01T00:10:02.000Z"),
  }), true, "characters after the stored 80-character token are intentionally indistinguishable");

  const beforeDifferentStoredToken = await getJob(job.id);
  assert.equal(await renewAutoAcceptJobClaim({
    id: job.id,
    ownerNodeId,
    claimToken: `x${storedToken.slice(1)}-original-suffix`,
    leaseMs: 10_000,
    now: new Date("2035-01-01T00:10:03.000Z"),
  }), false, "a difference within the stored first 80 characters must not authorize the claim");
  assert.deepEqual(await getJob(job.id), beforeDifferentStoredToken);
}

async function assertActiveClaimMutationFences() {
  await resetDb();
  await assertStoredClaimTokenNormalization();
  const claimedAt = new Date("2035-01-01T00:00:00.000Z");
  const expiresAt = new Date("2035-01-01T00:00:10.000Z");
  const liveAt = new Date(expiresAt.getTime() - 1);
  const afterExpiry = new Date(expiresAt.getTime() + 1);
  const ownerNodeId = `active-owner-${"x".repeat(120)}`;
  let caseId = 0;

  for (const family of activeClaimMutationFamilies) {
    const liveToken = `fence-${caseId}-live`;
    const liveJob = await enqueueClaimedFenceJob({
      caseId: caseId++,
      ownerNodeId,
      claimToken: liveToken,
      claimedAt,
      leaseMs: 10_000,
    });
    const beforeWrongOwner = await getJob(liveJob.id);
    assert.equal(await family.mutate({
      id: liveJob.id,
      ownerNodeId: "wrong-owner",
      claimToken: liveToken,
      now: new Date("2035-01-01T00:00:01.000Z"),
    }), false, `${family.name}: wrong owner must be rejected`);
    assert.deepEqual(
      await getJob(liveJob.id),
      beforeWrongOwner,
      `${family.name}: wrong owner must leave the row unchanged`,
    );
    assert.equal(await family.mutate({
      id: liveJob.id,
      ownerNodeId,
      claimToken: liveToken,
      now: liveAt,
    }), true, `${family.name}: active claim must succeed one millisecond before expiry`);

    const exactToken = `fence-${caseId}-exact`;
    const exactJob = await enqueueClaimedFenceJob({
      caseId: caseId++,
      ownerNodeId,
      claimToken: exactToken,
      claimedAt,
      leaseMs: 10_000,
    });
    const beforeExactExpiry = await getJob(exactJob.id);
    assert.equal(await family.mutate({
      id: exactJob.id,
      ownerNodeId,
      claimToken: exactToken,
      now: expiresAt,
    }), false, `${family.name}: exact-expiry claim must be rejected`);
    assert.deepEqual(
      await getJob(exactJob.id),
      beforeExactExpiry,
      `${family.name}: exact-expiry rejection must leave the row unchanged`,
    );

    const expiredToken = `fence-${caseId}-expired`;
    const expiredJob = await enqueueClaimedFenceJob({
      caseId: caseId++,
      ownerNodeId,
      claimToken: expiredToken,
      claimedAt,
      leaseMs: 10_000,
    });
    const beforeAfterExpiry = await getJob(expiredJob.id);
    assert.equal(await family.mutate({
      id: expiredJob.id,
      ownerNodeId,
      claimToken: expiredToken,
      now: afterExpiry,
    }), false, `${family.name}: expired claim must be rejected`);
    assert.deepEqual(
      await getJob(expiredJob.id),
      beforeAfterExpiry,
      `${family.name}: expired rejection must leave the row unchanged`,
    );
  }

  const executionOwner = "execution-owner-before-expiry";
  const executionToken = "execution-token-before-expiry";
  const executionJob = await enqueueClaimedFenceJob({
    caseId: caseId++,
    ownerNodeId: executionOwner,
    claimToken: executionToken,
    claimedAt,
    leaseMs: 10_000,
  });
  const [executionReclaim] = await claimAutoAcceptJobs({
    ownerNodeId: "execution-owner-after-reclaim",
    claimToken: "execution-token-after-reclaim",
    teamIds: [executionJob.teamId],
    limit: 1,
    leaseMs: 10_000,
    now: expiresAt,
  });
  assert.equal(executionReclaim.id, executionJob.id);
  const afterExecutionReclaim = await getJob(executionJob.id);
  assert.equal(await renewAutoAcceptJobClaim({
    id: executionJob.id,
    ownerNodeId: executionOwner,
    claimToken: executionToken,
    leaseMs: 30_000,
    now: afterExpiry,
  }), false, "an expired renew must not resurrect the old execution claim");
  assert.deepEqual(await getJob(executionJob.id), afterExecutionReclaim);

  const settlementOwner = "settlement-owner-before-expiry";
  const settlementToken = "settlement-token-before-expiry";
  const settlementJob = await enqueueClaimedFenceJob({
    caseId,
    ownerNodeId: settlementOwner,
    claimToken: settlementToken,
    claimedAt,
    leaseMs: 10_000,
  });
  const canonicalCheckpoint = {
    resultStatus: "owned" as const,
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: `fence:${settlementJob.id}:canonical`,
  };
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: settlementJob.id,
    ownerNodeId: settlementOwner,
    claimToken: settlementToken,
    ...canonicalCheckpoint,
    now: liveAt,
  }), true);
  const [settlementReclaim] = await claimAutoAcceptJobs({
    ownerNodeId: "settlement-owner-after-reclaim",
    claimToken: "settlement-token-after-reclaim",
    teamIds: [settlementJob.teamId],
    limit: 1,
    leaseMs: 10_000,
    scope: "settlement",
    now: expiresAt,
  });
  assert.equal(settlementReclaim.id, settlementJob.id);
  const afterSettlementReclaim = await getJob(settlementJob.id);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: settlementJob.id,
    ownerNodeId: settlementOwner,
    claimToken: settlementToken,
    ...canonicalCheckpoint,
    now: afterExpiry,
  }), false, "the old settlement claim must be fenced after reclaim");
  assert.deepEqual(await getJob(settlementJob.id), afterSettlementReclaim);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: settlementJob.id,
    ownerNodeId: "settlement-owner-after-reclaim",
    claimToken: "settlement-token-after-reclaim",
    ...canonicalCheckpoint,
    now: afterExpiry,
  }), true, "an identical canonical checkpoint must resume under the new active settlement claim");
  const beforeConflict = await getJob(settlementJob.id);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: settlementJob.id,
    ownerNodeId: "settlement-owner-after-reclaim",
    claimToken: "settlement-token-after-reclaim",
    ...canonicalCheckpoint,
    resultStatus: "lost",
    now: new Date(afterExpiry.getTime() + 1),
  }), false, "conflicting canonical result data must remain rejected");
  assert.deepEqual(await getJob(settlementJob.id), beforeConflict);
}

async function seedBudgetRule(ruleId: string) {
  const db = await getDb();
  await db.insert(notifyRules).values({
    id: ruleId,
    teamId: 2,
    name: "Budget reservation metrics",
    origins: "[]",
    destinations: "[]",
    vehicleTypes: "[]",
    need: 10,
    enabled: 1,
    fulfilled: 0,
    autoAccept: 1,
    acceptAll: 0,
    autoAccepted: 0,
  });
}

async function enqueueBudgetMetricJob(input: {
  bookingId: number;
  requestId: number;
  ruleId: string;
  observedAt: Date;
}) {
  const identity = {
    teamId: 2,
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: input.ruleId,
    attemptKind: "pending_request" as const,
  };
  return enqueueAutoAcceptJob(baseJob({
    ...identity,
    observedAt: input.observedAt,
    nextRunAt: input.observedAt,
    payload: {
      ...baseJob().payload,
      ...identity,
      idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity),
      ruleName: "Budget reservation metrics",
      secretLikeText: "budget reservation payload must not appear in read models",
      observedAt: input.observedAt.toISOString(),
    },
  }));
}

async function reserveAndCompleteBudgetMetricJob(input: {
  bookingId: number;
  requestId: number;
  ruleId: string;
  reservationAt: Date;
  completedAt: Date;
  status: "succeeded" | "failed" | "indeterminate" | "cancelled";
  resultStatus: "owned" | "lost" | "failed" | "unknown";
  resultReasonCode: string;
  releaseAt?: Date;
  progressAt?: Date;
}) {
  const job = await enqueueBudgetMetricJob({
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: input.ruleId,
    observedAt: input.reservationAt,
  });
  await reserveAutoAcceptRuleBudgetOnce({
    jobId: job.id,
    teamId: 2,
    bookingId: input.bookingId,
    requestIds: [input.requestId],
    ruleId: input.ruleId,
    acceptedCount: 1,
    reasonCode: "test_budget_reservation",
    traceId: `budget:${job.id}:reservation`,
    now: input.reservationAt,
  });

  const claimToken = `budget-claim-${job.id}`;
  const claimAt = new Date(input.reservationAt.getTime() + 1000);
  const [claim] = await claimAutoAcceptJobs({
    ownerNodeId: "budget-metric-worker",
    claimToken,
    teamIds: [2],
    limit: 1,
    leaseMs: Math.max(30_000, input.completedAt.getTime() - claimAt.getTime() + 1000),
    now: claimAt,
  });
  assert.equal(claim.id, job.id);
  assert.equal(await markAutoAcceptJobCompleted({
    id: job.id,
    ownerNodeId: "budget-metric-worker",
    claimToken,
    status: input.status,
    resultStatus: input.resultStatus,
    resultReasonCode: input.resultReasonCode,
    winningAttemptTraceId: `budget:${job.id}:trace`,
    now: input.completedAt,
  }), true);

  if (input.releaseAt) {
    await releaseAutoAcceptRuleBudgetOnce({
      jobId: job.id,
      teamId: 2,
      bookingId: input.bookingId,
      requestIds: [input.requestId],
      ruleId: input.ruleId,
      acceptedCount: 1,
      reasonCode: "test_budget_release",
      traceId: `budget:${job.id}:release`,
      now: input.releaseAt,
    });
  }

  if (input.progressAt) {
    await settleAutoAcceptProgressOnce({
      jobId: job.id,
      teamId: 2,
      bookingId: input.bookingId,
      requestIds: [input.requestId],
      ruleId: input.ruleId,
      acceptedCount: 1,
      reasonCode: "test_progress_consumed",
      traceId: `budget:${job.id}:progress`,
      now: input.progressAt,
    });
  }

  return job;
}

async function main() {
  await assertActiveClaimMutationFences();
  await resetDb();

  const key = buildAutoAcceptJobIdempotencyKey({
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288114,
    ruleId: "rule-1",
    attemptKind: "pending_request",
  });
  assert.equal(key, "2:2791810:40288114:rule-1:pending_request");
  assert.equal(
    buildAutoAcceptJobIdempotencyKey({
      teamId: 2,
      bookingId: 2791810,
      requestId: 0,
      ruleId: "rule-1",
      attemptKind: "fast_accept_all",
    }),
    "2:2791810:0:rule-1:fast_accept_all",
  );

  await assert.rejects(
    () => enqueueAutoAcceptJob(baseJob({ teamId: 0 })),
    /teamId must be a positive integer/,
  );
  await assert.rejects(
    () => enqueueAutoAcceptJob(baseJob({ requestId: 0 })),
    /requestId must be a positive integer unless attemptKind is fast_accept_all/,
  );
  await assert.rejects(
    () => enqueueAutoAcceptJob(baseJob({ ruleId: "" })),
    /ruleId must be non-empty/,
  );

  const first = await enqueueAutoAcceptJob(baseJob());
  assert.equal(first.idempotencyKey, key);
  assert.equal(first.status, "pending");
  assert.equal(first.teamId, 2);
  assert.equal(JSON.parse(first.payloadJson).trip.origin, "Bangkok");

  const duplicate = await enqueueAutoAcceptJob(baseJob({
    payload: {
      ...baseJob().payload,
      trip: { ...baseJob().payload.trip, origin: "Changed" },
    },
  }));
  assert.equal(duplicate.id, first.id);
  assert.equal(JSON.parse(duplicate.payloadJson).trip.origin, "Bangkok");

  const byKey = await getAutoAcceptJobByIdempotencyKey(key);
  assert.ok(byKey);
  assert.equal(byKey.id, first.id);

  await enqueueAutoAcceptJob(baseJob({
    teamId: 3,
    bookingId: 2791811,
    requestId: 40288115,
    payload: { ...baseJob().payload, teamId: 3, bookingId: 2791811, requestId: 40288115 },
  }));
  await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791812,
    requestId: 40288116,
    nextRunAt: new Date("2030-01-01T00:10:00.000Z"),
    payload: { ...baseJob().payload, bookingId: 2791812, requestId: 40288116 },
  }));

  const claimStart = new Date("2030-01-01T00:01:00.000Z");
  const claimed = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-a",
    claimToken: "claim-a",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: claimStart,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, first.id);
  assert.equal(claimed[0].status, "claimed");
  assert.equal(claimed[0].claimOwner, "auto-worker-a");
  assert.equal(claimed[0].claimToken, "claim-a");

  const blockedByLiveClaim = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-b",
    claimToken: "claim-b",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:01:10.000Z"),
  });
  assert.equal(blockedByLiveClaim.length, 0);

  const reclaimed = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-b",
    claimToken: "claim-b",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:01:31.000Z"),
  });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].id, first.id);
  assert.equal(reclaimed[0].claimOwner, "auto-worker-b");

  assert.equal(await renewAutoAcceptJobClaim({
    id: first.id,
    ownerNodeId: "auto-worker-b",
    claimToken: "wrong-token",
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:40.000Z"),
  }), false);
  assert.equal(await renewAutoAcceptJobClaim({
    id: first.id,
    ownerNodeId: "auto-worker-b",
    claimToken: "claim-b",
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:40.000Z"),
  }), true);

  assert.equal(await markAutoAcceptJobVerifying({
    id: first.id,
    ownerNodeId: "auto-worker-b",
    claimToken: "wrong-token",
    now: new Date("2030-01-01T00:01:45.000Z"),
  }), false);
  assert.equal(await markAutoAcceptJobVerifying({
    id: first.id,
    ownerNodeId: "auto-worker-b",
    claimToken: "claim-b",
    now: new Date("2030-01-01T00:01:45.000Z"),
  }), true);
  const verifying = await getJob(first.id);
  assert.ok(verifying);
  assert.equal(verifying.status, "verifying");
  assert.equal(verifying.claimToken, "claim-b");

  assert.equal(await markAutoAcceptJobRetrying({
    id: first.id,
    ownerNodeId: "auto-worker-b",
    claimToken: "wrong-token",
    reasonCode: "accept_timeout_ambiguous",
    error: "wrong token should not update",
    retryDelayMs: 5_000,
    count: "attempt",
    now: new Date("2030-01-01T00:01:50.000Z"),
  }), false);
  assert.equal(await markAutoAcceptJobRetrying({
    id: first.id,
    ownerNodeId: "auto-worker-b",
    claimToken: "claim-b",
    reasonCode: "accept_timeout_ambiguous",
    error: "SPX timed out after submit",
    retryDelayMs: 5_000,
    count: "attempt",
    now: new Date("2030-01-01T00:01:50.000Z"),
  }), true);
  const retrying = await getJob(first.id);
  assert.ok(retrying);
  assert.equal(retrying.status, "retrying");
  assert.equal(retrying.claimOwner, null);
  assert.equal(retrying.claimToken, null);
  assert.equal(retrying.attemptCount, 1);
  assert.equal(retrying.lastReasonCode, "accept_timeout_ambiguous");

  const notReady = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-c",
    claimToken: "claim-c",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:01:52.000Z"),
  });
  assert.equal(notReady.length, 0);

  const retryClaim = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-c",
    claimToken: "claim-c",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:01:56.000Z"),
  });
  assert.equal(retryClaim.length, 1);
  assert.equal(retryClaim[0].id, first.id);

  assert.equal(await markAutoAcceptJobCompleted({
    id: first.id,
    ownerNodeId: "auto-worker-c",
    claimToken: "wrong-token",
    status: "succeeded",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791810:40288114:2030",
    progressSettledAt: new Date("2030-01-01T00:02:00.000Z"),
    historyWrittenAt: new Date("2030-01-01T00:02:01.000Z"),
    notificationEnqueuedAt: new Date("2030-01-01T00:02:02.000Z"),
    now: new Date("2030-01-01T00:02:03.000Z"),
  }), false);
  assert.equal(await markAutoAcceptJobCompleted({
    id: first.id,
    ownerNodeId: "auto-worker-c",
    claimToken: "claim-c",
    status: "succeeded",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791810:40288114:2030",
    progressSettledAt: new Date("2030-01-01T00:02:00.000Z"),
    historyWrittenAt: new Date("2030-01-01T00:02:01.000Z"),
    notificationEnqueuedAt: new Date("2030-01-01T00:02:02.000Z"),
    now: new Date("2030-01-01T00:02:03.000Z"),
  }), true);
  const completed = await getJob(first.id);
  assert.ok(completed);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.claimOwner, null);
  assert.equal(completed.resultStatus, "owned");
  assert.equal(completed.resultReasonCode, "verified_owned");
  assert.equal(completed.winningAttemptTraceId, "aa:2:2791810:40288114:2030");
  assert.ok(completed.progressSettledAt);
  assert.ok(completed.historyWrittenAt);
  assert.ok(completed.notificationEnqueuedAt);
  assert.ok(completed.completedAt);

  const checkpointed = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791815,
    requestId: 40288119,
    payload: { ...baseJob().payload, bookingId: 2791815, requestId: 40288119 },
  }));
  const [checkpointClaim] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-checkpoint",
    claimToken: "claim-checkpoint",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:02:10.000Z"),
  });
  assert.equal(checkpointClaim.id, checkpointed.id);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: checkpointed.id,
    ownerNodeId: "auto-worker-checkpoint",
    claimToken: "wrong-token",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791815:40288119:2030",
    now: new Date("2030-01-01T00:02:11.000Z"),
  }), false);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: checkpointed.id,
    ownerNodeId: "auto-worker-checkpoint",
    claimToken: "claim-checkpoint",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791815:40288119:2030",
    now: new Date("2030-01-01T00:02:11.000Z"),
  }), true);
  const resultCheckpoint = await getJob(checkpointed.id);
  assert.ok(resultCheckpoint);
  assert.equal(resultCheckpoint.status, "verifying");
  assert.equal(resultCheckpoint.claimToken, "claim-checkpoint");
  assert.equal(resultCheckpoint.resultStatus, "owned");
  assert.equal(resultCheckpoint.resultReasonCode, "verified_owned");
  assert.equal(resultCheckpoint.lastReasonCode, "verified_owned");
  assert.equal(resultCheckpoint.winningAttemptTraceId, "aa:2:2791815:40288119:2030");
  assert.ok(resultCheckpoint.lastHeartbeatAt);
  assert.equal(resultCheckpoint.completedAt, null);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: checkpointed.id,
    ownerNodeId: "auto-worker-checkpoint",
    claimToken: "claim-checkpoint",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791815:40288119:2030",
    now: new Date("2030-01-01T00:02:11.500Z"),
  }), true);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: checkpointed.id,
    ownerNodeId: "auto-worker-checkpoint",
    claimToken: "claim-checkpoint",
    resultStatus: "lost",
    resultReasonCode: "verified_not_owned",
    winningAttemptTraceId: "aa:2:2791815:40288119:conflict",
    now: new Date("2030-01-01T00:02:11.750Z"),
  }), false);
  const unchangedCheckpoint = await getJob(checkpointed.id);
  assert.ok(unchangedCheckpoint);
  assert.equal(unchangedCheckpoint.resultStatus, "owned");
  assert.equal(unchangedCheckpoint.resultReasonCode, "verified_owned");
  assert.equal(unchangedCheckpoint.winningAttemptTraceId, "aa:2:2791815:40288119:2030");
  const blockedCheckpointReclaim = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-checkpoint-reclaim",
    claimToken: "claim-checkpoint-blocked",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:02:20.000Z"),
  });
  assert.equal(blockedCheckpointReclaim.length, 0);
  const blockedCheckpointExecutionReclaim = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-checkpoint-reclaim",
    claimToken: "claim-checkpoint-execution-blocked",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:02:41.000Z"),
  });
  assert.deepEqual(blockedCheckpointExecutionReclaim, []);
  assert.equal((await getJob(checkpointed.id))?.claimToken, "claim-checkpoint");
  const [reclaimedCheckpoint] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-checkpoint-reclaim",
    claimToken: "claim-checkpoint-reclaimed",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:02:41.000Z"),
    scope: "settlement",
  });
  assert.equal(reclaimedCheckpoint.id, checkpointed.id);
  assert.equal(reclaimedCheckpoint.resultStatus, "owned");
  assert.equal(reclaimedCheckpoint.resultReasonCode, "verified_owned");
  assert.equal(reclaimedCheckpoint.winningAttemptTraceId, "aa:2:2791815:40288119:2030");
  const checkpointClaimToken = "claim-checkpoint-reclaimed";

  assert.equal(await markAutoAcceptJobSettlementCheckpoint({
    id: checkpointed.id,
    ownerNodeId: "auto-worker-checkpoint-reclaim",
    claimToken: "wrong-token",
    progressSettledAt: new Date("2030-01-01T00:02:12.000Z"),
    now: new Date("2030-01-01T00:02:12.000Z"),
  }), false);
  assert.equal(await markAutoAcceptJobSettlementCheckpoint({
    id: checkpointed.id,
    ownerNodeId: "auto-worker-checkpoint-reclaim",
    claimToken: checkpointClaimToken,
    progressSettledAt: new Date("2030-01-01T00:02:12.000Z"),
    now: new Date("2030-01-01T00:02:12.000Z"),
  }), true);
  let settlementCheckpoint = await getJob(checkpointed.id);
  assert.ok(settlementCheckpoint);
  assert.ok(settlementCheckpoint.progressSettledAt);
  assert.equal(settlementCheckpoint.historyWrittenAt, null);
  assert.equal(settlementCheckpoint.notificationEnqueuedAt, null);
  assert.equal(await markAutoAcceptJobSettlementCheckpoint({
    id: checkpointed.id,
    ownerNodeId: "auto-worker-checkpoint-reclaim",
    claimToken: checkpointClaimToken,
    historyWrittenAt: new Date("2030-01-01T00:02:13.000Z"),
    now: new Date("2030-01-01T00:02:13.000Z"),
  }), true);
  settlementCheckpoint = await getJob(checkpointed.id);
  assert.ok(settlementCheckpoint);
  assert.ok(settlementCheckpoint.progressSettledAt, "partial settlement checkpoint must preserve progress timestamp");
  assert.ok(settlementCheckpoint.historyWrittenAt);
  assert.equal(settlementCheckpoint.notificationEnqueuedAt, null);

  assert.equal(await markAutoAcceptJobRetrying({
    id: checkpointed.id,
    ownerNodeId: "auto-worker-checkpoint-reclaim",
    claimToken: checkpointClaimToken,
    reasonCode: "settlement_pending",
    error: "notification enqueue pending",
    retryDelayMs: 180_000,
    count: "verify",
    now: new Date("2030-01-01T00:02:14.000Z"),
  }), true);
  const checkpointRetry = await getJob(checkpointed.id);
  assert.ok(checkpointRetry);
  assert.equal(checkpointRetry.status, "retrying");
  assert.equal(checkpointRetry.claimToken, null);
  assert.equal(checkpointRetry.verifyCount, 1);
  assert.equal(checkpointRetry.resultStatus, "owned");
  assert.equal(checkpointRetry.resultReasonCode, "verified_owned");
  assert.equal(checkpointRetry.winningAttemptTraceId, "aa:2:2791815:40288119:2030");
  assert.ok(checkpointRetry.progressSettledAt);
  assert.ok(checkpointRetry.historyWrittenAt);
  assert.equal(checkpointRetry.completedAt, null);

  const exhausted = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791813,
    requestId: 40288117,
    maxAttempts: 1,
    payload: { ...baseJob().payload, bookingId: 2791813, requestId: 40288117 },
  }));
  const [exhaustedClaim] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-d",
    claimToken: "claim-d",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:03:00.000Z"),
  });
  assert.equal(exhaustedClaim.id, exhausted.id);
  assert.equal(await markAutoAcceptJobRetrying({
    id: exhausted.id,
    ownerNodeId: "auto-worker-d",
    claimToken: "claim-d",
    reasonCode: "accept_api_error",
    error: "terminal after max attempts",
    retryDelayMs: 5_000,
    count: "attempt",
    now: new Date("2030-01-01T00:03:01.000Z"),
  }), true);
  const deadByExhaustion = await getJob(exhausted.id);
  assert.ok(deadByExhaustion);
  assert.equal(deadByExhaustion.status, "dead_letter");
  assert.equal(deadByExhaustion.attemptCount, 1);
  assert.equal(deadByExhaustion.claimOwner, null);
  assert.ok(deadByExhaustion.completedAt);

  const permanent = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791814,
    requestId: 40288118,
    payload: { ...baseJob().payload, bookingId: 2791814, requestId: 40288118 },
  }));
  const [permanentClaim] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-e",
    claimToken: "claim-e",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:04:00.000Z"),
  });
  assert.equal(permanentClaim.id, permanent.id);
  assert.equal(await markAutoAcceptJobDeadLetter({
    id: permanent.id,
    ownerNodeId: "auto-worker-e",
    claimToken: "claim-e",
    reasonCode: "malformed_payload",
    error: "x".repeat(1200),
    now: new Date("2030-01-01T00:04:01.000Z"),
  }), true);
  const permanentDead = await getJob(permanent.id);
  assert.ok(permanentDead);
  assert.equal(permanentDead.status, "dead_letter");
  assert.equal(permanentDead.claimOwner, null);
  assert.equal(permanentDead.claimToken, null);
  assert.equal(permanentDead.lastReasonCode, "malformed_payload");
  assert.equal(permanentDead.lastError?.length, 1000);
  assert.ok(permanentDead.completedAt);

  const ordinaryRetrying = await enqueueAutoAcceptJob(baseJob({
    teamId: 4,
    bookingId: 2791818,
    requestId: 40288122,
    payload: { ...baseJob().payload, teamId: 4, bookingId: 2791818, requestId: 40288122 },
  }));
  const [ordinaryRetryingClaim] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-ordinary-retry",
    claimToken: "claim-ordinary-retry",
    teamIds: [4],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:04:10.000Z"),
  });
  assert.equal(ordinaryRetryingClaim.id, ordinaryRetrying.id);
  assert.equal(await markAutoAcceptJobRetrying({
    id: ordinaryRetrying.id,
    ownerNodeId: "auto-worker-ordinary-retry",
    claimToken: "claim-ordinary-retry",
    reasonCode: "accept_timeout_ambiguous",
    error: "ordinary execution retry should stay out of settlement scope",
    retryDelayMs: 50_000,
    count: "attempt",
    now: new Date("2030-01-01T00:04:11.000Z"),
  }), true);
  const ordinaryPending = await enqueueAutoAcceptJob(baseJob({
    teamId: 4,
    bookingId: 2791817,
    requestId: 40288121,
    nextRunAt: new Date("2030-01-01T00:05:00.000Z"),
    payload: { ...baseJob().payload, teamId: 4, bookingId: 2791817, requestId: 40288121 },
  }));

  const checkpointedRetrying = await enqueueAutoAcceptJob(baseJob({
    teamId: 4,
    bookingId: 2791819,
    requestId: 40288123,
    payload: { ...baseJob().payload, teamId: 4, bookingId: 2791819, requestId: 40288123 },
  }));
  const [checkpointedRetryingClaim] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-settlement-retry",
    claimToken: "claim-settlement-retry",
    teamIds: [4],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:04:20.000Z"),
  });
  assert.equal(checkpointedRetryingClaim.id, checkpointedRetrying.id);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: checkpointedRetrying.id,
    ownerNodeId: "auto-worker-settlement-retry",
    claimToken: "claim-settlement-retry",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791819:40288123:2030",
    now: new Date("2030-01-01T00:04:21.000Z"),
  }), true);
  assert.equal(await markAutoAcceptJobSettlementCheckpoint({
    id: checkpointedRetrying.id,
    ownerNodeId: "auto-worker-settlement-retry",
    claimToken: "claim-settlement-retry",
    progressSettledAt: new Date("2030-01-01T00:04:22.000Z"),
    now: new Date("2030-01-01T00:04:22.000Z"),
  }), true);
  assert.equal(await markAutoAcceptJobRetrying({
    id: checkpointedRetrying.id,
    ownerNodeId: "auto-worker-settlement-retry",
    claimToken: "claim-settlement-retry",
    reasonCode: "settlement_pending",
    error: "checkpointed settlement retry should be claimable",
    retryDelayMs: 37_000,
    count: "verify",
    now: new Date("2030-01-01T00:04:23.000Z"),
  }), true);

  const expiredCheckpointedVerifying = await enqueueAutoAcceptJob(baseJob({
    teamId: 4,
    bookingId: 2791820,
    requestId: 40288124,
    payload: { ...baseJob().payload, teamId: 4, bookingId: 2791820, requestId: 40288124 },
  }));
  const [expiredCheckpointedVerifyingClaim] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-expired-verifying",
    claimToken: "claim-expired-verifying",
    teamIds: [4],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:04:30.000Z"),
  });
  assert.equal(expiredCheckpointedVerifyingClaim.id, expiredCheckpointedVerifying.id);
  assert.equal(await markAutoAcceptJobVerifying({
    id: expiredCheckpointedVerifying.id,
    ownerNodeId: "auto-worker-expired-verifying",
    claimToken: "claim-expired-verifying",
    now: new Date("2030-01-01T00:04:31.000Z"),
  }), true);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: expiredCheckpointedVerifying.id,
    ownerNodeId: "auto-worker-expired-verifying",
    claimToken: "claim-expired-verifying",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791820:40288124:2030",
    now: new Date("2030-01-01T00:04:32.000Z"),
  }), true);

  const liveCheckpointedVerifying = await enqueueAutoAcceptJob(baseJob({
    teamId: 4,
    bookingId: 2791821,
    requestId: 40288125,
    payload: { ...baseJob().payload, teamId: 4, bookingId: 2791821, requestId: 40288125 },
  }));
  const [liveCheckpointedVerifyingClaim] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-live-verifying",
    claimToken: "claim-live-verifying",
    teamIds: [4],
    limit: 5,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:04:40.000Z"),
  });
  assert.equal(liveCheckpointedVerifyingClaim.id, liveCheckpointedVerifying.id);
  assert.equal(await markAutoAcceptJobVerifying({
    id: liveCheckpointedVerifying.id,
    ownerNodeId: "auto-worker-live-verifying",
    claimToken: "claim-live-verifying",
    now: new Date("2030-01-01T00:04:41.000Z"),
  }), true);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: liveCheckpointedVerifying.id,
    ownerNodeId: "auto-worker-live-verifying",
    claimToken: "claim-live-verifying",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791821:40288125:2030",
    now: new Date("2030-01-01T00:04:42.000Z"),
  }), true);

  const settlementBeforeExpiry = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-settlement-before-expiry",
    claimToken: "claim-settlement-before-expiry",
    teamIds: [4],
    limit: 10,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:04:59.999Z"),
    scope: "settlement",
  });
  assert.deepEqual(settlementBeforeExpiry, []);

  const settlementClaims = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-settlement-scope",
    claimToken: "claim-settlement-scope",
    teamIds: [4],
    limit: 10,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:05:00.000Z"),
    scope: "settlement",
  });
  assert.deepEqual(
    settlementClaims.map((row) => row.id),
    [checkpointedRetrying.id, expiredCheckpointedVerifying.id],
  );
  assert.equal((await getJob(ordinaryPending.id))?.claimToken, null);
  assert.equal((await getJob(ordinaryRetrying.id))?.claimToken, null);
  assert.equal((await getJob(liveCheckpointedVerifying.id))?.claimToken, "claim-live-verifying");

  const verifyingJob = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791816,
    requestId: 40288120,
    payload: { ...baseJob().payload, bookingId: 2791816, requestId: 40288120 },
  }));
  const [verifyingClaim] = await claimAutoAcceptJobs({
    ownerNodeId: "auto-worker-verifying",
    claimToken: "claim-verifying",
    teamIds: [2],
    limit: 5,
    leaseMs: 30_000,
    now: new Date("2030-01-01T00:04:10.000Z"),
  });
  assert.equal(verifyingClaim.id, verifyingJob.id);
  assert.equal(await markAutoAcceptJobVerifying({
    id: verifyingJob.id,
    ownerNodeId: "auto-worker-verifying",
    claimToken: "claim-verifying",
    now: new Date("2030-01-01T00:04:11.000Z"),
  }), true);
  assert.equal(await markAutoAcceptJobResultCheckpoint({
    id: verifyingJob.id,
    ownerNodeId: "auto-worker-verifying",
    claimToken: "claim-verifying",
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: "aa:2:2791816:40288120:2030",
    now: new Date("2030-01-01T00:04:12.000Z"),
  }), true);

  const queueSummary = await getAutoAcceptJobQueueSummary(new Date("2030-01-01T00:05:00.000Z"));
  assert.equal(queueSummary.total, 12);
  assert.equal(queueSummary.byStatus.pending, 3);
  assert.equal(queueSummary.byStatus.retrying, 2);
  assert.equal(queueSummary.byStatus.succeeded, 1);
  assert.equal(queueSummary.byStatus.dead_letter, 2);
  assert.equal(queueSummary.byStatus.claimed, 2);
  assert.equal(queueSummary.byStatus.verifying, 2);
  assert.equal(queueSummary.byAttemptKind.pending_request, 12);
  assert.equal(queueSummary.byAttemptKind.fast_accept_all, 0);
  assert.equal(queueSummary.claimableCount, 3);
  assert.equal(queueSummary.expiredClaimCount, 1);
  assert.equal(queueSummary.inFlightCount, 3);
  assert.equal(queueSummary.terminalCount, 3);
  assert.equal(queueSummary.settlementPendingCount, 5);
  assert.equal("payloadJson" in queueSummary, false);
  assert.equal(JSON.stringify(queueSummary).includes("SPX timed out after submit"), false);

  await resetDb();
  const budgetRuleId = "rule-budget-metrics";
  await seedBudgetRule(budgetRuleId);
  await reserveAndCompleteBudgetMetricJob({
    bookingId: 2791900,
    requestId: 40289000,
    ruleId: budgetRuleId,
    reservationAt: new Date("2030-01-01T00:10:00.000Z"),
    completedAt: new Date("2030-01-01T00:30:00.000Z"),
    status: "indeterminate",
    resultStatus: "unknown",
    resultReasonCode: "accept_timeout_ambiguous",
  });
  await reserveAndCompleteBudgetMetricJob({
    bookingId: 2791901,
    requestId: 40289001,
    ruleId: budgetRuleId,
    reservationAt: new Date("2030-01-01T00:50:00.000Z"),
    completedAt: new Date("2030-01-01T00:50:30.000Z"),
    status: "indeterminate",
    resultStatus: "unknown",
    resultReasonCode: "accept_timeout_ambiguous",
  });
  await reserveAndCompleteBudgetMetricJob({
    bookingId: 2791904,
    requestId: 40289004,
    ruleId: budgetRuleId,
    reservationAt: new Date("2030-01-01T00:44:00.000Z"),
    completedAt: new Date("2030-01-01T00:45:00.000Z"),
    status: "indeterminate",
    resultStatus: "unknown",
    resultReasonCode: "accept_timeout_ambiguous",
  });
  await reserveAndCompleteBudgetMetricJob({
    bookingId: 2791905,
    requestId: 40289005,
    ruleId: budgetRuleId,
    reservationAt: new Date("2030-01-01T00:44:30.000Z"),
    completedAt: new Date("2030-01-01T00:45:01.000Z"),
    status: "indeterminate",
    resultStatus: "unknown",
    resultReasonCode: "accept_timeout_ambiguous",
  });
  await reserveAndCompleteBudgetMetricJob({
    bookingId: 2791902,
    requestId: 40289002,
    ruleId: budgetRuleId,
    reservationAt: new Date("2030-01-01T00:00:00.000Z"),
    completedAt: new Date("2030-01-01T00:20:00.000Z"),
    status: "indeterminate",
    resultStatus: "unknown",
    resultReasonCode: "accept_timeout_ambiguous",
    releaseAt: new Date("2030-01-01T00:21:00.000Z"),
  });
  await reserveAndCompleteBudgetMetricJob({
    bookingId: 2791903,
    requestId: 40289003,
    ruleId: budgetRuleId,
    reservationAt: new Date("2030-01-01T00:05:00.000Z"),
    completedAt: new Date("2030-01-01T00:25:00.000Z"),
    status: "indeterminate",
    resultStatus: "unknown",
    resultReasonCode: "accept_timeout_ambiguous",
    progressAt: new Date("2030-01-01T00:26:00.000Z"),
  });

  const budgetSummary = await getAutoAcceptJobQueueSummary(new Date("2030-01-01T01:00:00.000Z"));
  assert.equal(budgetSummary.budgetReservations.activeCount, 4);
  assert.equal(budgetSummary.budgetReservations.staleCount, 2);
  assert.equal(budgetSummary.budgetReservations.oldestHeldAt, "2030-01-01T00:10:00.000Z");
  assert.equal(budgetSummary.budgetReservations.oldestHeldAgeMs, 50 * 60 * 1000);
  assert.equal(budgetSummary.budgetReservations.staleTtlMs, 15 * 60_000);
  const budgetSummaryJson = JSON.stringify(budgetSummary);
  assert.equal(budgetSummaryJson.includes("payloadJson"), false);
  assert.equal(budgetSummaryJson.includes("budget reservation payload must not appear in read models"), false);

  await resetDb();
  const mappingJob = await seedSummaryJob({
    teamId: 2,
    bookingId: 4_900_001,
    requestId: 5_900_001,
    ruleId: "dead-summary-mapping",
    attemptKind: "pending_request",
    status: "dead_letter",
    reasonCode: "malformed_payload",
    payloadSentinel: "mapping payload must stay private",
    errorSentinel: "mapping error must stay private",
    traceSentinel: "mapping trace must stay private",
  });
  const storedReasonMappings = {
    invalid_payload: ["malformed_payload", "dry_run_invalid_payload", "dry_run_invalid_payload_json", "settlement_invalid_payload", "settlement_invalid_payload_json"],
    identity_mismatch: ["dry_run_identity_mismatch", "dry_run_attempt_source_mismatch", "settlement_identity_mismatch", "settlement_request_id_required"],
    configuration_error: ["dry_run_rule_inactive", "dry_run_rule_state_mismatch", "dry_run_rule_state_unavailable", "dry_run_rule_missing", "real_execution_policy_unavailable", "real_execution_policy_blocked", "session_expired", "fast_accept_all_api_not_configured"],
    execution_failure: ["accept_api_error", "worker_execution_error"],
    verification_indeterminate: ["accept_timeout_ambiguous", "verify_indeterminate", "fast_accept_all_no_verified_owned_requests"],
    progress_persistence_failure: ["progress_settlement_failed"],
    result_persistence_failure: ["real_execution_result_checkpoint_failed", "settlement_checkpoint_failed"],
    history_persistence_failure: ["history_settlement_failed"],
    notification_persistence_failure: ["notification_settlement_failed"],
    unsupported_job: ["dry_run_forbidden_payload_key", "real_execution_attempt_kind_not_supported"],
  } as const;
  const mappingDb = await getDb();
  for (const [publicReason, storedReasons] of Object.entries(storedReasonMappings)) {
    for (const storedReason of storedReasons) {
      await mappingDb
        .update(autoAcceptJobs)
        .set({ lastReasonCode: storedReason })
        .where(eq(autoAcceptJobs.id, mappingJob.id));
      const mappedSummary = await getAutoAcceptJobQueueSummary(new Date("2030-01-01T01:00:00.000Z"));
      assert.equal(
        mappedSummary.deadLetters.byReasonCode[publicReason as keyof typeof mappedSummary.deadLetters.byReasonCode],
        1,
        `${storedReason} must map to ${publicReason}`,
      );
      assert.equal(mappedSummary.deadLetters.total, 1);
    }
  }

  await resetDb();
  const unsafeReason = "authorization=Bearer raw-dead-letter-secret";
  const rawError = "raw dead-letter stack and provider error must stay private";
  const rawPayload = "raw dead-letter payload must stay private";
  const rawTrace = "trace:raw-dead-letter-trace-must-stay-private";
  const summaryJobs = [
    { teamId: 2, bookingId: 5_000_001, requestId: 6_000_001, ruleId: "dead-summary-invalid", attemptKind: "pending_request", status: "dead_letter", reasonCode: "malformed_payload" },
    { teamId: 2, bookingId: 5_000_002, requestId: 6_000_002, ruleId: "dead-summary-secret", attemptKind: "pending_request", status: "dead_letter", reasonCode: unsafeReason },
    { teamId: 2, bookingId: 5_000_003, requestId: 6_000_003, ruleId: "dead-summary-empty", attemptKind: "pending_request", status: "dead_letter", reasonCode: "" },
    { teamId: 2, bookingId: 5_000_004, requestId: 6_000_004, ruleId: "dead-summary-null", attemptKind: "own_status_reconcile", status: "dead_letter", reasonCode: null },
    { teamId: 2, bookingId: 5_000_005, requestId: 6_000_005, ruleId: "dead-summary-malformed", attemptKind: "own_status_reconcile", status: "dead_letter", reasonCode: "MALFORMED_PAYLOAD" },
    { teamId: 3, bookingId: 5_000_006, requestId: 0, ruleId: "dead-summary-execution", attemptKind: "fast_accept_all", status: "dead_letter", reasonCode: "accept_api_error" },
    { teamId: 3, bookingId: 5_000_007, requestId: 0, ruleId: "dead-summary-unknown", attemptKind: "fast_accept_all", status: "dead_letter", reasonCode: "future_reason_not_public" },
    { teamId: 3, bookingId: 5_000_008, requestId: 0, ruleId: "dead-summary-nondead", attemptKind: "fast_accept_all", status: "pending", reasonCode: unsafeReason },
  ] as const;
  for (const [index, job] of summaryJobs.entries()) {
    await seedSummaryJob({
      ...job,
      payloadSentinel: `${rawPayload}:${index}`,
      errorSentinel: `${rawError}:${index}`,
      traceSentinel: `${rawTrace}:${index}`,
    });
  }
  const legacyAttemptKind = "legacy_attempt_kind_must_not_leak";
  const legacyAttemptJob = await seedSummaryJob({
    teamId: 1,
    bookingId: 5_000_009,
    requestId: 6_000_009,
    ruleId: "dead-summary-legacy-attempt",
    attemptKind: "pending_request",
    status: "dead_letter",
    reasonCode: "malformed_payload",
    payloadSentinel: `${rawPayload}:legacy-attempt`,
    errorSentinel: `${rawError}:legacy-attempt`,
    traceSentinel: `${rawTrace}:legacy-attempt`,
  });
  const legacyAttemptDb = await getDb();
  await legacyAttemptDb
    .update(autoAcceptJobs)
    .set({ attemptKind: legacyAttemptKind as never })
    .where(eq(autoAcceptJobs.id, legacyAttemptJob.id));

  const deadLetterSummary = await getAutoAcceptJobQueueSummary(new Date("2030-01-01T01:00:00.000Z"));
  assert.equal(deadLetterSummary.total, 9);
  assert.equal(deadLetterSummary.byStatus.dead_letter, 8);
  assert.deepEqual(deadLetterSummary.deadLetters.byReasonCode, {
    invalid_payload: 2,
    identity_mismatch: 0,
    configuration_error: 0,
    execution_failure: 1,
    verification_indeterminate: 0,
    progress_persistence_failure: 0,
    result_persistence_failure: 0,
    history_persistence_failure: 0,
    notification_persistence_failure: 0,
    unsupported_job: 0,
    other: 5,
  });
  assert.deepEqual(deadLetterSummary.deadLetters.groups, [
    { teamId: 1, attemptKind: "other", reasonCode: "invalid_payload", count: 1 },
    { teamId: 2, attemptKind: "own_status_reconcile", reasonCode: "other", count: 2 },
    { teamId: 2, attemptKind: "pending_request", reasonCode: "invalid_payload", count: 1 },
    { teamId: 2, attemptKind: "pending_request", reasonCode: "other", count: 2 },
    { teamId: 3, attemptKind: "fast_accept_all", reasonCode: "execution_failure", count: 1 },
    { teamId: 3, attemptKind: "fast_accept_all", reasonCode: "other", count: 1 },
  ]);
  assert.equal(deadLetterSummary.deadLetters.total, 8);
  assert.equal(
    deadLetterSummary.deadLetters.groups.reduce((total, group) => total + group.count, 0),
    deadLetterSummary.byStatus.dead_letter,
  );
  const deadLetterSummaryJson = JSON.stringify(deadLetterSummary.deadLetters);
  for (const forbidden of [
    unsafeReason,
    "malformed_payload",
    rawError,
    rawPayload,
    rawTrace,
    legacyAttemptKind,
    "dead-summary-secret",
    "claim-owner-5000002",
    "claim-token-6000002",
    "5000002",
    "6000002",
  ]) {
    assert.equal(deadLetterSummaryJson.includes(forbidden), false, `dead-letter summary leaked ${forbidden}`);
  }

  const publicationIdentity = {
    teamId: 2,
    epoch: "phase3-ifn-20300101",
    pollerNodeId: "poller-ifn-claim-1",
  };
  await resetDb();
  await enablePublication(publicationIdentity);
  const fencedDrainJob = await enqueueAutoAcceptJob(baseJob({
    cutoverEpoch: publicationIdentity.epoch,
    requestId: 7_100_001,
  }));
  await fencePublication(publicationIdentity);
  const fencedClaims = await claimAutoAcceptJobs({
    ownerNodeId: "auto-accept-ifn-claim-1",
    claimToken: "fenced-active-claim",
    teamIds: [publicationIdentity.teamId],
    limit: 10,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
  });
  assert.deepEqual(
    fencedClaims.map((row) => row.id),
    [fencedDrainJob.id],
    "fenced active generation remains drainable",
  );

  await resetDb();
  await enablePublication(publicationIdentity);
  const staleJob = await enqueueAutoAcceptJob(baseJob({
    cutoverEpoch: publicationIdentity.epoch,
    requestId: 7_100_002,
  }));
  const fencedForAdvance = await fencePublication(publicationIdentity);
  getRawMemoryDb().prepare(`
    UPDATE auto_accept_jobs
    SET status = 'succeeded', result_status = 'owned', completed_at = datetime('now')
    WHERE id = ?
  `).run(staleJob.id);
  await acknowledgePublicationFence({
    ...publicationIdentity,
    ackJobId: fencedForAdvance.fenceJobId ?? 0,
  });
  await advancePublicationEpoch({
    teamId: publicationIdentity.teamId,
    previousEpoch: publicationIdentity.epoch,
    nextEpoch: "phase3-ifn-20300102",
    nextPollerNodeId: publicationIdentity.pollerNodeId,
  });
  getRawMemoryDb().prepare(`
    UPDATE auto_accept_jobs
    SET status = 'pending', result_status = NULL, completed_at = NULL,
        next_run_at = '2030-01-01 00:00:00'
    WHERE id = ?
  `).run(staleJob.id);
  const staleClaims = await claimAutoAcceptJobs({
    ownerNodeId: "auto-accept-ifn-claim-1",
    claimToken: "stale-generation-claim",
    teamIds: [publicationIdentity.teamId],
    limit: 10,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:02:00.000Z"),
  });
  assert.deepEqual(staleClaims, []);
  const quarantined = await getJob(staleJob.id);
  assert.equal(quarantined?.status, "indeterminate");
  assert.equal(quarantined?.lastReasonCode, "stale_publication_epoch");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
