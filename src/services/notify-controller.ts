import type { FastifyPluginAsync } from "fastify";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { sendNotificationMessage } from "./notifier.js";

interface NotificationBody {
  title?: string;
  message?: string;
  channels?: {
    line?: boolean;
    discord?: boolean;
  };
}

function redact(value: string, visible = 4): string {
  if (!value) return "";
  if (value.length <= visible * 2) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, visible)}${"*".repeat(Math.max(4, value.length - visible * 2))}${value.slice(-visible)}`;
}

export const notifyController: FastifyPluginAsync = async (app) => {
  app.post<{ Body: NotificationBody }>("/preview", async (req) => {
    const body = req.body ?? {};
    return {
      ok: true,
      preview: {
        title: body?.title ?? "SPX Notification Preview",
        message: body?.message ?? "นี่คือข้อความตัวอย่างสำหรับตรวจสอบรูปแบบแจ้งเตือน",
        channels: {
          line: Boolean(env.LINE_NOTIFY_TOKEN),
          discord: Boolean(env.DISCORD_WEBHOOK_URL),
        },
      },
    };
  });

  app.post<{ Body: NotificationBody }>("/test", async (req, reply) => {
    const body = req.body ?? {};
    const title = body?.title ?? "SPX Notification Test";
    const message = body?.message ?? "Test notification from SPX Bidding Poller.";

    if (!env.LINE_NOTIFY_TOKEN && !env.DISCORD_WEBHOOK_URL) {
      return reply.code(400).send({ error: { code: "NOT_CONFIGURED", message: "No notification target is configured" } });
    }

    logger.info("notification-test-requested", {
      title,
      lineConfigured: Boolean(env.LINE_NOTIFY_TOKEN),
      discordConfigured: Boolean(env.DISCORD_WEBHOOK_URL),
      discordWebhook: redact(env.DISCORD_WEBHOOK_URL),
    });

    const result = await sendNotificationMessage(title, message);

    return {
      ok: result.sent,
      sent: {
        line: result.results.some((item) => item.channel === "line" && item.ok),
        discord: result.results.some((item) => item.channel === "discord" && item.ok),
      },
      channels: result.results,
      message,
    };
  });
};
