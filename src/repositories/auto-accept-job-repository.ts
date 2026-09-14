import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { ensureDashboardTables, getDb, getPool } from "../db/client.js";
import { getRawMemoryDb } from "../db/client-memory.js";
import { autoAcceptJobs } from "../db/schema.js";
import { getAutoAcceptBudgetReservationSummary } from "./auto-accept-job-settlement-repository.js";

export type AutoAcceptAttemptKind =
  | "pending_request"
  | "non_pending_probe"
  | "fast_accept_all"
  | "own_status_reconcile";

export type AutoAcceptJobStatus =
  | "pending"
  | "claimed"
  | "retrying"
  | "verifying"
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "dead_letter"
  | "cancelled";

export type AutoAcceptJobResultStatus = "owned" | "lost" | "failed" | "unknown";
export type AutoAcceptJobClaimScope = "execution" | "settlement";
export type AutoAcceptJobRow = typeof autoAcceptJobs.$inferSelect;

const autoAcceptJobStatuses = [
  "pending",
  "claimed",
  "retrying",
  "verifying",
  "succeeded",
  "failed",
  "indeterminate",
  "dead_letter",
  "cancelled",
] as const satisfies readonly AutoAcceptJobStatus[];

const autoAcceptAttemptKinds = [
  "pending_request",
  "non_pending_probe",
  "fast_accept_all",
  "own_status_reconcile",
] as const satisfies readonly AutoAcceptAttemptKind[];

export const AUTO_ACCEPT_JOB_DEAD_LETTER_REASON_CODES = [
  "invalid_payload",
  "identity_mismatch",
  "configuration_error",
  "execution_failure",
  "verification_indeterminate",
  "progress_persistence_failure",
  "result_persistence_failure",
  "history_persistence_failure",
  "notification_persistence_failure",
  "unsupported_job",
  "other",
] as const;

export type AutoAcceptJobDeadLetterReasonCode = typeof AUTO_ACCEPT_JOB_DEAD_LETTER_REASON_CODES[number];
export type AutoAcceptJobDeadLetterAttemptKind = AutoAcceptAttemptKind | "other";

const publicDeadLetterReasonByStoredCode = new Map<string, AutoAcceptJobDeadLetterReasonCode>([
  ...[
    "malformed_payload",
    "dry_run_invalid_payload",
    "dry_run_invalid_payload_json",
    "settlement_invalid_payload",
    "settlement_invalid_payload_json",
  ].map((reasonCode) => [reasonCode, "invalid_payload"] as const),
  ...[
    "dry_run_identity_mismatch",
    "dry_run_attempt_source_mismatch",
    "settlement_identity_mismatch",
    "settlement_request_id_required",
  ].map((reasonCode) => [reasonCode, "identity_mismatch"] as const),
  ...[
    "dry_run_rule_inactive",
    "dry_run_rule_state_mismatch",
    "dry_run_rule_state_unavailable",
    "dry_run_rule_missing",
    "real_execution_policy_unavailable",
    "real_execution_policy_blocked",
    "session_expired",
    "fast_accept_all_api_not_configured",
  ].map((reasonCode) => [reasonCode, "configuration_error"] as const),
  ...[
    "accept_api_error",
    "worker_execution_error",
  ].map((reasonCode) => [reasonCode, "execution_failure"] as const),
  ...[
    "accept_timeout_ambiguous",
    "verify_indeterminate",
    "fast_accept_all_no_verified_owned_requests",
  ].map((reasonCode) => [reasonCode, "verification_indeterminate"] as const),
  ["progress_settlement_failed", "progress_persistence_failure"],
  ["real_execution_result_checkpoint_failed", "result_persistence_failure"],
  ["settlement_checkpoint_failed", "result_persistence_failure"],
  ["history_settlement_failed", "history_persistence_failure"],
  ["notification_settlement_failed", "notification_persistence_failure"],
  ["dry_run_forbidden_payload_key", "unsupported_job"],
  ["real_execution_attempt_kind_not_supported", "unsupported_job"],
]);

const terminalAutoAcceptJobStatuses = new Set<AutoAcceptJobStatus>([
  "succeeded",
  "failed",
  "indeterminate",
  "dead_letter",
  "cancelled",
]);

export const AUTO_ACCEPT_BUDGET_RESERVATION_STALE_TTL_MS = 15 * 60_000;

export interface AutoAcceptBudgetReservationQueueSummary {
  activeCount: number;
  staleCount: number;
  oldestHeldAt: string | null;
  oldestHeldAgeMs: number | null;
  staleTtlMs: number;
}

export interface AutoAcceptJobDeadLetterGroup {
  teamId: number;
  attemptKind: AutoAcceptJobDeadLetterAttemptKind;
  reasonCode: AutoAcceptJobDeadLetterReasonCode;
  count: number;
}

