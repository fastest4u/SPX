# DB-First Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SPX production config DB-first so `.env` contains only bootstrap and process identity values.

**Architecture:** Add one typed config catalog that declares every setting key, default, secrecy, storage scope, and reload behavior. Startup connects to DB first, seeds missing DB rows from existing env values once, loads DB rows into the mutable runtime config, then validates and starts HTTP/notifier/workers. Team credentials and LINE targets remain team-scoped and encrypted in `teams`.

**Tech Stack:** Node 24, TypeScript NodeNext, Fastify, Drizzle ORM, MySQL, SQLite memory tests, React 19, TanStack Query.

---

## File Structure

- Create `src/config/config-catalog.ts`: setting metadata, default values, secret key list, reload behavior, and helpers.
- Modify `src/config/env.ts`: split bootstrap/process env parsing from DB-loaded runtime values; keep exported `env` mutable through existing live reload pattern.
- Modify `src/services/settings.ts`: load all DB-first settings, seed missing rows from env, apply settings to `process.env` and `env`, and expose reload behavior.
- Modify `src/repositories/app-settings-repository.ts`: use catalog secret metadata for encryption instead of a local hard-coded set.
- Modify `src/app.ts`: always load DB-first settings before full runtime validation when DB is configured.
- Modify `src/db/schema.ts`, `src/db/client.ts`, `src/db/client-memory.ts`, `src/db/migration-sql.ts`, `migrations/001_create_booking_requests.sql`, and add a new migration under `migrations/`: add team success/failure LINE target columns.
- Modify `src/repositories/team-repository.ts`: support encrypted team success/failure LINE target values.
- Modify `src/controllers/teams-controller.ts`: accept and validate new team target fields.
- Modify `src/controllers/settings-controller.ts`: expose expanded global settings and reload behavior while redacting secrets.
- Modify `src/frontend/types/index.ts`, `src/frontend/lib/api.ts`, `src/frontend/lib/settings-shared.tsx`, and `src/frontend/routes/teams.tsx`: update forms and types for DB-first settings and team targets.
- Modify `docs/env-reference.md`, `docs/deployment.md`, and `docker-compose.yml`: document and apply the reduced env model.
- Add or modify tests under `tests/`: `settings-validation.test.ts`, `team-repository.test.ts`, `schema-consistency.test.ts`, and a new `db-first-config.test.ts`.

## Task 1: Add Config Catalog

**Files:**
- Create: `src/config/config-catalog.ts`
- Test: `tests/db-first-config.test.ts`

- [ ] **Step 1: Write the catalog test**

Create `tests/db-first-config.test.ts` with this content:

```ts
import assert from "node:assert/strict";
import {
  APP_SETTING_KEYS,
  BOOTSTRAP_ENV_KEYS,
  PROCESS_ENV_KEYS,
  SECRET_APP_SETTING_KEYS,
  getAppSettingDefaults,
  getAppSettingMetadata,
} from "../src/config/config-catalog.js";

assert.equal(BOOTSTRAP_ENV_KEYS.includes("DB_HOST"), true);
assert.equal(BOOTSTRAP_ENV_KEYS.includes("SECRETS_KEY"), true);
assert.equal(PROCESS_ENV_KEYS.includes("SPX_ROLE"), true);
assert.equal(PROCESS_ENV_KEYS.includes("RUN_TEAM_IDS"), true);
assert.equal(APP_SETTING_KEYS.includes("API_URL"), true);
assert.equal(APP_SETTING_KEYS.includes("AUTO_ACCEPT_ENABLED"), true);
assert.equal(APP_SETTING_KEYS.includes("JWT_SECRET"), true);
assert.equal(APP_SETTING_KEYS.includes("COOKIE_SECRET"), true);
assert.equal(APP_SETTING_KEYS.includes("NOTIFIER_SHARED_SECRET"), true);
assert.equal(APP_SETTING_KEYS.includes("COOKIE"), false);
assert.equal(APP_SETTING_KEYS.includes("DEVICE_ID"), false);
assert.equal(SECRET_APP_SETTING_KEYS.has("JWT_SECRET"), true);
assert.equal(SECRET_APP_SETTING_KEYS.has("COOKIE_SECRET"), true);
assert.equal(SECRET_APP_SETTING_KEYS.has("NOTIFIER_SHARED_SECRET"), true);

const defaults = getAppSettingDefaults();
assert.equal(defaults.POLL_INTERVAL_MS, "30000");
assert.equal(defaults.BOOKING_DETAIL_CONCURRENCY, "8");
assert.equal(defaults.AUTO_ACCEPT_ENABLED, "false");
assert.equal(defaults.HTTP_ENABLED, "true");

const apiUrl = getAppSettingMetadata("API_URL");
assert.equal(apiUrl.reload, "restart-worker");
assert.equal(apiUrl.secret, false);

const jwt = getAppSettingMetadata("JWT_SECRET");
assert.equal(jwt.reload, "restart-process");
assert.equal(jwt.secret, true);

console.log("db-first-config: catalog assertions passed");
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```powershell
npm test -- db-first-config
```

Expected: FAIL because `src/config/config-catalog.ts` does not exist.

- [ ] **Step 3: Create the catalog**

Create `src/config/config-catalog.ts` with this content:

```ts
export type AppSettingReload = "live" | "restart-worker" | "restart-process";

