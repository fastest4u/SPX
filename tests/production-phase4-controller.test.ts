import assert from "node:assert/strict";

import {
  PHASE4_PRODUCTION_TRANSITIONS,
  restoreProductionPhase4Compensation,
  runProductionPhase4Transition,
} from "../scripts/production-phase4-controller.mjs";

assert.deepEqual(PHASE4_PRODUCTION_TRANSITIONS, [
  "verify-expand-install",
  "realtime-start",
  "route-producer",
  "route-read",
  "route-stream",
  "route-local-rollback",
  "route-approved-final",
]);

async function main(): Promise<void> {
  const calls: string[] = [];
  await runProductionPhase4Transition({
    transition: "route-stream",
    context: Object.freeze({}),
    consumeContext: (_context: unknown, scope: string) => ({ scope }),
    state: { readsLocal: true, streamsLocal: false, producersLocal: false },
    adapter: {
      async mutate(transition: string) { calls.push(transition); },
      async verify() { return true; },
    },
  });
  assert.deepEqual(calls, ["route-stream"]);
  const restored: string[] = [];
  await restoreProductionPhase4Compensation({
    adapter: {
      async mutate(transition: string) { restored.push(transition); },
      async verify(transition: string) { restored.push(`verify:${transition}`); return true; },
    },
  });
  assert.deepEqual(restored, ["route-local-rollback", "verify:route-local-rollback"]);
  await assert.rejects(
    () => runProductionPhase4Transition({
      transition: "route-local-rollback",
      context: {},
      consumeContext: (_context: unknown, scope: string) => ({ scope }),
      state: { readsLocal: false, streamsLocal: false, producersLocal: false },
      adapter: { async mutate() {}, async verify() { return true; } },
    }),
    /streams and reads/i,
  );
  await assert.rejects(
    () => runProductionPhase4Transition({
      transition: "compose-up",
      context: {},
      consumeContext: () => ({}),
      state: {},
      adapter: {},
    }),
    /transition/i,
  );
  console.log("production Phase 4 controller tests passed");
}

void main();