export interface AutoAcceptJobDeadLetterSummary {
  total: number;
  byReasonCode: Record<AutoAcceptJobDeadLetterReasonCode, number>;
  groups: AutoAcceptJobDeadLetterGroup[];
}

export interface AutoAcceptJobQueueSummary {
  total: number;
  byStatus: Record<AutoAcceptJobStatus, number>;
  byAttemptKind: Record<AutoAcceptAttemptKind, number>;
  claimableCount: number;
  expiredClaimCount: number;
  inFlightCount: number;
  terminalCount: number;
  settlementPendingCount: number;
  budgetReservations: AutoAcceptBudgetReservationQueueSummary;
  deadLetters: AutoAcceptJobDeadLetterSummary;
}

export type AutoAcceptJobExecutionMode = "shadow" | "cutover";

export interface AutoAcceptJobIdentity {
  executionMode?: AutoAcceptJobExecutionMode;
  teamId: number;
  cutoverEpoch?: string;
  bookingId: number;
  requestId: number;
  ruleId: string;
  attemptKind: AutoAcceptAttemptKind;
}

export interface EnqueueAutoAcceptJobInput extends AutoAcceptJobIdentity {
  payload: unknown;
  maxAttempts?: number;
  nextRunAt?: Date;
  observedAt?: Date;
}

export type AutoAcceptPublicationRejectionReason =
  | "publication-fenced"
  | "stale-publication-epoch";

export class AutoAcceptPublicationRejectedError extends Error {
  readonly reason: AutoAcceptPublicationRejectionReason;

  constructor(reason: AutoAcceptPublicationRejectionReason) {
    super(reason === "publication-fenced" ? "publication fenced" : "stale publication epoch");
    this.name = "AutoAcceptPublicationRejectedError";
    this.reason = reason;
  }
}

export interface ClaimAutoAcceptJobsInput {
  ownerNodeId: string;
  claimToken: string;
  teamIds: number[];
  limit: number;
  leaseMs: number;
  scope?: AutoAcceptJobClaimScope;
  now?: Date;
}

export interface RenewAutoAcceptJobClaimInput {
  id: number;
  ownerNodeId: string;
  claimToken: string;
  leaseMs: number;
  now: Date;
}

export interface MarkAutoAcceptJobRetryingInput {
  id: number;
  ownerNodeId: string;
  claimToken: string;
  reasonCode: string;
  error?: string | null;
  retryDelayMs: number;
  count: "attempt" | "verify";
  now: Date;
}

export interface MarkAutoAcceptJobVerifyingInput {
  id: number;
  ownerNodeId: string;
  claimToken: string;
  now: Date;
}

export interface MarkAutoAcceptJobResultCheckpointInput {
  id: number;
  ownerNodeId: string;
  claimToken: string;
  resultStatus: AutoAcceptJobResultStatus;
  resultReasonCode: string;
  winningAttemptTraceId?: string | null;
  now: Date;
}

export interface MarkAutoAcceptJobSettlementCheckpointInput {
  id: number;
  ownerNodeId: string;
  claimToken: string;
  progressSettledAt?: Date;
  historyWrittenAt?: Date;
  notificationEnqueuedAt?: Date;
  now: Date;
}

export interface MarkAutoAcceptJobCompletedInput {
  preserveEvidence?: boolean;
  id: number;
  ownerNodeId: string;
  claimToken: string;
  status: Extract<AutoAcceptJobStatus, "succeeded" | "failed" | "indeterminate" | "cancelled">;
  resultStatus?: AutoAcceptJobResultStatus | null;
  resultReasonCode?: string | null;
  winningAttemptTraceId?: string | null;
  progressSettledAt?: Date | null;
  historyWrittenAt?: Date | null;
  notificationEnqueuedAt?: Date | null;
  now: Date;
}

export interface MarkAutoAcceptJobDeadLetterInput {
  id: number;
  ownerNodeId: string;
  claimToken: string;
  reasonCode: string;
  error?: string | null;
  now: Date;
}

const attemptKinds = new Set<AutoAcceptAttemptKind>([
  "pending_request",
  "non_pending_probe",
  "fast_accept_all",
  "own_status_reconcile",
]);

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function dbTimestamp(value: Date) {
  return sql`${formatDbTimestamp(value)}`;
}

function affectedRows(result: unknown): number | null {
  if (Array.isArray(result)) return affectedRows(result[0]);
  if (!result || typeof result !== "object") return null;
  for (const key of ["affectedRows", "changes", "rowsAffected"]) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function isDuplicateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (candidate.code === "ER_DUP_ENTRY" || candidate.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (candidate.errno === 1062 || candidate.errno === 1555 || candidate.errno === 2067) return true;
    if (message.includes("Duplicate entry") || message.includes("UNIQUE constraint failed")) return true;
    current = candidate.cause;
  }

  return false;
}

