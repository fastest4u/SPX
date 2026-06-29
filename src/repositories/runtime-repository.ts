import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { runtimeNodes, teamRuntimeLeases } from "../db/schema.js";

export interface UpsertRuntimeNodeInput {
  nodeId: string;
  role: string;
  hostname?: string;
  pid?: number;
  version?: string;
  metadata?: unknown;
}

export interface TryAcquireLeaseInput {
  teamId: number;
  nodeId: string;
  role: string;
  ttlMs: number;
  now?: Date;
}

export interface RenewLeaseInput {
  teamId: number;
  nodeId: string;
  leaseToken: string;
  ttlMs: number;
  now?: Date;
}

export interface ReleaseLeaseInput {
  teamId: number;
  nodeId: string;
  leaseToken: string;
}

export interface LeaseAcquireResult {
  acquired: boolean;
  leaseToken?: string;
}

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function dbTimestamp(value: Date) {
  return sql`${formatDbTimestamp(value)}`;
}

function isDuplicateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (candidate.code === "ER_DUP_ENTRY" || candidate.code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
    if (candidate.errno === 1062 || candidate.errno === 1555 || candidate.errno === 2067) return true;
    if (message.includes("Duplicate entry") || message.includes("UNIQUE constraint failed")) return true;
    current = candidate.cause;
  }

  return false;
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

function leaseExpiry(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs);
}

async function findLeaseByToken(teamId: number, leaseToken: string): Promise<LeaseAcquireResult> {
  const db = await getDb();
  const [row] = await db
    .select({ leaseToken: teamRuntimeLeases.leaseToken })
    .from(teamRuntimeLeases)
    .where(and(
      eq(teamRuntimeLeases.teamId, teamId),
      eq(teamRuntimeLeases.leaseToken, leaseToken),
    ))
    .limit(1);

  if (!row) return { acquired: false };
  return { acquired: true, leaseToken: row.leaseToken };
}

export async function upsertRuntimeNode(input: UpsertRuntimeNodeInput): Promise<void> {
  requireNonEmpty("nodeId", input.nodeId);
  requireNonEmpty("role", input.role);

  await ensureDashboardTables();
  const db = await getDb();
  const now = new Date();
  const values = {
    nodeId: input.nodeId,
    role: input.role,
    hostname: input.hostname ?? null,
    pid: input.pid ?? null,
    version: input.version ?? null,
    lastHeartbeatAt: dbTimestamp(now),
    metadataJson: input.metadata === undefined ? null : JSON.stringify(input.metadata),
    updatedAt: dbTimestamp(now),
  };

  try {
    await db.insert(runtimeNodes).values(values);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    await db
      .update(runtimeNodes)
      .set(values)
      .where(eq(runtimeNodes.nodeId, input.nodeId));
  }
}

export async function tryAcquireLease(input: TryAcquireLeaseInput): Promise<LeaseAcquireResult> {
  requirePositiveInteger("teamId", input.teamId);
  requirePositiveInteger("ttlMs", input.ttlMs);
  requireNonEmpty("nodeId", input.nodeId);
  requireNonEmpty("role", input.role);

  await ensureDashboardTables();
  const db = await getDb();
  const now = input.now ?? new Date();
  const leaseToken = randomUUID();
  const expiresAt = leaseExpiry(now, input.ttlMs);

  const values = {
    teamId: input.teamId,
    ownerNodeId: input.nodeId,
    ownerRole: input.role,
    leaseToken,
    leaseExpiresAt: dbTimestamp(expiresAt),
    heartbeatAt: dbTimestamp(now),
    status: "running",
    lastError: null,
    startedAt: dbTimestamp(now),
    updatedAt: dbTimestamp(now),
  };

  try {
    await db.insert(teamRuntimeLeases).values(values);
    return { acquired: true, leaseToken };
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
  }

  const updateResult = await db
    .update(teamRuntimeLeases)
    .set(values)
    .where(and(
      eq(teamRuntimeLeases.teamId, input.teamId),
      or(
        eq(teamRuntimeLeases.ownerNodeId, input.nodeId),
        lte(teamRuntimeLeases.leaseExpiresAt, dbTimestamp(now)),
      ),
    ));

  if (affectedRows(updateResult) === 0) return { acquired: false };
  return await findLeaseByToken(input.teamId, leaseToken);
}

export async function renewLease(input: RenewLeaseInput): Promise<boolean> {
  requirePositiveInteger("teamId", input.teamId);
  requirePositiveInteger("ttlMs", input.ttlMs);
  requireNonEmpty("nodeId", input.nodeId);
  requireNonEmpty("leaseToken", input.leaseToken);

  await ensureDashboardTables();
  const db = await getDb();
  const now = input.now ?? new Date();
  const updateResult = await db
    .update(teamRuntimeLeases)
    .set({
      leaseExpiresAt: dbTimestamp(leaseExpiry(now, input.ttlMs)),
      heartbeatAt: dbTimestamp(now),
      updatedAt: dbTimestamp(now),
    })
    .where(and(
      eq(teamRuntimeLeases.teamId, input.teamId),
      eq(teamRuntimeLeases.ownerNodeId, input.nodeId),
      eq(teamRuntimeLeases.leaseToken, input.leaseToken),
      gt(teamRuntimeLeases.leaseExpiresAt, dbTimestamp(now)),
    ));

  return affectedRows(updateResult) !== 0;
}

export async function releaseLease(input: ReleaseLeaseInput): Promise<boolean> {
  requirePositiveInteger("teamId", input.teamId);
  requireNonEmpty("nodeId", input.nodeId);
  requireNonEmpty("leaseToken", input.leaseToken);

  await ensureDashboardTables();
  const db = await getDb();
  const deleteResult = await db
    .delete(teamRuntimeLeases)
    .where(and(
      eq(teamRuntimeLeases.teamId, input.teamId),
      eq(teamRuntimeLeases.ownerNodeId, input.nodeId),
      eq(teamRuntimeLeases.leaseToken, input.leaseToken),
    ));

  return affectedRows(deleteResult) !== 0;
}

export async function listRuntimeNodes(): Promise<Array<typeof runtimeNodes.$inferSelect>> {
  await ensureDashboardTables();
  const db = await getDb();
  return await db.select().from(runtimeNodes);
}

export async function listTeamRuntimeLeases(): Promise<Array<typeof teamRuntimeLeases.$inferSelect>> {
  await ensureDashboardTables();
  const db = await getDb();
  return await db.select().from(teamRuntimeLeases);
}
