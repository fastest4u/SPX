import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, ensureDashboardTables } from "../db/client.js";
import { notifyRules as notifyRulesTable, teams as teamsTable } from "../db/schema.js";
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
  teamId?: number;
  teamName?: string;
  name: string;
  origins: string[];
  destinations: string[];
  vehicle_types: string[];
  need: number;
  enabled: boolean;
  fulfilled: boolean;
  /** Always true — every enabled rule auto-accepts. Kept on the wire for backward compat. */
  auto_accept: true;
  /** When true, the auto-accept path submits SPX accept_all for the matched booking. */
  accept_all: boolean;
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
  accept_all?: boolean;
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
  acceptAll: boolean;
}

export interface BookingNameRoute {
  origin: string;
  destination: string;
}

export interface AcceptAllBookingNameRuleMatch extends RuleMatch, BookingNameRoute {
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
const RULES_CACHE_STALE_FILL_RETRIES = 3;
const currentTimestamp = sql`CURRENT_TIMESTAMP`;

let rulesCache = new Map<number, { rules: NotifyRule[]; fromDb: boolean; expiresAt: number }>();
const rulesCacheFill = new Map<number, Promise<NotifyRule[]>>();
// Bumped on every writer refresh/invalidate. An in-flight cache fill captures
// the generation at SELECT start and discards its result if a writer
// committed meanwhile — otherwise a stale fill could resurrect a just-deleted
// rule for up to RULES_CACHE_TTL_MS.
let rulesCacheGeneration = 0;

function cacheKey(teamId: number, fromDb: boolean): number {
  return fromDb ? teamId : 1;
}

function setRulesCache(teamId: number, rules: NotifyRule[], fromDb: boolean): void {
  rulesCacheGeneration += 1;
  rulesCache.set(cacheKey(teamId, fromDb), { rules, fromDb, expiresAt: Date.now() + RULES_CACHE_TTL_MS });
}

function invalidateRulesCache(teamId?: number): void {
  rulesCacheGeneration += 1;
  if (typeof teamId === "number") {
    rulesCache.delete(teamId);
    return;
  }
  rulesCache = new Map();
}

function getFreshRulesCache(teamId: number, fromDb: boolean): NotifyRule[] | null {
  const cached = rulesCache.get(cacheKey(teamId, fromDb));
  if (!cached || cached.fromDb !== fromDb || Date.now() >= cached.expiresAt) {
    return null;
  }
  return cached.rules;
}

// ── Utils ────────────────────────────────────────────────────────────────

function usesDb(): boolean {
  return env.DB_MODE === "memory"
    || ((env.SAVE_TO_DB || env.HTTP_ENABLED || env.AUTO_ACCEPT_ENABLED) && env.NODE_ENV === "production");
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
      accept_all: candidate.accept_all === true,
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

// Pre-compiled filter. `hasFilter` preserves the original "no filter ⇒ match
// anything" semantics off the RAW array length, while `needles` are NFKC-
// normalized once (rule needles are constant) instead of being re-normalized on
// every trip × rule comparison on the auto-accept hot path. hasFilter true with
// an empty needles list (filter present but all-whitespace) ⇒ matches nothing.
interface CompiledFilter {
  hasFilter: boolean;
  needles: string[];
}

interface CompiledRuleFilters {
  origins: CompiledFilter;
  destinations: CompiledFilter;
  vehicleTypes: CompiledFilter;
}

interface CompiledTrip {
  origin: string;
  destination: string;
  vehicleType: string;
  trip: TripLike;
}

function compileFilter(values: string[]): CompiledFilter {
  const needles: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized.length > 0) needles.push(normalized);
  }
  return { hasFilter: values.length > 0, needles };
}

// Rule objects are immutable once cached (writers replace the array wholesale,
// never mutate entries), so a WeakMap keyed by the rule reuses one compilation
// across every booking/trip within a tick and is GC'd when the cache refreshes.
const compiledRuleCache = new WeakMap<NotifyRule, CompiledRuleFilters>();

