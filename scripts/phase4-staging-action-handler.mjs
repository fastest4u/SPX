#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  canonicalJson,
  readEvidenceBytes,
  readEvidenceJson,
} from "./lib/evidence-artifact.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases } from "./lib/a3-staging-leases.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";
import {
  executePhase4RoutingMutation,
  validateRoutingPlan,
} from "./phase4-routing-guard.mjs";

const CAPABILITY_PATH = "/etc/spx-staging/phase4-action-capabilities.json";
const RUNTIME_PROBE_AUTH_PATH = "/etc/spx-staging/phase4-runtime-probe.auth";
const ROUTING_STATE_PATH = "/var/lib/spx-staging-rollout/phase4-routing-state.json";
const TERMINAL_SAMPLE_PATH =
  "/var/lib/spx-staging-rollout/evidence/phase4-staging/guard-close.json";
const HANDLER_ROOT = "/usr/local/libexec/spx-staging-actions";
const NODE = "/usr/bin/node";
const PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ACTION_IDENTITIES = Object.freeze([
  ["phase4-proxy-realtime-start", "phase4-proxy-realtime-start", "forward"],
  ["phase4-singleton-contender-probe", "phase4-singleton-contender-probe", "forward"],
  ["phase4-route-producer", "phase4-route-producer", "forward"],
  ["phase4-route-read", "phase4-route-read", "forward"],
  ["phase4-route-stream", "phase4-route-stream", "forward"],
  ["phase4-realtime-restart-probe", "phase4-realtime-restart-probe", "forward"],
  ["phase4-route-local-rollback", "phase4-route-local-rollback", "forward"],
  ["phase4-route-approved-final", "phase4-route-approved-final", "forward"],
  ["phase4-route-final-cleanup-baseline", "phase4-route-final-cleanup-baseline", "forward"],
  ["guard-close", "guard-close", "forward"],
]);

export const PHASE4_HANDLER_ACTIONS = Object.freeze(
  ACTION_IDENTITIES.map(([actionId, scope, kind]) => Object.freeze({ actionId, scope, kind })),
);

export const PHASE4_HANDLER_INSTALL_MAP = Object.freeze(
  PHASE4_HANDLER_ACTIONS.map((action) =>
    Object.freeze({
      ...action,
      handlerPath: `${HANDLER_ROOT}/${action.actionId}`,
      executable: `${HANDLER_ROOT}/${action.actionId}`,
      argv: Object.freeze([]),
    }),
  ),
);

const ACTIONS = new Map(PHASE4_HANDLER_ACTIONS.map((action) => [action.actionId, action]));
const ROUTING_OPERATIONS = Object.freeze({
  "phase4-route-producer": "producer",
  "phase4-route-read": "read",
  "phase4-route-stream": "stream",
  "phase4-route-local-rollback": "local-rollback",
  "phase4-route-approved-final": "approved-final",
  "phase4-route-final-cleanup-baseline": "final-cleanup-baseline",
});
const ROUTING_RUNTIME_MODES = Object.freeze({
  "phase4-route-producer": "baseline",
  "phase4-route-read": "baseline",
  "phase4-route-stream": "routed",
  "phase4-route-local-rollback": "rollback",
  "phase4-route-approved-final": "routed",
  "phase4-route-final-cleanup-baseline": "rollback",
});
const ROUTING_ACTION_IDS = Object.freeze(Object.keys(ROUTING_OPERATIONS));
const ROUTING_PLAN_KEYS = Object.freeze([
  "environment",
  "composeProject",
  "releaseSha",
  "producers",
  "webReadsRemote",
  "webStreamsRemote",
  "routingWatermark",
  "localFallbackWatermark",
  "singletonOwners",
]);
const ROUTE_SERVICE_MAP = Object.freeze({
  poller: Object.freeze(["poller-ifn-phase3", "poller-ptwl-phase3"]),
  notification: Object.freeze(["notification-service"]),
  line: Object.freeze(["line-service"]),
  "web-api": Object.freeze(["web-api"]),
});
const ROUTE_COMPOSE_SERVICES = new Set(Object.values(ROUTE_SERVICE_MAP).flat());

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) && same(Object.keys(value).sort(), [...keys].sort());
}

function allProducers(plan) {
  return same(plan?.producers, ["poller", "notification", "line"]);
}

