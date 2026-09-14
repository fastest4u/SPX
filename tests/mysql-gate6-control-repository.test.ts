import assert from "node:assert/strict";

import type { Gate6SqlConnection } from "../src/db/gate6-action-transaction.js";
import { MySqlGate6ControlRepository } from "../src/repositories/mysql-gate6-control-repository.js";

const H = (character: string): string => character.repeat(64);

class Connection implements Gate6SqlConnection {
  began = 0;
  committed = 0;
  rolledBack = 0;
  released = 0;
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  constructor(private readonly responses: unknown[]) {}
  async beginTransaction(): Promise<void> { this.began += 1; }
  async commit(): Promise<void> { this.committed += 1; }
  async rollback(): Promise<void> { this.rolledBack += 1; }
  release(): void { this.released += 1; }
  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values: [...values] });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`unexpected SQL: ${sql}`);
    return [response, []];
  }
}

function repositoryWith(connections: Connection[]): MySqlGate6ControlRepository {
  const pending = [...connections];
  return new MySqlGate6ControlRepository({
    async getConnection() {
      const connection = pending.shift();
      if (!connection) throw new Error("missing fake connection");
      return connection;
    },
  });
}

function sqlCall(
  connection: Connection,
  pattern: RegExp,
  occurrence = 0,
): { sql: string; values: readonly unknown[] } {
  const matches = connection.calls.filter(({ sql }) => pattern.test(sql));
  const match = matches[occurrence];
  assert.ok(match, `missing SQL call ${pattern} at occurrence ${occurrence}`);
  return match;
}

