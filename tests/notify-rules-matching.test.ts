import assert from "node:assert/strict";
import {
  getAutoAcceptOriginFilters,
  matchAutoAcceptRuleTripsWithRules,
  previewRuleAgainstTrips,
  type NotifyRule,
  type TripLike,
} from "../src/services/notify-rules.js";

function makeRule(partial: Partial<NotifyRule> & { id: string; name: string }): NotifyRule {
  return {
    origins: [],
    destinations: [],
    vehicle_types: [],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    auto_accepted: false,
    ...partial,
  };
}

// ── previewRuleAgainstTrips: matching is case-insensitive substring on each axis ──
{
  const trips: TripLike[] = [
    { origin: "Bangkok Hub", destination: "Chiang Mai", vehicle_type: "6WH" },
    { origin: "Phuket", destination: "Bangkok", vehicle_type: "4WH" },
  ];
  const result = previewRuleAgainstTrips({ name: "r", origins: ["bangkok"], vehicle_types: ["6wh"] }, trips);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.wouldMatch, true);
}

// Thai-key fallback (ต้นทาง/ปลายทาง/ประเภทรถ) is honored.
{
  const trips: TripLike[] = [{ "ต้นทาง": "กรุงเทพ", "ปลายทาง": "เชียงใหม่", "ประเภทรถ": "6 ล้อ" }];
  const result = previewRuleAgainstTrips({ name: "th", origins: ["กรุงเทพ"], destinations: ["เชียงใหม่"] }, trips);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.wouldMatch, true);
}

// Unicode compatibility equivalence (NFKC): Thai SARA AM typed as the
// composed ำ (U+0E33) must match API data carrying the decomposed
// NIKHAHIT+SARA AA (U+0E4D U+0E32) sequence, and vice versa.
{
  const composedNam = "น้ำพอง"; // น้ำพอง with composed SARA AM
  const decomposedNam = "น้ําพอง"; // same text, decomposed form
  const trips: TripLike[] = [{ "ต้นทาง": decomposedNam, "ปลายทาง": "ขอนแก่น" }];
  const result = previewRuleAgainstTrips({ name: "sara-am", origins: [composedNam] }, trips);
  assert.equal(result.matchedCount, 1, "composed rule must match decomposed API data");

  const reversed = previewRuleAgainstTrips({ name: "sara-am-rev", origins: [decomposedNam] }, [
    { "ต้นทาง": composedNam },
  ]);
  assert.equal(reversed.matchedCount, 1, "decomposed rule must match composed API data");
}

// need threshold: matched < need => wouldMatch false.
{
  const trips: TripLike[] = [{ origin: "Bangkok", destination: "X", vehicle_type: "6WH" }];
  const result = previewRuleAgainstTrips({ name: "need2", origins: ["bangkok"], need: 2 }, trips);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.wouldMatch, false);
}

// Empty filters match every trip (matchesAny returns true on empty needles).
{
  const trips: TripLike[] = [{ origin: "A" }, { origin: "B" }, { origin: "C" }];
  const result = previewRuleAgainstTrips({ name: "all" }, trips);
  assert.equal(result.matchedCount, 3);
  assert.equal(result.wouldMatch, true);
}

// ── matchAutoAcceptRuleTripsWithRules: respects enabled/fulfilled/need gating ──
{
  const trips: TripLike[] = [{ origin: "Bangkok", destination: "CM", vehicle_type: "6WH" }];

  const enabled = makeRule({ id: "1", name: "enabled", origins: ["bangkok"] });
  const disabled = makeRule({ id: "2", name: "disabled", origins: ["bangkok"], enabled: false });
  const fulfilled = makeRule({ id: "3", name: "fulfilled", origins: ["bangkok"], fulfilled: true });
  const zeroNeed = makeRule({ id: "4", name: "zeroNeed", origins: ["bangkok"], need: 0 });

  const matches = matchAutoAcceptRuleTripsWithRules(trips, [enabled, disabled, fulfilled, zeroNeed]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ruleId, "1");
  assert.equal(matches[0].matchedCount, 1);
}

// ── getAutoAcceptOriginFilters: union of normalized origins across active rules ──
{
  const filters = getAutoAcceptOriginFilters([
    makeRule({ id: "1", name: "a", origins: ["Bangkok", "PHUKET"] }),
    makeRule({ id: "2", name: "b", origins: ["bangkok", "Surat"] }),
  ]);
  assert.deepEqual([...filters].sort(), ["bangkok", "phuket", "surat"]);
}

// A single active rule with NO origin filter short-circuits to [] (match all origins).
{
  const filters = getAutoAcceptOriginFilters([
    makeRule({ id: "1", name: "a", origins: ["bangkok"] }),
    makeRule({ id: "2", name: "wildcard", origins: [] }),
  ]);
  assert.deepEqual(filters, []);
}

// Disabled / fulfilled / zero-need rules are ignored by the origin prefilter.
{
  const filters = getAutoAcceptOriginFilters([
    makeRule({ id: "1", name: "off", origins: ["bangkok"], enabled: false }),
    makeRule({ id: "2", name: "done", origins: ["phuket"], fulfilled: true }),
    makeRule({ id: "3", name: "live", origins: ["surat"] }),
  ]);
  assert.deepEqual(filters, ["surat"]);
}

console.log("notify-rules-matching: all assertions passed");
