#!/usr/bin/env node

import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, statfs } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases, monotonicNowMs } from "./lib/a3-staging-leases.mjs";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";
import {
  loadInstalledStagingActionCapability,
  loadStagingDatabaseCredential,
} from "./lib/staging-action-capability.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";
import {
  STAGING_PHASE3_PRODUCTION_OBSERVER_POLICY_PATH,
  STAGING_PHASE3_PRODUCTION_OBSERVER_TOKEN_PATH,
  validateStagingProductionObserverPolicyBytes,
  validateStagingProductionObserverTokenBytes,
} from "./lib/staging-production-observer-policy.mjs";
import { phase3PartitionIdentity } from "./lib/phase3-staging-evidence.mjs";
import {
  loadGrantContract,
  loadMysqlPromiseClient,
  runGrantCheck,
} from "./db-grants-check.mjs";

const SNAPSHOT_NUMBERS = [
  "a3CpuPercent",
  "a3MemoryFreeBytes",
  "a3DiskFreeBytes",
  "a3InodeFreePercent",
  "a3PidFree",
  "a3NetworkRxUtilizationPercent",
  "a3NetworkTxUtilizationPercent",
  "a3NetworkHeadroomMbps",
  "sharedMysqlConnectionsFree",
  "sharedMysqlConnectionHeadroomPercent",
  "productionP95LatencyMs",
  "productionBaselineP95LatencyMs",
];

const THRESHOLD_NUMBERS = [
  "maxCpuPercent",
  "minMemoryFreeBytes",
  "minDiskFreeBytes",
  "minInodeFreePercent",
  "minPidFree",
  "maxNetworkRxUtilizationPercent",
  "maxNetworkTxUtilizationPercent",
  "minNetworkHeadroomMbps",
  "minMysqlConnectionsFree",
  "minMysqlConnectionHeadroomPercent",
  "maxProductionP95LatencyMs",
  "maxLatencyIncreasePercent",
];

function validNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validInput(snapshot, thresholds) {
  return Boolean(
    snapshot &&
      thresholds &&
      SNAPSHOT_NUMBERS.every((field) => validNumber(snapshot[field])) &&
      THRESHOLD_NUMBERS.every((field) => validNumber(thresholds[field])) &&
      typeof snapshot.productionReady === "boolean" &&
      typeof snapshot.a3StagingPortAvailable === "boolean" &&
      snapshot.productionBaselineP95LatencyMs > 0,
  );
}

export function evaluateCapacitySnapshot(snapshot, thresholds) {
  if (!validInput(snapshot, thresholds)) {
    return { ok: false, failures: ["CAPACITY_SNAPSHOT_INVALID"] };
  }

  const failures = [];
  if (!snapshot.productionReady) failures.push("PRODUCTION_NOT_READY");
  if (!snapshot.a3StagingPortAvailable) failures.push("STAGING_PORT_COLLISION");
  if (snapshot.a3CpuPercent > thresholds.maxCpuPercent) failures.push("A3_CPU_BUDGET_EXCEEDED");
  if (snapshot.a3MemoryFreeBytes < thresholds.minMemoryFreeBytes)
    failures.push("A3_MEMORY_HEADROOM_LOW");
  if (snapshot.a3DiskFreeBytes < thresholds.minDiskFreeBytes)
    failures.push("A3_DISK_HEADROOM_LOW");
  if (snapshot.a3InodeFreePercent < thresholds.minInodeFreePercent)
    failures.push("A3_INODE_HEADROOM_LOW");
  if (snapshot.a3PidFree < thresholds.minPidFree) failures.push("A3_PID_HEADROOM_LOW");
  if (snapshot.a3NetworkRxUtilizationPercent > thresholds.maxNetworkRxUtilizationPercent)
    failures.push("A3_NETWORK_RX_BUDGET_EXCEEDED");
  if (snapshot.a3NetworkTxUtilizationPercent > thresholds.maxNetworkTxUtilizationPercent)
    failures.push("A3_NETWORK_TX_BUDGET_EXCEEDED");
  if (snapshot.a3NetworkHeadroomMbps < thresholds.minNetworkHeadroomMbps)
    failures.push("A3_NETWORK_HEADROOM_LOW");
  if (snapshot.sharedMysqlConnectionsFree < thresholds.minMysqlConnectionsFree)
    failures.push("MYSQL_CONNECTION_HEADROOM_LOW");
  if (
    snapshot.sharedMysqlConnectionHeadroomPercent < thresholds.minMysqlConnectionHeadroomPercent
  )
    failures.push("MYSQL_CONNECTION_PERCENT_HEADROOM_LOW");
  if (snapshot.productionP95LatencyMs > thresholds.maxProductionP95LatencyMs)
    failures.push("PRODUCTION_LATENCY_BUDGET_EXCEEDED");

  const latencyIncreasePercent =
    ((snapshot.productionP95LatencyMs - snapshot.productionBaselineP95LatencyMs) /
      snapshot.productionBaselineP95LatencyMs) *
    100;
  if (latencyIncreasePercent > thresholds.maxLatencyIncreasePercent)
    failures.push("PRODUCTION_LATENCY_INCREASE_EXCEEDED");
  return { ok: failures.length === 0, failures };
}

export function thresholdsFromApprovedPolicy(policy) {
  return Object.freeze({
    maxCpuPercent: policy?.maxCpuPercent,
    minMemoryFreeBytes: policy?.minMemoryFreeBytes,
    minDiskFreeBytes: 10_000_000_000,
    minInodeFreePercent: 20,
    minPidFree: 1_000,
    maxNetworkRxUtilizationPercent: 70,
    maxNetworkTxUtilizationPercent: 70,
    minNetworkHeadroomMbps: 100,
    minMysqlConnectionsFree: policy?.minMysqlConnectionsFree,
    minMysqlConnectionHeadroomPercent: 30,
    maxProductionP95LatencyMs: policy?.productionP95LatencyMs,
    maxLatencyIncreasePercent: policy?.maxLatencyIncreasePercent,
  });
}

