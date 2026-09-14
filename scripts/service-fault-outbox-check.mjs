#!/usr/bin/env node
// Read-only notification_outbox evidence probe for split-service fault drills.
//
// It prints aggregate queue counts only. It never prints targets, message bodies,
// payload JSON, DB credentials, or raw error text.

import { createHash } from "node:crypto";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";
import { evaluateDeliveryCounts } from "./lib/task9-worker-evaluators.mjs";

const DEFAULT_SINCE_MINUTES = 30;
const PENDING_STATUSES = new Set(["queued", "failed", "sending", "provider_sending", "delivery_ambiguous"]);

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function helpText() {
  return `service-fault-outbox-check.mjs

Read-only Task 9 notification_outbox evidence probe. Prints aggregate,
metadata-only queue evidence; it does not print notification targets, message
bodies, payload JSON, DB credentials, raw event-key filters, or raw error text.

Usage:
  node scripts/service-fault-outbox-check.mjs --help
  node scripts/service-fault-outbox-check.mjs --dry-run --since-minutes=<minutes> --event-key-contains=<event-key>
  node scripts/service-fault-outbox-check.mjs --since-minutes=<minutes> --event-key-contains=<event-key> --min-total=1 --expect-sent --max-pending=0
  node scripts/service-fault-outbox-check.mjs --since-minutes=<minutes> --event-key-contains=<event-key> --min-total=1 --expect-failed-attempt

Options:
  --dry-run                         Validate DB env and expectation flags without querying MySQL.
  --since-minutes=<minutes>         Positive lookup window; Task 9 runbook uses 30.
  --event-key-contains=<event-key>  Required for dry-run/live checks; binds output to a publisher event key by SHA-256 only.
  --min-total=<count>               Require at least this many matching outbox rows.
  --expect-sent                     Require at least one sent row.
  --expect-failed-attempt           Require at least one failed attempt.
  --max-pending=<count>             Require unresolved rows (including ambiguous deliveries) at or below this count.

Database credential:
  Set exactly one of DB_PASSWORD or DB_PASSWORD_FILE. Mounted secret files are
  read with bounded validation and neither the path nor value is printed.
  Production also requires DB_SSL_MODE=verify-identity and DB_SSL_CA_FILE.

Output:
  Prints checkedAt, mode, sinceMinutes, event-key hash, expectation flags,
  database configuration codes, expectation failure names, and aggregate counts only.
`;
}

