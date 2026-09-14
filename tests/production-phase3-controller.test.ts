import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PHASE3_PRODUCTION_TRANSITIONS,
  restoreProductionPhase3Compensation,
  runProductionPhase3Transition,
} from "../scripts/production-phase3-controller.mjs";

assert.deepEqual(PHASE3_PRODUCTION_TRANSITIONS, [
  "consumer-start-disabled",
  "legacy-lease-release",
  "poller-start",
  "publication-enable",
  "execution-enable",
  "publication-fence",
  "fence-ack-wait",
  "drain-or-quarantine",
  "inline-owner-restore",
]);
const source = readFileSync("scripts/production-phase3-controller.mjs", "utf8");
assert.doesNotMatch(source, /pool\.execute|FROM auto_accept_jobs|FROM operational_phase3_control_evidence|FROM team_runtime_leases/);
assert.match(source, /gate6-runtime-state-probe\.mjs/);
assert.match(source, /"run", "--rm", "--no-deps"/);
assert.match(source, /createProductionPhase3ControlMysqlPool/);
assert.match(source, /createPhase3PublicationMysqlOperations/);

async function main(): Promise<void> {
  const calls: string[] = [];
  const result = await runProductionPhase3Transition({
    transition: "publication-enable",
    teamId: 2,
    epoch: "gate6-ifn-20260710",
    nodeId: "prod-poller-ifn-phase3-1",
    envelope: {
      canaryTeamId: 2,
      canaryEpoch: "gate6-ifn-20260710",
      productionPhase3NodeIds: ["prod-poller-ifn-phase3-1"],
    },
    context: Object.freeze({}),
    consumeContext: () => { throw new Error("publication library must be the sole consumer"); },
    publicationControl: {
      async executeGate6Phase3PublicationMutation(input: { scope: string }) {
        calls.push(input.scope);
        return { ok: true };
      },
    },
    rollback: async () => { calls.push("rollback"); },
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(calls, ["phase3-publication-enable"]);

  await assert.rejects(
    () => runProductionPhase3Transition({
      transition: "publication-enable",
      teamId: 3,
      epoch: "gate6-ifn-20260710",
      nodeId: "prod-poller-ifn-phase3-1",
      envelope: {
        canaryTeamId: 2,
        canaryEpoch: "gate6-ifn-20260710",
        productionPhase3NodeIds: ["prod-poller-ifn-phase3-1"],
      },
      context: {},
      consumeContext: () => ({}),
      publicationControl: {},
      rollback: async () => {},
    }),
    /team/i,
  );

  const failed: string[] = [];
  await assert.rejects(
    () => runProductionPhase3Transition({
      transition: "execution-enable",
      teamId: 2,
      epoch: "gate6-ifn-20260710",
      nodeId: "prod-poller-ifn-phase3-1",
      envelope: {
        canaryTeamId: 2,
        canaryEpoch: "gate6-ifn-20260710",
        productionPhase3NodeIds: ["prod-poller-ifn-phase3-1"],
      },
      context: {},
      consumeContext: (_context: unknown, scope: string) => ({ scope }),
      publicationControl: { async execute() { throw new Error("fence race"); } },
      rollback: async () => { failed.push("rollback"); },
    }),
    /fence race/,
  );
  assert.deepEqual(failed, ["rollback"]);

  const restored: string[] = [];
  await restoreProductionPhase3Compensation({
    adapter: {
      async restoreInlineOwner() { restored.push("restore"); },
      async verifyInlineOwner() { restored.push("verify"); return true; },
    },
  });
  assert.deepEqual(restored, ["restore", "verify"]);

  console.log("production Phase 3 controller tests passed");
}

void main();