function localPlan(plan) {
  return (
    same(plan?.producers, []) &&
    plan?.webReadsRemote === false &&
    plan?.webStreamsRemote === false &&
    Number.isSafeInteger(plan?.localFallbackWatermark) &&
    plan.localFallbackWatermark >= plan.routingWatermark
  );
}

function assertRoutingTargetSemantics(actionId, plan) {
  const valid = exactKeys(plan, ROUTING_PLAN_KEYS) && validateRoutingPlan(plan).ok;
  if (!valid) throw new Error("Phase 4 routing capability is invalid");
  if (
    actionId === "phase4-route-producer" &&
    !(allProducers(plan) && !plan.webReadsRemote && !plan.webStreamsRemote)
  ) {
    throw new Error("Phase 4 producer routing capability is invalid");
  }
  if (
    actionId === "phase4-route-read" &&
    !(allProducers(plan) && plan.webReadsRemote && !plan.webStreamsRemote)
  ) {
    throw new Error("Phase 4 read routing capability is invalid");
  }
  if (
    ["phase4-route-stream", "phase4-route-approved-final"].includes(actionId) &&
    !(allProducers(plan) && plan.webReadsRemote && plan.webStreamsRemote)
  ) {
    throw new Error("Phase 4 remote routing capability is invalid");
  }
  if (
    ["phase4-route-local-rollback", "phase4-route-final-cleanup-baseline"].includes(actionId) &&
    !localPlan(plan)
  ) {
    throw new Error("Phase 4 local routing capability is invalid");
  }
}

export function parsePhase4HandlerInvocation(argv, env = process.env) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("Phase 4 fixed handler accepts zero caller arguments");
  }
  const actionId = env.SPX_STAGING_ACTION_ID;
  const scope = env.SPX_STAGING_ACTION_SCOPE;
  const stagingRunId = env.SPX_STAGING_RUN_ID;
  const action = ACTIONS.get(actionId);
  if (!action) throw new Error("unsupported Phase 4 fixed action");
  if (scope !== action.scope || !ID.test(stagingRunId ?? "")) {
    throw new Error("Phase 4 inherited action context is invalid");
  }
  return Object.freeze({ actionId, scope, stagingRunId });
}

export function validatePhase4ActionCapabilities(value, context) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "binding",
      "runtimeSnapshotUrl",
      "routingTargets",
      "guard",
    ]) ||
    value.schemaVersion !== 1 ||
    !exactKeys(value.binding, [
      "candidateSha",
      "stagingRunId",
      "stagingTargetDescriptorSha256",
      "operatorBundleSha256",
    ]) ||
    !exactKeys(value.guard, ["guardLeaseId", "watchdogLeaseId"])
  ) {
    throw new Error("Phase 4 capability shape is invalid");
  }
  const binding = context?.installedBinding;
  if (
    context?.descriptor?.releaseEnvironment !== "staging" ||
    context?.descriptor?.runtimeEnvironment !== "staging" ||
    context?.descriptor?.composeProject !== "spx-staging" ||
    binding?.environment !== "staging" ||
    binding?.composeProject !== "spx-staging" ||
    !SHA.test(value.binding.candidateSha ?? "") ||
    !HASH.test(value.binding.stagingTargetDescriptorSha256 ?? "") ||
    !HASH.test(value.binding.operatorBundleSha256 ?? "") ||
    !ID.test(value.binding.stagingRunId ?? "") ||
    value.binding.candidateSha !== binding.candidateSha ||
    value.binding.stagingRunId !== binding.stagingRunId ||
    value.binding.stagingTargetDescriptorSha256 !== binding.stagingTargetDescriptorSha256 ||
    value.binding.operatorBundleSha256 !== binding.operatorBundleSha256
  ) {
    throw new Error("Phase 4 capability binding is invalid");
  }
  let snapshot;
  try {
    snapshot = new URL(value.runtimeSnapshotUrl);
  } catch {
    throw new Error("Phase 4 loopback snapshot capability is invalid");
  }
  if (
    snapshot.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(snapshot.hostname) ||
    snapshot.pathname !== "/internal/phase4/runtime-snapshot" ||
    snapshot.username ||
    snapshot.password ||
    snapshot.search ||
    snapshot.hash
  ) {
    throw new Error("Phase 4 loopback snapshot capability is invalid");
  }
  if (
    !UUID.test(value.guard.guardLeaseId ?? "") ||
    !UUID.test(value.guard.watchdogLeaseId ?? "") ||
    value.guard.guardLeaseId === value.guard.watchdogLeaseId ||
    !exactKeys(value.routingTargets, ROUTING_ACTION_IDS)
  ) {
    throw new Error("Phase 4 control capability is invalid");
  }
  for (const actionId of ROUTING_ACTION_IDS) {
    const plan = value.routingTargets[actionId];
    if (plan?.releaseSha !== binding.candidateSha) {
      throw new Error("Phase 4 routing release capability is invalid");
    }
    assertRoutingTargetSemantics(actionId, plan);
  }
  return value;
}

