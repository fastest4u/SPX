import { env } from "../config/env.js";
import { closePool } from "../db/client.js";
import { ApiClient } from "../services/api-client.js";
import { DataProcessor } from "../services/data-processor.js";
import { BookingHistorySaveQueue } from "../services/booking-history-save-queue.js";
import { acceptAndNotifyMatchedRules, sendSessionExpiryNotification, NeedBudget, OWN_ACCEPTED_STATUSES } from "../services/notifier.js";
import { metrics } from "../services/metrics.js";
import { startHttpServer, stopHttpServer } from "../services/http-server.js";
import { getActiveAutoAcceptRules, getAutoAcceptOriginFilters, matchAutoAcceptRuleTripsWithRules } from "../services/notify-rules.js";
import type { NotifyRule } from "../services/notify-rules.js";
import { ensureMetricsTable, insertMetricsSnapshot } from "../repositories/metrics-repository.js";
import { getRecentAutoAcceptRequestKeys } from "../repositories/auto-accept-repository.js";
import {
  logger,
  formatHeader,
  formatFooter,
  formatRequestLine,
  formatStatus,
} from "../utils/logger.js";
import { orderBookingsByOriginHint } from "../utils/booking-priority.js";
import { getSpxDispatcher } from "../utils/http-dispatcher.js";
import { extractAllRequestListTrips, filterTripsByBiddingVehicleType, formatTripInfo } from "../utils/booking-extractor.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";
import { classifyPollingError, formatClassifiedError } from "../utils/error-classifier.js";
import { sseBroadcaster } from "../services/sse.js";
import type { Booking, PollingStats } from "../models/types.js";
import { pollerControl } from "../services/poller-control.js";

/**
 * Non-pending-tab statuses eligible for the one-shot accept attempt: 4 = taken
 * by another agency (the lost-race case this exists for), 1 = still biddable
 * (should not appear on this tab; attempting is the winning move if it does).
 * Statuses in OWN_ACCEPTED_STATUSES are ours and must never be re-attempted —
 * after a restart the in-memory accepted keys are empty, and a re-attempt
 * would fire a false failure alert for a job we already won. Anything else
 * (cancelled/expired?) has unverified semantics: warn for triage, never fire
 * a doomed accept against it.
 */
