#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";
import { readStableRegularFile } from "./lib/safe-file.mjs";
import {
  commitProductionInstallHostLock,
  readProductionMutationLock,
  readProductionInstallHostLockCommit,
  reconcileProductionInstallBootstrapSlot,
  reconcileProductionMutationGate6Handoff,
} from "./production-mutation-host-lock.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const HOST_MYSQL_CLIENT = "/usr/bin/mysql";
const HOST_GATE6_CONFIG_FILE = "/var/lib/spx-gate6/gate6-control-db.json";
const HOST_GATE6_PASSWORD_FILE = "/var/lib/spx-gate6/secrets/gate6-control-db-password";
const HOST_MYSQL_CA_FILE = "/var/lib/spx-gate6/config/db-ca.pem";
const HOST_GATE6_ROOT_DIRECTORY = "/var/lib/spx-gate6";
const HOST_GATE6_SECRET_DIRECTORY = "/var/lib/spx-gate6/secrets";
const HOST_GATE6_CONFIG_DIRECTORY = "/var/lib/spx-gate6/config";
const HOST_MYSQL_RUNTIME_DIRECTORY = "/run/spx-protected-install";
const MAX_GATE6_CONFIG_BYTES = 16 * 1024;
const MAX_GATE6_PASSWORD_BYTES = 1024;
const MAX_MYSQL_OUTPUT_BYTES = 64 * 1024;
const FIXED_PROTECTED_INSTALL_ROOT = "/var/lib/spx-protected-install";
const FIXED_PREPARED_FILE_NAMES = Object.freeze([
  "evidence-core.json",
  "prepared-commit.json",
  "protected-install-evidence.json",
  "protected-install-signature.json",
]);
const MAX_PREPARED_FILE_BYTES = 512 * 1024;
const GATE6_SLOT_QUERY = `SELECT JSON_OBJECT(
  'environment', environment,
  'owner_type', owner_type,
  'owner_id', owner_id,
  'operation_id', operation_id,
  'transfer_token_sha256', transfer_token_sha256,
  'state', state,
  'version', version,
  'uncompensated_work', uncompensated_work,
  'protected_install_evidence_sha256', protected_install_evidence_sha256,
  'release_sha', release_sha,
  'target_descriptor_sha256', target_descriptor_sha256,
  'operator_bundle_sha256', operator_bundle_sha256,
  'installed_migration_set_sha256', installed_migration_set_sha256,
  'installed_schema_version', installed_schema_version
) FROM gate6_environment_slots WHERE environment = BINARY 'production' LIMIT 2`;
const PREPARED_GATE6_SLOT_QUERY = `SELECT JSON_OBJECT(
  'environment', environment,
  'owner_type', owner_type,
  'owner_id', owner_id,
  'operation_id', operation_id,
  'transfer_token_sha256', transfer_token_sha256,
  'state', state,
  'version', version,
  'uncompensated_work', uncompensated_work,
  'protected_install_evidence_sha256', protected_install_evidence_sha256,
  'release_sha', release_sha,
  'target_descriptor_sha256', target_descriptor_sha256,
  'operator_bundle_sha256', operator_bundle_sha256,
  'installed_migration_set_sha256', installed_migration_set_sha256,
  'installed_schema_version', installed_schema_version,
  'heartbeat_at', CONCAT(DATE_FORMAT(heartbeat_at, '%Y-%m-%dT%H:%i:%s.'), LEFT(DATE_FORMAT(heartbeat_at, '%f'), 3), 'Z'),
  'expires_at', CONCAT(DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.'), LEFT(DATE_FORMAT(expires_at, '%f'), 3), 'Z')
) FROM gate6_environment_slots WHERE environment = BINARY 'production' LIMIT 2`;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} is invalid`);
  }
}

function pattern(value, expected, label) {
  if (typeof value !== "string" || !expected.test(value)) throw new Error(`${label} is invalid`);
}

function timestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

export function validateGate6CapabilityFileMetadata(metadata, kind) {
  const limits = {
    config: { maximumBytes: MAX_GATE6_CONFIG_BYTES, modes: [0o400] },
    password: { maximumBytes: MAX_GATE6_PASSWORD_BYTES, modes: [0o400] },
    ca: { maximumBytes: 1024 * 1024, modes: [0o400, 0o444] },
  };
  const policy = limits[kind];
  if (
    policy === undefined ||
    !isObject(metadata) ||
    metadata.isFile !== true ||
    metadata.isSymbolicLink !== false ||
    metadata.uid !== 0 ||
    !policy.modes.includes(metadata.mode & 0o777) ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    metadata.size > policy.maximumBytes
  )
    throw new Error("Gate 6 capability file metadata is invalid");
}

function validateCapabilityDirectory(path, allowedModes) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== 0 ||
    !allowedModes.includes(stat.mode & 0o777)
  )
    throw new Error("Gate 6 capability directory is invalid");
}

function secureFileMetadata(path) {
  const stat = lstatSync(path);
  return {
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    uid: stat.uid,
    mode: stat.mode,
    size: stat.size,
  };
}

export function parseGate6ControlDatabaseConfig(source, expectedTargetDescriptorSha256) {
  if (typeof source !== "string" || source.length < 1 || source.length > MAX_GATE6_CONFIG_BYTES) {
    throw new Error("Gate 6 control database config is invalid");
  }
  let values;
  try {
    values = JSON.parse(source);
  } catch {
    throw new Error("Gate 6 control database config is invalid");
  }
  exactKeys(
    values,
    [
      "caSha256",
      "database",
      "host",
      "passwordSha256",
      "port",
      "schemaVersion",
      "sslServername",
      "targetDescriptorSha256",
      "username",
    ],
    "Gate 6 control database config",
  );
  if (
    values.schemaVersion !== 1 ||
    values.database !== "SPX" ||
    !Number.isSafeInteger(values.port) ||
    values.port < 1 ||
    values.port > 65535 ||
    typeof values.host !== "string" ||
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
      values.host,
    ) ||
    values.sslServername !== values.host ||
    !/^[A-Za-z0-9_$-]{1,64}$/.test(values.username ?? "") ||
    !SHA256_PATTERN.test(values.targetDescriptorSha256 ?? "") ||
    values.targetDescriptorSha256 !== expectedTargetDescriptorSha256 ||
    !SHA256_PATTERN.test(values.passwordSha256 ?? "") ||
    !SHA256_PATTERN.test(values.caSha256 ?? "")
  )
    throw new Error("Gate 6 control database config is invalid");
  return Object.freeze({ ...values });
}

export function validateGate6ControlDatabasePassword(source) {
  if (typeof source !== "string" || !/^[A-Za-z0-9_-]{32,1024}$/.test(source)) {
    throw new Error("Gate 6 control database password is invalid");
  }
  return source;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("protected install prepared JSON is invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("protected install prepared JSON is invalid");
    seen.add(value);
    const source = `[${value.map((entry) => canonicalJsonValue(entry, seen)).join(",")}]`;
    seen.delete(value);
    return source;
  }
  if (!isObject(value) || seen.has(value)) {
    throw new Error("protected install prepared JSON is invalid");
  }
  seen.add(value);
  const source = `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(value[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return source;
}

export function renderGate6MysqlDefaults(capability, password) {
  const validatedPassword = validateGate6ControlDatabasePassword(password);
  return [
    "[client]",
    `host=${capability.host}`,
    `port=${capability.port}`,
    `user=${capability.username}`,
    `password=${validatedPassword}`,
    "database=SPX",
    "protocol=TCP",
    "ssl-mode=VERIFY_IDENTITY",
    `ssl-ca=${HOST_MYSQL_CA_FILE}`,
    "",
  ].join("\n");
}

function loadGate6MysqlCapability(expectedTargetDescriptorSha256) {
  pattern(expectedTargetDescriptorSha256, SHA256_PATTERN, "Gate 6 target descriptor hash");
  validateCapabilityDirectory(HOST_GATE6_ROOT_DIRECTORY, [0o700, 0o755]);
  validateCapabilityDirectory(HOST_GATE6_SECRET_DIRECTORY, [0o700]);
  validateCapabilityDirectory(HOST_GATE6_CONFIG_DIRECTORY, [0o700, 0o755]);
  validateGate6CapabilityFileMetadata(secureFileMetadata(HOST_GATE6_CONFIG_FILE), "config");
  validateGate6CapabilityFileMetadata(secureFileMetadata(HOST_GATE6_PASSWORD_FILE), "password");
  validateGate6CapabilityFileMetadata(secureFileMetadata(HOST_MYSQL_CA_FILE), "ca");
  const configBytes = readStableRegularFile(
    HOST_GATE6_CONFIG_FILE,
    "Gate 6 control database config",
    {
      maximumBytes: MAX_GATE6_CONFIG_BYTES,
    },
  );
  const capability = parseGate6ControlDatabaseConfig(
    configBytes.toString("utf8"),
    expectedTargetDescriptorSha256,
  );
  const passwordBytes = readStableRegularFile(
    HOST_GATE6_PASSWORD_FILE,
    "Gate 6 control database password",
    {
      maximumBytes: MAX_GATE6_PASSWORD_BYTES,
    },
  );
  if (sha256(passwordBytes) !== capability.passwordSha256) {
    throw new Error("Gate 6 control database password hash is invalid");
  }
  const password = validateGate6ControlDatabasePassword(passwordBytes.toString("utf8"));
  const caMetadata = secureFileMetadata(HOST_MYSQL_CA_FILE);
  validateGate6CapabilityFileMetadata(caMetadata, "ca");
  const caBytes = readStableRegularFile(HOST_MYSQL_CA_FILE, "Gate 6 MySQL TLS CA", {
    maximumBytes: 1024 * 1024,
  });
  if (
    sha256(caBytes) !== capability.caSha256 ||
    !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(caBytes.toString("utf8"))
  ) {
    throw new Error("Gate 6 MySQL TLS CA is invalid");
  }
  return Object.freeze({ capability, password });
}

export function parseGate6SlotQueryOutput(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_MYSQL_OUTPUT_BYTES) {
    throw new Error("Gate 6 slot query output is malformed");
  }
  const lines = source.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length === 0) return null;
  if (lines.length !== 1) throw new Error("Gate 6 slot query output is ambiguous");
  let row;
  try {
    row = JSON.parse(lines[0]);
  } catch {
    throw new Error("Gate 6 slot query output is malformed");
  }
  if (!isObject(row)) throw new Error("Gate 6 slot query output is malformed");
  const expected = [
    "environment",
    "installed_migration_set_sha256",
    "installed_schema_version",
    "operation_id",
    "operator_bundle_sha256",
    "owner_id",
    "owner_type",
    "protected_install_evidence_sha256",
    "release_sha",
    "state",
    "target_descriptor_sha256",
    "transfer_token_sha256",
    "uncompensated_work",
    "version",
  ];
  const keys = Object.keys(row).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Gate 6 slot query output is malformed");
  }
  row.version = Number(row.version);
  row.uncompensated_work = Number(row.uncompensated_work);
  row.installed_schema_version = Number(row.installed_schema_version);
  if (
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    ![0, 1].includes(row.uncompensated_work) ||
    !Number.isSafeInteger(row.installed_schema_version) ||
    row.installed_schema_version < 1
  )
    throw new Error("Gate 6 slot query output is malformed");
  return row;
}

