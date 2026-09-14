import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { getPool } from "../db/client.js";
import { getRawMemoryDb } from "../db/client-memory.js";
import {
  prepareInternalRequestReplay,
  type InternalRequestReplayGuardOptions,
  type InternalRequestReplayInput,
  type InternalRequestReplayResult,
  type InternalRequestReplayStore,
  type PreparedInternalRequestReplay,
} from "../services/internal-auth.js";

export type ReplayStoreOutcome = "consumed" | "replay" | "capacity";

interface MysqlReplayConnection {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  rollback(): Promise<void>;
}

export interface InternalRequestReplayPersistenceStore {
  consume(
    input: PreparedInternalRequestReplay,
    limits: { cleanupBatchSize: number; maxEntries: number; maxEntriesPerPartition: number },
  ): Promise<ReplayStoreOutcome>;
}

export interface DurableInternalRequestReplayGuardOptions extends InternalRequestReplayGuardOptions {
  cleanupBatchSize?: number;
  store?: InternalRequestReplayPersistenceStore;
}

const defaultMaxSkewMs = 120_000;
const defaultMaxEntries = 50_000;
const defaultMaxEntriesPerPartition = 10_000;
const defaultCleanupBatchSize = 100;
const mysqlCapacityLockTimeoutSeconds = 2;

export function mysqlReplayCapacityLockName(databaseName: string): string {
  if (typeof databaseName !== "string" || databaseName.length === 0) {
    throw new Error("internal replay database namespace unavailable");
  }
  const namespace = createHash("sha256").update(databaseName, "utf8").digest("hex").slice(0, 40);
  return `spx:replay-capacity:v1:${namespace}`;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
  return value;
}

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 23).replace("T", " ");
}

function isDuplicateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (
      candidate.code === "ER_DUP_ENTRY" ||
      candidate.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      candidate.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      candidate.errno === 1062 ||
      candidate.errno === 1555 ||
      candidate.errno === 2067 ||
      message.includes("Duplicate entry") ||
      message.includes("UNIQUE constraint failed")
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

class DatabaseInternalRequestReplayStore implements InternalRequestReplayPersistenceStore {
  async consume(
    input: PreparedInternalRequestReplay,
    limits: { cleanupBatchSize: number; maxEntries: number; maxEntriesPerPartition: number },
  ): Promise<ReplayStoreOutcome> {
    return env.DB_MODE === "memory"
      ? this.consumeMemory(input, limits)
      : this.consumeMysql(input, limits);
  }

  private async consumeMysql(
    input: PreparedInternalRequestReplay,
    limits: { cleanupBatchSize: number; maxEntries: number; maxEntriesPerPartition: number },
  ): Promise<ReplayStoreOutcome> {
    const pool = getPool();
    if (!pool) throw new Error("internal replay database unavailable");
    const connection = await pool.getConnection();
    try {
      return await consumeMysqlInternalRequestReplay(connection, input, limits);
    } finally {
      connection.release();
    }
  }

  private async consumeMemory(
    input: PreparedInternalRequestReplay,
    limits: { cleanupBatchSize: number; maxEntries: number; maxEntriesPerPartition: number },
  ): Promise<ReplayStoreOutcome> {
    const db = getRawMemoryDb();
    const now = formatDbTimestamp(input.now);
    const transaction = db.transaction((): ReplayStoreOutcome => {
      db.prepare(
        "DELETE FROM internal_request_replays WHERE replay_key = ? AND expires_at <= ?",
      ).run(input.fingerprint, now);
      db.prepare(`
        DELETE FROM internal_request_replays
        WHERE replay_key IN (
          SELECT replay_key FROM internal_request_replays
          WHERE expires_at <= ?
          ORDER BY expires_at
          LIMIT ?
        )
      `).run(now, limits.cleanupBatchSize);
      const total = Number((db.prepare(
        "SELECT COUNT(*) AS total FROM internal_request_replays",
      ).get() as { total: number }).total);
      const partitionTotal = Number((db.prepare(
        "SELECT COUNT(*) AS total FROM internal_request_replays WHERE partition_name = ?",
      ).get(input.partition) as { total: number }).total);
      if (total >= limits.maxEntries || partitionTotal >= limits.maxEntriesPerPartition) {
        return "capacity";
      }
      try {
        db.prepare(`
          INSERT INTO internal_request_replays (replay_key, partition_name, expires_at)
          VALUES (?, ?, ?)
        `).run(input.fingerprint, input.partition, formatDbTimestamp(input.expiresAt));
        return "consumed";
      } catch (error) {
        if (isDuplicateError(error)) return "replay";
        throw error;
      }
    });
    return transaction();
  }
}

export async function consumeMysqlInternalRequestReplay(
  connection: MysqlReplayConnection,
  input: PreparedInternalRequestReplay,
  limits: { cleanupBatchSize: number; maxEntries: number; maxEntriesPerPartition: number },
): Promise<ReplayStoreOutcome> {
  let capacityLockAcquired = false;
  let capacityLockName = "";
  const now = formatDbTimestamp(input.now);
  let outcome: ReplayStoreOutcome | null = null;
  let primaryFailure: { error: unknown } | null = null;
  let releaseFailure: Error | null = null;
  try {
    outcome = await (async (): Promise<ReplayStoreOutcome> => {
      const [activeRows] = await connection.query(
        "SELECT 1 AS active FROM internal_request_replays WHERE replay_key = ? AND expires_at > ? LIMIT 1",
        [input.fingerprint, now],
      );
      if ((activeRows as Array<{ active: number | string }>).length > 0) return "replay";

      const [databaseRows] = await connection.query(
        "SELECT DATABASE() AS databaseName",
      );
      const databaseName = (databaseRows as Array<{ databaseName?: unknown }>)[0]?.databaseName;
      capacityLockName = mysqlReplayCapacityLockName(
        typeof databaseName === "string" ? databaseName : "",
      );
      const [lockRows] = await connection.query(
        "SELECT GET_LOCK(?, ?) AS acquired",
        [capacityLockName, mysqlCapacityLockTimeoutSeconds],
      );
      const acquired = Number((lockRows as Array<{ acquired: number | string }>)[0]?.acquired ?? 0);
      if (acquired !== 1) throw new Error("internal replay capacity lock unavailable");
      capacityLockAcquired = true;

      const [lockedActiveRows] = await connection.query(
        "SELECT 1 AS active FROM internal_request_replays WHERE replay_key = ? AND expires_at > ? LIMIT 1",
        [input.fingerprint, now],
      );
      if ((lockedActiveRows as Array<{ active: number | string }>).length > 0) return "replay";

      try {
        await connection.beginTransaction();
        await connection.query(
          "DELETE FROM internal_request_replays WHERE replay_key = ? AND expires_at <= ?",
          [input.fingerprint, now],
        );
        await connection.query(
          "DELETE FROM internal_request_replays WHERE expires_at <= ? ORDER BY expires_at LIMIT ?",
          [now, limits.cleanupBatchSize],
        );
        const [totalRows] = await connection.query(
          "SELECT COUNT(*) AS total FROM internal_request_replays",
        );
        const [partitionRows] = await connection.query(
          "SELECT COUNT(*) AS total FROM internal_request_replays WHERE partition_name = ?",
          [input.partition],
        );
        const total = Number((totalRows as Array<{ total: number | string }>)[0]?.total ?? 0);
        const partitionTotal = Number((partitionRows as Array<{ total: number | string }>)[0]?.total ?? 0);
        if (total >= limits.maxEntries || partitionTotal >= limits.maxEntriesPerPartition) {
          await connection.commit();
          return "capacity";
        }
        await connection.query(
          "INSERT INTO internal_request_replays (replay_key, partition_name, expires_at) VALUES (?, ?, ?)",
          [input.fingerprint, input.partition, formatDbTimestamp(input.expiresAt)],
        );
        await connection.commit();
        return "consumed";
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // The original database failure determines the fail-closed result.
        }
        if (isDuplicateError(error)) return "replay";
        throw error;
      }
    })();
  } catch (error) {
    primaryFailure = { error };
  } finally {
    if (capacityLockAcquired) {
      try {
        const [releaseRows] = await connection.query(
          "SELECT RELEASE_LOCK(?) AS released",
          [capacityLockName],
        );
        const released = Number((releaseRows as Array<{ released: number | string }>)[0]?.released ?? 0);
        if (released !== 1) releaseFailure = new Error("internal replay capacity lock release failed");
      } catch {
        releaseFailure = new Error("internal replay capacity lock release failed");
      }
    }
  }
  if (primaryFailure) throw primaryFailure.error;
  if (releaseFailure) throw releaseFailure;
  if (outcome === null) throw new Error("internal replay result unavailable");
  return outcome;
}