function compileRuleFilters(rule: NotifyRule): CompiledRuleFilters {
  const cached = compiledRuleCache.get(rule);
  if (cached) return cached;
  const compiled: CompiledRuleFilters = {
    origins: compileFilter(rule.origins),
    destinations: compileFilter(rule.destinations),
    vehicleTypes: compileFilter(rule.vehicle_types),
  };
  compiledRuleCache.set(rule, compiled);
  return compiled;
}

function compileTrip(trip: TripLike): CompiledTrip {
  return {
    origin: normalize(trip.origin ?? trip["ต้นทาง"]),
    destination: normalize(trip.destination ?? trip["ปลายทาง"]),
    vehicleType: normalize(trip.vehicle_type ?? trip["ประเภทรถ"]),
    trip,
  };
}

function matchesCompiledFilter(haystack: string, filter: CompiledFilter): boolean {
  if (!filter.hasFilter) return true;
  for (const needle of filter.needles) {
    if (haystack.includes(needle)) return true;
  }
  return false;
}

function compiledTripMatchesRule(compiled: CompiledTrip, filters: CompiledRuleFilters): boolean {
  return matchesCompiledFilter(compiled.origin, filters.origins)
    && matchesCompiledFilter(compiled.destination, filters.destinations)
    && matchesCompiledFilter(compiled.vehicleType, filters.vehicleTypes);
}

function compiledRouteMatchesRule(route: BookingNameRoute, filters: CompiledRuleFilters): boolean {
  return matchesCompiledFilter(normalize(route.origin), filters.origins)
    && matchesCompiledFilter(normalize(route.destination), filters.destinations);
}

function collectRuleMatchedTrips(filters: CompiledRuleFilters, compiledTrips: CompiledTrip[]): TripLike[] {
  const matched: TripLike[] = [];
  for (const compiled of compiledTrips) {
    if (compiledTripMatchesRule(compiled, filters)) matched.push(compiled.trip);
  }
  return matched;
}

// ── DB row converters ────────────────────────────────────────────────────

type DbRow = typeof notifyRulesTable.$inferSelect;

function withRuleTeam(rule: NotifyRule, teamId: number, teamName?: string | null): NotifyRule {
  return {
    ...rule,
    teamId,
    ...(teamName ? { teamName } : {}),
  };
}

function dbRowToRule(row: DbRow, teamName?: string | null): NotifyRule {
  const parseArray = (val: string): string[] => {
    try { return JSON.parse(val) as string[]; } catch { return []; }
  };

  const need = Math.max(0, row.need);
  const enabled = row.enabled === 1;
  const completed = need === 0;

  return {
    id: row.id,
    teamId: row.teamId,
    ...(teamName ? { teamName } : {}),
    name: row.name,
    origins: parseArray(row.origins),
    destinations: parseArray(row.destinations),
    vehicle_types: parseArray(row.vehicleTypes),
    need,
    enabled,
    fulfilled: completed,
    // Every rule auto-accepts. DB column kept for backward compatibility.
    auto_accept: true,
    accept_all: row.acceptAll === 1,
    auto_accepted: completed && row.autoAccepted === 1,
  };
}

