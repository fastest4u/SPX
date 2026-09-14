import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { TextDecoder } from "node:util";
import { isIP } from "node:net";
import type { PoolOptions } from "mysql2/promise";

export type DatabaseSslMode = "disabled" | "verify-identity";

export interface MysqlPoolRuntimeConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: DatabaseSslMode;
  sslCaFile: string;
  sslServername?: string;
}

const DB_TIMEZONE = "+00:00";
const MAX_CA_BYTES = 1024 * 1024;

function isIpLiteral(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  return isIP(normalized) !== 0;
}

function isDnsHostname(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    value.split(".").every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readDatabaseCaFile(path: string): string {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_CA_BYTES) {
      throw new Error("invalid CA file");
    }

    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("CA file changed before read");
    }

    const buffer = Buffer.allocUnsafe(MAX_CA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === 0 || length > MAX_CA_BYTES) throw new Error("invalid CA file size");

    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after) || after.size !== BigInt(length)) {
      throw new Error("CA file changed during read");
    }
    const value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    if (
      value.includes("\0") ||
      !value.includes("-----BEGIN CERTIFICATE-----") ||
      !value.includes("-----END CERTIFICATE-----")
    ) {
      throw new Error("invalid CA bundle");
    }
    return value;
  } catch {
    throw new Error("DB_SSL_CA_FILE could not be read");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A close failure does not make it safe to expose filesystem details.
      }
    }
  }
}

export function buildMysqlPoolOptions(config: MysqlPoolRuntimeConfig): PoolOptions {
  const options: PoolOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: "utf8mb4",
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    timezone: DB_TIMEZONE,
    dateStrings: true,
  };

  if (config.sslMode === "disabled") return options;
  if (config.sslMode !== "verify-identity") {
    throw new Error("DB_SSL_MODE must be disabled or verify-identity");
  }
  if (isIpLiteral(config.host)) throw new Error("DB_HOST must be a DNS hostname");
  if (!config.sslCaFile.trim()) throw new Error("DB_SSL_CA_FILE is required");
  const configuredServername = config.sslServername?.trim() ?? "";
  const servername = configuredServername || config.host;
  if (isIpLiteral(servername) || !isDnsHostname(servername)) {
    throw new Error("DB_SSL_SERVERNAME must be a DNS hostname");
  }
  if (
    ["staging-db-proxy", "gate6-db-proxy"].includes(config.host) &&
    (!configuredServername || servername === config.host)
  ) {
    throw new Error("DB_SSL_SERVERNAME must identify the approved upstream through the proxy");
  }

  const ssl = {
    ca: readDatabaseCaFile(config.sslCaFile),
    rejectUnauthorized: true,
    servername,
    verifyIdentity: true,
  } as Exclude<PoolOptions["ssl"], string | undefined> & { servername: string };

  return {
    ...options,
    ssl,
  };
}
