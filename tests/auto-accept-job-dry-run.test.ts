import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  getAutoAcceptJobById,
  type AutoAcceptAttemptKind,
} from "../src/repositories/auto-accept-job-repository.js";
import { getAutoAcceptHistory } from "../src/repositories/auto-accept-repository.js";
import { runAutoAcceptJobDryRunBatch } from "../src/services/auto-accept-job-dry-run.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function baseJob(overrides: {
  teamId?: number;
  bookingId?: number;
  requestId?: number;
  ruleId?: string;
  attemptKind?: AutoAcceptAttemptKind;
  payload?: Record<string, unknown>;
  ruleSnapshot?: {
    need: number;
    accept_all: boolean;
    enabled: boolean;
    fulfilled: boolean;
  };
} = {}) {
  const identity = {
    teamId: overrides.teamId ?? 2,
    bookingId: overrides.bookingId ?? 2791810,
    requestId: overrides.requestId ?? 40288114,
    ruleId: overrides.ruleId ?? "rule-1",
    attemptKind: overrides.attemptKind ?? "pending_request",
  };
  const ruleSnapshot = overrides.ruleSnapshot ?? {
    need: 1,
    accept_all: false,
    enabled: true,
    fulfilled: false,
  };
  const payload = {
    schemaVersion: 1,
    idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity),
    attemptKind: identity.attemptKind,
    teamId: identity.teamId,
    bookingId: identity.bookingId,
    requestId: identity.requestId,
    ruleId: identity.ruleId,
    ruleName: "Bangkok to Rayong",
    acceptAll: ruleSnapshot.accept_all,
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
    ruleSnapshot,
    observedAt: "2030-01-01T00:00:00.000Z",
    pollerNodeId: "poller-01",
    ...overrides.payload,
  };
  return {
    ...identity,
    payload,
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

async function main() {
  await resetDb();

  const valid = await enqueueAutoAcceptJob(baseJob());
  const validSummary = await runAutoAcceptJobDryRunBatch({
    ownerNodeId: "auto-dry-run-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:01:00.000Z"),
    claimTokenFactory: () => "dry-run-valid",
  });
  assert.deepEqual(validSummary, {
    claimed: 1,
    succeeded: 0,
    failed: 0,
    indeterminate: 0,
    cancelled: 1,
    retried: 0,
    deadLettered: 0,
    executorErrors: 0,
    settleFailures: 0,
    checkpointed: 0,
    checkpointFailures: 0,
  });
  const validAfterDryRun = await getAutoAcceptJobById(valid.id);
  assert.ok(validAfterDryRun);
  assert.equal(validAfterDryRun.status, "cancelled");
  assert.equal(validAfterDryRun.resultStatus, "unknown");
  assert.equal(validAfterDryRun.resultReasonCode, "dry_run_validated");
  assert.equal(validAfterDryRun.claimToken, null);
  assert.ok(validAfterDryRun.completedAt);
  assert.equal(validAfterDryRun.progressSettledAt, null);
  assert.equal(validAfterDryRun.historyWrittenAt, null);
  assert.equal(validAfterDryRun.notificationEnqueuedAt, null);
  assert.deepEqual(await getAutoAcceptHistory(2, { limit: 20 }), []);

  const inactiveRule = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791811,
    requestId: 40288115,
    ruleSnapshot: {
      need: 1,
      accept_all: false,
      enabled: false,
      fulfilled: false,
    },
  }));
  const inactiveSummary = await runAutoAcceptJobDryRunBatch({
    ownerNodeId: "auto-dry-run-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:02:00.000Z"),
    claimTokenFactory: () => "dry-run-inactive",
  });
  assert.equal(inactiveSummary.deadLettered, 1);
  const inactiveAfterDryRun = await getAutoAcceptJobById(inactiveRule.id);
  assert.ok(inactiveAfterDryRun);
  assert.equal(inactiveAfterDryRun.status, "dead_letter");
  assert.equal(inactiveAfterDryRun.lastReasonCode, "dry_run_rule_inactive");
  assert.equal(inactiveAfterDryRun.resultStatus, null);
  assert.equal(inactiveAfterDryRun.historyWrittenAt, null);

  const identityMismatch = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791812,
    requestId: 40288116,
    payload: {
      teamId: 999,
    },
  }));
  const mismatchSummary = await runAutoAcceptJobDryRunBatch({
    ownerNodeId: "auto-dry-run-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:03:00.000Z"),
    claimTokenFactory: () => "dry-run-mismatch",
  });
  assert.equal(mismatchSummary.deadLettered, 1);
  const mismatchAfterDryRun = await getAutoAcceptJobById(identityMismatch.id);
  assert.ok(mismatchAfterDryRun);
  assert.equal(mismatchAfterDryRun.status, "dead_letter");
  assert.equal(mismatchAfterDryRun.lastReasonCode, "dry_run_identity_mismatch");
  assert.equal(mismatchAfterDryRun.historyWrittenAt, null);
  assert.deepEqual(await getAutoAcceptHistory(2, { limit: 20 }), []);

  const forbiddenSecretPayload = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791813,
    requestId: 40288117,
    payload: {
      trip: {
        request_id: 40288117,
        booking_id: 2791813,
        origin: "Bangkok",
        destination: "Rayong",
        spxCookie: "must-not-be-in-payload",
      },
    },
  }));
  const forbiddenSummary = await runAutoAcceptJobDryRunBatch({
    ownerNodeId: "auto-dry-run-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:04:00.000Z"),
    claimTokenFactory: () => "dry-run-forbidden",
  });
  assert.equal(forbiddenSummary.deadLettered, 1);
  const forbiddenAfterDryRun = await getAutoAcceptJobById(forbiddenSecretPayload.id);
  assert.ok(forbiddenAfterDryRun);
  assert.equal(forbiddenAfterDryRun.status, "dead_letter");
  assert.equal(forbiddenAfterDryRun.lastReasonCode, "dry_run_forbidden_payload_key");
  assert.equal(forbiddenAfterDryRun.historyWrittenAt, null);

  const transientRuleState = await enqueueAutoAcceptJob(baseJob({
    bookingId: 2791814,
    requestId: 40288118,
  }));
  const transientSummary = await runAutoAcceptJobDryRunBatch({
    ownerNodeId: "auto-dry-run-worker",
    teamIds: [2],
    limit: 1,
    leaseMs: 60_000,
    now: new Date("2030-01-01T00:05:00.000Z"),
    claimTokenFactory: () => "dry-run-rule-loader",
    retryDelayMsOnRuleStateError: 45_000,
    loadRuleState: () => {
      throw new Error("rule state unavailable");
    },
  });
  assert.equal(transientSummary.executorErrors, 0);
  assert.equal(transientSummary.retried, 1);
  const transientAfterDryRun = await getAutoAcceptJobById(transientRuleState.id);
  assert.ok(transientAfterDryRun);
  assert.equal(transientAfterDryRun.status, "retrying");
  assert.equal(transientAfterDryRun.lastReasonCode, "dry_run_rule_state_unavailable");
  assert.equal(transientAfterDryRun.attemptCount, 0);
  assert.equal(transientAfterDryRun.verifyCount, 1);
  assert.equal(transientAfterDryRun.historyWrittenAt, null);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