function truncateNullable(value: string | null | undefined, length: number): string | null {
  if (value === undefined || value === null) return null;
  return value.substring(0, length);
}

function emptyCountRecord<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function hasCountKey<T extends string>(record: Record<T, number>, key: string): key is T {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function publicDeadLetterReasonCode(value: unknown): AutoAcceptJobDeadLetterReasonCode {
  return typeof value === "string"
    ? publicDeadLetterReasonByStoredCode.get(value) ?? "other"
    : "other";
}

function publicDeadLetterAttemptKind(value: unknown): AutoAcceptJobDeadLetterAttemptKind {
  return typeof value === "string" && attemptKinds.has(value as AutoAcceptAttemptKind)
    ? value as AutoAcceptAttemptKind
    : "other";
}

function compareDeadLetterGroups(left: AutoAcceptJobDeadLetterGroup, right: AutoAcceptJobDeadLetterGroup): number {
  if (left.teamId !== right.teamId) return left.teamId - right.teamId;
  if (left.attemptKind !== right.attemptKind) return left.attemptKind < right.attemptKind ? -1 : 1;
  if (left.reasonCode !== right.reasonCode) return left.reasonCode < right.reasonCode ? -1 : 1;
  return 0;
}

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}.000Z`
    : trimmed;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isDue(value: unknown, nowMs: number): boolean {
  const timestamp = timestampMs(value);
  return timestamp !== null && timestamp <= nowMs;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requireNonNegativeRequestId(identity: AutoAcceptJobIdentity): void {
  if (identity.requestId === 0 && identity.attemptKind === "fast_accept_all") return;
  if (!Number.isInteger(identity.requestId) || identity.requestId <= 0) {
    throw new Error("requestId must be a positive integer unless attemptKind is fast_accept_all");
  }
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be non-empty`);
  }
}

function validateIdentity(identity: AutoAcceptJobIdentity): void {
  if (identity.executionMode !== undefined && identity.executionMode !== "shadow" && identity.executionMode !== "cutover") {
    throw new Error("executionMode must be shadow or cutover");
  }
  requirePositiveInteger("teamId", identity.teamId);
  requirePositiveInteger("bookingId", identity.bookingId);
  requireNonNegativeRequestId(identity);
  requireNonEmpty("ruleId", identity.ruleId);
  if (identity.cutoverEpoch !== undefined) {
    requireNonEmpty("cutoverEpoch", identity.cutoverEpoch);
    if (
      identity.cutoverEpoch.length > 80
      || identity.cutoverEpoch.trim() !== identity.cutoverEpoch
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(identity.cutoverEpoch)
    ) {
      throw new Error("cutoverEpoch must be a concrete bounded identifier");
    }
  }
  if (!attemptKinds.has(identity.attemptKind)) {
    throw new Error("attemptKind is not supported");
  }
}

function requirePositiveDuration(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function serializePayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be a JSON object");
  }
  try {
    return JSON.stringify(payload);
  } catch {
    throw new Error("payload must be JSON serializable");
  }
}

export function buildAutoAcceptJobIdempotencyKey(identity: AutoAcceptJobIdentity): string {
  validateIdentity(identity);
  const base = `${identity.teamId}:${identity.bookingId}:${identity.requestId}:${identity.ruleId}:${identity.attemptKind}`;
  const canonical = identity.cutoverEpoch ? `${base}:${identity.cutoverEpoch}` : base;
  // Observation identity must not consume or overwrite executable identity.
  return identity.executionMode === "shadow" ? `shadow:${canonical}` : canonical;
}

export async function getAutoAcceptJobByIdempotencyKey(key: string): Promise<AutoAcceptJobRow | null> {
  requireNonEmpty("idempotencyKey", key);
  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select()
    .from(autoAcceptJobs)
    .where(eq(autoAcceptJobs.idempotencyKey, key))
    .limit(1);
  return row ?? null;
}

export async function getAutoAcceptJobById(id: number): Promise<AutoAcceptJobRow | null> {
  requirePositiveInteger("id", id);
  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select()
    .from(autoAcceptJobs)
    .where(eq(autoAcceptJobs.id, id))
    .limit(1);
  return row ?? null;
}

