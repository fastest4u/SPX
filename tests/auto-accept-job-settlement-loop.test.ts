import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
} from "../src/repositories/auto-accept-job-repository.js";
import { getAutoAcceptHistory } from "../src/repositories/auto-accept-repository.js";
import { setTeamRuntimeDesiredState } from "../src/repositories/runtime-repository.js";
import { createTeam } from "../src/repositories/team-repository.js";
import { createAutoAcceptJobSettlementOperations } from "../src/services/auto-accept-job-settlement.js";
import {
  runAutoAcceptJobSettlementWorkerOnce,
  startAutoAcceptJobSettlementWorkerLoop,
} from "../src/services/auto-accept-job-settlement-loop.js";
import { runAutoAcceptWorkerBatch, type AutoAcceptWorkerBatchResult } from "../src/services/auto-accept-worker.js";
import { createRule, readRules, type NotifyRule } from "../src/services/notify-rules.js";

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

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

async function createActiveRule(): Promise<NotifyRule> {
  return await createRule(2, {
    name: "Settlement loop rule",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    accept_all: false,
  });
}

function jobForRule(
  rule: NotifyRule,
  overrides: { bookingId: number; requestId: number; observedAt?: Date },
) {
  const identity = {
    teamId: 2,
    bookingId: overrides.bookingId,
    requestId: overrides.requestId,
    ruleId: rule.id,
    attemptKind: "pending_request" as const,
  };
  const observedAt = overrides.observedAt ?? new Date("2030-01-01T00:00:00.000Z");
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
        acceptance_status: 2,
        listAgeMs: 1200,
      },
      observedAt: observedAt.toISOString(),
      pollerNodeId: "poller-01",
    },
    observedAt,
  };
}