function parsePositiveInteger(name, defaultValue) {
  const raw = argValue(name);
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(name) {
  const raw = argValue(name);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseDeliveryPhase() {
  const phase = argValue("delivery-phase");
  if (phase === undefined) return null;
  if (!["baseline", "line-down", "recovery"].includes(phase)) {
    throw new Error("delivery-phase is invalid");
  }
  return phase;
}

function countValueToNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function summarizeRows(rows) {
  const byStatus = {};
  let total = 0;
  let pending = 0;
  let failedAttempts = 0;
  let retriedRows = 0;
  let sent = 0;

  for (const row of rows) {
    const status = String(row.status ?? "unknown");
    const count = countValueToNumber(row.count);
    const attempted = countValueToNumber(row.attempted);
    const minAttempts = countValueToNumber(row.minAttempts);
    const maxAttempts = countValueToNumber(row.maxAttempts);
    byStatus[status] = { count, attempted, minAttempts, maxAttempts };
    total += count;
    if (PENDING_STATUSES.has(status)) pending += count;
    // First successful delivery has attempts=1. Failed/ambiguous first attempts
    // still count as outage evidence; SQL supplies exact counts for mixed groups.
    retriedRows += row.retried === undefined
      ? (status === "sent" && minAttempts === 1 && maxAttempts === 1 ? 0 : attempted)
      : countValueToNumber(row.retried);
    if (["failed", "failed_terminal", "delivery_ambiguous"].includes(status)) failedAttempts += attempted;
    if (status === "sent") sent += count;
  }

  return { total, pending, failedAttempts, retriedRows, sent, byStatus };
}

function evaluateExpectations(summary, options) {
  const failures = [];
  if (options.minTotal !== null && summary.total < options.minTotal) {
    failures.push("total-count-below-threshold");
  }
  if (options.expectSent && summary.sent <= 0) {
    failures.push("expected-sent-missing");
  }
  if (options.expectFailedAttempt && summary.retriedRows <= 0) {
    failures.push("expected-failed-attempt-missing");
  }
  if (options.expectSent && !options.expectFailedAttempt && summary.retriedRows > 0) {
    failures.push("unexpected-failed-attempt-present");
  }
  if (options.maxPending !== null && summary.pending > options.maxPending) {
    failures.push("pending-count-above-threshold");
  }
  return failures;
}

function dbConfigFromEnv() {
  const result = mysqlScriptConnectionConfigFromEnv();
  return { missing: result.missing, config: result.value };
}

function missingDbEnvForLiveProbe() {
  if (process.env.DB_MODE === "memory") {
    return ["DB_MODE=mysql required for live outbox probe"];
  }
  return dbConfigFromEnv().missing;
}

function formatMysqlTimestamp(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function filterEvidence(eventKeyContains) {
  return {
    eventKeyContains: Boolean(eventKeyContains),
    eventKeyContainsSha256: eventKeyContains ? sha256(eventKeyContains) : null,
  };
}

function expectationEvidence(options) {
  return {
    minTotal: options.minTotal,
    expectSent: options.expectSent,
    expectFailedAttempt: options.expectFailedAttempt,
    maxPending: options.maxPending,
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function loadRowsFromDb(options) {
  if (process.env.DB_MODE === "memory") {
    return { rows: [], missingDbEnv: ["DB_MODE=mysql required for live outbox probe"] };
  }

  const { missing, config } = dbConfigFromEnv();
  if (missing.length > 0) return { rows: [], missingDbEnv: missing };

  const since = new Date(Date.now() - options.sinceMinutes * 60_000);
  const params = [formatMysqlTimestamp(since)];
  const filters = ["created_at >= ?"];
  const eventKeyContains = argValue("event-key-contains");
  if (eventKeyContains) {
    filters.push("event_key = ?");
    params.push(eventKeyContains);
  }

  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(config);
  try {
    const [rows] = await connection.execute(
      `
        SELECT
          status,
          COUNT(*) AS count,
          SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS attempted,
          SUM(CASE WHEN attempts > 1 OR status IN ('failed', 'failed_terminal', 'delivery_ambiguous') THEN 1 ELSE 0 END) AS retried,
          MIN(attempts) AS minAttempts,
          MAX(attempts) AS maxAttempts
        FROM notification_outbox
        WHERE ${filters.join(" AND ")}
        GROUP BY status
      `,
      params,
    );
    let delivery = null;
    if (options.deliveryPhase) {
      const eventKey = argValue("event-key-contains");
      const [deliveryRows] = await connection.execute(
        `
          SELECT
            COUNT(DISTINCT o.id) AS matchedOutboxRows,
            COALESCE(SUM(CASE WHEN d.status IN ('success', 'reconciled_success') THEN 1 ELSE 0 END), 0) AS success,
            COALESCE(SUM(CASE WHEN d.status IN ('failed', 'ambiguous', 'reconciled_not_sent') THEN 1 ELSE 0 END), 0) AS failed
          FROM notification_outbox o
          LEFT JOIN notification_deliveries d ON d.outbox_id = o.id
          WHERE o.created_at >= ? AND o.event_key = ?
        `,
        [formatMysqlTimestamp(since), eventKey],
      );
      delivery = deliveryRows[0] ?? null;
    }
    return { rows, delivery, missingDbEnv: [] };
  } finally {
    await connection.end();
  }
}

function loadRowsFromFixture() {
  const fixtureJson = argValue("fixture-json");
  if (!fixtureJson) return null;
  const parsed = JSON.parse(fixtureJson);
  if (!Array.isArray(parsed)) throw new Error("fixture-json must be a JSON array");
  return parsed;
}

function loadDeliveryFromFixture() {
  const fixtureJson = argValue("delivery-fixture-json");
  if (!fixtureJson) return null;
  const parsed = JSON.parse(fixtureJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("delivery-fixture-json must be an object");
  }
  return parsed;
}

function numericDelivery(value) {
  if (!value || typeof value !== "object") return null;
  return {
    matchedOutboxRows: countValueToNumber(value.matchedOutboxRows),
    success: countValueToNumber(value.success),
    failed: countValueToNumber(value.failed),
  };
}

if (hasFlag("help")) {
  console.log(helpText());
  process.exit();
}

const options = {
  sinceMinutes: parsePositiveInteger("since-minutes", DEFAULT_SINCE_MINUTES),
  minTotal: parseNonNegativeInteger("min-total"),
  expectSent: hasFlag("expect-sent"),
  expectFailedAttempt: hasFlag("expect-failed-attempt"),
  maxPending: parseNonNegativeInteger("max-pending"),
  deliveryPhase: parseDeliveryPhase(),
};
const eventKeyContains = argValue("event-key-contains");
const hasFixtureJson = argValue("fixture-json") !== undefined;

if (!eventKeyContains && (hasFlag("dry-run") || !hasFixtureJson)) {
  printJson({
    ok: false,
    checkedAt: new Date().toISOString(),
    skipped: true,
    reason: "missing-config",
    missingConfig: ["--event-key-contains"],
    mode: hasFlag("dry-run") ? "dry-run" : "mysql",
    sinceMinutes: options.sinceMinutes,
    filters: filterEvidence(eventKeyContains),
    expectations: expectationEvidence(options),
  });
  process.exitCode = 1;
  process.exit();
}

if (hasFlag("dry-run")) {
  const missingDbEnv = missingDbEnvForLiveProbe();
  const ok = missingDbEnv.length === 0;
  printJson({
    ok,
    checkedAt: new Date().toISOString(),
    mode: "dry-run",
    dryRun: true,
    sinceMinutes: options.sinceMinutes,
    filters: filterEvidence(eventKeyContains),
    expectations: expectationEvidence(options),
    missingDbEnv,
    expectationFailures: [],
  });
  if (!ok) process.exitCode = 1;
  process.exit();
}

try {
  let rows = loadRowsFromFixture();
  let deliveryRow = loadDeliveryFromFixture();
  let missingDbEnv = [];
  let mode = "fixture";

  if (!rows) {
    mode = "mysql";
    const dbResult = await loadRowsFromDb(options);
    rows = dbResult.rows;
    deliveryRow = dbResult.delivery;
    missingDbEnv = dbResult.missingDbEnv;
  }

  const summary = summarizeRows(rows);
  const expectationFailures = missingDbEnv.length > 0 ? [] : evaluateExpectations(summary, options);
  const deliveryCounts = options.deliveryPhase ? numericDelivery(deliveryRow) : null;
  const deliveryResult = options.deliveryPhase
    ? evaluateDeliveryCounts(deliveryCounts, options.deliveryPhase)
    : { ok: true, failures: [] };
  const delivery = options.deliveryPhase
    ? {
        phase: options.deliveryPhase,
        ...(deliveryCounts ?? { matchedOutboxRows: 0, success: 0, failed: 0 }),
        failures: deliveryResult.failures,
      }
    : undefined;
  const ok =
    missingDbEnv.length === 0 && expectationFailures.length === 0 && deliveryResult.ok;

  printJson({
    ok,
    checkedAt: new Date().toISOString(),
    mode,
    sinceMinutes: options.sinceMinutes,
    filters: filterEvidence(eventKeyContains),
    expectations: expectationEvidence(options),
    missingDbEnv,
    expectationFailures,
    summary,
    ...(delivery ? { delivery } : {}),
  });

  if (!ok) process.exitCode = 1;
} catch {
  printJson({
    ok: false,
    checkedAt: new Date().toISOString(),
    mode: hasFixtureJson ? "fixture" : "mysql",
    sinceMinutes: options.sinceMinutes,
    filters: filterEvidence(eventKeyContains),
    expectations: expectationEvidence(options),
    missingDbEnv: [],
    expectationFailures: ["query-failed"],
    summary: { total: 0, pending: 0, failedAttempts: 0, retriedRows: 0, sent: 0, byStatus: {} },
  });
  process.exitCode = 1;
}