export async function getAutoAcceptJobQueueSummary(now = new Date()): Promise<AutoAcceptJobQueueSummary> {
  await ensureDashboardTables();
  const db = await getDb();
  const [rows, budgetReservations] = await Promise.all([
    db
      .select({
        teamId: autoAcceptJobs.teamId,
        status: autoAcceptJobs.status,
        attemptKind: autoAcceptJobs.attemptKind,
        nextRunAt: autoAcceptJobs.nextRunAt,
        claimExpiresAt: autoAcceptJobs.claimExpiresAt,
        resultStatus: autoAcceptJobs.resultStatus,
        completedAt: autoAcceptJobs.completedAt,
        lastReasonCode: autoAcceptJobs.lastReasonCode,
      })
      .from(autoAcceptJobs),
    getAutoAcceptBudgetReservationSummary({
      now,
      staleTtlMs: AUTO_ACCEPT_BUDGET_RESERVATION_STALE_TTL_MS,
    }),
  ]);

  const byStatus = emptyCountRecord(autoAcceptJobStatuses);
  const byAttemptKind = emptyCountRecord(autoAcceptAttemptKinds);
  const deadLettersByReasonCode = emptyCountRecord(AUTO_ACCEPT_JOB_DEAD_LETTER_REASON_CODES);
  const deadLetterGroups = new Map<string, AutoAcceptJobDeadLetterGroup>();
  const nowMs = now.getTime();
  let claimableCount = 0;
  let expiredClaimCount = 0;
  let inFlightCount = 0;
  let terminalCount = 0;
  let settlementPendingCount = 0;

  for (const row of rows) {
    const status = row.status as AutoAcceptJobStatus;
    const attemptKind = row.attemptKind as string;

    if (hasCountKey(byStatus, status)) byStatus[status] += 1;
    if (hasCountKey(byAttemptKind, attemptKind)) byAttemptKind[attemptKind] += 1;

    if (status === "dead_letter") {
      const reasonCode = publicDeadLetterReasonCode(row.lastReasonCode);
      const publicAttemptKind = publicDeadLetterAttemptKind(attemptKind);
      deadLettersByReasonCode[reasonCode] += 1;
      const groupKey = `${row.teamId}\u0000${publicAttemptKind}\u0000${reasonCode}`;
      const existingGroup = deadLetterGroups.get(groupKey);
      if (existingGroup) {
        existingGroup.count += 1;
      } else {
        deadLetterGroups.set(groupKey, {
          teamId: row.teamId,
          attemptKind: publicAttemptKind,
          reasonCode,
          count: 1,
        });
      }
    }

    const pendingReady = (status === "pending" || status === "retrying") && isDue(row.nextRunAt, nowMs);
    const claimLocked = status === "claimed" || status === "verifying";
    const expiredClaim = claimLocked && isDue(row.claimExpiresAt, nowMs);

    if (pendingReady || expiredClaim) claimableCount += 1;
    if (expiredClaim) expiredClaimCount += 1;
    if (claimLocked && !expiredClaim) inFlightCount += 1;
    if (terminalAutoAcceptJobStatuses.has(status)) terminalCount += 1;
    if (row.resultStatus !== null && row.completedAt === null) settlementPendingCount += 1;
  }

  const deadLetterGroupList = [...deadLetterGroups.values()].sort(compareDeadLetterGroups);
  const deadLetterTotal = Object.values(deadLettersByReasonCode).reduce((total, count) => total + count, 0);
  const deadLetterGroupTotal = deadLetterGroupList.reduce((total, group) => total + group.count, 0);
  if (deadLetterTotal !== byStatus.dead_letter || deadLetterGroupTotal !== byStatus.dead_letter) {
    throw new Error("auto-accept dead-letter queue summary invariant failed");
  }

  return {
    total: rows.length,
    byStatus,
    byAttemptKind,
    claimableCount,
    expiredClaimCount,
    inFlightCount,
    terminalCount,
    settlementPendingCount,
    budgetReservations,
    deadLetters: {
      total: deadLetterTotal,
      byReasonCode: deadLettersByReasonCode,
      groups: deadLetterGroupList,
    },
  };
}

type PreparedAutoAcceptJobInsert = {
  idempotencyKey: string;
  payloadJson: string;
  now: Date;
  nextRunAt: Date;
  maxAttempts: number;
};

function controlledInsertValues(
  input: EnqueueAutoAcceptJobInput & { cutoverEpoch: string },
  prepared: PreparedAutoAcceptJobInsert,
  publicationGeneration: number,
): Array<string | number> {
  return [
    prepared.idempotencyKey,
    input.teamId,
    input.cutoverEpoch,
    publicationGeneration,
    input.bookingId,
    input.requestId,
    truncateNullable(input.ruleId, 255) ?? "",
    input.attemptKind,
    prepared.payloadJson,
    prepared.maxAttempts,
    formatDbTimestamp(prepared.nextRunAt),
    formatDbTimestamp(prepared.now),
    formatDbTimestamp(prepared.now),
  ];
}

const CONTROLLED_INSERT_SQL = `
  INSERT INTO auto_accept_jobs (
    idempotency_key, schema_version, team_id, cutover_epoch,
    publication_generation, booking_id, request_id, rule_id, attempt_kind,
    status, payload_json, max_attempts, next_run_at, created_at, updated_at
  ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
`;

