import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { realtimeExecutionMetrics as table } from "../db/schema.js";
import {
  normalizeExecutionMetricsSnapshot,
  mergeExecutionMetricsRecords,
  type ExecutionMetricsRecord,
} from "../services/execution-metrics.js";
import {
  assertSupportedRealtimeEnvelope,
  type RealtimeEnvelopeV1,
} from "../services/realtime-contract.js";
import {
  listRealtimeMetricsReadModels,
  projectRealtimeMetricsEnvelope,
} from "./realtime-metrics-read-model-repository.js";

const RETENTION_MS = 600_000;
const MAX_CLEANUP_ROWS = 100;
function timestamp(value: Date | string): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(" ", "T")}Z` : value);
}
function dbTime(ms: number) {
  return sql`${new Date(ms).toISOString().slice(0, 23).replace("T", " ")}`;
}
function duplicate(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const e = error as { code?: string; message?: string; cause?: unknown };
    if (e.code === "ER_DUP_ENTRY" || /UNIQUE constraint failed/.test(e.message ?? "")) return true;
    error = e.cause;
  }
  return false;
}
export async function listExecutionMetricsRecords(): Promise<ExecutionMetricsRecord[]> {
  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db.select().from(table).orderBy(asc(table.teamId), asc(table.sourceNodeId));
  return rows.map((row: typeof table.$inferSelect) => {
    const snapshot = normalizeExecutionMetricsSnapshot(
      typeof row.snapshotJson === "string" ? JSON.parse(row.snapshotJson) : row.snapshotJson,
    );
    if (
      snapshot.teamId !== row.teamId ||
      snapshot.generation !== row.generation ||
      Date.parse(snapshot.startedAt) !== timestamp(row.startedAt)
    )
      throw new Error("Invalid stored execution metrics binding");
    return {
      teamId: row.teamId,
      nodeId: row.sourceNodeId,
      snapshot,
      emittedAt: timestamp(row.emittedAt),
      receivedAt: timestamp(row.receivedAt),
    };
  });
}
export async function listMergedRealtimeMetricsReadModels(now = Date.now()) {
  const [primary, execution] = await Promise.all([
    listRealtimeMetricsReadModels(),
    listExecutionMetricsRecords(),
  ]);
  return mergeExecutionMetricsRecords(primary, execution, now);
}
/** Bounded opportunistic cleanup on ingestion; conditional deletes cannot remove a refreshed row. */
async function cleanupExpired(now: number): Promise<void> {
  const db = await getDb();
  const cutoff = dbTime(now - RETENTION_MS);
  const rows = await db
    .select({ teamId: table.teamId, sourceNodeId: table.sourceNodeId })
    .from(table)
    .where(lt(table.receivedAt, cutoff))
    .orderBy(asc(table.receivedAt))
    .limit(MAX_CLEANUP_ROWS);
  for (const row of rows) {
    await db
      .delete(table)
      .where(
        and(
          eq(table.teamId, row.teamId),
          eq(table.sourceNodeId, row.sourceNodeId),
          lt(table.receivedAt, cutoff),
        ),
      );
  }
}
export function validateExecutionMetricsEnvelope(envelope: RealtimeEnvelopeV1) {
  if (
    envelope.scope.kind !== "team" ||
    envelope.replayable ||
    envelope.idempotencyKey !== undefined ||
    envelope.source.service !== "auto-accept-service" ||
    envelope.source.role !== "auto-accept-service" ||
    !/^[a-zA-Z0-9._:-]{1,120}$/.test(envelope.source.nodeId)
  )
    throw new Error("Invalid execution metrics scope or source");
  const snapshot = normalizeExecutionMetricsSnapshot(envelope.payload);
  const emittedAt = Date.parse(envelope.emittedAt);
  const receivedAt = Date.parse(envelope.receivedAt);
  const startedAt = Date.parse(snapshot.startedAt);
  if (
    snapshot.teamId !== envelope.scope.teamId ||
    startedAt > emittedAt ||
    emittedAt > receivedAt + 5000
  )
    throw new Error("Invalid execution metrics team or producer timestamp");
  return { snapshot, emittedAt, receivedAt, startedAt };
}
export async function projectRealtimeObservationsEnvelope(
  envelope: RealtimeEnvelopeV1,
): Promise<unknown> {
  assertSupportedRealtimeEnvelope(envelope);
  if (envelope.type !== "metrics.execution.snapshot")
    return projectRealtimeMetricsEnvelope(envelope);
  const { snapshot, emittedAt, receivedAt, startedAt } = validateExecutionMetricsEnvelope(envelope);
  await ensureDashboardTables();
  const db = await getDb();
  const key = and(
    eq(table.teamId, snapshot.teamId),
    eq(table.sourceNodeId, envelope.source.nodeId),
  );
  const newer = or(
    lt(table.startedAt, dbTime(startedAt)),
    and(
      eq(table.startedAt, dbTime(startedAt)),
      eq(table.generation, snapshot.generation),
      lt(table.emittedAt, dbTime(emittedAt)),
    ),
  );
  const values = {
    teamId: snapshot.teamId,
    sourceNodeId: envelope.source.nodeId,
    generation: snapshot.generation,
    startedAt: dbTime(startedAt),
    snapshotJson: snapshot,
    emittedAt: dbTime(emittedAt),
    receivedAt: dbTime(receivedAt),
  };
  // Conditional updates handle competing ingestions without a read/modify/write race.
  await db.update(table).set(values).where(and(key, newer));
  try {
    await db.insert(table).values(values);
  } catch (error) {
    if (!duplicate(error)) throw error;
    await db.update(table).set(values).where(and(key, newer));
  }
  await cleanupExpired(receivedAt);
  return { projected: true };
}
