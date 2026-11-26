import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { ensureDashboardTables, getDb, getPool } from "../db/client.js";
import { teamSpxDrivers } from "../db/schema.js";

export interface TeamSpxDriverRecord {
  id: number;
  teamId: number;
  driverId: number;
  driverName: string;
  agencyName: string;
  vehicleType: number;
  vehicleTypeName: string;
  enabled: boolean;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncTeamSpxDriverInput {
  driverId: number;
  driverName: string;
  agencyName?: string;
  vehicleType: number;
  vehicleTypeName?: string;
}

export interface TeamSpxDriverVehicleSummary {
  vehicleType: number;
  vehicleTypeName: string;
  total: number;
  enabled: number;
}

export interface TeamSpxDriverSummary {
  total: number;
  enabled: number;
  lastSyncedAt: string | null;
  byVehicleType: TeamSpxDriverVehicleSummary[];
}

export interface SyncTeamSpxDriversResult {
  synced: number;
  inserted: number;
  updated: number;
  removed: number;
  summary: TeamSpxDriverSummary;
  drivers: TeamSpxDriverRecord[];
}

type DriverRow = typeof teamSpxDrivers.$inferSelect;

const BATCH_SIZE = 100;

function asDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : String(value ?? "");
}

function toDriverRecord(row: DriverRow): TeamSpxDriverRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    driverId: row.driverId,
    driverName: row.driverName,
    agencyName: row.agencyName ?? "",
    vehicleType: row.vehicleType,
    vehicleTypeName: row.vehicleTypeName ?? "",
    enabled: row.enabled === 1,
    syncedAt: asDateString(row.syncedAt),
    createdAt: asDateString(row.createdAt),
    updatedAt: asDateString(row.updatedAt),
  };
}

export function summarizeDriverRecords(records: TeamSpxDriverRecord[]): TeamSpxDriverSummary {
  const byType = new Map<number, TeamSpxDriverVehicleSummary>();
  let enabled = 0;
  let lastSyncedAt: string | null = null;

  for (const driver of records) {
    if (driver.enabled) enabled++;
    if (driver.syncedAt && (!lastSyncedAt || driver.syncedAt > lastSyncedAt)) {
      lastSyncedAt = driver.syncedAt;
    }
    const existing = byType.get(driver.vehicleType);
    if (existing) {
      existing.total++;
      if (driver.enabled) existing.enabled++;
      if (!existing.vehicleTypeName && driver.vehicleTypeName) {
        existing.vehicleTypeName = driver.vehicleTypeName;
      }
    } else {
      byType.set(driver.vehicleType, {
        vehicleType: driver.vehicleType,
        vehicleTypeName: driver.vehicleTypeName || `Type ${driver.vehicleType}`,
        total: 1,
        enabled: driver.enabled ? 1 : 0,
      });
    }
  }

  return {
    total: records.length,
    enabled,
    lastSyncedAt,
    byVehicleType: [...byType.values()].sort((a, b) => b.total - a.total || a.vehicleType - b.vehicleType),
  };
}

export async function listDriversByTeam(
  teamId: number,
  options: { onlyEnabled?: boolean; vehicleType?: number } = {},
): Promise<TeamSpxDriverRecord[]> {
  await ensureDashboardTables();
  const db = getDb();
  const conditions = [eq(teamSpxDrivers.teamId, teamId)];
  if (options.onlyEnabled) {
    conditions.push(eq(teamSpxDrivers.enabled, 1));
  }
  if (typeof options.vehicleType === "number" && Number.isInteger(options.vehicleType) && options.vehicleType > 0) {
    conditions.push(eq(teamSpxDrivers.vehicleType, options.vehicleType));
  }
  const rows = await db
    .select()
    .from(teamSpxDrivers)
    .where(and(...conditions))
    .orderBy(asc(teamSpxDrivers.vehicleType), asc(teamSpxDrivers.driverName), asc(teamSpxDrivers.driverId));
  return rows.map(toDriverRecord);
}

export async function getDriverSummaryByTeam(teamId: number): Promise<TeamSpxDriverSummary> {
  const records = await listDriversByTeam(teamId);
  return summarizeDriverRecords(records);
}

