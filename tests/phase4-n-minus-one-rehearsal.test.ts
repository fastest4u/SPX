import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  N_MINUS_ONE_ACTION_IDS,
  buildNMinusOneDbProxyStartCommand,
  buildNMinusOneRoleProbeCommand,
  evaluateSchemaRange,
  executeNMinusOneAction,
  highestMigrationVersion,
  listRequiredRoleProbes,
  parseLiveArgs,
  validateRoleContracts,
} from "../scripts/phase4-n-minus-one-rehearsal.mjs";

const roles = [
  "web-api",
  "notification-service",
  "line-service",
  "ocr-service",
  "worker-ifn-split",
  "worker-ptwl-split",
];
const baseline = { rollbackEligibleRoles: roles };
const operatorRoot = `/opt/spx-staging/release/${"a".repeat(40)}/operator`;
const config = {
  environment: "staging",
  project: "spx-staging",
  envFile: "/etc/spx-staging/runtime.env",
  composeFiles: [
    `${operatorRoot}/docker-compose.yml`,
    `${operatorRoot}/docker-compose.staging.yml`,
  ],
  profile: "n-minus-one",
};

async function main(): Promise<void> {
  assert.deepEqual(evaluateSchemaRange({ current: 33, min: 32, max: 33 }), {
    ok: true,
    failures: [],
  });
  assert.equal(evaluateSchemaRange({ current: 33, min: 31, max: 32 }).ok, false);
  assert.equal(
    highestMigrationVersion([
      { name: "034_complete_fresh_baseline.sql" },
      { name: "036_create_gate6_control_plane.sql" },
      { name: "035_create_auto_accept_publication_controls.sql" },
      { name: "037_create_n_minus_one_probe_fixtures.sql" },
    ]),
    37,
  );

  const contract = JSON.parse(readFileSync("deploy/n-minus-one-role-contracts.json", "utf8"));
  const grants = JSON.parse(readFileSync("deploy/db-grants.json", "utf8"));
  assert.deepEqual(validateRoleContracts(contract), { ok: true, failures: [] });
  for (const role of roles.filter((role) => role !== "ocr-service")) {
    for (const table of contract.roles[role].representativeReads) {
      assert.ok(grants.roles[role].tables[table]?.includes("SELECT"), `${role} cannot read ${table}`);
    }
    for (const table of contract.roles[role].representativeWrites) {
      assert.ok(
        grants.roles[role].tables[table]?.some((verb: string) =>
          ["INSERT", "UPDATE", "DELETE"].includes(verb),
        ),
        `${role} cannot write ${table}`,
      );
    }
  }
  assert.deepEqual(listRequiredRoleProbes(baseline, contract), roles);
  assert.deepEqual(buildNMinusOneRoleProbeCommand(config, contract, "web-api"), [
    "compose",
    "-p",
    "spx-staging",
    "--env-file",
    "/etc/spx-staging/runtime.env",
    "-f",
    `${operatorRoot}/docker-compose.yml`,
    "-f",
    `${operatorRoot}/docker-compose.staging.yml`,
    "--profile",
    "n-minus-one",
    "run",
    "--rm",
    "--no-deps",
    "--pull",
    "never",
    "n-minus-one-web-probe",
  ]);
  assert.deepEqual(buildNMinusOneDbProxyStartCommand(config), [
    "compose",
    "-p",
    "spx-staging",
    "--env-file",
    "/etc/spx-staging/runtime.env",
    "-f",
    `${operatorRoot}/docker-compose.yml`,
    "-f",
    `${operatorRoot}/docker-compose.staging.yml`,
    "--profile",
    "n-minus-one",
    "up",
    "-d",
    "--no-deps",
    "--pull",
    "never",
    "n-minus-one-db-proxy",
  ]);
  assert.throws(
    () =>
      buildNMinusOneRoleProbeCommand(
        { ...config, project: "spx-production" },
        contract,
        "web-api",
      ),
    /spx-staging/i,
  );
  assert.throws(() => parseLiveArgs(["--confirm-n-minus-one-rehearsal"]), /controller context/i);

  const events: string[] = [];
  const result = await executeNMinusOneAction("start", {
    config,
    contract,
    baseline,
    inheritedAction: {
      actionId: N_MINUS_ONE_ACTION_IDS.start,
      stagingRunId: "staging-run-001",
    },
    stagingRunId: "staging-run-001",
    async startDbProxy(command: string[]) {
      events.push(`proxy:${command.at(-1)}`);
      return true;
    },
    async runProbe(role: string, command: string[]) {
      events.push(`${role}:${command.at(-1)}`);
      return { ok: true, role };
    },
  });
  assert.deepEqual(result, {
    ok: true,
    actionId: "phase4-n1-start",
    roleCount: roles.length,
  });
  assert.deepEqual(events, [
    "proxy:n-minus-one-db-proxy",
    "web-api:n-minus-one-web-probe",
    "notification-service:n-minus-one-notification-probe",
    "line-service:n-minus-one-line-probe",
    "ocr-service:n-minus-one-ocr-probe",
    "worker-ifn-split:n-minus-one-worker-ifn-probe",
    "worker-ptwl-split:n-minus-one-worker-ptwl-probe",
  ]);

  console.log("Phase 4 N-1 rehearsal tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
