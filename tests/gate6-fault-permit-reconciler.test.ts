import assert from "node:assert/strict";

import { reconcileAllGate6FaultPermits } from "../scripts/gate6-fault-permit-reconciler.mjs";

async function main(): Promise<void> {
  const calls: unknown[] = [];
  const result = await reconcileAllGate6FaultPermits({
    context: { gate6Id: "gate6-prod-001" },
    ledger: {
      async disarmAllTask9Permits(value: unknown) {
        calls.push(value);
        return { status: "disarmed", changedCount: 2 };
      },
    },
    now: new Date("2026-07-11T02:00:00.000Z"),
  });
  assert.equal(calls.length, 1);
  assert.equal(result.status, "complete");
  assert.match(result.evidenceSha256, /^[0-9a-f]{64}$/);
  console.log("Gate 6 fault-permit reconciler tests passed");
}

void main();
