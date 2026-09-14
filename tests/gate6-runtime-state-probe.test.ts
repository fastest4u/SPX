import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  executeGate6RuntimeProbe,
  parseGate6RuntimeProbeArgs,
} from "../scripts/gate6-runtime-state-probe.mjs";

async function main(): Promise<void> {
  assert.deepEqual(parseGate6RuntimeProbeArgs(["--probe=lease", "--team-id=2"]), {
    probe: "lease",
    teamId: 2,
    epoch: null,
  });
  assert.throws(
    () => parseGate6RuntimeProbeArgs(["--probe=lease", "--team-id=2", "--table=users"]),
    /unknown/i,
  );
  const sql: string[] = [];
  const lease = await executeGate6RuntimeProbe({
    async execute(statement: string) {
      sql.push(statement);
      return [[{
        owner_node_id: "prod-worker-ifn-split-1",
        owner_role: "worker",
        status: "running",
        lease_active: 1,
      }], []];
    },
  }, { probe: "lease", teamId: 2, epoch: null });
  assert.equal(lease.leaseActive, true);
  assert.equal(lease.ownerNodeId, "prod-worker-ifn-split-1");
  const source = readFileSync("scripts/gate6-runtime-state-probe.mjs", "utf8");
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
  assert.match(source, /mysqlScriptConnectionConfigFromEnv/);
  assert.equal(sql.every((statement) => /^\s*SELECT\b/i.test(statement)), true);
  console.log("Gate 6 runtime state probe tests passed");
}

void main();
