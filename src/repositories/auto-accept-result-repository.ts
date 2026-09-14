import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { autoAcceptAttempts, autoAcceptResults } from "../db/schema.js";

export type AutoAcceptMode = "request_ids" | "accept_all";
export type AutoAcceptResultStatus = "owned" | "lost" | "failed" | "unknown";

export interface AutoAcceptAttemptInput {
  traceId: string;
  teamId: number;
  workerNodeId: string;
  bookingId: number;
  requestIds: number[];
  ruleId?: string | null;
  ruleName?: string | null;
  acceptMode: AutoAcceptMode;
  acceptStartedAt: Date;
  acceptFinishedAt?: Date | null;
  acceptRttMs?: number | null;
  spxHttpStatus?: number | null;
  spxRetcode?: number | null;
  spxMessage?: string | null;
  rawError?: string | null;
  ambiguousAccept?: boolean;
}

export interface AutoAcceptResultInput {
  teamId: number;
  bookingId: number;
  requestId: number;
  winningAttemptTraceId?: string | null;
  status: AutoAcceptResultStatus;
  reasonCode: string;
  evidence?: unknown;
}

export type AutoAcceptResultRow = typeof autoAcceptResults.$inferSelect;

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function dbTimestamp(value: Date) {
  return sql`${formatDbTimestamp(value)}`;
}

