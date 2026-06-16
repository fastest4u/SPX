/** Lightweight polling metrics collector — no external dependencies */

import { getPoolStats, type PoolStats } from "../db/client.js";
import { isTeamPaused, pollerControl } from "./poller-control.js";
import { getUpstreamConnectionCount } from "../utils/http-dispatcher.js";

export interface LatencyBucket {
  count: number;
  sum: number;
  min: number;
  max: number;
  values: number[]; // kept for percentile calculations, capped
}

export type TimedOperation =
  | "detailFetch"
  | "dbSave"
  | "notify"
  | "autoAccept"
  // Isolated SPX accept POST round-trip — the decisive competitive number.
  | "acceptRtt"
  // Request-list page-1 fetch → first matching trip (the on-critical-path detail hop).
  | "detailToFirstMatch";

export interface TimingSummary {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  lastMs: number | null;
}

export interface RuntimeMetrics {
  activeDetailJobs: number;
  activeDetailBookings: number;
  detailConcurrency: number;
  queuedDetailBookings: number;
  detailQueuePressure: number;
  sseClients: number;
}

type RuntimeState = Omit<RuntimeMetrics, "detailQueuePressure">;

export interface MetricsSnapshot {
  teamId: number | null;
  teamName?: string;
  isPaused: boolean;
  uptime: number;
  startedAt: string;
  polling: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    successRate: number;
    latency: {
      avg: number;
      min: number;
      max: number;
      p50: number;
      p95: number;
      p99: number;
    };
  };
  data: {
    totalRecordsSeen: number;
    changesDetected: number;
    tripsInserted: number;
    tripsSkipped: number;
  };
  lastPoll: {
    timestamp: string | null;
    latencyMs: number | null;
    recordCount: number | null;
    status: string | null;
  };
  database: PoolStats | null;
  session: {
    consecutiveErrors: number;
    lastSessionWarning: string | null;
    isHealthy: boolean;
  };
  autoAccept: {
    totalAttempts: number;
    successCount: number;
    failureCount: number;
  };
  // Booking-detail scheduling outcomes — reveals concurrency saturation (slots
  // clogged) and how much redundant re-processing the cooldown is suppressing.
  scheduling: {
    launched: number;
    skippedConcurrency: number;
    skippedCooldown: number;
  };
  // Keep-alive effectiveness: total upstream requests vs fresh connections opened
  // to the SPX host. A high reuseRatio proves the warm pool is removing handshakes.
  upstream: {
    requests: number;
    connections: number;
    reuseRatio: number;
  };
  operations: Record<TimedOperation, TimingSummary>;
  runtime: RuntimeMetrics;
}

const MAX_LATENCY_SAMPLES = 1000;

export interface MetricsSnapshotContext {
  teamId?: number | null;
  teamName?: string;
}

export class MetricsCollector {
  private readonly defaultTeamId: number | null;
  private readonly defaultTeamName: string | undefined;
  private startTime = Date.now();
  private totalRequests = 0;
  private successCount = 0;
  private errorCount = 0;
  private latencies: number[] = [];
  private totalRecordsSeen = 0;
  private changesDetected = 0;
  private tripsInserted = 0;
  private tripsSkipped = 0;
  private lastPollTimestamp: Date | null = null;
  private lastPollLatency: number | null = null;
  private lastPollRecordCount: number | null = null;
  private lastPollStatus: string | null = null;
  private consecutiveErrors = 0;
  private lastSessionWarning: Date | null = null;
  private autoAcceptAttempts = 0;
  private autoAcceptSuccess = 0;
  private autoAcceptFailures = 0;
  private operationLatencies: Record<TimedOperation, number[]> = {
    detailFetch: [],
    dbSave: [],
    notify: [],
    autoAccept: [],
    acceptRtt: [],
    detailToFirstMatch: [],
  };
  private upstreamRequests = 0;
  private schedulingLaunched = 0;
  private schedulingSkippedConcurrency = 0;
  private schedulingSkippedCooldown = 0;
  private runtime: RuntimeState = {
    activeDetailJobs: 0,
    activeDetailBookings: 0,
    detailConcurrency: 0,
    queuedDetailBookings: 0,
    sseClients: 0,
  };

  constructor(context: MetricsSnapshotContext = {}) {
    this.defaultTeamId = context.teamId ?? null;
    this.defaultTeamName = context.teamName;
  }

  recordPoll(latencyMs: number, success: boolean, status: string, recordCount: number | null): void {
    this.totalRequests++;
    if (success) {
      this.successCount++;
      this.consecutiveErrors = 0;
    } else {
      this.errorCount++;
      this.consecutiveErrors++;
    }

    this.latencies.push(latencyMs);
    if (this.latencies.length > MAX_LATENCY_SAMPLES) {
      this.latencies = this.latencies.slice(-MAX_LATENCY_SAMPLES);
    }

    if (recordCount !== null) {
      this.totalRecordsSeen += recordCount;
    }

    if (status === "changed") {
      this.changesDetected++;
    }

    this.lastPollTimestamp = new Date();
    this.lastPollLatency = latencyMs;
    this.lastPollRecordCount = recordCount;
    this.lastPollStatus = status;
  }