function controlledPublicationMemory(
  input: EnqueueAutoAcceptJobInput & { cutoverEpoch: string },
  prepared: PreparedAutoAcceptJobInsert,
): void {
  const db = getRawMemoryDb();
  db.transaction(() => {
    const active = db.prepare(`
      SELECT active_epoch, active_generation
      FROM auto_accept_publication_active_epochs
      WHERE team_id = ?
    `).get(input.teamId) as { active_epoch: string; active_generation: number } | undefined;
    if (!active || active.active_epoch !== input.cutoverEpoch) {
      throw new AutoAcceptPublicationRejectedError("stale-publication-epoch");
    }
    const control = db.prepare(`
      SELECT state, publication_generation
      FROM auto_accept_publication_controls
      WHERE team_id = ? AND cutover_epoch = ?
    `).get(input.teamId, input.cutoverEpoch) as {
      state: string;
      publication_generation: number;
    } | undefined;
    if (
      !control
      || control.state !== "enabled"
      || Number(control.publication_generation) !== Number(active.active_generation)
    ) {
      throw new AutoAcceptPublicationRejectedError("publication-fenced");
    }
    try {
      db.prepare(CONTROLLED_INSERT_SQL).run(
        ...controlledInsertValues(input, prepared, Number(active.active_generation)),
      );
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
    }
  })();
}

