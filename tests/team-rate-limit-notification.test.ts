process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "team-rate-limit-notification-test-key";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam, getTeamById, getTeamRuntimeConfig, updateTeam } = await import("../src/repositories/team-repository.js");
  const { toTeamPatch } = await import("../src/controllers/teams-controller.js");
  const { sendRateLimitNotification } = await import("../src/services/notifier.js");

  resetMemoryDb();

  // Test 1: Default value on creation should be false (disabled)
  const defaultTeam = await createTeam({
    name: "Team Default RL",
    enabled: true,
    spxCookie: "cookie-1",
    spxDeviceId: "device-1",
    lineGroupId: "group-1",
  });
  assert.equal(defaultTeam.rateLimitNotifyEnabled, false, "Default team should have rateLimitNotifyEnabled = false");

  const runtimeConfig1 = await getTeamRuntimeConfig(defaultTeam.id);
  assert.ok(runtimeConfig1);
  assert.equal(runtimeConfig1.rateLimitNotifyEnabled, false, "Runtime config should reflect rateLimitNotifyEnabled = false");

  // Test 2: Explicitly enabling on creation
  const enabledTeam = await createTeam({
    name: "Team Enabled RL",
    enabled: true,
    spxCookie: "cookie-2",
    spxDeviceId: "device-2",
    lineGroupId: "group-2",
    rateLimitNotifyEnabled: true,
  });
  assert.equal(enabledTeam.rateLimitNotifyEnabled, true, "Explicitly enabled team should have rateLimitNotifyEnabled = true");

  const runtimeConfig2 = await getTeamRuntimeConfig(enabledTeam.id);
  assert.ok(runtimeConfig2);
  assert.equal(runtimeConfig2.rateLimitNotifyEnabled, true, "Runtime config should reflect rateLimitNotifyEnabled = true");

  // Test 3: toTeamPatch parsing validation
  const patchTrue = toTeamPatch({ rateLimitNotifyEnabled: true });
  assert.equal(patchTrue.rateLimitNotifyEnabled, true);

  const patchFalse = toTeamPatch({ rateLimitNotifyEnabled: false });
  assert.equal(patchFalse.rateLimitNotifyEnabled, false);

  assert.throws(
    () => toTeamPatch({ rateLimitNotifyEnabled: "invalid" as unknown as boolean }),
    /rateLimitNotifyEnabled must be a boolean/
  );

  // Test 4: updateTeam toggling
  const updatedToEnabled = await updateTeam(defaultTeam.id, { rateLimitNotifyEnabled: true });
  assert.ok(updatedToEnabled);
  assert.equal(updatedToEnabled.rateLimitNotifyEnabled, true, "Updated team should now have rateLimitNotifyEnabled = true");

  const runtimeConfigUpdated = await getTeamRuntimeConfig(defaultTeam.id);
  assert.ok(runtimeConfigUpdated);
  assert.equal(runtimeConfigUpdated.rateLimitNotifyEnabled, true);

  const updatedToDisabled = await updateTeam(defaultTeam.id, { rateLimitNotifyEnabled: false });
  assert.ok(updatedToDisabled);
  assert.equal(updatedToDisabled.rateLimitNotifyEnabled, false, "Updated team should now have rateLimitNotifyEnabled = false");

  // Test 5: sendRateLimitNotification skips when rateLimitNotifyEnabled is false
  const skippedResultHit = await sendRateLimitNotification(
    "hit",
    { teamId: defaultTeam.id, retcode: 130008001, backoffMs: 2000 },
    { teamId: defaultTeam.id, teamName: "Team Default RL", lineGroupId: "group-1", rateLimitNotifyEnabled: false }
  );
  assert.equal(skippedResultHit.sent, false);
  assert.equal(skippedResultHit.skipped, true);

  const skippedResultRecovered = await sendRateLimitNotification(
    "recovered",
    { teamId: defaultTeam.id, backoffMs: 2000 },
    { teamId: defaultTeam.id, teamName: "Team Default RL", lineGroupId: "group-1", rateLimitNotifyEnabled: false }
  );
  assert.equal(skippedResultRecovered.sent, false);
  assert.equal(skippedResultRecovered.skipped, true);

  // Test 6: sendRateLimitNotification without context skips
  const skippedWithoutContext = await sendRateLimitNotification(
    "hit",
    { teamId: defaultTeam.id, retcode: 130008001, backoffMs: 2000 }
  );
  assert.equal(skippedWithoutContext.sent, false);
  assert.equal(skippedWithoutContext.skipped, true);

  console.log("team-rate-limit-notification: all assertions passed successfully!");
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