export async function collectCapacitySnapshot(ports) {
  if (
    typeof ports?.collectLocal !== "function" ||
    typeof ports?.collectMysql !== "function" ||
    typeof ports?.collectProduction !== "function" ||
    !validNumber(ports?.productionBaselineP95LatencyMs) ||
    ports.productionBaselineP95LatencyMs <= 0
  ) {
    throw new Error("capacity collector ports are invalid");
  }
  const [local, mysql, production] = await Promise.all([
    ports.collectLocal(),
    ports.collectMysql(),
    ports.collectProduction(),
  ]);
  const snapshot = {
    ...local,
    ...mysql,
    ...production,
    productionBaselineP95LatencyMs: ports.productionBaselineP95LatencyMs,
  };
  if (!SNAPSHOT_NUMBERS.every((field) => validNumber(snapshot[field]))) {
    throw new Error("capacity collector returned invalid numbers");
  }
  return snapshot;
}

function parseCpuStat(source) {
  const line = source.split(/\r?\n/, 1)[0];
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  if (!line.startsWith("cpu ") || values.length < 5 || values.some((value) => !validNumber(value))) {
    throw new Error("local CPU statistics are invalid");
  }
  return { total: values.reduce((sum, value) => sum + value, 0), idle: values[3] + values[4] };
}

