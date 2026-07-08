import { and, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, ensureDashboardTables } from "../db/client.js";
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
