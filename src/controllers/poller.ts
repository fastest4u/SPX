import { env } from "../config/env.js";
import { closePool } from "../db/client.js";
import { ApiClient } from "../services/api-client.js";
import { DataProcessor } from "../services/data-processor.js";
import { BookingHistorySaveQueue } from "../services/booking-history-save-queue.js";
import { acceptAndNotifyMatchedRules, sendSessionExpiryNotification, NeedBudget, OWN_ACCEPTED_STATUSES, type TeamNotificationContext } from "../services/notifier.js";
import { metrics } from "../services/metrics.js";
import { startHttpServer, stopHttpServer } from "../services/http-server.js";
import {
  applyAutoAcceptProgress,
  getActiveAutoAcceptRules,
  getAutoAcceptOriginFilters,
  matchAcceptAllBookingNameRules,
  matchAutoAcceptRuleTripsWithRules,
} from "../services/notify-rules.js";
import type { AcceptAllBookingNameRuleMatch, NotifyRule } from "../services/notify-rules.js";
import { ensureMetricsTable, insertMetricsSnapshot } from "../repositories/metrics-repository.js";
import { getRecentAutoAcceptRequestKeys, insertAutoAcceptHistory } from "../repositories/auto-accept-repository.js";
import {
  logger,
  formatHeader,
  formatFooter,
  formatRequestLine,
  formatStatus,
} from "../utils/logger.js";
import { orderBookingsByOriginHint } from "../utils/booking-priority.js";
import {
  fastLaneReserveForConcurrency,
  partitionBookingsByFastLane,
} from "../utils/booking-fast-lane.js";
import { getSpxDispatcher } from "../utils/http-dispatcher.js";
import { extractAllRequestListTrips, filterTripsByBiddingVehicleType, formatTripInfo } from "../utils/booking-extractor.js";
import type { ExtractedTripInfo } from "../utils/booking-extractor.js";
import { classifyPollingError, formatClassifiedError } from "../utils/error-classifier.js";
import { sseBroadcaster } from "../services/sse.js";
import type { Booking, PollingStats } from "../models/types.js";
import { isTeamPaused } from "../services/poller-control.js";

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

function acceptAllSuccessCount(response: { data?: unknown } | null): number {
  const data = response?.data;
  if (!data || typeof data !== "object") return 1;
  const successCount = (data as Record<string, unknown>).success_count;
  return typeof successCount === "number" && Number.isFinite(successCount) && successCount > 0
    ? Math.floor(successCount)
    : 1;
}

export interface TeamPollerContext {
  teamId: number;
  teamName: string;
  apiClient: ApiClient;
  lineGroupId: string;
  manageHttpServer?: boolean;
  manageProcessSignals?: boolean;
  closeSharedResourcesOnStop?: boolean;
  exitOnStop?: boolean;
}

