#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";

import {
  canonicalJson,
  readEvidenceJson,
} from "./lib/evidence-artifact.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases } from "./lib/a3-staging-leases.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";

const ROLES = Object.freeze([
  "web-api",
  "notification-service",
  "line-service",
  "ocr-service",
  "worker-ifn-split",
  "worker-ptwl-split",
]);
const HANDOFF_PATH = "/var/lib/spx-staging-rollout/evidence/gate4-handoff.json";
const EVIDENCE_ROOT = "/var/lib/spx-staging-rollout/evidence/phase4-n-minus-one-staging";
const DB_PROXY_SERVICE = "n-minus-one-db-proxy";

export const N_MINUS_ONE_ACTION_IDS = Object.freeze({
  preflight: "phase4-n1-preflight",
  start: "phase4-n1-start",
  verify: "phase4-n1-verify",
  rollbackForward: "phase4-n1-rollback-forward",
  stop: "phase4-n1-stop",
});

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function evaluateSchemaRange(range) {
  if (
    !range ||
    !Number.isSafeInteger(range.current) ||
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.current < 0 ||
    range.min < 0 ||
    range.max < range.min
  ) {
    return { ok: false, failures: ["SCHEMA_RANGE_INVALID"] };
  }
  return range.current >= range.min && range.current <= range.max
    ? { ok: true, failures: [] }
    : { ok: false, failures: ["CURRENT_SCHEMA_OUTSIDE_RANGE"] };
}

export function highestMigrationVersion(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error("candidate migrations are required");
  }
  const versions = migrations.map((migration) => {
    const name = migration?.name ?? migration?.filename;
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name ?? "");
    if (!match) throw new Error("candidate migration name is invalid");
    return Number(match[1]);
  });
  return Math.max(...versions);
}

