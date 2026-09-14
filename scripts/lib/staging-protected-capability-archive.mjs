import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { canonicalJson } from "./evidence-artifact.mjs";
import {
  STAGING_PROVISIONED_DB_ROLES,
  validateStagingActionCapability,
} from "./staging-action-capability.mjs";
import {
  validateStagingProductionObserverPolicyBytes,
  validateStagingProductionObserverTokenBytes,
} from "./staging-production-observer-policy.mjs";

const MAX_ARCHIVE_BYTES = 1_048_576;
const MAX_CAPABILITY_BYTES = 256 * 1024;
const MAX_CA_BYTES = 256 * 1024;
const MAX_POLICY_BYTES = 8_192;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4_096;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS = Object.freeze([
  "action-capability.json",
  "database/",
  "database/bootstrap.password",
  "database/phase3-control.password",
  ...STAGING_PROVISIONED_DB_ROLES.map((role) => `database/principal-${role}.password`),
  "db-ca.pem",
  "phase3-production-observer-policy.json",
  "phase3-production-observer-token",
].sort());

const EXPECTED_MEMBERS = new Set(STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS);

function invalidArchive() {
  throw new Error("protected staging capability archive is invalid");
}

function invalidExtraction() {
  throw new Error("protected staging capability extraction is invalid");
}

function asciiField(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  const used = zero === -1 ? field : field.subarray(0, zero);
  if ([...used].some((value) => value < 0x20 || value > 0x7e)) invalidArchive();
  if (zero !== -1 && field.subarray(zero).some((value) => value !== 0)) invalidArchive();
  return used.toString("ascii");
}

function octalField(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) invalidArchive();
  const text = field.toString("ascii").replace(/[\0 ]+$/g, "").trimStart();
  if (!/^[0-7]+$/.test(text)) invalidArchive();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) invalidArchive();
  return value;
}

function expectedSize(name, size) {
  if (name === "database/") return size === 0;
  if (name === "action-capability.json") return size >= 1 && size <= MAX_CAPABILITY_BYTES;
  if (name === "db-ca.pem") return size >= 1 && size <= MAX_CA_BYTES;
  if (name === "phase3-production-observer-policy.json") {
    return size >= 1 && size <= MAX_POLICY_BYTES;
  }
  return size >= MIN_SECRET_BYTES && size <= MAX_SECRET_BYTES;
}

function assertSafeMemberName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part, index, parts) =>
      part === "." || part === ".." || (part === "" && index !== parts.length - 1))
  ) invalidArchive();
}

export function validateStagingProtectedCapabilityArchiveBytes(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1_024 ||
    bytes.byteLength > MAX_ARCHIVE_BYTES ||
    bytes.byteLength % 512 !== 0
  ) invalidArchive();
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const members = [];
  const seen = new Set();
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= source.length) {
    const header = source.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (offset + 1_024 > source.length) invalidArchive();
      if (!source.subarray(offset).every((value) => value === 0)) invalidArchive();
      terminated = true;
      break;
    }
    const storedChecksum = octalField(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = [...checksumHeader].reduce((sum, value) => sum + value, 0);
    if (storedChecksum !== actualChecksum) invalidArchive();
    if (header.subarray(257, 263).toString("latin1") !== "ustar\0") invalidArchive();
    if (header.subarray(263, 265).toString("ascii") !== "00") invalidArchive();
    if (asciiField(header, 345, 155) !== "") invalidArchive();
    const name = asciiField(header, 0, 100);
    assertSafeMemberName(name);
    if (!EXPECTED_MEMBERS.has(name) || seen.has(name)) invalidArchive();
    const type = String.fromCharCode(header[156] || 0);
    const isDirectory = type === "5";
    const isRegular = type === "0" || type === "\0";
    if ((name === "database/" && !isDirectory) || (name !== "database/" && !isRegular)) {
      invalidArchive();
    }
    if (asciiField(header, 157, 100) !== "") invalidArchive();
    const mode = octalField(header, 100, 8);
    const uid = octalField(header, 108, 8);
    const gid = octalField(header, 116, 8);
    const size = octalField(header, 124, 12);
    if (uid !== 0 || gid !== 0 || mode !== (isDirectory ? 0o700 : 0o400)) invalidArchive();
    if (!expectedSize(name, size)) invalidArchive();
    const padded = Math.ceil(size / 512) * 512;
    if (offset + 512 + padded > source.length) invalidArchive();
    seen.add(name);
    members.push(name);
    offset += 512 + padded;
  }
  if (!terminated) invalidArchive();
  const ordered = [...members].sort();
  if (canonicalJson(ordered) !== canonicalJson(STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS)) {
    invalidArchive();
  }
  return Object.freeze({ schemaVersion: 1, members: Object.freeze(ordered) });
}

function decode(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function parseContinuousPolicy(bytes) {
  const label = "continuous production observer policy";
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_POLICY_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  const text = decode(bytes, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    canonicalJson(value) !== text ||
    canonicalJson(Object.keys(value ?? {}).sort()) !== canonicalJson(["credentialPath", "endpoint"]) ||
    value.credentialPath !== "/run/credentials/spx-production-observer-token" ||
    typeof value.endpoint !== "string"
  ) throw new Error(`${label} is invalid`);
  let endpoint;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error(`${label} is invalid`);
  }
  return value.endpoint;
}

function parseFinalPolicy(bytes, expectedSha256) {
  validateStagingProductionObserverPolicyBytes(bytes, expectedSha256);
  try {
    return JSON.parse(decode(bytes, "staging production observer policy")).endpoint;
  } catch {
    throw new Error("staging production observer policy is invalid");
  }
}

