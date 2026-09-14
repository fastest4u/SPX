import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { publishAutoAcceptJob, type PublishAutoAcceptJobInput } from "../src/services/auto-accept-job-publisher.js";
import { runAutoAcceptJobRealExecutionBatch } from "../src/services/auto-accept-job-real-execution.js";
import { runAutoAcceptJobDryRunBatch } from "../src/services/auto-accept-job-dry-run.js";
import { buildAutoAcceptJobIdempotencyKey, enqueueAutoAcceptJob, getAutoAcceptJobById } from "../src/repositories/auto-accept-job-repository.js";
import { beginAutoAcceptAttempt, getAutoAcceptAttemptByTraceId } from "../src/repositories/auto-accept-result-repository.js";
import { enablePublication } from "../src/repositories/auto-accept-publication-control-repository.js";
import { createRule } from "../src/services/notify-rules.js";
import { runAutoAcceptJobSettlementBatch } from "../src/services/auto-accept-job-settlement.js";

const state = { need: 2, accept_all: false, enabled: true, fulfilled: false };
const now = new Date("2035-01-01T00:01:00Z");
async function setup(): Promise<PublishAutoAcceptJobInput> {
  await closePool(); resetMemoryDb();
  const rule = await createRule(1, { name: "Admission rule", origins: ["A"], destinations: ["B"], ...state });
  return { teamId: 1, bookingId: 700, requestId: 701, ruleId: rule.id, ruleName: rule.name,
    attemptKind: "pending_request", acceptAll: false, source: "pending_tab", pollerNodeId: "test-poller",
    observedAt: new Date("2035-01-01T00:00:00Z"), ruleSnapshot: state };
}
async function publish(input: PublishAutoAcceptJobInput) {
  const result = await publishAutoAcceptJob(input);
  assert.equal(result.published, true);
  if (!result.published) throw new Error(result.reason);
  return result.job;
}
function worker() {
  const calls: string[] = [];
  return { calls, run: () => runAutoAcceptJobRealExecutionBatch({
    ownerNodeId: "real-admission-worker", teamIds: [1], limit: 10, leaseMs: 60_000, now,
    loadRuleState: () => state,
    apiClient: {
      acceptBookingRequests: async () => { calls.push("accept"); return { ok: true, httpStatus: 200, response: { retcode: 0 } }; },
      fetchBookingRequestList: async (_id, options) => { calls.push("read"); return { data: { request_list: options?.tabPendingConfirmation === false ? [{ request_id: 701, booking_id: 700, request_acceptance_status: 2 }] : [] } }; },
    },
  }) };
}
function count(table: "auto_accept_attempts" | "auto_accept_job_settlements") {
  return (getRawMemoryDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
async function legacy(input: PublishAutoAcceptJobInput) {
  const identity = { teamId: input.teamId, bookingId: input.bookingId, requestId: input.requestId,
    ruleId: input.ruleId, attemptKind: input.attemptKind, ...(input.cutoverEpoch ? { cutoverEpoch: input.cutoverEpoch } : {}) };
  return enqueueAutoAcceptJob({ ...identity, observedAt: input.observedAt,
    payload: { ...input, schemaVersion: 1, observedAt: input.observedAt!.toISOString(), idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity) } });
}

async function main() {
  for (const controlled of [false, true]) {
    const input = await setup();
    if (controlled) {
      input.cutoverEpoch = "admission-epoch";
      await enablePublication({ teamId: 1, epoch: input.cutoverEpoch, pollerNodeId: input.pollerNodeId });
    }
    const shadow = await publish(input);
    const execution = worker();
    const result = await execution.run();
    assert.equal(result.claimed, 1);
    assert.deepEqual(execution.calls, [], "default shadow must be rejected even with a current publication epoch");
    assert.equal(count("auto_accept_attempts"), 0);
    assert.equal(count("auto_accept_job_settlements"), 0);
    assert.equal((await getAutoAcceptJobById(shadow.id))?.lastReasonCode, "shadow_job_not_executable");
  }

  let input = await setup();
  await publish(input);
  const dry = await runAutoAcceptJobDryRunBatch({ ownerNodeId: "dry-observer", teamIds: [1], limit: 1, leaseMs: 60_000, now });
  assert.equal(dry.cancelled, 1, "dry-run workers can still observe and validate shadow jobs");

  input = await setup();
  const old = await legacy(input);
  const marker = await beginAutoAcceptAttempt({ teamId: 1, bookingId: 700, requestIds: [701], ruleId: input.ruleId,
    ruleName: input.ruleName, traceId: "legacy-admission-evidence", workerNodeId: "historical-worker",
    acceptMode: "request_ids", acceptStartedAt: input.observedAt! });
  getRawMemoryDb().prepare("UPDATE auto_accept_jobs SET winning_attempt_trace_id = ? WHERE id = ?").run(marker.row.traceId, old.id);
  const oldWorker = worker();
  assert.equal((await oldWorker.run()).indeterminate, 1);
  assert.deepEqual(oldWorker.calls, [], "ambiguous historical null-epoch jobs require reconciliation before any provider activity");
  const quarantined = await getAutoAcceptJobById(old.id);
  assert.equal(quarantined?.lastReasonCode, "legacy_job_admission_ambiguous");
  assert.equal(quarantined?.payloadJson, old.payloadJson);
  assert.equal(quarantined?.winningAttemptTraceId, "legacy-admission-evidence");
  assert.ok(await getAutoAcceptAttemptByTraceId("legacy-admission-evidence"));
  const conflict = await publishAutoAcceptJob({ ...input, executionMode: "cutover" });
  assert.deepEqual(conflict, { published: false, reason: "admission-conflict" }, "old ambiguous rows cannot be promoted by duplicate enqueue");

  input = await setup();
  const executable = await publish({ ...input, executionMode: "cutover" });
  const intentional = worker();
  assert.equal((await intentional.run()).claimed, 1);
  assert.equal(intentional.calls.filter((call) => call === "accept").length, 1, "explicit supervised no-epoch cutover remains executable");
  assert.equal((await publish({ ...input, executionMode: "cutover" })).id, executable.id);

  input = await setup();
  input.cutoverEpoch = "historical-controlled";
  await enablePublication({ teamId: 1, epoch: input.cutoverEpoch, pollerNodeId: input.pollerNodeId });
  await legacy(input);
  const controlledLegacy = worker();
  assert.equal((await controlledLegacy.run()).indeterminate, 1);
  assert.deepEqual(controlledLegacy.calls, [], "a historical current epoch proves producer binding, not execution intent");

  for (const mode of ["legacy", "shadow"] as const) {
    input = await setup();
    const checkpoint = mode === "legacy" ? await legacy(input) : await publish(input);
    getRawMemoryDb().prepare(`UPDATE auto_accept_jobs SET status = 'retrying', result_status = 'owned',
      result_reason_code = 'verified_owned', winning_attempt_trace_id = 'historical-checkpoint',
      progress_settled_at = '2035-01-01 00:00:10', next_run_at = '2035-01-01 00:00:20' WHERE id = ?`).run(checkpoint.id);
    const before = (await getAutoAcceptJobById(checkpoint.id))!;
    const accounting: string[] = [];
    await runAutoAcceptJobSettlementBatch({ ownerNodeId: "settlement-admission", teamIds: [1], limit: 1, leaseMs: 60_000, now,
      operations: { settleProgress: async () => { accounting.push("progress"); }, writeHistory: async () => { accounting.push("history"); }, enqueueNotification: async () => { accounting.push("notification"); } } });
    assert.deepEqual(accounting, [], "unadmitted checkpoint rows must stop before accounting or notification");
    const after = (await getAutoAcceptJobById(checkpoint.id))!;
    assert.equal(after.resultStatus, before.resultStatus);
    assert.equal(after.resultReasonCode, before.resultReasonCode);
    assert.equal(after.winningAttemptTraceId, before.winningAttemptTraceId);
    assert.deepEqual(after.progressSettledAt, before.progressSettledAt);
    assert.equal(after.payloadJson, before.payloadJson);
    assert.equal(after.lastReasonCode, mode === "shadow" ? "shadow_job_not_executable" : "legacy_job_admission_ambiguous");
  }

  input = await setup();
  input.cutoverEpoch = "intentional-controlled";
  await enablePublication({ teamId: 1, epoch: input.cutoverEpoch, pollerNodeId: input.pollerNodeId });
  const controlled = await publish({ ...input, executionMode: "cutover" });
  const actualExecution = worker();
  await actualExecution.run();
  assert.equal(actualExecution.calls.filter((call) => call === "accept").length, 1);
  const settlementCalls: string[] = [];
  const settled = await runAutoAcceptJobSettlementBatch({ ownerNodeId: "controlled-settlement", teamIds: [1], limit: 1, leaseMs: 60_000,
    now: new Date(now.getTime() + 1_000),
    operations: { settleProgress: async () => { settlementCalls.push("progress"); }, writeHistory: async () => { settlementCalls.push("history"); }, enqueueNotification: async () => { settlementCalls.push("notification"); } } });
  assert.equal(settled.succeeded, 1, "explicit controlled jobs must preserve epoch identity through settlement");
  assert.equal(settlementCalls.length, 3);
  assert.equal((await getAutoAcceptJobById(controlled.id))?.status, "succeeded");
  console.log("auto-accept job admission passed");
}
main().finally(closePool).catch((error) => { console.error(error); process.exitCode = 1; });
