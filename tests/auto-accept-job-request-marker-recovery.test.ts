import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { autoAcceptAttempts, autoAcceptJobs } from "../src/db/schema.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
  type AutoAcceptJobRow,
} from "../src/repositories/auto-accept-job-repository.js";
import {
  __autoAcceptAttemptRepositoryTestHooks,
  beginAutoAcceptAttempt,
  getAutoAcceptAttemptByTraceId,
  getAutoAcceptResult,
  upsertAutoAcceptResult,
} from "../src/repositories/auto-accept-result-repository.js";
import {
  runAutoAcceptJobRealExecutionBatch,
  type AutoAcceptJobRealExecutionApi,
} from "../src/services/auto-accept-job-real-execution.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function probeJob(overrides: {
  bookingId?: number;
  requestId?: number;
  ruleId?: string;
  attemptKind?: "pending_request" | "non_pending_probe";
  payload?: Record<string, unknown>;
} = {}) {
  const identity = {
    teamId: 2,
    bookingId: overrides.bookingId ?? 2791900,
    requestId: overrides.requestId ?? 40289000,
    ruleId: overrides.ruleId ?? "rule-marker",
    attemptKind: overrides.attemptKind ?? "non_pending_probe" as const,
  };
  return {
    ...identity,
    payload: {
      executionMode: "cutover",
      schemaVersion: 1,
      idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity),
      attemptKind: identity.attemptKind,
      teamId: identity.teamId,
      bookingId: identity.bookingId,
      requestId: identity.requestId,
      ruleId: identity.ruleId,
      ruleName: "Marker recovery rule",
      acceptAll: false,
      source: identity.attemptKind === "pending_request" ? "pending_tab" : "non_pending_tab",
      trip: {
        request_id: identity.requestId,
        booking_id: identity.bookingId,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
        acceptance_status: 4,
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
      ...overrides.payload,
    },
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

const activeRuleState = () => ({
  need: 1,
  accept_all: false,
  enabled: true,
  fulfilled: false,
});

function acceptedList(requestId: number) {
  return {
    data: {
      request_list: [{ request_id: requestId, request_acceptance_status: 2 }],
    },
  };
}

function traceFor(jobId: number, ordinal = 1): string {
  return `aa-job:${jobId}:external:${ordinal}`;
}

async function attemptsForJob(jobId: number) {
  const rows = await (await getDb()).select().from(autoAcceptAttempts);
  return rows.filter((row) => row.traceId.startsWith(`aa-job:${jobId}:external:`));
}

async function beginMarker(job: AutoAcceptJobRow, ordinal = 1) {
  const payload = JSON.parse(job.payloadJson) as {
    ruleName: string;
  };
  return await beginAutoAcceptAttempt({
    traceId: traceFor(job.id, ordinal),
    teamId: job.teamId,
    workerNodeId: "previous-owner",
    bookingId: job.bookingId,
    requestIds: [job.requestId],
    ruleId: job.ruleId,
    ruleName: payload.ruleName,
    acceptMode: "request_ids",
    acceptStartedAt: new Date("2030-01-01T00:00:30.000Z"),
  });
}

async function runOne(input: {
  apiClient: AutoAcceptJobRealExecutionApi;
  now: string;
  loadRuleState?: typeof activeRuleState;
  ownerNodeId?: string;
}) {
  return await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: input.ownerNodeId ?? "request-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date(input.now),
    claimTokenFactory: () => `claim-${input.now}`,
    apiClient: input.apiClient,
    loadRuleState: input.loadRuleState ?? activeRuleState,
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnRuleStateError: 1,
    retryDelayMsOnSettlementPending: 1,
    retryDelayMsOnCheckpointError: 1,
  });
}

