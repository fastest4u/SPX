import { getDb, ensureDashboardTables } from "../db/client.js";
import { autoAcceptHistory } from "../db/schema.js";
import { logger } from "../utils/logger.js";

export interface AutoAcceptRecord {
  ruleId: string;
  ruleName: string;
  bookingId: number;
  requestIds: number[];
  acceptedCount: number;
  origin: string;
  destination: string;
  vehicleType: string;
  status: "success" | "failed";
  errorMessage?: string;
}

export async function insertAutoAcceptHistory(record: AutoAcceptRecord): Promise<void> {
  try {
    await ensureDashboardTables();
    const db = await getDb();
    await db.insert(autoAcceptHistory).values({
      ruleId: record.ruleId,
      ruleName: record.ruleName,
      bookingId: record.bookingId,
      requestIds: JSON.stringify(record.requestIds),
      acceptedCount: record.acceptedCount,
      origin: record.origin,
      destination: record.destination,
      vehicleType: record.vehicleType,
      status: record.status,
      errorMessage: record.errorMessage?.substring(0, 1000),
    });
  } catch (err) {
    logger.warn("auto-accept-history-insert-failed", {
      ruleId: record.ruleId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
