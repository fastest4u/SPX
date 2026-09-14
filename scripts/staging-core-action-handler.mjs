#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases } from "./lib/a3-staging-leases.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";

const PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SPLIT_SERVICES = Object.freeze([
  "web-api",
  "notification-service",
  "line-service",
  "ocr-service",
  "worker-ifn-split",
  "worker-ptwl-split",
]);
const SPLIT_WORKERS = Object.freeze(["worker-ifn-split", "worker-ptwl-split"]);
const COMPATIBILITY_WORKERS = Object.freeze(["worker-ifn", "worker-ptwl"]);

const ACTION_IDENTITIES = Object.freeze([
  ["staging-runtime-start", "runtime-start"],
  ["staging-controlled-publish", "notification-publish"],
  ["staging-worker-forward-handoff", "worker-handoff-forward"],
  ["staging-worker-reverse-handoff", "worker-handoff-reverse"],
]);

export const CORE_STAGING_ACTIONS = Object.freeze(
  ACTION_IDENTITIES.map(([actionId, scope]) => Object.freeze({ actionId, scope })),
);
const ACTIONS = new Map(CORE_STAGING_ACTIONS.map((action) => [action.actionId, action]));

function compose(prefix, ...argv) {
  return Object.freeze({ type: "compose", argv: Object.freeze([...prefix, ...argv]) });
}

function verifyRunning(...services) {
  return Object.freeze({ type: "verify-running", services: Object.freeze(services) });
}

function verifyStopped(...services) {
  return Object.freeze({ type: "verify-stopped", services: Object.freeze(services) });
}

function waitLeaseRelease(owners) {
  return Object.freeze({ type: "wait-lease-release", owners: Object.freeze(owners) });
}

function verifyOwners(owners) {
  return Object.freeze({ type: "verify-owners", owners: Object.freeze(owners) });
}

export function parseCoreActionInvocation(argv, environment = process.env) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("fixed staging core actions accept zero caller arguments");
  }
  const action = ACTIONS.get(environment.SPX_STAGING_ACTION_ID);
  if (
    !action ||
    environment.SPX_STAGING_ACTION_SCOPE !== action.scope ||
    typeof environment.SPX_STAGING_RUN_ID !== "string" ||
    !RUN_ID.test(environment.SPX_STAGING_RUN_ID)
  ) {
    throw new Error("inherited fixed staging core action context is invalid");
  }
  return Object.freeze({ ...action, stagingRunId: environment.SPX_STAGING_RUN_ID });
}

export function buildCoreActionSteps(actionId, stagingRunId, operatorRoot) {
  if (!ACTIONS.has(actionId) || typeof stagingRunId !== "string" || !RUN_ID.test(stagingRunId)) {
    throw new Error("fixed staging core action is invalid");
  }
  const composePrefix = buildInstalledStagingComposePrefix(operatorRoot);
  let steps;
  if (actionId === "staging-runtime-start") {
    steps = [
      compose(composePrefix, "--profile", "split", "up", "-d", "--no-deps", ...SPLIT_SERVICES),
      verifyRunning(...SPLIT_SERVICES),
    ];
  } else if (actionId === "staging-controlled-publish") {
    steps = [
      Object.freeze({
        type: "publish",
        argv: Object.freeze([
          ...composePrefix,
          "exec",
          "-T",
          "worker-ifn-split",
          "node",
          "scripts/service-fault-publish-notification.mjs",
          "--url=http://notification-service:3002/internal/notification-events",
          "--team-id=2",
          `--drill-id=${stagingRunId}`,
          "--step=baseline",
          "--confirm-send-test-notification",
        ]),
      }),
    ];
  } else if (actionId === "staging-worker-forward-handoff") {
    steps = [
      compose(composePrefix, "stop", "--timeout", "120", ...SPLIT_WORKERS),
      waitLeaseRelease([[1, "stg-worker-ptwl-split-1"], [2, "stg-worker-ifn-split-1"]]),
      compose(composePrefix, "up", "-d", "--no-deps", ...COMPATIBILITY_WORKERS),
      verifyRunning(...COMPATIBILITY_WORKERS),
      verifyStopped(...SPLIT_WORKERS),
      verifyOwners([[1, "stg-worker-ptwl-1"], [2, "stg-worker-ifn-1"]]),
    ];
  } else if (actionId === "staging-worker-reverse-handoff") {
    steps = [
      compose(composePrefix, "stop", "--timeout", "120", ...COMPATIBILITY_WORKERS),
      waitLeaseRelease([[1, "stg-worker-ptwl-1"], [2, "stg-worker-ifn-1"]]),
      compose(composePrefix, "--profile", "split", "up", "-d", "--no-deps", ...SPLIT_WORKERS),
      verifyRunning(...SPLIT_WORKERS),
      verifyStopped(...COMPATIBILITY_WORKERS),
      verifyOwners([[1, "stg-worker-ptwl-split-1"], [2, "stg-worker-ifn-split-1"]]),
    ];
  } else {
    throw new Error("fixed staging core action has no implementation");
  }
  return Object.freeze(steps);
}

