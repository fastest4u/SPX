import {
  admitDurableGate6Run,
  beginDurableGate6Action,
  beginDurableGate6Compensation,
  isDurableGate6ActionReceipt,
  type DurableGate6ActionInput,
  type DurableGate6ActionReceipt,
  type DurableGate6AdmissionInput,
  type DurableGate6CompensationInput,
  type Gate6SqlConnection,
} from "../db/gate6-action-transaction.js";

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface ReleasableGate6SqlConnection extends Gate6SqlConnection {
  release(): void;
}

export interface Gate6SqlPool {
  getConnection(): Promise<ReleasableGate6SqlConnection>;
}

export interface DurableTask9PermitReceipt {
  status: "armed";
  gate6Id: string;
  scope: string;
  actionId: string;
  permitId: string;
}

interface ResultHeader {
  affectedRows: number;
}

function resultRows<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} returned an invalid result`);
  return value as T[];
}

function oneRow<T>(value: unknown, label: string): T {
  const rows = resultRows<T>(value, label);
  if (rows.length !== 1) throw new Error(`${label} is missing or ambiguous`);
  return rows[0];
}

function affectedOne(value: unknown, label: string): void {
  if ((value as Partial<ResultHeader> | null)?.affectedRows !== 1) {
    throw new Error(`${label} compare-and-swap failed`);
  }
}

function hash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
}

function iso(value: Date | undefined): string {
  return (value ?? new Date()).toISOString();
}

async function inTransaction<T>(
  connection: Gate6SqlConnection,
  callback: () => Promise<T>,
): Promise<T> {
  await connection.beginTransaction();
  try {
    const value = await callback();
    await connection.commit();
    return value;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export class MySqlGate6ControlRepository {
  constructor(private readonly pool: Gate6SqlPool) {}

  private async connection<T>(callback: (connection: ReleasableGate6SqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      return await callback(connection);
    } finally {
      connection.release();
    }
  }

  admitInstalledRun(input: DurableGate6AdmissionInput): Promise<{ status: "admitted"; slotVersion: number }> {
    return this.connection((connection) => admitDurableGate6Run(connection, input));
  }

  beginAction(input: DurableGate6ActionInput): Promise<DurableGate6ActionReceipt> {
    return this.connection((connection) => beginDurableGate6Action(connection, input));
  }

  beginCompensation(input: DurableGate6CompensationInput): Promise<DurableGate6ActionReceipt> {
    return this.connection((connection) => beginDurableGate6Compensation(connection, input));
  }

  async finishAction(
    receipt: DurableGate6ActionReceipt,
    input: { status: "succeeded" | "failed" | "ambiguous"; afterEvidenceSha256: string; now?: Date },
  ): Promise<void> {
    if (!isDurableGate6ActionReceipt(receipt)) throw new Error("durable Gate 6 action receipt is required");
    hash(input.afterEvidenceSha256, "Gate 6 action evidence hash");
    return this.connection((connection) => inTransaction(connection, async () => {
      const [selected] = await connection.execute(`
        SELECT gate6_id, scope, action_id, kind, paired_action_id, status
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = ? AND action_id = ?
        FOR UPDATE
      `, [receipt.gate6Id, receipt.scope, receipt.actionId]);
      const row = oneRow<{
        gate6_id: string;
        scope: string;
        action_id: string;
        kind: string;
        paired_action_id: string | null;
        status: string;
      }>(selected, "consumed Gate 6 action");
      if (
        row.gate6_id !== receipt.gate6Id
        || row.scope !== receipt.scope
        || row.action_id !== receipt.actionId
        || row.status !== "consumed"
      ) throw new Error("consumed Gate 6 action identity or state mismatch");
      const completedAt = iso(input.now);
      const [updated] = await connection.execute(`
        UPDATE gate6_actions
        SET status = ?, after_evidence_sha256 = ?, completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'consumed'
      `, [
        input.status, input.afterEvidenceSha256, completedAt, completedAt,
        receipt.gate6Id, receipt.scope, receipt.actionId,
      ]);
      affectedOne(updated, "Gate 6 action completion");
      if (input.status !== "succeeded") {
        await this.revokeLocked(connection, receipt.gate6Id, "action-not-succeeded", completedAt);
      } else if (row.kind === "compensation" && row.paired_action_id) {
        const [paired] = await connection.execute(`
          UPDATE gate6_actions
          SET status = 'compensated', updated_at = ?
          WHERE gate6_id = ? AND action_id = ?
            AND kind = 'forward' AND status IN ('consumed', 'succeeded', 'failed', 'ambiguous')
        `, [completedAt, receipt.gate6Id, row.paired_action_id]);
        affectedOne(paired, "paired Gate 6 compensation");
        await this.clearUncompensatedIfSafe(connection, receipt.gate6Id, completedAt);
      } else {
        await this.clearUncompensatedIfSafe(connection, receipt.gate6Id, completedAt);
      }
    }));
  }

  private async clearUncompensatedIfSafe(
    connection: Gate6SqlConnection,
    gate6Id: string,
    at: string,
  ): Promise<void> {
    const [unsafeActionResult] = await connection.execute(`
      SELECT COUNT(*) AS count
      FROM gate6_actions
      WHERE gate6_id = ? AND status IN ('consumed', 'failed', 'ambiguous')
    `, [gate6Id]);
    const unsafeActions = oneRow<{ count: number }>(unsafeActionResult, "Gate 6 unsafe action count");
    const [armedPermitResult] = await connection.execute(`
      SELECT COUNT(*) AS count
      FROM gate6_fault_permits
      WHERE gate6_id = ? AND status = 'armed'
    `, [gate6Id]);
    const armedPermits = oneRow<{ count: number }>(armedPermitResult, "Gate 6 armed permit count");
    if (Number(unsafeActions.count) !== 0 || Number(armedPermits.count) !== 0) return;
    const [slot] = await connection.execute(`
      UPDATE gate6_environment_slots
      SET uncompensated_work = 0, heartbeat_at = ?, version = version + 1, updated_at = ?
      WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
        AND uncompensated_work = 1
    `, [at, at, gate6Id]);
    affectedOne(slot, "Gate 6 safe slot");
  }

  async acceptSemanticChecker(
    receipt: DurableGate6ActionReceipt,
    input: { checkerName: string; checkerSha256: string; nextStage: string; now?: Date },
  ): Promise<void> {
    if (!isDurableGate6ActionReceipt(receipt)) throw new Error("durable Gate 6 action receipt is required");
    hash(input.checkerSha256, "Gate 6 semantic checker hash");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.checkerName) || !/^[a-z][a-z0-9-]{0,63}$/.test(input.nextStage)) {
      throw new Error("Gate 6 semantic checker identity is invalid");
    }
    await this.connection((connection) => inTransaction(connection, async () => {
      const acceptedAt = iso(input.now);
      const [action] = await connection.execute(`
        UPDATE gate6_actions
        SET status = 'succeeded', after_evidence_sha256 = ?, completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'consumed'
      `, [input.checkerSha256, acceptedAt, acceptedAt, receipt.gate6Id, receipt.scope, receipt.actionId]);
      affectedOne(action, "Gate 6 semantic action completion");
      const [run] = await connection.execute(`
        UPDATE gate6_runs
        SET current_stage = ?, stage_version = stage_version + 1,
            accepted_checker_name = ?, accepted_checker_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'active'
      `, [input.nextStage, input.checkerName, input.checkerSha256, acceptedAt, receipt.gate6Id]);
      affectedOne(run, "Gate 6 semantic stage advancement");
      const [pinned] = await connection.execute(`
        UPDATE gate6_actions
        SET required_checker_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND required_stage = ? AND status = 'registered'
          AND required_checker_sha256 IS NULL
      `, [input.checkerSha256, acceptedAt, receipt.gate6Id, input.nextStage]);
      if (!Number.isSafeInteger((pinned as Partial<ResultHeader> | null)?.affectedRows)) {
        throw new Error("Gate 6 next-stage checker pinning failed");
      }
      await this.clearUncompensatedIfSafe(connection, receipt.gate6Id, acceptedAt);
    }));
  }

  async reconcileStaleConsumedActions(input: {
    gate6Id: string;
    staleBefore: string;
    now?: Date;
  }): Promise<{ status: "clean" | "revoked"; ambiguousActionIds: string[] }> {
    const staleBefore = iso(new Date(input.staleBefore));
    const at = iso(input.now);
    if (Date.parse(staleBefore) >= Date.parse(at)) throw new Error("Gate 6 reconciliation cutoff is invalid");
    return this.connection((connection) => inTransaction(connection, async () => {
      const [selected] = await connection.execute(`
        SELECT action_id FROM gate6_actions
        WHERE gate6_id = ? AND status = 'consumed' AND consumed_at <= ?
        ORDER BY action_id FOR UPDATE
      `, [input.gate6Id, staleBefore]);
      const rows = resultRows<{ action_id: string }>(selected, "stale consumed Gate 6 actions");
      if (rows.length === 0) return { status: "clean" as const, ambiguousActionIds: [] };
      const actionIds = rows.map((row) => row.action_id);
      if (actionIds.some((actionId) => typeof actionId !== "string" || actionId.length === 0)) {
        throw new Error("stale Gate 6 action identity is invalid");
      }
      const placeholders = actionIds.map(() => "?").join(", ");
      const [actions] = await connection.execute(`
        UPDATE gate6_actions SET status = 'ambiguous', completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'consumed' AND action_id IN (${placeholders})
      `, [at, at, input.gate6Id, ...actionIds]);
      if ((actions as Partial<ResultHeader> | null)?.affectedRows !== actionIds.length) {
        throw new Error("Gate 6 stale action reconciliation compare-and-swap failed");
      }
      await this.revokeLocked(connection, input.gate6Id, "stale-consumed-action", at);
      return { status: "revoked" as const, ambiguousActionIds: actionIds };
    }));
  }

  async renewLease(input: {
    gate6Id: string;
    lease: "monitor" | "supervisor";
    status: "green" | "red";
    expiresAt: string;
    now?: Date;
  }): Promise<void> {
    const at = iso(input.now);
    if (Date.parse(input.expiresAt) <= Date.parse(at)) throw new Error("Gate 6 lease expiry is stale");
    await this.connection((connection) => inTransaction(connection, async () => {
      const statusColumn = input.lease === "monitor" ? "monitor_status" : "supervisor_status";
      const expiryColumn = input.lease === "monitor" ? "monitor_lease_expires_at" : "supervisor_lease_expires_at";
      const [run] = await connection.execute(`
        UPDATE gate6_runs
        SET ${statusColumn} = ?, ${expiryColumn} = ?, updated_at = ?
        WHERE gate6_id = ? AND status IN ('active', 'sealed-verifying', 'releasing')
      `, [input.status, input.expiresAt, at, input.gate6Id]);
      affectedOne(run, "Gate 6 lease renewal");
      if (input.status === "red") await this.revokeLocked(connection, input.gate6Id, `${input.lease}-red`, at);
      else {
        const [slot] = await connection.execute(`
          UPDATE gate6_environment_slots SET heartbeat_at = ?, updated_at = ?
          WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
            AND state IN ('active', 'sealed-verifying', 'releasing')
        `, [at, at, input.gate6Id]);
        affectedOne(slot, "Gate 6 slot heartbeat");
      }
    }));
  }

  async revokeRun(input: { gate6Id: string; reasonCode: string; now?: Date }): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(input.reasonCode)) throw new Error("Gate 6 revocation reason is invalid");
    await this.connection((connection) => inTransaction(
      connection,
      () => this.revokeLocked(connection, input.gate6Id, input.reasonCode, iso(input.now)),
    ));
  }

  private async revokeLocked(
    connection: Gate6SqlConnection,
    gate6Id: string,
    reasonCode: string,
    at: string,
  ): Promise<void> {
    const [run] = await connection.execute(`
      UPDATE gate6_runs
      SET status = 'revoked', revocation_reason_code = ?, updated_at = ?
      WHERE gate6_id = ? AND status IN ('active', 'sealed-verifying', 'releasing')
    `, [reasonCode, at, gate6Id]);
    affectedOne(run, "Gate 6 revocation");
    const [slot] = await connection.execute(`
      UPDATE gate6_environment_slots
      SET state = 'revoked-uncompensated', uncompensated_work = 1,
          heartbeat_at = ?, updated_at = ?
      WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
        AND state IN ('active', 'sealed-verifying', 'releasing')
    `, [at, at, gate6Id]);
    affectedOne(slot, "Gate 6 revoked slot");
  }

  async registerTask9Permit(input: {
    gate6Id: string;
    scope: string;
    actionId: string;
    approvalSha256: string;
    allowedMutationSha256: string;
    permitId: string;
    service: "line-service" | "ocr-service";
    kind: string;
    teamId: number;
    drillSha256: string;
    targetSha256: string | null;
    fixtureSha256: string | null;
    signedPermitSha256: string;
    keyId: string;
    expectedCheckerSha256: string;
    expiresAt: string;
    now?: Date;
  }): Promise<DurableTask9PermitReceipt> {
    for (const [value, label] of [
      [input.approvalSha256, "approval hash"],
      [input.allowedMutationSha256, "mutation hash"],
      [input.drillSha256, "drill hash"],
      [input.signedPermitSha256, "signed permit hash"],
      [input.expectedCheckerSha256, "accepted checker hash"],
    ] as const) hash(value, `Gate 6 permit ${label}`);
    if (input.targetSha256 !== null) hash(input.targetSha256, "Gate 6 permit target hash");
    if (input.fixtureSha256 !== null) hash(input.fixtureSha256, "Gate 6 permit fixture hash");
    const at = iso(input.now);
    if (Date.parse(input.expiresAt) <= Date.parse(at) || Date.parse(input.expiresAt) - Date.parse(at) > 120_000) {
      throw new Error("Gate 6 permit TTL is invalid");
    }
    return this.connection((connection) => inTransaction(connection, async () => {
      const [slotResult] = await connection.execute(`
        SELECT owner_id, state, version FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = oneRow<{ owner_id: string; state: string; version: number }>(slotResult, "Gate 6 permit slot");
      if (slot.owner_id !== input.gate6Id || slot.state !== "active") throw new Error("Gate 6 permit slot is inactive");
      const [runResult] = await connection.execute(`
        SELECT gate6_id, status, current_stage, accepted_checker_sha256,
               monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at, expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `, [input.gate6Id]);
      const run = oneRow<Record<string, unknown>>(runResult, "Gate 6 permit run");
      if (
        run.gate6_id !== input.gate6Id
        || run.status !== "active"
        || run.current_stage !== "db-transition-stable"
        || run.accepted_checker_sha256 !== input.expectedCheckerSha256
        || run.monitor_status !== "green"
        || run.supervisor_status !== "green"
        || Date.parse(String(run.monitor_lease_expires_at)) <= Date.parse(at)
        || Date.parse(String(run.supervisor_lease_expires_at)) <= Date.parse(at)
        || Date.parse(String(run.expires_at)) <= Date.parse(at)
      ) throw new Error("Gate 6 permit run or liveness binding is invalid");
      const [actionResult] = await connection.execute(`
        SELECT gate6_id, scope, action_id, status, approval_sha256,
               allowed_mutation_sha256, expires_at
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = ? AND action_id = ?
        FOR UPDATE
      `, [input.gate6Id, input.scope, input.actionId]);
      const action = oneRow<Record<string, unknown>>(actionResult, "Gate 6 permit action");
      if (
        action.gate6_id !== input.gate6Id
        || action.scope !== input.scope
        || action.action_id !== input.actionId
        || action.status !== "registered"
        || action.approval_sha256 !== input.approvalSha256
        || action.allowed_mutation_sha256 !== input.allowedMutationSha256
        || Date.parse(String(action.expires_at)) <= Date.parse(at)
      ) throw new Error("Gate 6 permit action binding is invalid");
      const [permit] = await connection.execute(`
        INSERT INTO gate6_fault_permits (
          permit_id, gate6_id, scope, action_id, service, kind, team_id,
          drill_sha256, target_sha256, fixture_sha256, signed_permit_sha256,
          verification_key_id, status, expires_at, consumed_at, disarmed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, NULL, NULL, ?, ?)
      `, [
        input.permitId, input.gate6Id, input.scope, input.actionId, input.service,
        input.kind, input.teamId, input.drillSha256, input.targetSha256,
        input.fixtureSha256, input.signedPermitSha256, input.keyId,
        input.expiresAt, at, at,
      ]);
      affectedOne(permit, "Gate 6 permit registration");
      const [actionUpdate] = await connection.execute(`
        UPDATE gate6_actions
        SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'registered'
      `, [at, at, input.gate6Id, input.scope, input.actionId]);
      affectedOne(actionUpdate, "Gate 6 permit action consumption");
      const [slotUpdate] = await connection.execute(`
        UPDATE gate6_environment_slots
        SET uncompensated_work = 1, heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND state = 'active' AND version = ?
      `, [at, at, input.gate6Id, slot.version]);
      affectedOne(slotUpdate, "Gate 6 permit slot fence");
      return Object.freeze({
        status: "armed" as const,
        gate6Id: input.gate6Id,
        scope: input.scope,
        actionId: input.actionId,
        permitId: input.permitId,
      });
    }));
  }

  async completeTask9PermitAction(
    receipt: DurableTask9PermitReceipt,
    input: { status: "succeeded" | "ambiguous"; afterEvidenceSha256: string; now?: Date },
  ): Promise<void> {
    hash(input.afterEvidenceSha256, "Gate 6 Task 9 evidence hash");
    if (!["succeeded", "ambiguous"].includes(input.status)) {
      throw new Error("Gate 6 Task 9 completion status is invalid");
    }
    if (
      receipt?.status !== "armed"
      || !receipt.gate6Id
      || !receipt.scope
      || !receipt.actionId
      || !receipt.permitId
    ) throw new Error("durable Gate 6 Task 9 receipt is required");
    const at = iso(input.now);
    await this.connection((connection) => inTransaction(connection, async () => {
      const [selected] = await connection.execute(`
        SELECT a.gate6_id, a.scope, a.action_id, a.status AS action_status,
               p.permit_id, p.status AS permit_status, p.disarmed_at
        FROM gate6_actions a
        JOIN gate6_fault_permits p
          ON p.gate6_id = a.gate6_id AND p.scope = a.scope AND p.action_id = a.action_id
        WHERE a.gate6_id = ? AND a.scope = ? AND a.action_id = ? AND p.permit_id = ?
        FOR UPDATE
      `, [receipt.gate6Id, receipt.scope, receipt.actionId, receipt.permitId]);
      const row = oneRow<Record<string, unknown>>(selected, "consumed Gate 6 Task 9 action");
      if (
        row.gate6_id !== receipt.gate6Id
        || row.scope !== receipt.scope
        || row.action_id !== receipt.actionId
        || row.permit_id !== receipt.permitId
        || row.action_status !== "consumed"
        || !["consumed", "disarmed"].includes(String(row.permit_status))
        || row.disarmed_at === null
      ) throw new Error("Gate 6 Task 9 action or permit is not terminal");
      const [updated] = await connection.execute(`
        UPDATE gate6_actions
        SET status = ?, after_evidence_sha256 = ?, completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'consumed'
      `, [
        input.status, input.afterEvidenceSha256, at, at,
        receipt.gate6Id, receipt.scope, receipt.actionId,
      ]);
      affectedOne(updated, "Gate 6 Task 9 action completion");
      if (input.status === "succeeded") {
        await this.clearUncompensatedIfSafe(connection, receipt.gate6Id, at);
      } else {
        await this.revokeLocked(
          connection,
          receipt.gate6Id,
          "task9-controller-failure",
          at,
        );
      }
    }));
  }

  async consumeTask9Permit(input: {
    permitId: string;
    service: "line-service" | "ocr-service";
    teamId: number;
    signedPermitSha256: string;
    targetSha256?: string;
    fixtureSha256?: string;
    now?: Date;
  }): Promise<{ status: "consumed" }> {
    hash(input.signedPermitSha256, "Gate 6 signed permit hash");
    const at = iso(input.now);
    return this.connection((connection) => inTransaction(connection, async () => {
      const [selected] = await connection.execute(`
        SELECT permit_id, service, team_id, target_sha256, fixture_sha256,
               signed_permit_sha256, status, expires_at
        FROM gate6_fault_permits WHERE permit_id = ? FOR UPDATE
      `, [input.permitId]);
      const permit = oneRow<Record<string, unknown>>(selected, "Gate 6 fault permit");
      if (
        permit.permit_id !== input.permitId
        || permit.service !== input.service
        || Number(permit.team_id) !== input.teamId
        || permit.signed_permit_sha256 !== input.signedPermitSha256
        || permit.status !== "armed"
        || (permit.target_sha256 !== null && permit.target_sha256 !== input.targetSha256)
        || (permit.fixture_sha256 !== null && permit.fixture_sha256 !== input.fixtureSha256)
        || Date.parse(String(permit.expires_at)) <= Date.parse(at)
      ) throw new Error("Gate 6 fault permit is unavailable or does not match");
      const [updated] = await connection.execute(`
        UPDATE gate6_fault_permits
        SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE permit_id = ? AND status = 'armed'
      `, [at, at, input.permitId]);
      affectedOne(updated, "Gate 6 fault permit consumption");
      return { status: "consumed" as const };
    }));
  }

  async disarmTask9Permit(input: { permitId: string; now?: Date }): Promise<void> {
    const at = iso(input.now);
    await this.connection(async (connection) => {
      const [updated] = await connection.execute(`
        UPDATE gate6_fault_permits
        SET status = IF(status = 'armed', 'disarmed', status), disarmed_at = ?, updated_at = ?
        WHERE permit_id = ? AND status IN ('armed', 'consumed', 'expired', 'disarmed')
      `, [at, at, input.permitId]);
      affectedOne(updated, "Gate 6 fault permit disarm");
    });
  }

  async registerPostProofActions(input: {
    gate6Id: string;
    expectedStage: "pre-close-accepted";
    expectedCheckerSha256: string;
    revoke: DurableGate6AdmissionInput["actions"][number];
    restore: DurableGate6AdmissionInput["actions"][number];
    now?: Date;
  }): Promise<void> {
    hash(input.expectedCheckerSha256, "Gate 6 pre-close checker hash");
    if (
      input.revoke.scope !== "db-principal-revoke-legacy"
      || input.restore.scope !== "db-principal-restore-legacy"
      || input.restore.kind !== "compensation"
      || input.restore.pairedActionId !== input.revoke.actionId
    ) throw new Error("Gate 6 post-proof action pair is invalid");
    const at = iso(input.now);
    await this.connection((connection) => inTransaction(connection, async () => {
      const [runResult] = await connection.execute(`
        SELECT status, current_stage, accepted_checker_sha256,
               monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `, [input.gate6Id]);
      const run = oneRow<Record<string, unknown>>(runResult, "Gate 6 post-proof run");
      if (
        run.status !== "active"
        || run.current_stage !== input.expectedStage
        || run.accepted_checker_sha256 !== input.expectedCheckerSha256
        || run.monitor_status !== "green"
        || run.supervisor_status !== "green"
        || Date.parse(String(run.monitor_lease_expires_at)) <= Date.parse(at)
        || Date.parse(String(run.supervisor_lease_expires_at)) <= Date.parse(at)
      ) throw new Error("Gate 6 post-proof run binding is invalid");
      for (const action of [input.revoke, input.restore]) {
        const [inserted] = await connection.execute(`
          INSERT INTO gate6_actions (
            gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256,
            kind, paired_action_id, predecessor_action_ids_json,
            required_stage, required_checker_sha256, status, expires_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?)
        `, [
          input.gate6Id, action.scope, action.actionId, action.approvalSha256,
          action.allowedMutationSha256, action.kind, action.pairedActionId,
          JSON.stringify(action.predecessorActionIds), action.requiredStage,
          action.requiredCheckerSha256, action.expiresAt, at, at,
        ]);
        affectedOne(inserted, "Gate 6 post-proof action registration");
      }
    }));
  }

  async sealForVerification(input: {
    gate6Id: string;
    scope: "gate6-seal-close";
    actionId: string;
    approvalSha256: string;
    allowedMutationSha256: string;
    expectedStage: "pre-close-accepted";
    expectedCheckerSha256: string;
    terminalEvidenceSha256: string;
    now?: Date;
  }): Promise<void> {
    hash(input.approvalSha256, "Gate 6 seal approval hash");
    hash(input.allowedMutationSha256, "Gate 6 seal mutation hash");
    hash(input.expectedCheckerSha256, "Gate 6 seal checker hash");
    hash(input.terminalEvidenceSha256, "Gate 6 terminal evidence hash");
    const at = iso(input.now);
    await this.connection((connection) => inTransaction(connection, async () => {
      const [runResult] = await connection.execute(`
        SELECT gate6_id, status, current_stage, accepted_checker_sha256,
               monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `, [input.gate6Id]);
      const selectedRun = oneRow<Record<string, unknown>>(runResult, "Gate 6 seal run");
      if (
        selectedRun.gate6_id !== input.gate6Id
        || selectedRun.status !== "active"
        || selectedRun.current_stage !== input.expectedStage
        || selectedRun.accepted_checker_sha256 !== input.expectedCheckerSha256
        || selectedRun.monitor_status !== "green"
        || selectedRun.supervisor_status !== "green"
        || Date.parse(String(selectedRun.monitor_lease_expires_at)) <= Date.parse(at)
        || Date.parse(String(selectedRun.supervisor_lease_expires_at)) <= Date.parse(at)
      ) throw new Error("Gate 6 seal run, stage, or liveness binding is invalid");
      const [slotResult] = await connection.execute(`
        SELECT owner_id, state, uncompensated_work
        FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const selectedSlot = oneRow<Record<string, unknown>>(slotResult, "Gate 6 seal slot");
      if (
        selectedSlot.owner_id !== input.gate6Id
        || selectedSlot.state !== "active"
        || Number(selectedSlot.uncompensated_work) !== 0
      ) throw new Error("Gate 6 seal slot is not safe");
      const [sealActionResult] = await connection.execute(`
        SELECT gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256, status
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = 'gate6-seal-close' AND action_id = ?
        FOR UPDATE
      `, [input.gate6Id, input.actionId]);
      const sealAction = oneRow<Record<string, unknown>>(sealActionResult, "Gate 6 seal action");
      if (
        sealAction.gate6_id !== input.gate6Id
        || sealAction.scope !== input.scope
        || sealAction.action_id !== input.actionId
        || sealAction.approval_sha256 !== input.approvalSha256
        || sealAction.allowed_mutation_sha256 !== input.allowedMutationSha256
        || sealAction.status !== "registered"
      ) throw new Error("Gate 6 seal action binding is invalid");
      const [blockingResult] = await connection.execute(`
        SELECT
          SUM(status = 'ambiguous') AS ambiguous_count,
          SUM(kind = 'forward' AND scope NOT IN ('gate6-seal-close', 'gate6-release')
              AND status NOT IN ('succeeded', 'compensated', 'not_needed')) AS incomplete_forward_count,
          SUM(scope = 'db-principal-revoke-legacy' AND status = 'succeeded') AS revoke_succeeded_count,
          SUM(scope = 'db-principal-restore-legacy' AND kind = 'compensation'
              AND status = 'registered') AS restore_registered_count,
          SUM(scope = 'db-principal-restore-legacy' AND kind = 'compensation'
              AND status = 'succeeded') AS restore_succeeded_count
        FROM gate6_actions WHERE gate6_id = ?
      `, [input.gate6Id]);
      const blocking = oneRow<{
        ambiguous_count: number;
        incomplete_forward_count: number;
        revoke_succeeded_count: number;
        restore_registered_count: number;
        restore_succeeded_count: number;
      }>(blockingResult, "Gate 6 seal actions");
      const [permitResult] = await connection.execute(`
        SELECT COUNT(*) AS count FROM gate6_fault_permits
        WHERE gate6_id = ? AND status = 'armed'
      `, [input.gate6Id]);
      const permits = oneRow<{ count: number }>(permitResult, "Gate 6 seal permits");
      const postProofSafe = (
        Number(blocking.revoke_succeeded_count) === 1
        && Number(blocking.restore_registered_count) === 1
      ) || Number(blocking.restore_succeeded_count) === 1;
      if (
        Number(blocking.ambiguous_count) !== 0
        || Number(blocking.incomplete_forward_count) !== 0
        || Number(permits.count) !== 0
        || !postProofSafe
      ) {
        throw new Error("Gate 6 seal has incomplete actions or active permits");
      }
      const [sealActionUpdate] = await connection.execute(`
        UPDATE gate6_actions
        SET status = 'succeeded', consumed_at = ?, completed_at = ?,
            before_evidence_sha256 = ?, after_evidence_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = 'gate6-seal-close' AND action_id = ?
          AND status = 'registered' AND approval_sha256 = ? AND allowed_mutation_sha256 = ?
      `, [
        at, at, input.expectedCheckerSha256, input.terminalEvidenceSha256, at,
        input.gate6Id, input.actionId, input.approvalSha256, input.allowedMutationSha256,
      ]);
      affectedOne(sealActionUpdate, "Gate 6 seal action consumption");
      const [run] = await connection.execute(`
        UPDATE gate6_runs SET status = 'sealed-verifying', current_stage = 'sealed-verifying',
            stage_version = stage_version + 1, accepted_checker_name = 'gate6-seal-close',
            accepted_checker_sha256 = ?, terminal_evidence_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'active'
      `, [input.terminalEvidenceSha256, input.terminalEvidenceSha256, at, input.gate6Id]);
      affectedOne(run, "Gate 6 run seal");
      const [slot] = await connection.execute(`
        UPDATE gate6_environment_slots SET state = 'sealed-verifying',
            uncompensated_work = 0, heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ? AND state = 'active'
      `, [at, at, input.gate6Id]);
      affectedOne(slot, "Gate 6 slot seal");
    }));
  }

  async releaseRun(input: {
    gate6Id: string;
    scope: "gate6-release";
    actionId: string;
    approvalSha256: string;
    allowedMutationSha256: string;
    terminalEvidenceSha256: string;
    verifierSha256: string;
    restoreActionId: string;
    now?: Date;
  }): Promise<{ status: "releasing" }> {
    hash(input.verifierSha256, "Gate 6 release verifier hash");
    hash(input.terminalEvidenceSha256, "Gate 6 terminal evidence hash");
    hash(input.approvalSha256, "Gate 6 release approval hash");
    hash(input.allowedMutationSha256, "Gate 6 release mutation hash");
    const at = iso(input.now);
    return this.connection((connection) => inTransaction(connection, async () => {
      const [runResult] = await connection.execute(`
        SELECT gate6_id, status, terminal_evidence_sha256,
               monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `, [input.gate6Id]);
      const selectedRun = oneRow<Record<string, unknown>>(runResult, "sealed Gate 6 release run");
      if (
        selectedRun.gate6_id !== input.gate6Id
        || selectedRun.status !== "sealed-verifying"
        || selectedRun.terminal_evidence_sha256 !== input.terminalEvidenceSha256
        || selectedRun.monitor_status !== "green"
        || selectedRun.supervisor_status !== "green"
        || Date.parse(String(selectedRun.monitor_lease_expires_at)) <= Date.parse(at)
        || Date.parse(String(selectedRun.supervisor_lease_expires_at)) <= Date.parse(at)
      ) throw new Error("Gate 6 release run or liveness binding is invalid");
      const [slotResult] = await connection.execute(`
        SELECT owner_id, state FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const selectedSlot = oneRow<{ owner_id: string; state: string }>(slotResult, "sealed Gate 6 release slot");
      if (selectedSlot.owner_id !== input.gate6Id || selectedSlot.state !== "sealed-verifying") {
        throw new Error("Gate 6 release slot binding is invalid");
      }
      const [actionResult] = await connection.execute(`
        SELECT gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256, status
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = 'gate6-release' AND action_id = ?
        FOR UPDATE
      `, [input.gate6Id, input.actionId]);
      const action = oneRow<Record<string, unknown>>(actionResult, "Gate 6 release action");
      if (
        action.gate6_id !== input.gate6Id
        || action.scope !== input.scope
        || action.action_id !== input.actionId
        || action.approval_sha256 !== input.approvalSha256
        || action.allowed_mutation_sha256 !== input.allowedMutationSha256
        || action.status !== "registered"
      ) throw new Error("Gate 6 release action binding is invalid");
      const [restoreResult] = await connection.execute(`
        SELECT gate6_id, action_id, kind, status
        FROM gate6_actions
        WHERE gate6_id = ? AND action_id = ? FOR UPDATE
      `, [input.gate6Id, input.restoreActionId]);
      const restore = oneRow<Record<string, unknown>>(restoreResult, "Gate 6 release restore action");
      if (
        restore.gate6_id !== input.gate6Id
        || restore.action_id !== input.restoreActionId
        || restore.kind !== "compensation"
        || !["registered", "succeeded"].includes(String(restore.status))
      ) throw new Error("Gate 6 release restore capability is unavailable");
      const [actionUpdate] = await connection.execute(`
        UPDATE gate6_actions
        SET status = 'consumed', consumed_at = ?,
            before_evidence_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = 'gate6-release' AND action_id = ?
          AND status = 'registered' AND approval_sha256 = ? AND allowed_mutation_sha256 = ?
      `, [
        at, input.terminalEvidenceSha256, at,
        input.gate6Id, input.actionId, input.approvalSha256, input.allowedMutationSha256,
      ]);
      affectedOne(actionUpdate, "Gate 6 release action consumption");
      const [run] = await connection.execute(`
        UPDATE gate6_runs
        SET status = 'releasing', current_stage = 'releasing',
            stage_version = stage_version + 1, accepted_checker_name = 'gate6-final-verifier',
            accepted_checker_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'sealed-verifying'
          AND terminal_evidence_sha256 = ?
      `, [input.verifierSha256, at, input.gate6Id, input.terminalEvidenceSha256]);
      affectedOne(run, "Gate 6 release");
      const [slot] = await connection.execute(`
        UPDATE gate6_environment_slots
        SET state = 'releasing', uncompensated_work = 1,
            heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND state = 'sealed-verifying'
      `, [at, at, input.gate6Id]);
      affectedOne(slot, "Gate 6 releasing slot");
      return { status: "releasing" as const };
    }));
  }

  async completeRelease(input: {
    gate6Id: string;
    actionId: string;
    restoreActionId: string;
    terminalEvidenceSha256: string;
    cleanupEvidenceSha256: string;
    now?: Date;
  }): Promise<void> {
    hash(input.terminalEvidenceSha256, "Gate 6 release terminal evidence hash");
    hash(input.cleanupEvidenceSha256, "Gate 6 release cleanup evidence hash");
    const at = iso(input.now);
    await this.connection((connection) => inTransaction(connection, async () => {
      const [runResult] = await connection.execute(`
        SELECT gate6_id, status, terminal_evidence_sha256
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `, [input.gate6Id]);
      const runRow = oneRow<Record<string, unknown>>(runResult, "releasing Gate 6 run");
      if (
        runRow.gate6_id !== input.gate6Id
        || runRow.status !== "releasing"
        || runRow.terminal_evidence_sha256 !== input.terminalEvidenceSha256
      ) throw new Error("Gate 6 run is not awaiting cleanup completion");
      const [slotResult] = await connection.execute(`
        SELECT owner_id, state FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slotRow = oneRow<Record<string, unknown>>(slotResult, "releasing Gate 6 slot");
      if (slotRow.owner_id !== input.gate6Id || slotRow.state !== "releasing") {
        throw new Error("Gate 6 slot is not awaiting cleanup completion");
      }
      const [releaseResult] = await connection.execute(`
        SELECT gate6_id, action_id, status FROM gate6_actions
        WHERE gate6_id = ? AND scope = 'gate6-release' AND action_id = ? FOR UPDATE
      `, [input.gate6Id, input.actionId]);
      const release = oneRow<Record<string, unknown>>(releaseResult, "consumed Gate 6 release action");
      if (release.gate6_id !== input.gate6Id || release.action_id !== input.actionId || release.status !== "consumed") {
        throw new Error("Gate 6 release action is not consumed");
      }
      const [restoreResult] = await connection.execute(`
        SELECT gate6_id, action_id, kind, status FROM gate6_actions
        WHERE gate6_id = ? AND action_id = ? FOR UPDATE
      `, [input.gate6Id, input.restoreActionId]);
      const restore = oneRow<Record<string, unknown>>(restoreResult, "Gate 6 restore action");
      if (
        restore.gate6_id !== input.gate6Id
        || restore.action_id !== input.restoreActionId
        || restore.kind !== "compensation"
        || !["registered", "succeeded"].includes(String(restore.status))
      ) throw new Error("Gate 6 restore action is unavailable at cleanup completion");
      if (restore.status === "registered") {
        const [restoreUpdate] = await connection.execute(`
          UPDATE gate6_actions SET status = 'not_needed', completed_at = ?, updated_at = ?
          WHERE gate6_id = ? AND action_id = ? AND kind = 'compensation' AND status = 'registered'
        `, [at, at, input.gate6Id, input.restoreActionId]);
        affectedOne(restoreUpdate, "Gate 6 unused restore terminalization");
      }
      const [releaseUpdate] = await connection.execute(`
        UPDATE gate6_actions SET status = 'succeeded', after_evidence_sha256 = ?,
            completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = 'gate6-release' AND action_id = ? AND status = 'consumed'
      `, [input.cleanupEvidenceSha256, at, at, input.gate6Id, input.actionId]);
      affectedOne(releaseUpdate, "Gate 6 release completion");
      const [run] = await connection.execute(`
        UPDATE gate6_runs SET status = 'released', current_stage = 'released',
            stage_version = stage_version + 1, accepted_checker_name = 'gate6-release-cleanup',
            accepted_checker_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'releasing' AND terminal_evidence_sha256 = ?
      `, [input.cleanupEvidenceSha256, at, input.gate6Id, input.terminalEvidenceSha256]);
      affectedOne(run, "Gate 6 released run");
      const [slot] = await connection.execute(`
        UPDATE gate6_environment_slots SET state = 'released', uncompensated_work = 0,
            heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND state = 'releasing'
      `, [at, at, at, input.gate6Id]);
      affectedOne(slot, "Gate 6 released slot");
    }));
  }

  async getSanitizedSnapshot(gate6Id: string): Promise<Record<string, unknown> | null> {
    return this.connection(async (connection) => {
      const [result] = await connection.execute(`
        SELECT * FROM operational_gate6_terminal_evidence WHERE gate6_id = ?
      `, [gate6Id]);
      const rows = resultRows<Record<string, unknown>>(result, "Gate 6 observer snapshot");
      if (rows.length > 1) throw new Error("Gate 6 observer snapshot is ambiguous");
      return rows[0] ?? null;
    });
  }

  async getActiveFaultContext(input: {
    gate6Id: string;
    service: "line-service" | "ocr-service";
    repository: string;
    now?: Date;
  }): Promise<{
    gate6Id: string;
    gate6Nonce: string;
    envelopeCoreSha256: string;
    permitId: string;
    actionId: string;
    signedPermitSha256: string;
    currentStage: "db-transition-stable";
    acceptedCheckerSha256: string;
    teamId: number;
    candidateSha: string;
    repository: string;
  } | null> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
      throw new Error("active Gate 6 fault repository binding is invalid");
    }
    const at = iso(input.now);
    return this.connection(async (connection) => {
      const [result] = await connection.execute(`
        SELECT r.gate6_id, r.gate6_nonce, r.envelope_core_sha256,
               r.current_stage, r.accepted_checker_sha256, r.candidate_sha,
               p.permit_id, p.action_id, p.signed_permit_sha256, p.service, p.team_id
        FROM gate6_runs r
        JOIN gate6_fault_permits p ON p.gate6_id = r.gate6_id
        WHERE r.gate6_id = ? AND p.service = ?
          AND r.status = 'active' AND r.current_stage = 'db-transition-stable'
          AND r.accepted_checker_sha256 IS NOT NULL
          AND r.monitor_status = 'green' AND r.monitor_lease_expires_at > ?
          AND r.supervisor_status = 'green' AND r.supervisor_lease_expires_at > ?
          AND r.expires_at > ?
          AND p.status = 'armed' AND p.expires_at > ?
      `, [input.gate6Id, input.service, at, at, at, at]);
      const rows = resultRows<Record<string, unknown>>(result, "active Gate 6 fault context");
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new Error("active Gate 6 fault context is ambiguous");
      const row = rows[0];
      if (
        row.gate6_id !== input.gate6Id
        || row.service !== input.service
        || typeof row.gate6_nonce !== "string"
        || typeof row.envelope_core_sha256 !== "string"
        || row.current_stage !== "db-transition-stable"
        || typeof row.accepted_checker_sha256 !== "string"
        || typeof row.candidate_sha !== "string"
        || typeof row.permit_id !== "string"
        || !ID.test(row.permit_id)
        || typeof row.action_id !== "string"
        || !ID.test(row.action_id)
        || typeof row.signed_permit_sha256 !== "string"
        || !SHA256.test(row.signed_permit_sha256)
        || !Number.isSafeInteger(Number(row.team_id))
      ) throw new Error("active Gate 6 fault context identity mismatch");
      return {
        gate6Id: input.gate6Id,
        gate6Nonce: row.gate6_nonce,
        envelopeCoreSha256: row.envelope_core_sha256,
        permitId: row.permit_id,
        actionId: row.action_id,
        signedPermitSha256: row.signed_permit_sha256,
        currentStage: "db-transition-stable",
        acceptedCheckerSha256: row.accepted_checker_sha256,
        teamId: Number(row.team_id),
        candidateSha: row.candidate_sha,
        repository: input.repository,
      };
    });
  }
}
