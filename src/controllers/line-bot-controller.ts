import type { FastifyPluginAsync } from "fastify";
import { env } from "../config/env.js";
import {
  getLineServiceGroups,
  getLineServiceProfile,
  getLineServiceStorage,
  getLineServiceStatus,
  logoutLineService,
  requestLineServiceLogin,
  sendLineServiceMessage,
  type LineServiceGroupsResult,
  type LineServiceLoginResult,
  type LineServiceLogoutResult,
  type LineServiceMessageResult,
  type LineServiceProfileResult,
  type LineServiceStorageResult,
  type LineServiceStatusResult,
} from "../services/line-service-client.js";
import type {
  LineServiceLogoutRequest,
  LineServiceSendRequest,
  LineServiceLoginResponse,
  LineServiceStatusResponse,
} from "../services/line-service-contract.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { logger } from "../utils/logger.js";

interface SendMessageBody {
  to: string;
  text: string;
}

interface LogoutBody {
  clearStorage?: boolean;
}

type LocalLineBotModule = typeof import("../services/line-bot.js");

export interface LineBotControllerOptions {
  lineService?: {
    isEnabled?: () => boolean;
    getStatus?: () => Promise<LineServiceStatusResult>;
    sendMessage?: (request: LineServiceSendRequest) => Promise<LineServiceMessageResult>;
    requestLogin?: () => Promise<LineServiceLoginResult>;
    getGroups?: () => Promise<LineServiceGroupsResult>;
    getProfile?: () => Promise<LineServiceProfileResult>;
    getStorage?: () => Promise<LineServiceStorageResult>;
    logout?: (request: LineServiceLogoutRequest) => Promise<LineServiceLogoutResult>;
  };
  loadLocalLineBot?: () => Promise<LocalLineBotModule>;
}

function isRemoteLineServiceEnabled(options: LineBotControllerOptions): boolean {
  return options.lineService?.isEnabled?.() ?? env.LINE_SERVICE_URL.trim() !== "";
}

function lineServiceClientOptions(sharedSecret = env.NOTIFIER_SHARED_SECRET) {
  return {
    baseUrl: env.LINE_SERVICE_URL,
    sharedSecret,
    nodeId: env.SPX_NODE_ID || "web-api",
    requestTimeoutMs: env.LINE_SERVICE_REQUEST_TIMEOUT_MS,
  };
}

function lineServiceAdminClientOptions() {
  return lineServiceClientOptions(env.LINE_SERVICE_ADMIN_SECRET);
}

async function defaultLineServiceStatus(): Promise<LineServiceStatusResult> {
  return getLineServiceStatus(lineServiceAdminClientOptions());
}

async function defaultLineServiceSend(
  request: LineServiceSendRequest,
): Promise<LineServiceMessageResult> {
  return sendLineServiceMessage(lineServiceClientOptions(), request);
}

async function defaultLineServiceLogin(): Promise<LineServiceLoginResult> {
  return requestLineServiceLogin(lineServiceAdminClientOptions());
}

async function defaultLineServiceGroups(): Promise<LineServiceGroupsResult> {
  return getLineServiceGroups(lineServiceAdminClientOptions());
}

async function defaultLineServiceProfile(): Promise<LineServiceProfileResult> {
  return getLineServiceProfile(lineServiceAdminClientOptions());
}

async function defaultLineServiceStorage(): Promise<LineServiceStorageResult> {
  return getLineServiceStorage(lineServiceAdminClientOptions());
}

async function defaultLineServiceLogout(
  request: LineServiceLogoutRequest,
): Promise<LineServiceLogoutResult> {
  return logoutLineService(lineServiceAdminClientOptions(), request);
}

function lineServiceStatusToApiStatus(
  status: LineServiceStatusResponse | LineServiceLoginResponse,
) {
  return {
    enabled: status.enabled,
    authenticated: status.authenticated,
    qrUrl: status.qrUrl,
    pincode: status.pincode,
    listenerActive: status.listenerActive,
    message:
      "message" in status && typeof status.message === "string"
        ? status.message
        : status.enabled
          ? status.authenticated
            ? "LINE Bot is connected"
            : "LINE Bot is not yet authenticated"
          : "LINE Bot is disabled",
  };
}

async function defaultLoadLocalLineBot(): Promise<LocalLineBotModule> {
  return import("../services/line-bot.js");
}

function sendLineServiceError(
  reply: Parameters<typeof sendError>[0],
  result: { error: string; retryable: boolean },
  code: string,
): void {
  sendError(reply, result.retryable ? 503 : 502, code, result.error);
}

function lineBotLoginMessage(status: LineServiceLoginResponse): string {
  if (status.authenticated) return "LINE Bot is authenticated";
  return status.message || "QR login initiated";
}

