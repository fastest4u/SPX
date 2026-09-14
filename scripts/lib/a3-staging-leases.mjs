import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalJson } from "./evidence-artifact.mjs";

const LEASE_ROOT = "/run/spx-staging-rollout";
const LEASE_PATHS = Object.freeze({
  guard: `${LEASE_ROOT}/guard.lease.json`,
  watchdog: `${LEASE_ROOT}/watchdog.lease.json`,
});
const ROLES = new Set(Object.keys(LEASE_PATHS));

export function monotonicNowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function assertRole(role) {
  if (!ROLES.has(role)) throw new Error("staging lease role is invalid");
}

function assertLease(value, role) {
  const keys = Object.keys(value ?? {}).sort();
  const expected = [
    "baselineP95LatencyMs",
    "breachCount",
    "heartbeatMonotonicMs",
    "leaseId",
    "pid",
    "role",
    "schemaVersion",
    "state",
    "stagingRunId",
    "startedMonotonicMs",
  ].sort();
  if (canonicalJson(keys) !== canonicalJson(expected)) throw new Error("staging lease shape is invalid");
  if (
    value.schemaVersion !== 1 ||
    value.role !== role ||
    !["armed", "aborted"].includes(value.state) ||
    typeof value.leaseId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.leaseId) ||
    typeof value.stagingRunId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.stagingRunId) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isSafeInteger(value.startedMonotonicMs) ||
    value.startedMonotonicMs < 0 ||
    !Number.isSafeInteger(value.heartbeatMonotonicMs) ||
    value.heartbeatMonotonicMs < value.startedMonotonicMs ||
    !Number.isSafeInteger(value.breachCount) ||
    value.breachCount < 0 ||
    !(
      value.baselineP95LatencyMs === null ||
      (typeof value.baselineP95LatencyMs === "number" &&
        Number.isFinite(value.baselineP95LatencyMs) &&
        value.baselineP95LatencyMs > 0)
    )
  ) {
    throw new Error("staging lease value is invalid");
  }
  return Object.freeze({ ...value });
}

async function assertPrivateRoot() {
  await mkdir(LEASE_ROOT, { recursive: true, mode: 0o700 });
  const [real, stat] = await Promise.all([
    realpath(LEASE_ROOT),
    lstat(LEASE_ROOT, { bigint: true }),
  ]);
  if (resolve(real) !== resolve(LEASE_ROOT) || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("staging lease root is invalid");
  }
  if (
    process.platform !== "win32" &&
    (Number(stat.uid) !== 0 || Number(stat.mode & 0o777n) !== 0o700)
  ) {
    throw new Error("staging lease root must be root owned mode 0700");
  }
}

async function readLeasePath(path, role) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > 4_096n) {
    throw new Error("staging lease file is invalid");
  }
  if (
    process.platform !== "win32" &&
    (Number(before.uid) !== 0 || Number(before.mode & 0o777n) !== 0o600)
  ) {
    throw new Error("staging lease file must be root owned mode 0600");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("staging lease changed during validation");
    }
    const text = await handle.readFile("utf8");
    const value = JSON.parse(text);
    if (text !== canonicalJson(value)) throw new Error("staging lease must use canonical JSON");
    return assertLease(value, role);
  } finally {
    await handle.close();
  }
}

export async function readStagingLease(role) {
  assertRole(role);
  await assertPrivateRoot();
  return readLeasePath(LEASE_PATHS[role], role);
}

export async function loadStagingLeases(stagingRunId, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? 10_000;
  const nowMonotonicMs = options.nowMonotonicMs ?? monotonicNowMs();
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("staging lease maximum age is invalid");
  }
  const [guard, watchdog] = await Promise.all([
    readStagingLease("guard"),
    readStagingLease("watchdog"),
  ]);
  if (
    guard.stagingRunId !== stagingRunId ||
    watchdog.stagingRunId !== stagingRunId ||
    guard.leaseId === watchdog.leaseId
  ) {
    throw new Error("staging leases are not bound to this rollout");
  }
  return Object.freeze({
    stagingRunId,
    guard: Object.freeze({
      ...guard,
      heartbeatAgeMs: Math.max(0, nowMonotonicMs - guard.heartbeatMonotonicMs),
    }),
    watchdog: Object.freeze({
      ...watchdog,
      heartbeatAgeMs: Math.max(0, nowMonotonicMs - watchdog.heartbeatMonotonicMs),
    }),
    maxAgeMs,
  });
}

export async function loadEmergencyStagingLeases(stagingRunId, role, options = {}) {
  assertRole(role);
  const peerRole = role === "guard" ? "watchdog" : "guard";
  const maxAgeMs = options.maxAgeMs ?? 10_000;
  const nowMonotonicMs = options.nowMonotonicMs ?? monotonicNowMs();
  const own = await readStagingLease(role);
  if (own.stagingRunId !== stagingRunId) {
    throw new Error("emergency staging lease is not bound to this rollout");
  }
  const peer = await readStagingLease(peerRole).catch(() => null);
  const entry = (lease) =>
    lease
      ? Object.freeze({
          ...lease,
          heartbeatAgeMs: Math.max(0, nowMonotonicMs - lease.heartbeatMonotonicMs),
        })
      : Object.freeze({ leaseId: "missing", heartbeatAgeMs: Number.POSITIVE_INFINITY });
  return Object.freeze({
    stagingRunId,
    guard: role === "guard" ? entry(own) : entry(peer),
    watchdog: role === "watchdog" ? entry(own) : entry(peer),
    maxAgeMs,
  });
}

export async function writeStagingLease(role, value) {
  assertRole(role);
  await assertPrivateRoot();
  const lease = assertLease(value, role);
  const path = LEASE_PATHS[role];
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(canonicalJson(lease));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (process.platform === "win32") await rm(path, { force: true });
    await rename(temporaryPath, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return lease;
}

export function newStagingLease(role, stagingRunId, nowMonotonicMs = monotonicNowMs()) {
  assertRole(role);
  return assertLease(
    {
      schemaVersion: 1,
      role,
      state: "armed",
      breachCount: 0,
      baselineP95LatencyMs: null,
      leaseId: randomUUID(),
      stagingRunId,
      pid: process.pid,
      startedMonotonicMs: nowMonotonicMs,
      heartbeatMonotonicMs: nowMonotonicMs,
    },
    role,
  );
}
