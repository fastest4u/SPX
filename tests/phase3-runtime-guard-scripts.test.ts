import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  evaluatePhase3RuntimeConfidence,
} from "../scripts/phase3-runtime-confidence-check.mjs";
import {
  evaluatePhase3RollbackGuard,
} from "../scripts/phase3-rollback-guard.mjs";

const confidenceInput = {
  expectedTeamIds: [1, 2],
  pollerNodeId: "poller-phase3-01",
  autoAcceptNodeId: "auto-phase3-01",
  expectedAutoAcceptModes: ["autoAcceptReal", "autoAcceptSettlement"],
  maxAgeMs: 120_000,
  nodes: [
    {
      nodeId: "poller-phase3-01",
      role: "poller-service",
      heartbeatAgeMs: 10_000,
      metadataJson: JSON.stringify({
        assignedTeamIds: [2, 1],
        enabledLoopModes: ["poller"],
        secret: "must-not-be-projected",
      }),
    },
    {
      nodeId: "auto-phase3-01",
      role: "auto-accept-service",
      heartbeatAgeMs: 12_000,
      metadataJson: JSON.stringify({
        assignedTeamIds: [1, 2],
        enabledLoopModes: ["autoAcceptSettlement", "autoAcceptReal"],
      }),
    },
  ],
  leases: [
    {
      teamId: 1,
      ownerNodeId: "poller-phase3-01",
      ownerRole: "poller-service",
      status: "running",
      heartbeatAgeMs: 5_000,
      leaseActive: true,
    },
    {
      teamId: 2,
      ownerNodeId: "poller-phase3-01",
      ownerRole: "poller-service",
      status: "running",
      heartbeatAgeMs: 6_000,
      leaseActive: true,
    },
  ],
  metrics: [
    { teamId: 1, sourceNodeId: "poller-phase3-01", ageMs: 8_000 },
    { teamId: 2, sourceNodeId: "poller-phase3-01", ageMs: 9_000 },
  ],
};

const confidence = evaluatePhase3RuntimeConfidence(confidenceInput);
assert.deepEqual(confidence, {
  ok: true,
  expectedTeamIds: [1, 2],
  pollerNodeId: "poller-phase3-01",
  autoAcceptNodeId: "auto-phase3-01",
  expectedAutoAcceptModes: ["autoAcceptReal", "autoAcceptSettlement"],
  freshPollerLeases: 2,
  freshMetricsRecords: 2,
  failures: [],
});
assert.equal(JSON.stringify(confidence).includes("must-not-be-projected"), false);

const staleConfidence = evaluatePhase3RuntimeConfidence({
  ...confidenceInput,
  nodes: confidenceInput.nodes.map((node) => (
    node.nodeId === "auto-phase3-01" ? { ...node, heartbeatAgeMs: 120_001 } : node
  )),
  metrics: confidenceInput.metrics.slice(0, 1),
});
assert.equal(staleConfidence.ok, false);
assert.deepEqual(staleConfidence.failures, [
  "AUTO_ACCEPT_HEARTBEAT_STALE",
  "POLLER_METRICS_INCOMPLETE",
]);

const impossibleModes = evaluatePhase3RuntimeConfidence({
  ...confidenceInput,
  nodes: confidenceInput.nodes.map((node) => (
    node.nodeId === "auto-phase3-01"
      ? { ...node, metadataJson: JSON.stringify({ assignedTeamIds: [1, 2], enabledLoopModes: ["poller"] }) }
      : node
  )),
});
assert.equal(impossibleModes.ok, false);
assert.deepEqual(impossibleModes.failures, ["AUTO_ACCEPT_LOOP_MODES_MISMATCH"]);

const outsideAssignment = evaluatePhase3RuntimeConfidence({
  ...confidenceInput,
  leases: [
    ...confidenceInput.leases,
    {
      teamId: 3,
      ownerNodeId: "poller-phase3-01",
      ownerRole: "poller-service",
      status: "running",
      heartbeatAgeMs: 4_000,
      leaseActive: true,
    },
  ],
  metrics: [
    ...confidenceInput.metrics,
    { teamId: 3, sourceNodeId: "poller-phase3-01", ageMs: 7_000 },
  ],
});
assert.equal(outsideAssignment.ok, false);
assert.deepEqual(outsideAssignment.failures, [
  "POLLER_LEASES_OUTSIDE_ASSIGNMENT",
  "POLLER_METRICS_OUTSIDE_ASSIGNMENT",
]);