export async function getDriverCountsByTeam(): Promise<Map<number, { total: number; enabled: number }>> {
  await ensureDashboardTables();
  const db = getDb();
  const rows = await db
    .select({
      teamId: teamSpxDrivers.teamId,
      total: sql<number>`COUNT(*)`,
      enabled: sql<number>`COALESCE(SUM(CASE WHEN ${teamSpxDrivers.enabled} = 1 THEN 1 ELSE 0 END), 0)`,
    })
    .from(teamSpxDrivers)
    .groupBy(teamSpxDrivers.teamId);

  const counts = new Map<number, { total: number; enabled: number }>();
  for (const row of rows) {
    counts.set(Number(row.teamId), {
      total: Number(row.total) || 0,
      enabled: Number(row.enabled) || 0,
    });
  }
  return counts;
}

export async function syncTeamDrivers(
  teamId: number,
  drivers: SyncTeamSpxDriverInput[],
  syncedAt = new Date(),
): Promise<SyncTeamSpxDriversResult> {
  await ensureDashboardTables();

  // Deduplicate incoming drivers by driverId (first occurrence wins) and sanitize fields.
  const incomingByDriverId = new Map<number, {
    driverId: number;
    driverName: string;
    agencyName: string;
    vehicleType: number;
    vehicleTypeName: string;
  }>();

  for (const raw of drivers) {
    if (!Number.isInteger(raw.driverId) || raw.driverId <= 0) continue;
    if (!Number.isInteger(raw.vehicleType) || raw.vehicleType <= 0) continue;
    const driverName = typeof raw.driverName === "string" ? raw.driverName.trim() : "";
    if (!driverName) continue;
    if (incomingByDriverId.has(raw.driverId)) continue;

    incomingByDriverId.set(raw.driverId, {
      driverId: raw.driverId,
      driverName: driverName.slice(0, 255),
      agencyName: (raw.agencyName ?? "").trim().slice(0, 255),
      vehicleType: raw.vehicleType,
      vehicleTypeName: (raw.vehicleTypeName ?? "").trim().slice(0, 100),
    });
  }

  const incomingList = [...incomingByDriverId.values()];
  let inserted = 0;
  let updated = 0;
  let removed = 0;

  if (env.DB_MODE === "memory") {
    const db = getDb();
    db.transaction((tx: typeof db) => {
      const existingRows = tx
        .select({ id: teamSpxDrivers.id, driverId: teamSpxDrivers.driverId })
        .from(teamSpxDrivers)
        .where(eq(teamSpxDrivers.teamId, teamId))
        .all() as Array<{ id: number; driverId: number }>;

      const existingDriverIds = new Set(existingRows.map((row) => row.driverId));
      const staleRowIds: number[] = [];

      for (const incoming of incomingList) {
        if (existingDriverIds.has(incoming.driverId)) {
          updated++;
        } else {
          inserted++;
        }
        // Atomic upsert that preserves existing enabled=0 manual toggles.
        tx.insert(teamSpxDrivers)
          .values({
            teamId,
            driverId: incoming.driverId,
            driverName: incoming.driverName,
            agencyName: incoming.agencyName,
            vehicleType: incoming.vehicleType,
            vehicleTypeName: incoming.vehicleTypeName,
            enabled: 1,
            syncedAt,
            createdAt: syncedAt,
            updatedAt: syncedAt,
          })
          .onConflictDoUpdate({
            target: [teamSpxDrivers.teamId, teamSpxDrivers.driverId],
            set: {
              driverName: incoming.driverName,
              agencyName: incoming.agencyName,
              vehicleType: incoming.vehicleType,
              vehicleTypeName: incoming.vehicleTypeName,
              syncedAt,
              updatedAt: syncedAt,
            },
          })
          .run();
      }

      // Only prune stale drivers when SPX returned at least one valid driver to guard against empty upstream glitches.
      if (incomingByDriverId.size > 0) {
        for (const existing of existingRows) {
          if (!incomingByDriverId.has(existing.driverId)) {
            staleRowIds.push(existing.id);
          }
        }
      }

      for (let i = 0; i < staleRowIds.length; i += BATCH_SIZE) {
        const chunk = staleRowIds.slice(i, i + BATCH_SIZE);
        tx.delete(teamSpxDrivers)
          .where(and(eq(teamSpxDrivers.teamId, teamId), inArray(teamSpxDrivers.id, chunk)))
          .run();
      }
      removed = staleRowIds.length;
    });
  } else {
    const pool = getPool();
    if (!pool) throw new Error("Database pool not initialised");

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Lock existing team rows so concurrent syncs serialize cleanly on one connection without ER_DUP_ENTRY.
      const [existingRows] = await conn.query<Array<RowDataPacket & { id: number; driver_id: number }>>(
        "SELECT id, driver_id FROM team_spx_drivers WHERE team_id = ? FOR UPDATE",
        [teamId],
      );
      const existingDriverIds = new Set<number>(existingRows.map((row) => Number(row.driver_id)));

      for (const incoming of incomingList) {
        if (existingDriverIds.has(incoming.driverId)) {
          updated++;
        } else {
          inserted++;
        }
      }

      for (let i = 0; i < incomingList.length; i += BATCH_SIZE) {
        const chunk = incomingList.slice(i, i + BATCH_SIZE);
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, 1, ?, ?, ?)").join(", ");
        const values = chunk.flatMap((incoming) => [
          teamId,
          incoming.driverId,
          incoming.driverName,
          incoming.agencyName,
          incoming.vehicleType,
          incoming.vehicleTypeName,
          syncedAt,
          syncedAt,
          syncedAt,
        ]);
        // Omit `enabled` from ON DUPLICATE KEY UPDATE so manual enabled=0 overrides are preserved atomically.
        await conn.query(
          `INSERT INTO team_spx_drivers (
            team_id, driver_id, driver_name, agency_name, vehicle_type, vehicle_type_name,
            enabled, synced_at, created_at, updated_at
          ) VALUES ${placeholders}
          ON DUPLICATE KEY UPDATE
            driver_name = VALUES(driver_name),
            agency_name = VALUES(agency_name),
            vehicle_type = VALUES(vehicle_type),
            vehicle_type_name = VALUES(vehicle_type_name),
            synced_at = VALUES(synced_at),
            updated_at = VALUES(updated_at)`,
          values,
        );
      }

      const staleRowIds: number[] = [];
      if (incomingByDriverId.size > 0) {
        for (const existing of existingRows) {
          if (!incomingByDriverId.has(Number(existing.driver_id))) {
            staleRowIds.push(Number(existing.id));
          }
        }
      }

      for (let i = 0; i < staleRowIds.length; i += BATCH_SIZE) {
        const chunk = staleRowIds.slice(i, i + BATCH_SIZE);
        const placeholders = chunk.map(() => "?").join(", ");
        await conn.query(
          `DELETE FROM team_spx_drivers WHERE team_id = ? AND id IN (${placeholders})`,
          [teamId, ...chunk],
        );
      }
      removed = staleRowIds.length;

      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }

  const updatedRecords = await listDriversByTeam(teamId);
  return {
    synced: incomingByDriverId.size,
    inserted,
    updated,
    removed,
    summary: summarizeDriverRecords(updatedRecords),
    drivers: updatedRecords,
  };
}

