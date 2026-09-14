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
import {
  collectLiveCapacitySnapshot,
  evaluateCapacitySnapshot,
} from "./a3-capacity-check.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";

const GUARD_INTERVAL_MS = 2_000;
const MAX_LEASE_AGE_MS = 10_000;
const STARTUP_GRACE_MS = 15_000;
const REQUIRED_BREACHES = 3;
const STOP_ACTIONS = Object.freeze({
  "staging-guard-emergency-stop": "guard-emergency-stop",
  "staging-watchdog-emergency-stop": "watchdog-emergency-stop",
  "staging-final-stop": "final-stop",
});

export function buildStagingGuardComposePrefix(operatorRoot) {
  return [...buildInstalledStagingComposePrefix(operatorRoot), "--profile", "*"];
}

export const STAGING_STOP_SERVICE_ALLOWLIST = Object.freeze([
  "migrator",
  "notifier",
  "web-api",
  "notification-service",
  "line-service",
  "ocr-service",
  "worker-ifn-split",
  "worker-ptwl-split",
  "worker-ifn",
  "worker-ptwl",
  "poller-ifn-phase3",
  "auto-accept-ifn-phase3",
  "poller-ptwl-phase3",
  "auto-accept-ptwl-phase3",
  "realtime-service",
  "gate6-control",
  "gate6-task9-controller",
  "gate6-db-proxy",
  "gate6-monitor-probe",
  "staging-db-proxy",
  "n-minus-one-db-proxy",
  "n-minus-one-web-probe",
  "n-minus-one-notification-probe",
  "n-minus-one-line-probe",
  "n-minus-one-ocr-probe",
  "n-minus-one-worker-ifn-probe",
  "n-minus-one-worker-ptwl-probe",
]);

const allowedServices = new Set(STAGING_STOP_SERVICE_ALLOWLIST);

export function assertAllowedStagingServices(services) {
  if (
    !Array.isArray(services) ||
    services.length === 0 ||
    new Set(services).size !== services.length ||
    services.some((service) => typeof service !== "string" || !allowedServices.has(service))
  ) {
    throw new Error("defined staging services do not match the complete stop allowlist");
  }
  return [...services];
}

export function assertLocalStagingDocker(input = {}) {
  if (input.dockerHost || process.env.DOCKER_HOST) {
    throw new Error("DOCKER_HOST and remote Docker endpoints are forbidden");
  }
  if (input.dockerContext !== undefined && input.dockerContext !== "default") {
    throw new Error("only the local default Docker context is allowed");
  }
  return true;
}

export function buildStagingStopCommand(services, operatorRoot) {
  return [
    ...buildStagingGuardComposePrefix(operatorRoot),
    "stop",
    ...assertAllowedStagingServices(services),
  ];
}

function leaseFresh(lease, stagingRunId, nowMonotonicMs, maxLeaseAgeMs) {
  return Boolean(
    lease &&
      typeof lease.leaseId === "string" &&
      lease.leaseId.length > 0 &&
      (lease.state === undefined || lease.state === "armed") &&
      (lease.stagingRunId === undefined || lease.stagingRunId === stagingRunId) &&
      typeof lease.heartbeatMonotonicMs === "number" &&
      Number.isFinite(lease.heartbeatMonotonicMs) &&
      lease.heartbeatMonotonicMs <= nowMonotonicMs &&
      nowMonotonicMs - lease.heartbeatMonotonicMs <= maxLeaseAgeMs,
  );
}