const scopedRollback = {
  active: { epoch: "phase3-ifn-20260710", generation: 4 },
  expected: {
    epoch: "phase3-ifn-20260710",
    generation: 4,
    pollerNodeId: "poller-phase3-01",
  },
  control: {
    epoch: "phase3-ifn-20260710",
    generation: 4,
    state: "fenced",
    pollerNodeId: "poller-phase3-01",
    fenceJobId: 42,
    ackNodeId: "poller-phase3-01",
    ackJobId: 42,
    acknowledgedAt: "2026-07-10T12:00:00.000Z",
  },
  counts: {
  pending: 0,
  retrying: 0,
  claimed: 0,
  verifying: 0,
  indeterminate: 0,
  unknown: 0,
    settlementPending: 0,
  },
};

assert.deepEqual(evaluatePhase3RollbackGuard(scopedRollback), {
  ok: true,
  failures: [],
});

assert.deepEqual(evaluatePhase3RollbackGuard({
  ...scopedRollback,
  counts: {
    ...scopedRollback.counts,
    pending: 1,
    retrying: 2,
    claimed: 1,
    verifying: 1,
  },
}), {
  ok: false,
  failures: ["LIVE_CLAIMS_PRESENT", "QUEUE_NOT_EMPTY_OR_QUARANTINED"],
});

assert.throws(
  () => evaluatePhase3RollbackGuard({
    ...scopedRollback,
    counts: { ...scopedRollback.counts, pending: -1 },
  }),
  /non-negative integer/,
);

assert.deepEqual(evaluatePhase3RollbackGuard({
  ...scopedRollback,
  counts: { ...scopedRollback.counts, indeterminate: 2, unknown: 1 },
}), {
  ok: false,
  failures: ["INDETERMINATE_WORK_PRESENT", "UNKNOWN_JOB_STATUS_PRESENT"],
});

assert.deepEqual(evaluatePhase3RollbackGuard({
  ...scopedRollback,
  active: { epoch: "phase3-ifn-20260711", generation: 5 },
}).failures, ["ACTIVE_EPOCH_CHANGED"]);

const secret = "db-password-must-not-leak";
const dryRunEnv = {
  ...process.env,
  DB_MODE: "mysql",
  DB_HOST: "mysql.internal",
  DB_USERNAME: "spx",
  DB_PASSWORD: secret,
  DB_NAME: "spx",
};
const confidenceDryRun = spawnSync(process.execPath, [
  resolve(process.cwd(), "scripts/phase3-runtime-confidence-check.mjs"),
  "--dry-run",
  "--poller-node-id=poller-phase3-01",
  "--auto-accept-node-id=auto-phase3-01",
  "--team-ids=1,2",
  "--auto-accept-modes=autoAcceptReal,autoAcceptSettlement",
], { cwd: process.cwd(), env: dryRunEnv, encoding: "utf8" });
assert.equal(confidenceDryRun.status, 0, confidenceDryRun.stderr || confidenceDryRun.stdout);
assert.equal(confidenceDryRun.stdout.includes(secret), false);
assert.equal(JSON.parse(confidenceDryRun.stdout).dryRun, true);

const rollbackDryRun = spawnSync(process.execPath, [
  resolve(process.cwd(), "scripts/phase3-rollback-guard.mjs"),
  "--dry-run",
  "--team-id=2",
  "--epoch=phase3-ifn-20260710",
  "--poller-node-id=poller-phase3-01",
], { cwd: process.cwd(), env: dryRunEnv, encoding: "utf8" });
assert.equal(rollbackDryRun.status, 0, rollbackDryRun.stderr || rollbackDryRun.stdout);
assert.equal(rollbackDryRun.stdout.includes(secret), false);
assert.deepEqual(JSON.parse(rollbackDryRun.stdout), {
  ok: true,
  dryRun: true,
  missingDbEnv: [],
  teamId: 2,
  epoch: "phase3-ifn-20260710",
  pollerNodeId: "poller-phase3-01",
});
