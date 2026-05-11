import type { FastifyPluginAsync } from "fastify";
import { requestQrLogin, sendMessage, getStatus, getGroups, isLineBotEnabled } from "../services/line-bot.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { logger } from "../utils/logger.js";

interface SendMessageBody {
  to: string;
  text: string;
}

export const lineBotController: FastifyPluginAsync = async (app) => {
  /** GET /status — current LINE Bot authentication state */
  app.get("/status", async (_req, reply) => {
    return sendSuccess(reply, getStatus());
  });

  /** POST /login — trigger QR login flow */
  app.post("/login", async (_req, reply) => {
    if (!isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled (LINEJS_TEST_ENABLED=false or NODE_ENV=production)");
    }

    try {
      const result = await requestQrLogin();
      return sendSuccess(reply, result, result.authenticated ? "LINE Bot is authenticated" : "QR login initiated");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("line-bot-login-error", { error: msg });
      return sendError(reply, 500, "LOGIN_ERROR", msg);
    }
  });

  /** POST /send — send a message to a user or group */
  app.post<{ Body: SendMessageBody }>("/send", {
    schema: {
      body: {
        type: "object",
        required: ["to", "text"],
        additionalProperties: false,
        properties: {
          to: { type: "string", minLength: 1, maxLength: 100 },
          text: { type: "string", minLength: 1, maxLength: 5000 },
        },
      },
    },
  }, async (req, reply) => {
    if (!isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
    }

    const { to, text } = req.body;
    logger.info("line-bot-send-requested", { to: to.slice(0, 6) + "...", textLength: text.length });

    const result = await sendMessage(to, text);

    if (!result.ok) {
      return sendError(reply, 502, "SEND_FAILED", result.error || "Failed to send message", {
        qrUrl: result.qrUrl,
        pincode: result.pincode,
      });
    }

    return sendSuccess(reply, { sent: true }, "Message sent successfully");
  });

  /** GET /groups — fetch groups the bot is a member of */
  app.get("/groups", async (_req, reply) => {
    if (!isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
    }

    try {
      const result = await getGroups();
      return sendSuccess(reply, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("line-bot-groups-error", { error: msg });
      return sendError(reply, 500, "GROUPS_ERROR", msg);
    }
  });
};
