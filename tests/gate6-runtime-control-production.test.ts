import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  buildGate6AdmissionActions,
  executeGate6Abort,
  executeGate6Admission,
  executeGate6SemanticAcceptance,
  parseGate6RuntimeControlArgs,
} from "../scripts/gate6-runtime-control.mjs";
import {
  COMPENSATION_PAIRINGS,
  MANDATORY_FORWARD_SCOPES,
  canonicalGate6Json,
} from "../src/services/gate6-approval-runtime.mjs";

const H = (character: string): string => character.repeat(64);
const actionId = (scope: string): string => `action-${scope}`;

function envelope() {
  const scopes = [
    ...MANDATORY_FORWARD_SCOPES,
    ...Object.keys(COMPENSATION_PAIRINGS),
    "gate6-abort",
  ];
  return {
    gate6Id: "gate6-prod-001",
    gate6Nonce: "nonce-prod-001",
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    composeProject: "spx-production",
    candidateSha: "a".repeat(40),
    candidateImageDigest: `sha256:${H("b")}`,
    rollbackSha: "c".repeat(40),
    rollbackImageDigest: `sha256:${H("d")}`,
    productionTargetDescriptorSha256: H("e"),
    operatorBundleSha256: H("f"),
    protectedInstallEvidenceSha256: H("1"),
    installedMigrationSetSha256: H("2"),
    installedSchemaVersion: 36,
    rtoMinutes: 20,
    expiresAt: "2026-07-11T03:00:00.000Z",
    envelopeCoreSha256: H("3"),
    actionApprovals: scopes.map((scope) => ({
      gate6Id: "gate6-prod-001",
      scope,
      kind: Object.hasOwn(COMPENSATION_PAIRINGS, scope)
        ? "compensation"
        : scope === "gate6-abort"
          ? "emergency"
          : "forward",
      actionId: actionId(scope),
      allowedMutationSha256: H("4"),
      pairedActionId: Object.hasOwn(COMPENSATION_PAIRINGS, scope)
        ? actionId(COMPENSATION_PAIRINGS[scope as keyof typeof COMPENSATION_PAIRINGS])
        : null,
      expiresAt: "2026-07-11T04:00:00.000Z",
    })),
  };
}

async function actionGraph(): Promise<void> {
  const actions = buildGate6AdmissionActions(envelope());
  const byScope = new Map(actions.map((action) => [action.scope, action]));
  assert.equal(byScope.get("db-principal-prepare-realtime")?.requiredStage, "admitted");
  assert.deepEqual(byScope.get("db-principal-prepare-realtime")?.predecessorActionIds, [
    actionId("gate6-admit"),
  ]);
  assert.deepEqual(byScope.get("stage-accept-db-transition")?.predecessorActionIds, [
    actionId("db-principal-switch-web"),
  ]);
  assert.equal(byScope.get("task9-line-baseline")?.requiredStage, "db-transition-stable");
  assert.deepEqual(byScope.get("task9-line-baseline")?.predecessorActionIds, [
    actionId("stage-accept-db-transition"),
  ]);
  assert.deepEqual(byScope.get("stage-accept-task9")?.predecessorActionIds, [
    actionId("task9-ocr-boundary"),
  ]);
  assert.equal(byScope.get("worker-ifn-forward")?.requiredStage, "task9-accepted");
  assert.equal(byScope.get("phase3-consumer-start-disabled")?.requiredStage, "worker-accepted");
  assert.equal(byScope.get("phase4-verify-expand-install")?.requiredStage, "phase3-accepted");
  assert.equal(byScope.get("gate6-final-baseline")?.requiredStage, "phase4-accepted");
  assert.equal(byScope.get("stage-accept-pre-close")?.requiredStage, "final-baseline-stable");
  assert.deepEqual(byScope.get("gate6-release")?.predecessorActionIds, [
    actionId("gate6-seal-close"),
  ]);
  assert.equal(
    byScope.get("db-principal-restore-line")?.pairedActionId,
    actionId("db-principal-switch-line"),
  );
}

