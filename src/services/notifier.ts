import { env, type RequestSelectionStrategy } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { metrics } from "./metrics.js";
import { matchRules, getActiveAutoAcceptRules, matchAutoAcceptRuleTripsWithRules, applyAutoAcceptProgress, type NotifyRule, type RuleTripMatch, type TripLike } from "./notify-rules.js";
import { insertAutoAcceptHistory } from "../repositories/auto-accept-repository.js";
import {
  insertAutoAcceptAttempt,
  upsertAutoAcceptResult,
  getOwnedAutoAcceptRequestKeys,
  type AutoAcceptResultStatus,
} from "../repositories/auto-accept-result-repository.js";
import type { ApiClient } from "./api-client.js";
import { isLineBotEnabled, sendMessage as sendLineBotMessage, formatError as lineBotFormatError, LineBotQrRequiredError } from "./line-bot.js";
import { buildAutoAcceptFailureAlertText, buildAutoAcceptTraceId, summarizeAutoAcceptEvidence, type AutoAcceptFailureReason } from "./auto-accept-diagnostics.js";
import type { AutoAcceptVerificationJob, AutoAcceptVerificationOutcome } from "./auto-accept-verifier.js";
import { createWorkerNotificationPublisher, type NotificationPublisher } from "./notification-publisher.js";
import { buildAutoAcceptEventKey } from "./notification-events.js";
import { AutoAcceptVerificationRunner, verificationHoldCount } from "./auto-accept-verification-runner.js";
import { notifyAutoAcceptProgressCommitted } from "./notify-rules.js";
import { listAutoAcceptVerificationJobs } from "../repositories/auto-accept-verification-repository.js";

// Re-export for backward compatibility
export type { LineBotStatus as LineJsQrLoginResult } from "./line-bot.js";
export { requestQrLogin as requestLineJsQrLogin } from "./line-bot.js";

type NotificationChannel = "line" | "discord" | "linejs_test" | "central_notifier";

const NOTIFY_FETCH_TIMEOUT_MS = 10_000;
const LINE_QUOTA_FETCH_TIMEOUT_MS = 5_000;
let workerNotificationPublisher: NotificationPublisher | null = null;

export interface TeamNotificationContext {
  teamId: number;
  teamName: string;
  lineGroupId: string;
  rateLimitNotifyEnabled?: boolean;
}

async function fetchWithTimeout(input: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = NOTIFY_FETCH_TIMEOUT_MS, ...options } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type NotificationSendResult = {
  channel: NotificationChannel;
  ok: boolean;
  error?: string;
  qrUrl?: string;
  pincode?: string;
};

function hasNotificationTarget(context?: TeamNotificationContext): boolean {
  if (context) return Boolean(context.lineGroupId.trim());
  return Boolean(env.LINE_CHANNEL_ACCESS_TOKEN || env.DISCORD_WEBHOOK_URL || isLineBotEnabled());
}

function textValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "-";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

async function sendDiscordNotification(title: string, message: string): Promise<void> {
  const response = await fetchWithTimeout(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title,
        description: truncate(message, 4096),
        color: 0x0ea5e9,
        timestamp: new Date().toISOString(),
      }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
}

async function sendLineOaMessage(title: string, message: string, targetId: string = env.LINE_USER_ID): Promise<void> {
  const body = JSON.stringify({
    to: targetId,
    messages: [{
      type: "text",
      text: title ? `${title}\n${truncate(message, 4500)}` : truncate(message, 4500),
    }],
  });

  const response = await fetchWithTimeout("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`LINE OA push failed with HTTP ${response.status}: ${responseBody.slice(0, 200)}`);
  }
}

function getAutoAcceptSuccessLineJsTarget(): string {
  return env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS || env.LINEJS_TEST_TARGET_ID || env.LINE_USER_ID || "";
}

function getTeamLineTarget(context: TeamNotificationContext | undefined, logPrefix: string): string | null {
  if (!context) return null;
  const target = context.lineGroupId.trim();
  if (!target) {
    logger.warn(`${logPrefix}-line-target-missing`, { teamId: context.teamId, teamName: context.teamName });
  }
  return target;
}

function maskTarget(value: string): string {
  if (!value) return "";
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

async function sendLineJsThenOa(
  title: string,
  message: string,
  options: {
    lineJsTarget?: string;
    lineOaTarget?: string;
    logPrefix: string;
    results?: NotificationSendResult[];
    useGlobalFallback?: boolean;
  }
): Promise<boolean> {
  const text = title ? `${title}\n${message}` : message;
  const useGlobalFallback = options.useGlobalFallback !== false;
  const lineJsTarget = options.lineJsTarget || (useGlobalFallback ? env.LINEJS_TEST_TARGET_ID || env.LINE_USER_ID || "" : "");
  const lineOaTarget = options.lineOaTarget || (useGlobalFallback ? env.LINE_USER_ID : "");

  if (lineJsTarget && isLineBotEnabled()) {
    try {
      const result = await sendLineBotMessage(lineJsTarget, text);
      if (result.ok) {
        logger.info(`${options.logPrefix}-linejs-sent`, { groupMid: maskTarget(lineJsTarget), title });
        options.results?.push({ channel: "linejs_test", ok: true });
        return true;
      }
      logger.warn(`${options.logPrefix}-linejs-failed`, { groupMid: maskTarget(lineJsTarget), title, error: result.error });
      options.results?.push({ channel: "linejs_test", ok: false, error: result.error });
    } catch (error) {
      const errorMessage = lineBotFormatError(error);
      logger.warn(`${options.logPrefix}-linejs-error`, { groupMid: maskTarget(lineJsTarget), title, error: errorMessage });
      const errObj = error as Record<string, unknown>;
      options.results?.push({
        channel: "linejs_test",
        ok: false,
        error: errorMessage,
        qrUrl: error instanceof LineBotQrRequiredError ? error.qrUrl : errObj.qrUrl as string | undefined,
        pincode: error instanceof LineBotQrRequiredError ? error.pincode : errObj.pincode as string | undefined,
      });
    }
  } else {
    logger.warn(`${options.logPrefix}-linejs-skipped`, {
      title,
      targetConfigured: Boolean(lineJsTarget),
      lineBotEnabled: isLineBotEnabled(),
    });
  }

  if (env.LINE_CHANNEL_ACCESS_TOKEN && lineOaTarget) {
    try {
      await sendLineOaMessage(title, message, lineOaTarget);
      logger.info(`${options.logPrefix}-line-oa-sent`, { title });
      options.results?.push({ channel: "line", ok: true });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`${options.logPrefix}-line-oa-failed`, { title, error: errorMessage });
      options.results?.push({ channel: "line", ok: false, error: errorMessage });
    }
  } else {
    logger.warn(`${options.logPrefix}-line-oa-skipped`, {
      title,
      tokenConfigured: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN),
      userConfigured: Boolean(lineOaTarget),
    });
  }

  return false;
}

export async function sendLineTargetMessage(targetId: string, text: string): Promise<{ ok: boolean; providerMessageId?: string; error?: string }> {
  const sent = await sendLineJsThenOa("", text, {
    lineJsTarget: targetId,
    lineOaTarget: targetId,
    logPrefix: "notification-dispatcher",
    useGlobalFallback: false,
  });
  return sent ? { ok: true } : { ok: false, error: "No LINE provider accepted the message" };
}

/** Send auto-accept success to LINEJS first, then fallback to LINE OA. */
async function sendAutoAcceptAlert(title: string, message: string, context?: TeamNotificationContext): Promise<boolean> {
  const teamTarget = getTeamLineTarget(context, "auto-accept-alert");
  if (teamTarget === "") return false;

  return sendLineJsThenOa(title, message, {
    lineJsTarget: teamTarget ?? getAutoAcceptSuccessLineJsTarget(),
    lineOaTarget: teamTarget ?? undefined,
    logPrefix: "auto-accept-alert",
    useGlobalFallback: !context,
  });
}

