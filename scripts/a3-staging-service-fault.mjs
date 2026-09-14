#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledReleaseBinding,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";
const OPERATIONS = Object.freeze({
  "line-fault": ["stop", "line-service"],
  "line-recover": ["start", "line-service"],
  "ocr-fault": ["stop", "ocr-service"],
  "ocr-recover": ["start", "ocr-service"],
});
const ACTION_CONTEXTS = Object.freeze({
  "line-fault": { actionId: "staging-line-fault", scope: "line-fault", service: "line-service" },
  "line-recover": {
    actionId: "staging-line-recovery",
    scope: "line-recovery",
    service: "line-service",
  },
  "ocr-fault": { actionId: "staging-ocr-fault", scope: "ocr-fault", service: "ocr-service" },
  "ocr-recover": {
    actionId: "staging-ocr-recovery",
    scope: "ocr-recovery",
    service: "ocr-service",
  },
});

export function parseFaultArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !(argv[0] in OPERATIONS))
    throw new Error("a fixed staging fault operation is required");
  if (argv.length !== 1) {
    const argument = argv[1] ?? "";
    if (argument.startsWith("--service=")) throw new Error("service override is forbidden");
    if (argument.startsWith("--env-file=")) throw new Error("env-file override is forbidden");
    if (argument.startsWith("--docker-host=")) throw new Error("remote Docker override is forbidden");
    throw new Error("project or command override is forbidden; only spx-staging is allowed");
  }
  return { operation: argv[0] };
}

export function buildStagingFaultCommand(operation, operatorRoot) {
  const suffix = OPERATIONS[operation];
  if (!suffix) throw new Error("unknown staging fault operation");
  return [...buildInstalledStagingComposePrefix(operatorRoot), ...suffix];
}

export function verifyStagingContainerIdentity(operation, identity, binding) {
  const expected = ACTION_CONTEXTS[operation];
  if (!expected || !identity || !binding) throw new Error("staging container identity is invalid");
  const labels = identity.labels;
  const expectedLabels = {
    "com.docker.compose.project": "spx-staging",
    "com.docker.compose.service": expected.service,
    "com.spx.environment": "staging",
    "com.spx.release-sha": binding.candidateSha,
    "com.spx.target-descriptor-sha256": binding.stagingTargetDescriptorSha256,
    "com.spx.operator-bundle-sha256": binding.operatorBundleSha256,
    "com.spx.staging-run-id": binding.stagingRunId,
  };
  if (
    identity.imageId !== binding.imageDigest ||
    !labels ||
    Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)
  ) {
    throw new Error("staging container identity labels do not match the installed release");
  }
  return true;
}

function spawnDocker(args, options = {}) {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  const result = spawnSync("docker", args, {
    shell: false,
    windowsHide: true,
    encoding: options.encoding ?? "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
    maxBuffer: 64 * 1024,
    timeout: 60_000,
    env: options.env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("fixed local staging Docker command failed");
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

async function inspectInstalledContainer(operation, operatorRoot, binding) {
  const expected = ACTION_CONTEXTS[operation];
  if (spawnDocker(["context", "show"], { capture: true }) !== "default") {
    throw new Error("only the local default Docker context is allowed");
  }
  const containerId = spawnDocker(
    [...buildInstalledStagingComposePrefix(operatorRoot), "ps", "-a", "-q", expected.service],
    { capture: true, env: buildInstalledStagingComposeEnvironment(binding, operatorRoot) },
  );
  if (!/^[0-9a-f]{12,64}$/.test(containerId)) {
    throw new Error("approved staging service container is unavailable");
  }
  const source = spawnDocker(
    [
      "inspect",
      "--format",
      '{"imageId":{{json .Image}},"labels":{{json .Config.Labels}}}',
      containerId,
    ],
    { capture: true },
  );
  const value = JSON.parse(source);
  if (
    Object.keys(value).sort().join(",") !== "imageId,labels" ||
    typeof value.imageId !== "string" ||
    !value.labels ||
    typeof value.labels !== "object" ||
    Array.isArray(value.labels)
  ) {
    throw new Error("approved staging service identity is invalid");
  }
  return value;
}

export async function executeStagingFaultAction(operation, ports) {
  if (!ACTION_CONTEXTS[operation] || !ports?.binding || !ports?.operatorRoot) {
    throw new Error("verified staging fault context is required");
  }
  const inspectContainer = ports.inspectContainer ?? inspectInstalledContainer;
  const runDocker = ports.runDocker ?? (async (args) => spawnDocker(args, {
    env: buildInstalledStagingComposeEnvironment(ports.binding, ports.operatorRoot),
  }));
  const identity = await inspectContainer(operation, ports.operatorRoot, ports.binding);
  verifyStagingContainerIdentity(operation, identity, ports.binding);
  await runDocker(buildStagingFaultCommand(operation, ports.operatorRoot));
  return { ok: true, operation };
}

function assertInheritedAction(operation, binding) {
  const expected = ACTION_CONTEXTS[operation];
  if (
    process.env.SPX_STAGING_ACTION_ID !== expected.actionId ||
    process.env.SPX_STAGING_ACTION_SCOPE !== expected.scope ||
    process.env.SPX_STAGING_RUN_ID !== binding.stagingRunId
  ) {
    throw new Error("inherited verified staging fault action is required");
  }
}

async function main() {
  try {
    const { operation } = parseFaultArgs(process.argv.slice(2));
    const binding = await loadInstalledReleaseBinding({ environment: "staging" });
    const operatorRoot = await loadInstalledStagingOperatorRoot(binding);
    assertInheritedAction(operation, binding);
    const result = await executeStagingFaultAction(operation, { binding, operatorRoot });
    console.log(canonicalJson(result));
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["STAGING_FAULT_ACTION_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("a3-staging-service-fault.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