export interface AppSettingMetadata {
  key: string;
  defaultValue: string;
  secret: boolean;
  reload: AppSettingReload;
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
  "HTTP_PORT",
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
  { key: "AUTO_ACCEPT_ENABLED", defaultValue: "true", secret: false, reload: "live" },
  { key: "HTTP_ENABLED", defaultValue: "true", secret: false, reload: "restart-process" },
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
  { key: "LINEJS_TEST_STORAGE_PATH", defaultValue: "data/linejs-storage.json", secret: false, reload: "restart-process" },
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
  { key: "CODEX_IMAGE_MAX_BYTES", defaultValue: String(10 * 1024 * 1024), secret: false, reload: "live" },
] as const satisfies readonly AppSettingMetadata[];

export type AppSettingKey = typeof APP_SETTING_METADATA[number]["key"];
export type BootstrapEnvKey = typeof BOOTSTRAP_ENV_KEYS[number];
export type ProcessEnvKey = typeof PROCESS_ENV_KEYS[number];
export type AppSettings = Partial<Record<AppSettingKey, string>>;

export const APP_SETTING_KEYS = APP_SETTING_METADATA.map((item) => item.key) as AppSettingKey[];
export const SECRET_APP_SETTING_KEYS = new Set(
  APP_SETTING_METADATA.filter((item) => item.secret).map((item) => item.key),
);

const METADATA_BY_KEY = new Map<string, AppSettingMetadata>(
  APP_SETTING_METADATA.map((item) => [item.key, item]),
);

