import {
  APP_SETTING_KEYS,
  getAppSettingDefaults,
  pickAppSettings,
  type AppSettingKey,
  type AppSettings,
} from "../config/config-catalog.js";
import { env, parseTrustProxy, validateRuntimeConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { getAppSettings, upsertAppSettings } from "../repositories/app-settings-repository.js";
import { reconfigureSpxDispatcher } from "../utils/http-dispatcher.js";

const REMOVED_SETTINGS_KEYS = ["LINEJS_TEST_EMAIL", "LINEJS_TEST_PASSWORD"] as const;
const LEGACY_TEAM_SETTINGS_KEYS = [
  "COOKIE",
  "DEVICE_ID",
  "LINE_USER_ID",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE",
] as const;

export const SETTINGS_KEYS = APP_SETTING_KEYS;
export type SettingsKey = AppSettingKey;
type LegacyTeamSettingsKey = typeof LEGACY_TEAM_SETTINGS_KEYS[number];
type RuntimeSettingsKey = SettingsKey | LegacyTeamSettingsKey;
export type EnvSettings = AppSettings;
type RuntimeSettings = Partial<Record<RuntimeSettingsKey, string>>;
type ProcessEnvSnapshot = Record<string, string | undefined>;

const DEFAULT_SETTINGS = getAppSettingDefaults();

const RUNTIME_SETTINGS_KEYS = [...SETTINGS_KEYS, ...LEGACY_TEAM_SETTINGS_KEYS] as const;

function readIntegerSetting(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const value = Number(rawValue);
  return Number.isInteger(value) ? value : Number.NaN;
}

function readOptionalIntegerSetting(name: string): number | undefined {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const value = Number(rawValue);
  return Number.isInteger(value) ? value : Number.NaN;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function pickKnownSettings(settings: Record<string, string>): EnvSettings {
  return pickAppSettings(settings);
}

function parseCommaSeparatedSetting(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function syncEnvObjectFromProcess(): void {
  const mutableEnv = env as unknown as Record<string, unknown>;
  mutableEnv.API_URL = process.env.API_URL || "";
  mutableEnv.APP_NAME = process.env.APP_NAME || "";
  mutableEnv.REFERER = process.env.REFERER || "";
  mutableEnv.DEBUG = process.env.DEBUG === "true";
  mutableEnv.FETCH_DETAILS = process.env.FETCH_DETAILS === "true";
  mutableEnv.SAVE_TO_DB = process.env.SAVE_TO_DB === "true";
  // Guard POLL_INTERVAL_MS against NaN — a non-finite interval would put the
  // poller into a busy loop. Fall back to a safe default and surface a warning.
  const pollInterval = readIntegerSetting("POLL_INTERVAL_MS", 30000);
  if (!Number.isFinite(pollInterval) || pollInterval <= 0) {
    console.warn(`POLL_INTERVAL_MS is invalid (${process.env.POLL_INTERVAL_MS}); falling back to 30000`);
    mutableEnv.POLL_INTERVAL_MS = 30000;
  } else {
    mutableEnv.POLL_INTERVAL_MS = pollInterval;
  }
  mutableEnv.COOKIE = process.env.COOKIE || "";
  mutableEnv.DEVICE_ID = process.env.DEVICE_ID || "";
  mutableEnv.BIDDING_PAGE_NO = readIntegerSetting("BIDDING_PAGE_NO", 1);
  mutableEnv.BIDDING_PAGE_COUNT = readIntegerSetting("BIDDING_PAGE_COUNT", 100);
  mutableEnv.REQUEST_TAB_PENDING_CONFIRMATION = process.env.REQUEST_TAB_PENDING_CONFIRMATION !== "false";
  mutableEnv.REQUEST_CTIME_START = readIntegerSetting("REQUEST_CTIME_START", 1776358800);
  mutableEnv.NOTIFY_ENABLED = process.env.NOTIFY_ENABLED === "true";
  mutableEnv.NOTIFY_MODE = process.env.NOTIFY_MODE || "batch";
  mutableEnv.NOTIFY_ORIGINS = parseCommaSeparatedSetting(process.env.NOTIFY_ORIGINS);
  mutableEnv.NOTIFY_DESTINATIONS = parseCommaSeparatedSetting(process.env.NOTIFY_DESTINATIONS);
  mutableEnv.NOTIFY_VEHICLE_TYPES = parseCommaSeparatedSetting(process.env.NOTIFY_VEHICLE_TYPES);
  mutableEnv.NOTIFY_MIN_TRIPS = readIntegerSetting("NOTIFY_MIN_TRIPS", 1);
  mutableEnv.AUTO_ACCEPT_ENABLED = process.env.AUTO_ACCEPT_ENABLED === "true";
  mutableEnv.HTTP_ENABLED = process.env.HTTP_ENABLED === "true";
  mutableEnv.HTTP_ALLOWED_ORIGINS = parseCommaSeparatedSetting(process.env.HTTP_ALLOWED_ORIGINS);
  mutableEnv.HTTP_TRUST_PROXY = parseTrustProxy(process.env.HTTP_TRUST_PROXY);
  mutableEnv.JWT_SECRET = process.env.JWT_SECRET || "";
  mutableEnv.COOKIE_SECRET = process.env.COOKIE_SECRET || "";
  mutableEnv.ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
  mutableEnv.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
  mutableEnv.ADMIN_ROLE = process.env.ADMIN_ROLE || "admin";
  mutableEnv.NOTIFIER_SHARED_SECRET = process.env.NOTIFIER_SHARED_SECRET || "";
  mutableEnv.NOTIFIER_AUTH_MODE = process.env.NOTIFIER_AUTH_MODE || "hmac";
  mutableEnv.NOTIFIER_REQUEST_TIMEOUT_MS = readIntegerSetting("NOTIFIER_REQUEST_TIMEOUT_MS", 1500);
  mutableEnv.NOTIFIER_RETRY_MAX_ATTEMPTS = readIntegerSetting("NOTIFIER_RETRY_MAX_ATTEMPTS", 12);
  mutableEnv.NOTIFIER_RETRY_BASE_DELAY_MS = readIntegerSetting("NOTIFIER_RETRY_BASE_DELAY_MS", 1000);
  mutableEnv.LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  mutableEnv.LINE_USER_ID = process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_ENABLED = process.env.LINEJS_TEST_ENABLED === "true";
  mutableEnv.LINEJS_TEST_TARGET_ID = process.env.LINEJS_TEST_TARGET_ID || process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS = process.env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS || process.env.LINEJS_TEST_TARGET_ID || process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE = process.env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || process.env.LINEJS_TEST_TARGET_ID || process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_DEVICE = process.env.LINEJS_TEST_DEVICE || "IOSIPAD";
  mutableEnv.LINEJS_TEST_STORAGE_PATH = process.env.LINEJS_TEST_STORAGE_PATH || "data/linejs-storage.json";
  mutableEnv.DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
  // Cap detail concurrency at runtime to prevent UI bypass of boot-time validation.
  const concurrency = readIntegerSetting("BOOKING_DETAIL_CONCURRENCY", 8);
  if (!Number.isFinite(concurrency) || concurrency <= 0 || concurrency > 50) {
    console.warn(`BOOKING_DETAIL_CONCURRENCY out of range (${process.env.BOOKING_DETAIL_CONCURRENCY}); falling back to 8`);
    mutableEnv.BOOKING_DETAIL_CONCURRENCY = 8;
  } else {
    mutableEnv.BOOKING_DETAIL_CONCURRENCY = concurrency;
  }
  // Re-process cooldown (ms). Guard against NaN/negative; 0 disables it.
  const reprocessCooldown = readIntegerSetting("BOOKING_REPROCESS_COOLDOWN_MS", 0);
  if (!Number.isFinite(reprocessCooldown) || reprocessCooldown < 0) {
    console.warn(`BOOKING_REPROCESS_COOLDOWN_MS is invalid (${process.env.BOOKING_REPROCESS_COOLDOWN_MS}); falling back to 0`);
    mutableEnv.BOOKING_REPROCESS_COOLDOWN_MS = 0;
  } else {
    mutableEnv.BOOKING_REPROCESS_COOLDOWN_MS = reprocessCooldown;
  }
  const biddingVehicleType = readOptionalIntegerSetting("BIDDING_VEHICLE_TYPE");
  if (biddingVehicleType !== undefined && (!Number.isFinite(biddingVehicleType) || biddingVehicleType <= 0)) {
    console.warn(`BIDDING_VEHICLE_TYPE is invalid (${process.env.BIDDING_VEHICLE_TYPE}); falling back to undefined`);
    mutableEnv.BIDDING_VEHICLE_TYPE = undefined;
  } else {
    mutableEnv.BIDDING_VEHICLE_TYPE = biddingVehicleType;
  }
  mutableEnv.CODEX_IMAGE_MODEL = process.env.CODEX_IMAGE_MODEL || "";
  mutableEnv.CODEX_IMAGE_PROVIDER = process.env.CODEX_IMAGE_PROVIDER || "auto";
  mutableEnv.CODEX_IMAGE_TIMEOUT_MS = readIntegerSetting("CODEX_IMAGE_TIMEOUT_MS", 300000);
  mutableEnv.CODEX_IMAGE_MAX_BYTES = readIntegerSetting("CODEX_IMAGE_MAX_BYTES", 10 * 1024 * 1024);
  mutableEnv.LINE_IMAGE_LISTENER_CHAT_ID = process.env.LINE_IMAGE_LISTENER_CHAT_ID || "";
  // Keep the HTTP keep-alive window in sync with the live poll interval so warm
  // connections always outlast the gap between polls (no-ops when unchanged).
  reconfigureSpxDispatcher(mutableEnv.POLL_INTERVAL_MS as number);
}

function applySettingsToEnv(settings: RuntimeSettings): void {
  for (const [key, value] of Object.entries(settings) as Array<[RuntimeSettingsKey, string | undefined]>) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
  syncEnvObjectFromProcess();
}

function snapshotProcessEnv(keys: readonly RuntimeSettingsKey[]): ProcessEnvSnapshot {
  const snapshot: ProcessEnvSnapshot = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreProcessEnv(snapshot: ProcessEnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  syncEnvObjectFromProcess();
}

function readProcessSettings(keys: readonly RuntimeSettingsKey[] = SETTINGS_KEYS): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string") {
      settings[key] = value;
    }
  }
  return settings;
}

export async function readStoredSettings(): Promise<EnvSettings> {
  const envSettings = pickKnownSettings(readProcessSettings());
  try {
    const dbSettings = pickKnownSettings(await getAppSettings(SETTINGS_KEYS));
    return isProduction()
      ? { ...DEFAULT_SETTINGS, ...dbSettings }
      : { ...DEFAULT_SETTINGS, ...envSettings, ...dbSettings };
  } catch {
    return { ...DEFAULT_SETTINGS, ...envSettings };
  }
}

export async function writeSettings(newSettings: EnvSettings): Promise<void> {
  const settings = pickKnownSettings(newSettings as Record<string, string>);

  // Stage candidate settings into a snapshot of process.env so we can validate
  // before persisting. This blocks UI updates that would put the poller into a
  // bad state (invalid URL, zero interval, etc.).
  const previousProcessEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(settings) as SettingsKey[]) {
    previousProcessEnv[key] = process.env[key];
    process.env[key] = settings[key];
  }
  syncEnvObjectFromProcess();

  try {
    validateRuntimeConfig();
  } catch (err) {
    // Roll back the in-memory mutation so the running process keeps the old config.
    for (const [key, prev] of Object.entries(previousProcessEnv)) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    syncEnvObjectFromProcess();
    throw err instanceof Error ? err : new Error(String(err));
  }

  await upsertAppSettings(settings as Record<string, string>);
}

