export type AppSettingReload = "live" | "restart-worker" | "restart-process";

export interface AppSettingMetadata {
  readonly key: string;
  readonly defaultValue: string;
  readonly secret: boolean;
  readonly reload: AppSettingReload;
}

export const BOOTSTRAP_ENV_KEYS = [
  "NODE_ENV",
  "DB_MODE",
  "DB_HOST",
  "DB_PORT",
  "DB_USERNAME",
  "DB_PASSWORD",
  "DB_NAME",
  "SECRETS_KEY",
] as const;

export const PROCESS_ENV_KEYS = [
  "SPX_ROLE",
  "SPX_NODE_ID",
  "SPX_NODE_NAME",
  "RUN_TEAM_IDS",
  "NOTIFIER_API_URL",
  "NOTIFIER_LOCAL_SPOOL_PATH",
  "HTTP_ENABLED",
  "HTTP_PORT",
  "LINE_SERVICE_URL",
  "LINE_SERVICE_SEND_SECRET",
  "LINE_SERVICE_ADMIN_SECRET",
  "LINE_SERVICE_REQUEST_TIMEOUT_MS",
  "OCR_SERVICE_URL",
  "OCR_SERVICE_REQUEST_TIMEOUT_MS",
] as const;

const APP_SETTING_METADATA = [
  { key: "API_URL", defaultValue: "", secret: false, reload: "restart-worker" },
  { key: "APP_NAME", defaultValue: "", secret: false, reload: "restart-worker" },
  { key: "REFERER", defaultValue: "", secret: false, reload: "restart-worker" },
  { key: "DEBUG", defaultValue: "false", secret: false, reload: "live" },
  { key: "FETCH_DETAILS", defaultValue: "false", secret: false, reload: "live" },
  { key: "SAVE_TO_DB", defaultValue: "true", secret: false, reload: "live" },
  { key: "POLL_INTERVAL_MS", defaultValue: "30000", secret: false, reload: "live" },
  { key: "BOOKING_DETAIL_CONCURRENCY", defaultValue: "8", secret: false, reload: "live" },
  { key: "BOOKING_REPROCESS_COOLDOWN_MS", defaultValue: "10000", secret: false, reload: "live" },
  { key: "BIDDING_PAGE_NO", defaultValue: "1", secret: false, reload: "live" },
  { key: "BIDDING_PAGE_COUNT", defaultValue: "100", secret: false, reload: "live" },
  { key: "REQUEST_TAB_PENDING_CONFIRMATION", defaultValue: "true", secret: false, reload: "live" },
  { key: "REQUEST_CTIME_START", defaultValue: "1776358800", secret: false, reload: "live" },
  { key: "BIDDING_VEHICLE_TYPE", defaultValue: "13", secret: false, reload: "live" },
  { key: "NOTIFY_ENABLED", defaultValue: "true", secret: false, reload: "live" },
  { key: "NOTIFY_MODE", defaultValue: "batch", secret: false, reload: "live" },
  { key: "NOTIFY_ORIGINS", defaultValue: "", secret: false, reload: "live" },
  { key: "NOTIFY_DESTINATIONS", defaultValue: "", secret: false, reload: "live" },
  { key: "NOTIFY_VEHICLE_TYPES", defaultValue: "", secret: false, reload: "live" },
  { key: "NOTIFY_MIN_TRIPS", defaultValue: "1", secret: false, reload: "live" },
  { key: "AUTO_ACCEPT_ENABLED", defaultValue: "false", secret: false, reload: "live" },
  { key: "HTTP_ALLOWED_ORIGINS", defaultValue: "", secret: false, reload: "restart-process" },
  { key: "HTTP_TRUST_PROXY", defaultValue: "false", secret: false, reload: "restart-process" },
  { key: "JWT_SECRET", defaultValue: "", secret: true, reload: "restart-process" },
  { key: "COOKIE_SECRET", defaultValue: "", secret: true, reload: "restart-process" },
  { key: "ADMIN_USERNAME", defaultValue: "admin", secret: false, reload: "restart-process" },
  { key: "ADMIN_PASSWORD", defaultValue: "", secret: true, reload: "restart-process" },
  { key: "ADMIN_ROLE", defaultValue: "admin", secret: false, reload: "restart-process" },
  { key: "LINE_CHANNEL_ACCESS_TOKEN", defaultValue: "", secret: true, reload: "live" },
  { key: "LINEJS_TEST_ENABLED", defaultValue: "false", secret: false, reload: "restart-process" },
  { key: "LINEJS_TEST_TARGET_ID", defaultValue: "", secret: true, reload: "live" },
  { key: "LINEJS_TEST_DEVICE", defaultValue: "IOSIPAD", secret: false, reload: "restart-process" },
  {
    key: "LINEJS_TEST_STORAGE_PATH",
    defaultValue: "data/linejs-storage.json",
    secret: false,
    reload: "restart-process",
  },
  { key: "DISCORD_WEBHOOK_URL", defaultValue: "", secret: true, reload: "live" },
  { key: "LINE_IMAGE_LISTENER_CHAT_ID", defaultValue: "", secret: true, reload: "restart-process" },
  { key: "NOTIFIER_SHARED_SECRET", defaultValue: "", secret: true, reload: "restart-process" },
  { key: "NOTIFIER_AUTH_MODE", defaultValue: "hmac", secret: false, reload: "restart-process" },
  { key: "NOTIFIER_REQUEST_TIMEOUT_MS", defaultValue: "1500", secret: false, reload: "live" },
  { key: "NOTIFIER_RETRY_MAX_ATTEMPTS", defaultValue: "12", secret: false, reload: "live" },
  { key: "NOTIFIER_RETRY_BASE_DELAY_MS", defaultValue: "1000", secret: false, reload: "live" },
  { key: "CODEX_IMAGE_MODEL", defaultValue: "", secret: false, reload: "live" },
  { key: "CODEX_IMAGE_PROVIDER", defaultValue: "auto", secret: false, reload: "live" },
  { key: "CODEX_IMAGE_TIMEOUT_MS", defaultValue: "300000", secret: false, reload: "live" },
  {
    key: "CODEX_IMAGE_MAX_BYTES",
    defaultValue: String(10 * 1024 * 1024),
    secret: false,
    reload: "live",
  },
] as const satisfies readonly AppSettingMetadata[];

