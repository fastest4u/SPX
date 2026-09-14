#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { readGate6RuntimeContext } from "./lib/gate6-runtime-context.mjs";
import {
  candidateGate6ComposePrefix,
  parseGate6InstanceArguments,
  verifyGate6SupervisorInstall,
} from "./lib/gate6-immutable-runtime.mjs";
import {
  createGate6MysqlLedger,
  createProductionGate6MysqlPool,
} from "./lib/gate6-mysql-ledger.mjs";
import { readEvidenceBytes } from "./lib/evidence-artifact.mjs";

const IMAGE = /^sha256:[0-9a-f]{64}$/;
const THRESHOLDS_FILE = "/var/lib/spx-gate6/config/monitor-thresholds.json";
const EVIDENCE_FILE = "/var/lib/spx-gate6/evidence/monitor-samples.ndjson";
const RUNTIME_SERVICES = Object.freeze([
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
]);

function boundedNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredTeamSet(value) {
  if (
    !Array.isArray(value)
    || value.some((teamId) => !Number.isSafeInteger(teamId) || ![1, 2].includes(teamId))
    || new Set(value).size !== value.length
  ) throw new Error("required worker lease availability signal is invalid");
  return new Set(value);
}

export function evaluateProductionCanarySample(sample, thresholds) {
  const reasons = [];
  if (
    sample?.releaseEnvironment !== "production"
    || sample?.runtimeEnvironment !== "production"
    || sample?.drillMode !== "supervised-production"
    || sample?.composeProject !== "spx-production"
  ) reasons.push("production-identity-mismatch");
  if (!IMAGE.test(sample?.candidateImageDigest ?? "")) reasons.push("candidate-image-invalid");
  if (
    !Array.isArray(sample?.observedImageDigests)
    || sample.observedImageDigests.length === 0
    || sample.observedImageDigests.some((digest) => digest !== sample.candidateImageDigest)
  ) reasons.push("mixed-release");
  if (sample?.readiness !== true) reasons.push("readiness-red");
  const checks = [
    ["latency", sample?.latencyMs, thresholds?.maxLatencyMs],
    ["queue-oldest", sample?.queueOldestMs, thresholds?.maxQueueOldestMs],
    ["outbox-oldest", sample?.outboxOldestMs, thresholds?.maxOutboxOldestMs],
    ["cpu", sample?.cpuPercent, thresholds?.maxCpuPercent],
    ["memory", sample?.memoryPercent, thresholds?.maxMemoryPercent],
    ["disk", sample?.diskPercent, thresholds?.maxDiskPercent],
    ["inode", sample?.inodePercent, thresholds?.maxInodePercent],
    ["mysql-connections", sample?.mysqlConnectionPercent, thresholds?.maxMysqlConnectionPercent],
  ];
  for (const [label, value, maximum] of checks) {
    try {
      if (boundedNumber(value, label) > boundedNumber(maximum, `${label} threshold`)) reasons.push(`${label}-threshold`);
    } catch {
      reasons.push(`${label}-invalid`);
    }
  }
  if (!Number.isSafeInteger(sample?.leaseStaleCount) || sample.leaseStaleCount !== 0) {
    reasons.push("runtime-lease-stale");
  }
  try {
    const missing = requiredTeamSet(sample?.missingLeaseTeamIds);
    const allowed = requiredTeamSet(sample?.allowedMissingLeaseTeamIds);
    if ([...missing].some((teamId) => !allowed.has(teamId))) reasons.push("runtime-owner-missing");
  } catch {
    reasons.push("runtime-owner-signal-invalid");
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

export function sanitizeProductionCanarySample(sample, result) {
  return Object.freeze({
    releaseEnvironment: sample.releaseEnvironment,
    runtimeEnvironment: sample.runtimeEnvironment,
    drillMode: sample.drillMode,
    composeProject: sample.composeProject,
    candidateImageDigest: sample.candidateImageDigest,
    readiness: sample.readiness,
    latencyMs: sample.latencyMs,
    queueOldestMs: sample.queueOldestMs,
    outboxOldestMs: sample.outboxOldestMs,
    leaseStaleCount: sample.leaseStaleCount,
    missingLeaseTeamIds: sample.missingLeaseTeamIds,
    allowedMissingLeaseTeamIds: sample.allowedMissingLeaseTeamIds,
    cpuPercent: sample.cpuPercent,
    memoryPercent: sample.memoryPercent,
    diskPercent: sample.diskPercent,
    inodePercent: sample.inodePercent,
    mysqlConnectionPercent: sample.mysqlConnectionPercent,
    status: result.ok ? "green" : "red",
    reasonCodes: result.reasons,
  });
}

export async function renewProductionMonitorLease({ repository, gate6Id, sample, thresholds, now = new Date(), ttlMs = 15_000 }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 30_000) {
    throw new Error("monitor lease TTL is outside the fixed short window");
  }
  const result = evaluateProductionCanarySample(sample, thresholds);
  await repository.renewLease({
    gate6Id,
    lease: "monitor",
    status: result.ok ? "green" : "red",
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    now,
  });
  return { result, evidence: sanitizeProductionCanarySample(sample, result) };
}

export async function runProductionMonitorOnce(input) {
  const [probe, observedImageDigests, host, handoff] = await Promise.all([
    input.probe(),
    input.inventory(),
    input.hostMetrics(),
    input.handoffWindow
      ? input.handoffWindow()
      : input.repository.getWorkerHandoffState(input.context.gate6Id),
  ]);
  if (probe?.ok !== true || !Array.isArray(observedImageDigests) || observedImageDigests.length === 0) {
    throw new Error("Gate 6 production monitor probe is invalid");
  }
  const sample = {
    releaseEnvironment: "production",
    runtimeEnvironment: "production",
    drillMode: "supervised-production",
    composeProject: input.context.composeProject,
    candidateImageDigest: input.context.candidateImageDigest,
    observedImageDigests,
    readiness: probe.readiness,
    latencyMs: probe.latencyMs,
    queueOldestMs: probe.queueOldestMs,
    outboxOldestMs: probe.outboxOldestMs,
    leaseStaleCount: probe.leaseStaleCount,
    missingLeaseTeamIds: probe.missingLeaseTeamIds,
    allowedMissingLeaseTeamIds: handoff.allowedMissingTeamIds,
    mysqlConnectionPercent: probe.mysqlConnectionPercent,
    cpuPercent: host.cpuPercent,
    memoryPercent: host.memoryPercent,
    diskPercent: host.diskPercent,
    inodePercent: host.inodePercent,
  };
  const renewed = await renewProductionMonitorLease({
    repository: input.repository,
    gate6Id: input.context.gate6Id,
    sample,
    thresholds: input.thresholds,
    now: input.now ?? new Date(),
    ttlMs: input.ttlMs ?? 15_000,
  });
  if (input.record) await input.record(renewed.evidence);
  return renewed;
}

function runBounded(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = (options.spawnImpl ?? spawn)(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 256 * 1024)) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null || bytes > (options.maxBytes ?? 256 * 1024)) {
        rejectPromise(new Error("Gate 6 monitor command failed"));
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

export function createProductionMonitorDockerAdapters(options = {}) {
  const composePrefix = options.composePrefix;
  if (!Array.isArray(composePrefix) || composePrefix.length === 0) {
    throw new Error("Gate 6 monitor requires a verified candidate Compose prefix");
  }
  const command = (args, commandOptions) => runBounded(
    "/usr/bin/docker",
    args,
    { ...options, ...commandOptions },
  );
  return Object.freeze({
    async probe() {
      const text = await command([
        ...composePrefix, "--profile", "gate6",
        "run", "--rm", "--no-deps", "gate6-monitor-probe",
      ]);
      const value = JSON.parse(text);
      if (canonicalGate6Json(value) !== text || value?.ok !== true) {
        throw new Error("Gate 6 monitor probe output is invalid");
      }
      return value;
    },
    async inventory() {
      const digests = [];
      for (const service of RUNTIME_SERVICES) {
        const containerId = await command([...composePrefix, "ps", "--quiet", service]);
        if (!containerId) continue;
        if (!/^[0-9a-f]{12,64}$/.test(containerId)) throw new Error("Gate 6 container identity is invalid");
        const digest = await command(["inspect", "--format={{.Image}}", containerId]);
        if (!IMAGE.test(digest)) throw new Error("Gate 6 observed image digest is invalid");
        digests.push(digest);
      }
      return [...new Set(digests)].sort();
    },
  });
}

export async function collectProductionHostMetrics() {
  const memoryTotal = totalmem();
  const fileSystem = await statfs("/");
  const blocks = Number(fileSystem.blocks);
  const freeBlocks = Number(fileSystem.bavail);
  const files = Number(fileSystem.files);
  const freeFiles = Number(fileSystem.ffree);
  const percent = (used, total) => total > 0 ? Math.round((used / total) * 10_000) / 100 : 100;
  return {
    cpuPercent: Math.min(100, Math.round((loadavg()[0] / Math.max(1, cpus().length)) * 10_000) / 100),
    memoryPercent: percent(memoryTotal - freemem(), memoryTotal),
    diskPercent: percent(blocks - freeBlocks, blocks),
    inodePercent: percent(files - freeFiles, files),
  };
}

export async function loadProductionMonitorThresholds(context) {
  const stat = await lstat(THRESHOLDS_FILE, { bigint: true });
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || (process.platform !== "win32" && stat.uid !== 0n)
    || (process.platform !== "win32" && Number(stat.mode & 0o022n) !== 0)
  ) throw new Error("Gate 6 monitor thresholds file is insecure");
  const bytes = await readEvidenceBytes(THRESHOLDS_FILE, { maxFileBytes: 16 * 1024 });
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  const keys = [
    "maxLatencyMs", "maxQueueOldestMs", "maxOutboxOldestMs", "maxCpuPercent",
    "maxMemoryPercent", "maxDiskPercent", "maxInodePercent", "maxMysqlConnectionPercent",
  ];
  if (
    canonicalGate6Json(Object.keys(value).sort()) !== canonicalGate6Json(keys.sort())
    || canonicalGate6Json(value) !== text
    || !keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0)
    || createHashSha256(bytes) !== context.monitorThresholdsSha256
  ) throw new Error("Gate 6 monitor thresholds binding is invalid");
  return Object.freeze({ ...value });
}

function createHashSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function appendProductionMonitorEvidence(evidence) {
  const directory = dirname(EVIDENCE_FILE);
  const directoryStat = await lstat(directory, { bigint: true });
  if (
    directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || (process.platform !== "win32" && directoryStat.uid !== 0n)
    || (process.platform !== "win32" && Number(directoryStat.mode & 0o077n) !== 0)
  ) throw new Error("Gate 6 monitor evidence directory is insecure");
  try {
    const stat = await lstat(EVIDENCE_FILE, { bigint: true });
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || (process.platform !== "win32" && stat.uid !== 0n)
      || (process.platform !== "win32" && Number(stat.mode & 0o077n) !== 0)
    ) throw new Error("Gate 6 monitor evidence file is insecure");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await open(
    EVIDENCE_FILE,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalGate6Json(evidence)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function runProductionMonitorLoop(input) {
  const intervalMs = input.intervalMs ?? 5_000;
  const ttlMs = input.ttlMs ?? 15_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs * 2 >= ttlMs) {
    throw new Error("Gate 6 monitor interval is invalid");
  }
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopped) {
      const state = await input.repository.getSupervisorState(input.context.gate6Id);
      if (["released", "revoked"].includes(state.status)) return { status: state.status };
      try {
        await runProductionMonitorOnce({
          ...input,
          now: new Date(),
          ttlMs,
        });
      } catch (error) {
        const now = new Date();
        await input.repository.renewLease({
          gate6Id: input.context.gate6Id,
          lease: "monitor",
          status: "red",
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
          now,
        });
        throw error;
      }
      await (input.sleep ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))))(intervalMs);
    }
    return { status: "stopped" };
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

