#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases } from "./lib/a3-staging-leases.mjs";

const MODES = Object.freeze([
  "baseline",
  "competing-owner",
  "routed",
  "db-fault",
  "recovered",
  "rollback",
]);
const HASH = /^[0-9a-f]{64}$/;

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parsePhase4ProbeArgs(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 1 ||
    !argv[0].startsWith("--mode=") ||
    !MODES.includes(argv[0].slice("--mode=".length))
  ) {
    throw new Error("one fixed Phase 4 probe mode is required; override forbidden");
  }
  return { mode: argv[0].slice("--mode=".length) };
}

export function evaluatePhase4Probe(input, mode = "baseline") {
  if (
    !input ||
    !MODES.includes(mode) ||
    typeof input.stagingRunId !== "string" ||
    !HASH.test(input.approvalEnvelopeSha256 ?? "") ||
    !Number.isSafeInteger(input.singletonOwners) ||
    ![
      input.latestEventId,
      input.replayCursor,
      input.localFallbackWatermark,
      input.routingWatermark,
    ].every(finiteNonNegative)
  ) {
    return { ok: false, failures: ["PHASE4_PROBE_INPUT_INVALID"] };
  }
  const failures = [];
  if (
    input.releaseEnvironment !== "staging" ||
    input.runtimeEnvironment !== "staging" ||
    input.drillMode !== "staging" ||
    input.composeProject !== "spx-staging"
  ) {
    failures.push("STAGING_DISCRIMINATOR_INVALID");
  }
  if (!input.targetDescriptorValid) failures.push("TARGET_DESCRIPTOR_INVALID");
  if (!input.operatorBundleValid) failures.push("OPERATOR_BUNDLE_INVALID");
  if (!input.a3HostIdentityMatches) failures.push("A3_HOST_IDENTITY_MISMATCH");
  if (!input.guardSameInstance) failures.push("GUARD_HANDOFF_CHANGED");
  if (!input.guardHeartbeatFresh) failures.push("GUARD_HEARTBEAT_STALE");
  if (!input.watchdogHeartbeatFresh) failures.push("WATCHDOG_HEARTBEAT_STALE");
  if (!input.baselineLeaseOwnerExact) failures.push("BASELINE_LEASE_OWNER_CHANGED");
  if (!input.runtimeIdentitiesExact) failures.push("RUNTIME_IDENTITY_MISMATCH");
  if (!input.databaseRoutingExact) failures.push("DATABASE_ROUTING_CLASSIFICATION_INVALID");
  if (!input.stagingWebReady) failures.push("STAGING_WEB_NOT_READY");
  if (!input.productionWebReady) failures.push("PRODUCTION_WEB_NOT_READY");
  if (!input.workerAlive) failures.push("WORKER_NOT_ALIVE");
  if (!input.directDbPublishersHealthy) failures.push("DIRECT_DB_PUBLISHER_UNHEALTHY");
  if (input.singletonOwners !== 1) failures.push("REALTIME_SINGLETON_VIOLATION");
  if (input.replayCursor > input.latestEventId) failures.push("REPLAY_CURSOR_AHEAD_OF_EVENT_LOG");
  if (input.localFallbackWatermark < input.routingWatermark) {
    failures.push("LOCAL_FALLBACK_BEHIND_ROUTING_WATERMARK");
  }

  if (mode === "baseline" && !input.realtimeReady) failures.push("REALTIME_NOT_READY");
  if (mode === "competing-owner") {
    if (!input.realtimeReady) failures.push("REALTIME_NOT_READY");
    if (!input.competingOwnerRejected) failures.push("COMPETING_OWNER_NOT_REJECTED");
  }
  if (mode === "routed") {
    if (!input.realtimeReady) failures.push("REALTIME_NOT_READY");
    if (!input.producersRemote) failures.push("PRODUCERS_NOT_REMOTE");
    if (!input.webReadsRemote) failures.push("WEB_READS_NOT_REMOTE");
    if (!input.webStreamsRemote) failures.push("WEB_STREAMS_NOT_REMOTE");
  }
  if (mode === "db-fault") {
    if (input.realtimeReady || !input.realtimeUnavailable) {
      failures.push("REALTIME_DB_FAULT_NOT_OBSERVED");
    }
    if (!input.targetedReaderDegraded) failures.push("TARGETED_READER_NOT_DEGRADED");
    if (!input.localFallbackUsable) failures.push("LOCAL_FALLBACK_UNAVAILABLE");
  }
  if (mode === "recovered") {
    if (!input.realtimeReady) failures.push("REALTIME_NOT_RECOVERED");
    if (input.replayCursor < input.routingWatermark) failures.push("RECOVERY_CURSOR_BEHIND");
  }
  if (mode === "rollback" && !input.localFallbackUsable) {
    failures.push("LOCAL_FALLBACK_UNAVAILABLE");
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

function safeSnapshotUrl(value) {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Phase 4 runtime snapshot endpoint is invalid");
  }
  return url;
}

function scanSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Phase 4 runtime snapshot is invalid");
  }
  if (
    Object.keys(value).some((key) =>
      /secret|token|password|cookie|authorization|credential|payload|eventData/i.test(key),
    )
  ) {
    throw new Error("Phase 4 runtime snapshot contains forbidden data");
  }
  return value;
}