export type AppSettingKey = (typeof APP_SETTING_METADATA)[number]["key"];
export type BootstrapEnvKey = (typeof BOOTSTRAP_ENV_KEYS)[number];
export type ProcessEnvKey = (typeof PROCESS_ENV_KEYS)[number];
export type AppSettings = Partial<Record<AppSettingKey, string>>;

export const APP_SETTING_KEYS: readonly AppSettingKey[] = Object.freeze(
  APP_SETTING_METADATA.map((item) => item.key),
);
const SECRET_APP_SETTING_KEY_SET = new Set<AppSettingKey>(
  APP_SETTING_METADATA.filter((item) => item.secret).map((item) => item.key),
);
export const SECRET_APP_SETTING_KEYS: ReadonlySet<AppSettingKey> = SECRET_APP_SETTING_KEY_SET;

const METADATA_BY_KEY = new Map<string, AppSettingMetadata>(
  APP_SETTING_METADATA.map((item) => [item.key, item]),
);

export function getAppSettingMetadata(key: AppSettingKey): AppSettingMetadata {
  const metadata = METADATA_BY_KEY.get(key);
  if (!metadata) throw new Error(`Unknown app setting key: ${key}`);
  return { ...metadata };
}

export function getAppSettingDefaults(): Record<AppSettingKey, string> {
  return Object.fromEntries(
    APP_SETTING_METADATA.map((item) => [item.key, item.defaultValue]),
  ) as Record<AppSettingKey, string>;
}

export function pickAppSettings(settings: Record<string, string>): AppSettings {
  const result: AppSettings = {};
  for (const key of APP_SETTING_KEYS) {
    const value = settings[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}