function parsePreparedGate6SlotQueryOutput(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_MYSQL_OUTPUT_BYTES) {
    throw new Error("prepared Gate 6 slot query output is malformed");
  }
  const lines = source.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new Error("prepared Gate 6 slot query output is missing or ambiguous");
  }
  let row;
  try {
    row = JSON.parse(lines[0]);
  } catch {
    throw new Error("prepared Gate 6 slot query output is malformed");
  }
  exactKeys(
    row,
    [
      "environment",
      "owner_type",
      "owner_id",
      "operation_id",
      "transfer_token_sha256",
      "state",
      "version",
      "uncompensated_work",
      "protected_install_evidence_sha256",
      "release_sha",
      "target_descriptor_sha256",
      "operator_bundle_sha256",
      "installed_migration_set_sha256",
      "installed_schema_version",
      "heartbeat_at",
      "expires_at",
    ],
    "prepared Gate 6 slot query output",
  );
  row.version = Number(row.version);
  row.uncompensated_work = Number(row.uncompensated_work);
  row.installed_schema_version = Number(row.installed_schema_version);
  if (
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    ![0, 1].includes(row.uncompensated_work) ||
    !Number.isSafeInteger(row.installed_schema_version) ||
    row.installed_schema_version < 1
  ) {
    throw new Error("prepared Gate 6 slot query output is malformed");
  }
  timestamp(row.heartbeat_at, "prepared Gate 6 slot heartbeat");
  timestamp(row.expires_at, "prepared Gate 6 slot expiry");
  return row;
}

function executeGate6MysqlCommand({
  capability,
  password,
  query,
  parseOutput,
  runtimeDirectory = HOST_MYSQL_RUNTIME_DIRECTORY,
  nonce = randomBytes(16).toString("hex"),
  mysqlPath = HOST_MYSQL_CLIENT,
  spawnImpl = spawnSync,
  fsAdapter = {
    closeSync,
    fsyncSync,
    lstatSync,
    openSync,
    unlinkSync,
    writeSync,
  },
}) {
  if (
    runtimeDirectory !== HOST_MYSQL_RUNTIME_DIRECTORY ||
    mysqlPath !== HOST_MYSQL_CLIENT ||
    !/^[0-9a-f]{16,64}$/.test(nonce) ||
    typeof query !== "string" ||
    query.length < 1 ||
    query.length > 64 * 1024 ||
    typeof parseOutput !== "function"
  ) {
    throw new Error("Gate 6 MySQL capability path is invalid");
  }
  const runtimeStat = fsAdapter.lstatSync(runtimeDirectory);
  if (
    runtimeStat.isSymbolicLink() ||
    !runtimeStat.isDirectory() ||
    runtimeStat.uid !== 0 ||
    (runtimeStat.mode & 0o777) !== 0o700
  )
    throw new Error("Gate 6 MySQL runtime directory is invalid");
  const defaultsFile = `${runtimeDirectory}/gate6-control-${nonce}.cnf`;
  const defaultsBytes = Buffer.from(renderGate6MysqlDefaults(capability, password), "utf8");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor;
  let created = false;
  try {
    descriptor = fsAdapter.openSync(
      defaultsFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o400,
    );
    created = true;
    const written = fsAdapter.writeSync(descriptor, defaultsBytes);
    if (written !== defaultsBytes.length) throw new Error("Gate 6 MySQL option file write failed");
    fsAdapter.fsyncSync(descriptor);
    fsAdapter.closeSync(descriptor);
    descriptor = undefined;
    const result = spawnImpl(
      mysqlPath,
      [
        `--defaults-extra-file=${defaultsFile}`,
        "--protocol=TCP",
        `--host=${capability.host}`,
        `--port=${capability.port}`,
        `--user=${capability.username}`,
        "--ssl-mode=VERIFY_IDENTITY",
        `--ssl-ca=${HOST_MYSQL_CA_FILE}`,
        "--database=SPX",
        "--connect-timeout=5",
        "--batch",
        "--raw",
        "--skip-column-names",
        `--execute=${query}`,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: MAX_MYSQL_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
        env: {
          HOME: runtimeDirectory,
          LANG: "C",
          LC_ALL: "C",
          XDG_CONFIG_HOME: runtimeDirectory,
        },
      },
    );
    if (result?.error?.code === "ENOENT") throw new Error("Gate 6 mysql client unavailable");
    if (result?.error || result?.status !== 0 || typeof result.stdout !== "string") {
      throw new Error("Gate 6 slot query failed");
    }
    return parseOutput(result.stdout);
  } finally {
    if (descriptor !== undefined) fsAdapter.closeSync(descriptor);
    if (created) {
      fsAdapter.unlinkSync(defaultsFile);
      const directoryDescriptor = fsAdapter.openSync(runtimeDirectory, constants.O_RDONLY);
      try {
        fsAdapter.fsyncSync(directoryDescriptor);
      } finally {
        fsAdapter.closeSync(directoryDescriptor);
      }
    }
  }
}

export function executeGate6SlotQuery(options) {
  return executeGate6MysqlCommand({
    ...options,
    query: GATE6_SLOT_QUERY,
    parseOutput: parseGate6SlotQueryOutput,
  });
}

export function readGate6SlotWithMysqlClient(expectedTargetDescriptorSha256) {
  const loaded = loadGate6MysqlCapability(expectedTargetDescriptorSha256);
  return executeGate6SlotQuery(loaded);
}

function mysqlTimestamp(value) {
  timestamp(value, "prepared Gate 6 SQL timestamp");
  return `${value.slice(0, 10)} ${value.slice(11, -1)}`;
}

function preparedGate6SlotCommitQuery(binding) {
  validatePreparedSlotCommit(binding);
  const heartbeat = mysqlTimestamp(binding.heartbeatAt);
  const expires = mysqlTimestamp(binding.expiresAt);
  return `UPDATE gate6_environment_slots
SET state = 'installed-awaiting-gate6',
    protected_install_evidence_sha256 = '${binding.protectedInstallEvidenceSha256}',
    heartbeat_at = '${heartbeat}', expires_at = '${expires}',
    version = version + 1, updated_at = '${heartbeat}'
WHERE environment = BINARY 'production'
  AND owner_type = 'protected-install'
  AND owner_id = '${binding.operationId}' AND operation_id = '${binding.operationId}'
  AND state = 'installing' AND uncompensated_work = 0
  AND transfer_token_sha256 REGEXP BINARY '^[0-9a-f]{64}$'
  AND protected_install_evidence_sha256 <> '${binding.protectedInstallEvidenceSha256}'
  AND release_sha = '${binding.releaseSha}'
  AND target_descriptor_sha256 = '${binding.targetDescriptorSha256}'
  AND operator_bundle_sha256 = '${binding.operatorBundleSha256}'
  AND installed_migration_set_sha256 = '${binding.installedMigrationSetSha256}'
  AND installed_schema_version = ${binding.installedSchemaVersion}
  AND heartbeat_at < '${heartbeat}' AND expires_at >= '${heartbeat}'
  AND version = ${binding.expectedCurrentVersion};
${PREPARED_GATE6_SLOT_QUERY}`;
}

