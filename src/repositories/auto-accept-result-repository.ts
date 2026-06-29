import { and, eq, ne, sql } from "drizzle-orm";
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
