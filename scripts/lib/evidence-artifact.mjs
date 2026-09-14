import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLACEHOLDER_PATTERN = /(?:\bTODO\b|\bTBD\b|YYYY|HHMM|<[^>]+>|replace\s+this)/i;
const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SECRET_VALUE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
];
const COMMON_BINDING_FIELDS = [
  "candidateSha",
  "imageDigest",
  "releaseManifestSha256",
  "environment",
  "topology",
  "composeProject",
  "operatorBundleSha256",
];
const STAGING_BINDING_FIELDS = [
  ...COMMON_BINDING_FIELDS,
  "stagingTargetDescriptorSha256",
  "stagingApprovalEnvelopeSha256",
  "actionJournalHeadSha256",
  "stagingRunId",
];
const PRODUCTION_BINDING_FIELDS = [
  ...COMMON_BINDING_FIELDS,
  "targetDescriptorSha256",
  "productionIdentityApprovalSha256",
];
const BINDING_LABELS = {
  candidateSha: "candidate SHA",
  imageDigest: "image digest",
  releaseManifestSha256: "release manifest hash",
  environment: "environment",
  topology: "topology",
  composeProject: "compose project",
  stagingTargetDescriptorSha256: "target descriptor hash",
  operatorBundleSha256: "operator bundle hash",
  stagingApprovalEnvelopeSha256: "staging approval envelope hash",
  actionJournalHeadSha256: "action journal head hash",
  stagingRunId: "staging run ID",
  targetDescriptorSha256: "target descriptor hash",
  productionIdentityApprovalSha256: "production identity approval hash",
};

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeCanonical(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON requires a finite JSON number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("canonical JSON cannot contain cycles");
    seen.add(value);
    const result = value.map((item) => normalizeCanonical(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value)) throw new Error("canonical JSON accepts only plain JSON values");
  if (seen.has(value)) throw new Error("canonical JSON cannot contain cycles");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new Error("canonical JSON cannot contain undefined");
    result[key] = normalizeCanonical(value[key], seen);
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonical(value, new Set()));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function boundedPositiveInteger(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

export async function readEvidenceBytes(path, options = {}) {
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    "evidence file size limit",
  );
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("evidence must be a regular file and not a symlink");
  }
  if (before.size > BigInt(maxFileBytes)) throw new Error("evidence file exceeds size limit");

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error("evidence symlink is not allowed");
    }
    throw error;
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("evidence file changed during validation");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxFileBytes) throw new Error("evidence file exceeds size limit");
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(opened, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error("evidence file changed during validation");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readEvidenceJson(path, options = {}) {
  const bytes = await readEvidenceBytes(path, options);
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  if (options.requireCanonical === true) {
    if (text !== canonicalJson(value)) {
      throw new Error("evidence document must use canonical JSON");
    }
  }
  return value;
}

function validateAllowedNames(allowedNames) {
  if (!Array.isArray(allowedNames) || allowedNames.length === 0) {
    throw new Error("allowed evidence filenames are required");
  }
  const names = new Set();
  for (const name of allowedNames) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name !== basename(name) ||
      !name.endsWith(".json") ||
      names.has(name)
    ) {
      throw new Error("allowed evidence filenames must be unique JSON basenames");
    }
    names.add(name);
  }
  return names;
}

export async function assertEvidenceDirectory(dir, allowedNames, options = {}) {
  const expected = validateAllowedNames(allowedNames);
  const directory = await lstat(dir, { bigint: true });
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("evidence bundle must be a regular directory and not a symlink");
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!expected.has(entry.name)) throw new Error("evidence directory contains unexpected files");
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        "evidence bundle entries must be regular files, not symlinks or subdirectories",
      );
    }
  }
  if (options.requireAll !== false && entries.length !== expected.size) {
    throw new Error("evidence bundle is missing a required evidence file");
  }
  return entries.map((entry) => entry.name).sort();
}