const NON_PENDING_ATTEMPT_STATUSES = new Set<number>([1, 4]);

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
  /**
   * bookingId → epoch ms when its last detail-processing finished CLEANLY.
   * Used by the re-process cooldown (env.BOOKING_REPROCESS_COOLDOWN_MS) to skip
   * re-fetching the request list of a booking that still lingers in the bidding
   * list, which is the churn an aggressive POLL_INTERVAL_MS otherwise produces.
   * New bookings are never present here, so they are always processed
   * immediately; failed fetches and failed/deferred accepts are NOT stamped, so
   * they retry on the next tick.
   */
  private recentlyProcessed = new Map<number, number>();
  /** Tracks how many detail-fetch tasks are currently in-flight (bounded by BOOKING_DETAIL_CONCURRENCY). */
  private detailInflight = 0;
  private historySaveQueue: BookingHistorySaveQueue;
  private static readonly SESSION_ALERT_THROTTLE_MS = 10 * 60_000; // 10 minutes
  /** Max time stop() waits for the in-flight tick before proceeding with shutdown. */
  private static readonly STOP_TICK_DEADLINE_MS = 30_000;
  private static readonly NON_PENDING_ATTEMPTED_CAP = 5000;
  /** Shared auto-accept budget & rules, refreshed each tick to avoid redundant DB lookups across per-booking tasks. */
  private tickAutoAcceptRules: NotifyRule[] = [];
  /** bookingId:requestId keys from the non-pending tab already attempted, so a lingering taken trip is attempted/alerted once — not on every detail cycle. */
  private nonPendingAttemptedKeys = new Set<string>();
  /** booking_ids already logged by the list-freshness instrumentation (first sight on the bidding list). */
  private seenListBookingIds = new Set<number>();
  private static readonly SEEN_LIST_BOOKINGS_CAP = 20000;
  /** bookingId → consecutive non-clean processing rounds; cleared on clean success. Drives the failure backoff below. */
  private detailFailureCounts = new Map<number, number>();
  private static readonly FAILURE_RETRY_BASE_MS = 1_000;
  private static readonly FAILURE_RETRY_MAX_EXPONENT = 5;
  private static readonly DETAIL_FAILURE_COUNTS_CAP = 1000;
  private tickNeedBudget = new NeedBudget();

  constructor(intervalSec?: number) {
    // Lazy provider: getIntervalMs() prefers the CLI override set below, so
    // the adaptive list-poll math always targets the poller's real cadence.
    this.apiClient = new ApiClient(() => this.getIntervalMs());
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

    // Seed the non-pending one-shot dedupe from history so a restart/deploy
    // does not re-fire doomed accepts + failure LINE alerts for races already
    // recorded (the set itself is process-memory only).
    if (env.AUTO_ACCEPT_ENABLED && env.SAVE_TO_DB) {
      const seededKeys = await getRecentAutoAcceptRequestKeys();
      for (const key of seededKeys) this.addNonPendingAttemptedKey(key);
      if (seededKeys.length > 0) {
        logger.info("auto-accept-nonpending-dedupe-seeded", { keys: seededKeys.length });
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
      const classified = classifyPollingError(result.httpStatus, result.error, result.retcode);
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

    // New tick window for the long-lived budget: availability re-seeds from
    // this tick's rule snapshot minus claims still in flight from earlier
    // ticks (accept flows span ticks; without this each tick re-grants the
    // full need and over-accepts). beginTick runs BEFORE the rules refresh
    // deliberately: a settle landing in between is double-counted for one
    // tick (brief under-grant) — the reverse order would over-grant.
    this.tickNeedBudget.beginTick();

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

    // List-freshness instrumentation (2026-06-11): SPX list rows carry the
    // booking's ctime/mtime, so listAgeMs = how stale the booking already was
    // the first time WE saw it. Discriminates the two lost-race explanations:
    // consistently tiny age (≈ poll interval) → competitors are simply faster;
    // multi-second age under fast polling → our list view lags (cache/
    // propagation) and competitors see jobs before we do.
    const firstSeenNowMs = Date.now();
    for (const booking of sortedBookings) {
      if (this.seenListBookingIds.has(booking.booking_id)) continue;
      this.seenListBookingIds.add(booking.booking_id);
      while (this.seenListBookingIds.size > Poller.SEEN_LIST_BOOKINGS_CAP) {
        const oldest = this.seenListBookingIds.values().next().value;
        if (oldest === undefined) break;
        this.seenListBookingIds.delete(oldest);
      }
      const ctimeMs = typeof booking.ctime === "number" && booking.ctime > 0 ? booking.ctime * 1000 : null;
      const mtimeMs = typeof booking.mtime === "number" && booking.mtime > 0 ? booking.mtime * 1000 : null;
      logger.info("bidding-list-booking-first-seen", {
        bookingId: booking.booking_id,
        bookingName: booking.booking_name,
        ctime: booking.ctime,
        mtime: booking.mtime,
        listAgeMs: ctimeMs === null ? null : firstSeenNowMs - ctimeMs,
        modifiedAgeMs: mtimeMs === null ? null : firstSeenNowMs - mtimeMs,
        acceptanceStatus: booking.request_acceptance_status,
      });
    }

    // Re-process cooldown: prune expired entries up front (or clear the map when
    // disabled) so it never grows unbounded.
    const cooldownMs = env.BOOKING_REPROCESS_COOLDOWN_MS;
    const nowMs = Date.now();
    if (cooldownMs > 0) {
      for (const [id, completedAt] of this.recentlyProcessed) {
        if (nowMs - completedAt >= cooldownMs) this.recentlyProcessed.delete(id);
      }
    } else if (this.recentlyProcessed.size > 0) {
      this.recentlyProcessed.clear();
    }

    let launched = 0;
    let skippedDuplicate = 0;
    let skippedConcurrency = 0;
    let skippedCooldown = 0;

    for (const booking of sortedBookings) {
      // Dedup: skip bookings already being processed
      if (this.activeDetailBookingIds.has(booking.booking_id)) {
        skippedDuplicate++;
        continue;
      }
      // Cooldown: skip bookings we recently finished, to stop re-scanning the same
      // lingering booking every tick. New bookings are never in the map, so they
      // are still processed instantly — this only suppresses redundant re-scans.
      if (cooldownMs > 0) {
        const completedAt = this.recentlyProcessed.get(booking.booking_id);
        if (completedAt !== undefined && nowMs - completedAt < cooldownMs) {
          skippedCooldown++;
          continue;
        }
      }
      // Concurrency guard: bounded by BOOKING_DETAIL_CONCURRENCY
      if (this.detailInflight >= env.BOOKING_DETAIL_CONCURRENCY) {
        // Count all remaining un-iterated bookings
        skippedConcurrency = sortedBookings.length - launched - skippedDuplicate - skippedCooldown;
        break;
      }

      // Reserve slot immediately (synchronous)
      this.activeDetailBookingIds.add(booking.booking_id);
      this.detailInflight++;
      launched++;

      // Fire-and-forget: each booking is independent
      void this.processOneBooking(booking)
        .then((cooldownEligible) => {
          // Clean processing stamps the full cooldown. Non-clean (failed
          // detail fetch, failed/deferred accept) gets an escalating failure
          // backoff instead: retried sooner than the cooldown window, but
          // never hot-looped every tick — a permanently failing booking must
          // not hammer SPX or starve the detail slots.
          if (cooldownEligible) {
            this.detailFailureCounts.delete(booking.booking_id);
            this.recentlyProcessed.set(booking.booking_id, Date.now());
            return;
          }
          const failures = (this.detailFailureCounts.get(booking.booking_id) ?? 0) + 1;
          this.detailFailureCounts.set(booking.booking_id, failures);
          while (this.detailFailureCounts.size > Poller.DETAIL_FAILURE_COUNTS_CAP) {
            const oldest = this.detailFailureCounts.keys().next().value;
            if (oldest === undefined) break;
            this.detailFailureCounts.delete(oldest);
          }
          const cooldownWindowMs = env.BOOKING_REPROCESS_COOLDOWN_MS;
          if (cooldownWindowMs > 0) {
            // Backdated stamp: entry expires after min(cooldown, base·2^(n-1))
            // instead of the full cooldown window.
            const backoffMs = Math.min(
              cooldownWindowMs,
              Poller.FAILURE_RETRY_BASE_MS * 2 ** Math.min(failures - 1, Poller.FAILURE_RETRY_MAX_EXPONENT)
            );
            this.recentlyProcessed.set(booking.booking_id, Date.now() - cooldownWindowMs + backoffMs);
          }
        })
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
        skippedCooldown,
        inflight: this.detailInflight,
        limit: env.BOOKING_DETAIL_CONCURRENCY,
      });
    }

    metrics.recordScheduling({ launched, skippedConcurrency, skippedCooldown });
    this.recordDetailRuntime();
  }

  /**
   * Process a single booking: fetch detail, extract trips, auto-accept, save to DB.
   * Fully independent — no coupling to sibling bookings.
   * Resolves true when processing was clean (cooldown-eligible); false when the
   * detail fetch failed or any accept attempt failed/was deferred, so the
   * booking is retried on the next tick instead of waiting out the cooldown.
   */
  private async processOneBooking(booking: Booking): Promise<boolean> {
    const startedAt = Date.now();
    const context = {
      booking_id: booking.booking_id,
      booking_name: booking.booking_name,
      agency_name: booking.agency_name,
    };

    const autoAcceptEnabled = env.AUTO_ACCEPT_ENABLED && this.tickAutoAcceptRules.length > 0;
    const autoAcceptTasks: Promise<boolean>[] = [];
    let autoAcceptHandledByPage = false;
    let firstMatchRecorded = false;

    const requestList = await this.apiClient.fetchBookingRequestList(booking.booking_id, {
      onPage: autoAcceptEnabled
        ? (page) => {
            const pageTrips = filterTripsByBiddingVehicleType(
              extractAllRequestListTrips(page.data, context),
              env.BIDDING_VEHICLE_TYPE
            ).trips;
            if (pageTrips.length > 0) {
              // Time-to-first-match: request-list page-1 fetch → first accept-eligible
              // trip. This is the on-critical-path detail hop (later pages don't gate
              // the accept thanks to this page-level fast lane).
              if (!firstMatchRecorded) {
                firstMatchRecorded = true;
                metrics.recordOperation("detailToFirstMatch", Date.now() - startedAt);
              }
              autoAcceptHandledByPage = true;
              autoAcceptTasks.push(this.runAutoAcceptForTrips(pageTrips, booking.booking_id));
            }
          }
        : undefined,
    }).finally(() => {
      metrics.recordOperation("detailFetch", Date.now() - startedAt);
    });

    if (!requestList) {
      logger.warn("request-list-missing", { bookingId: booking.booking_id });
      // Still await any page-level auto-accept tasks that may have fired
      if (autoAcceptTasks.length > 0) await Promise.allSettled(autoAcceptTasks);
      return false;
    }

    const extractedTrips = extractAllRequestListTrips(requestList.data, context);
    const { trips, skipped } = filterTripsByBiddingVehicleType(extractedTrips, env.BIDDING_VEHICLE_TYPE);

    // Pending-tab trips take the normal accept path here. Non-pending-tab
    // trips are fetched below for history persistence AND — when they match an
    // enabled rule and are not already ours — get a one-shot accept attempt so
    // a lost race surfaces as a failure alert + history row instead of silence.
    if (autoAcceptEnabled && trips.length > 0 && !autoAcceptHandledByPage) {
      autoAcceptTasks.push(this.runAutoAcceptForTrips(trips, booking.booking_id));
    }

    const historyTrips = new Map<number, ExtractedTripInfo>();
    for (const trip of trips) {
      historyTrips.set(trip.request_id, trip);
    }
    let totalSkipped = skipped;
    const skippedVehicleTypes = new Set(
      extractedTrips
        .filter((trip) => trip.vehicle_type_id !== env.BIDDING_VEHICLE_TYPE)
        .map((trip) => trip.ประเภทรถ)
        .filter(Boolean)
    );

    if (env.SAVE_TO_DB || autoAcceptEnabled) {
      const nonPendingRequestList = await this.apiClient.fetchBookingRequestList(booking.booking_id, {
        tabPendingConfirmation: false,
      });
      if (nonPendingRequestList) {
        const nonPendingExtractedTrips = extractAllRequestListTrips(nonPendingRequestList.data, context);
        const filtered = filterTripsByBiddingVehicleType(nonPendingExtractedTrips, env.BIDDING_VEHICLE_TYPE);
        for (const trip of filtered.trips) {
          historyTrips.set(trip.request_id, trip);
        }
        if (autoAcceptEnabled) {
          const attemptTrips: ExtractedTripInfo[] = [];
          const attemptKeyByRequestId = new Map<number, string>();
          for (const trip of filtered.trips) {
            const status = trip.acceptance_status;
            // Requests that are already ours must never be re-attempted.
            if (status === undefined || OWN_ACCEPTED_STATUSES.has(status)) continue;
            const attemptKey = `${booking.booking_id}:${trip.request_id}`;
            if (!NON_PENDING_ATTEMPT_STATUSES.has(status)) {
              // Unverified terminal state: surface once for triage, no attempt.
              const unknownKey = `${attemptKey}:s${status}`;
              if (this.nonPendingAttemptedKeys.has(unknownKey)) continue;
              const matchedRules = matchAutoAcceptRuleTripsWithRules([trip], this.tickAutoAcceptRules);
              if (matchedRules.length === 0) continue;
              this.addNonPendingAttemptedKey(unknownKey);
              logger.warn("auto-accept-unknown-acceptance-status", {
                bookingId: booking.booking_id,
                requestId: trip.request_id,
                rules: matchedRules.map((m) => m.ruleName),
                route: trip.เส้นทาง,
                acceptanceStatus: status,
              });
              continue;
            }
            if (this.nonPendingAttemptedKeys.has(attemptKey)) continue;
            const matchedRules = matchAutoAcceptRuleTripsWithRules([trip], this.tickAutoAcceptRules);
            if (matchedRules.length === 0) continue;
            this.addNonPendingAttemptedKey(attemptKey);
            logger.warn("auto-accept-rule-match-already-taken", {
              bookingId: booking.booking_id,
              requestId: trip.request_id,
              rules: matchedRules.map((m) => m.ruleName),
              route: trip.เส้นทาง,
              acceptanceStatus: status,
              attempting: true,
              // How old the booking already was when we lost it — the freshness
              // signal that separates "competitor faster" from "we see late".
              bookingAgeMs: typeof booking.ctime === "number" && booking.ctime > 0
                ? Date.now() - booking.ctime * 1000
                : null,
            });
            attemptTrips.push(trip);
            attemptKeyByRequestId.set(trip.request_id, attemptKey);
          }
          if (attemptTrips.length > 0) {
            autoAcceptTasks.push(
              this.runNonPendingAcceptAttempt(attemptTrips, booking.booking_id, attemptKeyByRequestId)
            );
          }
        }
        totalSkipped += filtered.skipped;
        for (const trip of nonPendingExtractedTrips) {
          if (trip.vehicle_type_id !== env.BIDDING_VEHICLE_TYPE && trip.ประเภทรถ) {
            skippedVehicleTypes.add(trip.ประเภทรถ);
          }
        }
      } else {
        logger.warn("request-list-missing", { bookingId: booking.booking_id, tabPendingConfirmation: false });
      }
    }

    if (totalSkipped > 0) {
      logger.warn("booking-detail-vehicle-type-filtered", {
        bookingId: booking.booking_id,
        configuredVehicleType: env.BIDDING_VEHICLE_TYPE,
        kept: historyTrips.size,
        skipped: totalSkipped,
        skippedVehicleTypes: [...skippedVehicleTypes].slice(0, 10),
      });
    }

    // Print to console if running in CLI mode
    if (env.FETCH_DETAILS && !env.HTTP_ENABLED) {
      for (const trip of trips) {
        console.log("\n" + formatTripInfo(trip));
      }
    }

    // Enqueue DB save
    const tripsToSave = [...historyTrips.values()];
    if (env.SAVE_TO_DB && tripsToSave.length > 0) {
      this.historySaveQueue.enqueue(tripsToSave);
    }

    // Wait for all auto-accept tasks to finish before releasing the booking slot
    if (autoAcceptTasks.length > 0) {
      const settled = await Promise.allSettled(autoAcceptTasks);
      return settled.every((task) => task.status === "fulfilled" && task.value === true);
    }
    return true;
  }

  /** FIFO-capped insert into the non-pending one-shot dedupe set. */
  private addNonPendingAttemptedKey(key: string): void {
    this.nonPendingAttemptedKeys.add(key);
    while (this.nonPendingAttemptedKeys.size > Poller.NON_PENDING_ATTEMPTED_CAP) {
      const oldest = this.nonPendingAttemptedKeys.values().next().value;
      if (oldest === undefined) break;
      this.nonPendingAttemptedKeys.delete(oldest);
    }
  }

  /**
   * One-shot accept attempt for rule-matching non-pending-tab trips (operator
   * decision 2026-06-11): a lost race surfaces as the standard failure LINE
   * alert + a "failed" auto_accept_history row instead of silence.
   *
   * Deliberately runs WITHOUT the shared NeedBudget: a doomed claim would
   * starve concurrently-running pending-tab accepts of the same rule for the
   * accept+verify window (or 120s on an indeterminate verify). The overshoot
   * window this opens is negligible — a surprise success still decrements the
   * rule's DB need via the normal progress path.
   *
   * Keys for requests WITHOUT a terminal verified outcome (deferred verify,
   * in-flight claim conflict, thrown error) are un-consumed so the next
   * detail cycle retries; a verified failure or success keeps the key.
   * Always resolves true: a terminal lost race must not dirty the booking
   * round and trigger the failure backoff / next-tick retry.
   */
  private async runNonPendingAcceptAttempt(
    trips: ExtractedTripInfo[],
    bookingId: number,
    attemptKeyByRequestId: Map<number, string>
  ): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const result = await acceptAndNotifyMatchedRules(trips, this.apiClient, {
        autoAcceptRules: this.tickAutoAcceptRules,
        deferSideEffects: true,
      });
      const terminalIds = new Set<number>();
      for (const a of result.accepted) terminalIds.add(a.requestId);
      for (const f of result.failed) for (const id of f.requestIds) terminalIds.add(id);
      for (const [requestId, key] of attemptKeyByRequestId) {
        if (!terminalIds.has(requestId)) this.nonPendingAttemptedKeys.delete(key);
      }
    } catch (err) {
      for (const key of attemptKeyByRequestId.values()) this.nonPendingAttemptedKeys.delete(key);
      logger.error("auto-accept-nonpending-attempt-failed", {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      metrics.recordOperation("autoAccept", Date.now() - startedAt);
    }
    return true;
  }

  /**
   * Run auto-accept for extracted trips, sharing the cross-tick NeedBudget.
   * Resolves true when every attempt completed cleanly (no verified failure,
   * no deferred-unverified outcome, no thrown error).
   */
  private async runAutoAcceptForTrips(trips: ExtractedTripInfo[], bookingId: number): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const result = await acceptAndNotifyMatchedRules(trips, this.apiClient, {
        autoAcceptRules: this.tickAutoAcceptRules,
        deferSideEffects: true,
        needBudget: this.tickNeedBudget,
      });
      return result.failed.length === 0 && result.deferredRequests === 0;
    } catch (err) {
      logger.error("auto-accept-processing-failed", {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
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
      // Bounded: a tick stuck in upstream retries must not eat the shutdown
      // grace budget — its results are superseded by shutdown anyway. Detail
      // jobs it may have launched are covered by the drain below.
      await Promise.race([
        this.activeTick.catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Poller.STOP_TICK_DEADLINE_MS);
          timer.unref();
        }),
      ]);
    }

    // Wait for all in-flight detail tasks to settle
    if (this.activeDetailBookingIds.size > 0) {
      // Poll briefly until all in-flight tasks drain (they are fire-and-forget promises)
      const drainDeadline = Date.now() + 30_000;
      while (this.detailInflight > 0 && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    // Close the keep-alive pool so no sockets linger after the last SPX call.
    // Detail tasks have drained above, so no further upstream requests occur.
    try {
      await getSpxDispatcher().close();
    } catch (err) {
      logger.error("http-dispatcher-close-error", err instanceof Error ? err : new Error(String(err)));
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
