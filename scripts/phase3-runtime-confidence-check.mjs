#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";

const AUTO_ACCEPT_MODES = ["autoAcceptDryRun", "autoAcceptReal", "autoAcceptSettlement"];
const DEFAULT_MAX_AGE_MS = 120_000;

function sortedPositiveIntegers(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.some((value) => !Number.isInteger(value) || value <= 0)) return null;
  return [...new Set(values)].sort((left, right) => left - right);
}

function sortedStrings(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    return null;
  }
  return [...new Set(values)].sort();
}

function sameValues(left, right) {
  return left !== null && right !== null
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function parseMetadata(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function freshAge(value, maxAgeMs) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maxAgeMs;
}

export function evaluatePhase3RuntimeConfidence(input) {
  const expectedTeamIds = sortedPositiveIntegers(input.expectedTeamIds);
  const expectedAutoAcceptModes = sortedStrings(input.expectedAutoAcceptModes);
  if (
    expectedTeamIds === null
    || expectedAutoAcceptModes === null
    || expectedAutoAcceptModes.length === 0
    || expectedAutoAcceptModes.some((mode) => !AUTO_ACCEPT_MODES.includes(mode))
    || !Number.isInteger(input.maxAgeMs)
    || input.maxAgeMs <= 0
  ) {
    throw new Error("Phase 3 confidence expectations are invalid");
  }

  const failures = [];
  const poller = input.nodes.find((node) => node.nodeId === input.pollerNodeId);
  const autoAccept = input.nodes.find((node) => node.nodeId === input.autoAcceptNodeId);
  const pollerMetadata = parseMetadata(poller?.metadataJson);
  const autoAcceptMetadata = parseMetadata(autoAccept?.metadataJson);

  if (!poller || poller.role !== "poller-service") failures.push("POLLER_NODE_MISSING_OR_WRONG_ROLE");
  else if (!freshAge(poller.heartbeatAgeMs, input.maxAgeMs)) failures.push("POLLER_HEARTBEAT_STALE");
  if (
    poller
    && (!sameValues(sortedPositiveIntegers(pollerMetadata?.assignedTeamIds), expectedTeamIds)
      || !sameValues(sortedStrings(pollerMetadata?.enabledLoopModes), ["poller"]))
  ) {
    failures.push("POLLER_METADATA_MISMATCH");
  }

  if (!autoAccept || autoAccept.role !== "auto-accept-service") {
    failures.push("AUTO_ACCEPT_NODE_MISSING_OR_WRONG_ROLE");
  } else if (!freshAge(autoAccept.heartbeatAgeMs, input.maxAgeMs)) {
    failures.push("AUTO_ACCEPT_HEARTBEAT_STALE");
  }
  if (
    autoAccept
    && !sameValues(
      sortedPositiveIntegers(autoAcceptMetadata?.assignedTeamIds),
      expectedTeamIds,
    )
  ) {
    failures.push("AUTO_ACCEPT_TEAM_ASSIGNMENT_MISMATCH");
  }
  if (
    autoAccept
    && !sameValues(
      sortedStrings(autoAcceptMetadata?.enabledLoopModes),
      expectedAutoAcceptModes,
    )
  ) {
    failures.push("AUTO_ACCEPT_LOOP_MODES_MISMATCH");
  }

  const freshPollerLeases = expectedTeamIds.filter((teamId) => {
    const lease = input.leases.find((candidate) => candidate.teamId === teamId);
    return lease?.ownerNodeId === input.pollerNodeId
      && lease.ownerRole === "poller-service"
      && lease.status === "running"
      && lease.leaseActive === true
      && freshAge(lease.heartbeatAgeMs, input.maxAgeMs);
  }).length;
  if (freshPollerLeases !== expectedTeamIds.length) failures.push("POLLER_LEASES_INCOMPLETE");
  const expectedTeamIdSet = new Set(expectedTeamIds);
  const outsidePollerLease = input.leases.some((lease) => (
    !expectedTeamIdSet.has(lease.teamId)
    && lease.ownerNodeId === input.pollerNodeId
    && lease.ownerRole === "poller-service"
    && lease.status === "running"
    && lease.leaseActive === true
    && freshAge(lease.heartbeatAgeMs, input.maxAgeMs)
  ));
  if (outsidePollerLease) failures.push("POLLER_LEASES_OUTSIDE_ASSIGNMENT");

  const freshMetricsRecords = expectedTeamIds.filter((teamId) => {
    const record = input.metrics.find((candidate) => candidate.teamId === teamId);
    return record?.sourceNodeId === input.pollerNodeId
      && freshAge(record.ageMs, input.maxAgeMs);
  }).length;
  if (freshMetricsRecords !== expectedTeamIds.length) failures.push("POLLER_METRICS_INCOMPLETE");
  const outsidePollerMetrics = input.metrics.some((record) => (
    !expectedTeamIdSet.has(record.teamId)
    && record.sourceNodeId === input.pollerNodeId
    && freshAge(record.ageMs, input.maxAgeMs)
  ));
  if (outsidePollerMetrics) failures.push("POLLER_METRICS_OUTSIDE_ASSIGNMENT");

  return {
    ok: failures.length === 0,
    expectedTeamIds,
    pollerNodeId: input.pollerNodeId,
    autoAcceptNodeId: input.autoAcceptNodeId,
    expectedAutoAcceptModes,
    freshPollerLeases,
    freshMetricsRecords,
    failures,
  };
}

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function commaList(value) {
  return value?.split(",").map((part) => part.trim()) ?? [];
}

function cliOptions() {
  const expectedTeamIds = commaList(
    argValue("team-ids") ?? process.env.PHASE3_EXPECTED_TEAM_IDS,
  ).map(Number);
  const maxAgeMs = Number(
    argValue("max-age-ms") ?? process.env.PHASE3_MAX_AGE_MS ?? DEFAULT_MAX_AGE_MS,
  );
  return {
    pollerNodeId: argValue("poller-node-id") ?? process.env.PHASE3_POLLER_NODE_ID ?? "",
    autoAcceptNodeId:
      argValue("auto-accept-node-id") ?? process.env.PHASE3_AUTO_ACCEPT_NODE_ID ?? "",
    expectedTeamIds,
    expectedAutoAcceptModes: commaList(
      argValue("auto-accept-modes") ?? process.env.PHASE3_AUTO_ACCEPT_MODES,
    ),
    maxAgeMs,
  };
}

function validateCliOptions(options) {
  if (!options.pollerNodeId || !options.autoAcceptNodeId) return false;
  try {
    evaluatePhase3RuntimeConfidence({
      ...options,
      nodes: [],
      leases: [],
      metrics: [],
    });
    return true;
  } catch {
    return false;
  }
}

function dbConfig() {
  return mysqlScriptConnectionConfigFromEnv();
}

async function loadConfidenceRows(options, config) {
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(config);
  const teamPlaceholders = options.expectedTeamIds.map(() => "?").join(", ");
  try {
    const [[nodes], [leases], [metrics]] = await Promise.all([
      connection.execute(
        `SELECT node_id AS nodeId, role, metadata_json AS metadataJson,
          TIMESTAMPDIFF(MICROSECOND, last_heartbeat_at, UTC_TIMESTAMP(3)) / 1000 AS heartbeatAgeMs
         FROM runtime_nodes WHERE node_id IN (?, ?)`,
        [options.pollerNodeId, options.autoAcceptNodeId],
      ),
      connection.execute(
        `SELECT team_id AS teamId, owner_node_id AS ownerNodeId, owner_role AS ownerRole, status,
          TIMESTAMPDIFF(MICROSECOND, heartbeat_at, UTC_TIMESTAMP(3)) / 1000 AS heartbeatAgeMs,
          lease_expires_at > UTC_TIMESTAMP(3) AS leaseActive
         FROM team_runtime_leases
         WHERE owner_node_id = ? OR team_id IN (${teamPlaceholders})`,
        [options.pollerNodeId, ...options.expectedTeamIds],
      ),
      connection.execute(
        `SELECT team_id AS teamId, source_node_id AS sourceNodeId,
          TIMESTAMPDIFF(MICROSECOND, received_at, UTC_TIMESTAMP(3)) / 1000 AS ageMs
         FROM realtime_metrics_read_models
         WHERE source_node_id = ? OR team_id IN (${teamPlaceholders})`,
        [options.pollerNodeId, ...options.expectedTeamIds],
      ),
    ]);
    return {
      nodes: nodes.map((row) => ({ ...row, heartbeatAgeMs: Number(row.heartbeatAgeMs) })),
      leases: leases.map((row) => ({
        ...row,
        teamId: Number(row.teamId),
        heartbeatAgeMs: Number(row.heartbeatAgeMs),
        leaseActive: Number(row.leaseActive) === 1,
      })),
      metrics: metrics.map((row) => ({
        ...row,
        teamId: Number(row.teamId),
        ageMs: Number(row.ageMs),
      })),
    };
  } finally {
    await connection.end();
  }
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function helpText() {
  return `phase3-runtime-confidence-check.mjs

Read-only shared-MySQL confidence check for dedicated poller/auto-accept roles.
It reports node IDs, team IDs, modes, counts, and stable failure codes only.

Usage:
  node scripts/phase3-runtime-confidence-check.mjs --dry-run --poller-node-id=<id> --auto-accept-node-id=<id> --team-ids=1,2 --auto-accept-modes=autoAcceptReal,autoAcceptSettlement
  node scripts/phase3-runtime-confidence-check.mjs --poller-node-id=<id> --auto-accept-node-id=<id> --team-ids=1,2 --auto-accept-modes=autoAcceptReal,autoAcceptSettlement

Database credential:
  Set exactly one of DB_PASSWORD or DB_PASSWORD_FILE. Production requires
  DB_SSL_MODE=verify-identity and DB_SSL_CA_FILE.
`;
}

async function main() {
  if (hasFlag("help")) {
    console.log(helpText());
    return;
  }
  const options = cliOptions();
  if (!validateCliOptions(options)) {
    print({ ok: false, code: "PHASE3_RUNTIME_CONFIDENCE_CONFIG_INVALID" });
    process.exitCode = 1;
    return;
  }
  const database = dbConfig();
  if (hasFlag("dry-run") || database.missing.length > 0) {
    const ok = database.missing.length === 0;
    print({
      ok,
      dryRun: hasFlag("dry-run"),
      missingDbEnv: database.missing,
      expectedTeamIds: [...options.expectedTeamIds].sort((a, b) => a - b),
      pollerNodeId: options.pollerNodeId,
      autoAcceptNodeId: options.autoAcceptNodeId,
      expectedAutoAcceptModes: [...options.expectedAutoAcceptModes].sort(),
    });
    if (!ok) process.exitCode = 1;
    return;
  }
  try {
    const rows = await loadConfidenceRows(options, database.value);
    const result = evaluatePhase3RuntimeConfidence({ ...options, ...rows });
    print({ ...result, checkedAt: new Date().toISOString(), mode: "mysql" });
    if (!result.ok) process.exitCode = 1;
  } catch {
    print({ ok: false, code: "PHASE3_RUNTIME_CONFIDENCE_QUERY_FAILED" });
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  void main().catch(() => {
    print({ ok: false, code: "PHASE3_RUNTIME_CONFIDENCE_QUERY_FAILED" });
    process.exitCode = 1;
  });
}
