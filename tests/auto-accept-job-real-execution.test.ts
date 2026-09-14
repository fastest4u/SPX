import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { autoAcceptAttempts, autoAcceptHistory, autoAcceptJobSettlements } from "../src/db/schema.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
  getAutoAcceptJobByIdempotencyKey,
  type AutoAcceptAttemptKind,
} from "../src/repositories/auto-accept-job-repository.js";
import { enablePublication } from "../src/repositories/auto-accept-publication-control-repository.js";
import { writeAutoAcceptHistoryOnce } from "../src/repositories/auto-accept-job-settlement-repository.js";
import { getBookingHistory } from "../src/repositories/booking-history-repository.js";
import { getAutoAcceptResult, upsertAutoAcceptResult } from "../src/repositories/auto-accept-result-repository.js";
import {
  createAutoAcceptJobSettlementOperations,
  runAutoAcceptJobSettlementBatch,
  type AutoAcceptJobHistorySettlement,
  type AutoAcceptJobNotificationSettlement,
  type AutoAcceptJobProgressSettlement,
  type AutoAcceptJobSettlementOperations,
} from "../src/services/auto-accept-job-settlement.js";
import { runAutoAcceptJobRealExecutionBatch } from "../src/services/auto-accept-job-real-execution.js";
import { runAutoAcceptWorkerBatch } from "../src/services/auto-accept-worker.js";
import { createRule, readRules } from "../src/services/notify-rules.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function basePendingRequestJob(overrides: {
  bookingId?: number;
  requestId?: number;
  ruleId?: string;
  attemptKind?: AutoAcceptAttemptKind;
  cutoverEpoch?: string;
  payload?: Record<string, unknown>;
} = {}) {
  const identity = {
    teamId: 2,
    ...(overrides.cutoverEpoch ? { cutoverEpoch: overrides.cutoverEpoch } : {}),
    bookingId: overrides.bookingId ?? 2791810,
    requestId: overrides.requestId ?? 40288114,
    ruleId: overrides.ruleId ?? "rule-1",
    attemptKind: overrides.attemptKind ?? "pending_request" as const,
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
    ...(overrides.cutoverEpoch ? { cutoverEpoch: overrides.cutoverEpoch } : {}),
    ...overrides.payload,
  };

  return {
    ...identity,
    payload,
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

function baseFastAcceptAllJob(overrides: {
  bookingId?: number;
  ruleId?: string;
  cutoverEpoch?: string;
  payload?: Record<string, unknown>;
} = {}) {
  const identity = {
    teamId: 2,
    ...(overrides.cutoverEpoch ? { cutoverEpoch: overrides.cutoverEpoch } : {}),
    bookingId: overrides.bookingId ?? 2791830,
    requestId: 0,
    ruleId: overrides.ruleId ?? "rule-fast",
    attemptKind: "fast_accept_all" as const,
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
    ruleName: "Bangkok to Rayong fast",
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
    ...(overrides.cutoverEpoch ? { cutoverEpoch: overrides.cutoverEpoch } : {}),
    bookingName: "[ADHOC]Bangkok > Rayong 2030-01-01",
    ...overrides.payload,
  };

  return {
    ...identity,
    payload,
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

function fastAcceptedRequestListItem(input: {
  requestId: number;
  bookingId: number;
  origin: string;
  destination: string;
  vehicleTypeName: string;
}) {
  return {
    onsite_id: input.requestId + 1000,
    request_id: input.requestId,
    booking_id: input.bookingId,
    booking_date: 1893456000,
    report_station_id: 1,
    report_station_name: "Bangkok",
    cost_type: 1,
    shift_type: 1,
    trip_type: 2,
    trip_path: null,
    route_path: null,
    route_level: 1,
    vehicle_type: 1,
    vehicle_type_name: input.vehicleTypeName,
    vehicle_plate_number: "",
    driver_id: 0,
    driver_name: "",
    driver_contact_number: "",
    standby_time: 480,
    remark: "",
    request_acceptance_status: 2,
    request_assignment_status: 1,
    request_fulfilled_status: 0,
    request_assign_ddl: 0,
    assign_able: 1,
    display_countdown_assign: 0,
    child_request_edit: false,
    request_mtime: 1893456000,
    route_detail_list: [
      {
        route_level: 1,
        node_id: 1,
        station_type_list: [],
        station_type_name_list: null,
        node_info_list: [{ id: 1, name: input.origin, address_info: {} }],
      },
      {
        route_level: 2,
        node_id: 2,
        station_type_list: [],
        station_type_name_list: null,
        node_info_list: [{ id: 2, name: input.destination, address_info: {} }],
      },
    ],
    trip_limit: 1,
    partially_canceled: false,
    origin_driver_id: 0,
    origin_driver_name: "",
    right_vehicle_type: 1,
    right_vehicle_type_name: input.vehicleTypeName,
    replacement_vehicle_type: 0,
    replacement_vehicle_type_name: "",
    replacement_vehicle_plate_number: "",
  };
}

function createSettlementOperations() {
  const progress: AutoAcceptJobProgressSettlement[] = [];
  const history: AutoAcceptJobHistorySettlement[] = [];
  const notifications: AutoAcceptJobNotificationSettlement[] = [];
  const operations: AutoAcceptJobSettlementOperations = {
    settleProgress: (input) => {
      progress.push(input);
    },
    writeHistory: (input) => {
      history.push(input);
    },
    enqueueNotification: (input) => {
      notifications.push(input);
    },
  };
  return { operations, progress, history, notifications };
}

function ownedApi(apiCalls: string[]) {
  return {
    async acceptBookingRequests(bookingId: number, requestIds: number[]) {
      apiCalls.push(`accept:${bookingId}:${requestIds.join(",")}`);
      return {
        ok: true,
        httpStatus: 200,
        response: { retcode: 0, message: "ok" },
      };
    },
    async fetchBookingRequestList(_bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
      apiCalls.push(options?.tabPendingConfirmation === false ? "verify:confirmed" : "verify:pending");
      return {
        data: {
          request_list: [
            { request_id: 40288114, request_acceptance_status: 2 },
          ],
        },
      };
    },
  };
}

const activeRuleState = () => ({
  need: 1,
  accept_all: false,
  enabled: true,
  fulfilled: false,
});

async function createActiveRule(need = 1) {
  return await createRule(2, {
    name: "Bangkok to Rayong",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
}

async function main() {
  await resetDb();

  const happyRule = await createActiveRule();
  const job = await enqueueAutoAcceptJob(basePendingRequestJob({ ruleId: happyRule.id }));
  const apiCalls: string[] = [];
  const apiClient = ownedApi(apiCalls);

  const realSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "real-owned",
    apiClient,
    loadRuleState: activeRuleState,
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnSettlementPending: 1,
  });

  assert.equal(realSummary.claimed, 1);
  assert.equal(realSummary.retried, 1);
  assert.deepEqual(apiCalls, ["accept:2791810:40288114", "verify:pending", "verify:confirmed"]);

  const afterExecution = await getAutoAcceptJobById(job.id);
  assert.ok(afterExecution);
  assert.equal(afterExecution.status, "retrying");
  assert.equal(afterExecution.resultStatus, "owned");
  assert.equal(afterExecution.resultReasonCode, "verified_owned");
  assert.ok(afterExecution.winningAttemptTraceId);

  const db = await getDb();
  const attempts = await db
    .select()
    .from(autoAcceptAttempts)
    .where(eq(autoAcceptAttempts.traceId, afterExecution.winningAttemptTraceId));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.acceptMode, "request_ids");
  assert.equal(attempts[0]?.workerNodeId, "real-worker");

  const result = await getAutoAcceptResult(2, 2791810, 40288114);
  assert.ok(result);
  assert.equal(result.status, "owned");
  assert.equal(result.reasonCode, "verified_owned");
  assert.equal(result.winningAttemptTraceId, afterExecution.winningAttemptTraceId);

  const settlements = createSettlementOperations();
  const settlementSummary = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:02:00.000Z"),
    claimTokenFactory: () => "settle-real-owned",
    operations: settlements.operations,
  });

  assert.equal(settlementSummary.claimed, 1);
  assert.equal(settlementSummary.succeeded, 1);
  assert.equal(settlements.progress.length, 1);
  assert.equal(settlements.history.length, 1);
  assert.equal(settlements.notifications.length, 1);
  const afterSettlement = await getAutoAcceptJobById(job.id);
  assert.ok(afterSettlement);
  assert.equal(afterSettlement.status, "succeeded");

  await resetDb();

  const budgetRule = await createActiveRule();
  await enqueueAutoAcceptJob(basePendingRequestJob({ ruleId: budgetRule.id }));
  await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791820,
    requestId: 40288120,
    ruleId: budgetRule.id,
  }));
  const budgetCalls: string[] = [];
  const budgetSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 2,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "budget-guard",
    apiClient: ownedApi(budgetCalls),
    loadRuleState: () => ({
      need: 1,
      accept_all: false,
      enabled: true,
      fulfilled: false,
    }),
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(budgetSummary.claimed, 2);
  assert.equal(budgetCalls.filter((call) => call.startsWith("accept:")).length, 1);
  const [budgetRuleAfter] = (await readRules(2)).filter((item) => item.id === budgetRule.id);
  assert.ok(budgetRuleAfter);
  assert.equal(budgetRuleAfter.need, 1);

  await resetDb();

  const checkpointRule = await createActiveRule();
  const checkpointedJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791811,
    requestId: 40288115,
    ruleId: checkpointRule.id,
  }));
  const checkpointSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "checkpoint-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "existing-checkpoint",
    execute: async ({ checkpointResult }) => {
      assert.equal(await checkpointResult({
        resultStatus: "owned",
        resultReasonCode: "verified_owned",
        winningAttemptTraceId: "aa:existing",
      }, new Date("2030-01-01T00:01:01.000Z")), true);
      return {
        outcome: "retry",
        reasonCode: "settlement_pending",
        retryDelayMs: 1,
        count: "verify",
      };
    },
  });
  assert.equal(checkpointSummary.retried, 1);
  const noRepostCalls: string[] = [];
  const noRepostSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:02.000Z"),
    claimTokenFactory: () => "no-repost",
    apiClient: ownedApi(noRepostCalls),
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(noRepostSummary.claimed, 0);
  assert.equal(noRepostSummary.retried, 0);
  assert.deepEqual(noRepostCalls, []);
  const noRepostAfter = await getAutoAcceptJobById(checkpointedJob.id);
  assert.ok(noRepostAfter);
  assert.equal(noRepostAfter.resultStatus, "owned");
  assert.equal(noRepostAfter.winningAttemptTraceId, "aa:existing");

  await resetDb();

  const canonicalRule = await createActiveRule();
  const canonicalOnlyJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791815,
    requestId: 40288119,
    ruleId: canonicalRule.id,
  }));
  await upsertAutoAcceptResult({
    teamId: 2,
    bookingId: 2791815,
    requestId: 40288119,
    winningAttemptTraceId: "aa:canonical-only",
    status: "owned",
    reasonCode: "verified_owned",
    evidence: { source: "checkpoint-write-failed-before-retry" },
  });
  const canonicalOnlyCalls: string[] = [];
  const canonicalOnlySummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:02:00.000Z"),
    claimTokenFactory: () => "canonical-only",
    apiClient: ownedApi(canonicalOnlyCalls),
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(canonicalOnlySummary.retried, 1);
  assert.deepEqual(canonicalOnlyCalls, []);
  const canonicalOnlyAfter = await getAutoAcceptJobById(canonicalOnlyJob.id);
  assert.ok(canonicalOnlyAfter);
  assert.equal(canonicalOnlyAfter.status, "retrying");
  assert.equal(canonicalOnlyAfter.resultStatus, "owned");
  assert.equal(canonicalOnlyAfter.resultReasonCode, "verified_owned");
  assert.equal(canonicalOnlyAfter.winningAttemptTraceId, "aa:canonical-only");

  await resetDb();

  const lostRule = await createActiveRule();
  const lostJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791812,
    requestId: 40288116,
    ruleId: lostRule.id,
  }));
  const lostApi = {
    async acceptBookingRequests() {
      return {
        ok: true,
        httpStatus: 200,
        response: { retcode: 0, message: "ok" },
      };
    },
    async fetchBookingRequestList() {
      return {
        data: {
          request_list: [
            { request_id: 40288116, request_acceptance_status: 4 },
          ],
        },
      };
    },
  };
  const lostExecution = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:03:00.000Z"),
    claimTokenFactory: () => "real-lost",
    apiClient: lostApi,
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(lostExecution.retried, 1);
  const lostResult = await getAutoAcceptResult(2, 2791812, 40288116);
  assert.ok(lostResult);
  assert.equal(lostResult.status, "lost");
  assert.equal(lostResult.reasonCode, "verified_lost_race");
  const lostAfterExecution = await getAutoAcceptJobById(lostJob.id);
  assert.ok(lostAfterExecution);
  assert.equal(lostAfterExecution.resultStatus, "lost");
  assert.equal(lostAfterExecution.resultReasonCode, "verified_lost_race");
  const lostSettlements = createSettlementOperations();
  const lostSettlement = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:04:00.000Z"),
    claimTokenFactory: () => "settle-lost",
    operations: lostSettlements.operations,
  });
  assert.equal(lostSettlement.failed, 1);
  assert.equal(lostSettlements.progress.length, 0);
  assert.equal(lostSettlements.history.length, 1);
  assert.equal(lostSettlements.notifications.length, 0);

  await resetDb();

  const unknownRule = await createActiveRule();
  const unknownJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791813,
    requestId: 40288117,
    ruleId: unknownRule.id,
  }));
  const unknownApiCalls: string[] = [];
  let unknownOwned = false;
  const unknownApi = {
    async acceptBookingRequests() {
      unknownApiCalls.push("accept");
      return {
        ok: false,
        httpStatus: 0,
        response: null,
        error: "timeout after 10000ms",
      };
    },
    async fetchBookingRequestList(_bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
      unknownApiCalls.push(options?.tabPendingConfirmation === false ? "verify:confirmed" : "verify:pending");
      return unknownOwned
        ? { data: { request_list: [{ request_id: 40288117, request_acceptance_status: 2 }] } }
        : null;
    },
  };
  const unknownExecution = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:05:00.000Z"),
    claimTokenFactory: () => "real-unknown",
    apiClient: unknownApi,
    loadRuleState: activeRuleState,
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(unknownExecution.retried, 1);
  assert.deepEqual(unknownApiCalls, ["accept", "verify:pending", "verify:confirmed", "verify:pending", "verify:confirmed"]);
  const unknownResult = await getAutoAcceptResult(2, 2791813, 40288117);
  assert.ok(unknownResult);
  assert.equal(unknownResult.status, "unknown");
  assert.equal(unknownResult.reasonCode, "verify_indeterminate");
  const unknownAfterExecution = await getAutoAcceptJobById(unknownJob.id);
  assert.ok(unknownAfterExecution);
  assert.equal(unknownAfterExecution.status, "retrying");
  assert.equal(unknownAfterExecution.resultStatus, null);
  assert.equal(unknownAfterExecution.resultReasonCode, null);
  assert.equal(unknownAfterExecution.winningAttemptTraceId, null);
  assert.equal(unknownAfterExecution.lastReasonCode, "verify_indeterminate");
  assert.equal(unknownAfterExecution.attemptCount, 0);
  assert.equal(unknownAfterExecution.verifyCount, 1);
  const unknownSettlements = createSettlementOperations();
  const unknownSettlement = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:06:00.000Z"),
    claimTokenFactory: () => "settle-unknown",
    operations: unknownSettlements.operations,
  });
  assert.equal(unknownSettlement.claimed, 0);
  assert.equal(unknownSettlements.progress.length, 0);
  assert.equal(unknownSettlements.history.length, 0);
  assert.equal(unknownSettlements.notifications.length, 0);
  const unknownLedger = await (await getDb())
    .select()
    .from(autoAcceptJobSettlements)
    .where(eq(autoAcceptJobSettlements.jobId, unknownJob.id));
  assert.equal(unknownLedger.some((row) => row.settlementStep === "budget_reservation"), true);
  assert.equal(unknownLedger.some((row) => row.settlementStep === "budget_release"), false);
  assert.equal(unknownLedger.some((row) => row.settlementStep === "progress"), false);

  unknownOwned = true;
  const unknownRecovered = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:06:01.000Z"),
    claimTokenFactory: () => "real-unknown-recovered",
    apiClient: unknownApi,
    loadRuleState: () => {
      throw new Error("existing marker recovery must not reload mutable rule state");
    },
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(unknownRecovered.retried, 1);
  assert.equal(unknownApiCalls.filter((call) => call === "accept").length, 1);
  const unknownRecoveredJob = await getAutoAcceptJobById(unknownJob.id);
  assert.equal(unknownRecoveredJob?.resultStatus, "owned");
  assert.ok(unknownRecoveredJob?.winningAttemptTraceId?.startsWith(`aa-job:${unknownJob.id}:external:`));
  const recoveredUnknownSettlement = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:06:02.000Z"),
    claimTokenFactory: () => "settle-unknown-recovered",
    operations: unknownSettlements.operations,
  });
  assert.equal(recoveredUnknownSettlement.succeeded, 1);
  assert.equal(unknownSettlements.progress.length, 1);
  assert.equal(unknownSettlements.history.length, 1);
  assert.equal(unknownSettlements.notifications.length, 1);

  await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791823,
    requestId: 40288123,
    ruleId: unknownRule.id,
  }));
  const heldUnknownCalls: string[] = [];
  const heldUnknownSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:06:30.000Z"),
    claimTokenFactory: () => "held-unknown-budget",
    apiClient: ownedApi(heldUnknownCalls),
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(heldUnknownSummary.claimed, 1);
  assert.deepEqual(heldUnknownCalls, []);

  const staleRecheckCalls: string[] = [];
  const staleRecheckApi = {
    async acceptBookingRequests(bookingId: number, requestIds: number[]) {
      staleRecheckCalls.push(`accept:${bookingId}:${requestIds.join(",")}`);
      return {
        ok: true,
        httpStatus: 200,
        response: { retcode: 0, message: "ok" },
      };
    },
    async fetchBookingRequestList(bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
      staleRecheckCalls.push(`${bookingId}:${options?.tabPendingConfirmation === false ? "confirmed" : "pending"}`);
      if (bookingId === 2791813) {
        return {
          data: {
            request_list: [{
              request_id: 40288117,
              request_acceptance_status: 4,
            }],
          },
        };
      }
      return {
        data: {
          request_list: [{
            request_id: 40288123,
            request_acceptance_status: 2,
          }],
        },
      };
    },
  };
  const staleReleasedSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:30:00.000Z"),
    claimTokenFactory: () => "released-stale-unknown-budget",
    apiClient: staleRecheckApi,
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
    staleBudgetReservationTtlMs: 5 * 60_000,
    staleBudgetReservationLimit: 5,
  });
  assert.equal(staleReleasedSummary.retried, 1);
  assert.deepEqual(staleRecheckCalls, []);
  const releasedUnknownLedger = await (await getDb())
    .select()
    .from(autoAcceptJobSettlements)
    .where(eq(autoAcceptJobSettlements.jobId, unknownJob.id));
  assert.equal(releasedUnknownLedger.some((row) => row.settlementStep === "budget_release"), false);
  assert.equal(releasedUnknownLedger.some((row) => row.settlementStep === "progress"), false);

  await resetDb();

  const staleOwnedRule = await createActiveRule();
  const staleOwnedJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791840,
    requestId: 40288140,
    ruleId: staleOwnedRule.id,
  }));
  const staleOwnedUnknownApi = {
    async acceptBookingRequests() {
      return { ok: false, httpStatus: 0, response: null, error: "timeout" };
    },
    async fetchBookingRequestList() {
      return null;
    },
  };
  await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T01:00:00.000Z"),
    claimTokenFactory: () => "stale-owned-original",
    apiClient: staleOwnedUnknownApi,
    loadRuleState: activeRuleState,
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnSettlementPending: 1,
  });
  await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T01:01:00.000Z"),
    claimTokenFactory: () => "settle-stale-owned-original",
    operations: createSettlementOperations().operations,
  });
  await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791841,
    requestId: 40288141,
    ruleId: staleOwnedRule.id,
  }));
  const staleOwnedCalls: string[] = [];
  const staleOwnedRecheckApi = {
    async acceptBookingRequests(bookingId: number, requestIds: number[]) {
      staleOwnedCalls.push(`accept:${bookingId}:${requestIds.join(",")}`);
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList(bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
      staleOwnedCalls.push(`${bookingId}:${options?.tabPendingConfirmation === false ? "confirmed" : "pending"}`);
      return {
        data: {
          request_list: [{
            request_id: 40288140,
            request_acceptance_status: 2,
          }],
        },
      };
    },
  };
  const staleOwnedSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T01:30:00.000Z"),
    claimTokenFactory: () => "hold-stale-owned-budget",
    apiClient: staleOwnedRecheckApi,
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
    staleBudgetReservationTtlMs: 5 * 60_000,
  });
  assert.equal(staleOwnedSummary.claimed, 1);
  assert.deepEqual(staleOwnedCalls, ["2791840:pending", "2791840:confirmed"]);
  const staleOwnedLedger = await (await getDb())
    .select()
    .from(autoAcceptJobSettlements)
    .where(eq(autoAcceptJobSettlements.jobId, staleOwnedJob.id));
  assert.equal(staleOwnedLedger.some((row) => row.settlementStep === "budget_release"), false);

  await resetDb();

  const partialReadRule = await createActiveRule();
  const partialReadJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791842,
    requestId: 40288142,
    ruleId: partialReadRule.id,
  }));
  await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T02:00:00.000Z"),
    claimTokenFactory: () => "partial-read-original",
    apiClient: staleOwnedUnknownApi,
    loadRuleState: activeRuleState,
    ambiguousRecheckDelayMs: 0,
    retryDelayMsOnSettlementPending: 1,
  });
  await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T02:01:00.000Z"),
    claimTokenFactory: () => "settle-partial-read-original",
    operations: createSettlementOperations().operations,
  });
  await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791843,
    requestId: 40288143,
    ruleId: partialReadRule.id,
  }));
  const partialReadCalls: string[] = [];
  const partialReadRecheckApi = {
    async acceptBookingRequests(bookingId: number, requestIds: number[]) {
      partialReadCalls.push(`accept:${bookingId}:${requestIds.join(",")}`);
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
    },
    async fetchBookingRequestList(bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
      partialReadCalls.push(`${bookingId}:${options?.tabPendingConfirmation === false ? "confirmed" : "pending"}`);
      if (options?.tabPendingConfirmation === false) return null;
      return { data: { request_list: [] } };
    },
  };
  const partialReadSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T02:30:00.000Z"),
    claimTokenFactory: () => "hold-partial-read-budget",
    apiClient: partialReadRecheckApi,
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
    staleBudgetReservationTtlMs: 5 * 60_000,
  });
  assert.equal(partialReadSummary.claimed, 1);
  assert.deepEqual(partialReadCalls, [
    "2791842:pending",
    "2791842:confirmed",
    "2791842:pending",
    "2791842:confirmed",
  ]);
  const partialReadLedger = await (await getDb())
    .select()
    .from(autoAcceptJobSettlements)
    .where(eq(autoAcceptJobSettlements.jobId, partialReadJob.id));
  assert.equal(partialReadLedger.some((row) => row.settlementStep === "budget_release"), false);

  await resetDb();

  const reconcileRule = await createActiveRule();
  const reconcileIdentity = {
    teamId: 2,
    bookingId: 2791824,
    requestId: 40288124,
    ruleId: reconcileRule.id,
    attemptKind: "own_status_reconcile" as const,
  };
  const reconcileJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: reconcileIdentity.bookingId,
    requestId: reconcileIdentity.requestId,
    ruleId: reconcileIdentity.ruleId,
    attemptKind: reconcileIdentity.attemptKind,
    payload: {
      idempotencyKey: buildAutoAcceptJobIdempotencyKey(reconcileIdentity),
      attemptKind: reconcileIdentity.attemptKind,
      acceptAll: false,
      source: "reconciliation",
      bookingId: reconcileIdentity.bookingId,
      requestId: reconcileIdentity.requestId,
      ruleId: reconcileIdentity.ruleId,
      ruleSnapshot: {
        need: 1,
        accept_all: false,
        enabled: true,
        fulfilled: false,
      },
      trip: {
        request_id: reconcileIdentity.requestId,
        booking_id: reconcileIdentity.bookingId,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
        acceptance_status: 2,
        listAgeMs: 2000,
      },
    },
  }));
  const reconcileApiCalls: string[] = [];
  const reconcileApi = {
    async acceptBookingRequests() {
      reconcileApiCalls.push("accept");
      throw new Error("own_status_reconcile must not call SPX accept");
    },
    async fetchBookingRequestList() {
      reconcileApiCalls.push("verify");
      throw new Error("own_status_reconcile should use observed child evidence");
    },
  };
  const reconcileSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:08:00.000Z"),
    claimTokenFactory: () => "own-reconcile",
    apiClient: reconcileApi,
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(reconcileSummary.claimed, 1);
  assert.equal(reconcileSummary.retried, 1);
  assert.deepEqual(reconcileApiCalls, []);
  const reconcileResult = await getAutoAcceptResult(2, reconcileIdentity.bookingId, reconcileIdentity.requestId);
  assert.ok(reconcileResult);
  assert.equal(reconcileResult.status, "owned");
  assert.equal(reconcileResult.reasonCode, "verified_owned");
  const reconcileAfterExecution = await getAutoAcceptJobById(reconcileJob.id);
  assert.ok(reconcileAfterExecution);
  assert.equal(reconcileAfterExecution.status, "retrying");
  assert.equal(reconcileAfterExecution.resultStatus, "owned");
  assert.equal(reconcileAfterExecution.resultReasonCode, "verified_owned");
  assert.ok(reconcileAfterExecution.winningAttemptTraceId);

  const reconcileSettlements = createSettlementOperations();
  const reconcileSettlement = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:09:00.000Z"),
    claimTokenFactory: () => "settle-own-reconcile",
    operations: reconcileSettlements.operations,
  });
  assert.equal(reconcileSettlement.succeeded, 1);
  assert.equal(reconcileSettlements.progress.length, 1);
  assert.equal(reconcileSettlements.history.length, 1);
  assert.equal(reconcileSettlements.notifications.length, 1);
  assert.deepEqual(reconcileSettlements.progress.map((item) => ({
    teamId: item.teamId,
    bookingId: item.bookingId,
    requestIds: item.requestIds,
    ruleId: item.ruleId,
    acceptedCount: item.acceptedCount,
  })), [{
    teamId: 2,
    bookingId: reconcileIdentity.bookingId,
    requestIds: [reconcileIdentity.requestId],
    ruleId: reconcileRule.id,
    acceptedCount: 1,
  }]);

  await resetDb();

  const fastRule = await createActiveRule(2);
  const fastParent = await enqueueAutoAcceptJob(baseFastAcceptAllJob({ ruleId: fastRule.id }));
  const fastCalls: string[] = [];
  const fastApi = {
    async acceptBookingRequests() {
      fastCalls.push("accept-request");
      throw new Error("fast_accept_all parent must not call request-id accept");
    },
    async acceptAllBookingRequests(bookingId: number) {
      fastCalls.push(`accept-all:${bookingId}`);
      return {
        ok: true,
        httpStatus: 200,
        response: { retcode: 0, message: "ok", data: { success_count: 2 } },
      };
    },
    async fetchBookingRequestList(_bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
      fastCalls.push(options?.tabPendingConfirmation === false ? "fetch:confirmed" : "fetch:pending");
      return {
        data: {
          request_list: options?.tabPendingConfirmation === false
            ? [
                fastAcceptedRequestListItem({
                  requestId: 40288130,
                  bookingId: 2791830,
                  origin: "Bangkok",
                  destination: "Rayong",
                  vehicleTypeName: "4W",
                }),
                fastAcceptedRequestListItem({
                  requestId: 40288131,
                  bookingId: 2791830,
                  origin: "Bangkok",
                  destination: "Rayong",
                  vehicleTypeName: "4W",
                }),
              ]
            : [],
        },
      };
    },
  };
  const fastSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:10:00.000Z"),
    claimTokenFactory: () => "fast-parent",
    apiClient: fastApi,
    loadRuleState: () => ({ need: 2, accept_all: true, enabled: true, fulfilled: false }),
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(fastSummary.claimed, 1);
  assert.equal(fastSummary.succeeded, 1);
  assert.deepEqual(fastCalls, ["accept-all:2791830", "fetch:pending", "fetch:confirmed"]);
  const fastParentAfter = await getAutoAcceptJobById(fastParent.id);
  assert.ok(fastParentAfter);
  assert.equal(fastParentAfter.status, "succeeded");
  assert.equal(fastParentAfter.resultStatus, "owned");
  assert.equal(fastParentAfter.resultReasonCode, "fast_accept_all_children_enqueued");
  const fastParentTrace = fastParentAfter.winningAttemptTraceId;
  assert.ok(fastParentTrace);

  for (const requestId of [40288130, 40288131]) {
    const result = await getAutoAcceptResult(2, 2791830, requestId);
    assert.equal(result?.status, "owned");
    assert.equal(result?.reasonCode, "verified_owned");
    assert.equal(result?.winningAttemptTraceId, fastParentTrace);
    const childKey = buildAutoAcceptJobIdempotencyKey({
      teamId: 2,
      bookingId: 2791830,
      requestId,
      ruleId: fastRule.id,
      attemptKind: "own_status_reconcile",
    });
    const child = await getAutoAcceptJobByIdempotencyKey(childKey);
    assert.ok(child);
    assert.equal(child.attemptKind, "own_status_reconcile");
    assert.equal(child.status, "pending");
    const childPayload = JSON.parse(child.payloadJson);
    assert.equal(childPayload.source, "reconciliation");
    assert.equal(childPayload.acceptAll, false);
    assert.equal(childPayload.trip.acceptance_status, 2);
  }

  const fastChildSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 2,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:10:01.000Z"),
    claimTokenFactory: () => "fast-children",
    apiClient: fastApi,
    loadRuleState: () => ({ need: 0, accept_all: false, enabled: false, fulfilled: true }),
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(fastChildSummary.claimed, 2);
  assert.equal(fastChildSummary.retried, 2);
  assert.deepEqual(fastCalls, ["accept-all:2791830", "fetch:pending", "fetch:confirmed"]);
  for (const requestId of [40288130, 40288131]) {
    const child = await getAutoAcceptJobByIdempotencyKey(buildAutoAcceptJobIdempotencyKey({
      teamId: 2,
      bookingId: 2791830,
      requestId,
      ruleId: fastRule.id,
      attemptKind: "own_status_reconcile",
    }));
    assert.equal(child?.resultStatus, "owned");
    assert.equal(child?.resultReasonCode, "verified_owned");
    assert.equal(child?.winningAttemptTraceId, fastParentTrace);
  }

  const fastPublished: unknown[] = [];
  const fastSettlementOps = createAutoAcceptJobSettlementOperations({
    publisher: {
      publish: async () => ({ ok: true }),
      autoAcceptOwned: async (input) => {
        fastPublished.push(input);
        return { ok: true };
      },
    },
  });
  const crashBeforeBookingHistoryOps: AutoAcceptJobSettlementOperations = {
    settleProgress: fastSettlementOps.settleProgress,
    writeHistory: async (input) => {
      await writeAutoAcceptHistoryOnce({
        jobId: input.jobId,
        teamId: input.teamId,
        record: input.record,
      });
      throw new Error("simulated crash before booking history insert");
    },
    enqueueNotification: fastSettlementOps.enqueueNotification,
  };
  const fastCrashSettlement = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:10:02.000Z"),
    claimTokenFactory: () => "settle-fast-children-crash",
    operations: crashBeforeBookingHistoryOps,
    retryDelayMsOnSettlementError: 1,
  });
  assert.equal(fastCrashSettlement.retried, 1);
  assert.deepEqual((await getBookingHistory(2, { limit: 20, sortBy: "request_id", sortDir: "asc" })).map((row) => row.requestId), []);
  const fastSettlement = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 2,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:10:03.000Z"),
    claimTokenFactory: () => "settle-fast-children",
    operations: fastSettlementOps,
  });
  assert.equal(fastSettlement.succeeded, 2);
  assert.equal(fastPublished.length, 2);
  assert.deepEqual(
    fastPublished.map((input) => (input as { traceId?: string | null }).traceId),
    [fastParentTrace, fastParentTrace],
  );
  const historyDb = await getDb();
  const fastHistoryRows = await historyDb
    .select({ traceId: autoAcceptHistory.traceId })
    .from(autoAcceptHistory)
    .where(eq(autoAcceptHistory.bookingId, 2791830));
  assert.deepEqual(fastHistoryRows.map((row) => row.traceId), [fastParentTrace, fastParentTrace]);
  const bookingHistory = await getBookingHistory(2, { limit: 20, sortBy: "request_id", sortDir: "asc" });
  assert.deepEqual(bookingHistory.map((row) => row.requestId), [40288130, 40288131]);
  for (const row of bookingHistory) {
    assert.equal(row.bookingId, 2791830);
    assert.equal(row.bookingName, "[ADHOC]Bangkok > Rayong 2030-01-01");
    assert.equal(row.route, "Bangkok -> Rayong");
    assert.equal(row.origin, "Bangkok");
    assert.equal(row.destination, "Rayong");
    assert.equal(row.costType, "Fixed");
    assert.equal(row.tripType, "One Way");
    assert.equal(row.shiftType, "Day Shift");
    assert.equal(row.vehicleType, "4W");
    assert.equal(row.standbyDateTime, "01/01/2573 08:00");
    assert.equal(row.acceptanceStatus, 2);
    assert.equal(row.assignmentStatus, 1);
  }
  const fastSettlementRerun = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 2,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:10:04.000Z"),
    claimTokenFactory: () => "settle-fast-children-again",
    operations: fastSettlementOps,
  });
  assert.equal(fastSettlementRerun.claimed, 0);
  const bookingHistoryAfterRerun = await getBookingHistory(2, { limit: 20, sortBy: "request_id", sortDir: "asc" });
  assert.deepEqual(bookingHistoryAfterRerun.map((row) => row.requestId), [40288130, 40288131]);

  await resetDb();

  const fastFailedRule = await createActiveRule(1);
  const fastFailedParent = await enqueueAutoAcceptJob(baseFastAcceptAllJob({
    bookingId: 2791831,
    ruleId: fastFailedRule.id,
    payload: {
      ruleSnapshot: { need: 1, accept_all: true, enabled: true, fulfilled: false },
    },
  }));
  const noOwnedApi = {
    async acceptBookingRequests() {
      throw new Error("fast_accept_all parent must not call request-id accept");
    },
    async acceptAllBookingRequests() {
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok", data: { success_count: 1 } } };
    },
    async fetchBookingRequestList(_bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
      return {
        data: {
          request_list: options?.tabPendingConfirmation === false
              ? [
                { request_id: 40288132, booking_id: 2791831, request_acceptance_status: 6 },
                { request_id: 40288133, booking_id: 2791831, request_acceptance_status: 4 },
              ]
            : [],
        },
      };
    },
  };
  const noOwnedSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:11:00.000Z"),
    claimTokenFactory: () => "fast-no-owned",
    apiClient: noOwnedApi,
    loadRuleState: () => ({ need: 1, accept_all: true, enabled: true, fulfilled: false }),
  });
  assert.equal(noOwnedSummary.failed, 1);
  const fastFailedAfter = await getAutoAcceptJobById(fastFailedParent.id);
  assert.ok(fastFailedAfter);
  assert.equal(fastFailedAfter.status, "failed");
  assert.equal(fastFailedAfter.resultReasonCode, "fast_accept_all_no_verified_owned_requests");
  assert.equal((await getAutoAcceptResult(2, 2791831, 40288132))?.status, "lost");
  assert.equal((await getAutoAcceptResult(2, 2791831, 40288133))?.status, "lost");

  await resetDb();

  const probeRule = await createActiveRule();
  const probeIdentity = {
    teamId: 2,
    bookingId: 2791814,
    requestId: 40288118,
    ruleId: probeRule.id,
    attemptKind: "non_pending_probe" as const,
  };
  const probeJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: probeIdentity.bookingId,
    requestId: probeIdentity.requestId,
    ruleId: probeIdentity.ruleId,
    attemptKind: probeIdentity.attemptKind,
    payload: {
      idempotencyKey: buildAutoAcceptJobIdempotencyKey(probeIdentity),
      attemptKind: probeIdentity.attemptKind,
      ruleId: probeIdentity.ruleId,
      bookingId: probeIdentity.bookingId,
      requestId: probeIdentity.requestId,
      source: "non_pending_tab",
      trip: {
        request_id: probeIdentity.requestId,
        booking_id: probeIdentity.bookingId,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
        acceptance_status: 4,
        listAgeMs: 1000,
      },
    },
  }));
  const probeCalls: string[] = [];
  const probeApi = {
    async acceptBookingRequests(bookingId: number, requestIds: number[]) {
      probeCalls.push(`accept:${bookingId}:${requestIds.join(",")}`);
      return {
        ok: true,
        httpStatus: 200,
        response: { retcode: 0, message: "ok" },
      };
    },
    async fetchBookingRequestList(_bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
      probeCalls.push(options?.tabPendingConfirmation === false ? "verify:confirmed" : "verify:pending");
      return {
        data: {
          request_list: [
            { request_id: probeIdentity.requestId, request_acceptance_status: 4 },
          ],
        },
      };
    },
  };
  const probeSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:07:00.000Z"),
    claimTokenFactory: () => "real-non-pending-probe",
    apiClient: probeApi,
    loadRuleState: activeRuleState,
    retryDelayMsOnSettlementPending: 1,
  });
  assert.equal(probeSummary.retried, 1);
  assert.deepEqual(probeCalls, ["accept:2791814:40288118", "verify:pending", "verify:confirmed"]);
  const probeResult = await getAutoAcceptResult(2, probeIdentity.bookingId, probeIdentity.requestId);
  assert.ok(probeResult);
  assert.equal(probeResult.status, "lost");
  assert.equal(probeResult.reasonCode, "verified_lost_race");
  const probeAfter = await getAutoAcceptJobById(probeJob.id);
  assert.ok(probeAfter);
  assert.equal(probeAfter.status, "retrying");
  assert.equal(probeAfter.resultStatus, "lost");
  assert.equal(probeAfter.resultReasonCode, "verified_lost_race");
  const probeLedger = await (await getDb())
    .select()
    .from(autoAcceptJobSettlements)
    .where(eq(autoAcceptJobSettlements.jobId, probeJob.id));
  assert.equal(probeLedger.some((row) => row.settlementStep === "budget_reservation"), false);
  assert.equal(probeLedger.some((row) => row.settlementStep === "budget_release"), false);
  const probeSettlements = createSettlementOperations();
  const probeSettlement = await runAutoAcceptJobSettlementBatch({
    ownerNodeId: "settlement-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:07:01.000Z"),
    claimTokenFactory: () => "settle-non-pending-probe",
    operations: probeSettlements.operations,
  });
  assert.equal(probeSettlement.failed, 1);
  assert.equal(probeSettlements.progress.length, 0);
  assert.equal(probeSettlements.history.length, 1);
  assert.equal(probeSettlements.history[0]?.record.status, "failed");
  assert.equal(probeSettlements.notifications.length, 0);

  await resetDb();

  const publicationIdentity = {
    teamId: 2,
    epoch: "phase3-ifn-real-execution",
    pollerNodeId: "poller-01",
  };
  await enablePublication(publicationIdentity);
  const fencedRule = await createActiveRule();
  const fencedJob = await enqueueAutoAcceptJob(basePendingRequestJob({
    bookingId: 2791840,
    requestId: 40288140,
    ruleId: fencedRule.id,
    cutoverEpoch: publicationIdentity.epoch,
  }));
  const fencedApiCalls: string[] = [];
  let advancedAfterClaim = false;
  const fencedSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:12:00.000Z"),
    claimTokenFactory: () => "real-stale-publication",
    apiClient: ownedApi(fencedApiCalls),
    loadRuleState: activeRuleState,
    canStartNewExternalAttempt: () => {
      const raw = getRawMemoryDb();
      raw.prepare(`
        INSERT INTO auto_accept_publication_controls (
          team_id, cutover_epoch, publication_generation, state, poller_node_id
        ) VALUES (?, ?, ?, 'enabled', ?)
      `).run(2, "phase3-ifn-real-execution-next", 2, "poller-02");
      raw.prepare(`
        UPDATE auto_accept_publication_active_epochs
        SET active_epoch = ?, active_generation = ?, updated_at = datetime('now')
        WHERE team_id = ?
      `).run("phase3-ifn-real-execution-next", 2, 2);
      advancedAfterClaim = true;
      return true;
    },
  });
  assert.equal(advancedAfterClaim, true);
  assert.equal(fencedSummary.claimed, 1);
  assert.equal(fencedSummary.indeterminate, 1);
  assert.deepEqual(fencedApiCalls, []);
  const fencedAfter = await getAutoAcceptJobById(fencedJob.id);
  assert.ok(fencedAfter);
  assert.equal(fencedAfter.status, "indeterminate");
  assert.equal(fencedAfter.resultStatus, "unknown");
  assert.equal(fencedAfter.resultReasonCode, "stale_publication_epoch");
  assert.equal((await (await getDb()).select().from(autoAcceptAttempts)).length, 0);
  assert.equal(await getAutoAcceptResult(2, 2791840, 40288140), null);
  const fencedLedger = await (await getDb())
    .select()
    .from(autoAcceptJobSettlements)
    .where(eq(autoAcceptJobSettlements.jobId, fencedJob.id));
  assert.equal(fencedLedger.length, 0);

  await resetDb();

  const fastPublication = {
    teamId: 2,
    epoch: "phase3-fast-parent",
    pollerNodeId: "poller-01",
  };
  await enablePublication(fastPublication);
  const controlledFastRule = await createRule(2, {
    name: "Bangkok to Rayong controlled fast",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
    accept_all: true,
  });
  const controlledFastParent = await enqueueAutoAcceptJob(baseFastAcceptAllJob({
    bookingId: 2791841,
    ruleId: controlledFastRule.id,
    cutoverEpoch: fastPublication.epoch,
    payload: {
      ruleSnapshot: { need: 1, accept_all: true, enabled: true, fulfilled: false },
    },
  }));
  const controlledFastSummary = await runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:13:00.000Z"),
    claimTokenFactory: () => "controlled-fast-parent",
    apiClient: {
      async acceptBookingRequests() {
        throw new Error("fast parent must not call request-id accept");
      },
      async acceptAllBookingRequests() {
        return { ok: true, httpStatus: 200, response: { retcode: 0, message: "ok" } };
      },
      async fetchBookingRequestList(_bookingId: number, options?: { tabPendingConfirmation?: boolean }) {
        return {
          data: {
            request_list: options?.tabPendingConfirmation === false
              ? [{
                  request_id: 40288141,
                  booking_id: 2791841,
                  request_acceptance_status: 2,
                  origin: "Bangkok",
                  destination: "Rayong",
                  vehicle_type: "4W",
                }]
              : [],
          },
        };
      },
    },
    loadRuleState: () => ({
      need: 1,
      accept_all: true,
      enabled: true,
      fulfilled: false,
    }),
  });
  assert.equal(controlledFastSummary.succeeded, 1);
  const controlledChildKey = buildAutoAcceptJobIdempotencyKey({
    teamId: 2,
    cutoverEpoch: fastPublication.epoch,
    bookingId: 2791841,
    requestId: 40288141,
    ruleId: controlledFastRule.id,
    attemptKind: "own_status_reconcile",
  });
  const controlledChild = await getAutoAcceptJobByIdempotencyKey(controlledChildKey);
  assert.ok(controlledChild);
  assert.equal(controlledChild.cutoverEpoch, fastPublication.epoch);
  assert.equal(controlledChild.publicationGeneration, controlledFastParent.publicationGeneration);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
