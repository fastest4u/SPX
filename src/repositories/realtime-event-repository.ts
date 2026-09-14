import { and, asc, desc, eq, gt, lt, lte, sql } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { realtimeEvents } from "../db/schema.js";
import {
  assertSupportedRealtimeEnvelope,
  type RealtimeEnvelopeV1,
  type RealtimeScope,
} from "../services/realtime-contract.js";
import { logger } from "../utils/logger.js";

export type RealtimeEventRow = typeof realtimeEvents.$inferSelect;

export interface PersistRealtimeEnvelopeResult {
  duplicate: boolean;
  row: RealtimeEventRow;
}

export interface ListRealtimeEventsForReplayInput {
  scope: RealtimeScope;
  afterId?: number;
  throughId?: number;
  limit?: number;
}

export interface PruneReplayableRealtimeEventsInput {
  now?: Date;
  minimumRetainedEvents?: number;
}

export type RealtimeEventPersistedListener = (envelope: RealtimeEnvelopeV1<unknown>) => void;

const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 500;
export const REALTIME_REPLAY_RETENTION_MS = 10 * 60 * 1000;
export const REALTIME_REPLAY_RETENTION_EVENT_LIMIT = 2_000;
const persistedListeners = new Set<RealtimeEventPersistedListener>();

export function onRealtimeEventPersisted(listener: RealtimeEventPersistedListener): () => void {
  persistedListeners.add(listener);
  return () => {
    persistedListeners.delete(listener);
  };
}

function notifyRealtimeEventPersisted(envelope: RealtimeEnvelopeV1<unknown>): void {
  for (const listener of persistedListeners) {
    try {
      listener(envelope);
    } catch {
      // Persistence must not fail because a local replay buffer listener failed.
    }
  }
}

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function dbTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Realtime event timestamp must be valid");
  }
  return sql`${formatDbTimestamp(parsed)}`;
}

function isDuplicateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (candidate.code === "ER_DUP_ENTRY" || candidate.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (candidate.errno === 1062 || candidate.errno === 2067 || candidate.errno === 1555) return true;
    if (message.includes("Duplicate entry") || message.includes("UNIQUE constraint failed")) return true;
    current = candidate.cause;
  }

  return false;
}

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

function nonEmptyIdempotencyKey(envelope: RealtimeEnvelopeV1<unknown>): string | null {
  const value = envelope.idempotencyKey;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function getRealtimeEventById(id: number): Promise<RealtimeEventRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(realtimeEvents)
    .where(eq(realtimeEvents.id, id))
    .limit(1);
  return row ?? null;
}

async function getRealtimeEventByIdempotencyKey(idempotencyKey: string): Promise<RealtimeEventRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(realtimeEvents)
    .where(eq(realtimeEvents.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

async function findDuplicateRealtimeEvent(envelope: RealtimeEnvelopeV1<unknown>): Promise<RealtimeEventRow | null> {
  const eventRow = await getRealtimeEventByEventId(envelope.id);
  const idempotencyKey = nonEmptyIdempotencyKey(envelope);
  const idempotencyRow = idempotencyKey
    ? await getRealtimeEventByIdempotencyKey(idempotencyKey)
    : null;

  if (eventRow && idempotencyRow && eventRow.id !== idempotencyRow.id) {
    throw new Error("Realtime event identity conflict: event_id and idempotency_key belong to different rows");
  }

  return eventRow ?? idempotencyRow;
}

function normalizeReplayLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_REPLAY_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_REPLAY_LIMIT;
  return Math.min(MAX_REPLAY_LIMIT, Math.max(0, Math.floor(limit)));
}

function normalizeAfterId(afterId: number | undefined): number {
  if (afterId === undefined) return 0;
  if (!Number.isFinite(afterId)) return 0;
  return Math.max(0, Math.floor(afterId));
}

function normalizeRetentionNow(now: Date | undefined): Date {
  const value = now ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Realtime replay retention now must be a valid Date");
  }
  return value;
}

function normalizeMinimumRetainedEvents(value: number | undefined): number {
  const threshold = value ?? REALTIME_REPLAY_RETENTION_EVENT_LIMIT;
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error("Realtime replay retention minimumRetainedEvents must be a positive whole number");
  }
  return threshold;
}

export function realtimeEventEnvelopeFromRow(row: RealtimeEventRow): RealtimeEnvelopeV1<unknown> {
  const parsed = JSON.parse(row.envelopeJson) as unknown;
  assertSupportedRealtimeEnvelope(parsed);
  return parsed;
}

