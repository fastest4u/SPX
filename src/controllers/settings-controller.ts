import type { FastifyPluginAsync } from "fastify";
import type { AuthUser } from "../services/authz.js";
import { readEnvFile, writeEnvFile, type EnvSettings, type SettingsKey } from "../services/settings.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { logger } from "../utils/logger.js";
import { sendSuccess } from "../utils/response.js";

const SECRET_KEYS = new Set<SettingsKey>(["COOKIE", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_USER_ID", "DISCORD_WEBHOOK_URL"]);
const REDACTED_PREFIX = "********";

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    API_URL: { type: "string" },
    COOKIE: { type: "string" },
    DEVICE_ID: { type: "string" },
    LINE_CHANNEL_ACCESS_TOKEN: { type: "string" },
    LINE_USER_ID: { type: "string" },
    DISCORD_WEBHOOK_URL: { type: "string" },
    POLL_INTERVAL_MS: { type: "string" },
  },
} as const;

function currentUser(req: { user?: unknown }): AuthUser {
  return req.user as AuthUser;
}

function redactSecret(value: string | undefined): string {
  if (!value) return "";
  return `${REDACTED_PREFIX}${value.slice(-4)}`;
}

function isRedactedSecret(value: string): boolean {
  return value.startsWith(REDACTED_PREFIX);
}

function readPublicSettings(): EnvSettings {
  const envVars = readEnvFile();
  return {
    API_URL: envVars.API_URL || "",
    COOKIE: redactSecret(envVars.COOKIE),
    DEVICE_ID: envVars.DEVICE_ID || "",
    LINE_CHANNEL_ACCESS_TOKEN: redactSecret(envVars.LINE_CHANNEL_ACCESS_TOKEN),
    LINE_USER_ID: redactSecret(envVars.LINE_USER_ID),
    DISCORD_WEBHOOK_URL: redactSecret(envVars.DISCORD_WEBHOOK_URL),
    POLL_INTERVAL_MS: envVars.POLL_INTERVAL_MS || "30000",
  };
}

function writableSettings(body: Partial<Record<SettingsKey, string>>): EnvSettings {
  const result: EnvSettings = {};
  for (const [key, value] of Object.entries(body) as Array<[SettingsKey, string | undefined]>) {
    if (typeof value !== "string") continue;
    if (SECRET_KEYS.has(key) && isRedactedSecret(value)) continue;
    result[key] = value;
  }
  return result;
}

export const settingsController: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    return sendSuccess(reply, readPublicSettings());
  });

  app.post(
    "/",
    { schema: { body: settingsSchema } },
    async (req, reply) => {
      const data = writableSettings(req.body as Partial<Record<SettingsKey, string>>);
      writeEnvFile(data);
      await insertAuditLog(currentUser(req).username, "Update Settings", "Updated .env configuration (Server Restarted)");

      setTimeout(() => {
        logger.info("settings-updated-restarting");
        process.exit(0);
      }, 1000);

      return sendSuccess(reply, null, "Settings saved. Server is restarting...");
    }
  );
};
