import { localTeamMetricsSnapshots } from "./metrics.js";
import { AUTO_ACCEPT_FAILURE_REASONS } from "./auto-accept-diagnostics.js";
import type { AutoAcceptFailureReason } from "./auto-accept-diagnostics.js";
import type { MetricsSnapshot, TimedOperation, TimingSummary } from "./metrics.js";

export const RUNTIME_METRICS_TTL_MS = 120_000;
const MAX_CONNECTION_POOLS = 256;
const TIMED_OPERATIONS: readonly TimedOperation[] = [
  "biddingListPage1",
  "page1ToDetailStart",
  "firstMatchToAcceptStart",
  "verificationQueueWait",
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
  teamId: number;
  nodeId: string;
  snapshot: MetricsSnapshot;
  emittedAt: number;
  receivedAt: number;
  updatedAt: number;
}

/** Keys that must never be projected or persisted inside a runtime snapshot. */
const SNAPSHOT_SECRET_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "cookie",
  "password",
  "secret",
  "credential",
  "authorization",
]);

function sanitizeSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSnapshotValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SNAPSHOT_SECRET_KEYS.has(key.replace(/[_-]/g, "").toLowerCase())) continue;
      result[key] = sanitizeSnapshotValue(child);
    }
    return result;
  }
  return value;
}

/**
 * Validates and sanitizes an untrusted runtime metrics snapshot before it is
 * projected into a read model or persisted: secret-shaped fields are stripped
 * at every level and the team binding must be a positive integer.
 */
