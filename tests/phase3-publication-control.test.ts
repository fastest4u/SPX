import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";
import { authorizeGate6ForwardMutation } from "../scripts/lib/gate6-controller.mjs";
import {
  createPhase3PublicationMysqlOperations,
  evaluateEpochAdvance,
  evaluateRollbackScope,
  executeGate6Phase3PublicationMutation,
  parseCli,
} from "../scripts/phase3-publication-control.mjs";

const zeroCounts = {
  pending: 0,
  retrying: 0,
  claimed: 0,
  verifying: 0,
  indeterminate: 0,
  unknown: 0,
  settlementPending: 0,
};

const valid = {
  active: { epoch: "phase3-ifn-20260710", generation: 4 },
  expected: {
    epoch: "phase3-ifn-20260710",
    generation: 4,
    pollerNodeId: "poller-1",
  },
  control: {
    epoch: "phase3-ifn-20260710",
    generation: 4,
    state: "fenced",
    pollerNodeId: "poller-1",
    fenceJobId: 42,
    ackNodeId: "poller-1",
    ackJobId: 42,
    acknowledgedAt: "2026-07-10T12:00:00.000Z",
  },
  counts: zeroCounts,
};

assert.deepEqual(evaluateRollbackScope(valid), {
  ok: true,
  failures: [],
});
assert.deepEqual(evaluateRollbackScope({
  ...valid,
  control: { ...valid.control, ackJobId: 41 },
}).failures, ["POLLER_ACK_BEHIND_FENCE"]);
assert.deepEqual(evaluateRollbackScope({
  ...valid,
  counts: { ...zeroCounts, settlementPending: 1 },
}).failures, ["SETTLEMENT_PENDING"]);
assert.deepEqual(evaluateRollbackScope({
  ...valid,
  active: { epoch: "phase3-ifn-20260711", generation: 5 },
}).failures, ["ACTIVE_EPOCH_CHANGED"]);

const validAdvance = {
  active: valid.active,
  previousEpoch: valid.expected.epoch,
  control: valid.control,
  counts: zeroCounts,
  nextEpoch: "phase3-ifn-20260711",
};
assert.deepEqual(evaluateEpochAdvance(validAdvance), { ok: true, failures: [] });
assert.deepEqual(evaluateEpochAdvance({
  ...validAdvance,
  counts: { ...zeroCounts, claimed: 1 },
}).failures, ["PRIOR_EPOCH_WORK_REMAINS"]);
assert.deepEqual(evaluateEpochAdvance({
  ...validAdvance,
  previousEpoch: "stale",
}).failures, ["ACTIVE_EPOCH_CHANGED"]);

assert.deepEqual(parseCli([
  "--action=dry-run",
  "--team-id=2",
  "--epoch=phase3-ifn-20260710",
  "--poller-node-id=poller-1",
]), {
  action: "dry-run",
  teamId: 2,
  epoch: "phase3-ifn-20260710",
  pollerNodeId: "poller-1",
});
assert.throws(
  () => parseCli([
    "--action=enable",
    "--team-id=2",
    "--epoch=phase3-ifn-20260710",
    "--poller-node-id=poller-1",
    "--confirm-phase3-publication-control",
  ]),
  /read-only|controller context/i,
);
const secret = "phase3-control-secret-must-not-leak";
const refusedCli = spawnSync(process.execPath, [
  resolve(process.cwd(), "scripts/phase3-publication-control.mjs"),
  "--action=enable",
  "--team-id=2",
  "--epoch=phase3-ifn-20260710",
  "--poller-node-id=poller-1",
  "--confirm-phase3-publication-control",
], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, DB_PASSWORD: secret },
});
assert.equal(refusedCli.status, 1);
assert.equal(refusedCli.stdout.includes(secret), false);
assert.deepEqual(JSON.parse(refusedCli.stdout), {
  ok: false,
  code: "phase3-publication-control-refused",
});

async function main(): Promise<void> {
const injectedResponses = [
  [[{ active_epoch: "phase3-ifn-20260710", active_generation: 1 }], []],
  [[{
    team_id: 2,
    cutover_epoch: "phase3-ifn-20260710",
    publication_generation: 1,
    state: "enabled",
    poller_node_id: "poller-1",
    fence_job_id: null,
    ack_node_id: null,
    ack_job_id: null,
    acknowledged_at: null,
  }], []],
];
let injectedCommitted = false;
let injectedReleased = false;
const injectedOperations = createPhase3PublicationMysqlOperations(async () => ({
  async beginTransaction() {},
  async execute() {
    const response = injectedResponses.shift();
    if (!response) throw new Error("unexpected injected Phase 3 SQL");
    return response;
  },
  async commit() { injectedCommitted = true; },
  async rollback() {},
  release() { injectedReleased = true; },
}));
assert.equal((await injectedOperations.enable({
  teamId: 2,
  epoch: "phase3-ifn-20260710",
  pollerNodeId: "poller-1",
})).state, "enabled");
assert.equal(injectedCommitted, true);
assert.equal(injectedReleased, true);

const binding = {
  teamId: 2,
  epoch: "phase3-ifn-20260710",
  pollerNodeId: "poller-1",
};
const scope = "phase3-publication-enable";
const ledger = {
  async beginAction() {
    return Object.freeze({ receipt: "durable" });
  },
};
const context = await authorizeGate6ForwardMutation({
  ledger,
  now: "2026-07-10T12:00:00.000Z",
  action: {
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    composeProject: "spx-production",
    envFile: "/root/SPX/.env",
    composeFiles: ["/root/SPX/docker-compose.yml"],
    gate6Id: "gate6-phase3-test",
    scope,
    actionId: "phase3-publication-enable",
    approvalSha256: "a".repeat(64),
    allowedMutationSha256: sha256Canonical(binding),
    minimumCompensationValidityMs: 60_000,
  },
});
const calls: unknown[] = [];
assert.deepEqual(await executeGate6Phase3PublicationMutation({
  context,
  scope,
  binding,
  operations: {
    enable: async (value: unknown) => {
      calls.push(value);
      return { state: "enabled", generation: 1 };
    },
  },
}), {
  ok: true,
  action: "enable",
  result: { state: "enabled", generation: 1 },
});
assert.deepEqual(calls, [binding]);
await assert.rejects(
  () => executeGate6Phase3PublicationMutation({
    context,
    scope,
    binding,
    operations: { enable: async () => ({}) },
  }),
  /already consumed/i,
);

const driftedBinding = { ...binding, teamId: 3 };
const driftContext = await authorizeGate6ForwardMutation({
  ledger,
  now: "2026-07-10T12:00:00.000Z",
  action: {
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    composeProject: "spx-production",
    envFile: "/root/SPX/.env",
    composeFiles: ["/root/SPX/docker-compose.yml"],
    gate6Id: "gate6-phase3-drift",
    scope,
    actionId: "phase3-publication-enable-drift",
    approvalSha256: "b".repeat(64),
    allowedMutationSha256: sha256Canonical(binding),
    minimumCompensationValidityMs: 60_000,
  },
});
let driftMutationRan = false;
await assert.rejects(
  () => executeGate6Phase3PublicationMutation({
    context: driftContext,
    scope,
    binding: driftedBinding,
    operations: {
      enable: async () => {
        driftMutationRan = true;
        return {};
      },
    },
  }),
  /binding mismatch/i,
);
assert.equal(driftMutationRan, false);

console.log("phase3-publication-control: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
