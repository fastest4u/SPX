import assert from "node:assert/strict";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  createUser,
  deleteUser,
  getUserAuthStateById,
  getUserByUsername,
  updateUserPassword,
  updateUserRole,
} from "../src/repositories/user-repository.js";
import { resolveAuthUserFromJwtPayload } from "../src/services/auth-session.js";
import { AppError } from "../src/utils/errors.js";

async function assertRejectedToken(payload: unknown): Promise<void> {
  await assert.rejects(
    () => resolveAuthUserFromJwtPayload(payload),
    (error) => error instanceof AppError && error.errorCode === "TOKEN_REVOKED",
  );
}

async function main(): Promise<void> {
  resetMemoryDb();

  await createUser("session-admin", "initial-password-123", "admin");
  const user = await getUserByUsername("session-admin");
  assert.ok(user);

  const originalPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    jti: "test-jti-auth-version",
    authVersion: user.authVersion,
  };

  const resolved = await resolveAuthUserFromJwtPayload(originalPayload);
  assert.deepEqual(resolved, { id: user.id, username: user.username, role: "admin" });

  const passwordChanged = await updateUserPassword(user.id, "changed-password-123");
  assert.equal(passwordChanged, true);
  await assertRejectedToken(originalPayload);

  const afterPasswordChange = await getUserAuthStateById(user.id);
  assert.ok(afterPasswordChange);
  assert.equal(afterPasswordChange.authVersion, user.authVersion + 1);

  const freshPayload = {
    ...originalPayload,
    role: afterPasswordChange.role,
    authVersion: afterPasswordChange.authVersion,
  };
  assert.deepEqual(await resolveAuthUserFromJwtPayload(freshPayload), {
    id: user.id,
    username: user.username,
    role: "admin",
  });

  const roleChanged = await updateUserRole(user.id, "user");
  assert.equal(roleChanged, true);
  await assertRejectedToken(freshPayload);

  const afterRoleChange = await getUserAuthStateById(user.id);
  assert.ok(afterRoleChange);
  const downgradedPayload = {
    ...freshPayload,
    role: "admin",
    authVersion: afterRoleChange.authVersion,
  };
  assert.deepEqual(await resolveAuthUserFromJwtPayload(downgradedPayload), {
    id: user.id,
    username: user.username,
    role: "user",
  });

  const missingPasswordChanged = await updateUserPassword(99_999, "missing-password-123");
  assert.equal(missingPasswordChanged, false);
  const missingRoleChanged = await updateUserRole(99_999, "user");
  assert.equal(missingRoleChanged, false);

  const deleted = await deleteUser(user.id);
  assert.equal(deleted, true);
  await assertRejectedToken(downgradedPayload);

  const missingDeleted = await deleteUser(99_999);
  assert.equal(missingDeleted, false);

  console.log("auth-session-revocation: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
