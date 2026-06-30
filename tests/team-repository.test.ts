process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "team-repository-test-key";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { closePool } = await import("../src/db/client.js");
  const teams = await import("../src/repositories/team-repository.js");
  const { upsertAppSettings } = await import("../src/repositories/app-settings-repository.js");
  const resetDb = async () => {
    await closePool();
    resetMemoryDb();
  };
  resetMemoryDb();

  await upsertAppSettings({
    COOKIE: "legacy-cookie",
    DEVICE_ID: "legacy-device",
    LINE_USER_ID: "legacy-line-group",
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: "legacy-success-line-group",
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: "legacy-failure-line-group",
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
  assert.equal(defaultRuntime?.autoAcceptSuccessLineGroupId, "legacy-success-line-group");
  assert.equal(defaultRuntime?.autoAcceptFailureLineGroupId, "legacy-failure-line-group");
  const repeatedDefaultTeam = await teams.ensureDefaultTeamFromLegacySettings();
  assert.equal(repeatedDefaultTeam.id, 1);

  await resetDb();
  await upsertAppSettings({
    COOKIE: "legacy-cookie",
    DEVICE_ID: "legacy-device",
    LINE_USER_ID: "legacy-line-group",
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: "legacy-success-line-group",
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: "legacy-failure-line-group",
  });
  await teams.createTeam({
    name: "Default Team",
    enabled: true,
    spxCookie: "existing-cookie",
    spxDeviceId: "existing-device",
    lineGroupId: "legacy-line-group",
  });
  await teams.ensureDefaultTeamFromLegacySettings();
  const upgradedDefaultRuntime = await teams.getTeamRuntimeConfig(1);
  assert.equal(upgradedDefaultRuntime?.lineGroupId, "legacy-line-group");
  assert.equal(upgradedDefaultRuntime?.autoAcceptSuccessLineGroupId, "legacy-success-line-group");
  assert.equal(upgradedDefaultRuntime?.autoAcceptFailureLineGroupId, "legacy-failure-line-group");

  await resetDb();
  await upsertAppSettings({
    COOKIE: "legacy-cookie",
    DEVICE_ID: "legacy-device",
    LINE_USER_ID: "legacy-line-group",
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: "legacy-success-line-group",
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: "legacy-failure-line-group",
  });
  await teams.createTeam({
    name: "Default Team",
    enabled: true,
    spxCookie: "existing-cookie",
    spxDeviceId: "existing-device",
    lineGroupId: "legacy-line-group",
    autoAcceptSuccessLineGroupId: "custom-success-line-group",
    autoAcceptFailureLineGroupId: "custom-failure-line-group",
  });
  await teams.ensureDefaultTeamFromLegacySettings();
  const preservedDefaultRuntime = await teams.getTeamRuntimeConfig(1);
  assert.equal(preservedDefaultRuntime?.autoAcceptSuccessLineGroupId, "custom-success-line-group");
  assert.equal(preservedDefaultRuntime?.autoAcceptFailureLineGroupId, "custom-failure-line-group");

  await resetDb();
  await upsertAppSettings({
    COOKIE: "legacy-cookie",
    DEVICE_ID: "legacy-device",
    LINE_USER_ID: "legacy-line-group",
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: "legacy-success-line-group",
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: "legacy-failure-line-group",
  });

  const created = await teams.createTeam({
    name: "Team A",
    enabled: true,
    spxCookie: "cookie-a-secret",
    spxDeviceId: "device-a-secret",
    lineGroupId: "line-group-a",
    autoAcceptSuccessLineGroupId: "line-success-a",
    autoAcceptFailureLineGroupId: "line-failure-a",
  });

  assert.equal(created.name, "Team A");
  assert.equal(created.enabled, true);
  assert.equal(created.hasSpxCookie, true);
  assert.equal(created.hasSpxDeviceId, true);
  assert.equal(created.hasLineGroupId, true);
  assert.equal(created.hasAutoAcceptSuccessLineGroupId, true);
  assert.equal(created.hasAutoAcceptFailureLineGroupId, true);
  assert.notEqual(created.spxCookiePreview, "cookie-a-secret");
  assert.notEqual(created.spxDeviceIdPreview, "device-a-secret");
  assert.notEqual(created.lineGroupIdPreview, "line-group-a");
  assert.notEqual(created.autoAcceptSuccessLineGroupIdPreview, "line-success-a");
  assert.notEqual(created.autoAcceptFailureLineGroupIdPreview, "line-failure-a");

  const runtime = await teams.getTeamRuntimeConfig(created.id);
  assert.ok(runtime);
  assert.equal(runtime.spxCookie, "cookie-a-secret");
  assert.equal(runtime.spxDeviceId, "device-a-secret");
  assert.equal(runtime.lineGroupId, "line-group-a");
  assert.equal(runtime.autoAcceptSuccessLineGroupId, "line-success-a");
  assert.equal(runtime.autoAcceptFailureLineGroupId, "line-failure-a");

  const preserved = await teams.updateTeam(created.id, {
    name: "Team A renamed",
    spxCookie: created.spxCookiePreview,
    spxDeviceId: created.spxDeviceIdPreview,
    lineGroupId: created.lineGroupIdPreview,
    autoAcceptSuccessLineGroupId: created.autoAcceptSuccessLineGroupIdPreview,
    autoAcceptFailureLineGroupId: created.autoAcceptFailureLineGroupIdPreview,
  });
  assert.ok(preserved);
  const runtimeAfterRedactedSave = await teams.getTeamRuntimeConfig(created.id);
  assert.equal(runtimeAfterRedactedSave?.spxCookie, "cookie-a-secret");
  assert.equal(runtimeAfterRedactedSave?.spxDeviceId, "device-a-secret");
  assert.equal(runtimeAfterRedactedSave?.lineGroupId, "line-group-a");
  assert.equal(runtimeAfterRedactedSave?.autoAcceptSuccessLineGroupId, "line-success-a");
  assert.equal(runtimeAfterRedactedSave?.autoAcceptFailureLineGroupId, "line-failure-a");

  await teams.disableTeam(created.id);
  const disabled = await teams.getTeamById(created.id);
  assert.equal(disabled?.enabled, false);

  console.log("team-repository: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
