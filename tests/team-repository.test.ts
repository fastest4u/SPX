process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "team-repository-test-key";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const teams = await import("../src/repositories/team-repository.js");
  const { upsertAppSettings } = await import("../src/repositories/app-settings-repository.js");
  resetMemoryDb();

  await upsertAppSettings({
    COOKIE: "legacy-cookie",
    DEVICE_ID: "legacy-device",
    LINE_USER_ID: "legacy-line-group",
  });

  const defaultTeam = await teams.ensureDefaultTeamFromLegacySettings();
  assert.equal(defaultTeam.id, 1);
  assert.equal(defaultTeam.name, "Default Team");
  assert.equal(defaultTeam.hasSpxCookie, true);
  assert.equal(defaultTeam.hasSpxDeviceId, true);
  assert.equal(defaultTeam.hasLineGroupId, true);
  const defaultRuntime = await teams.getTeamRuntimeConfig(1);
  assert.equal(defaultRuntime?.spxCookie, "legacy-cookie");
  assert.equal(defaultRuntime?.spxDeviceId, "legacy-device");
  assert.equal(defaultRuntime?.lineGroupId, "legacy-line-group");
  const repeatedDefaultTeam = await teams.ensureDefaultTeamFromLegacySettings();
  assert.equal(repeatedDefaultTeam.id, 1);

  const created = await teams.createTeam({
    name: "Team A",
    enabled: true,
    spxCookie: "cookie-a-secret",
    spxDeviceId: "device-a-secret",
    lineGroupId: "line-group-a",
  });

  assert.equal(created.name, "Team A");
  assert.equal(created.enabled, true);
  assert.equal(created.hasSpxCookie, true);
  assert.equal(created.hasSpxDeviceId, true);
  assert.equal(created.hasLineGroupId, true);
  assert.notEqual(created.spxCookiePreview, "cookie-a-secret");
  assert.notEqual(created.spxDeviceIdPreview, "device-a-secret");
  assert.notEqual(created.lineGroupIdPreview, "line-group-a");

  const runtime = await teams.getTeamRuntimeConfig(created.id);
  assert.ok(runtime);
  assert.equal(runtime.spxCookie, "cookie-a-secret");
  assert.equal(runtime.spxDeviceId, "device-a-secret");
  assert.equal(runtime.lineGroupId, "line-group-a");

  const preserved = await teams.updateTeam(created.id, {
    name: "Team A renamed",
    spxCookie: created.spxCookiePreview,
    spxDeviceId: created.spxDeviceIdPreview,
    lineGroupId: created.lineGroupIdPreview,
  });
  assert.ok(preserved);
  const runtimeAfterRedactedSave = await teams.getTeamRuntimeConfig(created.id);
  assert.equal(runtimeAfterRedactedSave?.spxCookie, "cookie-a-secret");
  assert.equal(runtimeAfterRedactedSave?.spxDeviceId, "device-a-secret");
  assert.equal(runtimeAfterRedactedSave?.lineGroupId, "line-group-a");

  await teams.disableTeam(created.id);
  const disabled = await teams.getTeamById(created.id);
  assert.equal(disabled?.enabled, false);

  console.log("team-repository: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
