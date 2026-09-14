#!/usr/bin/env node

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFileBackedSecret } from "./lib/file-backed-secret.mjs";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";
import { readStableRegularFile } from "./lib/safe-file.mjs";

const DEFAULT_CONTRACT_PATH = resolve(process.cwd(), "deploy/db-grants.json");
const MAX_CONTRACT_BYTES = 256 * 1024;
const ROLE_NAMES = Object.freeze([
  "auto-accept-ifn-phase3",
  "auto-accept-ptwl-phase3",
  "gate6-control",
  "gate6-monitor",
  "line-service",
  "migrator",
  "notification-service",
  "observer",
  "phase3-control",
  "phase3-observer",
  "poller-ifn-phase3",
  "poller-ptwl-phase3",
  "realtime-service",
  "web-api",
  "worker-ifn-split",
  "worker-ptwl-split",
]);
const ROLE_METADATA = Object.freeze({
  "auto-accept-ifn-phase3": ["auto-accept-ifn-phase3", "SPX_DB_USERNAME_AUTO_ACCEPT_IFN_PHASE3", "compose"],
  "auto-accept-ptwl-phase3": ["auto-accept-ptwl-phase3", "SPX_DB_USERNAME_AUTO_ACCEPT_PTWL_PHASE3", "compose"],
  "gate6-control": ["gate6-control", "SPX_DB_USERNAME_GATE6_CONTROL", "compose"],
  "gate6-monitor": ["gate6-monitor-probe", "SPX_DB_USERNAME_GATE6_MONITOR", "compose"],
  "line-service": ["line-service", "SPX_DB_USERNAME_LINE_SERVICE", "compose"],
  migrator: ["migrator", "SPX_DB_USERNAME_MIGRATOR", "compose"],
  "notification-service": ["notification-service", "SPX_DB_USERNAME_NOTIFICATION_SERVICE", "compose"],
  observer: [null, "SPX_DB_USERNAME_GATE6_OBSERVER", "observer"],
  "phase3-control": [null, "SPX_DB_USERNAME_PHASE3_CONTROL", "controller"],
  "phase3-observer": [null, "SPX_DB_USERNAME_PHASE3_OBSERVER", "observer"],
  "poller-ifn-phase3": ["poller-ifn-phase3", "SPX_DB_USERNAME_POLLER_IFN_PHASE3", "compose"],
  "poller-ptwl-phase3": ["poller-ptwl-phase3", "SPX_DB_USERNAME_POLLER_PTWL_PHASE3", "compose"],
  "realtime-service": ["realtime-service", "SPX_DB_USERNAME_REALTIME_SERVICE", "compose"],
  "web-api": ["web-api", "SPX_DB_USERNAME_WEB_API", "compose"],
  "worker-ifn-split": ["worker-ifn-split", "SPX_DB_USERNAME_WORKER_IFN_SPLIT", "compose"],
  "worker-ptwl-split": ["worker-ptwl-split", "SPX_DB_USERNAME_WORKER_PTWL_SPLIT", "compose"],
});
const PRIVILEGE_ORDER = Object.freeze([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "ALTER",
  "INDEX",
  "DROP",
]);
const KNOWN_PRIVILEGES = new Set(PRIVILEGE_ORDER);
const DDL_PRIVILEGES = new Set(["CREATE", "ALTER", "INDEX", "DROP"]);
const REPLAY_ROLES = new Set([
  "line-service",
  "notification-service",
  "realtime-service",
  "web-api",
]);
const EXACT_REPLAY_PRIVILEGES = Object.freeze(["SELECT", "INSERT", "DELETE"]);
const MIGRATION_HISTORY_EXEMPT_ROLES = new Set(["gate6-control", "gate6-monitor", "observer"]);
const ACCOUNT_HOST_INPUT = Object.freeze({
  cliOption: "--expected-account-host",
  fileEnvironment: "DB_EXPECTED_ACCOUNT_HOST_FILE",
});
const FAILURE_ORDER = Object.freeze([
  "contract_invalid",
  "role_invalid",
  "runtime_ddl_dependency_unresolved",
  "database_config_invalid",
  "account_host_contract_invalid",
  "account_resource_limit_mismatch",
  "connection_failed",
  "grant_query_failed",
  "evidence_invalid",
  "principal_mismatch",
  "broad_account_host_present",
  "account_host_mismatch",
  "database_mismatch",
  "mysql_role_enabled",
  "mysql_role_assignment_present",
  "grant_option_present",
  "all_privileges_present",
  "global_privilege_present",
  "cross_schema_privilege_present",
  "column_privilege_present",
  "routine_privilege_present",
  "runtime_ddl_privilege_present",
  "required_privilege_missing",
  "excess_privilege_present",
  "internal_request_replays_privilege_mismatch",
  "connection_close_failed",
  "internal_error",
]);
const FAILURE_RANK = new Map(FAILURE_ORDER.map((code, index) => [code, index]));

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype,
  );
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("invalid number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  throw new Error("invalid JSON value");
}

