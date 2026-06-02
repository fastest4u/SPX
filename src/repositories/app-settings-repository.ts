import { eq, inArray, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { ensureDashboardTables, getDb, getPool } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import { decryptString, encryptString, isEncrypted } from "../utils/crypto.js";

/**
 * Settings keys that hold credentials or external tokens. Values are encrypted
 * before insert/update and decrypted on read so DB dumps cannot leak them.
 */
const SECRET_SETTING_KEYS = new Set<string>([
  "COOKIE",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_USER_ID",
  "LINEJS_TEST_TARGET_ID",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE",
  "DISCORD_WEBHOOK_URL",
]);

function encodeForStorage(key: string, value: string): string {
  if (!SECRET_SETTING_KEYS.has(key)) return value;
  if (!value) return "";
  if (isEncrypted(value)) return value;
  return encryptString(value);
}

function decodeFromStorage(key: string, value: string): string {
  if (!SECRET_SETTING_KEYS.has(key)) return value;
  if (!value) return "";
  return isEncrypted(value) ? decryptString(value) : value;
}

export async function getAppSettings(keys?: readonly string[]): Promise<Record<string, string>> {
  await ensureDashboardTables();
  const db = getDb();
  const rows = keys && keys.length > 0
    ? await db.select().from(appSettings).where(inArray(appSettings.key, [...keys]))
    : await db.select().from(appSettings);
  return Object.fromEntries(
    rows.map((row: typeof appSettings.$inferSelect) => [row.key, decodeFromStorage(row.key, row.value)]),
  );
}

export async function upsertAppSettings(settings: Record<string, string>): Promise<void> {
  const entries = Object.entries(settings);
  if (entries.length === 0) return;

  await ensureDashboardTables();

  // MySQL: single atomic INSERT ... ON DUPLICATE KEY UPDATE per key to avoid the
  // PK-duplicate race inherent in a non-atomic select-then-insert/update.
  if (env.DB_MODE !== "memory") {
    const pool = getPool();
    if (pool) {
      for (const [key, value] of entries) {
        const stored = encodeForStorage(key, value);
        await pool.query(
          "INSERT INTO app_settings (setting_key, setting_value, created_at, updated_at) VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = UTC_TIMESTAMP()",
          [key, stored],
        );
      }
      return;
    }
  }

  // SQLite/memory mode is single-threaded, so a select-then-upsert is race-free.
  const db = getDb();
  for (const [key, value] of entries) {
    const stored = encodeForStorage(key, value);
    const rows = await db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
    if (rows.length > 0) {
      await db.update(appSettings).set({ value: stored, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(appSettings.key, key));
    } else {
      await db.insert(appSettings).values({ key, value: stored, createdAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP` });
    }
  }
}