async function admissionHandoff(): Promise<void> {
  const env = envelope();
  const events: string[] = [];
  const beforeSlot = {
    environment: "production",
    owner_type: "protected-install",
    owner_id: "install-001",
    operation_id: "install-001",
    transfer_token_sha256: H("5"),
    state: "installed-awaiting-gate6",
    version: 7,
  };
  const afterSlot = {
    ...beforeSlot,
    owner_type: "gate6",
    owner_id: env.gate6Id,
    transfer_token_sha256: null,
    state: "active",
    version: 8,
  };
  let slot = beforeSlot;
  const hostLock = {
    operationId: "install-001",
    releaseHash: H("6"),
    targetHash: env.productionTargetDescriptorSha256,
    state: "installed-awaiting-gate6",
    lease: { owner: "systemd:spx-protected-install-watchdog" },
    protectedInstall: {
      operationId: "install-001",
      transferTokenSha256: H("5"),
      protectedInstallEvidenceSha256: env.protectedInstallEvidenceSha256,
      releaseSha: env.candidateSha,
      targetDescriptorSha256: env.productionTargetDescriptorSha256,
      operatorBundleSha256: env.operatorBundleSha256,
      installedMigrationSetSha256: env.installedMigrationSetSha256,
      installedSchemaVersion: env.installedSchemaVersion,
      slotVersion: 7,
    },
    handoff: null,
  };
  const result = await executeGate6Admission({
    artifacts: {
      envelope: env,
      action: env.actionApprovals[0],
    },
    operationId: "install-001",
    now: new Date("2026-07-11T02:00:00.000Z"),
    ledger: {
      async getProductionSlotForHandoff() {
        return slot;
      },
      async admitInstalledRun(input: Record<string, unknown>) {
        events.push("db-admit");
        assert.equal(input.transferTokenSha256, H("5"));
        assert.equal((input.actions as unknown[]).length, env.actionApprovals.length);
        slot = afterSlot;
        return { status: "admitted", slotVersion: 8 };
      },
    },
    hostLockAdapters: {
      async read() {
        return hostLock;
      },
      async begin(input: Record<string, unknown>) {
        events.push("host-pending");
        assert.equal(input.leaseOwner, "systemd:spx-protected-install-watchdog");
        hostLock.state = "handoff-pending";
        hostLock.handoff = { gate6Id: env.gate6Id } as never;
        return hostLock;
      },
      async reconcile(input: Record<string, unknown>) {
        events.push("host-active");
        assert.equal(input.gate6LeaseOwner, "systemd:spx-gate6-supervisor");
        assert.equal((input.observedSlot as { version: number }).version, 8);
        return { outcome: "gate6-owner-completed" };
      },
    },
  });
  assert.deepEqual(events, ["host-pending", "db-admit", "host-active"]);
  assert.deepEqual(result, {
    status: "admitted",
    slotVersion: 8,
    handoff: "gate6-owner-completed",
  });
}

