process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "team-scoped-repositories-test-key";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const teams = await import("../src/repositories/team-repository.js");
  const rules = await import("../src/services/notify-rules.js");
  const history = await import("../src/repositories/booking-history-repository.js");
  const autoAccept = await import("../src/repositories/auto-accept-repository.js");
  resetMemoryDb();

  const teamA = await teams.createTeam({ name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" });
  const teamB = await teams.createTeam({ name: "B", enabled: true, spxCookie: "cb", spxDeviceId: "db", lineGroupId: "gb" });

  const ruleA = await rules.createRule(teamA.id, { name: "A route", origins: ["A"], destinations: ["X"], vehicle_types: [], need: 1, enabled: true, fulfilled: false, auto_accepted: false });
  const ruleB = await rules.createRule(teamB.id, { name: "B route", origins: ["B"], destinations: ["Y"], vehicle_types: [], need: 1, enabled: true, fulfilled: false, auto_accepted: false });

  assert.deepEqual((await rules.readRules(teamA.id)).map((r) => r.id), [ruleA.id]);
  assert.deepEqual((await rules.readRules(teamB.id)).map((r) => r.id), [ruleB.id]);

  const rec = {
    requestId: 9001,
    bookingId: 19001,
    bookingName: "same upstream request",
    agencyName: "agency",
    route: "A-X",
    origin: "A",
    destination: "X",
    costType: "cost",
    tripType: "trip",
    shiftType: "shift",
    vehicleType: "4W",
    standbyDateTime: "2026-06-16 10:00:00",
    acceptanceStatus: 1,
    assignmentStatus: 0,
  };

  assert.deepEqual(await history.insertBookingHistories(teamA.id, [rec]), { inserted: 1, skipped: 0 });
  assert.deepEqual(await history.insertBookingHistories(teamB.id, [rec]), { inserted: 1, skipped: 0 });
  assert.equal((await history.getBookingHistory(teamA.id, { limit: 20 })).length, 1);
  assert.equal((await history.getBookingHistory(teamB.id, { limit: 20 })).length, 1);

  await autoAccept.insertAutoAcceptHistory(teamA.id, { ruleId: ruleA.id, ruleName: ruleA.name, bookingId: 19001, requestIds: [9001], acceptedCount: 1, origin: "A", destination: "X", vehicleType: "4W", status: "success" });
  await autoAccept.insertAutoAcceptHistory(teamB.id, { ruleId: ruleB.id, ruleName: ruleB.name, bookingId: 19001, requestIds: [9001], acceptedCount: 1, origin: "B", destination: "Y", vehicleType: "4W", status: "success" });
  assert.equal((await autoAccept.getAutoAcceptHistory(teamA.id, { limit: 20 })).length, 1);
  assert.equal((await autoAccept.getAutoAcceptHistory(teamB.id, { limit: 20 })).length, 1);

  console.log("team-scoped-repositories: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