async function main() {
  await resetDb();

  await createTeam({
    name: "Placeholder team",
    enabled: true,
    spxCookie: "placeholder-cookie",
    spxDeviceId: "placeholder-device",
  });
  const disabledTeam = await createTeam({
    name: "Paused disabled settlement team",
    enabled: false,
    spxCookie: "disabled-cookie",
    spxDeviceId: "disabled-device",
  });
  assert.equal(disabledTeam.id, 2);
  await setTeamRuntimeDesiredState({
    teamId: disabledTeam.id,
    desiredState: "paused",
  });

  assert.match(
    readFileSync(resolve(process.cwd(), "src/services/auto-accept-job-settlement-loop.ts"), "utf8"),
    /auto-accept-job-settlement-worker-loop-failed/,
  );

  const rule = await createActiveRule();
  const ordinaryPending = await enqueueAutoAcceptJob(jobForRule(rule, {
    bookingId: 2791809,
    requestId: 40288113,
    observedAt: new Date("2030-01-01T00:01:30.000Z"),
  }));
  const checkpointedOwned = await enqueueAutoAcceptJob(jobForRule(rule, {
    bookingId: 2791810,
    requestId: 40288114,
  }));

  const checkpointSummary = await runAutoAcceptWorkerBatch({
    ownerNodeId: "checkpoint-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "checkpoint-owned",
    execute: async () => ({
      outcome: "checkpoint",
      checkpoint: "canonical_result",
      resultStatus: "owned",
      reasonCode: "verified_owned",
      winningAttemptTraceId: "aa:2:2791810:40288114:2030",
    }),
  });
  assert.equal(checkpointSummary.claimed, 1);
  assert.equal(checkpointSummary.checkpointed, 1);
  assert.equal((await getAutoAcceptJobById(ordinaryPending.id))?.status, "pending");
  assert.equal((await getAutoAcceptJobById(checkpointedOwned.id))?.status, "verifying");

  const published: unknown[] = [];
  const operations = createAutoAcceptJobSettlementOperations({
    publisher: {
      publish: async () => ({ ok: true }),
      autoAcceptOwned: async (input) => {
        published.push(input);
        return { ok: true };
      },
    },
  });
  const settlementSummary = await runAutoAcceptJobSettlementWorkerOnce({
    nodeId: "settlement-worker",
    teamIds: [2],
    batchSize: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:02:00.000Z"),
    claimTokenFactory: () => "settlement-owned",
    operations,
  });
  assert.equal(settlementSummary.claimed, 1);
  assert.equal(settlementSummary.succeeded, 1);
  assert.equal((await getAutoAcceptJobById(ordinaryPending.id))?.status, "pending");
  assert.equal((await getAutoAcceptJobById(checkpointedOwned.id))?.status, "succeeded");
  assert.equal((await readRules(2)).find((item) => item.id === rule.id)?.need, 0);
  assert.equal((await getAutoAcceptHistory(2, { limit: 20 })).length, 1);
  assert.equal(published.length, 1);

  const repeatSummary = await runAutoAcceptJobSettlementWorkerOnce({
    nodeId: "settlement-worker",
    teamIds: [2],
    batchSize: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:03:00.000Z"),
    claimTokenFactory: () => "settlement-repeat",
    operations,
  });
  assert.equal(repeatSummary.claimed, 0);
  assert.equal(repeatSummary.succeeded, 0);
  assert.equal((await getAutoAcceptHistory(2, { limit: 20 })).length, 1);
  assert.equal(published.length, 1);

  await assert.rejects(
    () => runAutoAcceptJobSettlementWorkerOnce({
      nodeId: " ",
      teamIds: [2],
      batchSize: 1,
      leaseMs: 60_000,
    }),
    /nodeId is required/,
  );
  await assert.rejects(
    () => runAutoAcceptJobSettlementWorkerOnce({
      nodeId: "settlement-worker",
      teamIds: [],
      batchSize: 1,
      leaseMs: 60_000,
    }),
    /teamIds must include at least one assigned team id/,
  );
  await assert.rejects(
    () => runAutoAcceptJobSettlementWorkerOnce({
      nodeId: "settlement-worker",
      teamIds: [0],
      batchSize: 1,
      leaseMs: 60_000,
    }),
    /teamId must be a positive integer/,
  );
  await assert.rejects(
    () => runAutoAcceptJobSettlementWorkerOnce({
      nodeId: "settlement-worker",
      teamIds: [2],
      batchSize: 0,
      leaseMs: 60_000,
    }),
    /batchSize must be a positive integer/,
  );
  await assert.rejects(
    () => runAutoAcceptJobSettlementWorkerOnce({
      nodeId: "settlement-worker",
      teamIds: [2],
      batchSize: 1,
      leaseMs: 0,
    }),
    /leaseMs must be a positive integer/,
  );
  assert.throws(
    () => startAutoAcceptJobSettlementWorkerLoop({
      nodeId: "settlement-worker",
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
  const loop = startAutoAcceptJobSettlementWorkerLoop({
    nodeId: "settlement-loop",
    teamIds: [2],
    batchSize: 1,
    leaseMs: 60_000,
    intervalMs: 60_000,
    runBatch: async () => {
      loopRuns += 1;
      if (loopRuns === 1) await firstRunReleased;
      return emptySummary({ claimed: 1, succeeded: 1 });
    },
  });
  assert.equal(await loop.runOnce(), null);
  assert.equal(loopRuns, 1);
  releaseFirstRun?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const manualSummary = await loop.runOnce();
  assert.equal(manualSummary?.claimed, 1);
  assert.equal(loopRuns, 2);
  loop.stop();
  loop.stop();
  assert.equal(await loop.runOnce(), null);

  let failingLoopRuns = 0;
  const failingLoop = startAutoAcceptJobSettlementWorkerLoop({
    nodeId: "settlement-failing-loop",
    teamIds: [2],
    batchSize: 1,
    leaseMs: 60_000,
    intervalMs: 60_000,
    runBatch: async () => {
      failingLoopRuns += 1;
      throw new Error("injected settlement loop failure");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await failingLoop.runOnce(), null);
  assert.equal(failingLoopRuns, 2);
  failingLoop.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
