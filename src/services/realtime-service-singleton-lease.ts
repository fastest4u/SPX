import { env } from "../config/env.js";
import { getPool } from "../db/client.js";
import { logger } from "../utils/logger.js";

const REALTIME_SINGLETON_LOCK_NAME = "spx:realtime-service:singleton:v1";
const REALTIME_SINGLETON_CHECK_INTERVAL_MS = 15_000;

export interface RealtimeSingletonConnection {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<[Array<Record<string, unknown>>, unknown]>;
  release(): void;
  on?(event: "error", listener: (error: Error) => void): void;
  off?(event: "error", listener: (error: Error) => void): void;
}

export interface RealtimeServiceSingletonLease {
  release(): Promise<void>;
}

export interface AcquireRealtimeServiceSingletonLeaseOptions {
  dbMode?: "mysql" | "memory";
  getConnection?: () => Promise<RealtimeSingletonConnection>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onLeaseLost?: () => void;
}

function scalarFlag(rows: Array<Record<string, unknown>>, key: string): boolean {
  const value = rows[0]?.[key];
  return value === 1 || value === "1" || value === true;
}

function defaultLeaseLost(): void {
  logger.error("realtime-service-singleton-lease-lost");
  try {
    process.kill(process.pid, "SIGTERM");
  } catch {
    process.exitCode = 1;
  }
}

async function defaultGetConnection(): Promise<RealtimeSingletonConnection> {
  const pool = getPool();
  if (!pool) throw new Error("MySQL pool unavailable");
  return await pool.getConnection() as unknown as RealtimeSingletonConnection;
}

function memoryLease(): RealtimeServiceSingletonLease {
  return { release: async () => undefined };
}

export async function acquireRealtimeServiceSingletonLease(
  options: AcquireRealtimeServiceSingletonLeaseOptions = {},
): Promise<RealtimeServiceSingletonLease> {
  if ((options.dbMode ?? env.DB_MODE) === "memory") return memoryLease();

  const getConnection = options.getConnection ?? defaultGetConnection;
  let connection: RealtimeSingletonConnection;
  try {
    connection = await getConnection();
  } catch {
    throw new Error("Realtime service singleton lease unavailable");
  }

  try {
    const [rows] = await connection.query(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [REALTIME_SINGLETON_LOCK_NAME],
    );
    if (!scalarFlag(rows, "acquired")) {
      throw new Error("Realtime service singleton lease unavailable");
    }
  } catch {
    connection.release();
    throw new Error("Realtime service singleton lease unavailable");
  }

  const scheduleInterval = options.setIntervalFn ?? setInterval;
  const cancelInterval = options.clearIntervalFn ?? clearInterval;
  const onLeaseLost = options.onLeaseLost ?? defaultLeaseLost;
  let released = false;
  let leaseLost = false;
  let monitorInFlight: Promise<void> | null = null;
  let releasePromise: Promise<void> | null = null;

  const signalLeaseLost = (): void => {
    if (released || leaseLost) return;
    leaseLost = true;
    onLeaseLost();
  };
  const onConnectionError = (): void => signalLeaseLost();
  connection.on?.("error", onConnectionError);

  const verifyOwnership = (): void => {
    if (released || leaseLost || monitorInFlight) return;
    const monitor = (async () => {
      try {
        const [rows] = await connection.query(
          "SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned",
          [REALTIME_SINGLETON_LOCK_NAME],
        );
        if (!scalarFlag(rows, "owned")) signalLeaseLost();
      } catch {
        signalLeaseLost();
      }
    })();
    const tracked = monitor.finally(() => {
      if (monitorInFlight === tracked) monitorInFlight = null;
    });
    monitorInFlight = tracked;
  };

  const timer = scheduleInterval(verifyOwnership, REALTIME_SINGLETON_CHECK_INTERVAL_MS);
  timer.unref?.();

  return {
    release(): Promise<void> {
      if (releasePromise) return releasePromise;
      releasePromise = (async () => {
        released = true;
        cancelInterval(timer);
        connection.off?.("error", onConnectionError);
        await monitorInFlight?.catch(() => undefined);
        try {
          await connection.query(
            "SELECT RELEASE_LOCK(?) AS released",
            [REALTIME_SINGLETON_LOCK_NAME],
          );
        } catch {
          // A lost connection already released its advisory lock at MySQL.
        } finally {
          connection.release();
        }
      })();
      return releasePromise;
    },
  };
}
