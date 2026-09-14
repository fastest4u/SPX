import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { ensureDashboardTables, getPool } from "../db/client.js";
import { getRawMemoryDb } from "../db/client-memory.js";
import {
  autoAcceptHistoryInsertValues,
  type AutoAcceptRecord,
} from "./auto-accept-repository.js";

export type AutoAcceptJobSettlementStep = "budget_reservation" | "budget_release" | "progress" | "history";

export interface AutoAcceptJobSettlementKeyInput {
  jobId: number;
  step: AutoAcceptJobSettlementStep;
}

export interface SettleAutoAcceptProgressOnceInput {
  jobId: number;
  teamId: number;
  bookingId: number;
  requestIds: number[];
  ruleId: string;
  acceptedCount: number;
  traceId?: string | null;
  reasonCode: string;
  now?: Date;
}

export interface AutoAcceptRuleBudgetSettlementInput {
  jobId: number;
  teamId: number;
  bookingId: number;
  requestIds: number[];
  ruleId: string;
  acceptedCount: number;
  traceId?: string | null;
  reasonCode: string;
  now?: Date;
}

export interface WriteAutoAcceptHistoryOnceInput {
  jobId: number;
  teamId: number;
  record: AutoAcceptRecord;
  now?: Date;
}

export interface SettleAutoAcceptProgressOnceResult {
  duplicate: boolean;
}

export interface ReserveAutoAcceptRuleBudgetOnceResult {
  reserved: boolean;
  duplicate: boolean;
  reasonCode?: string;
}

export interface ReleaseAutoAcceptRuleBudgetOnceResult {
  released: boolean;
  duplicate: boolean;
}

export interface AutoAcceptStaleBudgetReservationCandidate {
  jobId: number;
  teamId: number;
  bookingId: number;
  requestId: number;
  ruleId: string;
  resultStatus: string | null;
  resultReasonCode: string | null;
  winningAttemptTraceId: string | null;
  payloadJson: string;
  completedAt: Date | null;
  reservationCompletedAt: Date;
}

export interface ListStaleAutoAcceptRuleBudgetReservationsInput {
  teamId: number;
  ruleId: string;
  staleBefore: Date;
  limit: number;
}

export interface AutoAcceptBudgetReservationSummaryInput {
  now: Date;
  staleTtlMs: number;
}

export interface AutoAcceptBudgetReservationSummary {
  activeCount: number;
  staleCount: number;
  oldestHeldAt: string | null;
  oldestHeldAgeMs: number | null;
  staleTtlMs: number;
}

export interface WriteAutoAcceptHistoryOnceResult {
  duplicate: boolean;
  historyId: number | null;
}

interface ExistingSettlementRow {
  sideEffectId: number | null;
}

interface JobSettlementIdentityInput {
  jobId: number;
  teamId: number;
  bookingId: number;
  requestId: number;
  ruleId: string;
  step: AutoAcceptJobSettlementStep;
}

interface JobSettlementRow extends ExistingSettlementRow {
  jobId: number | string;
  teamId: number | string;
  bookingId: number | string;
  requestId: number | string;
  ruleId: string;
  settlementStep: string;
}

interface CanonicalSettlementRow extends ExistingSettlementRow {
  teamId: number | string;
  bookingId: number | string;
  requestId: number | string;
  settlementStep: string;
}