async function main() {
  let pool;
  try {
    const instance = parseGate6InstanceArguments(process.argv.slice(2), "--monitor");
    const context = await readGate6RuntimeContext();
    const install = await verifyGate6SupervisorInstall({ instance, context });
    const thresholds = await loadProductionMonitorThresholds(context);
    pool = await createProductionGate6MysqlPool({
      runtime: "host",
      expectedTargetDescriptorSha256: context.targetDescriptorSha256,
    });
    const repository = createGate6MysqlLedger(pool);
    const docker = createProductionMonitorDockerAdapters({
      composePrefix: candidateGate6ComposePrefix(install),
    });
    const result = await runProductionMonitorLoop({
      context,
      thresholds,
      repository,
      probe: docker.probe,
      inventory: docker.inventory,
      hostMetrics: collectProductionHostMetrics,
      record: (evidence) => appendProductionMonitorEvidence({
        gate6Id: context.gate6Id,
        recordedAt: new Date().toISOString(),
        evidence,
      }),
    });
    process.stdout.write(`${canonicalGate6Json({ ok: result.status === "released", status: result.status })}\n`);
    if (result.status !== "released") process.exitCode = 1;
  } catch {
    process.stdout.write(`${canonicalGate6Json({ ok: false, code: "gate6-monitor-refused" })}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
