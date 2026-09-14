import { and, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, getPool, ensureDashboardTables } from "../db/client.js";
import { getRawMemoryDb } from "../db/client-memory.js";
import { env } from "../config/env.js";
import { notificationDeliveries, notificationEvents, notificationOutbox } from "../db/schema.js";
import type { NormalizedNotificationEvent } from "../services/notification-events.js";

export interface CreateOutboxInput {
  targetType: string;
  targetId: string;
  title: string;
  message: string;
}

export interface CreateNotificationResult {
  duplicate: boolean;
  eventId: number | null;
  outboxId: number;
  outboxStatus: string;
}

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type NotificationQueueSummary = Record<string, number>;

const TERMINAL_FAILURE_STATUS = "failed_terminal";

function insertResultId(result: unknown): number | null {
  if (Array.isArray(result)) return insertResultId(result[0]);
  const insertId = (result as { insertId?: unknown })?.insertId;
  if (typeof insertId === "number") return insertId;
  if (typeof insertId === "bigint") return Number(insertId);
  const lastInsertRowid = (result as { lastInsertRowid?: unknown })?.lastInsertRowid;
  if (typeof lastInsertRowid === "number") return lastInsertRowid;
  if (typeof lastInsertRowid === "bigint") return Number(lastInsertRowid);
  return null;
}

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function dbTimestamp(value: Date) {
  return sql`${formatDbTimestamp(value)}`;
}

function truncate(value: string, length: number): string {
  return value.substring(0, length);
}

function isDuplicateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (candidate.code === "ER_DUP_ENTRY" || candidate.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (candidate.errno === 1062 || candidate.errno === 2067) return true;
    if (message.includes("Duplicate entry") || message.includes("UNIQUE constraint failed")) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

async function findOutboxByEventKey(eventKey: string): Promise<NotificationOutboxRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.eventKey, eventKey))
    .limit(1);
  return row ?? null;
}

export async function getNotificationOutboxDeliveryState(outboxId: number): Promise<"missing" | "pending" | "sent"> {
  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select({ status: notificationOutbox.status })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.id, outboxId))
    .limit(1);
  if (!row) return "missing";
  return row.status === "sent" ? "sent" : "pending";
}

async function findLockedSendingOutbox(
  db: ReturnType<typeof getDb>,
  outboxId: number,
  nodeId: string,
): Promise<NotificationOutboxRow | null> {
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(and(
      eq(notificationOutbox.id, outboxId),
      eq(notificationOutbox.lockedBy, nodeId),
      eq(notificationOutbox.status, "sending"),
    ))
    .limit(1);
  return row ?? null;
}

function lockedSendingWhere(outboxId: number, nodeId: string) {
  return and(
    eq(notificationOutbox.id, outboxId),
    eq(notificationOutbox.lockedBy, nodeId),
    eq(notificationOutbox.status, "sending"),
  );
}

