import {
  Gate6ControlRepository,
  type VerifiedGate6ActionContext,
} from "../repositories/gate6-control-repository.js";

const SHA256 = /^[0-9a-f]{64}$/;
const RECEIPT_BRAND = Symbol("durable-gate6-action-receipt");

export interface Gate6SqlConnection {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  execute(sql: string, parameters?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface DurableGate6ActionInput {
  gate6Id: string;
  scope: string;
  actionId: string;
  approvalSha256: string;
  allowedMutationSha256: string;
  envelopeSha256: string;
  envelopeCoreSha256: string;
  expectedStage: string;
  expectedCheckerSha256?: string | null;
  minimumCompensationValidityMs?: number;
  now?: Date;
}

export interface DurableGate6CompensationInput extends Omit<
  DurableGate6ActionInput,
  "expectedStage" | "expectedCheckerSha256" | "minimumCompensationValidityMs"
> {
  pairedActionId: string;
}

export interface DurableGate6ActionReceipt {
  readonly gate6Id: string;
  readonly scope: string;
  readonly actionId: string;
  readonly kind: "forward" | "emergency" | "compensation";
  readonly status: "consumed";
  readonly consumedAt: string;
  readonly slotVersion: number;
  readonly [RECEIPT_BRAND]: true;
}

interface SlotSqlRow {
  environment: string;
  owner_type: string;
  owner_id: string;
  state: string;
  version: number;
  operation_id?: string;
  transfer_token_sha256?: string | null;
  protected_install_evidence_sha256?: string;
  release_sha?: string;
  target_descriptor_sha256?: string;
  operator_bundle_sha256?: string;
  installed_migration_set_sha256?: string;
  installed_schema_version?: number;
  heartbeat_at?: string | Date;
  expires_at?: string | Date;
}

interface RunSqlRow {
  gate6_id: string;
  status: string;
  current_stage: string;
  envelope_sha256: string;
  envelope_core_sha256: string;
  monitor_status: string;
  monitor_lease_expires_at: string | Date;
  supervisor_status: string;
  supervisor_lease_expires_at: string | Date;
  emergency_supervisor_lease_expires_at?: string | Date;
  expires_at: string | Date;
  accepted_checker_sha256?: string | null;
}

interface ActionSqlRow {
  gate6_id: string;
  scope: string;
  action_id: string;
  approval_sha256: string;
  allowed_mutation_sha256: string;
  kind: "forward" | "emergency" | "compensation";
  paired_action_id?: string | null;
  status: string;
  required_stage: string;
  required_checker_sha256: string | null;
  predecessor_action_ids_json: string | string[];
  expires_at: string | Date;
}

interface MutationResult {
  affectedRows: number;
}

export interface DurableGate6AdmissionAction {
  scope: string;
  actionId: string;
  approvalSha256: string;
  allowedMutationSha256: string;
  kind: "forward" | "compensation" | "emergency";
  pairedActionId: string | null;
  predecessorActionIds: string[];
  requiredStage: string;
  requiredCheckerSha256: string | null;
  expiresAt: string;
}

export interface DurableGate6AdmissionInput {
  gate6Id: string;
  gate6Nonce: string;
  envelopeSha256: string;
  envelopeCoreSha256: string;
  releaseEnvironment: "production";
  runtimeEnvironment: "production";
  drillMode: "supervised-production";
  composeProject: "spx-production";
  candidateSha: string;
  candidateImageDigest: string;
  rollbackSha: string;
  rollbackImageDigest: string;
  productionTargetDescriptorSha256: string;
  operatorBundleSha256: string;
  protectedInstallEvidenceSha256: string;
  installedMigrationSetSha256: string;
  installedSchemaVersion: number;
  expiresAt: string;
  monitorLeaseExpiresAt: string;
  supervisorLeaseExpiresAt: string;
  emergencySupervisorLeaseExpiresAt: string;
  installOperationId: string;
  transferTokenSha256: string;
  admitActionId: string;
  actions: DurableGate6AdmissionAction[];
  now?: Date;
}

function rows<T>(result: unknown, label: string): T[] {
  if (!Array.isArray(result)) throw new Error(`${label} query returned an invalid result`);
  return result as T[];
}

function one<T>(result: unknown, label: string): T {
  const values = rows<T>(result, label);
  if (values.length !== 1) throw new Error(`${label} is missing or ambiguous`);
  return values[0];
}

function epoch(value: string | Date, label: string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function requireSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
}

function requireAffectedOne(result: unknown, label: string): void {
  const affectedRows = (result as Partial<MutationResult> | null)?.affectedRows;
  if (affectedRows !== 1) throw new Error(`${label} compare-and-swap failed; action is already consumed or ambiguous`);
}

function parsePredecessors(value: string | string[]): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("predecessor action index is invalid");
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("predecessor action index is invalid");
  }
  return parsed;
}