  recordTrip(action: string): void {
    if (action === "inserted") {
      this.tripsInserted++;
    } else if (action === "skipped") {
      this.tripsSkipped++;
    }
  }

  recordSessionWarning(): void {
    this.lastSessionWarning = new Date();
  }

  recordAutoAccept(success: boolean): void {
    this.autoAcceptAttempts++;
    if (success) {
      this.autoAcceptSuccess++;
    } else {
      this.autoAcceptFailures++;
    }
  }

  recordOperation(operation: TimedOperation, latencyMs: number): void {
    const samples = this.operationLatencies[operation];
    samples.push(Math.max(0, Math.round(latencyMs)));
    if (samples.length > MAX_LATENCY_SAMPLES) {
      this.operationLatencies[operation] = samples.slice(-MAX_LATENCY_SAMPLES);
    }
  }

  /** Count one upstream request sent (denominator for the connection-reuse ratio). */
  recordUpstreamRequest(): void {
    this.upstreamRequests++;
  }

  recordRuntimeState(state: Partial<RuntimeState>): void {
    this.runtime = { ...this.runtime, ...state };
  }

  /** Accumulate per-tick booking-detail scheduling outcomes. */
  recordScheduling(outcome: { launched: number; skippedConcurrency: number; skippedCooldown: number }): void {
    this.schedulingLaunched += outcome.launched;
    this.schedulingSkippedConcurrency += outcome.skippedConcurrency;
    this.schedulingSkippedCooldown += outcome.skippedCooldown;
  }

  private summarize(values: number[]): TimingSummary {
    const sorted = [...values].sort((a, b) => a - b);
    const len = sorted.length;
    return {
      count: len,
      avg: len > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / len) : 0,
      min: len > 0 ? sorted[0] : 0,
      max: len > 0 ? sorted[len - 1] : 0,
      p50: len > 0 ? sorted[Math.floor((len - 1) * 0.5)] : 0,
      p95: len > 0 ? sorted[Math.floor((len - 1) * 0.95)] : 0,
      p99: len > 0 ? sorted[Math.floor((len - 1) * 0.99)] : 0,
      lastMs: len > 0 ? values[values.length - 1] : null,
    };
  }

  snapshot(context: MetricsSnapshotContext = {}): MetricsSnapshot {
    const teamId = context.teamId !== undefined ? context.teamId : this.defaultTeamId;
    const teamName = context.teamName ?? this.defaultTeamName;
    const pollingLatency = this.summarize(this.latencies);
    const upstreamConnections = getUpstreamConnectionCount();
    const detailQueuePressure = this.runtime.detailConcurrency > 0
      ? Math.round((this.runtime.activeDetailBookings / this.runtime.detailConcurrency) * 100)
      : 0;

    return {
      teamId,
      ...(teamName ? { teamName } : {}),
      isPaused: typeof teamId === "number" ? isTeamPaused(teamId) : pollerControl.isPaused,
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      startedAt: new Date(this.startTime).toISOString(),
      polling: {
        totalRequests: this.totalRequests,
        successCount: this.successCount,
        errorCount: this.errorCount,
        successRate: this.totalRequests > 0
          ? Math.round((this.successCount / this.totalRequests) * 10000) / 100
          : 0,
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
        totalRecordsSeen: this.totalRecordsSeen,
        changesDetected: this.changesDetected,
        tripsInserted: this.tripsInserted,
        tripsSkipped: this.tripsSkipped,
      },
      lastPoll: {
        timestamp: this.lastPollTimestamp?.toISOString() ?? null,
        latencyMs: this.lastPollLatency,
        recordCount: this.lastPollRecordCount,
        status: this.lastPollStatus,
      },
      database: getPoolStats(),
      session: {
        consecutiveErrors: this.consecutiveErrors,
        lastSessionWarning: this.lastSessionWarning?.toISOString() ?? null,
        isHealthy: this.consecutiveErrors < 5,
      },
      autoAccept: {
        totalAttempts: this.autoAcceptAttempts,
        successCount: this.autoAcceptSuccess,
        failureCount: this.autoAcceptFailures,
      },
      scheduling: {
        launched: this.schedulingLaunched,
        skippedConcurrency: this.schedulingSkippedConcurrency,
        skippedCooldown: this.schedulingSkippedCooldown,
      },
      upstream: {
        requests: this.upstreamRequests,
        connections: upstreamConnections,
        reuseRatio: this.upstreamRequests > 0
          ? Math.max(0, Math.round((1 - upstreamConnections / this.upstreamRequests) * 10000) / 100)
          : 0,
      },
      operations: {
        detailFetch: this.summarize(this.operationLatencies.detailFetch),
        dbSave: this.summarize(this.operationLatencies.dbSave),
        notify: this.summarize(this.operationLatencies.notify),
        autoAccept: this.summarize(this.operationLatencies.autoAccept),
        acceptRtt: this.summarize(this.operationLatencies.acceptRtt),
        detailToFirstMatch: this.summarize(this.operationLatencies.detailToFirstMatch),
      },
      runtime: {
        ...this.runtime,
        detailQueuePressure,
      },
    };
  }
}

/** Singleton metrics instance shared across the app */
export const metrics = new MetricsCollector();