export function buildPhase4ComposeCommands(actionId, operatorRoot) {
  const composePrefix = buildInstalledStagingComposePrefix(operatorRoot);
  if (actionId === "phase4-proxy-realtime-start") {
    return [[
      ...composePrefix,
      "up",
      "-d",
      "--no-deps",
      "staging-db-proxy",
      "realtime-service",
    ]];
  }
  if (actionId === "phase4-singleton-contender-probe") {
    return [[
      ...composePrefix,
      "--profile",
      "staging-tools",
      "run",
      "--rm",
      "--no-deps",
      "--pull",
      "never",
      "realtime-singleton-contender-probe",
    ]];
  }
  if (actionId === "phase4-realtime-restart-probe") {
    return [
      [...composePrefix, "stop", "realtime-service"],
      [...composePrefix, "up", "-d", "--no-deps", "realtime-service"],
    ];
  }
  throw new Error("Phase 4 action has no fixed Compose command");
}

function assertSignedAction(context, inherited) {
  const actions = context?.envelope?.actions;
  if (actions === undefined) return;
  if (!Array.isArray(actions)) throw new Error("signed staging action plan is unavailable");
  const matches = actions.filter((action) => action?.actionId === inherited.actionId);
  if (
    matches.length !== 1 ||
    matches[0].scope !== inherited.scope ||
    matches[0].kind !== "forward"
  ) {
    throw new Error("signed staging action does not match the fixed handler");
  }
}

function assertProbeResult(result, mode) {
  if (!isObject(result) || result.ok !== true || result.mode !== mode) {
    throw new Error("Phase 4 runtime postcondition failed");
  }
}

async function runProbe(ports, mode, capabilities) {
  if (typeof ports.runRuntimeProbe !== "function") {
    throw new Error("Phase 4 runtime probe capability is unavailable");
  }
  const result = await ports.runRuntimeProbe(mode, capabilities);
  assertProbeResult(result, mode);
}

async function runComposeSuccess(ports, command) {
  if (typeof ports.runCompose !== "function") {
    throw new Error("Phase 4 local Compose capability is unavailable");
  }
  const result = await ports.runCompose(command);
  if (!isObject(result) || result.status !== 0) {
    throw new Error("Phase 4 fixed Compose action failed");
  }
  return result;
}

function assertExpectedSingletonRejection(result) {
  if (!isObject(result) || !Number.isSafeInteger(result.status) || result.status === 0) {
    throw new Error("singleton contender did not reject the second owner");
  }
  const lines = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let value;
  try {
    value = JSON.parse(lines.at(-1) ?? "null");
  } catch {
    throw new Error("singleton expected rejection evidence is invalid");
  }
  if (
    !exactKeys(value, ["code", "ok"]) ||
    value.ok !== false ||
    value.code !== "REALTIME_SINGLETON_HELD"
  ) {
    throw new Error("singleton expected rejection evidence is invalid");
  }
}

function validateFreshControlLeases(leases, inherited, capabilities) {
  if (
    leases?.stagingRunId !== inherited.stagingRunId ||
    leases?.guard?.leaseId !== capabilities.guard.guardLeaseId ||
    leases?.watchdog?.leaseId !== capabilities.guard.watchdogLeaseId ||
    leases?.guard?.state !== "armed" ||
    leases?.watchdog?.state !== "armed" ||
    !Number.isSafeInteger(leases?.maxAgeMs) ||
    leases.maxAgeMs <= 0 ||
    leases.guard.heartbeatAgeMs > leases.maxAgeMs ||
    leases.watchdog.heartbeatAgeMs > leases.maxAgeMs ||
    !Number.isSafeInteger(leases.guard.pid) ||
    !Number.isSafeInteger(leases.watchdog.pid) ||
    leases.guard.pid <= 1 ||
    leases.watchdog.pid <= 1 ||
    leases.guard.pid === leases.watchdog.pid ||
    [leases.guard.pid, leases.watchdog.pid].includes(process.pid)
  ) {
    throw new Error("fresh bound control leases are required for guard close");
  }
  return leases;
}

