import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { saveBookingRequests } from "./db-service.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";
import { logger } from "../utils/logger.js";

const SAVE_MAX_ATTEMPTS = 3;
const SAVE_RETRY_BASE_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type BookingHistorySaveResult = {
  inserted: number;
  skipped: number;
  errors: number;
  message: string;
};

export type BookingHistorySaveQueueOptions = {
  save?: (trips: ExtractedTripInfo[]) => Promise<BookingHistorySaveResult>;
  onResult?: (result: BookingHistorySaveResult, trips: ExtractedTripInfo[]) => void;
  onError?: (error: unknown, trips: ExtractedTripInfo[]) => void;
  onLatency?: (latencyMs: number, trips: ExtractedTripInfo[]) => void;
  onDrop?: (trips: ExtractedTripInfo[], reason: "overflow") => void;
  maxPendingTrips?: number;
  maxBatchSize?: number;
  deadLetterPath?: string | null;
  teamId?: number;
};

const defaultMaxPendingTrips = 50_000;
const defaultMaxBatchSize = 500;
const defaultDeadLetterPath = resolve(process.cwd(), "data", "booking-history-dead-letter.jsonl");

export class BookingHistorySaveQueue {
  private readonly save: (trips: ExtractedTripInfo[]) => Promise<BookingHistorySaveResult>;
  private readonly onResult?: (result: BookingHistorySaveResult, trips: ExtractedTripInfo[]) => void;
  private readonly onError?: (error: unknown, trips: ExtractedTripInfo[]) => void;
  private readonly onLatency?: (latencyMs: number, trips: ExtractedTripInfo[]) => void;
  private readonly onDrop?: (trips: ExtractedTripInfo[], reason: "overflow") => void;
  private readonly maxPendingTrips: number;
  private readonly maxBatchSize: number;
  private readonly deadLetterPath: string | null;
  private readonly teamId: number;
  private pendingTrips = new Map<number, ExtractedTripInfo>();
  private activeRequestIds = new Set<number>();
  private activeDrain: Promise<void> | null = null;

  constructor(options: BookingHistorySaveQueueOptions = {}) {
    this.teamId = options.teamId ?? 1;
    this.save = options.save ?? ((trips) => saveBookingRequests(this.teamId, trips));
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.onLatency = options.onLatency;
    this.onDrop = options.onDrop;
    this.maxPendingTrips = Math.max(1, options.maxPendingTrips ?? defaultMaxPendingTrips);
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? defaultMaxBatchSize);
    this.deadLetterPath = options.deadLetterPath === undefined ? defaultDeadLetterPath : options.deadLetterPath;
  }

  get pendingCount(): number {
    return this.pendingTrips.size;
  }

  get isSaving(): boolean {
    return this.activeDrain !== null;
  }

  enqueue(trips: ExtractedTripInfo[]): void {
    if (trips.length === 0) {
      return;
    }

    const droppedTrips: ExtractedTripInfo[] = [];

    for (const trip of trips) {
      if (this.activeRequestIds.has(trip.request_id)) {
        continue;
      }

      this.pendingTrips.set(trip.request_id, trip);

      while (this.pendingTrips.size > this.maxPendingTrips) {
        const oldestRequestId = this.pendingTrips.keys().next().value;
        if (oldestRequestId === undefined) {
          break;
        }
        const droppedTrip = this.pendingTrips.get(oldestRequestId);
        this.pendingTrips.delete(oldestRequestId);
        if (droppedTrip) {
          droppedTrips.push(droppedTrip);
        }
      }
    }

    if (droppedTrips.length > 0) {
      this.onDrop?.(droppedTrips, "overflow");
    }

    this.startDrain();
  }

  async flush(): Promise<void> {
    while (this.pendingTrips.size > 0 || this.activeDrain) {
      this.startDrain();
      const activeDrain = this.activeDrain;
      if (!activeDrain) {
        return;
      }
      await activeDrain;
    }
  }

  private startDrain(): void {
    if (this.activeDrain) {
      return;
    }

    const drain = this.drain().finally(() => {
      if (this.activeDrain === drain) {
        this.activeDrain = null;
      }
      if (this.pendingTrips.size > 0) {
        this.startDrain();
      }
    });

    this.activeDrain = drain;
  }

  private async saveWithRetry(batch: ExtractedTripInfo[]): Promise<BookingHistorySaveResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= SAVE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.save(batch);
      } catch (error) {
        lastError = error;
        if (attempt < SAVE_MAX_ATTEMPTS) {
          const delayMs = SAVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          logger.warn("booking-history-save-retry", {
            attempt,
            maxAttempts: SAVE_MAX_ATTEMPTS,
            delayMs,
            batchSize: batch.length,
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(delayMs);
        }
      }
    }

    throw lastError;
  }

  private takeNextBatch(): ExtractedTripInfo[] {
    const batch: ExtractedTripInfo[] = [];
    for (const [requestId, trip] of this.pendingTrips) {
      batch.push(trip);
      this.pendingTrips.delete(requestId);
      if (batch.length >= this.maxBatchSize) break;
    }
    return batch;
  }

  private async writeDeadLetter(error: unknown, batch: ExtractedTripInfo[]): Promise<void> {
    if (!this.deadLetterPath || batch.length === 0) return;
    const entry = {
      ts: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      trips: batch,
    };
    await mkdir(dirname(this.deadLetterPath), { recursive: true });
    await appendFile(this.deadLetterPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private async drain(): Promise<void> {
    while (this.pendingTrips.size > 0) {
      const batch = this.takeNextBatch();
      this.activeRequestIds = new Set(batch.map((trip) => trip.request_id));
      const startedAt = Date.now();

      try {
        const result = await this.saveWithRetry(batch);
        this.onResult?.(result, batch);
      } catch (error) {
        try {
          await this.writeDeadLetter(error, batch);
        } catch (deadLetterError) {
          logger.error("booking-history-dead-letter-write-failed", deadLetterError instanceof Error ? deadLetterError : new Error(String(deadLetterError)));
        }
        this.onError?.(error, batch);
      } finally {
        for (const trip of batch) {
          this.activeRequestIds.delete(trip.request_id);
        }
        this.onLatency?.(Date.now() - startedAt, batch);
      }
    }
  }
}
