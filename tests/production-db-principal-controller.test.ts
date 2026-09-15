import assert from "node:assert/strict";

import {
  executePostProofLegacyGrantAction,
  PRODUCTION_DB_ROLE_ORDER,
  verifyProductionDbPrincipalBootstrap,
  switchProductionDbPrincipal,
} from "../scripts/production-db-principal-controller.mjs";

const accountHosts = Object.fromEntries([
  "gate6-control",
  "gate6-monitor",
  "observer",
  ...PRODUCTION_DB_ROLE_ORDER,
].map((role) => [role, "10.0.0.10"]));
const descriptor = {
  environment: "production",
  database: { name: "SPX", accountHosts },
};

async function main(): Promise<void> {
  assert.deepEqual(PRODUCTION_DB_ROLE_ORDER, [
    "realtime-service",
    "line-service",
    "notification-service",
    "worker-ifn-split",
    "worker-ptwl-split",
    "web-api",
    "phase3-control",
    "migrator",
  ]);

  const bootstrap = await verifyProductionDbPrincipalBootstrap({
    descriptor,
    verifier: async (role: string, host: string) => ({
      role,
      host,
      positive: true,
      forbidden: true,
      grantsSha256: "a".repeat(64),
    }),
  });
  assert.equal(bootstrap.length, PRODUCTION_DB_ROLE_ORDER.length + 3);

  const calls: string[] = [];
  await switchProductionDbPrincipal({
    descriptor,
    role: "line-service",
    mutationContext: Object.freeze({}),
    consumeContext: () => ({ scope: "db-principal-switch-line" }),
    adapter: {
      async captureBaseline() { calls.push("capture"); return { active: true }; },
      async stageCredential() { calls.push("stage"); },
      async recreateExactService() { calls.push("recreate"); },
      async verifyPostconditions() { calls.push("verify"); return true; },
      async restoreCredential() { calls.push("restore-credential"); },
      async restoreExactService() { calls.push("restore-service"); },
    },
  });
  assert.deepEqual(calls, ["capture", "stage", "recreate", "verify"]);

  const compensated: string[] = [];
  await assert.rejects(
    () => switchProductionDbPrincipal({
      descriptor,
      role: "worker-ifn-split",
      mutationContext: Object.freeze({}),
      consumeContext: () => ({ scope: "db-principal-switch-worker-ifn" }),
      adapter: {
        async captureBaseline() { return { active: true }; },
        async stageCredential() {},
        async recreateExactService() { throw new Error("health failed"); },
        async verifyPostconditions() { return false; },
        async restoreCredential() { compensated.push("credential"); },
        async restoreExactService() { compensated.push("service"); },
      },
    }),
    /health failed/,
  );

  const postProofCalls: string[] = [];
  const postProofAction = {
    scope: "db-principal-revoke-legacy",
    actionId: "revoke-legacy-001",
    approvalSha256: "b".repeat(64),
    allowedMutationSha256: "c".repeat(64),
    pairedActionId: null,
    requiredStage: "pre-close-accepted",
    requiredCheckerSha256: "d".repeat(64),
    expiresAt: "2026-07-11T02:10:00.000Z",
  };
  const postProof = await executePostProofLegacyGrantAction({
    actionName: "revoke-legacy",
    artifacts: {
      envelope: {
        gate6Id: "gate6-prod-001",
        envelopeCoreSha256: "e".repeat(64),
      },
    },
    bundle: {},
    now: new Date("2026-07-11T02:00:00.000Z"),
    verifyBundle: () => ({
      ok: true,
      acceptedCheckerSha256: "d".repeat(64),
      priorGrantsSha256: "f".repeat(64),
      positiveGrantProofSha256: "1".repeat(64),
      forbiddenGrantProofSha256: "2".repeat(64),
      backupEvidenceSha256: "3".repeat(64),
      revoke: postProofAction,
      restore: {
        ...postProofAction,
        scope: "db-principal-restore-legacy",
        actionId: "restore-legacy-001",
        pairedActionId: postProofAction.actionId,
        expiresAt: "2026-07-11T04:00:00.000Z",
      },
    }),
    ledger: {
      async beginAction() { postProofCalls.push("begin"); return Object.freeze({ receipt: true }); },
      async finishAction(_receipt: unknown, input: { status: string }) {
        postProofCalls.push(`finish:${input.status}`);
      },
    },
    grantAdapter: {
      async converge(actionName: string) { postProofCalls.push(actionName); return { status: "revoked" }; },
    },
  });
  assert.equal(postProof.status, "revoked");
  assert.deepEqual(postProofCalls, ["begin", "revoke", "finish:succeeded"]);
  assert.deepEqual(compensated, ["credential", "service"]);

  await assert.rejects(
    () => switchProductionDbPrincipal({
      descriptor: { ...descriptor, database: { ...descriptor.database, accountHosts: { ...accountHosts, "line-service": "%" } } },
      role: "line-service",
      mutationContext: Object.freeze({}),
      consumeContext: () => ({ scope: "db-principal-switch-line" }),
      adapter: {},
    }),
    /account host/i,
  );
  await assert.rejects(
    () => switchProductionDbPrincipal({
      descriptor,
      role: "unknown-service",
      mutationContext: Object.freeze({}),
      consumeContext: () => ({}),
      adapter: {},
    }),
    /role/i,
  );

  console.log("production DB principal controller tests passed");
}

void main();
