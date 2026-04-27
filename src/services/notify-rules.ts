import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, ensureDashboardTables } from "../db/client.js";
import { notifyRules as notifyRulesTable } from "../db/schema.js";
import { env } from "../config/env.js";
import { sseBroadcaster } from "./sse.js";
import { logger } from "../utils/logger.js";

export interface TripLike {
  origin?: string;
  destination?: string;
  vehicle_type?: string;
  "ต้นทาง"?: unknown;
  "ปลายทาง"?: unknown;
  "ประเภทรถ"?: unknown;
  request_id?: unknown;
  booking_id?: unknown;
}

export interface NotifyRule {
  id: string;
  name: string;
  origins: string[];
  destinations: string[];
  vehicle_types: string[];
  need: number;
  enabled: boolean;
  fulfilled: boolean;
  auto_accept: boolean;
  auto_accepted: boolean;
}

export interface NotifyRuleInput {
  name: string;
  origins?: string[];
  destinations?: string[];
  vehicle_types?: string[];
  need?: number;
  enabled?: boolean;
  fulfilled?: boolean;
  auto_accept?: boolean;
  auto_accepted?: boolean;
}

export type NotifyRulePatch = Partial<NotifyRuleInput>;

export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  matchedCount: number;
}

export interface RuleTripMatch extends RuleMatch {
  trips: TripLike[];
  need: number;
}

const RULES_FILE = resolve(process.cwd(), "notify-rules.json");

// ── Utils ────────────────────────────────────────────────────────────────

function usesDb(): boolean {
  return (env.SAVE_TO_DB || env.HTTP_ENABLED || env.AUTO_ACCEPT_ENABLED)
    && env.NODE_ENV === "production";
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stableRuleId(candidate: Record<string, unknown>): string {
  const fingerprint = JSON.stringify({
    name: candidate.name,
    origins: toStringArray(candidate.origins),
    destinations: toStringArray(candidate.destinations),
    vehicle_types: toStringArray(candidate.vehicle_types),
    need: candidate.need,
  });
  return `rule_${createHash("sha1").update(fingerprint).digest("hex").slice(0, 12)}`;
}

function normalizeRules(rawRules: unknown): NotifyRule[] {
  if (!Array.isArray(rawRules)) return [];

  const seenIds = new Set<string>();
  return rawRules.flatMap((rule): NotifyRule[] => {
    if (!rule || typeof rule !== "object") return [];

    const candidate = rule as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const need = typeof candidate.need === "number" && Number.isInteger(candidate.need) ? candidate.need : 1;
    const rawId = typeof candidate.id === "string" ? candidate.id.trim() : "";

    if (!name) return [];

    const baseId = rawId || stableRuleId(candidate);
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix++;
    }
    seenIds.add(id);

    return [{
      id,
      name,
      origins: toStringArray(candidate.origins),
      destinations: toStringArray(candidate.destinations),
      vehicle_types: toStringArray(candidate.vehicle_types),
      need: Math.max(1, need),
      enabled: candidate.enabled !== false,
      fulfilled: candidate.fulfilled === true,
      auto_accept: candidate.auto_accept === true,
      auto_accepted: candidate.auto_accepted === true,
    }];
  });
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function matchesAny(haystack: string, needles: string[]): boolean {
  if (needles.length === 0) return true;
  return needles.some((needle) => {
    const normalized = normalize(needle);
    return normalized.length > 0 && haystack.includes(normalized);
  });
}

// ── DB row converters ────────────────────────────────────────────────────

type DbRow = typeof notifyRulesTable.$inferSelect;

function dbRowToRule(row: DbRow): NotifyRule {
  const parseArray = (val: string): string[] => {
    try { return JSON.parse(val) as string[]; } catch { return []; }
  };

  return {
    id: row.id,
    name: row.name,
    origins: parseArray(row.origins),
    destinations: parseArray(row.destinations),
    vehicle_types: parseArray(row.vehicleTypes),
    need: row.need,
    enabled: row.enabled === 1,
    fulfilled: row.fulfilled === 1,
    auto_accept: row.autoAccept === 1,
    auto_accepted: row.autoAccepted === 1,
  };
}

function ruleToDbRow(rule: NotifyRule) {
  return {
    id: rule.id,
    name: rule.name,
    origins: JSON.stringify(rule.origins),
    destinations: JSON.stringify(rule.destinations),
    vehicleTypes: JSON.stringify(rule.vehicle_types),
    need: rule.need,
    enabled: rule.enabled ? 1 : 0,
    fulfilled: rule.fulfilled ? 1 : 0,
    autoAccept: rule.auto_accept ? 1 : 0,
    autoAccepted: rule.auto_accepted ? 1 : 0,
  };
}

// ── File-based operations (DEV mode) ─────────────────────────────────────

function readRulesFile(): NotifyRule[] {
  if (!existsSync(RULES_FILE)) return [];
  try {
    const raw = readFileSync(RULES_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeRules(parsed);
  } catch {
    return [];
  }
}

function writeRulesFile(rules: NotifyRule[]): void {
  const normalized = normalizeRules(rules);
  const json = `${JSON.stringify(normalized, null, 2)}\n`;
  const tempFile = `${RULES_FILE}.tmp`;
  writeFileSync(tempFile, json, "utf8");
  try {
    renameSync(tempFile, RULES_FILE);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY") {
      writeFileSync(RULES_FILE, json, "utf8");
      try { unlinkSync(tempFile); } catch { /* cleanup */ }
    } else {
      throw err;
    }
  }
  sseBroadcaster.broadcast({ event: "rules", data: normalized });
}

// ── DB-based operations (PROD mode) ──────────────────────────────────────

async function readRulesDb(): Promise<NotifyRule[]> {
  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db.select().from(notifyRulesTable);
  return rows.map(dbRowToRule);
}

async function broadcastAllRules(): Promise<void> {
  const rules = await readRulesDb();
  sseBroadcaster.broadcast({ event: "rules", data: rules });
}

// ── Public API (dual mode) ───────────────────────────────────────────────

export async function readRules(): Promise<NotifyRule[]> {
  if (usesDb()) return readRulesDb();
  return readRulesFile();
}

export async function createRule(input: NotifyRuleInput): Promise<NotifyRule> {
  const normalized = normalizeRules([{ ...input, id: randomUUID() }])[0];

  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    await db.insert(notifyRulesTable).values({
      ...ruleToDbRow(normalized),
      createdAt: sql`UTC_TIMESTAMP()`,
      updatedAt: sql`UTC_TIMESTAMP()`,
    });
    await broadcastAllRules();
    return normalized;
  }

  const rules = readRulesFile();
  rules.push(normalized);
  writeRulesFile(rules);
  return normalized;
}

