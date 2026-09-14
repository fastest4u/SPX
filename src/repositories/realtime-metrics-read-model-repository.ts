import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { realtimeMetricsReadModels } from "../db/schema.js";
import {
  assertSupportedRealtimeEnvelope,
  type RealtimeEnvelopeV1,
} from "../services/realtime-contract.js";
import {
  normalizeRuntimeMetricsSnapshot,
  type RuntimeMetricsRecord,
} from "../services/runtime-metrics.js";
import type { MetricsSnapshot } from "../services/metrics.js";

export type RealtimeMetricsReadModelRow = typeof realtimeMetricsReadModels.$inferSelect;
export type RealtimeMetricsUpsertOutcome =
  | "inserted"
  | "updated"
  | "stale"
  | "equal_received_at_retained"
  | "idempotent";

export interface UpsertRealtimeMetricsReadModelInput {
  teamId: number;
  sourceNodeId: string;
  snapshot: unknown;
  emittedAt: Date;
  receivedAt: Date;
  updatedAt?: Date;
}

export interface RealtimeMetricsProjectionApplied {
  projected: true;
  outcome: RealtimeMetricsUpsertOutcome;
  record: RuntimeMetricsRecord;
}

export interface RealtimeMetricsProjectionIgnored {
  projected: false;
  reason: "not-metrics-snapshot";
}

export type RealtimeMetricsProjectionResult =
  | RealtimeMetricsProjectionApplied
  | RealtimeMetricsProjectionIgnored;

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 23).replace("T", " ");
}

function dbTimestamp(value: Date) {
  return sql`${formatDbTimestamp(value)}`;
}

