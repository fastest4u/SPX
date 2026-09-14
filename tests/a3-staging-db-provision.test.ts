import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildStagingMigrationCommand,
  buildStagingSqlExecutorCommand,
  buildProvisionOperation,
  buildProvisionStatements,
  executeSqlInCandidate,
  executeProvisionOperation,
  provisionCredentialRoles,
  runMigrationsInCandidate,
  STAGING_ROLLOUT_DB_SERVICE_ROLES,
  validateProvisionPlan,
} from "../scripts/a3-staging-db-provision.mjs";
import { STAGING_PROVISIONED_DB_ROLES } from "../scripts/lib/staging-action-capability.mjs";

const released = JSON.parse(readFileSync("migrations/released-checksums.json", "utf8"));
const grantContract = JSON.parse(readFileSync("deploy/db-grants.json", "utf8"));
const migrations = Object.entries(released).map(([filename, sha256]) => ({
  filename,
  sha256,
}));
const validPlan = {
  environment: "staging",
  project: "spx-staging",
  database: "spx_staging",
  accountHosts: Object.fromEntries(STAGING_PROVISIONED_DB_ROLES.map((role) => [role, "172.17.0.1"])),
  signedAccountHosts: Object.fromEntries(STAGING_PROVISIONED_DB_ROLES.map((role) => [role, "172.17.0.1"])),
  actors: {
    bootstrap: "spx_staging_bootstrap",
    phase3Control: "spx_stg_phase3_control",
  },
  actorHosts: {
    bootstrap: "172.17.0.254",
    phase3Control: "172.17.0.1",
  },
  approvalId: "approval-new",
  usedApprovalIds: [],
  migrations,
  steps: [
    { action: "bootstrap-db-and-migrator" },
    { action: "migrate-through-release" },
    { action: "finalize-principals" },
    { action: "revoke-bootstrap" },
  ],
  principals: STAGING_PROVISIONED_DB_ROLES.filter((role) => role !== "migrator"),
};