function parseNetworkStat(source) {
  const totals = { rx: 0, tx: 0, interfaces: [] };
  for (const line of source.split(/\r?\n/).slice(2)) {
    const match = line.match(/^\s*([^:]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
    if (!match || match[1].trim() === "lo") continue;
    totals.interfaces.push(match[1].trim());
    totals.rx += Number(match[2]);
    totals.tx += Number(match[3]);
  }
  if (totals.interfaces.length === 0) throw new Error("local network statistics are unavailable");
  return totals;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function portAvailable() {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port: 3100, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function collectLocalCapacity(options = {}) {
  const [cpuBeforeSource, networkBeforeSource, memorySource, pidMaxSource, disk, processEntries] =
    await Promise.all([
      readFile("/proc/stat", "utf8"),
      readFile("/proc/net/dev", "utf8"),
      readFile("/proc/meminfo", "utf8"),
      readFile("/proc/sys/kernel/pid_max", "utf8"),
      statfs("/var/lib/spx-staging-rollout"),
      readdir("/proc", { withFileTypes: true }),
    ]);
  const beforeCpu = parseCpuStat(cpuBeforeSource);
  const beforeNetwork = parseNetworkStat(networkBeforeSource);
  const speeds = await Promise.all(
    beforeNetwork.interfaces.map(async (name) => {
      const value = Number((await readFile(`/sys/class/net/${name}/speed`, "utf8")).trim());
      if (!Number.isFinite(value) || value <= 0) throw new Error("local network capacity is invalid");
      return value;
    }),
  );
  const sampleMs = 250;
  await delay(sampleMs);
  const [cpuAfterSource, networkAfterSource] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    readFile("/proc/net/dev", "utf8"),
  ]);
  const afterCpu = parseCpuStat(cpuAfterSource);
  const afterNetwork = parseNetworkStat(networkAfterSource);
  const totalDelta = afterCpu.total - beforeCpu.total;
  const idleDelta = afterCpu.idle - beforeCpu.idle;
  if (totalDelta <= 0 || idleDelta < 0) throw new Error("local CPU sample is invalid");
  const capacityMbps = speeds.reduce((sum, value) => sum + value, 0);
  const rxMbps = (Math.max(0, afterNetwork.rx - beforeNetwork.rx) * 8) / sampleMs / 1_000;
  const txMbps = (Math.max(0, afterNetwork.tx - beforeNetwork.tx) * 8) / sampleMs / 1_000;
  const memoryMatch = memorySource.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  const pidMax = Number(pidMaxSource.trim());
  if (!memoryMatch || !Number.isSafeInteger(pidMax) || pidMax <= 0) {
    throw new Error("local resource statistics are invalid");
  }
  const activePids = processEntries.filter(
    (entry) => entry.isDirectory() && /^\d+$/.test(entry.name),
  ).length;
  return {
    a3CpuPercent: ((totalDelta - idleDelta) / totalDelta) * 100,
    a3MemoryFreeBytes: Number(memoryMatch[1]) * 1024,
    a3DiskFreeBytes: Number(disk.bavail) * Number(disk.bsize),
    a3InodeFreePercent: Number(disk.files) > 0 ? (Number(disk.ffree) / Number(disk.files)) * 100 : 0,
    a3PidFree: Math.max(0, pidMax - activePids),
    a3NetworkRxUtilizationPercent: (rxMbps / capacityMbps) * 100,
    a3NetworkTxUtilizationPercent: (txMbps / capacityMbps) * 100,
    a3NetworkHeadroomMbps: Math.max(0, capacityMbps - Math.max(rxMbps, txMbps)),
    a3StagingPortAvailable: options.continuous === true ? true : await portAvailable(),
  };
}

async function collectMysqlCapacity() {
  const configured = mysqlScriptConnectionConfigFromEnv();
  if (configured.missing.length > 0 || configured.value.database !== "spx_staging") {
    throw new Error("staging read-only MySQL observer is unavailable");
  }
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(configured.value);
  try {
    const [rows] = await connection.query(
      "SELECT @@GLOBAL.max_connections AS maxConnections, (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected') AS connected",
    );
    const maxConnections = Number(rows?.[0]?.maxConnections);
    const connected = Number(rows?.[0]?.connected);
    if (!Number.isSafeInteger(maxConnections) || !Number.isSafeInteger(connected) || maxConnections <= 0) {
      throw new Error("shared MySQL capacity result is invalid");
    }
    const free = Math.max(0, maxConnections - connected);
    return {
      sharedMysqlConnectionsFree: free,
      sharedMysqlConnectionHeadroomPercent: (free / maxConnections) * 100,
    };
  } finally {
    await connection.end();
  }
}

async function readPrivateCredential(path) {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1n || stat.size > 4_096n) {
    throw new Error("production observer credential is invalid");
  }
  if (
    process.platform !== "win32" &&
    (Number(stat.uid) !== 0 || (Number(stat.mode & 0o777n) & 0o077) !== 0)
  ) {
    throw new Error("production observer credential permissions are invalid");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
}

async function collectProductionCapacity() {
  const policyText = await readFile("/etc/spx-staging/production-observer.json", "utf8");
  const policy = JSON.parse(policyText);
  if (policyText !== canonicalJson(policy)) throw new Error("production observer policy is invalid");
  const url = new URL(policy.endpoint);
  if (
    Object.keys(policy).sort().join(",") !== "credentialPath,endpoint" ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    policy.credentialPath !== "/run/credentials/spx-production-observer-token"
  ) {
    throw new Error("production observer target is invalid");
  }
  const token = await readPrivateCredential(policy.credentialPath);
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok || text.length > 8_192) throw new Error("production observer request failed");
  const value = JSON.parse(text);
  if (
    Object.keys(value).sort().join(",") !== "p95LatencyMs,ready" ||
    typeof value.ready !== "boolean" ||
    !validNumber(value.p95LatencyMs)
  ) {
    throw new Error("production observer response is invalid");
  }
  return { productionReady: value.ready, productionP95LatencyMs: value.p95LatencyMs };
}

const FINAL_DATABASE_ROLE = "phase3-observer";
const FINAL_DATABASE_USERNAME = "spx_stg_phase3_observer";
const FINAL_DATABASE_NAME = "spx_staging";
const FINAL_TIMEOUT_MS = 5_000;
const FINAL_LEASE_MAX_AGE_MS = 10_000;
const FINAL_RESPONSE_MAX_BYTES = 8_192;
const CONTINUOUS_OBSERVER_POLICY_PATH = "/etc/spx-staging/production-observer.json";
const CONTINUOUS_OBSERVER_TOKEN_PATH = "/run/credentials/spx-production-observer-token";
const FINAL_FAILURE_ORDER = Object.freeze([
  "PRODUCTION_NOT_READY",
  "A3_CPU_BUDGET_EXCEEDED",
  "A3_MEMORY_HEADROOM_LOW",
  "A3_DISK_HEADROOM_LOW",
  "A3_INODE_HEADROOM_LOW",
  "A3_PID_HEADROOM_LOW",
  "A3_NETWORK_RX_BUDGET_EXCEEDED",
  "A3_NETWORK_TX_BUDGET_EXCEEDED",
  "A3_NETWORK_HEADROOM_LOW",
  "MYSQL_CONNECTION_HEADROOM_LOW",
  "MYSQL_CONNECTION_PERCENT_HEADROOM_LOW",
  "PRODUCTION_LATENCY_BUDGET_EXCEEDED",
  "PRODUCTION_LATENCY_INCREASE_EXCEEDED",
]);
const FINAL_TEST_PORT_NAMES = new Set([
  "collectLocal",
  "collectRuntimeInventory",
  "createMysqlConnection",
  "fetch",
  "loadCapability",
  "loadContext",
  "loadCredential",
  "loadGrantContract",
  "loadLeases",
  "readContinuousPolicy",
  "readFinalPolicy",
  "readFinalToken",
  "runGrantCheck",
]);
const FINAL_UTF8 = new TextDecoder("utf-8", { fatal: true });

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function finalCollectionFailure() {
  return new Error("installed Phase 3 capacity evidence collection failed");
}

function finalPrerequisiteFailure(changed = false) {
  return new Error(
    changed
      ? "installed Phase 3 capacity evidence prerequisite changed"
      : "installed Phase 3 capacity evidence prerequisite is invalid",
  );
}

function sanitizeFinalFailure(error) {
  if (
    error instanceof Error &&
    (error.message === "installed Phase 3 capacity evidence prerequisite is invalid" ||
      error.message === "installed Phase 3 capacity evidence prerequisite changed")
  ) return error;
  return finalCollectionFailure();
}

function assertTestPorts(callerArguments) {
  if (callerArguments.length === 0) return null;
  if (
    process.env.NODE_ENV !== "test" ||
    callerArguments.length !== 1 ||
    !callerArguments[0] ||
    typeof callerArguments[0] !== "object" ||
    Array.isArray(callerArguments[0])
  ) throw new Error("collectInstalledPhase3CapacityEvidence accepts zero arguments in production");
  const ports = callerArguments[0];
  try {
    const ownKeys = Reflect.ownKeys(ports);
    const descriptors = Object.getOwnPropertyDescriptors(ports);
    if (
      Object.getPrototypeOf(ports) !== Object.prototype ||
      ownKeys.length !== FINAL_TEST_PORT_NAMES.size ||
      ownKeys.some((name) => typeof name !== "string" || !FINAL_TEST_PORT_NAMES.has(name)) ||
      [...FINAL_TEST_PORT_NAMES].some((name) => {
        const descriptor = descriptors[name];
        return !descriptor ||
          descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, "value") ||
          typeof descriptor.value !== "function";
      })
    ) throw new Error("invalid");
  } catch {
    throw new Error("test-only capacity evidence ports are invalid");
  }
  return ports;
}

function exactObject(value, keys) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()),
  );
}

function validAccountHost(value) {
  return Boolean(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      value === value.trim() &&
      !/[%_]/.test(value) &&
      /^[A-Za-z0-9.:-]+$/.test(value),
  );
}

