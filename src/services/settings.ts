import { env, validateRuntimeConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { getAppSettings, upsertAppSettings } from "../repositories/app-settings-repository.js";

const REMOVED_SETTINGS_KEYS = ["LINEJS_TEST_EMAIL", "LINEJS_TEST_PASSWORD"] as const;

export const SETTINGS_KEYS = [
  "API_URL",
  "COOKIE",
  "DEVICE_ID",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_USER_ID",
  "LINEJS_TEST_ENABLED",
  "LINEJS_TEST_TARGET_ID",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE",
  "LINEJS_TEST_DEVICE",
  "LINEJS_TEST_STORAGE_PATH",
  "DISCORD_WEBHOOK_URL",
  "POLL_INTERVAL_MS",
  "BOOKING_DETAIL_CONCURRENCY",
  "BIDDING_VEHICLE_TYPE",
  "CODEX_IMAGE_PROVIDER",
] as const;

export type SettingsKey = typeof SETTINGS_KEYS[number];
export type EnvSettings = Partial<Record<SettingsKey, string>>;

const DEFAULT_SETTINGS: Record<SettingsKey, string> = {
  API_URL: "",
  COOKIE: "",
  DEVICE_ID: "",
  LINE_CHANNEL_ACCESS_TOKEN: "",
  LINE_USER_ID: "",
  LINEJS_TEST_ENABLED: "false",
  LINEJS_TEST_TARGET_ID: "",
  LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: "",
  LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: "",
  LINEJS_TEST_DEVICE: "IOSIPAD",
  LINEJS_TEST_STORAGE_PATH: "data/linejs-storage.json",
  DISCORD_WEBHOOK_URL: "",
  POLL_INTERVAL_MS: "30000",
  BOOKING_DETAIL_CONCURRENCY: "8",
  BIDDING_VEHICLE_TYPE: "13",
  CODEX_IMAGE_PROVIDER: "auto",
};

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
  const result: EnvSettings = {};
  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function syncEnvObjectFromProcess(): void {
  const mutableEnv = env as unknown as Record<string, unknown>;
  mutableEnv.API_URL = process.env.API_URL || "";
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
  const biddingVehicleType = readOptionalIntegerSetting("BIDDING_VEHICLE_TYPE");
  if (biddingVehicleType !== undefined && (!Number.isFinite(biddingVehicleType) || biddingVehicleType <= 0)) {
    console.warn(`BIDDING_VEHICLE_TYPE is invalid (${process.env.BIDDING_VEHICLE_TYPE}); falling back to undefined`);
    mutableEnv.BIDDING_VEHICLE_TYPE = undefined;
  } else {
    mutableEnv.BIDDING_VEHICLE_TYPE = biddingVehicleType;
  }
  mutableEnv.CODEX_IMAGE_PROVIDER = process.env.CODEX_IMAGE_PROVIDER || "auto";
}

function applySettingsToEnv(settings: EnvSettings): void {
  for (const [key, value] of Object.entries(settings) as Array<[SettingsKey, string | undefined]>) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
  syncEnvObjectFromProcess();
}

function readProcessSettings(): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of SETTINGS_KEYS) {
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
  const previousProcessEnv: Record<string, string | undefined> = {};
  for (const key of SETTINGS_KEYS) {
    previousProcessEnv[key] = process.env[key];
  }

  applySettingsToEnv({ ...DEFAULT_SETTINGS, ...dbSettings });
  try {
    validateRuntimeConfig();
  } catch (err) {
    // Roll back to the previously-valid config and keep the poller running on it.
    for (const [key, prev] of Object.entries(previousProcessEnv)) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    syncEnvObjectFromProcess();
    logger.error("settings-live-reload-validation-failed", {
      error: err instanceof Error ? err.message : String(err),
      rolledBack: true,
    });
  }
}

export async function migrateEnvSettingsToDb(): Promise<void> {
  const envSettings = pickKnownSettings(readProcessSettings());
  for (const key of REMOVED_SETTINGS_KEYS) {
    delete envSettings[key as SettingsKey];
  }

  const currentSettings = await getAppSettings(SETTINGS_KEYS);
  const missingSettings: EnvSettings = {};
  for (const [key, value] of Object.entries(envSettings) as Array<[SettingsKey, string | undefined]>) {
    if (typeof value === "string" && currentSettings[key] === undefined) {
      missingSettings[key] = value;
    }
  }

  if (Object.keys(missingSettings).length > 0) {
    await upsertAppSettings(missingSettings as Record<string, string>);
  }
}

export async function loadDbSettingsIntoEnv(): Promise<void> {
  const dbSettings = pickKnownSettings(await getAppSettings(SETTINGS_KEYS));
  applySettingsToEnv({ ...DEFAULT_SETTINGS, ...dbSettings });
}
