import assert from "node:assert/strict";
import { TeamCredentialPool } from "../src/services/team-credential-pool.js";
import type { TeamSpxAccountRuntime } from "../src/repositories/team-spx-account-repository.js";

async function main(): Promise<void> {
  let currentTime = 1000;
  const mockClock = () => currentTime;

  // 1. Fallback credentials when accounts are empty
  const fallback = { spxCookie: "fallback-cookie", spxDeviceId: "fallback-device" };
  const emptyPool = new TeamCredentialPool({
    teamId: 1,
    fallbackCredentials: fallback,
    loadAccounts: async () => [],
    clock: mockClock,
  });
  await emptyPool.init();

  assert.equal(emptyPool.hasCredentials(), true);
  assert.equal(emptyPool.getAccountCount(), 0);
  const creds0 = emptyPool.nextCredentials();
  assert.equal(creds0.spxCookie, "fallback-cookie");

  // 2. Pool with 2 active accounts rotates round-robin
  const mockAccounts: TeamSpxAccountRuntime[] = [
    {
      id: 101,
      teamId: 1,
      name: "Account 1",
      spxCookie: "cookie-1",
      spxDeviceId: "device-1",
      spxAppName: "app-1",
      spxReferer: "ref-1",
      enabled: true,
    },
    {
      id: 102,
      teamId: 1,
      name: "Account 2",
      spxCookie: "cookie-2",
      spxDeviceId: "device-2",
      spxAppName: "app-2",
      spxReferer: "ref-2",
      enabled: true,
    },
  ];

  const pool = new TeamCredentialPool({
    teamId: 1,
    loadAccounts: async () => mockAccounts,
    clock: mockClock,
  });
  await pool.init();

  assert.equal(pool.hasCredentials(), true);
  assert.equal(pool.getAccountCount(), 2);
  assert.equal(pool.getActiveAccountCount(), 2);

  // First call -> Account 2 (currentIndex starts at 0, (0+1)%2 = 1 -> Account 2)
  const c1 = pool.nextCredentials();
  // Second call -> (1+1)%2 = 0 -> Account 1
  const c2 = pool.nextCredentials();
  // Third call -> Account 2
  const c3 = pool.nextCredentials();

  assert.notEqual(c1.accountId, c2.accountId);
  assert.equal(c1.accountId, c3.accountId);

  // 3. Record rate limit on Account 101 for 30 seconds
  pool.recordRateLimit(101, 30_000);
  assert.equal(pool.getActiveAccountCount(), 1);

  // Now, every nextCredentials() call should skip 101 and pick 102
  for (let i = 0; i < 5; i++) {
    const cred = pool.nextCredentials();
    assert.equal(cred.accountId, 102);
    assert.equal(cred.spxCookie, "cookie-2");
  }

  // 4. Advance clock by 35 seconds (past rate limit)
  currentTime += 35_000;
  assert.equal(pool.getActiveAccountCount(), 2);

  // Both accounts should rotate again
  const seenIds = new Set<number>();
  for (let i = 0; i < 4; i++) {
    const cred = pool.nextCredentials();
    if (cred.accountId) seenIds.add(cred.accountId);
  }
  assert.equal(seenIds.size, 2);

  // 5. If all accounts are rate-limited, pick earliest expiring
  pool.recordRateLimit(101, 10_000); // expires at currentTime + 10000
  pool.recordRateLimit(102, 50_000); // expires at currentTime + 50000
  assert.equal(pool.getActiveAccountCount(), 0);

  const fallbackCred = pool.nextCredentials();
  // Account 101 has earlier expiry
  assert.equal(fallbackCred.accountId, 101);

  // 6. Session expired handling
  pool.clearRateLimits();
  pool.recordSessionExpired(102);
  assert.equal(pool.getActiveAccountCount(), 1);

  // 102 should be completely skipped
  for (let i = 0; i < 5; i++) {
    const cred = pool.nextCredentials();
    assert.equal(cred.accountId, 101);
  }

  console.log("team-credential-pool: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
