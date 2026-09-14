import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createGate6MysqlLedger,
  validateProductionGate6DbCapability,
} from "../scripts/lib/gate6-mysql-ledger.mjs";

const H = (character: string): string => character.repeat(64);

class Connection {
  readonly calls: string[] = [];

  constructor(private readonly responses: unknown[]) {}
  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  release(): void {}
  async execute(sql: string): Promise<[unknown, unknown]> {
    this.calls.push(sql.replace(/\s+/g, " ").trim());
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`unexpected SQL: ${sql}`);
    return [response, []];
  }
}

function beginResponses(): unknown[] {
  return [
    [{ owner_type: "gate6", owner_id: "gate6-prod-001", state: "active", version: 3 }],
    [{
      gate6_id: "gate6-prod-001",
      envelope_sha256: H("a"),
      envelope_core_sha256: H("b"),
      status: "active",
      current_stage: "admitted",
      accepted_checker_sha256: null,
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:02:00.000Z",
      expires_at: "2026-07-11T01:05:00.000Z",
    }],
    [{
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
      expires_at: "2026-07-11T01:04:00.000Z",
    }],
  ];
}

async function main(): Promise<void> {
  assert.deepEqual(validateProductionGate6DbCapability({
    schemaVersion: 1,
    host: "mysql.internal.example",
    port: 3306,
    database: "spx",
    username: "spx_gate6_control",
    sslServername: "mysql.internal.example",
    targetDescriptorSha256: H("0"),
    passwordSha256: H("1"),
    caSha256: H("2"),
  }, H("0")), {
    host: "mysql.internal.example",
    port: 3306,
    database: "spx",
    username: "spx_gate6_control",
    sslServername: "mysql.internal.example",
    passwordSha256: H("1"),
    caSha256: H("2"),
  });
  assert.throws(() => validateProductionGate6DbCapability({
    schemaVersion: 1,
    host: "mysql.internal.example",
    port: 3306,
    database: "other",
    username: "spx_gate6_control",
    sslServername: "127.0.0.1",
    targetDescriptorSha256: H("0"),
    passwordSha256: H("1"),
    caSha256: H("2"),
  }, H("0")), /capability/i);
  const source = readFileSync("scripts/lib/gate6-mysql-ledger.mjs", "utf8");
  assert.match(source, /\/var\/lib\/spx-gate6\/gate6-control-db\.json/);
  assert.match(source, /\/run\/secrets\/db_password/);
  assert.match(source, /servername/);
  const beginWithoutRecovery = new Connection([
    ...beginResponses(),
    [],
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const finish = new Connection([
    { affectedRows: 1 },
    [{ count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
  ]);
  const task9Register = new Connection([
    [{ owner_id: "gate6-prod-001", state: "active", version: 5 }],
    [{
      gate6_id: "gate6-prod-001",
      status: "active",
      current_stage: "db-transition-stable",
      accepted_checker_sha256: H("7"),
      monitor_status: "green",
      monitor_lease_expires_at: "2026-07-11T01:03:00.000Z",
      supervisor_status: "green",
      supervisor_lease_expires_at: "2026-07-11T01:03:00.000Z",
      expires_at: "2026-07-11T01:05:00.000Z",
    }],
    [{
      gate6_id: "gate6-prod-001",
      scope: "task9-line-boundary",
      action_id: "task9-line-001",
      status: "registered",
      approval_sha256: H("1"),
      allowed_mutation_sha256: H("2"),
      expires_at: "2026-07-11T01:04:00.000Z",
    }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
  ]);
  const task9Disarm = new Connection([{ affectedRows: 1 }]);
  const task9Status = new Connection([[{ status: "consumed" }]]);
  const task9Complete = new Connection([
    [{
      gate6_id: "gate6-prod-001",
      scope: "task9-line-boundary",
      action_id: "task9-line-001",
      action_status: "consumed",
      permit_id: "permit-line-001",
      permit_status: "consumed",
      disarmed_at: "2026-07-11T01:00:22.000Z",
    }],
    { affectedRows: 1 },
    [{ count: 0 }],
    [{ count: 0 }],
    { affectedRows: 1 },
  ]);
  const connections = [beginWithoutRecovery, finish, task9Register, task9Status, task9Disarm, task9Complete];
  const ledger = createGate6MysqlLedger({
    async getConnection() {
      const connection = connections.shift();
      if (!connection) throw new Error("missing fake connection");
      return connection;
    },
  });
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
    minimumCompensationValidityMs: 60_000,
    now: new Date("2026-07-11T01:00:00.000Z"),
  });
  await ledger.finishAction(receipt, {
    status: "succeeded",
    afterEvidenceSha256: H("e"),
    now: new Date("2026-07-11T01:00:10.000Z"),
  });
  assert.ok(finish.calls.some((sql) => /SET uncompensated_work = 0/.test(sql)));
  const task9Receipt = await ledger.registerTask9Permit({
    gate6Id: "gate6-prod-001",
    scope: "task9-line-boundary",
    actionId: "task9-line-001",
    approvalSha256: H("1"),
    allowedMutationSha256: H("2"),
    permitId: "permit-line-001",
    service: "line-service",
    kind: "retryable-before-provider",
    teamId: 2,
    drillSha256: H("3"),
    targetSha256: H("4"),
    fixtureSha256: null,
    signedPermitSha256: H("5"),
    keyId: "gate6-line-2026-07",
    expectedCheckerSha256: H("7"),
    expiresAt: "2026-07-11T01:01:00.000Z",
    now: new Date("2026-07-11T01:00:20.000Z"),
  });
  assert.equal(await ledger.getTask9PermitStatus(task9Receipt), "consumed");
  await ledger.disarmTask9Permit(task9Receipt, {
    now: new Date("2026-07-11T01:00:22.000Z"),
  });
  await ledger.completeTask9PermitAction(task9Receipt, {
    status: "succeeded",
    afterEvidenceSha256: H("6"),
    now: new Date("2026-07-11T01:00:23.000Z"),
  });
  assert.ok(task9Register.calls.some((sql) => /SET uncompensated_work = 1/.test(sql)));
  assert.ok(task9Complete.calls.some((sql) => /UPDATE gate6_actions SET status = \?/.test(sql)));
  console.log("Gate 6 MySQL executable ledger tests passed");
}

void main();