export async function sendNotificationMessage(
  title: string,
  message: string,
  context?: TeamNotificationContext
): Promise<{ sent: boolean; skipped?: boolean; results: NotificationSendResult[] }> {
  const results: NotificationSendResult[] = [];
  const teamTarget = getTeamLineTarget(context, "notification");
  if (teamTarget === "") {
    return { sent: false, skipped: true, results };
  }

  if (env.DISCORD_WEBHOOK_URL) {
    try {
      await sendDiscordNotification(title, message);
      results.push({ channel: "discord", ok: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("discord-notification-failed", { error: errorMessage });
      results.push({ channel: "discord", ok: false, error: errorMessage });
    }
  }

  await sendLineJsThenOa(title, message, {
    lineJsTarget: teamTarget ?? undefined,
    lineOaTarget: teamTarget ?? undefined,
    logPrefix: "notification",
    results,
    useGlobalFallback: !context,
  });

  return { sent: results.some((result) => result.ok), results };
}

export async function notifyMatchedRules(trips: TripLike[], options?: { dryRun?: boolean; forceTest?: boolean; teamId?: number }) {
  const matches = await matchRules(options?.teamId ?? 1, trips);
  if (options?.dryRun) {
    return { matches, sent: false, dryRun: true };
  }

  return { matches, sent: false, skipped: true, disabled: true };
}

// ── Auto-accept + Notify flow ──────────────────────────────────────────

export interface AcceptedTripNotificationItem {
  trip: TripLike;
  bookingId: number;
  requestId: number;
  traceId?: string;
}

type AcceptedTrip = AcceptedTripNotificationItem;

interface AutoAcceptResult {
  autoAcceptMatches: RuleTripMatch[];
  accepted: AcceptedTrip[];
  failed: Array<{
    bookingId: number;
    requestIds: number[];
    error: string;
    reason?: AutoAcceptFailureReason;
    traceId?: string;
    acceptRttMs?: number;
    listAgeMs?: number;
    pendingTabRead?: boolean;
    confirmedTabRead?: boolean;
    nextAction?: string;
  }>;
  /** Requests whose accept outcome could not be verified (deferred for a later poll to retry). */
  deferredRequests: number;
  /** Requests whose accept POST was submitted and whose verification is running off the hot path. */
  pendingVerification: number;
  notified: boolean;
}

// An aborted/timed-out accept (httpStatus 0) may still commit server-side
// after the client gave up; verifying the tabs immediately would misread
// that late commit as failure (and never decrement the rule's need).
const AMBIGUOUS_ACCEPT_VERIFY_DELAY_MS = 2_500;

// Per-booking throttle for the auto-accept failure alert: history rows and
// metrics still record every failure, but the operator is paged at most once
// per booking per window.
/** "bookingId:sortedRequestIds" → last alert epoch ms (see throttle below). */
const failureAlertLastSentByBooking = new Map<string, number>();
const FAILURE_ALERT_THROTTLE_MS = 60_000;

interface AutoAcceptOptions {
  teamId?: number;
  notificationContext?: TeamNotificationContext;
  deferSideEffects?: boolean;
  needBudget?: NeedBudget;
  autoAcceptRules?: NotifyRule[];
  verificationMode?: "inline" | "detached";
  selectionStrategy?: RequestSelectionStrategy;
  canVerify?: () => boolean | Promise<boolean>;
  onVerifiedTrips?: (trips: TripLike[]) => void | Promise<void>;
  onRetryableBooking?: (ruleId: string, bookingId: number) => void;
}

/**
 * request_acceptance_status values that mean the request is OURS from the
 * poller's skip-perspective: 2 = just accepted (SPX reports 2 immediately
 * after our accept commits), 6 = confirmed/assigned (observed in production
 * history for our accepted bookings). The poller must never re-attempt these.
 * NOTE: the post-accept verify deliberately counts ONLY status 2 as a
 * verified win — whether 6 is ownership-scoped (ours-only) or global
 * (any agency's confirmation) is unproven, and counting an unproven status
 * as success would decrement need for a job we may not own. Skipping (not
 * attempting) on 6 is safe either way.
 */
export const OWN_ACCEPTED_STATUSES = new Set<number>([2, 6]);

/**
 * Opaque handle for a batch of claims. release()/settle() are bounded to the
 * batch behind the token, so a flow that outlives the claim TTL cannot
 * double-credit availability or consume another flow's live claims.
 */
export type ClaimToken = number;

/**
 * Atomic in-memory budget tracker for concurrent auto-accept.
 * Node.js is single-threaded — synchronous Map operations between await
 * points are inherently atomic, so this acts as a lock-free semaphore.
 *
 * The poller keeps ONE long-lived instance and calls beginTick() each tick.
 * Accept flows span multiple ticks at aggressive poll intervals, and the DB
 * `need` decrement only commits after verification — so per-tick availability
 * must be seeded from the tick's DB snapshot MINUS claims still in flight
 * from earlier ticks, or every new tick re-grants the full need and
 * over-accepts beyond the operator's quota.
 *
 * Claim lifecycle: claim() → exactly one of release() (unused selection,
 * verified failure, or deferred-unverified — the slot becomes retryable) or
 * settle() (DB decrement committed). Settled slots keep counting against
 * availability until the next beginTick, because a tick already in flight
 * may hold a rules snapshot read before the commit.
 */
export class NeedBudget {
  private remaining = new Map<string, number>();
  private verificationHolds = new Map<string, Map<string, number>>();
  /** ruleId → token → unresolved claim batch. */
  private inFlight = new Map<string, Map<ClaimToken, { count: number; claimedAt: number }>>();
  /** Claims settled (DB decrement committed) since the last beginTick. */
  private settledSinceTick = new Map<string, number>();
  private nextToken: ClaimToken = 1;

  /**
   * Max age before an unresolved claim batch is presumed leaked (crashed
   * flow) and dropped. Must exceed the worst-case duration of a HEALTHY
   * accept flow, or a live flow gets pruned and its slot double-granted:
   * accept POST (10s timeout) + ambiguous-verify delay (2.5s) + dual-tab
   * verify where each fetch retries up to 4x15s + backoff (~67s/tab under
   * upstream degradation) ≈ 150s+. 300s clears that with headroom while
   * still recovering genuinely leaked slots within minutes.
   */
  private static readonly CLAIM_TTL_MS = 300_000;

  /** Start a new tick: drop settled/expired claims; availability re-seeds lazily per rule. */
  beginTick(now: number = Date.now()): void {
    this.remaining.clear();
    this.settledSinceTick.clear();
    for (const [ruleId, batches] of this.inFlight) {
      for (const [token, batch] of batches) {
        if (now - batch.claimedAt >= NeedBudget.CLAIM_TTL_MS) batches.delete(token);
      }
      if (batches.size === 0) this.inFlight.delete(ruleId);
    }
  }

  /** Atomically claim up to `requested` slots. */
  claim(ruleId: string, dbNeed: number, requested: number): { granted: number; token: ClaimToken } {
    if (!this.remaining.has(ruleId)) {
      this.remaining.set(ruleId, Math.max(0, dbNeed - this.heldCount(ruleId)));
    }
    const available = this.remaining.get(ruleId)!;
    const granted = Math.min(requested, available);
    this.remaining.set(ruleId, available - granted);
    const token = this.nextToken++;
    if (granted > 0) {
      const batches = this.inFlight.get(ruleId) ?? new Map<ClaimToken, { count: number; claimedAt: number }>();
      batches.set(token, { count: granted, claimedAt: Date.now() });
      this.inFlight.set(ruleId, batches);
    }
    return { granted, token };
  }

  /**
   * Return claims to availability: unused selection or verified failure.
   * Bounded by the token's unresolved count — a no-op once TTL-pruned, so TTL
   * expiry is the single terminal authority for a leaked claim.
   */
  release(ruleId: string, token: ClaimToken, count: number): void {
    const dropped = this.drop(ruleId, token, count);
    if (dropped > 0 && this.remaining.has(ruleId)) {
      this.remaining.set(ruleId, this.remaining.get(ruleId)! + dropped);
    }
  }

  /** Mark claims settled after the DB need decrement commits. */
  settle(ruleId: string, token: ClaimToken, count: number): void {
    const dropped = this.drop(ruleId, token, count);
    if (dropped > 0) {
      this.settledSinceTick.set(ruleId, (this.settledSinceTick.get(ruleId) ?? 0) + dropped);
    }
  }

  /** Durable verification has no time-based expiry; only evidence releases it. */
  trackVerification(ruleId: string, traceId: string, count: number): void {
    const holds = this.verificationHolds.get(ruleId) ?? new Map<string, number>();
    const previous = holds.get(traceId) ?? 0;
    if (count > 0) holds.set(traceId, count);
    else holds.delete(traceId);
    if (holds.size > 0) this.verificationHolds.set(ruleId, holds);
    else this.verificationHolds.delete(ruleId);
    if (this.remaining.has(ruleId)) {
      this.remaining.set(ruleId, Math.max(0, this.remaining.get(ruleId)! + previous - count));
    }
  }

  /** Called only after the durable transaction commits, with newly owned IDs. */
  settleVerification(ruleId: string, traceId: string, acceptedCount: number, remainingCount: number): void {
    this.trackVerification(ruleId, traceId, remainingCount);
    if (acceptedCount > 0) {
      this.settledSinceTick.set(ruleId, (this.settledSinceTick.get(ruleId) ?? 0) + acceptedCount);
      if (this.remaining.has(ruleId)) {
        this.remaining.set(ruleId, Math.max(0, this.remaining.get(ruleId)! - acceptedCount));
      }
    }
  }

  private heldCount(ruleId: string): number {
    let held = this.settledSinceTick.get(ruleId) ?? 0;
    for (const count of this.verificationHolds.get(ruleId)?.values() ?? []) held += count;
    const batches = this.inFlight.get(ruleId);
    if (batches) {
      for (const batch of batches.values()) held += batch.count;
    }
    return held;
  }

  private drop(ruleId: string, token: ClaimToken, count: number): number {
    if (count <= 0) return 0;
    const batches = this.inFlight.get(ruleId);
    const batch = batches?.get(token);
    if (!batches || !batch) return 0;
    const dropped = Math.min(count, batch.count);
    batch.count -= dropped;
    if (batch.count === 0) batches.delete(token);
    if (batches.size === 0) this.inFlight.delete(ruleId);
    return dropped;
  }
}

const acceptedRequestKeys = new Set<string>();
const acceptedRequestKeyOrder: string[] = [];
const MAX_ACCEPTED_REQUEST_KEYS = 5000;
const autoAcceptRequestKeys = new Set<string>();
const autoAcceptRequestKeyOrder: string[] = [];
const autoAcceptAllBookingKeys = new Set<string>();
const autoAcceptAllBookingKeyOrder: string[] = [];

function acceptedRequestKey(ruleId: string, requestId: number): string {
  return `${ruleId}:${requestId}`;
}

function rememberAcceptedRequest(ruleId: string, requestId: number): void {
  const key = acceptedRequestKey(ruleId, requestId);
  if (acceptedRequestKeys.has(key)) return;

  acceptedRequestKeys.add(key);
  acceptedRequestKeyOrder.push(key);
  while (acceptedRequestKeyOrder.length > MAX_ACCEPTED_REQUEST_KEYS) {
    const oldest = acceptedRequestKeyOrder.shift();
    if (oldest) acceptedRequestKeys.delete(oldest);
  }
}

function autoAcceptRequestKey(bookingId: number, requestId: number): string {
  return `${bookingId}:${requestId}`;
}

function autoAcceptAllBookingKey(ruleId: string, bookingId: number): string {
  return `${ruleId}:${bookingId}`;
}

function claimAutoAcceptRequest(bookingId: number, requestId: number): boolean {
  const key = autoAcceptRequestKey(bookingId, requestId);
  if (autoAcceptRequestKeys.has(key)) return false;

  autoAcceptRequestKeys.add(key);
  autoAcceptRequestKeyOrder.push(key);
  while (autoAcceptRequestKeyOrder.length > MAX_ACCEPTED_REQUEST_KEYS) {
    const oldest = autoAcceptRequestKeyOrder.shift();
    if (oldest) autoAcceptRequestKeys.delete(oldest);
  }
  return true;
}

function claimAutoAcceptAllBooking(ruleId: string, bookingId: number): boolean {
  const key = autoAcceptAllBookingKey(ruleId, bookingId);
  if (autoAcceptAllBookingKeys.has(key)) return false;

  autoAcceptAllBookingKeys.add(key);
  autoAcceptAllBookingKeyOrder.push(key);
  while (autoAcceptAllBookingKeyOrder.length > MAX_ACCEPTED_REQUEST_KEYS) {
    const oldest = autoAcceptAllBookingKeyOrder.shift();
    if (oldest) autoAcceptAllBookingKeys.delete(oldest);
  }
  return true;
}

function releaseAutoAcceptRequest(bookingId: number, requestId: number): void {
  autoAcceptRequestKeys.delete(autoAcceptRequestKey(bookingId, requestId));
}

function releaseAutoAcceptAllBooking(ruleId: string, bookingId: number): void {
  autoAcceptAllBookingKeys.delete(autoAcceptAllBookingKey(ruleId, bookingId));
}

function runDetached(label: string, promise: Promise<unknown>): void {
  void promise.catch((err) => {
    logger.warn(label, { error: err instanceof Error ? err.message : String(err) });
  });
}

function buildAcceptNotificationMessage(accepted: AcceptedTrip[]): string {
  const now = new Date();
  const thaiDateShort = now.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "2-digit" });
  const timeStr = now.toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false });

  const item = accepted[0];
  const vehicleType = textValue(item.trip["ประเภทรถ"] ?? item.trip.vehicle_type);
  const bookingName = textValue((item.trip as Record<string, unknown>).booking_name);

  const requestLines = accepted.slice(0, 10).map((a, i) => {
    const reqOrigin = textValue(a.trip["ต้นทาง"] ?? a.trip.origin);
    const reqDest = textValue(a.trip["ปลายทาง"] ?? a.trip.destination);
    const reqTime = textValue((a.trip as Record<string, unknown>)["วันที่เวลาสแตนบาย"]);
    return `🛣️ เส้นทาง ที่ ${i + 1} id=${a.requestId} ${reqOrigin} ➜ ${reqDest} (${reqTime})`;
  });

  return [
    ``,
    ...requestLines,
    accepted.length > 10 ? `...และอีก ${accepted.length - 10} รายการ` : "",
    ``,
    `🚛 ประเภทรถ : ${vehicleType}`,
    ``,
    `📝 Booking : ${bookingName}`,
    ``,
    `SPX Bidding Poller•${thaiDateShort} ${timeStr}`,
  ].filter(Boolean).join("\n");
}