export async function executePhase4StagingAction(input, ports = {}) {
  const inherited = input?.inherited;
  const action = ACTIONS.get(inherited?.actionId);
  if (
    !action ||
    inherited.scope !== action.scope ||
    inherited.stagingRunId !== input?.context?.installedBinding?.stagingRunId ||
    typeof input?.context?.operatorRoot !== "string"
  ) {
    throw new Error("verified inherited Phase 4 action is required");
  }
  const capabilities = validatePhase4ActionCapabilities(input.capabilities, input.context);
  assertSignedAction(input.context, inherited);
  if (typeof ports.assertLocalDocker !== "function" || (await ports.assertLocalDocker()) !== true) {
    throw new Error("local default Docker capability is required");
  }

  if (inherited.actionId === "phase4-proxy-realtime-start") {
    await runComposeSuccess(ports, buildPhase4ComposeCommands(
      inherited.actionId,
      input.context.operatorRoot,
    )[0]);
    await runProbe(ports, "baseline", capabilities);
  } else if (inherited.actionId === "phase4-singleton-contender-probe") {
    if (typeof ports.runCompose !== "function") {
      throw new Error("singleton contender capability is unavailable");
    }
    assertExpectedSingletonRejection(
      await ports.runCompose(buildPhase4ComposeCommands(
        inherited.actionId,
        input.context.operatorRoot,
      )[0]),
    );
    await runProbe(ports, "competing-owner", capabilities);
  } else if (inherited.actionId in ROUTING_OPERATIONS) {
    if (
      typeof ports.readRoutingState !== "function" ||
      typeof ports.writeRoutingState !== "function" ||
      typeof ports.applyRouting !== "function"
    ) {
      throw new Error("fixed routing mutation capability is unavailable");
    }
    const previous = await ports.readRoutingState();
    if (!exactKeys(previous, ROUTING_PLAN_KEYS)) {
      throw new Error("current Phase 4 routing state is invalid");
    }
    const next = capabilities.routingTargets[inherited.actionId];
    await executePhase4RoutingMutation(previous, next, ROUTING_OPERATIONS[inherited.actionId], {
      inheritedAction: {
        actionId: inherited.actionId,
        releaseSha: input.context.installedBinding.candidateSha,
        stagingRunId: inherited.stagingRunId,
      },
      stagingRunId: inherited.stagingRunId,
      apply: (services, plan) => ports.applyRouting(services, plan, capabilities),
    });
    await ports.writeRoutingState(next);
    await runProbe(ports, ROUTING_RUNTIME_MODES[inherited.actionId], capabilities);
  } else if (inherited.actionId === "phase4-realtime-restart-probe") {
    if (typeof ports.readReplayCursor !== "function") {
      throw new Error("realtime cursor capability is unavailable");
    }
    const before = await ports.readReplayCursor(capabilities);
    if (!Number.isSafeInteger(before) || before < 0) {
      throw new Error("realtime cursor before restart is invalid");
    }
    for (const command of buildPhase4ComposeCommands(
      inherited.actionId,
      input.context.operatorRoot,
    )) {
      await runComposeSuccess(ports, command);
    }
    await runProbe(ports, "recovered", capabilities);
    const after = await ports.readReplayCursor(capabilities);
    if (!Number.isSafeInteger(after) || after < before) {
      throw new Error("realtime cursor did not resume after restart");
    }
    await runProbe(ports, "routed", capabilities);
  } else if (inherited.actionId === "guard-close") {
    if (
      typeof ports.listStagingContainerIds !== "function" ||
      typeof ports.listNMinusOneContainerIds !== "function" ||
      typeof ports.loadLeases !== "function" ||
      typeof ports.captureTerminalSample !== "function" ||
      typeof ports.closeControlProcesses !== "function" ||
      typeof ports.verifyControlProcessesClosed !== "function"
    ) {
      throw new Error("guard close capability is unavailable");
    }
    const [stagingIds, nMinusOneIds] = await Promise.all([
      ports.listStagingContainerIds(),
      ports.listNMinusOneContainerIds(),
    ]);
    if (
      !Array.isArray(stagingIds) ||
      !Array.isArray(nMinusOneIds) ||
      stagingIds.length !== 0 ||
      nMinusOneIds.length !== 0
    ) {
      throw new Error("zero staging containers is required before guard close; staging remains");
    }
    const leases = validateFreshControlLeases(
      await ports.loadLeases(inherited.stagingRunId),
      inherited,
      capabilities,
    );
    if ((await ports.captureTerminalSample({ inherited, capabilities, leases })) !== true) {
      throw new Error("terminal guard sample could not be recorded");
    }
    const pids = [leases.guard.pid, leases.watchdog.pid];
    await ports.closeControlProcesses(pids, leases);
    if ((await ports.verifyControlProcessesClosed(pids)) !== true) {
      throw new Error("guard and watchdog did not close");
    }
  } else {
    throw new Error("unsupported Phase 4 fixed action");
  }
  return { ok: true, actionId: inherited.actionId };
}