function ruleToDbRow(teamId: number, rule: NotifyRule) {
  return {
    id: rule.id,
    teamId,
    name: rule.name,
    origins: JSON.stringify(rule.origins),
    destinations: JSON.stringify(rule.destinations),
    vehicleTypes: JSON.stringify(rule.vehicle_types),
    need: rule.need,
    enabled: rule.enabled ? 1 : 0,
    fulfilled: rule.fulfilled ? 1 : 0,
    autoAccept: 1,
    acceptAll: rule.accept_all ? 1 : 0,
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
  setRulesCache(1, normalized, false);
  sseBroadcaster.broadcast({ event: "rules", data: normalized });
}

// ── DB-based operations (PROD mode) ──────────────────────────────────────

async function readRulesDb(teamId: number): Promise<NotifyRule[]> {
  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db.select().from(notifyRulesTable).where(eq(notifyRulesTable.teamId, teamId));
  return rows.map(dbRowToRule);
}

async function readRulesDbAllTeams(): Promise<NotifyRule[]> {
  await ensureDashboardTables();
  const db = await getDb();
  const rows = await db
    .select({ rule: notifyRulesTable, teamName: teamsTable.name })
    .from(notifyRulesTable)
    .leftJoin(teamsTable, eq(notifyRulesTable.teamId, teamsTable.id));
  return rows.map((row: { rule: DbRow; teamName: string | null }) => dbRowToRule(row.rule, row.teamName));
}

async function getTeamName(teamId: number): Promise<string | undefined> {
  if (!usesDb()) return undefined;
  await ensureDashboardTables();
  const db = await getDb();
  const [team] = await db.select({ name: teamsTable.name }).from(teamsTable).where(eq(teamsTable.id, teamId)).limit(1);
  return team?.name;
}

async function readRulesDbForCacheFill(teamId: number): Promise<NotifyRule[]> {
  for (let attempt = 0; attempt < RULES_CACHE_STALE_FILL_RETRIES; attempt += 1) {
    const generationAtReadStart = rulesCacheGeneration;
    const rules = await readRulesDb(teamId);

    if (rulesCacheGeneration === generationAtReadStart) {
      setRulesCache(teamId, rules, true);
      return rules;
    }

    // A writer committed and refreshed while our SELECT was in flight. Return
    // that newer cache to callers instead of handing back this stale snapshot.
    const freshCache = getFreshRulesCache(teamId, true);
    if (freshCache) return freshCache;
  }

  logger.warn("notify-rules-cache-fill-retried", {
    retries: RULES_CACHE_STALE_FILL_RETRIES,
  });

  const generationAtFinalReadStart = rulesCacheGeneration;
  const rules = await readRulesDb(teamId);
  if (rulesCacheGeneration === generationAtFinalReadStart) {
    setRulesCache(teamId, rules, true);
  }
  return rules;
}

async function broadcastAllRules(teamId: number): Promise<void> {
  // Called right after a writer commit. Invalidate first so no reader serves
  // pre-commit data, then refresh — but install the SELECT result only if no
  // newer writer invalidated meanwhile: two writers' SELECTs can resolve out
  // of order on different pool connections, and the loser must not resurrect
  // a just-decremented or just-deleted rule on the auto-accept path.
  invalidateRulesCache(teamId);
  const generationAtRefreshStart = rulesCacheGeneration;
  const rules = await readRulesDb(teamId);
  if (rulesCacheGeneration === generationAtRefreshStart) {
    setRulesCache(teamId, rules, true);
  }
  sseBroadcaster.broadcast({ event: "rules", teamId, data: rules });
}

// ── Public API (dual mode) ───────────────────────────────────────────────

export async function readRules(teamId: number): Promise<NotifyRule[]> {
  const fromDb = usesDb();
  const cachedRules = getFreshRulesCache(teamId, fromDb);
  if (cachedRules) return cachedRules;

  if (!fromDb) {
    const rules = readRulesFile();
    setRulesCache(teamId, rules, false);
    return rules;
  }

  // Single-flight: concurrent cache misses (poller tick + HTTP handlers)
  // share one SELECT instead of stampeding the DB.
  if (!rulesCacheFill.has(teamId)) {
    rulesCacheFill.set(teamId, readRulesDbForCacheFill(teamId)
      .finally(() => {
        rulesCacheFill.delete(teamId);
      }));
  }
  return rulesCacheFill.get(teamId)!;
}

export async function readRulesForScope(teamId: number | null): Promise<NotifyRule[]> {
  if (teamId === null) {
    if (!usesDb()) return readRulesFile().map((rule) => withRuleTeam(rule, 1));
    return readRulesDbAllTeams();
  }

  const rules = await readRules(teamId);
  const teamName = await getTeamName(teamId);
  return rules.map((rule) => withRuleTeam(rule, teamId, teamName));
}

export async function getRuleTeamId(id: string): Promise<number | null> {
  if (!usesDb()) {
    return readRulesFile().some((rule) => rule.id === id) ? 1 : null;
  }

  await ensureDashboardTables();
  const db = await getDb();
  const [row] = await db.select({ teamId: notifyRulesTable.teamId }).from(notifyRulesTable).where(eq(notifyRulesTable.id, id)).limit(1);
  return row?.teamId ?? null;
}

export async function createRule(teamId: number, input: NotifyRuleInput): Promise<NotifyRule> {
  const normalized = normalizeRules([{ ...input, id: randomUUID() }])[0];

  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    await db.insert(notifyRulesTable).values({
      ...ruleToDbRow(teamId, normalized),
      createdAt: currentTimestamp,
      updatedAt: currentTimestamp,
    });
    await broadcastAllRules(teamId);
    return withRuleTeam(normalized, teamId, await getTeamName(teamId));
  }

  const rules = readRulesFile();
  rules.push(normalized);
  writeRulesFile(rules);
  return withRuleTeam(normalized, 1);
}