function deliveredAfterProviderSendWhere(outboxId: number, nodeId: string) {
  return and(
    eq(notificationOutbox.id, outboxId),
    isNull(notificationOutbox.providerRequestId),
    isNull(notificationOutbox.providerStartedAt),
    or(
      lockedSendingWhere(outboxId, nodeId),
      and(
        eq(notificationOutbox.status, "failed"),
        isNull(notificationOutbox.lockedBy),
      ),
    ),
  );
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

function countValueToNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Unexpected notification queue count value: ${String(value)}`);
}

function claimableWhere(now: Date) {
  const nowValue = dbTimestamp(now);
  return and(
    inArray(notificationOutbox.status, ["queued", "failed", "sending"]),
    isNull(notificationOutbox.providerRequestId),
    isNull(notificationOutbox.providerStartedAt),
    lte(notificationOutbox.availableAt, nowValue),
    or(
      isNull(notificationOutbox.lockedBy),
      isNull(notificationOutbox.lockedUntil),
      lte(notificationOutbox.lockedUntil, nowValue),
    ),
  );
}

export async function createNotificationEventAndOutbox(
  event: NormalizedNotificationEvent,
  outbox: CreateOutboxInput,
): Promise<CreateNotificationResult> {
  await ensureDashboardTables();
  const db = await getDb();
  const now = new Date();

  const insertOutbox = async (eventId: number | null, duplicate: boolean): Promise<CreateNotificationResult> => {
    const outboxResult = await db.insert(notificationOutbox).values({
      eventKey: event.eventKey,
      teamId: event.teamId,
      targetType: outbox.targetType,
      targetId: outbox.targetId,
      eventType: event.eventType,
      severity: event.severity,
      title: outbox.title,
      message: outbox.message,
      payloadJson: JSON.stringify(event.payload),
      status: "queued",
      availableAt: dbTimestamp(now),
      updatedAt: dbTimestamp(now),
    });

    const insertedOutboxId = insertResultId(outboxResult);
    if (insertedOutboxId !== null) {
      return {
        duplicate,
        eventId,
        outboxId: insertedOutboxId,
        outboxStatus: "queued",
      };
    }

    const row = await findOutboxByEventKey(event.eventKey);
    if (!row) throw new Error(`notification outbox insert did not return an id for event ${event.eventKey}`);
    return {
      duplicate,
      eventId,
      outboxId: row.id,
      outboxStatus: row.status,
    };
  };

  try {
    const eventResult = await db.insert(notificationEvents).values({
      eventKey: event.eventKey,
      schemaVersion: event.schemaVersion,
      eventType: event.eventType,
      severity: event.severity,
      teamId: event.teamId,
      workerNodeId: event.workerNodeId,
      traceId: event.traceId,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      payloadJson: JSON.stringify(event.payload),
      receivedAt: dbTimestamp(now),
    });

    return await insertOutbox(insertResultId(eventResult), false);
  } catch (error) {
    if (isDuplicateError(error)) {
      const row = await findOutboxByEventKey(event.eventKey);
      if (row) {
        return {
          duplicate: true,
          eventId: null,
          outboxId: row.id,
          outboxStatus: row.status,
        };
      }
      return await insertOutbox(null, true);
    }
    throw error;
  }
}

export async function claimNotificationOutboxBatch(
  nodeId: string,
  batchSize: number,
  lockMs: number,
  now = new Date(),
): Promise<NotificationOutboxRow[]> {
  if (batchSize <= 0) return [];

  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db
    .select()
    .from(notificationOutbox)
    .where(claimableWhere(now))
    .orderBy(notificationOutbox.id)
    .limit(batchSize);

  const ids = rows.map((row: NotificationOutboxRow) => row.id);
  if (ids.length === 0) return [];

  const lockedUntil = new Date(now.getTime() + lockMs);
  await db
    .update(notificationOutbox)
    .set({
      status: "sending",
      lockedBy: nodeId,
      lockedUntil: dbTimestamp(lockedUntil),
      updatedAt: dbTimestamp(now),
    })
    .where(and(
      inArray(notificationOutbox.id, ids),
      claimableWhere(now),
    ));

  return await db
    .select()
    .from(notificationOutbox)
    .where(and(
      inArray(notificationOutbox.id, ids),
      eq(notificationOutbox.lockedBy, nodeId),
      eq(notificationOutbox.status, "sending"),
    ))
    .orderBy(notificationOutbox.id);
}

export async function markNotificationDelivered(
  outboxId: number,
  nodeId: string,
  provider: string,
  providerMessageId?: string,
  now = new Date(),
): Promise<boolean> {
  await ensureDashboardTables();
  const db = await getDb();
  const row = await findLockedSendingOutbox(db, outboxId, nodeId);
  if (!row) return false;

  const updateResult = await db
    .update(notificationOutbox)
    .set({
      status: "sent",
      sentAt: dbTimestamp(now),
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      updatedAt: dbTimestamp(now),
    })
    .where(lockedSendingWhere(outboxId, nodeId));
  if (affectedRows(updateResult) === 0) return false;

  await db.insert(notificationDeliveries).values({
    outboxId,
    deliveryAttempt: row.attempts + 1,
    provider,
    status: "success",
    providerMessageId: providerMessageId ?? null,
    startedAt: dbTimestamp(now),
    finishedAt: dbTimestamp(now),
  });

  return true;
}

export async function markNotificationDeliveredAfterProviderSend(
  outboxId: number,
  nodeId: string,
  provider: string,
  providerMessageId?: string,
  now = new Date(),
): Promise<boolean> {
  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(deliveredAfterProviderSendWhere(outboxId, nodeId))
    .limit(1);
  if (!row) return false;

  const updateResult = await db
    .update(notificationOutbox)
    .set({
      status: "sent",
      sentAt: dbTimestamp(now),
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      updatedAt: dbTimestamp(now),
    })
    .where(deliveredAfterProviderSendWhere(outboxId, nodeId));
  if (affectedRows(updateResult) === 0) return false;

  await db.insert(notificationDeliveries).values({
    outboxId,
    deliveryAttempt: row.status === "failed" ? Math.max(1, row.attempts) : row.attempts + 1,
    provider,
    status: "success",
    providerMessageId: providerMessageId ?? null,
    startedAt: dbTimestamp(now),
    finishedAt: dbTimestamp(now),
  });

  return true;
}

export async function markNotificationFailed(
  outboxId: number,
  nodeId: string,
  errorMessage: string,
  retryDelayMs: number,
  now = new Date(),
): Promise<boolean> {
  await ensureDashboardTables();
  const db = await getDb();
  const row = await findLockedSendingOutbox(db, outboxId, nodeId);
  if (!row) return false;

  const truncatedError = truncate(errorMessage, 1000);
  const updateResult = await db
    .update(notificationOutbox)
    .set({
      status: "failed",
      attempts: sql`${notificationOutbox.attempts} + 1`,
      availableAt: dbTimestamp(new Date(now.getTime() + retryDelayMs)),
      lockedBy: null,
      lockedUntil: null,
      lastError: truncatedError,
      updatedAt: dbTimestamp(now),
    })
    .where(lockedSendingWhere(outboxId, nodeId));
  if (affectedRows(updateResult) === 0) return false;

  await db.insert(notificationDeliveries).values({
    outboxId,
    deliveryAttempt: row.attempts + 1,
    provider: "linejs",
    status: "failed",
    errorMessage: truncatedError,
    startedAt: dbTimestamp(now),
    finishedAt: dbTimestamp(now),
  });

  return true;
}

export async function markNotificationFailedPermanently(
  outboxId: number,
  nodeId: string,
  errorMessage: string,
  now = new Date(),
): Promise<boolean> {
  await ensureDashboardTables();
  const db = await getDb();
  const row = await findLockedSendingOutbox(db, outboxId, nodeId);
  if (!row) return false;

  const truncatedError = truncate(errorMessage, 1000);
  const updateResult = await db
    .update(notificationOutbox)
    .set({
      status: TERMINAL_FAILURE_STATUS,
      attempts: sql`${notificationOutbox.attempts} + 1`,
      availableAt: dbTimestamp(now),
      lockedBy: null,
      lockedUntil: null,
      lastError: truncatedError,
      updatedAt: dbTimestamp(now),
    })
    .where(lockedSendingWhere(outboxId, nodeId));
  if (affectedRows(updateResult) === 0) return false;

  await db.insert(notificationDeliveries).values({
    outboxId,
    deliveryAttempt: row.attempts + 1,
    provider: "linejs",
    status: "failed",
    errorMessage: truncatedError,
    startedAt: dbTimestamp(now),
    finishedAt: dbTimestamp(now),
  });

  return true;
}

export async function getNotificationQueueSummary(): Promise<NotificationQueueSummary> {
  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db
    .select({
      status: notificationOutbox.status,
      count: count(notificationOutbox.id),
    })
    .from(notificationOutbox)
    .groupBy(notificationOutbox.status);

  const summary: NotificationQueueSummary = {};
  for (const row of rows) {
    summary[row.status] = countValueToNumber(row.count);
  }
  return summary;
}

export interface ProviderDeliveryReadModelRowsInput {
  from: Date;
  to: Date;
  teamId?: number | null;
  limit?: number;
}

export type NotificationProviderReconciliationCandidate = {
  outboxId: number;
  teamId: number;
  status: string;
  providerRequestId: string | null;
  lockedBy: string | null;
  attempts: number;
  providerStartedAt: string | null;
  updatedAt: string;
};

export type NotificationProviderReconciliationAction =
  | "mark_sent"
  | "requeue_not_sent";

export interface NotificationProviderReconciliationInput {
  outboxId: number;
  action: NotificationProviderReconciliationAction;
  expectedStatus: string;
  providerRequestId: string;
  expectedProviderStartedAt: string;
  evidenceReference: string;
  reason: string;
  providerMessageId?: string;
  actor: {
    userId: number;
    username: string;
    teamId: number | null;
  };
  now?: Date;
}

export type NotificationProviderReconciliationResult =
  | { state: "reconciled"; status: "sent" | "queued" }
  | { state: "missing" }
  | { state: "conflict" };

export interface ProviderDeliveryReadModelRow {
  outboxId: number;
  provider: string;
  status: string;
  deliveryAttempt: number;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface LineImageExtractionSummary {
  completedExtractions: number;
  lastCompletedAt: string | null;
}

function mysqlTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

type ProviderRow = Record<string, unknown>;
type ProviderQuery = { sql: string; values: unknown[]; read: boolean };
type ProviderProgram<T> = Generator<ProviderQuery, T, ProviderRow[]>;
const providerRead = (query: string, ...values: unknown[]): ProviderQuery => ({ sql: query, values, read: true });
const providerWrite = (query: string, ...values: unknown[]): ProviderQuery => ({ sql: query, values, read: false });
const providerRowLock = () => env.DB_MODE === "memory" ? "" : " FOR UPDATE";

// The same SQL program runs synchronously in SQLite and on one MySQL connection.
// This keeps the outbox transition and durable evidence in one transaction.
async function providerTransaction<T>(program: () => ProviderProgram<T>): Promise<T> {
  await ensureDashboardTables();
  if (env.DB_MODE === "memory") {
    const db = getRawMemoryDb();
    return db.transaction(() => {
      const iterator = program();
      let step = iterator.next();
      while (!step.done) {
        const query = step.value;
        const statement = db.prepare(query.sql);
        const rows = query.read ? statement.all(...query.values) as ProviderRow[] : (statement.run(...query.values), []);
        step = iterator.next(rows);
      }
      return step.value;
    })();
  }
  const connection = await getPool()!.getConnection();
  try {
    await connection.beginTransaction();
    const iterator = program();
    let step = iterator.next();
    while (!step.done) {
      const query = step.value;
      const [rows] = await connection.query(query.sql, query.values);
      step = iterator.next(query.read ? rows as ProviderRow[] : []);
    }
    await connection.commit();
    return step.value;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function providerTimestamp(value: unknown): string | null {
  return value instanceof Date ? formatDbTimestamp(value) : value == null ? null : String(value);
}

export async function listNotificationProviderReconciliationCandidates(): Promise<NotificationProviderReconciliationCandidate[]> {
  await ensureDashboardTables();
  const rows = await getDb().select({
    outboxId: notificationOutbox.id,
    teamId: notificationOutbox.teamId,
    status: notificationOutbox.status,
    providerRequestId: notificationOutbox.providerRequestId,
    lockedBy: notificationOutbox.lockedBy,
    attempts: notificationOutbox.attempts,
    providerStartedAt: notificationOutbox.providerStartedAt,
    updatedAt: notificationOutbox.updatedAt,
  }).from(notificationOutbox)
    .where(inArray(notificationOutbox.status, ["provider_sending", "delivery_ambiguous"]))
    .orderBy(notificationOutbox.id).limit(200);
  return rows.map((row: NotificationProviderReconciliationCandidate) => ({
    ...row, providerStartedAt: providerTimestamp(row.providerStartedAt), updatedAt: providerTimestamp(row.updatedAt)!,
  }));
}

export async function reconcileNotificationProviderDelivery(input: NotificationProviderReconciliationInput): Promise<NotificationProviderReconciliationResult> {
  if (!Number.isSafeInteger(input.outboxId) || input.outboxId <= 0) return { state: "missing" };
  if (!["provider_sending", "delivery_ambiguous"].includes(input.expectedStatus)
    || !["mark_sent", "requeue_not_sent"].includes(input.action)
    || !input.providerRequestId || !input.expectedProviderStartedAt) return { state: "conflict" };
  return providerTransaction(function* (): ProviderProgram<NotificationProviderReconciliationResult> {
    const [row] = yield providerRead(`SELECT * FROM notification_outbox WHERE id = ?${providerRowLock()}`, input.outboxId);
    if (!row) return { state: "missing" };
    const status = input.action === "mark_sent" ? "sent" : "queued";
    const [audit] = yield providerRead(`SELECT * FROM notification_provider_reconciliations
      WHERE outbox_id = ? AND provider_request_id = ? AND provider_started_at = ?`, input.outboxId, input.providerRequestId, input.expectedProviderStartedAt);
    if (audit) {
      const identical = audit.provider_request_id === input.providerRequestId
        && audit.action === input.action && audit.expected_status === input.expectedStatus
        && Number(audit.actor_user_id) === input.actor.userId && audit.actor_username === input.actor.username
        && audit.actor_team_id === input.actor.teamId && audit.evidence_reference === input.evidenceReference
        && audit.reason === input.reason && audit.provider_message_id === (input.providerMessageId ?? null);
      const sameResult = row.status === status && (status === "queued"
        ? row.provider_request_id === null && row.provider_started_at === null
        : row.provider_request_id === input.providerRequestId && providerTimestamp(row.provider_started_at) === input.expectedProviderStartedAt);
      return identical && sameResult ? { state: "reconciled", status } : { state: "conflict" };
    }
    if (row.status !== input.expectedStatus || row.provider_request_id !== input.providerRequestId
      || providerTimestamp(row.provider_started_at) !== input.expectedProviderStartedAt) return { state: "conflict" };
    const now = formatDbTimestamp(input.now ?? new Date());
    // The locked row plus this exact predicate is the compare-and-swap fence.
    yield providerWrite(`UPDATE notification_outbox SET status = ?, sent_at = ?, available_at = ?,
      locked_by = NULL, locked_until = NULL, last_error = NULL, updated_at = ?,
      provider_request_id = ?, provider_started_at = ?, provider_execution_started_at = ?
      WHERE id = ? AND status = ? AND provider_request_id = ? AND provider_started_at = ?`,
    status, status === "sent" ? now : null, now, now,
    status === "sent" ? input.providerRequestId : null, status === "sent" ? input.expectedProviderStartedAt : null,
    status === "sent" ? providerTimestamp(row.provider_execution_started_at) : null,
    input.outboxId, input.expectedStatus, input.providerRequestId, input.expectedProviderStartedAt);
    yield providerWrite(`INSERT INTO notification_provider_reconciliations
      (outbox_id,provider_request_id,provider_started_at,expected_status,action,result_status,
       actor_user_id,actor_username,actor_team_id,target_team_id,evidence_reference,reason,provider_message_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.outboxId, input.providerRequestId, input.expectedProviderStartedAt, input.expectedStatus, input.action, status,
    input.actor.userId, input.actor.username, input.actor.teamId, row.team_id, input.evidenceReference, input.reason, input.providerMessageId ?? null, now);
    yield providerWrite(`INSERT INTO notification_deliveries
      (outbox_id,delivery_attempt,provider,status,provider_message_id,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?)`, input.outboxId, Math.max(1, Number(row.attempts)), "linejs",
    status === "sent" ? "reconciled_success" : "reconciled_not_sent", input.providerMessageId ?? null, input.expectedProviderStartedAt, now);
    return { state: "reconciled", status };
  });
}