export async function setTeamDriverEnabled(
  teamId: number,
  driverId: number,
  enabled: boolean,
): Promise<TeamSpxDriverRecord | null> {
  await ensureDashboardTables();
  const db = getDb();
  const [existing] = await db
    .select()
    .from(teamSpxDrivers)
    .where(and(eq(teamSpxDrivers.teamId, teamId), eq(teamSpxDrivers.driverId, driverId)))
    .limit(1);
  if (!existing) return null;

  await db
    .update(teamSpxDrivers)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(teamSpxDrivers.id, existing.id));

  const [updated] = await db
    .select()
    .from(teamSpxDrivers)
    .where(eq(teamSpxDrivers.id, existing.id))
    .limit(1);
  return updated ? toDriverRecord(updated) : null;
}

export async function setAllTeamDriversEnabled(
  teamId: number,
  enabled: boolean,
  vehicleType?: number,
): Promise<number> {
  await ensureDashboardTables();
  const db = getDb();
  const conditions = [eq(teamSpxDrivers.teamId, teamId)];
  if (typeof vehicleType === "number" && Number.isInteger(vehicleType) && vehicleType > 0) {
    conditions.push(eq(teamSpxDrivers.vehicleType, vehicleType));
  }
  const matching = await db
    .select({ id: teamSpxDrivers.id })
    .from(teamSpxDrivers)
    .where(and(...conditions));
  if (matching.length === 0) return 0;

  await db
    .update(teamSpxDrivers)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(and(...conditions));
  return matching.length;
}