function validDate(value: Date, fieldName: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Realtime metrics ${fieldName} must be a valid Date`);
  }
  return value;
}

function timestampMs(value: unknown, fieldName: string): number {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value.getTime();
    throw new Error(`Realtime metrics ${fieldName} must be a valid timestamp`);
  }
  if (typeof value !== "string") {
    throw new Error(`Realtime metrics ${fieldName} must be a valid timestamp`);
  }
  const mysqlUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(mysqlUtc);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Realtime metrics ${fieldName} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeSourceNodeId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 120) {
    throw new Error("Realtime metrics sourceNodeId must contain 1-120 characters");
  }
  return normalized;
}

function parseSnapshot(value: unknown): MetricsSnapshot {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Invalid runtime metrics snapshot: stored JSON is malformed");
    }
  }
  return normalizeRuntimeMetricsSnapshot(parsed);
}

function rowToRecord(row: RealtimeMetricsReadModelRow): RuntimeMetricsRecord {
  const snapshot = parseSnapshot(row.snapshotJson);
  if (snapshot.teamId !== row.teamId) {
    throw new Error("Realtime metrics stored snapshot teamId does not match its row");
  }
  return {
    teamId: row.teamId,
    nodeId: normalizeSourceNodeId(row.sourceNodeId),
    snapshot,
    emittedAt: timestampMs(row.emittedAt, "emittedAt"),
    receivedAt: timestampMs(row.receivedAt, "receivedAt"),
    updatedAt: timestampMs(row.updatedAt, "updatedAt"),
  };
}

function affectedRows(result: unknown): number | null {
  if (Array.isArray(result)) return affectedRows(result[0]);
  if (!result || typeof result !== "object") return null;
  const candidate = result as Record<string, unknown>;
  for (const key of ["affectedRows", "changes", "rowsAffected"]) {
    const value = candidate[key];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
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
    if (candidate.code === "ER_DUP_ENTRY" || candidate.code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
    if (candidate.code === "SQLITE_CONSTRAINT_UNIQUE" || candidate.errno === 1062) return true;
    if (candidate.errno === 1555 || candidate.errno === 2067) return true;
    if (message.includes("Duplicate entry") || message.includes("UNIQUE constraint failed")) return true;
    current = candidate.cause;
  }
  return false;
}

async function updateIfNewer(input: {
  teamId: number;
  sourceNodeId: string;
  snapshot: MetricsSnapshot;
  emittedAt: Date;
  receivedAt: Date;
  updatedAt: Date;
}): Promise<number | null> {
  const db = await getDb();
  const result = await db
    .update(realtimeMetricsReadModels)
    .set({
      sourceNodeId: input.sourceNodeId,
      snapshotJson: input.snapshot,
      emittedAt: dbTimestamp(input.emittedAt),
      receivedAt: dbTimestamp(input.receivedAt),
      updatedAt: dbTimestamp(input.updatedAt),
    })
    .where(and(
      eq(realtimeMetricsReadModels.teamId, input.teamId),
      lt(realtimeMetricsReadModels.receivedAt, dbTimestamp(input.receivedAt)),
    ));
  return affectedRows(result);
}

function retainedOutcome(
  record: RuntimeMetricsRecord,
  input: {
    sourceNodeId: string;
    snapshot: MetricsSnapshot;
    emittedAt: Date;
    receivedAt: Date;
  },
): RealtimeMetricsUpsertOutcome {
  const receivedAt = input.receivedAt.getTime();
  if (record.receivedAt > receivedAt) return "stale";
  if (record.receivedAt < receivedAt) {
    throw new Error("Realtime metrics monotonic upsert did not retain the newest record");
  }
  const idempotent = record.nodeId === input.sourceNodeId
    && record.emittedAt === input.emittedAt.getTime()
    && isDeepStrictEqual(record.snapshot, input.snapshot);
  return idempotent ? "idempotent" : "equal_received_at_retained";
}

export async function getRealtimeMetricsReadModelByTeamId(teamId: number): Promise<RuntimeMetricsRecord | null> {
  if (!Number.isInteger(teamId) || teamId <= 0) {
    throw new Error("Realtime metrics teamId must be a positive integer");
  }
  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db
    .select()
    .from(realtimeMetricsReadModels)
    .where(eq(realtimeMetricsReadModels.teamId, teamId))
    .limit(1);
  return row ? rowToRecord(row) : null;
}

export async function listRealtimeMetricsReadModels(): Promise<RuntimeMetricsRecord[]> {
  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db
    .select()
    .from(realtimeMetricsReadModels)
    .orderBy(asc(realtimeMetricsReadModels.teamId));
  return rows.map(rowToRecord);
}

export async function upsertRealtimeMetricsReadModel(
  rawInput: UpsertRealtimeMetricsReadModelInput,
): Promise<{ outcome: RealtimeMetricsUpsertOutcome; record: RuntimeMetricsRecord }> {
  if (!Number.isInteger(rawInput.teamId) || rawInput.teamId <= 0) {
    throw new Error("Realtime metrics teamId must be a positive integer");
  }
  const sourceNodeId = normalizeSourceNodeId(rawInput.sourceNodeId);
  const snapshot = normalizeRuntimeMetricsSnapshot(rawInput.snapshot);
  if (snapshot.teamId !== rawInput.teamId) {
    throw new Error("Realtime metrics snapshot teamId must match envelope scope teamId");
  }
  const emittedAt = validDate(rawInput.emittedAt, "emittedAt");
  const receivedAt = validDate(rawInput.receivedAt, "receivedAt");
  const updatedAt = validDate(rawInput.updatedAt ?? new Date(), "updatedAt");
  const input = { teamId: rawInput.teamId, sourceNodeId, snapshot, emittedAt, receivedAt, updatedAt };

  await ensureDashboardTables();
  const firstUpdate = await updateIfNewer(input);
  if (firstUpdate !== null && firstUpdate > 0) {
    const record = await getRealtimeMetricsReadModelByTeamId(input.teamId);
    if (!record) throw new Error("Realtime metrics update did not return a row");
    return { outcome: "updated", record };
  }

  const db = await getDb();
  try {
    await db.insert(realtimeMetricsReadModels).values({
      teamId: input.teamId,
      sourceNodeId: input.sourceNodeId,
      snapshotJson: input.snapshot,
      emittedAt: dbTimestamp(input.emittedAt),
      receivedAt: dbTimestamp(input.receivedAt),
      updatedAt: dbTimestamp(input.updatedAt),
    });
    const record = await getRealtimeMetricsReadModelByTeamId(input.teamId);
    if (!record) throw new Error("Realtime metrics insert did not return a row");
    return { outcome: "inserted", record };
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
  }

  const racedUpdate = await updateIfNewer(input);
  const record = await getRealtimeMetricsReadModelByTeamId(input.teamId);
  if (!record) throw new Error("Realtime metrics conflict did not return a row");
  if (racedUpdate !== null && racedUpdate > 0) return { outcome: "updated", record };
  return { outcome: retainedOutcome(record, input), record };
}

export async function projectRealtimeMetricsEnvelope(
  envelope: RealtimeEnvelopeV1<unknown>,
): Promise<RealtimeMetricsProjectionResult> {
  assertSupportedRealtimeEnvelope(envelope);
  if (envelope.type !== "metrics.snapshot") {
    return { projected: false, reason: "not-metrics-snapshot" };
  }
  if (envelope.scope.kind !== "team") {
    throw new Error("Realtime metrics snapshot requires team scope");
  }
  if (typeof envelope.idempotencyKey === "string" && envelope.idempotencyKey.trim().length > 0) {
    throw new Error("Realtime metrics idempotencyKey events cannot update the latest projection");
  }

  const result = await upsertRealtimeMetricsReadModel({
    teamId: envelope.scope.teamId,
    sourceNodeId: envelope.source.nodeId,
    snapshot: envelope.payload,
    emittedAt: new Date(envelope.emittedAt),
    receivedAt: new Date(envelope.receivedAt),
  });
  return { projected: true, ...result };
}
