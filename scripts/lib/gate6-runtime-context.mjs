import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalGate6Json } from "../../src/services/gate6-approval-runtime.mjs";

export const GATE6_RUNTIME_CONTEXT_FILE = "/var/lib/spx-gate6/runtime-context.json";
const MAX_BYTES = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEYS = Object.freeze([
  "schemaVersion",
  "gate6Id",
  "candidateSha",
  "candidateImageDigest",
  "rollbackSha",
  "targetDescriptorSha256",
  "operatorBundleSha256",
  "monitorThresholdsSha256",
  "composeProject",
  "envelopeSha256",
  "createdAt",
]);

function validate(value) {
  const actual = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (
    canonicalGate6Json(actual) !== canonicalGate6Json([...KEYS].sort())
    || value.schemaVersion !== 1
    || !ID.test(value.gate6Id ?? "")
    || !COMMIT_SHA.test(value.candidateSha ?? "")
    || !IMAGE.test(value.candidateImageDigest ?? "")
    || !COMMIT_SHA.test(value.rollbackSha ?? "")
    || !SHA256.test(value.targetDescriptorSha256 ?? "")
    || !SHA256.test(value.operatorBundleSha256 ?? "")
    || !SHA256.test(value.monitorThresholdsSha256 ?? "")
    || value.composeProject !== "spx-production"
    || !SHA256.test(value.envelopeSha256 ?? "")
    || !Number.isFinite(Date.parse(value.createdAt ?? ""))
    || new Date(value.createdAt).toISOString() !== value.createdAt
  ) throw new Error("Gate 6 runtime context is invalid");
  return value;
}

async function secureDirectory(path, allowNonRoot) {
  const stat = await lstat(path, { bigint: true });
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || (process.platform !== "win32" && Number(stat.mode & 0o077n) !== 0)
    || (process.platform !== "win32" && !allowNonRoot && stat.uid !== 0n)
  ) throw new Error("Gate 6 runtime context directory is insecure");
}

export async function readGate6RuntimeContext(options = {}) {
  const path = options.path ?? GATE6_RUNTIME_CONTEXT_FILE;
  await secureDirectory(dirname(path), options.allowNonRoot === true);
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.size <= 0n
    || before.size > BigInt(MAX_BYTES)
    || (process.platform !== "win32" && Number(before.mode & 0o077n) !== 0)
    || (process.platform !== "win32" && options.allowNonRoot !== true && before.uid !== 0n)
  ) throw new Error("Gate 6 runtime context file is insecure");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Gate 6 runtime context changed during read");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
    ) throw new Error("Gate 6 runtime context changed during read");
    const text = bytes.toString("utf8");
    const value = JSON.parse(text);
    if (text !== canonicalGate6Json(value)) throw new Error("Gate 6 runtime context is not canonical");
    return Object.freeze({ ...validate(value) });
  } finally {
    await handle.close();
  }
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

export async function writeGate6RuntimeContext(value, options = {}) {
  const validated = Object.freeze({ ...validate(value) });
  const path = options.path ?? GATE6_RUNTIME_CONTEXT_FILE;
  const directory = dirname(path);
  await secureDirectory(directory, options.allowNonRoot === true);
  try {
    const existing = await readGate6RuntimeContext(options);
    if (canonicalGate6Json(existing) !== canonicalGate6Json(validated)) {
      throw new Error("Gate 6 runtime context conflicts with the active run");
    }
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.pending`;
  let handle;
  let result;
  let operationFailure = null;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(canonicalGate6Json(validated), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readGate6RuntimeContext(options);
      if (canonicalGate6Json(existing) !== canonicalGate6Json(validated)) {
        throw new Error("Gate 6 runtime context conflicts with the active run");
      }
      result = existing;
    }
    if (result === undefined) {
      await syncDirectory(directory);
      result = validated;
    }
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
  return result;
}
