import { getDb } from "../db/client.js";
import { lineBotSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";

const DEFAULT_KEY = "default";

export async function getLineBotSession(sessionKey = DEFAULT_KEY): Promise<{ authToken: string; device: string } | null> {
  try {
    const db = getDb();
    const rows = await db.select().from(lineBotSessions).where(eq(lineBotSessions.sessionKey, sessionKey)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return { authToken: row.authToken, device: row.device };
  } catch {
    return null;
  }
}

export async function saveLineBotSession(authToken: string, device: string, sessionKey = DEFAULT_KEY): Promise<boolean> {
  try {
    const db = getDb();
    const rows = await db.select().from(lineBotSessions).where(eq(lineBotSessions.sessionKey, sessionKey)).limit(1);
    if (rows.length > 0) {
      await db.update(lineBotSessions).set({ authToken, device }).where(eq(lineBotSessions.sessionKey, sessionKey));
    } else {
      await db.insert(lineBotSessions).values({ sessionKey, authToken, device });
    }
    return true;
  } catch {
    return false;
  }
}
