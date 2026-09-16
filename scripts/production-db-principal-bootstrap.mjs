import { createHash } from "node:crypto";

import { PRODUCTION_DB_ROLE_ORDER } from "./db-principal-rollout.mjs";

export const PRODUCTION_BOOTSTRAP_DB_ROLES = Object.freeze([
  "gate6-control",
  "gate6-monitor",
  "observer",
  ...PRODUCTION_DB_ROLE_ORDER,
]);

const HASH = /^[0-9a-f]{64}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\d{1,3}(?:\.\d{1,3}){3})$/;
const USER = /^[A-Za-z0-9_$-]{1,64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
const PRIVILEGE = /^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|INDEX|DROP)$/;
const PASSWORD = /^[A-Za-z0-9_-]{32,1024}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactHost(value) {
  return typeof value === "string" && HOST.test(value) && !/[%_/@\\\s]/.test(value);
}

function account(username, host) {
  if (!USER.test(username) || !exactHost(host)) throw new Error("production account host is invalid");
  return `'${username}'@'${host}'`;
}

function candidateUsername(role) {
  const value = `spx_prod_${role.replaceAll("-", "_")}`;
  if (!USER.test(value)) throw new Error("production candidate username is invalid");
  return value;
}

function maximumConnections(role, grantContract) {
  if (role === "gate6-monitor") {
    return grantContract?.accountResourceLimits?.[role]?.maxUserConnections;
  }
  return role === "migrator" ? 2 : 8;
}

function assertGrantRole(contract, role) {
  const value = contract?.roles?.[role];
  if (
    !value
    || typeof value !== "object"
    || value.runtimeDdlFree !== true
    || !Array.isArray(value.schemaPrivileges)
    || !value.tables
    || typeof value.tables !== "object"
    || !value.columns
    || typeof value.columns !== "object"
  ) throw new Error(`production grant contract is invalid for ${role}`);
  return value;
}

export function buildProductionPrincipalPlan(input) {
  if (
    input?.descriptor?.environment !== "production"
    || input.descriptor?.database?.name !== "SPX"
    || !HASH.test(input?.targetDescriptorSha256 ?? "")
    || !USER.test(input?.legacyUsername ?? "")
    || !HASH.test(input?.legacyPasswordSha256 ?? "")
  ) throw new Error("production principal bootstrap input is invalid");
  const hosts = input.descriptor.database.accountHosts;
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) {
    throw new Error("production database account hosts are invalid");
  }
  const actualRoles = Object.keys(hosts);
  if (
    actualRoles.length !== PRODUCTION_BOOTSTRAP_DB_ROLES.length
    || actualRoles.some((role) => !PRODUCTION_BOOTSTRAP_DB_ROLES.includes(role))
  ) throw new Error("production database account role set is invalid");

  const principals = {};
  for (const role of PRODUCTION_BOOTSTRAP_DB_ROLES) {
    if (!exactHost(hosts[role])) throw new Error(`production account host is invalid for ${role}`);
    assertGrantRole(input.grantContract, role);
    const maxUserConnections = maximumConnections(role, input.grantContract);
    if (!Number.isSafeInteger(maxUserConnections) || maxUserConnections < 1 || maxUserConnections > 64) {
      throw new Error(`production account resource limit is invalid for ${role}`);
    }
    principals[role] = Object.freeze({
      role,
      accountHost: hosts[role],
      candidateUsername: candidateUsername(role),
      legacyUsername: input.legacyUsername,
      legacyPasswordSha256: input.legacyPasswordSha256,
      maxUserConnections,
      grant: assertGrantRole(input.grantContract, role),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    environment: "production",
    database: "SPX",
    targetDescriptorSha256: input.targetDescriptorSha256,
    roles: PRODUCTION_BOOTSTRAP_DB_ROLES,
    principals: Object.freeze(principals),
  });
}

function assertIdentifier(value, label) {
  if (!IDENTIFIER.test(value ?? "")) throw new Error(`${label} is invalid`);
}

function assertPrivileges(values, label) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || new Set(values).size !== values.length
    || values.some((value) => !PRIVILEGE.test(value))
  ) throw new Error(`${label} is invalid`);
}