async function collectLiveSnapshot(mode) {
  const context = await loadInstalledApprovedStagingContext();
  const binding = context.installedBinding;
  const leases = await loadStagingLeases(binding.stagingRunId);
  const endpoint = safeSnapshotUrl(process.env.PHASE4_RUNTIME_SNAPSHOT_URL ?? "");
  const authorization = process.env.PHASE4_RUNTIME_PROBE_AUTH;
  if (typeof authorization !== "string" || authorization.length < 16 || authorization.length > 4_096) {
    throw new Error("Phase 4 runtime probe authentication is unavailable");
  }
  const response = await fetch(endpoint, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${authorization}`,
      "x-spx-phase4-probe-mode": mode,
    },
  });
  const text = await response.text();
  if (!response.ok || text.length > 64 * 1024) {
    throw new Error("Phase 4 runtime snapshot request failed");
  }
  const observed = scanSnapshot(JSON.parse(text));
  const hostIdentity = (await readFile("/etc/spx-staging/host-identity.sha256", "utf8")).trim();
  return {
    ...observed,
    releaseEnvironment: context.descriptor.releaseEnvironment,
    runtimeEnvironment: context.descriptor.runtimeEnvironment,
    drillMode: "staging",
    composeProject: context.descriptor.composeProject,
    stagingRunId: binding.stagingRunId,
    approvalEnvelopeSha256: binding.stagingApprovalEnvelopeSha256,
    targetDescriptorValid: true,
    operatorBundleValid: true,
    a3HostIdentityMatches: hostIdentity === context.descriptor.target.hostIdentitySha256,
    guardSameInstance:
      observed.guardLeaseId === leases.guard.leaseId &&
      observed.watchdogLeaseId === leases.watchdog.leaseId,
    guardHeartbeatFresh:
      leases.guard.state === "armed" && leases.guard.heartbeatAgeMs <= leases.maxAgeMs,
    watchdogHeartbeatFresh:
      leases.watchdog.state === "armed" && leases.watchdog.heartbeatAgeMs <= leases.maxAgeMs,
  };
}

async function main() {
  const checkedAt = new Date().toISOString();
  try {
    const { mode } = parsePhase4ProbeArgs(process.argv.slice(2));
    const result = evaluatePhase4Probe(await collectLiveSnapshot(mode), mode);
    console.log(canonicalJson({ ...result, mode, checkedAt }));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(
      canonicalJson({
        ok: false,
        failures: ["PHASE4_RUNTIME_PROBE_FAILED"],
        checkedAt,
      }),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("phase4-runtime-probe.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
