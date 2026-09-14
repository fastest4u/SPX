#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, unlink } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_FILE_PATTERN = /^[A-Z][A-Z0-9_]*_FILE$/;
const PLAIN_SECRET_PATTERN = /(?:^|_)(?:SECRET|SECRETS|PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY|API_KEY)$/;
const DB_CA_ENV_KEY = "DB_SSL_CA_FILE";
const DB_CA_PATH = "/run/config/db-ca.pem";
const MOUNT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ACCESS_VALUES = new Set(["absent", "read-only", "read-write"]);
const KIND_VALUES = new Set(["file", "directory"]);
const POLICY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../deploy/runtime-isolation-policy.json",
);
const MAX_POLICY_BYTES = 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function uniqueStrings(value, pattern) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && pattern.test(item)) &&
    new Set(value).size === value.length
  );
}

function normalizedAbsolutePath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    !value.includes("*") &&
    !value.split("/").includes("..") &&
    posix.normalize(value) === value
  );
}

function validatePolicyInternal(value) {
  if (
    !exactKeys(value, ["version", "services"]) ||
    value.version !== 1 ||
    !isObject(value.services)
  ) {
    return false;
  }
  const services = Object.entries(value.services);
  if (services.length === 0) return false;
  const writableOwners = new Set();
  for (const [service, entry] of services) {
    if (
      !SERVICE_PATTERN.test(service) ||
      service.includes("*") ||
      !exactKeys(entry, ["requiredSecretFiles", "allowedSecretFiles", "mounts"])
    ) {
      return false;
    }
    if (
      !uniqueStrings(entry.requiredSecretFiles, SECRET_FILE_PATTERN) ||
      !uniqueStrings(entry.allowedSecretFiles, SECRET_FILE_PATTERN) ||
      entry.requiredSecretFiles.some((key) => !entry.allowedSecretFiles.includes(key)) ||
      !Array.isArray(entry.mounts) ||
      entry.mounts.length === 0
    ) {
      return false;
    }
    const mountIds = new Set();
    const mountPaths = new Set();
    for (const mount of entry.mounts) {
      if (
        !exactKeys(mount, ["id", "resource", "path", "access", "kind"]) ||
        !MOUNT_ID_PATTERN.test(mount.id) ||
        !MOUNT_ID_PATTERN.test(mount.resource) ||
        !normalizedAbsolutePath(mount.path) ||
        !ACCESS_VALUES.has(mount.access) ||
        !KIND_VALUES.has(mount.kind) ||
        mountIds.has(mount.id) ||
        mountPaths.has(mount.path)
      ) {
        return false;
      }
      mountIds.add(mount.id);
      mountPaths.add(mount.path);
      if (mount.access === "read-write") {
        if (writableOwners.has(mount.resource)) return false;
        writableOwners.add(mount.resource);
      }
    }
  }
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export function validatePolicy(value) {
  if (!validatePolicyInternal(value)) throw new Error("runtime isolation policy invalid");
  return deepFreeze(structuredClone(value));
}

function expectedSecretPath(key) {
  return `/run/secrets/${key.slice(0, -"_FILE".length).toLowerCase()}`;
}

function addFailure(failures, code) {
  if (!failures.includes(code)) failures.push(code);
}

function mountFailureCode(accessValue) {
  if (accessValue === "absent") return "mount_absence_violation";
  if (accessValue === "read-only") return "mount_read_only_violation";
  return "mount_read_write_violation";
}

async function defaultProbeSecretFile(path) {
  let handle;
  try {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) return false;
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    return opened.isFile() && opened.dev === before.dev && opened.ino === before.ino;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function permissionDenied(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["EACCES", "EPERM", "EROFS"].includes(error.code)
  );
}

async function classifyDirectoryAccess(path) {
  try {
    await access(path, constants.R_OK | constants.X_OK);
  } catch {
    return "unavailable";
  }
  const probePath = join(path, `.spx-isolation-${randomUUID()}`);
  let handle;
  try {
    handle = await open(probePath, "wx", 0o600);
    await handle.writeFile("probe", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await unlink(probePath);
    return "read-write";
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(probePath).catch(() => undefined);
    return permissionDenied(error) ? "read-only" : "unavailable";
  }
}

async function classifyFileAccess(path) {
  let readHandle;
  try {
    readHandle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await readHandle.stat();
    if (!stat.isFile()) return "unavailable";
  } catch {
    return "unavailable";
  } finally {
    await readHandle?.close().catch(() => undefined);
  }

  let writeHandle;
  try {
    writeHandle = await open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    return "read-write";
  } catch (error) {
    return permissionDenied(error) ? "read-only" : "unavailable";
  } finally {
    await writeHandle?.close().catch(() => undefined);
  }
}

async function defaultProbeMountAccess(mount) {
  let stat;
  try {
    stat = await lstat(mount.path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "absent";
    }
    return "unavailable";
  }
  if (stat.isSymbolicLink()) return "unavailable";
  if (mount.kind === "directory") {
    return stat.isDirectory() ? classifyDirectoryAccess(mount.path) : "unavailable";
  }
  return stat.isFile() ? classifyFileAccess(mount.path) : "unavailable";
}

export async function evaluateRoleIsolation(input) {
  const policy = validatePolicy(input?.policy);
  const service = typeof input?.service === "string" ? input.service : "";
  if (!SERVICE_PATTERN.test(service) || !Object.hasOwn(policy.services, service)) {
    return { ok: false, service: "invalid", failureCodes: ["service_not_approved"] };
  }
  const entry = policy.services[service];
  const env = isObject(input.env) ? input.env : {};
  const failures = [];
  if (!Number.isInteger(input.uid) || input.uid < 0) addFailure(failures, "uid_unavailable");
  else if (input.uid === 0) addFailure(failures, "running_as_root");

  const allowedSecretFiles = new Set(entry.allowedSecretFiles);
  if (
    Object.keys(env).some(
      (key) =>
        key !== DB_CA_ENV_KEY &&
        SECRET_FILE_PATTERN.test(key) &&
        !allowedSecretFiles.has(key) &&
        env[key],
    )
  ) {
    addFailure(failures, "unexpected_secret_file");
  }
  if (
    Object.entries(env).some(
      ([key, value]) =>
        PLAIN_SECRET_PATTERN.test(key) && typeof value === "string" && value.trim() !== "",
    )
  ) {
    addFailure(failures, "plain_secret_present");
  }

  const probeSecretFile =
    typeof input.probeSecretFile === "function" ? input.probeSecretFile : defaultProbeSecretFile;
  const publicCa = entry.mounts.find((mount) => mount.id === "public-ca");
  const rawCaPath = env[DB_CA_ENV_KEY];
  const caPathPresent = typeof rawCaPath === "string" && rawCaPath !== "";
  if (publicCa?.access === "read-only") {
    if (!caPathPresent) {
      addFailure(failures, "required_config_missing");
    } else if (rawCaPath !== rawCaPath.trim() || rawCaPath !== DB_CA_PATH) {
      addFailure(failures, "config_file_path_mismatch");
    } else {
      let readable = false;
      try {
        readable = (await probeSecretFile(rawCaPath)) === true;
      } catch {
        readable = false;
      }
      if (!readable) addFailure(failures, "config_file_unreadable");
    }
  } else if (caPathPresent) {
    addFailure(failures, "unexpected_config_file");
  }

  for (const key of entry.allowedSecretFiles) {
    const rawPath = env[key];
    const present = typeof rawPath === "string" && rawPath !== "";
    if (!present) {
      if (entry.requiredSecretFiles.includes(key)) addFailure(failures, "required_secret_missing");
      continue;
    }
    if (rawPath !== rawPath.trim() || rawPath !== expectedSecretPath(key)) {
      addFailure(failures, "secret_file_path_mismatch");
      continue;
    }
    let readable = false;
    try {
      readable = (await probeSecretFile(rawPath)) === true;
    } catch {
      readable = false;
    }
    if (!readable) addFailure(failures, "secret_file_unreadable");
  }

  const probeMountAccess =
    typeof input.probeMountAccess === "function" ? input.probeMountAccess : defaultProbeMountAccess;
  for (const mount of entry.mounts) {
    let actual = "unavailable";
    try {
      actual = await probeMountAccess(mount);
    } catch {
      actual = "unavailable";
    }
    if (actual !== mount.access) addFailure(failures, mountFailureCode(mount.access));
  }

  return { ok: failures.length === 0, service, failureCodes: failures };
}

async function loadCheckedPolicy() {
  const before = await lstat(POLICY_PATH, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(MAX_POLICY_BYTES)) {
    throw new Error("policy unavailable");
  }

  let handle;
  let bytes;
  try {
    handle = await open(POLICY_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.size !== opened.size ||
      before.mtimeNs !== opened.mtimeNs ||
      before.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error("policy unavailable");
    }

    const buffer = Buffer.allocUnsafe(MAX_POLICY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      length > MAX_POLICY_BYTES ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      BigInt(length) !== after.size
    ) {
      throw new Error("policy unavailable");
    }
    bytes = buffer.subarray(0, length);
  } finally {
    await handle?.close();
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return validatePolicy(JSON.parse(text));
}

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function helpText() {
  return `container-isolation-probe.mjs

Usage:
  node scripts/container-isolation-probe.mjs --service=<approved-service>

Prints only the approved service label and fixed isolation failure codes.`;
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  if (process.argv.includes("--help")) {
    console.log(helpText());
  } else {
    try {
      const requestedService = argValue("service");
      const policy = await loadCheckedPolicy();
      const result = await evaluateRoleIsolation({
        service: requestedService,
        policy,
        env: process.env,
        uid: process.getuid?.(),
      });
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    } catch {
      console.log(
        JSON.stringify({ ok: false, service: "invalid", failureCodes: ["probe_failed"] }),
      );
      process.exitCode = 1;
    }
  }
}
