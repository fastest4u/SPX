import type { MetricsSnapshot, TimingSummary } from "./metrics.js";
import {
  mergeConnectionPools,
  summarizeTimings,
  RUNTIME_METRICS_TTL_MS,
  type RuntimeMetricsRecord,
} from "./runtime-metrics.js";

export const EXECUTION_OPERATIONS = ["firstMatchToAcceptStart", "acceptRtt"] as const;
export interface ExecutionMetricsSnapshot {
  teamId: number;
  generation: string;
  startedAt: string;
  operations: Pick<MetricsSnapshot["operations"], (typeof EXECUTION_OPERATIONS)[number]>;
  upstream: MetricsSnapshot["upstream"];
}
export interface ExecutionMetricsRecord {
  teamId: number;
  nodeId: string;
  snapshot: ExecutionMetricsSnapshot;
  emittedAt: number;
  receivedAt: number;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid execution metrics fields");
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid execution metrics counter");
  return value;
}
function timing(value: unknown): TimingSummary {
  const record = object(value, ["count", "avg", "min", "max", "p50", "p95", "p99", "lastMs"]);
  count(record.count);
  for (const key of ["avg", "min", "max", "p50", "p95", "p99", "lastMs"]) {
    if (key === "lastMs" && record[key] === null) continue;
    if (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0)
      throw new Error("Invalid execution metrics timing");
  }
  if ((record.count as number) > 1000) throw new Error("Execution timing exceeds collector bound");
  return { ...record } as unknown as TimingSummary;
}
export function normalizeExecutionMetricsSnapshot(value: unknown): ExecutionMetricsSnapshot {
  const record = object(value, ["teamId", "generation", "startedAt", "operations", "upstream"]);
  if (
    count(record.teamId) === 0 ||
    typeof record.generation !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(record.generation) ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt))
  )
    throw new Error("Invalid execution producer identity");
  const operations = object(record.operations, [...EXECUTION_OPERATIONS]);
  const upstream = object(record.upstream, [
    "requests",
    "connections",
    "reuseRatio",
    "connectionScope",
    "connectionPools",
  ]);
  const requests = count(upstream.requests);
  if (
    upstream.connectionScope !== "process" ||
    !Array.isArray(upstream.connectionPools) ||
    upstream.connectionPools.length !== 1
  )
    throw new Error("Execution metrics require one process pool");
  const pool = object(upstream.connectionPools[0], ["id", "requests", "connections"]);
  if (typeof pool.id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(pool.id))
    throw new Error("Invalid execution process pool");
  const poolRequests = count(pool.requests);
  const connections = count(pool.connections);
  return {
    teamId: record.teamId as number,
    generation: record.generation,
    startedAt: new Date(record.startedAt).toISOString(),
    operations: {
      acceptRtt: timing(operations.acceptRtt),
      firstMatchToAcceptStart: timing(operations.firstMatchToAcceptStart),
    },
    upstream: {
      requests,
      connections,
      reuseRatio:
        poolRequests > 0
          ? Math.max(0, Math.round((1 - connections / poolRequests) * 10000) / 100)
          : 0,
      connectionScope: "process",
      connectionPools: [{ id: pool.id, requests: poolRequests, connections }],
    },
  };
}
export function executionMetricsSnapshot(
  snapshot: MetricsSnapshot,
  generation: string,
  startedAt: string,
): ExecutionMetricsSnapshot {
  return normalizeExecutionMetricsSnapshot({
    teamId: snapshot.teamId,
    generation,
    startedAt,
    operations: {
      acceptRtt: snapshot.operations.acceptRtt,
      firstMatchToAcceptStart: snapshot.operations.firstMatchToAcceptStart,
    },
    upstream: snapshot.upstream,
  });
}
/** Only execution-owned observations are summed; primary poll identity and freshness remain authoritative. */
export function mergeExecutionMetricsRecords(
  primary: readonly RuntimeMetricsRecord[],
  execution: readonly ExecutionMetricsRecord[],
  now = Date.now(),
): RuntimeMetricsRecord[] {
  return primary.map((record) => {
    const producers = execution.filter(
      (e) =>
        e.teamId === record.teamId &&
        e.nodeId !== record.nodeId &&
        now - Math.min(e.emittedAt, e.receivedAt) <= RUNTIME_METRICS_TTL_MS,
    );
    if (!producers.length) return record;
    const snapshot = record.snapshot;
    const upstreams = [snapshot.upstream, ...producers.map((e) => e.snapshot.upstream)];
    const ownership = mergeConnectionPools(upstreams);
    const connections = ownership.connectionPools.reduce((sum, pool) => sum + pool.connections, 0);
    const requests = ownership.connectionPools.reduce((sum, pool) => sum + pool.requests, 0);
    return {
      ...record,
      snapshot: {
        ...snapshot,
        operations: {
          ...snapshot.operations,
          acceptRtt: summarizeTimings([
            snapshot.operations.acceptRtt,
            ...producers.map((e) => e.snapshot.operations.acceptRtt),
          ]),
          firstMatchToAcceptStart: summarizeTimings([
            snapshot.operations.firstMatchToAcceptStart,
            ...producers.map((e) => e.snapshot.operations.firstMatchToAcceptStart),
          ]),
        },
        upstream: {
          ...ownership,
          requests: upstreams.reduce((sum, u) => sum + u.requests, 0),
          connections,
          reuseRatio:
            ownership.connectionScope === "aggregate" && requests > 0
              ? Math.max(0, Math.round((1 - connections / requests) * 10000) / 100)
              : 0,
        },
      },
    };
  });
}
