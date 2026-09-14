#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_PROJECT = "spx";
const CANONICAL_PROJECT = "spx-production";
const PRODUCTION_RELEASE_ROOT = "/root/spx-releases";
const DEFAULT_JOURNAL_PATH = "/var/lib/spx-production-mutation/project-identity-journal.json";
const MAX_DOCKER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_APPROVAL_BYTES = 256 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_COMPOSE_FILE_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.ya?ml$/;
const SAFE_ENV_FILE_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*\.env(?:\.[A-Za-z0-9._-]+)?$/;
const PRODUCTION_ENV_FILE = "/etc/spx-production/runtime.env";

function fail(code) {
  throw new Error(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertExactKeys(value, keys, code = "production-project-approval-invalid") {
  if (!isObject(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function assertPattern(value, pattern, code = "production-project-approval-invalid") {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
}

function parseIso(value, code = "production-project-approval-invalid") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(code);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return milliseconds;
}

function assertSortedUnique(values, pattern, code = "production-project-approval-invalid") {
  if (!Array.isArray(values) || values.length === 0) fail(code);
  for (const value of values) assertPattern(value, pattern, code);
  const sorted = [...values].sort();
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== sorted[index])
  ) {
    fail(code);
  }
}

function immutableProductionWorkingDirectory(sourceSha) {
  assertPattern(sourceSha, COMMIT_SHA_PATTERN);
  return `${PRODUCTION_RELEASE_ROOT}/${sourceSha}/operator`;
}

function validateApproval(approval, nowMs, requireWindow = true) {
  assertExactKeys(approval, [
    "schemaVersion",
    "currentProductionSha",
    "approvedImageRef",
    "approvedImageDigest",
    "services",
    "maintenanceWindow",
    "volumeMappings",
    "networkMappings",
    "portBindings",
    "healthThresholds",
    "rollbackOwner",
    "compose",
  ]);
  if (approval.schemaVersion !== 1) fail("production-project-approval-invalid");
  assertPattern(approval.currentProductionSha, COMMIT_SHA_PATTERN);
  const imageRefIsDigest =
    typeof approval.approvedImageRef === "string" &&
    approval.approvedImageRef.endsWith(`@${approval.approvedImageDigest}`);
  const imageRefIsReleaseTag =
    typeof approval.approvedImageRef === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}:[0-9a-f]{40}$/.test(approval.approvedImageRef) &&
    approval.approvedImageRef.endsWith(`:${approval.currentProductionSha}`);
  if (
    typeof approval.approvedImageRef !== "string" ||
    approval.approvedImageRef.length > 512 ||
    (!imageRefIsDigest && !imageRefIsReleaseTag)
  ) {
    fail("production-project-approval-invalid");
  }
  assertPattern(approval.approvedImageDigest, IMAGE_DIGEST_PATTERN);
  assertSortedUnique(approval.services, SERVICE_PATTERN);

  assertExactKeys(approval.maintenanceWindow, ["notBefore", "notAfter"]);
  const notBefore = parseIso(approval.maintenanceWindow.notBefore);
  const notAfter = parseIso(approval.maintenanceWindow.notAfter);
  if (notAfter <= notBefore || notAfter - notBefore > 24 * 60 * 60 * 1_000) {
    fail("production-project-approval-invalid");
  }
  if (requireWindow && (nowMs < notBefore || nowMs > notAfter)) {
    fail("production-project-approval-outside-window");
  }

  if (!Array.isArray(approval.volumeMappings) || approval.volumeMappings.length === 0) {
    fail("production-project-approval-invalid");
  }
  const volumeNames = new Set();
  for (const mapping of approval.volumeMappings) {
    assertExactKeys(mapping, ["name", "legacyName", "canonicalName", "stateful"]);
    for (const key of ["name", "legacyName", "canonicalName"]) {
      assertPattern(mapping[key], /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
    }
    if (typeof mapping.stateful !== "boolean" || volumeNames.has(mapping.name)) {
      fail("production-project-approval-invalid");
    }
    volumeNames.add(mapping.name);
    if (mapping.stateful && mapping.legacyName !== mapping.canonicalName) {
      fail("production-project-stateful-volume-remap");
    }
  }

  if (!Array.isArray(approval.networkMappings) || approval.networkMappings.length === 0) {
    fail("production-project-approval-invalid");
  }
  const networkNames = new Set();
  for (const mapping of approval.networkMappings) {
    assertExactKeys(mapping, ["legacyName", "canonicalName", "networkId"]);
    assertPattern(mapping.legacyName, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
    assertPattern(mapping.canonicalName, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
    assertPattern(mapping.networkId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
    if (mapping.legacyName !== mapping.canonicalName || networkNames.has(mapping.legacyName)) {
      fail("production-project-network-remap");
    }
    networkNames.add(mapping.legacyName);
  }

  if (!Array.isArray(approval.portBindings)) fail("production-project-approval-invalid");
  const ports = new Set();
  for (const binding of approval.portBindings) {
    assertExactKeys(binding, ["service", "containerPort", "hostIp", "hostPort"]);
    assertPattern(binding.service, SERVICE_PATTERN);
    if (!approval.services.includes(binding.service)) fail("production-project-approval-invalid");
    assertPattern(binding.containerPort, /^\d{1,5}\/(?:tcp|udp)$/);
    assertPattern(binding.hostIp, /^(?:\d{1,3}\.){3}\d{1,3}$|^::$/);
    assertPattern(binding.hostPort, /^\d{1,5}$/);
    const key = canonicalJson(binding);
    if (ports.has(key)) fail("production-project-approval-invalid");
    ports.add(key);
  }

  assertExactKeys(approval.healthThresholds, [
    "startupTimeoutMs",
    "pollIntervalMs",
    "requiredStatus",
  ]);
  if (
    !Number.isSafeInteger(approval.healthThresholds.startupTimeoutMs) ||
    approval.healthThresholds.startupTimeoutMs < 1 ||
    approval.healthThresholds.startupTimeoutMs > 15 * 60 * 1_000 ||
    !Number.isSafeInteger(approval.healthThresholds.pollIntervalMs) ||
    approval.healthThresholds.pollIntervalMs < 1 ||
    approval.healthThresholds.pollIntervalMs > 30_000 ||
    approval.healthThresholds.pollIntervalMs > approval.healthThresholds.startupTimeoutMs ||
    approval.healthThresholds.requiredStatus !== "healthy"
  ) {
    fail("production-project-approval-invalid");
  }
  assertPattern(approval.rollbackOwner, ID_PATTERN);

  assertExactKeys(approval.compose, ["workingDirectory", "files", "envFile", "configSha256"]);
  if (approval.compose.workingDirectory !== immutableProductionWorkingDirectory(approval.currentProductionSha)) {
    fail("production-project-approval-invalid");
  }
  assertSortedUnique(approval.compose.files, SAFE_COMPOSE_FILE_PATTERN);
  if (
    approval.compose.envFile !== PRODUCTION_ENV_FILE &&
    !SAFE_ENV_FILE_PATTERN.test(approval.compose.envFile)
  ) {
    fail("production-project-approval-invalid");
  }
  assertExactKeys(approval.compose.configSha256, approval.services);
  for (const service of approval.services) {
    assertPattern(approval.compose.configSha256[service], SHA256_PATTERN);
  }
  return structuredClone(approval);
}

export function verifyProductionIdentityReleaseBinding(approval, releaseManifest) {
  if (!isObject(releaseManifest)) fail("production-project-release-binding-invalid");
  assertPattern(
    releaseManifest.sourceSha,
    COMMIT_SHA_PATTERN,
    "production-project-release-binding-invalid",
  );
  assertPattern(
    releaseManifest.imageId,
    IMAGE_DIGEST_PATTERN,
    "production-project-release-binding-invalid",
  );
  if (typeof releaseManifest.imageTag !== "string" || releaseManifest.imageTag.length > 512) {
    fail("production-project-release-binding-invalid");
  }
  if (
    releaseManifest.sourceSha !== approval.currentProductionSha ||
    releaseManifest.imageId !== approval.approvedImageDigest ||
    releaseManifest.imageTag !== approval.approvedImageRef
  ) {
    fail("production-project-release-binding-mismatch");
  }
  return {
    sourceSha: releaseManifest.sourceSha,
    imageId: releaseManifest.imageId,
    imageTag: releaseManifest.imageTag,
  };
}

function createDefaultDockerRunner() {
  return (args, options = {}) =>
    new Promise((resolveRun, rejectRun) => {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
        rejectRun(new Error("production-project-docker-command-invalid"));
        return;
      }
      const child = spawn("docker", args, {
        cwd: options.cwd ?? "/",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderrBytes = 0;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        rejectRun(new Error("production-project-docker-command-timeout"));
      }, options.timeoutMs ?? 60_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > MAX_DOCKER_OUTPUT_BYTES && !settled) {
          settled = true;
          clearTimeout(timeout);
          child.kill("SIGKILL");
          rejectRun(new Error("production-project-docker-output-too-large"));
        }
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_DOCKER_OUTPUT_BYTES && !settled) {
          settled = true;
          clearTimeout(timeout);
          child.kill("SIGKILL");
          rejectRun(new Error("production-project-docker-output-too-large"));
        }
      });
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectRun(new Error("production-project-docker-command-failed"));
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0 || signal) {
          rejectRun(new Error("production-project-docker-command-failed"));
          return;
        }
        resolveRun(stdout);
      });
    });
}