function assertFinalContext(context) {
  const descriptor = context?.descriptor;
  const expectedPolicySha256 = descriptor?.target?.productionObserverPolicySha256;
  const accountHost = descriptor?.database?.accountHosts?.[FINAL_DATABASE_ROLE];
  const thresholds = context?.envelope?.policy?.thresholds;
  if (
    context?.installedBinding?.stagingRunId === undefined ||
    descriptor?.releaseEnvironment !== "staging" ||
    descriptor?.runtimeEnvironment !== "staging" ||
    descriptor?.composeProject !== "spx-staging" ||
    descriptor?.database?.name !== FINAL_DATABASE_NAME ||
    typeof expectedPolicySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedPolicySha256) ||
    !validAccountHost(accountHost) ||
    !validNumber(thresholds?.maxCpuPercent) ||
    !validNumber(thresholds?.minMemoryFreeBytes) ||
    !validNumber(thresholds?.minMysqlConnectionsFree) ||
    !validNumber(thresholds?.productionP95LatencyMs) ||
    !validNumber(thresholds?.maxLatencyIncreasePercent)
  ) throw finalPrerequisiteFailure();
  return { expectedPolicySha256, accountHost, thresholds };
}

function assertLease(lease, role, stagingRunId, now) {
  if (
    !lease ||
    lease.role !== role ||
    lease.state !== "armed" ||
    lease.stagingRunId !== stagingRunId ||
    typeof lease.leaseId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(lease.leaseId) ||
    !Number.isSafeInteger(lease.pid) ||
    lease.pid <= 0 ||
    !Number.isSafeInteger(lease.startedMonotonicMs) ||
    lease.startedMonotonicMs < 0 ||
    !Number.isSafeInteger(lease.heartbeatMonotonicMs) ||
    lease.heartbeatMonotonicMs < lease.startedMonotonicMs ||
    lease.heartbeatMonotonicMs > now ||
    !validNumber(lease.heartbeatAgeMs) ||
    lease.heartbeatAgeMs > FINAL_LEASE_MAX_AGE_MS ||
    now - lease.heartbeatMonotonicMs > FINAL_LEASE_MAX_AGE_MS
  ) throw finalPrerequisiteFailure();
  return lease;
}

function assertFinalLeases(value, stagingRunId) {
  const now = monotonicNowMs();
  if (
    value?.stagingRunId !== stagingRunId ||
    value?.maxAgeMs !== FINAL_LEASE_MAX_AGE_MS
  ) throw finalPrerequisiteFailure();
  const guard = assertLease(value.guard, "guard", stagingRunId, now);
  const watchdog = assertLease(value.watchdog, "watchdog", stagingRunId, now);
  if (
    guard.leaseId === watchdog.leaseId ||
    !validNumber(guard.baselineP95LatencyMs) ||
    guard.baselineP95LatencyMs <= 0
  ) throw finalPrerequisiteFailure();
  return { guard, watchdog };
}

function assertUnchangedFinalLeases(before, after) {
  for (const role of ["guard", "watchdog"]) {
    for (const field of ["leaseId", "pid", "startedMonotonicMs", "baselineP95LatencyMs"]) {
      if (before[role][field] !== after[role][field]) throw finalPrerequisiteFailure(true);
    }
    if (after[role].heartbeatMonotonicMs < before[role].heartbeatMonotonicMs) {
      throw finalPrerequisiteFailure(true);
    }
  }
}

function normalizePrivateSnapshot(value, minimum, maximum) {
  const bytes = value?.bytes;
  const uidValid = process.platform === "win32" ? value?.uid === null || value?.uid === 0 : value?.uid === 0;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < minimum ||
    bytes.byteLength > maximum ||
    value?.symbolicLink !== false ||
    value?.regular !== true ||
    value?.nlink !== 1 ||
    value?.mode !== 0o400 ||
    !uidValid ||
    !(typeof value?.dev === "bigint" || Number.isSafeInteger(value?.dev)) ||
    !(typeof value?.ino === "bigint" || Number.isSafeInteger(value?.ino))
  ) throw finalCollectionFailure();
  return { ...value, bytes: Buffer.from(bytes) };
}

async function readStableRootPrivateFile(path, minimum, maximum) {
  const before = await lstat(path, { bigint: true });
  const snapshot = {
    bytes: null,
    dev: before.dev,
    ino: before.ino,
    uid: process.platform === "win32" ? null : Number(before.uid),
    mode: Number(before.mode & 0o777n),
    nlink: Number(before.nlink),
    regular: before.isFile(),
    symbolicLink: before.isSymbolicLink(),
  };
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    Number(before.nlink) !== 1 ||
    Number(before.size) < minimum ||
    Number(before.size) > maximum
  ) throw finalCollectionFailure();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw finalCollectionFailure();
    }
    snapshot.bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw finalCollectionFailure();
    }
    return normalizePrivateSnapshot(snapshot, minimum, maximum);
  } finally {
    await handle.close();
  }
}

function assertSamePolicySnapshot(before, after) {
  const normalized = normalizePrivateSnapshot(after, 1, 8_192);
  if (
    normalized.dev !== before.dev ||
    normalized.ino !== before.ino ||
    normalized.mode !== before.mode ||
    normalized.uid !== before.uid ||
    !normalized.bytes.equals(before.bytes)
  ) throw finalPrerequisiteFailure(true);
}

function parseFinalPolicy(bytes, expectedSha256) {
  validateStagingProductionObserverPolicyBytes(bytes, expectedSha256);
  try {
    return JSON.parse(FINAL_UTF8.decode(bytes)).endpoint;
  } catch {
    throw finalCollectionFailure();
  }
}

