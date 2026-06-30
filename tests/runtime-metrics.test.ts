process.env.DB_MODE = "memory";

import assert from "node:assert/strict";
import { MetricsCollector, type MetricsSnapshot } from "../src/services/metrics.js";
import {
  clearRuntimeMetricsSnapshots,
  recordRuntimeMetricsSnapshot,
  runtimeMetricsSnapshotFor,
} from "../src/services/runtime-metrics.js";

function workerSnapshot(teamId: number, teamName: string, latencyMs: number, acceptRttMs: number): MetricsSnapshot {
  const collector = new MetricsCollector({ teamId, teamName });
  collector.recordPoll(latencyMs, true, "same", 10);
  collector.recordOperation("acceptRtt", acceptRttMs);
  collector.recordOperation("detailFetch", latencyMs + 10);
  collector.recordRuntimeState({
    activeDetailBookings: 1,
    activeDetailJobs: 2,
    detailConcurrency: 8,
    queuedDetailBookings: teamId,
  });
  return collector.snapshot();
}

async function main(): Promise<void> {
  clearRuntimeMetricsSnapshots();

  const fallback = new MetricsCollector().snapshot();
  const ptwl = workerSnapshot(1, "PTWL", 80, 120);
  const ifn = workerSnapshot(2, "IFN", 100, 180);

  recordRuntimeMetricsSnapshot({ nodeId: "prod-worker-ptwl-1", snapshot: ptwl });
  recordRuntimeMetricsSnapshot({ nodeId: "prod-worker-ifn-1", snapshot: ifn });

  const adminSnapshot = runtimeMetricsSnapshotFor(fallback, null);
  assert.equal(adminSnapshot.polling.totalRequests, 2);
  assert.equal(adminSnapshot.polling.successCount, 2);
  assert.equal(adminSnapshot.operations.acceptRtt.count, 2);
  assert.equal(adminSnapshot.operations.acceptRtt.avg, 150);
  assert.equal(adminSnapshot.operations.acceptRtt.p95, 180);
  assert.equal(adminSnapshot.runtime.activeDetailBookings, 2);
  assert.equal(adminSnapshot.runtime.queuedDetailBookings, 3);

  const teamSnapshot = runtimeMetricsSnapshotFor(fallback, 2);
  assert.equal(teamSnapshot.teamId, 2);
  assert.equal(teamSnapshot.teamName, "IFN");
  assert.equal(teamSnapshot.polling.totalRequests, 1);
  assert.equal(teamSnapshot.operations.acceptRtt.avg, 180);

  clearRuntimeMetricsSnapshots();
  assert.equal(runtimeMetricsSnapshotFor(fallback, null).polling.totalRequests, 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
