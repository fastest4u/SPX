process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "team-spx-account-repository-test-key";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { closePool } = await import("../src/db/client.js");
  const accounts = await import("../src/repositories/team-spx-account-repository.js");

  const resetDb = async () => {
    await closePool();
    resetMemoryDb();
  };
  await resetDb();

  // 1. Create account for team 1
  const created1 = await accounts.createAccount({
    teamId: 1,
    name: "Driver Account A",
    spxCookie: "session-cookie-123456789",
    spxDeviceId: "device-uuid-1",
    spxAppName: "spx-app",
    spxReferer: "https://spx.co.th",
    enabled: true,
  });

  assert.equal(created1.teamId, 1);
  assert.equal(created1.name, "Driver Account A");
  assert.equal(created1.hasSpxCookie, true);
  assert.equal(created1.hasSpxDeviceId, true);
  assert.equal(created1.enabled, true);
  assert.equal(created1.spxAppName, "spx-app");
  assert.match(created1.spxCookiePreview, /6789$/);

  // 2. Create second account for team 1 (disabled)
  const created2 = await accounts.createAccount({
    teamId: 1,
    name: "Driver Account B",
    spxCookie: "session-cookie-987654321",
    spxDeviceId: "device-uuid-2",
    enabled: false,
  });
  assert.equal(created2.enabled, false);

  // 3. Create account for team 2
  const createdTeam2 = await accounts.createAccount({
    teamId: 2,
    name: "Team 2 Driver Account",
    spxCookie: "team2-cookie-1111",
    spxDeviceId: "team2-device-1",
    enabled: true,
  });
  assert.equal(createdTeam2.teamId, 2);

  // 4. List accounts by team
  const team1All = await accounts.listAccountsByTeam(1);
  assert.equal(team1All.length, 2);

  const team1Enabled = await accounts.listAccountsByTeam(1, true);
  assert.equal(team1Enabled.length, 1);
  assert.equal(team1Enabled[0].name, "Driver Account A");

  const team2All = await accounts.listAccountsByTeam(2);
  assert.equal(team2All.length, 1);
  assert.equal(team2All[0].name, "Team 2 Driver Account");

  // 5. Runtime accounts should return decrypted credentials
  const runtimeTeam1 = await accounts.getRuntimeAccountsByTeam(1);
  assert.equal(runtimeTeam1.length, 1);
  assert.equal(runtimeTeam1[0].spxCookie, "session-cookie-123456789");
  assert.equal(runtimeTeam1[0].spxDeviceId, "device-uuid-1");

  // 6. Update account with redacted placeholder does not overwrite cookie
  const updated = await accounts.updateAccount(created1.id, {
    name: "Driver Account A Updated",
    spxCookie: created1.spxCookiePreview, // redacted placeholder
    enabled: true,
  });
  assert.equal(updated?.name, "Driver Account A Updated");

  // Verify decrypted cookie in runtime config is still intact
  const runtimeAfterUpdate = await accounts.getRuntimeAccountById(created1.id);
  assert.equal(runtimeAfterUpdate?.spxCookie, "session-cookie-123456789");

  // 7. Update cookie with new value
  await accounts.updateAccount(created1.id, {
    spxCookie: "new-super-secret-cookie",
  });
  const runtimeAfterCookieUpdate = await accounts.getRuntimeAccountById(created1.id);
  assert.equal(runtimeAfterCookieUpdate?.spxCookie, "new-super-secret-cookie");

  // 8. Delete account
  const deleted = await accounts.deleteAccount(created2.id);
  assert.equal(deleted, true);

  const team1AfterDelete = await accounts.listAccountsByTeam(1);
  assert.equal(team1AfterDelete.length, 1);

  await resetDb();
  console.log("team-spx-account-repository: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
