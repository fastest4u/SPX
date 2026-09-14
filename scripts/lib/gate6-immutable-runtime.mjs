import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalGate6Json } from "../../src/services/gate6-approval-runtime.mjs";

export const GATE6_SUPERVISOR_PARENT = "/var/lib/spx-gate6/supervisors";
export const GATE6_RELEASE_PARENT = "/root/spx-releases";
export const GATE6_PRODUCTION_ENV_FILE = "/etc/spx-production/runtime.env";
export const GATE6_SUPERVISOR_INDEX = "operator-bundle.index.json";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_ENTRYPOINTS = Object.freeze([
  "migrations/released-checksums.json",
  "scripts/gate6-host-watchdog.mjs",
  "scripts/gate6-rollback-coordinator.mjs",
  "scripts/lib/gate6-immutable-runtime.mjs",
  "scripts/lib/gate6-mysql-ledger.mjs",
  "scripts/lib/gate6-runtime-context.mjs",
  "scripts/production-canary-monitor.mjs",
  "src/services/gate6-approval-runtime.mjs",
]);
const UNIT_NAMES = Object.freeze({
  watchdog: "spx-gate6-watchdog",
  monitor: "spx-gate6-monitor",
  "rollback-supervisor": "spx-gate6-rollback-supervisor",
});

