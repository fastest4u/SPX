import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import { AutoAcceptVerificationRunner, verificationHoldCount } from "../src/services/auto-accept-verification-runner.js";
import { NeedBudget } from "../src/services/notifier.js";
import { createAutoAcceptVerificationIntent, updateAutoAcceptVerificationResponse, listAutoAcceptVerificationJobs } from "../src/repositories/auto-accept-verification-repository.js";
import { verifyAutoAcceptJob, type AutoAcceptVerificationJob } from "../src/services/auto-accept-verifier.js";
import type { ApiClient } from "../src/services/api-client.js";

async function main() {
  const db = getRawMemoryDb();
  for (const teamId of [1, 2]) {
    const ruleId = `settled-discovery-${teamId}`;
    db.prepare("INSERT INTO notify_rules (id,team_id,name,need,auto_accept) VALUES (?,?,?,5,1)").run(ruleId, teamId, ruleId);
    const job: AutoAcceptVerificationJob = { teamId, ruleId, ruleName: ruleId, bookingId: 900 + teamId,
      traceId: ruleId, requestIds: [], trips: [], claimToken: 0, reservationCount: 5,
      acceptResult: { ok: true, httpStatus: 200 }, acceptStartedAt: 1, acceptFinishedAt: 2,
      acceptRttMs: 1, ambiguousAccept: false, acceptAll: true,
      discovery: { bookingName: "A-B", expectedAcceptedCount: 2 } };
    await createAutoAcceptVerificationIntent(job);
    await updateAutoAcceptVerificationResponse(job);
    let phase = 0;
    const client = { fetchBookingRequestList: async (_id: number, options: { tabPendingConfirmation?: boolean }) => {
      const rows = options.tabPendingConfirmation ? [] : phase === 0
        ? [{ request_id: 101, request_acceptance_status: 2 }, ...(teamId === 2 ? [{ request_id: 103, request_acceptance_status: 4 }] : [])]
        : [{ request_id: 102, request_acceptance_status: 2 }];
      return { retcode: 0, data: { request_list: rows } };
    }, acceptBookingRequests: async () => assert.fail("verification cannot repeat the POST") } as unknown as ApiClient;
    const published: number[] = [];
    const makeRunner = (budget: NeedBudget) => new AutoAcceptVerificationRunner(teamId, client, {
      canRun: () => true,
      onHold: record => budget.trackVerification(ruleId, record.job.traceId, verificationHoldCount(record)),
      onSettled: (record, accepted) => budget.settleVerification(ruleId, record.job.traceId, accepted.length, verificationHoldCount(record)),
      publish: async outcome => { published.push(...outcome.acceptedRequestIds); return true; },
    }, { retryDelayMs: 1, jitter: () => 0 });
    const first = makeRunner(new NeedBudget());
    await first.runDue();
    await first.idle();
    assert.deepEqual(published, [101]);
    await first.stop();
    phase = 1;
    const budget = new NeedBudget();
    const restarted = makeRunner(budget);
    try {
      await restarted.restore();
      await restarted.runDue(Date.now() + 1000);
      await restarted.idle();
      assert.deepEqual(published, [101, 102], "each owned request is published once across restart");
      assert.equal((await listAutoAcceptVerificationJobs(teamId)).length, 0,
        "accepted and terminal lost IDs absent from later tabs must not reopen discovery");
      const progress = db.prepare("SELECT need FROM notify_rules WHERE id=?").get(ruleId) as { need: number };
      assert.equal(progress.need, 3);
      budget.beginTick();
      assert.equal(budget.claim(ruleId, progress.need, 3).granted, 3, "finished discovery releases the remaining reservation");
    } finally { await restarted.stop(); }

    const historical = await verifyAutoAcceptJob(client, { ...job, requestIds: [101],
      discovery: { ...job.discovery!, verifiedRequestIds: [101] } }, { skipAmbiguousRecheck: true });
    assert.deepEqual(historical.indeterminateRequestIds, [], "persisted ownership proof survives tab disappearance");
    assert.equal(historical.discoveryPending, false);
    assert.equal(historical.evidence.observedStatuses?.[101], null, "historical proof does not fabricate a current tab observation");
  }
  await closePool();
  console.log("discovery settlement survives disappearing tabs and restart for both teams");
}
main().catch(error => { console.error(error); process.exit(1); });