export function normalizeRuntimeMetricsSnapshot(input: unknown): MetricsSnapshot {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Runtime metrics snapshot must be an object");
  }
  const snapshot = sanitizeSnapshotValue(input) as MetricsSnapshot;
  if (
    !Number.isInteger(snapshot.teamId)
    || snapshot.teamId === null
    || (snapshot.teamId as number) <= 0
  ) {
    throw new Error("Runtime metrics snapshot must include a positive teamId");
  }
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Runtime metrics snapshot missing ${field}`);
    }
    return value as Record<string, unknown>;
  };
  const numbers = (value: unknown, fields: readonly string[], field: string): void => {
    const record = object(value, field);
    for (const name of fields) {
      if (typeof record[name] !== "number" || !Number.isFinite(record[name])) {
        throw new Error(`Runtime metrics snapshot has invalid ${field}.${name}`);
      }
    }
  };
  if (typeof snapshot.isPaused !== "boolean" || !Number.isFinite(snapshot.uptime)
    || typeof snapshot.startedAt !== "string" || !Number.isFinite(Date.parse(snapshot.startedAt))) {
    throw new Error("Runtime metrics snapshot has invalid runtime identity");
  }
  numbers(snapshot.polling, ["totalRequests", "successCount", "errorCount", "successRate"], "polling");
  numbers(snapshot.polling.latency, ["avg", "min", "max", "p50", "p95", "p99"], "polling.latency");
  numbers(snapshot.data, ["totalRecordsSeen", "changesDetected", "tripsInserted", "tripsSkipped"], "data");
  numbers(snapshot.session, ["consecutiveErrors"], "session");
  if (typeof snapshot.session.isHealthy !== "boolean") throw new Error("Runtime metrics snapshot has invalid session health");
  object(snapshot.lastPoll, "lastPoll");
  numbers(snapshot.autoAccept, ["totalAttempts", "successCount", "failureCount", "verifiedSuccessCount", "verifiedFailureCount", "pendingVerificationCount"], "autoAccept");
  numbers(snapshot.autoAccept.verification, ["queued", "active", "completed", "indeterminate", "maxQueueDepth"], "autoAccept.verification");
  numbers(snapshot.autoAccept.verification.failuresByReason, AUTO_ACCEPT_FAILURE_REASONS, "autoAccept.verification.failuresByReason");
  numbers(snapshot.scheduling, ["launched", "skippedConcurrency", "skippedCooldown"], "scheduling");
  numbers(snapshot.upstream, ["requests", "connections", "reuseRatio"], "upstream");
  const { connectionScope, connectionPools } = snapshot.upstream;
  if (connectionScope !== undefined || connectionPools !== undefined) {
    if (!["process", "aggregate", "unknown"].includes(connectionScope ?? "")
      || !Array.isArray(connectionPools) || connectionPools.length > MAX_CONNECTION_POOLS
      || (connectionScope === "process" && connectionPools.length !== 1)
      || (connectionScope === "aggregate" && connectionPools.length === 0)) {
      throw new Error("Runtime metrics snapshot has invalid upstream connection ownership");
    }
    const ids = new Set<string>();
    for (const pool of connectionPools) {
      object(pool, "upstream.connectionPools entry");
      if (typeof pool.id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(pool.id) || ids.has(pool.id)
        || !Number.isSafeInteger(pool.requests) || pool.requests < 0
        || !Number.isSafeInteger(pool.connections) || pool.connections < 0) {
        throw new Error("Runtime metrics snapshot has invalid upstream connection pool");
      }
      ids.add(pool.id);
    }
  }
  numbers(snapshot.runtime, ["activeDetailJobs", "activeDetailBookings", "detailConcurrency", "queuedDetailBookings", "detailQueuePressure", "sseClients"], "runtime");
  object(snapshot.operations, "operations");
  for (const operation of ["biddingListPage1", "page1ToDetailStart", "firstMatchToAcceptStart", "verificationQueueWait"] as const) {
    if (!(operation in snapshot.operations)) snapshot.operations[operation] = { count: 0, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, lastMs: null };
  }
  for (const operation of TIMED_OPERATIONS) {
    numbers(snapshot.operations[operation], ["count", "avg", "min", "max", "p50", "p95", "p99"], `operations.${operation}`);
    const summary = snapshot.operations[operation];
    if (!Number.isInteger(summary.count) || summary.count < 0
      || [summary.avg, summary.min, summary.max, summary.p50, summary.p95, summary.p99].some(value => value < 0)
      || (summary.lastMs !== null && (typeof summary.lastMs !== "number" || !Number.isFinite(summary.lastMs) || summary.lastMs < 0))) {
      throw new Error(`Runtime metrics snapshot has invalid operations.${operation}`);
    }
  }
  return snapshot;
}

const runtimeMetricsByTeam = new Map<number, RuntimeMetricsRecord>();

function cloneSnapshot(snapshot: MetricsSnapshot): MetricsSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as MetricsSnapshot;
}

function activeRecords(now = Date.now()): RuntimeMetricsRecord[] {
  const records = new Map(runtimeMetricsByTeam);
  for (const snapshot of localTeamMetricsSnapshots()) {
    // Execution-only local collectors must never replace an authoritative remote poller snapshot.
    const remote = records.get(snapshot.teamId!);
    if (remote && (snapshot.polling.totalRequests === 0
      || Date.parse(remote.snapshot.lastPoll.timestamp ?? "") > Date.parse(snapshot.lastPoll.timestamp ?? ""))) continue;
    records.set(snapshot.teamId!, { teamId: snapshot.teamId!, nodeId: "local", snapshot, receivedAt: now, updatedAt: now, emittedAt: now });
  }
  return [...records.values()]
    .filter((record) => now - record.receivedAt <= RUNTIME_METRICS_TTL_MS)
    .sort((a, b) => a.receivedAt - b.receivedAt);
}

function latestTimestamp(values: Array<string | null>): string | null {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export function summarizeTimings(summaries: TimingSummary[]): TimingSummary {
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

export interface ConnectionPoolMergeResult {
  connectionScope: "aggregate" | "unknown";
  connectionPools: NonNullable<MetricsSnapshot["upstream"]["connectionPools"]>;
}

/** Merge cumulative observations once per process, regardless of team/publication order. */
export function mergeConnectionPools(upstreams: readonly MetricsSnapshot["upstream"][]): ConnectionPoolMergeResult {
  const pools = new Map<string, NonNullable<MetricsSnapshot["upstream"]["connectionPools"]>[number]>();
  for (const upstream of upstreams) {
    for (const pool of upstream.connectionPools ?? []) {
      const previous = pools.get(pool.id);
      pools.set(pool.id, {
        id: pool.id,
        requests: Math.max(previous?.requests ?? 0, pool.requests),
        connections: Math.max(previous?.connections ?? 0, pool.connections),
      });
    }
  }
  const connectionPools = [...pools.values()].sort((a, b) => a.id.localeCompare(b.id));
  const ownershipComplete = upstreams.length > 0
    && upstreams.every(upstream =>
      (upstream.connectionScope === "process" || upstream.connectionScope === "aggregate")
      && (upstream.connectionPools?.length ?? 0) > 0)
    && connectionPools.length <= MAX_CONNECTION_POOLS;
  return {
    connectionScope: ownershipComplete ? "aggregate" : "unknown",
    connectionPools: connectionPools.slice(0, MAX_CONNECTION_POOLS),
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
  const connectionOwnership = mergeConnectionPools(snapshots.map(snapshot => snapshot.upstream));
  const { connectionPools } = connectionOwnership;
  const poolOwnershipKnown = connectionOwnership.connectionScope === "aggregate";
  const upstreamConnections = connectionPools.reduce((sum, pool) => sum + pool.connections, 0);
  const poolRequests = connectionPools.reduce((sum, pool) => sum + pool.requests, 0);
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
      reuseRatio: poolOwnershipKnown && poolRequests > 0
        ? Math.max(0, Math.round((1 - upstreamConnections / poolRequests) * 10000) / 100)
        : 0,
      connectionScope: connectionOwnership.connectionScope,
      connectionPools,
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
  emittedAt?: number;
  receivedAt?: number;
  updatedAt?: number;
}): RuntimeMetricsRecord {
  if (!Number.isInteger(input.snapshot.teamId) || input.snapshot.teamId === null || input.snapshot.teamId <= 0) {
    throw new Error("Runtime metrics snapshot must include a positive teamId");
  }
  if (input.nodeId.trim().length === 0) {
    throw new Error("Runtime metrics nodeId must be non-empty");
  }

  const receivedAt = input.receivedAt ?? Date.now();
  const record: RuntimeMetricsRecord = {
    teamId: input.snapshot.teamId,
    nodeId: input.nodeId,
    snapshot: normalizeRuntimeMetricsSnapshot(input.snapshot),
    emittedAt: input.emittedAt ?? receivedAt,
    receivedAt,
    updatedAt: input.updatedAt ?? receivedAt,
  };
  runtimeMetricsByTeam.set(input.snapshot.teamId, record);
  return record;
}

export function runtimeMetricsSnapshotFor(
  fallback: MetricsSnapshot,
  teamId: number | null | undefined,
): MetricsSnapshot {
  if (typeof teamId === "number") {
    const record = activeRecords().find(record => record.teamId === teamId);
    if (!record || Date.now() - record.receivedAt > RUNTIME_METRICS_TTL_MS) return fallback;
    return cloneSnapshot(record.snapshot);
  }
  return aggregateSnapshots(fallback, activeRecords());
}

export interface RuntimeMetricsSummaryReadModel {
  metrics: MetricsSnapshot;
  teams: Array<{ teamId: number; nodeId: string; receivedAt: number }>;
  missingTeamIds: number[];
  generatedAt: number;
}

/**
 * Builds the sanitized realtime metrics read model from durable worker records.
 * A team scope uses that team's freshest record (or the caller fallback when
 * missing); an admin scope aggregates every fresh record and reports which
 * expected teams have no fresh record.
 */
export function runtimeMetricsSummaryReadModelFromRecords(
  fallback: MetricsSnapshot,
  records: readonly RuntimeMetricsRecord[],
  teamId: number | null,
  options: { expectedTeamIds: readonly number[]; now: number },
): RuntimeMetricsSummaryReadModel {
  const fresh = records.filter(
    (record) => options.now - record.receivedAt <= RUNTIME_METRICS_TTL_MS
      && (teamId === null || record.snapshot.teamId === teamId),
  );
  let snapshot: MetricsSnapshot;
  if (typeof teamId === "number") {
    const record = fresh.find((candidate) => candidate.snapshot.teamId === teamId);
    snapshot = record ? cloneSnapshot(record.snapshot) : cloneSnapshot(fallback);
  } else {
    snapshot = aggregateSnapshots(fallback, fresh);
  }
  const freshTeamIds = new Set(
    fresh.map((record) => Number(record.snapshot.teamId)).filter((id) => Number.isInteger(id)),
  );
  return {
    metrics: snapshot,
    teams: fresh
      .filter((record) => Number.isInteger(record.snapshot.teamId))
      .map((record) => ({
        teamId: record.snapshot.teamId as number,
        nodeId: record.nodeId,
        receivedAt: record.receivedAt,
      })),
    missingTeamIds: options.expectedTeamIds.filter((id) => (teamId === null || id === teamId) && !freshTeamIds.has(id)),
    generatedAt: options.now,
  };
}