export class DurableInternalRequestReplayGuard implements InternalRequestReplayStore {
  private readonly cleanupBatchSize: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerPartition: number;
  private readonly maxSkewMs: number;
  private readonly store: InternalRequestReplayPersistenceStore;

  constructor(options: DurableInternalRequestReplayGuardOptions = {}) {
    this.maxSkewMs = requirePositiveInteger(options.maxSkewMs ?? defaultMaxSkewMs, "replay guard skew");
    this.maxEntries = requirePositiveInteger(options.maxEntries ?? defaultMaxEntries, "replay guard capacity");
    this.maxEntriesPerPartition = requirePositiveInteger(
      options.maxEntriesPerPartition ?? defaultMaxEntriesPerPartition,
      "replay guard partition capacity",
    );
    this.cleanupBatchSize = requirePositiveInteger(
      options.cleanupBatchSize ?? defaultCleanupBatchSize,
      "replay guard cleanup batch size",
    );
    if (this.maxEntriesPerPartition > this.maxEntries) {
      throw new Error("replay guard partition capacity is invalid");
    }
    this.store = options.store ?? new DatabaseInternalRequestReplayStore();
  }

  async consume(input: InternalRequestReplayInput): Promise<InternalRequestReplayResult> {
    const prepared = prepareInternalRequestReplay(input, this.maxSkewMs);
    if (!prepared.ok) return prepared;
    try {
      const outcome = await this.store.consume(prepared.value, {
        cleanupBatchSize: this.cleanupBatchSize,
        maxEntries: this.maxEntries,
        maxEntriesPerPartition: this.maxEntriesPerPartition,
      });
      if (outcome === "consumed") return { ok: true };
      return { ok: false, reason: outcome === "replay" ? "replay" : "capacity" };
    } catch {
      return { ok: false, reason: "capacity" };
    }
  }
}
