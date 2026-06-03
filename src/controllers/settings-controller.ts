import type { FastifyPluginAsync } from "fastify";
import type { AuthUser } from "../services/authz.js";
import { readStoredSettings, writeSettings, reloadSettingsLive, type EnvSettings, type SettingsKey } from "../services/settings.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { sendSuccess } from "../utils/response.js";

const SECRET_KEYS = new Set<SettingsKey>(["COOKIE", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_USER_ID", "LINEJS_TEST_TARGET_ID", "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS", "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE", "DISCORD_WEBHOOK_URL"]);
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
    LINEJS_TEST_ENABLED: { type: "string" },
    LINEJS_TEST_TARGET_ID: { type: "string" },
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: { type: "string" },
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: { type: "string" },
    LINEJS_TEST_DEVICE: { type: "string" },
    LINEJS_TEST_STORAGE_PATH: { type: "string" },
    DISCORD_WEBHOOK_URL: { type: "string" },
    POLL_INTERVAL_MS: { type: "string" },
    BOOKING_DETAIL_CONCURRENCY: { type: "string" },
    BOOKING_REPROCESS_COOLDOWN_MS: { type: "string" },
    BIDDING_VEHICLE_TYPE: { type: "string" },
    CODEX_IMAGE_PROVIDER: { type: "string", enum: ["auto", "codex-cli", "codex-device"] },
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

async function readPublicSettings(): Promise<EnvSettings> {
  const envVars = await readStoredSettings();
  return {
    API_URL: envVars.API_URL || "",
    COOKIE: redactSecret(envVars.COOKIE),
    DEVICE_ID: envVars.DEVICE_ID || "",
    LINE_CHANNEL_ACCESS_TOKEN: redactSecret(envVars.LINE_CHANNEL_ACCESS_TOKEN),
    LINE_USER_ID: redactSecret(envVars.LINE_USER_ID),
    LINEJS_TEST_ENABLED: envVars.LINEJS_TEST_ENABLED || "false",
    LINEJS_TEST_TARGET_ID: redactSecret(envVars.LINEJS_TEST_TARGET_ID),
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: redactSecret(envVars.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS),
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: redactSecret(envVars.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE),
    LINEJS_TEST_DEVICE: envVars.LINEJS_TEST_DEVICE || "IOSIPAD",
    LINEJS_TEST_STORAGE_PATH: envVars.LINEJS_TEST_STORAGE_PATH || "data/linejs-storage.json",
    DISCORD_WEBHOOK_URL: redactSecret(envVars.DISCORD_WEBHOOK_URL),
    POLL_INTERVAL_MS: envVars.POLL_INTERVAL_MS || "30000",
    BOOKING_DETAIL_CONCURRENCY: envVars.BOOKING_DETAIL_CONCURRENCY || "8",
    BOOKING_REPROCESS_COOLDOWN_MS: envVars.BOOKING_REPROCESS_COOLDOWN_MS || "0",
    BIDDING_VEHICLE_TYPE: envVars.BIDDING_VEHICLE_TYPE ?? "13",
    CODEX_IMAGE_PROVIDER: envVars.CODEX_IMAGE_PROVIDER || "auto",
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
    return sendSuccess(reply, await readPublicSettings());
  });

  app.post(
    "/",
    { schema: { body: settingsSchema } },
    async (req, reply) => {
      const data = writableSettings(req.body as Partial<Record<SettingsKey, string>>);
      await writeSettings(data);
      await reloadSettingsLive();
      await insertAuditLog(currentUser(req).username, "Update Settings", "Updated DB-backed settings (Live Reload)");

      return sendSuccess(reply, null, "Settings saved. Applied live.");
    }
  );
};