export function validateRoleContracts(contract) {
  const failures = [];
  if (contract?.schemaVersion !== 1 || contract?.contractVersion !== "phase4-n-minus-one-v1") {
    failures.push("ROLE_CONTRACT_VERSION_INVALID");
  }
  if (!same(contract?.rollbackEligibleRoles, ROLES)) failures.push("ROLLBACK_ROLE_SET_INVALID");
  if (!contract?.roles || !same(Object.keys(contract.roles), ROLES)) {
    failures.push("ROLE_CONTRACT_SET_INVALID");
  } else {
    for (const role of ROLES) {
      const value = contract.roles[role];
      const dbRole = role !== "ocr-service";
      if (
        typeof value?.probeService !== "string" ||
        value.probeService !== `n-minus-one-${
          {
            "web-api": "web",
            "notification-service": "notification",
            "line-service": "line",
            "ocr-service": "ocr",
            "worker-ifn-split": "worker-ifn",
            "worker-ptwl-split": "worker-ptwl",
          }[role]
        }-probe` ||
        value.nodeId !== `stg-n-minus-one-${role}` ||
        value.usesDatabase !== dbRole ||
        value.dbCredentialAllowed !== dbRole ||
        value.transactionRequired !== dbRole ||
        !Array.isArray(value.representativeReads) ||
        !Array.isArray(value.representativeWrites) ||
        (dbRole &&
          (value.representativeReads.length === 0 || value.representativeWrites.length === 0)) ||
        (!dbRole &&
          (value.representativeReads.length !== 0 || value.representativeWrites.length !== 0)) ||
        value.ddlAllowed !== false ||
        value.providerCallsAllowed !== false ||
        value.backgroundLoopsAllowed !== false ||
        value.liveClaimsAllowed !== false
      ) {
        failures.push("ROLE_CONTRACT_INVALID");
        break;
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

export function listRequiredRoleProbes(signedBaseline, contract) {
  const checked = validateRoleContracts(contract);
  if (!checked.ok || !same(signedBaseline?.rollbackEligibleRoles, ROLES)) {
    throw new Error("signed rollback role coverage does not match reviewed contracts");
  }
  return [...ROLES];
}

function validateCommandConfig(config) {
  const match = /^\/opt\/spx-staging\/release\/[0-9a-f]{40}\/operator\/docker-compose\.yml$/.exec(
    config?.composeFiles?.[0] ?? "",
  );
  const operatorRoot = match ? config.composeFiles[0].slice(0, -"/docker-compose.yml".length) : null;
  if (
    config?.environment !== "staging" ||
    config?.project !== "spx-staging" ||
    config?.envFile !== "/etc/spx-staging/runtime.env" ||
    !operatorRoot ||
    !same(config?.composeFiles, [
      `${operatorRoot}/docker-compose.yml`,
      `${operatorRoot}/docker-compose.staging.yml`,
    ]) ||
    config?.profile !== "n-minus-one"
  ) {
    throw new Error("N-1 probes require the fixed spx-staging configuration");
  }
  return operatorRoot;
}

function composePrefix(config) {
  return buildInstalledStagingComposePrefix(validateCommandConfig(config));
}

export function buildNMinusOneRoleProbeCommand(config, contract, role) {
  validateCommandConfig(config);
  if (!validateRoleContracts(contract).ok || !ROLES.includes(role)) {
    throw new Error("N-1 role probe contract is invalid");
  }
  return [
    ...composePrefix(config),
    "--profile",
    "n-minus-one",
    "run",
    "--rm",
    "--no-deps",
    "--pull",
    "never",
    contract.roles[role].probeService,
  ];
}

export function buildNMinusOneDbProxyStartCommand(config) {
  validateCommandConfig(config);
  return [
    ...composePrefix(config),
    "--profile",
    "n-minus-one",
    "up",
    "-d",
    "--no-deps",
    "--pull",
    "never",
    DB_PROXY_SERVICE,
  ];
}

export function parseLiveArgs() {
  throw new Error("N-1 live actions require an opaque controller context");
}

function actionIdFor(operation) {
  return operation === "rollback-forward"
    ? N_MINUS_ONE_ACTION_IDS.rollbackForward
    : N_MINUS_ONE_ACTION_IDS[operation];
}

export async function executeNMinusOneAction(operation, ports) {
  const actionId = actionIdFor(operation);
  const roles = listRequiredRoleProbes(ports?.baseline, ports?.contract);
  validateCommandConfig(ports?.config);
  if (
    !actionId ||
    ports?.inheritedAction?.actionId !== actionId ||
    ports.inheritedAction.stagingRunId !== ports.stagingRunId
  ) {
    throw new Error("opaque inherited N-1 action is required");
  }
  if (operation === "preflight") {
    if (typeof ports.preflight !== "function" || (await ports.preflight()) !== true) {
      throw new Error("N-1 preflight failed");
    }
  } else if (operation === "start") {
    if (
      typeof ports.startDbProxy !== "function" ||
      (await ports.startDbProxy(buildNMinusOneDbProxyStartCommand(ports.config))) !== true
    ) {
      throw new Error("N-1 database egress proxy failed");
    }
    if (typeof ports.runProbe !== "function") throw new Error("N-1 role runner is unavailable");
    for (const role of roles) {
      const result = await ports.runProbe(
        role,
        buildNMinusOneRoleProbeCommand(ports.config, ports.contract, role),
      );
      if (result?.ok !== true || result?.role !== role) throw new Error("N-1 role probe failed");
    }
  } else if (operation === "verify") {
    if (typeof ports.verify !== "function" || (await ports.verify()) !== true) {
      throw new Error("N-1 evidence verification failed");
    }
  } else if (["rollback-forward", "stop"].includes(operation)) {
    if (typeof ports.cleanup !== "function" || (await ports.cleanup()) !== true) {
      throw new Error("N-1 cleanup failed");
    }
  } else {
    throw new Error("unknown N-1 action");
  }
  return { ok: true, actionId, roleCount: roles.length };
}

function spawnDocker(args, capture = true, env) {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  const result = spawnSync("docker", args, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
    maxBuffer: 256 * 1024,
    timeout: 15 * 60 * 1_000,
    env: env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("fixed N-1 Docker operation failed");
  }
  return capture ? result.stdout.trim() : "";
}

async function writeRoleEvidence(role, value) {
  await mkdir(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  const path = `${EVIDENCE_ROOT}/${role}.json`;
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
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function runProbeLive(role, command, composeEnv) {
  const lines = spawnDocker(command, true, composeEnv)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const result = JSON.parse(lines.at(-1) ?? "null");
  if (
    result?.ok !== true ||
    result?.role !== role ||
    /secret|token|password|cookie|authorization|credential/i.test(canonicalJson(result))
  ) {
    throw new Error("N-1 role probe output is invalid");
  }
  await writeRoleEvidence(role, result);
  return result;
}

async function cleanupLive(contract) {
  const ids = spawnDocker(
    ["ps", "-a", "--filter", "label=com.spx.n-minus-one=true", "--format", "{{.ID}}"],
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const allowedServices = new Set([
    ...Object.values(contract.roles).map((role) => role.probeService),
    DB_PROXY_SERVICE,
  ]);
  for (const id of ids) {
    if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error("N-1 remnant ID is invalid");
    const labels = JSON.parse(
      spawnDocker(["inspect", "--format", "{{json .Config.Labels}}", id]),
    );
    if (
      labels?.["com.docker.compose.project"] !== "spx-staging" ||
      labels?.["com.spx.n-minus-one"] !== "true" ||
      !allowedServices.has(labels?.["com.docker.compose.service"])
    ) {
      throw new Error("N-1 remnant identity is invalid");
    }
    spawnDocker(["rm", "--force", id], false);
  }
  return true;
}

async function main() {
  try {
    if (process.argv.length !== 2) throw new Error("N-1 caller arguments are forbidden");
    const operationByActionId = Object.fromEntries(
      Object.entries(N_MINUS_ONE_ACTION_IDS).map(([operation, actionId]) => [
        actionId,
        operation === "rollbackForward" ? "rollback-forward" : operation,
      ]),
    );
    const actionId = process.env.SPX_STAGING_ACTION_ID;
    const operation = operationByActionId[actionId];
    const context = await loadInstalledApprovedStagingContext();
    const binding = context.installedBinding;
    const operatorRoot = await loadInstalledStagingOperatorRoot(binding);
    const composeEnv = buildInstalledStagingComposeEnvironment(binding, operatorRoot);
    if (
      !operation ||
      process.env.SPX_STAGING_ACTION_SCOPE !== actionId ||
      process.env.SPX_STAGING_RUN_ID !== binding.stagingRunId
    ) {
      throw new Error("inherited N-1 controller action is invalid");
    }
    const leases = await loadStagingLeases(binding.stagingRunId);
    if (
      leases.guard.state !== "armed" ||
      leases.watchdog.state !== "armed" ||
      leases.guard.heartbeatAgeMs > leases.maxAgeMs ||
      leases.watchdog.heartbeatAgeMs > leases.maxAgeMs
    ) {
      throw new Error("continuous staging leases are unavailable");
    }
    const contract = JSON.parse(
      await readFile(`${operatorRoot}/deploy/n-minus-one-role-contracts.json`, "utf8"),
    );
    const baseline = await readEvidenceJson(HANDOFF_PATH, { requireCanonical: true });
    const config = {
      environment: "staging",
      project: "spx-staging",
      envFile: "/etc/spx-staging/runtime.env",
      composeFiles: [
        `${operatorRoot}/docker-compose.yml`,
        `${operatorRoot}/docker-compose.staging.yml`,
      ],
      profile: "n-minus-one",
    };
    const result = await executeNMinusOneAction(operation, {
      config,
      contract,
      baseline,
      inheritedAction: { actionId, stagingRunId: binding.stagingRunId },
      stagingRunId: binding.stagingRunId,
      preflight: async () => {
        const current = highestMigrationVersion(context.artifacts.releaseManifest.migrations);
        return (
          evaluateSchemaRange({ current, ...baseline.candidateSchemaRange }).ok &&
          evaluateSchemaRange({ current, ...baseline.nMinusOneSchemaRange }).ok &&
          baseline.nMinusOneContractVersion === contract.contractVersion
        );
      },
      startDbProxy: async (command) => {
        spawnDocker(command, false, composeEnv);
        return true;
      },
      runProbe: (role, command) => runProbeLive(role, command, composeEnv),
      verify: async () =>
        Promise.all(
          ROLES.map((role) =>
            readEvidenceJson(`${EVIDENCE_ROOT}/${role}.json`, { requireCanonical: true }),
          ),
        ).then((values) => values.every((value, index) => value.ok === true && value.role === ROLES[index])),
      cleanup: () => cleanupLive(contract),
    });
    console.log(canonicalJson(result));
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["N_MINUS_ONE_ACTION_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("phase4-n-minus-one-rehearsal.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
