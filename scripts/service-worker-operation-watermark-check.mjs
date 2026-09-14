#!/usr/bin/env node

import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";
import { compareWatermarks } from "./lib/task9-worker-evaluators.mjs";

const FIELDS = Object.freeze([
  "bookingHistory",
  "autoAcceptAttempts",
  "autoAcceptResults",
  "autoAcceptHistory",
  "notificationEvents",
  "notificationOutbox",
  "metrics",
  "duplicateAnomalies",
]);

export function buildOperationWatermarkSql() {
  return `
    WITH
      booking_history AS (
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM spx_booking_history WHERE team_id = ?
      ),
      accept_attempts AS (
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM auto_accept_attempts WHERE team_id = ?
      ),
      accept_results AS (
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM auto_accept_results WHERE team_id = ?
      ),
      accept_history AS (
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM auto_accept_history WHERE team_id = ?
      ),
      notification_event_state AS (
        SELECT COALESCE(MAX(id), 0) AS watermark,
          COUNT(*) - COUNT(DISTINCT event_key) AS duplicateAnomalies
        FROM notification_events WHERE team_id = ?
      ),
      notification_outbox_state AS (
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM notification_outbox WHERE team_id = ?
      ),
      metrics_state AS (
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM metrics_snapshots WHERE team_id = ?
      )
    SELECT
      booking_history.watermark AS bookingHistory,
      accept_attempts.watermark AS autoAcceptAttempts,
      accept_results.watermark AS autoAcceptResults,
      accept_history.watermark AS autoAcceptHistory,
      notification_event_state.watermark AS notificationEvents,
      notification_outbox_state.watermark AS notificationOutbox,
      metrics_state.watermark AS metrics,
      notification_event_state.duplicateAnomalies AS duplicateAnomalies
    FROM booking_history, accept_attempts, accept_results, accept_history,
      notification_event_state, notification_outbox_state, metrics_state
  `;
}

function toInteger(value) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("invalid watermark row");
  return number;
}

export function normalizeOperationWatermarkRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("invalid watermark row");
  }
  return Object.fromEntries(FIELDS.map((field) => [field, toInteger(row[field])]));
}

export function compareOperationWatermarks(before, after) {
  return compareWatermarks(before, after);
}

function parseTeamId(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || !/^--team-id=[1-9]\d*$/.test(argv[0])) {
    throw new Error("team ID is required");
  }
  const teamId = Number(argv[0].slice("--team-id=".length));
  if (!Number.isSafeInteger(teamId)) throw new Error("team ID is invalid");
  return teamId;
}

async function main() {
  const teamId = parseTeamId(process.argv.slice(2));
  const configured = mysqlScriptConnectionConfigFromEnv();
  if (configured.missing.length > 0) throw new Error("database configuration is unavailable");
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(configured.value);
  try {
    const [rows] = await connection.execute(buildOperationWatermarkSql(), Array(7).fill(teamId));
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("watermark query failed");
    console.log(
      JSON.stringify({
        ok: true,
        checkedAt: new Date().toISOString(),
        teamId,
        watermark: normalizeOperationWatermarkRow(rows[0]),
      }),
    );
  } finally {
    await connection.end();
  }
}

if (process.argv[1]?.endsWith("service-worker-operation-watermark-check.mjs")) {
  main().catch(() => {
    console.error("SERVICE_WORKER_OPERATION_WATERMARK_CHECK_FAILED");
    process.exitCode = 1;
  });
}