export async function reloadSettingsLive(): Promise<void> {
  const dbSettings = pickKnownSettings(await getAppSettings(SETTINGS_KEYS));

  // Snapshot the current process.env for every settings key so we can roll back
  // if the DB-sourced config fails validation. Without this, an invalid stored
  // row would replace the live config and leave the poller running on broken
  // settings (the old code applied first and only logged on failure).
  const previousProcessEnv = snapshotProcessEnv(SETTINGS_KEYS);

  applySettingsToEnv({ ...DEFAULT_SETTINGS, ...dbSettings });
  try {
    validateRuntimeConfig();
  } catch (err) {
    // Roll back to the previously-valid config and keep the poller running on it.
    restoreProcessEnv(previousProcessEnv);
    logger.error("settings-live-reload-validation-failed", {
      error: err instanceof Error ? err.message : String(err),
      rolledBack: true,
    });
  }
}

export async function migrateEnvSettingsToDb(): Promise<void> {
  const envSettings = readProcessSettings(RUNTIME_SETTINGS_KEYS);
  for (const key of REMOVED_SETTINGS_KEYS) {
    delete envSettings[key];
  }

  const currentSettings = await getAppSettings(RUNTIME_SETTINGS_KEYS);
  const missingSettings: RuntimeSettings = {};
  for (const [key, value] of Object.entries(envSettings) as Array<[RuntimeSettingsKey, string | undefined]>) {
    if (typeof value === "string" && currentSettings[key] === undefined) {
      missingSettings[key] = value;
    }
  }

  if (Object.keys(missingSettings).length > 0) {
    await upsertAppSettings(missingSettings as Record<string, string>);
  }
}

export async function loadDbSettingsIntoEnv(): Promise<void> {
  const dbSettings = await getAppSettings(RUNTIME_SETTINGS_KEYS);
  const previousProcessEnv = snapshotProcessEnv(RUNTIME_SETTINGS_KEYS);

  applySettingsToEnv({ ...DEFAULT_SETTINGS, ...dbSettings });
  try {
    validateRuntimeConfig();
  } catch (err) {
    restoreProcessEnv(previousProcessEnv);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function loadDbFirstSettingsIntoEnv(): Promise<void> {
  await migrateEnvSettingsToDb();
  await loadDbSettingsIntoEnv();
}