export async function updateRule(teamId: number, id: string, patch: NotifyRulePatch): Promise<NotifyRule | null> {
  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    const rows = await db.select().from(notifyRulesTable).where(and(eq(notifyRulesTable.teamId, teamId), eq(notifyRulesTable.id, id)));
    if (rows.length === 0) return null;

    const existing = dbRowToRule(rows[0]);
    const updated = normalizeRules([{ ...existing, ...patch, id: existing.id }])[0];
    await db.update(notifyRulesTable)
      .set({ ...ruleToDbRow(teamId, updated), updatedAt: currentTimestamp })
      .where(and(eq(notifyRulesTable.teamId, teamId), eq(notifyRulesTable.id, id)));
    await broadcastAllRules(teamId);
    return withRuleTeam(updated, teamId, await getTeamName(teamId));
  }

  const rules = readRulesFile();
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return null;

  const updated = normalizeRules([{ ...rules[index], ...patch, id: rules[index].id }])[0];
  rules[index] = updated;
  writeRulesFile(rules);
  return withRuleTeam(updated, 1);
}

export async function deleteRule(teamId: number, id: string): Promise<NotifyRule | null> {
  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    const rows = await db.select().from(notifyRulesTable).where(and(eq(notifyRulesTable.teamId, teamId), eq(notifyRulesTable.id, id)));
    if (rows.length === 0) return null;

    const deleted = dbRowToRule(rows[0]);
    await db.delete(notifyRulesTable).where(and(eq(notifyRulesTable.teamId, teamId), eq(notifyRulesTable.id, id)));
    await broadcastAllRules(teamId);
    return withRuleTeam(deleted, teamId, await getTeamName(teamId));
  }

  const rules = readRulesFile();
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return null;

  const [deleted] = rules.splice(index, 1);
  writeRulesFile(rules);
  return withRuleTeam(deleted, 1);
}

export async function matchRules(teamId: number, trips: TripLike[]): Promise<RuleMatch[]> {
  const ruleTrips = await matchRuleTrips(teamId, trips);
  return ruleTrips.map(({ ruleId, ruleName, matchedCount }) => ({ ruleId, ruleName, matchedCount }));
}

export async function getActiveAutoAcceptRules(teamId: number): Promise<NotifyRule[]> {
  const rules = await readRules(teamId);
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
  return collectRuleMatchedTrips(compileRuleFilters(rule), trips.map(compileTrip));
}

export async function matchRuleTrips(teamId: number, trips: TripLike[]): Promise<RuleTripMatch[]> {
  const rules = await readRules(teamId);
  const matches: RuleTripMatch[] = [];
  // Compile trips once and reuse across every rule (normalization is the hot cost).
  let compiledTrips: CompiledTrip[] | null = null;

  for (const rule of rules) {
    if (!rule.enabled || rule.fulfilled) continue;
    if (!compiledTrips) compiledTrips = trips.map(compileTrip);

    const matchedTrips = collectRuleMatchedTrips(compileRuleFilters(rule), compiledTrips);

    if (matchedTrips.length >= Math.max(1, rule.need)) {
      matches.push({ ruleId: rule.id, ruleName: rule.name, matchedCount: matchedTrips.length, trips: matchedTrips, need: rule.need, acceptAll: rule.accept_all });
    }
  }

  return matches;
}

export function previewRuleAgainstTrips(input: NotifyRuleInput, trips: TripLike[], sampleLimit = 10): RulePreviewResult {
  const rule = normalizeRules([{ ...input, id: "preview" }])[0];
  if (!rule) {
    return { ruleId: "preview", ruleName: "", matchedCount: 0, trips: [], need: 1, acceptAll: false, sampleSize: trips.length, wouldMatch: false };
  }

  const matchedTrips = ruleMatchesTrips(rule, trips);
  const need = Math.max(1, rule.need);
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matchedCount: matchedTrips.length,
    trips: matchedTrips.slice(0, Math.max(1, sampleLimit)),
    need,
    acceptAll: rule.accept_all,
    sampleSize: trips.length,
    wouldMatch: matchedTrips.length >= need,
  };
}