export function evaluateGuardDecision(input) {
  const leasesBound =
    input?.leases?.stagingRunId === input?.stagingRunId &&
    leaseFresh(input?.leases?.guard, input?.stagingRunId, input?.nowMonotonicMs, input?.maxLeaseAgeMs) &&
    leaseFresh(
      input?.leases?.watchdog,
      input?.stagingRunId,
      input?.nowMonotonicMs,
      input?.maxLeaseAgeMs,
    ) &&
    input?.leases?.guard?.leaseId !== input?.leases?.watchdog?.leaseId;
  const capacityFailures = Array.isArray(input?.capacity?.failures)
    ? [...input.capacity.failures]
    : ["CAPACITY_SNAPSHOT_INVALID"];
  const nextConsecutiveBreaches = input?.capacity?.ok
    ? 0
    : Number.isInteger(input?.consecutiveBreaches)
      ? input.consecutiveBreaches + 1
      : 1;
  const leaseFailure = leasesBound ? null : "WATCHDOG_LEASE_STALE";
  const thresholdReached =
    !input?.capacity?.ok &&
    Number.isInteger(input?.requiredBreaches) &&
    input.requiredBreaches > 0 &&
    nextConsecutiveBreaches >= input.requiredBreaches;
  const mustStop = leaseFailure !== null || thresholdReached;

  if (mustStop && input?.emergencyActionAvailable !== true) {
    return {
      ok: false,
      stop: false,
      nextConsecutiveBreaches,
      failures: ["ACTION_LEDGER_UNAVAILABLE"],
    };
  }
  if (mustStop) {
    return {
      ok: false,
      stop: true,
      actionId: "staging-guard-emergency-stop",
      nextConsecutiveBreaches,
      failures: leaseFailure ? [leaseFailure] : capacityFailures,
    };
  }
  return {
    ok: input?.capacity?.ok === true && leasesBound,
    stop: false,
    nextConsecutiveBreaches,
    failures: input?.capacity?.ok === true ? [] : capacityFailures,
  };
}

export async function executeGuardDecision(input, consumeEmergencyAction) {
  const decision = evaluateGuardDecision(input);
  if (decision.stop) {
    if (typeof consumeEmergencyAction !== "function") {
      throw new Error("verified emergency action consumer is unavailable");
    }
    await consumeEmergencyAction(decision.actionId);
  }
  return decision;
}

function spawnLocalDocker(args, capture = false, env) {
  assertLocalStagingDocker({ dockerContext: "default" });
  const result = spawnSync("docker", args, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
    maxBuffer: 64 * 1024,
    timeout: 15 * 60 * 1_000,
    env: env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("fixed local staging Docker stop failed");
  }
  return capture ? result.stdout.trim() : "";
}

