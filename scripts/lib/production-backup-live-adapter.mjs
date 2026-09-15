import { spawn } from "node:child_process";
import { createHash, randomBytes as systemRandomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";

import { readProductionMutationLock } from "../production-mutation-host-lock.mjs";

export const BACKUP_ROOT = "/var/lib/spx-production-backup";
export const BACKUP_CONTEXT_ROOT = `${BACKUP_ROOT}/context`;
export const BACKUP_CONTEXT_FILE = `${BACKUP_CONTEXT_ROOT}/verified-backup-context.json`;
export const BACKUP_OPERATIONS_ROOT = `${BACKUP_ROOT}/operations`;
export const BACKUP_RUNTIME_ROOT = `${BACKUP_ROOT}/runtime`;
export const BACKUP_PRODUCER_ROOT = `${BACKUP_ROOT}/producer`;
export const BACKUP_EXPORT_ROOT = `${BACKUP_ROOT}/export`;

export const SOURCE_CREDENTIAL_FILE = "/run/credentials/spx-production-backup-source.cnf";
export const KMS_CAPABILITY_FILE = "/run/credentials/spx-production-backup-kms.json";
export const MYSQLDUMP_EXECUTABLE = "/usr/bin/mysqldump";
export const MYSQL_EXECUTABLE = "/usr/bin/mysql";
export const DOCKER_EXECUTABLE = "/usr/bin/docker";
export const KMS_EXECUTABLE = "/usr/local/libexec/spx-kms-envelope";

export const ISOLATED_PASSWORD_FILE = `${BACKUP_RUNTIME_ROOT}/isolated-root-password`;
export const ISOLATED_CLIENT_FILE = `${BACKUP_RUNTIME_ROOT}/isolated-client.cnf`;
export const ACTIVE_OPERATION_FILE = `${BACKUP_RUNTIME_ROOT}/active-operation.json`;
export const ISOLATED_RESTORE_PROJECT_PREFIX = "spx-backup-restore-";

export const INVARIANT_DEFINITIONS_FILE = `${BACKUP_PRODUCER_ROOT}/deploy/production-backup-invariants.json`;
export const ISOLATED_COMPOSE_FILE = `${BACKUP_PRODUCER_ROOT}/deploy/production-backup-isolated-compose.yml`;
export const CONTROLLER_FILE = `${BACKUP_PRODUCER_ROOT}/scripts/production-backup-restore-controller.mjs`;
export const LIVE_ADAPTER_FILE = `${BACKUP_PRODUCER_ROOT}/scripts/lib/production-backup-live-adapter.mjs`;

const HASH = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMAGE = /^mysql@sha256:[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_$.-]{1,128}$/;
const SECRET_VALUE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_ENCRYPTED_BACKUP_BYTES = 16 * 1024 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const QUERY_TIMEOUT_MS = 30 * 1000;
const COMMON_ENV = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: "/nonexistent" });
const ALLOWED_COMMANDS = new Set([
  MYSQLDUMP_EXECUTABLE,
  MYSQL_EXECUTABLE,
  DOCKER_EXECUTABLE,
  KMS_EXECUTABLE,
]);
const CONTEXT_KEYS = Object.freeze([
  "schemaVersion",
  "operationId",
  "candidateSha",
  "releaseManifestSha256",
  "targetDescriptorSha256",
  "databaseFingerprint",
  "createdAt",
  "limits",
  "producer",
  "implementationSha256",
  "sourceCredentialSha256",
  "kmsCapabilitySha256",
  "kmsKeyId",
  "evidenceSigningKeyId",
  "isolatedMysqlImageDigest",
  "executableSha256",
]);
const LIMIT_KEYS = Object.freeze(["maximumAgeMinutes", "maximumRpoMinutes", "maximumRtoMinutes"]);
const PRODUCER_KEYS = Object.freeze([
  "repository",
  "environment",
  "workflow",
  "workflowSha",
  "workflowFileSha256",
]);
const IMPLEMENTATION_KEYS = Object.freeze([
  "controllerSha256",
  "liveAdapterSha256",
  "invariantDefinitionsSha256",
  "isolatedComposeSha256",
]);
const EXECUTABLE_KEYS = Object.freeze(["mysqldump", "mysql", "docker", "kmsEnvelope"]);
const PORT_METHODS = Object.freeze([
  "now",
  "randomBytes",
  "assertSecureDirectory",
  "assertSecureFile",
  "ensurePrivateDirectory",
  "listSecureDirectory",
  "readSecureJson",
  "writeExclusive",
  "removeFile",
  "hashFile",
  "inspectHostLock",
  "run",
  "pipeline",
]);
const CALLER_BOUNDARY_KEYS = new Set([
  "path",
  "root",
  "sql",
  "query",
  "database",
  "schema",
  "service",
  "project",
  "network",
  "volume",
  "command",
  "executable",
  "argv",
  "env",
  "image",
  "credential",
]);

