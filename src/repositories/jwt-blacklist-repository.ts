import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { getPool } from "../db/client.js";

/**
 * Server-side JWT invalidation via jti (JWT ID) blacklist.
 * Stores revoked jti values with their original expiry so the table self-prunes.
 *
 * In-memory mode keeps a Map; production uses MySQL.
 */

interface BlacklistEntry {
    jti: string;
    revokedAt: number;
    expiresAt: number;
}

const memoryBlacklist = new Map<string, BlacklistEntry>();
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function pruneMemory(now: number = Date.now()): void {
    for (const [jti, entry] of memoryBlacklist) {
        if (entry.expiresAt <= now) memoryBlacklist.delete(jti);
    }
}

function ensurePruneTimer(): void {
    if (pruneTimer) return;
    pruneTimer = setInterval(() => pruneMemory(), 60_000);
    if (typeof pruneTimer.unref === "function") pruneTimer.unref();
}

let mysqlPruneTimer: ReturnType<typeof setInterval> | null = null;
const MYSQL_PRUNE_INTERVAL_MS = 5 * 60_000;
const JWT_BLACKLIST_LOOKUP_TIMEOUT_MS = 1_500;

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`jwt blacklist lookup timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function pruneMysql(): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query("DELETE FROM jwt_blacklist WHERE expires_at <= ?", [Date.now()]);
}

function ensureMysqlPruneTimer(): void {
    if (mysqlPruneTimer) return;
    mysqlPruneTimer = setInterval(() => {
        void pruneMysql().catch((err) => {
            logger.warn("jwt-blacklist-prune-failed", { error: err instanceof Error ? err.message : String(err) });
        });
    }, MYSQL_PRUNE_INTERVAL_MS);
    if (typeof mysqlPruneTimer.unref === "function") mysqlPruneTimer.unref();
}

let tableEnsured = false;
let tableEnsurePromise: Promise<void> | null = null;

async function ensureTable(): Promise<void> {
    if (tableEnsured) return;
    if (env.DB_MODE === "memory") {
        tableEnsured = true;
        return;
    }
    if (tableEnsurePromise) {
        await tableEnsurePromise;
        return;
    }
    tableEnsurePromise = (async () => {
        const pool = getPool();
        if (!pool) return;
        await pool.query(`
      CREATE TABLE IF NOT EXISTS jwt_blacklist (
        jti VARCHAR(64) NOT NULL PRIMARY KEY,
        revoked_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY jwt_blacklist_expires_idx (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
        tableEnsured = true;
        ensureMysqlPruneTimer();
    })().catch((err) => {
        tableEnsurePromise = null;
        throw err;
    });
    await tableEnsurePromise;
}

export async function revokeJti(jti: string, expiresAtMs: number): Promise<void> {
    if (!jti) return;
    const now = Date.now();
    if (expiresAtMs <= now) return;

    memoryBlacklist.set(jti, { jti, revokedAt: now, expiresAt: expiresAtMs });
    ensurePruneTimer();

    if (env.DB_MODE === "memory") {
        return;
    }

    try {
        await ensureTable();
        const pool = getPool();
        if (!pool) return;
        await pool.query(
            "INSERT INTO jwt_blacklist (jti, revoked_at, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE revoked_at = VALUES(revoked_at), expires_at = VALUES(expires_at)",
            [jti, now, expiresAtMs],
        );
        // Expired rows are pruned by a periodic background timer (ensureMysqlPruneTimer),
        // not on every revoke; isJtiRevoked filters expires_at > now so stale rows never match.
        ensureMysqlPruneTimer();
    } catch (err) {
        logger.warn("jwt-blacklist-revoke-failed", { jti, error: err instanceof Error ? err.message : String(err) });
    }
}

export async function isJtiRevoked(jti: string | undefined): Promise<boolean> {
    if (!jti) return false;
    pruneMemory();
    if (memoryBlacklist.has(jti)) return true;
    if (env.DB_MODE === "memory") {
        return false;
    }

    try {
        await withDeadline(ensureTable(), JWT_BLACKLIST_LOOKUP_TIMEOUT_MS);
        const pool = getPool();
        if (!pool) return true;
        const [rows] = await withDeadline(
            pool.query("SELECT 1 FROM jwt_blacklist WHERE jti = ? AND expires_at > ? LIMIT 1", [jti, Date.now()]),
            JWT_BLACKLIST_LOOKUP_TIMEOUT_MS,
        );
        return (rows as unknown[]).length > 0;
    } catch (err) {
        logger.warn("jwt-blacklist-check-failed", { error: err instanceof Error ? err.message : String(err) });
        return true;
    }
}