function collectAutoAcceptMatchedTrips(
  trips: ExtractedTripInfo[],
  rules: NotifyRule[]
): ExtractedTripInfo[] {
  const byRequestId = new Map<number, ExtractedTripInfo>();

  for (const match of matchAutoAcceptRuleTripsWithRules(trips, rules)) {
    for (const trip of match.trips) {
      if (typeof trip.request_id === "number") {
        byRequestId.set(trip.request_id, trip as ExtractedTripInfo);
      }
    }
  }

  return [...byRequestId.values()];
}

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
   * bookingId → epoch ms stamp driving the re-process cooldown
   * (env.BOOKING_REPROCESS_COOLDOWN_MS). New bookings are never present here,
   * so they are always processed immediately. Clean rounds stamp the full
   * cooldown; non-clean rounds (failed fetch, failed/deferred accept, thrown
   * error) get a BACKDATED stamp that expires after min(cooldown, exponential
   * failure backoff 1–32s) — sooner than the full window, never hot-looped.
   * NOTE: all of this only applies when BOOKING_REPROCESS_COOLDOWN_MS > 0; at
   * the default 0 the map is cleared every tick and every listed booking is
   * re-processed each tick (no backoff).
   */
  private recentlyProcessed = new Map<number, number>();
  /** Tracks how many detail-fetch tasks are currently in-flight (bounded by BOOKING_DETAIL_CONCURRENCY). */
  private detailInflight = 0;
  /** Fast-lane tasks may use the full detail limit; recurring work cannot consume the reserved share. */
  private fastLaneDetailInflight = 0;
  private backgroundDetailInflight = 0;
  private historySaveQueue: BookingHistorySaveQueue;
  private readonly teamId: number;
  private readonly teamName: string;
  private readonly notificationContext: TeamNotificationContext;
  private readonly manageHttpServer: boolean;
  private readonly manageProcessSignals: boolean;
  private readonly closeSharedResourcesOnStop: boolean;
  private readonly exitOnStop: boolean;
  private static readonly SESSION_ALERT_THROTTLE_MS = 10 * 60_000; // 10 minutes
  /** Max time stop() waits for the in-flight tick before proceeding with shutdown. */
  private static readonly STOP_TICK_DEADLINE_MS = 30_000;
  private static readonly NON_PENDING_ATTEMPTED_CAP = 5000;
  private static readonly FAST_ACCEPT_ALL_ATTEMPTED_CAP = 5000;
  /** Shared auto-accept budget & rules, refreshed each tick to avoid redundant DB lookups across per-booking tasks. */
  private tickAutoAcceptRules: NotifyRule[] = [];
  /** bookingId:requestId keys from the non-pending tab already attempted, so a lingering taken trip is attempted/alerted once — not on every detail cycle. */
  private nonPendingAttemptedKeys = new Set<string>();
  /** booking_ids already logged by the list-freshness instrumentation (first sight on the bidding list). */
  private seenListBookingIds = new Set<number>();
  /** Newly observed booking IDs keep fast-lane priority until launched or evicted by the safety cap. */
  private pendingFastLaneBookingIds = new Set<number>();
  /** bookingId → last seen status/mtime from bidding list to bypass cooldown on update. */
  private bookingLastStates = new Map<number, { mtime: number; acceptanceStatus: number; assignmentStatus: number }>();
  /** False until the first list pass after startup has silently primed seenListBookingIds. */
  private listFreshnessPrimed = false;
  private static readonly SEEN_LIST_BOOKINGS_CAP = 20000;
  private static readonly PENDING_FAST_LANE_CAP = 20000;
  /** bookingId → consecutive non-clean processing rounds; cleared on clean success. Drives the failure backoff below. */
  private detailFailureCounts = new Map<number, number>();
  private static readonly FAILURE_RETRY_BASE_MS = 1_000;
  private static readonly FAILURE_RETRY_MAX_EXPONENT = 5;
  private static readonly DETAIL_FAILURE_COUNTS_CAP = 1000;
  private tickNeedBudget = new NeedBudget();
  /** ruleId:bookingId keys accepted via booking-list route fast path; there is no request_id before detail fetch. */
  private fastAcceptAllAttemptedKeys = new Set<string>();

  constructor(intervalSec?: number, context?: TeamPollerContext) {
    this.cliIntervalMs = intervalSec !== undefined ? intervalSec * 1000 : null;
    this.teamId = context?.teamId ?? 1;
    this.teamName = context?.teamName ?? "Default Team";
    this.manageHttpServer = context?.manageHttpServer ?? true;
    this.manageProcessSignals = context?.manageProcessSignals ?? true;
    this.closeSharedResourcesOnStop = context?.closeSharedResourcesOnStop ?? true;
    this.exitOnStop = context?.exitOnStop ?? true;
    this.notificationContext = {
      teamId: this.teamId,
      teamName: this.teamName,
      lineGroupId: context?.lineGroupId ?? env.LINE_USER_ID,
    };
    // Lazy provider: getIntervalMs() prefers the CLI override set below, so
    // the adaptive list-poll math always targets the poller's real cadence.
    this.apiClient = context?.apiClient ?? new ApiClient({ pollIntervalMsProvider: () => this.getIntervalMs() });
    this.dataProcessor = new DataProcessor();
    this.historySaveQueue = new BookingHistorySaveQueue({
      teamId: this.teamId,
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

    if (this.manageHttpServer && env.HTTP_ENABLED) {
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
    // recorded (the set itself is process-memory only). Gated on
    // AUTO_ACCEPT_ENABLED alone: history rows are written whenever
    // auto-accept runs (no SAVE_TO_DB gate), AUTO_ACCEPT_ENABLED already
    // requires DB config, and the query degrades to [] on DB failure.
    if (env.AUTO_ACCEPT_ENABLED) {
      const seededKeys = await getRecentAutoAcceptRequestKeys(this.teamId);
      // Repository returns newest-first; insert oldest-first so the FIFO cap
      // evicts stale keys, never the freshest races.
      for (const key of [...seededKeys].reverse()) this.addNonPendingAttemptedKey(key);
      if (seededKeys.length > 0) {
        logger.info("auto-accept-nonpending-dedupe-seeded", { keys: seededKeys.length });
      }
    }

    if (process.stdout.isTTY && !env.HTTP_ENABLED) {
      logger.info("interactive-console-detected", { tty: true });
    }

    void this.run();

    if (this.manageProcessSignals) {
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
  }

  private metricsSnapshot() {
    return metrics.snapshot({ teamId: this.teamId, teamName: this.teamName });
  }

  private async run(): Promise<void> {
    if (this.stopped) {
      return;
    }

    // Measure tick duration so we can subtract it from the interval below (drift compensation).
    const tickStart = Date.now();
    try {
      if (!isTeamPaused(this.teamId)) {
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
        if (isTeamPaused(this.teamId)) {
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
      sseBroadcaster.broadcast({ event: "metrics", teamId: this.teamId, data: this.metricsSnapshot() });
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
      teamId: this.teamId,
      data: this.metricsSnapshot(),
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
   * Fire-and-forget: each booking launches its own independent async task. Fast-lane
   * priority is retained in a bounded ID set, without a work queue or Head-of-Line Blocking.
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
        this.tickAutoAcceptRules = await getActiveAutoAcceptRules(this.teamId);
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
    // The very first pass after a restart primes the set SILENTLY (one
    // aggregate line): per-booking logging there would burst hundreds of
    // synchronous log lines ahead of the first tick's detail launches —
    // delaying the accept path right after a deploy — and every lingering
    // booking would pollute the freshness dataset with restart artifacts.
    const firstSeenNowMs = Date.now();
    let newlyQueuedFastLane = 0;
    if (!this.listFreshnessPrimed) {
      for (const booking of sortedBookings) {
        this.seenListBookingIds.add(booking.booking_id);
      }
      this.listFreshnessPrimed = true;
      logger.info("bidding-list-freshness-primed", { bookings: this.seenListBookingIds.size });
    } else {
      for (const booking of sortedBookings) {
        if (this.seenListBookingIds.has(booking.booking_id)) continue;
        this.seenListBookingIds.add(booking.booking_id);
        this.pendingFastLaneBookingIds.add(booking.booking_id);
        newlyQueuedFastLane++;
        while (this.seenListBookingIds.size > Poller.SEEN_LIST_BOOKINGS_CAP) {
          const oldest = this.seenListBookingIds.values().next().value;
          if (oldest === undefined) break;
          this.seenListBookingIds.delete(oldest);
        }
        while (this.pendingFastLaneBookingIds.size > Poller.PENDING_FAST_LANE_CAP) {
          const oldest = this.pendingFastLaneBookingIds.values().next().value;
          if (oldest === undefined) break;
          this.pendingFastLaneBookingIds.delete(oldest);
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
    }

    // Preserve the existing origin-hint ordering inside each lane, but always
    // schedule newly observed bookings before recurring scans.
    const partitioned = partitionBookingsByFastLane(sortedBookings, this.pendingFastLaneBookingIds);
    const orderedBookings = partitioned.ordered;
    const detailConcurrency = env.BOOKING_DETAIL_CONCURRENCY;
    const fastLaneReserve = fastLaneReserveForConcurrency(detailConcurrency);
    const backgroundConcurrency = Math.max(1, detailConcurrency - fastLaneReserve);

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
    let fastLaneLaunched = 0;
    let fastLaneBlocked = 0;
    let backgroundLaunched = 0;
    let backgroundBlocked = 0;

    for (const booking of orderedBookings) {
      const isFastLane = this.pendingFastLaneBookingIds.has(booking.booking_id);
      // Dedup: skip bookings already being processed
      if (this.activeDetailBookingIds.has(booking.booking_id)) {
        skippedDuplicate++;
        continue;
      }
      // Cooldown: skip bookings we recently finished, to stop re-scanning the same
      // lingering booking every tick. New bookings are never in the map, so they
      // are still processed instantly — this only suppresses redundant re-scans.
      // Bypass cooldown if mtime, request_acceptance_status, or request_assignment_status changed.
      const lastState = this.bookingLastStates.get(booking.booking_id);
      const stateChanged = !lastState ||
        lastState.mtime !== booking.mtime ||
        lastState.acceptanceStatus !== booking.request_acceptance_status ||
        lastState.assignmentStatus !== booking.request_assignment_status;

      if (cooldownMs > 0 && !stateChanged) {
        const completedAt = this.recentlyProcessed.get(booking.booking_id);
        if (completedAt !== undefined && nowMs - completedAt < cooldownMs) {
          skippedCooldown++;
          continue;
        }
      }

      this.bookingLastStates.set(booking.booking_id, {
        mtime: booking.mtime,
        acceptanceStatus: booking.request_acceptance_status,
        assignmentStatus: booking.request_assignment_status,
      });
      while (this.bookingLastStates.size > Poller.SEEN_LIST_BOOKINGS_CAP) {
        const oldest = this.bookingLastStates.keys().next().value;
        if (oldest === undefined) break;
        this.bookingLastStates.delete(oldest);
      }

      // Fast-lane work may use any free slot. Background work has its own
      // lower ceiling so recurring scans can never occupy the reserved share.
      const totalCapacityFull = this.detailInflight >= detailConcurrency;
      const backgroundCapacityFull = !isFastLane && this.backgroundDetailInflight >= backgroundConcurrency;
      if (totalCapacityFull || backgroundCapacityFull) {
        skippedConcurrency++;
        if (isFastLane) fastLaneBlocked++;
        else backgroundBlocked++;
        continue;
      }

      // Reserve slot immediately (synchronous)
      this.activeDetailBookingIds.add(booking.booking_id);
      this.detailInflight++;
      if (isFastLane) {
        this.pendingFastLaneBookingIds.delete(booking.booking_id);
        this.fastLaneDetailInflight++;
        fastLaneLaunched++;
      } else {
        this.backgroundDetailInflight++;
        backgroundLaunched++;
      }
      launched++;

      // Fire-and-forget: each booking is independent
      void this.processOneBooking(booking)
        .then((cooldownEligible) => {
          // Clean processing stamps the full cooldown. Non-clean (failed
          // detail fetch, failed/deferred accept) gets an escalating failure
          // backoff instead — retried sooner than the cooldown window. The
          // backoff only exists when BOOKING_REPROCESS_COOLDOWN_MS > 0; at
          // the default 0 every booking is re-processed each tick anyway.
          if (cooldownEligible) {
            this.detailFailureCounts.delete(booking.booking_id);
            this.recentlyProcessed.set(booking.booking_id, Date.now());
            return;
          }
          this.stampNonCleanRound(booking.booking_id);
        })
        .catch((err) => {
          logger.error("booking-detail-failed", {
            bookingId: booking.booking_id,
            error: err instanceof Error ? err.message : String(err),
          });
          // A thrown round is non-clean too — it must take the same failure
          // backoff, not slip through unstamped and hot-loop the booking.
          this.stampNonCleanRound(booking.booking_id);
        })
        .finally(() => {
          this.activeDetailBookingIds.delete(booking.booking_id);
          this.detailInflight--;
          if (isFastLane) this.fastLaneDetailInflight--;
          else this.backgroundDetailInflight--;
          this.recordDetailRuntime();
        });
    }

    if (newlyQueuedFastLane > 0 || fastLaneLaunched > 0 || fastLaneBlocked > 0) {
      logger.info("booking-fast-lane-scheduled", {
        newlyQueued: newlyQueuedFastLane,
        launched: fastLaneLaunched,
        blocked: fastLaneBlocked,
        pending: this.pendingFastLaneBookingIds.size,
        reserve: fastLaneReserve,
        fastLaneInflight: this.fastLaneDetailInflight,
        backgroundInflight: this.backgroundDetailInflight,
        totalInflight: this.detailInflight,
        limit: detailConcurrency,
      });
    }

    if (skippedConcurrency > 0) {
      logger.warn("booking-detail-concurrency-saturated", {
        launched,
        skippedConcurrency,
        skippedDuplicate,
        skippedCooldown,
        inflight: this.detailInflight,
        limit: detailConcurrency,
        fastLaneLaunched,
        fastLaneBlocked,
        backgroundLaunched,
        backgroundBlocked,
        fastLaneReserve,
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
    let nonPendingFetchOk = true;

    if (autoAcceptEnabled) {
      const fastAcceptAllResult = await this.runFastAcceptAllForBookingName(booking);
      if (fastAcceptAllResult !== null) return fastAcceptAllResult;
    }

    const requestList = await this.apiClient.fetchBookingRequestList(booking.booking_id, {
      onPage: autoAcceptEnabled
        ? (page) => {
            const pageTrips = filterTripsByBiddingVehicleType(
              extractAllRequestListTrips(page.data, context),
              env.BIDDING_VEHICLE_TYPE
            ).trips;
            const matchedPageTrips = collectAutoAcceptMatchedTrips(pageTrips, this.tickAutoAcceptRules);
            if (matchedPageTrips.length > 0) {
              // Time-to-first-match: request-list page-1 fetch → first accept-eligible
              // trip. Accept is scheduled immediately, while remaining pages keep
              // flowing so later matching request_ids can be accepted too.
              if (!firstMatchRecorded) {
                firstMatchRecorded = true;
                metrics.recordOperation("detailToFirstMatch", Date.now() - startedAt);
              }
              autoAcceptHandledByPage = true;
              autoAcceptTasks.push(this.runAutoAcceptForTrips(matchedPageTrips, booking.booking_id));
            }
            return true;
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
      if (autoAcceptTasks.length > 0) {
        // Skip fetching non-pending list if we are in the middle of accepting a pending trip.
        // This prioritizes network bandwidth/sockets for the accept POST call.
        nonPendingFetchOk = true;
      } else {
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
            if (status === undefined) continue;
            const attemptKey = `${booking.booking_id}:${trip.request_id}`;
            if (OWN_ACCEPTED_STATUSES.has(status)) {
              // Own-status trip with NO record of our attempt (not seeded
              // from history, not contested this session): likely an
              // ambiguous-timeout accept that committed server-side without
              // being recorded — a truck may be committed with no history
              // row, no alert, and no need decrement. Surface once for
              // reconciliation; never re-attempt our own request.
              if (this.nonPendingAttemptedKeys.has(attemptKey)) continue;
              const matchedRules = matchAutoAcceptRuleTripsWithRules([trip], this.tickAutoAcceptRules);
              if (matchedRules.length === 0) continue;
              this.addNonPendingAttemptedKey(attemptKey);
              logger.warn("auto-accept-own-status-unreconciled", {
                bookingId: booking.booking_id,
                requestId: trip.request_id,
                rules: matchedRules.map((m) => m.ruleName),
                route: trip.เส้นทาง,
                acceptanceStatus: status,
              });
              continue;
            }
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
        // The fetch feeding history persistence AND the lost-race scan never
        // ran — the round is not clean, retry via the failure backoff.
        nonPendingFetchOk = false;
      }
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
      return nonPendingFetchOk && settled.every((task) => task.status === "fulfilled" && task.value === true);
    }
    return nonPendingFetchOk;
  }

  private async runFastAcceptAllForBookingName(booking: Booking): Promise<boolean | null> {
    const matches = matchAcceptAllBookingNameRules(booking.booking_name, this.tickAutoAcceptRules);
    if (matches.length === 0) return null;

    for (const match of matches) {
      const { granted, token } = this.tickNeedBudget.claim(match.ruleId, match.need, 1);
      if (granted <= 0) {
        logger.info("auto-accept-list-name-budget-empty", {
          bookingId: booking.booking_id,
          ruleId: match.ruleId,
          ruleName: match.ruleName,
        });
        continue;
      }

      const key = `${match.ruleId}:${booking.booking_id}`;
      if (!this.addFastAcceptAllAttemptedKey(key)) {
        this.tickNeedBudget.release(match.ruleId, token, granted);
        continue;
      }

      const startedAt = Date.now();
      try {
        logger.info("auto-accept-list-name-calling", {
          bookingId: booking.booking_id,
          bookingName: booking.booking_name,
          origin: match.origin,
          destination: match.destination,
          ruleId: match.ruleId,
          ruleName: match.ruleName,
          acceptAll: true,
        });

        const result = await this.apiClient.acceptAllBookingRequests(booking.booking_id);
        if (!result.ok) {
          metrics.recordAutoAccept(false);
          this.tickNeedBudget.release(match.ruleId, token, granted);
          this.fastAcceptAllAttemptedKeys.delete(key);
          this.recordFastAcceptAllHistory(booking, match, "failed", 0, result.error);
          logger.error("auto-accept-list-name-failed", {
            bookingId: booking.booking_id,
            ruleId: match.ruleId,
            error: result.error,
            httpStatus: result.httpStatus,
          });
          return false;
        }

        const acceptedCount = acceptAllSuccessCount(result.response);
        for (let i = 0; i < acceptedCount; i++) metrics.recordAutoAccept(true);
        try {
          await applyAutoAcceptProgress(this.teamId, [
            { ruleId: match.ruleId, acceptedCount },
          ], (ruleId, committedCount) => {
            this.tickNeedBudget.settle(ruleId, token, committedCount);
          });
        } catch (err) {
          logger.error("auto-accept-list-name-progress-failed", {
            bookingId: booking.booking_id,
            ruleId: match.ruleId,
            acceptedCount,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.recordFastAcceptAllHistory(booking, match, "success", acceptedCount);
        logger.info("auto-accept-list-name-success", {
          bookingId: booking.booking_id,
          ruleId: match.ruleId,
          acceptedCount,
          httpStatus: result.httpStatus,
        });
        return true;
      } catch (err) {
        metrics.recordAutoAccept(false);
        this.tickNeedBudget.release(match.ruleId, token, granted);
        this.fastAcceptAllAttemptedKeys.delete(key);
        const error = err instanceof Error ? err.message : String(err);
        this.recordFastAcceptAllHistory(booking, match, "failed", 0, error);
        logger.error("auto-accept-list-name-threw", {
          bookingId: booking.booking_id,
          ruleId: match.ruleId,
          error,
        });
        return false;
      } finally {
        metrics.recordOperation("autoAccept", Date.now() - startedAt);
      }
    }

    return true;
  }

  private addFastAcceptAllAttemptedKey(key: string): boolean {
    if (this.fastAcceptAllAttemptedKeys.has(key)) return false;
    this.fastAcceptAllAttemptedKeys.add(key);
    while (this.fastAcceptAllAttemptedKeys.size > Poller.FAST_ACCEPT_ALL_ATTEMPTED_CAP) {
      const oldest = this.fastAcceptAllAttemptedKeys.values().next().value;
      if (oldest === undefined) break;
      this.fastAcceptAllAttemptedKeys.delete(oldest);
    }
    return true;
  }

  private recordFastAcceptAllHistory(
    booking: Booking,
    match: AcceptAllBookingNameRuleMatch,
    status: "success" | "failed",
    acceptedCount: number,
    errorMessage?: string
  ): void {
    void insertAutoAcceptHistory(this.teamId, {
      ruleId: match.ruleId,
      ruleName: match.ruleName,
      bookingId: booking.booking_id,
      requestIds: [],
      acceptedCount,
      origin: match.origin,
      destination: match.destination,
      vehicleType: "",
      status,
      errorMessage,
    }).catch((err) => {
      logger.warn("auto-accept-list-name-history-write-failed", {
        bookingId: booking.booking_id,
        ruleId: match.ruleId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Escalating failure backoff for a non-clean processing round (backdated cooldown stamp). */
  private stampNonCleanRound(bookingId: number): void {
    const failures = (this.detailFailureCounts.get(bookingId) ?? 0) + 1;
    this.detailFailureCounts.set(bookingId, failures);
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
      this.recentlyProcessed.set(bookingId, Date.now() - cooldownWindowMs + backoffMs);
    }
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
   * in-flight claim conflict, thrown error) are un-consumed AND the round is
   * reported non-clean (false) so the failure backoff retries it soon — not
   * after the full re-process cooldown. A fully terminal outcome (every
   * request verified failed/accepted) resolves true: a lost race is final
   * and must not dirty the booking round.
   */
  private async runNonPendingAcceptAttempt(
    trips: ExtractedTripInfo[],
    bookingId: number,
    attemptKeyByRequestId: Map<number, string>
  ): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const result = await acceptAndNotifyMatchedRules(trips, this.apiClient, {
        teamId: this.teamId,
        notificationContext: this.notificationContext,
        autoAcceptRules: this.tickAutoAcceptRules,
        deferSideEffects: true,
      });
      const terminalIds = new Set<number>();
      for (const a of result.accepted) terminalIds.add(a.requestId);
      for (const f of result.failed) for (const id of f.requestIds) terminalIds.add(id);
      let allTerminal = true;
      for (const [requestId, key] of attemptKeyByRequestId) {
        if (!terminalIds.has(requestId)) {
          this.nonPendingAttemptedKeys.delete(key);
          allTerminal = false;
        }
      }
      return allTerminal;
    } catch (err) {
      for (const key of attemptKeyByRequestId.values()) this.nonPendingAttemptedKeys.delete(key);
      logger.error("auto-accept-nonpending-attempt-failed", {
        bookingId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      metrics.recordOperation("autoAccept", Date.now() - startedAt);
    }
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
        teamId: this.teamId,
        notificationContext: this.notificationContext,
        autoAcceptRules: this.tickAutoAcceptRules,
        deferSideEffects: true,
        needBudget: this.tickNeedBudget,
      });
      // Feed terminal outcomes into the non-pending dedupe: a request already
      // contested here (won or verified-lost, alert + history row written)
      // must not get a second doomed POST when it reappears on the
      // non-pending tab next cycle — and a win recorded here keeps the
      // own-status reconcile warn silent.
      for (const a of result.accepted) {
        this.addNonPendingAttemptedKey(`${a.bookingId}:${a.requestId}`);
      }
      for (const f of result.failed) {
        for (const id of f.requestIds) this.addNonPendingAttemptedKey(`${f.bookingId}:${id}`);
      }
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
      if (exitCode !== 0 && this.exitOnStop) process.exit(exitCode);
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

    if (this.closeSharedResourcesOnStop) {
      // Close the keep-alive pool so no sockets linger after the last SPX call.
      // Detail tasks have drained above, so no further upstream requests occur.
      try {
        await getSpxDispatcher().close();
      } catch (err) {
        logger.error("http-dispatcher-close-error", err instanceof Error ? err : new Error(String(err)));
      }
    }

    await this.historySaveQueue.flush();

    // Persist final metrics snapshot after active work and async history saves finish.
    await this.persistMetrics();

    formatFooter(this.stats);

    if (this.closeSharedResourcesOnStop) {
      sseBroadcaster.closeAll();
    }

    if (this.manageHttpServer) {
      try {
        await stopHttpServer();
      } catch (err) {
        logger.error("http-shutdown-error", err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (this.closeSharedResourcesOnStop) {
      try {
        await closePool();
      } catch (err) {
        logger.error("db-shutdown-error", err instanceof Error ? err : new Error(String(err)));
        if (this.exitOnStop) process.exit(1);
      }
    }

    if (this.exitOnStop) process.exit(exitCode);
  }

  private async persistMetrics(): Promise<void> {
    if (!env.SAVE_TO_DB) return;
    try {
      const snap = this.metricsSnapshot();
      await insertMetricsSnapshot(snap, this.teamId);
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
      teamId: this.teamId,
      data: {
        message: errorMessage,
        timestamp: new Date(now).toISOString(),
      },
    });

    try {
      const result = await sendSessionExpiryNotification(errorMessage, this.notificationContext);
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
