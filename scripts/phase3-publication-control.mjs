#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { canonicalJson, sha256Canonical } from "./lib/evidence-artifact.mjs";
import {
  consumeGate6MutationContext,
  inspectGate6MutationContext,
} from "./lib/gate6-controller.mjs";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIRECT_ACTIONS = new Set(["status", "dry-run"]);
const MUTATION_SCOPES = Object.freeze({
  "phase3-publication-enable": Object.freeze({
    action: "enable",
    keys: Object.freeze(["teamId", "epoch", "pollerNodeId"]),
  }),
  "phase3-publication-fence": Object.freeze({
    action: "fence",
    keys: Object.freeze(["teamId", "epoch", "pollerNodeId"]),
  }),
  "phase3-publication-advance": Object.freeze({
    action: "advance",
    keys: Object.freeze(["teamId", "previousEpoch", "nextEpoch", "nextPollerNodeId"]),
  }),
});
const COUNT_KEYS = Object.freeze([
  "pending",
  "retrying",
  "claimed",
  "verifying",
  "indeterminate",
  "unknown",
  "settlementPending",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (
    !isRecord(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  ) {
    throw new Error(`${label} has an invalid or unknown field`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function identifier(value, label, maximumLength) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || value.length > maximumLength
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a concrete bounded identifier`);
  }
  return value;
}

function validateCounts(counts) {
  assertExactKeys(counts, COUNT_KEYS, "Phase 3 scoped counts");
  return Object.fromEntries(COUNT_KEYS.map((key) => [
    key,
    nonNegativeInteger(counts[key], `Phase 3 ${key} count`),
  ]));
}

function hasPriorWork(counts) {
  return counts.pending + counts.retrying + counts.claimed + counts.verifying
    + counts.indeterminate + counts.unknown > 0;
}

export function evaluateRollbackScope(input) {
  if (!isRecord(input) || !isRecord(input.active) || !isRecord(input.expected) || !isRecord(input.control)) {
    throw new Error("Phase 3 rollback scope is invalid");
  }
  const counts = validateCounts(input.counts);
  const failures = [];
  if (
    input.active.epoch !== input.expected.epoch
    || input.active.generation !== input.expected.generation
  ) failures.push("ACTIVE_EPOCH_CHANGED");
  else if (
    input.control.epoch !== input.expected.epoch
    || input.control.generation !== input.expected.generation
  ) failures.push("CONTROL_IDENTITY_MISMATCH");
  else if (input.control.state !== "fenced") failures.push("PUBLICATION_NOT_FENCED");
  else if (
    input.control.pollerNodeId !== input.expected.pollerNodeId
    || input.control.ackNodeId !== input.expected.pollerNodeId
  ) failures.push("POLLER_NODE_MISMATCH");
  else if (
    input.control.acknowledgedAt === null
    || input.control.acknowledgedAt === undefined
    || input.control.ackJobId === null
    || input.control.ackJobId === undefined
  ) failures.push("POLLER_ACK_MISSING");
  else if (
    !Number.isSafeInteger(input.control.fenceJobId)
    || !Number.isSafeInteger(input.control.ackJobId)
    || input.control.ackJobId < input.control.fenceJobId
  ) failures.push("POLLER_ACK_BEHIND_FENCE");

  if (counts.claimed + counts.verifying > 0) failures.push("LIVE_CLAIMS_PRESENT");
  if (counts.pending + counts.retrying > 0) failures.push("QUEUE_NOT_EMPTY_OR_QUARANTINED");
  if (counts.indeterminate > 0) failures.push("INDETERMINATE_WORK_PRESENT");
  if (counts.unknown > 0) failures.push("UNKNOWN_JOB_STATUS_PRESENT");
  if (counts.settlementPending > 0) failures.push("SETTLEMENT_PENDING");
  return { ok: failures.length === 0, failures };
}

export function evaluateEpochAdvance(input) {
  if (!isRecord(input) || !isRecord(input.active) || !isRecord(input.control)) {
    throw new Error("Phase 3 epoch advance scope is invalid");
  }
  const counts = validateCounts(input.counts);
  identifier(input.previousEpoch, "previous epoch", 80);
  identifier(input.nextEpoch, "next epoch", 80);
  const failures = [];
  if (
    input.active.epoch !== input.previousEpoch
    || input.control.epoch !== input.previousEpoch
    || input.active.generation !== input.control.generation
  ) failures.push("ACTIVE_EPOCH_CHANGED");
  if (input.nextEpoch === input.previousEpoch) failures.push("NEXT_EPOCH_INVALID");
  if (input.control.state !== "fenced") failures.push("PUBLICATION_NOT_FENCED");
  else if (
    input.control.acknowledgedAt === null
    || input.control.ackJobId === null
    || input.control.ackJobId === undefined
  ) failures.push("POLLER_ACK_MISSING");
  else if (
    !Number.isSafeInteger(input.control.fenceJobId)
    || !Number.isSafeInteger(input.control.ackJobId)
    || input.control.ackJobId < input.control.fenceJobId
  ) failures.push("POLLER_ACK_BEHIND_FENCE");
  if (hasPriorWork(counts) || counts.settlementPending > 0) {
    failures.push("PRIOR_EPOCH_WORK_REMAINS");
  }
  return { ok: failures.length === 0, failures };
}

function parseArgument(argument) {
  const match = /^--([a-z0-9-]+)=(.*)$/.exec(argument);
  if (!match) throw new Error("Phase 3 publication control is read-only without controller context");
  return [match[1], match[2]];
}

export function parseCli(argv) {
  if (!Array.isArray(argv)) throw new Error("Phase 3 publication control arguments are invalid");
  const entries = argv.map(parseArgument);
  const args = Object.fromEntries(entries);
  if (
    entries.length !== 4
    || Object.keys(args).some((key) => !["action", "team-id", "epoch", "poller-node-id"].includes(key))
    || !DIRECT_ACTIONS.has(args.action)
  ) {
    throw new Error("Phase 3 publication control is read-only without controller context");
  }
  return {
    action: args.action,
    teamId: positiveInteger(Number(args["team-id"]), "team ID"),
    epoch: identifier(args.epoch, "epoch", 80),
    pollerNodeId: identifier(args["poller-node-id"], "poller node ID", 120),
  };
}

function validateMutationBinding(scope, binding) {
  const definition = MUTATION_SCOPES[scope];
  if (!definition) throw new Error("Phase 3 publication mutation scope is invalid");
  assertExactKeys(binding, definition.keys, "Phase 3 publication mutation binding");
  positiveInteger(binding.teamId, "team ID");
  if (definition.action === "advance") {
    identifier(binding.previousEpoch, "previous epoch", 80);
    identifier(binding.nextEpoch, "next epoch", 80);
    identifier(binding.nextPollerNodeId, "next poller node ID", 120);
    if (binding.previousEpoch === binding.nextEpoch) throw new Error("next epoch must be distinct");
  } else {
    identifier(binding.epoch, "epoch", 80);
    identifier(binding.pollerNodeId, "poller node ID", 120);
  }
  return definition;
}

function numberValue(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function controlRow(row) {
  if (!row) throw new Error("publication control is missing");
  return {
    teamId: numberValue(row.team_id, "team ID"),
    epoch: row.cutover_epoch,
    generation: numberValue(row.publication_generation, "publication generation"),
    state: row.state,
    pollerNodeId: row.poller_node_id,
    fenceJobId: row.fence_job_id === null ? null : numberValue(row.fence_job_id, "fence watermark"),
    ackNodeId: row.ack_node_id,
    ackJobId: row.ack_job_id === null ? null : numberValue(row.ack_job_id, "acknowledgement watermark"),
    acknowledgedAt: row.acknowledged_at,
  };
}

async function selectControl(connection, teamId, epoch, lock = false) {
  const [rows] = await connection.execute(`
    SELECT team_id, cutover_epoch, publication_generation, state, poller_node_id,
           fence_job_id, ack_node_id, ack_job_id, acknowledged_at
    FROM auto_accept_publication_controls
    WHERE team_id = ? AND cutover_epoch = ?
    ${lock ? "FOR UPDATE" : ""}
  `, [teamId, epoch]);
  return rows[0] ?? null;
}

async function selectActive(connection, teamId, lock = false) {
  const [rows] = await connection.execute(`
    SELECT active_epoch, active_generation
    FROM auto_accept_publication_active_epochs
    WHERE team_id = ?
    ${lock ? "FOR UPDATE" : ""}
  `, [teamId]);
  return rows[0] ?? null;
}

async function withTransaction(operation) {
  const database = mysqlScriptConnectionConfigFromEnv();
  if (database.missing.length > 0) throw new Error("Phase 3 control database is unavailable");
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(database.value);
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* rollback is best effort */ }
    throw error;
  } finally {
    await connection.end();
  }
}

async function withInjectedTransaction(createConnection, operation) {
  const connection = await createConnection();
  if (!connection || typeof connection.execute !== "function") {
    throw new Error("Phase 3 injected database connection is unavailable");
  }
  let result;
  let operationFailure = null;
  try {
    await connection.beginTransaction();
    result = await operation(connection);
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch { /* rollback is best effort */ }
    operationFailure = error;
  }
  let releaseFailure = null;
  try {
    if (typeof connection.release === "function") connection.release();
    else if (typeof connection.end === "function") await connection.end();
    else throw new Error("Phase 3 injected database connection cannot be released");
  } catch (error) {
    releaseFailure = error;
  }
  if (releaseFailure !== null) throw releaseFailure;
  if (operationFailure !== null) throw operationFailure;
  return result;
}

async function enableMysql(binding, transact = withTransaction) {
  return transact(async (connection) => {
    const active = await selectActive(connection, binding.teamId, true);
    if (active) {
      if (active.active_epoch !== binding.epoch) throw new Error("active publication epoch changed");
      const existing = controlRow(await selectControl(connection, binding.teamId, binding.epoch, true));
      if (
        existing.generation !== numberValue(active.active_generation, "active publication generation")
        || existing.pollerNodeId !== binding.pollerNodeId
      ) throw new Error("publication identity mismatch");
      return existing;
    }
    const [history] = await connection.execute(`
      SELECT publication_generation
      FROM auto_accept_publication_controls
      WHERE team_id = ?
      FOR UPDATE
    `, [binding.teamId]);
    if (history.length > 0) throw new Error("publication history exists without an active pointer");
    await connection.execute(`
      INSERT INTO auto_accept_publication_controls (
        team_id, cutover_epoch, publication_generation, state, poller_node_id
      ) VALUES (?, ?, 1, 'enabled', ?)
    `, [binding.teamId, binding.epoch, binding.pollerNodeId]);
    await connection.execute(`
      INSERT INTO auto_accept_publication_active_epochs (
        team_id, active_epoch, active_generation
      ) VALUES (?, ?, 1)
    `, [binding.teamId, binding.epoch]);
    return controlRow(await selectControl(connection, binding.teamId, binding.epoch, true));
  });
}

async function fenceMysql(binding, transact = withTransaction) {
  return transact(async (connection) => {
    const active = await selectActive(connection, binding.teamId, true);
    if (!active || active.active_epoch !== binding.epoch) throw new Error("active publication epoch changed");
    const control = controlRow(await selectControl(connection, binding.teamId, binding.epoch, true));
    if (
      control.pollerNodeId !== binding.pollerNodeId
      || control.generation !== numberValue(active.active_generation, "active publication generation")
    ) throw new Error("publication identity mismatch");
    if (control.state === "enabled") {
      const [rows] = await connection.execute(`
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM auto_accept_jobs
        WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
        FOR UPDATE
      `, [binding.teamId, binding.epoch, control.generation]);
      await connection.execute(`
        UPDATE auto_accept_publication_controls
        SET state = 'fenced', fence_job_id = ?, fence_requested_at = CURRENT_TIMESTAMP
        WHERE team_id = ? AND cutover_epoch = ? AND state = 'enabled'
      `, [numberValue(rows[0]?.watermark ?? 0, "fence watermark"), binding.teamId, binding.epoch]);
    } else if (control.state !== "fenced") {
      throw new Error("publication state is invalid");
    }
    return controlRow(await selectControl(connection, binding.teamId, binding.epoch, true));
  });
}

async function advanceMysql(binding, transact = withTransaction) {
  return transact(async (connection) => {
    const activeRaw = await selectActive(connection, binding.teamId, true);
    if (!activeRaw || activeRaw.active_epoch !== binding.previousEpoch) {
      throw new Error("active publication epoch changed");
    }
    const activeGeneration = numberValue(activeRaw.active_generation, "active publication generation");
    const previous = controlRow(await selectControl(connection, binding.teamId, binding.previousEpoch, true));
    if (
      previous.generation !== activeGeneration
      || previous.state !== "fenced"
      || previous.acknowledgedAt === null
      || previous.ackNodeId !== previous.pollerNodeId
      || previous.fenceJobId === null
      || previous.ackJobId === null
      || previous.ackJobId < previous.fenceJobId
    ) throw new Error("prior publication fence is not acknowledged");
    const [work] = await connection.execute(`
      SELECT id
      FROM auto_accept_jobs
      WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
        AND (
          status IN ('pending', 'retrying', 'claimed', 'verifying', 'indeterminate')
          OR result_status = 'unknown'
          OR (result_status IS NOT NULL AND completed_at IS NULL)
        )
      FOR UPDATE
    `, [binding.teamId, binding.previousEpoch, activeGeneration]);
    if (work.length > 0) throw new Error("prior publication epoch has work");
    if (await selectControl(connection, binding.teamId, binding.nextEpoch, true)) {
      throw new Error("next publication epoch already exists");
    }
    const nextGeneration = activeGeneration + 1;
    await connection.execute(`
      INSERT INTO auto_accept_publication_controls (
        team_id, cutover_epoch, publication_generation, state, poller_node_id
      ) VALUES (?, ?, ?, 'enabled', ?)
    `, [binding.teamId, binding.nextEpoch, nextGeneration, binding.nextPollerNodeId]);
    const [moved] = await connection.execute(`
      UPDATE auto_accept_publication_active_epochs
      SET active_epoch = ?, active_generation = ?
      WHERE team_id = ? AND active_epoch = ? AND active_generation = ?
    `, [binding.nextEpoch, nextGeneration, binding.teamId, binding.previousEpoch, activeGeneration]);
    if (moved.affectedRows !== 1) throw new Error("active publication epoch changed");
    return controlRow(await selectControl(connection, binding.teamId, binding.nextEpoch, true));
  });
}

const DEFAULT_OPERATIONS = Object.freeze({
  enable: enableMysql,
  fence: fenceMysql,
  advance: advanceMysql,
});

export function createPhase3PublicationMysqlOperations(createConnection) {
  if (typeof createConnection !== "function") {
    throw new Error("Phase 3 connection factory is required");
  }
  const transact = (operation) => withInjectedTransaction(createConnection, operation);
  return Object.freeze({
    enable: (binding) => enableMysql(binding, transact),
    fence: (binding) => fenceMysql(binding, transact),
    advance: (binding) => advanceMysql(binding, transact),
  });
}

export async function executeGate6Phase3PublicationMutation({
  context,
  scope,
  binding,
  operations = DEFAULT_OPERATIONS,
}) {
  const definition = validateMutationBinding(scope, binding);
  const operation = operations?.[definition.action];
  if (typeof operation !== "function") throw new Error("Phase 3 publication mutation operation is unavailable");
  const inspected = inspectGate6MutationContext(context, scope);
  if (sha256Canonical(binding) !== inspected.allowedMutationSha256) {
    throw new Error("Phase 3 publication mutation binding mismatch");
  }
  consumeGate6MutationContext(context, scope);
  const result = await operation(Object.freeze(structuredClone(binding)));
  return { ok: true, action: definition.action, result };
}

export async function loadPhase3PublicationSnapshot(connection, input) {
  positiveInteger(input.teamId, "team ID");
  identifier(input.epoch, "epoch", 80);
  identifier(input.pollerNodeId, "poller node ID", 120);
  const [controls] = await connection.execute(`
    SELECT team_id, cutover_epoch, publication_generation, state, poller_node_id,
           fence_job_id, ack_node_id, ack_job_id, acknowledged_at,
           active_epoch, active_generation
    FROM operational_phase3_control_evidence
    WHERE team_id = ? AND cutover_epoch = ?
  `, [input.teamId, input.epoch]);
  if (controls.length !== 1) throw new Error("scoped publication control is missing");
  const row = controls[0];
  const generation = numberValue(row.publication_generation, "publication generation");
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  const [statusRows] = await connection.execute(`
    SELECT status, COUNT(*) AS count
    FROM operational_phase3_evidence
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
    GROUP BY status
  `, [input.teamId, input.epoch, generation]);
  for (const statusRow of statusRows) {
    const value = numberValue(statusRow.count, "job status count");
    if (["pending", "retrying", "claimed", "verifying", "indeterminate"].includes(statusRow.status)) {
      counts[statusRow.status] += value;
    }
  }
  const [unknownRows] = await connection.execute(`
    SELECT COUNT(*) AS count
    FROM operational_phase3_evidence
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
      AND (
        result_status = 'unknown'
        OR status NOT IN (
          'pending', 'retrying', 'claimed', 'verifying', 'succeeded',
          'failed', 'indeterminate', 'dead_letter', 'cancelled'
        )
      )
  `, [input.teamId, input.epoch, generation]);
  counts.unknown += numberValue(unknownRows[0]?.count ?? 0, "unknown result count");
  const [settlementRows] = await connection.execute(`
    SELECT COUNT(*) AS count
    FROM operational_phase3_evidence
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
      AND result_status IS NOT NULL
      AND status NOT IN ('succeeded', 'failed', 'indeterminate', 'dead_letter', 'cancelled')
  `, [input.teamId, input.epoch, generation]);
  counts.settlementPending = numberValue(settlementRows[0]?.count ?? 0, "settlement count");
  return {
    active: {
      epoch: row.active_epoch,
      generation: numberValue(row.active_generation, "active publication generation"),
    },
    expected: { epoch: input.epoch, generation, pollerNodeId: input.pollerNodeId },
    control: controlRow(row),
    counts,
  };
}

function print(value) {
  process.stdout.write(`${canonicalJson(value)}\n`);
}

async function main() {
  try {
    const args = parseCli(process.argv.slice(2));
    const database = mysqlScriptConnectionConfigFromEnv();
    if (database.missing.length > 0) throw new Error("database unavailable");
    const mysql = await import("mysql2/promise");
    const connection = await mysql.createConnection(database.value);
    try {
      const snapshot = await loadPhase3PublicationSnapshot(connection, args);
      const evaluation = evaluateRollbackScope(snapshot);
      print({ ...evaluation, action: args.action, teamId: args.teamId, epoch: args.epoch });
      if (args.action === "dry-run" && !evaluation.ok) process.exitCode = 1;
    } finally {
      await connection.end();
    }
  } catch {
    print({ ok: false, code: "phase3-publication-control-refused" });
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) void main();
