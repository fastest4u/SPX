import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
} from "../src/repositories/auto-accept-job-repository.js";
import { getAutoAcceptHistory } from "../src/repositories/auto-accept-repository.js";
import { createRule, updateRule, type NotifyRule } from "../src/services/notify-rules.js";
import {
  runAutoAcceptJobDryRunWorkerOnce,
  startAutoAcceptJobDryRunWorkerLoop,
} from "../src/services/auto-accept-job-dry-run-loop.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

async function createActiveRule(teamId: number): Promise<NotifyRule> {
  return await createRule(teamId, {
    name: `Dry run rule ${teamId}`,
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
  await resetDb();

  const rule = await createActiveRule(2);
  const valid = await enqueueAutoAcceptJob(jobForRule(rule));
  const validSummary = await runAutoAcceptJobDryRunWorkerOnce({
    nodeId: "dry-worker-01",
    teamIds: [2],
    batchSize: 5,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "runtime-dry-valid",
  });
  assert.equal(validSummary.claimed, 1);
  assert.equal(validSummary.cancelled, 1);
  const validAfterRun = await getAutoAcceptJobById(valid.id);
  assert.ok(validAfterRun);
  assert.equal(validAfterRun.status, "cancelled");
  assert.equal(validAfterRun.resultReasonCode, "dry_run_validated");
  assert.equal(validAfterRun.historyWrittenAt, null);
  assert.equal(validAfterRun.notificationEnqueuedAt, null);
  assert.deepEqual(await getAutoAcceptHistory(2, { limit: 20 }), []);

  await updateRule(2, rule.id, { enabled: false });
  const disabledRulePayload = await enqueueAutoAcceptJob(jobForRule(rule, {
    bookingId: 2791811,
    requestId: 40288115,
  }));
  const disabledSummary = await runAutoAcceptJobDryRunWorkerOnce({
    nodeId: "dry-worker-01",
    teamIds: [2],
    batchSize: 5,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:02:00.000Z"),
    claimTokenFactory: () => "runtime-dry-disabled",
  });
  assert.equal(disabledSummary.deadLettered, 1);
  const disabledAfterRun = await getAutoAcceptJobById(disabledRulePayload.id);
  assert.ok(disabledAfterRun);
  assert.equal(disabledAfterRun.status, "dead_letter");
  assert.equal(disabledAfterRun.lastReasonCode, "dry_run_rule_inactive");

  const otherTeamRule = await createActiveRule(3);
  const otherTeamJob = await enqueueAutoAcceptJob(jobForRule(otherTeamRule, {
    teamId: 3,
    bookingId: 2791812,
    requestId: 40288116,
  }));
  const scopedSummary = await runAutoAcceptJobDryRunWorkerOnce({
    nodeId: "dry-worker-01",
    teamIds: [2],
    batchSize: 5,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:03:00.000Z"),
    claimTokenFactory: () => "runtime-dry-scoped",
  });
  assert.equal(scopedSummary.claimed, 0);
  const otherTeamAfterRun = await getAutoAcceptJobById(otherTeamJob.id);
  assert.ok(otherTeamAfterRun);
  assert.equal(otherTeamAfterRun.status, "pending");

  let loopRuns = 0;
  const loop = startAutoAcceptJobDryRunWorkerLoop({
    nodeId: "dry-worker-loop",
    teamIds: [2],
    batchSize: 1,
    leaseMs: 60_000,
    intervalMs: 60_000,
    runBatch: async () => {
      loopRuns += 1;
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
      };
    },
  });
  assert.equal(typeof loop.stop, "function");
  await loop.runOnce();
  assert.ok(loopRuns >= 1);
  loop.stop();
  loop.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
