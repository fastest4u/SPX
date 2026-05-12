import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { metrics } from "./metrics.js";
import { matchRules, getActiveAutoAcceptRules, matchAutoAcceptRuleTripsWithRules, markRulesFulfilled, applyAutoAcceptProgress, type NotifyRule, type RuleMatch, type RuleTripMatch, type TripLike } from "./notify-rules.js";
import { insertAutoAcceptHistory } from "../repositories/auto-accept-repository.js";
import type { ApiClient } from "./api-client.js";
import { isLineBotEnabled, sendNotification as sendLineBotNotification, sendMessage as sendLineBotMessage, formatError as lineBotFormatError, LineBotQrRequiredError } from "./line-bot.js";

// Re-export for backward compatibility
export type { LineBotStatus as LineJsQrLoginResult } from "./line-bot.js";
export { requestQrLogin as requestLineJsQrLogin } from "./line-bot.js";

type NotificationChannel = "line" | "discord" | "linejs_test";

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

function dedupeRuleIds(matches: Array<{ ruleId: string }>): string[] {
  return [...new Set(matches.map((match) => match.ruleId))];
}

function textValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "-";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function buildNotificationMessage(matches: RuleMatch[], trips: TripLike[], forceTest: boolean): string {
  if (forceTest && matches.length === 0) {
    return "Test notification from SPX Bidding Poller.";
  }

  const primaryMatch = matches[0];
  const sampleTrip = trips[0];
  const matchedCount = matches.reduce((sum, match) => sum + match.matchedCount, 0);

  const sampleLines = sampleTrip
    ? [
        `request_id: ${typeof sampleTrip.request_id === "number" ? sampleTrip.request_id : "-"}`,
        `เส้นทาง: ${textValue(sampleTrip.origin ?? sampleTrip["ต้นทาง"])} → ${textValue(sampleTrip.destination ?? sampleTrip["ปลายทาง"])}`,
        `ประเภทรถ: ${textValue(sampleTrip.vehicle_type ?? sampleTrip["ประเภทรถ"])}`,
      ]
    : ["- none"];

  return [
    "SPX แจ้งเตือนงานที่ตรงเงื่อนไข",
    `พบ ${matchedCount} งานที่ตรง rule`,
    "",
    "Matched rule",
    primaryMatch ? primaryMatch.ruleName : "- none",
    "",
    "ตัวอย่างงานที่ match",
    ...sampleLines,
  ].join("\n");
}

