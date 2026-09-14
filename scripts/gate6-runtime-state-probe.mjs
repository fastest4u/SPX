#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROBES = new Set(["lease", "phase3-drain", "phase3-fence"]);

function one(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`${label} is unavailable or ambiguous`);
  return rows[0];
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

export function parseGate6RuntimeProbeArgs(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("Gate 6 runtime probe arguments are invalid");
    values[match[1]] = match[2];
  }
  if (!PROBES.has(values.probe) || !/^[1-9]\d*$/.test(values["team-id"] ?? "")) {
    throw new Error("Gate 6 runtime probe selection is invalid");
  }
  const allowed = values.probe === "phase3-fence"
    ? ["probe", "team-id", "epoch"]
    : ["probe", "team-id"];
  if (Object.keys(values).some((key) => !allowed.includes(key))) throw new Error("unknown Gate 6 runtime probe argument");
  if (values.probe === "phase3-fence" && !ID.test(values.epoch ?? "")) {
    throw new Error("Gate 6 Phase 3 probe epoch is invalid");
  }
  return { probe: values.probe, teamId: Number(values["team-id"]), epoch: values.epoch ?? null };
}

export async function executeGate6RuntimeProbe(connection, input) {
  if (input.probe === "lease") {
    const [rows] = await connection.execute(`
      SELECT owner_node_id, owner_role, status,
             lease_expires_at > UTC_TIMESTAMP(3) AS lease_active
      FROM team_runtime_leases WHERE team_id = ?
    `, [input.teamId]);
    if (!Array.isArray(rows) || rows.length > 1) throw new Error("Gate 6 lease evidence is ambiguous");
    const row = rows[0];
    return {
      ok: true,
      probe: "lease",
      teamId: input.teamId,
      ownerNodeId: row?.owner_node_id ?? null,
      ownerRole: row?.owner_role ?? null,
      status: row?.status ?? null,
      leaseActive: Number(row?.lease_active ?? 0) === 1,
    };
  }
  if (input.probe === "phase3-drain") {
    const [rows] = await connection.execute(`
      SELECT COUNT(*) AS active_count FROM auto_accept_jobs
      WHERE team_id = ?
        AND status IN ('pending', 'retrying', 'claimed', 'verifying', 'indeterminate')
    `, [input.teamId]);
    return {
      ok: true,
      probe: "phase3-drain",
      teamId: input.teamId,
      activeCount: integer(one(rows, "Gate 6 Phase 3 drain evidence").active_count, "active job count"),
    };
  }
  const [rows] = await connection.execute(`
    SELECT c.state, c.poller_node_id, c.fence_job_id, c.ack_node_id,
           c.ack_job_id, c.acknowledged_at,
           (a.active_epoch = c.cutover_epoch
             AND a.active_generation = c.publication_generation) AS is_active
    FROM auto_accept_publication_controls c
    LEFT JOIN auto_accept_publication_active_epochs a ON a.team_id = c.team_id
    WHERE c.team_id = ? AND c.cutover_epoch = ?
  `, [input.teamId, input.epoch]);
  const row = one(rows, "Gate 6 Phase 3 fence evidence");
  return {
    ok: true,
    probe: "phase3-fence",
    teamId: input.teamId,
    epoch: input.epoch,
    state: row.state,
    pollerNodeId: row.poller_node_id,
    fenceJobId: integer(row.fence_job_id, "fence job ID"),
    ackNodeId: row.ack_node_id,
    ackJobId: integer(row.ack_job_id, "acknowledged job ID"),
    acknowledged: row.acknowledged_at !== null,
    active: Number(row.is_active) === 1,
  };
}

async function main() {
  try {
    const args = parseGate6RuntimeProbeArgs(process.argv.slice(2));
    const configured = mysqlScriptConnectionConfigFromEnv();
    if (configured.missing.length > 0) throw new Error("Gate 6 runtime probe database is unavailable");
    const mysql = await import("mysql2/promise");
    const connection = await mysql.createConnection(configured.value);
    try {
      const result = await executeGate6RuntimeProbe(connection, args);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      await connection.end();
    }
  } catch {
    process.stdout.write('{"code":"gate6-runtime-probe-refused","ok":false}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