async function inspectProject(runDocker, project) {
  const idSource = await runDocker(
    ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
    { cwd: "/", timeoutMs: 30_000 },
  );
  if (typeof idSource !== "string" || Buffer.byteLength(idSource) > MAX_DOCKER_OUTPUT_BYTES) {
    fail("production-project-inspection-invalid");
  }
  const ids = idSource
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    ids.length > 64 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !ID_PATTERN.test(id))
  ) {
    fail("production-project-inspection-invalid");
  }
  if (ids.length === 0) return [];
  const source = await runDocker(["inspect", ...ids], {
    cwd: "/",
    timeoutMs: 30_000,
  });
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_DOCKER_OUTPUT_BYTES) {
    fail("production-project-inspection-invalid");
  }
  let values;
  try {
    values = JSON.parse(source);
  } catch {
    fail("production-project-inspection-invalid");
  }
  if (!Array.isArray(values) || values.length !== ids.length) {
    fail("production-project-inspection-invalid");
  }
  for (const value of values) {
    if (!isObject(value) || value.Config?.Labels?.["com.docker.compose.project"] !== project) {
      fail("production-project-inspection-invalid");
    }
  }
  return values;
}

async function inspectProjects(runDocker) {
  const legacy = await inspectProject(runDocker, LEGACY_PROJECT);
  const canonical = await inspectProject(runDocker, CANONICAL_PROJECT);
  return { legacy, canonical };
}

