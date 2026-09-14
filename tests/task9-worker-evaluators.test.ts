import assert from "node:assert/strict";

import {
  compareWatermarks,
  evaluateDeliveryCounts,
  evaluateRuntimeOwner,
  evaluateWorkerEvidence,
} from "../scripts/lib/task9-worker-evaluators.mjs";

assert.deepEqual(
  evaluateDeliveryCounts({ matchedOutboxRows: 1, success: 1, failed: 0 }, "baseline"),
  { ok: true, failures: [] },
);
assert.equal(
  evaluateDeliveryCounts({ matchedOutboxRows: 1, success: 0, failed: 1 }, "line-down").ok,
  true,
);
assert.equal(
  evaluateDeliveryCounts({ matchedOutboxRows: 1, success: 1, failed: 1 }, "recovery").ok,
  true,
);
assert.deepEqual(
  evaluateDeliveryCounts({ matchedOutboxRows: 2, success: 1, failed: 0 }, "baseline").failures,
  ["OUTBOX_IDENTITY_NOT_UNIQUE"],
);

const owners = [
  { teamId: 2, nodeId: "new-worker", active: true, heartbeatAgeMs: 1_000 },
  { teamId: 2, nodeId: "old-worker", active: false, heartbeatAgeMs: 60_000 },
];
assert.deepEqual(
  evaluateRuntimeOwner(owners, {
    teamId: 2,
    expectedActiveNodeId: "new-worker",
    expectedInactiveNodeId: "old-worker",
    maxHeartbeatAgeMs: 45_000,
  }),
  { ok: true, failures: [] },
);
assert.deepEqual(
  evaluateRuntimeOwner(
    owners.map((row) => (row.nodeId === "old-worker" ? { ...row, active: true } : row)),
    {
      teamId: 2,
      expectedActiveNodeId: "new-worker",
      expectedInactiveNodeId: "old-worker",
      maxHeartbeatAgeMs: 45_000,
    },
  ).failures,
  ["PRIOR_OWNER_STILL_ACTIVE"],
);

const w0 = {
  bookingHistory: 10,
  autoAcceptAttempts: 20,
  autoAcceptResults: 30,
  autoAcceptHistory: 40,
  notificationEvents: 50,
  notificationOutbox: 60,
  metrics: 70,
  duplicateAnomalies: 0,
};
const w1 = { ...w0, bookingHistory: 11, metrics: 71 };
assert.deepEqual(compareWatermarks(w0, w1), { ok: true, failures: [] });
assert.deepEqual(compareWatermarks(w0, { ...w1, duplicateAnomalies: 1 }).failures, [
  "DUPLICATE_OPERATION_ANOMALY",
]);
assert.deepEqual(compareWatermarks(w1, w0).failures, ["WATERMARK_REGRESSED"]);

const handoff = {
  isolationModel: "same-host",
  baseline: { owner: "old-worker", webReady: true, watermark: w0 },
  forward: {
    priorReleased: true,
    owner: "new-worker",
    priorInactive: true,
    metricsFailures: 0,
    watermark: w1,
  },
  reverse: {
    replacementReleased: true,
    owner: "old-worker",
    replacementInactive: true,
    metricsFailures: 0,
    watermark: { ...w1, notificationEvents: 51 },
  },
  final: { webReady: true, duplicateAnomalies: 0 },
};
assert.equal(evaluateWorkerEvidence(handoff).ok, true);
assert.equal(evaluateWorkerEvidence({ ...handoff, isolationModel: "multi-host" }).ok, false);
assert.equal(
  evaluateWorkerEvidence({ ...handoff, note: "host-fault-tolerant HA proof" }).ok,
  false,
);

console.log("Task 9 and worker evaluator tests passed");
