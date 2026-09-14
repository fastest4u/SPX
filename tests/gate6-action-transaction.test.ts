import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  admitDurableGate6Run,
  beginDurableGate6Action,
  type Gate6SqlConnection,
} from "../src/db/gate6-action-transaction.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const NOW = new Date("2026-07-11T01:00:00.000Z");

class FakeConnection implements Gate6SqlConnection {
  readonly calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  began = 0;
  committed = 0;
  rolledBack = 0;

  constructor(
    private readonly responses: unknown[],
  ) {}

  async beginTransaction(): Promise<void> {
    this.began += 1;
  }

  async commit(): Promise<void> {
    this.committed += 1;
  }

  async rollback(): Promise<void> {
    this.rolledBack += 1;
  }

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push({ sql: sql.replace(/\s+/g, " ").trim(), parameters });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`unexpected SQL: ${sql}`);
    return [response, []];
  }
}

function validRows() {
  return [
    [{
      environment: "production",
      owner_type: "gate6",
      owner_id: "gate6-prod-001",
      state: "active",
      version: 7,
    }],
    [{
      gate6_id: "gate6-prod-001",
      status: "active",
      current_stage: "admitted",
      envelope_sha256: HASH_A,
      envelope_core_sha256: HASH_B,
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      expires_at: "2026-07-11T01:05:00.000Z",
    }],
    [{
      gate6_id: "gate6-prod-001",
      scope: "worker-ifn-forward",
      action_id: "worker-ifn-forward-001",
      approval_sha256: HASH_A,
      allowed_mutation_sha256: HASH_C,
      kind: "forward",
      status: "registered",
      required_stage: "admitted",
      required_checker_sha256: null,
      predecessor_action_ids_json: "[]",
      expires_at: "2026-07-11T01:04:00.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ];
}

async function testAtomicConsumption(): Promise<void> {
  const connection = new FakeConnection(validRows());
  const receipt = await beginDurableGate6Action(connection, {
    gate6Id: "gate6-prod-001",
    scope: "worker-ifn-forward",
    actionId: "worker-ifn-forward-001",
    approvalSha256: HASH_A,
    allowedMutationSha256: HASH_C,
    envelopeSha256: HASH_A,
    envelopeCoreSha256: HASH_B,
    expectedStage: "admitted",
    now: NOW,
  });

  assert.equal(receipt.status, "consumed");
  assert.equal(connection.began, 1);
  assert.equal(connection.committed, 1);
  assert.equal(connection.rolledBack, 0);
  assert.match(connection.calls[0].sql, /gate6_environment_slots.+FOR UPDATE/i);
  assert.match(connection.calls[1].sql, /gate6_runs.+FOR UPDATE/i);
  assert.match(connection.calls[2].sql, /gate6_actions.+FOR UPDATE/i);
  assert.ok(connection.calls.some(({ sql }) => /UPDATE gate6_actions SET status = 'consumed'/i.test(sql)));
  assert.ok(connection.calls.every(({ sql }) => !/^INSERT\s+INTO\s+gate6_actions/i.test(sql)));
}

async function testProtectedInstallTransferAdmission(): Promise<void> {
  const action = {
    scope: "gate6-admit",
    actionId: "gate6-admit-001",
    approvalSha256: HASH_A,
    allowedMutationSha256: HASH_C,
    kind: "forward" as const,
    pairedActionId: null,
    predecessorActionIds: [],
    requiredStage: "admitted",
    requiredCheckerSha256: null,
    expiresAt: "2026-07-11T01:04:00.000Z",
  };
  const connection = new FakeConnection([
    [{
      environment: "production",
      owner_type: "protected-install",
      owner_id: "install-001",
      operation_id: "install-001",
      transfer_token_sha256: HASH_B,
      state: "installed-awaiting-gate6",
      version: 4,
      protected_install_evidence_sha256: HASH_A,
      release_sha: "a".repeat(40),
      target_descriptor_sha256: HASH_B,
      operator_bundle_sha256: HASH_C,
      installed_migration_set_sha256: "d".repeat(64),
      installed_schema_version: 36,
      heartbeat_at: "2026-07-11T00:59:50.000Z",
      expires_at: "2026-07-12T01:00:00.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const admitted = await admitDurableGate6Run(connection, {
    gate6Id: "gate6-prod-001",
    gate6Nonce: "nonce-prod-001",
    envelopeSha256: HASH_A,
    envelopeCoreSha256: HASH_B,
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    composeProject: "spx-production",
    candidateSha: "a".repeat(40),
    candidateImageDigest: `sha256:${"b".repeat(64)}`,
    rollbackSha: "c".repeat(40),
    rollbackImageDigest: `sha256:${"d".repeat(64)}`,
    productionTargetDescriptorSha256: HASH_B,
    operatorBundleSha256: HASH_C,
    protectedInstallEvidenceSha256: HASH_A,
    installedMigrationSetSha256: "d".repeat(64),
    installedSchemaVersion: 36,
    expiresAt: "2026-07-11T01:05:00.000Z",
    monitorLeaseExpiresAt: "2026-07-11T01:02:00.000Z",
    supervisorLeaseExpiresAt: "2026-07-11T01:02:00.000Z",
    emergencySupervisorLeaseExpiresAt: "2026-07-11T03:00:00.000Z",
    installOperationId: "install-001",
    transferTokenSha256: HASH_B,
    admitActionId: action.actionId,
    actions: [action],
    now: NOW,
  });
  assert.deepEqual(admitted, { status: "admitted", slotVersion: 5 });
  assert.equal(connection.committed, 1);
  assert.ok(connection.calls.some(({ sql }) => /INSERT INTO gate6_runs/i.test(sql)));
  assert.ok(connection.calls.some(({ sql }) => /INSERT INTO gate6_actions/i.test(sql)));
  assert.ok(connection.calls.every(({ sql }) => !/INSERT INTO gate6_environment_slots/i.test(sql)));
  assert.match(connection.calls.at(-1)?.sql ?? "", /UPDATE gate6_environment_slots/i);

  const absentSlot = new FakeConnection([[]]);
  await assert.rejects(
    () => admitDurableGate6Run(absentSlot, {
      gate6Id: "gate6-prod-001",
      gate6Nonce: "nonce-prod-001",
      envelopeSha256: HASH_A,
      envelopeCoreSha256: HASH_B,
      releaseEnvironment: "production",
      runtimeEnvironment: "production",
      drillMode: "supervised-production",
      composeProject: "spx-production",
      candidateSha: "a".repeat(40),
      candidateImageDigest: `sha256:${"b".repeat(64)}`,
      rollbackSha: "c".repeat(40),
      rollbackImageDigest: `sha256:${"d".repeat(64)}`,
      productionTargetDescriptorSha256: HASH_B,
      operatorBundleSha256: HASH_C,
      protectedInstallEvidenceSha256: HASH_A,
      installedMigrationSetSha256: "d".repeat(64),
      installedSchemaVersion: 36,
      expiresAt: "2026-07-11T01:05:00.000Z",
      monitorLeaseExpiresAt: "2026-07-11T01:02:00.000Z",
      supervisorLeaseExpiresAt: "2026-07-11T01:02:00.000Z",
      emergencySupervisorLeaseExpiresAt: "2026-07-11T03:00:00.000Z",
      installOperationId: "install-001",
      transferTokenSha256: HASH_B,
      admitActionId: action.actionId,
      actions: [action],
      now: NOW,
    }),
    /installed-awaiting-gate6|slot/i,
  );
  assert.equal(absentSlot.rolledBack, 1);
}

async function testCasReplayFailsClosed(): Promise<void> {
  const responses = validRows();
  responses[3] = { affectedRows: 0 };
  const connection = new FakeConnection(responses);
  await assert.rejects(
    () => beginDurableGate6Action(connection, {
      gate6Id: "gate6-prod-001",
      scope: "worker-ifn-forward",
      actionId: "worker-ifn-forward-001",
      approvalSha256: HASH_A,
      allowedMutationSha256: HASH_C,
      envelopeSha256: HASH_A,
      envelopeCoreSha256: HASH_B,
      expectedStage: "admitted",
      now: NOW,
    }),
    /compare-and-swap|already consumed|ambiguous/i,
  );
  assert.equal(connection.committed, 0);
  assert.equal(connection.rolledBack, 1);
}

async function testStaleLeaseRollsBack(): Promise<void> {
  const responses = validRows();
  const runRows = responses[1] as Array<Record<string, unknown>>;
  runRows[0].monitor_lease_expires_at = "2026-07-11T00:59:59.000Z";
  const connection = new FakeConnection(responses);
  await assert.rejects(
    () => beginDurableGate6Action(connection, {
      gate6Id: "gate6-prod-001",
      scope: "worker-ifn-forward",
      actionId: "worker-ifn-forward-001",
      approvalSha256: HASH_A,
      allowedMutationSha256: HASH_C,
      envelopeSha256: HASH_A,
      envelopeCoreSha256: HASH_B,
      expectedStage: "admitted",
      now: NOW,
    }),
    /monitor lease/i,
  );
  assert.equal(connection.committed, 0);
  assert.equal(connection.rolledBack, 1);
  assert.ok(connection.calls.every(({ sql }) => !sql.startsWith("UPDATE gate6_actions")));
}

async function testCaseVariantIdentityFailsClosed(): Promise<void> {
  const responses = validRows();
  const actionRows = responses[2] as Array<Record<string, unknown>>;
  actionRows[0].scope = "WORKER-IFN-FORWARD";
  const connection = new FakeConnection(responses);
  await assert.rejects(
    () => beginDurableGate6Action(connection, {
      gate6Id: "gate6-prod-001",
      scope: "worker-ifn-forward",
      actionId: "worker-ifn-forward-001",
      approvalSha256: HASH_A,
      allowedMutationSha256: HASH_C,
      envelopeSha256: HASH_A,
      envelopeCoreSha256: HASH_B,
      expectedStage: "admitted",
      now: NOW,
    }),
    /action identity mismatch/i,
  );
  assert.equal(connection.rolledBack, 1);
}

async function testCompensationValidityIsEnforced(): Promise<void> {
  const responses = validRows();
  responses.splice(3, 0, [{ expires_at: "2026-07-11T01:00:30.000Z" }]);
  const connection = new FakeConnection(responses);
  await assert.rejects(
    () => beginDurableGate6Action(connection, {
      gate6Id: "gate6-prod-001",
      scope: "worker-ifn-forward",
      actionId: "worker-ifn-forward-001",
      approvalSha256: HASH_A,
      allowedMutationSha256: HASH_C,
      envelopeSha256: HASH_A,
      envelopeCoreSha256: HASH_B,
      expectedStage: "admitted",
      minimumCompensationValidityMs: 60_000,
      now: NOW,
    }),
    /compensation validity/i,
  );
  assert.equal(connection.rolledBack, 1);
}

async function testMigrationContract(): Promise<void> {
  const migrationPath = fileURLToPath(new URL("../migrations/036_create_gate6_control_plane.sql", import.meta.url));
  const sql = await readFile(migrationPath, "utf8");
  for (const table of [
    "gate6_environment_slots",
    "gate6_runs",
    "gate6_actions",
    "gate6_fault_permits",
  ]) assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`, "i"));
  assert.match(sql, /CREATE OR REPLACE SQL SECURITY DEFINER VIEW operational_gate6_terminal_evidence/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.equal((sql.match(/DEFAULT CHARSET=ascii COLLATE=ascii_bin/g) ?? []).length, 4);
  const view = sql.slice(sql.search(/CREATE OR REPLACE SQL SECURITY DEFINER VIEW/i));
  assert.doesNotMatch(view, /gate6_nonce|signature|approval_sha256|allowed_mutation_sha256|target_sha256|fixture_sha256/i);
  assert.match(view, /FROM gate6_actions\s+GROUP BY gate6_id\s*\) a/is);
  assert.match(view, /FROM gate6_fault_permits\s+GROUP BY gate6_id\s*\) p/is);
  assert.doesNotMatch(view, /LEFT JOIN gate6_actions a\b/i);
  assert.match(view, /forward_succeeded_count/);
  assert.match(view, /forward_compensated_count/);
  assert.match(view, /compensation_compensated_count/);
  assert.match(view, /emergency_succeeded_count/);
}

async function main(): Promise<void> {
  await testAtomicConsumption();
  await testProtectedInstallTransferAdmission();
  await testCasReplayFailsClosed();
  await testStaleLeaseRollsBack();
  await testCaseVariantIdentityFailsClosed();
  await testCompensationValidityIsEnforced();
  await testMigrationContract();
  console.log("gate6 durable action transaction tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
