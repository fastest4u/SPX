import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
} from "../src/repositories/auto-accept-job-repository.js";
import {
  beginAutoAcceptAttempt,
  completeAutoAcceptAttempt,
  getAutoAcceptAttemptByTraceId,
  getAutoAcceptResult,
  upsertAutoAcceptResult,
} from "../src/repositories/auto-accept-result-repository.js";
import {
  runAutoAcceptJobRealExecutionBatch,
  type AutoAcceptJobRealExecutionApi,
} from "../src/services/auto-accept-job-real-execution.js";

async function resetDb(): Promise<void> {
  await closePool();
  resetMemoryDb();
}

function requestJob(input: {
  bookingId: number;
  requestId: number;
  attemptKind?: "non_pending_probe" | "own_status_reconcile";
}) {
  const attemptKind = input.attemptKind ?? "non_pending_probe";
  const source = attemptKind === "own_status_reconcile" ? "reconciliation" : "non_pending_tab";
  const identity = {
    teamId: 2,
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: "policy-recovery-rule",
    attemptKind,
  };
  return {
    ...identity,
    payload: {
      executionMode: "cutover",
      schemaVersion: 1,
      idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity),
      attemptKind,
      teamId: identity.teamId,
      bookingId: identity.bookingId,
      requestId: identity.requestId,
      ruleId: identity.ruleId,
      ruleName: "Policy recovery rule",
      acceptAll: false,
      source,
      trip: {
        request_id: identity.requestId,
        booking_id: identity.bookingId,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
        acceptance_status: attemptKind === "own_status_reconcile" ? 2 : 4,
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
  };
}

function fastAcceptAllJob(bookingId: number) {
  const identity = {
    teamId: 2,
    bookingId,
    requestId: 0,
    ruleId: "fast-policy-rule",
    attemptKind: "fast_accept_all" as const,
  };
  return {
    ...identity,
    payload: {
      executionMode: "cutover",
      schemaVersion: 1,
      idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity),
      attemptKind: identity.attemptKind,
      teamId: identity.teamId,
      bookingId,
      requestId: 0,
      ruleId: identity.ruleId,
      ruleName: "Fast policy rule",
      acceptAll: true,
      source: "booking_name",
      trip: {
        booking_id: bookingId,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
      },
      ruleSnapshot: {
        need: 2,
        accept_all: true,
        enabled: true,
        fulfilled: false,
      },
      observedAt: "2030-01-01T00:00:00.000Z",
      pollerNodeId: "poller-01",
      bookingName: "[ADHOC] Bangkok > Rayong",
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

async function runOne(input: {
  apiClient: AutoAcceptJobRealExecutionApi;
  now: string;
  onPolicyCheck: () => void;
  loadRuleState?: typeof activeRuleState;
}) {
  return await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "policy-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date(input.now),
    claimTokenFactory: () => `policy-${input.now}`,
    apiClient: input.apiClient,
    loadRuleState: input.loadRuleState ?? activeRuleState,
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnRuleStateError: 1,
    retryDelayMsOnSettlementPending: 1,
    retryDelayMsOnCheckpointError: 1,
    canStartNewExternalAttempt: async () => {
      input.onPolicyCheck();
      return false;
    },
  });
}

async function main(): Promise<void> {
  await resetDb();

  const unavailableJob = await enqueueAutoAcceptJob(requestJob({
    bookingId: 2792110,
    requestId: 40291110,
  }));
  let unavailablePosts = 0;
  const unavailableSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "policy-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "policy-unavailable",
    apiClient: {
      async acceptBookingRequests() {
        unavailablePosts += 1;
        return { ok: true, httpStatus: 200, response: { retcode: 0 } };
      },
      async fetchBookingRequestList() {
        return null;
      },
    },
    loadRuleState: activeRuleState,
    retryDelayMsOnRuleStateError: 1,
    canStartNewExternalAttempt: async () => {
      throw new Error("policy-db-secret-must-not-persist");
    },
  });
  assert.equal(unavailableSummary.retried, 1);
  assert.equal(unavailablePosts, 0);
  assert.equal(await getAutoAcceptAttemptByTraceId(`aa-job:${unavailableJob.id}:external:1`), null);
  const unavailableAfter = await getAutoAcceptJobById(unavailableJob.id);
  assert.equal(unavailableAfter?.attemptCount, 0);
  assert.equal(unavailableAfter?.verifyCount, 1);
  assert.equal(unavailableAfter?.lastReasonCode, "real_execution_policy_unavailable");
  assert.equal((unavailableAfter?.lastError ?? "").includes("policy-db-secret"), false);

  await resetDb();

  const fastJob = await enqueueAutoAcceptJob(fastAcceptAllJob(2792111));
  let fastPolicyChecks = 0;
  let fastPosts = 0;
  let fastReads = 0;
  const fastSummary = await runOne({
    now: "2030-01-01T00:02:00.000Z",
    loadRuleState: () => ({
      need: 2,
      accept_all: true,
      enabled: true,
      fulfilled: false,
    }),
    onPolicyCheck: () => {
      fastPolicyChecks += 1;
    },
    apiClient: {
      async acceptBookingRequests() {
        throw new Error("fast parent must not use request-id accept");
      },
      async acceptAllBookingRequests() {
        fastPosts += 1;
        return { ok: true, httpStatus: 200, response: { retcode: 0 } };
      },
      async fetchBookingRequestList() {
        fastReads += 1;
        return { data: { request_list: [] } };
      },
    },
  });
  assert.equal(fastSummary.retried, 1);
  assert.equal(fastPolicyChecks, 1);
  assert.equal(fastPosts, 0);
  assert.equal(fastReads, 0);
  assert.equal(await getAutoAcceptAttemptByTraceId(`aa-job:${fastJob.id}:external:1`), null);

  await resetDb();

  const incompleteJob = await enqueueAutoAcceptJob(requestJob({
    bookingId: 2792112,
    requestId: 40291112,
  }));
  const incompleteTrace = `aa-job:${incompleteJob.id}:external:1`;
  await beginAutoAcceptAttempt({
    traceId: incompleteTrace,
    teamId: incompleteJob.teamId,
    workerNodeId: "previous-worker",
    bookingId: incompleteJob.bookingId,
    requestIds: [incompleteJob.requestId],
    ruleId: incompleteJob.ruleId,
    ruleName: "Policy recovery rule",
    acceptMode: "request_ids",
    acceptStartedAt: new Date("2030-01-01T00:02:30.000Z"),
  });
  let incompletePolicyChecks = 0;
  let incompletePosts = 0;
  const incompleteSummary = await runOne({
    now: "2030-01-01T00:03:00.000Z",
    onPolicyCheck: () => {
      incompletePolicyChecks += 1;
    },
    apiClient: {
      async acceptBookingRequests() {
        incompletePosts += 1;
        throw new Error("existing marker must not POST");
      },
      async fetchBookingRequestList() {
        return acceptedList(incompleteJob.requestId);
      },
    },
  });
  assert.equal(incompleteSummary.retried, 1);
  assert.equal(incompletePolicyChecks, 0);
  assert.equal(incompletePosts, 0);
  assert.equal((await getAutoAcceptResult(2, incompleteJob.bookingId, incompleteJob.requestId))?.status, "owned");

  await resetDb();

  const completedJob = await enqueueAutoAcceptJob(requestJob({
    bookingId: 2792113,
    requestId: 40291113,
  }));
  const completedTrace = `aa-job:${completedJob.id}:external:1`;
  await beginAutoAcceptAttempt({
    traceId: completedTrace,
    teamId: completedJob.teamId,
    workerNodeId: "previous-worker",
    bookingId: completedJob.bookingId,
    requestIds: [completedJob.requestId],
    ruleId: completedJob.ruleId,
    ruleName: "Policy recovery rule",
    acceptMode: "request_ids",
    acceptStartedAt: new Date("2030-01-01T00:03:30.000Z"),
  });
  await completeAutoAcceptAttempt({
    traceId: completedTrace,
    teamId: completedJob.teamId,
    bookingId: completedJob.bookingId,
    requestIds: [completedJob.requestId],
    ruleId: completedJob.ruleId,
    ruleName: "Policy recovery rule",
    acceptMode: "request_ids",
    acceptFinishedAt: new Date("2030-01-01T00:03:31.000Z"),
    acceptRttMs: 1000,
    spxHttpStatus: 200,
    spxRetcode: 0,
  });
  let completedPolicyChecks = 0;
  let completedPosts = 0;
  const completedSummary = await runOne({
    now: "2030-01-01T00:04:00.000Z",
    onPolicyCheck: () => {
      completedPolicyChecks += 1;
    },
    apiClient: {
      async acceptBookingRequests() {
        completedPosts += 1;
        throw new Error("completed marker must not POST");
      },
      async fetchBookingRequestList() {
        return acceptedList(completedJob.requestId);
      },
    },
  });
  assert.equal(completedSummary.retried, 1);
  assert.equal(completedPolicyChecks, 0);
  assert.equal(completedPosts, 0);
  assert.equal((await getAutoAcceptResult(2, completedJob.bookingId, completedJob.requestId))?.status, "owned");

  await resetDb();

  const canonicalJob = await enqueueAutoAcceptJob(requestJob({
    bookingId: 2792114,
    requestId: 40291114,
  }));
  await upsertAutoAcceptResult({
    teamId: canonicalJob.teamId,
    bookingId: canonicalJob.bookingId,
    requestId: canonicalJob.requestId,
    winningAttemptTraceId: "existing-canonical-trace",
    status: "owned",
    reasonCode: "verified_owned",
  });
  let canonicalPolicyChecks = 0;
  let canonicalApiCalls = 0;
  const canonicalSummary = await runOne({
    now: "2030-01-01T00:05:00.000Z",
    onPolicyCheck: () => {
      canonicalPolicyChecks += 1;
    },
    apiClient: {
      async acceptBookingRequests() {
        canonicalApiCalls += 1;
        throw new Error("canonical recovery must not POST");
      },
      async fetchBookingRequestList() {
        canonicalApiCalls += 1;
        throw new Error("canonical recovery must not read SPX");
      },
    },
  });
  assert.equal(canonicalSummary.retried, 1);
  assert.equal(canonicalPolicyChecks, 0);
  assert.equal(canonicalApiCalls, 0);
  assert.equal((await getAutoAcceptJobById(canonicalJob.id))?.resultStatus, "owned");

  await resetDb();

  const reconcileJob = await enqueueAutoAcceptJob(requestJob({
    bookingId: 2792115,
    requestId: 40291115,
    attemptKind: "own_status_reconcile",
  }));
  let reconcilePolicyChecks = 0;
  let reconcileApiCalls = 0;
  const reconcileSummary = await runOne({
    now: "2030-01-01T00:06:00.000Z",
    onPolicyCheck: () => {
      reconcilePolicyChecks += 1;
    },
    apiClient: {
      async acceptBookingRequests() {
        reconcileApiCalls += 1;
        throw new Error("own-status recovery must not POST");
      },
      async fetchBookingRequestList() {
        reconcileApiCalls += 1;
        throw new Error("own-status recovery must use observed evidence");
      },
    },
  });
  assert.equal(reconcileSummary.retried, 1);
  assert.equal(reconcilePolicyChecks, 0);
  assert.equal(reconcileApiCalls, 0);
  assert.equal((await getAutoAcceptJobById(reconcileJob.id))?.resultStatus, "owned");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