export async function beginNotificationProviderSend(outboxId: number, nodeId: string, requestId: string, now = new Date()): Promise<boolean> {
  await ensureDashboardTables();
  const result = await getDb().update(notificationOutbox).set({
    status: "provider_sending", providerRequestId: requestId, providerStartedAt: dbTimestamp(now), updatedAt: dbTimestamp(now),
  }).where(and(lockedSendingWhere(outboxId, nodeId),
    isNull(notificationOutbox.providerRequestId), isNull(notificationOutbox.providerStartedAt)));
  return affectedRows(result) === 1;
}

export interface CompleteNotificationProviderSendInput {
  outboxId: number;
  nodeId: string;
  providerRequestId: string;
  providerStartedAt: string;
  outcome: "sent" | "not_sent" | "ambiguous";
  retryable?: boolean;
  retryDelayMs?: number;
  providerMessageId?: string;
  error?: string;
  now?: Date;
}

export async function beginNotificationProviderExecution(input: {
  outboxId: number; nodeId: string; providerRequestId: string; providerStartedAt: string;
  targetId: string; text: string; eventKey?: string;
}): Promise<"started" | "sent" | "conflict"> {
  return providerTransaction(function* (): ProviderProgram<"started" | "sent" | "conflict"> {
    const [row] = yield providerRead(`SELECT * FROM notification_outbox WHERE id = ?${providerRowLock()}`, input.outboxId);
    if (!row || row.provider_request_id !== input.providerRequestId || providerTimestamp(row.provider_started_at) !== input.providerStartedAt
      || row.target_id !== input.targetId || `${row.title}\n${row.message}` !== input.text || row.event_key !== input.eventKey) return "conflict";
    if (row.status === "sent") return "sent";
    if (row.status !== "provider_sending" || row.locked_by !== input.nodeId || row.provider_execution_started_at !== null) return "conflict";
    yield providerWrite(`UPDATE notification_outbox SET provider_execution_started_at = ?
      WHERE id = ? AND status = 'provider_sending' AND provider_request_id = ? AND provider_started_at = ? AND provider_execution_started_at IS NULL`,
    formatDbTimestamp(new Date()), input.outboxId, input.providerRequestId, input.providerStartedAt);
    return "started";
  });
}

