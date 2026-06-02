import { env } from "../config/env.js";
import { closePool } from "../db/client.js";
import { ApiClient } from "../services/api-client.js";
import { DataProcessor } from "../services/data-processor.js";
import { BookingHistorySaveQueue } from "../services/booking-history-save-queue.js";
import { acceptAndNotifyMatchedRules, sendSessionExpiryNotification, NeedBudget } from "../services/notifier.js";
import { metrics } from "../services/metrics.js";
import { startHttpServer, stopHttpServer } from "../services/http-server.js";
import { getActiveAutoAcceptRules, getAutoAcceptOriginFilters } from "../services/notify-rules.js";
import type { NotifyRule } from "../services/notify-rules.js";
import { ensureMetricsTable, insertMetricsSnapshot } from "../repositories/metrics-repository.js";
import {
  logger,
  formatHeader,
  formatFooter,
  formatRequestLine,
  formatStatus,
} from "../utils/logger.js";
import { orderBookingsByOriginHint } from "../utils/booking-priority.js";
import { extractAllRequestListTrips, filterTripsByBiddingVehicleType, formatTripInfo } from "../utils/booking-extractor.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";
import { classifyPollingError, formatClassifiedError } from "../utils/error-classifier.js";
import { sseBroadcaster } from "../services/sse.js";
import type { Booking, PollingStats } from "../models/types.js";
import { pollerControl } from "../services/poller-control.js";


export class Poller {
  private apiClient: ApiClient;
  private dataProcessor: DataProcessor;
  private stats: PollingStats;
  private readonly cliIntervalMs: number | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeTick: Promise<void> | null = null;
  private requestCount = 0;
  private stopped = false;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private lastSessionAlertTime = 0;
  private activeDetailBookingIds = new Set<number>();
  /** Tracks how many detail-fetch tasks are currently in-flight (bounded by BOOKING_DETAIL_CONCURRENCY). */
  private detailInflight = 0;
  private historySaveQueue: BookingHistorySaveQueue;
  private static readonly SESSION_ALERT_THROTTLE_MS = 10 * 60_000; // 10 minutes
  /** Shared auto-accept budget & rules, refreshed each tick to avoid redundant DB lookups across per-booking tasks. */
  private tickAutoAcceptRules: NotifyRule[] = [];
  private tickNeedBudget = new NeedBudget();

