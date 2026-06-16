process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "auto-accept-progress-update-test-key";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const teams = await import("../src/repositories/team-repository.js");
  const rules = await import("../src/services/notify-rules.js");
  resetMemoryDb();

  const team = await teams.createTeam({
    name: "Progress Team",
    enabled: true,
    spxCookie: "cookie",
    spxDeviceId: "device",
    lineGroupId: "line",
  });
  const otherTeam = await teams.createTeam({
    name: "Other Team",
    enabled: true,
    spxCookie: "cookie-2",
    spxDeviceId: "device-2",
    lineGroupId: "line-2",
  });

  const rule = await rules.createRule(team.id, {
    name: "Need decrements",
    origins: ["A"],
    destinations: ["B"],
    vehicle_types: ["4W"],
    need: 2,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });

  await rules.applyAutoAcceptProgress(team.id, [{ ruleId: rule.id, acceptedCount: 1 }]);
  const afterValidUpdate = (await rules.readRules(team.id)).find((candidate) => candidate.id === rule.id);
  assert.equal(afterValidUpdate?.need, 1);
  assert.equal(afterValidUpdate?.fulfilled, false);

  let committedCount = 0;
  await rules.applyAutoAcceptProgress(otherTeam.id, [{ ruleId: rule.id, acceptedCount: 1 }], () => {
    committedCount += 1;
  });

  const afterWrongTeamUpdate = (await rules.readRules(team.id)).find((candidate) => candidate.id === rule.id);
  assert.equal(afterWrongTeamUpdate?.need, 0);
  assert.equal(afterWrongTeamUpdate?.fulfilled, true);
  assert.equal(committedCount, 1, "team-scope recovery should settle NeedBudget claims after the DB decrement commits");

  await rules.applyAutoAcceptProgress(otherTeam.id, [{ ruleId: "missing-rule", acceptedCount: 1 }], () => {
    committedCount += 1;
  });
  assert.equal(committedCount, 1, "missing rule progress update must not settle NeedBudget claims");

  console.log("auto-accept-progress-update: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