const SOURCE_FINGERPRINT_SQL = [
  "SELECT CONCAT(@@server_uuid, CHAR(9), @@version, CHAR(9), DATABASE())",
].join(" ");
const GATE6_QUIESCENCE_SQL = [
  "SET @spx_gate6_quiescence_sql = IF(",
  "EXISTS (SELECT 1 FROM information_schema.TABLES",
  "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gate6_environment_slots'),",
  "'SELECT CASE WHEN COUNT(*) = 0 THEN ''absent''",
  "WHEN SUM(CASE WHEN state = ''released'' AND uncompensated_work = 0 THEN 0 ELSE 1 END) = 0",
  "THEN ''absent'' ELSE ''busy'' END FROM gate6_environment_slots",
  "WHERE environment = ''production''',",
  "'SELECT ''absent''');",
  "PREPARE spx_gate6_quiescence FROM @spx_gate6_quiescence_sql;",
  "EXECUTE spx_gate6_quiescence;",
  "DEALLOCATE PREPARE spx_gate6_quiescence",
].join(" ");
const ISOLATED_FINGERPRINT_SQL = ["SELECT CONCAT(@@server_uuid, CHAR(9), DATABASE())"].join(" ");
const ISOLATED_SCHEMA_DIGEST_SQL = [
  "SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA",
  "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'SPX'",
  "ORDER BY TABLE_NAME, ORDINAL_POSITION",
].join(" ");
const ISOLATED_FOREIGN_KEY_DIGEST_SQL = [
  "SELECT CONSTRAINT_NAME, TABLE_NAME, REFERENCED_TABLE_NAME, UPDATE_RULE, DELETE_RULE",
  "FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = 'SPX'",
  "ORDER BY CONSTRAINT_NAME, TABLE_NAME",
].join(" ");
const ISOLATED_RUNTIME_OBJECT_DIGEST_SQL = [
  "SELECT 'trigger' AS OBJECT_KIND, TRIGGER_NAME AS OBJECT_NAME, EVENT_MANIPULATION AS OBJECT_TYPE, EVENT_OBJECT_TABLE AS OBJECT_TARGET, ACTION_TIMING AS OBJECT_STATE",
  "FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = 'SPX'",
  "UNION ALL",
  "SELECT 'routine' AS OBJECT_KIND, ROUTINE_NAME AS OBJECT_NAME, ROUTINE_TYPE AS OBJECT_TYPE, COALESCE(DATA_TYPE, '') AS OBJECT_TARGET, SECURITY_TYPE AS OBJECT_STATE",
  "FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = 'SPX'",
  "UNION ALL",
  "SELECT 'event' AS OBJECT_KIND, EVENT_NAME AS OBJECT_NAME, 'EVENT' AS OBJECT_TYPE, COALESCE(EVENT_TYPE, '') AS OBJECT_TARGET, STATUS AS OBJECT_STATE",
  "FROM information_schema.EVENTS WHERE EVENT_SCHEMA = 'SPX'",
  "ORDER BY OBJECT_KIND, OBJECT_NAME",
].join(" ");
const ISOLATED_ROW_COUNT_SQL = [
  "SELECT TABLE_NAME, COALESCE(TABLE_ROWS, 0)",
  "FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'SPX' AND TABLE_TYPE = 'BASE TABLE'",
  "ORDER BY TABLE_NAME",
].join(" ");
const INVARIANT_QUERIES = Object.freeze([
  ["schema-shape", ISOLATED_SCHEMA_DIGEST_SQL],
  ["foreign-key-shape", ISOLATED_FOREIGN_KEY_DIGEST_SQL],
  ["runtime-object-shape", ISOLATED_RUNTIME_OBJECT_DIGEST_SQL],
]);

