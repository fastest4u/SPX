import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  APP_SETTING_KEYS,
  BOOTSTRAP_ENV_KEYS,
  PROCESS_ENV_KEYS,
  SECRET_APP_SETTING_KEYS,
  getAppSettingDefaults,
  getAppSettingMetadata,
  pickAppSettings,
} from "../src/config/config-catalog.js";

assert.equal(new Set(APP_SETTING_KEYS).size, APP_SETTING_KEYS.length);
assert.equal(Object.isFrozen(APP_SETTING_KEYS), true);
assert.equal(BOOTSTRAP_ENV_KEYS.includes("DB_HOST"), true);
assert.equal(BOOTSTRAP_ENV_KEYS.includes("SECRETS_KEY"), true);
const processEnvKeys = PROCESS_ENV_KEYS as readonly string[];
const appSettingKeys = APP_SETTING_KEYS as readonly string[];
assert.equal(processEnvKeys.includes("SPX_ROLE"), true);
assert.equal(processEnvKeys.includes("SPX_NODE_ID"), true);
assert.equal(processEnvKeys.includes("SPX_NODE_NAME"), true);
assert.equal(processEnvKeys.includes("RUN_TEAM_IDS"), true);
assert.equal(processEnvKeys.includes("NOTIFIER_API_URL"), true);
assert.equal(processEnvKeys.includes("NOTIFIER_LOCAL_SPOOL_PATH"), true);
assert.equal(processEnvKeys.includes("HTTP_ENABLED"), true);
assert.equal(processEnvKeys.includes("HTTP_PORT"), true);
assert.equal(processEnvKeys.includes("LINE_SERVICE_URL"), true);
assert.equal(processEnvKeys.includes("LINE_SERVICE_SEND_SECRET"), true);
assert.equal(processEnvKeys.includes("OCR_SERVICE_URL"), true);
assert.equal(processEnvKeys.includes("LINE_SERVICE_REQUEST_TIMEOUT_MS"), true);
assert.equal(processEnvKeys.includes("OCR_SERVICE_REQUEST_TIMEOUT_MS"), true);
assert.equal(appSettingKeys.includes("API_URL"), true);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_ENABLED"), true);
assert.equal(appSettingKeys.includes("JWT_SECRET"), true);
assert.equal(appSettingKeys.includes("COOKIE_SECRET"), true);
assert.equal(appSettingKeys.includes("NOTIFIER_SHARED_SECRET"), true);
assert.equal(appSettingKeys.includes("HTTP_ENABLED"), false);
assert.equal(appSettingKeys.includes("LINE_SERVICE_URL"), false);
assert.equal(appSettingKeys.includes("LINE_SERVICE_SEND_SECRET"), false);
assert.equal(appSettingKeys.includes("OCR_SERVICE_URL"), false);
assert.equal(appSettingKeys.includes("LINE_SERVICE_REQUEST_TIMEOUT_MS"), false);
assert.equal(appSettingKeys.includes("OCR_SERVICE_REQUEST_TIMEOUT_MS"), false);
assert.equal(appSettingKeys.includes("COOKIE"), false);
assert.equal(appSettingKeys.includes("DEVICE_ID"), false);
assert.equal(SECRET_APP_SETTING_KEYS.has("JWT_SECRET"), true);
assert.equal(SECRET_APP_SETTING_KEYS.has("COOKIE_SECRET"), true);
assert.equal(SECRET_APP_SETTING_KEYS.has("NOTIFIER_SHARED_SECRET"), true);

const defaults = getAppSettingDefaults();
assert.equal(defaults.POLL_INTERVAL_MS, "30000");
assert.equal(defaults.BOOKING_DETAIL_CONCURRENCY, "8");
assert.equal(defaults.AUTO_ACCEPT_ENABLED, "false");
assert.equal(Object.hasOwn(defaults, "HTTP_ENABLED"), false);

const apiUrl = getAppSettingMetadata("API_URL");
assert.equal(apiUrl.reload, "restart-worker");
assert.equal(apiUrl.secret, false);
assert.notStrictEqual(apiUrl, getAppSettingMetadata("API_URL"));