function executePreparedGate6Mysql(binding, query) {
  const loaded = loadGate6MysqlCapability(binding.targetDescriptorSha256);
  return executeGate6MysqlCommand({
    ...loaded,
    query,
    parseOutput: parsePreparedGate6SlotQueryOutput,
  });
}

export function previewPreparedGate6SlotWithMysqlClient(identity) {
  validatePreparedSlotIdentity(identity);
  const loaded = loadGate6MysqlCapability(identity.targetDescriptorSha256);
  const row = executeGate6MysqlCommand({
    ...loaded,
    query: PREPARED_GATE6_SLOT_QUERY,
    parseOutput: parsePreparedGate6SlotQueryOutput,
  });
  if (
    !preparedSlotIdentityMatches(row, identity) ||
    row.state !== "installing" ||
    !Number.isSafeInteger(Number(row.version)) ||
    Number(row.version) < 1 ||
    !SHA256_PATTERN.test(row.protected_install_evidence_sha256 ?? "")
  ) {
    throw new Error("protected install fixed prepared slot installing binding mismatch");
  }
  const version = Number(row.version);
  return {
    current: { operationId: identity.operationId, state: "installing", version },
    next: {
      operationId: identity.operationId,
      state: "installed-awaiting-gate6",
      version: version + 1,
    },
  };
}

export function readPreparedGate6SlotWithMysqlClient(binding) {
  validatePreparedSlotCommit(binding);
  const row = executePreparedGate6Mysql(binding, PREPARED_GATE6_SLOT_QUERY);
  if (!exactPreparedFinalSlot(row, binding) && !exactPreparedCurrentSlot(row, binding)) {
    throw new Error("protected install fixed prepared database-slot binding mismatch");
  }
  return preparedSlotResult(row);
}

export function commitPreparedGate6SlotWithMysqlClient(binding) {
  validatePreparedSlotCommit(binding);
  const row = executePreparedGate6Mysql(binding, preparedGate6SlotCommitQuery(binding));
  if (!exactPreparedFinalSlot(row, binding)) {
    throw new Error("protected install fixed prepared database-slot CAS failed");
  }
  return {
    status: "installed-awaiting-gate6",
    slotVersion: binding.expectedNextVersion,
    idempotent: false,
  };
}

function validateBootstrapSlotInput(input) {
  exactKeys(
    input,
    [
      "operationId",
      "transferTokenSha256",
      "installIntentEvidenceSha256",
      "releaseSha",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "installedMigrationSetSha256",
      "installedSchemaVersion",
      "heartbeatAt",
      "expiresAt",
    ],
    "protected install slot input",
  );
  pattern(input.operationId, ID_PATTERN, "protected install operation ID");
  pattern(input.transferTokenSha256, SHA256_PATTERN, "protected install transfer token hash");
  pattern(
    input.installIntentEvidenceSha256,
    SHA256_PATTERN,
    "protected install intent evidence hash",
  );
  pattern(input.releaseSha, COMMIT_SHA_PATTERN, "protected install release SHA");
  pattern(input.targetDescriptorSha256, SHA256_PATTERN, "protected install target descriptor hash");
  pattern(input.operatorBundleSha256, SHA256_PATTERN, "protected install operator bundle hash");
  pattern(
    input.installedMigrationSetSha256,
    SHA256_PATTERN,
    "protected install migration set hash",
  );
  if (!Number.isSafeInteger(input.installedSchemaVersion) || input.installedSchemaVersion < 1) {
    throw new Error("protected install schema version is invalid");
  }
  const heartbeat = timestamp(input.heartbeatAt, "protected install heartbeat");
  const expires = timestamp(input.expiresAt, "protected install expiry");
  if (expires <= heartbeat || expires - heartbeat > 24 * 60 * 60 * 1_000) {
    throw new Error("protected install slot lease is invalid");
  }
}

function affectedOne(result, label) {
  if (!isObject(result) || result.affectedRows !== 1) {
    throw new Error(`${label} compare-and-swap failed`);
  }
}

function exactBootstrapSlot(row, input) {
  return (
    isObject(row) &&
    row.environment === "production" &&
    row.owner_type === "protected-install" &&
    row.owner_id === input.operationId &&
    row.operation_id === input.operationId &&
    row.transfer_token_sha256 === input.transferTokenSha256 &&
    row.state === "installing" &&
    Number.isSafeInteger(row.version) &&
    row.version >= 1 &&
    Number(row.uncompensated_work) === 0 &&
    row.protected_install_evidence_sha256 === input.installIntentEvidenceSha256 &&
    row.release_sha === input.releaseSha &&
    row.target_descriptor_sha256 === input.targetDescriptorSha256 &&
    row.operator_bundle_sha256 === input.operatorBundleSha256 &&
    row.installed_migration_set_sha256 === input.installedMigrationSetSha256 &&
    Number(row.installed_schema_version) === input.installedSchemaVersion &&
    new Date(row.heartbeat_at).toISOString() === input.heartbeatAt &&
    new Date(row.expires_at).toISOString() === input.expiresAt
  );
}

