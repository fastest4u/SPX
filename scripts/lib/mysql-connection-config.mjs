import { TextDecoder } from "node:util";
import { createConnection, isIP } from "node:net";
import { resolveFileBackedSecret } from "./file-backed-secret.mjs";
import { readStableRegularFile } from "./safe-file.mjs";

const MAX_CA_FILE_BYTES = 1024 * 1024;
const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;

export function mysqlVerifiedTransport(host, port, servername) {
  if (!isDnsHostname(servername ?? "") || isIpLiteral(servername)) {
    throw new Error("database-servername-required");
  }
  return {
    host: servername,
    port,
    ...(host === servername ? {} : { stream: () => createConnection({ host, port }) }),
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isIpLiteral(host) {
  const normalized = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  return isIP(normalized) !== 0;
}

function isDnsHostname(host) {
  return (
    host.length >= 1 &&
    host.length <= 253 &&
    host.split(".").every((label) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
}

function readCaFile(path) {
  try {
    const bytes = readStableRegularFile(path, "database CA file", {
      maximumBytes: MAX_CA_FILE_BYTES,
    });
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!PEM_CERTIFICATE_PATTERN.test(value)) throw new Error("invalid PEM");
    return value;
  } catch {
    return null;
  }
}

export function mysqlScriptConnectionConfigFromEnv(env = process.env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return { missing: ["database-config-invalid"], value: null };
  }
  if (stringValue(env.DB_MODE) === "memory") {
    return { missing: ["DB_MODE=mysql"], value: null };
  }

  const missing = [];
  const host = stringValue(env.DB_HOST);
  const user = stringValue(env.DB_USERNAME);
  const database = stringValue(env.DB_NAME);
  const port = Number(stringValue(env.DB_PORT) || "3306");
  let password = "";
  try {
    password = resolveFileBackedSecret("DB_PASSWORD", env);
  } catch {
    missing.push("database-credential-invalid");
  }

  if (!host) missing.push("DB_HOST");
  if (!user) missing.push("DB_USERNAME");
  if (!password && !missing.includes("database-credential-invalid")) {
    missing.push("database-credential");
  }
  if (!database) missing.push("DB_NAME");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) missing.push("DB_PORT");

  const production = stringValue(env.NODE_ENV) === "production";
  const configuredSslMode = stringValue(env.DB_SSL_MODE);
  const sslMode = configuredSslMode || (production ? "" : "disabled");
  let ssl = null;
  if (sslMode !== "disabled" && sslMode !== "verify-identity") {
    missing.push("database-tls-mode-invalid");
  } else if (production && sslMode !== "verify-identity") {
    missing.push("database-tls-required");
  } else if (sslMode === "verify-identity") {
    if (isIpLiteral(host)) missing.push("database-hostname-required");
    const configuredServername = stringValue(env.DB_SSL_SERVERNAME);
    const servername = configuredServername || host;
    if (!isDnsHostname(servername) || isIpLiteral(servername)) {
      missing.push("database-servername-required");
    }
    if (
      ["staging-db-proxy", "gate6-db-proxy"].includes(host) &&
      (!configuredServername || configuredServername === host)
    ) {
      missing.push("database-servername-upstream-required");
    }
    const caPath = stringValue(env.DB_SSL_CA_FILE);
    if (!caPath) {
      missing.push("database-ca-required");
    } else {
      const ca = readCaFile(caPath);
      if (ca === null) missing.push("database-ca-invalid");
      else ssl = { ca, rejectUnauthorized: true, servername, verifyIdentity: true };
    }
  }

  if (missing.length > 0) return { missing, value: null };
  return {
    missing: [],
    value: {
      host,
      port,
      user,
      password,
      database,
      ...(ssl === null ? {} : { ...mysqlVerifiedTransport(host, port, ssl.servername), ssl }),
    },
  };
}
