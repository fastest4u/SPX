#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";

const READY_URLS = Object.freeze([
  "http://web-api:3000/ready",
  "http://notification-service:3003/ready",
  "http://line-service:3002/ready",
  "http://ocr-service:3004/ready",
]);

function one(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`${label} is unavailable or ambiguous`);
  return rows[0];
}

function nonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

export async function executeGate6ProductionMonitorProbe(input) {
  const [queueResult] = await input.connection.execute(`
    SELECT COALESCE(MAX(TIMESTAMPDIFF(MICROSECOND, updated_at, UTC_TIMESTAMP(3))) / 1000, 0)
      AS queue_oldest_ms
    FROM auto_accept_jobs
    WHERE status IN ('pending', 'retrying', 'claimed', 'verifying', 'indeterminate')
  `);
  const [outboxResult] = await input.connection.execute(`
    SELECT COALESCE(MAX(TIMESTAMPDIFF(MICROSECOND, updated_at, UTC_TIMESTAMP(3))) / 1000, 0)
      AS outbox_oldest_ms
    FROM notification_outbox
    WHERE status IN ('pending', 'retrying', 'sending')
  `);
  const [leaseResult] = await input.connection.execute(`
    SELECT
      COALESCE(SUM(status = 'running' AND lease_expires_at <= UTC_TIMESTAMP(3)), 0) AS stale_count,
      COALESCE(SUM(team_id = 1 AND status = 'running' AND lease_expires_at > UTC_TIMESTAMP(3)), 0)
        AS team_1_active_count,
      COALESCE(SUM(team_id = 2 AND status = 'running' AND lease_expires_at > UTC_TIMESTAMP(3)), 0)
        AS team_2_active_count
    FROM team_runtime_leases
    WHERE team_id IN (1, 2)
  `);
  const [connectionsResult] = await input.connection.execute("SHOW GLOBAL STATUS LIKE 'Threads_connected'");
  const [maximumResult] = await input.connection.execute("SHOW GLOBAL VARIABLES LIKE 'max_connections'");
  const threads = nonNegative(one(connectionsResult, "MySQL connection count").Value, "MySQL connection count");
  const maximum = nonNegative(one(maximumResult, "MySQL connection limit").Value, "MySQL connection limit");
  if (maximum <= 0) throw new Error("MySQL connection limit is invalid");
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const started = monotonicNow();
  const readiness = await Promise.all(READY_URLS.map(async (url) => {
    try {
      const response = await (input.fetchImpl ?? fetch)(url, {
        method: "GET",
        signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(1_500) : undefined,
      });
      return response.ok === true && response.status === 200;
    } catch {
      return false;
    }
  }));
  const latencyMs = Math.max(0, Math.round(monotonicNow() - started));
  const now = input.now ?? new Date();
  const lease = one(leaseResult, "required worker lease state");
  const missingLeaseTeamIds = [1, 2].filter((teamId) => {
    const count = nonNegative(lease[`team_${teamId}_active_count`], `team ${teamId} active lease count`);
    if (!Number.isSafeInteger(count) || count > 1) throw new Error("required worker lease state is ambiguous");
    return count === 0;
  });
  return Object.freeze({
    ok: readiness.every(Boolean),
    readiness: readiness.every(Boolean),
    latencyMs,
    queueOldestMs: Math.round(nonNegative(one(queueResult, "queue age").queue_oldest_ms, "queue age")),
    outboxOldestMs: Math.round(nonNegative(one(outboxResult, "outbox age").outbox_oldest_ms, "outbox age")),
    leaseStaleCount: Math.round(nonNegative(lease.stale_count, "stale lease count")),
    missingLeaseTeamIds,
    mysqlConnectionPercent: Math.round((threads / maximum) * 10_000) / 100,
    checkedAt: now.toISOString(),
  });
}

async function main() {
  let connection;
  try {
    if (process.argv.length !== 2) throw new Error("Gate 6 production monitor probe accepts no arguments");
    const configured = mysqlScriptConnectionConfigFromEnv(process.env);
    if (configured.value === null || configured.missing.length > 0) {
      throw new Error("Gate 6 production monitor probe database is unavailable");
    }
    const mysql = await import("mysql2/promise");
    connection = await mysql.createConnection({
      ...configured.value,
      timezone: "Z",
      multipleStatements: false,
    });
    const result = await executeGate6ProductionMonitorProbe({ connection });
    process.stdout.write(`${canonicalGate6Json(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`${canonicalGate6Json({ ok: false, code: "gate6-monitor-probe-refused" })}\n`);
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
