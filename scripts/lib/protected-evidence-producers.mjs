import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertEvidenceDirectory,
  canonicalJson,
  readEvidenceBytes,
  sha256Canonical,
} from "./evidence-artifact.mjs";

const DEFAULT_MAP_PATH = "deploy/protected-evidence-producers.json";
const MAX_MAP_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const ZERO_SHA = "0".repeat(40);
const ZERO_SHA256 = "0".repeat(64);
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ENTRY_FIELDS = Object.freeze([
  "workflow",
  "environment",
  "files",
  "signerSha",
  "workflowFileSha256",
  "bootstrapDenied",
]);
const PRODUCER_FIELDS = Object.freeze([
  "repository",
  "environment",
  "workflow",
  "workflowSha",
  "workflowFileSha256",
]);
const SIGNATURE_FIELDS = Object.freeze([
  "schemaVersion",
  "algorithm",
  "keyId",
  "subjectSha256",
  "signatureBase64",
  "signedAt",
]);
const EXPECTED = Object.freeze({
  "accepted-db-transition": Object.freeze({
    workflow: ".github/workflows/gate6-accepted-evidence-exporter.yml",
    environment: "production",
    files: Object.freeze(["accepted-db-transition-evidence.json"]),
  }),
  "accepted-pre-close": Object.freeze({
    workflow: ".github/workflows/gate6-accepted-evidence-exporter.yml",
    environment: "production",
    files: Object.freeze(["accepted-pre-close-evidence.json"]),
  }),
  "final-verifier": Object.freeze({
    workflow: ".github/workflows/gate6-final-verifier-exporter.yml",
    environment: "production",
    files: Object.freeze(["final-verifier.json"]),
  }),
  "production-backup-restore": Object.freeze({
    workflow: ".github/workflows/trusted-production-backup-restore.yml",
    environment: "production",
    files: Object.freeze([
      "production-backup-restore-evidence.json",
      "production-backup-restore-signature.json",
    ]),
  }),
  "protected-install": Object.freeze({
    workflow: ".github/workflows/trusted-deploy.yml",
    environment: "production",
    files: Object.freeze(["protected-install-evidence.json", "protected-install-signature.json"]),
  }),
  "staging-gates": Object.freeze({
    workflow: ".github/workflows/trusted-staging-protected-evidence.yml",
    environment: "staging",
    files: Object.freeze(["staging-protected-evidence.json"]),
  }),
});
const KINDS = Object.freeze(Object.keys(EXPECTED).sort());