function fail(code) {
  throw new Error(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, code = "production-backup-context-invalid") {
  if (!isObject(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function assertHash(value, code = "production-backup-context-invalid") {
  if (typeof value !== "string" || !HASH.test(value) || /^0{64}$/.test(value)) fail(code);
}

function assertIso(value, code = "production-backup-context-invalid") {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
}

function assertSignatureBase64(value) {
  if (typeof value !== "string" || value.length > 16_384 || !SIGNATURE.test(value)) {
    fail("production-backup-signature-invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 16 || bytes.toString("base64") !== value) {
    fail("production-backup-signature-invalid");
  }
  const decodedText = bytes.toString("utf8");
  if (
    !decodedText.includes("\uFFFD") &&
    SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(decodedText))
  ) {
    fail("production-backup-signature-secret-shaped");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeQueryOutput(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || value.length > MAX_FILE_BYTES || value.includes("\0")) {
    fail(`production-backup-${label}-invalid`);
  }
  const normalized = value.replaceAll("\r\n", "\n").replace(/\n+$/, "");
  if (normalized.includes("\r") || (!allowEmpty && normalized.length === 0)) {
    fail(`production-backup-${label}-invalid`);
  }
  return normalized;
}

function bindAuthenticatedSourceIdentity(value, context) {
  const normalized = normalizeQueryOutput(value, "source-identity", { allowEmpty: false });
  const fields = normalized.split("\t");
  if (
    fields.length !== 3 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      fields[0] ?? "",
    ) ||
    !/^[0-9A-Za-z._+-]{1,128}$/.test(fields[1] ?? "") ||
    fields[2] !== "SPX"
  ) {
    fail("production-backup-source-identity-invalid");
  }
  return sha256(
    canonicalJson({
      databaseFingerprint: context.databaseFingerprint,
      sourceIdentitySha256: sha256(normalized),
      targetDescriptorSha256: context.targetDescriptorSha256,
    }),
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function validateVerifiedBackupContext(input) {
  assertExactKeys(input, CONTEXT_KEYS);
  if (
    input.schemaVersion !== 1 ||
    !OPERATION_ID.test(input.operationId ?? "") ||
    !COMMIT.test(input.candidateSha ?? "") ||
    !DIGEST.test(input.databaseFingerprint ?? "") ||
    !KEY_ID.test(input.kmsKeyId ?? "") ||
    !KEY_ID.test(input.evidenceSigningKeyId ?? "") ||
    !IMAGE.test(input.isolatedMysqlImageDigest ?? "")
  )
    fail("production-backup-context-invalid");
  assertHash(input.releaseManifestSha256);
  assertHash(input.targetDescriptorSha256);
  assertHash(input.sourceCredentialSha256);
  assertHash(input.kmsCapabilitySha256);
  assertIso(input.createdAt);

  assertExactKeys(input.limits, LIMIT_KEYS);
  for (const key of LIMIT_KEYS) {
    const value = input.limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > 1440) {
      fail("production-backup-context-invalid");
    }
  }

  assertExactKeys(input.producer, PRODUCER_KEYS);
  assertExactKeys(input.implementationSha256, IMPLEMENTATION_KEYS);
  if (
    input.producer.repository !== "fastest4u/SPX" ||
    input.producer.environment !== "production" ||
    input.producer.workflow !== ".github/workflows/trusted-production-backup-restore.yml" ||
    !COMMIT.test(input.producer.workflowSha ?? "")
  )
    fail("production-backup-context-invalid");
  for (const key of PRODUCER_KEYS.slice(4)) assertHash(input.producer[key]);
  for (const key of IMPLEMENTATION_KEYS) assertHash(input.implementationSha256[key]);

  assertExactKeys(input.executableSha256, EXECUTABLE_KEYS);
  for (const key of EXECUTABLE_KEYS) assertHash(input.executableSha256[key]);

  return deepFreeze(structuredClone(input));
}

function assertNoCallerBoundaryOverrides(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) fail("production-backup-caller-override-rejected");
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (CALLER_BOUNDARY_KEYS.has(key.toLowerCase())) {
      fail("production-backup-caller-override-rejected");
    }
    assertNoCallerBoundaryOverrides(nested, seen);
  }
  seen.delete(value);
}

function resources(operationId) {
  if (!OPERATION_ID.test(operationId ?? "")) fail("production-backup-operation-invalid");
  const project = `${ISOLATED_RESTORE_PROJECT_PREFIX}${operationId}`;
  return Object.freeze({
    operationId,
    project,
    network: `${project}-internal`,
    volume: `${project}-data`,
    operationRoot: `${BACKUP_OPERATIONS_ROOT}/${operationId}`,
    journalRoot: `${BACKUP_OPERATIONS_ROOT}/${operationId}/journal`,
    encryptedBackupPath: `${BACKUP_OPERATIONS_ROOT}/${operationId}/encrypted-backup.bin`,
    encryptionMetadataPath: `${BACKUP_OPERATIONS_ROOT}/${operationId}/encryption-metadata.json`,
  });
}

function activeOperationRecord(input) {
  const identity = {
    candidateSha: input.candidateSha,
    operationId: input.operationId,
    targetDescriptorSha256: input.targetDescriptorSha256,
  };
  return Object.freeze({
    schemaVersion: 1,
    operationId: input.operationId,
    candidateSha: input.candidateSha,
    targetDescriptorSha256: input.targetDescriptorSha256,
    operationIdentitySha256: sha256(canonicalJson(identity)),
  });
}

function fixedComposeEnvironment(context, identity) {
  return Object.freeze({
    ...COMMON_ENV,
    SPX_BACKUP_ISOLATED_MYSQL_IMAGE: context.isolatedMysqlImageDigest,
    SPX_BACKUP_ISOLATED_NETWORK: identity.network,
    SPX_BACKUP_ISOLATED_VOLUME: identity.volume,
  });
}

function composePrefix(identity) {
  return ["compose", "-p", identity.project, "-f", ISOLATED_COMPOSE_FILE];
}

function sourceMysqlArgv(sql) {
  return [
    `--defaults-extra-file=${SOURCE_CREDENTIAL_FILE}`,
    "--ssl-mode=VERIFY_IDENTITY",
    "--batch",
    "--skip-column-names",
    "--raw",
    `--execute=${sql}`,
    "SPX",
  ];
}

function isolatedMysqlArgv(identity, sql = undefined) {
  const argv = [
    ...composePrefix(identity),
    "exec",
    "-T",
    "isolated-mysql",
    "mysql",
    "--defaults-extra-file=/run/secrets/isolated-client.cnf",
  ];
  if (sql !== undefined) argv.push("--batch", "--skip-column-names", "--raw", `--execute=${sql}`);
  argv.push("SPX");
  return argv;
}

async function secureReadBytes(path, options = {}) {
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0n ||
    before.size > BigInt(options.maxBytes ?? MAX_FILE_BYTES) ||
    (process.platform !== "win32" &&
      options.mode !== undefined &&
      Number(before.mode & 0o777n) !== options.mode) ||
    (process.platform !== "win32" && before.uid !== 0n)
  )
    fail("production-backup-secure-file-invalid");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      fail("production-backup-secure-file-invalid");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    )
      fail("production-backup-secure-file-changed");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function secureHashFile(path, options = {}) {
  const before = await lstat(path, { bigint: true });
  const maximum = BigInt(options.maxBytes ?? MAX_FILE_BYTES);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0n ||
    before.size > maximum ||
    (process.platform !== "win32" && before.uid !== 0n) ||
    (process.platform !== "win32" &&
      options.mode !== undefined &&
      Number(before.mode & 0o777n) !== options.mode) ||
    (process.platform !== "win32" &&
      options.mode === undefined &&
      Number(before.mode & 0o022n) !== 0) ||
    (process.platform !== "win32" &&
      options.requireExecutable === true &&
      Number(before.mode & 0o111n) === 0)
  ) {
    fail("production-backup-secure-file-invalid");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      fail("production-backup-secure-file-invalid");
    }
    const digest = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      fail("production-backup-secure-file-changed");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function collectBounded(stream, maximum = MAX_FILE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    stream.on("data", (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > maximum) {
        const error = new Error("production-backup-process-output-exceeded");
        rejectOnce(error);
        stream.destroy(error);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", rejectOnce);
  });
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let spawnError;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      spawnError = error;
      child.kill("SIGKILL");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error("production-backup-process-timeout"));
        return;
      }
      if (spawnError) {
        reject(new Error("production-backup-process-failed"));
        return;
      }
      if (code !== 0 || signal) {
        reject(new Error("production-backup-process-failed"));
        return;
      }
      resolve({ exitCode: code });
    });
  });
}

function sanitizedProcessFailure(error) {
  if (error instanceof Error && /^production-backup-process-/.test(error.message)) return error;
  return new Error("production-backup-process-failed");
}

