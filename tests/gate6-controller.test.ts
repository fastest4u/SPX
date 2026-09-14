import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  PRODUCTION_COMPOSE,
  authorizeGate6ForwardMutation,
  consumeGate6MutationContext,
} from "../scripts/lib/gate6-controller.mjs";

const H = (value: string): string => createHash("sha256").update(value).digest("hex");
const calls: unknown[] = [];
const ledger = {
  async beginAction(input: unknown) {
    calls.push(input);
    return Object.freeze({ durable: true });
  },
};

assert.deepEqual(PRODUCTION_COMPOSE, {
  project: "spx-production",
  envFile: "/root/SPX/.env",
  files: ["/root/SPX/docker-compose.yml"],
});

const action = {
  gate6Id: "gate6-prod-001",
  scope: "worker-ifn-forward",
  actionId: "action-001",
  approvalSha256: H("approval"),
  allowedMutationSha256: H("mutation"),
  releaseEnvironment: "production",
  runtimeEnvironment: "production",
  drillMode: "supervised-production",
  composeProject: "spx-production",
  envFile: "/root/SPX/.env",
  composeFiles: ["/root/SPX/docker-compose.yml"],
};

async function main(): Promise<void> {
  const context = await authorizeGate6ForwardMutation({ ledger, action });
  assert.equal(calls.length, 1);
  assert.equal(consumeGate6MutationContext(context, "worker-ifn-forward").actionId, "action-001");
  assert.throws(() => consumeGate6MutationContext(context, "worker-ifn-forward"), /already consumed/i);

  for (const changed of [
    { composeProject: "default" },
    { envFile: "/tmp/.env" },
    { composeFiles: ["docker-compose.yml"] },
    { releaseEnvironment: "staging" },
  ]) {
    await assert.rejects(
      () => authorizeGate6ForwardMutation({ ledger, action: { ...action, ...changed } }),
      /production boundary|discriminator/i,
    );
  }

  assert.throws(
    () => consumeGate6MutationContext(Object.freeze({}), "worker-ifn-forward"),
    /verified Gate 6 mutation context/i,
  );
  console.log("gate6 controller tests passed");
}

void main();
