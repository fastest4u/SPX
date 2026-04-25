import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envFilePath = resolve(process.cwd(), ".env");

if (existsSync(envFilePath)) {
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

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function readIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const value = Number(rawValue);
  return Number.isInteger(value) ? value : Number.NaN;
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
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

export const env = {
  API_URL: process.env.API_URL || "",
  POLL_INTERVAL_MS: readIntegerEnv("POLL_INTERVAL_MS", 30000),
  COOKIE: process.env.COOKIE || "",
  DEVICE_ID: process.env.DEVICE_ID || "",
  APP_NAME: process.env.APP_NAME || "",
  REFERER: process.env.REFERER || "",
  DEBUG: process.env.DEBUG === "true",
  FETCH_DETAILS: process.env.FETCH_DETAILS === "true",
  BIDDING_PAGE_NO: readIntegerEnv("BIDDING_PAGE_NO", 1),
  BIDDING_PAGE_COUNT: readIntegerEnv("BIDDING_PAGE_COUNT", 100),
  REQUEST_TAB_PENDING_CONFIRMATION: process.env.REQUEST_TAB_PENDING_CONFIRMATION !== "false",
  REQUEST_CTIME_START: readIntegerEnv("REQUEST_CTIME_START", 1776358800),
  DB_HOST: process.env.DB_HOST,
  DB_PORT: readIntegerEnv("DB_PORT", 3306),
  DB_USERNAME: process.env.DB_USERNAME,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_NAME: process.env.DB_NAME,
  SAVE_TO_DB: process.env.SAVE_TO_DB === "true",
  NOTIFY_ENABLED: process.env.NOTIFY_ENABLED === "true",
  LINE_NOTIFY_TOKEN: process.env.LINE_NOTIFY_TOKEN || "",
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "",
  NOTIFY_MODE: (process.env.NOTIFY_MODE || "batch") as "each" | "batch",
  NOTIFY_ORIGINS: parseCommaSeparated(process.env.NOTIFY_ORIGINS),
  NOTIFY_DESTINATIONS: parseCommaSeparated(process.env.NOTIFY_DESTINATIONS),
  NOTIFY_VEHICLE_TYPES: parseCommaSeparated(process.env.NOTIFY_VEHICLE_TYPES),
  NOTIFY_MIN_TRIPS: readIntegerEnv("NOTIFY_MIN_TRIPS", 1),
  HTTP_ENABLED: process.env.HTTP_ENABLED === "true",
  HTTP_PORT: readIntegerEnv("HTTP_PORT", 3000),
  HTTP_ALLOWED_ORIGINS: parseCommaSeparated(process.env.HTTP_ALLOWED_ORIGINS),
  JWT_SECRET: process.env.JWT_SECRET || "",
  COOKIE_SECRET: process.env.COOKIE_SECRET || "",
  NODE_ENV: process.env.NODE_ENV || "development",
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
  ADMIN_ROLE: (process.env.ADMIN_ROLE || "admin") as "admin" | "editor" | "viewer",
} as const;

export function validateRuntimeConfig(): void {
  const missing: string[] = [];
  const invalid: string[] = [];
  const usesDatabase = env.SAVE_TO_DB || env.HTTP_ENABLED;

  if (!env.API_URL) missing.push("API_URL");
  if (!env.COOKIE) missing.push("COOKIE");
  if (!env.DEVICE_ID) missing.push("DEVICE_ID");
  if (!env.APP_NAME) missing.push("APP_NAME");
  if (!env.REFERER) missing.push("REFERER");

  if (env.API_URL && !isValidUrl(env.API_URL)) invalid.push("API_URL must be a valid URL");
  if (env.API_URL && !env.API_URL.includes("/booking/bidding/list")) invalid.push("API_URL must contain /booking/bidding/list");
  if (env.REFERER && !isValidUrl(env.REFERER)) invalid.push("REFERER must be a valid URL");
  if (!isPositiveInteger(env.POLL_INTERVAL_MS)) invalid.push("POLL_INTERVAL_MS must be a positive integer in milliseconds");
  if (!isPositiveInteger(env.BIDDING_PAGE_NO)) invalid.push("BIDDING_PAGE_NO must be a positive integer");
  if (!isPositiveInteger(env.BIDDING_PAGE_COUNT)) invalid.push("BIDDING_PAGE_COUNT must be a positive integer");
  if (!isNonNegativeInteger(env.REQUEST_CTIME_START)) invalid.push("REQUEST_CTIME_START must be a non-negative integer Unix timestamp");
  if (!isPositiveInteger(env.NOTIFY_MIN_TRIPS)) invalid.push("NOTIFY_MIN_TRIPS must be a positive integer");
  if (!isBooleanString(process.env.DEBUG)) invalid.push("DEBUG must be true or false");
  if (!isBooleanString(process.env.FETCH_DETAILS)) invalid.push("FETCH_DETAILS must be true or false");
  if (!isBooleanString(process.env.SAVE_TO_DB)) invalid.push("SAVE_TO_DB must be true or false");
  if (!isBooleanString(process.env.NOTIFY_ENABLED)) invalid.push("NOTIFY_ENABLED must be true or false");
  if (!isBooleanString(process.env.HTTP_ENABLED)) invalid.push("HTTP_ENABLED must be true or false");
  if (!isBooleanString(process.env.REQUEST_TAB_PENDING_CONFIRMATION)) invalid.push("REQUEST_TAB_PENDING_CONFIRMATION must be true or false");

  const listError = validateList("NOTIFY_ORIGINS", env.NOTIFY_ORIGINS) ?? validateList("NOTIFY_DESTINATIONS", env.NOTIFY_DESTINATIONS) ?? validateList("NOTIFY_VEHICLE_TYPES", env.NOTIFY_VEHICLE_TYPES);
  if (listError) invalid.push(listError);

  if (usesDatabase) {
    if (!env.DB_HOST) missing.push("DB_HOST");
    if (!env.DB_USERNAME) missing.push("DB_USERNAME");
    if (!env.DB_PASSWORD) missing.push("DB_PASSWORD");
    if (!env.DB_NAME) missing.push("DB_NAME");
    if (!isPositiveInteger(env.DB_PORT) || env.DB_PORT > 65535) invalid.push("DB_PORT must be an integer from 1 to 65535");
  }

  if (env.NOTIFY_ENABLED) {
    if (!env.LINE_NOTIFY_TOKEN && !env.DISCORD_WEBHOOK_URL) invalid.push("NOTIFY_ENABLED=true but neither LINE_NOTIFY_TOKEN nor DISCORD_WEBHOOK_URL is set");
    if (env.DISCORD_WEBHOOK_URL && !isValidUrl(env.DISCORD_WEBHOOK_URL)) invalid.push("DISCORD_WEBHOOK_URL must be a valid URL");
    if (env.NOTIFY_MODE !== "each" && env.NOTIFY_MODE !== "batch") invalid.push("NOTIFY_MODE must be 'each' or 'batch'");
  }

  if (env.HTTP_ENABLED) {
    if (!isPositiveInteger(env.HTTP_PORT) || env.HTTP_PORT > 65535) invalid.push("HTTP_PORT must be an integer from 1 to 65535");
    for (const origin of env.HTTP_ALLOWED_ORIGINS) {
      if (!isValidUrl(origin)) invalid.push(`HTTP_ALLOWED_ORIGINS contains an invalid URL: ${origin}`);
    }
    if (!env.JWT_SECRET || !isValidJwtSecret(env.JWT_SECRET)) invalid.push("JWT_SECRET must be set and at least 32 characters long when HTTP_ENABLED=true");
    if (!env.COOKIE_SECRET || !isValidJwtSecret(env.COOKIE_SECRET)) invalid.push("COOKIE_SECRET must be set and at least 32 characters long when HTTP_ENABLED=true");
    if (!isStrongPassword(env.ADMIN_PASSWORD)) invalid.push("ADMIN_PASSWORD must be set and at least 12 characters long when HTTP_ENABLED=true");
    if (!env.ADMIN_USERNAME || env.ADMIN_USERNAME.trim().length < 3) invalid.push("ADMIN_USERNAME must be at least 3 characters long");
    if (env.ADMIN_ROLE !== "admin" && env.ADMIN_ROLE !== "editor" && env.ADMIN_ROLE !== "viewer") invalid.push("ADMIN_ROLE must be admin, editor, or viewer");
  }

  if (missing.length > 0) throw new Error(`Missing required .env values: ${missing.join(", ")}`);
  if (invalid.length > 0) throw new Error(`Invalid .env values: ${invalid.join("; ")}`);
}