function assertFreshLeases(leases, stagingRunId) {
  if (
    leases?.stagingRunId !== stagingRunId ||
    leases?.guard?.state !== "armed" ||
    leases?.watchdog?.state !== "armed" ||
    !Number.isFinite(leases?.maxAgeMs) ||
    leases.guard.heartbeatAgeMs > leases.maxAgeMs ||
    leases.watchdog.heartbeatAgeMs > leases.maxAgeMs
  ) {
    throw new Error("continuous staging guard leases are unavailable");
  }
}

export async function executeCoreStagingAction(input, ports) {
  const inherited = input?.inherited;
  const binding = input?.binding;
  if (
    !ACTIONS.has(inherited?.actionId) ||
    inherited?.stagingRunId !== binding?.stagingRunId ||
    typeof input?.operatorRoot !== "string" ||
    typeof ports?.assertLocalDocker !== "function" ||
    typeof ports?.loadLeases !== "function"
  ) {
    throw new Error("verified staging core action context is required");
  }
  await ports.assertLocalDocker();
  assertFreshLeases(await ports.loadLeases(binding.stagingRunId), binding.stagingRunId);
  for (const step of buildCoreActionSteps(
    inherited.actionId,
    inherited.stagingRunId,
    input.operatorRoot,
  )) {
    if (step.type === "compose" || step.type === "publish") {
      const result = await ports.runCompose(step.argv, { capture: step.type === "publish" });
      if (result?.status !== 0) throw new Error("fixed staging Compose operation failed");
      if (step.type === "publish") {
        let value;
        try {
          value = JSON.parse(result.stdout);
        } catch {
          throw new Error("controlled staging publish result is invalid");
        }
        if (value?.ok !== true || value?.drillId !== inherited.stagingRunId || value?.teamId !== 2) {
          throw new Error("controlled staging publish postcondition failed");
        }
      }
    } else if (step.type === "verify-running") {
      await ports.verifyRunning(step.services, binding);
    } else if (step.type === "verify-stopped") {
      await ports.verifyStopped(step.services);
    } else if (step.type === "wait-lease-release") {
      await ports.waitLeaseReleased(step.owners);
    } else if (step.type === "verify-owners") {
      await ports.verifyOwners(step.owners);
    } else {
      throw new Error("unknown fixed staging core action step");
    }
  }
  assertFreshLeases(await ports.loadLeases(binding.stagingRunId), binding.stagingRunId);
  return { ok: true, actionId: inherited.actionId };
}

function spawnDocker(args, options = {}) {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  const result = spawnSync("docker", args, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
    timeout: options.timeout ?? 180_000,
    maxBuffer: 512 * 1024,
    env: options.env ?? { PATH },
  });
  if (result.error || result.signal) throw new Error("fixed local staging Docker command failed");
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout.trim() : "" };
}

async function assertLocalDockerLive() {
  const result = spawnDocker(["context", "show"], { capture: true, timeout: 30_000 });
  if (result.status !== 0 || result.stdout !== "default") {
    throw new Error("only the local default Docker context is allowed");
  }
}

function serviceRunning(service, composePrefix, composeEnv) {
  const result = spawnDocker([...composePrefix, "ps", "--status", "running", "--services", service], {
    capture: true,
    timeout: 30_000,
    env: composeEnv,
  });
  return result.status === 0 && result.stdout.split(/\r?\n/).filter(Boolean).includes(service);
}

function inspectService(service, composePrefix, composeEnv) {
  const id = spawnDocker([...composePrefix, "ps", "-q", service], {
    capture: true,
    timeout: 30_000,
    env: composeEnv,
  });
  if (id.status !== 0 || !/^[0-9a-f]{12,64}$/.test(id.stdout)) {
    throw new Error("fixed staging service container is unavailable");
  }
  const inspected = spawnDocker([
    "inspect",
    "--format",
    '{"health":{{json .State.Health.Status}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"status":{{json .State.Status}}}',
    id.stdout,
  ], { capture: true, timeout: 30_000 });
  if (inspected.status !== 0) throw new Error("fixed staging service inspection failed");
  return JSON.parse(inspected.stdout);
}

