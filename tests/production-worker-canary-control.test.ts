import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCTION_WORKER_HANDOFFS,
  forwardProductionWorkerCanary,
  restoreProductionWorkerCompensation,
  reverseProductionWorkerCanary,
} from "../scripts/production-worker-canary-control.mjs";

assert.deepEqual(PRODUCTION_WORKER_HANDOFFS.ifn, {
  priorService: "worker-ifn-split",
  priorNodeId: "prod-worker-ifn-split-1",
  replacementService: "auto-accept-ifn-phase3",
  replacementNodeId: "prod-auto-accept-ifn-phase3-1",
});
const source = readFileSync("scripts/production-worker-canary-control.mjs", "utf8");
assert.doesNotMatch(source, /team_runtime_leases|pool\.execute/);
assert.match(source, /gate6-runtime-state-probe\.mjs/);
assert.match(source, /"run", "--rm", "--no-deps"/);

async function main(): Promise<void> {
  const calls: string[] = [];
  await forwardProductionWorkerCanary({
    partition: "ifn",
    context: Object.freeze({}),
    consumeContext: () => ({ scope: "worker-ifn-forward" }),
    adapter: {
      async inspect() { calls.push("inspect"); return "prior-active"; },
      async stopPrior() { calls.push("stop-prior"); },
      async waitLeaseReleased() { calls.push("lease-released"); return true; },
      async startReplacement() { calls.push("start-replacement"); },
      async verifySoleOwner() { calls.push("sole-owner"); return true; },
      async stopReplacement() { calls.push("stop-replacement"); },
      async restorePrior() { calls.push("restore-prior"); },
    },
  });
  assert.deepEqual(calls, ["inspect", "stop-prior", "lease-released", "start-replacement", "sole-owner"]);

  const compensated: string[] = [];
  await assert.rejects(
    () => forwardProductionWorkerCanary({
      partition: "ptwl",
      context: Object.freeze({}),
      consumeContext: () => ({ scope: "worker-ptwl-forward" }),
      adapter: {
        async inspect() { return "prior-active"; },
        async stopPrior() {},
        async waitLeaseReleased() { return true; },
        async startReplacement() {},
        async verifySoleOwner() { return false; },
        async stopReplacement() { compensated.push("stop-replacement"); },
        async restorePrior() { compensated.push("restore-prior"); },
      },
    }),
    /sole owner/i,
  );
  assert.deepEqual(compensated, ["stop-replacement", "restore-prior"]);

  const reverseCalls: string[] = [];
  await reverseProductionWorkerCanary({
    partition: "ifn",
    context: Object.freeze({}),
    consumeContext: () => ({ scope: "worker-ifn-reverse" }),
    adapter: {
      async inspect() { return "prior-active"; },
      async stopReplacement() { reverseCalls.push("stop"); },
      async restorePrior() { reverseCalls.push("restore"); },
      async verifyPriorSoleOwner() { return true; },
    },
  });
  assert.deepEqual(reverseCalls, [], "already-restored reverse must be idempotent");

  const restoreCalls: string[] = [];
  await restoreProductionWorkerCompensation({
    partition: "ptwl",
    adapter: {
      async inspect() { return "replacement-sole-owner"; },
      async stopReplacement() { restoreCalls.push("stop"); },
      async restorePrior() { restoreCalls.push("restore"); },
      async verifyPriorSoleOwner() { restoreCalls.push("verify"); return true; },
    },
  });
  assert.deepEqual(restoreCalls, ["stop", "restore", "verify"]);

  await assert.rejects(
    () => forwardProductionWorkerCanary({
      partition: "unknown",
      context: {},
      consumeContext: () => ({}),
      adapter: {},
    }),
    /partition/i,
  );
  console.log("production worker canary control tests passed");
}

void main();