export async function sendAutoAcceptSuccessNotification(
  accepted: AcceptedTripNotificationItem[],
  context?: TeamNotificationContext
): Promise<boolean> {
  if (accepted.length === 0) return false;
  const title = `✅ SPX Auto-Accept สำเร็จ ${accepted.length} รายการ`;
  const message = buildAcceptNotificationMessage(accepted);
  return sendAutoAcceptAlert(title, message, context);
}

function getWorkerNotificationPublisher(): NotificationPublisher {
  workerNotificationPublisher ??= createWorkerNotificationPublisher();
  return workerNotificationPublisher;
}

function getWorkerNodeId(): string {
  return env.SPX_NODE_ID || "combined";
}

async function recordAutoAcceptAttemptSafely(input: {
  teamId: number;
  traceId: string;
  workerNodeId: string;
  bookingId: number;
  requestIds: number[];
  ruleId: string;
  ruleName: string;
  acceptAll: boolean;
  acceptStartedAt: number;
  acceptFinishedAt: number;
  result: Awaited<ReturnType<ApiClient["acceptBookingRequests"]>>;
  ambiguousAccept: boolean;
}): Promise<void> {
  try {
    await insertAutoAcceptAttempt({
      traceId: input.traceId,
      teamId: input.teamId,
      workerNodeId: input.workerNodeId,
      bookingId: input.bookingId,
      requestIds: input.requestIds,
      ruleId: input.ruleId,
      ruleName: input.ruleName,
      acceptMode: input.acceptAll ? "accept_all" : "request_ids",
      acceptStartedAt: new Date(input.acceptStartedAt),
      acceptFinishedAt: new Date(input.acceptFinishedAt),
      acceptRttMs: input.acceptFinishedAt - input.acceptStartedAt,
      spxHttpStatus: input.result.httpStatus,
      spxRetcode: input.result.response?.retcode ?? null,
      spxMessage: input.result.response?.message ?? null,
      rawError: input.result.error ?? null,
      ambiguousAccept: input.ambiguousAccept,
    });
  } catch (error) {
    logger.warn("auto-accept-attempt-write-failed", {
      traceId: input.traceId,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestIds: input.requestIds,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordAutoAcceptResultSafely(input: {
  teamId: number;
  bookingId: number;
  requestId: number;
  traceId: string;
  status: AutoAcceptResultStatus;
  reasonCode: string;
  evidence: Record<string, unknown>;
}): Promise<void> {
  try {
    await upsertAutoAcceptResult({
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId: input.requestId,
      winningAttemptTraceId: input.traceId,
      status: input.status,
      reasonCode: input.reasonCode,
      evidence: input.evidence,
    });
  } catch (error) {
    logger.warn("auto-accept-result-write-failed", {
      traceId: input.traceId,
      teamId: input.teamId,
      bookingId: input.bookingId,
      requestId: input.requestId,
      status: input.status,
      reasonCode: input.reasonCode,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function canonicalFailureStatus(reasonCode: string, acceptOk: boolean): AutoAcceptResultStatus {
  if (reasonCode === "verified_lost_race" || reasonCode === "verified_not_owned") return "lost";
  return acceptOk ? "lost" : "failed";
}

function canonicalFailureReasonCode(reason?: AutoAcceptFailureReason, acceptOk = false): string {
  if (reason === "lost_race") return "verified_lost_race";
  if (reason === "verify_not_confirmed") return "verified_not_owned";
  if (reason === "session_expired") return "session_expired";
  if (reason === "accept_api_error") return "accept_api_error";
  return acceptOk ? "verified_not_owned" : "accept_api_error";
}

export function setWorkerNotificationPublisherForTests(publisher: NotificationPublisher | null): void {
  workerNotificationPublisher = publisher;
}

async function publishWorkerAutoAcceptSuccessNotification(
  accepted: AcceptedTripNotificationItem[],
  options: {
    teamId?: number;
    notificationContext?: TeamNotificationContext;
    source: "notifier" | "detached_verification";
    traceId?: string;
    evidence?: Record<string, unknown>;
  },
): Promise<boolean> {
  const context = options.notificationContext;
  const teamId = context?.teamId ?? options.teamId ?? 1;
  const teamName = context?.teamName ?? `Team ${teamId}`;
  const acceptedByBooking = new Map<number, AcceptedTripNotificationItem[]>();

  for (const item of accepted) {
    const items = acceptedByBooking.get(item.bookingId) ?? [];
    items.push(item);
    acceptedByBooking.set(item.bookingId, items);
  }

  let allPublished = acceptedByBooking.size > 0;
  for (const [bookingId, items] of acceptedByBooking) {
    const requestIds = items.map((item) => item.requestId);
    const traceIds = [...new Set([
      ...items.map((item) => item.traceId).filter((traceId): traceId is string => Boolean(traceId)),
      ...(options.traceId ? [options.traceId] : []),
    ])];
    const traceId = traceIds.length === 1 ? traceIds[0] : options.traceId;
    const message = buildAcceptNotificationMessage(items);
    try {
      const result = await getWorkerNotificationPublisher().autoAcceptOwned({
        teamId,
        teamName,
        bookingId,
        requestIds,
        traceId,
        message,
        evidence: {
          requestCount: requestIds.length,
          source: options.source,
          ...(traceIds.length > 1 ? { traceIds } : {}),
          ...options.evidence,
        },
      });
      if (!result.ok) {
        allPublished = false;
        logger.warn("auto-accept-notification-publish-failed", {
          bookingId,
          requestIds,
          teamId,
          traceId: options.traceId,
          error: result.error,
        });
      }
    } catch (error) {
      allPublished = false;
      logger.warn("auto-accept-notification-publish-error", {
        bookingId,
        requestIds,
        teamId,
        traceId: options.traceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return allPublished;
}

async function publishWorkerAutoAcceptFailureNotification(
  failures: AutoAcceptResult["failed"],
  message: string,
  context?: TeamNotificationContext,
): Promise<boolean> {
  if (failures.length === 0) return false;
  const teamId = context?.teamId ?? 1;
  const teamName = context?.teamName ?? `Team ${teamId}`;
  let allPublished = true;

  for (const failure of failures) {
    const requestIds = failure.requestIds.map((requestId) => String(requestId));
    const firstRequestId = requestIds[0] ?? String(failure.bookingId);
    const status = failure.reason === "lost_race" || failure.reason === "verify_not_confirmed" ? "lost" : "failed";
    const result = await getWorkerNotificationPublisher().publish({
      eventKey: buildAutoAcceptEventKey({
        status,
        teamId,
        bookingId: String(failure.bookingId),
        requestId: firstRequestId,
      }),
      event: {
        schemaVersion: 1,
        eventType: "auto_accept_failure",
        severity: "error",
        teamId,
        teamName,
        bookingId: String(failure.bookingId),
        requestIds,
        status,
        reasonCode: failure.reason ?? "accept_api_error",
        traceId: failure.traceId,
        message,
        occurredAt: new Date().toISOString(),
        evidence: {
          error: failure.error,
          acceptRttMs: failure.acceptRttMs,
          listAgeMs: failure.listAgeMs,
          pendingTabRead: failure.pendingTabRead,
          confirmedTabRead: failure.confirmedTabRead,
          nextAction: failure.nextAction,
        },
      },
    });
    if (!result.ok) {
      allPublished = false;
      logger.warn("auto-accept-failure-notification-publish-failed", {
        teamId,
        bookingId: failure.bookingId,
        requestIds,
        traceId: failure.traceId,
        error: result.error,
      });
    }
  }

  return allPublished;
}

async function publishWorkerSessionExpiredNotification(
  errorMessage: string,
  message: string,
  context?: TeamNotificationContext,
): Promise<{ sent: boolean; results: NotificationSendResult[] }> {
  const teamId = context?.teamId ?? 1;
  const teamName = context?.teamName ?? `Team ${teamId}`;
  const result = await getWorkerNotificationPublisher().publish({
    eventKey: `session_expired:team:${teamId}:${Date.now()}`,
    event: {
      schemaVersion: 1,
      eventType: "session_expired",
      severity: "error",
      teamId,
      teamName,
      message,
      occurredAt: new Date().toISOString(),
      evidence: { errorMessage },
    },
  });
  return {
    sent: result.ok,
    results: [{ channel: "central_notifier", ok: result.ok, error: result.error }],
  };
}

export async function routeAutoAcceptSuccessNotification(
  accepted: AcceptedTripNotificationItem[],
  options: {
    teamId?: number;
    notificationContext?: TeamNotificationContext;
    source: "notifier" | "detached_verification";
    traceId?: string;
    evidence?: Record<string, unknown>;
  },
): Promise<boolean> {
  if (accepted.length === 0) return false;
  if (env.SPX_ROLE === "worker") {
    return publishWorkerAutoAcceptSuccessNotification(accepted, options);
  }
  return sendAutoAcceptSuccessNotification(accepted, options.notificationContext);
}

interface AutoAcceptRuleRunResult {
  autoAcceptMatches: RuleTripMatch[];
  accepted: AcceptedTrip[];
  failed: AutoAcceptResult["failed"];
  deferredRequests: number;
  pendingVerification: number;
  acceptedProgress: Array<{ ruleId: string; acceptedCount: number }>;
  historyWrites: Array<() => Promise<unknown>>;
  /** Budget claim batch for this rule's run; used to settle after the DB decrement commits. */
  claimToken: ClaimToken;
}

interface SelectedAutoAcceptRequest {
  trip: TripLike;
  bookingId: number;
  requestId: number;
}

interface AutoAcceptBookingEntry {
  requestIds: Set<number>;
  trips: TripLike[];
  ruleId: string;
  ruleName: string;
}

type RecoveryOptions = Pick<AutoAcceptOptions, "teamId" | "notificationContext" | "needBudget" | "canVerify" | "onVerifiedTrips" | "onRetryableBooking">;
const verificationRunners = new Set<AutoAcceptVerificationRunner>();
const verificationRunnersByClient = new WeakMap<ApiClient, Map<number, AutoAcceptVerificationRunner>>();
const failedPreparationsByClient = new WeakMap<ApiClient, Map<string, {
  job: AutoAcceptVerificationJob;
  options: RecoveryOptions;
}>>();

/** Recheck failed pre-POST writes before admitting more work on this client. */
export async function recoverAutoAcceptPreparations(apiClient: ApiClient, teamId: number): Promise<void> {
  const pending = failedPreparationsByClient.get(apiClient);
  const failures = [...(pending?.values() ?? [])].filter(item => item.job.teamId === teamId);
  if (!pending || failures.length === 0) return;
  let records: Awaited<ReturnType<typeof listAutoAcceptVerificationJobs>>;
  try { records = await listAutoAcceptVerificationJobs(teamId); }
  catch {
    // A lost commit acknowledgement is ambiguous until the database can answer.
    // Keep non-expiring holds and retry this check on the next normal admission.
    return;
  }
  const byTrace = new Map(records.map(record => [record.job.traceId, record]));
  for (const failure of failures) {
    const { job, options } = failure;
    if (pending.get(job.traceId) !== failure) continue;
    const record = byTrace.get(job.traceId);
    if (record) {
      options.needBudget?.trackVerification(job.ruleId, job.traceId, verificationHoldCount(record));
    } else {
      options.needBudget?.trackVerification(job.ruleId, job.traceId, 0);
      for (const requestId of job.requestIds) releaseAutoAcceptRequest(job.bookingId, requestId);
      if (job.acceptAll) {
        releaseAutoAcceptAllBooking(job.ruleId, job.bookingId);
        options.onRetryableBooking?.(job.ruleId, job.bookingId);
      }
    }
    pending.delete(job.traceId);
  }
  if (pending.size === 0) failedPreparationsByClient.delete(apiClient);
}

function emptyAutoAcceptRuleRunResult(): AutoAcceptRuleRunResult {
  return { autoAcceptMatches: [], accepted: [], failed: [], deferredRequests: 0,
    pendingVerification: 0, acceptedProgress: [], historyWrites: [], claimToken: 0 };
}

export function getAutoAcceptVerificationRunner(apiClient: ApiClient, options: RecoveryOptions): AutoAcceptVerificationRunner {
  const teamId = options.teamId ?? 1;
  let runners = verificationRunnersByClient.get(apiClient);
  if (!runners) { runners = new Map(); verificationRunnersByClient.set(apiClient, runners); }
  const existing = runners.get(teamId);
  if (existing) return existing;
  const runner = new AutoAcceptVerificationRunner(teamId, apiClient, {
    canRun: options.canVerify ?? (() => true),
    onHold: record => options.needBudget?.trackVerification(record.job.ruleId, record.job.traceId, verificationHoldCount(record)),
    onSettled: async (record, acceptedIds, failedIds) => {
      options.needBudget?.settleVerification(record.job.ruleId, record.job.traceId, acceptedIds.length, verificationHoldCount(record));
      const newlyFailed = new Set(failedIds);
      const retryable = record.notifications.flatMap(notification => notification.outcome.requests)
        .filter(request => newlyFailed.has(request.requestId) && request.releaseRequestDedupe);
      for (const request of retryable) releaseAutoAcceptRequest(record.job.bookingId, request.requestId);
      if (record.job.acceptAll && retryable.length > 0 && verificationHoldCount(record) === 0) {
        releaseAutoAcceptAllBooking(record.job.ruleId, record.job.bookingId);
        options.onRetryableBooking?.(record.job.ruleId, record.job.bookingId);
      }
      if (record.job.discovery && record.job.requestIds.length === 0 && !record.job.ambiguousAccept
        && !record.job.acceptResult.ok && verificationHoldCount(record) === 0) {
        options.onRetryableBooking?.(record.job.ruleId, record.job.bookingId);
      }
      for (const id of acceptedIds) rememberAcceptedRequest(record.job.ruleId, id);
      for (const _id of acceptedIds) metrics.recordAutoAccept(true);
      for (const _id of failedIds) metrics.recordAutoAccept(false);
      if (acceptedIds.length > 0) {
        await notifyAutoAcceptProgressCommitted(teamId);
      }
    },
    publish: async outcome => {
      const ids = new Set(outcome.acceptedRequestIds);
      // Durable notification replay also retries the idempotent booking-history save.
      if (ids.size > 0) await options.onVerifiedTrips?.(outcome.job.trips.filter(trip => ids.has(Number(trip.request_id))));
      return publishDurableVerificationOutcome(outcome, options.notificationContext);
    },
  });
  runners.set(teamId, runner);
  verificationRunners.add(runner);
  return runner;
}

export async function stopAutoAcceptVerificationRecovery(apiClient: ApiClient, teamId: number): Promise<void> {
  const runner = verificationRunnersByClient.get(apiClient)?.get(teamId);
  if (!runner) return;
  await runner.stop();
  verificationRunners.delete(runner);
  verificationRunnersByClient.get(apiClient)?.delete(teamId);
  const failedPreparations = failedPreparationsByClient.get(apiClient);
  for (const [traceId, failure] of failedPreparations ?? []) {
    if (failure.job.teamId === teamId) failedPreparations?.delete(traceId);
  }
  if (failedPreparations?.size === 0) failedPreparationsByClient.delete(apiClient);
}

export async function awaitAutoAcceptVerificationIdle(timeoutMs = 5_000): Promise<void> {
  await Promise.all([...verificationRunners].map(runner => runner.idle(timeoutMs)));
}

async function publishDurableVerificationOutcome(outcome: AutoAcceptVerificationOutcome, context?: TeamNotificationContext): Promise<boolean> {
  const accepted = acceptedTripsForOutcome(outcome);
  if (accepted.length > 0) {
    if (env.SPX_ROLE !== "worker" && !hasNotificationTarget(context)) return true;
    return routeAutoAcceptSuccessNotification(accepted, {
      teamId: outcome.job.teamId, notificationContext: context, source: "detached_verification",
      traceId: outcome.job.traceId, evidence: { ...outcome.evidence },
    });
  }
  if (outcome.failedRequestIds.length === 0) return true;
  if (env.SPX_ROLE !== "worker" && !hasNotificationTarget(context)) return true;
  const failures: AutoAcceptResult["failed"] = [{
    bookingId: outcome.job.bookingId, requestIds: outcome.failedRequestIds,
    error: summarizeAutoAcceptEvidence(outcome.evidence), reason: outcome.requests[0]?.reason,
    traceId: outcome.job.traceId, acceptRttMs: outcome.job.acceptRttMs,
    pendingTabRead: outcome.evidence.pendingTabRead, confirmedTabRead: outcome.evidence.confirmedTabRead,
  }];
  if (env.SPX_ROLE === "worker") {
    return publishWorkerAutoAcceptFailureNotification(failures, buildAutoAcceptFailureAlertText({
      now: new Date(), failures: failures.map(failure => ({ ...failure, reason: failure.reason ?? "accept_api_error" })),
    }), context);
  }
  await sendDetachedAutoAcceptFailureAlert(failures, context);
  return true;
}

export async function submitDurableAutoAccept(
  apiClient: ApiClient, job: AutoAcceptVerificationJob, options: RecoveryOptions,
): Promise<Awaited<ReturnType<ApiClient["acceptBookingRequests"]>>> {
  const runner = getAutoAcceptVerificationRunner(apiClient, options);
  const reservationCount = job.reservationCount ?? Math.max(job.requestIds.length, 1);
  let persisted = false;
  let created: boolean;
  try {
    created = await runner.prepare(job, () => {
      persisted = true;
      options.needBudget?.release(job.ruleId, job.claimToken, reservationCount);
    });
  } catch (error) {
    if (!persisted) {
      const pending = failedPreparationsByClient.get(apiClient) ?? new Map();
      pending.set(job.traceId, { job, options });
      failedPreparationsByClient.set(apiClient, pending);
      options.needBudget?.release(job.ruleId, job.claimToken, reservationCount);
      options.needBudget?.trackVerification(job.ruleId, job.traceId, reservationCount);
      await recoverAutoAcceptPreparations(apiClient, job.teamId);
    }
    throw error;
  }
  if (!created) return { ok: false, httpStatus: 0, response: null, error: "Verification already pending" };
  let result: Awaited<ReturnType<ApiClient["acceptBookingRequests"]>>;
  try {
    result = job.acceptAll ? await apiClient.acceptAllBookingRequests(job.bookingId)
      : await apiClient.acceptBookingRequests(job.bookingId, job.requestIds);
  } catch {
    // A thrown POST may have committed upstream; recovery only reads its result.
    result = { ok: false, httpStatus: 0, response: null, error: "Accept transport outcome unknown" };
  }
  const acceptFinishedAt = Date.now();
  const data = result.response?.data;
  const successCount = data && typeof data === "object" ? (data as Record<string, unknown>).success_count : undefined;
  const completed = { ...job, acceptFinishedAt, acceptRttMs: acceptFinishedAt - job.acceptStartedAt,
    ...(job.discovery ? { discovery: { ...job.discovery, expectedAcceptedCount:
      typeof successCount === "number" && Number.isInteger(successCount) && successCount > 0
        ? successCount : job.discovery.expectedAcceptedCount } } : {}),
    ambiguousAccept: result.httpStatus === 0,
    acceptResult: { ok: result.ok, httpStatus: result.httpStatus, retcode: result.response?.retcode,
      message: result.response?.message, error: result.error } };
  try { await runner.submitted(completed); }
  catch (error) {
    logger.error("auto-accept-verification-response-save-pending", { teamId: job.teamId, traceId: job.traceId, error: String(error) });
  }
  return result;
}

function firstTripListAgeMs(trips: TripLike[]): number | undefined {
  const value = trips[0]?.listAgeMs;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}

function acceptedTripsForOutcome(outcome: AutoAcceptVerificationOutcome): AcceptedTrip[] {
  const acceptedIds = new Set(outcome.acceptedRequestIds);
  const accepted: AcceptedTrip[] = [];
  for (const trip of outcome.job.trips as TripLike[]) {
    const requestId = typeof trip.request_id === "number" ? trip.request_id : 0;
    if (requestId > 0 && acceptedIds.has(requestId)) {
      accepted.push({ trip, bookingId: outcome.job.bookingId, requestId, traceId: outcome.job.traceId });
    }
  }
  return accepted;
}

async function sendDetachedAutoAcceptFailureAlert(
  failures: AutoAcceptResult["failed"],
  context?: TeamNotificationContext
): Promise<void> {
  const alertNow = Date.now();
  for (const [key, sentAt] of failureAlertLastSentByBooking) {
    if (alertNow - sentAt >= FAILURE_ALERT_THROTTLE_MS) failureAlertLastSentByBooking.delete(key);
  }
  const failureAlertKey = (f: AutoAcceptResult["failed"][number]): string =>
    `${f.bookingId}:${[...f.requestIds].sort((a, b) => a - b).join(",")}`;
  const failedToAlert = failures.filter((f) => !failureAlertLastSentByBooking.has(failureAlertKey(f)));
  if (failedToAlert.length === 0) return;

  const alertKeys = failedToAlert.map(failureAlertKey);
  for (const key of alertKeys) failureAlertLastSentByBooking.set(key, alertNow);

  const teamTarget = getTeamLineTarget(context, "auto-accept-failure-alert");
  const failGroupMid = teamTarget ?? (env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || env.LINEJS_TEST_TARGET_ID || env.LINE_USER_ID || "");
  const failAlertText = buildAutoAcceptFailureAlertText({
    now: new Date(alertNow),
    failures: failedToAlert.map((failure) => ({
      bookingId: failure.bookingId,
      requestIds: failure.requestIds,
      reason: failure.reason ?? "accept_api_error",
      error: failure.error,
      traceId: failure.traceId,
      acceptRttMs: failure.acceptRttMs,
      listAgeMs: failure.listAgeMs,
      pendingTabRead: failure.pendingTabRead,
      confirmedTabRead: failure.confirmedTabRead,
      nextAction: failure.nextAction,
    })),
  });

  if (env.SPX_ROLE === "worker") {
    const published = await publishWorkerAutoAcceptFailureNotification(failedToAlert, failAlertText, context);
    if (!published) {
      for (const key of alertKeys) failureAlertLastSentByBooking.delete(key);
    }
    return;
  }

  if (teamTarget === "") return;

  try {
    const sent = await sendLineJsThenOa("SPX Auto-Accept ล้มเหลว", failAlertText, {
      lineJsTarget: failGroupMid,
      lineOaTarget: teamTarget ?? undefined,
      logPrefix: "auto-accept-failure-alert",
      useGlobalFallback: !context,
    });
    if (!sent) {
      for (const key of alertKeys) failureAlertLastSentByBooking.delete(key);
    }
  } catch (err) {
    for (const key of alertKeys) failureAlertLastSentByBooking.delete(key);
    throw err;
  }
}

export function applyRequestSelectionStrategy<T>(items: T[], strategy: RequestSelectionStrategy = "random"): T[] {
  if (items.length <= 1) return items;
  if (strategy === "last") {
    return items.reverse();
  }
  if (strategy === "random") {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = items[i]!;
      items[i] = items[j]!;
      items[j] = temp;
    }
    return items;
  }
  return items;
}

function selectAutoAcceptRequests(
  match: RuleTripMatch,
  options: AutoAcceptOptions,
  runner?: AutoAcceptVerificationRunner,
  ownedKeys: Set<string> = new Set(),
): { selected: SelectedAutoAcceptRequest[]; claimToken: ClaimToken; reservationCount: number } {
  const candidates: SelectedAutoAcceptRequest[] = [];

  for (const trip of match.trips) {
    const requestId = typeof trip.request_id === "number" ? trip.request_id : undefined;
    const bookingId = typeof trip.booking_id === "number" ? trip.booking_id : undefined;

    if (bookingId === undefined || requestId === undefined) {
      logger.warn("auto-accept-skip-trip", { reason: "missing booking_id or request_id", trip });
      continue;
    }

    if (acceptedRequestKeys.has(acceptedRequestKey(match.ruleId, requestId))) continue;
    if (ownedKeys.has(`${bookingId}:${requestId}`)) continue;
    if (runner?.hasPending(bookingId, requestId)) continue;
    candidates.push({ trip, bookingId, requestId });
  }

  const strategy = options.selectionStrategy ?? env.REQUEST_SELECTION_STRATEGY;
  applyRequestSelectionStrategy(candidates, strategy);

  const reserveWholeRule = Boolean(runner && match.acceptAll);
  const { granted: limit, token: claimToken } = options.needBudget
    ? options.needBudget.claim(match.ruleId, match.need, reserveWholeRule ? match.need : candidates.length)
    : { granted: Math.max(0, match.need), token: 0 };
  const selected: SelectedAutoAcceptRequest[] = [];
  const selectedAcceptAllBookings = new Set<number>();

  for (const candidate of candidates) {
    if (selected.length >= Math.min(limit, reserveWholeRule ? 1 : limit)) break;
    if (match.acceptAll) {
      if (selectedAcceptAllBookings.has(candidate.bookingId)) continue;
      if (!claimAutoAcceptAllBooking(match.ruleId, candidate.bookingId)) continue;
      selectedAcceptAllBookings.add(candidate.bookingId);
    }
    if (claimAutoAcceptRequest(candidate.bookingId, candidate.requestId)) {
      selected.push(candidate);
    } else if (match.acceptAll) {
      releaseAutoAcceptAllBooking(match.ruleId, candidate.bookingId);
      selectedAcceptAllBookings.delete(candidate.bookingId);
    }
  }

  const reservationCount = reserveWholeRule && selected.length > 0 ? limit : selected.length;
  options.needBudget?.release(match.ruleId, claimToken, limit - reservationCount);

  if (match.trips.length > selected.length) {
    logger.info("auto-accept-truncated", {
      ruleId: match.ruleId,
      ruleName: match.ruleName,
      matchedCount: match.matchedCount,
      selectedCount: selected.length,
      limit,
      selectionStrategy: strategy,
    });
  }

  return { selected, claimToken, reservationCount };
}

async function acceptAutoAcceptMatch(
  match: RuleTripMatch,
  apiClient: ApiClient,
  options: AutoAcceptOptions
): Promise<AutoAcceptRuleRunResult> {
  const strategy = options.selectionStrategy ?? env.REQUEST_SELECTION_STRATEGY;
  logger.info("auto-accept-rule-matched", {
    ruleId: match.ruleId,
    ruleName: match.ruleName,
    matchedCount: match.matchedCount,
    acceptAll: match.acceptAll,
    selectionStrategy: strategy,
  });

  const runner = options.verificationMode === "detached" ? getAutoAcceptVerificationRunner(apiClient, options) : undefined;
  await runner?.restore();
  if (runner) await recoverAutoAcceptPreparations(apiClient, options.teamId ?? 1);
  const ownedKeys = runner ? await getOwnedAutoAcceptRequestKeys(options.teamId ?? 1,
    match.trips.map(trip => Number(trip.booking_id)).filter(Number.isSafeInteger),
    match.trips.map(trip => Number(trip.request_id)).filter(Number.isSafeInteger)) : new Set<string>();
  const { selected, claimToken, reservationCount } = selectAutoAcceptRequests(match, options, runner, ownedKeys);
  if (selected.length === 0) {
    return { ...emptyAutoAcceptRuleRunResult(), autoAcceptMatches: [match], claimToken };
  }

  const byBooking = new Map<number, AutoAcceptBookingEntry>();
  for (const { trip, bookingId, requestId } of selected) {
    let entry = byBooking.get(bookingId);
    if (!entry) {
      entry = { requestIds: new Set(), trips: [], ruleId: match.ruleId, ruleName: match.ruleName };
      byBooking.set(bookingId, entry);
    }
    entry.requestIds.add(requestId);
    entry.trips.push(trip);
  }

  const accepted: AcceptedTrip[] = [];
  const failed: AutoAcceptResult["failed"] = [];
  let deferredRequests = 0;
  let pendingVerification = 0;
  const acceptedProgress: Array<{ ruleId: string; acceptedCount: number }> = [];
  const historyWrites: Array<() => Promise<unknown>> = [];

  const acceptResults = await Promise.all([...byBooking].map(async ([bookingId, entry]) => {
    const requestIds = [...entry.requestIds];

    logger.info("auto-accept-calling", { bookingId, requestIds, ruleId: match.ruleId, ruleName: match.ruleName, acceptAll: match.acceptAll });

    const acceptStartedAt = Date.now();
    const teamId = options.teamId ?? 1;
    const traceId = buildAutoAcceptTraceId({ teamId, bookingId, requestIds, acceptStartedAt });
    const intent: AutoAcceptVerificationJob = {
      teamId, ruleId: entry.ruleId, ruleName: entry.ruleName, bookingId, requestIds,
      trips: entry.trips, claimToken, acceptResult: { ok: false, httpStatus: 0 },
      reservationCount: match.acceptAll ? reservationCount : requestIds.length,
      acceptStartedAt, acceptFinishedAt: acceptStartedAt, acceptRttMs: 0,
      ambiguousAccept: true, acceptAll: match.acceptAll, traceId,
      listAgeMs: firstTripListAgeMs(entry.trips),
      ...(match.acceptAll ? { discovery: { bookingName: "", expectedAcceptedCount: requestIds.length } } : {}),
    };
    const result = options.verificationMode === "detached"
      ? await submitDurableAutoAccept(apiClient, intent, options)
      : match.acceptAll ? await apiClient.acceptAllBookingRequests(bookingId)
        : await apiClient.acceptBookingRequests(bookingId, requestIds);
    const acceptFinishedAt = Date.now();
    const ambiguousAccept = result.httpStatus === 0;

    await recordAutoAcceptAttemptSafely({
      teamId,
      traceId,
      workerNodeId: getWorkerNodeId(),
      bookingId,
      requestIds,
      ruleId: entry.ruleId,
      ruleName: entry.ruleName,
      acceptAll: match.acceptAll,
      acceptStartedAt,
      acceptFinishedAt,
      result,
      ambiguousAccept,
    });

    if (options.verificationMode === "detached") {
      return {
        bookingId,
        entry,
        requestIds,
        result,
        verifiedAcceptedIds: [],
        verifiedFailedIds: [],
        deferredIds: [],
        verificationRan: false,
        canonicalFailureFactsAllowed: false,
        detachedQueued: true,
        detachedAcceptClean: result.ok,
        traceId,
        acceptRttMs: acceptFinishedAt - acceptStartedAt,
      };
    }

    // Verify the actual status of each request so we report and notify based on
    // what really happened rather than the raw retcode. SPX can return retcode=0
    // while the request later appears as status=4 ("Other agency accept first"),
    // and error responses may still partially accept a batched request.
    let verifiedAcceptedIds: number[] = [];
    let verifiedFailedIds: number[] = [];
    let deferredIds: number[] = [];
    // Whether verification actually ran and produced a usable answer. This is
    // only true once at least one tab fetch returns data; a transient double
    // fetch failure leaves it false so we defer instead of asserting failure.
    let verificationRan = false;
    let canonicalFailureFactsAllowed = false;

    // OPTIMIZATION: If there is only 1 request in the batch and we got a clear,
    // non-ambiguous error response from the server (not a network timeout/abort),
    // there is no possibility of partial success. We can skip the expensive
    // verification double-fetch (2 API calls). Successful retcode=0 responses
    // still verify because they are not a reliable source of ownership.
    const canSkipVerify = !result.ok && requestIds.length === 1 && !ambiguousAccept;

    if (canSkipVerify) {
      verifiedFailedIds = requestIds;
      verificationRan = true;
      logger.info("auto-accept-verify-skipped", {
        bookingId,
        requestId: requestIds[0],
        reason: "single-request-clear-failure",
        error: result.error,
      });
    } else {
      try {
        if (ambiguousAccept) {
          // Ambiguous delivery (abort/network): the accept may still commit
          // server-side after the client gave up — give SPX a moment before
          // reading the tabs so a late commit is not misread as failure.
          // Deliberate tradeoff: this sleep holds the booking's bounded detail
          // slot for 2.5s; correctness of the money path outranks slot churn.
          await new Promise((resolve) => setTimeout(resolve, AMBIGUOUS_ACCEPT_VERIFY_DELAY_MS));
        }
        // Verify against BOTH tabs because SPX moves accepted requests out of the
        // "pending confirmation" tab into the "confirmed" tab. Fetching only the
        // pending tab (the default) misses requests we just accepted, causing
        // false success/failure reports depending on the raw accept response.
        const [pendingList, confirmedList] = await Promise.all([
          apiClient.fetchBookingRequestList(bookingId, { tabPendingConfirmation: true }),
          apiClient.fetchBookingRequestList(bookingId, { tabPendingConfirmation: false }),
        ]);
        const merged = new Map<number, number>();
        for (const list of [pendingList, confirmedList]) {
          if (!list) continue;
          for (const r of list.data.request_list) {
            const prev = merged.get(r.request_id);
            // Prefer the highest-progress status (accepted=2 wins over waiting=1)
            if (prev === undefined || r.request_acceptance_status > prev) {
              merged.set(r.request_id, r.request_acceptance_status);
            }
          }
        }
        if (pendingList || confirmedList) {
          // At least one tab fetch succeeded — verification actually ran.
          verificationRan = true;
          canonicalFailureFactsAllowed = true;
          // ONLY status 2 proves OUR accept landed. Status 6 is deliberately
          // NOT counted: its ownership scope is unproven (see
          // OWN_ACCEPTED_STATUSES), and a false win here would decrement need
          // and notify success for a job another agency may own.
          const acceptedSet = new Set(
            [...merged.entries()]
              .filter(([, status]) => status === 2)
              .map(([requestId]) => requestId)
          );
          verifiedAcceptedIds = requestIds.filter((id) => acceptedSet.has(id));
          verifiedFailedIds = requestIds.filter((id) => !acceptedSet.has(id));
          if (verifiedFailedIds.length > 0 && !result.error) {
            result.error = "Accept response was not confirmed by SPX request-list status";
          }
          if (ambiguousAccept && verifiedFailedIds.length > 0) {
            deferredIds = verifiedFailedIds;
            verifiedFailedIds = [];
          }
          if (verifiedAcceptedIds.length > 0) {
            logger.info("auto-accept-partial-verified", {
              bookingId,
              acceptedIds: verifiedAcceptedIds,
              failedIds: verifiedFailedIds,
              deferredIds,
              ruleId: entry.ruleId,
              originalError: result.error,
            });
          }
          if (ambiguousAccept && deferredIds.length > 0) {
            // A timed-out/network-failed accept can still commit after this
            // verify window. If we already received tab data but did not see
            // status=2 yet, defer instead of declaring failure and releasing
            // quota; a false failure alert is worse than holding the claim
            // until the NeedBudget TTL.
            if (verifiedAcceptedIds.length === 0) verificationRan = false;
            logger.warn("auto-accept-ambiguous-unverified-deferred", {
              bookingId,
              requestIds: deferredIds,
              ruleId: entry.ruleId,
              originalError: result.error,
            });
          }
        } else {
          // Both tab fetches returned null/empty — verification could NOT run
          // (transient double failure). This is indeterminate, NOT a confirmed
          // failure, so defer: do not assert failure and do not fire the
          // false-failure notification. Leave both verified lists empty and
          // mark verification as not-run so the consumer skips the batch.
          verificationRan = false;
          logger.warn("auto-accept-verify-indeterminate", {
            bookingId,
            requestIds,
            ruleId: entry.ruleId,
            originalError: result.error,
          });
          verifiedAcceptedIds = [];
          verifiedFailedIds = [];
        }
      } catch (verifyErr) {
        // The verification fetch itself threw — verification could not run, so
        // defer rather than falsely asserting failure for the whole batch.
        verificationRan = false;
        verifiedAcceptedIds = [];
        verifiedFailedIds = [];
        logger.warn("auto-accept-verify-failed", {
          bookingId,
          ruleId: entry.ruleId,
          error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        });
      }
    }

    return {
      bookingId,
      entry,
      requestIds,
      result,
      verifiedAcceptedIds,
      verifiedFailedIds,
      deferredIds,
      verificationRan,
      canonicalFailureFactsAllowed,
      detachedQueued: false,
      detachedAcceptClean: true,
      traceId,
      acceptRttMs: acceptFinishedAt - acceptStartedAt,
    };
  }));

  for (const { bookingId, entry, requestIds, result, verifiedAcceptedIds, verifiedFailedIds, deferredIds, verificationRan, canonicalFailureFactsAllowed, detachedQueued, detachedAcceptClean, traceId, acceptRttMs } of acceptResults) {
    if (detachedQueued) {
      pendingVerification += requestIds.length;
      if (!detachedAcceptClean) deferredRequests += requestIds.length;
      continue;
    }

    if (verifiedAcceptedIds.length > 0) {
      const logLevel = result.ok ? "auto-accept-success" : "auto-accept-partial-success";
      logger.info(logLevel, { bookingId, requestIds: verifiedAcceptedIds, ruleId: entry.ruleId, httpStatus: result.httpStatus });
      for (const trip of entry.trips) {
        const requestId = typeof trip.request_id === "number" ? trip.request_id : 0;
        if (requestId > 0 && verifiedAcceptedIds.includes(requestId)) {
          accepted.push({ trip, bookingId, requestId, traceId });
          rememberAcceptedRequest(entry.ruleId, requestId);
        }
      }
      acceptedProgress.push({ ruleId: entry.ruleId, acceptedCount: verifiedAcceptedIds.length });
      for (const requestId of verifiedAcceptedIds) {
        await recordAutoAcceptResultSafely({
          teamId: options.teamId ?? 1,
          bookingId,
          requestId,
          traceId,
          status: "owned",
          reasonCode: "verified_owned",
          evidence: {
            source: "notifier_inline_verify",
            acceptRttMs,
            httpStatus: result.httpStatus,
            retcode: result.response?.retcode,
            message: result.response?.message,
            acceptAll: match.acceptAll,
          },
        });
      }
      historyWrites.push(() => insertAutoAcceptHistory(options.teamId ?? 1, {
        ruleId: entry.ruleId,
        ruleName: entry.ruleName,
        bookingId,
        requestIds: verifiedAcceptedIds,
        acceptedCount: verifiedAcceptedIds.length,
        origin: textValue(entry.trips[0]?.origin ?? entry.trips[0]?.["ต้นทาง"]),
        destination: textValue(entry.trips[0]?.destination ?? entry.trips[0]?.["ปลายทาง"]),
        vehicleType: textValue(entry.trips[0]?.vehicle_type ?? entry.trips[0]?.["ประเภทรถ"]),
        status: "success",
        traceId,
        acceptRttMs,
        verificationStatus: "verified_success",
        verifiedAt: new Date(),
      }));
    }

    if (verifiedFailedIds.length > 0) {
      for (const requestId of verifiedFailedIds) {
        releaseAutoAcceptRequest(bookingId, requestId);
      }
      if (match.acceptAll) releaseAutoAcceptAllBooking(entry.ruleId, bookingId);
      options.needBudget?.release(entry.ruleId, claimToken, verifiedFailedIds.length);
      logger.error("auto-accept-failed", { bookingId, requestIds: verifiedFailedIds, ruleId: entry.ruleId, error: result.error, httpStatus: result.httpStatus });
      failed.push({ bookingId, requestIds: verifiedFailedIds, error: result.error || "Unknown error" });
      const reasonCode = canonicalFailureReasonCode(undefined, result.ok);
      const status = canonicalFailureStatus(reasonCode, result.ok);
      if (canonicalFailureFactsAllowed) {
        for (const requestId of verifiedFailedIds) {
          await recordAutoAcceptResultSafely({
            teamId: options.teamId ?? 1,
            bookingId,
            requestId,
            traceId,
            status,
            reasonCode,
            evidence: {
              source: "notifier_inline_verify",
              acceptRttMs,
              httpStatus: result.httpStatus,
              retcode: result.response?.retcode,
              message: result.response?.message,
              error: result.error,
              acceptAll: match.acceptAll,
            },
          });
        }
      }
      historyWrites.push(() => insertAutoAcceptHistory(options.teamId ?? 1, {
        ruleId: entry.ruleId,
        ruleName: entry.ruleName,
        bookingId,
        requestIds: verifiedFailedIds,
        acceptedCount: 0,
        origin: textValue(entry.trips[0]?.origin ?? entry.trips[0]?.["ต้นทาง"]),
        destination: textValue(entry.trips[0]?.destination ?? entry.trips[0]?.["ปลายทาง"]),
        vehicleType: textValue(entry.trips[0]?.vehicle_type ?? entry.trips[0]?.["ประเภทรถ"]),
        status: "failed",
        errorMessage: result.error,
        traceId,
        acceptRttMs,
        verificationStatus: "verified_failed",
        verifiedAt: new Date(),
      }));
    }

    if (deferredIds.length > 0) {
      for (const requestId of deferredIds) {
        releaseAutoAcceptRequest(bookingId, requestId);
      }
      if (match.acceptAll) releaseAutoAcceptAllBooking(entry.ruleId, bookingId);
      deferredRequests += deferredIds.length;
      logger.warn("auto-accept-deferred-unverified", { bookingId, requestIds: deferredIds, ruleId: entry.ruleId, error: result.error, httpStatus: result.httpStatus });
    }

    if (verificationRan && verifiedAcceptedIds.length === 0 && verifiedFailedIds.length === 0 && deferredIds.length === 0) {
      // Verification actually ran and confirmed the requests are absent —
      // treat the original batch as fully failed.
      for (const requestId of requestIds) {
        releaseAutoAcceptRequest(bookingId, requestId);
      }
      if (match.acceptAll) releaseAutoAcceptAllBooking(entry.ruleId, bookingId);
      options.needBudget?.release(entry.ruleId, claimToken, requestIds.length);
      logger.error("auto-accept-failed", { bookingId, requestIds, ruleId: entry.ruleId, error: result.error, httpStatus: result.httpStatus });
      failed.push({ bookingId, requestIds, error: result.error || "Unknown error" });
      const reasonCode = canonicalFailureReasonCode(undefined, result.ok);
      const status = canonicalFailureStatus(reasonCode, result.ok);
      if (canonicalFailureFactsAllowed) {
        for (const requestId of requestIds) {
          await recordAutoAcceptResultSafely({
            teamId: options.teamId ?? 1,
            bookingId,
            requestId,
            traceId,
            status,
            reasonCode,
            evidence: {
              source: "notifier_inline_verify_absent",
              acceptRttMs,
              httpStatus: result.httpStatus,
              retcode: result.response?.retcode,
              message: result.response?.message,
              error: result.error,
              acceptAll: match.acceptAll,
            },
          });
        }
      }
      historyWrites.push(() => insertAutoAcceptHistory(options.teamId ?? 1, {
        ruleId: entry.ruleId,
        ruleName: entry.ruleName,
        bookingId,
        requestIds,
        acceptedCount: 0,
        origin: textValue(entry.trips[0]?.origin ?? entry.trips[0]?.["ต้นทาง"]),
        destination: textValue(entry.trips[0]?.destination ?? entry.trips[0]?.["ปลายทาง"]),
        vehicleType: textValue(entry.trips[0]?.vehicle_type ?? entry.trips[0]?.["ประเภทรถ"]),
        status: "failed",
        errorMessage: result.error,
        traceId,
        acceptRttMs,
        verificationStatus: "verified_failed",
        verifiedAt: new Date(),
      }));
    } else if (!verificationRan && verifiedAcceptedIds.length === 0 && verifiedFailedIds.length === 0 && deferredIds.length === 0) {
      // Verification could not run (transient double fetch failure or fetch
      // threw). Defer: release the claimed request keys so a later poll can
      // retry, but do NOT assert failure or fire the false-failure alert.
      // The budget claim is deliberately NOT released: the accept may have
      // committed server-side (the request would leave the pending tab and
      // never be reconciled), so holding the slot until the claim TTL biases
      // toward under-accepting instead of overshooting the operator's quota.
      for (const requestId of requestIds) {
        releaseAutoAcceptRequest(bookingId, requestId);
      }
      if (match.acceptAll) releaseAutoAcceptAllBooking(entry.ruleId, bookingId);
      deferredRequests += requestIds.length;
      logger.warn("auto-accept-deferred-unverified", { bookingId, requestIds, ruleId: entry.ruleId, error: result.error, httpStatus: result.httpStatus });
    }
  }

  return {
    autoAcceptMatches: [match],
    accepted,
    failed,
    deferredRequests,
    pendingVerification,
    acceptedProgress,
    historyWrites,
    claimToken,
  };
}

/**
 * Auto-accept matched rules then notify on success.
 * Flow: Match auto_accept rules → call Accept API → notify only if accept succeeded.
 */
export async function acceptAndNotifyMatchedRules(
  trips: TripLike[],
  apiClient: ApiClient,
  options: AutoAcceptOptions = {}
): Promise<AutoAcceptResult> {
  const teamId = options.teamId ?? 1;
  const autoAcceptRules = options.autoAcceptRules ?? await getActiveAutoAcceptRules(teamId);
  // Match every rule in a single pass so trips are NFKC-normalized once per
  // call (not once per rule), then fan out the API accepts in parallel.
  const matches = matchAutoAcceptRuleTripsWithRules(trips, autoAcceptRules);

  if (matches.length === 0) {
    return { autoAcceptMatches: [], accepted: [], failed: [], deferredRequests: 0, pendingVerification: 0, notified: false };
  }

  const ruleResults = await Promise.all(
    matches.map((match) => acceptAutoAcceptMatch(match, apiClient, options))
  );

  const autoAcceptMatches = ruleResults.flatMap((result) => result.autoAcceptMatches);

  logger.info("auto-accept-matched", {
    ruleCount: autoAcceptMatches.length,
    totalTrips: autoAcceptMatches.reduce((sum, m) => sum + m.matchedCount, 0),
  });

  const accepted = ruleResults.flatMap((result) => result.accepted);
  const failed = ruleResults.flatMap((result) => result.failed);
  const deferredRequests = ruleResults.reduce((sum, result) => sum + result.deferredRequests, 0);
  const pendingVerification = ruleResults.reduce((sum, result) => sum + result.pendingVerification, 0);
  const acceptedProgress = ruleResults.flatMap((result) => result.acceptedProgress);
  const historyWrites = ruleResults.flatMap((result) => result.historyWrites);

  // Record auto-accept metrics
  for (let i = 0; i < accepted.length; i++) metrics.recordAutoAccept(true);
  for (let i = 0; i < failed.length; i++) metrics.recordAutoAccept(false);

  // Settle each rule's claims the moment ITS decrement commits — a later
  // rule's UPDATE (or the broadcast) throwing must not strand the claims of
  // rules whose decrement already landed.
  const tokenByRule = new Map<string, ClaimToken>();
  for (const result of ruleResults) {
    const match = result.autoAcceptMatches[0];
    if (match) tokenByRule.set(match.ruleId, result.claimToken);
  }
  try {
    await applyAutoAcceptProgress(teamId, acceptedProgress, (ruleId, acceptedCount) => {
      const token = tokenByRule.get(ruleId);
      if (token !== undefined) options.needBudget?.settle(ruleId, token, acceptedCount);
    });
  } catch (err) {
    // The decrement infrastructure failing (DB pool down, broadcast throw)
    // must not abort the history writes and notifications below — trucks are
    // already committed upstream. Unsettled claims expire via the claim TTL,
    // biasing toward under-accepting.
    logger.error("auto-accept-progress-failed", {
      rules: acceptedProgress.map((p) => p.ruleId),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (options.deferSideEffects) {
    for (const write of historyWrites) runDetached("auto-accept-history-write-failed", write());
  } else {
    await Promise.all(historyWrites.map((write) => write()));
  }

  // Notify only if at least one request was accepted successfully
  let notified = false;

  if (accepted.length > 0) {
    if (options.deferSideEffects) {
      runDetached("auto-accept-notification", routeAutoAcceptSuccessNotification(accepted, {
        teamId,
        notificationContext: options.notificationContext,
        source: "notifier",
        evidence: { acceptedCount: accepted.length },
      }));
    } else {
      notified = await routeAutoAcceptSuccessNotification(accepted, {
        teamId,
        notificationContext: options.notificationContext,
        source: "notifier",
        evidence: { acceptedCount: accepted.length },
      });
      if (notified) {
        logger.info("auto-accept-notified", { acceptedCount: accepted.length });
      }
    }
  }

  // Notify about failures via LINEJS first, then LINE OA fallback. Throttled
  // per booking+request-set: a request that keeps failing every retry round
  // must not page the operator on every cycle, but a DIFFERENT request set in
  // the same booking (e.g. a lost-race probe vs a genuine pending failure)
  // gets its own alert slot.
  const alertNow = Date.now();
  for (const [key, sentAt] of failureAlertLastSentByBooking) {
    if (alertNow - sentAt >= FAILURE_ALERT_THROTTLE_MS) failureAlertLastSentByBooking.delete(key);
  }
  const failureAlertKey = (f: AutoAcceptResult["failed"][number]): string =>
    `${f.bookingId}:${[...f.requestIds].sort((a, b) => a - b).join(",")}`;
  const failedToAlert = failed.filter((f) => !failureAlertLastSentByBooking.has(failureAlertKey(f)));
  const alertKeys = failedToAlert.map(failureAlertKey);
  for (const key of alertKeys) failureAlertLastSentByBooking.set(key, alertNow);

  if (failedToAlert.length > 0) {
    const teamTarget = getTeamLineTarget(options.notificationContext, "auto-accept-failure-alert");
    const failGroupMid = teamTarget ?? (env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || env.LINEJS_TEST_TARGET_ID || env.LINE_USER_ID || "");
    const failLines = failedToAlert.map((f) => `❌ booking_id=${f.bookingId} requests=[${f.requestIds.join(",")}]\n   error: ${f.error}`);
    const failAlertText = [
      "⚠️ SPX Auto-Accept ล้มเหลว",
      `เวลา: ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`,
      "",
      ...failLines,
    ].join("\n");

    const sendFailAlert = async () => {
      if (env.SPX_ROLE === "worker") {
        const published = await publishWorkerAutoAcceptFailureNotification(failedToAlert, failAlertText, options.notificationContext);
        if (!published) {
          for (const key of alertKeys) failureAlertLastSentByBooking.delete(key);
        }
        return;
      }
      if (teamTarget === "") return;
      // Roll the throttle slots back when no channel delivered, so a
      // transient LINE outage cannot permanently silence a one-shot
      // lost-race alert (the attempt itself is never re-run).
      try {
        const sent = await sendLineJsThenOa("SPX Auto-Accept ล้มเหลว", failAlertText, {
          lineJsTarget: failGroupMid,
          lineOaTarget: teamTarget ?? undefined,
          logPrefix: "auto-accept-failure-alert",
          useGlobalFallback: !options.notificationContext,
        });
        if (!sent) {
          for (const key of alertKeys) failureAlertLastSentByBooking.delete(key);
        }
      } catch (err) {
        for (const key of alertKeys) failureAlertLastSentByBooking.delete(key);
        throw err;
      }
    };

    if (options.deferSideEffects) {
      runDetached("auto-accept-failure-linejs-alert", sendFailAlert());
    } else {
      await sendFailAlert();
    }
  }

  return { autoAcceptMatches, accepted, failed, deferredRequests, pendingVerification, notified };
}

/** Send a critical alert when SPX session cookie expires */
export async function sendSessionExpiryNotification(
  errorMessage: string,
  context?: TeamNotificationContext
): Promise<{ sent: boolean; skipped?: boolean; results: NotificationSendResult[] }> {
  const title = "🔴 SPX Session หมดอายุ";
  const message = [
    "**ระบบตรวจพบว่า Session Cookie ของ SPX หมดอายุแล้ว**",
    "",
    `Error: ${errorMessage}`,
    "",
    "⚠️ ระบบจะไม่สามารถ poll ข้อมูลหรือ accept งานได้จนกว่าจะอัปเดต cookie",
    "",
    "🔧 วิธีแก้:",
    "1. เข้า SPX Agency Portal แล้ว copy cookie ใหม่",
    "2. อัปเดตค่า COOKIE ผ่าน Settings UI หรือแก้ไขไฟล์ .env",
    "3. ระบบจะ restart และเริ่มทำงานใหม่อัตโนมัติ",
  ].join("\n");

  if (env.SPX_ROLE === "worker") {
    return publishWorkerSessionExpiredNotification(errorMessage, `${title}\n${message}`, context);
  }

  if (!hasNotificationTarget(context)) {
    if (context) {
      logger.warn("session-expiry-notification-line-target-missing", { teamId: context.teamId, teamName: context.teamName });
    }
    return { sent: false, skipped: true, results: [] };
  }

  return sendNotificationMessage(title, message, context);
}

/** Send a LINE alert when SPX rate limit is hit or recovered (respects team rateLimitNotifyEnabled setting) */
export async function sendRateLimitNotification(
  type: "hit" | "recovered",
  details: { teamId: number; retcode?: number; backoffMs: number; endpoint?: string },
  context?: TeamNotificationContext
): Promise<{ sent: boolean; skipped?: boolean; results: NotificationSendResult[] }> {
  // If rate limit notification is not explicitly enabled for this team, skip sending
  if (!context?.rateLimitNotifyEnabled) {
    return { sent: false, skipped: true, results: [] };
  }

  const teamName = context?.teamName ?? `Team ${details.teamId}`;

  const title = type === "hit"
    ? "⚠️ SPX Rate Limit"
    : "✅ SPX Rate Limit คลายแล้ว";

  const message = type === "hit"
    ? [
        `Team: ${teamName}`,
        `จุดที่พบ: ${details.endpoint || "ดึงรายการงานหลัก (Bidding List)"}`,
        `Retcode: ${details.retcode ?? "130008001"}`,
        `ชะลอการดึงงานชั่วคราว ${(details.backoffMs / 1000).toFixed(1)} วินาที...`,
      ].join("\n")
    : [
        `Team: ${teamName}`,
        `จุดที่คลาย: ${details.endpoint || "ดึงรายการงานหลัก (Bidding List)"}`,
        "ระบบเริ่มทำงานรอบใหม่ปกติแล้ว",
      ].join("\n");

  if (env.SPX_ROLE === "worker") {
    const result = await getWorkerNotificationPublisher().publish({
      eventKey: `rate_limit_${type}:team:${details.teamId}:${Date.now()}`,
      event: {
        schemaVersion: 1,
        eventType: `rate_limit_${type}`,
        severity: type === "hit" ? "warning" : "info",
        teamId: details.teamId,
        teamName,
        message: `${title}\n${message}`,
        occurredAt: new Date().toISOString(),
        evidence: { retcode: details.retcode, backoffMs: details.backoffMs },
      },
    });
    return {
      sent: result.ok,
      results: [{ channel: "central_notifier", ok: result.ok, error: result.error }],
    };
  }

  if (!hasNotificationTarget(context)) {
    if (context) {
      logger.warn(`rate-limit-${type}-notification-line-target-missing`, { teamId: context.teamId, teamName: context.teamName });
    }
    return { sent: false, skipped: true, results: [] };
  }

  return sendNotificationMessage(title, message, context);
}

let lineQuotaCache: { totalUsage: number; limit: number; type: string; fetchedAt: number } | null = null;
const LINE_QUOTA_CACHE_MS = 60_000;

export async function fetchLineQuota(): Promise<{ totalUsage: number; limit: number; type: string; enabled: boolean } | null> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return null;
  }

  if (lineQuotaCache && (Date.now() - lineQuotaCache.fetchedAt) < LINE_QUOTA_CACHE_MS) {
    return { ...lineQuotaCache, enabled: true };
  }

  try {
    const [quotaRes, consumptionRes] = await Promise.all([
      fetchWithTimeout("https://api.line.me/v2/bot/message/quota", {
        headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
        timeoutMs: LINE_QUOTA_FETCH_TIMEOUT_MS,
      }),
      fetchWithTimeout("https://api.line.me/v2/bot/message/quota/consumption", {
        headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
        timeoutMs: LINE_QUOTA_FETCH_TIMEOUT_MS,
      }),
    ]);

    let limit = 0;
    let type = "unknown";
    if (quotaRes.ok) {
      const q = await quotaRes.json() as { type?: string; value?: number };
      type = q.type ?? "unknown";
      limit = q.value ?? 0;
    }

    let totalUsage = 0;
    if (consumptionRes.ok) {
      const c = await consumptionRes.json() as { totalUsage?: number };
      totalUsage = c.totalUsage ?? 0;
    }

    lineQuotaCache = { totalUsage, limit, type, fetchedAt: Date.now() };
    return { totalUsage, limit, type, enabled: true };
  } catch (error) {
    logger.error("line-quota-fetch-failed", error instanceof Error ? error : new Error(String(error)));
    return lineQuotaCache ? { ...lineQuotaCache, enabled: true } : { totalUsage: 0, limit: 0, type: "unknown", enabled: false };
  }
}
