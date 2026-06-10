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
  /** Always true — every enabled rule auto-accepts. Kept on the wire for backward compat. */
  auto_accept: true;
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

export interface RulePreviewResult extends RuleTripMatch {
  sampleSize: number;
  wouldMatch: boolean;
}

const RULES_FILE = resolve(process.cwd(), "notify-rules.json");

// ── Rules cache ──────────────────────────────────────────────────────────
// readRules() sits on the poller's critical path: it is awaited every tick
// before any booking-detail fetch launches, so DB mode must not pay a SELECT
// per tick. Every writer in this module refreshes the cache synchronously
// after committing; the short TTL is only a safety net for out-of-band
// writes (manual SQL edits, another process sharing the DB).
const RULES_CACHE_TTL_MS = 5_000;

let rulesCache: { rules: NotifyRule[]; fromDb: boolean; expiresAt: number } | null = null;
let rulesCacheFill: Promise<NotifyRule[]> | null = null;
// Bumped on every writer refresh/invalidate. An in-flight cache fill captures
// the generation at SELECT start and discards its result if a writer
// committed meanwhile — otherwise a stale fill could resurrect a just-deleted
// rule for up to RULES_CACHE_TTL_MS.
let rulesCacheGeneration = 0;

function setRulesCache(rules: NotifyRule[], fromDb: boolean): void {
  rulesCacheGeneration += 1;
  rulesCache = { rules, fromDb, expiresAt: Date.now() + RULES_CACHE_TTL_MS };
}

function invalidateRulesCache(): void {
  rulesCacheGeneration += 1;
  rulesCache = null;
}

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

    const enabled = candidate.enabled !== false;

    return [{
      id,
      name,
      origins: toStringArray(candidate.origins),
      destinations: toStringArray(candidate.destinations),
      vehicle_types: toStringArray(candidate.vehicle_types),
      need: Math.max(0, need),
      enabled,
      fulfilled: candidate.fulfilled === true,
      // Every rule auto-accepts. Field is kept only for wire compatibility.
      auto_accept: true,
      auto_accepted: candidate.auto_accepted === true,
    }];
  });
}

