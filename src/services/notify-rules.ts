import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TripLike {
  origin?: string;
  destination?: string;
  vehicle_type?: string;
  "ต้นทาง"?: unknown;
  "ปลายทาง"?: unknown;
  "ประเภทรถ"?: unknown;
  request_id?: unknown;
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
}

export interface NotifyRuleInput {
  name: string;
  origins?: string[];
  destinations?: string[];
  vehicle_types?: string[];
  need?: number;
  enabled?: boolean;
  fulfilled?: boolean;
}

export type NotifyRulePatch = Partial<NotifyRuleInput>;

export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  matchedCount: number;
}

const RULES_FILE = resolve(process.cwd(), "notify-rules.json");

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
    }];
  });
}

export function readRules(): NotifyRule[] {
  if (!existsSync(RULES_FILE)) return [];

  try {
    const raw = readFileSync(RULES_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeRules(parsed);
  } catch {
    return [];
  }
}

function writeRules(rules: NotifyRule[]): void {
  const tempFile = `${RULES_FILE}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(normalizeRules(rules), null, 2)}\n`, "utf8");
  renameSync(tempFile, RULES_FILE);
}

export function createRule(input: NotifyRuleInput): NotifyRule {
  const rules = readRules();
  const rule = normalizeRules([{ ...input, id: randomUUID() }])[0];
  rules.push(rule);
  writeRules(rules);
  return rule;
}

export function updateRule(id: string, patch: NotifyRulePatch): NotifyRule | null {
  const rules = readRules();
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return null;

  const updated = normalizeRules([{ ...rules[index], ...patch, id: rules[index].id }])[0];
  rules[index] = updated;
  writeRules(rules);
  return updated;
}

export function deleteRule(id: string): NotifyRule | null {
  const rules = readRules();
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return null;

  const [deleted] = rules.splice(index, 1);
  writeRules(rules);
  return deleted;
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

export function matchRules(trips: TripLike[]): RuleMatch[] {
  const rules = readRules();
  const matches: RuleMatch[] = [];

  for (const [index, rule] of rules.entries()) {
    if (!rule.enabled || rule.fulfilled) continue;

    const matchedTrips = trips.filter((trip) => {
      const origin = normalize(trip.origin ?? trip["ต้นทาง"]);
      const destination = normalize(trip.destination ?? trip["ปลายทาง"]);
      const vehicleType = normalize(trip.vehicle_type ?? trip["ประเภทรถ"]);

      return matchesAny(origin, rule.origins)
        && matchesAny(destination, rule.destinations)
        && matchesAny(vehicleType, rule.vehicle_types);
    });

    if (matchedTrips.length >= Math.max(1, rule.need)) {
      matches.push({ ruleId: rule.id, ruleName: rule.name, matchedCount: matchedTrips.length });
    }
  }

  return matches;
}

export function markRulesFulfilled(ruleIds: string[]): void {
  if (ruleIds.length === 0) return;

  const rules = readRules();
  let changed = false;
  const ids = new Set(ruleIds);

  for (const rule of rules) {
    if (!ids.has(rule.id) || rule.fulfilled) continue;
    rule.fulfilled = true;
    changed = true;
  }

  if (changed) {
    writeRules(rules);
  }
}
