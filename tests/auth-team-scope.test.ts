process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "auth-team-scope-test-key";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const teams = await import("../src/repositories/team-repository.js");
  const users = await import("../src/repositories/user-repository.js");
  const { resolveAuthUserFromJwtPayload } = await import("../src/services/auth-session.js");
  resetMemoryDb();

  const team = await teams.createTeam({ name: "Team Scope", enabled: true, spxCookie: "c", spxDeviceId: "d", lineGroupId: "g" });
  await users.createUser("team-user", "password-123456", "user", team.id);
  const user = await users.getUserByUsername("team-user");
  assert.ok(user);
  assert.equal(user.teamId, team.id);

  const resolved = await resolveAuthUserFromJwtPayload({
    id: user.id,
    username: user.username,
    role: user.role,
    teamId: user.teamId,
    authVersion: user.authVersion,
    jti: "team-scope-jti",
  });
  assert.deepEqual(resolved, { id: user.id, username: "team-user", role: "user", teamId: team.id });

  const adminId = await users.createUser("global-admin", "password-123456", "admin", null);
  const admin = await users.getUserAuthStateById(adminId);
  assert.ok(admin);
  assert.equal(admin.teamId, null);

  const moved = await users.updateUserTeam(user.id, null);
  assert.equal(moved, false, "user role cannot be moved to null team");

  const otherTeam = await teams.createTeam({ name: "Other Team", enabled: true, spxCookie: "c2", spxDeviceId: "d2", lineGroupId: "g2" });
  const movedToOtherTeam = await users.updateUserTeam(user.id, otherTeam.id);
  assert.equal(movedToOtherTeam, true);
  const afterMove = await users.getUserAuthStateById(user.id);
  assert.equal(afterMove?.teamId, otherTeam.id);
  assert.equal(afterMove?.authVersion, (user.authVersion ?? 0) + 1);

  console.log("auth-team-scope: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
