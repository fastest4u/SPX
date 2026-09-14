#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import {
  loadStagingLeases,
  monotonicNowMs,
  newStagingLease,
  readStagingLease,
  writeStagingLease,
} from "./lib/a3-staging-leases.mjs";

const ROLLOUT_CONTROLLER =
  "/opt/spx-staging/release/current/operator/scripts/a3-staging-rollout-controller.mjs";
const WATCHDOG_INTERVAL_MS = 2_000;
const MAX_LEASE_AGE_MS = 10_000;
const STARTUP_GRACE_MS = 15_000;

function fresh(lease, runId, now, maxAge) {
  return Boolean(
    lease &&
      typeof lease.leaseId === "string" &&
      lease.leaseId.length > 0 &&
      (lease.state === undefined || lease.state === "armed") &&
      lease.stagingRunId === runId &&
      typeof lease.heartbeatMonotonicMs === "number" &&
      lease.heartbeatMonotonicMs <= now &&
      now - lease.heartbeatMonotonicMs <= maxAge,
  );
}

export function evaluateWatchdogDecision(input) {
  const guardFresh = fresh(
    input?.guardLease,
    input?.stagingRunId,
    input?.nowMonotonicMs,
    input?.maxLeaseAgeMs,
  );
  const watchdogFresh = fresh(
    input?.watchdogLease,
    input?.stagingRunId,
    input?.nowMonotonicMs,
    input?.maxLeaseAgeMs,
  );
  const distinct = input?.guardLease?.leaseId !== input?.watchdogLease?.leaseId;
  if (guardFresh && watchdogFresh && distinct) return { ok: true, stop: false, failures: [] };
  if (input?.emergencyActionAvailable !== true) {
    return { ok: false, stop: false, failures: ["ACTION_LEDGER_UNAVAILABLE"] };
  }
  return {
    ok: false,
    stop: true,
    actionId: "staging-watchdog-emergency-stop",
    failures: [guardFresh ? "WATCHDOG_LEASE_INVALID" : "GUARD_LEASE_STALE"],
  };
}

export async function executeWatchdogDecision(input, consumeEmergencyAction) {
  const decision = evaluateWatchdogDecision(input);
  if (decision.stop) {
    if (typeof consumeEmergencyAction !== "function") {
      throw new Error("verified watchdog action consumer is unavailable");
    }
    await consumeEmergencyAction(decision.actionId);
  }
  return decision;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consumeInstalledEmergencyAction(actionId) {
  if (actionId !== "staging-watchdog-emergency-stop") {
    throw new Error("watchdog emergency action is invalid");
  }
  const result = spawnSync(
    "/usr/bin/node",
    [ROLLOUT_CONTROLLER, "watchdog-emergency-stop"],
    {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15 * 60 * 1_000,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("verified watchdog emergency action failed");
  }
}

async function assertNoLiveWatchdog(stagingRunId, nowMonotonicMs) {
  const [existing, peer] = await Promise.all([
    readStagingLease("watchdog").catch(() => null),
    readStagingLease("guard").catch(() => null),
  ]);
  const fresh = (lease) =>
    lease?.stagingRunId === stagingRunId &&
    lease.heartbeatMonotonicMs <= nowMonotonicMs &&
    nowMonotonicMs - lease.heartbeatMonotonicMs <= MAX_LEASE_AGE_MS;
  if (
    existing?.stagingRunId === stagingRunId &&
    existing.state === "armed" &&
    fresh(existing)
  ) {
    throw new Error("a live staging watchdog lease already exists");
  }
  if (existing?.stagingRunId === stagingRunId && existing.state === "aborted") {
    throw new Error("the staging run is already aborted");
  }
  if (
    existing?.stagingRunId === stagingRunId &&
    peer?.stagingRunId === stagingRunId &&
    !fresh(existing) &&
    !fresh(peer)
  ) {
    throw new Error("simultaneously stale staging leases cannot be rearmed");
  }
}

export async function runCapacityWatchdog(ports = {}) {
  const context = await (ports.loadContext ?? loadInstalledApprovedStagingContext)();
  const stagingRunId = context?.installedBinding?.stagingRunId;
  if (!stagingRunId) throw new Error("installed staging run is unavailable");
  let now = (ports.now ?? monotonicNowMs)();
  await assertNoLiveWatchdog(stagingRunId, now);
  let lease = newStagingLease("watchdog", stagingRunId, now);
  const writeLease = ports.writeLease ?? writeStagingLease;
  const loadLeases = ports.loadLeases ?? loadStagingLeases;
  const wait = ports.sleep ?? sleep;
  const consume = ports.consumeEmergencyAction ?? consumeInstalledEmergencyAction;
  await writeLease("watchdog", lease);

  while (true) {
    now = (ports.now ?? monotonicNowMs)();
    lease = { ...lease, heartbeatMonotonicMs: now };
    await writeLease("watchdog", lease);
    let leases;
    try {
      leases = await loadLeases(stagingRunId, {
        maxAgeMs: MAX_LEASE_AGE_MS,
        nowMonotonicMs: now,
      });
    } catch {
      if (now - lease.startedMonotonicMs <= STARTUP_GRACE_MS) {
        await wait(WATCHDOG_INTERVAL_MS);
        continue;
      }
      leases = { guard: null, watchdog: lease };
    }
    const decision = await executeWatchdogDecision(
      {
        stagingRunId,
        guardLease: leases.guard,
        watchdogLease: leases.watchdog,
        nowMonotonicMs: now,
        maxLeaseAgeMs: MAX_LEASE_AGE_MS,
        emergencyActionAvailable: true,
      },
      consume,
    );
    if (decision.stop) {
      lease = { ...lease, state: "aborted" };
      await writeLease("watchdog", lease);
      return decision;
    }
    await wait(WATCHDOG_INTERVAL_MS);
  }
}

async function main() {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "run") {
      throw new Error("capacity watchdog accepts only run");
    }
    await runCapacityWatchdog();
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["CAPACITY_WATCHDOG_FAILED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("a3-capacity-watchdog.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
