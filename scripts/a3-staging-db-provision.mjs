#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import {
  databaseSecretPath,
  loadInstalledStagingActionCapability,
  loadStagingDatabaseCredential,
  readRootOwnedStagingSecret,
  STAGING_PROVISIONED_DB_ROLES,
} from "./lib/staging-action-capability.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";

const STEP_ORDER = Object.freeze([
  "bootstrap-db-and-migrator",
  "migrate-through-release",
  "finalize-principals",
  "revoke-bootstrap",
]);
const SHA256 = /^[0-9a-f]{64}$/;
const MIGRATION = /^\d{3}_[a-z0-9_]+\.sql$/;
const ROLE = /^[a-z][a-z0-9-]{0,62}$/;
const ACCOUNT_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,253}[A-Za-z0-9])?$/;
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
const OPERATIONS = Object.freeze({
  "db-bootstrap": { actionId: "staging-db-bootstrap", scope: "database-bootstrap" },
  "db-migrate": { actionId: "staging-db-migrate", scope: "database-migrate" },
  "db-finalize": { actionId: "staging-db-finalize", scope: "database-finalize" },
  "db-bootstrap-revoke": {
    actionId: "staging-db-bootstrap-revoke",
    scope: "database-revoke",
  },
});
const PRINCIPAL_ROLES = Object.freeze(STAGING_PROVISIONED_DB_ROLES.filter((role) => role !== "migrator"));
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const STAGING_ROLLOUT_DB_SERVICE_ROLES = Object.freeze({
  "auto-accept-ifn-phase3": "auto-accept-ifn-phase3",
  "auto-accept-ptwl-phase3": "auto-accept-ptwl-phase3",
  "gate6-monitor-probe": "gate6-monitor",
  "line-service": "line-service",
  migrator: "migrator",
  "notification-service": "notification-service",
  "poller-ifn-phase3": "poller-ifn-phase3",
  "poller-ptwl-phase3": "poller-ptwl-phase3",
  "realtime-service": "realtime-service",
  "web-api": "web-api",
  "worker-ifn": "worker-ifn",
  "worker-ifn-split": "worker-ifn-split",
  "worker-ptwl": "worker-ptwl",
  "worker-ptwl-split": "worker-ptwl-split",
});

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateProvisionPlan(plan) {
  const failures = [];
  if (plan?.environment !== "staging") failures.push("ENVIRONMENT_INVALID");
  if (plan?.project !== "spx-staging") failures.push("PROJECT_INVALID");
  if (plan?.database !== "spx_staging") failures.push("DATABASE_INVALID");
  const accountHosts = plan?.accountHosts;
  const signedAccountHosts = plan?.signedAccountHosts;
  const accountRoles =
    accountHosts && typeof accountHosts === "object" && !Array.isArray(accountHosts)
      ? Object.keys(accountHosts)
      : [];
  if (
    !same(accountRoles, STAGING_PROVISIONED_DB_ROLES) ||
    !same(accountHosts, signedAccountHosts) ||
    accountRoles.some(
      (role) => !ROLE.test(role) || !ACCOUNT_HOST.test(accountHosts[role]) || /[%_]/.test(accountHosts[role]),
    )
  ) {
    failures.push("ACCOUNT_HOST_INVALID");
  }
  if (!plan?.approvalId || plan?.usedApprovalIds?.includes(plan.approvalId))
    failures.push("APPROVAL_REPLAY");
  if (!same(plan?.steps?.map((step) => step.action), STEP_ORDER)) failures.push("STEP_ORDER_INVALID");
  if (!same(plan?.principals, PRINCIPAL_ROLES))
    failures.push("PRINCIPAL_SET_INVALID");
  if (
    !same(Object.keys(plan?.actors ?? {}).sort(), ["bootstrap", "phase3Control"]) ||
    !same(Object.keys(plan?.actorHosts ?? {}).sort(), ["bootstrap", "phase3Control"]) ||
    plan.actors.bootstrap !== "spx_staging_bootstrap" ||
    plan.actors.phase3Control !== "spx_stg_phase3_control" ||
    plan.actorHosts.phase3Control !== accountHosts?.["phase3-control"] ||
    Object.values(plan.actorHosts).some((host) => !ACCOUNT_HOST.test(host) || /[%_]/.test(host))
  ) {
    failures.push("ACTOR_IDENTITY_INVALID");
  }
  if (
    !Array.isArray(plan?.migrations) ||
    plan.migrations.length === 0 ||
    plan.migrations.some(
      (migration) => !MIGRATION.test(migration?.filename ?? "") || !SHA256.test(migration?.sha256 ?? ""),
    ) ||
    !same(
      plan.migrations.map((migration) => migration.filename),
      [...plan.migrations.map((migration) => migration.filename)].sort(),
    )
  )
    failures.push("MIGRATION_SET_INVALID");
  return { ok: failures.length === 0, failures };
}

