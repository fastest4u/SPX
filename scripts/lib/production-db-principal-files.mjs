import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalGate6Json } from "../../src/services/gate6-approval-runtime.mjs";
import { PRODUCTION_DB_ROLE_ORDER } from "../db-principal-rollout.mjs";

export const PRODUCTION_DB_CREDENTIAL_ROOT = "/var/lib/spx-gate6/service-db";
const HASH = /^[0-9a-f]{64}$/;
const USER = /^[A-Za-z0-9_$-]{1,64}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\d{1,3}(?:\.\d{1,3}){3})$/;
const PASSWORD = /^[A-Za-z0-9_-]{32,1024}$/;
const BINDING_KEYS = Object.freeze([
  "schemaVersion", "role", "targetDescriptorSha256", "accountHost",
  "candidateUsername", "legacyUsername", "candidatePasswordSha256",
  "legacyPasswordSha256", "positiveGrantProofSha256", "forbiddenGrantProofSha256",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function secureDirectory(path, allowNonRoot) {
  const stat = await lstat(path, { bigint: true });
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || (process.platform !== "win32" && Number(stat.mode & 0o077n) !== 0)
    || (process.platform !== "win32" && !allowNonRoot && stat.uid !== 0n)
  ) throw new Error("production DB principal directory is insecure");
}

async function secureRead(path, options = {}) {
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.size <= 0n
    || before.size > BigInt(options.maxBytes ?? 16 * 1024)
    || (process.platform !== "win32" && Number(before.mode & 0o077n) !== 0)
    || (process.platform !== "win32" && !options.allowNonRoot && before.uid !== 0n)
  ) throw new Error("production DB principal file is insecure");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("production DB principal file changed");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
    ) throw new Error("production DB principal file changed");
    return bytes;
  } finally {
    await handle.close();
  }
}

function validateBinding(value, role, targetDescriptorSha256) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || canonicalGate6Json(Object.keys(value).sort()) !== canonicalGate6Json([...BINDING_KEYS].sort())
    || value.schemaVersion !== 1
    || value.role !== role
    || !PRODUCTION_DB_ROLE_ORDER.includes(role)
    || value.targetDescriptorSha256 !== targetDescriptorSha256
    || !HASH.test(value.targetDescriptorSha256 ?? "")
    || !HOST.test(value.accountHost ?? "")
    || /[%_/@\\\s]/.test(value.accountHost)
    || !USER.test(value.candidateUsername ?? "")
    || !USER.test(value.legacyUsername ?? "")
    || ![
      value.candidatePasswordSha256,
      value.legacyPasswordSha256,
      value.positiveGrantProofSha256,
      value.forbiddenGrantProofSha256,
    ].every((hash) => HASH.test(hash ?? ""))
  ) throw new Error("production DB principal binding is invalid");
  return Object.freeze({ ...value });
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path, bytes, allowNonRoot) {
  const directory = resolve(path, "..");
  await secureDirectory(directory, allowNonRoot);
  const temporary = `${path}.${process.pid}.${randomUUID()}.pending`;
  let handle;
  let operationFailure = null;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    operationFailure = error;
  }
  let cleanupFailure = null;
  try {
    if (handle) await handle.close();
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } catch (error) {
    cleanupFailure = error;
  }
  if (cleanupFailure !== null) throw cleanupFailure;
  if (operationFailure !== null) throw operationFailure;
}

