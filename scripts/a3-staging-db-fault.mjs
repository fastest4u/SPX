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
  fault: ["stop", "staging-db-proxy"],
  recover: ["up", "-d", "--no-deps", "staging-db-proxy"],
});
const ACTIONS = Object.freeze({
  fault: { actionId: "phase4-db-proxy-fault", scope: "phase4-db-proxy-fault" },
  recover: { actionId: "phase4-db-proxy-recover", scope: "phase4-db-proxy-recover" },
});

export function parseFaultArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || !(argv[0] in OPERATIONS)) {
    throw new Error("a fixed controller context staging DB proxy operation is required; override forbidden");
  }
  return { operation: argv[0] };
}

export function buildFaultCommand(operation, operatorRoot) {
  const suffix = OPERATIONS[operation];
  if (!suffix) throw new Error("unknown staging DB proxy operation");
  return [...buildInstalledStagingComposePrefix(operatorRoot), ...suffix];
}

export function verifyProxyContainerIdentity(identity, binding) {
  const labels = identity?.labels;
  const expected = {
    "com.docker.compose.project": "spx-staging",
    "com.docker.compose.service": "staging-db-proxy",
    "com.spx.environment": "staging",
    "com.spx.release-sha": binding?.candidateSha,
    "com.spx.target-descriptor-sha256": binding?.stagingTargetDescriptorSha256,
    "com.spx.operator-bundle-sha256": binding?.operatorBundleSha256,
    "com.spx.staging-run-id": binding?.stagingRunId,
  };
  if (
    !binding ||
    identity?.imageId !== binding.imageDigest ||
    !labels ||
    Object.entries(expected).some(([key, value]) => labels[key] !== value)
  ) {
    throw new Error("staging DB proxy container identity is invalid");
  }
  return true;
}

function spawnDocker(args, capture = false, env) {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  const result = spawnSync("docker", args, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
    maxBuffer: 64 * 1024,
    timeout: 60_000,
    env: env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("fixed staging DB proxy Docker operation failed");
  }
  return capture ? result.stdout.trim() : "";
}

async function inspectInstalledProxy(operatorRoot, binding) {
  if (spawnDocker(["context", "show"], true) !== "default") {
    throw new Error("only the local default Docker context is allowed");
  }
  const id = spawnDocker(
    [...buildInstalledStagingComposePrefix(operatorRoot), "ps", "-a", "-q", "staging-db-proxy"],
    true,
    buildInstalledStagingComposeEnvironment(binding, operatorRoot),
  );
  if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error("staging DB proxy container is unavailable");
  const source = spawnDocker(
    [
      "inspect",
      "--format",
      '{"imageId":{{json .Image}},"labels":{{json .Config.Labels}}}',
      id,
    ],
    true,
  );
  const value = JSON.parse(source);
  if (Object.keys(value).sort().join(",") !== "imageId,labels") {
    throw new Error("staging DB proxy inspection is invalid");
  }
  return value;
}

export async function executeStagingDbFaultAction(operation, ports) {
  if (!OPERATIONS[operation] || !ports?.binding || !ports?.operatorRoot) {
    throw new Error("verified staging DB proxy action is required");
  }
  const inspectContainer = ports.inspectContainer ?? inspectInstalledProxy;
  const runDocker = ports.runDocker ?? (async (args) => spawnDocker(
    args,
    false,
    buildInstalledStagingComposeEnvironment(ports.binding, ports.operatorRoot),
  ));
  verifyProxyContainerIdentity(await inspectContainer(operation, ports.operatorRoot, ports.binding), ports.binding);
  await runDocker(buildFaultCommand(operation, ports.operatorRoot));
  return { ok: true, operation };
}

function assertInheritedAction(operation, binding) {
  const expected = ACTIONS[operation];
  if (
    process.env.SPX_STAGING_ACTION_ID !== expected.actionId ||
    process.env.SPX_STAGING_ACTION_SCOPE !== expected.scope ||
    process.env.SPX_STAGING_RUN_ID !== binding.stagingRunId
  ) {
    throw new Error("inherited staging DB proxy controller context is required");
  }
}

async function main() {
  try {
    const { operation } = parseFaultArgs(process.argv.slice(2));
    const binding = await loadInstalledReleaseBinding({ environment: "staging" });
    const operatorRoot = await loadInstalledStagingOperatorRoot(binding);
    assertInheritedAction(operation, binding);
    console.log(canonicalJson(await executeStagingDbFaultAction(operation, { binding, operatorRoot })));
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["STAGING_DB_PROXY_ACTION_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("a3-staging-db-fault.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
