import type { FastifyPluginAsync } from "fastify";
import type { AuthUser } from "../services/authz.js";
import { getAppSettingMetadata } from "../config/config-catalog.js";
import { readStoredSettings, writeSettings, reloadSettingsLive, SETTINGS_KEYS, type EnvSettings, type SettingsKey } from "../services/settings.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { sendSuccess } from "../utils/response.js";

const WRITABLE_SETTINGS_KEYS = new Set<string>(SETTINGS_KEYS);
const REDACTED_PREFIX = "********";

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    API_URL: { type: "string" },
    APP_NAME: { type: "string" },
    REFERER: { type: "string" },
    DEBUG: { type: "string" },
    FETCH_DETAILS: { type: "string" },
    SAVE_TO_DB: { type: "string" },
    BIDDING_PAGE_NO: { type: "string" },
    BIDDING_PAGE_COUNT: { type: "string" },
    REQUEST_TAB_PENDING_CONFIRMATION: { type: "string" },
    REQUEST_CTIME_START: { type: "string" },
    NOTIFY_ENABLED: { type: "string" },
    NOTIFY_MODE: { type: "string", enum: ["each", "batch"] },
    NOTIFY_ORIGINS: { type: "string" },
    NOTIFY_DESTINATIONS: { type: "string" },
    NOTIFY_VEHICLE_TYPES: { type: "string" },
    NOTIFY_MIN_TRIPS: { type: "string" },
    AUTO_ACCEPT_ENABLED: { type: "string" },
    HTTP_ALLOWED_ORIGINS: { type: "string" },
    HTTP_TRUST_PROXY: { type: "string" },
    JWT_SECRET: { type: "string" },
    COOKIE_SECRET: { type: "string" },
    ADMIN_USERNAME: { type: "string" },
    ADMIN_PASSWORD: { type: "string" },
    ADMIN_ROLE: { type: "string", enum: ["admin", "user"] },
    LINE_CHANNEL_ACCESS_TOKEN: { type: "string" },
    LINEJS_TEST_ENABLED: { type: "string" },
    LINEJS_TEST_TARGET_ID: { type: "string" },
    LINEJS_TEST_DEVICE: { type: "string" },
    LINEJS_TEST_STORAGE_PATH: { type: "string" },
    DISCORD_WEBHOOK_URL: { type: "string" },
    POLL_INTERVAL_MS: { type: "string" },
    BOOKING_DETAIL_CONCURRENCY: { type: "string" },
    BOOKING_REPROCESS_COOLDOWN_MS: { type: "string" },
    BIDDING_VEHICLE_TYPE: { type: "string" },
    LINE_IMAGE_LISTENER_CHAT_ID: { type: "string" },
    NOTIFIER_SHARED_SECRET: { type: "string" },
    NOTIFIER_AUTH_MODE: { type: "string", enum: ["hmac", "bearer"] },
    NOTIFIER_REQUEST_TIMEOUT_MS: { type: "string" },
    NOTIFIER_RETRY_MAX_ATTEMPTS: { type: "string" },
    NOTIFIER_RETRY_BASE_DELAY_MS: { type: "string" },
    CODEX_IMAGE_MODEL: { type: "string" },
    CODEX_IMAGE_PROVIDER: { type: "string", enum: ["auto", "codex-cli", "codex-device"] },
    CODEX_IMAGE_TIMEOUT_MS: { type: "string" },
    CODEX_IMAGE_MAX_BYTES: { type: "string" },
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

function isSecretKey(key: SettingsKey): boolean {
  return getAppSettingMetadata(key).secret;
}

async function readPublicSettings(): Promise<EnvSettings> {
  const envVars = await readStoredSettings();
  const publicSettings: EnvSettings = {};
  for (const key of SETTINGS_KEYS) {
    const value = envVars[key] ?? "";
    publicSettings[key] = isSecretKey(key) ? redactSecret(value) : value;
  }
  return publicSettings;
}

function writableSettings(body: Record<string, unknown>): EnvSettings {
  const result: EnvSettings = {};
  for (const [key, value] of Object.entries(body)) {
    if (!WRITABLE_SETTINGS_KEYS.has(key)) continue;
    if (typeof value !== "string") continue;
    const settingsKey = key as SettingsKey;
    if (isSecretKey(settingsKey) && isRedactedSecret(value)) continue;
    result[settingsKey] = value;
  }
  return result;
}

export const settingsController: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    return sendSuccess(reply, {
      values: await readPublicSettings(),
      reloadBehavior: Object.fromEntries(
        SETTINGS_KEYS.map((key) => [key, getAppSettingMetadata(key).reload]),
      ),
    });
  });

  app.post(
    "/",
    { schema: { body: settingsSchema } },
    async (req, reply) => {
      const data = writableSettings(req.body as Record<string, unknown>);
      await writeSettings(data);
      await reloadSettingsLive();
      await insertAuditLog(currentUser(req).username, "Update Settings", "Updated DB-backed settings (Live Reload)");

      return sendSuccess(reply, null, "Settings saved. Applied live.");
    }
  );
};