class RuleBudgetUnavailableError extends Error {
  constructor() {
    super("rule budget is exhausted");
    this.name = "RuleBudgetUnavailableError";
  }
}

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function dbNow(now: Date | undefined): string {
  return formatDbTimestamp(now ?? new Date());
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

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be non-empty`);
  }
}

function requireRequestIds(requestIds: number[]): void {
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw new Error("requestIds must be non-empty");
  }
  for (const requestId of requestIds) {
    requirePositiveInteger("requestId", requestId);
  }
}

function validateStep(step: AutoAcceptJobSettlementStep): void {
  if (
    step !== "budget_reservation" &&
    step !== "budget_release" &&
    step !== "progress" &&
    step !== "history"
  ) {
    throw new Error("settlement step is not supported");
  }
}

function nullableTimestamp(value: Date | string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return formatDbTimestamp(value);
  return formatDbTimestamp(new Date(value));
}

function parseDbDate(value: Date | string | null | undefined): Date | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}.000Z`
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function firstRequestId(requestIds: number[]): number {
  requireRequestIds(requestIds);
  return requestIds[0];
}

function validateProgressInput(input: SettleAutoAcceptProgressOnceInput): void {
  requirePositiveInteger("jobId", input.jobId);
  requirePositiveInteger("teamId", input.teamId);
  requirePositiveInteger("bookingId", input.bookingId);
  firstRequestId(input.requestIds);
  requireNonEmpty("ruleId", input.ruleId);
  requirePositiveInteger("acceptedCount", input.acceptedCount);
  if (input.requestIds.length !== 1 || input.acceptedCount !== 1) {
    throw new Error("job progress settlement requires exactly one accepted request");
  }
  requireNonEmpty("reasonCode", input.reasonCode);
}

function validateBudgetInput(input: AutoAcceptRuleBudgetSettlementInput): void {
  requirePositiveInteger("jobId", input.jobId);
  requirePositiveInteger("teamId", input.teamId);
  requirePositiveInteger("bookingId", input.bookingId);
  firstRequestId(input.requestIds);
  requireNonEmpty("ruleId", input.ruleId);
  requirePositiveInteger("acceptedCount", input.acceptedCount);
  requireNonEmpty("reasonCode", input.reasonCode);
}

function validateListStaleBudgetReservationsInput(input: ListStaleAutoAcceptRuleBudgetReservationsInput): void {
  requirePositiveInteger("teamId", input.teamId);
  requireNonEmpty("ruleId", input.ruleId);
  requirePositiveInteger("limit", input.limit);
  if (!(input.staleBefore instanceof Date) || Number.isNaN(input.staleBefore.getTime())) {
    throw new Error("staleBefore must be a valid Date");
  }
}

function validateBudgetReservationSummaryInput(input: AutoAcceptBudgetReservationSummaryInput): void {
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  if (!Number.isInteger(input.staleTtlMs) || input.staleTtlMs <= 0) {
    throw new Error("staleTtlMs must be a positive integer");
  }
}

function validateHistoryInput(input: WriteAutoAcceptHistoryOnceInput): void {
  requirePositiveInteger("jobId", input.jobId);
  requirePositiveInteger("teamId", input.teamId);
  requirePositiveInteger("bookingId", input.record.bookingId);
  firstRequestId(input.record.requestIds);
  requireNonEmpty("ruleId", input.record.ruleId);
  if (input.record.requestIds.length !== 1 || (input.record.status === "success" && input.record.acceptedCount !== 1)) {
    throw new Error("job history settlement requires exactly one request");
  }
  if (input.record.status === "success" && input.record.verificationStatus !== "verified_success") {
    throw new Error("successful history settlement requires verified success");
  }
}

export function buildAutoAcceptJobSettlementKey(input: AutoAcceptJobSettlementKeyInput): string {
  requirePositiveInteger("jobId", input.jobId);
  validateStep(input.step);
  return `auto_accept_job:${input.jobId}:${input.step}`;
}

function settlementValues(input: {
  key: string;
  jobId: number;
  teamId: number;
  bookingId: number;
  requestId: number;
  ruleId: string;
  step: AutoAcceptJobSettlementStep | "progress_claim" | "history_claim";
  sideEffectId?: number | null;
  metadata: Record<string, unknown>;
  now: string;
}) {
  return [
    input.key,
    input.jobId,
    input.teamId,
    input.bookingId,
    input.requestId,
    input.ruleId,
    input.step,
    input.sideEffectId ?? null,
    JSON.stringify(input.metadata),
    input.now,
    input.now,
  ];
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function requiredNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return typeof value === "number" ? value : Number(value);
}

function historyValues(teamId: number, record: AutoAcceptRecord): Array<string | number | null> {
  const values = autoAcceptHistoryInsertValues(teamId, record);
  return [
    requiredNumber(values.teamId),
    requiredString(values.ruleId),
    requiredString(values.ruleName),
    requiredNumber(values.bookingId),
    requiredString(values.requestIds),
    requiredNumber(values.acceptedCount),
    requiredString(values.origin),
    requiredString(values.destination),
    requiredString(values.vehicleType),
    requiredString(values.status),
    nullableString(values.errorMessage),
    nullableString(values.failureReason),
    nullableString(values.traceId),
    nullableNumber(values.acceptRttMs),
    nullableNumber(values.listAgeMs),
    nullableNumber(values.verificationLatencyMs),
    nullableString(values.verificationStatus),
    nullableTimestamp(values.verifiedAt),
  ];
}

function assertJobSettlementIdentity(
  row: JobSettlementRow | undefined,
  input: JobSettlementIdentityInput,
): asserts row is JobSettlementRow {
  if (
    !row ||
    Number(row.jobId) !== input.jobId ||
    Number(row.teamId) !== input.teamId ||
    Number(row.bookingId) !== input.bookingId ||
    Number(row.requestId) !== input.requestId ||
    row.ruleId !== input.ruleId ||
    row.settlementStep !== input.step
  ) {
    throw new Error("job settlement identity conflicts with another request");
  }
}

async function findExistingSettlement(
  settlementKey: string,
  input: JobSettlementIdentityInput,
): Promise<ExistingSettlementRow> {
  if (env.DB_MODE === "memory") {
    const row = getRawMemoryDb()
      .prepare(`
        SELECT
          job_id AS jobId,
          team_id AS teamId,
          booking_id AS bookingId,
          request_id AS requestId,
          rule_id AS ruleId,
          settlement_step AS settlementStep,
          side_effect_id AS sideEffectId
        FROM auto_accept_job_settlements
        WHERE settlement_key = ?
        LIMIT 1
      `)
      .get(settlementKey) as JobSettlementRow | undefined;
    assertJobSettlementIdentity(row, input);
    return { sideEffectId: row.sideEffectId ?? null };
  }

  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       job_id AS jobId,
       team_id AS teamId,
       booking_id AS bookingId,
       request_id AS requestId,
       rule_id AS ruleId,
       settlement_step AS settlementStep,
       side_effect_id AS sideEffectId
     FROM auto_accept_job_settlements
     WHERE settlement_key = ?
     LIMIT 1`,
    [settlementKey],
  );
  const row = rows[0] as JobSettlementRow | undefined;
  assertJobSettlementIdentity(row, input);
  return {
    sideEffectId: row.sideEffectId === null || row.sideEffectId === undefined
      ? null
      : Number(row.sideEffectId),
  };
}

function reservationMetadata(input: AutoAcceptRuleBudgetSettlementInput): Record<string, unknown> {
  return {
    acceptedCount: input.acceptedCount,
    requestIds: input.requestIds,
    traceId: input.traceId ?? null,
    reasonCode: input.reasonCode,
  };
}

function hasBudgetReservationMemory(jobId: number): boolean {
  const row = getRawMemoryDb()
    .prepare("SELECT 1 FROM auto_accept_job_settlements WHERE job_id = ? AND settlement_step = 'budget_reservation' LIMIT 1")
    .get(jobId);
  return Boolean(row);
}

function hasBudgetReleaseMemory(jobId: number): boolean {
  const row = getRawMemoryDb()
    .prepare("SELECT 1 FROM auto_accept_job_settlements WHERE job_id = ? AND settlement_step = 'budget_release' LIMIT 1")
    .get(jobId);
  return Boolean(row);
}

function hasProgressSettlementMemory(jobId: number): boolean {
  const row = getRawMemoryDb()
    .prepare("SELECT 1 FROM auto_accept_job_settlements WHERE job_id = ? AND settlement_step = 'progress' LIMIT 1")
    .get(jobId);
  return Boolean(row);
}

function activeBudgetReservationCountMemory(input: { teamId: number; ruleId: string }): number {
  const row = getRawMemoryDb()
    .prepare(`
      SELECT COUNT(*) AS activeCount
      FROM auto_accept_job_settlements reservation
      WHERE reservation.team_id = ?
        AND reservation.rule_id = ?
        AND reservation.settlement_step = 'budget_reservation'
        AND NOT EXISTS (
          SELECT 1
          FROM auto_accept_job_settlements terminal
          WHERE terminal.job_id = reservation.job_id
            AND terminal.settlement_step IN ('budget_release', 'progress')
        )
    `)
    .get(input.teamId, input.ruleId) as { activeCount: number } | undefined;
  return Number(row?.activeCount ?? 0);
}

type StaleBudgetReservationRow = {
  jobId: number | string;
  teamId: number | string;
  bookingId: number | string;
  requestId: number | string;
  ruleId: string;
  resultStatus: string | null;
  resultReasonCode: string | null;
  winningAttemptTraceId: string | null;
  payloadJson: string;
  completedAt: Date | string | null;
  reservationCompletedAt: Date | string;
};

type BudgetReservationSummaryRow = {
  activeCount?: number | string | null;
  staleCount?: number | string | null;
  oldestHeldAt?: Date | string | null;
};

function staleBudgetReservationCandidateFromRow(row: StaleBudgetReservationRow): AutoAcceptStaleBudgetReservationCandidate {
  return {
    jobId: Number(row.jobId),
    teamId: Number(row.teamId),
    bookingId: Number(row.bookingId),
    requestId: Number(row.requestId),
    ruleId: row.ruleId,
    resultStatus: row.resultStatus ?? null,
    resultReasonCode: row.resultReasonCode ?? null,
    winningAttemptTraceId: row.winningAttemptTraceId ?? null,
    payloadJson: row.payloadJson,
    completedAt: parseDbDate(row.completedAt),
    reservationCompletedAt: parseDbDate(row.reservationCompletedAt) ?? new Date(0),
  };
}

function numberFromAggregate(value: number | string | null | undefined): number {
  const numberValue = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function budgetReservationSummaryFromRow(
  row: BudgetReservationSummaryRow | undefined,
  input: AutoAcceptBudgetReservationSummaryInput,
): AutoAcceptBudgetReservationSummary {
  const oldestHeldAt = parseDbDate(row?.oldestHeldAt);
  return {
    activeCount: numberFromAggregate(row?.activeCount),
    staleCount: numberFromAggregate(row?.staleCount),
    oldestHeldAt: oldestHeldAt ? oldestHeldAt.toISOString() : null,
    oldestHeldAgeMs: oldestHeldAt ? Math.max(0, input.now.getTime() - oldestHeldAt.getTime()) : null,
    staleTtlMs: input.staleTtlMs,
  };
}

function getBudgetReservationSummaryMemory(
  input: AutoAcceptBudgetReservationSummaryInput,
): AutoAcceptBudgetReservationSummary {
  const staleBefore = new Date(input.now.getTime() - input.staleTtlMs);
  const row = getRawMemoryDb()
    .prepare(`
      SELECT
        COUNT(*) AS activeCount,
        SUM(CASE
          WHEN job.status = 'indeterminate'
            AND job.result_status = 'unknown'
            AND job.completed_at <= ?
          THEN 1 ELSE 0 END) AS staleCount,
        MIN(reservation.completed_at) AS oldestHeldAt
      FROM auto_accept_job_settlements reservation
      INNER JOIN auto_accept_jobs job ON job.id = reservation.job_id
      LEFT JOIN auto_accept_job_settlements terminal
        ON terminal.job_id = reservation.job_id
        AND terminal.settlement_step IN ('budget_release', 'progress')
      WHERE reservation.settlement_step = 'budget_reservation'
        AND terminal.job_id IS NULL
    `)
    .get(formatDbTimestamp(staleBefore)) as BudgetReservationSummaryRow | undefined;
  return budgetReservationSummaryFromRow(row, input);
}

function listStaleBudgetReservationsMemory(
  input: ListStaleAutoAcceptRuleBudgetReservationsInput,
): AutoAcceptStaleBudgetReservationCandidate[] {
  const rows = getRawMemoryDb()
    .prepare(`
      SELECT
        reservation.job_id AS jobId,
        reservation.team_id AS teamId,
        reservation.booking_id AS bookingId,
        reservation.request_id AS requestId,
        reservation.rule_id AS ruleId,
        job.result_status AS resultStatus,
        job.result_reason_code AS resultReasonCode,
        job.winning_attempt_trace_id AS winningAttemptTraceId,
        job.payload_json AS payloadJson,
        job.completed_at AS completedAt,
        reservation.completed_at AS reservationCompletedAt
      FROM auto_accept_job_settlements reservation
      INNER JOIN auto_accept_jobs job ON job.id = reservation.job_id
      WHERE reservation.team_id = ?
        AND reservation.rule_id = ?
        AND reservation.settlement_step = 'budget_reservation'
        AND job.status = 'indeterminate'
        AND job.result_status = 'unknown'
        AND job.completed_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM auto_accept_job_settlements terminal
          WHERE terminal.job_id = reservation.job_id
            AND terminal.settlement_step IN ('budget_release', 'progress')
        )
      ORDER BY reservation.completed_at ASC, reservation.job_id ASC
      LIMIT ?
    `)
    .all(input.teamId, input.ruleId, formatDbTimestamp(input.staleBefore), input.limit) as StaleBudgetReservationRow[];
  return rows.map(staleBudgetReservationCandidateFromRow);
}

async function hasBudgetReservationMysql(jobId: number): Promise<boolean> {
  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT 1 FROM auto_accept_job_settlements WHERE job_id = ? AND settlement_step = 'budget_reservation' LIMIT 1",
    [jobId],
  );
  return rows.length > 0;
}

async function listStaleBudgetReservationsMysql(
  input: ListStaleAutoAcceptRuleBudgetReservationsInput,
): Promise<AutoAcceptStaleBudgetReservationCandidate[]> {
  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      reservation.job_id AS jobId,
      reservation.team_id AS teamId,
      reservation.booking_id AS bookingId,
      reservation.request_id AS requestId,
      reservation.rule_id AS ruleId,
      job.result_status AS resultStatus,
      job.result_reason_code AS resultReasonCode,
      job.winning_attempt_trace_id AS winningAttemptTraceId,
      job.payload_json AS payloadJson,
      job.completed_at AS completedAt,
      reservation.completed_at AS reservationCompletedAt
    FROM auto_accept_job_settlements reservation
    INNER JOIN auto_accept_jobs job ON job.id = reservation.job_id
    WHERE reservation.team_id = ?
      AND reservation.rule_id = ?
      AND reservation.settlement_step = 'budget_reservation'
      AND job.status = 'indeterminate'
      AND job.result_status = 'unknown'
      AND job.completed_at <= ?
      AND NOT EXISTS (
        SELECT 1
        FROM auto_accept_job_settlements terminal
        WHERE terminal.job_id = reservation.job_id
          AND terminal.settlement_step IN ('budget_release', 'progress')
      )
    ORDER BY reservation.completed_at ASC, reservation.job_id ASC
    LIMIT ?
  `, [input.teamId, input.ruleId, formatDbTimestamp(input.staleBefore), input.limit]);
  return (rows as unknown as StaleBudgetReservationRow[]).map(staleBudgetReservationCandidateFromRow);
}

