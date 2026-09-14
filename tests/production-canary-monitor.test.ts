import assert from "node:assert/strict";

import {
  evaluateProductionCanarySample,
  renewProductionMonitorLease,
  runProductionMonitorOnce,
} from "../scripts/production-canary-monitor.mjs";

const sample = {
  releaseEnvironment: "production",
  runtimeEnvironment: "production",
  drillMode: "supervised-production",
  composeProject: "spx-production",
  candidateImageDigest: `sha256:${"a".repeat(64)}`,
  observedImageDigests: [`sha256:${"a".repeat(64)}`],
  readiness: true,
  latencyMs: 50,
  queueOldestMs: 100,
  outboxOldestMs: 100,
  leaseStaleCount: 0,
  missingLeaseTeamIds: [],
  allowedMissingLeaseTeamIds: [],
  cpuPercent: 20,
  memoryPercent: 40,
  diskPercent: 30,
  inodePercent: 20,
  mysqlConnectionPercent: 15,
};
const thresholds = {
  maxLatencyMs: 500,
  maxQueueOldestMs: 5_000,
  maxOutboxOldestMs: 5_000,
  maxCpuPercent: 90,
  maxMemoryPercent: 90,
  maxDiskPercent: 85,
  maxInodePercent: 85,
  maxMysqlConnectionPercent: 80,
};

assert.deepEqual(evaluateProductionCanarySample(sample, thresholds), { ok: true, reasons: [] });
assert.equal(evaluateProductionCanarySample({ ...sample, composeProject: "default" }, thresholds).ok, false);
assert.equal(evaluateProductionCanarySample({
  ...sample,
  observedImageDigests: [`sha256:${"b".repeat(64)}`],
}, thresholds).ok, false);
assert.equal(evaluateProductionCanarySample({ ...sample, readiness: false }, thresholds).ok, false);
assert.equal(evaluateProductionCanarySample({
  ...sample,
  missingLeaseTeamIds: [1, 2],
}, thresholds).ok, false, "no required worker lease may be treated as green");
assert.equal(evaluateProductionCanarySample({
  ...sample,
  missingLeaseTeamIds: [2],
  allowedMissingLeaseTeamIds: [2],
}, thresholds).ok, true, "an explicitly consumed handoff may tolerate only its team");

async function main(): Promise<void> {
  const renewals: unknown[] = [];
  await renewProductionMonitorLease({
    repository: { async renewLease(value: unknown) { renewals.push(value); } },
    gate6Id: "gate6-prod-001",
    sample,
    thresholds,
    now: new Date("2026-07-11T01:00:00.000Z"),
    ttlMs: 15_000,
  });
  assert.deepEqual(renewals, [{
    gate6Id: "gate6-prod-001",
    lease: "monitor",
    status: "green",
    expiresAt: "2026-07-11T01:00:15.000Z",
    now: new Date("2026-07-11T01:00:00.000Z"),
  }]);
  const once = await runProductionMonitorOnce({
    context: {
      gate6Id: "gate6-prod-001",
      candidateImageDigest: sample.candidateImageDigest,
      composeProject: "spx-production",
    },
    thresholds,
    probe: async () => ({
      ok: true,
      readiness: true,
      latencyMs: 50,
      queueOldestMs: 100,
      outboxOldestMs: 100,
      leaseStaleCount: 0,
      missingLeaseTeamIds: [],
      mysqlConnectionPercent: 15,
    }),
    inventory: async () => [sample.candidateImageDigest],
    hostMetrics: async () => ({ cpuPercent: 20, memoryPercent: 40, diskPercent: 30, inodePercent: 20 }),
    repository: { async renewLease(value: unknown) { renewals.push(value); } },
    handoffWindow: async () => ({ allowedMissingTeamIds: [] }),
    now: new Date("2026-07-11T01:00:30.000Z"),
  });
  assert.equal(once.result.ok, true);
  assert.equal(once.evidence.status, "green");
  console.log("production canary monitor tests passed");
}

void main();