function safeSpawn(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024,
    timeout: options.timeout ?? 15 * 60 * 1_000,
    env: options.env ?? { PATH },
  });
  return {
    status: result.error || result.signal || !Number.isSafeInteger(result.status)
      ? -1
      : result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
  };
}

async function assertSecureFile(path, options = {}) {
  const [file, parent, parentReal] = await Promise.all([
    lstat(path, { bigint: true }),
    lstat(dirname(path), { bigint: true }),
    realpath(dirname(path)),
  ]);
  if (
    file.isSymbolicLink() ||
    !file.isFile() ||
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    resolve(parentReal) !== resolve(dirname(path)) ||
    file.size <= 0n ||
    file.size > BigInt(options.maxBytes ?? 256 * 1024)
  ) {
    throw new Error("fixed root-owned Phase 4 file is invalid");
  }
  if (process.platform !== "win32") {
    const mode = Number(file.mode & 0o777n);
    const acceptedModes = options.private ? [0o400, 0o440] : [0o400, 0o440, 0o444, 0o600];
    if (
      Number(file.uid) !== 0 ||
      Number(parent.uid) !== 0 ||
      !acceptedModes.includes(mode) ||
      (Number(parent.mode & 0o777n) & 0o022) !== 0
    ) {
      throw new Error("fixed Phase 4 file permissions are invalid");
    }
  }
}

async function loadCapabilitiesLive(context) {
  await assertSecureFile(CAPABILITY_PATH);
  const value = await readEvidenceJson(CAPABILITY_PATH, {
    maxFileBytes: 256 * 1024,
    requireCanonical: true,
  });
  return validatePhase4ActionCapabilities(value, context);
}

async function readRuntimeProbeAuth() {
  await assertSecureFile(RUNTIME_PROBE_AUTH_PATH, { private: true, maxBytes: 4_096 });
  const value = (
    await readEvidenceBytes(RUNTIME_PROBE_AUTH_PATH, { maxFileBytes: 4_096 })
  ).toString("utf8").trim();
  if (value.length < 16 || value.length > 4_096 || /\r|\n|\0/.test(value)) {
    throw new Error("fixed Phase 4 runtime probe authentication is invalid");
  }
  return value;
}

async function assertLocalDockerLive() {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  const context = safeSpawn("docker", ["context", "show"], { timeout: 10_000 });
  if (context.status !== 0 || context.stdout !== "default") {
    throw new Error("only the local default Docker context is allowed");
  }
  return true;
}

async function runRuntimeProbeLive(mode, capabilities, operatorRoot) {
  if (!Object.values(ROUTING_RUNTIME_MODES).includes(mode) &&
      !["baseline", "competing-owner", "recovered", "routed"].includes(mode)) {
    throw new Error("fixed Phase 4 runtime mode is invalid");
  }
  const authorization = await readRuntimeProbeAuth();
  const result = safeSpawn(
    NODE,
    [`${operatorRoot}/scripts/phase4-runtime-probe.mjs`, `--mode=${mode}`],
    {
      timeout: 30_000,
      env: {
        PATH,
        PHASE4_RUNTIME_SNAPSHOT_URL: capabilities.runtimeSnapshotUrl,
        PHASE4_RUNTIME_PROBE_AUTH: authorization,
      },
    },
  );
  if (result.status !== 0) throw new Error("Phase 4 runtime probe failed");
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const value = JSON.parse(lines.at(-1) ?? "null");
  if (!isObject(value) || value.ok !== true || value.mode !== mode) {
    throw new Error("Phase 4 runtime probe result is invalid");
  }
  return value;
}