function truncateNullable(value: string | null | undefined, length: number): string | null {
  if (value === undefined || value === null) return null;
  return value.substring(0, length);
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

function validateAttempt(input: AutoAcceptAttemptInput): void {
  requireNonEmpty("traceId", input.traceId);
  requirePositiveInteger("teamId", input.teamId);
  requireNonEmpty("workerNodeId", input.workerNodeId);
  requirePositiveInteger("bookingId", input.bookingId);
  if (input.acceptMode === "accept_all" && Array.isArray(input.requestIds) && input.requestIds.length === 0) return;
  requireRequestIds(input.requestIds);
}

function validateResult(input: AutoAcceptResultInput): void {
  requirePositiveInteger("teamId", input.teamId);
  requirePositiveInteger("bookingId", input.bookingId);
  requirePositiveInteger("requestId", input.requestId);
  requireNonEmpty("reasonCode", input.reasonCode);
  if (input.winningAttemptTraceId !== undefined && input.winningAttemptTraceId !== null) {
    requireNonEmpty("winningAttemptTraceId", input.winningAttemptTraceId);
  }
}

export async function insertAutoAcceptAttempt(input: AutoAcceptAttemptInput): Promise<void> {
  validateAttempt(input);

  await ensureDashboardTables();
  const db = await getDb();
  const values = {
    traceId: truncateNullable(input.traceId, 160) ?? "",
    teamId: input.teamId,
    workerNodeId: truncateNullable(input.workerNodeId, 120) ?? "",
    bookingId: input.bookingId,
    requestIdsJson: JSON.stringify(input.requestIds),
    ruleId: truncateNullable(input.ruleId, 255),
    ruleName: truncateNullable(input.ruleName, 128),
    acceptMode: input.acceptMode,
    acceptStartedAt: dbTimestamp(input.acceptStartedAt),
    acceptFinishedAt: input.acceptFinishedAt ? dbTimestamp(input.acceptFinishedAt) : null,
    acceptRttMs: input.acceptRttMs ?? null,
    spxHttpStatus: input.spxHttpStatus ?? null,
    spxRetcode: input.spxRetcode ?? null,
    spxMessage: truncateNullable(input.spxMessage, 1000),
    rawError: truncateNullable(input.rawError, 1000),
    ambiguousAccept: input.ambiguousAccept ? 1 : 0,
  };

  try {
    await db.insert(autoAcceptAttempts).values(values);
    return;
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
  }

  await db
    .update(autoAcceptAttempts)
    .set({
      acceptFinishedAt: values.acceptFinishedAt,
      acceptRttMs: values.acceptRttMs,
      spxHttpStatus: values.spxHttpStatus,
      spxRetcode: values.spxRetcode,
      spxMessage: values.spxMessage,
      rawError: values.rawError,
      ambiguousAccept: values.ambiguousAccept,
    })
    .where(eq(autoAcceptAttempts.traceId, values.traceId));
}

export async function upsertAutoAcceptResult(input: AutoAcceptResultInput): Promise<void> {
  validateResult(input);

  await ensureDashboardTables();
  const db = await getDb();
  const now = new Date();
  const values = {
    teamId: input.teamId,
    bookingId: input.bookingId,
    requestId: input.requestId,
    winningAttemptTraceId: truncateNullable(input.winningAttemptTraceId, 160),
    status: input.status,
    reasonCode: truncateNullable(input.reasonCode, 64) ?? "",
    evidenceJson: input.evidence === undefined ? null : JSON.stringify(input.evidence),
    resolvedAt: input.status === "unknown" ? null : dbTimestamp(now),
    updatedAt: dbTimestamp(now),
  };

  try {
    await db.insert(autoAcceptResults).values(values);
    return;
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
  }

  const existing = await getAutoAcceptResult(input.teamId, input.bookingId, input.requestId);
  if (!existing) throw new Error("auto_accept_results duplicate row was not readable");
  if (existing.status === "owned" && input.status !== "owned") return;

  const updateFilters = [
    eq(autoAcceptResults.teamId, input.teamId),
    eq(autoAcceptResults.bookingId, input.bookingId),
    eq(autoAcceptResults.requestId, input.requestId),
  ];
  if (input.status !== "owned") {
    updateFilters.push(ne(autoAcceptResults.status, "owned"));
  }

  await db
    .update(autoAcceptResults)
    .set(values)
    .where(and(...updateFilters));
}

export async function getAutoAcceptResult(
  teamId: number,
  bookingId: number,
  requestId: number,
): Promise<AutoAcceptResultRow | null> {
  requirePositiveInteger("teamId", teamId);
  requirePositiveInteger("bookingId", bookingId);
  requirePositiveInteger("requestId", requestId);

  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select()
    .from(autoAcceptResults)
    .where(and(
      eq(autoAcceptResults.teamId, teamId),
      eq(autoAcceptResults.bookingId, bookingId),
      eq(autoAcceptResults.requestId, requestId),
    ))
    .limit(1);
  return row ?? null;
}

/** One indexed read protects pending-tab candidates after worker restart. */
export async function getOwnedAutoAcceptRequestKeys(
  teamId: number, bookingIds: number[], requestIds: number[],
): Promise<Set<string>> {
  if (!bookingIds.length || !requestIds.length) return new Set();
  await ensureDashboardTables();
  const rows: Array<{ bookingId: number; requestId: number }> = await getDb().select({
    bookingId: autoAcceptResults.bookingId, requestId: autoAcceptResults.requestId,
  }).from(autoAcceptResults).where(and(eq(autoAcceptResults.teamId, teamId), eq(autoAcceptResults.status, "owned"),
    inArray(autoAcceptResults.bookingId, [...new Set(bookingIds)]), inArray(autoAcceptResults.requestId, [...new Set(requestIds)])));
  return new Set(rows.map(row => `${row.bookingId}:${row.requestId}`));
}


export const ATTEMPT_IDENTITY_CONFLICT = "auto_accept_attempt_identity_conflict";

let afterBeginInsert: (() => Promise<void>) | null = null;
let beforeCompletionRead: (() => Promise<void>) | null = null;
export const __autoAcceptAttemptRepositoryTestHooks = {
  setAfterBeginInsert(hook: (() => Promise<void>) | null): void {
    if (process.env.NODE_ENV !== "test") throw new Error("test hook unavailable");
    afterBeginInsert = hook;
  },
  setBeforeCompletionRead(hook: (() => Promise<void>) | null): void {
    if (process.env.NODE_ENV !== "test") throw new Error("test hook unavailable");
    beforeCompletionRead = hook;
  },
};

export type AutoAcceptAttemptRow = typeof autoAcceptAttempts.$inferSelect;

export type BeginAutoAcceptAttemptResult =
  | { kind: "created"; row: AutoAcceptAttemptRow }
  | { kind: "existing"; row: AutoAcceptAttemptRow };

function rowRequestIds(row: AutoAcceptAttemptRow): number[] {
  try {
    const parsed = JSON.parse(row.requestIdsJson) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function sameRequestIds(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function matchesAttemptIdentity(row: AutoAcceptAttemptRow, input: AutoAcceptAttemptCompletionInput): boolean {
  // Early accept-all markers stored the booking id as a sentinel. It is the
  // same booking-wide operation as the canonical empty request-id list.
  const requestIds = (ids: number[]) => input.acceptMode === "accept_all"
    && (ids.length === 0 || (ids.length === 1 && ids[0] === input.bookingId)) ? [] : ids;
  return row.teamId === input.teamId
    && row.bookingId === input.bookingId
    && row.acceptMode === input.acceptMode
    && row.ruleId === truncateNullable(input.ruleId, 255)
    && row.ruleName === truncateNullable(input.ruleName, 128)
    && sameRequestIds(requestIds(rowRequestIds(row)), requestIds(input.requestIds));
}

function changedRows(result: unknown): number {
  if (Array.isArray(result)) return changedRows(result[0]);
  if (result && typeof result === "object") {
    const header = result as { affectedRows?: number; changes?: number };
    return header.affectedRows ?? header.changes ?? 0;
  }
  return 0;
}

/**
 * Creates the external attempt marker exactly once per trace id. When the
 * marker already exists it must describe the same job identity; a mismatch
 * is a durable conflict (ATTEMPT_IDENTITY_CONFLICT), not an overwrite.
 */
export async function beginAutoAcceptAttempt(
  input: AutoAcceptAttemptInput,
): Promise<BeginAutoAcceptAttemptResult> {
  validateAttempt(input);

  await ensureDashboardTables();
  const db = await getDb();
  const values = {
    traceId: truncateNullable(input.traceId, 160) ?? "",
    teamId: input.teamId,
    workerNodeId: truncateNullable(input.workerNodeId, 120) ?? "",
    bookingId: input.bookingId,
    requestIdsJson: JSON.stringify(input.requestIds),
    ruleId: truncateNullable(input.ruleId, 255),
    ruleName: truncateNullable(input.ruleName, 128),
    acceptMode: input.acceptMode,
    acceptStartedAt: dbTimestamp(input.acceptStartedAt),
    acceptFinishedAt: input.acceptFinishedAt ? dbTimestamp(input.acceptFinishedAt) : null,
    acceptRttMs: input.acceptRttMs ?? null,
    spxHttpStatus: input.spxHttpStatus ?? null,
    spxRetcode: input.spxRetcode ?? null,
    spxMessage: truncateNullable(input.spxMessage, 1000),
    rawError: truncateNullable(input.rawError, 1000),
    ambiguousAccept: input.ambiguousAccept ? 1 : 0,
  };

  let row: AutoAcceptAttemptRow | null = await getAutoAcceptAttemptByTraceId(values.traceId);
  if (row) {
    if (!matchesAttemptIdentity(row, input)) {
      throw new Error(ATTEMPT_IDENTITY_CONFLICT);
    }
    return { kind: "existing", row };
  }
  try {
    await db.insert(autoAcceptAttempts).values(values);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    row = await getAutoAcceptAttemptByTraceId(values.traceId);
    if (!row) throw error;
    if (!matchesAttemptIdentity(row, input)) {
      throw new Error(ATTEMPT_IDENTITY_CONFLICT);
    }
    return { kind: "existing", row };
  }
  await afterBeginInsert?.();
  const created = await getAutoAcceptAttemptByTraceId(values.traceId);
  if (!created) throw new Error("external attempt marker creation did not persist");
  return { kind: "created", row: created };
}

export type AutoAcceptAttemptCompletionInput = Omit<AutoAcceptAttemptInput, "workerNodeId" | "acceptStartedAt"> & {
  /** Identity is re-checked against the persisted marker; the original
    * worker/started values are never rewritten by completion. */
};

export type CompleteAutoAcceptAttemptResult = {
  kind: "completed" | "idempotent";
  row: AutoAcceptAttemptRow;
};

/**
 * Finalizes the external attempt marker with the accept outcome. Re-completing
 * an already-finished attempt with a conflicting identity is a durable
 * conflict; matching repeats are idempotent.
 */
export async function completeAutoAcceptAttempt(
  input: AutoAcceptAttemptCompletionInput,
): Promise<CompleteAutoAcceptAttemptResult> {
  await beforeCompletionRead?.();
  if (!(input.acceptFinishedAt instanceof Date) || !Number.isFinite(input.acceptFinishedAt.getTime())) {
    throw new Error("acceptFinishedAt must be a valid completion timestamp");
  }
  const marker = await getAutoAcceptAttemptByTraceId(input.traceId);
  const full: AutoAcceptAttemptInput = {
    ...input,
    workerNodeId: marker?.workerNodeId ?? "unknown",
    acceptStartedAt: marker?.acceptStartedAt ?? new Date(),
  };
  validateAttempt(full);

  await ensureDashboardTables();
  const db = await getDb();
  const existing = marker;
  if (!existing) throw new Error(ATTEMPT_IDENTITY_CONFLICT);
  if (!matchesAttemptIdentity(existing, full)) {
    throw new Error(ATTEMPT_IDENTITY_CONFLICT);
  }
  if (existing.acceptFinishedAt !== null) {
    return { kind: "idempotent", row: existing };
  }

  const values = {
    acceptFinishedAt: input.acceptFinishedAt ? dbTimestamp(input.acceptFinishedAt) : null,
    acceptRttMs: input.acceptRttMs ?? null,
    spxHttpStatus: input.spxHttpStatus ?? null,
    spxRetcode: input.spxRetcode ?? null,
    spxMessage: truncateNullable(input.spxMessage, 1000),
    rawError: truncateNullable(input.rawError, 1000),
    ambiguousAccept: input.ambiguousAccept ? 1 : 0,
  };
  const updateResult = await db
    .update(autoAcceptAttempts)
    .set(values)
    .where(and(
      eq(autoAcceptAttempts.traceId, input.traceId),
      isNull(autoAcceptAttempts.acceptFinishedAt),
      eq(autoAcceptAttempts.teamId, existing.teamId),
      eq(autoAcceptAttempts.bookingId, existing.bookingId),
      eq(autoAcceptAttempts.acceptMode, existing.acceptMode),
      eq(autoAcceptAttempts.requestIdsJson, existing.requestIdsJson),
      existing.ruleId === null ? isNull(autoAcceptAttempts.ruleId) : eq(autoAcceptAttempts.ruleId, existing.ruleId),
      existing.ruleName === null ? isNull(autoAcceptAttempts.ruleName) : eq(autoAcceptAttempts.ruleName, existing.ruleName),
    ));
  const completed = await getAutoAcceptAttemptByTraceId(input.traceId);
  if (!completed) throw new Error("external attempt completion did not persist");
  if (!matchesAttemptIdentity(completed, input) || completed.acceptFinishedAt === null) {
    throw new Error(ATTEMPT_IDENTITY_CONFLICT);
  }
  return { kind: changedRows(updateResult) > 0 ? "completed" : "idempotent", row: completed };
}

export async function getAutoAcceptAttemptByTraceId(
  traceId: string,
): Promise<AutoAcceptAttemptRow | null> {
  if (typeof traceId !== "string" || traceId.trim().length === 0) return null;
  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select()
    .from(autoAcceptAttempts)
    .where(eq(autoAcceptAttempts.traceId, traceId))
    .limit(1);
  return row ?? null;
}

export async function listOwnedAutoAcceptResultsByWinningTrace(input: {
  teamId: number;
  bookingId?: number;
  winningAttemptTraceId: string;
}): Promise<AutoAcceptResultRow[]> {
  if (!Number.isInteger(input.teamId) || input.teamId <= 0) return [];
  if (typeof input.winningAttemptTraceId !== "string" || input.winningAttemptTraceId.trim().length === 0) {
    return [];
  }
  await ensureDashboardTables();
  const db = await getDb();
  const predicates = [
    eq(autoAcceptResults.teamId, input.teamId),
    eq(autoAcceptResults.winningAttemptTraceId, input.winningAttemptTraceId),
    eq(autoAcceptResults.status, "owned"),
  ];
  if (typeof input.bookingId === "number" && Number.isInteger(input.bookingId)) {
    predicates.push(eq(autoAcceptResults.bookingId, input.bookingId));
  }
  return await db
    .select()
    .from(autoAcceptResults)
    .where(and(...predicates));
}