export function createProductionDbCredentialAdapter(options = {}) {
  const root = resolve(options.root ?? PRODUCTION_DB_CREDENTIAL_ROOT);
  const allowNonRoot = options.allowNonRoot === true;
  const targetDescriptorSha256 = options.targetDescriptorSha256;
  if (!HASH.test(targetDescriptorSha256 ?? "")) throw new Error("production target descriptor hash is invalid");
  const docker = options.docker;
  async function loaded(role) {
    if (!PRODUCTION_DB_ROLE_ORDER.includes(role)) throw new Error("unknown production DB role");
    await secureDirectory(root, allowNonRoot);
    const roleRoot = join(root, role);
    await secureDirectory(roleRoot, allowNonRoot);
    const bindingBytes = await secureRead(join(roleRoot, "binding.json"), { allowNonRoot });
    const text = bindingBytes.toString("utf8");
    const value = JSON.parse(text);
    if (text !== canonicalGate6Json(value)) throw new Error("production DB principal binding is not canonical");
    const binding = validateBinding(value, role, targetDescriptorSha256);
    const candidate = await secureRead(join(roleRoot, "candidate-password"), { allowNonRoot, maxBytes: 1024 });
    const legacy = await secureRead(join(roleRoot, "legacy-password"), { allowNonRoot, maxBytes: 1024 });
    if (
      !PASSWORD.test(candidate.toString("utf8"))
      || !PASSWORD.test(legacy.toString("utf8"))
      || sha256(candidate) !== binding.candidatePasswordSha256
      || sha256(legacy) !== binding.legacyPasswordSha256
    ) throw new Error("production DB principal password binding is invalid");
    return { roleRoot, binding, candidate, legacy };
  }
  async function project(role, mode) {
    const value = await loaded(role);
    const password = mode === "candidate" ? value.candidate : value.legacy;
    const username = mode === "candidate" ? value.binding.candidateUsername : value.binding.legacyUsername;
    await atomicWrite(join(value.roleRoot, "active-password"), password, allowNonRoot);
    await atomicWrite(join(value.roleRoot, "active.env"), Buffer.from(`DB_USERNAME=${username}\n`, "utf8"), allowNonRoot);
  }
  async function activeMode(role) {
    const value = await loaded(role);
    try {
      const active = await secureRead(join(value.roleRoot, "active-password"), { allowNonRoot, maxBytes: 1024 });
      const digest = sha256(active);
      if (digest === value.binding.candidatePasswordSha256) return "candidate";
      if (digest === value.binding.legacyPasswordSha256) return "legacy";
      return "indeterminate";
    } catch (error) {
      if (error?.code === "ENOENT") return "unstaged";
      throw error;
    }
  }
  return Object.freeze({
    async descriptor() {
      const accountHosts = {};
      for (const role of PRODUCTION_DB_ROLE_ORDER) accountHosts[role] = (await loaded(role)).binding.accountHost;
      return { environment: "production", database: { name: "SPX", accountHosts } };
    },
    async captureBaseline({ role }) {
      return { active: docker ? await docker.isRunning(role) : false, mode: await activeMode(role) };
    },
    async prepareRestricted({ role, accountHost }) {
      const value = await loaded(role);
      if (value.binding.accountHost !== accountHost) throw new Error("production DB account host binding mismatch");
    },
    async verifyPrepared({ role, accountHost }) {
      const value = await loaded(role);
      return value.binding.accountHost === accountHost;
    },
    async verifyExisting({ role, accountHost }) {
      const value = await loaded(role);
      return value.binding.accountHost === accountHost;
    },
    async stageCredential({ role, accountHost }) {
      const value = await loaded(role);
      if (value.binding.accountHost !== accountHost) throw new Error("production DB account host binding mismatch");
      await project(role, "candidate");
    },
    async restoreCredential({ role }) { await project(role, "legacy"); },
    async recreateExactService({ role }) {
      if (!docker) throw new Error("production DB service adapter is unavailable");
      await docker.recreate(role);
    },
    async restoreExactService({ role }) {
      if (!docker) throw new Error("production DB service adapter is unavailable");
      await docker.recreate(role);
    },
    async verifyPostconditions({ role, serviceExpectedActive }) {
      if (await activeMode(role) !== "candidate") return false;
      return !serviceExpectedActive || (docker && await docker.isReady(role));
    },
    async restoreRole(role) {
      await project(role, "legacy");
      if (docker && await docker.isRunning(role)) await docker.recreate(role);
      return await activeMode(role) === "legacy";
    },
  });
}