async function getBudgetReservationSummaryMysql(
  input: AutoAcceptBudgetReservationSummaryInput,
): Promise<AutoAcceptBudgetReservationSummary> {
  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const staleBefore = new Date(input.now.getTime() - input.staleTtlMs);
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      COUNT(*) AS activeCount,
      SUM(CASE
        WHEN job.status = 'indeterminate'
          AND job.result_status = 'unknown'
          AND job.completed_at <= ?
        THEN 1 ELSE 0 END) AS staleCount,
      MIN(reservation.completed_at) AS oldestHeldAt
    FROM auto_accept_job_settlements reservation
    INNER JOIN auto_accept_jobs job ON job.id = reservation.job_id
    LEFT JOIN auto_accept_job_settlements terminal
      ON terminal.job_id = reservation.job_id
      AND terminal.settlement_step IN ('budget_release', 'progress')
    WHERE reservation.settlement_step = 'budget_reservation'
      AND terminal.job_id IS NULL
  `, [formatDbTimestamp(staleBefore)]);
  return budgetReservationSummaryFromRow(rows[0] as BudgetReservationSummaryRow | undefined, input);
}

function reservationAvailableMemory(input: AutoAcceptRuleBudgetSettlementInput): boolean {
  const rule = getRawMemoryDb()
    .prepare("SELECT need FROM notify_rules WHERE team_id = ? AND id = ? AND enabled = 1 AND fulfilled = 0 LIMIT 1")
    .get(input.teamId, input.ruleId) as { need: number } | undefined;
  if (!rule) return false;
  return Number(rule.need) - activeBudgetReservationCountMemory(input) >= input.acceptedCount;
}

function reserveBudgetMemory(
  input: AutoAcceptRuleBudgetSettlementInput,
  settlementKey: string,
): ReserveAutoAcceptRuleBudgetOnceResult {
  const db = getRawMemoryDb();
  const now = dbNow(input.now);
  const requestId = firstRequestId(input.requestIds);
  const tx = db.transaction(() => {
    if (hasBudgetReservationMemory(input.jobId)) return "duplicate";
    if (!reservationAvailableMemory(input)) throw new RuleBudgetUnavailableError();

    db.prepare(`
      INSERT INTO auto_accept_job_settlements (
        settlement_key, job_id, team_id, booking_id, request_id, rule_id,
        settlement_step, side_effect_id, metadata_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...settlementValues({
      key: settlementKey,
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId,
      ruleId: input.ruleId,
      step: "budget_reservation",
      metadata: reservationMetadata(input),
      now,
    }));
    return "reserved";
  });

  try {
    const result = tx();
    return { reserved: true, duplicate: result === "duplicate" };
  } catch (error) {
    if (isDuplicateError(error)) return { reserved: true, duplicate: true };
    if (error instanceof RuleBudgetUnavailableError) {
      return { reserved: false, duplicate: false, reasonCode: "rule_budget_exhausted" };
    }
    throw error;
  }
}