async function readRoutingStateLive() {
  await assertSecureFile(ROUTING_STATE_PATH);
  return readEvidenceJson(ROUTING_STATE_PATH, {
    maxFileBytes: 64 * 1024,
    requireCanonical: true,
  });
}

async function atomicWriteCanonical(path, value) {
  const parentPath = dirname(path);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const [parent, parentReal] = await Promise.all([
    lstat(parentPath, { bigint: true }),
    realpath(parentPath),
  ]);
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    resolve(parentReal) !== resolve(parentPath) ||
    (process.platform !== "win32" &&
      (Number(parent.uid) !== 0 || (Number(parent.mode & 0o777n) & 0o077) !== 0))
  ) {
    throw new Error("Phase 4 state directory is invalid");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(canonicalJson(value));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (process.platform === "win32") await rm(path, { force: true });
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(parentPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeRoutingStateLive(value) {
  return atomicWriteCanonical(ROUTING_STATE_PATH, value);
}

function routingEnvironment(plan) {
  const remote = "http://realtime-service:3005";
  const producerRemote = (producer) => (plan.producers.includes(producer) ? remote : "");
  return Object.freeze({
    PATH,
    SPX_REALTIME_POLLER_IFN_PHASE3_URL: producerRemote("poller"),
    SPX_REALTIME_POLLER_PTWL_PHASE3_URL: producerRemote("poller"),
    SPX_REALTIME_NOTIFICATION_SERVICE_URL: producerRemote("notification"),
    SPX_REALTIME_LINE_SERVICE_URL: producerRemote("line"),
    SPX_REALTIME_WEB_API_URL: plan.webReadsRemote || plan.webStreamsRemote ? remote : "",
    SPX_PHASE4_WEB_READ_REMOTE: String(plan.webReadsRemote),
    SPX_PHASE4_WEB_STREAM_REMOTE: String(plan.webStreamsRemote),
  });
}

async function applyRoutingLive(logicalServices, plan, operatorRoot, binding) {
  const composeServices = [];
  for (const logical of logicalServices) {
    const mapped = ROUTE_SERVICE_MAP[logical];
    if (!mapped) throw new Error("routing service is outside the fixed allowlist");
    for (const service of mapped) if (!composeServices.includes(service)) composeServices.push(service);
  }
  if (
    composeServices.length === 0 ||
    composeServices.some((service) => !ROUTE_COMPOSE_SERVICES.has(service))
  ) {
    throw new Error("routing Compose service set is invalid");
  }
  const result = safeSpawn(
    "docker",
    [
      ...buildInstalledStagingComposePrefix(operatorRoot),
      "up",
      "-d",
      "--no-deps",
      ...composeServices,
    ],
    {
      env: {
        ...buildInstalledStagingComposeEnvironment(binding, operatorRoot),
        ...routingEnvironment(plan),
      },
    },
  );
  if (result.status !== 0) throw new Error("fixed routing Compose action failed");
}

async function fetchRuntimeSnapshot(capabilities) {
  const authorization = await readRuntimeProbeAuth();
  const response = await fetch(capabilities.runtimeSnapshotUrl, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${authorization}`,
      "x-spx-phase4-probe-mode": "recovered",
    },
  });
  const text = await response.text();
  if (!response.ok || text.length > 64 * 1024) {
    throw new Error("fixed Phase 4 runtime snapshot failed");
  }
  const value = JSON.parse(text);
  if (
    !isObject(value) ||
    Object.keys(value).some((key) =>
      /secret|token|password|cookie|authorization|credential|payload|eventData/i.test(key),
    )
  ) {
    throw new Error("fixed Phase 4 runtime snapshot is invalid");
  }
  return value;
}

async function readReplayCursorLive(capabilities) {
  const value = await fetchRuntimeSnapshot(capabilities);
  if (!Number.isSafeInteger(value.replayCursor) || value.replayCursor < 0) {
    throw new Error("realtime replay cursor is invalid");
  }
  return value.replayCursor;
}

function splitIds(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!/^[0-9a-f]{12,64}$/.test(entry)) throw new Error("container identity is invalid");
      return entry;
    });
}

async function listStagingContainerIdsLive(operatorRoot, binding) {
  const result = safeSpawn(
    "docker",
    [...buildInstalledStagingComposePrefix(operatorRoot), "ps", "-a", "-q"],
    {
      timeout: 30_000,
      env: buildInstalledStagingComposeEnvironment(binding, operatorRoot),
    },
  );
  if (result.status !== 0) throw new Error("staging container inventory failed");
  return splitIds(result.stdout);
}

async function listNMinusOneContainerIdsLive() {
  const result = safeSpawn(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project=spx-staging",
      "--filter",
      "label=com.spx.n-minus-one=true",
      "--format",
      "{{.ID}}",
    ],
    { timeout: 30_000 },
  );
  if (result.status !== 0) throw new Error("N-1 container inventory failed");
  return splitIds(result.stdout);
}

async function captureTerminalSampleLive({ inherited, capabilities, leases }) {
  await atomicWriteCanonical(TERMINAL_SAMPLE_PATH, {
    schemaVersion: 1,
    actionId: inherited.actionId,
    stagingRunId: inherited.stagingRunId,
    candidateSha: capabilities.binding.candidateSha,
    guardLeaseId: leases.guard.leaseId,
    watchdogLeaseId: leases.watchdog.leaseId,
    guardPid: leases.guard.pid,
    watchdogPid: leases.watchdog.pid,
    capturedAt: new Date().toISOString(),
    zeroStagingContainers: true,
  });
  return true;
}

async function assertControlProcess(pid, expectedScript) {
  const status = await lstat(`/proc/${pid}`, { bigint: true });
  if (!status.isDirectory() || Number(status.uid) !== 0) {
    throw new Error("staging control process identity is invalid");
  }
  const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
  const entries = commandLine.split("\0").filter(Boolean);
  if (!entries.some((entry) => entry.endsWith(expectedScript))) {
    throw new Error("staging control process command is invalid");
  }
}

async function closeControlProcessesLive(pids) {
  await Promise.all([
    assertControlProcess(pids[0], "a3-capacity-guard.mjs"),
    assertControlProcess(pids[1], "a3-capacity-watchdog.mjs"),
  ]);
  for (const pid of pids) process.kill(pid, "SIGTERM");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function verifyControlProcessesClosedLive(pids) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (pids.every((pid) => !processExists(pid))) return true;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  return false;
}

async function main() {
  try {
    const inherited = parsePhase4HandlerInvocation(process.argv.slice(2));
    const context = await loadInstalledApprovedStagingContext();
    const operatorRoot = await loadInstalledStagingOperatorRoot(context.installedBinding);
    const boundContext = { ...context, operatorRoot };
    const composeEnv = buildInstalledStagingComposeEnvironment(
      context.installedBinding,
      operatorRoot,
    );
    const capabilities = await loadCapabilitiesLive(boundContext);
    const result = await executePhase4StagingAction(
      { inherited, context: boundContext, capabilities },
      {
        assertLocalDocker: assertLocalDockerLive,
        runCompose: (args) => safeSpawn("docker", args, { env: composeEnv }),
        runRuntimeProbe: (mode, currentCapabilities) => runRuntimeProbeLive(
          mode,
          currentCapabilities,
          operatorRoot,
        ),
        readRoutingState: readRoutingStateLive,
        writeRoutingState: writeRoutingStateLive,
        applyRouting: (services, plan) => applyRoutingLive(
          services,
          plan,
          operatorRoot,
          context.installedBinding,
        ),
        readReplayCursor: readReplayCursorLive,
        listStagingContainerIds: () => listStagingContainerIdsLive(
          operatorRoot,
          context.installedBinding,
        ),
        listNMinusOneContainerIds: listNMinusOneContainerIdsLive,
        loadLeases: loadStagingLeases,
        captureTerminalSample: captureTerminalSampleLive,
        closeControlProcesses: closeControlProcessesLive,
        verifyControlProcessesClosed: verifyControlProcessesClosedLive,
      },
    );
    console.log(canonicalJson(result));
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["PHASE4_FIXED_ACTION_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("phase4-staging-action-handler.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
