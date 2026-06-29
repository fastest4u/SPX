import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  acquireTeamLease,
  releaseTeamLease,
  renewTeamLease,
} from "../src/services/runtime-lease.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

async function main() {
  await resetDb();
  const now = new Date("2030-06-29T07:00:00.000Z");

  const first = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-1",
    role: "team-worker",
    ttlMs: 30_000,
    now,
  });
  assert.equal(first.acquired, true);
  assert.ok(first.leaseToken);

  const blocked = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-2",
    role: "team-worker",
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:00:10.000Z"),
  });
  assert.deepEqual(blocked, { acquired: false });

  assert.equal(await renewTeamLease({
    teamId: 2,
    nodeId: "worker-1",
    leaseToken: first.leaseToken,
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:00:15.000Z"),
  }), true);

  assert.equal(await renewTeamLease({
    teamId: 2,
    nodeId: "worker-2",
    leaseToken: first.leaseToken,
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:00:20.000Z"),
  }), false);

  assert.equal(await renewTeamLease({
    teamId: 2,
    nodeId: "worker-1",
    leaseToken: "wrong-token",
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:00:20.000Z"),
  }), false);

  assert.equal(await releaseTeamLease({
    teamId: 2,
    nodeId: "worker-1",
    leaseToken: "wrong-token",
  }), false);

  const stillBlocked = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-2",
    role: "team-worker",
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:00:21.000Z"),
  });
  assert.deepEqual(stillBlocked, { acquired: false });

  assert.equal(await releaseTeamLease({
    teamId: 2,
    nodeId: "worker-1",
    leaseToken: first.leaseToken,
  }), true);

  const afterRelease = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-2",
    role: "team-worker",
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:00:22.000Z"),
  });
  assert.equal(afterRelease.acquired, true);
  assert.ok(afterRelease.leaseToken);
  assert.notEqual(afterRelease.leaseToken, first.leaseToken);

  await resetDb();
  const expiring = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-1",
    role: "team-worker",
    ttlMs: 30_000,
    now,
  });
  assert.equal(expiring.acquired, true);
  assert.ok(expiring.leaseToken);

  const afterExpiry = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-2",
    role: "team-worker",
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:00:31.000Z"),
  });
  assert.equal(afterExpiry.acquired, true);
  assert.ok(afterExpiry.leaseToken);
  assert.notEqual(afterExpiry.leaseToken, expiring.leaseToken);

  await resetDb();
  const expiredRenew = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-1",
    role: "team-worker",
    ttlMs: 30_000,
    now,
  });
  assert.equal(expiredRenew.acquired, true);
  assert.ok(expiredRenew.leaseToken);

  assert.equal(await renewTeamLease({
    teamId: 2,
    nodeId: "worker-1",
    leaseToken: expiredRenew.leaseToken,
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:01:00.000Z"),
  }), false);

  const acquiredAfterExpiredRenew = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-2",
    role: "team-worker",
    ttlMs: 30_000,
    now: new Date("2030-06-29T07:01:00.000Z"),
  });
  assert.equal(acquiredAfterExpiredRenew.acquired, true);
  assert.ok(acquiredAfterExpiredRenew.leaseToken);
  assert.notEqual(acquiredAfterExpiredRenew.leaseToken, expiredRenew.leaseToken);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