async function testTask9PermitRegistrationBindings(): Promise<void> {
  const at = "2026-07-11T01:00:00.000Z";
  const expiresAt = "2026-07-11T01:01:30.000Z";
  const gate6Id = "gate6-prod-bindings";
  const scope = "task9-line-fault";
  const actionId = "task9-line-001";
  const permitId = "permit-line-001";
  const connection = new Connection([
    [{ owner_id: gate6Id, state: "active", version: 23 }],
    [{
      gate6_id: gate6Id,
      status: "active",
      current_stage: "db-transition-stable",
      accepted_checker_sha256: H("6"),
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      expires_at: "2026-07-11T01:05:00.000Z",
    }],
    [{
      gate6_id: gate6Id,
      scope,
      action_id: actionId,
      status: "registered",
      approval_sha256: H("1"),
      allowed_mutation_sha256: H("2"),
      expires_at: "2026-07-11T01:02:00.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const repository = repositoryWith([connection]);
  const input = {
    gate6Id,
    scope,
    actionId,
    approvalSha256: H("1"),
    allowedMutationSha256: H("2"),
    permitId,
    service: "line-service" as const,
    kind: "line-timeout-drill",
    teamId: 2,
    drillSha256: H("3"),
    targetSha256: H("4"),
    fixtureSha256: null,
    signedPermitSha256: H("5"),
    keyId: "gate6-line-key-v1",
    expectedCheckerSha256: H("6"),
    expiresAt,
    now: new Date(at),
  };

  const receipt = await repository.registerTask9Permit(input);

  assert.deepEqual(receipt, { status: "armed", gate6Id, scope, actionId, permitId });
  assert.deepEqual(
    sqlCall(connection, /INSERT INTO gate6_fault_permits/i).values,
    [
      permitId, gate6Id, scope, actionId, "line-service", "line-timeout-drill", 2,
      H("3"), H("4"), null, H("5"), "gate6-line-key-v1", expiresAt, at, at,
    ],
    "Task 9 permit registration must preserve the signed artifact and column bind order",
  );
  assert.deepEqual(
    sqlCall(connection, /UPDATE gate6_actions SET status = 'consumed'/i).values,
    [at, at, gate6Id, scope, actionId],
  );
  assert.deepEqual(
    sqlCall(connection, /UPDATE gate6_environment_slots SET uncompensated_work = 1/i).values,
    [at, at, gate6Id, 23],
  );
  assert.equal(connection.committed, 1);
  assert.equal(connection.rolledBack, 0);
  assert.equal(connection.released, 1);

  let connectionRequests = 0;
  const rejectingRepository = new MySqlGate6ControlRepository({
    async getConnection() {
      connectionRequests += 1;
      throw new Error("invalid input must not request a connection");
    },
  });
  await assert.rejects(
    rejectingRepository.registerTask9Permit({ ...input, signedPermitSha256: H("g") }),
    /signed permit hash is invalid/i,
  );
  assert.equal(connectionRequests, 0, "invalid signed permit hashes must fail before SQL");
}

async function testTask9PermitConsumptionBindings(): Promise<void> {
  const at = "2026-07-11T01:00:10.000Z";
  const permitId = "permit-line-001";
  const successConnection = new Connection([
    [{
      permit_id: permitId,
      service: "line-service",
      team_id: 2,
      target_sha256: H("4"),
      fixture_sha256: null,
      signed_permit_sha256: H("5"),
      status: "armed",
      expires_at: "2026-07-11T01:01:30.000Z",
    }],
    { affectedRows: 1 },
  ]);
  const repository = repositoryWith([successConnection]);

  assert.deepEqual(await repository.consumeTask9Permit({
    permitId,
    service: "line-service",
    teamId: 2,
    signedPermitSha256: H("5"),
    targetSha256: H("4"),
    now: new Date(at),
  }), { status: "consumed" });
  assert.deepEqual(
    sqlCall(successConnection, /FROM gate6_fault_permits WHERE permit_id = \? FOR UPDATE/i).values,
    [permitId],
  );
  assert.deepEqual(
    sqlCall(successConnection, /UPDATE gate6_fault_permits SET status = 'consumed'/i).values,
    [at, at, permitId],
  );
  assert.equal(successConnection.committed, 1);

  const mismatchConnection = new Connection([[
    {
      permit_id: permitId,
      service: "line-service",
      team_id: 2,
      target_sha256: H("4"),
      fixture_sha256: null,
      signed_permit_sha256: H("5"),
      status: "armed",
      expires_at: "2026-07-11T01:01:30.000Z",
    },
  ]]);
  const mismatchRepository = repositoryWith([mismatchConnection]);
  await assert.rejects(
    mismatchRepository.consumeTask9Permit({
      permitId,
      service: "line-service",
      teamId: 2,
      signedPermitSha256: H("6"),
      targetSha256: H("4"),
      now: new Date(at),
    }),
    /unavailable or does not match/i,
  );
  assert.equal(mismatchConnection.calls.length, 1, "artifact mismatch must not consume the permit");
  assert.equal(mismatchConnection.committed, 0);
  assert.equal(mismatchConnection.rolledBack, 1);
  assert.equal(mismatchConnection.released, 1);
}

async function testTask9AmbiguousCompletionAndDisarmBindings(): Promise<void> {
  const at = "2026-07-11T01:00:20.000Z";
  const gate6Id = "gate6-prod-bindings";
  const scope = "task9-line-fault";
  const actionId = "task9-line-001";
  const permitId = "permit-line-001";
  const completionConnection = new Connection([
    [{
      gate6_id: gate6Id,
      scope,
      action_id: actionId,
      action_status: "consumed",
      permit_id: permitId,
      permit_status: "consumed",
      disarmed_at: "2026-07-11T01:00:19.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const repository = repositoryWith([completionConnection]);

  await repository.completeTask9PermitAction(
    { status: "armed", gate6Id, scope, actionId, permitId },
    { status: "ambiguous", afterEvidenceSha256: H("7"), now: new Date(at) },
  );
  assert.deepEqual(
    sqlCall(completionConnection, /UPDATE gate6_actions SET status = \?, after_evidence_sha256/i).values,
    ["ambiguous", H("7"), at, at, gate6Id, scope, actionId],
    "ambiguous must be persisted as the action status, not collapsed to succeeded",
  );
  assert.deepEqual(
    sqlCall(completionConnection, /UPDATE gate6_runs SET status = 'revoked'/i).values,
    ["task9-controller-failure", at, gate6Id],
  );
  assert.deepEqual(
    sqlCall(completionConnection, /UPDATE gate6_environment_slots SET state = 'revoked-uncompensated'/i).values,
    [at, at, gate6Id],
  );
  assert.equal(completionConnection.committed, 1);

  const disarmConnection = new Connection([{ affectedRows: 1 }]);
  await repositoryWith([disarmConnection]).disarmTask9Permit({ permitId, now: new Date(at) });
  assert.deepEqual(
    sqlCall(disarmConnection, /SET status = IF\(status = 'armed', 'disarmed', status\)/i).values,
    [at, at, permitId],
  );
  assert.equal(disarmConnection.began, 0, "single-statement disarm should not open a transaction");
  assert.equal(disarmConnection.released, 1);
}

async function testPostProofRegistrationBindings(): Promise<void> {
  const at = "2026-07-11T01:00:30.000Z";
  const expiresAt = "2026-07-11T01:04:00.000Z";
  const gate6Id = "gate6-prod-bindings";
  const revoke = {
    scope: "db-principal-revoke-legacy",
    actionId: "postproof-revoke-001",
    approvalSha256: H("8"),
    allowedMutationSha256: H("9"),
    kind: "forward" as const,
    pairedActionId: null,
    predecessorActionIds: ["pre-close-checker-001"],
    requiredStage: "pre-close-accepted",
    requiredCheckerSha256: H("a"),
    expiresAt,
  };
  const restore = {
    scope: "db-principal-restore-legacy",
    actionId: "postproof-restore-001",
    approvalSha256: H("b"),
    allowedMutationSha256: H("c"),
    kind: "compensation" as const,
    pairedActionId: revoke.actionId,
    predecessorActionIds: [revoke.actionId],
    requiredStage: "pre-close-accepted",
    requiredCheckerSha256: H("a"),
    expiresAt,
  };
  const connection = new Connection([
    [{
      status: "active",
      current_stage: "pre-close-accepted",
      accepted_checker_sha256: H("a"),
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:02:00.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const repository = repositoryWith([connection]);

  await repository.registerPostProofActions({
    gate6Id,
    expectedStage: "pre-close-accepted",
    expectedCheckerSha256: H("a"),
    revoke,
    restore,
    now: new Date(at),
  });
  assert.deepEqual(
    sqlCall(connection, /INSERT INTO gate6_actions/i, 0).values,
    [
      gate6Id, revoke.scope, revoke.actionId, H("8"), H("9"), "forward", null,
      JSON.stringify(revoke.predecessorActionIds), "pre-close-accepted", H("a"), expiresAt, at, at,
    ],
  );
  assert.deepEqual(
    sqlCall(connection, /INSERT INTO gate6_actions/i, 1).values,
    [
      gate6Id, restore.scope, restore.actionId, H("b"), H("c"), "compensation", revoke.actionId,
      JSON.stringify(restore.predecessorActionIds), "pre-close-accepted", H("a"), expiresAt, at, at,
    ],
  );
  assert.equal(connection.committed, 1);
  assert.equal(connection.released, 1);

  let connectionRequests = 0;
  const rejectingRepository = new MySqlGate6ControlRepository({
    async getConnection() {
      connectionRequests += 1;
      throw new Error("invalid pair must not request a connection");
    },
  });
  await assert.rejects(
    rejectingRepository.registerPostProofActions({
      gate6Id,
      expectedStage: "pre-close-accepted",
      expectedCheckerSha256: H("a"),
      revoke,
      restore: { ...restore, pairedActionId: "different-revoke" },
      now: new Date(at),
    }),
    /post-proof action pair is invalid/i,
  );
  assert.equal(connectionRequests, 0, "invalid post-proof pairs must fail before SQL");
}

async function main(): Promise<void> {
  const beginConnection = new Connection([
    [{ environment: "production", owner_type: "gate6", owner_id: "gate6-prod-001", state: "active", version: 5 }],
    [{
      gate6_id: "gate6-prod-001",
      status: "active",
      current_stage: "admitted",
      envelope_sha256: H("a"),
      envelope_core_sha256: H("b"),
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      emergency_supervisor_lease_expires_at: "2026-07-11T03:00:00.000Z",
      expires_at: "2026-07-11T01:05:00.000Z",
      accepted_checker_sha256: null,
    }],
    [{
      gate6_id: "gate6-prod-001",
      scope: "worker-ifn-forward",
      action_id: "action-001",
      approval_sha256: H("a"),
      allowed_mutation_sha256: H("c"),
      kind: "forward",
      paired_action_id: null,
      status: "registered",
      required_stage: "admitted",
      required_checker_sha256: null,
      predecessor_action_ids_json: "[]",
      expires_at: "2026-07-11T01:04:00.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const finishConnection = new Connection([
    [{
      gate6_id: "gate6-prod-001",
      scope: "worker-ifn-forward",
      action_id: "action-001",
      kind: "forward",
      paired_action_id: null,
      status: "consumed",
    }],
    { affectedRows: 1 },
    [{ count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
  ]);
  const leaseConnection = new Connection([
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const contextConnection = new Connection([[
    {
      gate6_id: "gate6-prod-001",
      gate6_nonce: "nonce-prod-001",
      envelope_core_sha256: H("b"),
      current_stage: "db-transition-stable",
      accepted_checker_sha256: H("e"),
      candidate_sha: "a".repeat(40),
      permit_id: "permit-line-001",
      action_id: "task9-line-001",
      signed_permit_sha256: H("f"),
      service: "line-service",
      team_id: 2,
    },
  ]]);
  const connections = [beginConnection, finishConnection, leaseConnection, contextConnection];
  const repository = new MySqlGate6ControlRepository({
    async getConnection() {
      const connection = connections.shift();
      if (!connection) throw new Error("missing fake connection");
      return connection;
    },
  });
  const receipt = await repository.beginAction({
    gate6Id: "gate6-prod-001",
    scope: "worker-ifn-forward",
    actionId: "action-001",
    approvalSha256: H("a"),
    allowedMutationSha256: H("c"),
    envelopeSha256: H("a"),
    envelopeCoreSha256: H("b"),
    expectedStage: "admitted",
    now: new Date("2026-07-11T01:00:00.000Z"),
  });
  await repository.finishAction(receipt, {
    status: "succeeded",
    afterEvidenceSha256: H("d"),
    now: new Date("2026-07-11T01:00:10.000Z"),
  });
  await repository.renewLease({
    gate6Id: "gate6-prod-001",
    lease: "monitor",
    status: "green",
    expiresAt: "2026-07-11T01:01:00.000Z",
    now: new Date("2026-07-11T01:00:20.000Z"),
  });
  const activeFault = await repository.getActiveFaultContext({
    gate6Id: "gate6-prod-001",
    service: "line-service",
    repository: "owner/SPX",
    now: new Date("2026-07-11T01:00:20.000Z"),
  });
  assert.deepEqual(activeFault, {
    gate6Id: "gate6-prod-001",
    gate6Nonce: "nonce-prod-001",
    envelopeCoreSha256: H("b"),
    permitId: "permit-line-001",
    actionId: "task9-line-001",
    signedPermitSha256: H("f"),
    currentStage: "db-transition-stable",
    acceptedCheckerSha256: H("e"),
    teamId: 2,
    candidateSha: "a".repeat(40),
    repository: "owner/SPX",
  });
  assert.equal(beginConnection.committed, 1);
  assert.equal(finishConnection.committed, 1);
  assert.equal(leaseConnection.committed, 1);
  assert.equal(beginConnection.released, 1);
  assert.equal(finishConnection.released, 1);
  assert.equal(leaseConnection.released, 1);
  assert.equal(contextConnection.released, 1);
  assert.ok(finishConnection.calls.some(({ sql }) => /UPDATE gate6_actions/i.test(sql)));
  assert.ok(leaseConnection.calls.some(({ sql }) => /monitor_lease_expires_at/i.test(sql)));
  assert.ok(beginConnection.calls.some(({ values }) => values.length > 0), "fake connection must retain SQL bind arrays");
  await testTask9PermitRegistrationBindings();
  await testTask9PermitConsumptionBindings();
  await testTask9AmbiguousCompletionAndDisarmBindings();
  await testPostProofRegistrationBindings();
  console.log("MySQL Gate 6 control repository tests passed");
}

void main();
