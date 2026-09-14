import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ROLLBACK_STEP_IDS,
  convergeGate6Rollback,
  superviseGate6RollbackOnce,
} from "../scripts/gate6-rollback-coordinator.mjs";

const complete = new Set<string>();
const mutations: string[] = [];
const adapters = Object.fromEntries(ROLLBACK_STEP_IDS.map((id) => [id, {
  async inspect() { return complete.has(id) ? "complete" : "needed"; },
  async converge() { mutations.push(id); complete.add(id); },
  async verify() { return complete.has(id); },
}])) as Record<string, unknown>;

async function main(): Promise<void> {
  const source = readFileSync("scripts/gate6-rollback-coordinator.mjs", "utf8");
  assert.match(source, /--action=restore-legacy/);
  assert.match(source, /postproof-actions\.json/);
  const journal: string[] = [];
  await convergeGate6Rollback({ adapters, journal: { async record(id: string) { journal.push(id); } } });
  assert.deepEqual(mutations, ROLLBACK_STEP_IDS);
  assert.deepEqual(journal, ROLLBACK_STEP_IDS);

  await convergeGate6Rollback({ adapters, journal: { async record(id: string) { journal.push(id); } } });
  assert.deepEqual(mutations, ROLLBACK_STEP_IDS, "restart must not repeat completed compensation");

  const indeterminate = {
    ...adapters,
    "phase3-inline-owner": {
      async inspect() { return "indeterminate"; },
      async converge() { throw new Error("must not run"); },
      async verify() { return false; },
    },
  };
  await assert.rejects(
    () => convergeGate6Rollback({ adapters: indeterminate, journal: { async record() {} } }),
    /indeterminate/i,
  );
  const completions: unknown[] = [];
  const supervised = await superviseGate6RollbackOnce({
    context: { gate6Id: "gate6-prod-001" },
    ledger: {
      async getSupervisorState() { return { status: "revoked" }; },
      async completeRollback(value: unknown) { completions.push(value); },
    },
    converge: async () => ({ status: "compensated", steps: [...ROLLBACK_STEP_IDS] }),
    now: new Date("2026-07-11T02:00:00.000Z"),
  });
  assert.equal(supervised.status, "rolled-back");
  assert.equal(completions.length, 1);
  console.log("gate6 rollback coordinator tests passed");
}

void main();