async function reserveBudgetMysql(
  input: AutoAcceptRuleBudgetSettlementInput,
  settlementKey: string,
): Promise<ReserveAutoAcceptRuleBudgetOnceResult> {
  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const now = dbNow(input.now);
  const requestId = firstRequestId(input.requestIds);
  let connection: PoolConnection | null = null;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [existing] = await connection.execute<RowDataPacket[]>(
      "SELECT 1 FROM auto_accept_job_settlements WHERE job_id = ? AND settlement_step = 'budget_reservation' LIMIT 1",
      [input.jobId],
    );
    if (existing.length > 0) {
      await connection.commit();
      return { reserved: true, duplicate: true };
    }

    const [rules] = await connection.execute<RowDataPacket[]>(
      "SELECT need FROM notify_rules WHERE team_id = ? AND id = ? AND enabled = 1 AND fulfilled = 0 LIMIT 1 FOR UPDATE",
      [input.teamId, input.ruleId],
    );
    const rule = rules[0] as { need?: number | string } | undefined;
    if (!rule) throw new RuleBudgetUnavailableError();

    const [activeReservations] = await connection.execute<RowDataPacket[]>(`
      SELECT COUNT(*) AS activeCount
      FROM auto_accept_job_settlements reservation
      WHERE reservation.team_id = ?
        AND reservation.rule_id = ?
        AND reservation.settlement_step = 'budget_reservation'
        AND NOT EXISTS (
          SELECT 1
          FROM auto_accept_job_settlements terminal
          WHERE terminal.job_id = reservation.job_id
            AND terminal.settlement_step IN ('budget_release', 'progress')
        )
    `, [input.teamId, input.ruleId]);
    const activeCount = Number((activeReservations[0] as { activeCount?: number | string } | undefined)?.activeCount ?? 0);
    if (Number(rule.need ?? 0) - activeCount < input.acceptedCount) throw new RuleBudgetUnavailableError();

    await connection.execute<ResultSetHeader>(`
      INSERT INTO auto_accept_job_settlements (
        settlement_key, job_id, team_id, booking_id, request_id, rule_id,
        settlement_step, side_effect_id, metadata_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, settlementValues({
      key: settlementKey,
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId,
      ruleId: input.ruleId,
      step: "budget_reservation",
      metadata: reservationMetadata(input),
      now,
    }));

    await connection.commit();
    return { reserved: true, duplicate: false };
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch { /* rollback best effort */ }
    }
    if (isDuplicateError(error)) return { reserved: true, duplicate: true };
    if (error instanceof RuleBudgetUnavailableError) {
      return { reserved: false, duplicate: false, reasonCode: "rule_budget_exhausted" };
    }
    throw error;
  } finally {
    connection?.release();
  }
}

function releaseBudgetMemory(
  input: AutoAcceptRuleBudgetSettlementInput,
  settlementKey: string,
): ReleaseAutoAcceptRuleBudgetOnceResult {
  const db = getRawMemoryDb();
  const now = dbNow(input.now);
  const requestId = firstRequestId(input.requestIds);
  const tx = db.transaction(() => {
    if (hasBudgetReleaseMemory(input.jobId)) return "duplicate";
    if (!hasBudgetReservationMemory(input.jobId) || hasProgressSettlementMemory(input.jobId)) return "not_active";

    db.prepare(`
      INSERT INTO auto_accept_job_settlements (
        settlement_key, job_id, team_id, booking_id, request_id, rule_id,
        settlement_step, side_effect_id, metadata_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...settlementValues({
      key: settlementKey,
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId,
      ruleId: input.ruleId,
      step: "budget_release",
      metadata: reservationMetadata(input),
      now,
    }));
    return "released";
  });

  try {
    const result = tx();
    if (result === "duplicate") return { released: true, duplicate: true };
    if (result === "released") return { released: true, duplicate: false };
    return { released: false, duplicate: false };
  } catch (error) {
    if (isDuplicateError(error)) return { released: true, duplicate: true };
    throw error;
  }
}