export async function claimProtectedInstallBootstrapSlot(connection, input) {
  validateBootstrapSlotInput(input);
  await connection.beginTransaction();
  try {
    const [rows] = await connection.execute(`
      SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
             state, version, uncompensated_work, protected_install_evidence_sha256,
             release_sha, target_descriptor_sha256, operator_bundle_sha256,
             installed_migration_set_sha256, installed_schema_version,
             heartbeat_at, expires_at
      FROM gate6_environment_slots
      WHERE environment = 'production'
      FOR UPDATE
    `);
    if (!Array.isArray(rows) || rows.length > 1) {
      throw new Error("production Gate 6 environment slot is ambiguous");
    }
    if (rows.length === 1) {
      const current = rows[0];
      if (exactBootstrapSlot(current, input)) {
        await connection.commit();
        return { status: "installing", slotVersion: current.version, idempotent: true };
      }
      if (
        !isObject(current) ||
        current.owner_type !== "gate6" ||
        !ID_PATTERN.test(current.owner_id ?? "") ||
        current.transfer_token_sha256 !== null ||
        current.state !== "released" ||
        Number(current.uncompensated_work) !== 0 ||
        !Number.isSafeInteger(current.version) ||
        current.version < 1
      )
        throw new Error(
          "production Gate 6 environment slot is already owned or binding mismatched",
        );
      const [updated] = await connection.execute(
        `
        UPDATE gate6_environment_slots
        SET owner_type = 'protected-install', owner_id = ?, operation_id = ?,
            transfer_token_sha256 = ?, state = 'installing',
            uncompensated_work = 0, protected_install_evidence_sha256 = ?,
            release_sha = ?, target_descriptor_sha256 = ?, operator_bundle_sha256 = ?,
            installed_migration_set_sha256 = ?, installed_schema_version = ?,
            heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND transfer_token_sha256 IS NULL AND state = 'released'
          AND uncompensated_work = 0 AND version = ?
      `,
        [
          input.operationId,
          input.operationId,
          input.transferTokenSha256,
          input.installIntentEvidenceSha256,
          input.releaseSha,
          input.targetDescriptorSha256,
          input.operatorBundleSha256,
          input.installedMigrationSetSha256,
          input.installedSchemaVersion,
          input.heartbeatAt,
          input.expiresAt,
          input.heartbeatAt,
          current.owner_id,
          current.version,
        ],
      );
      affectedOne(updated, "protected install released Gate 6 slot claim");
      await connection.commit();
      return { status: "installing", slotVersion: current.version + 1, idempotent: false };
    }
    const [inserted] = await connection.execute(
      `
      INSERT INTO gate6_environment_slots (
        environment, owner_type, owner_id, operation_id, transfer_token_sha256,
        state, version, uncompensated_work, protected_install_evidence_sha256,
        release_sha, target_descriptor_sha256, operator_bundle_sha256,
        installed_migration_set_sha256, installed_schema_version,
        heartbeat_at, expires_at, created_at, updated_at
      ) VALUES (
        'production', 'protected-install', ?, ?, ?,
        'installing', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `,
      [
        input.operationId,
        input.operationId,
        input.transferTokenSha256,
        input.installIntentEvidenceSha256,
        input.releaseSha,
        input.targetDescriptorSha256,
        input.operatorBundleSha256,
        input.installedMigrationSetSha256,
        input.installedSchemaVersion,
        input.heartbeatAt,
        input.expiresAt,
        input.heartbeatAt,
        input.heartbeatAt,
      ],
    );
    affectedOne(inserted, "protected install Gate 6 slot claim");
    await connection.commit();
    return { status: "installing", slotVersion: 1, idempotent: false };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

function validatePreparedSlotIdentity(input) {
  exactKeys(
    input,
    [
      "operationId",
      "releaseSha",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "installedMigrationSetSha256",
      "installedSchemaVersion",
    ],
    "protected install prepared slot identity",
  );
  pattern(input.operationId, ID_PATTERN, "protected install prepared slot operation");
  pattern(input.releaseSha, COMMIT_SHA_PATTERN, "protected install prepared slot release");
  pattern(input.targetDescriptorSha256, SHA256_PATTERN, "protected install prepared slot target");
  pattern(input.operatorBundleSha256, SHA256_PATTERN, "protected install prepared slot bundle");
  pattern(
    input.installedMigrationSetSha256,
    SHA256_PATTERN,
    "protected install prepared slot migration set",
  );
  if (!Number.isSafeInteger(input.installedSchemaVersion) || input.installedSchemaVersion < 1) {
    throw new Error("protected install prepared slot schema version is invalid");
  }
  return input;
}

function validatePreparedSlotCommit(input) {
  exactKeys(
    input,
    [
      "operationId",
      "releaseSha",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "installedMigrationSetSha256",
      "installedSchemaVersion",
      "protectedInstallEvidenceSha256",
      "heartbeatAt",
      "expiresAt",
      "expectedCurrentVersion",
      "expectedNextVersion",
    ],
    "protected install prepared slot commit",
  );
  validatePreparedSlotIdentity({
    operationId: input.operationId,
    releaseSha: input.releaseSha,
    targetDescriptorSha256: input.targetDescriptorSha256,
    operatorBundleSha256: input.operatorBundleSha256,
    installedMigrationSetSha256: input.installedMigrationSetSha256,
    installedSchemaVersion: input.installedSchemaVersion,
  });
  pattern(
    input.protectedInstallEvidenceSha256,
    SHA256_PATTERN,
    "protected install prepared slot evidence hash",
  );
  const heartbeat = timestamp(input.heartbeatAt, "protected install prepared slot heartbeat");
  const expires = timestamp(input.expiresAt, "protected install prepared slot expiry");
  if (expires <= heartbeat || expires - heartbeat > 24 * 60 * 60 * 1_000) {
    throw new Error("protected install prepared slot lease is invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedCurrentVersion) ||
    input.expectedCurrentVersion < 1 ||
    !Number.isSafeInteger(input.expectedNextVersion) ||
    input.expectedNextVersion !== input.expectedCurrentVersion + 1
  ) {
    throw new Error("protected install prepared slot version is invalid");
  }
  return input;
}

function preparedSlotIdentityMatches(row, input) {
  return (
    isObject(row) &&
    row.environment === "production" &&
    row.owner_type === "protected-install" &&
    row.owner_id === input.operationId &&
    row.operation_id === input.operationId &&
    SHA256_PATTERN.test(row.transfer_token_sha256 ?? "") &&
    Number(row.uncompensated_work) === 0 &&
    row.release_sha === input.releaseSha &&
    row.target_descriptor_sha256 === input.targetDescriptorSha256 &&
    row.operator_bundle_sha256 === input.operatorBundleSha256 &&
    row.installed_migration_set_sha256 === input.installedMigrationSetSha256 &&
    Number(row.installed_schema_version) === input.installedSchemaVersion
  );
}

function exactPreparedFinalSlot(row, input) {
  return (
    preparedSlotIdentityMatches(row, input) &&
    row.state === "installed-awaiting-gate6" &&
    Number(row.version) === input.expectedNextVersion &&
    row.protected_install_evidence_sha256 === input.protectedInstallEvidenceSha256 &&
    new Date(row.heartbeat_at).toISOString() === input.heartbeatAt &&
    new Date(row.expires_at).toISOString() === input.expiresAt
  );
}

function exactPreparedCurrentSlot(row, input) {
  return (
    preparedSlotIdentityMatches(row, input) &&
    row.state === "installing" &&
    Number(row.version) === input.expectedCurrentVersion &&
    SHA256_PATTERN.test(row.protected_install_evidence_sha256 ?? "") &&
    row.protected_install_evidence_sha256 !== input.protectedInstallEvidenceSha256 &&
    timestamp(row.heartbeat_at, "protected install current slot heartbeat") <
      timestamp(input.heartbeatAt, "protected install prepared slot heartbeat") &&
    timestamp(row.expires_at, "protected install current slot expiry") >
      timestamp(row.heartbeat_at, "protected install current slot heartbeat") &&
    timestamp(row.expires_at, "protected install current slot expiry") >=
      timestamp(input.heartbeatAt, "protected install prepared slot heartbeat")
  );
}

function preparedSlotResult(row) {
  return {
    operationId: row.operation_id,
    state: row.state,
    version: Number(row.version),
    protectedInstallEvidenceSha256: row.protected_install_evidence_sha256,
    heartbeatAt: new Date(row.heartbeat_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    releaseSha: row.release_sha,
    targetDescriptorSha256: row.target_descriptor_sha256,
    operatorBundleSha256: row.operator_bundle_sha256,
    installedMigrationSetSha256: row.installed_migration_set_sha256,
    installedSchemaVersion: Number(row.installed_schema_version),
  };
}

async function readPreparedSlotRows(connection, forUpdate = false) {
  const [rows] = await connection.execute(`
    SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
           state, version, uncompensated_work, protected_install_evidence_sha256,
           release_sha, target_descriptor_sha256, operator_bundle_sha256,
           installed_migration_set_sha256, installed_schema_version,
           heartbeat_at, expires_at
    FROM gate6_environment_slots
    WHERE environment = 'production'
    ${forUpdate ? "FOR UPDATE" : ""}
  `);
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("protected install prepared slot is missing or ambiguous");
  }
  return rows[0];
}

export async function previewProtectedInstallGate6SlotCommit(connection, identity) {
  validatePreparedSlotIdentity(identity);
  const current = await readPreparedSlotRows(connection);
  if (
    !preparedSlotIdentityMatches(current, identity) ||
    current.state !== "installing" ||
    !Number.isSafeInteger(Number(current.version)) ||
    Number(current.version) < 1 ||
    !SHA256_PATTERN.test(current.protected_install_evidence_sha256 ?? "")
  ) {
    throw new Error("protected install prepared slot installing binding mismatch");
  }
  const version = Number(current.version);
  return {
    current: { operationId: identity.operationId, state: "installing", version },
    next: {
      operationId: identity.operationId,
      state: "installed-awaiting-gate6",
      version: version + 1,
    },
  };
}

export async function commitProtectedInstallGate6Slot(connection, binding) {
  validatePreparedSlotCommit(binding);
  await connection.beginTransaction();
  try {
    const current = await readPreparedSlotRows(connection, true);
    if (exactPreparedFinalSlot(current, binding)) {
      await connection.commit();
      return {
        status: "installed-awaiting-gate6",
        slotVersion: binding.expectedNextVersion,
        idempotent: true,
      };
    }
    if (
      !preparedSlotIdentityMatches(current, binding) ||
      current.state !== "installing" ||
      Number(current.version) !== binding.expectedCurrentVersion ||
      !SHA256_PATTERN.test(current.protected_install_evidence_sha256 ?? "") ||
      timestamp(current.heartbeat_at, "protected install current slot heartbeat") >=
        timestamp(binding.heartbeatAt, "protected install prepared slot heartbeat") ||
      timestamp(current.expires_at, "protected install current slot expiry") <
        timestamp(binding.heartbeatAt, "protected install prepared slot heartbeat")
    ) {
      throw new Error("protected install prepared slot commit binding mismatch");
    }
    const [updated] = await connection.execute(
      `
      UPDATE gate6_environment_slots
      SET state = 'installed-awaiting-gate6', protected_install_evidence_sha256 = ?,
          heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
      WHERE environment = 'production' AND owner_type = 'protected-install'
        AND owner_id = ? AND operation_id = ? AND state = 'installing'
        AND release_sha = ? AND target_descriptor_sha256 = ?
        AND operator_bundle_sha256 = ? AND installed_migration_set_sha256 = ?
        AND installed_schema_version = ? AND uncompensated_work = 0 AND version = ?
    `,
      [
        binding.protectedInstallEvidenceSha256,
        binding.heartbeatAt,
        binding.expiresAt,
        binding.heartbeatAt,
        binding.operationId,
        binding.operationId,
        binding.releaseSha,
        binding.targetDescriptorSha256,
        binding.operatorBundleSha256,
        binding.installedMigrationSetSha256,
        binding.installedSchemaVersion,
        binding.expectedCurrentVersion,
      ],
    );
    affectedOne(updated, "protected install prepared Gate 6 slot commit");
    await connection.commit();
    return {
      status: "installed-awaiting-gate6",
      slotVersion: binding.expectedNextVersion,
      idempotent: false,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export async function readProtectedInstallGate6SlotCommit(connection, binding) {
  validatePreparedSlotCommit(binding);
  const current = await readPreparedSlotRows(connection);
  if (!exactPreparedFinalSlot(current, binding) && !exactPreparedCurrentSlot(current, binding)) {
    throw new Error("protected install prepared slot committed binding mismatch");
  }
  return preparedSlotResult(current);
}

function validateFinalizeSlotInput(input) {
  exactKeys(
    input,
    [
      "operationId",
      "transferTokenSha256",
      "installIntentEvidenceSha256",
      "protectedInstallEvidenceSha256",
      "releaseSha",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "installedMigrationSetSha256",
      "installedSchemaVersion",
      "intentHeartbeatAt",
      "intentExpiresAt",
      "heartbeatAt",
      "expiresAt",
      "expectedSlotVersion",
    ],
    "protected install final slot input",
  );
  validateBootstrapSlotInput({
    operationId: input.operationId,
    transferTokenSha256: input.transferTokenSha256,
    installIntentEvidenceSha256: input.installIntentEvidenceSha256,
    releaseSha: input.releaseSha,
    targetDescriptorSha256: input.targetDescriptorSha256,
    operatorBundleSha256: input.operatorBundleSha256,
    installedMigrationSetSha256: input.installedMigrationSetSha256,
    installedSchemaVersion: input.installedSchemaVersion,
    heartbeatAt: input.intentHeartbeatAt,
    expiresAt: input.intentExpiresAt,
  });
  const intentHeartbeat = timestamp(input.intentHeartbeatAt, "protected install intent heartbeat");
  const finalHeartbeat = timestamp(input.heartbeatAt, "protected install final heartbeat");
  const finalExpires = timestamp(input.expiresAt, "protected install final expiry");
  if (
    finalHeartbeat <= intentHeartbeat ||
    finalExpires <= finalHeartbeat ||
    finalExpires - finalHeartbeat > 24 * 60 * 60 * 1_000
  )
    throw new Error("protected install final slot lease is invalid");
  pattern(
    input.protectedInstallEvidenceSha256,
    SHA256_PATTERN,
    "protected install final evidence hash",
  );
  if (
    input.expectedSlotVersion !== null &&
    (!Number.isSafeInteger(input.expectedSlotVersion) || input.expectedSlotVersion < 1)
  ) {
    throw new Error("protected install expected slot version is invalid");
  }
}

function exactFinalizedSlot(row, input) {
  return (
    isObject(row) &&
    row.environment === "production" &&
    row.owner_type === "protected-install" &&
    row.owner_id === input.operationId &&
    row.operation_id === input.operationId &&
    row.transfer_token_sha256 === input.transferTokenSha256 &&
    row.state === "installed-awaiting-gate6" &&
    row.version === input.expectedSlotVersion + 1 &&
    Number(row.uncompensated_work) === 0 &&
    row.protected_install_evidence_sha256 === input.protectedInstallEvidenceSha256 &&
    row.release_sha === input.releaseSha &&
    row.target_descriptor_sha256 === input.targetDescriptorSha256 &&
    row.operator_bundle_sha256 === input.operatorBundleSha256 &&
    row.installed_migration_set_sha256 === input.installedMigrationSetSha256 &&
    Number(row.installed_schema_version) === input.installedSchemaVersion &&
    new Date(row.heartbeat_at).toISOString() === input.heartbeatAt &&
    new Date(row.expires_at).toISOString() === input.expiresAt
  );
}

export async function finalizeProtectedInstallGate6Slot(connection, input) {
  validateFinalizeSlotInput(input);
  await connection.beginTransaction();
  try {
    const [rows] = await connection.execute(`
      SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
             state, version, uncompensated_work, protected_install_evidence_sha256,
             release_sha, target_descriptor_sha256, operator_bundle_sha256,
             installed_migration_set_sha256, installed_schema_version,
             heartbeat_at, expires_at
      FROM gate6_environment_slots
      WHERE environment = 'production'
      FOR UPDATE
    `);
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error("protected install bootstrap slot is missing or ambiguous");
    }
    const current = rows[0];
    if (exactFinalizedSlot(current, input)) {
      await connection.commit();
      return {
        status: "installed-awaiting-gate6",
        slotVersion: input.expectedSlotVersion + 1,
        idempotent: true,
      };
    }
    const bootstrapInput = {
      operationId: input.operationId,
      transferTokenSha256: input.transferTokenSha256,
      installIntentEvidenceSha256: input.installIntentEvidenceSha256,
      releaseSha: input.releaseSha,
      targetDescriptorSha256: input.targetDescriptorSha256,
      operatorBundleSha256: input.operatorBundleSha256,
      installedMigrationSetSha256: input.installedMigrationSetSha256,
      installedSchemaVersion: input.installedSchemaVersion,
      heartbeatAt: input.intentHeartbeatAt,
      expiresAt: input.intentExpiresAt,
    };
    if (
      !exactBootstrapSlot(current, bootstrapInput) ||
      current.version !== input.expectedSlotVersion
    ) {
      throw new Error("protected install bootstrap slot finalization binding mismatch");
    }
    const [updated] = await connection.execute(
      `
      UPDATE gate6_environment_slots
      SET state = 'installed-awaiting-gate6', protected_install_evidence_sha256 = ?,
          heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
      WHERE environment = 'production'
        AND owner_type = 'protected-install' AND owner_id = ? AND operation_id = ?
        AND transfer_token_sha256 = ? AND state = 'installing'
        AND protected_install_evidence_sha256 = ? AND release_sha = ?
        AND target_descriptor_sha256 = ? AND operator_bundle_sha256 = ?
        AND installed_migration_set_sha256 = ? AND installed_schema_version = ?
        AND uncompensated_work = 0 AND version = ?
    `,
      [
        input.protectedInstallEvidenceSha256,
        input.heartbeatAt,
        input.expiresAt,
        input.heartbeatAt,
        input.operationId,
        input.operationId,
        input.transferTokenSha256,
        input.installIntentEvidenceSha256,
        input.releaseSha,
        input.targetDescriptorSha256,
        input.operatorBundleSha256,
        input.installedMigrationSetSha256,
        input.installedSchemaVersion,
        input.expectedSlotVersion,
      ],
    );
    affectedOne(updated, "protected install Gate 6 slot finalization");
    await connection.commit();
    return {
      status: "installed-awaiting-gate6",
      slotVersion: input.expectedSlotVersion + 1,
      idempotent: false,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

function validateCompensateSlotInput(input) {
  exactKeys(
    input,
    ["operationId", "transferTokenSha256", "expectedSlotVersion", "compensatedAt"],
    "protected install compensation input",
  );
  pattern(input.operationId, ID_PATTERN, "protected install compensation operation");
  pattern(input.transferTokenSha256, SHA256_PATTERN, "protected install compensation token");
  timestamp(input.compensatedAt, "protected install compensation timestamp");
  if (!Number.isSafeInteger(input.expectedSlotVersion) || input.expectedSlotVersion < 1) {
    throw new Error("protected install compensation slot version is invalid");
  }
}

export async function inspectProtectedInstallSlot(connection, input) {
  exactKeys(input, ["operationId", "transferTokenSha256"], "protected install inspection input");
  pattern(input.operationId, ID_PATTERN, "protected install inspection operation");
  pattern(input.transferTokenSha256, SHA256_PATTERN, "protected install inspection token");
  const [rows] = await connection.execute(`
    SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
           state, version, uncompensated_work
    FROM gate6_environment_slots
    WHERE environment = 'production'
  `);
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("protected install inspection slot is ambiguous");
  }
  const current = rows[0] ?? null;
  if (current === null) return { status: "released", slotVersion: 0 };
  if (
    current.state === "released" &&
    current.transfer_token_sha256 === null &&
    Number(current.uncompensated_work) === 0
  )
    return { status: "released", slotVersion: Number(current.version) };
  if (
    current.owner_type === "protected-install" &&
    current.owner_id === input.operationId &&
    current.operation_id === input.operationId &&
    current.transfer_token_sha256 === input.transferTokenSha256 &&
    Number(current.uncompensated_work) === 0 &&
    ["installing", "installed-awaiting-gate6"].includes(current.state)
  )
    return { status: current.state, slotVersion: Number(current.version) };
  throw new Error("protected install inspection binding mismatch");
}

export async function compensateProtectedInstallBootstrapSlot(connection, input) {
  validateCompensateSlotInput(input);
  await connection.beginTransaction();
  try {
    const [rows] = await connection.execute(`
      SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
             state, version, uncompensated_work
      FROM gate6_environment_slots
      WHERE environment = 'production'
      FOR UPDATE
    `);
    if (!Array.isArray(rows) || rows.length > 1) {
      throw new Error("protected install compensation slot is ambiguous");
    }
    const current = rows[0] ?? null;
    if (current === null) {
      await connection.commit();
      return { status: "released", slotVersion: 0, idempotent: true };
    }
    if (
      current.state === "released" &&
      current.transfer_token_sha256 === null &&
      Number(current.uncompensated_work) === 0
    ) {
      await connection.commit();
      return { status: "released", slotVersion: Number(current.version), idempotent: true };
    }
    if (
      current.owner_type !== "protected-install" ||
      current.owner_id !== input.operationId ||
      current.operation_id !== input.operationId ||
      current.transfer_token_sha256 !== input.transferTokenSha256 ||
      current.state !== "installing" ||
      (input.expectedSlotVersion !== null &&
        Number(current.version) !== input.expectedSlotVersion) ||
      Number(current.uncompensated_work) !== 0
    ) {
      throw new Error("protected install compensation binding mismatch");
    }
    const compensatedVersion = Number(current.version);
    const [updated] = await connection.execute(
      `
      UPDATE gate6_environment_slots
      SET state = 'released', transfer_token_sha256 = NULL, uncompensated_work = 0,
          heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
      WHERE environment = 'production' AND owner_type = 'protected-install'
        AND owner_id = ? AND operation_id = ? AND transfer_token_sha256 = ?
        AND state = 'installing' AND version = ? AND uncompensated_work = 0
    `,
      [
        input.compensatedAt,
        input.compensatedAt,
        input.compensatedAt,
        input.operationId,
        input.operationId,
        input.transferTokenSha256,
        compensatedVersion,
      ],
    );
    affectedOne(updated, "protected install slot compensation");
    await connection.commit();
    return {
      status: "released",
      slotVersion: compensatedVersion + 1,
      idempotent: false,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function readAuthoritativeGate6Slot(connection) {
  const [rows] = await connection.execute(`
    SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
           state, version, uncompensated_work, protected_install_evidence_sha256,
           release_sha, target_descriptor_sha256, operator_bundle_sha256,
           installed_migration_set_sha256, installed_schema_version,
           heartbeat_at, expires_at
    FROM gate6_environment_slots
    WHERE environment = 'production'
  `);
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("production Gate 6 environment slot is ambiguous");
  }
  return rows[0] ?? null;
}

function validatePreparedDirectory(path, allowNonRoot) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error("protected install fixed prepared directory is unavailable");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("protected install fixed prepared directory is invalid");
  }
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o777) !== 0o700 || (!allowNonRoot && stat.uid !== 0))
  ) {
    throw new Error("protected install fixed prepared directory metadata is invalid");
  }
}

function readCanonicalPreparedFile(path, label, allowNonRoot) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size < 1 ||
    stat.size > MAX_PREPARED_FILE_BYTES ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o777) !== 0o400 || (!allowNonRoot && stat.uid !== 0) || stat.nlink !== 1))
  ) {
    throw new Error(`${label} metadata is invalid`);
  }
  const bytes = readStableRegularFile(path, label, { maximumBytes: MAX_PREPARED_FILE_BYTES });
  const after = lstatSync(path);
  if (
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.size !== stat.size ||
    after.mode !== stat.mode ||
    after.uid !== stat.uid ||
    after.nlink !== stat.nlink ||
    after.mtimeMs !== stat.mtimeMs ||
    after.ctimeMs !== stat.ctimeMs
  ) {
    throw new Error(`${label} changed identity or metadata during validation`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not canonical JSON`);
  }
  if (canonicalJsonValue(value) !== bytes.toString("utf8")) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return { bytes, value };
}

function validatePreparedVersionPair(value, label) {
  exactKeys(value, ["currentVersion", "nextVersion"], label);
  if (
    !Number.isSafeInteger(value.currentVersion) ||
    value.currentVersion < 1 ||
    !Number.isSafeInteger(value.nextVersion) ||
    value.nextVersion !== value.currentVersion + 1
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function preparedBindingsFromRecord(record) {
  const common = {
    operationId: record.operationId,
    releaseSha: record.releaseSha,
    targetDescriptorSha256: record.targetDescriptorSha256,
    operatorBundleSha256: record.operatorBundleSha256,
    protectedInstallEvidenceSha256: record.protectedInstallEvidenceSha256,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
  };
  return {
    databaseSlot: {
      ...common,
      installedMigrationSetSha256: record.installedMigrationSetSha256,
      installedSchemaVersion: record.installedSchemaVersion,
      expectedCurrentVersion: record.expectedDatabaseSlot.currentVersion,
      expectedNextVersion: record.expectedDatabaseSlot.nextVersion,
    },
    hostLock: {
      ...common,
      expectedCurrentVersion: record.expectedHostLock.currentVersion,
      expectedNextVersion: record.expectedHostLock.nextVersion,
    },
  };
}

function validateFixedPreparedCommitFiles(files, lock) {
  const record = files.get("prepared-commit.json").value;
  exactKeys(
    record,
    [
      "schemaVersion",
      "operationId",
      "releaseSha",
      "releaseManifestSha256",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "installedMigrationSetSha256",
      "installedSchemaVersion",
      "evidenceCoreSha256",
      "signatureSha256",
      "protectedInstallEvidenceSha256",
      "expectedHostLock",
      "expectedDatabaseSlot",
      "heartbeatAt",
      "expiresAt",
    ],
    "protected install fixed prepared commit record",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("protected install fixed prepared commit version is invalid");
  }
  pattern(record.operationId, ID_PATTERN, "protected install fixed prepared operation");
  pattern(record.releaseSha, COMMIT_SHA_PATTERN, "protected install fixed prepared release");
  for (const key of [
    "releaseManifestSha256",
    "targetDescriptorSha256",
    "operatorBundleSha256",
    "installedMigrationSetSha256",
    "evidenceCoreSha256",
    "signatureSha256",
    "protectedInstallEvidenceSha256",
  ]) {
    pattern(record[key], SHA256_PATTERN, `protected install fixed prepared ${key}`);
  }
  if (!Number.isSafeInteger(record.installedSchemaVersion) || record.installedSchemaVersion < 1) {
    throw new Error("protected install fixed prepared schema version is invalid");
  }
  validatePreparedVersionPair(
    record.expectedHostLock,
    "protected install fixed prepared host-lock versions",
  );
  validatePreparedVersionPair(
    record.expectedDatabaseSlot,
    "protected install fixed prepared database-slot versions",
  );
  const heartbeat = timestamp(record.heartbeatAt, "protected install fixed prepared heartbeat");
  const expires = timestamp(record.expiresAt, "protected install fixed prepared expiry");
  if (expires <= heartbeat || expires - heartbeat > 24 * 60 * 60 * 1_000) {
    throw new Error("protected install fixed prepared lease is invalid");
  }

  const coreFile = files.get("evidence-core.json");
  const signatureFile = files.get("protected-install-signature.json");
  const evidenceFile = files.get("protected-install-evidence.json");
  if (
    sha256(coreFile.bytes) !== record.evidenceCoreSha256 ||
    sha256(signatureFile.bytes) !== record.signatureSha256 ||
    sha256(evidenceFile.bytes) !== record.protectedInstallEvidenceSha256
  ) {
    throw new Error("protected install fixed prepared file hash mismatch");
  }
  const core = coreFile.value;
  if (!isObject(core)) throw new Error("protected install fixed prepared core is invalid");
  const signature = signatureFile.value;
  exactKeys(
    signature,
    ["schemaVersion", "algorithm", "keyId", "subjectSha256", "signatureBase64", "signedAt"],
    "protected install fixed prepared signature",
  );
  if (
    signature.schemaVersion !== 1 ||
    signature.algorithm !== "kms-sha256" ||
    typeof signature.keyId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9/_.:@+-]{0,255}$/.test(signature.keyId) ||
    signature.subjectSha256 !== record.evidenceCoreSha256 ||
    typeof signature.signatureBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.signatureBase64)
  ) {
    throw new Error("protected install fixed prepared signature binding is invalid");
  }
  timestamp(signature.signedAt, "protected install fixed prepared signature timestamp");
  const evidence = evidenceFile.value;
  if (!isObject(evidence) || evidence.signatureSha256 !== record.signatureSha256) {
    throw new Error("protected install fixed prepared evidence signature binding is invalid");
  }
  const evidenceCore = { ...evidence };
  delete evidenceCore.signatureSha256;
  if (canonicalJsonValue(evidenceCore) !== coreFile.bytes.toString("utf8")) {
    throw new Error("protected install fixed prepared evidence core binding is invalid");
  }
  if (
    core.operationId !== record.operationId ||
    core.candidateSha !== record.releaseSha ||
    core.releaseManifestSha256 !== record.releaseManifestSha256 ||
    core.productionTargetDescriptorSha256 !== record.targetDescriptorSha256 ||
    core.installedOperatorBundleSha256 !== record.operatorBundleSha256 ||
    core.installedMigrationSetSha256 !== record.installedMigrationSetSha256 ||
    core.afterSchema !== record.installedSchemaVersion ||
    !isObject(core.finalLease) ||
    core.finalLease.heartbeatAt !== record.heartbeatAt ||
    core.finalLease.expiresAt !== record.expiresAt
  ) {
    throw new Error("protected install fixed prepared release binding mismatch");
  }
  if (
    record.operationId !== lock.operationId ||
    record.releaseManifestSha256 !== lock.releaseHash ||
    record.targetDescriptorSha256 !== lock.targetHash
  ) {
    throw new Error("protected install fixed prepared host-lock identity mismatch");
  }
  const owner = lock.state === "installing" ? lock.installBootstrap : lock.protectedInstall;
  if (
    !isObject(owner) ||
    owner.operationId !== record.operationId ||
    owner.releaseSha !== record.releaseSha ||
    owner.targetDescriptorSha256 !== record.targetDescriptorSha256 ||
    owner.operatorBundleSha256 !== record.operatorBundleSha256 ||
    owner.installedMigrationSetSha256 !== record.installedMigrationSetSha256 ||
    owner.installedSchemaVersion !== record.installedSchemaVersion ||
    (lock.state === "installing" &&
      (lock.revision !== record.expectedHostLock.currentVersion ||
        owner.slotVersion !== record.expectedDatabaseSlot.currentVersion)) ||
    (lock.state === "installed-awaiting-gate6" &&
      (lock.revision !== record.expectedHostLock.nextVersion ||
        owner.slotVersion !== record.expectedDatabaseSlot.nextVersion ||
        owner.protectedInstallEvidenceSha256 !== record.protectedInstallEvidenceSha256 ||
        lock.lease.heartbeatAt !== record.heartbeatAt ||
        lock.lease.expiresAt !== record.expiresAt))
  ) {
    throw new Error("protected install fixed prepared durable-state binding mismatch");
  }
  return preparedBindingsFromRecord(record);
}

function loadFixedPreparedCommitForLock(lock, options) {
  if (
    lock.operationType !== "install" ||
    !["installing", "installed-awaiting-gate6"].includes(lock.state)
  )
    return null;
  const allowNonRoot = options.allowNonRoot === true;
  const override = options.testOnlyProtectedInstallRoot;
  if (override !== undefined && (!allowNonRoot || typeof override !== "string")) {
    throw new Error("protected install fixed prepared root override is invalid");
  }
  const root = resolve(override ?? FIXED_PROTECTED_INSTALL_ROOT);
  if (!existsSync(root)) return null;
  validatePreparedDirectory(root, allowNonRoot);
  const candidates = [];
  for (const kind of ["prepared", "committed"]) {
    const parent = join(root, kind);
    if (!existsSync(parent)) continue;
    validatePreparedDirectory(parent, allowNonRoot);
    const directory = join(parent, lock.operationId);
    if (!existsSync(directory)) continue;
    validatePreparedDirectory(directory, allowNonRoot);
    candidates.push(directory);
  }
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new Error("protected install fixed prepared commit location is ambiguous");
  }
  const directory = candidates[0];
  const names = readdirSync(directory).sort();
  if (
    names.length !== FIXED_PREPARED_FILE_NAMES.length ||
    names.some((name, index) => name !== FIXED_PREPARED_FILE_NAMES[index])
  ) {
    throw new Error("protected install fixed prepared commit file set is incomplete");
  }
  const files = new Map();
  for (const name of FIXED_PREPARED_FILE_NAMES) {
    files.set(
      name,
      readCanonicalPreparedFile(
        join(directory, name),
        `protected install fixed prepared ${name.replaceAll("-", " ")}`,
        allowNonRoot,
      ),
    );
  }
  return validateFixedPreparedCommitFiles(files, lock);
}

export async function loadFixedPreparedProtectedInstallCommit(options = {}) {
  const lock = await readProductionMutationLock(options);
  return loadFixedPreparedCommitForLock(lock, options);
}

function validatePreparedReconcileCommit(value) {
  exactKeys(value, ["databaseSlot", "hostLock"], "protected install prepared reconcile commit");
  if (!isObject(value.databaseSlot) || !isObject(value.hostLock)) {
    throw new Error("protected install prepared reconcile commit is invalid");
  }
  validatePreparedSlotCommit(value.databaseSlot);
  exactKeys(
    value.hostLock,
    [
      "operationId",
      "releaseSha",
      "targetDescriptorSha256",
      "operatorBundleSha256",
      "protectedInstallEvidenceSha256",
      "heartbeatAt",
      "expiresAt",
      "expectedCurrentVersion",
      "expectedNextVersion",
    ],
    "protected install prepared host-lock commit",
  );
  pattern(value.hostLock.operationId, ID_PATTERN, "protected install prepared host-lock operation");
  pattern(
    value.hostLock.releaseSha,
    COMMIT_SHA_PATTERN,
    "protected install prepared host-lock release",
  );
  pattern(
    value.hostLock.targetDescriptorSha256,
    SHA256_PATTERN,
    "protected install prepared host-lock target",
  );
  pattern(
    value.hostLock.operatorBundleSha256,
    SHA256_PATTERN,
    "protected install prepared host-lock bundle",
  );
  pattern(
    value.hostLock.protectedInstallEvidenceSha256,
    SHA256_PATTERN,
    "protected install prepared host-lock evidence",
  );
  const hostHeartbeat = timestamp(
    value.hostLock.heartbeatAt,
    "protected install prepared host-lock heartbeat",
  );
  const hostExpires = timestamp(
    value.hostLock.expiresAt,
    "protected install prepared host-lock expiry",
  );
  if (
    hostExpires <= hostHeartbeat ||
    hostExpires - hostHeartbeat > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(value.hostLock.expectedCurrentVersion) ||
    value.hostLock.expectedCurrentVersion < 1 ||
    !Number.isSafeInteger(value.hostLock.expectedNextVersion) ||
    value.hostLock.expectedNextVersion !== value.hostLock.expectedCurrentVersion + 1
  ) {
    throw new Error("protected install prepared host-lock version or lease is invalid");
  }
  for (const key of [
    "operationId",
    "releaseSha",
    "targetDescriptorSha256",
    "operatorBundleSha256",
    "protectedInstallEvidenceSha256",
    "heartbeatAt",
    "expiresAt",
  ]) {
    if (value.databaseSlot[key] !== value.hostLock[key]) {
      throw new Error("protected install prepared reconcile binding mismatch");
    }
  }
  return value;
}

async function reconcilePreparedProtectedInstallCommit({
  connection,
  stateDir,
  allowNonRoot,
  preparedCommit,
}) {
  const prepared = validatePreparedReconcileCommit(preparedCommit);
  const readDatabaseSlot =
    connection === undefined
      ? readPreparedGate6SlotWithMysqlClient
      : (binding) => readProtectedInstallGate6SlotCommit(connection, binding);
  const finalizeDatabaseSlot =
    connection === undefined
      ? commitPreparedGate6SlotWithMysqlClient
      : (binding) => commitProtectedInstallGate6Slot(connection, binding);
  await readDatabaseSlot(prepared.databaseSlot);
  await readProductionInstallHostLockCommit({
    stateDir,
    allowNonRoot,
    binding: prepared.hostLock,
  });
  await finalizeDatabaseSlot(prepared.databaseSlot);
  await commitProductionInstallHostLock({
    stateDir,
    allowNonRoot,
    binding: prepared.hostLock,
  });
  const slot = await readDatabaseSlot(prepared.databaseSlot);
  await readProductionInstallHostLockCommit({
    stateDir,
    allowNonRoot,
    binding: prepared.hostLock,
  });
  const lock = await readProductionMutationLock({ stateDir, allowNonRoot });
  return {
    outcome: "prepared-protected-install-commit-reconciled",
    lock,
    slot,
  };
}

export async function reconcileProtectedInstallHandoffOnce({
  connection,
  readSlot,
  stateDir,
  nowMs = Date.now(),
  watchdogOwner = "systemd:spx-protected-install-watchdog",
  gate6LeaseOwner = "systemd:spx-gate6-supervisor",
  leaseDurationMs = 30_000,
  allowNonRoot = false,
  preparedCommit,
  testOnlyProtectedInstallRoot,
}) {
  const lock = await readProductionMutationLock({
    stateDir,
    allowNonRoot,
    allowMissing: true,
  });
  if (lock === null) return { outcome: "unlocked", lock: null };
  if (lock.operationType !== "install") return { outcome: "not-protected-install", lock };
  if (preparedCommit !== undefined) {
    return reconcilePreparedProtectedInstallCommit({
      connection,
      stateDir,
      allowNonRoot,
      preparedCommit,
    });
  }
  const fixedPreparedCommit = loadFixedPreparedCommitForLock(lock, {
    allowNonRoot,
    testOnlyProtectedInstallRoot,
  });
  if (fixedPreparedCommit !== null) {
    return reconcilePreparedProtectedInstallCommit({
      connection,
      stateDir,
      allowNonRoot,
      preparedCommit: fixedPreparedCommit,
    });
  }
  if (lock.state === "gate6-active" || lock.state === "terminal") {
    return { outcome: "handoff-already-complete", lock };
  }
  if (connection === undefined && typeof readSlot !== "function") {
    throw new Error("protected install slot reader is unavailable");
  }
  const observedSlot =
    typeof readSlot === "function"
      ? await readSlot({ targetDescriptorSha256: lock.targetHash })
      : await readAuthoritativeGate6Slot(connection);
  if (observedSlot === null) return { outcome: "slot-not-yet-created", lock };
  if (
    ["installing", "recovering"].includes(lock.state) &&
    observedSlot.environment === "production" &&
    observedSlot.owner_type === "gate6" &&
    observedSlot.state === "released" &&
    observedSlot.transfer_token_sha256 === null &&
    Number(observedSlot.uncompensated_work) === 0
  )
    return { outcome: "slot-not-yet-created", lock };
  const identity = {
    stateDir,
    operationId: lock.operationId,
    releaseHash: lock.releaseHash,
    targetHash: lock.targetHash,
    nowMs,
    allowNonRoot,
  };
  if (
    observedSlot.owner_type === "protected-install" &&
    observedSlot.owner_id === lock.operationId &&
    observedSlot.operation_id === lock.operationId &&
    observedSlot.state === "installing"
  ) {
    if (lock.state === "installed-awaiting-gate6") {
      return { outcome: "prepared-commit-required", lock };
    }
    const reconciled = await reconcileProductionInstallBootstrapSlot({
      ...identity,
      observedSlot,
      watchdogOwner,
      leaseDurationMs,
    });
    return { outcome: "protected-install-bootstrap-reconciled", lock: reconciled };
  }
  if (["installing", "recovering", "installed-awaiting-gate6"].includes(lock.state)) {
    return { outcome: "prepared-commit-required", lock };
  }
  if (lock.state === "handoff-pending") {
    return reconcileProductionMutationGate6Handoff({
      ...identity,
      leaseOwner: lock.lease.owner,
      observedSlot,
      gate6LeaseOwner,
      gate6LeaseDurationMs: leaseDurationMs,
    });
  }
  throw new Error("protected install host-lock state is not reconcilable");
}

function exactServiceSet(signedServices, allowedServices) {
  if (
    !Array.isArray(signedServices) ||
    !Array.isArray(allowedServices) ||
    signedServices.length === 0
  ) {
    throw new Error("protected install service allowlist is invalid");
  }
  const allowed = new Set(allowedServices);
  if (
    new Set(signedServices).size !== signedServices.length ||
    signedServices.some((service) => !allowed.has(service))
  ) {
    throw new Error("protected install service allowlist mismatch");
  }
}

export async function activateProtectedBaselineServices({
  signedServices,
  allowedServices,
  adapter,
}) {
  exactServiceSet(signedServices, allowedServices);
  for (const service of signedServices) {
    const baseline = await adapter.capture(service);
    let activated = false;
    try {
      await adapter.activate(service);
      activated = true;
      if ((await adapter.verify(service)) !== true)
        throw new Error(`protected install verification failed for ${service}`);
    } catch (error) {
      if (activated) await adapter.restore(service, baseline);
      throw error;
    }
  }
  return { status: "activated", services: [...signedServices] };
}

export async function reconcileProtectedInstall({
  journal,
  allowedServices,
  restore,
  verify,
  persist,
}) {
  if (journal?.state === "restored") return { status: "restored", idempotent: true };
  exactServiceSet(
    journal.services.map((item) => item.service),
    allowedServices,
  );
  for (const item of [...journal.services].reverse()) {
    if (item.restored === true) continue;
    await restore(item.service);
    if ((await verify(item.service)) !== true)
      throw new Error(`protected install restore failed for ${item.service}`);
    item.restored = true;
    await persist(journal);
  }
  journal.state = "restored";
  await persist(journal);
  return { status: "restored", idempotent: false };
}

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3)
      throw new Error("protected install CLI is invalid");
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value === "" || key in values) throw new Error("protected install CLI is invalid");
    values[key] = value;
  }
  return values;
}

function required(values, key, expected = null) {
  const value = values[key];
  if (typeof value !== "string" || (expected && !expected.test(value))) {
    throw new Error("protected install CLI is invalid");
  }
  return value;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const action = required(
    values,
    "action",
    /^(?:claim-bootstrap-slot|compensate-slot|finalize-slot|inspect-slot|reconcile-loop|validate-host-capability)$/,
  );
  if (action === "validate-host-capability") {
    const allowed = new Set(["action", "target-descriptor-sha256"]);
    if (Object.keys(values).some((key) => !allowed.has(key))) {
      throw new Error("protected install CLI is invalid");
    }
    loadGate6MysqlCapability(required(values, "target-descriptor-sha256", SHA256_PATTERN));
    process.stdout.write('{"ok":true,"status":"host-capability-valid"}\n');
    return;
  }
  if (action === "reconcile-loop") {
    const allowed = new Set(["action", "interval-ms", "lease-duration-ms"]);
    if (Object.keys(values).some((key) => !allowed.has(key))) {
      throw new Error("protected install CLI is invalid");
    }
    const intervalMs = Number(values["interval-ms"] ?? 5_000);
    const leaseDurationMs = Number(values["lease-duration-ms"] ?? 30_000);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) {
      throw new Error("protected install CLI is invalid");
    }
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < intervalMs * 2 ||
      leaseDurationMs > 86_400_000
    ) {
      throw new Error("protected install CLI is invalid");
    }
    let stopped = false;
    process.once("SIGTERM", () => {
      stopped = true;
    });
    process.once("SIGINT", () => {
      stopped = true;
    });
    while (!stopped) {
      await reconcileProtectedInstallHandoffOnce({
        readSlot: ({ targetDescriptorSha256 }) =>
          readGate6SlotWithMysqlClient(targetDescriptorSha256),
        leaseDurationMs,
      });
      if (!stopped) await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
    }
    return;
  }
  const allowed = new Set([
    "action",
    "operation-id",
    "transfer-token-sha256",
    "install-intent-evidence-sha256",
    "protected-install-evidence-sha256",
    "release-sha",
    "target-descriptor-sha256",
    "operator-bundle-sha256",
    "installed-migration-set-sha256",
    "installed-schema-version",
    "intent-heartbeat-at",
    "intent-expires-at",
    "heartbeat-at",
    "expires-at",
    "expected-slot-version",
    "compensated-at",
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) {
    throw new Error("protected install CLI is invalid");
  }
  if (
    action === "claim-bootstrap-slot" &&
    (values["protected-install-evidence-sha256"] !== undefined ||
      values["expected-slot-version"] !== undefined ||
      values["intent-heartbeat-at"] !== undefined ||
      values["intent-expires-at"] !== undefined ||
      values["compensated-at"] !== undefined)
  )
    throw new Error("protected install CLI is invalid");
  if (
    action === "finalize-slot" &&
    (values["protected-install-evidence-sha256"] === undefined ||
      values["expected-slot-version"] === undefined ||
      values["intent-heartbeat-at"] === undefined ||
      values["intent-expires-at"] === undefined ||
      values["compensated-at"] !== undefined)
  )
    throw new Error("protected install CLI is invalid");
  if (
    action === "compensate-slot" &&
    (values["compensated-at"] === undefined ||
      values["protected-install-evidence-sha256"] !== undefined ||
      values["install-intent-evidence-sha256"] !== undefined ||
      values["release-sha"] !== undefined ||
      values["target-descriptor-sha256"] !== undefined ||
      values["operator-bundle-sha256"] !== undefined ||
      values["installed-migration-set-sha256"] !== undefined ||
      values["installed-schema-version"] !== undefined ||
      values["heartbeat-at"] !== undefined ||
      values["expires-at"] !== undefined ||
      values["intent-heartbeat-at"] !== undefined ||
      values["intent-expires-at"] !== undefined)
  )
    throw new Error("protected install CLI is invalid");
  if (
    action === "inspect-slot" &&
    Object.keys(values).some(
      (key) => !["action", "operation-id", "transfer-token-sha256"].includes(key),
    )
  )
    throw new Error("protected install CLI is invalid");
  const configured = mysqlScriptConnectionConfigFromEnv(process.env);
  if (configured.value === null) {
    throw new Error(
      `protected install database configuration is invalid: ${configured.missing.join(",")}`,
    );
  }
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({
    ...configured.value,
    timezone: "Z",
    multipleStatements: false,
  });
  try {
    if (action === "inspect-slot") {
      const result = await inspectProtectedInstallSlot(connection, {
        operationId: required(values, "operation-id", ID_PATTERN),
        transferTokenSha256: required(values, "transfer-token-sha256", SHA256_PATTERN),
      });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
      return;
    }
    if (action === "compensate-slot") {
      const result = await compensateProtectedInstallBootstrapSlot(connection, {
        operationId: required(values, "operation-id", ID_PATTERN),
        transferTokenSha256: required(values, "transfer-token-sha256", SHA256_PATTERN),
        expectedSlotVersion:
          values["expected-slot-version"] === undefined
            ? null
            : Number(required(values, "expected-slot-version", /^\d+$/)),
        compensatedAt: required(values, "compensated-at"),
      });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
      return;
    }
    const common = {
      operationId: required(values, "operation-id", ID_PATTERN),
      transferTokenSha256: required(values, "transfer-token-sha256", SHA256_PATTERN),
      installIntentEvidenceSha256: required(
        values,
        "install-intent-evidence-sha256",
        SHA256_PATTERN,
      ),
      releaseSha: required(values, "release-sha", COMMIT_SHA_PATTERN),
      targetDescriptorSha256: required(values, "target-descriptor-sha256", SHA256_PATTERN),
      operatorBundleSha256: required(values, "operator-bundle-sha256", SHA256_PATTERN),
      installedMigrationSetSha256: required(
        values,
        "installed-migration-set-sha256",
        SHA256_PATTERN,
      ),
      installedSchemaVersion: Number(required(values, "installed-schema-version", /^\d+$/)),
      heartbeatAt: required(values, "heartbeat-at"),
      expiresAt: required(values, "expires-at"),
    };
    const result =
      action === "claim-bootstrap-slot"
        ? await claimProtectedInstallBootstrapSlot(connection, common)
        : await finalizeProtectedInstallGate6Slot(connection, {
            ...common,
            protectedInstallEvidenceSha256: required(
              values,
              "protected-install-evidence-sha256",
              SHA256_PATTERN,
            ),
            expectedSlotVersion: Number(required(values, "expected-slot-version", /^\d+$/)),
            intentHeartbeatAt: required(values, "intent-heartbeat-at"),
            intentExpiresAt: required(values, "intent-expires-at"),
          });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("protected-install-operation-failed");
    process.exitCode = 1;
  });
}
