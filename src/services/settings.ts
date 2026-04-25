import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const envFilePath = resolve(process.cwd(), ".env");

export const SETTINGS_KEYS = [
  "API_URL",
  "COOKIE",
  "DEVICE_ID",
  "LINE_NOTIFY_TOKEN",
  "DISCORD_WEBHOOK_URL",
  "POLL_INTERVAL_MS",
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
  const mergedSettings = { ...currentSettings, ...newSettings };
  
  let content = "";
  for (const [key, value] of Object.entries(mergedSettings)) {
    content += `${key}=${value}\n`;
  }
  
  const tempFile = `${envFilePath}.tmp`;
  writeFileSync(tempFile, content.trim(), "utf8");
  renameSync(tempFile, envFilePath);
}