async function main(): Promise<void> {
assert.deepEqual(validateProvisionPlan(validPlan), { ok: true, failures: [] });
assert.deepEqual(Object.keys(STAGING_ROLLOUT_DB_SERVICE_ROLES).sort(), [
  "auto-accept-ifn-phase3",
  "auto-accept-ptwl-phase3",
  "gate6-monitor-probe",
  "line-service",
  "migrator",
  "notification-service",
  "poller-ifn-phase3",
  "poller-ptwl-phase3",
  "realtime-service",
  "web-api",
  "worker-ifn",
  "worker-ifn-split",
  "worker-ptwl",
  "worker-ptwl-split",
]);
assert.deepEqual(
  [
    ...new Set(Object.values(STAGING_ROLLOUT_DB_SERVICE_ROLES)),
    "phase3-control",
    "phase3-observer",
  ].sort(),
  [...STAGING_PROVISIONED_DB_ROLES],
);
assert.equal(validateProvisionPlan({ ...validPlan, database: "spx" }).ok, false);
assert.equal(validateProvisionPlan({ ...validPlan, environment: "production" }).ok, false);
assert.equal(
  validateProvisionPlan({ ...validPlan, usedApprovalIds: [validPlan.approvalId] }).ok,
  false,
);
assert.equal(
  validateProvisionPlan({
    ...validPlan,
    accountHosts: Object.fromEntries(
      Object.entries(validPlan.accountHosts).filter(([role]) => role !== "worker-ifn"),
    ),
    signedAccountHosts: Object.fromEntries(
      Object.entries(validPlan.signedAccountHosts).filter(([role]) => role !== "worker-ifn"),
    ),
    principals: validPlan.principals.filter((role) => role !== "worker-ifn"),
  }).ok,
  false,
);
assert.equal(
  validateProvisionPlan({ ...validPlan, principals: [...validPlan.principals, "ocr"] }).ok,
  false,
);
assert.equal(
  validateProvisionPlan({
    ...validPlan,
    accountHosts: { ...validPlan.accountHosts, "line-service": "172.17.0.2" },
  }).ok,
  false,
);
assert.equal(
  validateProvisionPlan({
    ...validPlan,
    accountHosts: { ...validPlan.accountHosts, "line-service": "%" },
    signedAccountHosts: { ...validPlan.signedAccountHosts, "line-service": "%" },
  }).ok,
  false,
);
assert.equal(
  validateProvisionPlan({ ...validPlan, steps: [...validPlan.steps].reverse() }).ok,
  false,
);
const statements = buildProvisionStatements(validPlan);
assert.ok(statements.length > 0);
assert.equal(statements.some((sql) => /\bDROP\b|GRANT\s+OPTION|@'%'/i.test(sql)), false);
assert.equal(statements.every((sql) => !/\bspx\b(?!_staging)/i.test(sql)), true);
assert.equal(statements.some((sql) => /REQUIRE SSL/i.test(sql)), true);

const bootstrap = buildProvisionOperation(validPlan, "db-bootstrap", { roles: {} });
assert.equal(bootstrap.statements.some((entry: { sql: string }) => /spx_stg_web_api/.test(entry.sql)), false);
assert.equal(bootstrap.statements.some((entry: { sql: string }) => /CREATE DATABASE/.test(entry.sql)), true);
const finalized = buildProvisionOperation(validPlan, "db-finalize", grantContract);
assert.equal(finalized.statements.some((entry: { sql: string }) => /CREATE DATABASE/.test(entry.sql)), false);
assert.equal(finalized.statements.length >= validPlan.principals.length, true);
assert.equal(finalized.statements.some((entry: { sql: string }) => /spx_stg_worker_ifn'@/.test(entry.sql)), true);
assert.equal(finalized.statements.some((entry: { sql: string }) => /spx_stg_worker_ptwl'@/.test(entry.sql)), true);
const observerStatements = finalized.statements.filter((entry: { sql: string }) =>
  /spx_stg_phase3_observer'@/.test(entry.sql));
assert.equal(observerStatements.some((entry: { sql: string }) => /CREATE USER/.test(entry.sql)), true);
assert.equal(observerStatements.some((entry: { sql: string }) =>
  /GRANT SELECT ON `spx_staging`\.`operational_phase3_control_evidence`/.test(entry.sql)), true);
const observerLeaseStatements = observerStatements.filter((entry: { sql: string }) =>
  /`spx_staging`\.`team_runtime_leases`/.test(entry.sql));
assert.deepEqual(observerLeaseStatements, [{
  sql: "GRANT SELECT (`lease_expires_at`, `owner_node_id`, `status`, `team_id`) ON `spx_staging`.`team_runtime_leases` TO 'spx_stg_phase3_observer'@'172.17.0.1'",
}]);
const expectedObserverColumnStatements = [
  "GRANT SELECT (`accept_finished_at`, `ambiguous_accept`, `created_at`, `id`, `team_id`, `trace_id`, `worker_node_id`) ON `spx_staging`.`auto_accept_attempts` TO 'spx_stg_phase3_observer'@'172.17.0.1'",
  "GRANT SELECT (`booking_id`, `rule_id`, `team_id`, `trace_id`) ON `spx_staging`.`auto_accept_history` TO 'spx_stg_phase3_observer'@'172.17.0.1'",
  "GRANT SELECT (`completed_at`, `job_id`, `settlement_step`, `team_id`) ON `spx_staging`.`auto_accept_job_settlements` TO 'spx_stg_phase3_observer'@'172.17.0.1'",
  "GRANT SELECT (`booking_id`, `claim_expires_at`, `completed_at`, `created_at`, `cutover_epoch`, `id`, `publication_generation`, `request_id`, `result_status`, `rule_id`, `status`, `team_id`, `winning_attempt_trace_id`) ON `spx_staging`.`auto_accept_jobs` TO 'spx_stg_phase3_observer'@'172.17.0.1'",
  "GRANT SELECT (`booking_id`, `request_id`, `team_id`) ON `spx_staging`.`auto_accept_results` TO 'spx_stg_phase3_observer'@'172.17.0.1'",
  "GRANT SELECT (`event_type`, `team_id`, `trace_id`) ON `spx_staging`.`notification_events` TO 'spx_stg_phase3_observer'@'172.17.0.1'",
  "GRANT SELECT (`request_id`, `team_id`) ON `spx_staging`.`spx_booking_history` TO 'spx_stg_phase3_observer'@'172.17.0.1'",
  observerLeaseStatements[0].sql,
].sort();
assert.deepEqual(
  observerStatements
    .filter((entry: { sql: string }) => /GRANT SELECT \(/.test(entry.sql))
    .map((entry: { sql: string }) => entry.sql)
    .sort(),
  expectedObserverColumnStatements,
);
assert.equal(observerStatements.some((entry: { sql: string }) =>
  /GRANT\s+SELECT\s+ON\s+`spx_staging`\.`(?:auto_accept_attempts|auto_accept_history|auto_accept_job_settlements|auto_accept_jobs|auto_accept_results|notification_events|spx_booking_history|team_runtime_leases)`/i.test(entry.sql)), false);
assert.equal(observerStatements.some((entry: { sql: string }) => /\b(?:INSERT|UPDATE|DELETE)\b/.test(entry.sql)), false);
const revoked = buildProvisionOperation(validPlan, "db-bootstrap-revoke", grantContract);
assert.deepEqual(revoked.statements, [
  { sql: "DROP USER IF EXISTS 'spx_staging_bootstrap'@'172.17.0.254'" },
]);

const events: string[] = [];
assert.deepEqual(provisionCredentialRoles("db-bootstrap", validPlan), ["migrator"]);
assert.deepEqual(provisionCredentialRoles("db-migrate", validPlan), []);
assert.deepEqual(provisionCredentialRoles("db-finalize", validPlan), validPlan.principals);
assert.deepEqual(provisionCredentialRoles("db-bootstrap-revoke", validPlan), []);
await executeProvisionOperation("db-bootstrap", {
  plan: validPlan,
  grantContract: { roles: {} },
  passwords: { migrator: "test-password" },
  async executeSql(statements: Array<{ sql: string }>) {
    events.push(`sql:${statements.length}`);
  },
  async runMigrations() {
    events.push("migrations");
  },
});
assert.deepEqual(events, [`sql:${bootstrap.statements.length}`]);

const source = readFileSync("scripts/a3-staging-db-provision.mjs", "utf8");
assert.match(source, /loadInstalledStagingActionCapability/);
assert.match(source, /loadStagingDatabaseCredential/);
assert.match(source, /databaseSecretPath\("principal"/);
assert.doesNotMatch(source, /mysqlScriptConnectionConfigFromEnv|SPX_STAGING_DB_PASSWORD_/);
assert.doesNotMatch(source, /import\("mysql2\/promise"\)/);

const binding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: "1".repeat(64),
  environment: "staging",
  topology: "split",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: "c".repeat(64),
  operatorBundleSha256: "d".repeat(64),
  stagingApprovalEnvelopeSha256: "2".repeat(64),
  actionJournalHeadSha256: "3".repeat(64),
  stagingRunId: "staging-run-001",
};
const operatorRoot = `/opt/spx-staging/release/${binding.candidateSha}/operator`;
assert.deepEqual(buildStagingSqlExecutorCommand(binding), [
  "run", "--rm", "--pull=never", "--network=spx-staging", "--read-only",
  "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true", "--pids-limit=64", "--memory=256m", "--cpus=0.25",
  binding.imageDigest, "node", "scripts/staging-db-sql-executor.mjs",
]);
assert.deepEqual(buildStagingMigrationCommand(operatorRoot), [
  "compose", "-p", "spx-staging", "--env-file", "/etc/spx-staging/runtime.env",
  "-f", `${operatorRoot}/docker-compose.yml`, "-f", `${operatorRoot}/docker-compose.staging.yml`,
  "--profile", "migration", "run", "--rm", "--no-deps", "migrator",
]);
const spawned: Array<{ command: string; argv: string[]; options: Record<string, unknown> }> = [];
const spawn = (command: string, argv: string[], options: Record<string, unknown>) => {
  spawned.push({ command, argv, options });
  return { status: 0, signal: null, error: undefined };
};
await executeSqlInCandidate(
  {
    host: "mysql.staging.internal",
    port: 3306,
    user: "spx_staging_bootstrap",
    password: "x".repeat(40),
    database: "spx_staging",
    ssl: { ca: "test-ca", rejectUnauthorized: true, servername: "mysql.staging.internal" },
  },
  [{ sql: "CREATE DATABASE IF NOT EXISTS `spx_staging`", parameters: [] }],
  binding,
  spawn,
);
assert.equal(spawned[0].command, "docker");
assert.deepEqual(spawned[0].argv, buildStagingSqlExecutorCommand(binding));
assert.equal(JSON.stringify(spawned[0].options).includes("x".repeat(40)), true);
assert.equal(spawned[0].argv.join(" ").includes("x".repeat(40)), false);
await runMigrationsInCandidate(operatorRoot, binding, spawn);
assert.deepEqual(spawned[1].argv, buildStagingMigrationCommand(operatorRoot));
assert.equal((spawned[1].options.env as Record<string, string>).SPX_IMAGE, binding.imageDigest);

console.log("A3 staging DB provisioning tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
