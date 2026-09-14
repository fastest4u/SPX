import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
} from "../src/repositories/auto-accept-job-repository.js";
import { createTeam } from "../src/repositories/team-repository.js";
import { createRule, type NotifyRule } from "../src/services/notify-rules.js";
import type {
  AutoAcceptJobRealExecutionApi,
  RunAutoAcceptJobRealExecutionBatchInput,
} from "../src/services/auto-accept-job-real-execution.js";
import {
  loadAutoAcceptJobRealApiClientForTeam,
  runAutoAcceptJobRealWorkerOnce,
  startAutoAcceptJobRealWorkerLoop,
} from "../src/services/auto-accept-job-real-execution-loop.js";
import type { AutoAcceptWorkerBatchResult } from "../src/services/auto-accept-worker.js";

function emptySummary(overrides: Partial<AutoAcceptWorkerBatchResult> = {}): AutoAcceptWorkerBatchResult {
  return {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    indeterminate: 0,
    cancelled: 0,
    retried: 0,
    deadLettered: 0,
    executorErrors: 0,
    settleFailures: 0,
    checkpointed: 0,
    checkpointFailures: 0,
    ...overrides,
  };
}

function fakeApiClient(): AutoAcceptJobRealExecutionApi {
  return {
    async acceptBookingRequests() {
      throw new Error("test fake should not accept directly");
    },
    async fetchBookingRequestList() {
      throw new Error("test fake should not fetch directly");
    },
  };
}

const ruleState = {
  need: 1,
  accept_all: false,
  enabled: true,
  fulfilled: false,
};

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

async function createActiveRule(teamId: number): Promise<NotifyRule> {
  return await createRule(teamId, {
    name: `Real loop rule ${teamId}`,
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 2,
    enabled: true,
    fulfilled: false,
    accept_all: false,
  });
}