function serviceOf(container) {
  const service = container.Config?.Labels?.["com.docker.compose.service"];
  assertPattern(service, SERVICE_PATTERN, "production-project-inspection-invalid");
  return service;
}

function runningContainers(containers) {
  return containers.filter((container) => container.State?.Running === true);
}

function assertNoUnknownServices(snapshot, approval) {
  for (const container of [...snapshot.legacy, ...snapshot.canonical]) {
    const service = serviceOf(container);
    if (!approval.services.includes(service)) fail("production-project-unknown-service");
  }
}

function actualPorts(containers) {
  const values = [];
  for (const container of containers) {
    const service = serviceOf(container);
    const ports = container.NetworkSettings?.Ports;
    if (!isObject(ports)) fail("production-project-inspection-invalid");
    for (const [containerPort, bindings] of Object.entries(ports)) {
      if (bindings === null) continue;
      if (!Array.isArray(bindings)) fail("production-project-inspection-invalid");
      for (const binding of bindings) {
        if (!isObject(binding)) fail("production-project-inspection-invalid");
        values.push({
          service,
          containerPort,
          hostIp: binding.HostIp,
          hostPort: binding.HostPort,
        });
      }
    }
  }
  return values.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function validateProjectSet(containers, project, approval, requireHealthy = true) {
  const running = runningContainers(containers);
  const services = running.map(serviceOf).sort();
  if (
    new Set(services).size !== services.length ||
    canonicalJson(services) !== canonicalJson(approval.services)
  ) {
    fail("production-project-service-set-mismatch");
  }
  const expectedVolumeNames = new Set(
    approval.volumeMappings.map((mapping) =>
      project === LEGACY_PROJECT ? mapping.legacyName : mapping.canonicalName,
    ),
  );
  const observedVolumeNames = new Set();
  const expectedNetworks = new Map(
    approval.networkMappings.map((mapping) => [
      project === LEGACY_PROJECT ? mapping.legacyName : mapping.canonicalName,
      mapping.networkId,
    ]),
  );
  const observedNetworks = new Set();

  for (const container of running) {
    const service = serviceOf(container);
    if (
      container.Config?.Image !== approval.approvedImageRef ||
      container.Image !== approval.approvedImageDigest ||
      container.Config?.Labels?.["org.opencontainers.image.revision"] !==
        approval.currentProductionSha ||
      container.Config?.Labels?.["com.docker.compose.config-hash"] !==
        approval.compose.configSha256[service]
    ) {
      fail("production-project-image-drift");
    }
    if (
      requireHealthy &&
      container.State?.Health?.Status !== approval.healthThresholds.requiredStatus
    ) {
      fail("production-project-not-ready");
    }
    if (!Array.isArray(container.Mounts)) fail("production-project-inspection-invalid");
    for (const mount of container.Mounts) {
      if (!isObject(mount)) fail("production-project-inspection-invalid");
      if (mount.Type === "volume") {
        const name = mount.Name;
        if (
          typeof name !== "string" ||
          /^[0-9a-f]{64}$/.test(name) ||
          !expectedVolumeNames.has(name)
        ) {
          fail("production-project-volume-ambiguity");
        }
        observedVolumeNames.add(name);
      } else if (mount.RW === true) {
        fail("production-project-volume-ambiguity");
      }
    }
    const networks = container.NetworkSettings?.Networks;
    if (!isObject(networks)) fail("production-project-inspection-invalid");
    for (const [name, network] of Object.entries(networks)) {
      if (!expectedNetworks.has(name) || network?.NetworkID !== expectedNetworks.get(name)) {
        fail("production-project-network-ambiguity");
      }
      observedNetworks.add(name);
    }
  }
  if (
    canonicalJson([...observedVolumeNames].sort()) !==
      canonicalJson([...expectedVolumeNames].sort()) ||
    canonicalJson([...observedNetworks].sort()) !==
      canonicalJson([...expectedNetworks.keys()].sort())
  ) {
    fail("production-project-state-mapping-mismatch");
  }
  if (
    canonicalJson(actualPorts(running)) !==
    canonicalJson(
      [...approval.portBindings].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      ),
    )
  ) {
    fail("production-project-port-conflict");
  }
  return sanitizeIdentity(project, running, approval);
}

