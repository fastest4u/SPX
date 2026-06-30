import { AUTO_ACCEPT_FAILURE_REASONS } from "./auto-accept-diagnostics.js";
import type { AutoAcceptFailureReason } from "./auto-accept-diagnostics.js";
import type { MetricsSnapshot, TimedOperation, TimingSummary } from "./metrics.js";

const RUNTIME_METRICS_TTL_MS = 120_000;
const TIMED_OPERATIONS: readonly TimedOperation[] = [
  "detailFetch",
  "dbSave",
  "notify",
  "autoAccept",
  "acceptRtt",
  "detailToFirstMatch",
  "autoAcceptVerify",
  "acceptToVerify",
  "listAgeMs",
];

export interface RuntimeMetricsRecord {
  nodeId: string;
  receivedAt: number;
  snapshot: MetricsSnapshot;
}

const runtimeMetricsByTeam = new Map<number, RuntimeMetricsRecord>();

function cloneSnapshot(snapshot: MetricsSnapshot): MetricsSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as MetricsSnapshot;
}

function activeRecords(now = Date.now()): RuntimeMetricsRecord[] {
  return [...runtimeMetricsByTeam.values()]
    .filter((record) => now - record.receivedAt <= RUNTIME_METRICS_TTL_MS)
    .sort((a, b) => a.receivedAt - b.receivedAt);
}

function latestTimestamp(values: Array<string | null>): string | null {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function summarizeTimings(summaries: TimingSummary[]): TimingSummary {
  const active = summaries.filter((summary) => summary.count > 0);
  const count = active.reduce((sum, summary) => sum + summary.count, 0);
  if (count === 0) {
    return { count: 0, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, lastMs: null };
  }

  return {
    count,
    avg: Math.round(active.reduce((sum, summary) => sum + summary.avg * summary.count, 0) / count),
    min: Math.min(...active.map((summary) => summary.min)),
    max: Math.max(...active.map((summary) => summary.max)),
    p50: Math.max(...active.map((summary) => summary.p50)),
    p95: Math.max(...active.map((summary) => summary.p95)),
    p99: Math.max(...active.map((summary) => summary.p99)),
    lastMs: active[active.length - 1]?.lastMs ?? null,
  };
}

function aggregateSnapshots(fallback: MetricsSnapshot, records: RuntimeMetricsRecord[]): MetricsSnapshot {
  const snapshots = records.map((record) => record.snapshot);
  if (snapshots.length === 0) return fallback;

  const totalRequests = snapshots.reduce((sum, snapshot) => sum + snapshot.polling.totalRequests, 0);
  const successCount = snapshots.reduce((sum, snapshot) => sum + snapshot.polling.successCount, 0);
  const errorCount = snapshots.reduce((sum, snapshot) => sum + snapshot.polling.errorCount, 0);
  const pollingLatency = summarizeTimings(snapshots.map((snapshot) => ({
    ...snapshot.polling.latency,
    count: snapshot.polling.totalRequests,
    lastMs: snapshot.lastPoll.latencyMs,
  })));
  const operations = Object.fromEntries(
    TIMED_OPERATIONS.map((operation) => [
      operation,
      summarizeTimings(snapshots.map((snapshot) => snapshot.operations[operation])),
    ]),
  ) as MetricsSnapshot["operations"];
  const failuresByReason = Object.fromEntries(
    AUTO_ACCEPT_FAILURE_REASONS.map((reason) => [
      reason,
      snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.verification.failuresByReason[reason], 0),
    ]),
  ) as Record<AutoAcceptFailureReason, number>;
  const upstreamRequests = snapshots.reduce((sum, snapshot) => sum + snapshot.upstream.requests, 0);
  const upstreamConnections = snapshots.reduce((sum, snapshot) => sum + snapshot.upstream.connections, 0);
  const detailConcurrency = snapshots.reduce((sum, snapshot) => sum + snapshot.runtime.detailConcurrency, 0);
  const activeDetailBookings = snapshots.reduce((sum, snapshot) => sum + snapshot.runtime.activeDetailBookings, 0);
  const latestPollSnapshot = snapshots
    .filter((snapshot) => snapshot.lastPoll.timestamp)
    .sort((a, b) => Date.parse(b.lastPoll.timestamp ?? "") - Date.parse(a.lastPoll.timestamp ?? ""))[0];

  return {
    ...fallback,
    teamId: null,
    teamName: "All teams",
    isPaused: snapshots.every((snapshot) => snapshot.isPaused),
    uptime: Math.max(...snapshots.map((snapshot) => snapshot.uptime)),
    startedAt: snapshots.map((snapshot) => snapshot.startedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? fallback.startedAt,
    polling: {
      totalRequests,
      successCount,
      errorCount,
      successRate: totalRequests > 0 ? Math.round((successCount / totalRequests) * 10000) / 100 : 0,
      latency: {
        avg: pollingLatency.avg,
        min: pollingLatency.min,
        max: pollingLatency.max,
        p50: pollingLatency.p50,
        p95: pollingLatency.p95,
        p99: pollingLatency.p99,
      },
    },
    data: {
      totalRecordsSeen: snapshots.reduce((sum, snapshot) => sum + snapshot.data.totalRecordsSeen, 0),
      changesDetected: snapshots.reduce((sum, snapshot) => sum + snapshot.data.changesDetected, 0),
      tripsInserted: snapshots.reduce((sum, snapshot) => sum + snapshot.data.tripsInserted, 0),
      tripsSkipped: snapshots.reduce((sum, snapshot) => sum + snapshot.data.tripsSkipped, 0),
    },
    lastPoll: latestPollSnapshot?.lastPoll ?? fallback.lastPoll,
    session: {
      consecutiveErrors: snapshots.reduce((sum, snapshot) => sum + snapshot.session.consecutiveErrors, 0),
      lastSessionWarning: latestTimestamp(snapshots.map((snapshot) => snapshot.session.lastSessionWarning)),
      isHealthy: snapshots.every((snapshot) => snapshot.session.isHealthy),
    },
    autoAccept: {
      totalAttempts: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.totalAttempts, 0),
      successCount: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.successCount, 0),
      failureCount: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.failureCount, 0),
      verifiedSuccessCount: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.verifiedSuccessCount, 0),
      verifiedFailureCount: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.verifiedFailureCount, 0),
      pendingVerificationCount: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.pendingVerificationCount, 0),
      verification: {
        queued: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.verification.queued, 0),
        active: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.verification.active, 0),
        completed: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.verification.completed, 0),
        indeterminate: snapshots.reduce((sum, snapshot) => sum + snapshot.autoAccept.verification.indeterminate, 0),
        maxQueueDepth: Math.max(...snapshots.map((snapshot) => snapshot.autoAccept.verification.maxQueueDepth)),
        failuresByReason,
      },
    },
    scheduling: {
      launched: snapshots.reduce((sum, snapshot) => sum + snapshot.scheduling.launched, 0),
      skippedConcurrency: snapshots.reduce((sum, snapshot) => sum + snapshot.scheduling.skippedConcurrency, 0),
      skippedCooldown: snapshots.reduce((sum, snapshot) => sum + snapshot.scheduling.skippedCooldown, 0),
    },
    upstream: {
      requests: upstreamRequests,
      connections: upstreamConnections,
      reuseRatio: upstreamRequests > 0
        ? Math.max(0, Math.round((1 - upstreamConnections / upstreamRequests) * 10000) / 100)
        : 0,
    },
    operations,
    runtime: {
      activeDetailJobs: snapshots.reduce((sum, snapshot) => sum + snapshot.runtime.activeDetailJobs, 0),
      activeDetailBookings,
      detailConcurrency,
      queuedDetailBookings: snapshots.reduce((sum, snapshot) => sum + snapshot.runtime.queuedDetailBookings, 0),
      sseClients: fallback.runtime.sseClients,
      detailQueuePressure: detailConcurrency > 0
        ? Math.round((activeDetailBookings / detailConcurrency) * 100)
        : 0,
    },
  };
}

