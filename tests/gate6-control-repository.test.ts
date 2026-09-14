import assert from "node:assert/strict";

const H = (value: string) => value.repeat(64);
const now = new Date("2026-07-11T01:00:00.000Z");

function action(
  scope: string,
  actionId: string,
  options: Partial<{
    kind: "forward" | "compensation" | "emergency";
    pairedActionId: string;
    predecessorActionIds: string[];
    requiredStage: string;
    expiresAt: string;
  }> = {},
) {
  return {
    scope,
    actionId,
    approvalSha256: H("a"),
    allowedMutationSha256: H("b"),
    kind: options.kind ?? "forward",
    pairedActionId: options.pairedActionId ?? null,
    predecessorActionIds: options.predecessorActionIds ?? [],
    requiredStage: options.requiredStage ?? "admitted",
    requiredCheckerSha256: null,
    expiresAt: options.expiresAt ?? "2026-07-11T02:00:00.000Z",
  };
}

function run(actions: ReturnType<typeof action>[], gate6Id = "gate6-test-001") {
  return {
    gate6Id,
    gate6Nonce: "nonce-test-001",
    envelopeSha256: H("c"),
    envelopeCoreSha256: H("d"),
    releaseEnvironment: "production" as const,
    runtimeEnvironment: "production" as const,
    drillMode: "supervised-production" as const,
    candidateSha: "e".repeat(40),
    candidateImageDigest: `sha256:${H("f")}`,
    rollbackSha: "1".repeat(40),
    rollbackImageDigest: `sha256:${H("2")}`,
    productionTargetDescriptorSha256: H("3"),
    operatorBundleSha256: H("4"),
    protectedInstallEvidenceSha256: H("5"),
    installedMigrationSetSha256: H("6"),
    installedSchemaVersion: 36,
    expiresAt: "2026-07-11T02:00:00.000Z",
    monitorLeaseExpiresAt: "2026-07-11T01:05:00.000Z",
    supervisorLeaseExpiresAt: "2026-07-11T01:05:00.000Z",
    emergencySupervisorLeaseExpiresAt: "2026-07-11T04:00:00.000Z",
    actions,
  };
}

