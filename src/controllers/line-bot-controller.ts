import type { FastifyPluginAsync } from "fastify";
import { requestQrLogin, sendMessage, getStatus, getGroups, getProfile, getStorageHealth, logout, isLineBotEnabled } from "../services/line-bot.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { logger } from "../utils/logger.js";

interface SendMessageBody {
  to: string;
  text: string;
}

interface LogoutBody {
  clearStorage?: boolean;
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

  /** GET /profile — get authenticated LINE profile */
  app.get("/profile", async (_req, reply) => {
    if (!isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
    }

    try {
      const profile = await getProfile();
      if (!profile) {
        return sendError(reply, 503, "NOT_AUTHENTICATED", "LINE Bot is not authenticated or profile unavailable");
      }
      return sendSuccess(reply, profile);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("line-bot-profile-error", { error: msg });
      return sendError(reply, 500, "PROFILE_ERROR", msg);
    }
  });

  /** GET /storage — check storage health (E2EE keys, auth state) */
  app.get("/storage", async (_req, reply) => {
    if (!isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
    }

    try {
      const health = await getStorageHealth();
      return sendSuccess(reply, health);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("line-bot-storage-error", { error: msg });
      return sendError(reply, 500, "STORAGE_ERROR", msg);
    }
  });

  /** POST /logout — logout and optionally clear storage */
  app.post<{ Body: LogoutBody }>("/logout", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          clearStorage: { type: "boolean" },
        },
      },
    },
  }, async (req, reply) => {
    if (!isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
    }

    try {
      await logout(req.body.clearStorage);
      return sendSuccess(reply, { loggedOut: true, clearStorage: req.body.clearStorage }, "LINE Bot logged out");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("line-bot-logout-error", { error: msg });
      return sendError(reply, 500, "LOGOUT_ERROR", msg);
    }
  });
};
