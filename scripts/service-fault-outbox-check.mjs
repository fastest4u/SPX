#!/usr/bin/env node
// Read-only notification_outbox evidence probe for split-service fault drills.
//
// It prints aggregate queue counts only. It never prints targets, message bodies,
// payload JSON, DB credentials, or raw error text.

import { createHash } from "node:crypto";

const DEFAULT_SINCE_MINUTES = 30;
const PENDING_STATUSES = new Set(["queued", "failed", "sending"]);

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
  --max-pending=<count>             Require pending/retryable rows at or below this count.

Output:
  Prints checkedAt, mode, sinceMinutes, event-key hash, expectation flags,
  missing DB env names, expectation failure names, and aggregate counts only.
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
    retriedRows += attempted;
    if (status === "failed") failedAttempts += attempted;
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
  const required = ["DB_HOST", "DB_USERNAME", "DB_PASSWORD", "DB_NAME"];
  const missing = required.filter((name) => !process.env[name]);
  return {
    missing,
    config: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
  };
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
          MIN(attempts) AS minAttempts,
          MAX(attempts) AS maxAttempts
        FROM notification_outbox
        WHERE ${filters.join(" AND ")}
        GROUP BY status
      `,
      params,
    );
    return { rows, missingDbEnv: [] };
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
  let missingDbEnv = [];
  let mode = "fixture";

  if (!rows) {
    mode = "mysql";
    const dbResult = await loadRowsFromDb(options);
    rows = dbResult.rows;
    missingDbEnv = dbResult.missingDbEnv;
  }

  const summary = summarizeRows(rows);
  const expectationFailures = missingDbEnv.length > 0 ? [] : evaluateExpectations(summary, options);
  const ok = missingDbEnv.length === 0 && expectationFailures.length === 0;

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
