import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
  getAutoAcceptJobByIdempotencyKey,
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

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function fastJob(overrides: {
  bookingId?: number;
  ruleId?: string;
  payload?: Record<string, unknown>;
} = {}) {
  const identity = {
    teamId: 2,
    bookingId: overrides.bookingId ?? 2792000,
    requestId: 0,
    ruleId: overrides.ruleId ?? "rule-fast-marker",
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
      bookingId: identity.bookingId,
      requestId: 0,
      ruleId: identity.ruleId,
      ruleName: "Fast marker rule",
      acceptAll: true,
      source: "booking_name",
      trip: {
        booking_id: identity.bookingId,
        origin: "Bangkok",
        destination: "Rayong",
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
      ...overrides.payload,
    },
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

const activeFastRule = () => ({
  need: 2,
  accept_all: true,
  enabled: true,
  fulfilled: false,
});

function parentTrace(jobId: number): string {
  return `aa-job:${jobId}:external:1`;
}

function observedItem(requestId: number, bookingId: number, acceptanceStatus = 2) {
  return {
    request_id: requestId,
    booking_id: bookingId,
    request_acceptance_status: acceptanceStatus,
    origin: "Bangkok",
    destination: "Rayong",
    vehicle_type: "4W",
  };
}

function childKey(input: { bookingId: number; requestId: number; ruleId: string }) {
  return buildAutoAcceptJobIdempotencyKey({
    teamId: 2,
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: input.ruleId,
    attemptKind: "own_status_reconcile",
  });
}

async function runFast(input: {
  apiClient: AutoAcceptJobRealExecutionApi;
  now: string;
  loadRuleState?: typeof activeFastRule;
  enqueueFastAcceptAllChildJob?: typeof enqueueAutoAcceptJob;
  afterFastAcceptAllCanonicalResult?: (input: { traceId: string; requestId: number }) => Promise<void>;
}) {
  return await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "fast-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date(input.now),
    claimTokenFactory: () => `fast-claim-${input.now}`,
    apiClient: input.apiClient,
    loadRuleState: input.loadRuleState ?? activeFastRule,
    retryDelayMsOnRuleStateError: 1,
    retryDelayMsOnSettlementPending: 1,
    retryDelayMsOnCheckpointError: 1,
    ...(input.enqueueFastAcceptAllChildJob
      ? { enqueueFastAcceptAllChildJob: input.enqueueFastAcceptAllChildJob }
      : {}),
    ...(input.afterFastAcceptAllCanonicalResult
      ? { afterFastAcceptAllCanonicalResult: input.afterFastAcceptAllCanonicalResult }
      : {}),
  });
}

async function beginParentMarker(job: Awaited<ReturnType<typeof enqueueAutoAcceptJob>>) {
  return await beginAutoAcceptAttempt({
    traceId: parentTrace(job.id),
    teamId: job.teamId,
    workerNodeId: "previous-fast-worker",
    bookingId: job.bookingId,
    acceptMode: "accept_all",
    requestIds: [job.bookingId],
    ruleId: job.ruleId,
    ruleName: "Fast marker rule",
    acceptStartedAt: new Date("2030-01-01T00:00:30.000Z"),
  });
}

