process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "provider-auth-repository-test-key";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { closePool } = await import("../src/db/client.js");
  const { getRawMemoryDb, resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam, getTeamById, getTeamRuntimeConfig, updateTeam } = await import("../src/repositories/team-repository.js");
  const {
    acquireTeamProviderAuthLease,
    commitTeamProviderAuth,
    failTeamProviderAuth,
    getTeamProviderAuth,
    getTeamProviderAuthStatus,
    releaseTeamProviderAuthLease,
  } = await import("../src/repositories/team-provider-auth-repository.js");

  const resetDb = async (): Promise<void> => {
    await closePool();
    resetMemoryDb();
  };

  resetMemoryDb();
  const clock = new Date("2030-09-11T08:00:00.000Z");
  const team = await createTeam({
    name: "Provider Auth Team",
    enabled: false,
    spxCookie: "legacy-cookie",
    spxDeviceId: "legacy-device",
    lineGroupId: "fixture-line",
  });

  // Removing the conditional acquisition UPDATE would let both owners proceed.
  const first = await acquireTeamProviderAuthLease(team.id, clock);
  assert.ok(first);
  assert.equal(await acquireTeamProviderAuthLease(team.id, clock), null);
  assert.equal((await getTeamProviderAuthStatus(team.id))?.status, "connecting");

  // Removing encryption or the fenced commit would expose plaintext or accept a stale writer.
  assert.equal(await commitTeamProviderAuth(
    first,
    { email: " Team@Example.Test ", password: "fixture-password" },
    { cookie: "fixture-cookie", deviceId: "fixture-device", expiresAt: "2030-09-11T09:00:00.000Z" },
    clock,
  ), true);

  const raw = getRawMemoryDb().prepare(`
    SELECT spx_email, spx_password, spx_cookie, spx_device_id, spx_auth_epoch,
           spx_auth_lease_token, spx_auth_lease_until
    FROM teams WHERE id = ?
  `).get(team.id) as Record<string, unknown>;
  assert.equal(raw.spx_email, "team@example.test");
  assert.notEqual(raw.spx_password, "fixture-password");
  assert.notEqual(raw.spx_cookie, "fixture-cookie");
  assert.notEqual(raw.spx_device_id, "fixture-device");
  assert.match(String(raw.spx_password), /^enc:v1:/);
  assert.match(String(raw.spx_cookie), /^enc:v1:/);
  assert.match(String(raw.spx_device_id), /^enc:v1:/);
  assert.equal(raw.spx_auth_epoch, 1);
  assert.equal(raw.spx_auth_lease_token, null);
  assert.equal(raw.spx_auth_lease_until, null);

  const record = await getTeamProviderAuth(team.id);
  assert.ok(record);
  assert.equal(record.email, "team@example.test");
  assert.equal(record.password, "fixture-password");
  assert.equal(record.cookie, "fixture-cookie");
  assert.equal(record.deviceId, "fixture-device");
  assert.equal(record.enabled, false, "auth commit must not enable a stopped team");
  assert.equal(record.status, "connected");
  assert.equal(record.storedStatus, "connected");
  assert.equal(record.lastLoginAt, clock.toISOString());
  assert.equal(record.expiresAt, "2030-09-11T09:00:00.000Z");

  // Adding a secret to the public DTO would make one of these checks fail.
  const status = await getTeamProviderAuthStatus(team.id);
  assert.ok(status);
  assert.equal(status.hasPassword, true);
  assert.equal(status.email, "team@example.test");
  for (const secret of ["password", "cookie", "deviceId", "epoch", "failures", "enabled", "storedStatus"]) {
    assert.equal(secret in status, false, `public status leaked ${secret}`);
  }

  const redactedTeam = await getTeamById(team.id);
  const runtime = await getTeamRuntimeConfig(team.id);
  assert.ok(redactedTeam);
  assert.ok(runtime);
  assert.equal("spxPassword" in redactedTeam, false);
  assert.equal("spxPassword" in runtime, false);

  // An expired lease must be replaceable, while its old token remains fenced.
  const expiredOwner = await acquireTeamProviderAuthLease(team.id, new Date("2030-09-11T08:10:00.000Z"));
  assert.ok(expiredOwner);
  const replacementClock = new Date("2030-09-11T08:12:01.000Z");
  assert.equal(await failTeamProviderAuth(expiredOwner, {
    status: "retry_wait",
    errorCode: "provider_unavailable",
    retryAt: "2030-09-11T08:13:00.000Z",
    failures: 1,
  }, replacementClock), false, "an expired lease must not finalize auth state");
  const replacementOwner = await acquireTeamProviderAuthLease(team.id, replacementClock);
  assert.ok(replacementOwner);
  assert.notEqual(replacementOwner.token, expiredOwner.token);
  assert.equal(await commitTeamProviderAuth(
    expiredOwner,
    { email: "stale@example.test", password: "stale-password" },
    { cookie: "stale-cookie", deviceId: "stale-device", expiresAt: null },
    replacementClock,
  ), false);

  // A failed candidate replacement must preserve the last known-good account and pair.
  assert.equal(await failTeamProviderAuth(replacementOwner, {
    status: "attention",
    errorCode: "invalid_credentials",
    retryAt: null,
    failures: 1,
  }, replacementClock), true);
  const afterFailure = await getTeamProviderAuth(team.id);
  assert.ok(afterFailure);
  assert.equal(afterFailure.email, "team@example.test");
  assert.equal(afterFailure.password, "fixture-password");
  assert.equal(afterFailure.cookie, "fixture-cookie");
  assert.equal(afterFailure.deviceId, "fixture-device");
  assert.equal(afterFailure.status, "attention");
  assert.equal(afterFailure.storedStatus, "attention");
  assert.equal(afterFailure.errorCode, "invalid_credentials");
  assert.equal(afterFailure.failures, 1);

  // Suppressing a handled operation must release only its own live lease without changing account state.
  const releaseClock = new Date("2030-09-11T08:15:00.000Z");
  const releasable = await acquireTeamProviderAuthLease(team.id, releaseClock);
  assert.ok(releasable);
  assert.equal(await releaseTeamProviderAuthLease(
    { ...releasable, token: "wrong-token" },
    new Date("2030-09-11T08:15:01.000Z"),
  ), false);
  assert.equal(await releaseTeamProviderAuthLease(releasable, new Date("2030-09-11T08:15:01.000Z")), true);
  const afterRelease = await getTeamProviderAuth(team.id);
  assert.ok(afterRelease);
  assert.equal(afterRelease.email, afterFailure.email);
  assert.equal(afterRelease.cookie, afterFailure.cookie);
  assert.equal(afterRelease.status, afterFailure.status);
  assert.equal(afterRelease.errorCode, afterFailure.errorCode);
  assert.equal(afterRelease.epoch, afterFailure.epoch);

  // A token with an old epoch cannot commit even if its token is restored in storage.
  const staleEpochLease = await acquireTeamProviderAuthLease(team.id, new Date("2030-09-11T08:20:00.000Z"));
  assert.ok(staleEpochLease);
  getRawMemoryDb().prepare("UPDATE teams SET spx_auth_epoch = spx_auth_epoch + 1 WHERE id = ?").run(team.id);
  assert.equal(await commitTeamProviderAuth(
    staleEpochLease,
    { email: "epoch@example.test", password: "epoch-password" },
    { cookie: "epoch-cookie", deviceId: "epoch-device", expiresAt: null },
    new Date("2030-09-11T08:20:01.000Z"),
  ), false);

  // Redacted placeholders and unrelated edits must leave automatic auth intact.
  getRawMemoryDb().prepare(`
    UPDATE teams SET spx_auth_lease_token = NULL, spx_auth_lease_until = NULL WHERE id = ?
  `).run(team.id);
  const preview = await getTeamById(team.id);
  assert.ok(preview);
  const epochBeforePlaceholder = (await getTeamProviderAuth(team.id))?.epoch;
  await updateTeam(team.id, {
    name: "Provider Auth Team Renamed",
    spxCookie: preview.spxCookiePreview,
    spxDeviceId: preview.spxDeviceIdPreview,
  });
  const afterPlaceholder = await getTeamProviderAuth(team.id);
  assert.ok(afterPlaceholder);
  assert.equal(afterPlaceholder.epoch, epochBeforePlaceholder);
  assert.equal(afterPlaceholder.email, "team@example.test");
  assert.equal(afterPlaceholder.hasPassword, true);

  // A real legacy secret replacement must clear auto-login data and fence in-flight work.
  const manualFenceLease = await acquireTeamProviderAuthLease(team.id, new Date("2030-09-11T08:30:00.000Z"));
  assert.ok(manualFenceLease);
  await updateTeam(team.id, { spxCookie: "manual-cookie-replacement" });
  const manual = await getTeamProviderAuth(team.id);
  assert.ok(manual);
  assert.equal(manual.status, "manual");
  assert.equal(manual.email, "");
  assert.equal(manual.password, "");
  assert.equal(manual.hasPassword, false);
  assert.equal(manual.epoch, manualFenceLease.epoch + 1);
  assert.equal(manual.cookie, "manual-cookie-replacement");
  assert.equal(manual.deviceId, "fixture-device");
  assert.equal(await failTeamProviderAuth(manualFenceLease, {
    status: "retry_wait",
    errorCode: "provider_unavailable",
    retryAt: "2030-09-11T08:31:00.000Z",
    failures: 2,
  }, new Date("2030-09-11T08:30:01.000Z")), false);

  assert.equal(await getTeamProviderAuth(999_999), null);
  assert.equal(await getTeamProviderAuthStatus(999_999), null);
  assert.equal(await acquireTeamProviderAuthLease(999_999, clock), null);

  await resetDb();
  console.log("team-provider-auth-repository: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
