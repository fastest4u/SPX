import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type TripLike = {
  origin?: string;
  destination?: string;
  vehicle_type?: string;
  "ต้นทาง"?: unknown;
  "ปลายทาง"?: unknown;
  "ประเภทรถ"?: unknown;
  [key: string]: unknown;
};

export type NotifyRule = {
  name: string;
  origins: string[];
  destinations: string[];
  vehicle_types: string[];
  need: number;
  enabled: boolean;
  fulfilled: boolean;
};

export type RuleMatch = {
  ruleIndex: number;
  ruleName: string;
  matchedCount: number;
};

const RULES_FILE = resolve(process.cwd(), "notify-rules.json");

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readRules(): NotifyRule[] {
  if (!existsSync(RULES_FILE)) return [];

  try {
    const raw = readFileSync(RULES_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((rule): NotifyRule[] => {
      if (!rule || typeof rule !== "object") return [];

      const candidate = rule as Record<string, unknown>;
      const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
      const need = typeof candidate.need === "number" && Number.isInteger(candidate.need) ? candidate.need : 1;

      if (!name) return [];

      return [{
        name,
        origins: toStringArray(candidate.origins),
        destinations: toStringArray(candidate.destinations),
        vehicle_types: toStringArray(candidate.vehicle_types),
        need: Math.max(1, need),
        enabled: candidate.enabled !== false,
        fulfilled: candidate.fulfilled === true,
      }];
    });
  } catch {
    return [];
  }
}

function writeRules(rules: NotifyRule[]): void {
  const tempFile = `${RULES_FILE}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
  renameSync(tempFile, RULES_FILE);
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function tripField(trip: TripLike, primaryKey: string, fallbackKey: string): string {
  return normalize(trip[primaryKey] ?? trip[fallbackKey]);
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
      const origin = tripField(trip, "origin", "ต้นทาง");
      const destination = tripField(trip, "destination", "ปลายทาง");
      const vehicleType = tripField(trip, "vehicle_type", "ประเภทรถ");

      return matchesAny(origin, rule.origins)
        && matchesAny(destination, rule.destinations)
        && matchesAny(vehicleType, rule.vehicle_types);
    });

    if (matchedTrips.length >= Math.max(1, rule.need)) {
      matches.push({ ruleIndex: index, ruleName: rule.name, matchedCount: matchedTrips.length });
    }
  }

  return matches;
}

export function markRulesFulfilled(ruleIndexes: number[]): void {
  if (ruleIndexes.length === 0) return;

  const rules = readRules();
  let changed = false;

  for (const index of ruleIndexes) {
    const rule = rules[index];
    if (!rule || rule.fulfilled) continue;
    rule.fulfilled = true;
    changed = true;
  }

  if (changed) {
    writeRules(rules);
  }
}