async function main() {
  await resetDb();

  const unreadableJob = await enqueueAutoAcceptJob(fastJob());
  const unreadableRequestId = 40290000;
  let unreadableMode: "pending_rejects" | "both_malformed" | "readable" = "pending_rejects";
  let unreadablePosts = 0;
  const unreadableCalls: string[] = [];
  const unreadableApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      throw new Error("fast parent must not call request-id accept");
    },
    async acceptAllBookingRequests() {
      const marker = await getAutoAcceptAttemptByTraceId(parentTrace(unreadableJob.id));
      assert.ok(marker, "fast parent marker must be durable before POST");
      assert.equal(marker.acceptFinishedAt, null);
      unreadablePosts += 1;
      unreadableCalls.push("post");
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList(_bookingId, options) {
      const tab = options?.tabPendingConfirmation === false ? "confirmed" : "pending";
      unreadableCalls.push(`${unreadableMode}:${tab}`);
      if (unreadableMode === "pending_rejects" && tab === "pending") {
        throw new Error("pending-tab-secret-value");
      }
      if (unreadableMode === "both_malformed") {
        return { data: { request_list: null } } as never;
      }
      return {
        data: {
          request_list: tab === "confirmed"
            ? [observedItem(unreadableRequestId, unreadableJob.bookingId)]
            : [],
        },
      };
    },
  };

  const unreadableFirst = await runFast({
    apiClient: unreadableApi,
    now: "2030-01-01T00:01:00.000Z",
  });
  assert.equal(unreadableFirst.retried, 1);
  assert.equal(unreadableFirst.executorErrors, 0);
  assert.equal(unreadablePosts, 1);
  assert.ok((await getAutoAcceptAttemptByTraceId(parentTrace(unreadableJob.id)))?.acceptFinishedAt);
  assert.equal(await getAutoAcceptResult(2, unreadableJob.bookingId, unreadableRequestId), null);
  assert.equal(await getAutoAcceptJobByIdempotencyKey(childKey({
    bookingId: unreadableJob.bookingId,
    requestId: unreadableRequestId,
    ruleId: unreadableJob.ruleId,
  })), null);
  const unreadableAfterFirst = await getAutoAcceptJobById(unreadableJob.id);
  assert.equal(unreadableAfterFirst?.resultStatus, null);
  assert.equal(unreadableAfterFirst?.attemptCount, 0);
  assert.equal(unreadableAfterFirst?.verifyCount, 1);
  assert.doesNotMatch(unreadableAfterFirst?.lastError ?? "", /pending-tab-secret-value/);

  unreadableMode = "both_malformed";
  const unreadableSecond = await runFast({
    apiClient: unreadableApi,
    now: "2030-01-01T00:01:01.000Z",
    loadRuleState: (() => {
      throw new Error("completed marker recovery must bypass mutable rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(unreadableSecond.retried, 1);
  assert.equal(unreadablePosts, 1);
  assert.equal(await getAutoAcceptResult(2, unreadableJob.bookingId, unreadableRequestId), null);

  unreadableMode = "readable";
  const unreadableRecovered = await runFast({
    apiClient: unreadableApi,
    now: "2030-01-01T00:01:02.000Z",
    loadRuleState: (() => {
      throw new Error("completed marker recovery must bypass changed rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(unreadableRecovered.succeeded, 1);
  assert.equal(unreadablePosts, 1);
  assert.equal((await getAutoAcceptResult(2, unreadableJob.bookingId, unreadableRequestId))?.winningAttemptTraceId, parentTrace(unreadableJob.id));
  const unreadableChild = await getAutoAcceptJobByIdempotencyKey(childKey({
    bookingId: unreadableJob.bookingId,
    requestId: unreadableRequestId,
    ruleId: unreadableJob.ruleId,
  }));
  assert.ok(unreadableChild);
  assert.equal(JSON.parse(unreadableChild.payloadJson).traceParent, parentTrace(unreadableJob.id));

  await resetDb();

  const nullTabJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792001 }));
  const nullTabRequestId = 40290001;
  let nullTabPosts = 0;
  const nullTabSummary = await runFast({
    apiClient: {
      async acceptBookingRequests() {
        throw new Error("fast parent must not call request-id accept");
      },
      async acceptAllBookingRequests() {
        nullTabPosts += 1;
        return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
      },
      async fetchBookingRequestList(_bookingId, options) {
        if (options?.tabPendingConfirmation === false) return null;
        return { data: { request_list: [observedItem(nullTabRequestId, nullTabJob.bookingId)] } };
      },
    },
    now: "2030-01-01T00:02:00.000Z",
  });
  assert.equal(nullTabSummary.retried, 1);
  assert.equal(nullTabPosts, 1);
  assert.equal(await getAutoAcceptResult(2, nullTabJob.bookingId, nullTabRequestId), null);
  assert.equal((await getAutoAcceptJobById(nullTabJob.id))?.resultStatus, null);

  await resetDb();

  const malformedItemJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792007 }));
  const malformedValidRequestId = 40290008;
  const malformedRequestId = 40290009;
  let malformedItemMode: "missing_status" | "wrong_booking" = "missing_status";
  let malformedItemPosts = 0;
  const malformedItemApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      throw new Error("fast parent must not call request-id accept");
    },
    async acceptAllBookingRequests() {
      malformedItemPosts += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList(_bookingId, options) {
      if (options?.tabPendingConfirmation !== false) {
        return { data: { request_list: [] } };
      }
      return {
        data: {
          request_list: [
            observedItem(malformedValidRequestId, malformedItemJob.bookingId),
            malformedItemMode === "missing_status"
              ? {
                  request_id: malformedRequestId,
                  booking_id: malformedItemJob.bookingId,
                }
              : observedItem(malformedRequestId, malformedItemJob.bookingId + 1),
          ],
        },
      } as never;
    },
  };

  const missingStatusSummary = await runFast({
    apiClient: malformedItemApi,
    now: "2030-01-01T00:02:10.000Z",
  });
  assert.equal(missingStatusSummary.retried, 1);
  assert.equal(malformedItemPosts, 1);
  assert.equal(await getAutoAcceptResult(2, malformedItemJob.bookingId, malformedValidRequestId), null);
  assert.equal(await getAutoAcceptResult(2, malformedItemJob.bookingId, malformedRequestId), null);
  assert.equal((await getAutoAcceptJobById(malformedItemJob.id))?.resultStatus, null);

  malformedItemMode = "wrong_booking";
  const wrongBookingSummary = await runFast({
    apiClient: malformedItemApi,
    now: "2030-01-01T00:02:11.000Z",
    loadRuleState: (() => {
      throw new Error("existing marker recovery must bypass mutable rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(wrongBookingSummary.retried, 1);
  assert.equal(malformedItemPosts, 1);
  assert.equal(await getAutoAcceptResult(2, malformedItemJob.bookingId, malformedValidRequestId), null);
  assert.equal(await getAutoAcceptResult(2, malformedItemJob.bookingId, malformedRequestId), null);
  assert.equal((await getAutoAcceptJobById(malformedItemJob.id))?.resultStatus, null);

  await resetDb();

  const incompleteJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792002 }));
  await beginParentMarker(incompleteJob);
  let incompletePosts = 0;
  let incompleteRuleLoads = 0;
  const incompleteSummary = await runFast({
    apiClient: {
      async acceptBookingRequests() {
        throw new Error("fast parent must not call request-id accept");
      },
      async acceptAllBookingRequests() {
        incompletePosts += 1;
        throw new Error("existing incomplete marker must not POST");
      },
      async fetchBookingRequestList(_bookingId, options) {
        return {
          data: {
            request_list: options?.tabPendingConfirmation === false
              ? [observedItem(40290002, incompleteJob.bookingId)]
              : [],
          },
        };
      },
    },
    now: "2030-01-01T00:03:00.000Z",
    loadRuleState: (() => {
      incompleteRuleLoads += 1;
      return { need: 0, accept_all: false, enabled: false, fulfilled: true };
    }) as typeof activeFastRule,
  });
  assert.equal(incompleteSummary.succeeded, 1);
  assert.equal(incompletePosts, 0);
  assert.equal(incompleteRuleLoads, 0);
  assert.equal((await getAutoAcceptResult(2, incompleteJob.bookingId, 40290002))?.winningAttemptTraceId, parentTrace(incompleteJob.id));

  await resetDb();

  const thrownPostJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792008 }));
  const thrownPostRequestIds = [40290010, 40290013];
  let thrownPostMode: "post_throws" | "non_owned" | "owned" = "post_throws";
  let thrownPostCalls = 0;
  const thrownPostApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      throw new Error("fast parent must not call request-id accept");
    },
    async acceptAllBookingRequests() {
      thrownPostCalls += 1;
      throw new Error("post outcome unavailable");
    },
    async fetchBookingRequestList(_bookingId, options) {
      return {
        data: {
          request_list: options?.tabPendingConfirmation === false && thrownPostMode !== "post_throws"
            ? thrownPostRequestIds.map((requestId, index) => observedItem(
                requestId,
                thrownPostJob.bookingId,
                thrownPostMode === "owned" || index === 0 ? 2 : 4,
              ))
            : [],
        },
      };
    },
  };

  const thrownPostFirst = await runFast({
    apiClient: thrownPostApi,
    now: "2030-01-01T00:03:10.000Z",
  });
  assert.equal(thrownPostFirst.retried, 1);
  assert.equal(thrownPostCalls, 1);
  assert.equal((await getAutoAcceptAttemptByTraceId(parentTrace(thrownPostJob.id)))?.acceptFinishedAt, null);

  thrownPostMode = "non_owned";
  const thrownPostIndeterminate = await runFast({
    apiClient: thrownPostApi,
    now: "2030-01-01T00:03:11.000Z",
    loadRuleState: (() => {
      throw new Error("incomplete marker recovery must bypass mutable rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(thrownPostIndeterminate.retried, 1);
  assert.equal(thrownPostCalls, 1);
  assert.equal(
    (await getAutoAcceptResult(2, thrownPostJob.bookingId, thrownPostRequestIds[0]))?.winningAttemptTraceId,
    parentTrace(thrownPostJob.id),
  );
  assert.equal(await getAutoAcceptResult(2, thrownPostJob.bookingId, thrownPostRequestIds[1]), null);
  assert.equal((await getAutoAcceptJobById(thrownPostJob.id))?.resultStatus, null);

  thrownPostMode = "owned";
  const thrownPostRecovered = await runFast({
    apiClient: thrownPostApi,
    now: "2030-01-01T00:03:12.000Z",
    loadRuleState: (() => {
      throw new Error("incomplete marker recovery must bypass changed rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(thrownPostRecovered.succeeded, 1);
  assert.equal(thrownPostCalls, 1);
  for (const requestId of thrownPostRequestIds) {
    assert.equal(
      (await getAutoAcceptResult(2, thrownPostJob.bookingId, requestId))?.winningAttemptTraceId,
      parentTrace(thrownPostJob.id),
    );
  }

  await resetDb();

  const ambiguousJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792009 }));
  const ambiguousRequestId = 40290011;
  await beginParentMarker(ambiguousJob);
  await completeAutoAcceptAttempt({
    traceId: parentTrace(ambiguousJob.id),
    teamId: ambiguousJob.teamId,
    bookingId: ambiguousJob.bookingId,
    acceptMode: "accept_all",
    requestIds: [],
    ruleId: ambiguousJob.ruleId,
    ruleName: "Fast marker rule",
    acceptFinishedAt: new Date("2030-01-01T00:03:20.000Z"),
    acceptRttMs: 20_000,
    spxHttpStatus: 0,
    rawError: "transport outcome unavailable",
    ambiguousAccept: true,
  });
  let ambiguousOwned = false;
  let ambiguousPosts = 0;
  const ambiguousApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      throw new Error("fast parent must not call request-id accept");
    },
    async acceptAllBookingRequests() {
      ambiguousPosts += 1;
      throw new Error("existing ambiguous marker must not POST");
    },
    async fetchBookingRequestList(_bookingId, options) {
      return {
        data: {
          request_list: options?.tabPendingConfirmation === false && ambiguousOwned
            ? [observedItem(ambiguousRequestId, ambiguousJob.bookingId)]
            : [],
        },
      };
    },
  };
  const ambiguousIndeterminate = await runFast({
    apiClient: ambiguousApi,
    now: "2030-01-01T00:03:21.000Z",
    loadRuleState: (() => {
      throw new Error("ambiguous marker recovery must bypass mutable rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(ambiguousIndeterminate.retried, 1);
  assert.equal(ambiguousPosts, 0);
  assert.equal((await getAutoAcceptJobById(ambiguousJob.id))?.resultStatus, null);

  ambiguousOwned = true;
  const ambiguousRecovered = await runFast({
    apiClient: ambiguousApi,
    now: "2030-01-01T00:03:22.000Z",
    loadRuleState: (() => {
      throw new Error("ambiguous marker recovery must bypass changed rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(ambiguousRecovered.succeeded, 1);
  assert.equal(ambiguousPosts, 0);
  assert.equal(
    (await getAutoAcceptResult(2, ambiguousJob.bookingId, ambiguousRequestId))?.winningAttemptTraceId,
    parentTrace(ambiguousJob.id),
  );

  await resetDb();

  const crashJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792003 }));
  const crashRequestIds = [40290003, 40290004];
  let crashPosts = 0;
  let crashRecovery = false;
  const crashApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      throw new Error("fast parent must not call request-id accept");
    },
    async acceptAllBookingRequests() {
      crashPosts += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList(_bookingId, options) {
      return {
        data: {
          request_list: options?.tabPendingConfirmation === false
            ? crashRecovery
              ? [observedItem(crashRequestIds[1], crashJob.bookingId)]
              : [
                  observedItem(crashRequestIds[1], crashJob.bookingId),
                  observedItem(crashRequestIds[0], crashJob.bookingId),
                  observedItem(crashRequestIds[0], crashJob.bookingId),
                ]
            : [],
        },
      };
    },
  };
  let canonicalCommits = 0;
  const crashFirst = await runFast({
    apiClient: crashApi,
    now: "2030-01-01T00:04:00.000Z",
    afterFastAcceptAllCanonicalResult: async ({ traceId, requestId }) => {
      canonicalCommits += 1;
      assert.equal(traceId, parentTrace(crashJob.id));
      assert.equal(requestId, crashRequestIds[0]);
      throw new Error("crash-after-canonical-before-child-secret");
    },
  });
  assert.equal(crashFirst.retried, 1);
  assert.equal(crashFirst.executorErrors, 0);
  assert.equal(crashPosts, 1);
  assert.equal((await getAutoAcceptJobById(crashJob.id))?.resultStatus, null);
  assert.equal((await getAutoAcceptJobById(crashJob.id))?.attemptCount, 0);
  assert.equal((await getAutoAcceptJobById(crashJob.id))?.verifyCount, 1);
  assert.equal((await getAutoAcceptJobById(crashJob.id))?.lastError, "fast accept-all child replay failed");
  assert.equal(canonicalCommits, 1);
  assert.equal((await getAutoAcceptResult(2, crashJob.bookingId, crashRequestIds[0]))?.status, "owned");
  assert.equal(await getAutoAcceptJobByIdempotencyKey(childKey({
    bookingId: crashJob.bookingId,
    requestId: crashRequestIds[0],
    ruleId: crashJob.ruleId,
  })), null, "crash must happen before the first child job is persisted");
  assert.equal(await getAutoAcceptResult(2, crashJob.bookingId, crashRequestIds[1]), null);

  crashRecovery = true;
  const recoveredEnqueueOrder: number[] = [];
  const crashRecovered = await runFast({
    apiClient: crashApi,
    now: "2030-01-01T00:04:01.000Z",
    loadRuleState: (() => {
      throw new Error("completed marker child replay must bypass mutable rule state");
    }) as typeof activeFastRule,
    enqueueFastAcceptAllChildJob: async (input) => {
      recoveredEnqueueOrder.push(input.requestId);
      return await enqueueAutoAcceptJob(input);
    },
  });
  assert.equal(crashRecovered.succeeded, 1);
  assert.equal(crashPosts, 1);
  assert.deepEqual(recoveredEnqueueOrder, crashRequestIds, "recovery must replay the durable omitted child in sorted order");
  for (const requestId of crashRequestIds) {
    const canonical = await getAutoAcceptResult(2, crashJob.bookingId, requestId);
    assert.equal(canonical?.status, "owned");
    assert.equal(canonical?.winningAttemptTraceId, parentTrace(crashJob.id));
    const child = await getAutoAcceptJobByIdempotencyKey(childKey({
      bookingId: crashJob.bookingId,
      requestId,
      ruleId: crashJob.ruleId,
    }));
    assert.ok(child);
    assert.equal(JSON.parse(child.payloadJson).traceParent, parentTrace(crashJob.id));
  }
  assert.equal((await getAutoAcceptJobById(crashJob.id))?.resultStatus, "owned");

  await resetDb();

  const firstChildCrashJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792006 }));
  const firstChildCrashRequestIds = [40290006, 40290007];
  let firstChildCrashPosts = 0;
  const firstChildCrashApi: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      throw new Error("fast parent must not call request-id accept");
    },
    async acceptAllBookingRequests() {
      firstChildCrashPosts += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList(_bookingId, options) {
      return {
        data: {
          request_list: options?.tabPendingConfirmation === false
            ? firstChildCrashRequestIds.map((requestId) => observedItem(requestId, firstChildCrashJob.bookingId))
            : [],
        },
      };
    },
  };
  let firstPersistedChildId: number | null = null;
  let firstChildEnqueueCalls = 0;
  const firstChildCrash = await runFast({
    apiClient: firstChildCrashApi,
    now: "2030-01-01T00:05:00.000Z",
    enqueueFastAcceptAllChildJob: async (input) => {
      const child = await enqueueAutoAcceptJob(input);
      firstChildEnqueueCalls += 1;
      if (firstChildEnqueueCalls === 1) {
        firstPersistedChildId = child.id;
        throw new Error("crash-after-first-child-secret");
      }
      return child;
    },
  });
  assert.equal(firstChildCrash.retried, 1);
  assert.equal(firstChildCrashPosts, 1);
  assert.ok(firstPersistedChildId);
  assert.equal((await getAutoAcceptJobById(firstChildCrashJob.id))?.resultStatus, null);

  const firstChildReplayIds = new Map<number, number>();
  const firstChildRecovered = await runFast({
    apiClient: firstChildCrashApi,
    now: "2030-01-01T00:05:01.000Z",
    loadRuleState: (() => {
      throw new Error("completed marker child replay must bypass mutable rule state");
    }) as typeof activeFastRule,
    enqueueFastAcceptAllChildJob: async (input) => {
      const child = await enqueueAutoAcceptJob(input);
      firstChildReplayIds.set(input.requestId, child.id);
      return child;
    },
  });
  assert.equal(firstChildRecovered.succeeded, 1);
  assert.equal(firstChildCrashPosts, 1);
  assert.deepEqual([...firstChildReplayIds.keys()], firstChildCrashRequestIds);
  assert.equal(firstChildReplayIds.get(firstChildCrashRequestIds[0]), firstPersistedChildId, "replay must reuse the first durable child job");

  await resetDb();

  const structuralJob = await enqueueAutoAcceptJob(fastJob({
    bookingId: 2792004,
    payload: { nested: { spxCookie: "forbidden" } },
  }));
  await beginParentMarker(structuralJob);
  let structuralCalls = 0;
  const structuralSummary = await runFast({
    apiClient: {
      async acceptBookingRequests() {
        structuralCalls += 1;
        throw new Error("invalid structure must not call API");
      },
      async acceptAllBookingRequests() {
        structuralCalls += 1;
        throw new Error("invalid structure must not call API");
      },
      async fetchBookingRequestList() {
        structuralCalls += 1;
        return { data: { request_list: [] } };
      },
    },
    now: "2030-01-01T00:06:00.000Z",
    loadRuleState: (() => {
      structuralCalls += 1;
      return activeFastRule();
    }) as typeof activeFastRule,
  });
  assert.equal(structuralSummary.deadLettered, 1);
  assert.equal(structuralCalls, 0);
  assert.equal((await getAutoAcceptJobById(structuralJob.id))?.lastReasonCode, "dry_run_forbidden_payload_key");

  await resetDb();

  const malformedEvidenceJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792005 }));
  const malformedEvidenceRequestId = 40290005;
  await beginParentMarker(malformedEvidenceJob);
  await upsertAutoAcceptResult({
    teamId: malformedEvidenceJob.teamId,
    bookingId: malformedEvidenceJob.bookingId,
    requestId: malformedEvidenceRequestId,
    winningAttemptTraceId: parentTrace(malformedEvidenceJob.id),
    status: "owned",
    reasonCode: "verified_owned",
    evidence: {
      source: "fast_accept_all_reconcile",
      acceptAll: true,
      observedStatus: 4,
      foundAcceptedCount: 1,
      observedCount: 1,
      trip: {
        request_id: malformedEvidenceRequestId,
        booking_id: malformedEvidenceJob.bookingId,
        acceptance_status: 4,
      },
    },
  });
  const malformedEvidenceSummary = await runFast({
    apiClient: {
      async acceptBookingRequests() {
        throw new Error("fast parent must not call request-id accept");
      },
      async acceptAllBookingRequests() {
        throw new Error("existing marker must not POST");
      },
      async fetchBookingRequestList() {
        return { data: { request_list: [] } };
      },
    },
    now: "2030-01-01T00:07:00.000Z",
    loadRuleState: (() => {
      throw new Error("existing marker must bypass mutable rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(malformedEvidenceSummary.retried, 1);
  assert.equal((await getAutoAcceptJobById(malformedEvidenceJob.id))?.lastReasonCode, "fast_accept_all_durable_child_unreadable");
  const malformedEvidenceCanonical = await getAutoAcceptResult(
    malformedEvidenceJob.teamId,
    malformedEvidenceJob.bookingId,
    malformedEvidenceRequestId,
  );
  assert.equal(malformedEvidenceCanonical?.status, "owned", "malformed evidence must not downgrade durable ownership");
  assert.equal(malformedEvidenceCanonical?.winningAttemptTraceId, parentTrace(malformedEvidenceJob.id));
  assert.equal(await getAutoAcceptJobByIdempotencyKey(childKey({
    bookingId: malformedEvidenceJob.bookingId,
    requestId: malformedEvidenceRequestId,
    ruleId: malformedEvidenceJob.ruleId,
  })), null);

  await resetDb();

  const sanitizedEvidenceJob = await enqueueAutoAcceptJob(fastJob({ bookingId: 2792010 }));
  const sanitizedEvidenceRequestId = 40290012;
  await beginParentMarker(sanitizedEvidenceJob);
  await completeAutoAcceptAttempt({
    traceId: parentTrace(sanitizedEvidenceJob.id),
    teamId: sanitizedEvidenceJob.teamId,
    bookingId: sanitizedEvidenceJob.bookingId,
    acceptMode: "accept_all",
    requestIds: [],
    ruleId: sanitizedEvidenceJob.ruleId,
    ruleName: "Fast marker rule",
    acceptFinishedAt: new Date("2030-01-01T00:08:00.000Z"),
    acceptRttMs: 1000,
    spxHttpStatus: 200,
    spxRetcode: 0,
    ambiguousAccept: false,
  });
  await upsertAutoAcceptResult({
    teamId: sanitizedEvidenceJob.teamId,
    bookingId: sanitizedEvidenceJob.bookingId,
    requestId: sanitizedEvidenceRequestId,
    winningAttemptTraceId: parentTrace(sanitizedEvidenceJob.id),
    status: "owned",
    reasonCode: "verified_owned",
    evidence: {
      source: "fast_accept_all_reconcile",
      acceptAll: true,
      observedStatus: 2,
      foundAcceptedCount: 1,
      observedCount: 1,
      trip: {
        request_id: sanitizedEvidenceRequestId,
        booking_id: sanitizedEvidenceJob.bookingId,
        acceptance_status: 2,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
        spxCookie: "must-not-enter-child-payload",
        untrusted: { nested: true },
      },
    },
  });
  const sanitizedEvidenceSummary = await runFast({
    apiClient: {
      async acceptBookingRequests() {
        throw new Error("fast parent must not call request-id accept");
      },
      async acceptAllBookingRequests() {
        throw new Error("existing marker must not POST");
      },
      async fetchBookingRequestList() {
        return { data: { request_list: [] } };
      },
    },
    now: "2030-01-01T00:08:01.000Z",
    loadRuleState: (() => {
      throw new Error("existing marker must bypass mutable rule state");
    }) as typeof activeFastRule,
  });
  assert.equal(sanitizedEvidenceSummary.succeeded, 1);
  const sanitizedEvidenceChild = await getAutoAcceptJobByIdempotencyKey(childKey({
    bookingId: sanitizedEvidenceJob.bookingId,
    requestId: sanitizedEvidenceRequestId,
    ruleId: sanitizedEvidenceJob.ruleId,
  }));
  assert.ok(sanitizedEvidenceChild);
  const sanitizedEvidenceTrip = JSON.parse(sanitizedEvidenceChild.payloadJson).trip as Record<string, unknown>;
  assert.equal(sanitizedEvidenceTrip.origin, "Bangkok");
  assert.equal(sanitizedEvidenceTrip.acceptance_status, 2);
  assert.equal("spxCookie" in sanitizedEvidenceTrip, false);
  assert.equal("untrusted" in sanitizedEvidenceTrip, false);

  await resetDb();
  const admissionParentInput = fastJob({ bookingId: 2792099 });
  const admissionParent = await enqueueAutoAcceptJob(admissionParentInput);
  const admissionRequestId = 40290999;
  const oldChildIdentity = { teamId: 2, bookingId: admissionParent.bookingId, requestId: admissionRequestId,
    ruleId: admissionParent.ruleId, attemptKind: "own_status_reconcile" as const };
  const oldChild = await enqueueAutoAcceptJob({ ...oldChildIdentity,
    observedAt: new Date("2030-01-01T00:00:00.000Z"), nextRunAt: new Date("2030-01-02T00:00:00.000Z"),
    payload: { ...admissionParentInput.payload, executionMode: undefined, ...oldChildIdentity,
      idempotencyKey: buildAutoAcceptJobIdempotencyKey(oldChildIdentity), source: "reconciliation", acceptAll: false } });
  let admissionParentPosts = 0;
  const admissionApi: AutoAcceptJobRealExecutionApi = {
    acceptBookingRequests: async () => { throw new Error("parent requires whole booking API"); },
    acceptAllBookingRequests: async () => { admissionParentPosts++; return { ok: true, httpStatus: 200, response: { retcode: 0 } }; },
    fetchBookingRequestList: async (_id, options) => ({ data: { request_list: options?.tabPendingConfirmation === false
      ? [observedItem(admissionRequestId, admissionParent.bookingId)] : [] } }),
  };
  const admissionConflict = await runFast({ apiClient: admissionApi, now: "2030-01-01T00:10:00.000Z" });
  assert.equal(admissionConflict.retried, 1, "parent must not report successful child publication when an old unadmitted child occupies its canonical key");
  assert.equal(admissionConflict.succeeded, 0);
  assert.equal((await getAutoAcceptJobById(oldChild.id))?.payloadJson, oldChild.payloadJson);
  await runFast({ apiClient: admissionApi, now: "2030-01-01T00:10:01.000Z" });
  assert.equal(admissionParentPosts, 1, "child admission conflict recovery must retain the parent marker and never replay its POST");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
