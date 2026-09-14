import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { basename, join, parse, resolve } from "node:path";

import { canonicalJson } from "./evidence-artifact.mjs";

export const GATE6_SEMANTIC_RECEIPT_ROOT = "/var/lib/spx-gate6/semantic-receipts";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_STAGE = /^[a-z][a-z0-9-]{0,63}$/;
const RECEIPT_SCOPES = new Set([
  "stage-accept-db-transition",
  "stage-accept-task9",
  "stage-accept-worker",
  "stage-accept-phase3",
  "stage-accept-phase4",
  "stage-accept-pre-close",
]);
const INPUT_FIELDS = [
  "gate6Id",
  "scope",
  "actionId",
  "expectedStage",
  "nextStage",
  "checkerName",
  "checkerExecutableSha256",
  "checkerArgumentsSha256",
  "checkerOutputSha256",
  "checkerOutput",
  "checkedAt",
];
const RECEIPT_FIELDS = [
  "schemaVersion",
  ...INPUT_FIELDS.slice(0, 9),
  "checkerOutput",
  "acceptedCheckerSha256",
  "checkedAt",
];
const SECRET_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SECRET_VALUE = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isoTimestamp(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function scanSafeJson(value, path = "checkerOutput", seen = new Set()) {
  if (typeof value === "string") {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("Gate 6 semantic receipt contains secret-shaped content");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} is not finite JSON`);
    return;
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    throw new Error(`${path} is not plain JSON`);
  }
  if (seen.has(value)) throw new Error("Gate 6 semantic receipt contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanSafeJson(child, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        throw new Error("Gate 6 semantic receipt contains a secret-shaped field");
      }
      scanSafeJson(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function validateIdentifiers(input) {
  for (const [value, label] of [
    [input.gate6Id, "Gate 6 ID"],
    [input.actionId, "Gate 6 action ID"],
    [input.checkerName, "Gate 6 checker name"],
  ]) {
    if (typeof value !== "string" || !SAFE_ID.test(value)) {
      throw new Error(`${label} is invalid`);
    }
  }
  if (!RECEIPT_SCOPES.has(input.scope)) throw new Error("Gate 6 semantic receipt scope is invalid");
  for (const [value, label] of [
    [input.expectedStage, "Gate 6 expected stage"],
    [input.nextStage, "Gate 6 next stage"],
  ]) {
    if (typeof value !== "string" || !SAFE_STAGE.test(value))
      throw new Error(`${label} is invalid`);
  }
  for (const [value, label] of [
    [input.checkerExecutableSha256, "checker executable hash"],
    [input.checkerArgumentsSha256, "checker arguments hash"],
    [input.checkerOutputSha256, "checker output hash"],
  ]) {
    if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  }
}

function acceptedCheckerCore(input) {
  return {
    schemaVersion: 1,
    gate6Id: input.gate6Id,
    scope: input.scope,
    actionId: input.actionId,
    expectedStage: input.expectedStage,
    nextStage: input.nextStage,
    checkerName: input.checkerName,
    checkerExecutableSha256: input.checkerExecutableSha256,
    checkerArgumentsSha256: input.checkerArgumentsSha256,
    checkerOutputSha256: input.checkerOutputSha256,
  };
}

export function buildGate6SemanticReceipt(input) {
  exactObject(input, INPUT_FIELDS, "Gate 6 semantic receipt input");
  validateIdentifiers(input);
  isoTimestamp(input.checkedAt, "Gate 6 semantic receipt timestamp");
  scanSafeJson(input.checkerOutput);
  const outputBytes = canonicalJson(input.checkerOutput);
  if (sha256(outputBytes) !== input.checkerOutputSha256) {
    throw new Error("Gate 6 semantic checker output hash mismatch");
  }
  const core = acceptedCheckerCore(input);
  return Object.freeze({
    ...core,
    checkerOutput: JSON.parse(outputBytes),
    acceptedCheckerSha256: sha256(canonicalJson(core)),
    checkedAt: input.checkedAt,
  });
}

function validateReceipt(receipt) {
  exactObject(receipt, RECEIPT_FIELDS, "Gate 6 semantic receipt");
  if (receipt.schemaVersion !== 1) throw new Error("Gate 6 semantic receipt version is invalid");
  const rebuilt = buildGate6SemanticReceipt({
    gate6Id: receipt.gate6Id,
    scope: receipt.scope,
    actionId: receipt.actionId,
    expectedStage: receipt.expectedStage,
    nextStage: receipt.nextStage,
    checkerName: receipt.checkerName,
    checkerExecutableSha256: receipt.checkerExecutableSha256,
    checkerArgumentsSha256: receipt.checkerArgumentsSha256,
    checkerOutputSha256: receipt.checkerOutputSha256,
    checkerOutput: receipt.checkerOutput,
    checkedAt: receipt.checkedAt,
  });
  if (rebuilt.acceptedCheckerSha256 !== receipt.acceptedCheckerSha256) {
    throw new Error("Gate 6 semantic receipt accepted-checker hash mismatch");
  }
  return receipt;
}

export function semanticReceiptPathForScope(scope, root = GATE6_SEMANTIC_RECEIPT_ROOT) {
  if (!RECEIPT_SCOPES.has(scope)) throw new Error("Gate 6 semantic receipt scope is invalid");
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    !resolve(root).startsWith(parse(resolve(root)).root)
  ) {
    throw new Error("Gate 6 semantic receipt root is invalid");
  }
  const name = `${scope}.json`;
  if (basename(name) !== name) throw new Error("Gate 6 semantic receipt filename is invalid");
  return join(resolve(root), name);
}

function expectedOwner(rootOverride) {
  if (rootOverride !== undefined && process.env.NODE_ENV === "test") {
    return typeof process.getuid === "function" ? process.getuid() : null;
  }
  return 0;
}

function modeOf(status) {
  return Number(status.mode) & 0o777;
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function validateNoSymlinkComponents(path) {
  const absolute = resolve(path);
  const volumeRoot = parse(absolute).root;
  const components = absolute
    .slice(volumeRoot.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = volumeRoot;
  for (const component of components) {
    current = join(current, component);
    const status = await lstat(current, { bigint: true });
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("Gate 6 semantic receipt root must not traverse a symlink");
    }
  }
}

async function validateDirectory(root, rootOverride) {
  await validateNoSymlinkComponents(root);
  const status = await lstat(root, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Gate 6 semantic receipt root must be a regular directory");
  }
  if (process.platform !== "win32" && modeOf(status) !== 0o700) {
    throw new Error("Gate 6 semantic receipt root mode must be 0700");
  }
  const owner = expectedOwner(rootOverride);
  if (owner !== null && Number(status.uid) !== owner) {
    throw new Error("Gate 6 semantic receipt root must be root-owned");
  }
}

async function readStableReceipt(path, rootOverride) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Gate 6 semantic receipt must be a regular non-symlink file");
  }
  if (process.platform !== "win32" && modeOf(before) !== 0o400) {
    throw new Error("Gate 6 semantic receipt mode must be root-private 0400");
  }
  const owner = expectedOwner(rootOverride);
  if (owner !== null && Number(before.uid) !== owner) {
    throw new Error("Gate 6 semantic receipt must be root-owned");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("Gate 6 semantic receipt changed while opening");
    }
    const bytes = await handle.readFile();
    if (bytes.length > 256 * 1024) throw new Error("Gate 6 semantic receipt is oversized");
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(after, pathAfter)) {
      throw new Error("Gate 6 semantic receipt changed during stable read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(root) {
  const handle = await open(root, constants.O_RDONLY);
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function readGate6SemanticReceipt(scope, options = {}) {
  const rootOverride = options.root;
  const root = resolve(rootOverride ?? GATE6_SEMANTIC_RECEIPT_ROOT);
  try {
    await validateDirectory(root, rootOverride);
  } catch (error) {
    if (options.allowMissing === true && error?.code === "ENOENT") return null;
    throw error;
  }
  const path = semanticReceiptPathForScope(scope, root);
  let bytes;
  try {
    bytes = await readStableReceipt(path, rootOverride);
  } catch (error) {
    if (options.allowMissing === true && error?.code === "ENOENT") return null;
    throw error;
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Gate 6 semantic receipt is not valid JSON");
  }
  if (canonicalJson(receipt) !== bytes.toString("utf8")) {
    throw new Error("Gate 6 semantic receipt is not canonical JSON");
  }
  validateReceipt(receipt);
  return Object.freeze({ receipt: Object.freeze(receipt), path, sha256: sha256(bytes) });
}

export async function writeGate6SemanticReceipt(receipt, options = {}) {
  validateReceipt(receipt);
  const rootOverride = options.root;
  if (
    rootOverride !== undefined &&
    (typeof rootOverride !== "string" || rootOverride.length === 0)
  ) {
    throw new Error("Gate 6 semantic receipt root override is invalid");
  }
  const root = resolve(rootOverride ?? GATE6_SEMANTIC_RECEIPT_ROOT);
  try {
    await mkdir(root, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await validateDirectory(root, rootOverride);
  const path = semanticReceiptPathForScope(receipt.scope, root);
  const bytes = Buffer.from(canonicalJson(receipt), "utf8");
  let created = false;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o400,
    );
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
  if (created) await fsyncDirectory(root);
  const reopened = await readStableReceipt(path, rootOverride);
  if (!reopened.equals(bytes)) {
    throw new Error("Gate 6 semantic receipt conflicts with durable bytes");
  }
  return Object.freeze({ path, sha256: sha256(reopened) });
}