export function matchAutoAcceptRuleTripsWithRules(trips: TripLike[], rules: NotifyRule[]): RuleTripMatch[] {
  const matches: RuleTripMatch[] = [];
  // Compile trips once and reuse across every rule (normalization is the hot cost).
  let compiledTrips: CompiledTrip[] | null = null;

  for (const rule of rules) {
    if (!rule.enabled || rule.fulfilled || rule.need <= 0) continue;
    if (!compiledTrips) compiledTrips = trips.map(compileTrip);

    const matchedTrips = collectRuleMatchedTrips(compileRuleFilters(rule), compiledTrips);
    if (matchedTrips.length > 0) {
      matches.push({ ruleId: rule.id, ruleName: rule.name, matchedCount: matchedTrips.length, trips: matchedTrips, need: rule.need, acceptAll: rule.accept_all });
    }
  }

  return matches;
}

export function parseBookingNameRoute(bookingName: string): BookingNameRoute | null {
  const routeText = bookingName
    .normalize("NFKC")
    .trim()
    .replace(/^\s*(?:\[[^\]]+\]\s*)+/, "");
  const match = routeText.match(/^(.+?)\s*>\s*(.+?)(?:\s+\d{4}-\d{2}-\d{2}\b|$)/);
  if (!match) return null;

  const origin = match[1]?.trim() ?? "";
  const destination = match[2]?.trim() ?? "";
  return origin && destination ? { origin, destination } : null;
}

export function matchAcceptAllBookingNameRules(
  bookingName: string,
  rules: NotifyRule[]
): AcceptAllBookingNameRuleMatch[] {
  const route = parseBookingNameRoute(bookingName);
  if (!route) return [];

  const matches: AcceptAllBookingNameRuleMatch[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.fulfilled || rule.need <= 0 || !rule.accept_all) continue;
    if (!compiledRouteMatchesRule(route, compileRuleFilters(rule))) continue;
    matches.push({
      ruleId: rule.id,
      ruleName: rule.name,
      matchedCount: 1,
      need: rule.need,
      origin: route.origin,
      destination: route.destination,
    });
  }
  return matches;
}

export async function matchAutoAcceptRuleTrips(teamId: number, trips: TripLike[]): Promise<RuleTripMatch[]> {
  return matchAutoAcceptRuleTripsWithRules(trips, await readRules(teamId));
}

export async function getActiveAutoAcceptOriginFilters(teamId: number): Promise<string[]> {
  return getAutoAcceptOriginFilters(await getActiveAutoAcceptRules(teamId));
}