export async function updateRule(id: string, patch: NotifyRulePatch): Promise<NotifyRule | null> {
  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    const rows = await db.select().from(notifyRulesTable).where(eq(notifyRulesTable.id, id));
    if (rows.length === 0) return null;

    const existing = dbRowToRule(rows[0]);
    const updated = normalizeRules([{ ...existing, ...patch, id: existing.id }])[0];
    await db.update(notifyRulesTable)
      .set({ ...ruleToDbRow(updated), updatedAt: sql`UTC_TIMESTAMP()` })
      .where(eq(notifyRulesTable.id, id));
    await broadcastAllRules();
    return updated;
  }

  const rules = readRulesFile();
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return null;

  const updated = normalizeRules([{ ...rules[index], ...patch, id: rules[index].id }])[0];
  rules[index] = updated;
  writeRulesFile(rules);
  return updated;
}

export async function deleteRule(id: string): Promise<NotifyRule | null> {
  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    const rows = await db.select().from(notifyRulesTable).where(eq(notifyRulesTable.id, id));
    if (rows.length === 0) return null;

    const deleted = dbRowToRule(rows[0]);
    await db.delete(notifyRulesTable).where(eq(notifyRulesTable.id, id));
    await broadcastAllRules();
    return deleted;
  }

  const rules = readRulesFile();
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return null;

  const [deleted] = rules.splice(index, 1);
  writeRulesFile(rules);
  return deleted;
}

export async function matchRules(trips: TripLike[]): Promise<RuleMatch[]> {
  const ruleTrips = await matchRuleTrips(trips);
  return ruleTrips.map(({ ruleId, ruleName, matchedCount }) => ({ ruleId, ruleName, matchedCount }));
}