export async function executeStagingStopAction(actionId, ports = {}) {
  if (!STOP_ACTIONS[actionId] || typeof ports.operatorRoot !== "string") {
    throw new Error("staging stop action is invalid");
  }
  const composeEnv = ports.binding
    ? buildInstalledStagingComposeEnvironment(ports.binding, ports.operatorRoot)
    : undefined;
  const definedServices =
    ports.definedServices ??
    (async () => {
      const context = spawnLocalDocker(["context", "show"], true);
      if (context !== "default") throw new Error("only the local default Docker context is allowed");
      return spawnLocalDocker(
        [...buildStagingGuardComposePrefix(ports.operatorRoot), "config", "--services"],
        true,
        composeEnv,
      )
        .split(/\r?\n/)
        .filter(Boolean);
    });
  const runDocker = ports.runDocker ?? (async (args) => spawnLocalDocker(args, false, composeEnv));
  const services = assertAllowedStagingServices(await definedServices());
  await runDocker(buildStagingStopCommand(services, ports.operatorRoot));
  return { ok: true, actionId, serviceCount: services.length };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consumeInstalledEmergencyAction(operatorRoot, actionId) {
  if (actionId !== "staging-guard-emergency-stop") {
    throw new Error("guard emergency action is invalid");
  }
  const result = spawnSync(
    "/usr/bin/node",
    [`${operatorRoot}/scripts/a3-staging-rollout-controller.mjs`, "guard-emergency-stop"],
    {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15 * 60 * 1_000,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("verified guard emergency action failed");
  }
}

async function assertNoLiveGuard(stagingRunId, nowMonotonicMs) {
  const [existing, peer] = await Promise.all([
    readStagingLease("guard").catch(() => null),
    readStagingLease("watchdog").catch(() => null),
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
    throw new Error("a live staging guard lease already exists");
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
  return existing?.stagingRunId === stagingRunId ? existing : null;
}

export async function runCapacityGuard(ports = {}) {
  assertLocalStagingDocker({ dockerContext: "default" });
  const context = await (ports.loadContext ?? loadInstalledApprovedStagingContext)();
  const stagingRunId = context?.installedBinding?.stagingRunId;
  if (!stagingRunId) throw new Error("installed staging run is unavailable");
  let now = (ports.now ?? monotonicNowMs)();
  const priorLease = await (ports.assertNoLiveLease ?? assertNoLiveGuard)(stagingRunId, now);
  let lease = {
    ...newStagingLease("guard", stagingRunId, now),
    breachCount: priorLease?.breachCount ?? 0,
    baselineP95LatencyMs: priorLease?.baselineP95LatencyMs ?? null,
  };
  await (ports.writeLease ?? writeStagingLease)("guard", lease);
  const collect = ports.collectCapacity ?? collectLiveCapacitySnapshot;
  const loadLeases = ports.loadLeases ?? loadStagingLeases;
  const wait = ports.sleep ?? sleep;
  const operatorRoot = ports.operatorRoot ?? (
    ports.consumeEmergencyAction ? null : await loadInstalledStagingOperatorRoot(context.installedBinding)
  );
  const consume = ports.consumeEmergencyAction ?? (
    (actionId) => consumeInstalledEmergencyAction(operatorRoot, actionId)
  );
  if (lease.baselineP95LatencyMs === null) {
    const first = await collect({ continuous: true });
    if (first.stagingRunId !== stagingRunId) throw new Error("capacity run binding changed");
    lease = {
      ...lease,
      baselineP95LatencyMs: first.snapshot.productionP95LatencyMs,
    };
    await (ports.writeLease ?? writeStagingLease)("guard", lease);
  }

  while (true) {
    now = (ports.now ?? monotonicNowMs)();
    lease = { ...lease, heartbeatMonotonicMs: now };
    await (ports.writeLease ?? writeStagingLease)("guard", lease);
    let leases;
    try {
      leases = await loadLeases(stagingRunId, {
        maxAgeMs: MAX_LEASE_AGE_MS,
        nowMonotonicMs: now,
      });
    } catch {
      if (now - lease.startedMonotonicMs <= STARTUP_GRACE_MS) {
        await wait(GUARD_INTERVAL_MS);
        continue;
      }
      leases = {
        stagingRunId,
        guard: lease,
        watchdog: null,
      };
    }
    const live = await collect({
      continuous: true,
      productionBaselineP95LatencyMs: lease.baselineP95LatencyMs,
    });
    if (live.stagingRunId !== stagingRunId) throw new Error("capacity run binding changed");
    const capacity = evaluateCapacitySnapshot(live.snapshot, live.thresholds);
    const decision = await executeGuardDecision(
      {
        capacity,
        leases,
        stagingRunId,
        nowMonotonicMs: now,
        maxLeaseAgeMs: MAX_LEASE_AGE_MS,
        consecutiveBreaches: lease.breachCount,
        requiredBreaches: REQUIRED_BREACHES,
        emergencyActionAvailable: true,
      },
      consume,
    );
    lease = {
      ...lease,
      breachCount: decision.nextConsecutiveBreaches,
      state: decision.stop ? "aborted" : "armed",
    };
    await (ports.writeLease ?? writeStagingLease)("guard", lease);
    if (decision.stop) return decision;
    await wait(GUARD_INTERVAL_MS);
  }
}

async function main() {
  try {
    if (process.argv.length !== 3 || !["run", "stop"].includes(process.argv[2])) {
      throw new Error("capacity guard accepts only run or inherited stop");
    }
    if (process.argv[2] === "stop") {
      const context = await loadInstalledApprovedStagingContext();
      const operatorRoot = await loadInstalledStagingOperatorRoot(context.installedBinding);
      const actionId = process.env.SPX_STAGING_ACTION_ID;
      const expectedScope = STOP_ACTIONS[actionId];
      if (
        !expectedScope ||
        process.env.SPX_STAGING_ACTION_SCOPE !== expectedScope ||
        process.env.SPX_STAGING_RUN_ID !== context.installedBinding.stagingRunId
      ) {
        throw new Error("inherited verified staging stop action is required");
      }
      const result = await executeStagingStopAction(actionId, {
        binding: context.installedBinding,
        operatorRoot,
      });
      console.log(canonicalJson(result));
      return;
    }
    await runCapacityGuard();
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["CAPACITY_GUARD_FAILED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("a3-capacity-guard.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