async function main() {
  await resetDb();

  const orderedJob = await enqueueAutoAcceptJob(probeJob());
  const orderedTrace = traceFor(orderedJob.id);
  const order: string[] = [];
  const orderedApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      const marker = await getAutoAcceptAttemptByTraceId(orderedTrace);
      assert.ok(marker, "marker must be durable before POST");
      assert.equal(marker.acceptFinishedAt, null);
      order.push("post");
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList() {
      order.push("verify");
      return acceptedList(orderedJob.requestId);
    },
  };
  const orderedSummary = await runOne({
    apiClient: orderedApi,
    now: "2030-01-01T00:01:00.000Z",
  });
  assert.equal(orderedSummary.retried, 1);
  assert.deepEqual(order, ["post", "verify", "verify"]);
  const orderedAttempts = await attemptsForJob(orderedJob.id);
  assert.equal(orderedAttempts.length, 1);
  assert.equal(orderedAttempts[0]?.traceId, orderedTrace);
  assert.ok(orderedAttempts[0]?.acceptFinishedAt);

  await resetDb();

  const acknowledgementJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791901, requestId: 40289001 }));
  let acknowledgementHookCalls = 0;
  const hooks = __autoAcceptAttemptRepositoryTestHooks as typeof __autoAcceptAttemptRepositoryTestHooks & {
    setAfterBeginInsert(hook: (() => Promise<void>) | null): void;
  };
  hooks.setAfterBeginInsert(async () => {
    acknowledgementHookCalls += 1;
    if (acknowledgementHookCalls === 1) throw new Error("begin-ack-secret-value");
  });
  let acknowledgementPosts = 0;
  const acknowledgementApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      acknowledgementPosts += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList() {
      return acceptedList(acknowledgementJob.requestId);
    },
  };
  try {
    const acknowledgementFirst = await runOne({
      apiClient: acknowledgementApi,
      now: "2030-01-01T00:02:00.000Z",
    });
    assert.equal(acknowledgementFirst.executorErrors, 0);
    assert.equal(acknowledgementFirst.retried, 1);
  } finally {
    hooks.setAfterBeginInsert(null);
  }
  assert.equal(acknowledgementPosts, 0);
  assert.equal((await attemptsForJob(acknowledgementJob.id)).length, 1);
  const acknowledgementAfterFirst = await getAutoAcceptJobById(acknowledgementJob.id);
  assert.equal(acknowledgementAfterFirst?.attemptCount, 0);
  assert.equal(acknowledgementAfterFirst?.verifyCount, 1);
  assert.doesNotMatch(acknowledgementAfterFirst?.lastError ?? "", /begin-ack-secret-value/);
  await runOne({ apiClient: acknowledgementApi, now: "2030-01-01T00:02:01.000Z" });
  assert.equal(acknowledgementPosts, 0);
  assert.equal((await getAutoAcceptResult(2, acknowledgementJob.bookingId, acknowledgementJob.requestId))?.status, "owned");

  await resetDb();

  const thrownPostJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791902, requestId: 40289002 }));
  let thrownPostCalls = 0;
  let thrownPostRecovery = false;
  const thrownPostApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      thrownPostCalls += 1;
      throw new Error("post-secret-value");
    },
    async fetchBookingRequestList() {
      return thrownPostRecovery ? acceptedList(thrownPostJob.requestId) : null;
    },
  };
  const thrownFirst = await runOne({ apiClient: thrownPostApi, now: "2030-01-01T00:03:00.000Z" });
  assert.equal(thrownFirst.executorErrors, 0);
  assert.equal(thrownFirst.retried, 1);
  assert.equal(thrownPostCalls, 1);
  const incomplete = await getAutoAcceptAttemptByTraceId(traceFor(thrownPostJob.id));
  assert.ok(incomplete);
  assert.equal(incomplete.acceptFinishedAt, null);
  const thrownAfterFirst = await getAutoAcceptJobById(thrownPostJob.id);
  assert.equal(thrownAfterFirst?.attemptCount, 0);
  assert.equal(thrownAfterFirst?.verifyCount, 1);
  assert.doesNotMatch(thrownAfterFirst?.lastError ?? "", /post-secret-value/);
  thrownPostRecovery = true;
  await runOne({ apiClient: thrownPostApi, now: "2030-01-01T00:03:01.000Z" });
  assert.equal(thrownPostCalls, 1);
  assert.equal((await getAutoAcceptResult(2, thrownPostJob.bookingId, thrownPostJob.requestId))?.status, "owned");

  await resetDb();

  const completedBeforeCanonicalJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791903, requestId: 40289003 }));
  let completeBeforeCanonicalPosts = 0;
  let malformedVerification = true;
  const completeBeforeCanonicalApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      completeBeforeCanonicalPosts += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList() {
      if (malformedVerification) return { data: { request_list: null } } as never;
      return acceptedList(completedBeforeCanonicalJob.requestId);
    },
  };
  const completedBeforeCanonicalFirst = await runOne({
    apiClient: completeBeforeCanonicalApi,
    now: "2030-01-01T00:04:00.000Z",
  });
  assert.equal(completedBeforeCanonicalFirst.executorErrors, 0);
  assert.equal(completedBeforeCanonicalFirst.retried, 1);
  assert.equal(completeBeforeCanonicalPosts, 1);
  assert.ok((await getAutoAcceptAttemptByTraceId(traceFor(completedBeforeCanonicalJob.id)))?.acceptFinishedAt);
  assert.equal(await getAutoAcceptResult(2, completedBeforeCanonicalJob.bookingId, completedBeforeCanonicalJob.requestId), null);
  malformedVerification = false;
  await runOne({ apiClient: completeBeforeCanonicalApi, now: "2030-01-01T00:04:01.000Z" });
  assert.equal(completeBeforeCanonicalPosts, 1);
  assert.equal((await getAutoAcceptResult(2, completedBeforeCanonicalJob.bookingId, completedBeforeCanonicalJob.requestId))?.status, "owned");

  await resetDb();

  const completionConflictJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791907, requestId: 40289007 }));
  const completionHooks = __autoAcceptAttemptRepositoryTestHooks as typeof __autoAcceptAttemptRepositoryTestHooks & {
    setBeforeCompletionRead(hook: (() => Promise<void>) | null): void;
  };
  let completionConflictHookCalls = 0;
  completionHooks.setBeforeCompletionRead(async () => {
    completionConflictHookCalls += 1;
    if (completionConflictHookCalls !== 1) return;
    await (await getDb())
      .update(autoAcceptAttempts)
      .set({ bookingId: completionConflictJob.bookingId + 1 })
      .where(eq(autoAcceptAttempts.traceId, traceFor(completionConflictJob.id)));
  });
  let completionConflictPosts = 0;
  const completionConflictApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      completionConflictPosts += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList() {
      return acceptedList(completionConflictJob.requestId);
    },
  };
  try {
    const completionConflictFirst = await runOne({
      apiClient: completionConflictApi,
      now: "2030-01-01T00:04:30.000Z",
    });
    assert.equal(completionConflictFirst.retried, 1);
    assert.equal(completionConflictFirst.deadLettered, 0);
  } finally {
    completionHooks.setBeforeCompletionRead(null);
  }
  assert.equal(completionConflictPosts, 1);
  const completionConflictAfterFirst = await getAutoAcceptJobById(completionConflictJob.id);
  assert.equal(completionConflictAfterFirst?.attemptCount, 0);
  assert.equal(completionConflictAfterFirst?.verifyCount, 1);
  assert.equal(completionConflictAfterFirst?.lastReasonCode, "external_attempt_identity_conflict");
  const completionConflictSecond = await runOne({
    apiClient: completionConflictApi,
    now: "2030-01-01T00:04:31.000Z",
  });
  assert.equal(completionConflictSecond.retried, 1);
  assert.equal(completionConflictSecond.deadLettered, 0);
  assert.equal(completionConflictPosts, 1);
  assert.equal((await attemptsForJob(completionConflictJob.id)).length, 1);
  const completionConflictAfterSecond = await getAutoAcceptJobById(completionConflictJob.id);
  assert.equal(completionConflictAfterSecond?.attemptCount, 0);
  assert.equal(completionConflictAfterSecond?.verifyCount, 2);
  assert.equal(completionConflictAfterSecond?.lastError, "external attempt identity conflict");

  await resetDb();

  const unknownJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791904, requestId: 40289004 }));
  let unknownPosts = 0;
  let unknownOwned = false;
  const unknownApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      unknownPosts += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList() {
      return unknownOwned ? acceptedList(unknownJob.requestId) : null;
    },
  };
  await runOne({ apiClient: unknownApi, now: "2030-01-01T00:05:00.000Z" });
  const unknownAfterFirst = await getAutoAcceptJobById(unknownJob.id);
  assert.equal(unknownAfterFirst?.resultStatus, null);
  assert.equal(unknownAfterFirst?.winningAttemptTraceId, null);
  assert.equal(unknownAfterFirst?.attemptCount, 0);
  assert.equal(unknownAfterFirst?.verifyCount, 1);
  assert.equal((await getAutoAcceptResult(2, unknownJob.bookingId, unknownJob.requestId))?.status, "unknown");
  unknownOwned = true;
  await runOne({ apiClient: unknownApi, now: "2030-01-01T00:05:01.000Z" });
  assert.equal(unknownPosts, 1);
  assert.equal((await attemptsForJob(unknownJob.id)).length, 1);
  const unknownAfterOwned = await getAutoAcceptJobById(unknownJob.id);
  assert.equal(unknownAfterOwned?.resultStatus, "owned");
  assert.equal(unknownAfterOwned?.winningAttemptTraceId, traceFor(unknownJob.id));

  await resetDb();

  const lostRenewalJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791905, requestId: 40289005 }));
  let lostRenewalPosts = 0;
  const lostRenewalClockValues = [
    new Date("2030-01-01T00:06:00.000Z"),
    new Date("2030-01-01T00:06:00.500Z"),
    new Date("2030-01-01T00:06:00.600Z"),
    new Date("2030-01-01T00:06:01.500Z"),
    new Date("2030-01-01T00:06:01.500Z"),
  ];
  let lostRenewalClockIndex = 0;
  const lostRenewalSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "expired-owner",
    teamIds: [2],
    limit: 1,
    leaseMs: 1000,
    now: new Date("2030-01-01T00:06:00.000Z"),
    clock: () => lostRenewalClockValues[
      Math.min(lostRenewalClockIndex++, lostRenewalClockValues.length - 1)
    ],
    claimTokenFactory: () => "expired-claim",
    apiClient: {
      async acceptBookingRequests() {
        lostRenewalPosts += 1;
        return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
      },
      async fetchBookingRequestList() {
        return acceptedList(lostRenewalJob.requestId);
      },
    },
    loadRuleState: activeRuleState,
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(lostRenewalSummary.claimed, 1);
  assert.equal(lostRenewalSummary.retried, 0);
  assert.equal(lostRenewalSummary.settleFailures, 1);
  assert.equal(lostRenewalPosts, 0);
  assert.equal((await attemptsForJob(lostRenewalJob.id)).length, 1);
  const expiredClaim = await getAutoAcceptJobById(lostRenewalJob.id);
  assert.equal(expiredClaim?.status, "claimed");
  assert.equal(expiredClaim?.claimOwner, "expired-owner");
  await runOne({
    apiClient: {
      async acceptBookingRequests() {
        lostRenewalPosts += 1;
        throw new Error("reclaimed marker must not POST");
      },
      async fetchBookingRequestList() {
        return acceptedList(lostRenewalJob.requestId);
      },
    },
    now: "2030-01-01T00:07:01.000Z",
    ownerNodeId: "replacement-owner",
  });
  assert.equal(lostRenewalPosts, 0);
  assert.equal((await getAutoAcceptResult(2, lostRenewalJob.bookingId, lostRenewalJob.requestId))?.status, "owned");

  await resetDb();

  const driftJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791906, requestId: 40289006 }));
  await (await getDb())
    .update(autoAcceptJobs)
    .set({ attemptCount: 3 })
    .where(eq(autoAcceptJobs.id, driftJob.id));
  const driftSummary = await runOne({
    apiClient: {
      async acceptBookingRequests() {
        throw new Error("drift-post-secret");
      },
      async fetchBookingRequestList() {
        return null;
      },
    },
    now: "2030-01-01T00:08:00.000Z",
  });
  assert.equal(driftSummary.executorErrors, 0);
  assert.ok(await getAutoAcceptAttemptByTraceId(traceFor(driftJob.id, 4)));
  const driftAfter = await getAutoAcceptJobById(driftJob.id);
  assert.equal(driftAfter?.attemptCount, 3);
  assert.equal(driftAfter?.verifyCount, 1);

  await resetDb();

  const existingDriftJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791908, requestId: 40289008 }));
  await beginMarker(existingDriftJob, 1);
  await (await getDb())
    .update(autoAcceptJobs)
    .set({ attemptCount: 3 })
    .where(eq(autoAcceptJobs.id, existingDriftJob.id));
  let existingDriftPosts = 0;
  const existingDriftSummary = await runOne({
    apiClient: {
      async acceptBookingRequests() {
        existingDriftPosts += 1;
        throw new Error("drifted existing marker must not POST");
      },
      async fetchBookingRequestList() {
        return acceptedList(existingDriftJob.requestId);
      },
    },
    now: "2030-01-01T00:09:00.000Z",
  });
  assert.equal(existingDriftSummary.retried, 1);
  assert.equal(existingDriftPosts, 0);
  assert.deepEqual((await attemptsForJob(existingDriftJob.id)).map((row) => row.traceId), [
    traceFor(existingDriftJob.id, 1),
  ]);
  const existingDriftAfter = await getAutoAcceptJobById(existingDriftJob.id);
  assert.equal(existingDriftAfter?.attemptCount, 3);
  assert.equal(existingDriftAfter?.verifyCount, 1);
  assert.equal(existingDriftAfter?.resultStatus, "owned");

  const structuralCases: Array<{
    payload: Record<string, unknown>;
    reasonCode: string;
  }> = [
    {
      payload: { nested: { deviceId: "forbidden-value" } },
      reasonCode: "dry_run_forbidden_payload_key",
    },
    {
      payload: { teamId: 999 },
      reasonCode: "dry_run_identity_mismatch",
    },
    {
      payload: { source: "pending_tab" },
      reasonCode: "dry_run_attempt_source_mismatch",
    },
    {
      payload: {
        trip: {
          request_id: 999999,
          booking_id: 2791933,
        },
      },
      reasonCode: "dry_run_identity_mismatch",
    },
  ];
  for (const [index, structuralCase] of structuralCases.entries()) {
    await resetDb();
    const structuralJob = await enqueueAutoAcceptJob(probeJob({
      bookingId: 2791930 + index,
      requestId: 40289030 + index,
      payload: structuralCase.payload,
    }));
    await beginMarker(structuralJob);
    let structuralRuleLoads = 0;
    let structuralApiCalls = 0;
    const structuralSummary = await runOne({
      apiClient: {
        async acceptBookingRequests() {
          structuralApiCalls += 1;
          throw new Error("invalid structure must not POST");
        },
        async fetchBookingRequestList() {
          structuralApiCalls += 1;
          return acceptedList(structuralJob.requestId);
        },
      },
      now: `2030-01-01T00:${30 + index}:00.000Z`,
      loadRuleState: (() => {
        structuralRuleLoads += 1;
        return activeRuleState();
      }) as typeof activeRuleState,
    });
    assert.equal(structuralSummary.deadLettered, 1);
    assert.equal(structuralRuleLoads, 0);
    assert.equal(structuralApiCalls, 0);
    assert.equal((await getAutoAcceptJobById(structuralJob.id))?.lastReasonCode, structuralCase.reasonCode);
  }

  for (const [index, staleRuleState] of [
    null,
    { need: 1, accept_all: false, enabled: false, fulfilled: false },
    { need: 1, accept_all: true, enabled: true, fulfilled: false },
  ].entries()) {
    await resetDb();
    const recoveredJob = await enqueueAutoAcceptJob(probeJob({
      bookingId: 2791910 + index,
      requestId: 40289010 + index,
      attemptKind: "pending_request",
    }));
    await beginMarker(recoveredJob);
    let mutableRuleLoads = 0;
    let recoveredPosts = 0;
    await runOne({
      apiClient: {
        async acceptBookingRequests() {
          recoveredPosts += 1;
          throw new Error("existing marker must not POST");
        },
        async fetchBookingRequestList() {
          return acceptedList(recoveredJob.requestId);
        },
      },
      now: `2030-01-01T00:${10 + index}:00.000Z`,
      loadRuleState: (() => {
        mutableRuleLoads += 1;
        return staleRuleState;
      }) as typeof activeRuleState,
    });
    assert.equal(mutableRuleLoads, 0);
    assert.equal(recoveredPosts, 0);
    assert.equal((await getAutoAcceptResult(2, recoveredJob.bookingId, recoveredJob.requestId))?.status, "owned");
  }

  await resetDb();

  const conflictJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791920, requestId: 40289020 }));
  await (await getDb())
    .update(autoAcceptJobs)
    .set({ attemptCount: 1 })
    .where(eq(autoAcceptJobs.id, conflictJob.id));
  await beginMarker(conflictJob, 1);
  await beginMarker(conflictJob, 2);
  let conflictPosts = 0;
  const conflictSummary = await runOne({
    apiClient: {
      async acceptBookingRequests() {
        conflictPosts += 1;
        throw new Error("conflicting markers must not POST");
      },
      async fetchBookingRequestList() {
        return acceptedList(conflictJob.requestId);
      },
    },
    now: "2030-01-01T00:20:00.000Z",
  });
  assert.equal(conflictSummary.deadLettered, 1);
  assert.equal(conflictPosts, 0);
  assert.equal((await getAutoAcceptJobById(conflictJob.id))?.lastReasonCode, "external_attempt_trace_conflict");

  await resetDb();

  const identityConflictJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791921, requestId: 40289021 }));
  await beginAutoAcceptAttempt({
    traceId: traceFor(identityConflictJob.id),
    teamId: identityConflictJob.teamId,
    workerNodeId: "wrong-marker-owner",
    bookingId: identityConflictJob.bookingId + 1,
    requestIds: [identityConflictJob.requestId],
    ruleId: identityConflictJob.ruleId,
    ruleName: "Marker recovery rule",
    acceptMode: "request_ids",
    acceptStartedAt: new Date("2030-01-01T00:20:30.000Z"),
  });
  const identityConflictSummary = await runOne({
    apiClient: {
      async acceptBookingRequests() {
        throw new Error("identity conflict must not POST");
      },
      async fetchBookingRequestList() {
        return acceptedList(identityConflictJob.requestId);
      },
    },
    now: "2030-01-01T00:21:00.000Z",
  });
  assert.equal(identityConflictSummary.retried, 1);
  assert.equal(identityConflictSummary.deadLettered, 0);
  const identityConflictAfter = await getAutoAcceptJobById(identityConflictJob.id);
  assert.equal(identityConflictAfter?.lastReasonCode, "external_attempt_identity_conflict");
  assert.equal(identityConflictAfter?.lastError, "external attempt identity conflict");

  await resetDb();

  const canonicalJob = await enqueueAutoAcceptJob(probeJob({ bookingId: 2791922, requestId: 40289022 }));
  await upsertAutoAcceptResult({
    teamId: canonicalJob.teamId,
    bookingId: canonicalJob.bookingId,
    requestId: canonicalJob.requestId,
    winningAttemptTraceId: "aa-job:existing-terminal",
    status: "owned",
    reasonCode: "verified_owned",
    evidence: { source: "preexisting-terminal" },
  });
  let canonicalRuleLoads = 0;
  let canonicalApiCalls = 0;
  await runOne({
    apiClient: {
      async acceptBookingRequests() {
        canonicalApiCalls += 1;
        throw new Error("terminal canonical shortcut must not POST");
      },
      async fetchBookingRequestList() {
        canonicalApiCalls += 1;
        throw new Error("terminal canonical shortcut must not verify");
      },
    },
    now: "2030-01-01T00:22:00.000Z",
    loadRuleState: (() => {
      canonicalRuleLoads += 1;
      throw new Error("terminal canonical shortcut must not load mutable rule");
    }) as typeof activeRuleState,
  });
  assert.equal(canonicalRuleLoads, 0);
  assert.equal(canonicalApiCalls, 0);
  const canonicalAfter = await getAutoAcceptJobById(canonicalJob.id);
  assert.equal(canonicalAfter?.resultStatus, "owned");
  assert.equal(canonicalAfter?.winningAttemptTraceId, "aa-job:existing-terminal");
  assert.deepEqual(await attemptsForJob(canonicalJob.id), []);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
