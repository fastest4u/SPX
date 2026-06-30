import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INITIAL_SETTINGS_FORM,
  validateNumericFields,
} from "../src/frontend/lib/settings-shared.js";
import { getAppSettingDefaults } from "../src/config/config-catalog.js";
import { SETTINGS_KEYS } from "../src/services/settings.js";

const cooldownDisabled = validateNumericFields({
  ...INITIAL_SETTINGS_FORM,
  BOOKING_REPROCESS_COOLDOWN_MS: "0",
});

assert.deepEqual(cooldownDisabled.errors, {});
assert.equal(cooldownDisabled.sanitized.BOOKING_REPROCESS_COOLDOWN_MS, "0");

const invalidConcurrency = validateNumericFields({
  ...INITIAL_SETTINGS_FORM,
  BOOKING_DETAIL_CONCURRENCY: "0",
});

assert.equal(
  invalidConcurrency.errors.BOOKING_DETAIL_CONCURRENCY,
  "ต้องเป็นจำนวนเต็มบวก",
);

const dbFirstDefaults = getAppSettingDefaults();

for (const [key, expectedValue] of Object.entries(dbFirstDefaults)) {
  assert.equal(
    INITIAL_SETTINGS_FORM[key as keyof typeof INITIAL_SETTINGS_FORM],
    expectedValue,
    `${key} should have the DB-first frontend default`,
  );
}

const requiredNumericSettings = [
  "BIDDING_PAGE_NO",
  "BIDDING_PAGE_COUNT",
  "REQUEST_CTIME_START",
  "NOTIFY_MIN_TRIPS",
  "NOTIFIER_REQUEST_TIMEOUT_MS",
  "NOTIFIER_RETRY_MAX_ATTEMPTS",
  "NOTIFIER_RETRY_BASE_DELAY_MS",
  "CODEX_IMAGE_TIMEOUT_MS",
  "CODEX_IMAGE_MAX_BYTES",
] as const;

for (const key of requiredNumericSettings) {
  const belowMinimum = validateNumericFields({
    ...INITIAL_SETTINGS_FORM,
    [key]: key === "REQUEST_CTIME_START" ? "-1" : "0",
  });
  assert.ok(belowMinimum.errors[key], `${key} should reject values below its minimum`);

  const empty = validateNumericFields({
    ...INITIAL_SETTINGS_FORM,
    [key]: "",
  });
  assert.ok(empty.errors[key], `${key} should be required`);
}

for (const teamSpecificKey of [
  "COOKIE",
  "DEVICE_ID",
  "LINE_USER_ID",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE",
] as const) {
  assert.equal(SETTINGS_KEYS.includes(teamSpecificKey), false, `${teamSpecificKey} must be configured per team, not as a global setting`);
}

for (const globalDbKey of [
  "APP_NAME",
  "REFERER",
  "AUTO_ACCEPT_ENABLED",
  "HTTP_ENABLED",
  "JWT_SECRET",
  "COOKIE_SECRET",
  "NOTIFIER_SHARED_SECRET",
] as const) {
  assert.equal(SETTINGS_KEYS.includes(globalDbKey), true, `${globalDbKey} must be configured through app_settings`);
}

const settingsControllerSource = readFileSync(resolve(process.cwd(), "src/controllers/settings-controller.ts"), "utf8");
const frontendApiSource = readFileSync(resolve(process.cwd(), "src/frontend/lib/api.ts"), "utf8");
const settingsSharedSource = readFileSync(resolve(process.cwd(), "src/frontend/lib/settings-shared.tsx"), "utf8");
for (const dbFirstUiKey of [
  "APP_NAME",
  "REFERER",
  "AUTO_ACCEPT_ENABLED",
  "HTTP_ENABLED",
  "NOTIFIER_SHARED_SECRET",
  "JWT_SECRET",
  "COOKIE_SECRET",
] as const) {
  assert.match(settingsControllerSource, new RegExp(`${dbFirstUiKey}`), `${dbFirstUiKey} must be exposed by settings controller`);
}

assert.match(
  frontendApiSource,
  /getDetailed:\s*async\s*\(\):\s*Promise<SettingsResponse>/,
  "settingsApi.getDetailed must preserve SettingsResponse metadata",
);
assert.match(
  settingsSharedSource,
  /queryFn:\s*settingsApi\.getDetailed/,
  "SettingsFormProvider must query the detailed settings response",
);
assert.match(
  settingsSharedSource,
  /reloadBehavior/,
  "SettingsFormProvider must retain reloadBehavior metadata in context",
);
assert.doesNotMatch(
  settingsSharedSource,
  /บันทึกการตั้งค่าแล้ว มีผลทันที/,
  "Settings save toast must not claim every setting applies live",
);
assert.match(
  settingsSharedSource,
  /restart-worker|restart-process|รีสตาร์ท/,
  "Settings UI must tell operators that some settings need worker or process restart",
);

const visibleDbFirstSettings = [
  "APP_NAME",
  "REFERER",
  "DEBUG",
  "FETCH_DETAILS",
  "SAVE_TO_DB",
  "BIDDING_PAGE_NO",
  "BIDDING_PAGE_COUNT",
  "REQUEST_TAB_PENDING_CONFIRMATION",
  "REQUEST_CTIME_START",
  "AUTO_ACCEPT_ENABLED",
  "HTTP_ENABLED",
  "HTTP_ALLOWED_ORIGINS",
  "HTTP_TRUST_PROXY",
  "JWT_SECRET",
  "COOKIE_SECRET",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "ADMIN_ROLE",
  "NOTIFY_ENABLED",
  "NOTIFY_MODE",
  "NOTIFY_ORIGINS",
  "NOTIFY_DESTINATIONS",
  "NOTIFY_VEHICLE_TYPES",
  "NOTIFY_MIN_TRIPS",
  "LINE_IMAGE_LISTENER_CHAT_ID",
  "NOTIFIER_SHARED_SECRET",
  "NOTIFIER_AUTH_MODE",
  "NOTIFIER_REQUEST_TIMEOUT_MS",
  "NOTIFIER_RETRY_MAX_ATTEMPTS",
  "NOTIFIER_RETRY_BASE_DELAY_MS",
  "CODEX_IMAGE_MODEL",
  "CODEX_IMAGE_TIMEOUT_MS",
  "CODEX_IMAGE_MAX_BYTES",
] as const;

for (const key of visibleDbFirstSettings) {
  assert.match(
    settingsSharedSource,
    new RegExp(`key:\\s*["']${key}["'],\\s*label:\\s*["'][^"']+["']`),
    `${key} must have a visible settings field descriptor with a label`,
  );
}