function spawnProcess(spec, stdio) {
  if (!ALLOWED_COMMANDS.has(spec.command) || !Array.isArray(spec.argv)) {
    fail("production-backup-process-boundary-invalid");
  }
  return spawn(spec.command, spec.argv, {
    shell: false,
    cwd: "/",
    windowsHide: true,
    env: { ...spec.env },
    stdio,
  });
}

function createSystemPort() {
  return Object.freeze({
    now() {
      return new Date();
    },
    randomBytes(size) {
      return systemRandomBytes(size);
    },
    async assertSecureDirectory({ path, mode = 0o700 }) {
      const status = await lstat(path, { bigint: true });
      if (
        status.isSymbolicLink() ||
        !status.isDirectory() ||
        (process.platform !== "win32" && status.uid !== 0n) ||
        (process.platform !== "win32" && Number(status.mode & 0o777n) !== mode)
      )
        fail("production-backup-secure-directory-invalid");
    },
    async assertSecureFile(spec) {
      const digest = await secureHashFile(spec.path, spec);
      if (spec.sha256 !== undefined && digest !== spec.sha256) {
        fail("production-backup-secure-file-digest-mismatch");
      }
    },
    async ensurePrivateDirectory({ path }) {
      try {
        await mkdir(path, { mode: 0o700 });
        await syncDirectory(dirname(path));
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const status = await lstat(path, { bigint: true });
      if (
        status.isSymbolicLink() ||
        !status.isDirectory() ||
        (process.platform !== "win32" && status.uid !== 0n) ||
        (process.platform !== "win32" && Number(status.mode & 0o777n) !== 0o700)
      )
        fail("production-backup-secure-directory-invalid");
    },
    async listSecureDirectory(path) {
      const status = await lstat(path, { bigint: true });
      if (
        status.isSymbolicLink() ||
        !status.isDirectory() ||
        (process.platform !== "win32" && status.uid !== 0n) ||
        (process.platform !== "win32" && Number(status.mode & 0o777n) !== 0o700)
      ) {
        fail("production-backup-secure-directory-invalid");
      }
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some((entry) => !entry.isFile())) fail("production-backup-journal-invalid");
      return entries.map((entry) => entry.name).sort();
    },
    async readSecureJson({ path, allowMissing = false, mode = 0o400, maxBytes = MAX_FILE_BYTES }) {
      try {
        const bytes = await secureReadBytes(path, { mode, maxBytes });
        return JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        if (allowMissing && error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async writeExclusive({ path, bytes, mode = 0o400 }) {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        mode,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(path));
    },
    async removeFile({ path, allowMissing = true }) {
      try {
        const status = await lstat(path, { bigint: true });
        if (status.isSymbolicLink() || !status.isFile())
          fail("production-backup-secure-file-invalid");
        await unlink(path);
        await syncDirectory(dirname(path));
      } catch (error) {
        if (allowMissing && error?.code === "ENOENT") return;
        throw error;
      }
    },
    async hashFile(path) {
      return secureHashFile(path, { maxBytes: MAX_ENCRYPTED_BACKUP_BYTES });
    },
    async inspectHostLock() {
      try {
        await lstat("/var/lib/spx-production-mutation");
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      return readProductionMutationLock({ allowMissing: true });
    },
    async run(spec) {
      const child = spawnProcess(spec, ["ignore", "pipe", "pipe"]);
      const stdout = collectBounded(child.stdout, spec.maxOutputBytes ?? MAX_FILE_BYTES);
      const stderr = collectBounded(child.stderr, 64 * 1024);
      const closed = waitForClose(child, spec.timeoutMs);
      const pending = [closed, stdout, stderr];
      try {
        const [, output] = await Promise.all(pending);
        return { stdout: output };
      } catch (error) {
        child.kill("SIGKILL");
        await Promise.allSettled(pending);
        throw sanitizedProcessFailure(error);
      }
    },
    async pipeline(spec) {
      const source = spawnProcess(spec.source, ["ignore", "pipe", "pipe"]);
      const sink = spawnProcess(spec.sink, ["pipe", "ignore", "pipe"]);
      const sourceError = collectBounded(source.stderr, 64 * 1024);
      const sinkError = collectBounded(sink.stderr, 64 * 1024);
      const timeoutMs = spec.timeoutMs ?? PROCESS_TIMEOUT_MS;
      const transferred = streamPipeline(source.stdout, sink.stdin);
      const sourceClosed = waitForClose(source, timeoutMs);
      const sinkClosed = waitForClose(sink, timeoutMs);
      const pending = [sourceClosed, sinkClosed, transferred, sourceError, sinkError];
      try {
        await Promise.all(pending);
      } catch (error) {
        source.kill("SIGKILL");
        sink.kill("SIGKILL");
        source.stdout.destroy();
        sink.stdin.destroy();
        await Promise.allSettled(pending);
        throw sanitizedProcessFailure(error);
      }
      return { sourceExitCode: 0, sinkExitCode: 0 };
    },
  });
}

function selectPort(testPort) {
  if (testPort === undefined) return createSystemPort();
  if (process.env.NODE_ENV !== "test") fail("production-backup-test-port-injection-forbidden");
  if (
    !isObject(testPort) ||
    PORT_METHODS.some((method) => typeof testPort[method] !== "function")
  ) {
    fail("production-backup-test-port-invalid");
  }
  return testPort;
}

export async function loadVerifiedBackupContext() {
  const port = createSystemPort();
  await port.assertSecureDirectory({ path: BACKUP_ROOT, mode: 0o700 });
  await port.assertSecureDirectory({ path: BACKUP_CONTEXT_ROOT, mode: 0o700 });
  const value = await port.readSecureJson({
    path: BACKUP_CONTEXT_FILE,
    mode: 0o400,
    maxBytes: 128 * 1024,
  });
  return validateVerifiedBackupContext(value);
}

export function createProductionBackupLiveAdapter(contextInput, testPort = undefined) {
  const context = validateVerifiedBackupContext(contextInput);
  const port = selectPort(testPort);
  const identity = resources(context.operationId);
  let initialized;
  let journalSequence = 0;
  let teardownComplete = false;
  let postTeardownQuiescence = false;
  let activeOperationPersisted = false;
  let sourceIdentityBindingSha256;
  let sourceInvariantSnapshot;
  let completedBackupBinding;
  let operationFinalized = false;

  async function recordPhase(phase, hashes = {}) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(phase)) fail("production-backup-journal-invalid");
    for (const [key, value] of Object.entries(hashes)) {
      if (!/^[a-z][A-Za-z0-9]*Sha256$/.test(key) || !HASH.test(value ?? "")) {
        fail("production-backup-journal-invalid");
      }
    }
    journalSequence += 1;
    const nonce = port.randomBytes(8).toString("hex");
    const record = {
      schemaVersion: 1,
      operationId: context.operationId,
      sequence: journalSequence,
      phase,
      hashes: Object.fromEntries(
        Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
      ),
      recordedAt: port.now().toISOString(),
    };
    await port.writeExclusive({
      path: `${identity.journalRoot}/${String(journalSequence).padStart(4, "0")}-${nonce}-${phase}.json`,
      bytes: Buffer.from(`${canonicalJson(record)}\n`, "utf8"),
      mode: 0o400,
    });
  }

  async function ensureInitialized() {
    if (!initialized) {
      initialized = (async () => {
        for (const path of [
          BACKUP_ROOT,
          BACKUP_CONTEXT_ROOT,
          BACKUP_OPERATIONS_ROOT,
          BACKUP_RUNTIME_ROOT,
        ]) {
          await port.assertSecureDirectory({ path, mode: 0o700 });
        }
        await port.ensurePrivateDirectory({ path: identity.operationRoot, mode: 0o700 });
        await port.ensurePrivateDirectory({ path: identity.journalRoot, mode: 0o700 });
        const journalEntries = await port.listSecureDirectory(identity.journalRoot);
        for (const name of journalEntries) {
          const match = /^(\d{4})-[0-9a-f]{16}-[a-z][a-z0-9-]{2,63}\.json$/.exec(name);
          if (!match) fail("production-backup-journal-invalid");
          journalSequence = Math.max(journalSequence, Number(match[1]));
        }
        if (journalSequence >= 9999) fail("production-backup-journal-exhausted");
        await port.assertSecureFile({
          path: SOURCE_CREDENTIAL_FILE,
          mode: 0o400,
          sha256: context.sourceCredentialSha256,
        });
        await port.assertSecureFile({
          path: KMS_CAPABILITY_FILE,
          mode: 0o400,
          sha256: context.kmsCapabilitySha256,
        });
        for (const [path, digest] of [
          [MYSQLDUMP_EXECUTABLE, context.executableSha256.mysqldump],
          [MYSQL_EXECUTABLE, context.executableSha256.mysql],
          [DOCKER_EXECUTABLE, context.executableSha256.docker],
          [KMS_EXECUTABLE, context.executableSha256.kmsEnvelope],
        ]) {
          await port.assertSecureFile({
            path,
            sha256: digest,
            requireExecutable: true,
            maxBytes: MAX_EXECUTABLE_BYTES,
          });
        }
        await port.assertSecureFile({
          path: CONTROLLER_FILE,
          sha256: context.implementationSha256.controllerSha256,
        });
        await port.assertSecureFile({
          path: LIVE_ADAPTER_FILE,
          sha256: context.implementationSha256.liveAdapterSha256,
        });
        await port.assertSecureFile({
          path: INVARIANT_DEFINITIONS_FILE,
          sha256: context.implementationSha256.invariantDefinitionsSha256,
        });
        await port.assertSecureFile({
          path: ISOLATED_COMPOSE_FILE,
          sha256: context.implementationSha256.isolatedComposeSha256,
        });
        await recordPhase("adapter-initialized", {
          liveAdapterSha256: context.implementationSha256.liveAdapterSha256,
          invariantDefinitionsSha256: context.implementationSha256.invariantDefinitionsSha256,
          isolatedComposeSha256: context.implementationSha256.isolatedComposeSha256,
        });
      })();
    }
    return initialized;
  }

  function processSpec(command, argv, options = {}) {
    return Object.freeze({
      command,
      argv: Object.freeze([...argv]),
      env: Object.freeze({ ...(options.env ?? COMMON_ENV) }),
      timeoutMs: options.timeoutMs ?? QUERY_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? MAX_FILE_BYTES,
      shell: false,
    });
  }

  function composeSpec(operationIdentity, argv, options = {}) {
    return processSpec(DOCKER_EXECUTABLE, [...composePrefix(operationIdentity), ...argv], {
      ...options,
      env: fixedComposeEnvironment(context, operationIdentity),
    });
  }

  async function runSourceQuery(sql) {
    const result = await port.run(processSpec(MYSQL_EXECUTABLE, sourceMysqlArgv(sql)));
    if (typeof result?.stdout !== "string") fail("production-backup-source-query-invalid");
    return result.stdout;
  }

  async function captureSourceInvariantSnapshot() {
    const results = [];
    for (const [id, sql] of INVARIANT_QUERIES) {
      const normalized = normalizeQueryOutput(await runSourceQuery(sql), "source-invariant");
      results.push(Object.freeze({ id, resultSha256: sha256(normalized) }));
    }
    return deepFreeze(results);
  }

  async function persistActiveOperation() {
    if (activeOperationPersisted) return activeOperationRecord(context);
    const activeOperation = activeOperationRecord(context);
    await port.writeExclusive({
      path: ACTIVE_OPERATION_FILE,
      bytes: Buffer.from(`${canonicalJson(activeOperation)}\n`, "utf8"),
      mode: 0o400,
    });
    activeOperationPersisted = true;
    await recordPhase("backup-output-armed", {
      operationIdentitySha256: activeOperation.operationIdentitySha256,
    });
    return activeOperation;
  }

  async function runIsolatedQuery(sql) {
    const result = await port.run(
      processSpec(DOCKER_EXECUTABLE, isolatedMysqlArgv(identity, sql), {
        env: fixedComposeEnvironment(context, identity),
      }),
    );
    if (typeof result?.stdout !== "string") {
      fail("production-backup-isolated-query-invalid");
    }
    return result.stdout;
  }

  async function teardownResources(operationIdentity, { mode }) {
    if (!new Set(["abandoned", "normal"]).has(mode)) {
      fail("production-backup-teardown-mode-invalid");
    }
    try {
      await port.run(
        composeSpec(
          operationIdentity,
          ["down", "--volumes", "--remove-orphans", "--timeout", "15"],
          { timeoutMs: PROCESS_TIMEOUT_MS },
        ),
      );
    } catch {
      fail("production-backup-isolated-teardown-failed");
    }
    const credentialErrors = [];
    for (const path of [ISOLATED_CLIENT_FILE, ISOLATED_PASSWORD_FILE]) {
      try {
        await port.removeFile({ path, allowMissing: true, requireRegular: true });
      } catch (error) {
        credentialErrors.push(error);
      }
    }
    if (credentialErrors.length > 0) fail("production-backup-isolated-teardown-failed");
    if (mode === "abandoned") {
      const outputErrors = [];
      for (const path of [
        operationIdentity.encryptedBackupPath,
        operationIdentity.encryptionMetadataPath,
      ]) {
        try {
          await port.removeFile({ path, allowMissing: true, requireRegular: true });
        } catch (error) {
          outputErrors.push(error);
        }
      }
      if (outputErrors.length > 0) fail("production-backup-isolated-teardown-failed");
      try {
        await port.removeFile({
          path: ACTIVE_OPERATION_FILE,
          allowMissing: true,
          requireRegular: true,
        });
      } catch {
        fail("production-backup-isolated-teardown-failed");
      }
    }
  }

  return Object.freeze({
    async recoverAbandonedOperation() {
      await ensureInitialized();
      const active = await port.readSecureJson({
        path: ACTIVE_OPERATION_FILE,
        allowMissing: true,
        mode: 0o400,
        maxBytes: 8 * 1024,
      });
      if (active === null) return Object.freeze({ recovered: false });
      assertExactKeys(
        active,
        [
          "schemaVersion",
          "operationId",
          "candidateSha",
          "targetDescriptorSha256",
          "operationIdentitySha256",
        ],
        "production-backup-recovery-record-invalid",
      );
      if (
        active.schemaVersion !== 1 ||
        !OPERATION_ID.test(active.operationId ?? "") ||
        !COMMIT.test(active.candidateSha ?? "") ||
        !HASH.test(active.targetDescriptorSha256 ?? "") ||
        !HASH.test(active.operationIdentitySha256 ?? "") ||
        activeOperationRecord(active).operationIdentitySha256 !== active.operationIdentitySha256
      )
        fail("production-backup-recovery-record-invalid");
      const abandoned = resources(active.operationId);
      await teardownResources(abandoned, { mode: "abandoned" });
      await recordPhase("abandoned-operation-recovered", {
        operationIdentitySha256: active.operationIdentitySha256,
      });
      return Object.freeze({
        recovered: true,
        operationIdentitySha256: active.operationIdentitySha256,
      });
    },

    async assertMutationQuiescent(phase) {
      await ensureInitialized();
      if (!new Set(["before-capture", "after-teardown"]).has(phase)) {
        fail("production-backup-quiescence-phase-invalid");
      }
      const hostLock = await port.inspectHostLock();
      const hostSafe = hostLock === null || hostLock?.state === "terminal";
      const gate6 = await port.run(
        processSpec(MYSQL_EXECUTABLE, sourceMysqlArgv(GATE6_QUIESCENCE_SQL)),
      );
      if (!hostSafe || gate6?.stdout?.trim() !== "absent") {
        fail("production-backup-mutation-not-quiescent");
      }
      const observedAt = port.now().toISOString();
      const core = {
        phase,
        observedAt,
        hostLockState: "absent",
        gate6DatabaseSlotState: "absent",
      };
      const observationSha256 = sha256(canonicalJson(core));
      await recordPhase(`${phase}-quiescent`, { observationSha256 });
      if (phase === "after-teardown") postTeardownQuiescence = true;
      return deepFreeze({ ...core, observationSha256 });
    },

    async readProductionFingerprint() {
      await ensureInitialized();
      const probe = await runSourceQuery(SOURCE_FINGERPRINT_SQL);
      sourceIdentityBindingSha256 = bindAuthenticatedSourceIdentity(probe, context);
      const capturedAt = port.now().toISOString();
      await recordPhase("production-fingerprint-captured", {
        fingerprintProbeSha256: sourceIdentityBindingSha256,
      });
      return Object.freeze({ databaseFingerprint: context.databaseFingerprint, capturedAt });
    },

    async createEncryptedBackup(input = {}) {
      assertNoCallerBoundaryOverrides(input);
      await ensureInitialized();
      if (input?.context !== undefined && canonicalJson(input.context) !== canonicalJson(context))
        fail("production-backup-context-binding-mismatch");
      if (
        input?.productionFingerprint !== undefined &&
        input.productionFingerprint.databaseFingerprint !== context.databaseFingerprint
      )
        fail("production-backup-fingerprint-binding-mismatch");
      if (!HASH.test(sourceIdentityBindingSha256 ?? "")) {
        fail("production-backup-source-identity-missing");
      }
      const sourceBefore = await captureSourceInvariantSnapshot();
      await persistActiveOperation();
      await port.pipeline({
        source: processSpec(
          MYSQLDUMP_EXECUTABLE,
          [
            `--defaults-extra-file=${SOURCE_CREDENTIAL_FILE}`,
            "--single-transaction",
            "--quick",
            "--hex-blob",
            "--routines",
            "--triggers",
            "--events",
            "--no-tablespaces",
            "--set-gtid-purged=OFF",
            "--skip-comments",
            "SPX",
          ],
          { timeoutMs: PROCESS_TIMEOUT_MS },
        ),
        sink: processSpec(
          KMS_EXECUTABLE,
          [
            "encrypt",
            "--capability-file",
            KMS_CAPABILITY_FILE,
            "--key-id",
            context.kmsKeyId,
            "--release-sha",
            context.candidateSha,
            "--database-fingerprint",
            context.databaseFingerprint,
            "--ciphertext-output",
            identity.encryptedBackupPath,
            "--metadata-output",
            identity.encryptionMetadataPath,
          ],
          { timeoutMs: PROCESS_TIMEOUT_MS },
        ),
        timeoutMs: PROCESS_TIMEOUT_MS,
        plaintextFile: false,
      });
      const sourceIdentityAfter = bindAuthenticatedSourceIdentity(
        await runSourceQuery(SOURCE_FINGERPRINT_SQL),
        context,
      );
      if (sourceIdentityAfter !== sourceIdentityBindingSha256) {
        fail("production-backup-source-identity-changed");
      }
      const sourceAfter = await captureSourceInvariantSnapshot();
      if (canonicalJson(sourceBefore) !== canonicalJson(sourceAfter)) {
        fail("production-backup-source-invariant-changed");
      }
      sourceInvariantSnapshot = sourceBefore;
      const backupSha256 = await port.hashFile(identity.encryptedBackupPath);
      const encryptionMetadataSha256 = await port.hashFile(identity.encryptionMetadataPath);
      assertHash(backupSha256, "production-backup-encrypted-output-invalid");
      assertHash(encryptionMetadataSha256, "production-backup-encrypted-output-invalid");
      const createdAt = port.now().toISOString();
      await recordPhase("encrypted-backup-created", { backupSha256, encryptionMetadataSha256 });
      completedBackupBinding = Object.freeze({ backupSha256, encryptionMetadataSha256 });
      return Object.freeze({
        backupSha256,
        encryptionMetadataSha256,
        createdAt,
        encrypted: true,
        beforeDdl: true,
        databaseFingerprint: context.databaseFingerprint,
      });
    },

    async startIsolatedRestore(input = {}) {
      assertNoCallerBoundaryOverrides(input);
      await ensureInitialized();
      teardownComplete = false;
      postTeardownQuiescence = false;
      if (!activeOperationPersisted || !sourceInvariantSnapshot) {
        fail("production-backup-output-not-armed");
      }
      const activeOperation = activeOperationRecord(context);
      const password = port.randomBytes(48).toString("base64url");
      if (password.length < 48) fail("production-backup-isolated-credential-invalid");
      await port.writeExclusive({
        path: ISOLATED_PASSWORD_FILE,
        bytes: Buffer.from(password, "utf8"),
        mode: 0o400,
      });
      await port.writeExclusive({
        path: ISOLATED_CLIENT_FILE,
        bytes: Buffer.from(`[client]\nuser=root\npassword=${password}\nprotocol=socket\n`, "utf8"),
        mode: 0o400,
      });
      await port.run(
        composeSpec(
          identity,
          ["up", "--detach", "--wait", "--no-build", "--pull", "never", "isolated-mysql"],
          { timeoutMs: PROCESS_TIMEOUT_MS },
        ),
      );
      await recordPhase("isolated-restore-started", {
        operationIdentitySha256: activeOperation.operationIdentitySha256,
      });
      return Object.freeze({
        environment: "isolated",
        productionRoutesPresent: false,
        providerCredentialsPresent: false,
        backgroundServicesPresent: false,
        sharedWritableVolumesPresent: false,
      });
    },

    async restoreBackup(input = {}) {
      assertNoCallerBoundaryOverrides(input);
      await ensureInitialized();
      await port.pipeline({
        source: processSpec(
          KMS_EXECUTABLE,
          [
            "decrypt",
            "--capability-file",
            KMS_CAPABILITY_FILE,
            "--key-id",
            context.kmsKeyId,
            "--release-sha",
            context.candidateSha,
            "--database-fingerprint",
            context.databaseFingerprint,
            "--input",
            identity.encryptedBackupPath,
          ],
          { timeoutMs: PROCESS_TIMEOUT_MS },
        ),
        sink: processSpec(DOCKER_EXECUTABLE, isolatedMysqlArgv(identity), {
          env: fixedComposeEnvironment(context, identity),
          timeoutMs: PROCESS_TIMEOUT_MS,
        }),
        timeoutMs: PROCESS_TIMEOUT_MS,
        plaintextFile: false,
      });
      const isolatedProbe = normalizeQueryOutput(
        await runIsolatedQuery(ISOLATED_FINGERPRINT_SQL),
        "isolated-identity",
        { allowEmpty: false },
      );
      const databaseFingerprint = `sha256:${sha256(isolatedProbe)}`;
      if (databaseFingerprint === context.databaseFingerprint) {
        fail("production-backup-isolated-fingerprint-conflict");
      }
      const restoredSchemaSha256 = sha256(
        normalizeQueryOutput(
          await runIsolatedQuery(ISOLATED_SCHEMA_DIGEST_SQL),
          "isolated-invariant",
        ),
      );
      await recordPhase("encrypted-backup-restored", { restoredSchemaSha256 });
      return Object.freeze({ databaseFingerprint, restoredSchemaSha256 });
    },

    async verifyFixedInvariants(input = {}) {
      assertNoCallerBoundaryOverrides(input);
      await ensureInitialized();
      if (!sourceInvariantSnapshot) fail("production-backup-source-invariant-missing");
      const results = [];
      for (let index = 0; index < INVARIANT_QUERIES.length; index += 1) {
        const [id, sql] = INVARIANT_QUERIES[index];
        const source = sourceInvariantSnapshot[index];
        if (source?.id !== id) fail("production-backup-source-invariant-invalid");
        const isolatedResultSha256 = sha256(
          normalizeQueryOutput(await runIsolatedQuery(sql), "isolated-invariant"),
        );
        if (isolatedResultSha256 !== source.resultSha256) {
          fail("production-backup-isolated-invariant-mismatch");
        }
        results.push({
          id,
          sourceResultSha256: source.resultSha256,
          isolatedResultSha256,
        });
      }
      const invariantResultsSha256 = sha256(canonicalJson(results));
      await recordPhase("fixed-invariants-verified", {
        invariantDefinitionsSha256: context.implementationSha256.invariantDefinitionsSha256,
        invariantResultsSha256,
      });
      return Object.freeze({
        invariantDefinitionsSha256: context.implementationSha256.invariantDefinitionsSha256,
        invariantResultsSha256,
      });
    },

    async captureSanitizedRowCountDigest(input = {}) {
      assertNoCallerBoundaryOverrides(input);
      await ensureInitialized();
      const raw = await runIsolatedQuery(ISOLATED_ROW_COUNT_SQL);
      const normalized = raw
        .trim()
        .split("\n")
        .map((line) => line.replace(/\r$/, "").split("\t"))
        .map(([identifier, count, ...rest]) => {
          if (
            rest.length > 0 ||
            !SAFE_IDENTIFIER.test(identifier ?? "") ||
            !/^\d+$/.test(count ?? "")
          ) {
            fail("production-backup-row-count-result-invalid");
          }
          return `${identifier}\t${BigInt(count).toString()}`;
        })
        .sort();
      const rowCountDigestSha256 = sha256(canonicalJson(normalized));
      await recordPhase("row-count-digest-captured", { rowCountDigestSha256 });
      return Object.freeze({ rowCountDigestSha256 });
    },

    async destroyIsolatedRestore(input = {}) {
      assertNoCallerBoundaryOverrides(input);
      await ensureInitialized();
      const mode = completedBackupBinding ? "normal" : "abandoned";
      await teardownResources(identity, { mode });
      if (mode === "abandoned") activeOperationPersisted = false;
      teardownComplete = true;
      const destroyedAt = port.now().toISOString();
      await recordPhase("isolated-restore-destroyed", {
        teardownProofSha256: sha256(
          canonicalJson({
            operationId: context.operationId,
            project: identity.project,
            destroyedAt,
          }),
        ),
      });
      return Object.freeze({ teardownProven: true, destroyedAt });
    },

    async signEvidenceCore(core) {
      assertNoCallerBoundaryOverrides(core);
      await ensureInitialized();
      if (!teardownComplete || !postTeardownQuiescence) {
        fail("production-backup-signing-before-teardown-forbidden");
      }
      if (!isObject(core)) fail("production-backup-evidence-core-invalid");
      if (
        operationFinalized ||
        !activeOperationPersisted ||
        !completedBackupBinding ||
        !HASH.test(core.backupSha256 ?? "") ||
        !HASH.test(core.encryptionMetadataSha256 ?? "")
      ) {
        fail("production-backup-retained-hash-binding-invalid");
      }
      const retainedBackupSha256 = await port.hashFile(identity.encryptedBackupPath);
      const retainedEncryptionMetadataSha256 = await port.hashFile(identity.encryptionMetadataPath);
      if (
        retainedBackupSha256 !== completedBackupBinding.backupSha256 ||
        retainedEncryptionMetadataSha256 !== completedBackupBinding.encryptionMetadataSha256 ||
        core.backupSha256 !== retainedBackupSha256 ||
        core.encryptionMetadataSha256 !== retainedEncryptionMetadataSha256
      ) {
        fail("production-backup-retained-hash-binding-invalid");
      }
      const subjectSha256 = sha256(canonicalJson(core));
      const signed = await port.run(
        processSpec(KMS_EXECUTABLE, [
          "sign",
          "--capability-file",
          KMS_CAPABILITY_FILE,
          "--key-id",
          context.evidenceSigningKeyId,
          "--subject-sha256",
          subjectSha256,
        ]),
      );
      let signatureBase64 = signed?.stdout?.trim();
      if (typeof signatureBase64 === "string" && signatureBase64.startsWith("{")) {
        const parsed = JSON.parse(signatureBase64);
        assertExactKeys(parsed, ["signatureBase64"], "production-backup-signature-invalid");
        signatureBase64 = parsed.signatureBase64;
      }
      assertSignatureBase64(signatureBase64);
      const signedAt = port.now().toISOString();
      const signature = Object.freeze({
        schemaVersion: 1,
        algorithm: "kms-sha256",
        keyId: context.evidenceSigningKeyId,
        subjectSha256,
        signatureBase64,
        signedAt,
      });
      await recordPhase("evidence-core-signed", {
        subjectSha256,
        signatureRecordSha256: sha256(canonicalJson(signature)),
      });
      try {
        await port.removeFile({
          path: ACTIVE_OPERATION_FILE,
          allowMissing: false,
          requireRegular: true,
        });
      } catch {
        try {
          const activeOperation = activeOperationRecord(context);
          await port.writeExclusive({
            path: ACTIVE_OPERATION_FILE,
            bytes: Buffer.from(`${canonicalJson(activeOperation)}\n`, "utf8"),
            mode: 0o400,
          });
        } catch (restoreError) {
          if (restoreError?.code !== "EEXIST") {
            fail("production-backup-active-marker-finalization-failed");
          }
        }
        fail("production-backup-active-marker-finalization-failed");
      }
      activeOperationPersisted = false;
      operationFinalized = true;
      return signature;
    },
  });
}