function parseContinuousObserverPolicy(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 8_192) {
    throw finalCollectionFailure();
  }
  let text;
  let value;
  try {
    text = FINAL_UTF8.decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw finalCollectionFailure();
  }
  if (
    !exactObject(value, ["credentialPath", "endpoint"]) ||
    canonicalJson(value) !== text ||
    value.credentialPath !== CONTINUOUS_OBSERVER_TOKEN_PATH ||
    typeof value.endpoint !== "string"
  ) throw finalCollectionFailure();
  let endpoint;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw finalCollectionFailure();
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw finalCollectionFailure();
  }
  return value.endpoint;
}

function runFixedDocker(args, env, capture = true) {
  const result = spawnSync("docker", ["--context", "default", ...args], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
    maxBuffer: 256 * 1024,
    timeout: 30_000,
    env: env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) throw finalCollectionFailure();
  return capture ? result.stdout.trim() : "";
}

function finalRuntimeInventoryFailure() {
  return new Error("Phase 3 final runtime inventory is invalid");
}

function exactPlainDataObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== fields.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    new Set(fields).size !== fields.length
  ) return false;
  const expected = new Set(fields);
  return ownKeys.every((key) => {
    if (!expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(
      descriptor &&
        descriptor.enumerable === true &&
        Object.hasOwn(descriptor, "value"),
    );
  });
}

function exactDataArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys.at(-1) !== "length") return false;
  for (let index = 0; index < value.length; index += 1) {
    if (ownKeys[index] !== String(index)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) return false;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  return Boolean(
    lengthDescriptor &&
      lengthDescriptor.enumerable === false &&
      Object.hasOwn(lengthDescriptor, "value"),
  );
}

function strictRuntimeEnvironment(values) {
  if (!exactDataArray(values)) throw finalRuntimeInventoryFailure();
  const result = new Map();
  for (const entry of values) {
    if (typeof entry !== "string") throw finalRuntimeInventoryFailure();
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    if (
      separator <= 0 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      result.has(key)
    ) throw finalRuntimeInventoryFailure();
    result.set(key, entry.slice(separator + 1));
  }
  return result;
}

function assertRuntimeLabels(labels, service, binding) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw finalRuntimeInventoryFailure();
  }
  const prototype = Object.getPrototypeOf(labels);
  const ownKeys = Reflect.ownKeys(labels);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = Object.getOwnPropertyDescriptor(labels, key);
      return !descriptor ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string";
    }) ||
    labels["com.docker.compose.project"] !== "spx-staging" ||
    labels["com.docker.compose.service"] !== service ||
    labels["com.spx.environment"] !== "staging" ||
    labels["com.spx.release-sha"] !== binding.candidateSha ||
    labels["com.spx.target-descriptor-sha256"] !== binding.stagingTargetDescriptorSha256 ||
    labels["com.spx.operator-bundle-sha256"] !== binding.operatorBundleSha256 ||
    labels["com.spx.staging-run-id"] !== binding.stagingRunId
  ) throw finalRuntimeInventoryFailure();
}