function validatePassword(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < MIN_SECRET_BYTES || bytes.byteLength > MAX_SECRET_BYTES) {
    invalidExtraction();
  }
  const value = decode(bytes, "protected staging database password");
  if (value.trim() !== value || /[\r\n\0]/.test(value)) invalidExtraction();
}

async function listExtracted(root) {
  const result = [];
  const visit = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativeName = `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      result.push(relativeName);
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${prefix}${entry.name}/`);
    }
  };
  await visit(root);
  return result.sort();
}

async function readExactLeaf(root, name) {
  const path = join(root, ...name.split("/"));
  const status = await lstat(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isFile() || Number(status.nlink) !== 1) invalidExtraction();
  const size = Number(status.size);
  if (!expectedSize(name, size)) invalidExtraction();
  return readFile(path);
}

export async function validateExtractedStagingProtectedCapability(root, options) {
  try {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      canonicalJson(Object.keys(options).sort()) !==
        canonicalJson([
          "continuousPolicyBytes",
          "expectedPolicySha256",
          "installedBinding",
          "signedAccountHosts",
        ].sort())
    ) invalidExtraction();
    const absoluteRoot = resolve(root);
    const [rootStatus, canonicalRoot] = await Promise.all([lstat(absoluteRoot, { bigint: true }), realpath(absoluteRoot)]);
    if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory() || resolve(canonicalRoot) !== absoluteRoot) {
      invalidExtraction();
    }
    const databaseStatus = await lstat(join(absoluteRoot, "database"), { bigint: true });
    if (databaseStatus.isSymbolicLink() || !databaseStatus.isDirectory()) invalidExtraction();
    if (canonicalJson(await listExtracted(absoluteRoot)) !== canonicalJson(STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS)) {
      invalidExtraction();
    }
    const contents = new Map();
    for (const name of STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS) {
      if (name !== "database/") contents.set(name, await readExactLeaf(absoluteRoot, name));
    }
    const capabilityBytes = contents.get("action-capability.json");
    const capabilityText = decode(capabilityBytes, "staging action capability");
    const capability = JSON.parse(capabilityText);
    if (canonicalJson(capability) !== capabilityText) invalidExtraction();
    validateStagingActionCapability(capability, options.installedBinding);
    if (canonicalJson(capability.database.principalRoles) !== canonicalJson(STAGING_PROVISIONED_DB_ROLES)) {
      invalidExtraction();
    }
    if (
      !options.signedAccountHosts ||
      typeof options.signedAccountHosts !== "object" ||
      Array.isArray(options.signedAccountHosts) ||
      canonicalJson(Object.keys(options.signedAccountHosts).sort()) !==
        canonicalJson([...STAGING_PROVISIONED_DB_ROLES].sort()) ||
      Object.values(options.signedAccountHosts).some((host) =>
        typeof host !== "string" ||
        host.length < 1 ||
        host.length > 255 ||
        host !== host.trim() ||
        /[%_]/.test(host) ||
        !/^[A-Za-z0-9.:-]+$/.test(host))
    ) invalidExtraction();
    const ca = contents.get("db-ca.pem");
    if (createHash("sha256").update(ca).digest("hex") !== capability.database.caSha256) {
      invalidExtraction();
    }
    const finalPolicy = contents.get("phase3-production-observer-policy.json");
    const finalEndpoint = parseFinalPolicy(finalPolicy, options.expectedPolicySha256);
    validateStagingProductionObserverTokenBytes(
      contents.get("phase3-production-observer-token"),
    );
    for (const name of STAGING_PROTECTED_CAPABILITY_ARCHIVE_MEMBERS) {
      if (name.endsWith(".password")) validatePassword(contents.get(name));
    }
    if (!contents.has("database/principal-phase3-observer.password")) invalidExtraction();
    if (finalEndpoint !== parseContinuousPolicy(options.continuousPolicyBytes)) invalidExtraction();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "protected staging capability extraction is invalid") {
      throw error;
    }
    invalidExtraction();
  }
}

async function readArchive(path) {
  const status = await lstat(path, { bigint: true });
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    Number(status.nlink) !== 1 ||
    Number(status.size) < 1_024 ||
    Number(status.size) > MAX_ARCHIVE_BYTES
  ) invalidArchive();
  return readFile(path);
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const values = {};
  for (const token of tokens) {
    const match = /^--(archive|root|target-descriptor|continuous-policy)=(.+)$/.exec(token);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("invalid arguments");
    values[match[1]] = match[2];
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "list-roles" && Object.keys(values).length === 0) {
    process.stdout.write(`${STAGING_PROVISIONED_DB_ROLES.join("\n")}\n`);
    return;
  }
  if (command === "validate-archive" && Object.keys(values).join(",") === "archive") {
    validateStagingProtectedCapabilityArchiveBytes(await readArchive(values.archive));
    return;
  }
  if (
    command === "validate-extracted" &&
    canonicalJson(Object.keys(values).sort()) ===
      canonicalJson(["continuous-policy", "root", "target-descriptor"])
  ) {
    const capability = JSON.parse(
      await readFile(join(resolve(values.root), "action-capability.json"), "utf8"),
    );
    const descriptor = JSON.parse(await readFile(resolve(values["target-descriptor"]), "utf8"));
    await validateExtractedStagingProtectedCapability(values.root, {
      installedBinding: capability.releaseBinding,
      expectedPolicySha256: descriptor?.target?.productionObserverPolicySha256,
      signedAccountHosts: descriptor?.database?.accountHosts,
      continuousPolicyBytes: await readFile(resolve(values["continuous-policy"])),
    });
    return;
  }
  throw new Error("invalid arguments");
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
