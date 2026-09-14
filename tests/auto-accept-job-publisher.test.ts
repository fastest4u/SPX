import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { env, validateRuntimeConfig } from "../src/config/env.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  getAutoAcceptJobByIdempotencyKey,
} from "../src/repositories/auto-accept-job-repository.js";
import {
  publishAutoAcceptJob,
  publishAutoAcceptJobs,
} from "../src/services/auto-accept-job-publisher.js";
import {
  acknowledgePublicationFence,
  advancePublicationEpoch,
  enablePublication,
  fencePublication,
} from "../src/repositories/auto-accept-publication-control-repository.js";
import type {
  AutoAcceptJobRow,
} from "../src/repositories/auto-accept-job-repository.js";

const mutableEnv = env as unknown as {
  AUTO_ACCEPT_JOB_SHADOW_ENABLED: boolean;
};

const original = {
  AUTO_ACCEPT_JOB_SHADOW_ENABLED: mutableEnv.AUTO_ACCEPT_JOB_SHADOW_ENABLED,
  processValue: process.env.AUTO_ACCEPT_JOB_SHADOW_ENABLED,
};

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function publishedJob(result: Awaited<ReturnType<typeof publishAutoAcceptJob>>): AutoAcceptJobRow {
  assert.equal(result.published, true);
  if (!result.published) throw new Error(`expected publication success, got ${result.reason}`);
  return result.job;
}