export function validateInstalledPhase3FinalRuntimeInventory(inventory, context, capability) {
  try {
    if (!exactDataArray(inventory) || inventory.length !== 3) {
      throw finalRuntimeInventoryFailure();
    }
    const binding = context?.installedBinding;
    if (
      !/^[0-9a-f]{40}$/.test(binding?.candidateSha ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(binding?.imageDigest ?? "") ||
      !/^[0-9a-f]{64}$/.test(binding?.stagingTargetDescriptorSha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(binding?.operatorBundleSha256 ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding?.stagingRunId ?? "")
    ) throw finalRuntimeInventoryFailure();
    const partition = phase3PartitionIdentity(
      capability?.phase3?.canaryTeamId,
      capability?.phase3?.canaryEpoch,
    );
    const entries = new Map();
    for (const entry of inventory) {
      if (
        !exactPlainDataObject(entry, [
          "service",
          "containerId",
          "imageId",
          "status",
          "paused",
          "restarting",
          "health",
          "labels",
          "environment",
        ]) ||
        typeof entry.service !== "string" ||
        entries.has(entry.service) ||
        !/^[0-9a-f]{64}$/.test(entry.containerId ?? "") ||
        entry.imageId !== binding.imageDigest ||
        (entry.health !== null && typeof entry.health !== "string") ||
        entry.paused !== false ||
        entry.restarting !== false
      ) throw finalRuntimeInventoryFailure();
      assertRuntimeLabels(entry.labels, entry.service, binding);
      entries.set(entry.service, {
        entry,
        environment: strictRuntimeEnvironment(entry.environment),
      });
    }
    if (new Set(inventory.map((entry) => entry.containerId)).size !== inventory.length) {
      throw finalRuntimeInventoryFailure();
    }
    const expectedServices = [
      partition.consumerService,
      partition.pollerService,
      partition.legacyService,
    ];
    if (expectedServices.some((service) => !entries.has(service))) {
      throw finalRuntimeInventoryFailure();
    }

    const consumer = entries.get(partition.consumerService);
    if (
      consumer.entry.status !== "exited" ||
      consumer.environment.get("SPX_NODE_ID") !== partition.consumerNodeId ||
      consumer.environment.get("AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED") !== "false" ||
      consumer.environment.get("AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED") !== "true" ||
      consumer.environment.get("AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED") !== "true"
    ) throw finalRuntimeInventoryFailure();

    const poller = entries.get(partition.pollerService);
    if (
      poller.entry.status !== "exited" ||
      poller.environment.get("SPX_NODE_ID") !== partition.pollerNodeId ||
      poller.environment.get("AUTO_ACCEPT_JOB_CUTOVER_EPOCH") !== partition.epoch ||
      poller.environment.get("AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED") !== "false" ||
      poller.environment.get("AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED") !== "false" ||
      poller.environment.get("AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED") !== "false"
    ) throw finalRuntimeInventoryFailure();

    const legacy = entries.get(partition.legacyService);
    if (
      legacy.entry.status !== "running" ||
      legacy.entry.health !== "healthy" ||
      legacy.environment.get("SPX_NODE_ID") !== partition.legacyNodeId ||
      legacy.environment.get("SPX_ROLE") !== "worker" ||
      legacy.environment.get("RUN_TEAM_IDS") !== String(partition.teamId)
    ) throw finalRuntimeInventoryFailure();
    return true;
  } catch {
    throw finalRuntimeInventoryFailure();
  }
}

async function collectInstalledFinalRuntimeInventory(context, capability) {
  if (runFixedDocker(["context", "show"], undefined) !== "default") throw finalCollectionFailure();
  const binding = context.installedBinding;
  const operatorRoot = await loadInstalledStagingOperatorRoot(binding);
  const composePrefix = buildInstalledStagingComposePrefix(operatorRoot);
  const composeEnvironment = buildInstalledStagingComposeEnvironment(binding, operatorRoot);
  const partition = phase3PartitionIdentity(
    capability?.phase3?.canaryTeamId,
    capability?.phase3?.canaryEpoch,
  );
  const inventory = [];
  for (const service of [
    partition.consumerService,
    partition.pollerService,
    partition.legacyService,
  ]) {
    const ids = runFixedDocker([...composePrefix, "ps", "-aq", service], composeEnvironment)
      .split(/\r?\n/)
      .filter(Boolean);
    if (ids.length !== 1 || !/^[0-9a-f]{12,64}$/.test(ids[0])) throw finalCollectionFailure();
    let inspect;
    try {
      const values = JSON.parse(runFixedDocker(["inspect", ids[0]], undefined));
      if (!Array.isArray(values) || values.length !== 1) throw new Error("invalid");
      inspect = values[0];
    } catch {
      throw finalCollectionFailure();
    }
    if (
      typeof inspect?.Id !== "string" ||
      !/^[0-9a-f]{64}$/.test(inspect.Id) ||
      !inspect.Id.startsWith(ids[0])
    ) throw finalCollectionFailure();
    inventory.push({
      service,
      containerId: inspect.Id,
      imageId: inspect?.Image,
      status: inspect?.State?.Status,
      paused: inspect?.State?.Paused,
      restarting: inspect?.State?.Restarting,
      health: inspect?.State?.Health?.Status ?? null,
      labels: inspect?.Config?.Labels,
      environment: inspect?.Config?.Env,
    });
  }
  return inventory;
}

async function collectFinalMysql(capability, expectedAccountHost, ports) {
  const config = await ports.loadCredential(capability, FINAL_DATABASE_ROLE);
  const connection = await ports.createMysqlConnection({ ...config, connectTimeout: FINAL_TIMEOUT_MS });
  let primaryFailure = null;
  let result;
  const facade = Object.freeze({
    async query(sql, values = []) {
      if (typeof sql !== "string" || !Array.isArray(values)) throw finalCollectionFailure();
      return connection.query({ sql, values, timeout: FINAL_TIMEOUT_MS });
    },
  });
  try {
    const [identityRows] = await facade.query(
      "SELECT CURRENT_USER() AS account, DATABASE() AS databaseName",
      [],
    );
    const identity = identityRows?.[0];
    if (
      identity?.account !== `${FINAL_DATABASE_USERNAME}@${expectedAccountHost}` ||
      identity?.databaseName !== FINAL_DATABASE_NAME
    ) throw finalCollectionFailure();
    const checked = await ports.runGrantCheck(
      facade,
      ports.loadGrantContract(),
      FINAL_DATABASE_ROLE,
      FINAL_DATABASE_USERNAME,
      FINAL_DATABASE_NAME,
      expectedAccountHost,
    );
    if (checked?.ok !== true || !Array.isArray(checked.failureCodes) || checked.failureCodes.length !== 0) {
      throw finalCollectionFailure();
    }
    const [maximumRows] = await facade.query(
      "SELECT @@GLOBAL.max_connections AS maxConnections",
      [],
    );
    const [connectedRows] = await facade.query(
      "SELECT VARIABLE_VALUE AS connected FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected'",
      [],
    );
    const maxConnections = Number(maximumRows?.[0]?.maxConnections);
    const connected = Number(connectedRows?.[0]?.connected);
    if (
      !Number.isSafeInteger(maxConnections) ||
      maxConnections <= 0 ||
      !Number.isSafeInteger(connected) ||
      connected < 0
    ) throw finalCollectionFailure();
    const free = Math.max(0, maxConnections - connected);
    result = {
      sharedMysqlConnectionsFree: free,
      sharedMysqlConnectionHeadroomPercent: (free / maxConnections) * 100,
    };
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await connection.end();
  } catch (error) {
    if (primaryFailure === null) primaryFailure = error;
  }
  if (primaryFailure !== null) throw primaryFailure;
  return result;
}

async function readBoundedObserverResponse(response) {
  if (response?.ok !== true || !response.body) throw finalCollectionFailure();
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) throw finalCollectionFailure();
      size += chunk.byteLength;
      if (size > FINAL_RESPONSE_MAX_BYTES) throw finalCollectionFailure();
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    throw finalCollectionFailure();
  }
  let text;
  let value;
  try {
    text = FINAL_UTF8.decode(Buffer.concat(chunks));
    value = JSON.parse(text);
  } catch {
    throw finalCollectionFailure();
  }
  if (
    !exactObject(value, ["p95LatencyMs", "ready"]) ||
    canonicalJson(value) !== text ||
    typeof value.ready !== "boolean" ||
    !validNumber(value.p95LatencyMs)
  ) throw finalCollectionFailure();
  return value;
}

