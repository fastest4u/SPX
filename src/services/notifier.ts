import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { metrics } from "./metrics.js";
import { matchRules, getActiveAutoAcceptRules, matchAutoAcceptRuleTripsWithRules, applyAutoAcceptProgress, type NotifyRule, type RuleTripMatch, type TripLike } from "./notify-rules.js";
import { insertAutoAcceptHistory } from "../repositories/auto-accept-repository.js";
import type { ApiClient } from "./api-client.js";
import { isLineBotEnabled, sendMessage as sendLineBotMessage, formatError as lineBotFormatError, LineBotQrRequiredError } from "./line-bot.js";

// Re-export for backward compatibility
export type { LineBotStatus as LineJsQrLoginResult } from "./line-bot.js";
export { requestQrLogin as requestLineJsQrLogin } from "./line-bot.js";

type NotificationChannel = "line" | "discord" | "linejs_test";

const NOTIFY_FETCH_TIMEOUT_MS = 10_000;
const LINE_QUOTA_FETCH_TIMEOUT_MS = 5_000;

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

function hasNotificationTarget(): boolean {
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

async function sendLineOaMessage(title: string, message: string): Promise<void> {
  const body = JSON.stringify({
    to: env.LINE_USER_ID,
    messages: [{
      type: "text",
      text: `${title}\n${truncate(message, 4500)}`,
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

function maskTarget(value: string): string {
  if (!value) return "";
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

async function sendLineJsThenOa(
  title: string,
  message: string,
  options: { lineJsTarget?: string; logPrefix: string; results?: NotificationSendResult[] }
): Promise<boolean> {
  const text = `${title}\n${message}`;
  const lineJsTarget = options.lineJsTarget || env.LINEJS_TEST_TARGET_ID || env.LINE_USER_ID || "";

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

  if (env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_USER_ID) {
    try {
      await sendLineOaMessage(title, message);
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
      userConfigured: Boolean(env.LINE_USER_ID),
    });
  }

  return false;
}

/** Send auto-accept success to LINEJS first, then fallback to LINE OA. */
async function sendAutoAcceptAlert(title: string, message: string): Promise<boolean> {
  return sendLineJsThenOa(title, message, {
    lineJsTarget: getAutoAcceptSuccessLineJsTarget(),
    logPrefix: "auto-accept-alert",
  });
}

export async function sendNotificationMessage(title: string, message: string): Promise<{ sent: boolean; results: NotificationSendResult[] }> {
  const results: NotificationSendResult[] = [];

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

  await sendLineJsThenOa(title, message, { logPrefix: "notification", results });

  return { sent: results.some((result) => result.ok), results };
}

export async function notifyMatchedRules(trips: TripLike[], options?: { dryRun?: boolean; forceTest?: boolean }) {
  const matches = await matchRules(trips);
  if (options?.dryRun) {
    return { matches, sent: false, dryRun: true };
  }

  return { matches, sent: false, skipped: true, disabled: true };
}

// ── Auto-accept + Notify flow ──────────────────────────────────────────

interface AcceptedTrip {
  trip: TripLike;
  bookingId: number;
  requestId: number;
}

interface AutoAcceptResult {
  autoAcceptMatches: RuleTripMatch[];
  accepted: AcceptedTrip[];
  failed: Array<{ bookingId: number; requestIds: number[]; error: string }>;
  notified: boolean;
}

interface AutoAcceptOptions {
  deferSideEffects?: boolean;
  needBudget?: NeedBudget;
  autoAcceptRules?: NotifyRule[];
}

/**
 * Atomic in-memory budget tracker for concurrent auto-accept.
 * Node.js is single-threaded — synchronous Map operations between await
 * points are inherently atomic, so this acts as a lock-free semaphore.
 * Create one instance per polling cycle and share it across concurrent workers.
 */
export class NeedBudget {
  private remaining = new Map<string, number>();

  /** Atomically claim up to `requested` slots. Returns the granted count. */
  claim(ruleId: string, dbNeed: number, requested: number): number {
    if (!this.remaining.has(ruleId)) {
      this.remaining.set(ruleId, dbNeed);
    }
    const available = this.remaining.get(ruleId)!;
    const granted = Math.min(requested, available);
    this.remaining.set(ruleId, available - granted);
    return granted;
  }

  release(ruleId: string, count: number): void {
    if (count <= 0 || !this.remaining.has(ruleId)) return;
    this.remaining.set(ruleId, this.remaining.get(ruleId)! + count);
  }
}

const acceptedRequestKeys = new Set<string>();
const acceptedRequestKeyOrder: string[] = [];
const MAX_ACCEPTED_REQUEST_KEYS = 5000;
const autoAcceptRequestKeys = new Set<string>();
const autoAcceptRequestKeyOrder: string[] = [];

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

function releaseAutoAcceptRequest(bookingId: number, requestId: number): void {
  autoAcceptRequestKeys.delete(autoAcceptRequestKey(bookingId, requestId));
}

function runDetached(label: string, promise: Promise<unknown>): void {
  void promise.catch((err) => {
    logger.warn(label, { error: err instanceof Error ? err.message : String(err) });
  });
}

function buildAcceptNotificationMessage(accepted: AcceptedTrip[]): string {
  const now = new Date();
  const thaiDateShort = now.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });
  const timeStr = now.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false });

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

interface AutoAcceptRuleRunResult {
  autoAcceptMatches: RuleTripMatch[];
  accepted: AcceptedTrip[];
  failed: AutoAcceptResult["failed"];
  acceptedProgress: Array<{ ruleId: string; acceptedCount: number }>;
  historyWrites: Array<() => Promise<unknown>>;
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

function emptyAutoAcceptRuleRunResult(): AutoAcceptRuleRunResult {
  return {
    autoAcceptMatches: [],
    accepted: [],
    failed: [],
    acceptedProgress: [],
    historyWrites: [],
  };
}

function selectAutoAcceptRequests(match: RuleTripMatch, options: AutoAcceptOptions): SelectedAutoAcceptRequest[] {
  const candidates: SelectedAutoAcceptRequest[] = [];

  for (const trip of match.trips) {
    const requestId = typeof trip.request_id === "number" ? trip.request_id : undefined;
    const bookingId = typeof trip.booking_id === "number" ? trip.booking_id : undefined;

    if (bookingId === undefined || requestId === undefined) {
      logger.warn("auto-accept-skip-trip", { reason: "missing booking_id or request_id", trip });
      continue;
    }

    if (acceptedRequestKeys.has(acceptedRequestKey(match.ruleId, requestId))) continue;
    candidates.push({ trip, bookingId, requestId });
  }

  const limit = options.needBudget
    ? options.needBudget.claim(match.ruleId, match.need, candidates.length)
    : Math.max(0, match.need);
  const selected: SelectedAutoAcceptRequest[] = [];

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (claimAutoAcceptRequest(candidate.bookingId, candidate.requestId)) {
      selected.push(candidate);
    }
  }

  options.needBudget?.release(match.ruleId, limit - selected.length);

  if (match.trips.length > selected.length) {
    logger.info("auto-accept-truncated", {
      ruleId: match.ruleId,
      ruleName: match.ruleName,
      matchedCount: match.matchedCount,
      selectedCount: selected.length,
      limit,
    });
  }

  return selected;
}

async function acceptAutoAcceptMatch(
  match: RuleTripMatch,
  apiClient: ApiClient,
  options: AutoAcceptOptions
): Promise<AutoAcceptRuleRunResult> {
  logger.info("auto-accept-rule-matched", {
    ruleId: match.ruleId,
    ruleName: match.ruleName,
    matchedCount: match.matchedCount,
  });

  const selected = selectAutoAcceptRequests(match, options);
  if (selected.length === 0) {
    return { ...emptyAutoAcceptRuleRunResult(), autoAcceptMatches: [match] };
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
  const acceptedProgress: Array<{ ruleId: string; acceptedCount: number }> = [];
  const historyWrites: Array<() => Promise<unknown>> = [];

  const acceptResults = await Promise.all([...byBooking].map(async ([bookingId, entry]) => {
    const requestIds = [...entry.requestIds];

    logger.info("auto-accept-calling", { bookingId, requestIds, ruleId: match.ruleId, ruleName: match.ruleName });

    const result = await apiClient.acceptBookingRequests(bookingId, requestIds);

    // When the SPX API returns an error, it may still have partially accepted some
    // requests in the batch (e.g. "Time-out or accept by other agency" for one request
    // while others succeeded). Verify the actual status of each request so we report
    // and notify based on what really happened rather than the raw retcode.
    let verifiedAcceptedIds: number[] = result.ok ? requestIds : [];
    let verifiedFailedIds: number[] = result.ok ? [] : requestIds;

    if (!result.ok) {
      try {
        // Verify against BOTH tabs because SPX moves accepted requests out of the
        // "pending confirmation" tab into the "confirmed" tab. Fetching only the
        // pending tab (the default) misses requests we just accepted, causing
        // the verify branch to falsely report success=0 and notify failure for
        // the whole batch.
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
          const acceptedSet = new Set(
            [...merged.entries()]
              .filter(([, status]) => status === 2)
              .map(([requestId]) => requestId)
          );
          verifiedAcceptedIds = requestIds.filter((id) => acceptedSet.has(id));
          verifiedFailedIds = requestIds.filter((id) => !acceptedSet.has(id));
          if (verifiedAcceptedIds.length > 0) {
            logger.info("auto-accept-partial-verified", {
              bookingId,
              acceptedIds: verifiedAcceptedIds,
              failedIds: verifiedFailedIds,
              ruleId: entry.ruleId,
              originalError: result.error,
            });
          }
        }
      } catch (verifyErr) {
        logger.warn("auto-accept-verify-failed", {
          bookingId,
          ruleId: entry.ruleId,
          error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        });
      }
    }

    return { bookingId, entry, requestIds, result, verifiedAcceptedIds, verifiedFailedIds };
  }));

  for (const { bookingId, entry, requestIds, result, verifiedAcceptedIds, verifiedFailedIds } of acceptResults) {
    if (verifiedAcceptedIds.length > 0) {
      const logLevel = result.ok ? "auto-accept-success" : "auto-accept-partial-success";
      logger.info(logLevel, { bookingId, requestIds: verifiedAcceptedIds, ruleId: entry.ruleId, httpStatus: result.httpStatus });
      for (const trip of entry.trips) {
        const requestId = typeof trip.request_id === "number" ? trip.request_id : 0;
        if (requestId > 0 && verifiedAcceptedIds.includes(requestId)) {
          accepted.push({ trip, bookingId, requestId });
          rememberAcceptedRequest(entry.ruleId, requestId);
        }
      }
      acceptedProgress.push({ ruleId: entry.ruleId, acceptedCount: verifiedAcceptedIds.length });
      historyWrites.push(() => insertAutoAcceptHistory({
        ruleId: entry.ruleId,
        ruleName: entry.ruleName,
        bookingId,
        requestIds: verifiedAcceptedIds,
        acceptedCount: verifiedAcceptedIds.length,
        origin: textValue(entry.trips[0]?.origin ?? entry.trips[0]?.["ต้นทาง"]),
        destination: textValue(entry.trips[0]?.destination ?? entry.trips[0]?.["ปลายทาง"]),
        vehicleType: textValue(entry.trips[0]?.vehicle_type ?? entry.trips[0]?.["ประเภทรถ"]),
        status: "success",
      }));
    }

    if (verifiedFailedIds.length > 0) {
      for (const requestId of verifiedFailedIds) {
        releaseAutoAcceptRequest(bookingId, requestId);
      }
      logger.error("auto-accept-failed", { bookingId, requestIds: verifiedFailedIds, ruleId: entry.ruleId, error: result.error, httpStatus: result.httpStatus });
      failed.push({ bookingId, requestIds: verifiedFailedIds, error: result.error || "Unknown error" });
      historyWrites.push(() => insertAutoAcceptHistory({
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
      }));
    }

    if (verifiedAcceptedIds.length === 0 && verifiedFailedIds.length === 0) {
      // Verification returned an empty list — treat original batch as fully failed
      for (const requestId of requestIds) {
        releaseAutoAcceptRequest(bookingId, requestId);
      }
      logger.error("auto-accept-failed", { bookingId, requestIds, ruleId: entry.ruleId, error: result.error, httpStatus: result.httpStatus });
      failed.push({ bookingId, requestIds, error: result.error || "Unknown error" });
      historyWrites.push(() => insertAutoAcceptHistory({
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
      }));
    }
  }

  return {
    autoAcceptMatches: [match],
    accepted,
    failed,
    acceptedProgress,
    historyWrites,
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
  const autoAcceptRules = options.autoAcceptRules ?? await getActiveAutoAcceptRules();
  const ruleResults = await Promise.all(autoAcceptRules.map((rule) => {
    const [match] = matchAutoAcceptRuleTripsWithRules(trips, [rule]);
    if (!match) return Promise.resolve(emptyAutoAcceptRuleRunResult());
    return acceptAutoAcceptMatch(match, apiClient, options);
  }));

  const autoAcceptMatches = ruleResults.flatMap((result) => result.autoAcceptMatches);

  if (autoAcceptMatches.length === 0) {
    return { autoAcceptMatches: [], accepted: [], failed: [], notified: false };
  }

  logger.info("auto-accept-matched", {
    ruleCount: autoAcceptMatches.length,
    totalTrips: autoAcceptMatches.reduce((sum, m) => sum + m.matchedCount, 0),
  });

  const accepted = ruleResults.flatMap((result) => result.accepted);
  const failed = ruleResults.flatMap((result) => result.failed);
  const acceptedProgress = ruleResults.flatMap((result) => result.acceptedProgress);
  const historyWrites = ruleResults.flatMap((result) => result.historyWrites);

  // Record auto-accept metrics
  for (let i = 0; i < accepted.length; i++) metrics.recordAutoAccept(true);
  for (let i = 0; i < failed.length; i++) metrics.recordAutoAccept(false);

  await applyAutoAcceptProgress(acceptedProgress);

  if (options.deferSideEffects) {
    for (const write of historyWrites) runDetached("auto-accept-history-write-failed", write());
  } else {
    await Promise.all(historyWrites.map((write) => write()));
  }

  // Notify only if at least one request was accepted successfully
  let notified = false;

  if (accepted.length > 0) {
    const title = `✅ SPX Auto-Accept สำเร็จ ${accepted.length} รายการ`;
    const message = buildAcceptNotificationMessage(accepted);

    if (options.deferSideEffects) {
      runDetached("auto-accept-notification", sendAutoAcceptAlert(title, message));
    } else {
      notified = await sendAutoAcceptAlert(title, message);
      if (notified) {
        logger.info("auto-accept-notified", { acceptedCount: accepted.length });
      }
    }
  }

  // Notify about failures via LINEJS first, then LINE OA fallback.
  if (failed.length > 0) {
    const failGroupMid = env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || env.LINEJS_TEST_TARGET_ID || env.LINE_USER_ID || "";
    const failLines = failed.map((f) => `❌ booking_id=${f.bookingId} requests=[${f.requestIds.join(",")}]\n   error: ${f.error}`);
    const failAlertText = [
      "⚠️ SPX Auto-Accept ล้มเหลว",
      `เวลา: ${new Date().toLocaleString("th-TH")}`,
      "",
      ...failLines,
    ].join("\n");

    const sendFailAlert = async () => {
      await sendLineJsThenOa("SPX Auto-Accept ล้มเหลว", failAlertText, {
        lineJsTarget: failGroupMid,
        logPrefix: "auto-accept-failure-alert",
      });
    };

    if (options.deferSideEffects) {
      runDetached("auto-accept-failure-linejs-alert", sendFailAlert());
    } else {
      await sendFailAlert();
    }
  }

  return { autoAcceptMatches, accepted, failed, notified };
}

/** Send a critical alert when SPX session cookie expires */
export async function sendSessionExpiryNotification(errorMessage: string): Promise<{ sent: boolean; skipped?: boolean; results: NotificationSendResult[] }> {
  if (!hasNotificationTarget()) {
    return { sent: false, skipped: true, results: [] };
  }

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

  return sendNotificationMessage(title, message);
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