export function clearRuntimeMetricsSnapshots(): void {
  runtimeMetricsByTeam.clear();
}

export function recordRuntimeMetricsSnapshot(input: {
  nodeId: string;
  snapshot: MetricsSnapshot;
  receivedAt?: number;
}): RuntimeMetricsRecord {
  if (!Number.isInteger(input.snapshot.teamId) || input.snapshot.teamId === null || input.snapshot.teamId <= 0) {
    throw new Error("Runtime metrics snapshot must include a positive teamId");
  }
  if (input.nodeId.trim().length === 0) {
    throw new Error("Runtime metrics nodeId must be non-empty");
  }

  const record: RuntimeMetricsRecord = {
    nodeId: input.nodeId,
    receivedAt: input.receivedAt ?? Date.now(),
    snapshot: cloneSnapshot(input.snapshot),
  };
  runtimeMetricsByTeam.set(input.snapshot.teamId, record);
  return record;
}

export function runtimeMetricsSnapshotFor(
  fallback: MetricsSnapshot,
  teamId: number | null | undefined,
): MetricsSnapshot {
  if (typeof teamId === "number") {
    const record = runtimeMetricsByTeam.get(teamId);
    if (!record || Date.now() - record.receivedAt > RUNTIME_METRICS_TTL_MS) return fallback;
    return cloneSnapshot(record.snapshot);
  }
  return aggregateSnapshots(fallback, activeRecords());
}