async function collectFinalProduction(endpoint, token, fetchPort) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw finalCollectionFailure();
  }
  const response = await fetchPort(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(FINAL_TIMEOUT_MS),
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  return readBoundedObserverResponse(response);
}

function finalThresholds(policy) {
  return {
    envelopeApproved: {
      maxCpuPercent: policy.maxCpuPercent,
      minMemoryFreeBytes: policy.minMemoryFreeBytes,
      minMysqlConnectionsFree: policy.minMysqlConnectionsFree,
      maxProductionP95LatencyMs: policy.productionP95LatencyMs,
      maxLatencyIncreasePercent: policy.maxLatencyIncreasePercent,
    },
    codeOwnedFixed: {
      minDiskFreeBytes: 10_000_000_000,
      minInodeFreePercent: 20,
      minPidFree: 1_000,
      maxNetworkRxUtilizationPercent: 70,
      maxNetworkTxUtilizationPercent: 70,
      minNetworkHeadroomMbps: 100,
      minMysqlConnectionHeadroomPercent: 30,
    },
  };
}

function evaluateFinalCapacity(measurements, thresholds, ready) {
  const failures = [];
  const approved = thresholds.envelopeApproved;
  const fixed = thresholds.codeOwnedFixed;
  if (!ready) failures.push("PRODUCTION_NOT_READY");
  if (measurements.a3CpuPercent > approved.maxCpuPercent) failures.push("A3_CPU_BUDGET_EXCEEDED");
  if (measurements.a3MemoryFreeBytes < approved.minMemoryFreeBytes) failures.push("A3_MEMORY_HEADROOM_LOW");
  if (measurements.a3DiskFreeBytes < fixed.minDiskFreeBytes) failures.push("A3_DISK_HEADROOM_LOW");
  if (measurements.a3InodeFreePercent < fixed.minInodeFreePercent) failures.push("A3_INODE_HEADROOM_LOW");
  if (measurements.a3PidFree < fixed.minPidFree) failures.push("A3_PID_HEADROOM_LOW");
  if (measurements.a3NetworkRxUtilizationPercent > fixed.maxNetworkRxUtilizationPercent) failures.push("A3_NETWORK_RX_BUDGET_EXCEEDED");
  if (measurements.a3NetworkTxUtilizationPercent > fixed.maxNetworkTxUtilizationPercent) failures.push("A3_NETWORK_TX_BUDGET_EXCEEDED");
  if (measurements.a3NetworkHeadroomMbps < fixed.minNetworkHeadroomMbps) failures.push("A3_NETWORK_HEADROOM_LOW");
  if (measurements.sharedMysqlConnectionsFree < approved.minMysqlConnectionsFree) failures.push("MYSQL_CONNECTION_HEADROOM_LOW");
  if (measurements.sharedMysqlConnectionHeadroomPercent < fixed.minMysqlConnectionHeadroomPercent) failures.push("MYSQL_CONNECTION_PERCENT_HEADROOM_LOW");
  if (measurements.productionP95LatencyMs > approved.maxProductionP95LatencyMs) failures.push("PRODUCTION_LATENCY_BUDGET_EXCEEDED");
  if (measurements.productionLatencyIncreasePercent > approved.maxLatencyIncreasePercent) failures.push("PRODUCTION_LATENCY_INCREASE_EXCEEDED");
  if (canonicalJson(failures) !== canonicalJson(FINAL_FAILURE_ORDER.filter((code) => failures.includes(code)))) {
    throw finalCollectionFailure();
  }
  return failures;
}

function defaultFinalPorts(testPorts) {
  return {
    collectLocal: testPorts?.collectLocal ?? (() => collectLocalCapacity({ continuous: true })),
    createMysqlConnection: testPorts?.createMysqlConnection ?? (async (config) =>
      loadMysqlPromiseClient(fileURLToPath(new URL("../", import.meta.url))).createConnection(config)),
    fetch: testPorts?.fetch ?? globalThis.fetch,
    loadCapability: testPorts?.loadCapability ?? ((binding) => loadInstalledStagingActionCapability(binding)),
    loadContext: testPorts?.loadContext ?? loadInstalledApprovedStagingContext,
    loadCredential: testPorts?.loadCredential ?? ((capability, role) =>
      loadStagingDatabaseCredential(capability, role)),
    loadGrantContract: testPorts?.loadGrantContract ?? (() =>
      loadGrantContract(fileURLToPath(new URL("../deploy/db-grants.json", import.meta.url)))),
    loadLeases: testPorts?.loadLeases ?? ((stagingRunId) => loadStagingLeases(stagingRunId)),
    readContinuousPolicy: testPorts?.readContinuousPolicy ?? (() =>
      readFile(CONTINUOUS_OBSERVER_POLICY_PATH)),
    readFinalPolicy: testPorts?.readFinalPolicy ?? (() =>
      readStableRootPrivateFile(STAGING_PHASE3_PRODUCTION_OBSERVER_POLICY_PATH, 1, 8_192)),
    readFinalToken: testPorts?.readFinalToken ?? (() =>
      readStableRootPrivateFile(STAGING_PHASE3_PRODUCTION_OBSERVER_TOKEN_PATH, 32, 4_096)),
    runGrantCheck: testPorts?.runGrantCheck ?? runGrantCheck,
    collectRuntimeInventory:
      testPorts?.collectRuntimeInventory ?? collectInstalledFinalRuntimeInventory,
  };
}

