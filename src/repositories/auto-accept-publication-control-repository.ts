import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { ensureDashboardTables, getPool } from "../db/client.js";
import { getRawMemoryDb } from "../db/client-memory.js";

export type PublicationState = "enabled" | "fenced";

export interface PublicationIdentity {
  teamId: number;
  epoch: string;
  pollerNodeId: string;
  now?: Date;
}

export interface PublicationControlRow {
  teamId: number;
  epoch: string;
  publicationGeneration: number;
  state: PublicationState;
  pollerNodeId: string;
  fenceJobId: number | null;
  fenceRequestedAt: Date | string | null;
  ackNodeId: string | null;
  ackJobId: number | null;
  acknowledgedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PublicationActiveEpochRow {
  teamId: number;
  activeEpoch: string;
  activeGeneration: number;
}

export interface PublicationJobWatermarkInput {
  teamId: number;
  epoch: string;
  publicationGeneration: number;
}

export interface AcknowledgePublicationFenceInput extends PublicationIdentity {
  ackJobId: number;
}

export interface AdvancePublicationEpochInput {
  teamId: number;
  previousEpoch: string;
  nextEpoch: string;
  nextPollerNodeId: string;
  now?: Date;
}

export interface PublicationBoundJob {
  teamId: number;
  cutoverEpoch: string | null;
  publicationGeneration: number | null;
}

type RawControlRow = {
  team_id: number | string;
  cutover_epoch: string;
  publication_generation: number | string;
  state: string;
  poller_node_id: string;
  fence_job_id: number | string | null;
  fence_requested_at: Date | string | null;
  ack_node_id: string | null;
  ack_job_id: number | string | null;
  acknowledged_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RawActiveRow = {
  team_id: number | string;
  active_epoch: string;
  active_generation: number | string;
};

type SqlExecutor = Pool | PoolConnection;

const CONTROL_COLUMNS = `
  team_id, cutover_epoch, publication_generation, state, poller_node_id,
  fence_job_id, fence_requested_at, ack_node_id, ack_job_id, acknowledged_at,
  created_at, updated_at
`;

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function requireIdentifier(name: string, value: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a concrete bounded identifier`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return value;
}

function validateIdentity(input: PublicationIdentity): void {
  requirePositiveInteger("teamId", input.teamId);
  requireIdentifier("epoch", input.epoch, 80);
  requireIdentifier("pollerNodeId", input.pollerNodeId, 120);
}

function validateAdvance(input: AdvancePublicationEpochInput): void {
  requirePositiveInteger("teamId", input.teamId);
  requireIdentifier("previousEpoch", input.previousEpoch, 80);
  requireIdentifier("nextEpoch", input.nextEpoch, 80);
  requireIdentifier("nextPollerNodeId", input.nextPollerNodeId, 120);
  if (input.previousEpoch === input.nextEpoch) throw new Error("next epoch must be distinct");
}

function formatTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("publication timestamp is invalid");
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function toNumber(value: number | string | null, label: string): number | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function controlFromRaw(row: RawControlRow): PublicationControlRow {
  if (row.state !== "enabled" && row.state !== "fenced") {
    throw new Error("publication state is invalid");
  }
  const generation = toNumber(row.publication_generation, "publication generation");
  if (generation === null || generation <= 0) throw new Error("publication generation is invalid");
  return {
    teamId: Number(row.team_id),
    epoch: row.cutover_epoch,
    publicationGeneration: generation,
    state: row.state,
    pollerNodeId: row.poller_node_id,
    fenceJobId: toNumber(row.fence_job_id, "fence job watermark"),
    fenceRequestedAt: row.fence_requested_at,
    ackNodeId: row.ack_node_id,
    ackJobId: toNumber(row.ack_job_id, "acknowledgement job watermark"),
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function activeFromRaw(row: RawActiveRow): PublicationActiveEpochRow {
  const generation = toNumber(row.active_generation, "active publication generation");
  if (generation === null || generation <= 0) throw new Error("active publication generation is invalid");
  return {
    teamId: Number(row.team_id),
    activeEpoch: row.active_epoch,
    activeGeneration: generation,
  };
}

function assertSameIdentity(control: PublicationControlRow, input: PublicationIdentity): void {
  if (control.epoch !== input.epoch) throw new Error("stale publication epoch");
  if (control.pollerNodeId !== input.pollerNodeId) throw new Error("publication poller node mismatch");
}

function assertFenceAcknowledged(control: PublicationControlRow): void {
  if (control.state !== "fenced") throw new Error("publication epoch is not fenced");
  if (
    control.fenceJobId === null
    || control.ackJobId === null
    || control.ackJobId < control.fenceJobId
    || control.ackNodeId !== control.pollerNodeId
    || control.acknowledgedAt === null
  ) {
    throw new Error("publication fence is not acknowledged");
  }
}

function activeWorkPredicate(): string {
  return `(
    status IN ('pending', 'retrying', 'claimed', 'verifying', 'indeterminate')
    OR result_status = 'unknown'
    OR (result_status IS NOT NULL AND completed_at IS NULL)
  )`;
}

function getMemoryActive(teamId: number): RawActiveRow | undefined {
  return getRawMemoryDb().prepare(`
    SELECT team_id, active_epoch, active_generation
    FROM auto_accept_publication_active_epochs
    WHERE team_id = ?
  `).get(teamId) as RawActiveRow | undefined;
}

function getMemoryControl(teamId: number, epoch: string): RawControlRow | undefined {
  return getRawMemoryDb().prepare(`
    SELECT ${CONTROL_COLUMNS}
    FROM auto_accept_publication_controls
    WHERE team_id = ? AND cutover_epoch = ?
  `).get(teamId, epoch) as RawControlRow | undefined;
}

async function getMysqlActive(
  executor: SqlExecutor,
  teamId: number,
  lock = false,
): Promise<RawActiveRow | undefined> {
  const [rows] = await executor.execute<RowDataPacket[]>(`
    SELECT team_id, active_epoch, active_generation
    FROM auto_accept_publication_active_epochs
    WHERE team_id = ?${lock ? " FOR UPDATE" : ""}
  `, [teamId]);
  return rows[0] as RawActiveRow | undefined;
}

async function getMysqlControl(
  executor: SqlExecutor,
  teamId: number,
  epoch: string,
  lock = false,
): Promise<RawControlRow | undefined> {
  const [rows] = await executor.execute<RowDataPacket[]>(`
    SELECT ${CONTROL_COLUMNS}
    FROM auto_accept_publication_controls
    WHERE team_id = ? AND cutover_epoch = ?${lock ? " FOR UPDATE" : ""}
  `, [teamId, epoch]);
  return rows[0] as RawControlRow | undefined;
}

async function withMysqlTransaction<T>(callback: (connection: PoolConnection) => Promise<T>): Promise<T> {
  await ensureDashboardTables();
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* rollback is best effort */ }
    throw error;
  } finally {
    connection.release();
  }
}

function assertMemoryEpochHasZeroWork(teamId: number, epoch: string, generation: number): void {
  const rows = getRawMemoryDb().prepare(`
    SELECT id
    FROM auto_accept_jobs
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
      AND ${activeWorkPredicate()}
  `).all(teamId, epoch, generation);
  if (rows.length > 0) throw new Error("prior publication epoch has work");
}

async function assertMysqlEpochHasZeroWork(
  connection: PoolConnection,
  teamId: number,
  epoch: string,
  generation: number,
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(`
    SELECT id, status, result_status, completed_at
    FROM auto_accept_jobs
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
      AND ${activeWorkPredicate()}
    FOR UPDATE
  `, [teamId, epoch, generation]);
  if (rows.length > 0) throw new Error("prior publication epoch has work");
}

export async function getActivePublicationEpoch(teamId: number): Promise<PublicationActiveEpochRow | null> {
  requirePositiveInteger("teamId", teamId);
  await ensureDashboardTables();
  if (env.DB_MODE === "memory") {
    const row = getMemoryActive(teamId);
    return row ? activeFromRaw(row) : null;
  }
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const row = await getMysqlActive(pool, teamId);
  return row ? activeFromRaw(row) : null;
}

export async function getPublicationControlHistory(teamId: number): Promise<PublicationControlRow[]> {
  requirePositiveInteger("teamId", teamId);
  await ensureDashboardTables();
  if (env.DB_MODE === "memory") {
    const rows = getRawMemoryDb().prepare(`
      SELECT ${CONTROL_COLUMNS}
      FROM auto_accept_publication_controls
      WHERE team_id = ?
      ORDER BY publication_generation ASC
    `).all(teamId) as RawControlRow[];
    return rows.map(controlFromRaw);
  }
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const [rows] = await pool.execute<RowDataPacket[]>(`
    SELECT ${CONTROL_COLUMNS}
    FROM auto_accept_publication_controls
    WHERE team_id = ?
    ORDER BY publication_generation ASC
  `, [teamId]);
  return (rows as RawControlRow[]).map(controlFromRaw);
}

export async function enablePublication(input: PublicationIdentity): Promise<PublicationControlRow> {
  validateIdentity(input);
  const now = formatTimestamp(input.now ?? new Date());
  await ensureDashboardTables();
  if (env.DB_MODE === "memory") {
    const db = getRawMemoryDb();
    return db.transaction(() => {
      const activeRaw = getMemoryActive(input.teamId);
      if (activeRaw) {
        const active = activeFromRaw(activeRaw);
        if (active.activeEpoch !== input.epoch) throw new Error("publication epoch advance required");
        const controlRaw = getMemoryControl(input.teamId, active.activeEpoch);
        if (!controlRaw) throw new Error("active publication control is missing");
        const control = controlFromRaw(controlRaw);
        assertSameIdentity(control, input);
        if (control.publicationGeneration !== active.activeGeneration) {
          throw new Error("active publication generation mismatch");
        }
        if (control.state !== "enabled") throw new Error("publication fenced");
        return control;
      }
      const orphan = getMemoryControl(input.teamId, input.epoch);
      if (orphan) throw new Error("publication control history has no active pointer");
      db.prepare(`
        INSERT INTO auto_accept_publication_controls (
          team_id, cutover_epoch, publication_generation, state, poller_node_id,
          created_at, updated_at
        ) VALUES (?, ?, 1, 'enabled', ?, ?, ?)
      `).run(input.teamId, input.epoch, input.pollerNodeId, now, now);
      db.prepare(`
        INSERT INTO auto_accept_publication_active_epochs (
          team_id, active_epoch, active_generation, updated_at
        ) VALUES (?, ?, 1, ?)
      `).run(input.teamId, input.epoch, now);
      return controlFromRaw(getMemoryControl(input.teamId, input.epoch)!);
    })();
  }

  return withMysqlTransaction(async (connection) => {
    const activeRaw = await getMysqlActive(connection, input.teamId, true);
    if (activeRaw) {
      const active = activeFromRaw(activeRaw);
      if (active.activeEpoch !== input.epoch) throw new Error("publication epoch advance required");
      const controlRaw = await getMysqlControl(connection, input.teamId, active.activeEpoch, true);
      if (!controlRaw) throw new Error("active publication control is missing");
      const control = controlFromRaw(controlRaw);
      assertSameIdentity(control, input);
      if (control.publicationGeneration !== active.activeGeneration) {
        throw new Error("active publication generation mismatch");
      }
      if (control.state !== "enabled") throw new Error("publication fenced");
      return control;
    }
    const orphan = await getMysqlControl(connection, input.teamId, input.epoch, true);
    if (orphan) throw new Error("publication control history has no active pointer");
    await connection.execute<ResultSetHeader>(`
      INSERT INTO auto_accept_publication_controls (
        team_id, cutover_epoch, publication_generation, state, poller_node_id,
        created_at, updated_at
      ) VALUES (?, ?, 1, 'enabled', ?, ?, ?)
    `, [input.teamId, input.epoch, input.pollerNodeId, now, now]);
    await connection.execute<ResultSetHeader>(`
      INSERT INTO auto_accept_publication_active_epochs (
        team_id, active_epoch, active_generation, updated_at
      ) VALUES (?, ?, 1, ?)
    `, [input.teamId, input.epoch, now]);
    return controlFromRaw((await getMysqlControl(connection, input.teamId, input.epoch, true))!);
  });
}

export async function assertPublicationEnabled(
  input: PublicationIdentity,
): Promise<PublicationControlRow> {
  validateIdentity(input);
  const active = await getActivePublicationEpoch(input.teamId);
  if (!active || active.activeEpoch !== input.epoch) throw new Error("stale publication epoch");
  const history = await getPublicationControlHistory(input.teamId);
  const control = history.find((row) => row.epoch === input.epoch);
  if (!control || control.publicationGeneration !== active.activeGeneration) {
    throw new Error("stale publication epoch");
  }
  assertSameIdentity(control, input);
  if (control.state !== "enabled") throw new Error("publication fenced");
  return control;
}

export async function getPublicationJobWatermark(
  input: PublicationJobWatermarkInput,
): Promise<number> {
  requirePositiveInteger("teamId", input.teamId);
  requireIdentifier("epoch", input.epoch, 80);
  requirePositiveInteger("publicationGeneration", input.publicationGeneration);
  await ensureDashboardTables();
  if (env.DB_MODE === "memory") {
    const row = getRawMemoryDb().prepare(`
      SELECT COALESCE(MAX(id), 0) AS watermark
      FROM auto_accept_jobs
      WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
    `).get(input.teamId, input.epoch, input.publicationGeneration) as { watermark: number | string };
    return Number(row.watermark);
  }
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool is not available");
  const [rows] = await pool.execute<RowDataPacket[]>(`
    SELECT COALESCE(MAX(id), 0) AS watermark
    FROM auto_accept_jobs
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
  `, [input.teamId, input.epoch, input.publicationGeneration]);
  return Number((rows[0] as { watermark?: number | string } | undefined)?.watermark ?? 0);
}

export async function fencePublication(input: PublicationIdentity): Promise<PublicationControlRow> {
  validateIdentity(input);
  const now = formatTimestamp(input.now ?? new Date());
  await ensureDashboardTables();
  if (env.DB_MODE === "memory") {
    const db = getRawMemoryDb();
    return db.transaction(() => {
      const activeRaw = getMemoryActive(input.teamId);
      if (!activeRaw || activeRaw.active_epoch !== input.epoch) throw new Error("stale publication epoch");
      const controlRaw = getMemoryControl(input.teamId, input.epoch);
      if (!controlRaw) throw new Error("publication control is missing");
      const control = controlFromRaw(controlRaw);
      assertSameIdentity(control, input);
      if (control.publicationGeneration !== Number(activeRaw.active_generation)) {
        throw new Error("stale publication epoch");
      }
      if (control.state === "fenced") return control;
      const watermarkRow = db.prepare(`
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM auto_accept_jobs
        WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
      `).get(input.teamId, input.epoch, control.publicationGeneration) as { watermark: number | string };
      db.prepare(`
        UPDATE auto_accept_publication_controls
        SET state = 'fenced', fence_job_id = ?, fence_requested_at = ?, updated_at = ?
        WHERE team_id = ? AND cutover_epoch = ? AND state = 'enabled'
      `).run(Number(watermarkRow.watermark), now, now, input.teamId, input.epoch);
      return controlFromRaw(getMemoryControl(input.teamId, input.epoch)!);
    })();
  }

  return withMysqlTransaction(async (connection) => {
    const activeRaw = await getMysqlActive(connection, input.teamId, true);
    if (!activeRaw || activeRaw.active_epoch !== input.epoch) throw new Error("stale publication epoch");
    const controlRaw = await getMysqlControl(connection, input.teamId, input.epoch, true);
    if (!controlRaw) throw new Error("publication control is missing");
    const control = controlFromRaw(controlRaw);
    assertSameIdentity(control, input);
    if (control.publicationGeneration !== Number(activeRaw.active_generation)) {
      throw new Error("stale publication epoch");
    }
    if (control.state === "fenced") return control;
    const [rows] = await connection.execute<RowDataPacket[]>(`
      SELECT COALESCE(MAX(id), 0) AS watermark
      FROM auto_accept_jobs
      WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
      FOR UPDATE
    `, [input.teamId, input.epoch, control.publicationGeneration]);
    const watermark = Number((rows[0] as { watermark?: number | string } | undefined)?.watermark ?? 0);
    await connection.execute<ResultSetHeader>(`
      UPDATE auto_accept_publication_controls
      SET state = 'fenced', fence_job_id = ?, fence_requested_at = ?, updated_at = ?
      WHERE team_id = ? AND cutover_epoch = ? AND state = 'enabled'
    `, [watermark, now, now, input.teamId, input.epoch]);
    return controlFromRaw((await getMysqlControl(connection, input.teamId, input.epoch, true))!);
  });
}

export async function acknowledgePublicationFence(
  input: AcknowledgePublicationFenceInput,
): Promise<PublicationControlRow> {
  validateIdentity(input);
  requireNonNegativeInteger("ackJobId", input.ackJobId);
  const now = formatTimestamp(input.now ?? new Date());
  await ensureDashboardTables();
  const acknowledge = (control: PublicationControlRow, update: () => void): PublicationControlRow => {
    assertSameIdentity(control, input);
    if (control.state !== "fenced" || control.fenceJobId === null) {
      throw new Error("publication is not fenced");
    }
    if (input.ackJobId < control.fenceJobId) throw new Error("publication acknowledgement is behind fence");
    if (control.ackJobId !== null && input.ackJobId < control.ackJobId) {
      throw new Error("publication acknowledgement watermark cannot decrease");
    }
    if (control.ackNodeId !== null && control.ackNodeId !== input.pollerNodeId) {
      throw new Error("publication acknowledgement node mismatch");
    }
    update();
    return control;
  };

  if (env.DB_MODE === "memory") {
    const db = getRawMemoryDb();
    return db.transaction(() => {
      const activeRaw = getMemoryActive(input.teamId);
      if (!activeRaw || activeRaw.active_epoch !== input.epoch) throw new Error("stale publication epoch");
      const raw = getMemoryControl(input.teamId, input.epoch);
      if (!raw) throw new Error("publication control is missing");
      acknowledge(controlFromRaw(raw), () => {
        db.prepare(`
          UPDATE auto_accept_publication_controls
          SET ack_node_id = ?, ack_job_id = ?, acknowledged_at = ?, updated_at = ?
          WHERE team_id = ? AND cutover_epoch = ?
        `).run(input.pollerNodeId, input.ackJobId, now, now, input.teamId, input.epoch);
      });
      return controlFromRaw(getMemoryControl(input.teamId, input.epoch)!);
    })();
  }

  return withMysqlTransaction(async (connection) => {
    const activeRaw = await getMysqlActive(connection, input.teamId, true);
    if (!activeRaw || activeRaw.active_epoch !== input.epoch) throw new Error("stale publication epoch");
    const raw = await getMysqlControl(connection, input.teamId, input.epoch, true);
    if (!raw) throw new Error("publication control is missing");
    const control = controlFromRaw(raw);
    acknowledge(control, () => undefined);
    await connection.execute<ResultSetHeader>(`
      UPDATE auto_accept_publication_controls
      SET ack_node_id = ?, ack_job_id = ?, acknowledged_at = ?, updated_at = ?
      WHERE team_id = ? AND cutover_epoch = ?
    `, [input.pollerNodeId, input.ackJobId, now, now, input.teamId, input.epoch]);
    return controlFromRaw((await getMysqlControl(connection, input.teamId, input.epoch, true))!);
  });
}

export async function advancePublicationEpoch(
  input: AdvancePublicationEpochInput,
): Promise<PublicationControlRow> {
  validateAdvance(input);
  const now = formatTimestamp(input.now ?? new Date());
  await ensureDashboardTables();
  if (env.DB_MODE === "memory") {
    const db = getRawMemoryDb();
    return db.transaction(() => {
      const activeRaw = getMemoryActive(input.teamId);
      if (!activeRaw || activeRaw.active_epoch !== input.previousEpoch) {
        throw new Error("active epoch changed");
      }
      const active = activeFromRaw(activeRaw);
      const previousRaw = getMemoryControl(input.teamId, input.previousEpoch);
      if (!previousRaw) throw new Error("publication control is missing");
      const previous = controlFromRaw(previousRaw);
      if (previous.publicationGeneration !== active.activeGeneration) {
        throw new Error("active epoch changed");
      }
      assertFenceAcknowledged(previous);
      assertMemoryEpochHasZeroWork(
        input.teamId,
        input.previousEpoch,
        previous.publicationGeneration,
      );
      if (getMemoryControl(input.teamId, input.nextEpoch)) throw new Error("publication epoch was already used");
      const nextGeneration = active.activeGeneration + 1;
      db.prepare(`
        INSERT INTO auto_accept_publication_controls (
          team_id, cutover_epoch, publication_generation, state, poller_node_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'enabled', ?, ?, ?)
      `).run(input.teamId, input.nextEpoch, nextGeneration, input.nextPollerNodeId, now, now);
      const moved = db.prepare(`
        UPDATE auto_accept_publication_active_epochs
        SET active_epoch = ?, active_generation = ?, updated_at = ?
        WHERE team_id = ? AND active_epoch = ? AND active_generation = ?
      `).run(
        input.nextEpoch,
        nextGeneration,
        now,
        input.teamId,
        input.previousEpoch,
        active.activeGeneration,
      );
      if (moved.changes !== 1) throw new Error("active epoch changed");
      return controlFromRaw(getMemoryControl(input.teamId, input.nextEpoch)!);
    })();
  }

  return withMysqlTransaction(async (connection) => {
    const activeRaw = await getMysqlActive(connection, input.teamId, true);
    if (!activeRaw || activeRaw.active_epoch !== input.previousEpoch) {
      throw new Error("active epoch changed");
    }
    const active = activeFromRaw(activeRaw);
    const previousRaw = await getMysqlControl(connection, input.teamId, input.previousEpoch, true);
    if (!previousRaw) throw new Error("publication control is missing");
    const previous = controlFromRaw(previousRaw);
    if (previous.publicationGeneration !== active.activeGeneration) throw new Error("active epoch changed");
    assertFenceAcknowledged(previous);
    await assertMysqlEpochHasZeroWork(
      connection,
      input.teamId,
      input.previousEpoch,
      previous.publicationGeneration,
    );
    if (await getMysqlControl(connection, input.teamId, input.nextEpoch, true)) {
      throw new Error("publication epoch was already used");
    }
    const nextGeneration = active.activeGeneration + 1;
    await connection.execute<ResultSetHeader>(`
      INSERT INTO auto_accept_publication_controls (
        team_id, cutover_epoch, publication_generation, state, poller_node_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'enabled', ?, ?, ?)
    `, [input.teamId, input.nextEpoch, nextGeneration, input.nextPollerNodeId, now, now]);
    const [moved] = await connection.execute<ResultSetHeader>(`
      UPDATE auto_accept_publication_active_epochs
      SET active_epoch = ?, active_generation = ?, updated_at = ?
      WHERE team_id = ? AND active_epoch = ? AND active_generation = ?
    `, [
      input.nextEpoch,
      nextGeneration,
      now,
      input.teamId,
      input.previousEpoch,
      active.activeGeneration,
    ]);
    if (moved.affectedRows !== 1) throw new Error("active epoch changed");
    return controlFromRaw((await getMysqlControl(connection, input.teamId, input.nextEpoch, true))!);
  });
}

export async function assertJobPublicationCurrent(job: PublicationBoundJob): Promise<void> {
  requirePositiveInteger("teamId", job.teamId);
  if (job.cutoverEpoch === null && job.publicationGeneration === null) return;
  if (job.cutoverEpoch === null || job.publicationGeneration === null) {
    throw new Error("stale publication epoch");
  }
  requireIdentifier("cutoverEpoch", job.cutoverEpoch, 80);
  requirePositiveInteger("publicationGeneration", job.publicationGeneration);
  const active = await getActivePublicationEpoch(job.teamId);
  if (
    !active
    || active.activeEpoch !== job.cutoverEpoch
    || active.activeGeneration !== job.publicationGeneration
  ) {
    throw new Error("stale publication epoch");
  }
}