export async function completeNotificationProviderSend(input: CompleteNotificationProviderSendInput): Promise<boolean> {
  return providerTransaction(function* (): ProviderProgram<boolean> {
    const [row] = yield providerRead(`SELECT * FROM notification_outbox WHERE id = ?${providerRowLock()}`, input.outboxId);
    if (!row || row.provider_request_id !== input.providerRequestId
      || providerTimestamp(row.provider_started_at) !== input.providerStartedAt) return false;
    if (row.status === "sent") return input.outcome === "sent";
    if (input.outcome === "not_sent" && row.provider_execution_started_at !== null) return false;
    const lateSuccess = row.status === "delivery_ambiguous" && input.outcome === "sent" && row.provider_execution_started_at !== null;
    if ((row.status !== "provider_sending" && !lateSuccess) || row.locked_by !== input.nodeId) return false;
    const now = input.now ?? new Date();
    const stamp = formatDbTimestamp(now);
    const status = input.outcome === "sent" ? "sent" : input.outcome === "ambiguous" ? "delivery_ambiguous"
      : input.retryable === false ? TERMINAL_FAILURE_STATUS : "failed";
    const clearFence = input.outcome === "not_sent";
    yield providerWrite(`UPDATE notification_outbox SET status = ?, attempts = attempts + ?,
      available_at = ?, sent_at = ?, locked_by = ?, locked_until = NULL,
      provider_request_id = ?, provider_started_at = ?, provider_execution_started_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND status = ? AND provider_request_id = ? AND provider_started_at = ?`,
    status, lateSuccess ? 0 : 1, formatDbTimestamp(new Date(now.getTime() + (input.retryDelayMs ?? 0))), input.outcome === "sent" ? stamp : null,
    input.outcome === "ambiguous" ? input.nodeId : null,
    clearFence ? null : input.providerRequestId, clearFence ? null : input.providerStartedAt,
    clearFence ? null : providerTimestamp(row.provider_execution_started_at),
    input.outcome === "sent" ? null : truncate(input.error ?? "Provider delivery outcome is unknown", 1000), stamp,
    input.outboxId, row.status, input.providerRequestId, input.providerStartedAt);
    yield providerWrite(`INSERT INTO notification_deliveries
      (outbox_id,delivery_attempt,provider,status,provider_message_id,error_message,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?)`, input.outboxId, Number(row.attempts) + (lateSuccess ? 0 : 1), "linejs",
    input.outcome === "sent" ? "success" : input.outcome === "ambiguous" ? "ambiguous" : "failed", input.providerMessageId ?? null,
    input.outcome === "sent" ? null : truncate(input.error ?? "Provider delivery outcome is unknown", 1000), input.providerStartedAt, stamp);
    return true;
  });
}