async function controlledPublicationMysql(
  input: EnqueueAutoAcceptJobInput & { cutoverEpoch: string },
  prepared: PreparedAutoAcceptJobInsert,
): Promise<void> {
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  let connection: PoolConnection | null = null;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [activeRows] = await connection.execute<RowDataPacket[]>(`
      SELECT active_epoch, active_generation
      FROM auto_accept_publication_active_epochs
      WHERE team_id = ?
      FOR UPDATE
    `, [input.teamId]);
    const active = activeRows[0] as {
      active_epoch?: string;
      active_generation?: number | string;
    } | undefined;
    if (!active || active.active_epoch !== input.cutoverEpoch) {
      throw new AutoAcceptPublicationRejectedError("stale-publication-epoch");
    }
    const [controlRows] = await connection.execute<RowDataPacket[]>(`
      SELECT state, publication_generation
      FROM auto_accept_publication_controls
      WHERE team_id = ? AND cutover_epoch = ?
      FOR UPDATE
    `, [input.teamId, input.cutoverEpoch]);
    const control = controlRows[0] as {
      state?: string;
      publication_generation?: number | string;
    } | undefined;
    if (
      !control
      || control.state !== "enabled"
      || Number(control.publication_generation) !== Number(active.active_generation)
    ) {
      throw new AutoAcceptPublicationRejectedError("publication-fenced");
    }
    try {
      await connection.execute<ResultSetHeader>(
        CONTROLLED_INSERT_SQL,
        controlledInsertValues(input, prepared, Number(active.active_generation)),
      );
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
    }
    await connection.commit();
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch { /* rollback is best effort */ }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

export async function enqueueAutoAcceptJob(input: EnqueueAutoAcceptJobInput): Promise<AutoAcceptJobRow> {
  validateIdentity(input);
  const idempotencyKey = buildAutoAcceptJobIdempotencyKey(input);
  const payloadJson = serializePayload(input.payload);
  const now = input.observedAt ?? new Date();
  const maxAttempts = input.maxAttempts ?? (input.attemptKind === "non_pending_probe" ? 1 : 3);
  requirePositiveDuration("maxAttempts", maxAttempts);

  await ensureDashboardTables();
  if (input.cutoverEpoch) {
    const prepared = {
      idempotencyKey,
      payloadJson,
      now,
      nextRunAt: input.nextRunAt ?? now,
      maxAttempts,
    };
    if (env.DB_MODE === "memory") controlledPublicationMemory(
      input as EnqueueAutoAcceptJobInput & { cutoverEpoch: string },
      prepared,
    );
    else await controlledPublicationMysql(
      input as EnqueueAutoAcceptJobInput & { cutoverEpoch: string },
      prepared,
    );
    const controlledRow = await getAutoAcceptJobByIdempotencyKey(idempotencyKey);
    if (!controlledRow) throw new Error("controlled auto_accept_jobs row was not readable after enqueue");
    if (
      controlledRow.cutoverEpoch !== input.cutoverEpoch
      || controlledRow.publicationGeneration === null
    ) {
      throw new Error("controlled auto_accept_jobs row has a stale publication identity");
    }
    return controlledRow;
  }
  const db = await getDb();
  try {
    await db.insert(autoAcceptJobs).values({
      idempotencyKey,
      schemaVersion: 1,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId: input.requestId,
      ruleId: truncateNullable(input.ruleId, 255) ?? "",
      attemptKind: input.attemptKind,
      status: "pending",
      payloadJson,
      maxAttempts,
      nextRunAt: dbTimestamp(input.nextRunAt ?? now),
      createdAt: dbTimestamp(now),
      updatedAt: dbTimestamp(now),
    });
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
  }

  const row = await getAutoAcceptJobByIdempotencyKey(idempotencyKey);
  if (!row) throw new Error("auto_accept_jobs row was not readable after enqueue");
  return row;
}

function claimableWhere(teamIds: number[], now: Date, scope: AutoAcceptJobClaimScope) {
  const nowValue = dbTimestamp(now);
  const settlementPhaseWhere = and(
    isNotNull(autoAcceptJobs.resultStatus),
    isNotNull(autoAcceptJobs.resultReasonCode),
    isNull(autoAcceptJobs.completedAt),
  );
  const executionPhaseWhere = and(
    isNull(autoAcceptJobs.resultStatus),
    isNull(autoAcceptJobs.resultReasonCode),
  );
  const statusWhere = scope === "settlement"
    ? or(
      and(
        eq(autoAcceptJobs.status, "retrying"),
        lte(autoAcceptJobs.nextRunAt, nowValue),
      ),
      and(
        inArray(autoAcceptJobs.status, ["claimed", "verifying"]),
        lte(autoAcceptJobs.claimExpiresAt, nowValue),
      ),
    )
    : or(
      and(
        inArray(autoAcceptJobs.status, ["pending", "retrying"]),
        lte(autoAcceptJobs.nextRunAt, nowValue),
      ),
      and(
        inArray(autoAcceptJobs.status, ["claimed", "verifying"]),
        lte(autoAcceptJobs.claimExpiresAt, nowValue),
      ),
    );
  const publicationCurrentWhere = or(
    and(
      isNull(autoAcceptJobs.cutoverEpoch),
      isNull(autoAcceptJobs.publicationGeneration),
    ),
    sql`EXISTS (
      SELECT 1
      FROM auto_accept_publication_active_epochs active
      WHERE active.team_id = ${autoAcceptJobs.teamId}
        AND active.active_epoch = ${autoAcceptJobs.cutoverEpoch}
        AND active.active_generation = ${autoAcceptJobs.publicationGeneration}
    )`,
  );
  return and(
    inArray(autoAcceptJobs.teamId, teamIds),
    publicationCurrentWhere,
    scope === "settlement" ? settlementPhaseWhere : executionPhaseWhere,
    statusWhere,
  );
}

async function quarantineStalePublicationJobs(teamIds: number[], now: Date): Promise<void> {
  const placeholders = teamIds.map(() => "?").join(", ");
  const values = [formatDbTimestamp(now), formatDbTimestamp(now), ...teamIds];
  const statement = `
    UPDATE auto_accept_jobs
    SET status = 'indeterminate',
        claim_owner = NULL,
        claim_token = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        last_heartbeat_at = NULL,
        last_reason_code = 'stale_publication_epoch',
        completed_at = ?,
        updated_at = ?
    WHERE team_id IN (${placeholders})
      AND cutover_epoch IS NOT NULL
      AND publication_generation IS NOT NULL
      AND status IN ('pending', 'retrying', 'claimed', 'verifying')
      AND NOT EXISTS (
        SELECT 1
        FROM auto_accept_publication_active_epochs active
        WHERE active.team_id = auto_accept_jobs.team_id
          AND active.active_epoch = auto_accept_jobs.cutover_epoch
          AND active.active_generation = auto_accept_jobs.publication_generation
      )
  `;
  if (env.DB_MODE === "memory") {
    getRawMemoryDb().prepare(statement).run(...values);
    return;
  }
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  await pool.execute(statement, values);
}

export async function claimAutoAcceptJobs(input: ClaimAutoAcceptJobsInput): Promise<AutoAcceptJobRow[]> {
  requireNonEmpty("ownerNodeId", input.ownerNodeId);
  requireNonEmpty("claimToken", input.claimToken);
  requirePositiveDuration("leaseMs", input.leaseMs);
  if (!Number.isInteger(input.limit) || input.limit <= 0 || input.teamIds.length === 0) return [];
  for (const teamId of input.teamIds) requirePositiveInteger("teamId", teamId);

  const now = input.now ?? new Date();
  const scope = input.scope ?? "execution";
  const claimExpiresAt = new Date(now.getTime() + input.leaseMs);
  const claimOwner = input.ownerNodeId.substring(0, 120);
  const claimToken = normalizeClaimToken(input.claimToken);
  await ensureDashboardTables();
  await quarantineStalePublicationJobs(input.teamIds, now);
  const db = await getDb();
  const rows = await db
    .select()
    .from(autoAcceptJobs)
    .where(claimableWhere(input.teamIds, now, scope))
    .orderBy(asc(autoAcceptJobs.id))
    .limit(input.limit);
  const ids = rows.map((row: AutoAcceptJobRow) => row.id);
  if (ids.length === 0) return [];

  await db
    .update(autoAcceptJobs)
    .set({
      status: "claimed",
      claimOwner,
      claimToken,
      claimedAt: dbTimestamp(now),
      claimExpiresAt: dbTimestamp(claimExpiresAt),
      lastHeartbeatAt: dbTimestamp(now),
      updatedAt: dbTimestamp(now),
    })
    .where(and(
      inArray(autoAcceptJobs.id, ids),
      claimableWhere(input.teamIds, now, scope),
    ));

  return await db
    .select()
    .from(autoAcceptJobs)
    .where(and(
      inArray(autoAcceptJobs.id, ids),
      eq(autoAcceptJobs.claimOwner, claimOwner),
      eq(autoAcceptJobs.claimToken, claimToken),
      eq(autoAcceptJobs.status, "claimed"),
    ))
    .orderBy(asc(autoAcceptJobs.id));
}

type ActiveClaimInput = {
  id: number;
  ownerNodeId: string;
  claimToken: string;
  now: Date;
};

function normalizeClaimToken(claimToken: string): string {
  return claimToken.substring(0, 80);
}

function activeClaimWhere(input: ActiveClaimInput) {
  return and(
    eq(autoAcceptJobs.id, input.id),
    eq(autoAcceptJobs.claimOwner, input.ownerNodeId.substring(0, 120)),
    eq(autoAcceptJobs.claimToken, normalizeClaimToken(input.claimToken)),
    inArray(autoAcceptJobs.status, ["claimed", "verifying"]),
    gt(autoAcceptJobs.claimExpiresAt, dbTimestamp(input.now)),
  );
}

export async function renewAutoAcceptJobClaim(input: RenewAutoAcceptJobClaimInput): Promise<boolean> {
  requirePositiveInteger("id", input.id);
  requireNonEmpty("ownerNodeId", input.ownerNodeId);
  requireNonEmpty("claimToken", input.claimToken);
  requirePositiveDuration("leaseMs", input.leaseMs);

  const now = input.now;
  const updateResult = await (async () => {
    await ensureDashboardTables();
    const db = await getDb();
    return await db
      .update(autoAcceptJobs)
      .set({
        claimExpiresAt: dbTimestamp(new Date(now.getTime() + input.leaseMs)),
        lastHeartbeatAt: dbTimestamp(now),
        updatedAt: dbTimestamp(now),
      })
      .where(activeClaimWhere(input));
  })();
  return affectedRows(updateResult) !== 0;
}

export async function markAutoAcceptJobVerifying(input: MarkAutoAcceptJobVerifyingInput): Promise<boolean> {
  requirePositiveInteger("id", input.id);
  requireNonEmpty("ownerNodeId", input.ownerNodeId);
  requireNonEmpty("claimToken", input.claimToken);

  const now = input.now;
  await ensureDashboardTables();
  const db = await getDb();
  const updateResult = await db
    .update(autoAcceptJobs)
    .set({
      status: "verifying",
      lastHeartbeatAt: dbTimestamp(now),
      updatedAt: dbTimestamp(now),
    })
    .where(activeClaimWhere(input));
  return affectedRows(updateResult) !== 0;
}

export async function markAutoAcceptJobResultCheckpoint(input: MarkAutoAcceptJobResultCheckpointInput): Promise<boolean> {
  requirePositiveInteger("id", input.id);
  requireNonEmpty("ownerNodeId", input.ownerNodeId);
  requireNonEmpty("claimToken", input.claimToken);
  requireNonEmpty("resultStatus", input.resultStatus);
  requireNonEmpty("resultReasonCode", input.resultReasonCode);

  const now = input.now;
  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select()
    .from(autoAcceptJobs)
    .where(activeClaimWhere(input))
    .limit(1);
  if (!row) return false;

  const resultStatus = truncateNullable(input.resultStatus, 32);
  const resultReasonCode = truncateNullable(input.resultReasonCode, 64);
  const winningAttemptTraceId = truncateNullable(input.winningAttemptTraceId, 160);
  if (row.resultStatus !== null || row.resultReasonCode !== null || row.winningAttemptTraceId !== null) {
    const sameCheckpoint = row.resultStatus === resultStatus
      && row.resultReasonCode === resultReasonCode
      && row.winningAttemptTraceId === winningAttemptTraceId;
    if (!sameCheckpoint) return false;
  }

  const updateResult = await db
    .update(autoAcceptJobs)
    .set({
      status: "verifying",
      winningAttemptTraceId,
      resultStatus,
      resultReasonCode,
      lastReasonCode: resultReasonCode,
      lastHeartbeatAt: dbTimestamp(now),
      updatedAt: dbTimestamp(now),
    })
    .where(activeClaimWhere(input));
  return affectedRows(updateResult) !== 0;
}

export async function markAutoAcceptJobSettlementCheckpoint(input: MarkAutoAcceptJobSettlementCheckpointInput): Promise<boolean> {
  requirePositiveInteger("id", input.id);
  requireNonEmpty("ownerNodeId", input.ownerNodeId);
  requireNonEmpty("claimToken", input.claimToken);

  const now = input.now;
  await ensureDashboardTables();
  const db = await getDb();
  const updateResult = await db
    .update(autoAcceptJobs)
    .set({
      ...(input.progressSettledAt !== undefined ? { progressSettledAt: dbTimestamp(input.progressSettledAt) } : {}),
      ...(input.historyWrittenAt !== undefined ? { historyWrittenAt: dbTimestamp(input.historyWrittenAt) } : {}),
      ...(input.notificationEnqueuedAt !== undefined ? { notificationEnqueuedAt: dbTimestamp(input.notificationEnqueuedAt) } : {}),
      lastHeartbeatAt: dbTimestamp(now),
      updatedAt: dbTimestamp(now),
    })
    .where(activeClaimWhere(input));
  return affectedRows(updateResult) !== 0;
}

export async function markAutoAcceptJobRetrying(input: MarkAutoAcceptJobRetryingInput): Promise<boolean> {
  requirePositiveInteger("id", input.id);
  requireNonEmpty("ownerNodeId", input.ownerNodeId);
  requireNonEmpty("claimToken", input.claimToken);
  requireNonEmpty("reasonCode", input.reasonCode);
  requirePositiveDuration("retryDelayMs", input.retryDelayMs);

  await ensureDashboardTables();
  const db = await getDb();
  const now = input.now;
  const [row] = await db
    .select()
    .from(autoAcceptJobs)
    .where(activeClaimWhere(input))
    .limit(1);
  if (!row) return false;

  const nextAttemptCount = row.attemptCount + (input.count === "attempt" ? 1 : 0);
  const nextVerifyCount = row.verifyCount + (input.count === "verify" ? 1 : 0);
  const exhausted = input.count === "attempt" && nextAttemptCount >= row.maxAttempts;
  const updateResult = await db
    .update(autoAcceptJobs)
    .set({
      status: exhausted ? "dead_letter" : "retrying",
      claimOwner: null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      lastHeartbeatAt: null,
      attemptCount: nextAttemptCount,
      verifyCount: nextVerifyCount,
      nextRunAt: dbTimestamp(exhausted ? now : new Date(now.getTime() + input.retryDelayMs)),
      lastError: truncateNullable(input.error, 1000),
      lastReasonCode: truncateNullable(input.reasonCode, 64),
      updatedAt: dbTimestamp(now),
      completedAt: exhausted ? dbTimestamp(now) : null,
    })
    .where(activeClaimWhere(input));
  return affectedRows(updateResult) !== 0;
}

export async function markAutoAcceptJobCompleted(input: MarkAutoAcceptJobCompletedInput): Promise<boolean> {
  requirePositiveInteger("id", input.id);
  requireNonEmpty("ownerNodeId", input.ownerNodeId);
  requireNonEmpty("claimToken", input.claimToken);

  const now = input.now;
  await ensureDashboardTables();
  const db = await getDb();
  const updateResult = await db
    .update(autoAcceptJobs)
    .set({
      status: input.status,
      claimOwner: null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      lastHeartbeatAt: null,
      ...(input.preserveEvidence ? {
        lastReasonCode: truncateNullable(input.resultReasonCode, 64),
      } : {
        winningAttemptTraceId: truncateNullable(input.winningAttemptTraceId, 160),
        resultStatus: truncateNullable(input.resultStatus, 32),
        resultReasonCode: truncateNullable(input.resultReasonCode, 64),
        progressSettledAt: input.progressSettledAt ? dbTimestamp(input.progressSettledAt) : null,
        historyWrittenAt: input.historyWrittenAt ? dbTimestamp(input.historyWrittenAt) : null,
        notificationEnqueuedAt: input.notificationEnqueuedAt ? dbTimestamp(input.notificationEnqueuedAt) : null,
      }),
      updatedAt: dbTimestamp(now),
      completedAt: dbTimestamp(now),
    })
    .where(activeClaimWhere(input));
  return affectedRows(updateResult) !== 0;
}

export async function markAutoAcceptJobDeadLetter(input: MarkAutoAcceptJobDeadLetterInput): Promise<boolean> {
  requirePositiveInteger("id", input.id);
  requireNonEmpty("ownerNodeId", input.ownerNodeId);
  requireNonEmpty("claimToken", input.claimToken);
  requireNonEmpty("reasonCode", input.reasonCode);

  const now = input.now;
  await ensureDashboardTables();
  const db = await getDb();
  const updateResult = await db
    .update(autoAcceptJobs)
    .set({
      status: "dead_letter",
      claimOwner: null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      lastHeartbeatAt: null,
      lastError: truncateNullable(input.error, 1000),
      lastReasonCode: truncateNullable(input.reasonCode, 64),
      updatedAt: dbTimestamp(now),
      completedAt: dbTimestamp(now),
    })
    .where(activeClaimWhere(input));
  return affectedRows(updateResult) !== 0;
}
