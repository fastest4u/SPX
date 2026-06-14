import { ensureDashboardTables, getDb, getPool } from "../db/client.js";
import { env } from "../config/env.js";
import { lineBotSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { decryptString, encryptString } from "../utils/crypto.js";

const DEFAULT_KEY = "default";

export async function getLineBotSession(sessionKey = DEFAULT_KEY): Promise<{ authToken: string; device: string } | null> {
  try {
    await ensureDashboardTables();
    const db = getDb();
    const rows = await db.select().from(lineBotSessions).where(eq(lineBotSessions.sessionKey, sessionKey)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const authToken = decryptString(row.authToken);
    if (!authToken) return null;
    return { authToken, device: row.device };
  } catch {
    return null;
  }
}

export async function saveLineBotSession(authToken: string, device: string, sessionKey = DEFAULT_KEY): Promise<boolean> {
  try {
    await ensureDashboardTables();
    const db = getDb();
    const encrypted = encryptString(authToken);
    if (env.DB_MODE !== "memory") {
      const pool = getPool();
      if (!pool) return false;
      await pool.query(
        "INSERT INTO line_bot_sessions (session_key, auth_token, device, created_at, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE auth_token = VALUES(auth_token), device = VALUES(device), updated_at = UTC_TIMESTAMP()",
        [sessionKey, encrypted, device],
      );
      return true;
    }

    const rows = await db.select().from(lineBotSessions).where(eq(lineBotSessions.sessionKey, sessionKey)).limit(1);
    if (rows.length > 0) {
      await db.update(lineBotSessions).set({ authToken: encrypted, device }).where(eq(lineBotSessions.sessionKey, sessionKey));
    } else {
      await db.insert(lineBotSessions).values({ sessionKey, authToken: encrypted, device });
    }
    return true;
  } catch {
    return false;
  }
}

export async function deleteLineBotSession(sessionKey = DEFAULT_KEY): Promise<boolean> {
  try {
    await ensureDashboardTables();
    const db = getDb();
    await db.delete(lineBotSessions).where(eq(lineBotSessions.sessionKey, sessionKey));
    return true;
  } catch {
    return false;
  }
}