function accountUsername(name) {
  return `spx_stg_${name.replaceAll("-", "_")}`;
}

function sqlAccount(username, host) {
  if (!SQL_IDENTIFIER.test(username) || !ACCOUNT_HOST.test(host) || /[%_]/.test(host)) {
    throw new Error("staging SQL account identity is invalid");
  }
  return `'${username}'@'${host}'`;
}

function account(name, host) {
  return sqlAccount(accountUsername(name), host);
}

export function buildProvisionStatements(plan) {
  const checked = validateProvisionPlan(plan);
  if (!checked.ok) throw new Error(`invalid staging provision plan: ${checked.failures.join(",")}`);
  const statements = [
    "CREATE DATABASE IF NOT EXISTS `spx_staging` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
    `CREATE USER IF NOT EXISTS ${account("migrator", plan.accountHosts.migrator)} IDENTIFIED BY ? REQUIRE SSL WITH MAX_USER_CONNECTIONS 4`,
    `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER ON \`spx_staging\`.* TO ${account("migrator", plan.accountHosts.migrator)}`,
  ];
  for (const principal of plan.principals) {
    statements.push(
      `CREATE USER IF NOT EXISTS ${account(principal, plan.accountHosts[principal])} IDENTIFIED BY ? REQUIRE SSL WITH MAX_USER_CONNECTIONS 8`,
    );
  }
  return statements;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !SQL_IDENTIFIER.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function grantStatements(role, host, grantContract) {
  const reviewedRole = role === "worker-ifn"
    ? "worker-ifn-split"
    : role === "worker-ptwl"
      ? "worker-ptwl-split"
      : role;
  const contract = grantContract?.roles?.[reviewedRole];
  if (!contract || typeof contract !== "object") {
    throw new Error(`grant contract does not contain ${role}`);
  }
  const target = account(role, host);
  const result = [];
  for (const privilege of contract.schemaPrivileges ?? []) {
    if (!/^[A-Z ]+$/.test(privilege)) throw new Error("schema privilege is invalid");
    result.push({ sql: `GRANT ${privilege} ON \`spx_staging\`.* TO ${target}` });
  }
  for (const [table, privileges] of Object.entries(contract.tables ?? {})) {
    assertIdentifier(table, "grant table");
    if (
      !Array.isArray(privileges) ||
      privileges.length === 0 ||
      privileges.some((privilege) => !/^[A-Z ]+$/.test(privilege))
    ) {
      throw new Error("table privileges are invalid");
    }
    result.push({
      sql: `GRANT ${privileges.join(", ")} ON \`spx_staging\`.\`${table}\` TO ${target}`,
    });
  }
  for (const [table, verbs] of Object.entries(contract.columns ?? {})) {
    assertIdentifier(table, "column grant table");
    for (const [privilege, columns] of Object.entries(verbs ?? {})) {
      if (
        !/^[A-Z ]+$/.test(privilege) ||
        !Array.isArray(columns) ||
        columns.length === 0 ||
        columns.some((column) => !SQL_IDENTIFIER.test(column))
      ) {
        throw new Error("column privileges are invalid");
      }
      result.push({
        sql: `GRANT ${privilege} (${columns.map((column) => `\`${column}\``).join(", ")}) ON \`spx_staging\`.\`${table}\` TO ${target}`,
      });
    }
  }
  return result;
}

