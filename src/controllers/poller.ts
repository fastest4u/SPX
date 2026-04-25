import { env } from "../config/env.js";
import { closePool } from "../db/client.js";
import { ApiClient } from "../services/api-client.js";
import { DataProcessor } from "../services/data-processor.js";
import { saveBookingRequest } from "../services/db-service.js";
import { notifyMatchedRules } from "../services/notifier.js";
import { metrics } from "../services/metrics.js";
import { startHttpServer, stopHttpServer } from "../services/http-server.js";
import {
  logger,
  formatHeader,
  formatFooter,
  formatRequestLine,
  formatStatus,
} from "../utils/logger.js";
import { extractAllRequestListTrips, formatTripInfo } from "../utils/booking-extractor.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";
import type { PollingStats } from "../models/types.js";

const MAX_BOOKING_CONCURRENCY = 3;

export class Poller {
  private apiClient: ApiClient;
  private dataProcessor: DataProcessor;
  private stats: PollingStats;
  private intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeTick: Promise<void> | null = null;
  private requestCount = 0;
  private stopped = false;

  constructor(intervalSec?: number) {
    this.apiClient = new ApiClient();
    this.dataProcessor = new DataProcessor();
    this.intervalMs = intervalSec === undefined ? env.POLL_INTERVAL_MS : intervalSec * 1000;
    this.stats = {
      totalRequests: 0,
      errorCount: 0,
      startTime: new Date(),
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    formatHeader(
      "Agency Booking Bidding List - Real-time Polling",
      env.API_URL,
      Math.round(this.intervalMs / 1000)
    );

    const features: string[] = [];
    if (env.FETCH_DETAILS) features.push("FETCH_DETAILS");
    if (env.SAVE_TO_DB) features.push("SAVE_TO_DB");
    if (env.NOTIFY_ENABLED) features.push(`NOTIFY(${env.NOTIFY_MODE})`);
    if (env.HTTP_ENABLED) features.push(`HTTP(:${env.HTTP_PORT})`);
    if (features.length > 0) {
      logger.info("poller-features", { features });
    }

    if (env.HTTP_ENABLED) {
      await startHttpServer(env.HTTP_PORT);
    }

    if (process.stdout.isTTY) {
      logger.info("interactive-console-detected", { tty: true });
    }

    void this.run();

    process.once("SIGINT", () => void this.stop());
    process.once("SIGTERM", () => void this.stop());
    process.once("uncaughtException", (error) => {
      logger.error("uncaught-exception", error instanceof Error ? error : new Error(String(error)));
      void this.stop(1);
    });
    process.once("unhandledRejection", (reason) => {
      logger.error("unhandled-rejection", reason instanceof Error ? reason : new Error(String(reason)));
      void this.stop(1);
    });
  }

  private async run(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      this.activeTick = this.tick();
      await this.activeTick;
    } catch (err) {
      this.stats.errorCount++;
      logger.error(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.activeTick = null;
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.run(), this.intervalMs);
      }
    }
  }

  private async tick(): Promise<void> {
    this.requestCount++;
    const reqNum = this.requestCount;
    this.stats.totalRequests++;

    process.stdout.write(`${formatRequestLine(reqNum)}\n`);

    const result = await this.apiClient.fetch(reqNum);

    if (!result.success) {
      this.stats.errorCount++;
      metrics.recordPoll(result.latencyMs, false, "error", null);
      logger.error("poll-failed", { latencyMs: result.latencyMs, httpStatus: result.httpStatus, error: result.error });
      return;
    }

    const change = this.dataProcessor.detectChange(result.data);

    let status: "ok" | "changed" | "same" | "first" = "ok";
    if (change.isFirst) status = "first";
    else if (change.hasChanged) status = "changed";
    else status = "same";

    metrics.recordPoll(result.latencyMs, true, status, change.recordCount);

    process.stdout.write(`${formatStatus(result.latencyMs, status, change.recordCount)}\n`);

    const summary = this.dataProcessor.extractSummary(result.data);
    if (summary) {
      logger.info("poll-summary", summary);
    }

    if ((env.FETCH_DETAILS || env.SAVE_TO_DB || env.NOTIFY_ENABLED) && result.data.data?.list) {
      const allTrips: ExtractedTripInfo[] = [];
      const bookings = [...result.data.data.list];

      for (let i = 0; i < bookings.length; i += MAX_BOOKING_CONCURRENCY) {
        const chunk = bookings.slice(i, i + MAX_BOOKING_CONCURRENCY);
        const chunkResults = await Promise.all(chunk.map(async (booking) => {
          const requestList = await this.apiClient.fetchBookingRequestList(booking.booking_id);
          if (!requestList) {
            logger.warn("request-list-missing", { bookingId: booking.booking_id });
            return [] as ExtractedTripInfo[];
          }

          return extractAllRequestListTrips(requestList.data, {
            booking_id: booking.booking_id,
            booking_name: booking.booking_name,
            agency_name: booking.agency_name,
          });
        }));

        for (const trips of chunkResults) {
          for (const trip of trips) {
            if (env.FETCH_DETAILS) {
              console.log("\n" + formatTripInfo(trip));
            }

            if (env.SAVE_TO_DB) {
              const dbResult = await saveBookingRequest(trip);
              metrics.recordTrip(dbResult.action);
              logger.info("db-save", { action: dbResult.action, message: dbResult.message, requestId: trip.request_id });
            }

            allTrips.push(trip);
          }
        }
      }

      if (env.NOTIFY_ENABLED && allTrips.length > 0) {
        await notifyMatchedRules(allTrips);
      }
    }
  }

  async stop(exitCode = 0): Promise<void> {
    if (this.stopped) {
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }

    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.activeTick) {
      await this.activeTick.catch(() => undefined);
    }

    formatFooter(this.stats);

    try {
      await stopHttpServer();
    } catch (err) {
      logger.error("http-shutdown-error", err instanceof Error ? err : new Error(String(err)));
    }

    try {
      await closePool();
    } catch (err) {
      logger.error("db-shutdown-error", err instanceof Error ? err : new Error(String(err)));
      process.exit(1);
    }

    process.exit(exitCode);
  }
}