async function main() {
  await resetDb();

  assert.equal(env.AUTO_ACCEPT_JOB_SHADOW_ENABLED, false);
  process.env.AUTO_ACCEPT_JOB_SHADOW_ENABLED = "maybe";
  assert.throws(
    () => validateRuntimeConfig(),
    /AUTO_ACCEPT_JOB_SHADOW_ENABLED must be true or false/,
  );
  process.env.AUTO_ACCEPT_JOB_SHADOW_ENABLED = original.processValue;

  const observedAt = new Date("2030-02-03T04:05:06.000Z");
  const base = {
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288114,
    ruleId: "rule-1",
    ruleName: "Bangkok to Rayong",
    acceptAll: false,
    source: "pending_tab" as const,
    trip: {
      request_id: 40288114,
      booking_id: 2791810,
      "ต้นทาง": "Bangkok",
      "ปลายทาง": "Rayong",
      "ประเภทรถ": "4W",
      acceptance_status: 1,
      listAgeMs: 1234,
      cookie: "must-not-leak",
    },
    ruleSnapshot: {
      need: 1,
      accept_all: false,
      enabled: true,
      fulfilled: false,
    },
    observedAt,
    pollerNodeId: "poller-01",
    pollerLeaseOwnerId: "lease-01",
  };

  const first = publishedJob(await publishAutoAcceptJob({
    ...base,
    attemptKind: "pending_request",
  }));
  const firstPayload = JSON.parse(first.payloadJson);
  const firstKey = buildAutoAcceptJobIdempotencyKey({
    executionMode: "shadow",
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288114,
    ruleId: "rule-1",
    attemptKind: "pending_request",
  });

  assert.equal(first.idempotencyKey, firstKey);
  assert.equal(firstPayload.schemaVersion, 1);
  assert.equal(firstPayload.executionMode, "shadow");
  assert.ok(first.idempotencyKey.startsWith("shadow:"));
  assert.equal(firstPayload.idempotencyKey, firstKey);
  assert.equal(firstPayload.attemptKind, "pending_request");
  assert.equal(firstPayload.source, "pending_tab");
  assert.deepEqual(firstPayload.trip, {
    request_id: 40288114,
    booking_id: 2791810,
    origin: "Bangkok",
    destination: "Rayong",
    vehicle_type: "4W",
    acceptance_status: 1,
    listAgeMs: 1234,
  });
  assert.equal(firstPayload.trip.cookie, undefined);
  assert.deepEqual(firstPayload.ruleSnapshot, {
    need: 1,
    accept_all: false,
    enabled: true,
    fulfilled: false,
  });
  assert.equal(firstPayload.observedAt, "2030-02-03T04:05:06.000Z");
  assert.equal(firstPayload.pollerNodeId, "poller-01");
  assert.equal(firstPayload.pollerLeaseOwnerId, "lease-01");

  const duplicate = publishedJob(await publishAutoAcceptJob({
    ...base,
    attemptKind: "pending_request",
    trip: {
      ...base.trip,
      "ต้นทาง": "Changed",
    },
  }));
  assert.equal(duplicate.id, first.id);
  assert.equal(JSON.parse(duplicate.payloadJson).trip.origin, "Bangkok");

  const [fastAcceptAllResult, nonPendingResult, ownStatusResult] = await publishAutoAcceptJobs([
    {
      ...base,
      requestId: 0,
      attemptKind: "fast_accept_all",
      acceptAll: true,
      source: "booking_name",
      bookingName: "[ADHOC]Bangkok > Rayong 2030-02-03",
      bookingCreatedAtMs: 1896321600000,
      ruleSnapshot: {
        ...base.ruleSnapshot,
        accept_all: true,
      },
      trip: undefined,
    },
    {
      ...base,
      requestId: 40288115,
      attemptKind: "non_pending_probe",
      source: "non_pending_tab",
      trip: {
        request_id: 40288115,
        booking_id: 2791810,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
        acceptance_status: 4,
      },
    },
    {
      ...base,
      requestId: 40288116,
      attemptKind: "own_status_reconcile",
      source: "reconciliation",
      trip: {
        request_id: 40288116,
        booking_id: 2791810,
        origin: "Bangkok",
        destination: "Rayong",
        vehicle_type: "4W",
        acceptance_status: 2,
      },
    },
  ]);
  const fastAcceptAll = publishedJob(fastAcceptAllResult);
  const nonPending = publishedJob(nonPendingResult);
  const ownStatus = publishedJob(ownStatusResult);

  assert.equal(fastAcceptAll.requestId, 0);
  assert.equal(fastAcceptAll.attemptKind, "fast_accept_all");
  assert.equal(JSON.parse(fastAcceptAll.payloadJson).bookingName, "[ADHOC]Bangkok > Rayong 2030-02-03");
  assert.equal(JSON.parse(fastAcceptAll.payloadJson).bookingCreatedAtMs, 1896321600000);
  assert.equal(nonPending.maxAttempts, 1);
  assert.equal(JSON.parse(nonPending.payloadJson).source, "non_pending_tab");
  assert.equal(JSON.parse(ownStatus.payloadJson).source, "reconciliation");
  assert.equal(JSON.parse(ownStatus.payloadJson).trip.acceptance_status, 2);

  const ownStatusKey = buildAutoAcceptJobIdempotencyKey({
    executionMode: "shadow",
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288116,
    ruleId: "rule-1",
    attemptKind: "own_status_reconcile",
  });
  assert.equal((await getAutoAcceptJobByIdempotencyKey(ownStatusKey))?.id, ownStatus.id);

  const identity = {
    teamId: base.teamId,
    epoch: "phase3-ifn-20300203",
    pollerNodeId: base.pollerNodeId,
  };
  await enablePublication(identity);
  const cutoverInput = {
    ...base,
    bookingId: 2791811,
    requestId: 40288117,
    attemptKind: "pending_request" as const,
    cutoverEpoch: identity.epoch,
  };
  const cutoverPublished = await publishAutoAcceptJob(cutoverInput);
  const cutoverJob = publishedJob(cutoverPublished);
  assert.equal(cutoverJob.cutoverEpoch, identity.epoch);
  assert.equal(cutoverJob.publicationGeneration, 1);

  const fenced = await fencePublication(identity);
  assert.equal(fenced.fenceJobId, cutoverJob.id);
  const blocked = await publishAutoAcceptJob({
    ...cutoverInput,
    requestId: 40288118,
  });
  assert.deepEqual(blocked, { published: false, reason: "publication-fenced" });

  getRawMemoryDb().prepare(`
    UPDATE auto_accept_jobs
    SET status = 'succeeded', result_status = 'owned', completed_at = datetime('now')
    WHERE id = ?
  `).run(cutoverJob.id);
  await acknowledgePublicationFence({
    ...identity,
    ackJobId: fenced.fenceJobId ?? 0,
  });
  await advancePublicationEpoch({
    teamId: identity.teamId,
    previousEpoch: identity.epoch,
    nextEpoch: "phase3-ifn-20300204",
    nextPollerNodeId: identity.pollerNodeId,
  });
  const stale = await publishAutoAcceptJob({
    ...cutoverInput,
    requestId: 40288119,
  });
  assert.deepEqual(stale, { published: false, reason: "stale-publication-epoch" });

  await closePool();
  console.log("auto-accept-job-publisher: all assertions passed");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    mutableEnv.AUTO_ACCEPT_JOB_SHADOW_ENABLED = original.AUTO_ACCEPT_JOB_SHADOW_ENABLED;
    if (original.processValue === undefined) {
      delete process.env.AUTO_ACCEPT_JOB_SHADOW_ENABLED;
    } else {
      process.env.AUTO_ACCEPT_JOB_SHADOW_ENABLED = original.processValue;
    }
  });