export async function persistRealtimeEnvelope(envelope: RealtimeEnvelopeV1<unknown>): Promise<PersistRealtimeEnvelopeResult> {
  assertSupportedRealtimeEnvelope(envelope);

  await ensureDashboardTables();
  const db = await getDb();
  const idempotencyKey = nonEmptyIdempotencyKey(envelope);
  const scopeKind = envelope.scope.kind;
  const teamId = envelope.scope.kind === "team" ? envelope.scope.teamId : null;
  const payloadJson = JSON.stringify(envelope.payload);
  const envelopeJson = JSON.stringify(envelope);

  try {
    const result = await db.insert(realtimeEvents).values({
      eventId: envelope.id,
      idempotencyKey,
      eventType: envelope.type,
      payloadVersion: envelope.payloadVersion,
      envelopeVersion: envelope.envelopeVersion,
      scopeKind,
      teamId,
      subjectType: envelope.subject?.type ?? null,
      subjectId: envelope.subject?.id ?? null,
      sourceService: envelope.source.service,
      sourceNodeId: envelope.source.nodeId,
      sourceRole: envelope.source.role,
      traceId: envelope.traceId ?? null,
      replayable: envelope.replayable ? 1 : 0,
      payloadJson,
      envelopeJson,
      emittedAt: dbTimestamp(envelope.emittedAt),
      receivedAt: dbTimestamp(envelope.receivedAt),
    });

    const insertedId = insertResultId(result);
    const row = insertedId === null
      ? await getRealtimeEventByEventId(envelope.id)
      : await getRealtimeEventById(insertedId);
    if (!row) throw new Error(`realtime event insert did not return a row for ${envelope.id}`);
    if (envelope.replayable) {
      try {
        await pruneReplayableRealtimeEvents();
      } catch (error) {
        logger.warn("realtime-event-retention-prune-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    notifyRealtimeEventPersisted(envelope);
    return { duplicate: false, row };
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    const row = await findDuplicateRealtimeEvent(envelope);
    if (!row) throw new Error(`duplicate realtime event could not be found for ${envelope.id}`);
    return { duplicate: true, row };
  }
}

export async function getRealtimeEventByEventId(eventId: string): Promise<RealtimeEventRow | null> {
  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select()
    .from(realtimeEvents)
    .where(eq(realtimeEvents.eventId, eventId))
    .limit(1);
  return row ?? null;
}

export async function pruneReplayableRealtimeEvents(
  input: PruneReplayableRealtimeEventsInput = {},
): Promise<void> {
  const now = normalizeRetentionNow(input.now);
  const minimumRetainedEvents = normalizeMinimumRetainedEvents(input.minimumRetainedEvents);
  const cutoff = new Date(now.getTime() - REALTIME_REPLAY_RETENTION_MS);

  await ensureDashboardTables();
  const db = await getDb();
  const [globalAnchor] = await db
    .select({ id: realtimeEvents.id })
    .from(realtimeEvents)
    .where(eq(realtimeEvents.replayable, 1))
    .orderBy(desc(realtimeEvents.id))
    .limit(1)
    .offset(minimumRetainedEvents - 1);
  if (!globalAnchor) return;

  const teamRows = await db
    .selectDistinct({ teamId: realtimeEvents.teamId })
    .from(realtimeEvents)
    .where(and(
      eq(realtimeEvents.replayable, 1),
      eq(realtimeEvents.scopeKind, "team"),
    ));

  const cutoffTimestamp = dbTimestamp(cutoff.toISOString());
  await db
    .delete(realtimeEvents)
    .where(and(
      eq(realtimeEvents.replayable, 1),
      eq(realtimeEvents.scopeKind, "admin"),
      lt(realtimeEvents.id, globalAnchor.id),
      lt(realtimeEvents.createdAt, cutoffTimestamp),
    ));

  for (const { teamId } of teamRows) {
    if (teamId === null) continue;
    const [teamAnchor] = await db
      .select({ id: realtimeEvents.id })
      .from(realtimeEvents)
      .where(and(
        eq(realtimeEvents.replayable, 1),
        eq(realtimeEvents.scopeKind, "team"),
        eq(realtimeEvents.teamId, teamId),
      ))
      .orderBy(desc(realtimeEvents.id))
      .limit(1)
      .offset(minimumRetainedEvents - 1);
    if (!teamAnchor) continue;

    await db
      .delete(realtimeEvents)
      .where(and(
        eq(realtimeEvents.replayable, 1),
        eq(realtimeEvents.scopeKind, "team"),
        eq(realtimeEvents.teamId, teamId),
        lt(realtimeEvents.id, globalAnchor.id),
        lt(realtimeEvents.id, teamAnchor.id),
        lt(realtimeEvents.createdAt, cutoffTimestamp),
      ));
  }
}

export async function listRealtimeEventsForReplay(input: ListRealtimeEventsForReplayInput): Promise<RealtimeEventRow[]> {
  await ensureDashboardTables();
  const limit = normalizeReplayLimit(input.limit);
  if (limit === 0) return [];

  const afterId = normalizeAfterId(input.afterId);
  const throughId = input.throughId === undefined ? undefined : normalizeAfterId(input.throughId);
  const scopeFilter = input.scope.kind === "admin"
    ? undefined
    : and(
      eq(realtimeEvents.scopeKind, "team"),
      eq(realtimeEvents.teamId, input.scope.teamId),
    );
  const filters = [
    eq(realtimeEvents.replayable, 1),
    gt(realtimeEvents.id, afterId),
  ];
  if (scopeFilter !== undefined) filters.push(scopeFilter);
  if (throughId !== undefined) {
    filters.push(lte(realtimeEvents.id, throughId));
  }

  const db = await getDb();
  return await db
    .select()
    .from(realtimeEvents)
    .where(and(...filters))
    .orderBy(asc(realtimeEvents.id))
    .limit(limit);
}

export async function getRealtimeReplayHighWater(scope: RealtimeScope): Promise<RealtimeEventRow | null> {
  await ensureDashboardTables();
  const scopeFilter = scope.kind === "admin"
    ? undefined
    : and(
      eq(realtimeEvents.scopeKind, "team"),
      eq(realtimeEvents.teamId, scope.teamId),
    );
  const filters = [eq(realtimeEvents.replayable, 1)];
  if (scopeFilter !== undefined) filters.push(scopeFilter);

  const db = await getDb();
  const [row] = await db
    .select()
    .from(realtimeEvents)
    .where(and(...filters))
    .orderBy(desc(realtimeEvents.id))
    .limit(1);
  return row ?? null;
}