async function releaseBudgetMysql(
  input: AutoAcceptRuleBudgetSettlementInput,
  settlementKey: string,
): Promise<ReleaseAutoAcceptRuleBudgetOnceResult> {
  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const now = dbNow(input.now);
  const requestId = firstRequestId(input.requestIds);
  let connection: PoolConnection | null = null;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [existingRelease] = await connection.execute<RowDataPacket[]>(
      "SELECT 1 FROM auto_accept_job_settlements WHERE job_id = ? AND settlement_step = 'budget_release' LIMIT 1",
      [input.jobId],
    );
    if (existingRelease.length > 0) {
      await connection.commit();
      return { released: true, duplicate: true };
    }

    const [reservations] = await connection.execute<RowDataPacket[]>(
      "SELECT 1 FROM auto_accept_job_settlements WHERE job_id = ? AND settlement_step = 'budget_reservation' LIMIT 1",
      [input.jobId],
    );
    const [progressRows] = await connection.execute<RowDataPacket[]>(
      "SELECT 1 FROM auto_accept_job_settlements WHERE job_id = ? AND settlement_step = 'progress' LIMIT 1",
      [input.jobId],
    );
    if (reservations.length === 0 || progressRows.length > 0) {
      await connection.commit();
      return { released: false, duplicate: false };
    }

    await connection.execute<ResultSetHeader>(`
      INSERT INTO auto_accept_job_settlements (
        settlement_key, job_id, team_id, booking_id, request_id, rule_id,
        settlement_step, side_effect_id, metadata_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, settlementValues({
      key: settlementKey,
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId,
      ruleId: input.ruleId,
      step: "budget_release",
      metadata: reservationMetadata(input),
      now,
    }));

    await connection.commit();
    return { released: true, duplicate: false };
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch { /* rollback best effort */ }
    }
    if (isDuplicateError(error)) return { released: true, duplicate: true };
    throw error;
  } finally {
    connection?.release();
  }
}

interface CanonicalSettlementInput {
  jobId: number;
  teamId: number;
  bookingId: number;
  requestId: number;
  ruleId: string;
  step: "progress" | "history";
  now: string;
}

interface CanonicalSettlementClaim {
  key: string;
  owner: boolean;
  historyId: number | null;
}

const INSERT_SETTLEMENT = `
  INSERT INTO auto_accept_job_settlements (
    settlement_key, job_id, team_id, booking_id, request_id, rule_id,
    settlement_step, side_effect_id, metadata_json, created_at, completed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function canonicalSettlement(input: CanonicalSettlementInput) {
  const key = `auto_accept_request:${input.teamId}:${input.bookingId}:${input.requestId}:${input.step}`;
  return { key, values: settlementValues({
    ...input,
    key,
    step: input.step === "progress" ? "progress_claim" : "history_claim",
    metadata: { canonicalRequest: true },
  }) };
}

function canonicalClaimStep(step: CanonicalSettlementInput["step"]): "progress_claim" | "history_claim" {
  return step === "progress" ? "progress_claim" : "history_claim";
}

function assertCanonicalSettlementIdentity(
  row: CanonicalSettlementRow | undefined,
  input: CanonicalSettlementInput,
): asserts row is CanonicalSettlementRow {
  if (
    !row ||
    Number(row.teamId) !== input.teamId ||
    Number(row.bookingId) !== input.bookingId ||
    Number(row.requestId) !== input.requestId ||
    row.settlementStep !== canonicalClaimStep(input.step)
  ) {
    throw new Error("canonical settlement identity conflicts with another request");
  }
}

function legacySettlementQuery(step: "progress" | "history") {
  return step === "progress"
    ? `SELECT job_id AS sideEffectId FROM auto_accept_job_settlements
       WHERE team_id = ? AND booking_id = ? AND request_id = ? AND settlement_step = 'progress'
       ORDER BY id LIMIT 1`
    : `SELECT history.id AS sideEffectId FROM auto_accept_job_settlements settlement
       JOIN auto_accept_history history ON history.id = settlement.side_effect_id
       WHERE settlement.team_id = ? AND settlement.booking_id = ? AND settlement.request_id = ?
         AND settlement.settlement_step = 'history' AND history.status = 'success'
         AND history.verification_status = 'verified_success'
       ORDER BY settlement.id LIMIT 1`;
}

function claimCanonicalSettlementMemory(input: CanonicalSettlementInput): CanonicalSettlementClaim {
  const db = getRawMemoryDb();
  const { key, values } = canonicalSettlement(input);
  let owner = true;
  try {
    db.prepare(INSERT_SETTLEMENT).run(...values);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    owner = false;
  }
  const row = db.prepare(`
    SELECT
      team_id AS teamId,
      booking_id AS bookingId,
      request_id AS requestId,
      settlement_step AS settlementStep,
      side_effect_id AS sideEffectId
    FROM auto_accept_job_settlements
    WHERE settlement_key = ?
  `).get(key) as CanonicalSettlementRow | undefined;
  assertCanonicalSettlementIdentity(row, input);
  let historyId = row.sideEffectId;
  if (owner) {
    const existing = db.prepare(legacySettlementQuery(input.step)).get(input.teamId, input.bookingId, input.requestId) as ExistingSettlementRow | undefined;
    if (existing) {
      owner = false;
      historyId = input.step === "history" ? existing.sideEffectId : null;
      db.prepare("UPDATE auto_accept_job_settlements SET side_effect_id = ? WHERE settlement_key = ?").run(historyId, key);
    }
  }
  if (!owner && input.step === "history" && (!Number.isInteger(historyId) || Number(historyId) <= 0)) {
    throw new Error("canonical history settlement is incomplete");
  }
  return { key, owner, historyId };
}

async function claimCanonicalSettlementMysql(connection: PoolConnection, input: CanonicalSettlementInput): Promise<CanonicalSettlementClaim> {
  const { key, values } = canonicalSettlement(input);
  let owner = true;
  try {
    await connection.execute<ResultSetHeader>(INSERT_SETTLEMENT, values);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    owner = false;
  }
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT
      team_id AS teamId,
      booking_id AS bookingId,
      request_id AS requestId,
      settlement_step AS settlementStep,
      side_effect_id AS sideEffectId
    FROM auto_accept_job_settlements
    WHERE settlement_key = ?
    FOR UPDATE
  `, [key]);
  const row = rows[0] as CanonicalSettlementRow | undefined;
  assertCanonicalSettlementIdentity(row, input);
  let historyId = row.sideEffectId == null ? null : Number(row.sideEffectId);
  if (owner) {
    const [existing] = await connection.query<RowDataPacket[]>(legacySettlementQuery(input.step), [input.teamId, input.bookingId, input.requestId]);
    if (existing[0]) {
      owner = false;
      historyId = input.step === "history" ? Number(existing[0].sideEffectId) : null;
      await connection.execute("UPDATE auto_accept_job_settlements SET side_effect_id = ? WHERE settlement_key = ?", [historyId, key]);
    }
  }
  if (!owner && input.step === "history" && (!Number.isInteger(historyId) || Number(historyId) <= 0)) {
    throw new Error("canonical history settlement is incomplete");
  }
  return { key, owner, historyId };
}

function settleProgressMemory(input: SettleAutoAcceptProgressOnceInput, settlementKey: string): boolean {
  const db = getRawMemoryDb();
  const now = dbNow(input.now);
  const requestId = firstRequestId(input.requestIds);
  const tx = db.transaction(() => {
    const canonical = claimCanonicalSettlementMemory({ ...input, requestId, step: "progress", now });
    db.prepare(`
      INSERT INTO auto_accept_job_settlements (
        settlement_key, job_id, team_id, booking_id, request_id, rule_id,
        settlement_step, side_effect_id, metadata_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...settlementValues({
      key: settlementKey,
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId,
      ruleId: input.ruleId,
      step: "progress",
      metadata: {
        acceptedCount: input.acceptedCount,
        requestIds: input.requestIds,
        traceId: input.traceId ?? null,
        reasonCode: input.reasonCode,
      },
      now,
    }));

    if (!canonical.owner) return true;
    const update = db.prepare(`
      UPDATE notify_rules
      SET
        need = CASE WHEN need > ? THEN need - ? ELSE 0 END,
        updated_at = datetime('now')
      WHERE team_id = ? AND id = ?
    `).run(input.acceptedCount, input.acceptedCount, input.teamId, input.ruleId);
    if (update.changes === 0) {
      throw new Error(`notify rule ${input.ruleId} was not found for team ${input.teamId}`);
    }

    db.prepare(`
      UPDATE notify_rules
      SET
        fulfilled = CASE WHEN need <= 0 THEN 1 ELSE 0 END,
        auto_accepted = CASE WHEN need <= 0 THEN 1 ELSE 0 END,
        updated_at = datetime('now')
      WHERE team_id = ? AND id = ?
    `).run(input.teamId, input.ruleId);
    return false;
  });
  return tx();
}

async function settleProgressMysql(input: SettleAutoAcceptProgressOnceInput, settlementKey: string): Promise<boolean> {
  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const now = dbNow(input.now);
  const requestId = firstRequestId(input.requestIds);
  let connection: PoolConnection | null = null;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const canonical = await claimCanonicalSettlementMysql(connection, { ...input, requestId, step: "progress", now });
    await connection.execute<ResultSetHeader>(`
      INSERT INTO auto_accept_job_settlements (
        settlement_key, job_id, team_id, booking_id, request_id, rule_id,
        settlement_step, side_effect_id, metadata_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, settlementValues({
      key: settlementKey,
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId,
      ruleId: input.ruleId,
      step: "progress",
      metadata: {
        acceptedCount: input.acceptedCount,
        requestIds: input.requestIds,
        traceId: input.traceId ?? null,
        reasonCode: input.reasonCode,
      },
      now,
    }));

    if (!canonical.owner) {
      await connection.commit();
      return true;
    }
    const [update] = await connection.execute<ResultSetHeader>(`
      UPDATE notify_rules
      SET
        need = CASE WHEN need > ? THEN need - ? ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE team_id = ? AND id = ?
    `, [input.acceptedCount, input.acceptedCount, input.teamId, input.ruleId]);
    if (update.affectedRows === 0) {
      throw new Error(`notify rule ${input.ruleId} was not found for team ${input.teamId}`);
    }

    await connection.execute<ResultSetHeader>(`
      UPDATE notify_rules
      SET
        fulfilled = CASE WHEN need <= 0 THEN 1 ELSE 0 END,
        auto_accepted = CASE WHEN need <= 0 THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE team_id = ? AND id = ?
    `, [input.teamId, input.ruleId]);

    await connection.commit();
    return false;
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch { /* rollback best effort */ }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

function writeHistoryMemory(input: WriteAutoAcceptHistoryOnceInput, settlementKey: string): WriteAutoAcceptHistoryOnceResult {
  const db = getRawMemoryDb();
  const now = dbNow(input.now);
  const requestId = firstRequestId(input.record.requestIds);
  let historyId = 0;
  let duplicate = false;
  const tx = db.transaction(() => {
    const canonical = input.record.status === "success" ? claimCanonicalSettlementMemory({
      jobId: input.jobId, teamId: input.teamId, bookingId: input.record.bookingId, requestId,
      ruleId: input.record.ruleId, step: "history", now,
    }) : null;
    db.prepare(`
      INSERT INTO auto_accept_job_settlements (
        settlement_key, job_id, team_id, booking_id, request_id, rule_id,
        settlement_step, side_effect_id, metadata_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...settlementValues({
      key: settlementKey,
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.record.bookingId,
      requestId,
      ruleId: input.record.ruleId,
      step: "history",
      metadata: {
        status: input.record.status,
        acceptedCount: input.record.acceptedCount,
        requestIds: input.record.requestIds,
        traceId: input.record.traceId ?? null,
      },
      now,
    }));

    if (canonical && !canonical.owner) {
      historyId = canonical.historyId!;
      duplicate = true;
      db.prepare("UPDATE auto_accept_job_settlements SET side_effect_id = ? WHERE settlement_key = ?").run(historyId, settlementKey);
      return;
    }
    const historyResult = db.prepare(`
      INSERT INTO auto_accept_history (
        team_id, rule_id, rule_name, booking_id, request_ids, accepted_count,
        origin, destination, vehicle_type, status, error_message, failure_reason,
        trace_id, accept_rtt_ms, list_age_ms, verification_latency_ms,
        verification_status, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...historyValues(input.teamId, input.record));
    historyId = Number(historyResult.lastInsertRowid);

    db.prepare(`
      UPDATE auto_accept_job_settlements
      SET side_effect_id = ?
      WHERE settlement_key IN (?, ?)
    `).run(historyId, settlementKey, canonical?.key ?? settlementKey);
  });
  tx();
  return { historyId, duplicate };
}

async function writeHistoryMysql(input: WriteAutoAcceptHistoryOnceInput, settlementKey: string): Promise<WriteAutoAcceptHistoryOnceResult> {
  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const now = dbNow(input.now);
  const requestId = firstRequestId(input.record.requestIds);
  let connection: PoolConnection | null = null;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const canonical = input.record.status === "success" ? await claimCanonicalSettlementMysql(connection, {
      jobId: input.jobId, teamId: input.teamId, bookingId: input.record.bookingId, requestId,
      ruleId: input.record.ruleId, step: "history", now,
    }) : null;
    await connection.execute<ResultSetHeader>(`
      INSERT INTO auto_accept_job_settlements (
        settlement_key, job_id, team_id, booking_id, request_id, rule_id,
        settlement_step, side_effect_id, metadata_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, settlementValues({
      key: settlementKey,
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.record.bookingId,
      requestId,
      ruleId: input.record.ruleId,
      step: "history",
      metadata: {
        status: input.record.status,
        acceptedCount: input.record.acceptedCount,
        requestIds: input.record.requestIds,
        traceId: input.record.traceId ?? null,
      },
      now,
    }));

    if (canonical && !canonical.owner) {
      await connection.execute("UPDATE auto_accept_job_settlements SET side_effect_id = ? WHERE settlement_key = ?", [canonical.historyId, settlementKey]);
      await connection.commit();
      return { historyId: canonical.historyId, duplicate: true };
    }
    const [historyResult] = await connection.execute<ResultSetHeader>(`
      INSERT INTO auto_accept_history (
        team_id, rule_id, rule_name, booking_id, request_ids, accepted_count,
        origin, destination, vehicle_type, status, error_message, failure_reason,
        trace_id, accept_rtt_ms, list_age_ms, verification_latency_ms,
        verification_status, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, historyValues(input.teamId, input.record));
    const historyId = historyResult.insertId;

    await connection.execute<ResultSetHeader>(`
      UPDATE auto_accept_job_settlements
      SET side_effect_id = ?
      WHERE settlement_key IN (?, ?)
    `, [historyId, settlementKey, canonical?.key ?? settlementKey]);

    await connection.commit();
    return { historyId, duplicate: false };
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch { /* rollback best effort */ }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

export async function settleAutoAcceptProgressOnce(
  input: SettleAutoAcceptProgressOnceInput,
): Promise<SettleAutoAcceptProgressOnceResult> {
  validateProgressInput(input);
  const settlementKey = buildAutoAcceptJobSettlementKey({ jobId: input.jobId, step: "progress" });

  try {
    const duplicate = env.DB_MODE === "memory"
      ? settleProgressMemory(input, settlementKey)
      : await settleProgressMysql(input, settlementKey);
    return { duplicate };
  } catch (error) {
    if (isDuplicateError(error)) {
      await findExistingSettlement(settlementKey, {
        jobId: input.jobId,
        teamId: input.teamId,
        bookingId: input.bookingId,
        requestId: firstRequestId(input.requestIds),
        ruleId: input.ruleId,
        step: "progress",
      });
      return { duplicate: true };
    }
    throw error;
  }
}

export async function reserveAutoAcceptRuleBudgetOnce(
  input: AutoAcceptRuleBudgetSettlementInput,
): Promise<ReserveAutoAcceptRuleBudgetOnceResult> {
  validateBudgetInput(input);
  const settlementKey = buildAutoAcceptJobSettlementKey({ jobId: input.jobId, step: "budget_reservation" });
  return env.DB_MODE === "memory"
    ? reserveBudgetMemory(input, settlementKey)
    : await reserveBudgetMysql(input, settlementKey);
}

export async function releaseAutoAcceptRuleBudgetOnce(
  input: AutoAcceptRuleBudgetSettlementInput,
): Promise<ReleaseAutoAcceptRuleBudgetOnceResult> {
  validateBudgetInput(input);
  const settlementKey = buildAutoAcceptJobSettlementKey({ jobId: input.jobId, step: "budget_release" });
  return env.DB_MODE === "memory"
    ? releaseBudgetMemory(input, settlementKey)
    : await releaseBudgetMysql(input, settlementKey);
}

export async function listStaleAutoAcceptRuleBudgetReservations(
  input: ListStaleAutoAcceptRuleBudgetReservationsInput,
): Promise<AutoAcceptStaleBudgetReservationCandidate[]> {
  validateListStaleBudgetReservationsInput(input);
  return env.DB_MODE === "memory"
    ? listStaleBudgetReservationsMemory(input)
    : await listStaleBudgetReservationsMysql(input);
}

export async function getAutoAcceptBudgetReservationSummary(
  input: AutoAcceptBudgetReservationSummaryInput,
): Promise<AutoAcceptBudgetReservationSummary> {
  validateBudgetReservationSummaryInput(input);
  return env.DB_MODE === "memory"
    ? getBudgetReservationSummaryMemory(input)
    : await getBudgetReservationSummaryMysql(input);
}

export async function hasAutoAcceptRuleBudgetReservation(jobId: number): Promise<boolean> {
  requirePositiveInteger("jobId", jobId);
  return env.DB_MODE === "memory"
    ? hasBudgetReservationMemory(jobId)
    : await hasBudgetReservationMysql(jobId);
}

export async function writeAutoAcceptHistoryOnce(
  input: WriteAutoAcceptHistoryOnceInput,
): Promise<WriteAutoAcceptHistoryOnceResult> {
  validateHistoryInput(input);
  const settlementKey = buildAutoAcceptJobSettlementKey({ jobId: input.jobId, step: "history" });

  try {
    return env.DB_MODE === "memory"
      ? writeHistoryMemory(input, settlementKey)
      : await writeHistoryMysql(input, settlementKey);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    const existing = await findExistingSettlement(settlementKey, {
      jobId: input.jobId,
      teamId: input.teamId,
      bookingId: input.record.bookingId,
      requestId: firstRequestId(input.record.requestIds),
      ruleId: input.record.ruleId,
      step: "history",
    });
    return { duplicate: true, historyId: existing.sideEffectId };
  }
}
