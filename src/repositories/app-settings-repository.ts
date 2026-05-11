import { eq, inArray, sql } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { appSettings } from "../db/schema.js";

export async function getAppSettings(keys?: readonly string[]): Promise<Record<string, string>> {
  await ensureDashboardTables();
  const db = getDb();
  const rows = keys && keys.length > 0
    ? await db.select().from(appSettings).where(inArray(appSettings.key, [...keys]))
    : await db.select().from(appSettings);
  return Object.fromEntries(rows.map((row: typeof appSettings.$inferSelect) => [row.key, row.value]));
}

export async function upsertAppSettings(settings: Record<string, string>): Promise<void> {
  const entries = Object.entries(settings);
  if (entries.length === 0) return;

  await ensureDashboardTables();
  const db = getDb();

  for (const [key, value] of entries) {
    const rows = await db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
    if (rows.length > 0) {
      await db.update(appSettings).set({ value, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(appSettings.key, key));
    } else {
      await db.insert(appSettings).values({ key, value, createdAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP` });
    }
  }
}
