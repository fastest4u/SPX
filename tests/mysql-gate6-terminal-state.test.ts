import assert from "node:assert/strict";

import type { Gate6SqlConnection } from "../src/db/gate6-action-transaction.js";
import { MySqlGate6ControlRepository } from "../src/repositories/mysql-gate6-control-repository.js";

const H = (character: string): string => character.repeat(64);

class Connection implements Gate6SqlConnection {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly responses: unknown[]) {}
  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  release(): void {}
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`unexpected SQL: ${sql}`);
    return [response, []];
  }
}

function repositoryFor(...connections: Connection[]): MySqlGate6ControlRepository {
  return new MySqlGate6ControlRepository({
    async getConnection() {
      const connection = connections.shift();
      if (!connection) throw new Error("missing fake connection");
      return connection;
    },
  });
}

async function task9Lifecycle(): Promise<void> {
  const registration = new Connection([
    [{ owner_id: "gate6-prod-001", state: "active", version: 7 }],
    [{
      gate6_id: "gate6-prod-001",
      status: "active",
      current_stage: "db-transition-stable",
      accepted_checker_sha256: H("e"),
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      expires_at: "2026-07-11T01:05:00.000Z",
    }],
    [{
      gate6_id: "gate6-prod-001",
      scope: "task9-line-boundary",
      action_id: "task9-line-001",
      status: "registered",
      approval_sha256: H("a"),
      allowed_mutation_sha256: H("b"),
      expires_at: "2026-07-11T01:04:00.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const completion = new Connection([
    [{
      gate6_id: "gate6-prod-001",
      scope: "task9-line-boundary",
      action_id: "task9-line-001",
      action_status: "consumed",
      permit_id: "permit-line-001",
      permit_status: "consumed",
      disarmed_at: "2026-07-11T01:00:05.000Z",
    }],
    { affectedRows: 1 },
    [{ count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
  ]);
  const repository = repositoryFor(registration, completion);
  const receipt = await repository.registerTask9Permit({
    gate6Id: "gate6-prod-001",
    scope: "task9-line-boundary",
    actionId: "task9-line-001",
    approvalSha256: H("a"),
    allowedMutationSha256: H("b"),
    permitId: "permit-line-001",
    service: "line-service",
    kind: "retryable-before-provider",
    teamId: 2,
    drillSha256: H("c"),
    targetSha256: H("d"),
    fixtureSha256: null,
    signedPermitSha256: H("f"),
    keyId: "gate6-line-2026-07",
    expectedCheckerSha256: H("e"),
    expiresAt: "2026-07-11T01:01:00.000Z",
    now: new Date("2026-07-11T01:00:00.000Z"),
  });
  assert.equal(receipt.status, "armed");
  assert.ok(registration.calls.some(({ sql }) => /SET uncompensated_work = 1/.test(sql)));
  await repository.completeTask9PermitAction(receipt, {
    status: "succeeded",
    afterEvidenceSha256: H("9"),
    now: new Date("2026-07-11T01:00:06.000Z"),
  });
  assert.ok(completion.calls.some(({ sql, params }) =>
    /SET status = \?/.test(sql) && params[0] === "succeeded"));
}

async function task9AmbiguousRevokes(): Promise<void> {
  const completion = new Connection([
    [{
      gate6_id: "gate6-prod-ambiguous",
      scope: "task9-line-boundary",
      action_id: "task9-line-ambiguous",
      action_status: "consumed",
      permit_id: "permit-line-ambiguous",
      permit_status: "disarmed",
      disarmed_at: "2026-07-11T01:00:05.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const repository = repositoryFor(completion);
  await repository.completeTask9PermitAction({
    status: "armed",
    gate6Id: "gate6-prod-ambiguous",
    scope: "task9-line-boundary",
    actionId: "task9-line-ambiguous",
    permitId: "permit-line-ambiguous",
  }, {
    status: "ambiguous",
    afterEvidenceSha256: H("8"),
    now: new Date("2026-07-11T01:00:06.000Z"),
  });
  assert.ok(completion.calls.some(({ sql, params }) =>
    /SET status = \?/.test(sql) && params[0] === "ambiguous"));
  assert.ok(completion.calls.some(({ sql, params }) =>
    /SET status = 'revoked'/.test(sql) && params[0] === "task9-controller-failure"));
  assert.ok(completion.calls.some(({ sql }) => /revoked-uncompensated/.test(sql)));
}

async function finalBaselineClearsFence(): Promise<void> {
  const begin = new Connection([
    [{ environment: "production", owner_type: "gate6", owner_id: "gate6-prod-001", state: "active", version: 9 }],
    [{
      gate6_id: "gate6-prod-001",
      status: "active",
      current_stage: "phase4-accepted",
      envelope_sha256: H("a"),
      envelope_core_sha256: H("b"),
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      emergency_supervisor_lease_expires_at: "2026-07-11T03:00:00.000Z",
      expires_at: "2026-07-11T01:05:00.000Z",
      accepted_checker_sha256: H("e"),
    }],
    [{
      gate6_id: "gate6-prod-001",
      scope: "gate6-final-baseline",
      action_id: "final-baseline-001",
      approval_sha256: H("a"),
      allowed_mutation_sha256: H("c"),
      kind: "forward",
      paired_action_id: null,
      status: "registered",
      required_stage: "phase4-accepted",
      required_checker_sha256: H("e"),
      predecessor_action_ids_json: "[]",
      expires_at: "2026-07-11T01:04:00.000Z",
    }],
    [],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const finish = new Connection([
    [{
      gate6_id: "gate6-prod-001",
      scope: "gate6-final-baseline",
      action_id: "final-baseline-001",
      kind: "forward",
      paired_action_id: null,
      status: "consumed",
    }],
    { affectedRows: 1 },
    [{ count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
  ]);
  const repository = repositoryFor(begin, finish);
  const receipt = await repository.beginAction({
    gate6Id: "gate6-prod-001",
    scope: "gate6-final-baseline",
    actionId: "final-baseline-001",
    approvalSha256: H("a"),
    allowedMutationSha256: H("c"),
    envelopeSha256: H("a"),
    envelopeCoreSha256: H("b"),
    expectedStage: "phase4-accepted",
    expectedCheckerSha256: H("e"),
    minimumCompensationValidityMs: 1,
    now: new Date("2026-07-11T01:00:00.000Z"),
  });
  await repository.finishAction(receipt, {
    status: "succeeded",
    afterEvidenceSha256: H("d"),
    now: new Date("2026-07-11T01:00:10.000Z"),
  });
  assert.ok(finish.calls.some(({ sql }) => /SET uncompensated_work = 0/.test(sql)));
}

async function twoPhaseClose(): Promise<void> {
  const seal = new Connection([
    [{
      gate6_id: "gate6-prod-001",
      status: "active",
      current_stage: "pre-close-accepted",
      accepted_checker_sha256: H("e"),
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:02:00.000Z",
    }],
    [{ owner_id: "gate6-prod-001", state: "active", uncompensated_work: 0 }],
    [{
      gate6_id: "gate6-prod-001",
      scope: "gate6-seal-close",
      action_id: "seal-001",
      approval_sha256: H("a"),
      allowed_mutation_sha256: H("b"),
      status: "registered",
    }],
    [{
      ambiguous_count: 0,
      incomplete_forward_count: 0,
      revoke_succeeded_count: 1,
      restore_registered_count: 1,
      restore_succeeded_count: 0,
    }],
    [{ count: 0 }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const beginRelease = new Connection([
    [{
      gate6_id: "gate6-prod-001",
      status: "sealed-verifying",
      terminal_evidence_sha256: H("f"),
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:03:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:03:00.000Z",
    }],
    [{ owner_id: "gate6-prod-001", state: "sealed-verifying" }],
    [{
      gate6_id: "gate6-prod-001",
      scope: "gate6-release",
      action_id: "release-001",
      approval_sha256: H("a"),
      allowed_mutation_sha256: H("b"),
      status: "registered",
    }],
    [{
      gate6_id: "gate6-prod-001",
      action_id: "restore-001",
      kind: "compensation",
      status: "registered",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const finishRelease = new Connection([
    [{ gate6_id: "gate6-prod-001", status: "releasing", terminal_evidence_sha256: H("f") }],
    [{ owner_id: "gate6-prod-001", state: "releasing" }],
    [{ gate6_id: "gate6-prod-001", action_id: "release-001", status: "consumed" }],
    [{ gate6_id: "gate6-prod-001", action_id: "restore-001", kind: "compensation", status: "registered" }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const repository = repositoryFor(seal, beginRelease, finishRelease);
  await repository.sealForVerification({
    gate6Id: "gate6-prod-001",
    scope: "gate6-seal-close",
    actionId: "seal-001",
    approvalSha256: H("a"),
    allowedMutationSha256: H("b"),
    expectedStage: "pre-close-accepted",
    expectedCheckerSha256: H("e"),
    terminalEvidenceSha256: H("f"),
    now: new Date("2026-07-11T01:00:20.000Z"),
  });
  assert.ok(seal.calls.some(({ sql }) => /scope = 'gate6-seal-close'/.test(sql) && /status = 'succeeded'/.test(sql)));
  await repository.releaseRun({
    gate6Id: "gate6-prod-001",
    scope: "gate6-release",
    actionId: "release-001",
    approvalSha256: H("a"),
    allowedMutationSha256: H("b"),
    terminalEvidenceSha256: H("f"),
    verifierSha256: H("9"),
    restoreActionId: "restore-001",
    now: new Date("2026-07-11T01:00:30.000Z"),
  });
  assert.ok(beginRelease.calls.some(({ sql }) => /SET status = 'consumed'/.test(sql)));
  assert.ok(beginRelease.calls.some(({ sql }) => /SET status = 'releasing'/.test(sql)));
  assert.equal(beginRelease.calls.some(({ sql }) => /not_needed/.test(sql)), false);
  await repository.completeRelease({
    gate6Id: "gate6-prod-001",
    actionId: "release-001",
    restoreActionId: "restore-001",
    terminalEvidenceSha256: H("f"),
    cleanupEvidenceSha256: H("8"),
    now: new Date("2026-07-11T01:00:40.000Z"),
  });
  assert.ok(finishRelease.calls.some(({ sql }) => /not_needed/.test(sql)));
  assert.ok(finishRelease.calls.some(({ sql }) => /SET status = 'released'/.test(sql)));
}

async function staleConsumptionRevokesWithoutReplay(): Promise<void> {
  const stale = new Connection([
    [{ action_id: "action-a" }, { action_id: "action-b" }],
    { affectedRows: 2 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const clean = new Connection([[]]);
  const repository = repositoryFor(stale, clean);
  const revoked = await repository.reconcileStaleConsumedActions({
    gate6Id: "gate6-prod-001",
    staleBefore: "2026-07-11T01:00:00.000Z",
    now: new Date("2026-07-11T01:01:00.000Z"),
  });
  assert.deepEqual(revoked, {
    status: "revoked",
    ambiguousActionIds: ["action-a", "action-b"],
  });
  assert.ok(stale.calls.some(({ sql }) => /SET status = 'ambiguous'/.test(sql)));
  assert.ok(stale.calls.some(({ sql }) => /SET status = 'revoked'/.test(sql)));
  const noWork = await repository.reconcileStaleConsumedActions({
    gate6Id: "gate6-prod-001",
    staleBefore: "2026-07-11T01:00:00.000Z",
    now: new Date("2026-07-11T01:01:00.000Z"),
  });
  assert.deepEqual(noWork, { status: "clean", ambiguousActionIds: [] });
}

async function semanticCheckerPinsNextStageActions(): Promise<void> {
  const begin = new Connection([
    [{ environment: "production", owner_type: "gate6", owner_id: "gate6-prod-001", state: "active", version: 11 }],
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
      scope: "stage-accept-db-transition",
      action_id: "stage-db-001",
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
  const accept = new Connection([
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 4 },
    [{ count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
  ]);
  const repository = repositoryFor(begin, accept);
  const receipt = await repository.beginAction({
    gate6Id: "gate6-prod-001",
    scope: "stage-accept-db-transition",
    actionId: "stage-db-001",
    approvalSha256: H("a"),
    allowedMutationSha256: H("c"),
    envelopeSha256: H("a"),
    envelopeCoreSha256: H("b"),
    expectedStage: "admitted",
    now: new Date("2026-07-11T01:00:00.000Z"),
  });
  await repository.acceptSemanticChecker(receipt, {
    checkerName: "db-transition",
    checkerSha256: H("e"),
    nextStage: "db-transition-stable",
    now: new Date("2026-07-11T01:00:10.000Z"),
  });
  assert.ok(accept.calls.some(({ sql }) =>
    /UPDATE gate6_actions/.test(sql)
    && /required_checker_sha256/.test(sql)
    && /required_stage = \?/.test(sql)));
}

async function main(): Promise<void> {
  await task9Lifecycle();
  await task9AmbiguousRevokes();
  await finalBaselineClearsFence();
  await twoPhaseClose();
  await staleConsumptionRevokesWithoutReplay();
  await semanticCheckerPinsNextStageActions();
  console.log("MySQL Gate 6 terminal state tests passed");
}

void main();