export const lineBotController: FastifyPluginAsync<LineBotControllerOptions> = async (
  app,
  options,
) => {
  const loadLocalLineBot = options.loadLocalLineBot ?? defaultLoadLocalLineBot;

  /** GET /status — current LINE Bot authentication state */
  app.get("/status", async (_req, reply) => {
    if (isRemoteLineServiceEnabled(options)) {
      const result = await (options.lineService?.getStatus ?? defaultLineServiceStatus)();
      if (!result.ok) {
        return sendError(
          reply,
          result.retryable ? 503 : 502,
          "LINE_SERVICE_STATUS_FAILED",
          result.error,
        );
      }
      return sendSuccess(reply, lineServiceStatusToApiStatus(result.status));
    }

    const lineBot = await loadLocalLineBot();
    return sendSuccess(reply, lineBot.getStatus());
  });

  /** POST /login — trigger QR login flow */
  app.post("/login", async (_req, reply) => {
    if (isRemoteLineServiceEnabled(options)) {
      const result = await (options.lineService?.requestLogin ?? defaultLineServiceLogin)();
      if (!result.ok) return sendLineServiceError(reply, result, "LINE_SERVICE_LOGIN_FAILED");
      return sendSuccess(
        reply,
        lineServiceStatusToApiStatus(result.status),
        lineBotLoginMessage(result.status),
      );
    }

    const lineBot = await loadLocalLineBot();
    if (!lineBot.isLineBotEnabled()) {
      return sendError(
        reply,
        400,
        "DISABLED",
        "LINE Bot is disabled (LINEJS_TEST_ENABLED=false or NODE_ENV=production)",
      );
    }

    try {
      const result = await lineBot.requestQrLogin();
      return sendSuccess(
        reply,
        result,
        result.authenticated ? "LINE Bot is authenticated" : "QR login initiated",
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("line-bot-login-error", { error: msg });
      return sendError(reply, 500, "LOGIN_ERROR", msg);
    }
  });

  /** POST /send — send a message to a user or group */
  app.post<{ Body: SendMessageBody }>(
    "/send",
    {
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
    },
    async (req, reply) => {
      const { to, text } = req.body;
      logger.info("line-bot-send-requested", {
        to: to.slice(0, 6) + "...",
        textLength: text.length,
      });

      if (isRemoteLineServiceEnabled(options)) {
        const result = await (options.lineService?.sendMessage ?? defaultLineServiceSend)({
          targetId: to,
          text,
        });
        if (!result.ok) {
          return sendError(
            reply,
            result.retryable ? 503 : 502,
            "SEND_FAILED",
            result.error || "Failed to send message",
          );
        }
        return sendSuccess(reply, { sent: true }, "Message sent successfully");
      }

      const lineBot = await loadLocalLineBot();
      if (!lineBot.isLineBotEnabled()) {
        return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
      }

      const result = await lineBot.sendMessage(to, text);

      if (!result.ok) {
        return sendError(reply, 502, "SEND_FAILED", result.error || "Failed to send message", {
          qrUrl: result.qrUrl,
          pincode: result.pincode,
        });
      }

      return sendSuccess(reply, { sent: true }, "Message sent successfully");
    },
  );

  /** GET /groups — fetch groups the bot is a member of */
  app.get("/groups", async (_req, reply) => {
    if (isRemoteLineServiceEnabled(options)) {
      const result = await (options.lineService?.getGroups ?? defaultLineServiceGroups)();
      if (!result.ok) return sendLineServiceError(reply, result, "LINE_SERVICE_GROUPS_FAILED");
      return sendSuccess(reply, result.groups);
    }

    const lineBot = await loadLocalLineBot();
    if (!lineBot.isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
    }

    try {
      const result = await lineBot.getGroups();
      return sendSuccess(reply, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("line-bot-groups-error", { error: msg });
      return sendError(reply, 500, "GROUPS_ERROR", msg);
    }
  });

  /** GET /profile — get authenticated LINE profile */
  app.get("/profile", async (_req, reply) => {
    if (isRemoteLineServiceEnabled(options)) {
      const result = await (options.lineService?.getProfile ?? defaultLineServiceProfile)();
      if (!result.ok) return sendLineServiceError(reply, result, "LINE_SERVICE_PROFILE_FAILED");
      return sendSuccess(reply, result.profile);
    }

    const lineBot = await loadLocalLineBot();
    if (!lineBot.isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
    }

    try {
      const profile = await lineBot.getProfile();
      if (!profile) {
        return sendError(
          reply,
          503,
          "NOT_AUTHENTICATED",
          "LINE Bot is not authenticated or profile unavailable",
        );
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
    if (isRemoteLineServiceEnabled(options)) {
      const result = await (options.lineService?.getStorage ?? defaultLineServiceStorage)();
      if (!result.ok) return sendLineServiceError(reply, result, "LINE_SERVICE_STORAGE_FAILED");
      return sendSuccess(reply, result.storage);
    }

    const lineBot = await loadLocalLineBot();
    if (!lineBot.isLineBotEnabled()) {
      return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
    }

    try {
      const health = await lineBot.getStorageHealth();
      return sendSuccess(reply, health);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("line-bot-storage-error", { error: msg });
      return sendError(reply, 500, "STORAGE_ERROR", msg);
    }
  });

  /** POST /logout — logout and optionally clear storage */
  app.post<{ Body: LogoutBody }>(
    "/logout",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            clearStorage: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      if (isRemoteLineServiceEnabled(options)) {
        const result = await (options.lineService?.logout ?? defaultLineServiceLogout)({
          clearStorage: req.body.clearStorage,
        });
        if (!result.ok) return sendLineServiceError(reply, result, "LINE_SERVICE_LOGOUT_FAILED");
        return sendSuccess(reply, result.logout, "LINE Bot logged out");
      }

      const lineBot = await loadLocalLineBot();
      if (!lineBot.isLineBotEnabled()) {
        return sendError(reply, 400, "DISABLED", "LINE Bot is disabled");
      }

      try {
        await lineBot.logout(req.body.clearStorage);
        return sendSuccess(
          reply,
          { loggedOut: true, clearStorage: req.body.clearStorage },
          "LINE Bot logged out",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("line-bot-logout-error", { error: msg });
        return sendError(reply, 500, "LOGOUT_ERROR", msg);
      }
    },
  );
};
