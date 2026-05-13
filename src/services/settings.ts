import { env } from "../config/env.js";
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
  "LINEJS_TEST_TARGET_ID_RULE_MATCH",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE",
  "LINEJS_TEST_DEVICE",
  "LINEJS_TEST_STORAGE_PATH",
  "DISCORD_WEBHOOK_URL",
  "POLL_INTERVAL_MS",
  "BOOKING_DETAIL_CONCURRENCY",
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
  LINEJS_TEST_TARGET_ID_RULE_MATCH: "",
  LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: "",
  LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: "",
  LINEJS_TEST_DEVICE: "IOSIPAD",
  LINEJS_TEST_STORAGE_PATH: "data/linejs-storage.json",
  DISCORD_WEBHOOK_URL: "",
  POLL_INTERVAL_MS: "30000",
  BOOKING_DETAIL_CONCURRENCY: "8",
};

function readIntegerSetting(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
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
  mutableEnv.POLL_INTERVAL_MS = readIntegerSetting("POLL_INTERVAL_MS", 30000);
  mutableEnv.COOKIE = process.env.COOKIE || "";
  mutableEnv.DEVICE_ID = process.env.DEVICE_ID || "";
  mutableEnv.LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  mutableEnv.LINE_USER_ID = process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_ENABLED = process.env.LINEJS_TEST_ENABLED === "true";
  mutableEnv.LINEJS_TEST_TARGET_ID = process.env.LINEJS_TEST_TARGET_ID || process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_TARGET_ID_RULE_MATCH = process.env.LINEJS_TEST_TARGET_ID_RULE_MATCH || process.env.LINEJS_TEST_TARGET_ID || process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS = process.env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS || process.env.LINEJS_TEST_TARGET_ID || process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE = process.env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || process.env.LINEJS_TEST_TARGET_ID || process.env.LINE_USER_ID || "";
  mutableEnv.LINEJS_TEST_DEVICE = process.env.LINEJS_TEST_DEVICE || "IOSIPAD";
  mutableEnv.LINEJS_TEST_STORAGE_PATH = process.env.LINEJS_TEST_STORAGE_PATH || "data/linejs-storage.json";
  mutableEnv.DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
  mutableEnv.BOOKING_DETAIL_CONCURRENCY = readIntegerSetting("BOOKING_DETAIL_CONCURRENCY", 20);
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
  await upsertAppSettings(settings as Record<string, string>);
  applySettingsToEnv(settings);
}

export async function reloadSettingsLive(): Promise<void> {
  const dbSettings = pickKnownSettings(await getAppSettings(SETTINGS_KEYS));
  applySettingsToEnv({ ...DEFAULT_SETTINGS, ...dbSettings });
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