export function canonicalGrantContractJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function validPrivilegeList(value, { allowDdl }) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) return false;
  let previous = -1;
  for (const privilege of value) {
    const index = PRIVILEGE_ORDER.indexOf(privilege);
    if (index < 0 || index <= previous || (!allowDdl && DDL_PRIVILEGES.has(privilege))) {
      return false;
    }
    previous = index;
  }
  return true;
}

function validateGrantContract(value) {
  if (
    !exactKeys(value, ["accountHostInput", "accountResourceLimits", "roles", "schemaVersion"])
    || value.schemaVersion !== 1
    || !exactKeys(value.accountHostInput, ["cliOption", "fileEnvironment"])
    || value.accountHostInput.cliOption !== ACCOUNT_HOST_INPUT.cliOption
    || value.accountHostInput.fileEnvironment !== ACCOUNT_HOST_INPUT.fileEnvironment
    || !isPlainObject(value.accountResourceLimits)
    || !exactKeys(value.accountResourceLimits, ["gate6-monitor"])
    || !exactKeys(value.accountResourceLimits["gate6-monitor"], ["maxUserConnections"])
    || value.accountResourceLimits["gate6-monitor"].maxUserConnections !== 1
  ) {
    throw new Error("invalid contract envelope");
  }
  if (!isPlainObject(value.roles) || Object.keys(value.roles).join("\0") !== ROLE_NAMES.join("\0")) {
    throw new Error("invalid contract roles");
  }

  for (const roleName of ROLE_NAMES) {
    const role = value.roles[roleName];
    if (!exactKeys(role, [
      "columns",
      "composePrincipalEnv",
      "composeService",
      "principalType",
      "runtimeDdlFree",
      "schemaPrivileges",
      "tables",
    ])) {
      throw new Error("invalid role contract");
    }
    const [service, principalEnv, principalType] = ROLE_METADATA[roleName];
    if (
      role.composeService !== service
      || role.composePrincipalEnv !== principalEnv
      || role.principalType !== principalType
      || typeof role.runtimeDdlFree !== "boolean"
      || !validPrivilegeList(role.schemaPrivileges, { allowDdl: roleName === "migrator" })
      || !isPlainObject(role.tables)
      || !isPlainObject(role.columns)
    ) {
      throw new Error("invalid role metadata");
    }
    if (roleName !== "migrator" && role.schemaPrivileges.length !== 0) {
      throw new Error("runtime schema privileges are forbidden");
    }
    if (
      roleName === "migrator"
      && (Object.keys(role.tables).length !== 0 || Object.keys(role.columns).length !== 0)
    ) {
      throw new Error("migrator must use explicit schema privileges");
    }

    const tableNames = Object.keys(role.tables);
    if (tableNames.join("\0") !== [...tableNames].sort().join("\0")) {
      throw new Error("table grants must be sorted");
    }
    for (const tableName of tableNames) {
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(tableName)
        || role.tables[tableName].length === 0
        || !validPrivilegeList(role.tables[tableName], { allowDdl: false })
      ) {
        throw new Error("invalid table grant");
      }
    }

    const columnTableNames = Object.keys(role.columns);
    if (columnTableNames.join("\0") !== [...columnTableNames].sort().join("\0")) {
      throw new Error("column grants must be sorted");
    }
    for (const tableName of columnTableNames) {
      const grants = role.columns[tableName];
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(tableName) || !isPlainObject(grants)) {
        throw new Error("invalid column grant table");
      }
      const privileges = Object.keys(grants);
      if (privileges.length === 0 || privileges.join("\0") !== [...privileges].sort().join("\0")) {
        throw new Error("invalid column grant privileges");
      }
      for (const privilege of privileges) {
        const columns = grants[privilege];
        if (
          !KNOWN_PRIVILEGES.has(privilege)
          || DDL_PRIVILEGES.has(privilege)
          || privilege === "DELETE"
          || role.tables[tableName]?.includes(privilege)
          || !Array.isArray(columns)
          || columns.length === 0
          || new Set(columns).size !== columns.length
          || columns.join("\0") !== [...columns].sort().join("\0")
          || !columns.every((column) => /^[a-z][a-z0-9_]{0,63}$/.test(column))
        ) {
          throw new Error("invalid column grant");
        }
      }
    }

    if (roleName !== "migrator") {
      if (
        !MIGRATION_HISTORY_EXEMPT_ROLES.has(roleName)
        && JSON.stringify(role.tables.schema_migrations) !== JSON.stringify(["SELECT"])
      ) {
        throw new Error("runtime migration history grant is required");
      }
      if (MIGRATION_HISTORY_EXEMPT_ROLES.has(roleName) && role.tables.schema_migrations !== undefined) {
        throw new Error("observer/control migration history grant is excessive");
      }
      const replayPrivileges = role.tables.internal_request_replays;
      if (REPLAY_ROLES.has(roleName)) {
        if (JSON.stringify(replayPrivileges) !== JSON.stringify(EXACT_REPLAY_PRIVILEGES)) {
          throw new Error("invalid replay grant");
        }
      } else if (replayPrivileges !== undefined) {
        throw new Error("worker replay grant is excessive");
      }
    }
  }
  return value;
}

