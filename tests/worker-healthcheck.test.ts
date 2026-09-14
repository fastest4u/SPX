import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWorkerHealthSql,
  evaluateWorkerHealth,
  readSpoolHealthSummary,
} from "../scripts/worker-healthcheck.mjs";

const healthy = {
  processAlive: true,
  nodeHeartbeatAgeMs: 5_000,
  metricsHeartbeatAgeMs: 4_000,
  recentMetricsFailures: 0,
  expectedTeamIds: [2],
  leases: [{ teamId: 2, ownerNodeId: "stg-worker-ifn", active: true, heartbeatAgeMs: 4_000 }],
  desiredStates: [{ teamId: 2, state: "running" }],
  spool: { pendingCount: 0, bytes: 0, oldestPendingAgeMs: null },
  outbox: { pendingCount: 0, oldestPendingAgeMs: null, watermark: 120, lastProgressAgeMs: null },
  nodeId: "stg-worker-ifn",
  maxAgeMs: 45_000,
  maxPendingCount: 100,
  maxSpoolBytes: 10_000_000,
};

assert.deepEqual(evaluateWorkerHealth(healthy), { ok: true, failures: [] });
assert.deepEqual(
  evaluateWorkerHealth({ ...healthy, nodeHeartbeatAgeMs: 46_000 }).failures,
  ["NODE_HEARTBEAT_STALE"],
);
assert.deepEqual(evaluateWorkerHealth({ ...healthy, leases: [] }).failures, [
  "EXPECTED_TEAM_LEASE_MISSING",
]);
assert.deepEqual(
  evaluateWorkerHealth({ ...healthy, metricsHeartbeatAgeMs: 46_000 }).failures,
  ["METRICS_HEARTBEAT_STALE"],
);
assert.deepEqual(
  evaluateWorkerHealth({ ...healthy, recentMetricsFailures: 1 }).failures,
  ["RECENT_METRICS_FAILURE"],
);
assert.equal(
  evaluateWorkerHealth({
    ...healthy,
    outbox: { ...healthy.outbox, lastProgressAgeMs: 300_000 },
  }).ok,
  true,
);
assert.deepEqual(
  evaluateWorkerHealth({
    ...healthy,
    spool: { pendingCount: 3, bytes: 1_024, oldestPendingAgeMs: 90_000 },
    outbox: { pendingCount: 2, oldestPendingAgeMs: 90_000, watermark: 120, lastProgressAgeMs: 90_000 },
  }).failures,
  ["DURABLE_WORK_STALLED"],
);
assert.deepEqual(
  evaluateWorkerHealth({
    ...healthy,
    desiredStates: [{ teamId: 2, state: "paused" }],
    leases: [],
  }),
  { ok: true, failures: [] },
);

const spoolRoot = mkdtempSync(join(tmpdir(), "spx-worker-health-spool-"));
try {
  const spoolPath = join(spoolRoot, "notification-spool.jsonl");
  const spoolBytes = Buffer.byteLength("opaque-payload-bytes\n");
  writeFileSync(spoolPath, "opaque-payload-bytes\n", "utf8");
  writeFileSync(
    `${spoolPath}.health.json`,
    JSON.stringify({
      schemaVersion: 1,
      pendingCount: 1,
      spoolBytes,
      oldestPendingAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:01.000Z",
    }),
    "utf8",
  );
  assert.deepEqual(readSpoolHealthSummary(spoolPath, Date.parse("2026-07-11T00:00:10.000Z")), {
    pendingCount: 1,
    bytes: spoolBytes,
    oldestPendingAgeMs: 10_000,
  });
  writeFileSync(
    `${spoolPath}.health.json`,
    JSON.stringify({
      schemaVersion: 1,
      pendingCount: 1,
      spoolBytes: spoolBytes - 1,
      oldestPendingAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:01.000Z",
    }),
    "utf8",
  );
  assert.throws(() => readSpoolHealthSummary(spoolPath, Date.now()), /mismatch|stale/i);
} finally {
  rmSync(spoolRoot, { recursive: true, force: true });
}

const sql = buildWorkerHealthSql();
assert.match(sql.node, /runtime_nodes/);
assert.match(sql.leases, /team_runtime_desired_state[\s\S]*team_runtime_leases/);
assert.match(sql.metrics, /realtime_metrics_read_models/);
assert.match(sql.outbox, /notification_outbox/);
assert.doesNotMatch(Object.values(sql).join("\n"), /payload_json|message|target_id|last_error/i);

console.log("worker health evaluator tests passed");