export async function listProviderDeliveryReadModelRows(
  input: ProviderDeliveryReadModelRowsInput,
): Promise<ProviderDeliveryReadModelRow[]> {
  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db
    .select({
      outboxId: notificationDeliveries.outboxId,
      provider: notificationDeliveries.provider,
      status: notificationDeliveries.status,
      deliveryAttempt: notificationDeliveries.deliveryAttempt,
      startedAt: notificationDeliveries.startedAt,
      finishedAt: notificationDeliveries.finishedAt,
      errorMessage: notificationDeliveries.errorMessage,
    })
    .from(notificationDeliveries)
    .innerJoin(notificationOutbox, eq(notificationOutbox.id, notificationDeliveries.outboxId))
    .where(and(
      input.teamId == null ? undefined : eq(notificationOutbox.teamId, input.teamId),
      sql`${notificationDeliveries.startedAt} >= ${mysqlTimestamp(input.from)}`,
      sql`${notificationDeliveries.startedAt} <= ${mysqlTimestamp(input.to)}`,
    ))
    .orderBy(sql`${notificationDeliveries.startedAt} DESC`)
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  return rows.map((row: {
    outboxId: number;
    provider: string;
    status: string;
    deliveryAttempt: number;
    startedAt: Date | string;
    finishedAt: Date | string | null;
    errorMessage: string | null;
  }) => ({
    outboxId: row.outboxId,
    provider: row.provider,
    status: row.status,
    deliveryAttempt: row.deliveryAttempt,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : String(row.startedAt),
    finishedAt: row.finishedAt instanceof Date
      ? row.finishedAt.toISOString()
      : row.finishedAt
        ? String(row.finishedAt)
        : null,
  }));
}