export async function collectInstalledPhase3CapacityEvidence(...callerArguments) {
  const testPorts = assertTestPorts(callerArguments);
  const ports = defaultFinalPorts(testPorts);
  try {
    const context = await ports.loadContext();
    const { expectedPolicySha256, accountHost, thresholds: approvedPolicy } =
      assertFinalContext(context);
    const capability = await ports.loadCapability(context.installedBinding);
    const initialLeases = assertFinalLeases(
      await ports.loadLeases(context.installedBinding.stagingRunId),
      context.installedBinding.stagingRunId,
    );
    validateInstalledPhase3FinalRuntimeInventory(
      await ports.collectRuntimeInventory(context, capability),
      context,
      capability,
    );
    const initialPolicy = normalizePrivateSnapshot(await ports.readFinalPolicy(), 1, 8_192);
    const endpoint = parseFinalPolicy(initialPolicy.bytes, expectedPolicySha256);
    if (endpoint !== parseContinuousObserverPolicy(await ports.readContinuousPolicy())) {
      throw finalCollectionFailure();
    }
    const tokenSnapshot = normalizePrivateSnapshot(await ports.readFinalToken(), 32, 4_096);
    validateStagingProductionObserverTokenBytes(tokenSnapshot.bytes);
    const token = FINAL_UTF8.decode(tokenSnapshot.bytes);
    const [local, mysql, production] = await Promise.all([
      ports.collectLocal(),
      collectFinalMysql(capability, accountHost, ports),
      collectFinalProduction(endpoint, token, ports.fetch),
    ]);
    const localFields = [
      "a3CpuPercent",
      "a3MemoryFreeBytes",
      "a3DiskFreeBytes",
      "a3InodeFreePercent",
      "a3PidFree",
      "a3NetworkRxUtilizationPercent",
      "a3NetworkTxUtilizationPercent",
      "a3NetworkHeadroomMbps",
    ];
    if (
      localFields.some((field) => !validNumber(local?.[field])) ||
      !validNumber(mysql?.sharedMysqlConnectionsFree) ||
      !validNumber(mysql?.sharedMysqlConnectionHeadroomPercent)
    ) throw finalCollectionFailure();
    const postPolicy = await ports.readFinalPolicy();
    assertSamePolicySnapshot(initialPolicy, postPolicy);
    const finalLeases = assertFinalLeases(
      await ports.loadLeases(context.installedBinding.stagingRunId),
      context.installedBinding.stagingRunId,
    );
    assertUnchangedFinalLeases(initialLeases, finalLeases);
    const productionLatencyIncreasePercent =
      ((production.p95LatencyMs - initialLeases.guard.baselineP95LatencyMs) /
        initialLeases.guard.baselineP95LatencyMs) * 100;
    if (!Number.isFinite(productionLatencyIncreasePercent)) throw finalCollectionFailure();
    const measurements = {
      a3CpuPercent: local.a3CpuPercent,
      a3MemoryFreeBytes: local.a3MemoryFreeBytes,
      a3DiskFreeBytes: local.a3DiskFreeBytes,
      a3InodeFreePercent: local.a3InodeFreePercent,
      a3PidFree: local.a3PidFree,
      a3NetworkRxUtilizationPercent: local.a3NetworkRxUtilizationPercent,
      a3NetworkTxUtilizationPercent: local.a3NetworkTxUtilizationPercent,
      a3NetworkHeadroomMbps: local.a3NetworkHeadroomMbps,
      sharedMysqlConnectionsFree: mysql.sharedMysqlConnectionsFree,
      sharedMysqlConnectionHeadroomPercent: mysql.sharedMysqlConnectionHeadroomPercent,
      productionP95LatencyMs: production.p95LatencyMs,
      productionBaselineP95LatencyMs: initialLeases.guard.baselineP95LatencyMs,
      productionLatencyIncreasePercent,
    };
    const thresholds = finalThresholds(approvedPolicy);
    const failures = evaluateFinalCapacity(measurements, thresholds, production.ready);
    const absoluteP95WithinApprovedLimit =
      production.p95LatencyMs <= thresholds.envelopeApproved.maxProductionP95LatencyMs;
    const latencyIncreaseWithinApprovedLimit =
      productionLatencyIncreasePercent <= thresholds.envelopeApproved.maxLatencyIncreasePercent;
    const observedAt = new Date().toISOString();
    return deepFreeze({
      capacity: {
        schemaVersion: 1,
        observedAt,
        ok: failures.length === 0,
        failures,
        measurements,
        thresholds,
      },
      productionObserver: {
        schemaVersion: 1,
        expectedPolicySha256,
        requestMethod: "GET",
        response: { p95LatencyMs: production.p95LatencyMs, ready: production.ready },
        observedAt,
        thresholdResult: {
          absoluteP95WithinApprovedLimit,
          latencyIncreaseWithinApprovedLimit,
          passed:
            production.ready &&
            absoluteP95WithinApprovedLimit &&
            latencyIncreaseWithinApprovedLimit,
        },
      },
    });
  } catch (error) {
    throw sanitizeFinalFailure(error);
  }
}

export async function collectLiveCapacitySnapshot(options = {}) {
  const context = await loadInstalledApprovedStagingContext();
  const production = await collectProductionCapacity();
  const baseline = options.productionBaselineP95LatencyMs ?? production.productionP95LatencyMs;
  const snapshot = await collectCapacitySnapshot({
    collectLocal: () => collectLocalCapacity({ continuous: options.continuous === true }),
    collectMysql: collectMysqlCapacity,
    collectProduction: async () => production,
    productionBaselineP95LatencyMs: baseline,
  });
  return Object.freeze({
    stagingRunId: context.installedBinding.stagingRunId,
    snapshot,
    thresholds: thresholdsFromApprovedPolicy(context.envelope.policy.thresholds),
  });
}

async function main() {
  const checkedAt = new Date().toISOString();
  try {
    if (process.argv.length !== 2) throw new Error("capacity check overrides are forbidden");
    const { snapshot, thresholds } = await collectLiveCapacitySnapshot({ continuous: false });
    const result = evaluateCapacitySnapshot(snapshot, thresholds);
    console.log(canonicalJson({ ...result, checkedAt }));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["CAPACITY_COLLECTION_FAILED"], checkedAt }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("a3-capacity-check.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
