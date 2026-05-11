import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const envFilePath = resolve(process.cwd(), ".env");
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

export function readEnvFile(): Record<string, string> {
  const settings: Record<string, string> = {};
  if (!existsSync(envFilePath)) return settings;

  const lines = readFileSync(envFilePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    settings[key] = value;
  }
  return settings;
}

export function writeEnvFile(newSettings: EnvSettings): void {
  const currentSettings = readEnvFile();
  for (const key of REMOVED_SETTINGS_KEYS) {
    delete currentSettings[key];
  }
  const mergedSettings = { ...currentSettings, ...newSettings };
  
  let content = "";
  for (const [key, value] of Object.entries(mergedSettings)) {
    content += `${key}=${value}\n`;
  }
  
  const tempFile = `${envFilePath}.tmp`;
  writeFileSync(tempFile, content.trim(), "utf8");
  try {
    renameSync(tempFile, envFilePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY") {
      writeFileSync(envFilePath, content.trim(), "utf8");
      try { unlinkSync(tempFile); } catch { /* cleanup */ }
    } else {
      throw err;
    }
  }
}