async function selectOne<T>(
  connection: Gate6SqlConnection,
  sql: string,
  parameters: readonly unknown[],
  label: string,
): Promise<T> {
  const [result] = await connection.execute(sql, parameters);
  return one<T>(result, label);
}

export async function admitDurableGate6Run(
  connection: Gate6SqlConnection,
  input: DurableGate6AdmissionInput,
): Promise<{ status: "admitted"; slotVersion: number }> {
  for (const [label, hash] of [
    ["envelope hash", input.envelopeSha256],
    ["envelope core hash", input.envelopeCoreSha256],
    ["target descriptor hash", input.productionTargetDescriptorSha256],
    ["operator bundle hash", input.operatorBundleSha256],
    ["protected install evidence hash", input.protectedInstallEvidenceSha256],
    ["installed migration set hash", input.installedMigrationSetSha256],
    ["transfer token hash", input.transferTokenSha256],
  ] as const) requireSha256(hash, label);
  if (
    input.releaseEnvironment !== "production"
    || input.runtimeEnvironment !== "production"
    || input.drillMode !== "supervised-production"
    || input.composeProject !== "spx-production"
  ) throw new Error("Gate 6 production admission discriminator mismatch");
  if (!/^[0-9a-f]{40}$/.test(input.candidateSha) || !/^[0-9a-f]{40}$/.test(input.rollbackSha)) {
    throw new Error("Gate 6 admission release SHA is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.candidateImageDigest) || !/^sha256:[0-9a-f]{64}$/.test(input.rollbackImageDigest)) {
    throw new Error("Gate 6 admission image digest is invalid");
  }
  if (!Number.isSafeInteger(input.installedSchemaVersion) || input.installedSchemaVersion <= 0) {
    throw new Error("Gate 6 installed schema version is invalid");
  }
  if (!Array.isArray(input.actions) || input.actions.length === 0) throw new Error("Gate 6 signed action index is empty");
  const actionIds = new Set<string>();
  const admitAction = input.actions.find((action) => action.actionId === input.admitActionId);
  if (!admitAction || admitAction.scope !== "gate6-admit" || admitAction.kind !== "forward") {
    throw new Error("Gate 6 admission action is missing");
  }
  for (const action of input.actions) {
    if (actionIds.has(action.actionId)) throw new Error("Gate 6 signed action ID is duplicated");
    actionIds.add(action.actionId);
    requireSha256(action.approvalSha256, "Gate 6 action approval hash");
    requireSha256(action.allowedMutationSha256, "Gate 6 action mutation hash");
    if (action.requiredCheckerSha256 !== null) requireSha256(action.requiredCheckerSha256, "Gate 6 checker hash");
    epoch(action.expiresAt, "Gate 6 action expiry");
  }

  const now = input.now ?? new Date();
  const admittedAt = now.toISOString();
  await connection.beginTransaction();
  try {
    const slot = await selectOne<SlotSqlRow>(connection, `
      SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
             state, version, protected_install_evidence_sha256, release_sha,
             target_descriptor_sha256, operator_bundle_sha256,
             installed_migration_set_sha256, installed_schema_version,
             heartbeat_at, expires_at
      FROM gate6_environment_slots
      WHERE environment = 'production'
      FOR UPDATE
    `, [], "installed-awaiting-gate6 production slot");
    if (
      slot.environment !== "production"
      || slot.owner_type !== "protected-install"
      || slot.owner_id !== input.installOperationId
      || slot.operation_id !== input.installOperationId
      || slot.transfer_token_sha256 !== input.transferTokenSha256
      || slot.state !== "installed-awaiting-gate6"
      || slot.protected_install_evidence_sha256 !== input.protectedInstallEvidenceSha256
      || slot.release_sha !== input.candidateSha
      || slot.target_descriptor_sha256 !== input.productionTargetDescriptorSha256
      || slot.operator_bundle_sha256 !== input.operatorBundleSha256
      || slot.installed_migration_set_sha256 !== input.installedMigrationSetSha256
      || slot.installed_schema_version !== input.installedSchemaVersion
      || slot.expires_at === undefined
      || epoch(slot.expires_at, "protected-install slot expiry") <= now.getTime()
    ) throw new Error("installed-awaiting-gate6 slot transfer binding mismatch");

    const [runInsert] = await connection.execute(`
      INSERT INTO gate6_runs (
        gate6_id, gate6_nonce, envelope_sha256, envelope_core_sha256,
        release_environment, runtime_environment, drill_mode, compose_project,
        candidate_sha, candidate_image_digest, rollback_sha, rollback_image_digest,
        production_target_descriptor_sha256, operator_bundle_sha256,
        protected_install_evidence_sha256, installed_migration_set_sha256,
        installed_schema_version, status, current_stage, stage_version,
        accepted_checker_name, accepted_checker_sha256, revocation_reason_code,
        monitor_status, monitor_lease_expires_at,
        supervisor_status, supervisor_lease_expires_at,
        emergency_supervisor_lease_expires_at, terminal_evidence_sha256,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'active', 'admitted', 1, NULL, NULL, NULL,
                'green', ?, 'green', ?, ?, NULL, ?, ?, ?)
    `, [
      input.gate6Id, input.gate6Nonce, input.envelopeSha256, input.envelopeCoreSha256,
      input.releaseEnvironment, input.runtimeEnvironment, input.drillMode, input.composeProject,
      input.candidateSha, input.candidateImageDigest, input.rollbackSha, input.rollbackImageDigest,
      input.productionTargetDescriptorSha256, input.operatorBundleSha256,
      input.protectedInstallEvidenceSha256, input.installedMigrationSetSha256,
      input.installedSchemaVersion, input.monitorLeaseExpiresAt, input.supervisorLeaseExpiresAt,
      input.emergencySupervisorLeaseExpiresAt, input.expiresAt, admittedAt, admittedAt,
    ]);
    requireAffectedOne(runInsert, "Gate 6 run admission");

    for (const action of input.actions) {
      const status = action.actionId === input.admitActionId ? "succeeded" : "registered";
      const [actionInsert] = await connection.execute(`
        INSERT INTO gate6_actions (
          gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256,
          kind, paired_action_id, predecessor_action_ids_json,
          required_stage, required_checker_sha256, status,
          before_evidence_sha256, after_evidence_sha256, expires_at,
          consumed_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        input.gate6Id, action.scope, action.actionId, action.approvalSha256,
        action.allowedMutationSha256, action.kind, action.pairedActionId,
        JSON.stringify(action.predecessorActionIds), action.requiredStage,
        action.requiredCheckerSha256, status, input.envelopeSha256,
        status === "succeeded" ? input.envelopeSha256 : null, action.expiresAt,
        status === "succeeded" ? admittedAt : null,
        status === "succeeded" ? admittedAt : null, admittedAt, admittedAt,
      ]);
      requireAffectedOne(actionInsert, "Gate 6 action admission");
    }

    const [slotTransfer] = await connection.execute(`
      UPDATE gate6_environment_slots
      SET owner_type = 'gate6', owner_id = ?, state = 'active',
          transfer_token_sha256 = NULL, uncompensated_work = 0,
          heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
      WHERE environment = 'production'
        AND owner_type = 'protected-install' AND owner_id = ? AND operation_id = ?
        AND transfer_token_sha256 = ? AND state = 'installed-awaiting-gate6'
        AND version = ?
    `, [
      input.gate6Id, admittedAt, input.expiresAt, admittedAt,
      input.installOperationId, input.installOperationId, input.transferTokenSha256, slot.version,
    ]);
    requireAffectedOne(slotTransfer, "Gate 6 installed slot transfer");
    await connection.commit();
    return { status: "admitted", slotVersion: slot.version + 1 };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function consumeDurableAction(
  connection: Gate6SqlConnection,
  input: DurableGate6ActionInput | DurableGate6CompensationInput,
  mode: "forward" | "compensation",
): Promise<DurableGate6ActionReceipt> {
  for (const [label, hash] of [
    ["approval hash", input.approvalSha256],
    ["allowed mutation hash", input.allowedMutationSha256],
    ["envelope hash", input.envelopeSha256],
    ["envelope core hash", input.envelopeCoreSha256],
  ] as const) requireSha256(hash, label);

  const now = input.now ?? new Date();
  const nowMs = epoch(now, "Gate 6 action clock");
  const consumedAt = now.toISOString();
  await connection.beginTransaction();
  try {
    const slot = await selectOne<SlotSqlRow>(connection, `
      SELECT environment, owner_type, owner_id, state, version
      FROM gate6_environment_slots
      WHERE environment = 'production'
      FOR UPDATE
    `, [], "production Gate 6 slot");
    if (slot.owner_type !== "gate6" || slot.owner_id !== input.gate6Id) {
      throw new Error("production Gate 6 slot ownership mismatch");
    }
    if (mode === "forward" && slot.state !== "active") throw new Error("production Gate 6 slot is not active");
    if (mode === "compensation" && slot.state !== "revoked-uncompensated") {
      throw new Error("production Gate 6 slot is not awaiting compensation");
    }

    const run = await selectOne<RunSqlRow>(connection, `
      SELECT gate6_id, status, current_stage, envelope_sha256, envelope_core_sha256,
             monitor_status, monitor_lease_expires_at,
             supervisor_status, supervisor_lease_expires_at,
             emergency_supervisor_lease_expires_at, expires_at,
             accepted_checker_sha256
      FROM gate6_runs
      WHERE gate6_id = ?
      FOR UPDATE
    `, [input.gate6Id], "Gate 6 run");
    if (run.gate6_id !== input.gate6Id) throw new Error("Gate 6 run identity mismatch");
    if (run.envelope_sha256 !== input.envelopeSha256 || run.envelope_core_sha256 !== input.envelopeCoreSha256) {
      throw new Error("Gate 6 envelope identity mismatch");
    }

    if (mode === "forward") {
      const forwardInput = input as DurableGate6ActionInput;
      if (run.status !== "active") throw new Error("Gate 6 run is revoked");
      if (run.current_stage !== forwardInput.expectedStage) throw new Error("Gate 6 stage mismatch");
      if (run.monitor_status !== "green" || nowMs >= epoch(run.monitor_lease_expires_at, "monitor lease")) {
        throw new Error("monitor lease is missing, stale, or red");
      }
      if (run.supervisor_status !== "green" || nowMs >= epoch(run.supervisor_lease_expires_at, "supervisor lease")) {
        throw new Error("supervisor lease is missing, stale, or red");
      }
      if (nowMs >= epoch(run.expires_at, "Gate 6 envelope expiry")) throw new Error("Gate 6 envelope is expired");
      if ((forwardInput.expectedCheckerSha256 ?? null) !== (run.accepted_checker_sha256 ?? null)) {
        throw new Error("Gate 6 semantic checker identity mismatch");
      }
    } else {
      if (run.status !== "revoked") throw new Error("compensation requires a revoked Gate 6 run");
      if (
        run.emergency_supervisor_lease_expires_at === undefined
        || nowMs >= epoch(run.emergency_supervisor_lease_expires_at, "emergency supervisor lease")
      ) throw new Error("emergency supervisor lease is missing or stale");
    }

    const action = await selectOne<ActionSqlRow>(connection, `
      SELECT gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256,
             kind, paired_action_id, status, required_stage,
             required_checker_sha256, predecessor_action_ids_json, expires_at
      FROM gate6_actions
      WHERE gate6_id = ? AND scope = ? AND action_id = ?
      FOR UPDATE
    `, [input.gate6Id, input.scope, input.actionId], "Gate 6 action");
    if (
      action.gate6_id !== input.gate6Id
      || action.scope !== input.scope
      || action.action_id !== input.actionId
    ) throw new Error("Gate 6 action identity mismatch");
    if (action.approval_sha256 !== input.approvalSha256) throw new Error("Gate 6 action approval hash mismatch");
    if (action.allowed_mutation_sha256 !== input.allowedMutationSha256) {
      throw new Error("Gate 6 action mutation hash mismatch");
    }
    if (action.status !== "registered") throw new Error(`Gate 6 action is already consumed or ambiguous (${action.status})`);
    if (nowMs >= epoch(action.expires_at, "Gate 6 action expiry")) throw new Error("Gate 6 action is expired");

    if (mode === "forward") {
      if (action.kind === "compensation") throw new Error("compensation cannot be consumed as a forward action");
      if (action.required_stage !== (input as DurableGate6ActionInput).expectedStage) {
        throw new Error("Gate 6 action stage binding mismatch");
      }
      if ((action.required_checker_sha256 ?? null) !== ((input as DurableGate6ActionInput).expectedCheckerSha256 ?? null)) {
        throw new Error("Gate 6 action semantic checker binding mismatch");
      }
      for (const predecessorActionId of parsePredecessors(action.predecessor_action_ids_json)) {
        const predecessor = await selectOne<{ status: string }>(connection, `
          SELECT status
          FROM gate6_actions
          WHERE gate6_id = ? AND action_id = ?
          FOR UPDATE
        `, [input.gate6Id, predecessorActionId], "Gate 6 predecessor action");
        if (!["succeeded", "compensated", "not_needed"].includes(predecessor.status)) {
          throw new Error("Gate 6 predecessor evidence is incomplete");
        }
      }
      const minimumCompensationValidityMs = (input as DurableGate6ActionInput).minimumCompensationValidityMs ?? 0;
      if (!Number.isSafeInteger(minimumCompensationValidityMs) || minimumCompensationValidityMs < 0) {
        throw new Error("minimum compensation validity is invalid");
      }
      if (minimumCompensationValidityMs > 0) {
        const [recoveryResult] = await connection.execute(`
          SELECT expires_at FROM gate6_actions
          WHERE gate6_id = ? AND kind = 'compensation' AND paired_action_id = ?
          FOR UPDATE
        `, [input.gate6Id, input.actionId]);
        const recoveries = rows<{ expires_at: string | Date }>(recoveryResult, "Gate 6 compensation action");
        if (recoveries.length > 1) throw new Error("Gate 6 compensation action is ambiguous");
        if (
          recoveries[0]
          && epoch(recoveries[0].expires_at, "Gate 6 compensation expiry")
            <= nowMs + minimumCompensationValidityMs
        ) throw new Error("Gate 6 compensation validity is insufficient");
      }
    } else {
      const compensation = input as DurableGate6CompensationInput;
      if (action.kind !== "compensation" || action.paired_action_id !== compensation.pairedActionId) {
        throw new Error("Gate 6 compensation binding mismatch");
      }
      const original = await selectOne<{ status: string }>(connection, `
        SELECT status
        FROM gate6_actions
        WHERE gate6_id = ? AND action_id = ?
        FOR UPDATE
      `, [input.gate6Id, compensation.pairedActionId], "paired Gate 6 action");
      if (original.status === "registered" || original.status === "not_needed") {
        throw new Error("paired Gate 6 action has no work to restore");
      }
    }

    const [mutation] = await connection.execute(`
      UPDATE gate6_actions
      SET status = 'consumed', consumed_at = ?, updated_at = ?
      WHERE gate6_id = ? AND scope = ? AND action_id = ?
        AND status = 'registered'
        AND approval_sha256 = ? AND allowed_mutation_sha256 = ?
    `, [consumedAt, consumedAt, input.gate6Id, input.scope, input.actionId, input.approvalSha256, input.allowedMutationSha256]);
    requireAffectedOne(mutation, "Gate 6 action");

    const [slotMutation] = await connection.execute(`
      UPDATE gate6_environment_slots
      SET uncompensated_work = 1, heartbeat_at = ?, version = version + 1, updated_at = ?
      WHERE environment = 'production' AND owner_type = 'gate6'
        AND owner_id = ? AND version = ?
    `, [consumedAt, consumedAt, input.gate6Id, slot.version]);
    requireAffectedOne(slotMutation, "Gate 6 slot");
    await connection.commit();
    return Object.freeze({
      gate6Id: input.gate6Id,
      scope: input.scope,
      actionId: input.actionId,
      kind: action.kind,
      status: "consumed" as const,
      consumedAt,
      slotVersion: slot.version + 1,
      [RECEIPT_BRAND]: true as const,
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export async function beginDurableGate6Action(
  connection: Gate6SqlConnection,
  input: DurableGate6ActionInput,
): Promise<DurableGate6ActionReceipt> {
  return consumeDurableAction(connection, input, "forward");
}

export async function beginDurableGate6Compensation(
  connection: Gate6SqlConnection,
  input: DurableGate6CompensationInput,
): Promise<DurableGate6ActionReceipt> {
  return consumeDurableAction(connection, input, "compensation");
}

export function isDurableGate6ActionReceipt(value: unknown): value is DurableGate6ActionReceipt {
  return typeof value === "object" && value !== null && RECEIPT_BRAND in value;
}

export interface BeginGate6ActionInput {
  gate6Id: string;
  scope: string;
  actionId: string;
  approvalSha256: string;
  allowedMutationSha256: string;
  now?: Date;
  minimumCompensationValidityMs?: number;
}

export interface BeginGate6CompensationInput extends Omit<
  BeginGate6ActionInput,
  "minimumCompensationValidityMs"
> {
  pairedActionId: string;
}

export async function beginGate6Action(
  repository: Gate6ControlRepository,
  input: BeginGate6ActionInput,
): Promise<VerifiedGate6ActionContext> {
  return repository.beginAction(input);
}

export async function beginGate6Compensation(
  repository: Gate6ControlRepository,
  input: BeginGate6CompensationInput,
): Promise<VerifiedGate6ActionContext> {
  return repository.beginCompensation(input);
}
