import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { matchRules, markRulesFulfilled, type RuleMatch, type TripLike } from "./notify-rules.js";

type NotificationChannel = "line" | "discord";

type NotificationSendResult = {
  channel: NotificationChannel;
  ok: boolean;
  error?: string;
};

function hasNotificationTarget(): boolean {
  return Boolean(env.LINE_NOTIFY_TOKEN || env.DISCORD_WEBHOOK_URL);
}

function dedupeRuleIndexes(matches: Array<{ ruleIndex: number }>): number[] {
  return [...new Set(matches.map((match) => match.ruleIndex))];
}

function textField(trip: TripLike, primaryKey: string, fallbackKey: string): string {
  const value = trip[primaryKey] ?? trip[fallbackKey];
  return typeof value === "string" && value.trim() ? value.trim() : "-";
}

function tripLine(trip: TripLike): string {
  const origin = textField(trip, "origin", "ต้นทาง");
  const destination = textField(trip, "destination", "ปลายทาง");
  const vehicleType = textField(trip, "vehicle_type", "ประเภทรถ");
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
    const fulfilledRuleIndexes: number[] = [];

    if (!forceTest && env.NOTIFY_MODE === "each") {
      for (const match of matches) {
        const message = buildNotificationMessage([match], trips, false);
        const sendResult = await sendNotificationMessage(`${title}: ${match.ruleName}`, message);
        channelResults.push(...sendResult.results);
        if (sendResult.sent) {
          fulfilledRuleIndexes.push(match.ruleIndex);
        }
      }
    } else {
      const message = buildNotificationMessage(matches, trips, forceTest);
      const sendResult = await sendNotificationMessage(title, message);
      channelResults.push(...sendResult.results);
      if (sendResult.sent) {
        fulfilledRuleIndexes.push(...dedupeRuleIndexes(matches));
      }
    }

    if (fulfilledRuleIndexes.length > 0) {
      markRulesFulfilled(fulfilledRuleIndexes);
    }

    return { matches, sent: channelResults.some((result) => result.ok), channels: channelResults };
  } catch (error) {
    logger.error("notification-failed", error instanceof Error ? error : new Error(String(error)));
    return { matches, sent: false, error: true };
  }
}