function sanitizeIdentity(project, containers, approval) {
  return {
    owner: project,
    releaseSha: approval.currentProductionSha,
    imageRef: approval.approvedImageRef,
    imageDigest: approval.approvedImageDigest,
    configSha256: approval.compose.configSha256,
    services: containers.map(serviceOf).sort(),
    volumes: [
      ...new Set(
        containers.flatMap((container) =>
          container.Mounts.filter((mount) => mount.Type === "volume").map((mount) => mount.Name),
        ),
      ),
    ].sort(),
    networks: [
      ...new Set(
        containers.flatMap((container) => Object.keys(container.NetworkSettings.Networks)),
      ),
    ].sort(),
    ports: actualPorts(containers),
    readiness: "healthy",
  };
}

function classifyOwner(snapshot, approval, requireHealthy = true) {
  assertNoUnknownServices(snapshot, approval);
  const legacy = runningContainers(snapshot.legacy);
  const canonical = runningContainers(snapshot.canonical);
  if (legacy.length > 0 && canonical.length > 0) fail("production-project-mixed-owners");
  if (legacy.length === 0 && canonical.length === 0) fail("production-project-no-owner");
  if (canonical.length > 0) {
    return validateProjectSet(snapshot.canonical, CANONICAL_PROJECT, approval, requireHealthy);
  }
  return validateProjectSet(snapshot.legacy, LEGACY_PROJECT, approval, requireHealthy);
}

export async function verifyProductionProjectIdentity(options) {
  const nowMs = options.nowMs ?? Date.now();
  const approval = validateApproval(options.approval, nowMs, false);
  const runDocker = options.runDocker ?? createDefaultDockerRunner();
  const identity = classifyOwner(await inspectProjects(runDocker), approval, true);
  if (identity.owner !== CANONICAL_PROJECT) fail("production-project-legacy-adoption-required");
  return identity;
}

