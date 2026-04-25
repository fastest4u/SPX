/** Lightweight polling metrics collector — no external dependencies */

export interface LatencyBucket {
  count: number;
  sum: number;
  min: number;
  max: number;
  values: number[]; // kept for percentile calculations, capped
}

export interface MetricsSnapshot {
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
}

const MAX_LATENCY_SAMPLES = 1000;

export class MetricsCollector {
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

  recordPoll(latencyMs: number, success: boolean, status: string, recordCount: number | null): void {
    this.totalRequests++;
    if (success) {
      this.successCount++;
    } else {
      this.errorCount++;
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

  snapshot(): MetricsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const len = sorted.length;

    return {
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
          avg: len > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / len) : 0,
          min: len > 0 ? sorted[0] : 0,
          max: len > 0 ? sorted[len - 1] : 0,
          p50: len > 0 ? sorted[Math.floor(len * 0.5)] : 0,
          p95: len > 0 ? sorted[Math.floor(len * 0.95)] : 0,
          p99: len > 0 ? sorted[Math.floor(len * 0.99)] : 0,
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
    };
  }
}

/** Singleton metrics instance shared across the app */
export const metrics = new MetricsCollector();