function jobForRule(rule: NotifyRule, overrides: { bookingId?: number; requestId?: number; teamId?: number } = {}) {
  const identity = {
    teamId: overrides.teamId ?? rule.teamId ?? 2,
    bookingId: overrides.bookingId ?? 2791810,
    requestId: overrides.requestId ?? 40288114,
    ruleId: rule.id,
    attemptKind: "pending_request" as const,
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
      ruleName: rule.name,
      acceptAll: false,
      source: "pending_tab",
      trip: {
        request_id: identity.requestId,
        booking_id: identity.bookingId,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
        acceptance_status: 1,
      },
      ruleSnapshot: {
        need: rule.need,
        accept_all: rule.accept_all,
        enabled: true,
        fulfilled: false,
      },
      observedAt: "2030-01-01T00:00:00.000Z",
      pollerNodeId: "poller-01",
    },
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

async function main() {
  const team2Client = fakeApiClient();
  const team3Client = fakeApiClient();
  const batchInputs: RunAutoAcceptJobRealExecutionBatchInput[] = [];
  const perTeamSummary = await runAutoAcceptJobRealWorkerOnce({
    nodeId: "real-worker-01",
    teamIds: [2, 3, 2],
    batchSize: 5,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:00:00.000Z"),
    claimTokenFactory: () => "real-claim-token",
    apiClientForTeam: async (teamId) => {
      if (teamId === 2) return team2Client;
      if (teamId === 3) return team3Client;
      return null;
    },
    loadRuleState: async () => ruleState,
    runBatch: async (input) => {
      batchInputs.push(input);
      return emptySummary({
        claimed: input.teamIds[0],
        succeeded: 1,
        retried: 1,
        checkpointed: 1,
      });
    },
  });
  assert.deepEqual(batchInputs.map((input) => input.teamIds), [[2], [3]]);
  assert.strictEqual(batchInputs[0]?.apiClient, team2Client);
  assert.strictEqual(batchInputs[1]?.apiClient, team3Client);
  assert.equal(batchInputs[0]?.ownerNodeId, "real-worker-01");
  assert.equal(batchInputs[0]?.limit, 5);
  assert.equal(batchInputs[0]?.leaseMs, 60_000);
  assert.equal(perTeamSummary.claimed, 5);
  assert.equal(perTeamSummary.succeeded, 2);
  assert.equal(perTeamSummary.retried, 2);
  assert.equal(perTeamSummary.checkpointed, 2);

  let skippedBatchCalls = 0;
  const skippedSummary = await runAutoAcceptJobRealWorkerOnce({
    nodeId: "real-worker-01",
    teamIds: [2, 3],
    batchSize: 5,
    leaseMs: 60_000,
    apiClientForTeam: async (teamId) => (teamId === 2 ? team2Client : null),
    loadRuleState: async () => ruleState,
    runBatch: async () => {
      skippedBatchCalls += 1;
      return emptySummary({ claimed: 1, succeeded: 1 });
    },
  });
  assert.equal(skippedBatchCalls, 1);
  assert.equal(skippedSummary.claimed, 1);
  assert.equal(skippedSummary.succeeded, 1);

  await resetDb();
  const disabledTeam = await createTeam({
    name: "Disabled real loop team",
    enabled: false,
    spxCookie: "disabled-cookie",
    spxDeviceId: "disabled-device",
  });
  const incompleteTeam = await createTeam({
    name: "Incomplete real loop team",
    enabled: true,
    spxCookie: "",
    spxDeviceId: "incomplete-device",
  });
  const disabledRule = await createActiveRule(disabledTeam.id);
  const incompleteRule = await createActiveRule(incompleteTeam.id);
  const missingTeamRule = await createActiveRule(999);
  const disabledJob = await enqueueAutoAcceptJob(jobForRule(disabledRule, {
    teamId: disabledTeam.id,
    bookingId: 2791817,
    requestId: 40288117,
  }));
  const incompleteJob = await enqueueAutoAcceptJob(jobForRule(incompleteRule, {
    teamId: incompleteTeam.id,
    bookingId: 2791818,
    requestId: 40288118,
  }));
  const missingTeamJob = await enqueueAutoAcceptJob(jobForRule(missingTeamRule, {
    teamId: 999,
    bookingId: 2791819,
    requestId: 40288119,
  }));
  assert.ok(await loadAutoAcceptJobRealApiClientForTeam(disabledTeam.id));
  assert.equal(await loadAutoAcceptJobRealApiClientForTeam(incompleteTeam.id), null);
  assert.equal(await loadAutoAcceptJobRealApiClientForTeam(999), null);
  let defaultLoaderBatchCalls = 0;
  let disabledTeamPolicyAllowed: boolean | null = null;
  const defaultLoaderSummary = await runAutoAcceptJobRealWorkerOnce({
    nodeId: "real-worker-01",
    teamIds: [disabledTeam.id, incompleteTeam.id, 999],
    batchSize: 5,
    leaseMs: 60_000,
    loadRuleState: async () => ruleState,
    runBatch: async (input) => {
      defaultLoaderBatchCalls += 1;
      disabledTeamPolicyAllowed = await input.canStartNewExternalAttempt?.({
        jobId: disabledJob.id,
        teamId: disabledTeam.id,
        attemptKind: "non_pending_probe",
      }) ?? null;
      return emptySummary({ claimed: 1, retried: 1 });
    },
  });
  assert.equal(defaultLoaderBatchCalls, 1);
  assert.equal(disabledTeamPolicyAllowed, false);
  assert.equal(defaultLoaderSummary.claimed, 1);
  assert.equal(defaultLoaderSummary.retried, 1);
  assert.equal((await getAutoAcceptJobById(disabledJob.id))?.status, "pending");
  assert.equal((await getAutoAcceptJobById(incompleteJob.id))?.status, "pending");
  assert.equal((await getAutoAcceptJobById(missingTeamJob.id))?.status, "pending");

  await assert.rejects(
    () =>
      runAutoAcceptJobRealWorkerOnce({
        nodeId: " ",
        teamIds: [2],
        batchSize: 1,
        leaseMs: 60_000,
      }),
    /nodeId is required/,
  );
  await assert.rejects(
    () =>
      runAutoAcceptJobRealWorkerOnce({
        nodeId: "real-worker-01",
        teamIds: [],
        batchSize: 1,
        leaseMs: 60_000,
      }),
    /teamIds must include at least one assigned team id/,
  );
  await assert.rejects(
    () =>
      runAutoAcceptJobRealWorkerOnce({
        nodeId: "real-worker-01",
        teamIds: [0],
        batchSize: 1,
        leaseMs: 60_000,
      }),
    /teamId must be a positive integer/,
  );
  await assert.rejects(
    () =>
      runAutoAcceptJobRealWorkerOnce({
        nodeId: "real-worker-01",
        teamIds: [2],
        batchSize: 0,
        leaseMs: 60_000,
      }),
    /batchSize must be a positive integer/,
  );
  await assert.rejects(
    () =>
      runAutoAcceptJobRealWorkerOnce({
        nodeId: "real-worker-01",
        teamIds: [2],
        batchSize: 1,
        leaseMs: 0,
      }),
    /leaseMs must be a positive integer/,
  );
  assert.throws(
    () =>
      startAutoAcceptJobRealWorkerLoop({
        nodeId: "real-worker-01",
        teamIds: [2],
        batchSize: 1,
        leaseMs: 60_000,
        intervalMs: 0,
      }),
    /intervalMs must be a positive integer/,
  );

  let releaseFirstRun: (() => void) | null = null;
  const firstRunReleased = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  let loopRuns = 0;
  const loop = startAutoAcceptJobRealWorkerLoop({
    nodeId: "real-worker-loop",
    teamIds: [2],
    batchSize: 1,
    leaseMs: 60_000,
    intervalMs: 60_000,
    apiClientForTeam: async () => team2Client,
    loadRuleState: async () => ruleState,
    runBatch: async () => {
      loopRuns += 1;
      if (loopRuns === 1) await firstRunReleased;
      return emptySummary({ claimed: 1, succeeded: 1 });
    },
  });
  assert.equal(await loop.runOnce(), null);
  releaseFirstRun?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const manualSummary = await loop.runOnce();
  assert.equal(manualSummary?.claimed, 1);
  assert.equal(loopRuns, 2);
  loop.stop();
  loop.stop();
  assert.equal(await loop.runOnce(), null);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
