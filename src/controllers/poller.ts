import { env } from "../config/env.js";
import { closePool } from "../db/client.js";
import { ApiClient } from "../services/api-client.js";
import { DataProcessor } from "../services/data-processor.js";
import { saveBookingRequest } from "../services/db-service.js";
import { notifyMatchedRules, acceptAndNotifyMatchedRules, sendSessionExpiryNotification } from "../services/notifier.js";
import { metrics } from "../services/metrics.js";
import { startHttpServer, stopHttpServer } from "../services/http-server.js";
import { getActiveAutoAcceptOriginFilters } from "../services/notify-rules.js";
import { ensureMetricsTable, insertMetricsSnapshot } from "../repositories/metrics-repository.js";
import {
  logger,
  formatHeader,
  formatFooter,
  formatRequestLine,
  formatStatus,
} from "../utils/logger.js";
import { extractAllRequestListTrips, formatTripInfo } from "../utils/booking-extractor.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";
import { classifyPollingError, formatClassifiedError } from "../utils/error-classifier.js";
import { sseBroadcaster } from "../services/sse.js";
import type { Booking, PollingStats } from "../models/types.js";

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

function bookingMatchesOriginFilters(booking: Booking, originFilters: string[]): boolean {
  if (originFilters.length === 0) return true;
  const bookingName = booking.booking_name.trim().toLowerCase();
  return originFilters.some((origin) => origin.length > 0 && bookingName.includes(origin));
}

export class Poller {
  private apiClient: ApiClient;
  private dataProcessor: DataProcessor;
  private stats: PollingStats;
  private intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeTick: Promise<void> | null = null;
  private requestCount = 0;
  private stopped = false;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private lastSessionAlertTime = 0;
  private activeDetailJobs = new Set<Promise<void>>();
  private activeDetailBookingIds = new Set<number>();
  private static readonly SESSION_ALERT_THROTTLE_MS = 10 * 60_000; // 10 minutes

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
    if (env.AUTO_ACCEPT_ENABLED) features.push("AUTO_ACCEPT");
    if (features.length > 0 && !env.HTTP_ENABLED) {
      logger.info("poller-features", { features });
    }

    if (env.HTTP_ENABLED) {
      await startHttpServer(env.HTTP_PORT);
    }

