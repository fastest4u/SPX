#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const EXPECTED_UPDATE_DENIAL_CODES = new Set([
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_COLUMNACCESS_DENIED_ERROR",
  "ER_SPECIFIC_ACCESS_DENIED_ERROR",
]);
const EXPECTED_UPDATE_DENIAL_ERRNOS = new Set([1142, 1143, 1227]);

export function loadMysqlPromiseClient(moduleRoot = process.cwd()) {
  const require = createRequire(resolve(moduleRoot, "package.json"));
  return require("mysql2/promise");
}

function isExpectedUpdateDenial(error) {
  if (!error || typeof error !== "object") return false;
  return EXPECTED_UPDATE_DENIAL_CODES.has(String(error.code ?? ""))
    || EXPECTED_UPDATE_DENIAL_ERRNOS.has(Number(error.errno));
}

function result(failureCodes) {
  return { ok: failureCodes.length === 0, failureCodes };
}

export async function runInternalReplayGrantPreflight(connection, options = {}) {
  const failureCodes = [];
  const fingerprint = options.fingerprint ?? randomBytes(32).toString("hex");
  const now = options.now ?? new Date();
  let inserted = false;

  try {
    if (
      !connection
      || typeof connection.beginTransaction !== "function"
      || typeof connection.execute !== "function"
      || typeof connection.rollback !== "function"
      || typeof connection.release !== "function"
      || !FINGERPRINT_PATTERN.test(fingerprint)
      || !(now instanceof Date)
      || !Number.isFinite(now.getTime())
    ) {
      failureCodes.push("input_invalid");
      return result(failureCodes);
    }

    try {
      await connection.beginTransaction();
    } catch {
      failureCodes.push("transaction_failed");
      return result(failureCodes);
    }

    try {
      await connection.execute(
        "SELECT replay_key FROM internal_request_replays WHERE replay_key = ? LIMIT 1",
        [fingerprint],
      );
    } catch {
      failureCodes.push("select_failed");
    }

    try {
      const expiresAt = new Date(now.getTime() + 60_000)
        .toISOString()
        .slice(0, 23)
        .replace("T", " ");
      await connection.execute(
        "INSERT INTO internal_request_replays (replay_key, partition_name, expires_at) VALUES (?, ?, ?)",
        [fingerprint, "grant-preflight", expiresAt],
      );
      inserted = true;
    } catch {
      failureCodes.push("insert_failed");
    }

    if (inserted) {
      try {
        await connection.execute(
          "UPDATE internal_request_replays SET expires_at = expires_at WHERE replay_key = ?",
          [fingerprint],
        );
        failureCodes.push("excessive_privilege");
      } catch (error) {
        if (!isExpectedUpdateDenial(error)) failureCodes.push("update_check_failed");
      }
    }

    try {
      await connection.execute(
        "DELETE FROM internal_request_replays WHERE replay_key = ?",
        [fingerprint],
      );
    } catch {
      failureCodes.push("delete_failed");
    }
  } finally {
    if (connection && typeof connection.rollback === "function") {
      try {
        await connection.rollback();
      } catch {
        failureCodes.push("rollback_failed");
      }
    }
    if (connection && typeof connection.release === "function") {
      try {
        await connection.release();
      } catch {
        failureCodes.push("release_failed");
      }
    }
  }

  return result(failureCodes);
}

function output(mode, failureCodes) {
  console.log(JSON.stringify({ ok: failureCodes.length === 0, mode, failureCodes }));
}

function help() {
  console.log("Usage: node scripts/internal-replay-grant-preflight.mjs [--dry-run|--help]");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    if (args.length !== 1) {
      output("help", ["invalid_arguments"]);
      process.exitCode = 1;
      return;
    }
    help();
    return;
  }
  const dryRun = args.includes("--dry-run");
  if (args.some((arg) => arg !== "--dry-run") || args.filter((arg) => arg === "--dry-run").length > 1) {
    output(dryRun ? "dry-run" : "live", ["invalid_arguments"]);
    process.exitCode = 1;
    return;
  }

  const config = mysqlScriptConnectionConfigFromEnv();
  if (config.missing.length > 0 || !config.value) {
    output(dryRun ? "dry-run" : "live", ["database_config_invalid"]);
    process.exitCode = 1;
    return;
  }
  if (dryRun) {
    output("dry-run", []);
    return;
  }

  let rawConnection;
  try {
    const mysql = loadMysqlPromiseClient();
    rawConnection = await mysql.createConnection(config.value);
  } catch {
    output("live", ["connection_failed"]);
    process.exitCode = 1;
    return;
  }

  const connection = {
    beginTransaction: () => rawConnection.beginTransaction(),
    execute: (sql, params) => rawConnection.execute(sql, params),
    rollback: () => rawConnection.rollback(),
    release: () => rawConnection.end(),
  };
  const checked = await runInternalReplayGrantPreflight(connection);
  output("live", checked.failureCodes);
  if (!checked.ok) process.exitCode = 1;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch(() => {
    output(process.argv.includes("--dry-run") ? "dry-run" : "live", ["internal_error"]);
    process.exitCode = 1;
  });
}