export function buildProvisionOperation(plan, operation, grantContract) {
  const checked = validateProvisionPlan(plan);
  if (!checked.ok) throw new Error(`invalid staging provision plan: ${checked.failures.join(",")}`);
  if (!OPERATIONS[operation]) throw new Error("unknown staging provision operation");
  if (operation === "db-bootstrap") {
    return Object.freeze({
      operation,
      runMigrations: false,
      statements: Object.freeze([
        {
          sql: "CREATE DATABASE IF NOT EXISTS `spx_staging` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
        },
        {
          sql: `CREATE USER IF NOT EXISTS ${account("migrator", plan.accountHosts.migrator)} IDENTIFIED BY ? REQUIRE SSL WITH MAX_USER_CONNECTIONS 4`,
          passwordRole: "migrator",
        },
        {
          sql: `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER ON \`spx_staging\`.* TO ${account("migrator", plan.accountHosts.migrator)}`,
        },
      ]),
    });
  }
  if (operation === "db-migrate") {
    return Object.freeze({ operation, runMigrations: true, statements: Object.freeze([]) });
  }
  if (operation === "db-bootstrap-revoke") {
    return Object.freeze({
      operation,
      runMigrations: false,
      statements: Object.freeze([
        {
          sql: `DROP USER IF EXISTS ${sqlAccount(plan.actors.bootstrap, plan.actorHosts.bootstrap)}`,
        },
      ]),
    });
  }
  const statements = [];
  for (const role of plan.principals) {
    statements.push({
      sql: `CREATE USER IF NOT EXISTS ${account(role, plan.accountHosts[role])} IDENTIFIED BY ? REQUIRE SSL WITH MAX_USER_CONNECTIONS 8`,
      passwordRole: role,
    });
    statements.push(...grantStatements(role, plan.accountHosts[role], grantContract));
  }
  return Object.freeze({ operation, runMigrations: false, statements: Object.freeze(statements) });
}

export async function executeProvisionOperation(operation, ports) {
  const built = buildProvisionOperation(ports?.plan, operation, ports?.grantContract);
  if (built.runMigrations) {
    if (typeof ports?.runMigrations !== "function") throw new Error("migration runner is unavailable");
    await ports.runMigrations();
  } else {
    if (typeof ports?.executeSql !== "function") throw new Error("staging SQL executor is unavailable");
    const statements = built.statements.map((entry) => {
      if (!entry.passwordRole) return { ...entry, parameters: [] };
      const password = ports?.passwords?.[entry.passwordRole];
      if (typeof password !== "string" || password.length < 1 || password.length > 1_024) {
        throw new Error("staging principal credential is unavailable");
      }
      return { ...entry, parameters: [password] };
    });
    await ports.executeSql(statements);
  }
  return { ok: true, operation, statementCount: built.statements.length };
}

export function buildStagingSqlExecutorCommand(binding) {
  if (!IMAGE_DIGEST.test(binding?.imageDigest ?? "")) {
    throw new Error("immutable staging candidate image is required");
  }
  return [
    "run",
    "--rm",
    "--pull=never",
    "--network=spx-staging",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=64",
    "--memory=256m",
    "--cpus=0.25",
    binding.imageDigest,
    "node",
    "scripts/staging-db-sql-executor.mjs",
  ];
}

