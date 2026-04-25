import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { matchRules, matchAutoAcceptRuleTrips, markRulesFulfilled, markRulesAutoAccepted, type RuleMatch, type RuleTripMatch, type TripLike } from "./notify-rules.js";
import type { ApiClient } from "./api-client.js";

type NotificationChannel = "line" | "discord";

type NotificationSendResult = {
  channel: NotificationChannel;
  ok: boolean;
  error?: string;
};

function hasNotificationTarget(): boolean {
  return Boolean(env.LINE_NOTIFY_TOKEN || env.DISCORD_WEBHOOK_URL);
}

function dedupeRuleIds(matches: Array<{ ruleId: string }>): string[] {
  return [...new Set(matches.map((match) => match.ruleId))];
}

function textValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "-";
}

function tripLine(trip: TripLike): string {
  const origin = textValue(trip.origin ?? trip["ต้นทาง"]);
  const destination = textValue(trip.destination ?? trip["ปลายทาง"]);
  const vehicleType = textValue(trip.vehicle_type ?? trip["ประเภทรถ"]);
  const requestId = typeof trip.request_id === "number" ? trip.request_id : "-";
  return `request_id=${requestId} ${origin} -> ${destination} (${vehicleType})`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function buildNotificationMessage(matches: RuleMatch[], trips: TripLike[], forceTest: boolean): string {
  if (forceTest && matches.length === 0) {
    return "Test notification from SPX Bidding Poller.";
  }

  const rules = matches.map((match) => `- ${match.ruleName}: ${match.matchedCount} matched trip(s)`).join("\n");
  const samples = trips.slice(0, 5).map((trip) => `- ${tripLine(trip)}`).join("\n");

  return [
    "Matched notification rules:",
    rules || "- none",
    "",
    `Total trips in current poll: ${trips.length}`,
    samples ? `Sample trips:\n${samples}` : "Sample trips: none",
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

async function sendLineNotification(title: string, message: string): Promise<void> {
  const body = new URLSearchParams({ message: `\n${title}\n${truncate(message, 3000)}` });
  const response = await fetch("https://notify-api.line.me/api/notify", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LINE_NOTIFY_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`LINE Notify failed with HTTP ${response.status}: ${responseBody.slice(0, 200)}`);
  }
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

  if (env.LINE_NOTIFY_TOKEN) {
    try {
      await sendLineNotification(title, message);
      results.push({ channel: "line", ok: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("line-notification-failed", { error: errorMessage });
      results.push({ channel: "line", ok: false, error: errorMessage });
    }
  }

  return { sent: results.some((result) => result.ok), results };
}

export async function notifyMatchedRules(trips: TripLike[], options?: { dryRun?: boolean; forceTest?: boolean }) {
  const matches = matchRules(trips);
  if (options?.dryRun) {
    return { matches, sent: false, dryRun: true };
  }

  if (!env.NOTIFY_ENABLED && !options?.forceTest) {
    return { matches, sent: false, skipped: true };
  }

  if (matches.length === 0 && !options?.forceTest) {
    return { matches, sent: false };
  }

  if (!hasNotificationTarget() && !options?.forceTest) {
    logger.warn("notification-skipped", { reason: "no-notification-target" });
    return { matches, sent: false, skipped: true };
  }

  try {
    const forceTest = Boolean(options?.forceTest);
    const title = forceTest ? "SPX Notification Test" : "SPX Bidding Rule Matched";
    logger.info("notification-sending", { matches: matches.length, forceTest: !!options?.forceTest });

    const channelResults: NotificationSendResult[] = [];
    const fulfilledRuleIds: string[] = [];

    if (!forceTest && env.NOTIFY_MODE === "each") {
      for (const match of matches) {
        const message = buildNotificationMessage([match], trips, false);
        const sendResult = await sendNotificationMessage(`${title}: ${match.ruleName}`, message);
        channelResults.push(...sendResult.results);
        if (sendResult.sent) {
          fulfilledRuleIds.push(match.ruleId);
        }
      }
    } else {
      const message = buildNotificationMessage(matches, trips, forceTest);
      const sendResult = await sendNotificationMessage(title, message);
      channelResults.push(...sendResult.results);
      if (sendResult.sent) {
        fulfilledRuleIds.push(...dedupeRuleIds(matches));
      }
    }

    if (fulfilledRuleIds.length > 0) {
      markRulesFulfilled(fulfilledRuleIds);
    }

    return { matches, sent: channelResults.some((result) => result.ok), channels: channelResults };
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

function buildAcceptNotificationMessage(accepted: AcceptedTrip[]): string {
  const lines = accepted.slice(0, 10).map((item) => {
    const origin = textValue(item.trip.origin ?? item.trip["ต้นทาง"]);
    const destination = textValue(item.trip.destination ?? item.trip["ปลายทาง"]);
    const vehicleType = textValue(item.trip.vehicle_type ?? item.trip["ประเภทรถ"]);
    return `- request_id=${item.requestId} ${origin} -> ${destination} (${vehicleType})`;
  });

  return [
    `✅ Auto-accepted ${accepted.length} request(s):`,
    ...lines,
    accepted.length > 10 ? `  ...and ${accepted.length - 10} more` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Auto-accept matched rules then notify on success.
 * Flow: Match auto_accept rules → call Accept API → notify only if accept succeeded.
 */
export async function acceptAndNotifyMatchedRules(
  trips: TripLike[],
  apiClient: ApiClient
): Promise<AutoAcceptResult> {
  const autoAcceptMatches = matchAutoAcceptRuleTrips(trips);

  if (autoAcceptMatches.length === 0) {
    return { autoAcceptMatches: [], accepted: [], failed: [], notified: false };
  }

  logger.info("auto-accept-matched", {
    ruleCount: autoAcceptMatches.length,
    totalTrips: autoAcceptMatches.reduce((sum, m) => sum + m.matchedCount, 0),
  });

  // Group all matched trips by booking_id for batched accept calls
  const byBooking = new Map<number, { requestIds: Set<number>; trips: TripLike[] }>();

  for (const match of autoAcceptMatches) {
    for (const trip of match.trips) {
      const bookingId = typeof trip.booking_id === "number" ? trip.booking_id : undefined;
      const requestId = typeof trip.request_id === "number" ? trip.request_id : undefined;

      if (bookingId === undefined || requestId === undefined) {
        logger.warn("auto-accept-skip-trip", { reason: "missing booking_id or request_id", trip });
        continue;
      }

      let entry = byBooking.get(bookingId);
      if (!entry) {
        entry = { requestIds: new Set(), trips: [] };
        byBooking.set(bookingId, entry);
      }
      entry.requestIds.add(requestId);
      entry.trips.push(trip);
    }
  }

  const accepted: AcceptedTrip[] = [];
  const failed: AutoAcceptResult["failed"] = [];

  // Call accept API per booking
  for (const [bookingId, entry] of byBooking) {
    const requestIds = [...entry.requestIds];

    logger.info("auto-accept-calling", { bookingId, requestIds });

    const result = await apiClient.acceptBookingRequests(bookingId, requestIds);

    if (result.ok) {
      logger.info("auto-accept-success", { bookingId, requestIds, httpStatus: result.httpStatus });
      for (const trip of entry.trips) {
        const requestId = typeof trip.request_id === "number" ? trip.request_id : 0;
        accepted.push({ trip, bookingId, requestId });
      }
    } else {
      logger.error("auto-accept-failed", { bookingId, requestIds, error: result.error, httpStatus: result.httpStatus });
      failed.push({ bookingId, requestIds, error: result.error || "Unknown error" });
    }
  }

  // Mark rules as auto_accepted (regardless of accept success, to avoid retry loops)
  const fulfilledRuleIds = autoAcceptMatches.map((m) => m.ruleId);
  markRulesAutoAccepted(fulfilledRuleIds);
  markRulesFulfilled(fulfilledRuleIds);

  // Notify only if at least one request was accepted successfully
  let notified = false;

  if (accepted.length > 0 && hasNotificationTarget()) {
    const title = "🚛 SPX Auto-Accept สำเร็จ";
    const message = buildAcceptNotificationMessage(accepted);

    const sendResult = await sendNotificationMessage(title, message);
    notified = sendResult.sent;

    if (notified) {
      logger.info("auto-accept-notified", { acceptedCount: accepted.length });
    }
  }

  // Notify about failures too (if any)
  if (failed.length > 0 && hasNotificationTarget()) {
    const failTitle = "⚠️ SPX Auto-Accept ล้มเหลว";
    const failLines = failed.map((f) => `- booking_id=${f.bookingId} requests=[${f.requestIds.join(",")}] error: ${f.error}`);
    const failMessage = truncate(failLines.join("\n"), 4000);

    await sendNotificationMessage(failTitle, failMessage);
  }

  return { autoAcceptMatches, accepted, failed, notified };
}