const jwt = getAppSettingMetadata("JWT_SECRET");
assert.equal(jwt.reload, "restart-process");
assert.equal(jwt.secret, true);

const picked = pickAppSettings({
  API_URL: "https://example.test",
  AUTO_ACCEPT_ENABLED: "true",
  JWT_SECRET: "jwt-value",
  DB_HOST: "localhost",
  SPX_ROLE: "worker",
  UNKNOWN_SETTING: "ignored",
});
assert.deepEqual(picked, {
  API_URL: "https://example.test",
  AUTO_ACCEPT_ENABLED: "true",
  JWT_SECRET: "jwt-value",
});

const appSource = readFileSync(resolve(process.cwd(), "src/app.ts"), "utf8");
assert.match(
  appSource,
  /await loadDbFirstSettingsIntoEnv\(\)/,
  "app startup must load DB-first settings before validation",
);
assert.match(
  appSource,
  /validateRuntimeConfig\(\)/,
  "app startup must still validate runtime config",
);
assert.ok(
  appSource.indexOf("await loadDbFirstSettingsIntoEnv()") <
    appSource.indexOf("validateRuntimeConfig()"),
  "DB-first settings must load before validateRuntimeConfig",
);
assert.doesNotMatch(
  appSource,
  /migrateEnvSettingsToDb\(\)[\s\S]*loadDbSettingsIntoEnv\(\)/,
  "app startup should use loadDbFirstSettingsIntoEnv instead of wiring migration/load directly",
);

process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "db-first-config-test-key";

async function assertRepositoryUsesCatalogSecrets(): Promise<void> {
  const { upsertAppSettings, getAppSettings } =
    await import("../src/repositories/app-settings-repository.js");
  const { resetMemoryDb, getRawMemoryDb } = await import("../src/db/client-memory.js");
  resetMemoryDb();

  await upsertAppSettings({
    JWT_SECRET: "x".repeat(40),
    NOTIFIER_SHARED_SECRET: "notifier-secret-value",
    API_URL: "https://spx.example.test/booking/bidding/list",
    COOKIE: "legacy-cookie-value",
  });

  const db = getRawMemoryDb();
  const rawRows = db.prepare("SELECT setting_key, setting_value FROM app_settings").all() as Array<{
    setting_key: string;
    setting_value: string;
  }>;
  const rawJwt = rawRows.find((row) => row.setting_key === "JWT_SECRET")?.setting_value ?? "";
  const rawNotifier =
    rawRows.find((row) => row.setting_key === "NOTIFIER_SHARED_SECRET")?.setting_value ?? "";
  const rawApi = rawRows.find((row) => row.setting_key === "API_URL")?.setting_value ?? "";
  const rawCookie = rawRows.find((row) => row.setting_key === "COOKIE")?.setting_value ?? "";

  assert.notEqual(rawJwt, "x".repeat(40));
  assert.notEqual(rawNotifier, "notifier-secret-value");
  assert.equal(rawApi, "https://spx.example.test/booking/bidding/list");
  assert.notEqual(rawCookie, "legacy-cookie-value");

  const decoded = await getAppSettings([
    "JWT_SECRET",
    "NOTIFIER_SHARED_SECRET",
    "API_URL",
    "COOKIE",
  ]);
  assert.equal(decoded.JWT_SECRET, "x".repeat(40));
  assert.equal(decoded.NOTIFIER_SHARED_SECRET, "notifier-secret-value");
  assert.equal(decoded.API_URL, "https://spx.example.test/booking/bidding/list");
  assert.equal(decoded.COOKIE, "legacy-cookie-value");
}