export async function executeSqlInCandidate(
  connectionConfig,
  statements,
  binding,
  spawn = spawnSync,
) {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  const payload = canonicalJson({
    schemaVersion: 1,
    connection: connectionConfig,
    statements,
  });
  if (Buffer.byteLength(payload) > 512 * 1024) {
    throw new Error("staging SQL execution payload is too large");
  }
  const result = spawn("docker", buildStagingSqlExecutorCommand(binding), {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
    input: payload,
    encoding: "utf8",
    timeout: 15 * 60 * 1_000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("fixed candidate staging SQL execution failed");
  }
}

export function buildStagingMigrationCommand(operatorRoot) {
  return [
    ...buildInstalledStagingComposePrefix(operatorRoot),
    "--profile",
    "migration",
    "run",
    "--rm",
    "--no-deps",
    "migrator",
  ];
}

export async function runMigrationsInCandidate(
  operatorRoot,
  binding,
  spawn = spawnSync,
) {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  const result = spawn("docker", buildStagingMigrationCommand(operatorRoot), {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15 * 60 * 1_000,
    env: buildInstalledStagingComposeEnvironment(binding, operatorRoot),
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("fixed staging migration failed");
  }
}

function provisionPlanFromContext(context, capability) {
  const accountHosts = context.descriptor?.database?.accountHosts;
  return {
    environment: "staging",
    project: "spx-staging",
    database: "spx_staging",
    accountHosts,
    signedAccountHosts: accountHosts,
    actors: capability.database.actors,
    actorHosts: capability.database.actorHosts,
    approvalId: context.envelope.approvalId,
    usedApprovalIds: [],
    migrations: context.envelope.migrations,
    steps: STEP_ORDER.map((action) => ({ action })),
    principals: PRINCIPAL_ROLES,
  };
}

export function provisionCredentialRoles(operation, plan) {
  if (!OPERATIONS[operation]) throw new Error("unknown staging provision operation");
  if (operation === "db-bootstrap") return ["migrator"];
  if (operation === "db-finalize") return [...plan.principals];
  return [];
}

function assertInheritedAction(operation, context) {
  const expected = OPERATIONS[operation];
  if (
    process.env.SPX_STAGING_ACTION_ID !== expected.actionId ||
    process.env.SPX_STAGING_ACTION_SCOPE !== expected.scope ||
    process.env.SPX_STAGING_RUN_ID !== context.installedBinding.stagingRunId
  ) {
    throw new Error("inherited verified staging database action is required");
  }
}

async function main() {
  try {
    if (process.argv.length !== 3 || !OPERATIONS[process.argv[2]]) {
      throw new Error("a fixed staging database operation is required");
    }
    const operation = process.argv[2];
    const context = await loadInstalledApprovedStagingContext();
    assertInheritedAction(operation, context);
    const capability = await loadInstalledStagingActionCapability(context.installedBinding);
    const operatorRoot = await loadInstalledStagingOperatorRoot(context.installedBinding);
    const grantContract = JSON.parse(
      await readFile(posix.join(operatorRoot, "deploy/db-grants.json"), "utf8"),
    );
    const plan = provisionPlanFromContext(context, capability);
    if (canonicalJson(capability.database.principalRoles) !== canonicalJson(Object.keys(plan.accountHosts).sort())) {
      throw new Error("staging database principal capability changed");
    }
    const passwordRoles = provisionCredentialRoles(operation, plan);
    const passwords = Object.fromEntries(
      await Promise.all(passwordRoles.map(async (role) => [
        role,
        await readRootOwnedStagingSecret(
          role === "phase3-control"
            ? databaseSecretPath("phase3-control")
            : databaseSecretPath("principal", role),
        ),
      ])),
    );
    const connectionConfig = operation === "db-migrate"
      ? null
      : await loadStagingDatabaseCredential(capability, "bootstrap");
    const result = await executeProvisionOperation(operation, {
      plan,
      grantContract,
      passwords,
      executeSql: (statements) => executeSqlInCandidate(
        connectionConfig,
        statements,
        context.installedBinding,
      ),
      runMigrations: () => runMigrationsInCandidate(operatorRoot, context.installedBinding),
    });
    console.log(canonicalJson(result));
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["STAGING_DB_ACTION_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("a3-staging-db-provision.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