async function verifyRunningLive(services, binding, operatorRoot) {
  const composePrefix = buildInstalledStagingComposePrefix(operatorRoot);
  const composeEnv = buildInstalledStagingComposeEnvironment(binding, operatorRoot);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let ready = true;
    for (const service of services) {
      if (!serviceRunning(service, composePrefix, composeEnv)) {
        ready = false;
        break;
      }
      const identity = inspectService(service, composePrefix, composeEnv);
      const labels = identity.labels;
      if (
        identity.status !== "running" ||
        identity.health !== "healthy" ||
        identity.imageId !== binding.imageDigest ||
        labels?.["com.docker.compose.project"] !== "spx-staging" ||
        labels?.["com.docker.compose.service"] !== service ||
        labels?.["com.spx.environment"] !== "staging" ||
        labels?.["com.spx.release-sha"] !== binding.candidateSha ||
        labels?.["com.spx.target-descriptor-sha256"] !== binding.stagingTargetDescriptorSha256 ||
        labels?.["com.spx.operator-bundle-sha256"] !== binding.operatorBundleSha256 ||
        labels?.["com.spx.staging-run-id"] !== binding.stagingRunId
      ) {
        ready = false;
        break;
      }
    }
    if (ready) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error("fixed staging service readiness or identity verification failed");
}

async function verifyStoppedLive(services, binding, operatorRoot) {
  const composePrefix = buildInstalledStagingComposePrefix(operatorRoot);
  const composeEnv = buildInstalledStagingComposeEnvironment(binding, operatorRoot);
  if (services.some((service) => serviceRunning(service, composePrefix, composeEnv))) {
    throw new Error("staging service expected to be stopped is still running");
  }
}

function leaseProbe(teamId, binding, operatorRoot) {
  const service = teamId === 1 ? "worker-ptwl-split" : "worker-ifn-split";
  const result = spawnDocker([
    ...buildInstalledStagingComposePrefix(operatorRoot),
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    service,
    "scripts/gate6-runtime-state-probe.mjs",
    "--probe=lease",
    `--team-id=${teamId}`,
  ], {
    capture: true,
    timeout: 60_000,
    env: buildInstalledStagingComposeEnvironment(binding, operatorRoot),
  });
  if (result.status !== 0) throw new Error("staging worker lease probe failed");
  const value = JSON.parse(result.stdout);
  if (value?.ok !== true || value?.probe !== "lease" || value?.teamId !== teamId) {
    throw new Error("staging worker lease probe output is invalid");
  }
  return value;
}

async function waitForOwners(owners, expected, binding, operatorRoot) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let matched = true;
    for (const [teamId, nodeId] of owners) {
      const lease = leaseProbe(teamId, binding, operatorRoot);
      const ok = expected
        ? lease.leaseActive === true && lease.ownerNodeId === nodeId
        : lease.leaseActive !== true || lease.ownerNodeId !== nodeId;
      if (!ok) {
        matched = false;
        break;
      }
    }
    if (matched) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(expected ? "staging worker sole ownership was not established" : "prior staging worker lease was not released");
}

async function main() {
  try {
    const inherited = parseCoreActionInvocation(process.argv.slice(2));
    const context = await loadInstalledApprovedStagingContext();
    if (context.installedBinding.stagingRunId !== inherited.stagingRunId) {
      throw new Error("installed staging run binding changed");
    }
    const operatorRoot = await loadInstalledStagingOperatorRoot(context.installedBinding);
    const composeEnv = buildInstalledStagingComposeEnvironment(
      context.installedBinding,
      operatorRoot,
    );
    const result = await executeCoreStagingAction(
      { inherited, binding: context.installedBinding, operatorRoot },
      {
        assertLocalDocker: assertLocalDockerLive,
        loadLeases: loadStagingLeases,
        runCompose: async (argv, options) => spawnDocker(argv, {
          ...options,
          timeout: 15 * 60_000,
          env: composeEnv,
        }),
        verifyRunning: (services, binding) => verifyRunningLive(services, binding, operatorRoot),
        verifyStopped: (services) => verifyStoppedLive(
          services,
          context.installedBinding,
          operatorRoot,
        ),
        waitLeaseReleased: (owners) => waitForOwners(
          owners,
          false,
          context.installedBinding,
          operatorRoot,
        ),
        verifyOwners: (owners) => waitForOwners(
          owners,
          true,
          context.installedBinding,
          operatorRoot,
        ),
      },
    );
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch {
    process.stdout.write(`${canonicalJson({ ok: false, failures: ["STAGING_CORE_ACTION_REJECTED"] })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("staging-core-action-handler.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
