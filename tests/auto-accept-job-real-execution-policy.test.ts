import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
} from "../src/repositories/auto-accept-job-repository.js";
import { hasAutoAcceptRuleBudgetReservation } from "../src/repositories/auto-accept-job-settlement-repository.js";
import { getAutoAcceptAttemptByTraceId } from "../src/repositories/auto-accept-result-repository.js";
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
  attemptKind?: "pending_request" | "non_pending_probe";
}) {
  const attemptKind = input.attemptKind ?? "non_pending_probe";
  const identity = {
    teamId: 2,
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: "policy-rule",
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
      ruleName: "Policy rule",
      acceptAll: false,
      source: attemptKind === "pending_request" ? "pending_tab" : "non_pending_tab",
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

async function main(): Promise<void> {
  await resetDb();

  const job = await enqueueAutoAcceptJob(requestJob({
    bookingId: 2792100,
    requestId: 40291000,
    attemptKind: "pending_request",
  }));
  let policyChecks = 0;
  let postCalls = 0;
  let readCalls = 0;
  const apiClient: AutoAcceptJobRealExecutionApi = {
    async acceptBookingRequests() {
      postCalls += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList() {
      readCalls += 1;
      return { data: { request_list: [] } };
    },
  };

  const summary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "policy-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "policy-blocked",
    apiClient,
    loadRuleState: activeRuleState,
    retryDelayMsOnRuleStateError: 1,
    retryDelayMsOnSettlementPending: 1,
    canStartNewExternalAttempt: async () => {
      policyChecks += 1;
      return false;
    },
  });

  assert.equal(summary.claimed, 1);
  assert.equal(summary.retried, 1);
  assert.equal(policyChecks, 1);
  assert.equal(postCalls, 0);
  assert.equal(readCalls, 0);
  assert.equal(await getAutoAcceptAttemptByTraceId(`aa-job:${job.id}:external:1`), null);
  assert.equal(await hasAutoAcceptRuleBudgetReservation(job.id), false);
  const after = await getAutoAcceptJobById(job.id);
  assert.equal(after?.attemptCount, 0);
  assert.equal(after?.verifyCount, 1);
  assert.equal(after?.lastReasonCode, "real_execution_policy_blocked");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