export function buildProductionPrincipalStatements(plan, role, password) {
  if (!plan?.roles?.includes(role) || !plan.principals?.[role]) {
    throw new Error("production principal role is invalid");
  }
  if (!PASSWORD.test(password ?? "")) throw new Error("production principal password is invalid");
  const principal = plan.principals[role];
  const target = account(principal.candidateUsername, principal.accountHost);
  const statements = [
    {
      sql: `CREATE USER IF NOT EXISTS ${target} IDENTIFIED BY ? REQUIRE SSL WITH MAX_USER_CONNECTIONS ${principal.maxUserConnections}`,
      parameters: [password],
    },
    {
      sql: `ALTER USER ${target} IDENTIFIED BY ? REQUIRE SSL WITH MAX_USER_CONNECTIONS ${principal.maxUserConnections}`,
      parameters: [password],
    },
    { sql: `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${target}`, parameters: [] },
  ];
  const grant = principal.grant;
  if (grant.schemaPrivileges.length > 0) {
    assertPrivileges(grant.schemaPrivileges, "production schema privileges");
    statements.push({
      sql: `GRANT ${grant.schemaPrivileges.join(", ")} ON \`SPX\`.* TO ${target}`,
      parameters: [],
    });
  }
  for (const [table, privileges] of Object.entries(grant.tables)) {
    assertIdentifier(table, "production grant table");
    assertPrivileges(privileges, "production table privileges");
    statements.push({
      sql: `GRANT ${privileges.join(", ")} ON \`SPX\`.\`${table}\` TO ${target}`,
      parameters: [],
    });
  }
  for (const [table, operations] of Object.entries(grant.columns)) {
    assertIdentifier(table, "production column grant table");
    for (const [privilege, columns] of Object.entries(operations)) {
      if (!PRIVILEGE.test(privilege)) throw new Error("production column privilege is invalid");
      if (!Array.isArray(columns) || columns.length === 0 || new Set(columns).size !== columns.length) {
        throw new Error("production column list is invalid");
      }
      for (const column of columns) assertIdentifier(column, "production grant column");
      statements.push({
        sql: `GRANT ${privilege} (${columns.map((column) => `\`${column}\``).join(", ")}) ON \`SPX\`.\`${table}\` TO ${target}`,
        parameters: [],
      });
    }
  }
  return Object.freeze(statements.map((entry) => Object.freeze({
    sql: entry.sql,
    parameters: Object.freeze([...entry.parameters]),
  })));
}

function proof(value, label) {
  if (!HASH.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}

export async function provisionProductionPrincipals(input) {
  if (
    !input?.plan
    || typeof input.passwordForRole !== "function"
    || !input.adapter
    || typeof input.adapter.apply !== "function"
    || typeof input.adapter.writeCredential !== "function"
    || typeof input.adapter.revoke !== "function"
    || typeof input.adapter.removeCredential !== "function"
  ) throw new Error("production principal bootstrap adapter is incomplete");
  const completed = [];
  const evidence = [];
  let appliedRole = null;
  try {
    for (const role of input.plan.roles) {
      const password = input.passwordForRole(role);
      const statements = buildProductionPrincipalStatements(input.plan, role, password);
      const principal = input.plan.principals[role];
      appliedRole = role;
      const result = await input.adapter.apply({ role, principal, statements });
      const binding = Object.freeze({
        schemaVersion: 1,
        role,
        targetDescriptorSha256: input.plan.targetDescriptorSha256,
        accountHost: principal.accountHost,
        candidateUsername: principal.candidateUsername,
        legacyUsername: principal.legacyUsername,
        candidatePasswordSha256: sha256(password),
        legacyPasswordSha256: principal.legacyPasswordSha256,
        positiveGrantProofSha256: proof(result?.positiveGrantProofSha256, "positive grant proof"),
        forbiddenGrantProofSha256: proof(result?.forbiddenGrantProofSha256, "forbidden grant proof"),
      });
      await input.adapter.writeCredential({ role, password, binding });
      completed.push(role);
      evidence.push(binding);
      appliedRole = null;
    }
    return Object.freeze(evidence);
  } catch (error) {
    const rollbackRoles = [...completed];
    if (appliedRole !== null) rollbackRoles.push(appliedRole);
    for (const role of rollbackRoles.reverse()) {
      try { await input.adapter.removeCredential({ role }); } catch { /* retained for operator recovery */ }
      try { await input.adapter.revoke({ role, principal: input.plan.principals[role] }); } catch { /* fail closed */ }
    }
    throw error;
  }
}
