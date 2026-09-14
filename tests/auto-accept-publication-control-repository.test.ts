import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import {
  acknowledgePublicationFence,
  advancePublicationEpoch,
  assertPublicationEnabled,
  enablePublication,
  fencePublication,
  getActivePublicationEpoch,
  getPublicationControlHistory,
  getPublicationJobWatermark,
} from "../src/repositories/auto-accept-publication-control-repository.js";

const firstIdentity = {
  teamId: 2,
  epoch: "phase3-ifn-20260710",
  pollerNodeId: "poller-ifn-1",
};

const nextIdentity = {
  teamId: 2,
  previousEpoch: firstIdentity.epoch,
  nextEpoch: "phase3-ifn-20260711",
  nextPollerNodeId: "poller-ifn-2",
};

async function resetDb(): Promise<void> {
  await closePool();
  resetMemoryDb();
}

function insertJob(input: {
  epoch: string;
  generation: number;
  status: string;
  resultStatus?: string | null;
  completedAt?: string | null;
}): number {
  const db = getRawMemoryDb();
  const result = db.prepare(`
    INSERT INTO auto_accept_jobs (
      idempotency_key, schema_version, team_id, cutover_epoch,
      publication_generation, booking_id, request_id, rule_id, attempt_kind,
      status, payload_json, max_attempts, next_run_at, result_status,
      created_at, updated_at, completed_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'pending_request', ?, '{}', 3,
      datetime('now'), ?, datetime('now'), datetime('now'), ?)
  `).run(
    `fixture-${input.epoch}-${input.status}-${Math.random()}`,
    firstIdentity.teamId,
    input.epoch,
    input.generation,
    100,
    Math.floor(Math.random() * 1_000_000) + 1,
    "rule-fixture",
    input.status,
    input.resultStatus ?? null,
    input.completedAt ?? null,
  );
  return Number(result.lastInsertRowid);
}

async function fenceAndAcknowledge(): Promise<void> {
  const fenced = await fencePublication(firstIdentity);
  const watermark = await getPublicationJobWatermark({
    teamId: firstIdentity.teamId,
    epoch: firstIdentity.epoch,
    publicationGeneration: fenced.publicationGeneration,
  });
  assert.equal(watermark, fenced.fenceJobId);
  await acknowledgePublicationFence({
    ...firstIdentity,
    ackJobId: watermark,
  });
}

async function main(): Promise<void> {
  await resetDb();

  const enabled = await enablePublication(firstIdentity);
  assert.equal(enabled.state, "enabled");
  assert.equal(enabled.publicationGeneration, 1);
  assert.deepEqual(
    await enablePublication(firstIdentity),
    enabled,
    "same team/epoch/node enable is idempotent",
  );
  await assert.rejects(
    () => enablePublication({ ...firstIdentity, epoch: "phase3-other" }),
    /advance required/,
  );
  await assert.rejects(
    () => enablePublication({ ...firstIdentity, pollerNodeId: "other-poller" }),
    /poller node mismatch/,
  );

  const firstJobId = insertJob({
    epoch: firstIdentity.epoch,
    generation: enabled.publicationGeneration,
    status: "succeeded",
    resultStatus: "owned",
    completedAt: "2030-01-01 00:00:00",
  });
  const fenced = await fencePublication(firstIdentity);
  assert.equal(fenced.state, "fenced");
  assert.equal(fenced.fenceJobId, firstJobId);
  await assert.rejects(() => assertPublicationEnabled(firstIdentity), /publication fenced/);
  await assert.rejects(
    () => acknowledgePublicationFence({ ...firstIdentity, ackJobId: firstJobId - 1 }),
    /behind fence/,
  );
  const acknowledged = await acknowledgePublicationFence({
    ...firstIdentity,
    ackJobId: firstJobId,
  });
  assert.equal(acknowledged.ackNodeId, firstIdentity.pollerNodeId);
  assert.equal(acknowledged.ackJobId, firstJobId);

  const advanced = await advancePublicationEpoch(nextIdentity);
  assert.equal(advanced.publicationGeneration, 2);
  assert.equal(advanced.epoch, nextIdentity.nextEpoch);
  assert.deepEqual(await getActivePublicationEpoch(firstIdentity.teamId), {
    teamId: firstIdentity.teamId,
    activeEpoch: nextIdentity.nextEpoch,
    activeGeneration: 2,
  });
  const history = await getPublicationControlHistory(firstIdentity.teamId);
  assert.equal(history.length, 2, "epoch advance preserves immutable history");
  assert.equal(history[0]?.epoch, firstIdentity.epoch);
  assert.equal(history[1]?.epoch, nextIdentity.nextEpoch);
  await assert.rejects(() => assertPublicationEnabled(firstIdentity), /stale publication epoch/);
  await assert.rejects(
    () => advancePublicationEpoch(nextIdentity),
    /active epoch changed/,
  );

  for (const blocked of [
    { status: "pending" },
    { status: "retrying" },
    { status: "claimed" },
    { status: "verifying" },
    { status: "indeterminate" },
    { status: "succeeded", resultStatus: "unknown", completedAt: "2030-01-01 00:00:00" },
    { status: "verifying", resultStatus: "owned", completedAt: null },
  ]) {
    await resetDb();
    const control = await enablePublication(firstIdentity);
    insertJob({
      epoch: firstIdentity.epoch,
      generation: control.publicationGeneration,
      status: blocked.status,
      resultStatus: blocked.resultStatus,
      completedAt: blocked.completedAt,
    });
    await fenceAndAcknowledge();
    await assert.rejects(
      () => advancePublicationEpoch(nextIdentity),
      /prior publication epoch has work/,
      `advance must reject ${JSON.stringify(blocked)}`,
    );
  }

  await resetDb();
  await enablePublication(firstIdentity);
  await assert.rejects(() => advancePublicationEpoch(nextIdentity), /not fenced/);

  await closePool();
  console.log("auto-accept-publication-control-repository: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