function normalize(value: unknown): string {
  // NFKC, not NFC: Thai SARA AM (ำ U+0E33) vs NIKHAHIT+SARA AA (U+0E4D
  // U+0E32) is a *compatibility* equivalence — only NFKC unifies them.
  // Without this a rule pasted in one form silently never matches API data
  // in the other. NFKC also folds fullwidth/ligature forms, which is what we
  // want for match keys.
  return typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
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

  const enabled = row.enabled === 1;

  return {
    id: row.id,
    name: row.name,
    origins: parseArray(row.origins),
    destinations: parseArray(row.destinations),
    vehicle_types: parseArray(row.vehicleTypes),
    need: row.need,
    enabled,
    fulfilled: row.fulfilled === 1,
    // Every rule auto-accepts. DB column kept for backward compatibility.
    auto_accept: true,
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
    autoAccept: 1,
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
  setRulesCache(normalized, false);
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
  // Called right after a writer commit. Invalidate first so no reader serves
  // pre-commit data, then refresh — but install the SELECT result only if no
  // newer writer invalidated meanwhile: two writers' SELECTs can resolve out
  // of order on different pool connections, and the loser must not resurrect
  // a just-decremented or just-deleted rule on the auto-accept path.
  invalidateRulesCache();
  const generationAtRefreshStart = rulesCacheGeneration;
  const rules = await readRulesDb();
  if (rulesCacheGeneration === generationAtRefreshStart) {
    setRulesCache(rules, true);
  }
  sseBroadcaster.broadcast({ event: "rules", data: rules });
}

// ── Public API (dual mode) ───────────────────────────────────────────────

export async function readRules(): Promise<NotifyRule[]> {
  const fromDb = usesDb();
  if (rulesCache && rulesCache.fromDb === fromDb && Date.now() < rulesCache.expiresAt) {
    return rulesCache.rules;
  }

  if (!fromDb) {
    const rules = readRulesFile();
    setRulesCache(rules, false);
    return rules;
  }

  // Single-flight: concurrent cache misses (poller tick + HTTP handlers)
  // share one SELECT instead of stampeding the DB.
  if (!rulesCacheFill) {
    const generationAtFillStart = rulesCacheGeneration;
    rulesCacheFill = readRulesDb()
      .then((rules) => {
        // A writer refreshed the cache while this SELECT was in flight; its
        // data is newer than this read — don't clobber it.
        if (rulesCacheGeneration === generationAtFillStart) {
          setRulesCache(rules, true);
        }
        return rules;
      })
      .finally(() => {
        rulesCacheFill = null;
      });
  }
  return rulesCacheFill;
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

export async function getActiveAutoAcceptRules(): Promise<NotifyRule[]> {
  const rules = await readRules();
  return rules.filter((rule) =>
    rule.enabled && !rule.fulfilled && rule.need > 0
  );
}

export function getAutoAcceptOriginFilters(rules: NotifyRule[]): string[] {
  const origins = new Set<string>();

  for (const rule of rules) {
    if (!rule.enabled || rule.fulfilled || rule.need <= 0) continue;
    if (rule.origins.length === 0) return [];

    for (const origin of rule.origins) {
      const normalized = normalize(origin);
      if (normalized.length > 0) origins.add(normalized);
    }
  }

  return [...origins];
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

export function previewRuleAgainstTrips(input: NotifyRuleInput, trips: TripLike[], sampleLimit = 10): RulePreviewResult {
  const rule = normalizeRules([{ ...input, id: "preview" }])[0];
  if (!rule) {
    return { ruleId: "preview", ruleName: "", matchedCount: 0, trips: [], need: 1, sampleSize: trips.length, wouldMatch: false };
  }

  const matchedTrips = ruleMatchesTrips(rule, trips);
  const need = Math.max(1, rule.need);
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matchedCount: matchedTrips.length,
    trips: matchedTrips.slice(0, Math.max(1, sampleLimit)),
    need,
    sampleSize: trips.length,
    wouldMatch: matchedTrips.length >= need,
  };
}

export function matchAutoAcceptRuleTripsWithRules(trips: TripLike[], rules: NotifyRule[]): RuleTripMatch[] {
  const matches: RuleTripMatch[] = [];

  for (const rule of rules) {
    if (!rule.enabled || rule.fulfilled || rule.need <= 0) continue;

    const matchedTrips = ruleMatchesTrips(rule, trips);
    if (matchedTrips.length > 0) {
      matches.push({ ruleId: rule.id, ruleName: rule.name, matchedCount: matchedTrips.length, trips: matchedTrips, need: rule.need });
    }
  }

  return matches;
}

export async function matchAutoAcceptRuleTrips(trips: TripLike[]): Promise<RuleTripMatch[]> {
  return matchAutoAcceptRuleTripsWithRules(trips, await readRules());
}

export async function getActiveAutoAcceptOriginFilters(): Promise<string[]> {
  return getAutoAcceptOriginFilters(await getActiveAutoAcceptRules());
}

export async function applyAutoAcceptProgress(updates: Array<{ ruleId: string; acceptedCount: number }>): Promise<void> {
  const acceptedByRule = new Map<string, number>();
  for (const update of updates) {
    if (update.acceptedCount <= 0) continue;
    acceptedByRule.set(update.ruleId, (acceptedByRule.get(update.ruleId) ?? 0) + update.acceptedCount);
  }
  const ruleIds = [...acceptedByRule.keys()];
  if (ruleIds.length === 0) return;

  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    // Atomic per-rule decrement: compute need/fulfilled inside SQL so concurrent
    // auto-accept tasks cannot lose updates via read-modify-write (two tasks both
    // reading need=5 and the later write clobbering the earlier). CASE WHEN is
    // used instead of GREATEST so the statement runs on both MySQL and the
    // in-memory SQLite backend used in tests.
    for (const [ruleId, accepted] of acceptedByRule) {
      await db.update(notifyRulesTable)
        .set({
          need: sql`CASE WHEN ${notifyRulesTable.need} > ${accepted} THEN ${notifyRulesTable.need} - ${accepted} ELSE 0 END`,
          fulfilled: sql`CASE WHEN ${notifyRulesTable.need} <= ${accepted} THEN 1 ELSE 0 END`,
          autoAccepted: sql`CASE WHEN ${notifyRulesTable.need} <= ${accepted} THEN 1 ELSE 0 END`,
          updatedAt: sql`UTC_TIMESTAMP()`,
        })
        .where(eq(notifyRulesTable.id, ruleId));
    }
    await broadcastAllRules();
    return;
  }

  const rules = readRulesFile();
  let changed = false;
  for (const rule of rules) {
    const acceptedCount = acceptedByRule.get(rule.id);
    if (acceptedCount === undefined) continue;
    const remainingNeed = Math.max(0, rule.need - acceptedCount);
    const completed = remainingNeed === 0;
    rule.need = remainingNeed;
    rule.fulfilled = completed;
    rule.auto_accepted = completed;
    changed = true;
  }
  if (changed) writeRulesFile(rules);
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

    await db.insert(notifyRulesTable).values(rules.map((rule) => ({
      ...ruleToDbRow(rule),
      createdAt: sql`UTC_TIMESTAMP()`,
      updatedAt: sql`UTC_TIMESTAMP()`,
    })));

    invalidateRulesCache();
    logger.info("notify-rules-migrated", { count: rules.length, source: "notify-rules.json" });
  } catch (err) {
    logger.warn("notify-rules-migration-failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