async function main(): Promise<void> {
  const {
    Gate6ControlRepository,
    createInMemoryGate6ControlStore,
  } = await import("../src/repositories/gate6-control-repository.js");
  const {
    beginGate6Action,
    beginGate6Compensation,
  } = await import("../src/db/gate6-action-transaction.js");

  const forward = action("db-principal-prepare", "action-001");
  const second = action("worker-forward", "action-002", {
    predecessorActionIds: [forward.actionId],
  });
  const rollback = action("db-principal-prepare:rollback", "action-003", {
    kind: "compensation",
    pairedActionId: forward.actionId,
    expiresAt: "2026-07-11T04:00:00.000Z",
  });
  const store = createInMemoryGate6ControlStore();
  const repository = new Gate6ControlRepository({ store, now: () => now });
  await repository.admitRun(run([forward, second, rollback]));

  const first = await beginGate6Action(repository, {
    gate6Id: "gate6-test-001",
    scope: forward.scope,
    actionId: forward.actionId,
    approvalSha256: forward.approvalSha256,
    allowedMutationSha256: forward.allowedMutationSha256,
    now,
  });
  assert.equal(first.status, "consumed");
  assert.equal(Object.keys(first).includes("gate6Nonce"), false);

  await assert.rejects(
    () => beginGate6Action(repository, {
      gate6Id: "gate6-test-001",
      scope: forward.scope,
      actionId: forward.actionId,
      approvalSha256: forward.approvalSha256,
      allowedMutationSha256: forward.allowedMutationSha256,
      now,
    }),
    /already consumed|ambiguous/,
  );

  const reopened = new Gate6ControlRepository({ store, now: () => now });
  await assert.rejects(
    () => beginGate6Action(reopened, {
      gate6Id: "gate6-test-001",
      scope: forward.scope,
      actionId: forward.actionId,
      approvalSha256: forward.approvalSha256,
      allowedMutationSha256: forward.allowedMutationSha256,
      now,
    }),
    /already consumed|ambiguous/,
  );
  await assert.rejects(
    () => reopened.admitRun(run([forward], "gate6-test-002")),
    /production slot busy/,
  );

  await assert.rejects(
    () => beginGate6Action(reopened, {
      gate6Id: "gate6-test-001",
      scope: second.scope,
      actionId: second.actionId,
      approvalSha256: second.approvalSha256,
      allowedMutationSha256: second.allowedMutationSha256,
      now,
    }),
    /predecessor evidence/,
  );

  await reopened.finishAction(first, {
    status: "succeeded",
    afterEvidenceSha256: H("7"),
    now,
  });
  const secondContext = await beginGate6Action(reopened, {
    gate6Id: "gate6-test-001",
    scope: second.scope,
    actionId: second.actionId,
    approvalSha256: second.approvalSha256,
    allowedMutationSha256: second.allowedMutationSha256,
    now,
  });
  await reopened.finishAction(secondContext, {
    status: "failed",
    afterEvidenceSha256: H("8"),
    now,
  });

  await reopened.revokeRun({
    gate6Id: "gate6-test-001",
    reasonCode: "forward-action-failed",
    now,
  });
  const compensation = await beginGate6Compensation(reopened, {
    gate6Id: "gate6-test-001",
    scope: rollback.scope,
    actionId: rollback.actionId,
    approvalSha256: rollback.approvalSha256,
    allowedMutationSha256: rollback.allowedMutationSha256,
    pairedActionId: forward.actionId,
    now: new Date("2026-07-11T02:30:00.000Z"),
  });
  assert.equal(compensation.status, "consumed");

  const stageAction = action("stage-accept-db-transition", "action-stage-001");
  const permitIntent = action("task9-line-boundary", "action-permit-001", {
    requiredStage: "db-transition-stable",
    predecessorActionIds: [stageAction.actionId],
  });
  const permitStore = createInMemoryGate6ControlStore();
  const permitRepository = new Gate6ControlRepository({ store: permitStore, now: () => now });
  await permitRepository.admitRun(run([stageAction, permitIntent]));
  const stageContext = await beginGate6Action(permitRepository, {
    gate6Id: "gate6-test-001",
    scope: stageAction.scope,
    actionId: stageAction.actionId,
    approvalSha256: stageAction.approvalSha256,
    allowedMutationSha256: stageAction.allowedMutationSha256,
    now,
  });
  await permitRepository.acceptSemanticChecker(stageContext, {
    checkerName: "db-transition-semantic-check",
    checkerSha256: H("f"),
    nextStage: "db-transition-stable",
    now,
  });
  assert.equal(await permitStore.read((state) => state.slots.get("production")?.uncompensatedWork), false);

  const permit = await permitRepository.registerTask9Permit({
    gate6Id: "gate6-test-001",
    scope: permitIntent.scope,
    actionId: permitIntent.actionId,
    approvalSha256: permitIntent.approvalSha256,
    allowedMutationSha256: permitIntent.allowedMutationSha256,
    permitId: "permit-line-001",
    service: "line-service",
    kind: "retryable-provider-suppression",
    teamId: 2,
    drillSha256: H("6"),
    targetSha256: H("9"),
    fixtureSha256: null,
    signedPermitSha256: H("0"),
    keyId: "gate6-line-2026-01",
    expectedCheckerSha256: H("f"),
    expiresAt: "2026-07-11T01:02:00.000Z",
    now: new Date("2026-07-11T01:01:00.000Z"),
  });
  assert.equal(permit.status, "armed");
  assert.equal(await permitStore.read((state) => state.slots.get("production")?.uncompensatedWork), true);
  await assert.rejects(
    () => permitRepository.consumeTask9Permit({
      permitId: "permit-line-001",
      service: "line-service",
      teamId: 2,
      targetSha256: H("9"),
      signedPermitSha256: H("1"),
      now: new Date("2026-07-11T01:01:09.000Z"),
    }),
    /permit request does not match/i,
  );
  const consumed = await permitRepository.consumeTask9Permit({
    permitId: "permit-line-001",
    service: "line-service",
    teamId: 2,
    targetSha256: H("9"),
    signedPermitSha256: H("0"),
    now: new Date("2026-07-11T01:01:10.000Z"),
  });
  assert.equal(consumed.status, "consumed");
  await assert.rejects(
    () => permitRepository.consumeTask9Permit({
      permitId: "permit-line-001",
      service: "line-service",
      teamId: 2,
      targetSha256: H("9"),
      signedPermitSha256: H("0"),
      now: new Date("2026-07-11T01:01:11.000Z"),
    }),
    /already consumed/,
  );
  await permitRepository.disarmTask9Permit({
    permitId: "permit-line-001",
    now: new Date("2026-07-11T01:01:12.000Z"),
  });
  await permitRepository.completeTask9PermitAction(permit, {
    status: "succeeded",
    afterEvidenceSha256: H("7"),
    now: new Date("2026-07-11T01:01:13.000Z"),
  });
  assert.equal(await permitStore.read((state) => state.slots.get("production")?.uncompensatedWork), false);
  assert.equal(
    await permitStore.read((state) => state.actions.get("gate6-test-001\0action-permit-001")?.status),
    "succeeded",
  );

  const leaseStore = createInMemoryGate6ControlStore();
  const leaseRepository = new Gate6ControlRepository({ store: leaseStore, now: () => now });
  await leaseRepository.admitRun(run([forward]));
  await assert.rejects(
    () => beginGate6Action(leaseRepository, {
      gate6Id: "gate6-test-001",
      scope: forward.scope,
      actionId: forward.actionId,
      approvalSha256: forward.approvalSha256,
      allowedMutationSha256: forward.allowedMutationSha256,
      now: new Date("2026-07-11T01:06:00.000Z"),
    }),
    /monitor lease|supervisor lease/,
  );
  assert.equal((await leaseRepository.getRun("gate6-test-001"))?.status, "revoked");

  const snapshot = await reopened.getSanitizedSnapshot("gate6-test-001");
  assert.equal(snapshot.gate6Id, "gate6-test-001");
  assert.equal(JSON.stringify(snapshot).includes("nonce-test-001"), false);
  assert.equal(JSON.stringify(snapshot).includes(forward.allowedMutationSha256), false);
  console.log("gate6 control repository tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