function ruleMatchesTrips(rule: NotifyRule, trips: TripLike[]): TripLike[] {
  return trips.filter((trip) => {
    const origin = normalize(trip.origin ?? trip["ต้นทาง"]);
    const destination = normalize(trip.destination ?? trip["ปลายทาง"]);
    const vehicleType = normalize(trip.vehicle_type ?? trip["ประเภทรถ"]);

    return matchesAny(origin, rule.origins)
      && matchesAny(destination, rule.destinations)
      && matchesAny(vehicleType, rule.vehicle_types);
  });
}

export async function matchRuleTrips(trips: TripLike[]): Promise<RuleTripMatch[]> {
  const rules = await readRules();
  const matches: RuleTripMatch[] = [];

  for (const rule of rules) {
    if (!rule.enabled || rule.fulfilled) continue;

    const matchedTrips = ruleMatchesTrips(rule, trips);

    if (matchedTrips.length >= Math.max(1, rule.need)) {
      matches.push({ ruleId: rule.id, ruleName: rule.name, matchedCount: matchedTrips.length, trips: matchedTrips, need: rule.need });
    }
  }

  return matches;
}

export async function matchAutoAcceptRuleTrips(trips: TripLike[]): Promise<RuleTripMatch[]> {
  const rules = await readRules();
  const matches: RuleTripMatch[] = [];

  for (const rule of rules) {
    if (!rule.enabled || rule.fulfilled || !rule.auto_accept || rule.auto_accepted) continue;

    const matchedTrips = ruleMatchesTrips(rule, trips);
    if (matchedTrips.length >= Math.max(1, rule.need)) {
      matches.push({ ruleId: rule.id, ruleName: rule.name, matchedCount: matchedTrips.length, trips: matchedTrips, need: rule.need });
    }
  }

  return matches;
}

export async function markRulesFulfilled(ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return;

  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    await db.update(notifyRulesTable)
      .set({ fulfilled: 1, updatedAt: sql`UTC_TIMESTAMP()` })
      .where(inArray(notifyRulesTable.id, ruleIds));
    await broadcastAllRules();
    return;
  }

  const rules = readRulesFile();
  const ids = new Set(ruleIds);
  let changed = false;
  for (const rule of rules) {
    if (!ids.has(rule.id) || rule.fulfilled) continue;
    rule.fulfilled = true;
    changed = true;
  }
  if (changed) writeRulesFile(rules);
}

export async function markRulesAutoAccepted(ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return;

  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    await db.update(notifyRulesTable)
      .set({ autoAccepted: 1, updatedAt: sql`UTC_TIMESTAMP()` })
      .where(inArray(notifyRulesTable.id, ruleIds));
    await broadcastAllRules();
    return;
  }

  const rules = readRulesFile();
  const ids = new Set(ruleIds);
  let changed = false;
  for (const rule of rules) {
    if (!ids.has(rule.id) || rule.auto_accepted) continue;
    rule.auto_accepted = true;
    changed = true;
  }
  if (changed) writeRulesFile(rules);
}

// ── Migration ────────────────────────────────────────────────────────────

/**
 * Migrate rules from notify-rules.json to the database.
 * Called once on startup when DB mode is active.
 * Existing DB rules take precedence.
 */
export async function migrateJsonToDb(): Promise<void> {
  if (!usesDb()) return;
  if (!existsSync(RULES_FILE)) return;

  await ensureDashboardTables();
  const db = await getDb();

  const existing = await db.select().from(notifyRulesTable);
  if (existing.length > 0) {
    logger.info("notify-rules-migration-skipped", { reason: "db-already-has-rules", count: existing.length });
    return;
  }

  try {
    const raw = readFileSync(RULES_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const rules = normalizeRules(parsed);

    if (rules.length === 0) return;

    for (const rule of rules) {
      await db.insert(notifyRulesTable).values({
        ...ruleToDbRow(rule),
        createdAt: sql`UTC_TIMESTAMP()`,
        updatedAt: sql`UTC_TIMESTAMP()`,
      });
    }

    logger.info("notify-rules-migrated", { count: rules.length, source: "notify-rules.json" });
  } catch (err) {
    logger.warn("notify-rules-migration-failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