export function getAppSettingMetadata(key: AppSettingKey): AppSettingMetadata {
  const metadata = METADATA_BY_KEY.get(key);
  if (!metadata) throw new Error(`Unknown app setting key: ${key}`);
  return metadata;
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
```

- [ ] **Step 4: Run the catalog test and confirm it passes**

Run:

```powershell
npm test -- db-first-config
```

Expected: PASS with `db-first-config: catalog assertions passed`.

- [ ] **Step 5: Commit checkpoint when commits are authorized**

Only run this step after the user explicitly authorizes commits:

```powershell
git add src/config/config-catalog.ts tests/db-first-config.test.ts
git commit -m "feat: add DB-first config catalog"
```

## Task 2: Make App Settings Repository Use Catalog Secrets

**Files:**
- Modify: `src/repositories/app-settings-repository.ts`
- Test: `tests/db-first-config.test.ts`

- [ ] **Step 1: Extend the repository test**

Append these assertions to `tests/db-first-config.test.ts`:

```ts
const { upsertAppSettings, getAppSettings } = await import("../src/repositories/app-settings-repository.js");
const { resetMemoryDb, getRawMemoryDb } = await import("../src/db/client-memory.js");

process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "db-first-config-test-key";
resetMemoryDb();

await upsertAppSettings({
  JWT_SECRET: "x".repeat(40),
  NOTIFIER_SHARED_SECRET: "notifier-secret-value",
  API_URL: "https://spx.example.test/booking/bidding/list",
});

const db = getRawMemoryDb();
const rawRows = db.prepare("SELECT setting_key, setting_value FROM app_settings").all() as Array<{ setting_key: string; setting_value: string }>;
const rawJwt = rawRows.find((row) => row.setting_key === "JWT_SECRET")?.setting_value ?? "";
const rawNotifier = rawRows.find((row) => row.setting_key === "NOTIFIER_SHARED_SECRET")?.setting_value ?? "";
const rawApi = rawRows.find((row) => row.setting_key === "API_URL")?.setting_value ?? "";

assert.notEqual(rawJwt, "x".repeat(40));
assert.notEqual(rawNotifier, "notifier-secret-value");
assert.equal(rawApi, "https://spx.example.test/booking/bidding/list");

const decoded = await getAppSettings(["JWT_SECRET", "NOTIFIER_SHARED_SECRET", "API_URL"]);
assert.equal(decoded.JWT_SECRET, "x".repeat(40));
assert.equal(decoded.NOTIFIER_SHARED_SECRET, "notifier-secret-value");
assert.equal(decoded.API_URL, "https://spx.example.test/booking/bidding/list");
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
npm test -- db-first-config
```

Expected: FAIL because the repository still uses its local `SECRET_SETTING_KEYS` set.

- [ ] **Step 3: Replace the local secret set**

In `src/repositories/app-settings-repository.ts`, replace the local `SECRET_SETTING_KEYS` declaration with this import:

```ts
import { SECRET_APP_SETTING_KEYS } from "../config/config-catalog.js";
```

Then update `encodeForStorage` and `decodeFromStorage`:

```ts
function encodeForStorage(key: string, value: string): string {
  if (!SECRET_APP_SETTING_KEYS.has(key)) return value;
  if (!value) return "";
  if (isEncrypted(value)) return value;
  return encryptString(value);
}

function decodeFromStorage(key: string, value: string): string {
  if (!SECRET_APP_SETTING_KEYS.has(key)) return value;
  if (!value) return "";
  return isEncrypted(value) ? decryptString(value) : value;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:

```powershell
npm test -- db-first-config
```

Expected: PASS.

- [ ] **Step 5: Commit checkpoint when commits are authorized**

```powershell
git add src/repositories/app-settings-repository.ts tests/db-first-config.test.ts
git commit -m "refactor: centralize secret setting metadata"
```

## Task 3: Expand DB-Backed Settings Service

**Files:**
- Modify: `src/services/settings.ts`
- Modify: `tests/settings-validation.test.ts`
- Test: `tests/db-first-config.test.ts`

- [ ] **Step 1: Add settings service assertions**

Append this block to `tests/db-first-config.test.ts`:

```ts
const settings = await import("../src/services/settings.js");
resetMemoryDb();

process.env.API_URL = "https://env.example.test/booking/bidding/list";
process.env.APP_NAME = "Env App";
process.env.REFERER = "https://env.example.test/";
process.env.JWT_SECRET = "j".repeat(40);
process.env.COOKIE_SECRET = "c".repeat(40);
process.env.ADMIN_PASSWORD = "admin-password-123";
process.env.NOTIFIER_SHARED_SECRET = "notifier-from-env";

await settings.migrateEnvSettingsToDb();
await settings.loadDbSettingsIntoEnv();

assert.equal(process.env.API_URL, "https://env.example.test/booking/bidding/list");
assert.equal(process.env.APP_NAME, "Env App");
assert.equal(process.env.NOTIFIER_SHARED_SECRET, "notifier-from-env");

const storedAfterSeed = await getAppSettings(["API_URL", "APP_NAME", "NOTIFIER_SHARED_SECRET"]);
assert.equal(storedAfterSeed.API_URL, "https://env.example.test/booking/bidding/list");
assert.equal(storedAfterSeed.APP_NAME, "Env App");
assert.equal(storedAfterSeed.NOTIFIER_SHARED_SECRET, "notifier-from-env");

await upsertAppSettings({
  API_URL: "https://db.example.test/booking/bidding/list",
  APP_NAME: "DB App",
  REFERER: "https://db.example.test/",
});
await settings.loadDbSettingsIntoEnv();
assert.equal(process.env.API_URL, "https://db.example.test/booking/bidding/list");
assert.equal(process.env.APP_NAME, "DB App");
assert.equal(process.env.REFERER, "https://db.example.test/");
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
npm test -- db-first-config
```

Expected: FAIL because `settings.ts` does not include the expanded catalog and does not sync all keys.

- [ ] **Step 3: Update imports and exported types**

In `src/services/settings.ts`, replace local key/default declarations with catalog imports:

```ts
import {
  APP_SETTING_KEYS,
  getAppSettingDefaults,
  pickAppSettings,
  type AppSettingKey,
  type AppSettings,
} from "../config/config-catalog.js";
```

Then define compatibility exports:

```ts
export const SETTINGS_KEYS = APP_SETTING_KEYS;
export type SettingsKey = AppSettingKey;
export type EnvSettings = AppSettings;

const DEFAULT_SETTINGS = getAppSettingDefaults();
```

- [ ] **Step 4: Expand `syncEnvObjectFromProcess`**

Add assignments for every DB-first setting that exists in `env`:

```ts
const mutableEnv = env as unknown as Record<string, unknown>;
mutableEnv.API_URL = process.env.API_URL || "";
mutableEnv.APP_NAME = process.env.APP_NAME || "";
mutableEnv.REFERER = process.env.REFERER || "";
mutableEnv.DEBUG = process.env.DEBUG === "true";
mutableEnv.FETCH_DETAILS = process.env.FETCH_DETAILS === "true";
mutableEnv.SAVE_TO_DB = process.env.SAVE_TO_DB === "true";
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
mutableEnv.CODEX_IMAGE_MODEL = process.env.CODEX_IMAGE_MODEL || "";
mutableEnv.CODEX_IMAGE_TIMEOUT_MS = readIntegerSetting("CODEX_IMAGE_TIMEOUT_MS", 300000);
mutableEnv.CODEX_IMAGE_MAX_BYTES = readIntegerSetting("CODEX_IMAGE_MAX_BYTES", 10 * 1024 * 1024);
mutableEnv.LINE_IMAGE_LISTENER_CHAT_ID = process.env.LINE_IMAGE_LISTENER_CHAT_ID || "";
```

Add the helper near the other local helpers:

```ts
function parseCommaSeparatedSetting(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}
```

- [ ] **Step 5: Update settings read/write functions**

Use catalog helpers in these functions:

```ts
function pickKnownSettings(settings: Record<string, string>): EnvSettings {
  return pickAppSettings(settings);
}

function readProcessSettings(keys: readonly RuntimeSettingsKey[] = SETTINGS_KEYS): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string") settings[key] = value;
  }
  return settings;
}
```

Keep `LEGACY_TEAM_SETTINGS_KEYS` only for migration input, not public global settings.

- [ ] **Step 6: Update the existing validation test**

In `tests/settings-validation.test.ts`, keep the assertion that team-scoped legacy keys are not in `SETTINGS_KEYS`, and add:

```ts
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
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm test -- db-first-config
npm test -- settings-validation
```

Expected: both PASS.

- [ ] **Step 8: Commit checkpoint when commits are authorized**

```powershell
git add src/services/settings.ts tests/db-first-config.test.ts tests/settings-validation.test.ts
git commit -m "feat: load runtime settings from DB catalog"
```

## Task 4: Refactor Startup To Load DB Before Runtime Validation

**Files:**
- Modify: `src/app.ts`
- Modify: `src/config/env.ts`
- Test: `tests/db-first-config.test.ts`

- [ ] **Step 1: Add startup-order assertions**

Append this static source assertion to `tests/db-first-config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(resolve(process.cwd(), "src/app.ts"), "utf8");
assert.match(appSource, /await loadDbFirstSettingsIntoEnv\(\)/, "app startup must load DB-first settings before validation");
assert.match(appSource, /validateRuntimeConfig\(\)/, "app startup must still validate runtime config");
assert.ok(
  appSource.indexOf("await loadDbFirstSettingsIntoEnv()") < appSource.indexOf("validateRuntimeConfig()"),
  "DB-first settings must load before validateRuntimeConfig",
);
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```powershell
npm test -- db-first-config
```

Expected: FAIL because `loadDbFirstSettingsIntoEnv` does not exist in `app.ts`.

- [ ] **Step 3: Add DB-first loader alias**

In `src/services/settings.ts`, export:

```ts
export async function loadDbFirstSettingsIntoEnv(): Promise<void> {
  await migrateEnvSettingsToDb();
  await loadDbSettingsIntoEnv();
}
```

- [ ] **Step 4: Update app startup**

In `src/app.ts`, replace:

```ts
if (canUseSettingsDatabase()) {
  await migrateEnvSettingsToDb();
  await loadDbSettingsIntoEnv();
}
```

with:

```ts
if (canUseSettingsDatabase()) {
  await loadDbFirstSettingsIntoEnv();
}
```

Update the import to:

```ts
import { loadDbFirstSettingsIntoEnv } from "./services/settings.js";
```

- [ ] **Step 5: Make DB use independent of DB-backed feature flags**

Replace `canUseSettingsDatabase` with:

```ts
function canUseSettingsDatabase(): boolean {
  return env.DB_MODE === "memory" || Boolean(env.DB_HOST && env.DB_USERNAME && env.DB_PASSWORD && env.DB_NAME);
}
```

This makes startup connect to DB for config even when `HTTP_ENABLED`, `SAVE_TO_DB`, and `AUTO_ACCEPT_ENABLED` are DB values.

- [ ] **Step 6: Keep validation after DB load**

Leave this line after DB load:

```ts
validateRuntimeConfig();
```

Do not move HTTP/notifier/worker startup before validation.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm test -- db-first-config
npm test -- runtime-role
npm test -- notifier-role-startup
```

Expected: all PASS.

- [ ] **Step 8: Commit checkpoint when commits are authorized**

```powershell
git add src/app.ts src/services/settings.ts tests/db-first-config.test.ts
git commit -m "feat: load DB-first settings before validation"
```

## Task 5: Add Team Notification Target Columns

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/client-memory.ts`
- Modify: `src/db/migration-sql.ts`
- Modify: `migrations/001_create_booking_requests.sql`
- Create: `migrations/026_team_notification_targets.sql`
- Modify: `scripts/schema-verify.mjs`
- Modify: `tests/team-repository.test.ts`
- Test: `tests/schema-consistency.test.ts`

- [ ] **Step 1: Extend team repository test first**

In `tests/team-repository.test.ts`, update the `createTeam` input:

```ts
const created = await teams.createTeam({
  name: "Team A",
  enabled: true,
  spxCookie: "cookie-a-secret",
  spxDeviceId: "device-a-secret",
  lineGroupId: "line-group-a",
  autoAcceptSuccessLineGroupId: "line-success-a",
  autoAcceptFailureLineGroupId: "line-failure-a",
});
```

Add assertions after existing line group assertions:

```ts
assert.equal(created.hasAutoAcceptSuccessLineGroupId, true);
assert.equal(created.hasAutoAcceptFailureLineGroupId, true);
assert.notEqual(created.autoAcceptSuccessLineGroupIdPreview, "line-success-a");
assert.notEqual(created.autoAcceptFailureLineGroupIdPreview, "line-failure-a");
assert.equal(runtime?.autoAcceptSuccessLineGroupId, "line-success-a");
assert.equal(runtime?.autoAcceptFailureLineGroupId, "line-failure-a");
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```powershell
npm test -- team-repository
```

Expected: FAIL because team types and columns do not exist.

- [ ] **Step 3: Add columns to schema and runtime DDL**

Add these columns beside `lineGroupId` in `src/db/schema.ts`:

```ts
autoAcceptSuccessLineGroupId: varchar("auto_accept_success_line_group_id", { length: 255 }).notNull().default(""),
autoAcceptFailureLineGroupId: varchar("auto_accept_failure_line_group_id", { length: 255 }).notNull().default(""),
```

Add matching MySQL DDL columns in `src/db/client.ts`, `src/db/migration-sql.ts`, and `migrations/001_create_booking_requests.sql`:

```sql
auto_accept_success_line_group_id VARCHAR(255) NOT NULL DEFAULT '',
auto_accept_failure_line_group_id VARCHAR(255) NOT NULL DEFAULT '',
```

Add matching SQLite DDL columns in `src/db/client-memory.ts`:

```sql
auto_accept_success_line_group_id TEXT NOT NULL DEFAULT '',
auto_accept_failure_line_group_id TEXT NOT NULL DEFAULT '',
```

- [ ] **Step 4: Add production migration**

Create `migrations/026_team_notification_targets.sql`:

```sql
ALTER TABLE teams
  ADD COLUMN auto_accept_success_line_group_id VARCHAR(255) NOT NULL DEFAULT '' AFTER line_group_id,
  ADD COLUMN auto_accept_failure_line_group_id VARCHAR(255) NOT NULL DEFAULT '' AFTER auto_accept_success_line_group_id;

UPDATE teams
SET
  auto_accept_success_line_group_id = line_group_id,
  auto_accept_failure_line_group_id = line_group_id
WHERE line_group_id <> ''
  AND auto_accept_success_line_group_id = ''
  AND auto_accept_failure_line_group_id = '';
```

- [ ] **Step 5: Update schema verification map**

In `scripts/schema-verify.mjs`, add these `teams` column expectations:

```js
auto_accept_success_line_group_id: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
auto_accept_failure_line_group_id: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
```

- [ ] **Step 6: Run schema tests**

Run:

```powershell
npm test -- schema-consistency
npm test -- team-repository
```

Expected: schema consistency PASS; team repository still FAIL until repository support is added.

- [ ] **Step 7: Commit checkpoint when commits are authorized**

```powershell
git add src/db/schema.ts src/db/client.ts src/db/client-memory.ts src/db/migration-sql.ts migrations/001_create_booking_requests.sql migrations/026_team_notification_targets.sql scripts/schema-verify.mjs tests/team-repository.test.ts
git commit -m "feat: add team notification target columns"
```

## Task 6: Support Team Success/Failure Targets In Repository And API

**Files:**
- Modify: `src/repositories/team-repository.ts`
- Modify: `src/controllers/teams-controller.ts`
- Modify: `src/controllers/internal-notification-controller.ts`
- Test: `tests/team-repository.test.ts`
- Test: `tests/internal-notification-controller.test.ts`

- [ ] **Step 1: Update team repository types**

Add fields to `TeamInput`, `TeamPatch`, `RedactedTeam`, and `TeamRuntimeConfig`:

```ts
autoAcceptSuccessLineGroupId?: string;
autoAcceptFailureLineGroupId?: string;
hasAutoAcceptSuccessLineGroupId: boolean;
hasAutoAcceptFailureLineGroupId: boolean;
autoAcceptSuccessLineGroupIdPreview: string;
autoAcceptFailureLineGroupIdPreview: string;
autoAcceptSuccessLineGroupId: string;
autoAcceptFailureLineGroupId: string;
```

Use optional properties only in input/patch types and required properties in redacted/runtime output types.

- [ ] **Step 2: Update redaction and runtime mapping**

In `toRedactedTeam`, decode the new columns:

```ts
const autoAcceptSuccessLineGroupId = decodeSecret(row.autoAcceptSuccessLineGroupId);
const autoAcceptFailureLineGroupId = decodeSecret(row.autoAcceptFailureLineGroupId);
```

Return:

```ts
hasAutoAcceptSuccessLineGroupId: autoAcceptSuccessLineGroupId.length > 0,
hasAutoAcceptFailureLineGroupId: autoAcceptFailureLineGroupId.length > 0,
autoAcceptSuccessLineGroupIdPreview: previewSecret(autoAcceptSuccessLineGroupId),
autoAcceptFailureLineGroupIdPreview: previewSecret(autoAcceptFailureLineGroupId),
```

In `toRuntimeConfig`, return:

```ts
autoAcceptSuccessLineGroupId: decodeSecret(row.autoAcceptSuccessLineGroupId),
autoAcceptFailureLineGroupId: decodeSecret(row.autoAcceptFailureLineGroupId),
```

- [ ] **Step 3: Update create/update persistence**

In `createTeam`, add:

```ts
autoAcceptSuccessLineGroupId: encodeSecret(input.autoAcceptSuccessLineGroupId || input.lineGroupId),
autoAcceptFailureLineGroupId: encodeSecret(input.autoAcceptFailureLineGroupId || input.lineGroupId),
```

In `updateTeam`, add:

```ts
if (patch.autoAcceptSuccessLineGroupId !== undefined && !isRedactedPlaceholder(patch.autoAcceptSuccessLineGroupId)) {
  next.autoAcceptSuccessLineGroupId = encodeSecret(patch.autoAcceptSuccessLineGroupId);
}
if (patch.autoAcceptFailureLineGroupId !== undefined && !isRedactedPlaceholder(patch.autoAcceptFailureLineGroupId)) {
  next.autoAcceptFailureLineGroupId = encodeSecret(patch.autoAcceptFailureLineGroupId);
}
```

- [ ] **Step 4: Update legacy default team migration**

In `ensureDefaultTeamFromLegacySettings`, read:

```ts
const legacy = await getAppSettings([
  "COOKIE",
  "DEVICE_ID",
  "LINE_USER_ID",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE",
]);
```

Insert:

```ts
lineGroupId: encodeSecret(legacy.LINE_USER_ID),
autoAcceptSuccessLineGroupId: encodeSecret(legacy.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS || legacy.LINE_USER_ID),
autoAcceptFailureLineGroupId: encodeSecret(legacy.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || legacy.LINE_USER_ID),
```

- [ ] **Step 5: Update teams controller parsing**

In `src/controllers/teams-controller.ts`, add optional body parsing:

```ts
const autoAcceptSuccessLineGroupId = optionalString(body.autoAcceptSuccessLineGroupId, "autoAcceptSuccessLineGroupId");
if (autoAcceptSuccessLineGroupId !== undefined) patch.autoAcceptSuccessLineGroupId = autoAcceptSuccessLineGroupId;

const autoAcceptFailureLineGroupId = optionalString(body.autoAcceptFailureLineGroupId, "autoAcceptFailureLineGroupId");
if (autoAcceptFailureLineGroupId !== undefined) patch.autoAcceptFailureLineGroupId = autoAcceptFailureLineGroupId;
```

Update `patchTouchesRuntime`:

```ts
return patch.enabled !== undefined
  || patch.spxCookie !== undefined
  || patch.spxDeviceId !== undefined
  || patch.lineGroupId !== undefined
  || patch.autoAcceptSuccessLineGroupId !== undefined
  || patch.autoAcceptFailureLineGroupId !== undefined;
```

- [ ] **Step 6: Update internal notification target selection**

In `src/controllers/internal-notification-controller.ts`, select target by event type:

```ts
const lineGroupId = event.eventType === "auto_accept_failed"
  ? (team?.autoAcceptFailureLineGroupId || team?.lineGroupId || "").trim()
  : event.eventType === "auto_accept_succeeded"
    ? (team?.autoAcceptSuccessLineGroupId || team?.lineGroupId || "").trim()
    : (team?.lineGroupId || "").trim();
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm test -- team-repository
npm test -- internal-notification-controller
```

Expected: both PASS.

- [ ] **Step 8: Commit checkpoint when commits are authorized**

```powershell
git add src/repositories/team-repository.ts src/controllers/teams-controller.ts src/controllers/internal-notification-controller.ts tests/team-repository.test.ts
git commit -m "feat: add team-specific notification targets"
```

## Task 7: Expand Settings API For DB-First Keys

**Files:**
- Modify: `src/controllers/settings-controller.ts`
- Modify: `src/frontend/types/index.ts`
- Modify: `tests/settings-validation.test.ts`

- [ ] **Step 1: Add API key assertions**

In `tests/settings-validation.test.ts`, add a static source check:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const settingsControllerSource = readFileSync(resolve(process.cwd(), "src/controllers/settings-controller.ts"), "utf8");
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
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```powershell
npm test -- settings-validation
```

Expected: FAIL until controller schema and redaction are expanded.

- [ ] **Step 3: Use catalog metadata for secret redaction**

In `src/controllers/settings-controller.ts`, import:

```ts
import { getAppSettingMetadata } from "../config/config-catalog.js";
```

Replace the local `SECRET_KEYS` set with:

```ts
function isSecretKey(key: SettingsKey): boolean {
  return getAppSettingMetadata(key).secret;
}
```

Update redaction checks to call `isSecretKey(settingsKey)`.

- [ ] **Step 4: Expand `settingsSchema.properties`**

Add string properties for every new DB-first setting:

```ts
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
HTTP_ENABLED: { type: "string" },
HTTP_ALLOWED_ORIGINS: { type: "string" },
HTTP_TRUST_PROXY: { type: "string" },
JWT_SECRET: { type: "string" },
COOKIE_SECRET: { type: "string" },
ADMIN_USERNAME: { type: "string" },
ADMIN_PASSWORD: { type: "string" },
ADMIN_ROLE: { type: "string", enum: ["admin", "user"] },
LINE_IMAGE_LISTENER_CHAT_ID: { type: "string" },
NOTIFIER_SHARED_SECRET: { type: "string" },
NOTIFIER_AUTH_MODE: { type: "string", enum: ["hmac", "bearer"] },
NOTIFIER_REQUEST_TIMEOUT_MS: { type: "string" },
NOTIFIER_RETRY_MAX_ATTEMPTS: { type: "string" },
NOTIFIER_RETRY_BASE_DELAY_MS: { type: "string" },
CODEX_IMAGE_MODEL: { type: "string" },
CODEX_IMAGE_TIMEOUT_MS: { type: "string" },
CODEX_IMAGE_MAX_BYTES: { type: "string" },
```

- [ ] **Step 5: Return reload behavior**

Change settings GET response to include metadata:

```ts
return sendSuccess(reply, {
  values: await readPublicSettings(),
  reloadBehavior: Object.fromEntries(
    SETTINGS_KEYS.map((key) => [key, getAppSettingMetadata(key).reload]),
  ),
});
```

Update frontend API types in the next task before relying on this shape in UI.

- [ ] **Step 6: Run focused test**

Run:

```powershell
npm test -- settings-validation
```

Expected: PASS.

- [ ] **Step 7: Commit checkpoint when commits are authorized**

```powershell
git add src/controllers/settings-controller.ts src/frontend/types/index.ts tests/settings-validation.test.ts
git commit -m "feat: expose DB-first settings API"
```

## Task 8: Update Frontend Settings And Teams UI

**Files:**
- Modify: `src/frontend/types/index.ts`
- Modify: `src/frontend/lib/api.ts`
- Modify: `src/frontend/lib/settings-shared.tsx`
- Modify: `src/frontend/routes/teams.tsx`
- Test: `tests/frontend-team-actions-toggle.test.ts`
- Test: `tests/settings-validation.test.ts`

- [ ] **Step 1: Update frontend types**

In `src/frontend/types/index.ts`, extend `Team`:

```ts
hasAutoAcceptSuccessLineGroupId: boolean;
hasAutoAcceptFailureLineGroupId: boolean;
autoAcceptSuccessLineGroupIdPreview: string;
autoAcceptFailureLineGroupIdPreview: string;
```

Extend `TeamInput`:

```ts
autoAcceptSuccessLineGroupId?: string;
autoAcceptFailureLineGroupId?: string;
```

Add settings response types:

```ts
export type SettingReloadBehavior = "live" | "restart-worker" | "restart-process";
export interface SettingsResponse {
  values: Record<string, string>;
  reloadBehavior: Record<string, SettingReloadBehavior>;
}
```

- [ ] **Step 2: Update settings API adapter**

In `src/frontend/lib/api.ts`, make `settingsApi.get` normalize both the old and new shape during rollout:

```ts
get: async (): Promise<Record<string, string>> => {
  const response = await fetchJson<Record<string, string> | { values: Record<string, string> }>(`${API_BASE}/settings`);
  return "values" in response ? response.values : response;
},
```

Keep `settingsApi.update` posting the flat settings object.

- [ ] **Step 3: Extend `INITIAL_SETTINGS_FORM`**

In `src/frontend/lib/settings-shared.tsx`, add fields for DB-first settings:

```ts
APP_NAME: "",
REFERER: "",
DEBUG: "false",
FETCH_DETAILS: "false",
SAVE_TO_DB: "true",
BIDDING_PAGE_NO: "1",
BIDDING_PAGE_COUNT: "100",
REQUEST_TAB_PENDING_CONFIRMATION: "true",
REQUEST_CTIME_START: "1776358800",
NOTIFY_ENABLED: "true",
NOTIFY_MODE: "batch",
NOTIFY_ORIGINS: "",
NOTIFY_DESTINATIONS: "",
NOTIFY_VEHICLE_TYPES: "",
NOTIFY_MIN_TRIPS: "1",
AUTO_ACCEPT_ENABLED: "true",
HTTP_ENABLED: "true",
HTTP_ALLOWED_ORIGINS: "",
HTTP_TRUST_PROXY: "false",
JWT_SECRET: "",
COOKIE_SECRET: "",
ADMIN_USERNAME: "admin",
ADMIN_PASSWORD: "",
ADMIN_ROLE: "admin",
LINE_IMAGE_LISTENER_CHAT_ID: "",
NOTIFIER_SHARED_SECRET: "",
NOTIFIER_AUTH_MODE: "hmac",
NOTIFIER_REQUEST_TIMEOUT_MS: "1500",
NOTIFIER_RETRY_MAX_ATTEMPTS: "12",
NOTIFIER_RETRY_BASE_DELAY_MS: "1000",
CODEX_IMAGE_MODEL: "",
CODEX_IMAGE_TIMEOUT_MS: "300000",
CODEX_IMAGE_MAX_BYTES: "10485760",
```

Update `formFromSettings` with the same defaults.

- [ ] **Step 4: Add numeric validation rules**

Add numeric rules:

```ts
BIDDING_PAGE_NO: { optional: false, min: 1 },
BIDDING_PAGE_COUNT: { optional: false, min: 1 },
REQUEST_CTIME_START: { optional: false, min: 0 },
NOTIFY_MIN_TRIPS: { optional: false, min: 1 },
NOTIFIER_REQUEST_TIMEOUT_MS: { optional: false, min: 1 },
NOTIFIER_RETRY_MAX_ATTEMPTS: { optional: false, min: 1 },
NOTIFIER_RETRY_BASE_DELAY_MS: { optional: false, min: 1 },
CODEX_IMAGE_TIMEOUT_MS: { optional: false, min: 1 },
CODEX_IMAGE_MAX_BYTES: { optional: false, min: 1 },
```

- [ ] **Step 5: Add team target inputs**

In `src/frontend/routes/teams.tsx`, add local state:

```ts
const [autoAcceptSuccessLineGroupId, setAutoAcceptSuccessLineGroupId] = useState("");
const [autoAcceptFailureLineGroupId, setAutoAcceptFailureLineGroupId] = useState("");
```

Set edit defaults:

```ts
setAutoAcceptSuccessLineGroupId(team?.autoAcceptSuccessLineGroupIdPreview ?? "");
setAutoAcceptFailureLineGroupId(team?.autoAcceptFailureLineGroupIdPreview ?? "");
```

Add to `TeamInput`:

```ts
autoAcceptSuccessLineGroupId,
autoAcceptFailureLineGroupId,
```

Render two LINE target fields under the existing default LINE field using the same select/input pattern:

```tsx
<LineGroupField
  id="team-auto-accept-success-line-group"
  label="Auto-accept success LINE group"
  value={autoAcceptSuccessLineGroupId}
  onChange={setAutoAcceptSuccessLineGroupId}
  lineGroups={lineGroups}
/>
<LineGroupField
  id="team-auto-accept-failure-line-group"
  label="Auto-accept failure LINE group"
  value={autoAcceptFailureLineGroupId}
  onChange={setAutoAcceptFailureLineGroupId}
  lineGroups={lineGroups}
/>
```

If no `LineGroupField` component exists, extract the existing LINE group select/input block into a local component in the same file.

- [ ] **Step 6: Run frontend-focused checks**

Run:

```powershell
npm test -- frontend-team-actions-toggle
npm test -- settings-validation
npm run typecheck:frontend
```

Expected: all PASS.

- [ ] **Step 7: Commit checkpoint when commits are authorized**

```powershell
git add src/frontend/types/index.ts src/frontend/lib/api.ts src/frontend/lib/settings-shared.tsx src/frontend/routes/teams.tsx
git commit -m "feat: update UI for DB-first config"
```

## Task 9: Update Env Docs And Docker Compose

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docs/env-reference.md`
- Modify: `docs/deployment.md`
- Test: `tests/node-runtime-config.test.ts`

- [ ] **Step 1: Add static docs assertions**

In `tests/node-runtime-config.test.ts`, add:

```ts
assert.match(deploymentDocs, /DB-first config/i, "deployment docs must describe DB-first config");
assert.match(deploymentDocs, /SECRETS_KEY/, "deployment docs must mention SECRETS_KEY as bootstrap env");
assert.match(deploymentDocs, /RUN_TEAM_IDS/, "deployment docs must keep worker team assignment as process env");
assert.doesNotMatch(deploymentDocs, /POLL_INTERVAL_MS=.*production/i, "deployment docs must not tell production operators to tune poll interval in .env");
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```powershell
npm test -- node-runtime-config
```

Expected: FAIL until docs are updated.

- [ ] **Step 3: Update docker compose comments**

Keep `env_file: .env` for bootstrap env, and keep process identity values under each service. Add a comment above `env_file`:

```yaml
  # .env is bootstrap-only. Runtime/operator settings are loaded from app_settings.
  env_file:
    - .env
```

Do not put `POLL_INTERVAL_MS`, `AUTO_ACCEPT_ENABLED`, `API_URL`, or notification provider values into compose service environment.

- [ ] **Step 4: Update env reference**

In `docs/env-reference.md`, split the reference into:

```md
## Bootstrap Env

These values remain in `.env`: `NODE_ENV`, `DB_MODE`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `SECRETS_KEY`.

## Process Identity Env

These values remain in Docker/service environment: `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_PORT`.

## DB-First Settings

Operator settings such as `POLL_INTERVAL_MS`, `API_URL`, `AUTO_ACCEPT_ENABLED`, notification settings, auth signing secrets, and provider settings are stored in `app_settings`.
```

- [ ] **Step 5: Update deployment docs**

In `docs/deployment.md`, add a production runbook section:

```md
## DB-first config

Production loads config from MySQL `app_settings` after reading bootstrap env. `.env` should contain only bootstrap values and Docker/process identity values. Use the dashboard Settings and Teams pages to change SPX API, polling, auto-accept, notification, and provider settings.

Before reducing `.env`, deploy the DB-first build once with the existing `.env` so startup can seed missing `app_settings` rows. Verify `/ready`, worker healthchecks, and Settings page values. After that verification, remove runtime/operator values from `.env`.
```

- [ ] **Step 6: Run docs test**

Run:

```powershell
npm test -- node-runtime-config
```

Expected: PASS.

- [ ] **Step 7: Commit checkpoint when commits are authorized**

```powershell
git add docker-compose.yml docs/env-reference.md docs/deployment.md tests/node-runtime-config.test.ts
git commit -m "docs: document DB-first config model"
```

## Task 10: Full Verification

**Files:**
- No source changes unless a previous task fails verification.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
npm test -- db-first-config
npm test -- settings-validation
npm test -- team-repository
npm test -- schema-consistency
npm test -- node-runtime-config
npm test -- internal-notification-controller
```

Expected: all PASS.

- [ ] **Step 2: Run full test suite**

Run:

```powershell
npm test
```

Expected: all `*.test.ts` files PASS.

- [ ] **Step 3: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: backend and frontend TypeScript checks PASS.

- [ ] **Step 4: Run production build gate**

Run:

```powershell
npm run build
```

Expected: backend bundle and Vite build complete successfully.

- [ ] **Step 5: Check migration generation**

Run:

```powershell
npm run db:generate
git diff -- migrations/001_create_booking_requests.sql src/db/migration-sql.ts
```

Expected: generated baseline matches committed schema updates. If the command rewrites formatting only, inspect and keep the generated schema-consistent output.

- [ ] **Step 6: Production rollout checklist**

Before production deploy:

```powershell
git status --short
```

Expected: only intentional files are changed.

Deploy sequence:

1. Deploy DB-first build with existing `.env` still present.
2. Let startup seed missing `app_settings` rows.
3. Confirm notifier `/ready` returns OK.
4. Confirm `docker compose ps` shows notifier and workers healthy.
5. Confirm dashboard Settings values are populated without showing raw secret values.
6. Confirm IFN worker has `RUN_TEAM_IDS=2` and PTWL worker has `RUN_TEAM_IDS=1`.
7. Remove runtime/operator values from production `.env`, leaving bootstrap and process identity values.
8. Restart services and confirm healthchecks again.

- [ ] **Step 7: Final commit when commits are authorized**

```powershell
git add .
git commit -m "feat: make runtime config DB-first"
```

## Self-Review

- Spec coverage: covered DB source of truth, minimal env boundary, encrypted secrets, team-scoped targets, startup order, live reload behavior, migration, docs, and verification.
- Placeholder scan: no unfinished marker words or incomplete sections remain.
- Type consistency: plan uses `AppSettingKey`, `AppSettings`, `AppSettingMetadata`, `autoAcceptSuccessLineGroupId`, and `autoAcceptFailureLineGroupId` consistently across backend, API, and frontend.
- Scope check: this is one cohesive config migration plan. It touches several layers, but each task is independently testable and reviewable.