    // Start periodic metrics persistence (every 5 minutes)
    if (env.SAVE_TO_DB) {
      try {
        await ensureMetricsTable();
        this.metricsTimer = setInterval(() => void this.persistMetrics(), 5 * 60_000);
      } catch (err) {
        logger.warn("metrics-persistence-init-failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (process.stdout.isTTY && !env.HTTP_ENABLED) {
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

    if (!env.HTTP_ENABLED) process.stdout.write(`${formatRequestLine(reqNum)}\n`);

    const result = await this.apiClient.fetch(reqNum);

    if (!result.success) {
      this.stats.errorCount++;
      const classified = classifyPollingError(result.httpStatus, result.error);
      metrics.recordPoll(result.latencyMs, false, classified.category, null);
      sseBroadcaster.broadcast({ event: "metrics", data: metrics.snapshot() });
      logger.error("poll-failed", { latencyMs: result.latencyMs, ...formatClassifiedError(classified) });

      // Alert on session expiry — send notification once
      if (classified.category === "session_expired") {
        metrics.recordSessionWarning();
        await this.sendSessionExpiryAlert(classified.message);
      }
      return;
    }

    const change = this.dataProcessor.detectChange(result.data);

    let status: "ok" | "changed" | "same" | "first" = "ok";
    if (change.isFirst) status = "first";
    else if (change.hasChanged) status = "changed";
    else status = "same";

    metrics.recordPoll(result.latencyMs, true, status, change.recordCount);

    if (!env.HTTP_ENABLED) process.stdout.write(`${formatStatus(result.latencyMs, status, change.recordCount)}\n`);

    // Broadcast live metrics to SSE clients
    sseBroadcaster.broadcast({
      event: "metrics",
      data: metrics.snapshot(),
    });

    const summary = this.dataProcessor.extractSummary(result.data);
    if (summary && !env.HTTP_ENABLED) {
      logger.info("poll-summary", summary);
    }

    if ((env.FETCH_DETAILS || env.SAVE_TO_DB || env.NOTIFY_ENABLED || env.AUTO_ACCEPT_ENABLED) && result.data.data?.list) {
      this.scheduleBookingDetails(result.data.data.list);
    }
  }

  private scheduleBookingDetails(bookings: Booking[]): void {
    if (this.stopped || bookings.length === 0) return;

    const job = this.processBookingDetails(bookings)
      .catch((err) => {
        logger.error("booking-detail-job-failed", err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.activeDetailJobs.delete(job);
      });

    this.activeDetailJobs.add(job);
  }

  private async processBookingDetails(bookings: Booking[]): Promise<void> {
    const allTrips: ExtractedTripInfo[] = [];
    let fastLaneBookings = [...bookings];
    let deferredBookings: Booking[] = [];

    const acceptedRequestIds = new Set<number>();
    let fastLanePrefiltered = false;

    if (env.AUTO_ACCEPT_ENABLED) {
      const originFilters = await getActiveAutoAcceptOriginFilters();
      if (originFilters.length > 0) {
        const matchingBookings = fastLaneBookings.filter((booking) => bookingMatchesOriginFilters(booking, originFilters));
        const nonMatchingBookings = fastLaneBookings.filter((booking) => !bookingMatchesOriginFilters(booking, originFilters));
        const skippedCount = nonMatchingBookings.length;
        fastLanePrefiltered = true;

        if (env.FETCH_DETAILS || env.SAVE_TO_DB || env.NOTIFY_ENABLED) {
          fastLaneBookings = matchingBookings;
          deferredBookings = nonMatchingBookings;
        } else {
          fastLaneBookings = matchingBookings;
        }

        logger.info("booking-origin-prefilter", {
          total: bookings.length,
          prioritized: matchingBookings.length,
          skipped: env.FETCH_DETAILS || env.SAVE_TO_DB || env.NOTIFY_ENABLED ? 0 : skippedCount,
        });
      }
    }

    let autoAcceptQueue: Promise<void> = Promise.resolve();
    const runAutoAcceptInOrder = async (trips: ExtractedTripInfo[]): Promise<void> => {
      const current = autoAcceptQueue.then(async () => {
        const autoResult = await acceptAndNotifyMatchedRules(trips, this.apiClient, { deferSideEffects: true });
        autoResult.accepted.forEach((a) => {
          if (a.requestId > 0) acceptedRequestIds.add(a.requestId);
        });
      });
      autoAcceptQueue = current.catch(() => undefined);
      await current;
    };

    const fetchBookingTrips = async (
      items: Booking[],
      options: { autoAccept: boolean; lane: "fast" | "deferred" }
    ): Promise<ExtractedTripInfo[][]> => {
      const availableBookings = items.filter((booking) => !this.activeDetailBookingIds.has(booking.booking_id));
      if (availableBookings.length === 0) return [];

      for (const booking of availableBookings) {
        this.activeDetailBookingIds.add(booking.booking_id);
      }

      const detailConcurrency = Math.min(env.BOOKING_DETAIL_CONCURRENCY, availableBookings.length);
      if (availableBookings.length > detailConcurrency) {
        logger.info("booking-detail-concurrency", { bookings: availableBookings.length, concurrency: detailConcurrency, lane: options.lane });
      }

      return mapWithConcurrency(availableBookings, detailConcurrency, async (booking) => {
        try {
          const requestList = await this.apiClient.fetchBookingRequestList(booking.booking_id);
          if (!requestList) {
            logger.warn("request-list-missing", { bookingId: booking.booking_id });
            return [] as ExtractedTripInfo[];
          }

          const trips = extractAllRequestListTrips(requestList.data, {
            booking_id: booking.booking_id,
            booking_name: booking.booking_name,
            agency_name: booking.agency_name,
          });

          if (options.autoAccept && trips.length > 0) {
            await runAutoAcceptInOrder(trips);
          }

          return trips;
        } catch (err) {
          logger.error("booking-detail-processing-failed", {
            bookingId: booking.booking_id,
            lane: options.lane,
            error: err instanceof Error ? err.message : String(err),
          });
          return [] as ExtractedTripInfo[];
        } finally {
          this.activeDetailBookingIds.delete(booking.booking_id);
        }
      });
    };

    const bookingTrips = await fetchBookingTrips(fastLaneBookings, { autoAccept: env.AUTO_ACCEPT_ENABLED, lane: "fast" });
    if (deferredBookings.length > 0) {
      const deferredTrips = await fetchBookingTrips(deferredBookings, { autoAccept: env.AUTO_ACCEPT_ENABLED && !fastLanePrefiltered, lane: "deferred" });
      bookingTrips.push(...deferredTrips);
    }

    allTrips.push(...bookingTrips.flat());

    for (const trip of allTrips) {
      if (env.FETCH_DETAILS && !env.HTTP_ENABLED) {
        console.log("\n" + formatTripInfo(trip));
      }

      if (env.SAVE_TO_DB) {
        const dbResult = await saveBookingRequest(trip);
        metrics.recordTrip(dbResult.action);
      }
    }

    if (env.NOTIFY_ENABLED && allTrips.length > 0) {
      const remainingTrips = allTrips.filter((trip) => !acceptedRequestIds.has(trip.request_id));
      if (remainingTrips.length > 0) {
        await notifyMatchedRules(remainingTrips);
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
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    // Persist final metrics snapshot before shutdown
    await this.persistMetrics();

    if (this.activeTick) {
      await this.activeTick.catch(() => undefined);
    }

    if (this.activeDetailJobs.size > 0) {
      await Promise.allSettled([...this.activeDetailJobs]);
    }

    formatFooter(this.stats);

    sseBroadcaster.closeAll();

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

  private async persistMetrics(): Promise<void> {
    if (!env.SAVE_TO_DB) return;
    try {
      const snap = metrics.snapshot();
      await insertMetricsSnapshot(snap);
      if (!env.HTTP_ENABLED) {
        logger.info("metrics-persisted", { uptime: snap.uptime, totalRequests: snap.polling.totalRequests });
      }
    } catch (err) {
      logger.warn("metrics-persist-failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Send session expiry alert via Discord/LINE — throttled to once per 10 minutes */
  private async sendSessionExpiryAlert(errorMessage: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastSessionAlertTime < Poller.SESSION_ALERT_THROTTLE_MS) {
      return; // Already alerted recently
    }
    this.lastSessionAlertTime = now;

    sseBroadcaster.broadcast({
      event: "session-expired",
      data: {
        message: errorMessage,
        timestamp: new Date(now).toISOString(),
      },
    });

    try {
      const result = await sendSessionExpiryNotification(errorMessage);
      if (result.sent) {
        logger.warn("session-expiry-alert-sent", {
          channels: result.results.filter((channel) => channel.ok).map((channel) => channel.channel),
          errorMessage,
        });
        return;
      }

      logger.warn("session-expiry-alert-not-sent", {
        reason: result.skipped ? "no-notification-target" : "all-notification-channels-failed",
        channels: result.results,
        errorMessage,
      });
    } catch (err) {
      logger.error("session-expiry-alert-failed", err instanceof Error ? err : new Error(String(err)));
    }
  }
}
