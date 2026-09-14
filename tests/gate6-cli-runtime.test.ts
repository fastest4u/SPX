import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { consumeGate6MutationContext } from "../scripts/lib/gate6-controller.mjs";
import {
  runVerifiedGate6AtomicController,
  runVerifiedGate6CompensationController,
  runVerifiedGate6ControllerMutation,
  isValidProductionGate6Keyring,
} from "../scripts/lib/gate6-cli-runtime.mjs";

const calls: string[] = [];
const action = {
  gate6Id: "gate6-prod-001",
  scope: "worker-ifn-forward",
  actionId: "action-001",
  allowedMutationSha256: "a".repeat(64),
};
const ledger = {
  async getActionBinding() {
    calls.push("binding");
    return { expectedStage: "workers-ready", expectedCheckerSha256: "b".repeat(64) };
  },
  async beginAction(input: { expectedStage: string }) {
    calls.push(`begin:${input.expectedStage}`);
    return Object.freeze({ durable: true });
  },
  async finishAction(_receipt: unknown, input: { status: string }) {
    calls.push(`finish:${input.status}`);
  },
};

async function main(): Promise<void> {
const pair = () => generateKeyPairSync("ed25519");
const pem = () => pair().publicKey.export({ type: "spki", format: "pem" }).toString();
const sharedKey = pem();
const keyIds = {
  envelope: "gate6-envelope-test",
  linePermit: "gate6-line-test",
  ocrPermit: "gate6-ocr-test",
  postproof: "gate6-postproof-test",
};
const keyring = {
  schemaVersion: 2,
  repository: "owner/SPX",
  workflowFileSha256: "a".repeat(64),
  signerWorkflowShas: {
    envelope: "1".repeat(40),
    linePermit: "2".repeat(40),
    ocrPermit: "3".repeat(40),
    postproof: "4".repeat(40),
  },
  keyIds,
  keys: Object.fromEntries(Object.values(keyIds).map((keyId) => [keyId, pem()])),
};
assert.equal(isValidProductionGate6Keyring(keyring), true);
assert.equal(
  isValidProductionGate6Keyring({ ...keyring, signerWorkflowShas: undefined }),
  false,
  "the runtime keyring must pin every reusable signer independently of candidate releases",
);
assert.equal(isValidProductionGate6Keyring({
  ...keyring,
  keys: Object.fromEntries(Object.values(keyIds).map((keyId) => [keyId, sharedKey])),
}), false, "role key IDs must resolve to distinct Ed25519 public-key material");
const privatePair = pair();
assert.equal(isValidProductionGate6Keyring({
  ...keyring,
  keys: {
    ...keyring.keys,
    [keyIds.envelope]: privatePair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  },
}), false, "the runtime keyring must reject private signing material");
assert.equal(isValidProductionGate6Keyring({
  ...keyring,
  keys: { ...keyring.keys, "unreferenced-extra-key": pem() },
}), false, "the runtime keyring must reject unreferenced extra keys");
const result = await runVerifiedGate6ControllerMutation({
  args: { action: "forward" },
  expectedScopes: ["worker-ifn-forward"],
  artifacts: {
    envelope: {
      gate6Id: "gate6-prod-001",
      releaseEnvironment: "production",
      runtimeEnvironment: "production",
      drillMode: "supervised-production",
      composeProject: "spx-production",
      envFile: "/root/SPX/.env",
      composeFiles: ["/root/SPX/docker-compose.yml"],
      envelopeCoreSha256: "c".repeat(64),
      rtoMinutes: 20,
    },
    release: {},
    action,
    approvalSha256: "d".repeat(64),
  },
  pool: {},
  ledger,
  execute: async ({ context }: { context: object }) => {
    consumeGate6MutationContext(context, "worker-ifn-forward");
    calls.push("mutate");
    return { status: "verified" };
  },
});
assert.equal(result.ok, true);
assert.deepEqual(calls, ["binding", "begin:workers-ready", "mutate", "finish:succeeded"]);

const atomicCalls: string[] = [];
const atomic = await runVerifiedGate6AtomicController({
  args: { action: "line-boundary-retry" },
  expectedScopes: ["task9-line-boundary"],
  artifacts: {
    envelope: { gate6Id: "gate6-prod-001" },
    release: {},
    action: { ...action, scope: "task9-line-boundary" },
    approvalSha256: "e".repeat(64),
  },
  pool: {},
  ledger: {},
  execute: async () => {
    atomicCalls.push("atomic");
    return { status: "succeeded" };
  },
});
assert.deepEqual(atomic, { status: "succeeded" });
assert.deepEqual(atomicCalls, ["atomic"]);

const compensationCalls: string[] = [];
const compensation = await runVerifiedGate6CompensationController({
  args: { action: "restore-prior" },
  expectedScopes: ["worker-ifn-restore-prior"],
  artifacts: {
    envelope: {
      gate6Id: "gate6-prod-001",
      envelopeCoreSha256: "c".repeat(64),
    },
    release: {},
    action: {
      ...action,
      scope: "worker-ifn-restore-prior",
      kind: "compensation",
      pairedActionId: "worker-forward-001",
    },
    approvalSha256: "e".repeat(64),
  },
  pool: {},
  ledger: {
    async beginCompensation() {
      compensationCalls.push("begin-compensation");
      return Object.freeze({ durable: true });
    },
    async finishAction(_receipt: unknown, input: { status: string }) {
      compensationCalls.push(`finish-compensation:${input.status}`);
    },
  },
  execute: async () => {
    compensationCalls.push("restore");
    return { status: "restored" };
  },
});
assert.equal(compensation.ok, true);
assert.deepEqual(compensationCalls, [
  "begin-compensation",
  "restore",
  "finish-compensation:succeeded",
]);

console.log("Gate 6 executable CLI runtime tests passed");
}

void main();