function composePrefix(approval, project) {
  const envFile = isAbsolute(approval.compose.envFile)
    ? approval.compose.envFile
    : resolve(approval.compose.workingDirectory, approval.compose.envFile);
  const prefix = [
    "compose",
    "--project-directory",
    approval.compose.workingDirectory,
    "--env-file",
    envFile,
  ];
  for (const file of approval.compose.files) {
    prefix.push("--file", resolve(approval.compose.workingDirectory, file));
  }
  prefix.push("-p", project);
  return prefix;
}

function stopCommand(approval, project) {
  return [
    ...composePrefix(approval, project),
    "stop",
    "--timeout",
    String(Math.max(1, Math.ceil(approval.healthThresholds.startupTimeoutMs / 1_000))),
    ...approval.services,
  ];
}

function startCommand(approval, project) {
  return [
    ...composePrefix(approval, project),
    "up",
    "-d",
    "--no-build",
    "--no-deps",
    ...approval.services,
  ];
}

function fsyncDirectory(path) {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (count <= 0) fail("production-project-journal-write-failed");
    offset += count;
  }
}

function writeJournalDurably(path, journal) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.identity-journal.${process.pid}.${randomUUID()}`);
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeAll(descriptor, Buffer.from(`${canonicalJson(journal)}\n`, "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readJournal(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail("production-project-journal-missing");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_APPROVAL_BYTES) {
    fail("production-project-journal-invalid");
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("production-project-journal-invalid");
  }
  if (
    !isObject(journal) ||
    journal.schemaVersion !== 1 ||
    !ID_PATTERN.test(journal.journalId ?? "") ||
    !SHA256_PATTERN.test(journal.approvalSha256 ?? "") ||
    ![
      "prepared",
      "legacy-stopped",
      "canonical-started",
      "completed",
      "rolling-back",
      "rolled-back",
    ].includes(journal.state)
  ) {
    fail("production-project-journal-invalid");
  }
  return journal;
}

function persistJournal(path, journal, state, nowMs, patch = {}) {
  const next = {
    ...journal,
    ...patch,
    state,
    updatedAt: new Date(nowMs).toISOString(),
  };
  writeJournalDurably(path, next);
  return next;
}

async function assertProjectStopped(runDocker, project, approval) {
  const containers = await inspectProject(runDocker, project);
  for (const container of containers) {
    const service = serviceOf(container);
    if (!approval.services.includes(service)) fail("production-project-unknown-service");
    if (container.State?.Running === true) fail("production-project-zero-overlap-failed");
  }
}

async function waitForOwner(options, project) {
  const deadline = options.now() + options.approval.healthThresholds.startupTimeoutMs;
  let lastError = new Error("production-project-not-ready");
  do {
    try {
      const identity = classifyOwner(
        await inspectProjects(options.runDocker),
        options.approval,
        true,
      );
      if (identity.owner !== project) fail("production-project-owner-mismatch");
      return identity;
    } catch (error) {
      lastError = error;
    }
    await options.sleep(options.approval.healthThresholds.pollIntervalMs);
  } while (options.now() <= deadline);
  throw lastError;
}

async function rollbackFromJournal(options, journal) {
  const { approval, runDocker, journalPath, now, sleep } = options;
  journal = persistJournal(journalPath, journal, "rolling-back", now());
  const snapshot = await inspectProjects(runDocker);
  assertNoUnknownServices(snapshot, approval);
  if (runningContainers(snapshot.canonical).length > 0) {
    validateProjectSet(snapshot.canonical, CANONICAL_PROJECT, approval, false);
    await runDocker(stopCommand(approval, CANONICAL_PROJECT), {
      cwd: approval.compose.workingDirectory,
      timeoutMs: approval.healthThresholds.startupTimeoutMs,
    });
  }
  await assertProjectStopped(runDocker, CANONICAL_PROJECT, approval);

  await runDocker(startCommand(approval, LEGACY_PROJECT), {
    cwd: approval.compose.workingDirectory,
    timeoutMs: approval.healthThresholds.startupTimeoutMs,
  });
  const identity = await waitForOwner({ approval, runDocker, now, sleep }, LEGACY_PROJECT);
  persistJournal(journalPath, journal, "rolled-back", now(), {
    after: identity,
    terminalPostcondition: "legacy-baseline-restored",
  });
  return identity;
}

export async function adoptProductionProjectIdentity(options) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const approval = validateApproval(options.approval, now(), true);
  const runDocker = options.runDocker ?? createDefaultDockerRunner();
  const journalPath = resolve(options.journalPath ?? DEFAULT_JOURNAL_PATH);
  const before = classifyOwner(await inspectProjects(runDocker), approval, true);
  if (before.owner !== LEGACY_PROJECT) fail("production-project-canonical-already-owned");

  const createdAt = new Date(now()).toISOString();
  let journal = {
    schemaVersion: 1,
    journalId: `identity-${randomUUID()}`,
    approvalSha256: sha256Canonical(approval),
    state: "prepared",
    createdAt,
    updatedAt: createdAt,
    before,
    after: null,
    rollback: {
      owner: approval.rollbackOwner,
      project: LEGACY_PROJECT,
      releaseSha: approval.currentProductionSha,
      imageRef: approval.approvedImageRef,
      imageDigest: approval.approvedImageDigest,
      configSha256: approval.compose.configSha256,
      services: approval.services,
      stopCanonicalCommand: stopCommand(approval, CANONICAL_PROJECT),
      startLegacyCommand: startCommand(approval, LEGACY_PROJECT),
    },
    terminalPostcondition: null,
  };
  writeJournalDurably(journalPath, journal);
  let mutationStarted = false;
  try {
    mutationStarted = true;
    await runDocker(stopCommand(approval, LEGACY_PROJECT), {
      cwd: approval.compose.workingDirectory,
      timeoutMs: approval.healthThresholds.startupTimeoutMs,
    });
    await assertProjectStopped(runDocker, LEGACY_PROJECT, approval);
    await assertProjectStopped(runDocker, CANONICAL_PROJECT, approval);
    journal = persistJournal(journalPath, journal, "legacy-stopped", now());

    await runDocker(startCommand(approval, CANONICAL_PROJECT), {
      cwd: approval.compose.workingDirectory,
      timeoutMs: approval.healthThresholds.startupTimeoutMs,
    });
    journal = persistJournal(journalPath, journal, "canonical-started", now());
    const after = await waitForOwner({ approval, runDocker, now, sleep }, CANONICAL_PROJECT);
    persistJournal(journalPath, journal, "completed", now(), {
      after,
      terminalPostcondition: "canonical-healthy-sole-owner",
    });
    return after;
  } catch {
    if (!mutationStarted) throw new Error("production-project-adoption-failed");
    try {
      await rollbackFromJournal({ approval, runDocker, journalPath, now, sleep }, journal);
    } catch {
      throw new Error("production-project-adoption-recovery-required");
    }
    throw new Error("production-project-adoption-rolled-back");
  }
}

export async function rollbackProductionProjectIdentity(options) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const approval = validateApproval(options.approval, now(), false);
  const runDocker = options.runDocker ?? createDefaultDockerRunner();
  const journalPath = resolve(options.journalPath ?? DEFAULT_JOURNAL_PATH);
  const journal = readJournal(journalPath);
  if (journal.approvalSha256 !== sha256Canonical(approval))
    fail("production-project-journal-approval-mismatch");
  return rollbackFromJournal({ approval, runDocker, journalPath, now, sleep }, journal);
}

export async function reconcileProductionProjectIdentity(options) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const approval = validateApproval(options.approval, now(), false);
  const runDocker = options.runDocker ?? createDefaultDockerRunner();
  const journalPath = resolve(options.journalPath ?? DEFAULT_JOURNAL_PATH);
  const journal = readJournal(journalPath);
  if (journal.approvalSha256 !== sha256Canonical(approval))
    fail("production-project-journal-approval-mismatch");
  if (journal.state === "completed") {
    const identity = classifyOwner(await inspectProjects(runDocker), approval, true);
    if (identity.owner !== CANONICAL_PROJECT) fail("production-project-reconcile-required");
    return { outcome: "canonical-healthy", identity };
  }
  if (journal.state === "rolled-back") {
    const identity = classifyOwner(await inspectProjects(runDocker), approval, true);
    if (identity.owner !== LEGACY_PROJECT) fail("production-project-reconcile-required");
    return { outcome: "legacy-restored", identity };
  }
  try {
    const identity = classifyOwner(await inspectProjects(runDocker), approval, true);
    if (identity.owner === CANONICAL_PROJECT) {
      persistJournal(journalPath, journal, "completed", now(), {
        after: identity,
        terminalPostcondition: "canonical-healthy-sole-owner",
      });
      return { outcome: "canonical-healthy", identity };
    }
  } catch {
    // Any inconclusive state falls through to the recorded reverse rollback.
  }
  const identity = await rollbackFromJournal(
    { approval, runDocker, journalPath, now, sleep },
    journal,
  );
  return { outcome: "rolled-back", identity };
}

export async function verifyExpectedProductionProjectIdentity(options) {
  assertPattern(options.expectedImage, IMAGE_DIGEST_PATTERN, "production-project-cli-invalid");
  assertSortedUnique(options.expectedServices, SERVICE_PATTERN, "production-project-cli-invalid");
  const runDocker = options.runDocker ?? createDefaultDockerRunner();
  const snapshot = await inspectProjects(runDocker);
  const legacy = runningContainers(snapshot.legacy);
  const canonical = runningContainers(snapshot.canonical);
  if (legacy.length > 0 && canonical.length > 0) fail("production-project-mixed-owners");
  if (legacy.length > 0) fail("production-project-legacy-adoption-required");
  if (canonical.length === 0) fail("production-project-no-owner");
  const services = canonical.map(serviceOf).sort();
  if (canonical.some((container) => container.Image !== options.expectedImage)) {
    fail("production-project-image-drift");
  }
  if (canonical.some((container) => container.State?.Health?.Status !== "healthy")) {
    fail("production-project-not-ready");
  }
  if (canonicalJson(services) !== canonicalJson(options.expectedServices)) {
    fail("production-project-service-set-mismatch");
  }
  return { owner: CANONICAL_PROJECT, imageDigest: options.expectedImage, services };
}

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) fail("production-project-cli-invalid");
    const separator = arg.indexOf("=");
    const key = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (key === "" || value === "" || key in values) fail("production-project-cli-invalid");
    values[key] = value;
  }
  return values;
}

function assertCliKeys(values, allowed) {
  const allowedSet = new Set(allowed);
  if (Object.keys(values).some((key) => !allowedSet.has(key))) {
    fail("production-project-cli-invalid");
  }
}

function readJsonDocument(path, invalidCode) {
  if (!isAbsolute(path)) fail("production-project-cli-invalid");
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(invalidCode);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_APPROVAL_BYTES) {
    fail(invalidCode);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(invalidCode);
  }
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const action = values.action;
  if (!/^(?:verify|adopt|rollback|reconcile)$/.test(action ?? "")) {
    fail("production-project-cli-invalid");
  }
  if (action === "verify" && values.approval === undefined) {
    assertCliKeys(values, ["action", "expected-image", "expected-services"]);
    const expectedServices = (values["expected-services"] ?? "").split(",").filter(Boolean).sort();
    const result = await verifyExpectedProductionProjectIdentity({
      expectedImage: values["expected-image"],
      expectedServices,
    });
    console.log(canonicalJson({ ok: true, owner: result.owner, services: result.services }));
    return;
  }
  assertCliKeys(values, ["action", "approval", "release-manifest", "journal"]);
  if (typeof values.approval !== "string") fail("production-project-cli-invalid");
  const approval = readJsonDocument(values.approval, "production-project-approval-invalid");
  if (values["release-manifest"] !== undefined) {
    const releaseManifest = readJsonDocument(
      values["release-manifest"],
      "production-project-release-binding-invalid",
    );
    verifyProductionIdentityReleaseBinding(approval, releaseManifest);
  }
  const journalPath = values.journal ?? DEFAULT_JOURNAL_PATH;
  if (journalPath !== DEFAULT_JOURNAL_PATH && process.env.NODE_ENV !== "test") {
    fail("production-project-cli-invalid");
  }
  const shared = { approval, journalPath };
  const result =
    action === "verify"
      ? await verifyProductionProjectIdentity(shared)
      : action === "adopt"
        ? await adoptProductionProjectIdentity(shared)
        : action === "rollback"
          ? await rollbackProductionProjectIdentity(shared)
          : await reconcileProductionProjectIdentity(shared);
  console.log(
    canonicalJson({
      ok: true,
      owner: result.owner ?? result.identity?.owner,
      outcome: result.outcome,
    }),
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "production-project-identity-failed");
    process.exitCode = 1;
  });
}
