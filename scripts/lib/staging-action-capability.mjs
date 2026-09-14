import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { canonicalJson, readEvidenceJson } from "./evidence-artifact.mjs";

export const STAGING_ACTION_CAPABILITY_PATH = "/etc/spx-staging/action-capability.json";
export const STAGING_DATABASE_SECRET_ROOT = "/run/spx-staging-actions/database";
export const STAGING_DATABASE_CA_PATH = "/etc/spx-staging/db-ca.pem";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const SQL_USER = /^[a-z][a-z0-9_]{0,63}$/;
const ROLE = /^[a-z][a-z0-9-]{0,62}$/;
const RELEASE_IDENTITY_KEYS = Object.freeze([
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "environment",
  "topology",
  "composeProject",
  "stagingTargetDescriptorSha256",
  "operatorBundleSha256",
  "stagingApprovalEnvelopeSha256",
  "stagingRunId",
]);

export const STAGING_PROVISIONED_DB_ROLES = Object.freeze([
  "auto-accept-ifn-phase3",
  "auto-accept-ptwl-phase3",
  "gate6-monitor",
  "line-service",
  "migrator",
  "notification-service",
  "phase3-control",
  "phase3-observer",
  "poller-ifn-phase3",
  "poller-ptwl-phase3",
  "realtime-service",
  "web-api",
  "worker-ifn",
  "worker-ifn-split",
  "worker-ptwl",
  "worker-ptwl-split",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

export function stagingReleaseIdentity(binding) {
  if (!isObject(binding)) throw new Error("installed staging release binding is required");
  return Object.freeze(Object.fromEntries(RELEASE_IDENTITY_KEYS.map((key) => [key, binding[key]])));
}

export function validateStagingActionCapability(value, installedBinding) {
  const expectedBinding = stagingReleaseIdentity(installedBinding);
  if (!exactKeys(value, ["schemaVersion", "releaseBinding", "database", "phase3"])) {
    throw new Error("staging action capability has a missing or unknown field");
  }
  if (
    value.schemaVersion !== 1 ||
    !exactKeys(value.releaseBinding, RELEASE_IDENTITY_KEYS) ||
    canonicalJson(value.releaseBinding) !== canonicalJson(expectedBinding)
  ) {
    throw new Error("staging action capability release binding is invalid");
  }
  const database = value.database;
  const roles = database?.principalRoles;
  if (
    !exactKeys(database, [
      "host",
      "port",
      "name",
      "sslServername",
      "caSha256",
      "actors",
      "actorHosts",
      "principalRoles",
    ]) ||
    !HOST.test(database.host ?? "") ||
    !Number.isSafeInteger(database.port) ||
    database.port < 1 ||
    database.port > 65535 ||
    database.name !== "spx_staging" ||
    !HOST.test(database.sslServername ?? "") ||
    !HASH.test(database.caSha256 ?? "") ||
    !exactKeys(database.actors, ["bootstrap", "phase3Control"]) ||
    database.actors.bootstrap !== "spx_staging_bootstrap" ||
    database.actors.phase3Control !== "spx_stg_phase3_control" ||
    !exactKeys(database.actorHosts, ["bootstrap", "phase3Control"]) ||
    !HOST.test(database.actorHosts.bootstrap ?? "") ||
    !HOST.test(database.actorHosts.phase3Control ?? "") ||
    /[%_]/.test(database.actorHosts.bootstrap) ||
    /[%_]/.test(database.actorHosts.phase3Control) ||
    !Array.isArray(roles) ||
    canonicalJson(roles) !== canonicalJson(STAGING_PROVISIONED_DB_ROLES) ||
    roles.some((role) => !ROLE.test(role)) ||
    database.actorHosts.phase3Control === undefined
  ) {
    throw new Error("staging action database capability is invalid");
  }
  if (
    !exactKeys(value.phase3, ["canaryTeamId", "canaryEpoch"]) ||
    ![1, 2].includes(value.phase3.canaryTeamId) ||
    !ID.test(value.phase3.canaryEpoch ?? "")
  ) {
    throw new Error("staging action Phase 3 canary capability is invalid");
  }
  return value;
}

export function databaseSecretPath(kind, role) {
  if (kind === "bootstrap") return `${STAGING_DATABASE_SECRET_ROOT}/bootstrap.password`;
  if (kind === "phase3-control") {
    return `${STAGING_DATABASE_SECRET_ROOT}/phase3-control.password`;
  }
  if (kind === "principal" && typeof role === "string" && ROLE.test(role)) {
    return `${STAGING_DATABASE_SECRET_ROOT}/principal-${role}.password`;
  }
  throw new Error("staging database secret role is invalid");
}

function owner(options) {
  if (options.expectedUid !== undefined) return options.expectedUid;
  return process.platform === "win32" ? null : 0;
}

export async function readRootOwnedStagingSecret(path, options = {}) {
  const allowedRoot = resolve(options.allowedRoot ?? STAGING_DATABASE_SECRET_ROOT);
  const absolute = resolve(path);
  const rel = relative(allowedRoot, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("staging secret path escapes the fixed root");
  }
  const [rootStatus, rootCanonical, fileStatus, fileCanonical] = await Promise.all([
    lstat(allowedRoot, { bigint: true }),
    realpath(allowedRoot),
    lstat(absolute, { bigint: true }),
    realpath(absolute),
  ]);
  if (
    rootStatus.isSymbolicLink() ||
    !rootStatus.isDirectory() ||
    resolve(rootCanonical) !== allowedRoot ||
    fileStatus.isSymbolicLink() ||
    !fileStatus.isFile() ||
    resolve(fileCanonical) !== absolute
  ) {
    throw new Error("staging secret must be a canonical regular file under the fixed root");
  }
  const expectedUid = owner(options);
  if (
    expectedUid !== null &&
    (Number(rootStatus.uid) !== expectedUid ||
      Number(rootStatus.mode & 0o777n) !== 0o700 ||
      Number(fileStatus.uid) !== expectedUid ||
      Number(fileStatus.mode & 0o777n) !== 0o400)
  ) {
    throw new Error("staging secret root/file ownership or permissions are invalid");
  }
  if (Number(fileStatus.size) < 32 || Number(fileStatus.size) > 4_096) {
    throw new Error("staging secret length is invalid");
  }
  const value = await readFile(absolute, "utf8");
  if (value.length < 32 || value.length > 4_096 || value.trim() !== value || /[\r\n\0]/.test(value)) {
    throw new Error("staging secret content is invalid");
  }
  return value;
}

export function buildStagingDatabaseConnectionConfig(capability, actor, password, caBytes) {
  const database = capability?.database;
  const actorKey = actor === "bootstrap"
    ? "bootstrap"
    : actor === "phase3-control"
      ? "phase3Control"
      : null;
  const user = actorKey
    ? database?.actors?.[actorKey]
    : actor === "phase3-observer" && database?.principalRoles?.includes("phase3-observer")
      ? "spx_stg_phase3_observer"
      : null;
  if (
    !SQL_USER.test(user ?? "") ||
    typeof password !== "string" ||
    password.length < 32 ||
    !Buffer.isBuffer(caBytes) ||
    caBytes.length === 0 ||
    createHash("sha256").update(caBytes).digest("hex") !== database?.caSha256
  ) {
    throw new Error("fixed staging database credential capability is invalid");
  }
  return {
    host: database.host,
    port: database.port,
    user,
    password,
    database: database.name,
    ssl: {
      ca: caBytes.toString("utf8"),
      rejectUnauthorized: true,
      servername: database.sslServername,
    },
  };
}

async function assertCapabilityFile(path, options = {}) {
  const [file, parent, canonical] = await Promise.all([
    lstat(path, { bigint: true }),
    lstat(dirname(path), { bigint: true }),
    realpath(path),
  ]);
  if (
    file.isSymbolicLink() ||
    !file.isFile() ||
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    resolve(canonical) !== resolve(path)
  ) {
    throw new Error("installed staging action capability is not a canonical regular file");
  }
  const expectedUid = owner(options);
  if (
    expectedUid !== null &&
    (Number(file.uid) !== expectedUid ||
      Number(file.mode & 0o777n) !== 0o400 ||
      Number(parent.uid) !== expectedUid ||
      (Number(parent.mode & 0o777n) & 0o077) !== 0)
  ) {
    throw new Error("installed staging action capability is not root-private");
  }
}

async function readRootOwnedPrivateFile(path, label, options = {}) {
  const [file, parent, canonical] = await Promise.all([
    lstat(path, { bigint: true }),
    lstat(dirname(path), { bigint: true }),
    realpath(path),
  ]);
  if (
    file.isSymbolicLink() ||
    !file.isFile() ||
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    resolve(canonical) !== resolve(path)
  ) {
    throw new Error(`${label} must be a canonical regular file`);
  }
  const expectedUid = owner(options);
  if (
    expectedUid !== null &&
    (Number(file.uid) !== expectedUid ||
      Number(file.mode & 0o777n) !== 0o400 ||
      Number(parent.uid) !== expectedUid ||
      (Number(parent.mode & 0o777n) & 0o077) !== 0)
  ) {
    throw new Error(`${label} must be root-private`);
  }
  if (Number(file.size) < 1 || Number(file.size) > 256 * 1024) {
    throw new Error(`${label} length is invalid`);
  }
  return readFile(path);
}

export async function loadInstalledStagingActionCapability(installedBinding, options = {}) {
  const path = options.path ?? STAGING_ACTION_CAPABILITY_PATH;
  await assertCapabilityFile(path, options);
  const value = await readEvidenceJson(path, { requireCanonical: true, maxFileBytes: 256 * 1024 });
  return Object.freeze(validateStagingActionCapability(value, installedBinding));
}

export async function loadStagingDatabaseCredential(capability, actor, options = {}) {
  const secretPath = options.secretPath ?? (
    actor === "phase3-observer"
      ? databaseSecretPath("principal", "phase3-observer")
      : databaseSecretPath(actor)
  );
  const caPath = options.caPath ?? STAGING_DATABASE_CA_PATH;
  const [password, caBytes] = await Promise.all([
    readRootOwnedStagingSecret(secretPath, options),
    readRootOwnedPrivateFile(caPath, "staging database CA", options),
  ]);
  if (createHash("sha256").update(caBytes).digest("hex") !== capability.database.caSha256) {
    throw new Error("staging database CA capability hash changed");
  }
  return buildStagingDatabaseConnectionConfig(capability, actor, password, caBytes);
}