export function loadGrantContract(path = DEFAULT_CONTRACT_PATH) {
  let bytes;
  let value;
  try {
    bytes = readStableRegularFile(resolve(path), "database grant contract", {
      maximumBytes: MAX_CONTRACT_BYTES,
    });
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("database grant contract is unavailable or invalid");
  }
  const contract = validateGrantContract(value);
  if (!bytes.equals(Buffer.from(canonicalGrantContractJson(contract), "utf8"))) {
    throw new Error("database grant contract is not canonical JSON");
  }
  return contract;
}

function orderedResult(failureCodes) {
  const unique = [...new Set(failureCodes)];
  unique.sort((left, right) => {
    const leftRank = FAILURE_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = FAILURE_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
  return { ok: unique.length === 0, failureCodes: unique };
}

export function evaluateContractRoleReadiness(contract, roleName) {
  if (!isPlainObject(contract) || !isPlainObject(contract.roles) || !contract.roles[roleName]) {
    return orderedResult(["role_invalid"]);
  }
  return orderedResult(contract.roles[roleName].runtimeDdlFree
    ? []
    : ["runtime_ddl_dependency_unresolved"]);
}

function evidenceRows(value) {
  return Array.isArray(value) && value.every(isRecord) ? value : null;
}

function normalizedPrivilege(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function addGrantableFailure(row, failures) {
  if (String(row.isGrantable ?? "").toUpperCase() === "YES") {
    failures.add("grant_option_present");
  }
}

function validExpectedAccountHost(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && value === value.trim()
    && value !== "%"
    && /^[A-Za-z0-9_.:%/-]+$/.test(value);
}

function splitAccount(account) {
  if (typeof account !== "string") return null;
  const separator = account.lastIndexOf("@");
  if (separator <= 0 || separator === account.length - 1) return null;
  const username = account.slice(0, separator);
  const host = account.slice(separator + 1);
  if (!/^[A-Za-z0-9_.$-]+$/.test(username) || !/^[A-Za-z0-9_.:%/-]+$/.test(host)) return null;
  return { username, host };
}

function expectedGrantKeys(role) {
  const keys = new Set();
  for (const [tableName, privileges] of Object.entries(role.tables)) {
    for (const privilege of privileges) keys.add(`${tableName}\0${privilege}`);
  }
  return keys;
}

function expectedColumnGrantKeys(role) {
  const keys = new Set();
  for (const [tableName, grants] of Object.entries(role.columns)) {
    for (const [privilege, columns] of Object.entries(grants)) {
      for (const column of columns) keys.add(`${tableName}\0${column}\0${privilege}`);
    }
  }
  return keys;
}

export function evaluateGrantEvidence(
  contract,
  roleName,
  expectedUsername,
  expectedAccountHost,
  evidence,
) {
  const failures = new Set();
  const role = isPlainObject(contract?.roles) ? contract.roles[roleName] : null;
  const account = splitAccount(evidence?.account);
  const userRows = evidenceRows(evidence?.userPrivileges);
  const schemaRows = evidenceRows(evidence?.schemaPrivileges);
  const tableRows = evidenceRows(evidence?.tablePrivileges);
  const columnRows = evidenceRows(evidence?.columnPrivileges);
  const routineRows = evidenceRows(evidence?.routinePrivileges);
  if (
    !role
    || !account
    || typeof expectedUsername !== "string"
    || expectedUsername.length === 0
    || typeof evidence?.database !== "string"
    || evidence.database.length === 0
    || typeof evidence?.currentRole !== "string"
    || !userRows
    || !schemaRows
    || !tableRows
    || !columnRows
    || !routineRows
    || !Array.isArray(evidence?.showGrants)
    || !evidence.showGrants.every((grant) => typeof grant === "string")
  ) {
    return orderedResult(["evidence_invalid"]);
  }
  if (!validExpectedAccountHost(expectedAccountHost)) {
    return orderedResult(["account_host_contract_invalid"]);
  }
  if (account.username !== expectedUsername) failures.add("principal_mismatch");
  if (account.host === "%") failures.add("broad_account_host_present");
  if (account.host !== expectedAccountHost) failures.add("account_host_mismatch");
  if (evidence.currentRole.trim().toUpperCase() !== "NONE") failures.add("mysql_role_enabled");

  for (const row of userRows) {
    const privilege = normalizedPrivilege(row.privilegeType);
    addGrantableFailure(row, failures);
    if (privilege && privilege !== "USAGE") failures.add("global_privilege_present");
  }

  const expectedSchema = new Set(role.schemaPrivileges);
  const actualSchema = new Set();
  for (const row of schemaRows) {
    const schema = typeof row.tableSchema === "string" ? row.tableSchema : "";
    const privilege = normalizedPrivilege(row.privilegeType);
    addGrantableFailure(row, failures);
    if (!schema || !privilege || !KNOWN_PRIVILEGES.has(privilege)) {
      failures.add("evidence_invalid");
      continue;
    }
    if (schema !== evidence.database) {
      failures.add("cross_schema_privilege_present");
      continue;
    }
    actualSchema.add(privilege);
    if (!expectedSchema.has(privilege)) failures.add("excess_privilege_present");
    if (roleName !== "migrator" && DDL_PRIVILEGES.has(privilege)) {
      failures.add("runtime_ddl_privilege_present");
    }
  }
  for (const privilege of expectedSchema) {
    if (!actualSchema.has(privilege)) failures.add("required_privilege_missing");
  }

  const expectedTables = expectedGrantKeys(role);
  const actualTables = new Set();
  const actualReplay = new Set();
  for (const row of tableRows) {
    const schema = typeof row.tableSchema === "string" ? row.tableSchema : "";
    const table = typeof row.tableName === "string" ? row.tableName : "";
    const privilege = normalizedPrivilege(row.privilegeType);
    addGrantableFailure(row, failures);
    if (!schema || !/^[a-z][a-z0-9_]{0,63}$/.test(table) || !privilege) {
      failures.add("evidence_invalid");
      continue;
    }
    if (schema !== evidence.database) {
      failures.add("cross_schema_privilege_present");
      continue;
    }
    const key = `${table}\0${privilege}`;
    actualTables.add(key);
    if (table === "internal_request_replays") actualReplay.add(privilege);
    if (!expectedTables.has(key)) failures.add("excess_privilege_present");
    if (roleName !== "migrator" && DDL_PRIVILEGES.has(privilege)) {
      failures.add("runtime_ddl_privilege_present");
    }
  }
  for (const key of expectedTables) {
    if (!actualTables.has(key)) failures.add("required_privilege_missing");
  }

  const replayExpected = role.tables.internal_request_replays ?? [];
  const actualReplayList = PRIVILEGE_ORDER.filter((privilege) => actualReplay.has(privilege));
  if (JSON.stringify(actualReplayList) !== JSON.stringify(replayExpected)) {
    if (replayExpected.length > 0 || actualReplayList.length > 0) {
      failures.add("internal_request_replays_privilege_mismatch");
    }
  }

  const expectedColumns = expectedColumnGrantKeys(role);
  const actualColumns = new Set();
  for (const row of columnRows) {
    const schema = typeof row.tableSchema === "string" ? row.tableSchema : "";
    const table = typeof row.tableName === "string" ? row.tableName : "";
    const column = typeof row.columnName === "string" ? row.columnName : "";
    const privilege = normalizedPrivilege(row.privilegeType);
    addGrantableFailure(row, failures);
    if (
      !schema
      || !/^[a-z][a-z0-9_]{0,63}$/.test(table)
      || !/^[a-z][a-z0-9_]{0,63}$/.test(column)
      || !privilege
      || !KNOWN_PRIVILEGES.has(privilege)
    ) {
      failures.add("evidence_invalid");
      continue;
    }
    if (schema !== evidence.database) {
      failures.add("cross_schema_privilege_present");
      continue;
    }
    const key = `${table}\0${column}\0${privilege}`;
    actualColumns.add(key);
    if (!expectedColumns.has(key)) failures.add("excess_privilege_present");
    if (DDL_PRIVILEGES.has(privilege)) failures.add("runtime_ddl_privilege_present");
  }
  for (const key of expectedColumns) {
    if (!actualColumns.has(key)) failures.add("required_privilege_missing");
  }
  if (routineRows.length > 0) {
    failures.add("routine_privilege_present");
    failures.add("excess_privilege_present");
  }
  for (const row of routineRows) addGrantableFailure(row, failures);

  for (const statement of evidence.showGrants) {
    const normalized = statement.trim();
    if (/\bWITH\s+GRANT\s+OPTION\b/i.test(normalized)) failures.add("grant_option_present");
    if (/^GRANT\s+ALL(?:\s+PRIVILEGES)?\b/i.test(normalized)) {
      failures.add("all_privileges_present");
      failures.add("excess_privilege_present");
    }
    if (/^GRANT\s+PROXY\b/i.test(normalized)) failures.add("excess_privilege_present");
    if (/^SET\s+DEFAULT\s+ROLE\b/i.test(normalized)) failures.add("mysql_role_assignment_present");
    if (/^GRANT\s+.+\s+TO\s+.+$/i.test(normalized) && !/\sON\s/i.test(normalized)) {
      failures.add("mysql_role_assignment_present");
    }
    if (
      /^GRANT\s+(?!USAGE\b)/i.test(normalized)
      && /\sON\s+(?:`\*`|\*)\.(?:`\*`|\*)\s/i.test(normalized)
    ) {
      failures.add("global_privilege_present");
    }
    if (/\sON\s+(?:PROCEDURE|FUNCTION)\s/i.test(normalized)) {
      failures.add("routine_privilege_present");
      failures.add("excess_privilege_present");
    }
  }
  const expectedLimit = contract.accountResourceLimits?.[roleName]?.maxUserConnections;
  if (expectedLimit !== undefined) {
    const actualLimits = evidence.showGrants.flatMap((statement) =>
      [...statement.matchAll(/\bMAX_USER_CONNECTIONS\s+(\d+)\b/gi)].map((match) => Number(match[1])));
    if (actualLimits.length !== 1 || actualLimits[0] !== expectedLimit) {
      failures.add("account_resource_limit_mismatch");
    }
  }
  return orderedResult([...failures]);
}

function informationSchemaGrantee(account) {
  const parsed = splitAccount(account);
  if (!parsed) throw new Error("invalid current account");
  return `'${parsed.username}'@'${parsed.host}'`;
}

async function queryRows(connection, sql, values = []) {
  const [rows] = await connection.query(sql, values);
  if (!Array.isArray(rows)) throw new Error("unexpected grant query result");
  return rows;
}

export async function collectGrantEvidence(connection) {
  if (!connection || typeof connection.query !== "function") {
    throw new Error("invalid connection");
  }
  const identityRows = await queryRows(
    connection,
    "SELECT CURRENT_USER() AS account, CURRENT_ROLE() AS currentRole, DATABASE() AS databaseName",
  );
  const identity = identityRows[0];
  if (!isRecord(identity)) throw new Error("identity query failed");
  const account = String(identity.account ?? "");
  const grantee = informationSchemaGrantee(account);
  const userPrivileges = await queryRows(connection, `
    SELECT PRIVILEGE_TYPE AS privilegeType, IS_GRANTABLE AS isGrantable
    FROM information_schema.USER_PRIVILEGES
    WHERE GRANTEE = ?
  `, [grantee]);
  const schemaPrivileges = await queryRows(connection, `
    SELECT TABLE_SCHEMA AS tableSchema, PRIVILEGE_TYPE AS privilegeType, IS_GRANTABLE AS isGrantable
    FROM information_schema.SCHEMA_PRIVILEGES
    WHERE GRANTEE = ?
  `, [grantee]);
  const tablePrivileges = await queryRows(connection, `
    SELECT TABLE_SCHEMA AS tableSchema, TABLE_NAME AS tableName,
      PRIVILEGE_TYPE AS privilegeType, IS_GRANTABLE AS isGrantable
    FROM information_schema.TABLE_PRIVILEGES
    WHERE GRANTEE = ?
  `, [grantee]);
  const columnPrivileges = await queryRows(connection, `
    SELECT TABLE_SCHEMA AS tableSchema, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
      PRIVILEGE_TYPE AS privilegeType, IS_GRANTABLE AS isGrantable
    FROM information_schema.COLUMN_PRIVILEGES
    WHERE GRANTEE = ?
  `, [grantee]);
  const showGrantRows = await queryRows(connection, "SHOW GRANTS FOR CURRENT_USER()");
  const showGrants = showGrantRows.map((row) => {
    if (!isRecord(row)) throw new Error("invalid SHOW GRANTS row");
    const value = Object.values(row)[0];
    if (typeof value !== "string") throw new Error("invalid SHOW GRANTS value");
    return value;
  });
  return {
    account,
    currentRole: String(identity.currentRole ?? ""),
    database: String(identity.databaseName ?? ""),
    userPrivileges,
    schemaPrivileges,
    tablePrivileges,
    columnPrivileges,
    routinePrivileges: [],
    showGrants,
  };
}

export async function runGrantCheck(
  connection,
  contract,
  roleName,
  expectedUsername,
  expectedDatabase,
  expectedAccountHost,
) {
  const evidence = await collectGrantEvidence(connection);
  const checked = evaluateGrantEvidence(
    contract,
    roleName,
    expectedUsername,
    expectedAccountHost,
    evidence,
  );
  return orderedResult([
    ...checked.failureCodes,
    ...(evidence.database === expectedDatabase ? [] : ["database_mismatch"]),
  ]);
}

export function loadMysqlPromiseClient(moduleRoot = process.cwd()) {
  const require = createRequire(resolve(moduleRoot, "package.json"));
  return require("mysql2/promise");
}

function parseArguments(argv) {
  let role = "";
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedAccountHost;
  let dryRun = false;
  let help = false;
  const seen = new Set();
  for (const token of argv) {
    if (token === "--dry-run" || token === "--help") {
      if (seen.has(token)) return null;
      seen.add(token);
      if (token === "--dry-run") dryRun = true;
      else help = true;
      continue;
    }
    const match = /^--(role|contract|expected-account-host)=(.+)$/.exec(token);
    if (!match || seen.has(match[1])) return null;
    seen.add(match[1]);
    if (match[1] === "role") role = match[2];
    else if (match[1] === "contract") contractPath = match[2];
    else expectedAccountHost = match[2];
  }
  if (help) return argv.length === 1 ? { help: true } : null;
  if (!ROLE_NAMES.includes(role)) return { invalidRole: true, dryRun };
  return { role, contractPath, expectedAccountHost, dryRun };
}

function output(mode, role, failureCodes) {
  const checked = orderedResult(failureCodes);
  process.stdout.write(`${JSON.stringify({
    ok: checked.ok,
    mode,
    role,
    failureCodes: checked.failureCodes,
  })}\n`);
}

function liveConfigFromEnv(env) {
  if (
    !env
    || typeof env.DB_PASSWORD_FILE !== "string"
    || env.DB_PASSWORD_FILE.trim() === ""
    || String(env.DB_SSL_MODE ?? "").trim() !== "verify-identity"
    || typeof env.DB_SSL_CA_FILE !== "string"
    || env.DB_SSL_CA_FILE.trim() === ""
  ) {
    return null;
  }
  const config = mysqlScriptConnectionConfigFromEnv(env);
  return config.missing.length === 0 ? config.value : null;
}

function expectedAccountHostFromInputs(contract, args, env) {
  const fileEnvironmentName = contract.accountHostInput.fileEnvironment;
  const environmentName = fileEnvironmentName.slice(0, -"_FILE".length);
  const directConfigured = typeof env?.[environmentName] === "string"
    && env[environmentName].trim() !== "";
  const fileConfigured = typeof env?.[fileEnvironmentName] === "string"
    && env[fileEnvironmentName].trim() !== "";
  if (directConfigured || (args.expectedAccountHost !== undefined && fileConfigured)) return null;
  let value = args.expectedAccountHost;
  if (value === undefined) {
    if (!fileConfigured) return null;
    try {
      value = resolveFileBackedSecret(environmentName, env);
    } catch {
      return null;
    }
  }
  return validExpectedAccountHost(value) ? value : null;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args?.help) {
    process.stdout.write(
      "Usage: node scripts/db-grants-check.mjs --role=<contract-role> [--dry-run] [--contract=<path>] [--expected-account-host=<pattern>]\n",
    );
    return;
  }
  if (!args || args.invalidRole) {
    output(args?.dryRun ? "dry-run" : "live", "invalid", ["role_invalid"]);
    process.exitCode = 1;
    return;
  }

  let contract;
  try {
    contract = loadGrantContract(args.contractPath);
  } catch {
    output(args.dryRun ? "dry-run" : "live", args.role, ["contract_invalid"]);
    process.exitCode = 1;
    return;
  }
  const readiness = evaluateContractRoleReadiness(contract, args.role);
  if (!readiness.ok) {
    output("dry-run", args.role, readiness.failureCodes);
    process.exitCode = 1;
    return;
  }
  if (args.dryRun) {
    if (args.expectedAccountHost !== undefined && !validExpectedAccountHost(args.expectedAccountHost)) {
      output("dry-run", args.role, ["account_host_contract_invalid"]);
      process.exitCode = 1;
      return;
    }
    output("dry-run", args.role, []);
    return;
  }

  const expectedAccountHost = expectedAccountHostFromInputs(
    contract,
    args,
    process.env,
  );
  if (!expectedAccountHost) {
    output("live", args.role, ["account_host_contract_invalid"]);
    process.exitCode = 1;
    return;
  }

  const config = liveConfigFromEnv(process.env);
  if (!config) {
    output("live", args.role, ["database_config_invalid"]);
    process.exitCode = 1;
    return;
  }

  let connection;
  let failureCodes = [];
  try {
    const mysql = loadMysqlPromiseClient();
    connection = await mysql.createConnection(config);
  } catch {
    output("live", args.role, ["connection_failed"]);
    process.exitCode = 1;
    return;
  }
  try {
    const checked = await runGrantCheck(
      connection,
      contract,
      args.role,
      config.user,
      config.database,
      expectedAccountHost,
    );
    failureCodes = checked.failureCodes;
  } catch {
    failureCodes = ["grant_query_failed"];
  } finally {
    try {
      await connection.end();
    } catch {
      failureCodes.push("connection_close_failed");
    }
  }
  const checked = orderedResult(failureCodes);
  output("live", args.role, checked.failureCodes);
  if (!checked.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch(() => {
    const parsed = parseArguments(process.argv.slice(2));
    output(parsed?.dryRun ? "dry-run" : "live", parsed?.role ?? "invalid", ["internal_error"]);
    process.exitCode = 1;
  });
}