  constructor(intervalSec?: number) {
    this.apiClient = new ApiClient();
    this.dataProcessor = new DataProcessor();
    this.historySaveQueue = new BookingHistorySaveQueue({
      onResult: (dbResult) => {
        for (let i = 0; i < dbResult.inserted; i++) metrics.recordTrip("inserted");
        for (let i = 0; i < dbResult.skipped; i++) metrics.recordTrip("skipped");
        if (dbResult.errors > 0) {
          logger.warn("booking-history-batch-save-failed", { errors: dbResult.errors, message: dbResult.message });
        }
      },
      onError: (error, trips) => {
        logger.error("booking-history-async-save-failed", {
          trips: trips.length,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onLatency: (latencyMs) => {
        metrics.recordOperation("dbSave", latencyMs);
      },
      onDrop: (trips, reason) => {
        logger.warn("booking-history-queue-drop", { trips: trips.length, reason });
      },
    });
    this.cliIntervalMs = intervalSec !== undefined ? intervalSec * 1000 : null;
    this.stats = {
      totalRequests: 0,
      errorCount: 0,
      startTime: new Date(),
    };
  }

  private getIntervalMs(): number {
    return this.cliIntervalMs ?? env.POLL_INTERVAL_MS;
  }

  private recordDetailRuntime(): void {
    metrics.recordRuntimeState({
      activeDetailJobs: this.detailInflight,
      activeDetailBookings: this.activeDetailBookingIds.size,
      detailConcurrency: env.BOOKING_DETAIL_CONCURRENCY,
      queuedDetailBookings: 0,
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    formatHeader(
      "Agency Booking Bidding List - Real-time Polling",
      env.API_URL,
      Math.round(this.getIntervalMs() / 1000)
    );

    const features: string[] = [];
    if (env.FETCH_DETAILS) features.push("FETCH_DETAILS");
    if (env.SAVE_TO_DB) features.push("SAVE_TO_DB");
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

    // Measure tick duration so we can subtract it from the interval below (drift compensation).
    const tickStart = Date.now();
    try {
      if (!pollerControl.isPaused) {
        this.activeTick = this.tick();
        await this.activeTick;
      }
    } catch (err) {
      this.stats.errorCount++;
      logger.error(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.activeTick = null;
      if (!this.stopped) {
        // Paused path stays at a fixed 1s heartbeat. Active path compensates for the measured tick
        // duration so cadence does not drift under latency. POLL_INTERVAL_MS is never floored — when
        // a tick takes longer than the interval, waitMs collapses to 0 and the next tick fires ASAP.
        let waitMs: number;
        if (pollerControl.isPaused) {
          waitMs = 1000;
        } else {
          const tickDuration = Date.now() - tickStart;
          waitMs = Math.max(0, this.getIntervalMs() - tickDuration);
        }
        this.timer = setTimeout(() => void this.run(), waitMs);
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

    if ((env.FETCH_DETAILS || env.SAVE_TO_DB || env.AUTO_ACCEPT_ENABLED) && result.data.data?.list) {
      void this.scheduleBookingDetails(result.data.data.list);
    }
  }

  /**
   * Fire-and-forget: each booking launches its own independent async task, bounded only by
   * BOOKING_DETAIL_CONCURRENCY.  No batching, no pending queue, no Head-of-Line Blocking.
   */
  private async scheduleBookingDetails(bookings: Booking[]): Promise<void> {
    if (this.stopped || bookings.length === 0) return;

    // Refresh shared auto-accept rules once per tick (cheap — cached in notify-rules.ts)
    if (env.AUTO_ACCEPT_ENABLED) {
      try {
        this.tickAutoAcceptRules = await getActiveAutoAcceptRules();
      } catch (err) {
        logger.error("auto-accept-rules-fetch-failed", err instanceof Error ? err : new Error(String(err)));
        this.tickAutoAcceptRules = [];
      }
    }

    // Priority sort: origin-matching bookings first
    let sortedBookings = bookings;
    if (env.AUTO_ACCEPT_ENABLED && this.tickAutoAcceptRules.length > 0) {
      const originFilters = getAutoAcceptOriginFilters(this.tickAutoAcceptRules);
      if (originFilters.length > 0) {
        const prioritized = orderBookingsByOriginHint(bookings, originFilters);
        sortedBookings = prioritized.ordered;
        if (prioritized.prioritized.length > 0) {
          logger.info("booking-origin-prefilter", {
            total: bookings.length,
            prioritized: prioritized.prioritized.length,
            deferred: prioritized.deferred.length,
            mode: "sort-only",
          });
        }
      }
    }

    let launched = 0;
    let skippedDuplicate = 0;
    let skippedConcurrency = 0;

    for (const booking of sortedBookings) {
      // Dedup: skip bookings already being processed
      if (this.activeDetailBookingIds.has(booking.booking_id)) {
        skippedDuplicate++;
        continue;
      }
      // Concurrency guard: bounded by BOOKING_DETAIL_CONCURRENCY
      if (this.detailInflight >= env.BOOKING_DETAIL_CONCURRENCY) {
        skippedConcurrency += sortedBookings.length - launched - skippedDuplicate - skippedConcurrency;
        break;
      }

      // Reserve slot immediately (synchronous)
      this.activeDetailBookingIds.add(booking.booking_id);
      this.detailInflight++;
      launched++;

      // Fire-and-forget: each booking is independent
      void this.processOneBooking(booking)
        .catch((err) => {
          logger.error("booking-detail-failed", {
            bookingId: booking.booking_id,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.activeDetailBookingIds.delete(booking.booking_id);
          this.detailInflight--;
          this.recordDetailRuntime();
        });
    }

    if (skippedConcurrency > 0) {
      logger.warn("booking-detail-concurrency-saturated", {
        launched,
        skippedConcurrency,
        skippedDuplicate,
        inflight: this.detailInflight,
        limit: env.BOOKING_DETAIL_CONCURRENCY,
      });
    }

    this.recordDetailRuntime();
  }

  /**
   * Process a single booking: fetch detail, extract trips, auto-accept, save to DB.
   * Fully independent — no coupling to sibling bookings.
   */
  private async processOneBooking(booking: Booking): Promise<void> {
    const startedAt = Date.now();
    const context = {
      booking_id: booking.booking_id,
      booking_name: booking.booking_name,
      agency_name: booking.agency_name,
    };

    const autoAcceptEnabled = env.AUTO_ACCEPT_ENABLED && this.tickAutoAcceptRules.length > 0;
    let autoAcceptTask: Promise<void> | null = null;
    let autoAcceptHandledByPage = false;

    const requestList = await this.apiClient.fetchBookingRequestList(booking.booking_id, {
      onPage: autoAcceptEnabled
        ? (page) => {
            const pageTrips = filterTripsByBiddingVehicleType(
              extractAllRequestListTrips(page.data, context),
              env.BIDDING_VEHICLE_TYPE
            ).trips;
            if (pageTrips.length > 0) {
              autoAcceptHandledByPage = true;
              autoAcceptTask = this.runAutoAcceptForTrips(pageTrips, booking.booking_id);
            }
          }
        : undefined,
    }).finally(() => {
      metrics.recordOperation("detailFetch", Date.now() - startedAt);
    });

    if (!requestList) {
      logger.warn("request-list-missing", { bookingId: booking.booking_id });
      return;
    }

    const extractedTrips = extractAllRequestListTrips(requestList.data, context);
    const { trips, skipped } = filterTripsByBiddingVehicleType(extractedTrips, env.BIDDING_VEHICLE_TYPE);

    if (skipped > 0) {
      logger.warn("booking-detail-vehicle-type-filtered", {
        bookingId: booking.booking_id,
        configuredVehicleType: env.BIDDING_VEHICLE_TYPE,
        kept: trips.length,
        skipped,
        skippedVehicleTypes: [
          ...new Set(
            extractedTrips
              .filter((trip) => trip.vehicle_type_id !== env.BIDDING_VEHICLE_TYPE)
              .map((trip) => trip.ประเภทรถ)
              .filter(Boolean)
          ),
        ].slice(0, 10),
      });
    }

    // Auto-accept: if the page callback didn't already handle it, fire now
    if (autoAcceptEnabled && trips.length > 0 && !autoAcceptHandledByPage) {
      autoAcceptTask = this.runAutoAcceptForTrips(trips, booking.booking_id);
    }

    // Print to console if running in CLI mode
    if (env.FETCH_DETAILS && !env.HTTP_ENABLED) {
      for (const trip of trips) {
        console.log("\n" + formatTripInfo(trip));
      }
    }

    // Enqueue DB save
    if (env.SAVE_TO_DB && trips.length > 0) {
      this.historySaveQueue.enqueue(trips);
    }

    // Wait for auto-accept to finish before releasing the booking slot
    if (autoAcceptTask) {
      await autoAcceptTask;
    }
  }

  /** Run auto-accept for extracted trips, sharing the tick-scoped NeedBudget. */
  private async runAutoAcceptForTrips(trips: ExtractedTripInfo[], bookingId: number): Promise<void> {
    const startedAt = Date.now();
    try {
      await acceptAndNotifyMatchedRules(trips, this.apiClient, {
        autoAcceptRules: this.tickAutoAcceptRules,
        deferSideEffects: true,
        needBudget: this.tickNeedBudget,
      });
    } catch (err) {
      logger.error("auto-accept-processing-failed", {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      metrics.recordOperation("autoAccept", Date.now() - startedAt);
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

    if (this.activeTick) {
      await this.activeTick.catch(() => undefined);
    }

    // Wait for all in-flight detail tasks to settle
    if (this.activeDetailBookingIds.size > 0) {
      // Poll briefly until all in-flight tasks drain (they are fire-and-forget promises)
      const drainDeadline = Date.now() + 30_000;
      while (this.detailInflight > 0 && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    await this.historySaveQueue.flush();

    // Persist final metrics snapshot after active work and async history saves finish.
    await this.persistMetrics();

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