export function assertGate6CandidateSha(value, label = "Gate 6 candidate SHA") {
  if (!COMMIT_SHA.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}

export function gate6InstanceUnit(kind, instance, context) {
  const prefix = UNIT_NAMES[kind];
  if (!prefix) throw new Error("Gate 6 systemd unit kind is invalid");
  assertGate6CandidateSha(instance, "Gate 6 systemd instance");
  if (context && context.candidateSha !== instance) {
    throw new Error("Gate 6 systemd instance does not match the runtime context");
  }
  return `${prefix}@${instance}.service`;
}

function pathWithin(root, relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error("Gate 6 operator index path is invalid");
  const path = resolve(root, ...relativePath.split("/"));
  const rel = relative(resolve(root), path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Gate 6 operator index path escapes its root");
  }
  return path;
}

async function assertSecureNode(path, kind, options = {}) {
  const stat = await lstat(path, { bigint: true });
  const correctKind = kind === "file" ? stat.isFile() : stat.isDirectory();
  if (stat.isSymbolicLink() || !correctKind) throw new Error(`Gate 6 ${kind} is insecure`);
  if (process.platform !== "win32" && options.allowNonRoot !== true) {
    if (stat.uid !== 0n || Number(stat.mode & 0o022n) !== 0) {
      throw new Error(`Gate 6 ${kind} is not immutable and root-owned`);
    }
  }
  return stat;
}

async function readStableFile(path, options = {}) {
  const before = await assertSecureNode(path, "file", options);
  const maximumBytes = options.maximumBytes ?? MAX_FILE_BYTES;
  if (before.size <= 0n || before.size > BigInt(maximumBytes)) {
    throw new Error("Gate 6 immutable file size is invalid");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Gate 6 immutable file changed during open");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
    ) throw new Error("Gate 6 immutable file changed during read");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertDirectoryChain(root, relativePath, options) {
  let current = root;
  await assertSecureNode(current, "directory", options);
  for (const part of relativePath.split("/").slice(0, -1)) {
    current = join(current, part);
    await assertSecureNode(current, "directory", options);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readDeploymentContext(candidateSha, options) {
  const releaseRoot = resolve(options.releaseParent, candidateSha);
  await assertSecureNode(options.releaseParent, "directory", options);
  await assertSecureNode(releaseRoot, "directory", options);
  const path = join(releaseRoot, "deployment-context.json");
  const bytes = await readStableFile(path, { ...options, maximumBytes: 256 * 1024 });
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Gate 6 installed deployment context is invalid");
  }
  if (
    value?.sourceSha !== candidateSha
    || !SHA256.test(value?.operatorBundleSha256 ?? "")
    || !SHA256.test(value?.operatorIndexSha256 ?? "")
  ) throw new Error("Gate 6 installed deployment context binding is invalid");
  return { value, releaseRoot };
}

export async function verifyGate6CandidateRelease(input) {
  const candidateSha = assertGate6CandidateSha(input.candidateSha);
  const releaseParent = resolve(input.releaseParent ?? GATE6_RELEASE_PARENT);
  const environmentFile = resolve(input.environmentFile ?? GATE6_PRODUCTION_ENV_FILE);
  const options = { allowNonRoot: input.allowNonRoot === true, releaseParent };
  const deployment = await readDeploymentContext(candidateSha, options);
  if (deployment.value.operatorBundleSha256 !== input.operatorBundleSha256) {
    throw new Error("Gate 6 candidate operator bundle binding is invalid");
  }
  const candidateOperatorRoot = join(deployment.releaseRoot, "operator");
  await assertSecureNode(candidateOperatorRoot, "directory", options);
  const composeFile = join(candidateOperatorRoot, "docker-compose.yml");
  await readStableFile(composeFile, options);
  await readStableFile(environmentFile, options);
  return Object.freeze({
    candidateSha,
    releaseRoot: deployment.releaseRoot,
    candidateOperatorRoot,
    composeFile,
    environmentFile,
    operatorBundleSha256: deployment.value.operatorBundleSha256,
    operatorIndexSha256: deployment.value.operatorIndexSha256,
  });
}

function validateIndex(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || canonicalGate6Json(Object.keys(value).sort())
      !== canonicalGate6Json(["schemaVersion", "format", "files"].sort())
    || value.schemaVersion !== 1
    || value.format !== "ustar"
    || !Array.isArray(value.files)
    || value.files.length === 0
  ) throw new Error("Gate 6 supervisor operator index is invalid");
  const paths = new Set();
  for (const entry of value.files) {
    if (
      entry === null
      || typeof entry !== "object"
      || Array.isArray(entry)
      || canonicalGate6Json(Object.keys(entry).sort())
        !== canonicalGate6Json(["path", "sha256", "size", "mode"].sort())
      || typeof entry.path !== "string"
      || !SHA256.test(entry.sha256 ?? "")
      || !Number.isSafeInteger(entry.size)
      || entry.size < 1
      || entry.size > MAX_FILE_BYTES
      || entry.mode !== "0644"
      || paths.has(entry.path)
    ) throw new Error("Gate 6 supervisor operator index entry is invalid");
    paths.add(entry.path);
  }
  return { value, paths };
}

export async function verifyGate6SupervisorInstall(input) {
  const instance = assertGate6CandidateSha(input.instance, "Gate 6 supervisor instance");
  if (input.context?.candidateSha !== instance) {
    throw new Error("Gate 6 supervisor instance does not match the runtime context");
  }
  if (
    !COMMIT_SHA.test(input.context?.rollbackSha ?? "")
    || !SHA256.test(input.context?.operatorBundleSha256 ?? "")
  ) throw new Error("Gate 6 supervisor runtime context binding is invalid");
  const release = await verifyGate6CandidateRelease({
    candidateSha: instance,
    operatorBundleSha256: input.context.operatorBundleSha256,
    releaseParent: input.releaseParent,
    environmentFile: input.environmentFile,
    allowNonRoot: input.allowNonRoot,
  });
  const supervisorParent = resolve(input.supervisorParent ?? GATE6_SUPERVISOR_PARENT);
  const supervisorRoot = resolve(supervisorParent, instance);
  const options = { allowNonRoot: input.allowNonRoot === true };
  await assertSecureNode(supervisorParent, "directory", options);
  await assertSecureNode(supervisorRoot, "directory", options);
  const indexPath = join(supervisorRoot, GATE6_SUPERVISOR_INDEX);
  const indexBytes = await readStableFile(indexPath, { ...options, maximumBytes: MAX_INDEX_BYTES });
  if (sha256(indexBytes) !== release.operatorIndexSha256) {
    throw new Error("Gate 6 supervisor operator index checksum mismatch");
  }
  let parsed;
  try {
    parsed = JSON.parse(indexBytes.toString("utf8"));
  } catch {
    throw new Error("Gate 6 supervisor operator index JSON is invalid");
  }
  if (canonicalGate6Json(parsed) !== indexBytes.toString("utf8")) {
    throw new Error("Gate 6 supervisor operator index is not canonical JSON");
  }
  const index = validateIndex(parsed);
  const required = input.requiredEntrypoints ?? DEFAULT_ENTRYPOINTS;
  for (const path of required) {
    if (!index.paths.has(path)) throw new Error(`Gate 6 supervisor entrypoint is not indexed: ${path}`);
  }
  for (const entry of index.value.files) {
    const path = pathWithin(supervisorRoot, entry.path);
    await assertDirectoryChain(supervisorRoot, entry.path, options);
    const bytes = await readStableFile(path, options);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`Gate 6 supervisor file checksum or size mismatch: ${entry.path}`);
    }
  }
  return Object.freeze({ ...release, supervisorRoot, indexPath });
}

export function candidateGate6ComposePrefix(verifiedRelease) {
  if (
    !COMMIT_SHA.test(verifiedRelease?.candidateSha ?? "")
    || !isAbsolute(verifiedRelease?.composeFile ?? "")
    || !isAbsolute(verifiedRelease?.environmentFile ?? "")
  ) throw new Error("Gate 6 verified candidate release is invalid");
  return Object.freeze([
    "compose", "--project-name", "spx-production",
    "--env-file", verifiedRelease.environmentFile,
    "--file", verifiedRelease.composeFile,
  ]);
}

export function parseGate6InstanceArguments(argv, action) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== action) {
    throw new Error("Gate 6 supervisor arguments are invalid");
  }
  const match = /^--instance=([0-9a-f]{40})$/.exec(argv[1]);
  if (!match) throw new Error("Gate 6 supervisor instance argument is invalid");
  return match[1];
}
