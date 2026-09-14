import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  beginAutoAcceptAttempt,
  completeAutoAcceptAttempt,
  getAutoAcceptAttemptByTraceId,
} from "../src/repositories/auto-accept-result-repository.js";

async function main() {
  await closePool();
  resetMemoryDb();
  const identity = {
    traceId: "lifecycle-race",
    teamId: 2,
    workerNodeId: "first-worker",
    bookingId: 123,
    requestIds: [456],
    ruleId: "rule-1",
    ruleName: "Original rule",
    acceptMode: "request_ids" as const,
    acceptStartedAt: new Date("2030-01-01T00:00:00Z"),
  };
  await beginAutoAcceptAttempt(identity);
  const outcomes = await Promise.all([
    completeAutoAcceptAttempt({ ...identity, acceptFinishedAt: new Date("2030-01-01T00:00:01Z"), spxMessage: "first" }),
    completeAutoAcceptAttempt({ ...identity, acceptFinishedAt: new Date("2030-01-01T00:00:02Z"), spxMessage: "second" }),
  ]);
  assert.deepEqual(outcomes.map((result) => result.kind).sort(), ["completed", "idempotent"]);
  const winner = outcomes.find((result) => result.kind === "completed")!;
  assert.equal((await getAutoAcceptAttemptByTraceId(identity.traceId))?.spxMessage, winner.row.spxMessage);
  assert.equal(outcomes[0].row.spxMessage, outcomes[1].row.spxMessage);
  await assert.rejects(beginAutoAcceptAttempt({ ...identity, ruleId: "different-rule" }), /identity_conflict/);
  await assert.rejects(completeAutoAcceptAttempt({ ...identity, ruleName: "Changed rule", acceptFinishedAt: new Date() }), /identity_conflict/);
  await beginAutoAcceptAttempt({ ...identity, traceId: "unfinished" });
  await assert.rejects(completeAutoAcceptAttempt({ ...identity, traceId: "unfinished" }), /acceptFinishedAt/);
  const all = await beginAutoAcceptAttempt({ ...identity, traceId: "accept-all", acceptMode: "accept_all", requestIds: [] });
  assert.equal(all.kind, "created");
  assert.equal(all.row.requestIdsJson, "[]");
  await closePool();
  console.log("Auto-accept marker lifecycle passed");
}

main().catch(async (error) => { console.error(error); await closePool(); process.exitCode = 1; });
