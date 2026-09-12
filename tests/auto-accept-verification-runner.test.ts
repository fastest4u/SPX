import assert from "node:assert/strict";
import { AutoAcceptVerificationRunner, verificationHoldCount } from "../src/services/auto-accept-verification-runner.js";
import { createAutoAcceptVerificationIntent, updateAutoAcceptVerificationResponse, listAutoAcceptVerificationJobs } from "../src/repositories/auto-accept-verification-repository.js";
import type { AutoAcceptVerificationJob } from "../src/services/auto-accept-verifier.js";
import type { ApiClient } from "../src/services/api-client.js";
import { closePool } from "../src/db/client.js";

const job: AutoAcceptVerificationJob = {
  teamId: 1, ruleId: "recovery-rule", ruleName: "Recovery", bookingId: 987654,
  requestIds: [101, 102], trips: [{ request_id: 101 }, { request_id: 102 }], claimToken: 0,
  acceptResult: { ok: true, httpStatus: 200 }, acceptStartedAt: 1, acceptFinishedAt: 2,
  acceptRttMs: 1, ambiguousAccept: false, acceptAll: false, traceId: "recovery-test",
};
const list = (request_id: number) => ({ retcode: 0, message: "", data: { pageno: 1, count: 1, total: 1,
  request_list: [{ request_id, booking_id: job.bookingId, request_acceptance_status: 2 }] } });

async function main() {
  const { getDb } = await import("../src/db/client.js");
  const { notifyRules } = await import("../src/db/schema.js");
  await getDb().insert(notifyRules).values({ id: job.ruleId, teamId: 1, name: job.ruleName,
    origins: "[]", destinations: "[]", vehicleTypes: "[]", need: 2 });
  await createAutoAcceptVerificationIntent(job);
  await updateAutoAcceptVerificationResponse(job);
  const [record] = await listAutoAcceptVerificationJobs(1);
  assert.equal(verificationHoldCount({ ...record!, job: { ...job, reservationCount: 5,
    discovery: { bookingName: "A > B", expectedAcceptedCount: 5, verifiedRequestIds: [101] } },
    unresolvedRequestIds: [], discoveryPending: true }), 4,
    "unknown accept_all siblings must reserve all four acknowledged remaining wins");
  let reads = 0;
  let phase = 0;
  let mayRun = true;
  const client = {
    fetchBookingRequestList: async (_id: number, options: { tabPendingConfirmation?: boolean }) => {
      reads++;
      if (phase === 0) return options.tabPendingConfirmation ? list(101) : null;
      return options.tabPendingConfirmation ? list(101) : list(102);
    },
    acceptBookingRequests: async () => assert.fail("recovery must never replay acceptance"),
  } as unknown as ApiClient;
  const published: number[][] = [];
  const runner = new AutoAcceptVerificationRunner(1, client, {
    canRun: () => mayRun,
    onHold: () => {},
    onSettled: () => {},
    publish: async (outcome) => { published.push(outcome.acceptedRequestIds); return true; },
  }, { retryDelayMs: 1, jitter: () => 0 });
  await runner.restore();
  await runner.runDue();
  await runner.idle();
  assert.equal(reads, 2);
  assert.deepEqual(published, [[101]]);
  assert.deepEqual((await listAutoAcceptVerificationJobs(1))[0]?.unresolvedRequestIds, [102]);
  assert.equal((runner as unknown as { records: Map<string, unknown> }).records.size, 1,
    "unresolved work remains in the in-process admission index");
  await runner.stop();

  // A fresh worker restores the same durable intent and never repeats the POST.
  phase = 1;
  const restarted = new AutoAcceptVerificationRunner(1, client, {
    canRun: () => mayRun, onHold: () => {}, onSettled: () => {},
    publish: async (outcome) => { published.push(outcome.acceptedRequestIds); return true; },
  }, { retryDelayMs: 1, jitter: () => 0 });
  await restarted.restore();
  mayRun = false;
  await restarted.runDue(Date.now() + 1000);
  assert.equal(reads, 2, "paused worker makes no provider reads");
  mayRun = true;
  await restarted.runDue(Date.now() + 1000);
  await restarted.idle();
  assert.deepEqual(published, [[101], [102]], "only newly resolved siblings are notified");
  assert.equal((restarted as unknown as { records: Map<string, unknown> }).records.size, 0,
    "completed durable jobs must be evicted so the admission index does not grow with history");
  assert.equal(restarted.hasPending(job.bookingId), false);
  await restarted.runDue(Date.now() + 2000);
  assert.deepEqual(published, [[101], [102]]);
  const rows = await getDb().select().from(notifyRules);
  assert.equal(rows[0].need, 0, "progress was applied once per request");
  await restarted.stop();
  await closePool();
  console.log("verification runner: recovery, partial settlement, pause and no POST replay passed");
}
main().catch(error => { console.error(error); process.exit(1); });
