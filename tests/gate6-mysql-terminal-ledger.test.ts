import assert from "node:assert/strict";

import { createGate6MysqlLedger } from "../scripts/lib/gate6-mysql-ledger.mjs";

const H = (character: string): string => character.repeat(64);

class Connection {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  beginCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  releaseCount = 0;

  constructor(private readonly responses: unknown[]) {}
  async beginTransaction(): Promise<void> { this.beginCount += 1; }
  async commit(): Promise<void> { this.commitCount += 1; }
  async rollback(): Promise<void> { this.rollbackCount += 1; }
  release(): void { this.releaseCount += 1; }
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`unexpected SQL: ${sql}`);
    return [response, []];
  }
}

function ledgerFor(...connections: Connection[]) {
  return createGate6MysqlLedger({
    async getConnection() {
      const connection = connections.shift();
      if (!connection) throw new Error("missing fake connection");
      return connection;
    },
    async execute(sql: string, params: unknown[] = []) {
      const connection = connections.shift();
      if (!connection) throw new Error("missing fake connection");
      return connection.execute(sql, params);
    },
  });
}

async function installedRunAdmission(): Promise<void> {
  const admission = new Connection([
    [
      {
        environment: "production",
        owner_type: "protected-install",
        owner_id: "install-001",
        operation_id: "install-001",
        transfer_token_sha256: H("1"),
        state: "installed-awaiting-gate6",
        version: 7,
        protected_install_evidence_sha256: H("2"),
        release_sha: "a".repeat(40),
        target_descriptor_sha256: H("3"),
        operator_bundle_sha256: H("4"),
        installed_migration_set_sha256: H("5"),
        installed_schema_version: 36,
        heartbeat_at: "2026-07-11T01:59:50.000Z",
        expires_at: "2026-07-12T02:00:00.000Z",
      },
    ],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const ledger = ledgerFor(admission);
  const result = await ledger.admitInstalledRun({
    gate6Id: "gate6-prod-001",
    gate6Nonce: "nonce-prod-001",
    envelopeSha256: H("6"),
    envelopeCoreSha256: H("7"),
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    composeProject: "spx-production",
    candidateSha: "a".repeat(40),
    candidateImageDigest: `sha256:${H("8")}`,
    rollbackSha: "b".repeat(40),
    rollbackImageDigest: `sha256:${H("9")}`,
    productionTargetDescriptorSha256: H("3"),
    operatorBundleSha256: H("4"),
    protectedInstallEvidenceSha256: H("2"),
    installedMigrationSetSha256: H("5"),
    installedSchemaVersion: 36,
    expiresAt: "2026-07-11T02:30:00.000Z",
    monitorLeaseExpiresAt: "2026-07-11T02:01:00.000Z",
    supervisorLeaseExpiresAt: "2026-07-11T02:01:00.000Z",
    emergencySupervisorLeaseExpiresAt: "2026-07-11T04:00:00.000Z",
    installOperationId: "install-001",
    transferTokenSha256: H("1"),
    admitActionId: "admit-001",
    actions: [
      {
        scope: "gate6-admit",
        actionId: "admit-001",
        approvalSha256: H("a"),
        allowedMutationSha256: H("b"),
        kind: "forward",
        pairedActionId: null,
        predecessorActionIds: [],
        requiredStage: "admitted",
        requiredCheckerSha256: null,
        expiresAt: "2026-07-11T02:30:00.000Z",
      },
    ],
    now: new Date("2026-07-11T02:00:00.000Z"),
  });
  assert.deepEqual(result, { status: "admitted", slotVersion: 8 });
  assert.ok(
    admission.calls.some(
      ({ sql }) => /installed-awaiting-gate6/.test(sql) && /version = \?/.test(sql),
    ),
  );
}

async function semanticAcceptance(): Promise<void> {
  const begin = new Connection([
    [{ owner_type: "gate6", owner_id: "gate6-prod-001", state: "active", version: 2 }],
    [
      {
        gate6_id: "gate6-prod-001",
        envelope_sha256: H("a"),
        envelope_core_sha256: H("b"),
        status: "active",
        current_stage: "admitted",
        accepted_checker_sha256: null,
        monitor_status: "green",
        monitor_lease_expires_at: "2026-07-11T02:02:00.000Z",
        supervisor_status: "green",
        supervisor_lease_expires_at: "2026-07-11T02:02:00.000Z",
        expires_at: "2026-07-11T02:05:00.000Z",
      },
    ],
    [
      {
        gate6_id: "gate6-prod-001",
        scope: "stage-accept-db-transition",
        action_id: "stage-db-001",
        approval_sha256: H("c"),
        allowed_mutation_sha256: H("d"),
        kind: "forward",
        paired_action_id: null,
        status: "registered",
        required_stage: "admitted",
        required_checker_sha256: null,
        predecessor_action_ids_json: "[]",
        expires_at: "2026-07-11T02:04:00.000Z",
      },
    ],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const accept = new Connection([
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 3 },
    [{ count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
  ]);
  const ledger = ledgerFor(begin, accept);
  const receipt = await ledger.beginAction({
    gate6Id: "gate6-prod-001",
    scope: "stage-accept-db-transition",
    actionId: "stage-db-001",
    approvalSha256: H("c"),
    allowedMutationSha256: H("d"),
    envelopeSha256: H("a"),
    envelopeCoreSha256: H("b"),
    expectedStage: "admitted",
    expectedCheckerSha256: null,
    minimumCompensationValidityMs: 0,
    now: new Date("2026-07-11T02:00:00.000Z"),
  });
  await ledger.acceptSemanticChecker(receipt, {
    checkerName: "db-transition",
    acceptedCheckerSha256: H("e"),
    nextStage: "db-transition-stable",
    now: new Date("2026-07-11T02:00:10.000Z"),
  });
  assert.ok(accept.calls.some(({ sql }) => /required_checker_sha256 = \?/.test(sql)));
  assert.ok(
    accept.calls.some(
      ({ sql, params }) => /after_evidence_sha256 = \?/.test(sql) && params[0] === H("e"),
    ),
  );
}

async function acceptedSemanticBinding(): Promise<void> {
  const read = new Connection([
    [
      {
        action_status: "succeeded",
        after_evidence_sha256: H("e"),
        run_status: "active",
        current_stage: "db-transition-stable",
        accepted_checker_name: "db-transition",
        accepted_checker_sha256: H("e"),
        slot_owner_type: "gate6",
        slot_owner_id: "gate6-prod-001",
        slot_state: "active",
        slot_version: 9,
        monitor_status: "green",
        monitor_lease_expires_at: "2026-07-11T02:02:00.000Z",
        supervisor_status: "green",
        supervisor_lease_expires_at: "2026-07-11T02:02:00.000Z",
      },
    ],
  ]);
  const ledger = ledgerFor(read);
  assert.deepEqual(
    await ledger.getAcceptedSemanticBinding(
      "gate6-prod-001",
      "stage-accept-db-transition",
      "stage-db-001",
    ),
    {
      actionStatus: "succeeded",
      afterEvidenceSha256: H("e"),
      runStatus: "active",
      currentStage: "db-transition-stable",
      acceptedCheckerName: "db-transition",
      acceptedCheckerSha256: H("e"),
      slotOwnerType: "gate6",
      slotOwnerId: "gate6-prod-001",
      slotState: "active",
      slotVersion: 9,
      monitorStatus: "green",
      monitorLeaseExpiresAt: "2026-07-11T02:02:00.000Z",
      supervisorStatus: "green",
      supervisorLeaseExpiresAt: "2026-07-11T02:02:00.000Z",
    },
  );
  assert.deepEqual(read.calls[0].params, [
    "gate6-prod-001",
    "stage-accept-db-transition",
    "stage-db-001",
  ]);
  assert.match(read.calls[0].sql, /JOIN gate6_runs/);
  assert.match(read.calls[0].sql, /JOIN gate6_environment_slots/);
}

async function staleConsumption(): Promise<void> {
  const stale = new Connection([
    [{ action_id: "action-a" }, { action_id: "action-b" }],
    { affectedRows: 2 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const ledger = ledgerFor(stale);
  const result = await ledger.reconcileStaleConsumedActions({
    gate6Id: "gate6-prod-001",
    staleBefore: "2026-07-11T02:00:00.000Z",
    now: new Date("2026-07-11T02:01:00.000Z"),
  });
  assert.deepEqual(result, { status: "revoked", ambiguousActionIds: ["action-a", "action-b"] });
  assert.ok(stale.calls.some(({ sql }) => /SET status = 'ambiguous'/.test(sql)));
}

async function runtimeControlLookups(): Promise<void> {
  const revoke = new Connection([{ affectedRows: 1 }, { affectedRows: 1 }]);
  const restore = new Connection([
    [{ gate6_id: "gate6-prod-001", action_id: "restore-legacy-001", status: "registered" }],
  ]);
  const renew = new Connection([{ affectedRows: 1 }, { affectedRows: 1 }]);
  const state = new Connection([
    [
      {
        gate6_id: "gate6-prod-001",
        status: "active",
        current_stage: "admitted",
        monitor_status: "green",
        monitor_lease_expires_at: "2026-07-11T02:02:00.000Z",
        supervisor_status: "green",
        supervisor_lease_expires_at: "2026-07-11T02:02:00.000Z",
        emergency_supervisor_lease_expires_at: "2026-07-11T04:00:00.000Z",
        expires_at: "2026-07-11T03:00:00.000Z",
      },
    ],
  ]);
  const ledger = ledgerFor(revoke, restore, renew, state);
  await ledger.revokeRun({
    gate6Id: "gate6-prod-001",
    reasonCode: "semantic-checker-failed",
    now: new Date("2026-07-11T02:01:00.000Z"),
  });
  assert.deepEqual(await ledger.getPostProofRestoreAction("gate6-prod-001"), {
    actionId: "restore-legacy-001",
    status: "registered",
  });
  await ledger.renewLease({
    gate6Id: "gate6-prod-001",
    lease: "supervisor",
    status: "green",
    expiresAt: "2026-07-11T02:02:00.000Z",
    now: new Date("2026-07-11T02:01:00.000Z"),
  });
  assert.equal((await ledger.getSupervisorState("gate6-prod-001")).status, "active");
}

async function emergencyAbortIsAtomicAndStageIndependent(): Promise<void> {
  const abort = new Connection([
    [{ owner_type: "gate6", owner_id: "gate6-prod-001", state: "releasing", version: 15 }],
    [
      {
        gate6_id: "gate6-prod-001",
        envelope_sha256: H("1"),
        envelope_core_sha256: H("2"),
        status: "releasing",
        current_stage: "sealed-verifying",
        monitor_status: "red",
        supervisor_status: "green",
      },
    ],
    [
      {
        gate6_id: "gate6-prod-001",
        scope: "gate6-abort",
        action_id: "abort-001",
        approval_sha256: H("3"),
        allowed_mutation_sha256: H("4"),
        kind: "emergency",
        paired_action_id: null,
        status: "registered",
        expires_at: "2026-07-11T04:00:00.000Z",
      },
    ],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const ledger = ledgerFor(abort);
  assert.deepEqual(
    await ledger.emergencyAbort({
      gate6Id: "gate6-prod-001",
      scope: "gate6-abort",
      actionId: "abort-001",
      approvalSha256: H("3"),
      allowedMutationSha256: H("4"),
      envelopeSha256: H("1"),
      envelopeCoreSha256: H("2"),
      reasonCode: "operator-abort",
      now: new Date("2026-07-11T02:01:00.000Z"),
    }),
    { status: "revoked", reasonCode: "operator-abort" },
  );
  assert.equal(abort.calls.filter(({ sql }) => /FOR UPDATE/.test(sql)).length, 3);
  assert.ok(
    abort.calls.some(
      ({ sql, params }) => /SET status = 'succeeded'/.test(sql) && params.includes("abort-001"),
    ),
  );
  assert.ok(
    abort.calls.some(
      ({ sql }) =>
        /SET status = 'revoked'/.test(sql) && /sealed-verifying/.test(sql) && /releasing/.test(sql),
    ),
  );
  assert.ok(abort.calls.some(({ sql }) => /state = 'revoked-uncompensated'/.test(sql)));
  assert.equal(
    abort.calls.some(({ sql }) => /monitor_lease_expires_at|supervisor_lease_expires_at/.test(sql)),
    false,
  );
}

async function compensationLifecycle(): Promise<void> {
  const begin = new Connection([
    [
      {
        owner_type: "gate6",
        owner_id: "gate6-prod-001",
        state: "revoked-uncompensated",
        version: 12,
      },
    ],
    [
      {
        gate6_id: "gate6-prod-001",
        envelope_sha256: H("a"),
        envelope_core_sha256: H("b"),
        status: "revoked",
        emergency_supervisor_lease_expires_at: "2026-07-11T04:00:00.000Z",
      },
    ],
    [
      {
        gate6_id: "gate6-prod-001",
        scope: "worker-ifn-restore-prior",
        action_id: "restore-worker-001",
        approval_sha256: H("c"),
        allowed_mutation_sha256: H("d"),
        kind: "compensation",
        paired_action_id: "worker-forward-001",
        status: "registered",
        expires_at: "2026-07-11T04:00:00.000Z",
      },
    ],
    [{ status: "ambiguous" }],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const finish = new Connection([
    { affectedRows: 1 },
    { affectedRows: 1 },
    [{ count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
  ]);
  const ledger = ledgerFor(begin, finish);
  const receipt = await ledger.beginCompensation({
    gate6Id: "gate6-prod-001",
    scope: "worker-ifn-restore-prior",
    actionId: "restore-worker-001",
    pairedActionId: "worker-forward-001",
    approvalSha256: H("c"),
    allowedMutationSha256: H("d"),
    envelopeSha256: H("a"),
    envelopeCoreSha256: H("b"),
    now: new Date("2026-07-11T02:00:00.000Z"),
  });
  await ledger.finishAction(receipt, {
    status: "succeeded",
    afterEvidenceSha256: H("e"),
    now: new Date("2026-07-11T02:00:10.000Z"),
  });
  assert.ok(finish.calls.some(({ sql }) => /SET status = 'compensated'/.test(sql)));
}

async function rollbackCompletion(): Promise<void> {
  const complete = new Connection([
    [{ gate6_id: "gate6-prod-001", status: "revoked" }],
    [{ owner_id: "gate6-prod-001", state: "revoked-uncompensated" }],
    [{ unsafe_count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const ledger = ledgerFor(complete);
  await ledger.completeRollback({
    gate6Id: "gate6-prod-001",
    rollbackEvidenceSha256: H("f"),
    now: new Date("2026-07-11T02:10:00.000Z"),
  });
  assert.ok(complete.calls.some(({ sql }) => /status = 'rolled-back'/.test(sql)));
  assert.ok(complete.calls.some(({ sql }) => /state = 'released'/.test(sql)));
}

async function faultPermitReconciliation(): Promise<void> {
  const disarm = new Connection([{ affectedRows: 2 }, [{ count: 0 }]]);
  const ledger = ledgerFor(disarm);
  assert.deepEqual(
    await ledger.disarmAllTask9Permits({
      gate6Id: "gate6-prod-001",
      now: new Date("2026-07-11T02:09:00.000Z"),
    }),
    { status: "disarmed", changedCount: 2 },
  );
}

async function postProofRegistration(): Promise<void> {
  const registration = new Connection([
    [
      {
        gate6_id: "gate6-prod-001",
        status: "active",
        current_stage: "pre-close-accepted",
        accepted_checker_sha256: H("e"),
        monitor_status: "green",
        monitor_lease_expires_at: "2026-07-11T02:03:00.000Z",
        supervisor_status: "green",
        supervisor_lease_expires_at: "2026-07-11T02:03:00.000Z",
      },
    ],
    [],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const ledger = ledgerFor(registration);
  const revoke = {
    scope: "db-principal-revoke-legacy",
    actionId: "revoke-legacy-001",
    approvalSha256: H("1"),
    allowedMutationSha256: H("2"),
    kind: "forward",
    pairedActionId: null,
    predecessorActionIds: [],
    requiredStage: "pre-close-accepted",
    requiredCheckerSha256: H("e"),
    expiresAt: "2026-07-11T02:05:00.000Z",
  };
  const restore = {
    scope: "db-principal-restore-legacy",
    actionId: "restore-legacy-001",
    approvalSha256: H("3"),
    allowedMutationSha256: H("4"),
    kind: "compensation",
    pairedActionId: revoke.actionId,
    predecessorActionIds: [],
    requiredStage: "revoked",
    requiredCheckerSha256: H("e"),
    expiresAt: "2026-07-11T04:00:00.000Z",
  };
  assert.deepEqual(
    await ledger.registerPostProofActions({
      gate6Id: "gate6-prod-001",
      expectedStage: "pre-close-accepted",
      expectedCheckerSha256: H("e"),
      revoke,
      restore,
      now: new Date("2026-07-11T02:00:00.000Z"),
    }),
    { status: "registered" },
  );
  assert.equal(
    registration.calls.filter(({ sql }) => /INSERT INTO gate6_actions/.test(sql)).length,
    2,
  );
}

async function terminalClose(): Promise<void> {
  const seal = new Connection([
    [
      {
        gate6_id: "gate6-prod-001",
        status: "active",
        current_stage: "pre-close-accepted",
        accepted_checker_sha256: H("e"),
        monitor_status: "green",
        monitor_lease_expires_at: "2026-07-11T02:03:00.000Z",
        supervisor_status: "green",
        supervisor_lease_expires_at: "2026-07-11T02:03:00.000Z",
      },
    ],
    [{ owner_id: "gate6-prod-001", state: "active", uncompensated_work: 0 }],
    [
      {
        gate6_id: "gate6-prod-001",
        scope: "gate6-seal-close",
        action_id: "seal-001",
        approval_sha256: H("a"),
        allowed_mutation_sha256: H("b"),
        status: "registered",
      },
    ],
    [
      {
        ambiguous_count: 0,
        incomplete_forward_count: 0,
        revoke_succeeded_count: 1,
        restore_registered_count: 1,
        restore_succeeded_count: 0,
      },
    ],
    [{ count: 0 }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const release = new Connection([
    [
      {
        gate6_id: "gate6-prod-001",
        status: "sealed-verifying",
        terminal_evidence_sha256: H("f"),
        monitor_status: "green",
        monitor_lease_expires_at: "2026-07-11T02:04:00.000Z",
        supervisor_status: "green",
        supervisor_lease_expires_at: "2026-07-11T02:04:00.000Z",
      },
    ],
    [{ owner_id: "gate6-prod-001", state: "sealed-verifying" }],
    [
      {
        gate6_id: "gate6-prod-001",
        scope: "gate6-release",
        action_id: "release-001",
        approval_sha256: H("a"),
        allowed_mutation_sha256: H("b"),
        status: "registered",
      },
    ],
    [
      {
        gate6_id: "gate6-prod-001",
        action_id: "restore-001",
        kind: "compensation",
        status: "registered",
      },
    ],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const complete = new Connection([
    [{ gate6_id: "gate6-prod-001", status: "releasing", terminal_evidence_sha256: H("f") }],
    [{ owner_id: "gate6-prod-001", state: "releasing" }],
    [{ gate6_id: "gate6-prod-001", action_id: "release-001", status: "consumed" }],
    [
      {
        gate6_id: "gate6-prod-001",
        action_id: "restore-001",
        kind: "compensation",
        status: "registered",
      },
    ],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const ledger = ledgerFor(seal, release, complete);
  await ledger.sealForVerification({
    gate6Id: "gate6-prod-001",
    scope: "gate6-seal-close",
    actionId: "seal-001",
    approvalSha256: H("a"),
    allowedMutationSha256: H("b"),
    expectedStage: "pre-close-accepted",
    expectedCheckerSha256: H("e"),
    terminalEvidenceSha256: H("f"),
    now: new Date("2026-07-11T02:00:20.000Z"),
  });
  assert.deepEqual(
    await ledger.releaseRun({
      gate6Id: "gate6-prod-001",
      scope: "gate6-release",
      actionId: "release-001",
      approvalSha256: H("a"),
      allowedMutationSha256: H("b"),
      terminalEvidenceSha256: H("f"),
      verifierSha256: H("9"),
      restoreActionId: "restore-001",
      now: new Date("2026-07-11T02:00:30.000Z"),
    }),
    { status: "releasing" },
  );
  assert.equal(
    release.calls.some(({ sql }) => /not_needed/.test(sql)),
    false,
  );
  await ledger.completeRelease({
    gate6Id: "gate6-prod-001",
    actionId: "release-001",
    restoreActionId: "restore-001",
    terminalEvidenceSha256: H("f"),
    cleanupEvidenceSha256: H("8"),
    now: new Date("2026-07-11T02:00:40.000Z"),
  });
  assert.ok(complete.calls.some(({ sql }) => /not_needed/.test(sql)));
  assert.ok(complete.calls.some(({ sql }) => /SET status = 'released'/.test(sql)));
}

async function finalVerifierSnapshot(): Promise<void> {
  const connection = new Connection([
    { affectedRows: 0 },
    { affectedRows: 0 },
    [
      {
        gate6_id: "gate6-prod-001",
        release_environment: "production",
        runtime_environment: "production",
        drill_mode: "supervised-production",
        compose_project: "spx-production",
        candidate_sha: "a".repeat(40),
        candidate_image_digest: `sha256:${H("8")}`,
        production_target_descriptor_sha256: H("3"),
        operator_bundle_sha256: H("4"),
        run_status: "sealed-verifying",
        current_stage: "sealed-verifying",
        stage_version: 8,
        accepted_checker_name: "gate6-seal-close",
        accepted_checker_sha256: H("f"),
        terminal_evidence_sha256: H("f"),
        monitor_status: "green",
        monitor_lease_expires_at: "2026-07-16T01:05:00.000Z",
        supervisor_status: "green",
        supervisor_lease_expires_at: "2026-07-16T01:05:00.000Z",
        emergency_supervisor_lease_expires_at: "2026-07-16T02:00:00.000Z",
        run_expires_at: "2026-07-16T03:00:00.000Z",
        slot_owner_type: "gate6",
        slot_owner_id: "gate6-prod-001",
        slot_state: "sealed-verifying",
        slot_version: 9,
        uncompensated_work: 0,
        slot_release_sha: "a".repeat(40),
        slot_target_descriptor_sha256: H("3"),
        slot_operator_bundle_sha256: H("4"),
        slot_heartbeat_at: "2026-07-16T01:00:00.000Z",
        slot_expires_at: "2026-07-16T03:00:00.000Z",
      },
    ],
    [
      {
        scope: "gate6-seal-close",
        action_id: "seal-001",
        kind: "forward",
        paired_action_id: null,
        required_stage: "pre-close-accepted",
        required_checker_sha256: H("e"),
        status: "succeeded",
        after_evidence_sha256: H("f"),
        completed_at: "2026-07-16T01:00:00.000Z",
      },
    ],
    [{ active_permit_count: 0 }],
  ]);
  const ledger = ledgerFor(connection);
  const snapshot = await ledger.getFinalVerifierSnapshot("gate6-prod-001");
  assert.deepEqual(snapshot, {
    run: {
      gate6Id: "gate6-prod-001",
      releaseEnvironment: "production",
      runtimeEnvironment: "production",
      drillMode: "supervised-production",
      composeProject: "spx-production",
      candidateSha: "a".repeat(40),
      candidateImageDigest: `sha256:${H("8")}`,
      productionTargetDescriptorSha256: H("3"),
      operatorBundleSha256: H("4"),
      status: "sealed-verifying",
      currentStage: "sealed-verifying",
      stageVersion: 8,
      acceptedCheckerName: "gate6-seal-close",
      acceptedCheckerSha256: H("f"),
      terminalEvidenceSha256: H("f"),
      monitorStatus: "green",
      monitorLeaseExpiresAt: "2026-07-16T01:05:00.000Z",
      supervisorStatus: "green",
      supervisorLeaseExpiresAt: "2026-07-16T01:05:00.000Z",
      emergencySupervisorLeaseExpiresAt: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T03:00:00.000Z",
    },
    slot: {
      ownerType: "gate6",
      ownerId: "gate6-prod-001",
      state: "sealed-verifying",
      version: 9,
      uncompensatedWork: false,
      releaseSha: "a".repeat(40),
      targetDescriptorSha256: H("3"),
      operatorBundleSha256: H("4"),
      heartbeatAt: "2026-07-16T01:00:00.000Z",
      expiresAt: "2026-07-16T03:00:00.000Z",
    },
    actions: [
      {
        scope: "gate6-seal-close",
        actionId: "seal-001",
        kind: "forward",
        pairedActionId: null,
        requiredStage: "pre-close-accepted",
        requiredCheckerSha256: H("e"),
        status: "succeeded",
        afterEvidenceSha256: H("f"),
        completedAt: "2026-07-16T01:00:00.000Z",
      },
    ],
    activePermitCount: 0,
  });
  assert.equal(connection.beginCount, 1);
  assert.equal(connection.commitCount, 1);
  assert.equal(connection.rollbackCount, 0);
  assert.equal(connection.releaseCount, 1);
  assert.equal(connection.calls.length, 5);
  assert.equal(
    connection.calls[0].sql,
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  );
  assert.equal(connection.calls[1].sql, "SET TRANSACTION READ ONLY");
  assert.ok(connection.calls[2].sql.includes("JOIN gate6_environment_slots"));
  assert.ok(connection.calls[3].sql.includes("ORDER BY scope, action_id"));
  assert.ok(connection.calls[4].sql.includes("status = 'armed'"));
  assert.deepEqual(connection.calls.map(({ params }) => params), [
    [],
    [],
    ["gate6-prod-001"],
    ["gate6-prod-001"],
    ["gate6-prod-001"],
  ]);
}

async function main(): Promise<void> {
  await installedRunAdmission();
  await semanticAcceptance();
  await acceptedSemanticBinding();
  await staleConsumption();
  await runtimeControlLookups();
  await emergencyAbortIsAtomicAndStageIndependent();
  await compensationLifecycle();
  await faultPermitReconciliation();
  await postProofRegistration();
  await rollbackCompletion();
  await terminalClose();
  await finalVerifierSnapshot();
  console.log("Gate 6 MySQL executable terminal ledger tests passed");
}

void main();
