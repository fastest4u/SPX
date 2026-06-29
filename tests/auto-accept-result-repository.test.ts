import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { autoAcceptAttempts } from "../src/db/schema.js";
import {
  getAutoAcceptResult,
  insertAutoAcceptAttempt,
  upsertAutoAcceptResult,
} from "../src/repositories/auto-accept-result-repository.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

async function getAttempt(traceId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(autoAcceptAttempts)
    .where(eq(autoAcceptAttempts.traceId, traceId))
    .limit(1);
  return row;
}

async function main() {
  await resetDb();

  const traceId = "aa:2:2791810:40288114-40288115:1893456000000";
  await insertAutoAcceptAttempt({
    traceId,
    teamId: 2,
    workerNodeId: "worker-a",
    bookingId: 2791810,
    requestIds: [40288114, 40288115],
    ruleId: "rule-1",
    ruleName: "Bangkok to Rayong",
    acceptMode: "request_ids",
    acceptStartedAt: new Date("2030-01-01T00:00:00.000Z"),
    acceptFinishedAt: new Date("2030-01-01T00:00:01.250Z"),
    acceptRttMs: 1250,
    spxHttpStatus: 200,
    spxRetcode: 0,
    spxMessage: "accepted",
    rawError: null,
    ambiguousAccept: false,
  });

  const insertedAttempt = await getAttempt(traceId);
  assert.ok(insertedAttempt);
  assert.equal(insertedAttempt.traceId, traceId);
  assert.equal(insertedAttempt.teamId, 2);
  assert.equal(insertedAttempt.workerNodeId, "worker-a");
  assert.equal(insertedAttempt.bookingId, 2791810);
  assert.deepEqual(JSON.parse(insertedAttempt.requestIdsJson), [40288114, 40288115]);
  assert.equal(insertedAttempt.ruleId, "rule-1");
  assert.equal(insertedAttempt.ruleName, "Bangkok to Rayong");
  assert.equal(insertedAttempt.acceptMode, "request_ids");
  assert.equal(insertedAttempt.acceptRttMs, 1250);
  assert.equal(insertedAttempt.spxHttpStatus, 200);
  assert.equal(insertedAttempt.spxRetcode, 0);
  assert.equal(insertedAttempt.spxMessage, "accepted");
  assert.equal(insertedAttempt.rawError, null);
  assert.equal(insertedAttempt.ambiguousAccept, 0);

  await insertAutoAcceptAttempt({
    traceId,
    teamId: 2,
    workerNodeId: "worker-a",
    bookingId: 2791810,
    requestIds: [40288114, 40288115],
    acceptMode: "accept_all",
    acceptStartedAt: new Date("2030-01-01T00:00:00.000Z"),
    acceptFinishedAt: new Date("2030-01-01T00:00:02.000Z"),
    acceptRttMs: 2000,
    spxHttpStatus: 504,
    spxRetcode: null,
    spxMessage: "timeout after post",
    rawError: "socket timed out",
    ambiguousAccept: true,
  });

  const updatedAttempt = await getAttempt(traceId);
  assert.ok(updatedAttempt);
  assert.equal(updatedAttempt.acceptMode, "request_ids");
  assert.equal(updatedAttempt.acceptRttMs, 2000);
  assert.equal(updatedAttempt.spxHttpStatus, 504);
  assert.equal(updatedAttempt.spxRetcode, null);
  assert.equal(updatedAttempt.spxMessage, "timeout after post");
  assert.equal(updatedAttempt.rawError, "socket timed out");
  assert.equal(updatedAttempt.ambiguousAccept, 1);

  await upsertAutoAcceptResult({
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288114,
    winningAttemptTraceId: traceId,
    status: "owned",
    reasonCode: "verified_owned",
    evidence: { source: "test", acceptRttMs: 2000 },
  });

  const owned = await getAutoAcceptResult(2, 2791810, 40288114);
  assert.ok(owned);
  assert.equal(owned.status, "owned");
  assert.equal(owned.reasonCode, "verified_owned");
  assert.equal(owned.winningAttemptTraceId, traceId);
  assert.deepEqual(JSON.parse(owned.evidenceJson ?? "{}"), { source: "test", acceptRttMs: 2000 });
  assert.ok(owned.resolvedAt);

  await upsertAutoAcceptResult({
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288114,
    winningAttemptTraceId: "later-lost",
    status: "lost",
    reasonCode: "verified_not_owned",
    evidence: { source: "later" },
  });

  const stillOwnedAfterLost = await getAutoAcceptResult(2, 2791810, 40288114);
  assert.ok(stillOwnedAfterLost);
  assert.equal(stillOwnedAfterLost.status, "owned");
  assert.equal(stillOwnedAfterLost.reasonCode, "verified_owned");
  assert.equal(stillOwnedAfterLost.winningAttemptTraceId, traceId);

  await upsertAutoAcceptResult({
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288114,
    winningAttemptTraceId: "later-failed",
    status: "failed",
    reasonCode: "verification_api_failure",
    evidence: { source: "later" },
  });

  const stillOwnedAfterFailed = await getAutoAcceptResult(2, 2791810, 40288114);
  assert.ok(stillOwnedAfterFailed);
  assert.equal(stillOwnedAfterFailed.status, "owned");
  assert.equal(stillOwnedAfterFailed.reasonCode, "verified_owned");
  assert.equal(stillOwnedAfterFailed.winningAttemptTraceId, traceId);

  await upsertAutoAcceptResult({
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288115,
    winningAttemptTraceId: "first-lost",
    status: "lost",
    reasonCode: "verified_not_owned",
    evidence: { source: "first" },
  });
  assert.equal((await getAutoAcceptResult(2, 2791810, 40288115))?.status, "lost");

  await upsertAutoAcceptResult({
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288115,
    winningAttemptTraceId: "later-owned",
    status: "owned",
    reasonCode: "verified_owned",
    evidence: { source: "later" },
  });

  const upgraded = await getAutoAcceptResult(2, 2791810, 40288115);
  assert.ok(upgraded);
  assert.equal(upgraded.status, "owned");
  assert.equal(upgraded.reasonCode, "verified_owned");
  assert.equal(upgraded.winningAttemptTraceId, "later-owned");

  await upsertAutoAcceptResult({
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288115,
    winningAttemptTraceId: "post-upgrade-lost",
    status: "lost",
    reasonCode: "verified_not_owned",
    evidence: { source: "post-upgrade" },
  });
  await upsertAutoAcceptResult({
    teamId: 2,
    bookingId: 2791810,
    requestId: 40288115,
    winningAttemptTraceId: "post-upgrade-failed",
    status: "failed",
    reasonCode: "accept_api_error",
    evidence: { source: "post-upgrade" },
  });

  const stillUpgraded = await getAutoAcceptResult(2, 2791810, 40288115);
  assert.ok(stillUpgraded);
  assert.equal(stillUpgraded.status, "owned");
  assert.equal(stillUpgraded.reasonCode, "verified_owned");
  assert.equal(stillUpgraded.winningAttemptTraceId, "later-owned");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