export async function applyAutoAcceptProgress(
  teamId: number,
  updates: Array<{ ruleId: string; acceptedCount: number }>,
  onRuleCommitted?: (ruleId: string, acceptedCount: number) => void
): Promise<void> {
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
    const touchedTeamIds = new Set<number>();
    // Atomic per-rule decrement: compute need inside SQL so concurrent
    // auto-accept tasks cannot lose updates via read-modify-write (two tasks both
    // reading need=5 and the later write clobbering the earlier). Completion is
    // synced in a second statement from the post-decrement need; MySQL evaluates
    // single-table SET assignments left-to-right, so deriving fulfilled in the
    // same SET list can mark need=2 accepted=1 as complete after need becomes 1.
    // CASE WHEN is used instead of GREATEST so the statement runs on both MySQL
    // and the in-memory SQLite backend used in tests.
    // Per-rule isolation: one rule's failed UPDATE must not block the other
    // rules' decrements (or their budget settlement via onRuleCommitted).
    const affectedRows = (result: unknown): number | null => {
      if (Array.isArray(result)) return affectedRows(result[0]);
      if (!result || typeof result !== "object") return null;
      const record = result as Record<string, unknown>;
      for (const key of ["affectedRows", "changes", "rowsAffected"]) {
        if (typeof record[key] === "number") return record[key] as number;
      }
      return null;
    };

    const decrementRuleNeed = (whereClause: ReturnType<typeof and> | ReturnType<typeof eq>, accepted: number) =>
      db.update(notifyRulesTable)
        .set({
          need: sql`CASE WHEN ${notifyRulesTable.need} > ${accepted} THEN ${notifyRulesTable.need} - ${accepted} ELSE 0 END`,
          updatedAt: currentTimestamp,
        })
        .where(whereClause);

    const syncRuleCompletion = (whereClause: ReturnType<typeof and> | ReturnType<typeof eq>) =>
      db.update(notifyRulesTable)
        .set({
          fulfilled: sql`CASE WHEN ${notifyRulesTable.need} <= 0 THEN 1 ELSE 0 END`,
          autoAccepted: sql`CASE WHEN ${notifyRulesTable.need} <= 0 THEN 1 ELSE 0 END`,
          updatedAt: currentTimestamp,
        })
        .where(whereClause);

    for (const [ruleId, accepted] of acceptedByRule) {
      try {
        const scopedWhere = and(eq(notifyRulesTable.teamId, teamId), eq(notifyRulesTable.id, ruleId));
        const scopedResult = await decrementRuleNeed(scopedWhere, accepted);
        let committedTeamId: number | null = affectedRows(scopedResult) === 0 ? null : teamId;

        if (committedTeamId === null) {
          const [owner] = await db
            .select({ teamId: notifyRulesTable.teamId })
            .from(notifyRulesTable)
            .where(eq(notifyRulesTable.id, ruleId))
            .limit(1);

          if (owner) {
            logger.warn("auto-accept-progress-team-scope-mismatch", {
              ruleId,
              accepted,
              attemptedTeamId: teamId,
              actualTeamId: owner.teamId,
            });
            const ownerWhere = and(eq(notifyRulesTable.teamId, owner.teamId), eq(notifyRulesTable.id, ruleId));
            const ownerResult = await decrementRuleNeed(ownerWhere, accepted);
            committedTeamId = affectedRows(ownerResult) === 0 ? null : owner.teamId;
            if (committedTeamId !== null) {
              await syncRuleCompletion(ownerWhere);
            }
          }
        } else {
          await syncRuleCompletion(scopedWhere);
        }

        if (committedTeamId === null) {
          logger.error("auto-accept-progress-update-missed", { ruleId, accepted, teamId });
          continue;
        }

        touchedTeamIds.add(committedTeamId);
        onRuleCommitted?.(ruleId, accepted);
      } catch (err) {
        // Lost quota decrement on the money path: the upstream accept already
        // committed but the rule's need was not reduced. The caller's budget
        // claims stay in flight (settle skipped) until the claim TTL.
        logger.error("auto-accept-progress-update-failed", {
          ruleId,
          accepted,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const touchedTeamId of touchedTeamIds) {
      await broadcastAllRules(touchedTeamId);
    }
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
  for (const [ruleId, accepted] of acceptedByRule) {
    onRuleCommitted?.(ruleId, accepted);
  }
}

export async function markRulesFulfilled(teamId: number, ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return;

  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    await db.update(notifyRulesTable)
      .set({ fulfilled: 1, updatedAt: currentTimestamp })
      .where(and(eq(notifyRulesTable.teamId, teamId), inArray(notifyRulesTable.id, ruleIds)));
    await broadcastAllRules(teamId);
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

export async function markRulesAutoAccepted(teamId: number, ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return;

  if (usesDb()) {
    await ensureDashboardTables();
    const db = await getDb();
    await db.update(notifyRulesTable)
      .set({ autoAccepted: 1, updatedAt: currentTimestamp })
      .where(and(eq(notifyRulesTable.teamId, teamId), inArray(notifyRulesTable.id, ruleIds)));
    await broadcastAllRules(teamId);
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
      ...ruleToDbRow(1, rule),
      createdAt: currentTimestamp,
      updatedAt: currentTimestamp,
    })));

    invalidateRulesCache();
    logger.info("notify-rules-migrated", { count: rules.length, source: "notify-rules.json" });
  } catch (err) {
    logger.warn("notify-rules-migration-failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