function scanEvidenceValue(value, options, path = "$", seen = new Set()) {
  if (typeof value === "string") {
    if (options.rejectPlaceholders !== false && PLACEHOLDER_PATTERN.test(value)) {
      throw new Error("evidence bundle contains placeholder content");
    }
    if (
      options.rejectSecrets !== false &&
      SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      throw new Error("evidence bundle contains secret-shaped content");
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object") throw new Error(`evidence at ${path} is not JSON-compatible`);
  if (seen.has(value)) throw new Error("evidence bundle contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanEvidenceValue(item, options, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (options.rejectSecrets !== false && SECRET_KEY_PATTERN.test(key)) {
        throw new Error("evidence bundle contains a secret-shaped field");
      }
      scanEvidenceValue(child, options, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function decodeEvidenceUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("evidence bundle contains invalid UTF-8");
  }
}

function scanRawEvidenceText(text, options) {
  if (options.rejectPlaceholders !== false && PLACEHOLDER_PATTERN.test(text)) {
    throw new Error("evidence bundle contains placeholder content");
  }
  if (options.rejectSecrets === false) return;
  const secretKeyInJson = new RegExp(
    `"[^"\\n]*(?:${SECRET_KEY_PATTERN.source})[^"\\n]*"\\s*:`,
    "i",
  );
  if (secretKeyInJson.test(text) || SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error("evidence bundle contains secret-shaped content");
  }
}

function sameDirectorySnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export async function readEvidenceBundle(dir, options = {}) {
  const allowed = [...validateAllowedNames(options.allowedNames)].sort();
  const maxTotalBytes = boundedPositiveInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    "evidence bundle total size limit",
  );
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    "evidence file size limit",
  );
  const directoryBefore = await lstat(dir, { bigint: true });
  const names = await assertEvidenceDirectory(dir, allowed, {
    requireAll: options.requireAll,
  });
  let totalBytes = 0;
  const result = {};
  for (const name of names) {
    const path = join(dir, name);
    const bytes = await readEvidenceBytes(path, { maxFileBytes });
    totalBytes += bytes.byteLength;
    if (totalBytes > maxTotalBytes) throw new Error("evidence bundle exceeds total size limit");
    const text = decodeEvidenceUtf8(bytes);
    scanRawEvidenceText(text, options);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("evidence bundle contains invalid JSON");
    }
    if (text !== canonicalJson(value)) {
      throw new Error("evidence bundle files must use canonical JSON without duplicate JSON keys");
    }
    scanEvidenceValue(value, options);
    if (options.expectedBinding !== undefined) {
      if (!isPlainObject(value) || !isPlainObject(value.releaseBinding)) {
        throw new Error("evidence file is missing its release binding");
      }
      validateReleaseBinding(value.releaseBinding, options.expectedBinding);
    }
    result[name] = value;
  }
  if (process.env.NODE_ENV === "test" && typeof options.beforeFinalDirectoryCheck === "function") {
    await options.beforeFinalDirectoryCheck();
  }
  await assertEvidenceDirectory(dir, allowed, { requireAll: options.requireAll });
  const directoryAfter = await lstat(dir, { bigint: true });
  if (!sameDirectorySnapshot(directoryBefore, directoryAfter)) {
    throw new Error("evidence directory changed during validation");
  }
  return result;
}

function requirePattern(label, value, pattern, expectedDescription) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} must be ${expectedDescription}`);
  }
}

function requireOneOf(label, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
}

export function validateReleaseBinding(value, expected) {
  if (!isPlainObject(value)) throw new Error("release binding must be an object");
  requireOneOf("environment", value.environment, ["staging", "supervised-production"]);
  const bindingFields = value.environment === "staging"
    ? STAGING_BINDING_FIELDS
    : PRODUCTION_BINDING_FIELDS;
  const keys = Object.keys(value).sort();
  const requiredKeys = [...bindingFields].sort();
  if (canonicalJson(keys) !== canonicalJson(requiredKeys)) {
    throw new Error("release binding must contain exactly the canonical binding fields");
  }
  requirePattern(
    "candidate SHA",
    value.candidateSha,
    COMMIT_SHA_PATTERN,
    "a 40-character lowercase SHA",
  );
  requirePattern(
    "image digest",
    value.imageDigest,
    IMAGE_DIGEST_PATTERN,
    "an immutable sha256 digest",
  );
  requirePattern(
    "release manifest hash",
    value.releaseManifestSha256,
    SHA256_PATTERN,
    "a SHA-256 hash",
  );
  requireOneOf("topology", value.topology, ["split", "phase3", "realtime"]);
  if (
    value.composeProject !== (value.environment === "staging" ? "spx-staging" : "spx-production")
  ) {
    throw new Error("compose project does not match the release environment");
  }
  requirePattern(
    "operator bundle hash",
    value.operatorBundleSha256,
    SHA256_PATTERN,
    "a SHA-256 hash",
  );
  if (value.environment === "staging") {
    requirePattern(
      "target descriptor hash",
      value.stagingTargetDescriptorSha256,
      SHA256_PATTERN,
      "a SHA-256 hash",
    );
    requirePattern(
      "staging approval envelope hash",
      value.stagingApprovalEnvelopeSha256,
      SHA256_PATTERN,
      "a SHA-256 hash",
    );
    requirePattern(
      "action journal head hash",
      value.actionJournalHeadSha256,
      SHA256_PATTERN,
      "a SHA-256 hash",
    );
    requirePattern(
      "staging run ID",
      value.stagingRunId,
      SAFE_ID_PATTERN,
      "a concrete bounded identifier",
    );
    if (PLACEHOLDER_PATTERN.test(value.stagingRunId)) {
      throw new Error("staging run ID contains a placeholder");
    }
  } else {
    requirePattern(
      "target descriptor hash",
      value.targetDescriptorSha256,
      SHA256_PATTERN,
      "a SHA-256 hash",
    );
    requirePattern(
      "production identity approval hash",
      value.productionIdentityApprovalSha256,
      SHA256_PATTERN,
      "a SHA-256 hash",
    );
  }

  if (expected !== undefined) {
    validateReleaseBinding(expected);
    if (value.environment !== expected.environment) {
      throw new Error("environment does not match the verified release binding");
    }
    for (const field of bindingFields) {
      if (value[field] !== expected[field]) {
        throw new Error(`${BINDING_LABELS[field]} does not match the verified release binding`);
      }
    }
  }
  return value;
}