async function sendDiscordNotification(title: string, message: string): Promise<void> {
  const response = await fetch(env.DISCORD_WEBHOOK_URL, {
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

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
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

async function sendLineJsTestMessage(title: string, message: string): Promise<void> {
  const result = await sendLineBotNotification(title, message);
  if (!result.ok) {
    const err = new Error(result.error || "LINE Bot send failed");
    if (result.qrUrl) Object.assign(err, { qrUrl: result.qrUrl, pincode: result.pincode });
    throw err;
  }
}

const LINEJS_FALLBACK_GROUP_MID = env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS || env.LINEJS_TEST_TARGET_ID || env.LINE_USER_ID || "";

/** Try LINE OA first; if it fails/quota exceeded, fallback to LINEJS direct message */
async function sendAutoAcceptAlert(title: string, message: string): Promise<boolean> {
  if (env.LINE_CHANNEL_ACCESS_TOKEN) {
    try {
      await sendLineOaMessage(title, message);
      logger.info("auto-accept-alert-line-oa-sent", { title });
      return true;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn("auto-accept-alert-line-oa-failed", { title, error: errMsg });
      // Fallback to LINEJS below
    }
  }

  try {
    const text = `${title}\n${message}`;
    const result = await sendLineBotMessage(LINEJS_FALLBACK_GROUP_MID, text);
    if (result.ok) {
      logger.info("auto-accept-alert-linejs-sent", { groupMid: LINEJS_FALLBACK_GROUP_MID, title });
      return true;
    }
    logger.warn("auto-accept-alert-linejs-failed", { groupMid: LINEJS_FALLBACK_GROUP_MID, title, error: result.error });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn("auto-accept-alert-linejs-error", { groupMid: LINEJS_FALLBACK_GROUP_MID, title, error: errMsg });
  }

  return false;
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

  if (env.LINE_CHANNEL_ACCESS_TOKEN) {
    try {
      await sendLineOaMessage(title, message);
      results.push({ channel: "line", ok: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("line-notification-failed", { error: errorMessage });
      results.push({ channel: "line", ok: false, error: errorMessage });
    }
  }

  if (isLineBotEnabled()) {
    try {
      await sendLineJsTestMessage(title, message);
      results.push({ channel: "linejs_test", ok: true });
    } catch (error) {
      const errorMessage = lineBotFormatError(error);
      logger.error("linejs-test-notification-failed", { error: errorMessage });
      const errObj = error as Record<string, unknown>;
      results.push({
        channel: "linejs_test",
        ok: false,
        error: errorMessage,
        qrUrl: error instanceof LineBotQrRequiredError ? error.qrUrl : errObj.qrUrl as string | undefined,
        pincode: error instanceof LineBotQrRequiredError ? error.pincode : errObj.pincode as string | undefined,
      });
    }
  }

  return { sent: results.some((result) => result.ok), results };
}

export async function notifyMatchedRules(trips: TripLike[], options?: { dryRun?: boolean; forceTest?: boolean }) {
  const matches = await matchRules(trips);
  if (options?.dryRun) {
    return { matches, sent: false, dryRun: true };
  }

  if (!env.NOTIFY_ENABLED && !options?.forceTest) {
    return { matches, sent: false, skipped: true };
  }

  if (matches.length === 0 && !options?.forceTest) {
    return { matches, sent: false };
  }

  try {
    const forceTest = Boolean(options?.forceTest);
    const title = forceTest ? "SPX Notification Test" : "SPX แจ้งเตือนงานที่ตรงเงื่อนไข";
    logger.info("notification-sending", { matches: matches.length, forceTest: !!options?.forceTest });

    // Send only via LINEJS direct group message
    const notifyGroupMid = env.LINEJS_TEST_TARGET_ID_RULE_MATCH || env.LINEJS_TEST_TARGET_ID || env.LINE_USER_ID || "";
    const matchLines = matches.map((m) => `• ${m.ruleName} (${m.matchedCount} รายการ)`);
    const notifyAlertText = [
      `🔔 ${title}`,
      `เวลา: ${new Date().toLocaleString("th-TH")}`,
      "",
      ...matchLines,
    ].join("\n");

    let sent = false;
    try {
      const lineResult = await sendLineBotMessage(notifyGroupMid, notifyAlertText);
      if (lineResult.ok) {
        sent = true;
        logger.info("rule-match-linejs-alert-sent", { groupMid: notifyGroupMid, matchCount: matches.length });
      } else {
        logger.warn("rule-match-linejs-alert-failed", { groupMid: notifyGroupMid, error: lineResult.error });
      }
    } catch (lineError) {
      logger.warn("rule-match-linejs-alert-error", { groupMid: notifyGroupMid, error: lineError instanceof Error ? lineError.message : String(lineError) });
    }

    if (sent && !forceTest) {
      await markRulesFulfilled(dedupeRuleIds(matches));
    }

    return { matches, sent };
  } catch (error) {
    logger.error("notification-failed", error instanceof Error ? error : new Error(String(error)));
    return { matches, sent: false, error: true };
  }
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

    return { bookingId, entry, requestIds, result };
  }));

  for (const { bookingId, entry, requestIds, result } of acceptResults) {
    if (result.ok) {
      logger.info("auto-accept-success", { bookingId, requestIds, ruleId: entry.ruleId, httpStatus: result.httpStatus });
      for (const trip of entry.trips) {
        const requestId = typeof trip.request_id === "number" ? trip.request_id : 0;
        accepted.push({ trip, bookingId, requestId });
        if (requestId > 0) {
          rememberAcceptedRequest(entry.ruleId, requestId);
        }
      }
      acceptedProgress.push({ ruleId: entry.ruleId, acceptedCount: requestIds.length });
      historyWrites.push(() => insertAutoAcceptHistory({
        ruleId: entry.ruleId,
        ruleName: entry.ruleName,
        bookingId,
        requestIds,
        acceptedCount: requestIds.length,
        origin: textValue(entry.trips[0]?.origin ?? entry.trips[0]?.["ต้นทาง"]),
        destination: textValue(entry.trips[0]?.destination ?? entry.trips[0]?.["ปลายทาง"]),
        vehicleType: textValue(entry.trips[0]?.vehicle_type ?? entry.trips[0]?.["ประเภทรถ"]),
        status: "success",
      }));
    } else {
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

  // Notify about failures — LINEJS direct group only
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
      try {
        const result = await sendLineBotMessage(failGroupMid, failAlertText);
        if (result.ok) {
          logger.info("auto-accept-failure-linejs-sent", { groupMid: failGroupMid, failedCount: failed.length });
        } else {
          logger.warn("auto-accept-failure-linejs-failed", { groupMid: failGroupMid, error: result.error });
        }
      } catch (error) {
        logger.warn("auto-accept-failure-linejs-error", { groupMid: failGroupMid, error: error instanceof Error ? error.message : String(error) });
      }
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
      fetch("https://api.line.me/v2/bot/message/quota", {
        headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
      }),
      fetch("https://api.line.me/v2/bot/message/quota/consumption", {
        headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
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
