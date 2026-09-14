#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";

function finiteAge(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function requiredAge(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validQueue(value) {
  return Boolean(
    value &&
      Number.isInteger(value.pendingCount) &&
      value.pendingCount >= 0 &&
      finiteAge(value.oldestPendingAgeMs),
  );
}

export function readSpoolHealthSummary(spoolPath, nowMs = Date.now()) {
  if (typeof spoolPath !== "string" || spoolPath.length === 0 || !Number.isFinite(nowMs)) {
    throw new Error("spool health configuration is invalid");
  }
  if (!existsSync(spoolPath)) {
    return { pendingCount: 0, bytes: 0, oldestPendingAgeMs: null };
  }
  const spoolStat = lstatSync(spoolPath);
  if (spoolStat.isSymbolicLink() || !spoolStat.isFile()) {
    throw new Error("spool must be a regular file");
  }
  if (spoolStat.size === 0) {
    return { pendingCount: 0, bytes: 0, oldestPendingAgeMs: null };
  }
  const healthPath = `${spoolPath}.health.json`;
  const healthStat = lstatSync(healthPath);
  if (healthStat.isSymbolicLink() || !healthStat.isFile() || healthStat.size > 8_192) {
    throw new Error("spool health summary must be a bounded regular file");
  }
  const health = JSON.parse(readFileSync(healthPath, "utf8"));
  const oldestMs = Date.parse(health?.oldestPendingAt);
  const updatedMs = Date.parse(health?.updatedAt);
  if (
    health?.schemaVersion !== 1 ||
    !Number.isInteger(health?.pendingCount) ||
    health.pendingCount <= 0 ||
    health?.spoolBytes !== statSync(spoolPath).size ||
    !Number.isFinite(oldestMs) ||
    !Number.isFinite(updatedMs) ||
    oldestMs > nowMs ||
    updatedMs > nowMs + 5_000
  ) {
    throw new Error("spool health summary is stale or mismatched");
  }
  return {
    pendingCount: health.pendingCount,
    bytes: health.spoolBytes,
    oldestPendingAgeMs: nowMs - oldestMs,
  };
}

export function buildWorkerHealthSql() {
  return Object.freeze({
    node: `
      SELECT TIMESTAMPDIFF(MICROSECOND, last_heartbeat_at, CURRENT_TIMESTAMP(6)) / 1000 AS heartbeatAgeMs
      FROM runtime_nodes WHERE node_id = ? LIMIT 1
    `,
    leases: `
      SELECT d.team_id AS teamId, d.desired_state AS state,
        l.owner_node_id AS ownerNodeId,
        CASE WHEN l.lease_expires_at > CURRENT_TIMESTAMP(6) THEN 1 ELSE 0 END AS active,
        TIMESTAMPDIFF(MICROSECOND, l.heartbeat_at, CURRENT_TIMESTAMP(6)) / 1000 AS heartbeatAgeMs
      FROM team_runtime_desired_state d
      LEFT JOIN team_runtime_leases l ON l.team_id = d.team_id
      WHERE d.team_id IN (__TEAM_PLACEHOLDERS__)
    `,
    metrics: `
      SELECT team_id AS teamId,
        TIMESTAMPDIFF(MICROSECOND, received_at, CURRENT_TIMESTAMP(6)) / 1000 AS heartbeatAgeMs
      FROM realtime_metrics_read_models
      WHERE source_node_id = ? AND team_id IN (__TEAM_PLACEHOLDERS__)
    `,
    outbox: `
      SELECT COUNT(*) AS pendingCount,
        TIMESTAMPDIFF(MICROSECOND, MIN(created_at), CURRENT_TIMESTAMP(6)) / 1000 AS oldestPendingAgeMs,
        COALESCE(MAX(id), 0) AS watermark,
        TIMESTAMPDIFF(MICROSECOND, MAX(updated_at), CURRENT_TIMESTAMP(6)) / 1000 AS lastProgressAgeMs
      FROM notification_outbox
      WHERE team_id IN (__TEAM_PLACEHOLDERS__)
        AND status IN ('queued', 'failed', 'sending', 'provider_sending', 'delivery_ambiguous')
    `,
  });
}

export function evaluateWorkerHealth(input) {
  if (
    !input ||
    typeof input.processAlive !== "boolean" ||
    !requiredAge(input.nodeHeartbeatAgeMs) ||
    !requiredAge(input.metricsHeartbeatAgeMs) ||
    !Number.isInteger(input.recentMetricsFailures) ||
    input.recentMetricsFailures < 0 ||
    !Array.isArray(input.expectedTeamIds) ||
    !Array.isArray(input.leases) ||
    !Array.isArray(input.desiredStates) ||
    !validQueue(input.spool) ||
    typeof input.spool.bytes !== "number" ||
    input.spool.bytes < 0 ||
    !validQueue(input.outbox) ||
    !finiteAge(input.outbox.lastProgressAgeMs) ||
    typeof input.nodeId !== "string" ||
    typeof input.maxAgeMs !== "number" ||
    input.maxAgeMs <= 0
  ) {
    return { ok: false, failures: ["WORKER_HEALTH_INPUT_INVALID"] };
  }

  const failures = [];
  if (!input.processAlive) failures.push("PROCESS_NOT_ALIVE");
  if (input.nodeHeartbeatAgeMs > input.maxAgeMs) failures.push("NODE_HEARTBEAT_STALE");
  if (input.metricsHeartbeatAgeMs > input.maxAgeMs) failures.push("METRICS_HEARTBEAT_STALE");
  if (input.recentMetricsFailures > 0) failures.push("RECENT_METRICS_FAILURE");

  for (const teamId of input.expectedTeamIds) {
    const state = input.desiredStates.find((candidate) => candidate.teamId === teamId)?.state;
    const activeLeases = input.leases.filter(
      (lease) => lease.teamId === teamId && lease.active === true,
    );
    if (state === "running") {
      if (activeLeases.length === 0) {
        failures.push("EXPECTED_TEAM_LEASE_MISSING");
      } else if (
        activeLeases.length !== 1 ||
        activeLeases[0].ownerNodeId !== input.nodeId ||
        !finiteAge(activeLeases[0].heartbeatAgeMs) ||
        activeLeases[0].heartbeatAgeMs > input.maxAgeMs
      ) {
        failures.push("EXPECTED_TEAM_LEASE_INVALID");
      }
    } else if (["paused", "stopped"].includes(state)) {
      if (activeLeases.length > 0) failures.push("INACTIVE_TEAM_LEASE_PRESENT");
    } else {
      failures.push("DESIRED_STATE_MISSING");
    }
  }

  const durablePending = input.spool.pendingCount > 0 || input.outbox.pendingCount > 0;
  const stalled =
    durablePending &&
    ((input.spool.oldestPendingAgeMs ?? 0) > input.maxAgeMs ||
      (input.outbox.oldestPendingAgeMs ?? 0) > input.maxAgeMs ||
      input.outbox.lastProgressAgeMs === null ||
      input.outbox.lastProgressAgeMs > input.maxAgeMs);
  if (stalled) failures.push("DURABLE_WORK_STALLED");
  if (input.spool.pendingCount > input.maxPendingCount) failures.push("SPOOL_COUNT_LIMIT_EXCEEDED");
  if (input.spool.bytes > input.maxSpoolBytes) failures.push("SPOOL_BYTES_LIMIT_EXCEEDED");
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("health threshold invalid");
  return parsed;
}

function parseRuntimeOptions(argv) {
  if (argv.some((argument) => !/^--max-age-ms=[1-9]\d*$/.test(argument)) || argv.length > 1) {
    throw new Error("worker health arguments are invalid");
  }
  const maxAgeMs = positiveInteger(argv[0]?.slice("--max-age-ms=".length), 45_000);
  const expectedTeamIds = String(process.env.RUN_TEAM_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (expectedTeamIds.length === 0 || new Set(expectedTeamIds).size !== expectedTeamIds.length) {
    throw new Error("RUN_TEAM_IDS is invalid");
  }
  const nodeId = process.env.SPX_NODE_ID;
  if (!nodeId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(nodeId)) {
    throw new Error("SPX_NODE_ID is invalid");
  }
  return {
    maxAgeMs,
    expectedTeamIds,
    nodeId,
    maxPendingCount: positiveInteger(process.env.WORKER_HEALTH_MAX_PENDING_COUNT, 1_000),
    maxSpoolBytes: positiveInteger(process.env.WORKER_HEALTH_MAX_SPOOL_BYTES, 50_000_000),
  };
}

function numeric(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function collectLiveSnapshot(options) {
  const configured = mysqlScriptConnectionConfigFromEnv();
  if (configured.missing.length > 0) throw new Error("database configuration unavailable");
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(configured.value);
  const sql = buildWorkerHealthSql();
  const placeholders = options.expectedTeamIds.map(() => "?").join(",");
  try {
    const [nodeRows] = await connection.execute(sql.node, [options.nodeId]);
    const [leaseRows] = await connection.execute(
      sql.leases.replace("__TEAM_PLACEHOLDERS__", placeholders),
      options.expectedTeamIds,
    );
    const [metricRows] = await connection.execute(
      sql.metrics.replace("__TEAM_PLACEHOLDERS__", placeholders),
      [options.nodeId, ...options.expectedTeamIds],
    );
    const [outboxRows] = await connection.execute(
      sql.outbox.replace("__TEAM_PLACEHOLDERS__", placeholders),
      options.expectedTeamIds,
    );
    if (!Array.isArray(nodeRows) || nodeRows.length !== 1 || !Array.isArray(metricRows)) {
      throw new Error("worker health query result invalid");
    }
    const metricsAges = metricRows.map((row) => numeric(row.heartbeatAgeMs));
    const outbox = Array.isArray(outboxRows) ? outboxRows[0] : null;
    return {
      processAlive: process.platform === "win32" || existsSync("/proc/1"),
      nodeHeartbeatAgeMs: numeric(nodeRows[0].heartbeatAgeMs),
      metricsHeartbeatAgeMs:
        metricsAges.length === options.expectedTeamIds.length && metricsAges.every((age) => age !== null)
          ? Math.max(...metricsAges)
          : null,
      recentMetricsFailures: 0,
      expectedTeamIds: options.expectedTeamIds,
      leases: Array.isArray(leaseRows)
        ? leaseRows
            .filter((row) => row.ownerNodeId !== null)
            .map((row) => ({
              teamId: Number(row.teamId),
              ownerNodeId: String(row.ownerNodeId),
              active: Number(row.active) === 1,
              heartbeatAgeMs: numeric(row.heartbeatAgeMs),
            }))
        : [],
      desiredStates: Array.isArray(leaseRows)
        ? leaseRows.map((row) => ({ teamId: Number(row.teamId), state: String(row.state) }))
        : [],
      spool: readSpoolHealthSummary(
        process.env.NOTIFIER_LOCAL_SPOOL_PATH ?? "/app/spool/notification-spool.jsonl",
      ),
      outbox: {
        pendingCount: Number(outbox?.pendingCount ?? 0),
        oldestPendingAgeMs: numeric(outbox?.oldestPendingAgeMs),
        watermark: Number(outbox?.watermark ?? 0),
        lastProgressAgeMs: numeric(outbox?.lastProgressAgeMs),
      },
      ...options,
    };
  } finally {
    await connection.end();
  }
}

async function main() {
  const checkedAt = new Date().toISOString();
  try {
    const options = parseRuntimeOptions(process.argv.slice(2));
    const result = evaluateWorkerHealth(await collectLiveSnapshot(options));
    console.log(JSON.stringify({ ...result, checkedAt }));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, failures: ["WORKER_HEALTH_QUERY_FAILED"], checkedAt }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("worker-healthcheck.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