async function semanticChecker(): Promise<void> {
  const env = envelope();
  const action = env.actionApprovals.find((candidate) => candidate.scope === "stage-accept-task9")!;
  const calls: string[] = [];
  let persistedReceipt: Record<string, unknown> | undefined;
  const request = (now: Date) => ({
    actionName: "verify-task9",
    artifacts: { envelope: env, action, approvalSha256: H("7") },
    now,
    ledger: {
      async getActionBinding() {
        return { expectedStage: "db-transition-stable", expectedCheckerSha256: H("8") };
      },
      async beginAction(input: Record<string, unknown>) {
        calls.push("consume");
        assert.equal(input.expectedStage, "db-transition-stable");
        return Object.freeze({
          gate6Id: env.gate6Id,
          scope: action.scope,
          actionId: action.actionId,
        });
      },
      async acceptSemanticChecker(_receipt: unknown, input: Record<string, unknown>) {
        calls.push("accept");
        assert.equal(input.nextStage, "task9-accepted");
        assert.match(String(input.acceptedCheckerSha256), /^[0-9a-f]{64}$/);
      },
    },
    async readSemanticReceipt() {
      calls.push("read");
      return persistedReceipt === undefined
        ? null
        : {
            receipt: persistedReceipt,
            path: "/fixed/stage-accept-task9.json",
            sha256: H("c"),
          };
    },
    async writeSemanticReceipt(receipt: Record<string, unknown>) {
      calls.push("receipt");
      assert.equal(receipt.scope, "stage-accept-task9");
      assert.equal(receipt.expectedStage, "db-transition-stable");
      assert.equal(receipt.nextStage, "task9-accepted");
      assert.match(String(receipt.acceptedCheckerSha256), /^[0-9a-f]{64}$/);
      if (persistedReceipt === undefined) persistedReceipt = structuredClone(receipt);
      else assert.deepEqual(receipt, persistedReceipt);
      return { path: "/fixed/stage-accept-task9.json", sha256: H("c") };
    },
    runChecker: async () => ({
      checkerName: "task9-production-evidence",
      checkerExecutableSha256: H("9"),
      checkerArgumentsSha256: H("a"),
      outputSha256: createHash("sha256")
        .update(canonicalGate6Json({ ok: true }))
        .digest("hex"),
      output: { ok: true },
    }),
  });
  const result = await executeGate6SemanticAcceptance(
    request(new Date("2026-07-11T02:00:00.000Z")),
  );
  assert.deepEqual(calls, ["read", "receipt", "consume", "accept"]);
  assert.equal(result.nextStage, "task9-accepted");
  assert.equal(result.receiptSha256, H("c"));
  calls.length = 0;
  await executeGate6SemanticAcceptance(request(new Date("2026-07-11T02:05:00.000Z")));
  assert.deepEqual(calls, ["read", "receipt", "consume", "accept"]);
  assert.equal(persistedReceipt?.checkedAt, "2026-07-11T02:00:00.000Z");
}

async function emergencyAbort(): Promise<void> {
  assert.equal(
    parseGate6RuntimeControlArgs([
      "--action=abort",
      "--envelope=/var/lib/spx-gate6/artifacts/gate6-envelope.json",
      "--action-approval=/var/lib/spx-gate6/actions/gate6-abort.json",
      "--release=/var/lib/spx-gate6/artifacts/release-manifest.json",
    ]).action,
    "abort",
  );
  const calls: string[] = [];
  const result = await executeGate6Abort({
    artifacts: {
      envelope: {
        gate6Id: "gate6-prod-001",
        envelopeCoreSha256: H("1"),
      },
      action: {
        gate6Id: "gate6-prod-001",
        scope: "gate6-abort",
        actionId: "abort-001",
        approvalSha256: H("2"),
        allowedMutationSha256: H("3"),
        kind: "emergency",
      },
      approvalSha256: H("2"),
    },
    ledger: {
      async emergencyAbort(input: { gate6Id: string; reasonCode: string }) {
        calls.push(`abort:${input.gate6Id}:${input.reasonCode}`);
        return { status: "revoked", reasonCode: input.reasonCode };
      },
    },
  });
  assert.deepEqual(result, { status: "revoked", reasonCode: "operator-abort" });
  assert.deepEqual(calls, ["abort:gate6-prod-001:operator-abort"]);
}

async function main(): Promise<void> {
  assert.deepEqual(
    parseGate6RuntimeControlArgs([
      "--action=admit-and-supervise",
      "--envelope=/root/spx-rollout/gate6/gate6-envelope.json",
      "--action-approval=/root/spx-rollout/gate6/actions/gate6-admit.json",
      "--release=/root/spx-rollout/release-manifest.json",
      "--operation-id=install-001",
    ]).action,
    "admit-and-supervise",
  );
  assert.throws(
    () =>
      parseGate6RuntimeControlArgs([
        "--action=admit-and-supervise",
        "--envelope=x",
        "--action-approval=y",
        "--release=z",
      ]),
    /operation/i,
  );
  await actionGraph();
  await admissionHandoff();
  await semanticChecker();
  await emergencyAbort();
  const source = readFileSync("scripts/gate6-runtime-control.mjs", "utf8");
  assert.doesNotMatch(source, /direct Gate 6 runtime control is read-only/);
  assert.match(canonicalGate6Json({ ok: true }), /"ok":true/);
  console.log("Gate 6 production runtime-control tests passed");
}

void main();
