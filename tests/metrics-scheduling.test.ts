import assert from "node:assert/strict";
import { MetricsCollector } from "../src/services/metrics.js";

// Guards the metrics contract the dashboard + operator rely on for diagnosing
// auto-accept latency: the isolated accept-RTT bucket, the detail→first-match
// bucket, and the scheduling counters that reveal concurrency saturation and how
// much redundant re-processing the cooldown is suppressing.

{
  // acceptRtt + detailToFirstMatch operation buckets summarize correctly.
  const m = new MetricsCollector();
  m.recordOperation("acceptRtt", 120);
  m.recordOperation("acceptRtt", 80);
  m.recordOperation("detailToFirstMatch", 300);
  m.recordOperation("autoAcceptVerify", 45);
  m.recordOperation("acceptToVerify", 220);
  m.recordOperation("listAgeMs", 900);

  const snap = m.snapshot();

  assert.equal(snap.operations.acceptRtt.count, 2);
  assert.equal(snap.operations.acceptRtt.avg, 100);
  assert.equal(snap.operations.acceptRtt.min, 80);
  assert.equal(snap.operations.acceptRtt.max, 120);
  assert.equal(snap.operations.acceptRtt.lastMs, 80);

  assert.equal(snap.operations.detailToFirstMatch.count, 1);
  assert.equal(snap.operations.detailToFirstMatch.avg, 300);

  assert.equal(snap.operations.autoAcceptVerify.count, 1);
  assert.equal(snap.operations.autoAcceptVerify.avg, 45);
  assert.equal(snap.operations.acceptToVerify.count, 1);
  assert.equal(snap.operations.acceptToVerify.avg, 220);
  assert.equal(snap.operations.listAgeMs.count, 1);
  assert.equal(snap.operations.listAgeMs.avg, 900);
}

{
  // Scheduling counters accumulate across ticks (launched / skippedConcurrency /
  // skippedCooldown) so the operator can see slot starvation and cooldown savings.
  const m = new MetricsCollector();
  m.recordScheduling({ launched: 5, skippedConcurrency: 2, skippedCooldown: 10 });
  m.recordScheduling({ launched: 3, skippedConcurrency: 0, skippedCooldown: 7 });

  const snap = m.snapshot();
  assert.equal(snap.scheduling.launched, 8);
  assert.equal(snap.scheduling.skippedConcurrency, 2);
  assert.equal(snap.scheduling.skippedCooldown, 17);
}

{
  // Detached auto-accept verification queue metrics expose backlog, active
  // workers, indeterminate outcomes, and terminal failure reasons.
  const m = new MetricsCollector();
  m.recordAutoAcceptVerificationQueued(3);
  m.recordAutoAcceptVerificationActive(2, 1);
  m.recordAutoAcceptVerificationCompleted({
    status: "verified_failed",
    reason: "lost_race",
    verificationLatencyMs: 45,
    acceptToVerifyMs: 220,
  });
  m.recordAutoAcceptVerificationCompleted({
    status: "indeterminate",
    reason: "accept_timeout_ambiguous",
    verificationLatencyMs: 80,
    acceptToVerifyMs: 400,
  });

  const snap = m.snapshot();
  assert.equal(snap.autoAccept.pendingVerificationCount, 1);
  assert.equal(snap.autoAccept.verifiedFailureCount, 1);
  assert.equal(snap.autoAccept.verifiedSuccessCount, 0);
  assert.equal(snap.autoAccept.verification.queued, 1);
  assert.equal(snap.autoAccept.verification.active, 0);
  assert.equal(snap.autoAccept.verification.completed, 2);
  assert.equal(snap.autoAccept.verification.indeterminate, 1);
  assert.equal(snap.autoAccept.verification.maxQueueDepth, 3);
  assert.equal(snap.autoAccept.verification.failuresByReason.lost_race, 1);
  assert.equal(snap.autoAccept.verification.failuresByReason.accept_timeout_ambiguous, 0);
  assert.equal(snap.operations.autoAcceptVerify.count, 2);
  assert.equal(snap.operations.acceptToVerify.count, 2);
}

{
  // Empty buckets stay zeroed (no NaN) so a fresh process renders cleanly.
  const m = new MetricsCollector();
  const snap = m.snapshot();
  assert.equal(snap.operations.acceptRtt.count, 0);
  assert.equal(snap.operations.acceptRtt.avg, 0);
  assert.equal(snap.operations.acceptRtt.lastMs, null);
  assert.equal(snap.operations.autoAcceptVerify.count, 0);
  assert.equal(snap.operations.acceptToVerify.count, 0);
  assert.equal(snap.operations.listAgeMs.count, 0);
  assert.equal(snap.scheduling.launched, 0);
  assert.equal(snap.scheduling.skippedCooldown, 0);
  assert.equal(snap.autoAccept.pendingVerificationCount, 0);
  assert.equal(snap.autoAccept.verification.failuresByReason.lost_race, 0);
}

console.log("metrics-scheduling: all assertions passed");