const SECRET_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SECRET_VALUES = Object.freeze([
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:authorization|cookie|credential|password|private.?key|secret|token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
]);
const RAW_SQL =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|SHOW|DESCRIBE|DESC|EXPLAIN|CALL|SET|USE|REPLACE)\s+[A-Za-z_*`]/i;
const ENDPOINT_VALUE = /\b(?:mysql|postgres(?:ql)?|ssh):\/\/|https?:\/\//i;
const DOTENV_VALUE = /(?:^|[\\/])\.env(?:$|[.\\/])/i;

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
  return value;
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

function freezeJson(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
  return value;
}

function frozenEntry(value) {
  return Object.freeze({
    workflow: value.workflow,
    environment: value.environment,
    files: Object.freeze([...value.files]),
    signerSha: value.signerSha,
    workflowFileSha256: value.workflowFileSha256,
    bootstrapDenied: value.bootstrapDenied,
  });
}

function validateEntry(kind, value) {
  exactObject(value, ENTRY_FIELDS, `protected evidence producer map entry ${kind}`);
  const expected = EXPECTED[kind];
  if (
    value.workflow !== expected.workflow ||
    value.environment !== expected.environment ||
    canonicalJson(value.files) !== canonicalJson(expected.files) ||
    !SHA.test(value.signerSha ?? "") ||
    !SHA256.test(value.workflowFileSha256 ?? "") ||
    typeof value.bootstrapDenied !== "boolean"
  ) {
    throw new Error(`protected evidence producer map entry ${kind} is invalid`);
  }
  const zeroPins = value.signerSha === ZERO_SHA && value.workflowFileSha256 === ZERO_SHA256;
  const nonzeroPins = value.signerSha !== ZERO_SHA && value.workflowFileSha256 !== ZERO_SHA256;
  if (
    (value.bootstrapDenied !== true || !zeroPins) &&
    (value.bootstrapDenied !== false || !nonzeroPins)
  ) {
    throw new Error(`protected evidence producer map entry ${kind} pin authorization is invalid`);
  }
  return frozenEntry(value);
}

function readStableMap(path) {
  const absolute = resolve(path);
  const before = lstatSync(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(MAX_MAP_BYTES)) {
    throw new Error("protected evidence producer map must be a bounded regular file");
  }
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("protected evidence producer map changed while opening");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(absolute, { bigint: true });
    if (
      bytes.length === 0 ||
      bytes.length > MAX_MAP_BYTES ||
      !sameIdentity(opened, after) ||
      !sameIdentity(after, pathAfter)
    ) {
      throw new Error("protected evidence producer map changed while reading");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function loadProtectedEvidenceProducerMap(path = DEFAULT_MAP_PATH) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("protected evidence producer map path is invalid");
  }
  const source = readStableMap(path).toString("utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("protected evidence producer map is invalid JSON");
  }
  exactObject(value, KINDS, "protected evidence producer map");
  const result = {};
  for (const kind of KINDS) result[kind] = validateEntry(kind, value[kind]);
  return Object.freeze(result);
}

export function producerFor(kind) {
  if (typeof kind !== "string" || !Object.hasOwn(EXPECTED, kind)) {
    throw new Error("protected evidence producer kind is unknown");
  }
  return loadProtectedEvidenceProducerMap()[kind];
}

function isHashOnlyField(key, value) {
  return (
    /(?:sha256|hash|digest)$/i.test(key) &&
    typeof value === "string" &&
    (SHA256.test(value) || IMAGE_DIGEST.test(value))
  );
}

function hasRawSqlFieldToken(key) {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/);
  return tokens.some((token) => /^(?:sql|query|statement)$/i.test(token));
}

function scanRedacted(value, path = "$", seen = new Set()) {
  if (typeof value === "string") {
    if (
      SECRET_VALUES.some((pattern) => pattern.test(value)) ||
      RAW_SQL.test(value) ||
      ENDPOINT_VALUE.test(value) ||
      DOTENV_VALUE.test(value)
    ) {
      throw new Error(`protected evidence contains unsafe redacted content at ${path}`);
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("protected evidence is not finite JSON");
    return;
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    throw new Error("protected evidence is not plain JSON");
  }
  if (seen.has(value)) throw new Error("protected evidence contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanRedacted(child, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      const hashOnly = isHashOnlyField(key, child);
      const safeAbsenceProof = key === "providerCredentialsPresent" && child === false;
      if (
        (!hashOnly && !safeAbsenceProof && SECRET_KEY.test(key)) ||
        (!hashOnly && hasRawSqlFieldToken(key)) ||
        (!hashOnly && /(?:database|db|ssh|provider).*(?:endpoint|host|url|address)/i.test(key)) ||
        /_FILE$/i.test(key) ||
        (!hashOnly && /(?:target|message|payload|error)/i.test(key)) ||
        (!hashOnly && /(?:account|username|principal|userId)/i.test(key))
      ) {
        throw new Error(`protected evidence contains an unsafe redacted field at ${path}.${key}`);
      }
      scanRedacted(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function validateProducer(value, mapped) {
  exactObject(value, PRODUCER_FIELDS, "protected evidence producer");
  if (
    value.repository !== "fastest4u/SPX" ||
    value.environment !== mapped.environment ||
    value.workflow !== mapped.workflow ||
    value.workflowSha !== mapped.signerSha ||
    value.workflowFileSha256 !== mapped.workflowFileSha256
  ) {
    throw new Error("protected evidence producer provenance does not match the map");
  }
}

function validateSignaturePair(primary, signature, signatureBytes) {
  exactObject(signature, SIGNATURE_FIELDS, "protected evidence signature file");
  if (
    signature.schemaVersion !== 1 ||
    signature.algorithm !== "kms-sha256" ||
    !SAFE_KEY_ID.test(signature.keyId ?? "") ||
    !SHA256.test(signature.subjectSha256 ?? "") ||
    typeof signature.signatureBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      signature.signatureBase64,
    ) ||
    signature.signatureBase64.length === 0 ||
    typeof signature.signedAt !== "string" ||
    !Number.isFinite(Date.parse(signature.signedAt)) ||
    new Date(signature.signedAt).toISOString() !== signature.signedAt
  ) {
    throw new Error("protected evidence signature file is invalid");
  }
  if (!SHA256.test(primary.signatureSha256 ?? "")) {
    throw new Error("protected evidence signature digest is missing");
  }
  const expectedSignatureSha256 = createHash("sha256").update(signatureBytes).digest("hex");
  if (primary.signatureSha256 !== expectedSignatureSha256) {
    throw new Error("protected evidence signature-file digest mismatch");
  }
  const core = { ...primary };
  delete core.signatureSha256;
  if (signature.subjectSha256 !== sha256Canonical(core)) {
    throw new Error("protected evidence signed core subject digest mismatch");
  }
}

export async function assertProtectedEvidenceFileSet(kind, root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("protected evidence root is invalid");
  }
  const mapped = producerFor(kind);
  const absoluteRoot = resolve(root);
  const directoryBefore = await lstat(absoluteRoot, { bigint: true });
  await assertEvidenceDirectory(absoluteRoot, mapped.files);
  const files = [];
  let totalBytes = 0;
  for (const name of mapped.files) {
    const loaded = await readEvidenceBytes(resolve(absoluteRoot, name), {
      maxFileBytes: MAX_FILE_BYTES,
    });
    totalBytes += loaded.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("protected evidence file set exceeds the total size limit");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(loaded);
    } catch {
      throw new Error("protected evidence file is not valid UTF-8");
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("protected evidence file is not valid JSON");
    }
    if (text !== canonicalJson(value)) {
      throw new Error("protected evidence file must be canonical JSON");
    }
    scanRedacted(value);
    freezeJson(value);
    const bytes = Buffer.from(loaded);
    files.push(
      Object.freeze({
        name,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        value,
      }),
    );
  }
  await assertEvidenceDirectory(absoluteRoot, mapped.files);
  const directoryAfter = await lstat(absoluteRoot, { bigint: true });
  if (!sameIdentity(directoryBefore, directoryAfter)) {
    throw new Error("protected evidence directory changed while validating");
  }
  const primary = files[0].value;
  if (!isPlainObject(primary)) throw new Error("protected evidence primary file is invalid");
  validateProducer(primary.producer, mapped);
  if (files.length === 2) {
    validateSignaturePair(primary, files[1].value, files[1].bytes);
  }
  return Object.freeze({
    kind,
    producer: mapped,
    files: Object.freeze(files),
  });
}
