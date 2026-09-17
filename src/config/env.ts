import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadFileBackedSecret } from "./file-backed-secret.js";
import {
  httpSurfaceForRole,
  parseRuntimeRole,
  parseRunTeamIds,
  requireNodeIdForDistributedRole,
  type RuntimeRole,
} from "../services/runtime-role.js";

const envFilePath = resolve(process.cwd(), ".env");
const DEFAULT_CODEX_IMAGE_TIMEOUT_MS = 300000;

// Explicit subprocess-test isolation; application startup always keeps file loading.
const skipEnvFile = process.env.NODE_ENV === "test" && process.env.SPX_TEST_SKIP_ENV_FILE === "1";
if (!skipEnvFile && existsSync(envFilePath)) {
  const lines = readFileSync(envFilePath, "utf8").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Resolve mounted credentials before building the immutable environment
// snapshot or parsing node-key maps. The loader rejects dual sources.
for (const name of [
  "DB_PASSWORD", "SECRETS_KEY", "JWT_SECRET", "COOKIE_SECRET", "ADMIN_PASSWORD",
  "LINE_CHANNEL_ACCESS_TOKEN", "NOTIFIER_SHARED_SECRET", "LINE_SERVICE_SEND_SECRET",
  "LINE_SERVICE_ADMIN_SECRET", "OCR_SERVICE_ADMIN_SECRET", "REALTIME_SHARED_SECRET",
  "REALTIME_NODE_SECRETS", "GATE6_LINE_NODE_SECRETS", "GATE6_OCR_NODE_SECRETS",
  "GATE6_CONTROL_NODE_SECRET", "NOTIFICATION_NODE_SECRET", "NOTIFICATION_NODE_SECRETS",
  "LINE_SERVICE_SEND_NODE_SECRETS", "OCR_NODE_SECRET", "OCR_NODE_SECRETS",
]) loadFileBackedSecret(name);

function isStandaloneTestEntrypoint(): boolean {
  return process.argv.some((arg) => /(?:^|[\\/])tests[\\/][^\\/]+\.test\.(?:ts|js)$/.test(arg));
}

if (process.env.NODE_ENV === "test" || isStandaloneTestEntrypoint()) {
  process.env.DB_MODE = "memory";
}

export function isLegacyDeployMode(): boolean {
  if (process.env.DEPLOYMENT_MODE === "legacy") return true;
  if (process.env.DEPLOYMENT_MODE === "protected-a3") return false;
  try {
    const candidates = [
      resolve(process.cwd(), "dist/deployment-contract.json"),
      "/app/dist/deployment-contract.json",
    ];
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) {
          const content = JSON.parse(readFileSync(candidate, "utf8")) as { mode?: unknown };
          if (content?.mode === "legacy") return true;
          if (content?.mode === "protected-a3") return false;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function readIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const value = Number(rawValue);
  return Number.isInteger(value) ? value : Number.NaN;
}

export type RequestSelectionStrategy = "random" | "last" | "first";

function readSelectionStrategyEnv(name: string, defaultValue: RequestSelectionStrategy = "random"): RequestSelectionStrategy {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (rawValue === "random" || rawValue === "last" || rawValue === "first") {
    return rawValue;
  }
  return defaultValue;
}

function readOptionalIntegerEnv(name: string, defaultValue?: number): number | undefined {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }
  if (rawValue.trim() === "") {
    return undefined;
  }

  const value = Number(rawValue);
  return Number.isInteger(value) ? value : Number.NaN;
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse HTTP_TRUST_PROXY into a Fastify `trustProxy` value. Controls how the
 * client IP (used for rate-limit identity and logs) is derived from
 * X-Forwarded-For. Accepts:
 *   - "true"/"false"         → trust all / trust none
 *   - a comma list of IPs/CIDRs → trust exactly those proxy addresses
 * Defaults to `false`; production deployments behind a reverse proxy should
 * set this to the proxy IP/CIDR after verifying the proxy path. Hop-count-only
 * trust cannot authenticate the immediate peer and is rejected fail-closed.
 */
export function parseTrustProxy(value: string | undefined): boolean | string[] {
  if (value === undefined || value.trim() === "") return false;
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    throw new Error("HTTP_TRUST_PROXY hop-count values are not supported; use proxy IPs or CIDRs");
  }
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidJwtSecret(value: string): boolean {
  return value.trim().length >= 32;
}

function isBooleanString(value: string | undefined): boolean {
  return value === undefined || value === "true" || value === "false";
}

function validateList(name: string, values: string[]): string | null {
  if (values.length === 0) return null;
  if (values.some((value) => value.length === 0)) return `${name} contains an empty value`;
  return null;
}

function isStrongPassword(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length >= 12;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeParseRuntimeRole(value: string | undefined): RuntimeRole {
  try {
    return parseRuntimeRole(value);
  } catch {
    return "combined";
  }
}

function safeParseRunTeamIds(value: string | undefined): number[] {
  try {
    return parseRunTeamIds(value);
  } catch {
    return [];
  }
}

function parseNodeSecretPairs(value: string | undefined): Map<string, { active: string }> {
  const result = new Map<string, { active: string }>();
  if (!value || value.trim() === "") return result;
  for (const pair of value.split(",")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) continue;
    const nodeId = pair.slice(0, separatorIndex).trim();
    const secret = pair.slice(separatorIndex + 1).trim();
    if (nodeId !== "" && secret !== "") result.set(nodeId, { active: secret });
  }
  return result;
}

function parseStrictNodeSet(value: string | undefined, name: string): Set<string> {
  const result = new Set<string>();
  if (value === undefined || value.trim() === "") return result;
  for (const rawPart of value.split(",")) {
    const nodeId = rawPart.trim();
    if (nodeId === "") throw new Error(`${name} contains an empty node id`);
    result.add(nodeId);
  }
  return result;
}

export function parseRealtimeTrustedNodeIds(value: string | undefined): Set<string> {
  return parseStrictNodeSet(value, "REALTIME_TRUSTED_NODE_IDS");
}

export function parseRealtimeAdminNodeIds(value: string | undefined): Set<string> {
  return parseStrictNodeSet(value, "REALTIME_ADMIN_NODE_IDS");
}

export function parseRealtimeNodeSecrets(
  value: string | undefined,
): Map<string, { active: string }> {
  const result = new Map<string, { active: string }>();
  const secretOwners = new Map<string, string>();
  if (value === undefined || value.trim() === "") return result;

  for (const rawPair of value.split(",")) {
    const separatorIndex = rawPair.indexOf("=");
    const nodeId = separatorIndex < 0 ? "" : rawPair.slice(0, separatorIndex).trim();
    const secret = separatorIndex < 0 ? "" : rawPair.slice(separatorIndex + 1).trim();
    if (nodeId === "" || secret === "") {
      throw new Error("REALTIME_NODE_SECRETS must contain node-id=secret pairs");
    }
    if (result.has(nodeId)) {
      throw new Error(`REALTIME_NODE_SECRETS contains duplicate node id: ${nodeId}`);
    }
    if (secretOwners.has(secret)) {
      throw new Error("REALTIME_NODE_SECRETS contains a duplicate secret value");
    }
    result.set(nodeId, { active: secret });
    secretOwners.set(secret, nodeId);
  }
  return result;
}

function safeParseRealtimeNodeSet(
  value: string | undefined,
  parser: (raw: string | undefined) => Set<string>,
): Set<string> {
  try {
    return parser(value);
  } catch {
    return new Set<string>();
  }
}

function safeParseRealtimeNodeSecrets(value: string | undefined): Map<string, { active: string }> {
  try {
    return parseRealtimeNodeSecrets(value);
  } catch {
    return new Map<string, { active: string }>();
  }
}

function parseNodeSet(value: string | undefined): Set<string> {
  return new Set(
    (value || "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  );
}

function parseNodeTeamsEntries(value: string | undefined): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  if (!value || value.trim() === "") return result;
  for (const entry of value.split(";")) {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex <= 0) continue;
    const nodeId = entry.slice(0, separatorIndex).trim();
    const teams = parseRunTeamIds(entry.slice(separatorIndex + 1).replace(/:/g, ","));
    if (nodeId !== "" && teams.length > 0) result.set(nodeId, new Set(teams));
  }
  return result;
}

function hasDuplicateSecretValues(map: Map<string, { active: string }>): boolean {
  const seen = new Set<string>();
  for (const ring of map.values()) {
    if (seen.has(ring.active)) return true;
    seen.add(ring.active);
  }
  return false;
}

function sameKeySet(left: Map<string, unknown> | Set<string>, right: Map<string, unknown> | Set<string>): boolean {
  const leftKeys = new Set([...left.keys()]);
  const rightKeys = new Set([...right.keys()]);
  if (leftKeys.size !== rightKeys.size) return false;
  for (const key of leftKeys) if (!rightKeys.has(key)) return false;
  return true;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function isCanonicalLedgerDir(path: string): boolean {
  if (path === "/app/data" || !path.startsWith("/app/data/")) return false;
  if (path.includes("..") || path.includes("\\") || path.includes("//")) return false;
  return /^\/app\/data\/[A-Za-z0-9._\-/]+$/.test(path) && !path.endsWith("/");
}

export const env = {
  SPX_ROLE: safeParseRuntimeRole(process.env.SPX_ROLE),
  SPX_NODE_ID: (process.env.SPX_NODE_ID || "").trim(),
  SPX_NODE_NAME: process.env.SPX_NODE_NAME || "",
  RUN_TEAM_IDS: safeParseRunTeamIds(process.env.RUN_TEAM_IDS),
  NOTIFIER_API_URL: process.env.NOTIFIER_API_URL || "",
  NOTIFIER_SHARED_SECRET: process.env.NOTIFIER_SHARED_SECRET || "",
  NOTIFIER_AUTH_MODE: (process.env.NOTIFIER_AUTH_MODE || "hmac") as "hmac" | "bearer",
  NOTIFIER_REQUEST_TIMEOUT_MS: readIntegerEnv("NOTIFIER_REQUEST_TIMEOUT_MS", 1500),
  NOTIFIER_RETRY_MAX_ATTEMPTS: readIntegerEnv("NOTIFIER_RETRY_MAX_ATTEMPTS", 12),
  NOTIFIER_RETRY_BASE_DELAY_MS: readIntegerEnv("NOTIFIER_RETRY_BASE_DELAY_MS", 1000),
  NOTIFIER_LOCAL_SPOOL_PATH:
    process.env.NOTIFIER_LOCAL_SPOOL_PATH || "data/notification-spool.jsonl",
  LINE_SERVICE_URL: process.env.LINE_SERVICE_URL || "",
  LINE_SERVICE_SEND_SECRET: process.env.LINE_SERVICE_SEND_SECRET || "",
  LINE_SERVICE_ADMIN_SECRET: process.env.LINE_SERVICE_ADMIN_SECRET || "",
  LINE_SERVICE_REQUEST_TIMEOUT_MS: readIntegerEnv("LINE_SERVICE_REQUEST_TIMEOUT_MS", 1500),
  OCR_SERVICE_URL: process.env.OCR_SERVICE_URL || "",
  OCR_SERVICE_REQUEST_TIMEOUT_MS: readIntegerEnv(
    "OCR_SERVICE_REQUEST_TIMEOUT_MS",
    readIntegerEnv("CODEX_IMAGE_TIMEOUT_MS", DEFAULT_CODEX_IMAGE_TIMEOUT_MS) + 5000,
  ),
  REALTIME_SERVICE_URL: safeNormalizeRealtimeServiceUrl(process.env.REALTIME_SERVICE_URL),
  REALTIME_SHARED_SECRET: process.env.REALTIME_SHARED_SECRET || "",
  REALTIME_REQUEST_TIMEOUT_MS: readIntegerEnv("REALTIME_REQUEST_TIMEOUT_MS", 1500),
  REALTIME_TRUSTED_NODE_IDS: safeParseRealtimeNodeSet(
    process.env.REALTIME_TRUSTED_NODE_IDS,
    parseRealtimeTrustedNodeIds,
  ),
  REALTIME_ADMIN_NODE_IDS: safeParseRealtimeNodeSet(
    process.env.REALTIME_ADMIN_NODE_IDS,
    parseRealtimeAdminNodeIds,
  ),
  REALTIME_ALLOWED_NODE_TEAMS: parseNodeTeamsEntries(process.env.REALTIME_ALLOWED_NODE_TEAMS),
  REALTIME_NODE_SECRETS: safeParseRealtimeNodeSecrets(process.env.REALTIME_NODE_SECRETS),
  GATE6_REPOSITORY: process.env.GATE6_REPOSITORY || "",
  GATE6_LINE_NODE_SECRETS: parseNodeSecretPairs(process.env.GATE6_LINE_NODE_SECRETS),
  GATE6_OCR_NODE_SECRETS: parseNodeSecretPairs(process.env.GATE6_OCR_NODE_SECRETS),
  GATE6_CONTROL_NODE_SECRET: process.env.GATE6_CONTROL_NODE_SECRET || "",
  GATE6_LINE_PERMIT_KEY_ID: process.env.GATE6_LINE_PERMIT_KEY_ID || "",
  GATE6_LINE_PERMIT_PUBLIC_KEY_FILE: process.env.GATE6_LINE_PERMIT_PUBLIC_KEY_FILE || "",
  GATE6_OCR_PERMIT_KEY_ID: process.env.GATE6_OCR_PERMIT_KEY_ID || "",
  GATE6_OCR_PERMIT_PUBLIC_KEY_FILE: process.env.GATE6_OCR_PERMIT_PUBLIC_KEY_FILE || "",
  NOTIFICATION_NODE_SECRET: process.env.NOTIFICATION_NODE_SECRET || "",
  NOTIFICATION_NODE_SECRETS: parseNodeSecretPairs(process.env.NOTIFICATION_NODE_SECRETS),
  NOTIFICATION_ALLOWED_NODE_TEAMS: parseNodeTeamsEntries(process.env.NOTIFICATION_ALLOWED_NODE_TEAMS),
  LINE_SERVICE_SEND_NODE_SECRETS: parseNodeSecretPairs(process.env.LINE_SERVICE_SEND_NODE_SECRETS),
  LINE_SEND_ALLOWED_NODE_IDS: parseNodeSet(process.env.LINE_SEND_ALLOWED_NODE_IDS),
  LINE_ADMIN_ALLOWED_NODE_IDS: parseNodeSet(process.env.LINE_ADMIN_ALLOWED_NODE_IDS),
  OCR_NODE_SECRET: process.env.OCR_NODE_SECRET || "",
  OCR_NODE_SECRETS: parseNodeSecretPairs(process.env.OCR_NODE_SECRETS),
  OCR_ALLOWED_LINE_NODE_IDS: parseNodeSet(process.env.OCR_ALLOWED_LINE_NODE_IDS),
  OCR_ADMIN_NODE_IDS: parseNodeSet(process.env.OCR_ADMIN_NODE_IDS),
  OCR_REPLAY_LEDGER_DIR: process.env.OCR_REPLAY_LEDGER_DIR || "",
  OCR_SERVICE_ADMIN_SECRET: process.env.OCR_SERVICE_ADMIN_SECRET || "",
  AUTO_ACCEPT_JOB_CUTOVER_EPOCH: process.env.AUTO_ACCEPT_JOB_CUTOVER_EPOCH || "",
  AUTO_ACCEPT_JOB_SHADOW_ENABLED: process.env.AUTO_ACCEPT_JOB_SHADOW_ENABLED === "true",
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED:
    process.env.AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED === "true",
  AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS: readIntegerEnv(
    "AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS",
    1000,
  ),
  AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE: readIntegerEnv(
    "AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE",
    10,
  ),
  AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS: readIntegerEnv(
    "AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS",
    300_000,
  ),
  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED:
    process.env.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED === "true",
  AUTO_ACCEPT_JOB_REAL_INTERVAL_MS: readIntegerEnv("AUTO_ACCEPT_JOB_REAL_INTERVAL_MS", 1000),
  AUTO_ACCEPT_JOB_REAL_BATCH_SIZE: readIntegerEnv("AUTO_ACCEPT_JOB_REAL_BATCH_SIZE", 10),
  AUTO_ACCEPT_JOB_REAL_LEASE_MS: readIntegerEnv("AUTO_ACCEPT_JOB_REAL_LEASE_MS", 300_000),
  AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED:
    process.env.AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED === "true",
  AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS: readIntegerEnv(
    "AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS",
    1000,
  ),
  AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE: readIntegerEnv(
    "AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE",
    10,
  ),
  AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS: readIntegerEnv(
    "AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS",
    300_000,
  ),
  AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED:
    process.env.AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED === "true",
  AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS: safeParseRunTeamIds(
    process.env.AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS,
  ),
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED:
    process.env.AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED === "true",
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS: safeParseRunTeamIds(
    process.env.AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS,
  ),
  API_URL: process.env.API_URL || "",
  POLL_INTERVAL_MS: readIntegerEnv("POLL_INTERVAL_MS", 30000),
  COOKIE: process.env.COOKIE || "",
  DEVICE_ID: process.env.DEVICE_ID || "",
  APP_NAME: process.env.APP_NAME || "",
  REFERER: process.env.REFERER || "",
  DEBUG: process.env.DEBUG === "true",
  FETCH_DETAILS: process.env.FETCH_DETAILS === "true",
  BOOKING_DETAIL_CONCURRENCY: readIntegerEnv("BOOKING_DETAIL_CONCURRENCY", 8),
  // Skip re-processing (re-fetching the request list of) a booking we already
  // finished within this many ms. New bookings are never in the cooldown map, so
  // they are still processed instantly — this only suppresses redundant re-scans
  // of bookings that linger in the list, which is the churn an aggressive
  // POLL_INTERVAL_MS otherwise produces (see Mistake-009). 0 disables it.
  BOOKING_REPROCESS_COOLDOWN_MS: readIntegerEnv("BOOKING_REPROCESS_COOLDOWN_MS", 10000),
  BIDDING_PAGE_NO: readIntegerEnv("BIDDING_PAGE_NO", 1),
  BIDDING_PAGE_COUNT: readIntegerEnv("BIDDING_PAGE_COUNT", 100),
  REQUEST_TAB_PENDING_CONFIRMATION: process.env.REQUEST_TAB_PENDING_CONFIRMATION !== "false",
  REQUEST_CTIME_START: readIntegerEnv("REQUEST_CTIME_START", 1788195600),
  BIDDING_VEHICLE_TYPE: readOptionalIntegerEnv("BIDDING_VEHICLE_TYPE", 13),
  REQUEST_SELECTION_STRATEGY: readSelectionStrategyEnv("REQUEST_SELECTION_STRATEGY", "random"),
  DB_MODE: (process.env.DB_MODE || "mysql") as "mysql" | "memory",
  DB_HOST: process.env.DB_HOST,
  DB_PORT: readIntegerEnv("DB_PORT", 3306),
  DB_USERNAME: process.env.DB_USERNAME,
  DB_PASSWORD: process.env.DB_PASSWORD,
  SECRETS_KEY: process.env.SECRETS_KEY || "",
  DB_NAME: process.env.DB_NAME,
  DB_SSL_MODE: (process.env.DB_SSL_MODE || "") as "" | "disabled" | "verify-identity",
  DB_SSL_CA_FILE: process.env.DB_SSL_CA_FILE || "",
  DB_SSL_SERVERNAME: process.env.DB_SSL_SERVERNAME || "",
  SAVE_TO_DB: process.env.SAVE_TO_DB === "true",
  NOTIFY_ENABLED: process.env.NOTIFY_ENABLED === "true",
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  LINE_USER_ID: process.env.LINE_USER_ID || "",
  LINEJS_TEST_ENABLED: process.env.LINEJS_TEST_ENABLED === "true",
  LINEJS_TEST_TARGET_ID: process.env.LINEJS_TEST_TARGET_ID || process.env.LINE_USER_ID || "",
  LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS:
    process.env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS ||
    process.env.LINEJS_TEST_TARGET_ID ||
    process.env.LINE_USER_ID ||
    "",
  LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE:
    process.env.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE ||
    process.env.LINEJS_TEST_TARGET_ID ||
    process.env.LINE_USER_ID ||
    "",
  LINEJS_TEST_DEVICE: process.env.LINEJS_TEST_DEVICE || "IOSIPAD",
  LINEJS_TEST_STORAGE_PATH: process.env.LINEJS_TEST_STORAGE_PATH || "data/linejs-storage.json",
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "",
  NOTIFY_MODE: (process.env.NOTIFY_MODE || "batch") as "each" | "batch",
  NOTIFY_ORIGINS: parseCommaSeparated(process.env.NOTIFY_ORIGINS),
  NOTIFY_DESTINATIONS: parseCommaSeparated(process.env.NOTIFY_DESTINATIONS),
  NOTIFY_VEHICLE_TYPES: parseCommaSeparated(process.env.NOTIFY_VEHICLE_TYPES),
  NOTIFY_MIN_TRIPS: readIntegerEnv("NOTIFY_MIN_TRIPS", 1),
  AUTO_ACCEPT_ENABLED: process.env.AUTO_ACCEPT_ENABLED === "true",
  HTTP_ENABLED: process.env.HTTP_ENABLED === "true",
  HTTP_PORT: readIntegerEnv("HTTP_PORT", 3000),
  HTTP_ALLOWED_ORIGINS: parseCommaSeparated(process.env.HTTP_ALLOWED_ORIGINS),
  HTTP_TRUST_PROXY: parseTrustProxy(process.env.HTTP_TRUST_PROXY),
  JWT_SECRET: process.env.JWT_SECRET || "",
  COOKIE_SECRET: process.env.COOKIE_SECRET || "",
  NODE_ENV: process.env.NODE_ENV || "development",
  DEPLOYMENT_MODE: (process.env.DEPLOYMENT_MODE || (isLegacyDeployMode() ? "legacy" : "protected-a3")) as
    | "legacy"
    | "protected-a3",
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
  ADMIN_ROLE: (process.env.ADMIN_ROLE || "admin") as "admin" | "user",
  CODEX_IMAGE_MODEL: process.env.CODEX_IMAGE_MODEL || "",
  CODEX_IMAGE_PROVIDER: (process.env.CODEX_IMAGE_PROVIDER || "auto") as
    | "auto"
    | "codex-cli"
    | "codex-device",
  CODEX_IMAGE_TIMEOUT_MS: readIntegerEnv("CODEX_IMAGE_TIMEOUT_MS", DEFAULT_CODEX_IMAGE_TIMEOUT_MS),
  CODEX_IMAGE_MAX_BYTES: readIntegerEnv("CODEX_IMAGE_MAX_BYTES", 10 * 1024 * 1024),
  LINE_IMAGE_LISTENER_CHAT_ID: process.env.LINE_IMAGE_LISTENER_CHAT_ID || "",
} as const;

export function validateRuntimeConfig(): void {
  const missing: string[] = [];
  const invalid: string[] = [];
  const usesDatabase = env.SAVE_TO_DB || env.HTTP_ENABLED || env.AUTO_ACCEPT_ENABLED;

  let runtimeRole = env.SPX_ROLE;
  let runTeamIds = env.RUN_TEAM_IDS;
  let runTeamIdsValid = true;

  try {
    runtimeRole = parseRuntimeRole(process.env.SPX_ROLE);
  } catch (error) {
    invalid.push(getErrorMessage(error));
  }

  try {
    runTeamIds = parseRunTeamIds(process.env.RUN_TEAM_IDS);
  } catch (error) {
    runTeamIdsValid = false;
    invalid.push(getErrorMessage(error));
  }

  try {
    requireNodeIdForDistributedRole(runtimeRole, env.SPX_NODE_ID);
  } catch {
    missing.push("SPX_NODE_ID");
  }

  const httpSurface = httpSurfaceForRole(runtimeRole);
  const runsWebApiHttp = env.HTTP_ENABLED && httpSurface === "web-api";
  const runsSpxApiClient = runtimeRole === "worker" || runtimeRole === "combined";

  if (runtimeRole === "worker" && runTeamIdsValid && runTeamIds.length === 0)
    invalid.push("RUN_TEAM_IDS must be set when SPX_ROLE=worker");
  if (runtimeRole === "worker" && !env.NOTIFIER_API_URL) missing.push("NOTIFIER_API_URL");
  const dedicatedRuntimeRole =
    runtimeRole === "poller-service" || runtimeRole === "auto-accept-service";
  if (dedicatedRuntimeRole && runTeamIdsValid && runTeamIds.length === 0)
    invalid.push(`RUN_TEAM_IDS must be set when SPX_ROLE=${runtimeRole}`);
  if (dedicatedRuntimeRole && !env.NOTIFIER_API_URL) missing.push("NOTIFIER_API_URL");
  if (dedicatedRuntimeRole && !env.NOTIFIER_SHARED_SECRET.trim())
    missing.push("NOTIFIER_SHARED_SECRET");
  if (dedicatedRuntimeRole && env.HTTP_ENABLED)
    invalid.push("HTTP_ENABLED cannot be true for a headless SPX_ROLE");
  if (dedicatedRuntimeRole && env.NODE_ENV === "production" && env.DB_MODE === "memory")
    invalid.push(`DB_MODE=memory is not allowed for production SPX_ROLE=${runtimeRole}`);
  if (runtimeRole === "realtime-service" && env.NODE_ENV === "production" && env.DB_MODE === "memory")
    invalid.push("DB_MODE=memory is not allowed for production SPX_ROLE=realtime-service");
  if (runtimeRole === "poller-service" && !env.AUTO_ACCEPT_JOB_CUTOVER_EPOCH.trim())
    invalid.push(`SPX_ROLE=poller-service requires AUTO_ACCEPT_JOB_CUTOVER_EPOCH`);
  if (runtimeRole === "poller-service" && env.AUTO_ACCEPT_JOB_CUTOVER_EPOCH.trim() !== "") {
    const epoch = env.AUTO_ACCEPT_JOB_CUTOVER_EPOCH.trim();
    if (
      epoch.length > 80
      || epoch !== process.env.AUTO_ACCEPT_JOB_CUTOVER_EPOCH
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(epoch)
    )
      invalid.push("AUTO_ACCEPT_JOB_CUTOVER_EPOCH must be a concrete bounded identifier");
  }
  for (const loopFlag of [
    "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED",
    "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
    "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
  ] as const) {
    if (process.env[loopFlag] !== "true") continue;
    if (
      runtimeRole === "auto-accept-service" ||
      runtimeRole === "worker" ||
      runtimeRole === "combined"
    ) continue;
    invalid.push(`${loopFlag} requires SPX_ROLE=auto-accept-service, worker, or combined`);
  }
  for (const pollerFlag of [
    "AUTO_ACCEPT_JOB_SHADOW_ENABLED",
    "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED",
    "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED",
  ] as const) {
    if (process.env[pollerFlag] !== "true") continue;
    if (
      runtimeRole === "poller-service" ||
      runtimeRole === "worker" ||
      runtimeRole === "combined"
    ) continue;
    invalid.push(`${pollerFlag} requires SPX_ROLE=poller-service, worker, or combined`);
  }
  if (
    env.AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED &&
    env.AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS.length === 0
  )
    invalid.push(
      "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS must be set when AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED=true",
    );
  if (
    env.AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED &&
    env.AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS.length === 0
  )
    invalid.push(
      "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS must be set when AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED=true",
    );
  for (const workerFlag of [
    "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED",
    "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
    "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
  ] as const) {
    if (env[workerFlag] && runTeamIdsValid && runTeamIds.length === 0)
      invalid.push(`RUN_TEAM_IDS must be set when ${workerFlag}=true`);
  }
  if (env.AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED && env.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED)
    invalid.push(
      "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED and AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED cannot both be true",
    );
  if (
    runtimeRole === "auto-accept-service" &&
    process.env.AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED !== "true" &&
    process.env.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED !== "true" &&
    process.env.AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED !== "true"
  )
    invalid.push("SPX_ROLE=auto-accept-service requires at least one auto-accept worker loop");
  if (runtimeRole === "gate6-control") {
    if (!env.HTTP_ENABLED) invalid.push("SPX_ROLE=gate6-control requires HTTP_ENABLED=true");
    if (!env.GATE6_REPOSITORY.trim()) missing.push("GATE6_REPOSITORY");
    if (env.GATE6_LINE_NODE_SECRETS.size === 0) missing.push("GATE6_LINE_NODE_SECRETS");
    if (env.GATE6_OCR_NODE_SECRETS.size === 0) missing.push("GATE6_OCR_NODE_SECRETS");
    const sharedNodeIds = [...env.GATE6_LINE_NODE_SECRETS.keys()].filter((nodeId) =>
      env.GATE6_OCR_NODE_SECRETS.has(nodeId),
    );
    if (sharedNodeIds.length > 0)
      invalid.push("GATE6_LINE_NODE_SECRETS and GATE6_OCR_NODE_SECRETS identities must be disjoint");
    const lineSecrets = new Set(
      [...env.GATE6_LINE_NODE_SECRETS.values()].map((ring) => ring.active),
    );
    const overlaps = [...env.GATE6_OCR_NODE_SECRETS.values()].some((ring) =>
      lineSecrets.has(ring.active),
    );
    if (overlaps)
      invalid.push("GATE6_LINE_NODE_SECRETS and GATE6_OCR_NODE_SECRETS secrets must be distinct");
  }
  if (runtimeRole === "realtime-service") {
    if (!env.HTTP_ENABLED) invalid.push("SPX_ROLE=realtime-service requires HTTP_ENABLED=true");
    if (env.REALTIME_SERVICE_URL !== "")
      invalid.push("REALTIME_SERVICE_URL must be empty for SPX_ROLE=realtime-service");
    if (!(process.env.REALTIME_TRUSTED_NODE_IDS ?? "").trim())
      missing.push("REALTIME_TRUSTED_NODE_IDS");
    if (!(process.env.REALTIME_NODE_SECRETS ?? "").trim()) missing.push("REALTIME_NODE_SECRETS");
    if (env.REALTIME_ADMIN_NODE_IDS.size === 0)
      invalid.push("REALTIME_ADMIN_NODE_IDS must contain at least one trusted admin node");

    const adminOutsideTrusted = [...env.REALTIME_ADMIN_NODE_IDS].some(
      (nodeId) => !env.REALTIME_TRUSTED_NODE_IDS.has(nodeId),
    );
    if (adminOutsideTrusted)
      invalid.push("REALTIME_ADMIN_NODE_IDS must contain only trusted node ids");
    const teamNodeOutsideTrusted = [...env.REALTIME_ALLOWED_NODE_TEAMS.keys()].some(
      (nodeId) => !env.REALTIME_TRUSTED_NODE_IDS.has(nodeId),
    );
    if (teamNodeOutsideTrusted)
      invalid.push("REALTIME_ALLOWED_NODE_TEAMS must contain only trusted node ids");
    const overlap = [...env.REALTIME_ADMIN_NODE_IDS].some((nodeId) =>
      env.REALTIME_ALLOWED_NODE_TEAMS.has(nodeId),
    );
    const classifiedNodeIds = new Set([
      ...env.REALTIME_ADMIN_NODE_IDS,
      ...env.REALTIME_ALLOWED_NODE_TEAMS.keys(),
    ]);
    if (overlap || !sameKeySet(env.REALTIME_TRUSTED_NODE_IDS, classifiedNodeIds))
      invalid.push("REALTIME trusted node ids must be classified exactly once without overlap");
    if (
      env.REALTIME_NODE_SECRETS.size > 0 &&
      !sameKeySet(env.REALTIME_TRUSTED_NODE_IDS, env.REALTIME_NODE_SECRETS)
    )
      invalid.push("REALTIME_NODE_SECRETS identities must exactly match REALTIME_TRUSTED_NODE_IDS");
    if (env.REALTIME_NODE_SECRETS.size > 1 && hasDuplicateSecretValues(env.REALTIME_NODE_SECRETS))
      invalid.push("REALTIME_NODE_SECRETS contains a duplicate secret value");
  } else if (runtimeRole !== "api" && env.REALTIME_NODE_SECRETS.size > 0) {
    invalid.push(`REALTIME_NODE_SECRETS is not allowed for SPX_ROLE=${runtimeRole}`);
  }

  if (runtimeRole === "notification-service" && !env.LINE_SERVICE_URL.trim())
    missing.push("LINE_SERVICE_URL");
  const isLegacy = isLegacyDeployMode();
  const productionRuntime = env.NODE_ENV === "production";
  const productionA3Runtime = productionRuntime && !isLegacy;
  if (
    (runtimeRole === "notification-service" ||
      runtimeRole === "line-service" ||
      (runsWebApiHttp && env.LINE_SERVICE_URL.trim())) &&
    !env.LINE_SERVICE_SEND_SECRET.trim() &&
    !(productionRuntime && runtimeRole === "line-service" && env.LINE_SERVICE_SEND_NODE_SECRETS.size > 0)
  )
    missing.push("LINE_SERVICE_SEND_SECRET");
  if (
    (runtimeRole === "line-service" || (runsWebApiHttp && env.LINE_SERVICE_URL.trim())) &&
    !env.LINE_SERVICE_ADMIN_SECRET.trim()
  )
    missing.push("LINE_SERVICE_ADMIN_SECRET");
  if (
    (runtimeRole === "worker" ||
      runtimeRole === "notifier" ||
      runtimeRole === "notification-service") &&
    env.NODE_ENV !== "production" &&
    !env.NOTIFIER_SHARED_SECRET.trim()
  )
    missing.push("NOTIFIER_SHARED_SECRET");
  if (env.NODE_ENV !== "production" && runtimeRole === "ocr-service" && !env.NOTIFIER_SHARED_SECRET.trim())
    missing.push("NOTIFIER_SHARED_SECRET");
  if (runtimeRole === "ocr-service" && env.NODE_ENV !== "production") {
    if (!env.OCR_SERVICE_ADMIN_SECRET.trim()) {
      missing.push("OCR_SERVICE_ADMIN_SECRET");
    } else if (
      env.NOTIFIER_SHARED_SECRET.trim() !== "" &&
      env.OCR_SERVICE_ADMIN_SECRET.trim() === env.NOTIFIER_SHARED_SECRET.trim()
    )
      invalid.push("OCR_SERVICE_ADMIN_SECRET must be distinct from NOTIFIER_SHARED_SECRET");
  }
  if (productionRuntime) {
    if (runtimeRole === "combined")
      invalid.push("SPX_ROLE=combined is not allowed in production");
    if (
      (runtimeRole === "api" ||
        runtimeRole === "worker" ||
        runtimeRole === "notifier" ||
        runtimeRole === "notification-service") &&
      (process.env.SECRETS_KEY ?? "").trim().length < 32
    )
      missing.push("SECRETS_KEY");
  }
  if (productionA3Runtime) {
    if (env.DB_MODE === "mysql" && env.DB_HOST && isIpLiteral(env.DB_HOST.trim()))
      invalid.push("DB_HOST must be a DNS hostname in production");
    if (env.DB_MODE === "mysql" && runtimeRole !== "ocr-service") {
      if (env.DB_SSL_MODE !== "verify-identity")
        invalid.push("DB_SSL_MODE must be verify-identity in production");
      if (!env.DB_SSL_CA_FILE.trim()) missing.push("DB_SSL_CA_FILE");
    }
    // Dedicated poller/auto-accept roles always work against the durable job
    // database, even though their HTTP-less startup does not set the legacy
    // usesDatabase flags.
    if (dedicatedRuntimeRole) {
      if (!env.DB_HOST) missing.push("DB_HOST");
      if (!env.DB_USERNAME) missing.push("DB_USERNAME");
      if (!env.DB_PASSWORD) missing.push("DB_PASSWORD");
      if (!env.DB_NAME) missing.push("DB_NAME");
    }
    if (runtimeRole === "worker" && !env.NOTIFICATION_NODE_SECRET.trim())
      missing.push("NOTIFICATION_NODE_SECRET");
    if (runtimeRole === "notifier" || runtimeRole === "notification-service") {
      const nodeSecrets = env.NOTIFICATION_NODE_SECRETS;
      const allowedTeams = env.NOTIFICATION_ALLOWED_NODE_TEAMS;
      if (nodeSecrets.size === 0) missing.push("NOTIFICATION_NODE_SECRETS");
      if (allowedTeams.size === 0) missing.push("NOTIFICATION_ALLOWED_NODE_TEAMS");
      if (nodeSecrets.size > 0 && allowedTeams.size > 0 && !sameKeySet(nodeSecrets, allowedTeams))
        invalid.push(
          "NOTIFICATION_NODE_SECRETS identities must exactly match NOTIFICATION_ALLOWED_NODE_TEAMS",
        );
      if (nodeSecrets.size > 1 && hasDuplicateSecretValues(nodeSecrets))
        invalid.push("duplicate secret values in NOTIFICATION_NODE_SECRETS");
      if (runtimeRole === "notifier" && !env.LINE_SERVICE_URL.trim())
        missing.push("LINE_SERVICE_URL");
    }
    if (runtimeRole === "line-service") {
      const sendSecrets = env.LINE_SERVICE_SEND_NODE_SECRETS;
      const sendAllowed = env.LINE_SEND_ALLOWED_NODE_IDS;
      if (sendSecrets.size === 0) missing.push("LINE_SERVICE_SEND_NODE_SECRETS");
      if (sendAllowed.size === 0) missing.push("LINE_SEND_ALLOWED_NODE_IDS");
      if (sendSecrets.size > 0 && sendAllowed.size > 0 && !sameKeySet(sendSecrets, sendAllowed))
        invalid.push("LINE_SERVICE_SEND_NODE_SECRETS identities must exactly match LINE_SEND_ALLOWED_NODE_IDS");
      if (!env.LINE_SERVICE_ADMIN_SECRET.trim()) {
        missing.push("LINE_SERVICE_ADMIN_SECRET");
      } else if (
        sendSecrets.size > 0 &&
        [...sendSecrets.values()].some((ring) => ring.active === env.LINE_SERVICE_ADMIN_SECRET.trim())
      )
        invalid.push("LINE_SERVICE_ADMIN_SECRET must be distinct from LINE_SERVICE_SEND_NODE_SECRETS");
      if (!env.OCR_NODE_SECRET.trim()) missing.push("OCR_NODE_SECRET");
      if (!env.GATE6_CONTROL_NODE_SECRET.trim()) missing.push("GATE6_CONTROL_NODE_SECRET");
      if (!env.GATE6_LINE_PERMIT_KEY_ID.trim()) missing.push("GATE6_LINE_PERMIT_KEY_ID");
      if (!env.GATE6_LINE_PERMIT_PUBLIC_KEY_FILE.trim())
        missing.push("GATE6_LINE_PERMIT_PUBLIC_KEY_FILE");
    }
    if (runtimeRole === "ocr-service") {
      const ocrSecrets = env.OCR_NODE_SECRETS;
      const lineIds = env.OCR_ALLOWED_LINE_NODE_IDS;
      const adminIds = env.OCR_ADMIN_NODE_IDS;
      if (ocrSecrets.size === 0) missing.push("OCR_NODE_SECRETS");
      if (lineIds.size === 0) missing.push("OCR_ALLOWED_LINE_NODE_IDS");
      if (adminIds.size === 0) missing.push("OCR_ADMIN_NODE_IDS");
      const classified = new Set([...lineIds, ...adminIds]);
      const overlap = [...lineIds].some((id) => adminIds.has(id));
      if (overlap)
        invalid.push("OCR node identities must be classified exactly once (line/admin overlap)");
      if (ocrSecrets.size > 0 && classified.size > 0 && !sameKeySet(ocrSecrets, classified))
        invalid.push(
          "OCR_NODE_SECRETS identities must exactly match OCR_ALLOWED_LINE_NODE_IDS and OCR_ADMIN_NODE_IDS",
        );
      if (!env.OCR_REPLAY_LEDGER_DIR.trim()) {
        missing.push("OCR_REPLAY_LEDGER_DIR");
      } else if (!isCanonicalLedgerDir(env.OCR_REPLAY_LEDGER_DIR.trim()))
        invalid.push("OCR_REPLAY_LEDGER_DIR must be a canonical absolute path under /app/data/");
      if (!env.GATE6_CONTROL_NODE_SECRET.trim()) missing.push("GATE6_CONTROL_NODE_SECRET");
      if (!env.GATE6_OCR_PERMIT_KEY_ID.trim()) missing.push("GATE6_OCR_PERMIT_KEY_ID");
      if (!env.GATE6_OCR_PERMIT_PUBLIC_KEY_FILE.trim())
        missing.push("GATE6_OCR_PERMIT_PUBLIC_KEY_FILE");
      if (env.CODEX_IMAGE_PROVIDER !== "codex-device")
        invalid.push("production OCR requires CODEX_IMAGE_PROVIDER=codex-device");
    }
  }
  if (!["development", "test", "production"].includes(process.env.NODE_ENV ?? ""))
    invalid.push("NODE_ENV must be exactly development, test, or production");
  if (env.NOTIFIER_AUTH_MODE !== "hmac" && env.NOTIFIER_AUTH_MODE !== "bearer")
    invalid.push("NOTIFIER_AUTH_MODE must be hmac or bearer");
  if (env.NOTIFIER_API_URL && !isValidUrl(env.NOTIFIER_API_URL))
    invalid.push("NOTIFIER_API_URL must be a valid URL");
  if (env.LINE_SERVICE_URL && !isValidUrl(env.LINE_SERVICE_URL))
    invalid.push("LINE_SERVICE_URL must be a valid URL");
  if (env.OCR_SERVICE_URL && !isValidUrl(env.OCR_SERVICE_URL))
    invalid.push("OCR_SERVICE_URL must be a valid URL");
  if (!isPositiveInteger(env.NOTIFIER_REQUEST_TIMEOUT_MS))
    invalid.push("NOTIFIER_REQUEST_TIMEOUT_MS must be a positive integer");
  if (!isPositiveInteger(env.LINE_SERVICE_REQUEST_TIMEOUT_MS))
    invalid.push("LINE_SERVICE_REQUEST_TIMEOUT_MS must be a positive integer");
  if (!isPositiveInteger(env.OCR_SERVICE_REQUEST_TIMEOUT_MS))
    invalid.push("OCR_SERVICE_REQUEST_TIMEOUT_MS must be a positive integer");
  if (!isPositiveInteger(env.NOTIFIER_RETRY_MAX_ATTEMPTS))
    invalid.push("NOTIFIER_RETRY_MAX_ATTEMPTS must be a positive integer");
  if (!isPositiveInteger(env.NOTIFIER_RETRY_BASE_DELAY_MS))
    invalid.push("NOTIFIER_RETRY_BASE_DELAY_MS must be a positive integer");

  if (runsSpxApiClient || dedicatedRuntimeRole) {
    if (!env.API_URL) missing.push("API_URL");
    if (!env.APP_NAME) missing.push("APP_NAME");
    if (!env.REFERER) missing.push("REFERER");
  }

  try {
    normalizeRealtimeServiceUrl(process.env.REALTIME_SERVICE_URL);
  } catch (error) {
    invalid.push(`REALTIME_SERVICE_URL ${getErrorMessage(error)}`);
  }
  for (const [name, parser] of [
    ["REALTIME_TRUSTED_NODE_IDS", parseRealtimeTrustedNodeIds],
    ["REALTIME_ADMIN_NODE_IDS", parseRealtimeAdminNodeIds],
    ["REALTIME_NODE_SECRETS", parseRealtimeNodeSecrets],
  ] as const) {
    try {
      parser(process.env[name]);
    } catch (error) {
      invalid.push(getErrorMessage(error));
    }
  }
  if (env.REALTIME_SERVICE_URL) {
    if (!env.SPX_NODE_ID.trim()) missing.push("SPX_NODE_ID");
    if (!env.REALTIME_SHARED_SECRET.trim()) missing.push("REALTIME_SHARED_SECRET");
  }
  if (!isPositiveInteger(env.REALTIME_REQUEST_TIMEOUT_MS))
    invalid.push("REALTIME_REQUEST_TIMEOUT_MS must be a positive integer");

  for (const booleanName of [
    "AUTO_ACCEPT_JOB_SHADOW_ENABLED",
    "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED",
    "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
    "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
    "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED",
    "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED",
  ] as const) {
    if (!isBooleanString(process.env[booleanName]))
      invalid.push(`${booleanName} must be true or false`);
  }
  for (const integerName of [
    "AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS",
    "AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE",
    "AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS",
    "AUTO_ACCEPT_JOB_REAL_INTERVAL_MS",
    "AUTO_ACCEPT_JOB_REAL_BATCH_SIZE",
    "AUTO_ACCEPT_JOB_REAL_LEASE_MS",
    "AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS",
    "AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE",
    "AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS",
  ] as const) {
    if (!isPositiveInteger(env[integerName]))
      invalid.push(`${integerName} must be a positive integer`);
  }
  for (const [enabled, teamIdsName] of [
    [env.AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED, "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS"],
    [env.AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED, "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS"],
  ] as const) {
    if (!enabled) continue;
    try {
      parseRunTeamIds(process.env[teamIdsName]);
    } catch {
      invalid.push(`${teamIdsName} must contain positive integer team ids`);
    }
  }

  if (env.API_URL && !isValidUrl(env.API_URL)) invalid.push("API_URL must be a valid URL");
  if (env.API_URL && !env.API_URL.includes("/booking/bidding/list"))
    invalid.push("API_URL must contain /booking/bidding/list");
  if (env.REFERER && !isValidUrl(env.REFERER)) invalid.push("REFERER must be a valid URL");
  // POLL_INTERVAL_MS is intentionally only checked for positivity. The operator
  // controls how aggressive polling is — a lower interval captures more bidding
  // jobs (a competitive advantage), and ticks are serialized so a low value
  // cannot busy-loop. Bound resource use via BOOKING_DETAIL_CONCURRENCY (capped
  // at 50 below) rather than flooring the interval.
  if (!isPositiveInteger(env.POLL_INTERVAL_MS))
    invalid.push("POLL_INTERVAL_MS must be a positive integer in milliseconds");
  if (!isPositiveInteger(env.BOOKING_DETAIL_CONCURRENCY) || env.BOOKING_DETAIL_CONCURRENCY > 50)
    invalid.push("BOOKING_DETAIL_CONCURRENCY must be an integer from 1 to 50");
  if (!isNonNegativeInteger(env.BOOKING_REPROCESS_COOLDOWN_MS))
    invalid.push(
      "BOOKING_REPROCESS_COOLDOWN_MS must be a non-negative integer in milliseconds (0 disables the re-process cooldown)",
    );
  if (!isPositiveInteger(env.BIDDING_PAGE_NO))
    invalid.push("BIDDING_PAGE_NO must be a positive integer");
  if (!isPositiveInteger(env.BIDDING_PAGE_COUNT))
    invalid.push("BIDDING_PAGE_COUNT must be a positive integer");
  if (!isNonNegativeInteger(env.REQUEST_CTIME_START))
    invalid.push("REQUEST_CTIME_START must be a non-negative integer Unix timestamp");
  if (env.BIDDING_VEHICLE_TYPE !== undefined && !isPositiveInteger(env.BIDDING_VEHICLE_TYPE))
    invalid.push("BIDDING_VEHICLE_TYPE must be empty or a positive integer");
  if (
    process.env.REQUEST_SELECTION_STRATEGY !== undefined &&
    process.env.REQUEST_SELECTION_STRATEGY.trim() !== "" &&
    !["random", "last", "first"].includes(process.env.REQUEST_SELECTION_STRATEGY.trim().toLowerCase())
  ) {
    invalid.push("REQUEST_SELECTION_STRATEGY must be 'random', 'last', or 'first'");
  }
  if (!isPositiveInteger(env.NOTIFY_MIN_TRIPS))
    invalid.push("NOTIFY_MIN_TRIPS must be a positive integer");
  if (!isBooleanString(process.env.DEBUG)) invalid.push("DEBUG must be true or false");
  if (!isBooleanString(process.env.FETCH_DETAILS))
    invalid.push("FETCH_DETAILS must be true or false");
  if (!isBooleanString(process.env.SAVE_TO_DB)) invalid.push("SAVE_TO_DB must be true or false");
  if (!isBooleanString(process.env.NOTIFY_ENABLED))
    invalid.push("NOTIFY_ENABLED must be true or false");
  if (!isBooleanString(process.env.LINEJS_TEST_ENABLED))
    invalid.push("LINEJS_TEST_ENABLED must be true or false");
  if (!isBooleanString(process.env.AUTO_ACCEPT_ENABLED))
    invalid.push("AUTO_ACCEPT_ENABLED must be true or false");
  if (!isBooleanString(process.env.HTTP_ENABLED))
    invalid.push("HTTP_ENABLED must be true or false");
  if (!isBooleanString(process.env.REQUEST_TAB_PENDING_CONFIRMATION))
    invalid.push("REQUEST_TAB_PENDING_CONFIRMATION must be true or false");

  const listError =
    validateList("NOTIFY_ORIGINS", env.NOTIFY_ORIGINS) ??
    validateList("NOTIFY_DESTINATIONS", env.NOTIFY_DESTINATIONS) ??
    validateList("NOTIFY_VEHICLE_TYPES", env.NOTIFY_VEHICLE_TYPES);
  if (listError) invalid.push(listError);

  // Unconditionally validate DB_MODE. `env.DB_MODE` is cast to "mysql" | "memory"
  // above, so an unset value safely defaults to "mysql"; but any explicitly set
  // value must be exactly "mysql" or "memory" — otherwise the cast would silently
  // hide a typo (e.g. "sqlite", "Memory", "") that later misroutes DB selection.
  if (env.DB_MODE !== "mysql" && env.DB_MODE !== "memory") {
    invalid.push("DB_MODE must be 'mysql' or 'memory'");
  }

  // ocr-service is a stateless OCR proxy: its HTTP surface and provider calls
  // never touch the application database, so MySQL fields stay optional.
  if (usesDatabase && env.DB_MODE !== "memory" && runtimeRole !== "ocr-service") {
    if (!env.DB_HOST) missing.push("DB_HOST");
    if (!env.DB_USERNAME) missing.push("DB_USERNAME");
    if (!env.DB_PASSWORD) missing.push("DB_PASSWORD");
    if (!env.DB_NAME) missing.push("DB_NAME");
    if (!isPositiveInteger(env.DB_PORT) || env.DB_PORT > 65535)
      invalid.push("DB_PORT must be an integer from 1 to 65535");
  }

  if (env.DISCORD_WEBHOOK_URL && !isValidUrl(env.DISCORD_WEBHOOK_URL))
    invalid.push("DISCORD_WEBHOOK_URL must be a valid URL");
  if (env.NOTIFY_MODE !== "each" && env.NOTIFY_MODE !== "batch")
    invalid.push("NOTIFY_MODE must be 'each' or 'batch'");

  if (!isPositiveInteger(env.CODEX_IMAGE_TIMEOUT_MS))
    invalid.push("CODEX_IMAGE_TIMEOUT_MS must be a positive integer in milliseconds");
  if (!isPositiveInteger(env.CODEX_IMAGE_MAX_BYTES))
    invalid.push("CODEX_IMAGE_MAX_BYTES must be a positive integer in bytes");
  if (
    env.CODEX_IMAGE_PROVIDER !== "auto" &&
    env.CODEX_IMAGE_PROVIDER !== "codex-cli" &&
    env.CODEX_IMAGE_PROVIDER !== "codex-device"
  ) {
    invalid.push("CODEX_IMAGE_PROVIDER must be auto, codex-cli, or codex-device");
  }

  if (env.LINEJS_TEST_ENABLED) {
    if (!env.LINEJS_TEST_DEVICE.trim()) invalid.push("LINEJS_TEST_DEVICE must not be empty");
    if (!env.LINEJS_TEST_STORAGE_PATH.trim())
      invalid.push("LINEJS_TEST_STORAGE_PATH must not be empty");
  }

  if (env.LINEJS_TEST_ENABLED && !env.LINEJS_TEST_TARGET_ID) {
    // Not fatal — target can be set later via UI or .env
    console.warn(
      "⚠ LINEJS_TEST_TARGET_ID is empty; LINE Bot notifications won't work until it is set",
    );
  }

  if (env.HTTP_ENABLED && httpSurface === null) {
    invalid.push("HTTP_ENABLED cannot be true when SPX_ROLE=worker");
  }

  if (runsWebApiHttp) {
    if (!isPositiveInteger(env.HTTP_PORT) || env.HTTP_PORT > 65535)
      invalid.push("HTTP_PORT must be an integer from 1 to 65535");
    for (const origin of env.HTTP_ALLOWED_ORIGINS) {
      if (!isValidUrl(origin))
        invalid.push(`HTTP_ALLOWED_ORIGINS contains an invalid URL: ${origin}`);
    }
    if (!env.JWT_SECRET || !isValidJwtSecret(env.JWT_SECRET))
      invalid.push("JWT_SECRET must be set and at least 32 characters long when HTTP_ENABLED=true");
    if (!env.COOKIE_SECRET || !isValidJwtSecret(env.COOKIE_SECRET))
      invalid.push(
        "COOKIE_SECRET must be set and at least 32 characters long when HTTP_ENABLED=true",
      );
    if (!isStrongPassword(env.ADMIN_PASSWORD))
      invalid.push(
        "ADMIN_PASSWORD must be set and at least 12 characters long when HTTP_ENABLED=true",
      );
    if (!env.ADMIN_USERNAME || env.ADMIN_USERNAME.trim().length < 3)
      invalid.push("ADMIN_USERNAME must be at least 3 characters long");
    if (env.ADMIN_ROLE !== "admin" && env.ADMIN_ROLE !== "user")
      invalid.push("ADMIN_ROLE must be admin or user");
  } else if (env.HTTP_ENABLED && (!isPositiveInteger(env.HTTP_PORT) || env.HTTP_PORT > 65535)) {
    invalid.push("HTTP_PORT must be an integer from 1 to 65535");
  }

  // Both categories are reported together so operators (and the config test
  // harness) always see every problem in one failure output.
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`Missing required .env values: ${missing.join(", ")}`);
  if (invalid.length > 0) problems.push(`Invalid .env values: ${invalid.join("; ")}`);
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/**
 * Production-only bootstrap secret gate: the settings-encryption key must be
 * present and strong before any encrypted column can be written or read.
 * Deliberately independent of validateRuntimeConfig so operator tooling can
 * run it before the full runtime contract exists.
 */
export function validateProductionSecrets(config: {
  NODE_ENV?: string;
  SECRETS_KEY?: string;
}): void {
  if (config.NODE_ENV !== "production") return;
  const key = (config.SECRETS_KEY ?? "").trim();
  if (key.length < 32) {
    throw new Error("SECRETS_KEY must be at least 32 characters in production");
  }
}

function assertInternalHttpOrigin(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("internal service URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("internal service URL must be http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("internal service URL must not contain credentials");
  }
  if (parsed.search) {
    throw new Error("internal service URL must not contain a query");
  }
  if (parsed.hash) {
    throw new Error("internal service URL must not contain a fragment");
  }
  return parsed;
}

/**
 * Normalizes the realtime API base to the canonical internal endpoint.
 */
export function normalizeRealtimeServiceUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";
  const parsed = assertInternalHttpOrigin(trimmed);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/internal/realtime") {
    throw new Error("must use the /internal/realtime path");
  }
  return parsed.origin + "/internal/realtime";
}

function safeNormalizeRealtimeServiceUrl(raw: string | undefined): string {
  try {
    return normalizeRealtimeServiceUrl(raw);
  } catch {
    return (raw ?? "").trim();
  }
}

/**
 * Normalizes the notifier API base to the exact signed notification-events
 * endpoint; only same-origin defaults and the canonical path are accepted.
 */
export function normalizeNotifierApiUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";
  const parsed = assertInternalHttpOrigin(trimmed);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/internal" && path !== "/internal/notification-events") {
    throw new Error("notifier API URL path must end with /internal/notification-events");
  }
  return parsed.origin + "/internal/notification-events";
}

/** Normalizes the line-service base to its bare origin. */
export function normalizeLineServiceUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";
  const parsed = assertInternalHttpOrigin(trimmed);
  if (parsed.pathname.replace(/\/+$/, "") !== "") {
    throw new Error("line service URL must be origin-only (no path)");
  }
  return parsed.origin;
}

/** Normalizes the ocr-service base to its bare origin. */
export function normalizeOcrServiceUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";
  const parsed = assertInternalHttpOrigin(trimmed);
  if (parsed.pathname.replace(/\/+$/, "") !== "") {
    throw new Error("ocr service URL must be origin-only (no path)");
  }
  return parsed.origin;
}