async function assertSettingsServiceUsesCatalogSettings(): Promise<void> {
  const { closePool } = await import("../src/db/client.js");
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  await closePool();
  resetMemoryDb();

  const { upsertAppSettings, getAppSettings } =
    await import("../src/repositories/app-settings-repository.js");
  const { env } = await import("../src/config/env.js");
  const settings = await import("../src/services/settings.js");

  process.env.API_URL = "https://env.example.test/booking/bidding/list";
  process.env.APP_NAME = "Env App";
  process.env.REFERER = "https://env.example.test/";
  process.env.JWT_SECRET = "j".repeat(40);
  process.env.COOKIE_SECRET = "c".repeat(40);
  process.env.ADMIN_PASSWORD = "admin-password-123";
  process.env.NOTIFIER_SHARED_SECRET = "notifier-from-env";
  process.env.SPX_ROLE = "worker";
  process.env.SPX_NODE_ID = "env-worker-01";
  process.env.SPX_NODE_NAME = "Env Worker 01";
  process.env.RUN_TEAM_IDS = "7,8";
  process.env.NOTIFIER_API_URL =
    "http://env-notification-service:3002/internal/notification-events";
  process.env.NOTIFIER_LOCAL_SPOOL_PATH = "data/env-notification-spool.jsonl";
  process.env.HTTP_ENABLED = "false";
  process.env.HTTP_PORT = "4321";
  process.env.LINE_SERVICE_URL = "http://env-line-service:3003";
  process.env.LINE_SERVICE_SEND_SECRET = "env-line-send-secret";
  process.env.LINE_SERVICE_ADMIN_SECRET = "env-line-admin-secret";
  process.env.OCR_SERVICE_URL = "http://env-ocr-service:3004";
  process.env.LINE_SERVICE_REQUEST_TIMEOUT_MS = "1234";
  process.env.OCR_SERVICE_REQUEST_TIMEOUT_MS = "5678";

  await settings.migrateEnvSettingsToDb();
  await settings.loadDbSettingsIntoEnv();

  assert.equal(process.env.API_URL, "https://env.example.test/booking/bidding/list");
  assert.equal(process.env.APP_NAME, "Env App");
  assert.equal(process.env.NOTIFIER_SHARED_SECRET, "notifier-from-env");
  assert.equal(process.env.SPX_ROLE, "worker");
  assert.equal(process.env.SPX_NODE_ID, "env-worker-01");
  assert.equal(process.env.SPX_NODE_NAME, "Env Worker 01");
  assert.equal(process.env.RUN_TEAM_IDS, "7,8");
  assert.equal(
    process.env.NOTIFIER_API_URL,
    "http://env-notification-service:3002/internal/notification-events",
  );
  assert.equal(process.env.NOTIFIER_LOCAL_SPOOL_PATH, "data/env-notification-spool.jsonl");
  assert.equal(process.env.HTTP_ENABLED, "false");
  assert.equal(process.env.HTTP_PORT, "4321");
  assert.equal(process.env.LINE_SERVICE_URL, "http://env-line-service:3003");
  assert.equal(process.env.LINE_SERVICE_SEND_SECRET, "env-line-send-secret");
  assert.equal(process.env.LINE_SERVICE_ADMIN_SECRET, "env-line-admin-secret");
  assert.equal(process.env.OCR_SERVICE_URL, "http://env-ocr-service:3004");
  assert.equal(process.env.LINE_SERVICE_REQUEST_TIMEOUT_MS, "1234");
  assert.equal(process.env.OCR_SERVICE_REQUEST_TIMEOUT_MS, "5678");
  assert.equal(env.API_URL, "https://env.example.test/booking/bidding/list");
  assert.equal(env.APP_NAME, "Env App");
  assert.equal(env.NOTIFIER_SHARED_SECRET, "notifier-from-env");
  assert.equal(env.SPX_ROLE, "worker");
  assert.equal(env.SPX_NODE_ID, "env-worker-01");
  assert.equal(env.SPX_NODE_NAME, "Env Worker 01");
  assert.deepEqual(env.RUN_TEAM_IDS, [7, 8]);
  assert.equal(
    env.NOTIFIER_API_URL,
    "http://env-notification-service:3002/internal/notification-events",
  );
  assert.equal(env.NOTIFIER_LOCAL_SPOOL_PATH, "data/env-notification-spool.jsonl");
  assert.equal(env.HTTP_ENABLED, false);
  assert.equal(env.HTTP_PORT, 4321);
  assert.equal(env.LINE_SERVICE_URL, "http://env-line-service:3003");
  assert.equal(env.LINE_SERVICE_SEND_SECRET, "env-line-send-secret");
  assert.equal(env.LINE_SERVICE_ADMIN_SECRET, "env-line-admin-secret");
  assert.equal(env.OCR_SERVICE_URL, "http://env-ocr-service:3004");
  assert.equal(env.LINE_SERVICE_REQUEST_TIMEOUT_MS, 1234);
  assert.equal(env.OCR_SERVICE_REQUEST_TIMEOUT_MS, 5678);

  const storedAfterSeed = await getAppSettings([
    "API_URL",
    "APP_NAME",
    "NOTIFIER_SHARED_SECRET",
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
    "OCR_SERVICE_URL",
    "LINE_SERVICE_REQUEST_TIMEOUT_MS",
    "OCR_SERVICE_REQUEST_TIMEOUT_MS",
  ]);
  assert.equal(storedAfterSeed.API_URL, "https://env.example.test/booking/bidding/list");
  assert.equal(storedAfterSeed.APP_NAME, "Env App");
  assert.equal(storedAfterSeed.NOTIFIER_SHARED_SECRET, "notifier-from-env");
  assert.equal(storedAfterSeed.SPX_ROLE, undefined);
  assert.equal(storedAfterSeed.SPX_NODE_ID, undefined);
  assert.equal(storedAfterSeed.SPX_NODE_NAME, undefined);
  assert.equal(storedAfterSeed.RUN_TEAM_IDS, undefined);
  assert.equal(storedAfterSeed.NOTIFIER_API_URL, undefined);
  assert.equal(storedAfterSeed.NOTIFIER_LOCAL_SPOOL_PATH, undefined);
  assert.equal(storedAfterSeed.HTTP_ENABLED, undefined);
  assert.equal(storedAfterSeed.HTTP_PORT, undefined);
  assert.equal(storedAfterSeed.LINE_SERVICE_URL, undefined);
  assert.equal(storedAfterSeed.LINE_SERVICE_SEND_SECRET, undefined);
  assert.equal(storedAfterSeed.LINE_SERVICE_ADMIN_SECRET, undefined);
  assert.equal(storedAfterSeed.OCR_SERVICE_URL, undefined);
  assert.equal(storedAfterSeed.LINE_SERVICE_REQUEST_TIMEOUT_MS, undefined);
  assert.equal(storedAfterSeed.OCR_SERVICE_REQUEST_TIMEOUT_MS, undefined);

  await upsertAppSettings({
    API_URL: "https://db.example.test/booking/bidding/list",
    APP_NAME: "DB App",
    REFERER: "https://db.example.test/",
    SPX_ROLE: "api",
    SPX_NODE_ID: "db-node-should-not-win",
    SPX_NODE_NAME: "DB Node",
    RUN_TEAM_IDS: "1",
    NOTIFIER_API_URL: "http://db-notification-service:3002/internal/notification-events",
    NOTIFIER_LOCAL_SPOOL_PATH: "data/db-spool.jsonl",
    HTTP_ENABLED: "true",
    HTTP_PORT: "9999",
    LINE_SERVICE_URL: "http://db-line-service:3003",
    LINE_SERVICE_SEND_SECRET: "db-line-send-secret",
    LINE_SERVICE_ADMIN_SECRET: "db-line-admin-secret",
    OCR_SERVICE_URL: "http://db-ocr-service:3004",
    LINE_SERVICE_REQUEST_TIMEOUT_MS: "9999",
    OCR_SERVICE_REQUEST_TIMEOUT_MS: "8888",
  });
  await settings.loadDbSettingsIntoEnv();
  assert.equal(process.env.API_URL, "https://db.example.test/booking/bidding/list");
  assert.equal(process.env.APP_NAME, "DB App");
  assert.equal(process.env.REFERER, "https://db.example.test/");
  assert.equal(process.env.SPX_ROLE, "worker");
  assert.equal(process.env.SPX_NODE_ID, "env-worker-01");
  assert.equal(process.env.SPX_NODE_NAME, "Env Worker 01");
  assert.equal(process.env.RUN_TEAM_IDS, "7,8");
  assert.equal(
    process.env.NOTIFIER_API_URL,
    "http://env-notification-service:3002/internal/notification-events",
  );
  assert.equal(process.env.NOTIFIER_LOCAL_SPOOL_PATH, "data/env-notification-spool.jsonl");
  assert.equal(process.env.HTTP_ENABLED, "false");
  assert.equal(process.env.HTTP_PORT, "4321");
  assert.equal(process.env.LINE_SERVICE_URL, "http://env-line-service:3003");
  assert.equal(process.env.LINE_SERVICE_SEND_SECRET, "env-line-send-secret");
  assert.equal(process.env.LINE_SERVICE_ADMIN_SECRET, "env-line-admin-secret");
  assert.equal(process.env.OCR_SERVICE_URL, "http://env-ocr-service:3004");
  assert.equal(process.env.LINE_SERVICE_REQUEST_TIMEOUT_MS, "1234");
  assert.equal(process.env.OCR_SERVICE_REQUEST_TIMEOUT_MS, "5678");
  assert.equal(env.API_URL, "https://db.example.test/booking/bidding/list");
  assert.equal(env.APP_NAME, "DB App");
  assert.equal(env.REFERER, "https://db.example.test/");
  assert.equal(env.SPX_ROLE, "worker");
  assert.equal(env.SPX_NODE_ID, "env-worker-01");
  assert.equal(env.SPX_NODE_NAME, "Env Worker 01");
  assert.deepEqual(env.RUN_TEAM_IDS, [7, 8]);
  assert.equal(
    env.NOTIFIER_API_URL,
    "http://env-notification-service:3002/internal/notification-events",
  );
  assert.equal(env.NOTIFIER_LOCAL_SPOOL_PATH, "data/env-notification-spool.jsonl");
  assert.equal(env.HTTP_ENABLED, false);
  assert.equal(env.HTTP_PORT, 4321);
  assert.equal(env.LINE_SERVICE_URL, "http://env-line-service:3003");
  assert.equal(env.LINE_SERVICE_SEND_SECRET, "env-line-send-secret");
  assert.equal(env.LINE_SERVICE_ADMIN_SECRET, "env-line-admin-secret");
  assert.equal(env.OCR_SERVICE_URL, "http://env-ocr-service:3004");
  assert.equal(env.LINE_SERVICE_REQUEST_TIMEOUT_MS, 1234);
  assert.equal(env.OCR_SERVICE_REQUEST_TIMEOUT_MS, 5678);

  await upsertAppSettings({
    NOTIFIER_REQUEST_TIMEOUT_MS: "bad",
  });

  await assert.rejects(
    () => settings.loadDbSettingsIntoEnv(),
    /NOTIFIER_REQUEST_TIMEOUT_MS must be a positive integer/,
  );
  assert.equal(process.env.API_URL, "https://db.example.test/booking/bidding/list");
  assert.equal(process.env.APP_NAME, "DB App");
  assert.equal(process.env.REFERER, "https://db.example.test/");
  assert.equal(process.env.NOTIFIER_REQUEST_TIMEOUT_MS, "1500");
  assert.equal(env.API_URL, "https://db.example.test/booking/bidding/list");
  assert.equal(env.APP_NAME, "DB App");
  assert.equal(env.REFERER, "https://db.example.test/");
  assert.equal(env.NOTIFIER_REQUEST_TIMEOUT_MS, 1500);
}

async function main(): Promise<void> {
  await assertRepositoryUsesCatalogSecrets();
  await assertSettingsServiceUsesCatalogSettings();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .then(() => {
    if (!process.exitCode) {
      console.log("db-first-config: catalog assertions passed");
    }
  });
