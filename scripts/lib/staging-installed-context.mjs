import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import { canonicalJson, readEvidenceJson, validateReleaseBinding } from "./evidence-artifact.mjs";

const INSTALLED_BINDING_PATH = "/var/lib/spx-staging-rollout/verified-release-binding.json";
const INSTALLED_TRUST_PATH = "/etc/spx-staging/staging-rollout-trust.json";
const STAGING_ACTIVE_PROJECTION = "/opt/spx-staging/release/current";
const STAGING_OPERATOR_PATTERN = /^\/opt\/spx-staging\/release\/([0-9a-f]{40})\/operator$/;
const PRODUCTION_ACTIVE_PROJECTION = "/root/SPX";
const PRODUCTION_RELEASE_PATTERN = /^\/root\/spx-releases\/[0-9a-f]{40}\/operator$/;
const ROLLOUT_ENVIRONMENTS = ["staging", "supervised-production"];
const TEST_TRUST_GLOBAL = "__SPX_TEST_INSTALLED_STAGING_TRUST__";
const TEST_BINDING_GLOBAL = "__SPX_TEST_INSTALLED_RELEASE_BINDING__";

function requestedEnvironment(options = {}) {
  const environment = options.environment ?? "staging";
  if (!ROLLOUT_ENVIRONMENTS.includes(environment)) {
    throw new Error("installed release binding environment is invalid");
  }
  return environment;
}

async function productionBindingPath() {
  let activeProjection;
  let activePath;
  try {
    [activeProjection, activePath] = await Promise.all([
      lstat(PRODUCTION_ACTIVE_PROJECTION, { bigint: true }),
      realpath(PRODUCTION_ACTIVE_PROJECTION),
    ]);
  } catch {
    throw new Error("installed supervised-production release binding is not installed");
  }
  const resolvedActivePath = resolve(activePath);
  if (!activeProjection.isSymbolicLink() || !PRODUCTION_RELEASE_PATTERN.test(resolvedActivePath)) {
    throw new Error("installed supervised-production release projection is invalid");
  }
  const activeDirectory = await lstat(resolvedActivePath, { bigint: true });
  if (activeDirectory.isSymbolicLink() || !activeDirectory.isDirectory()) {
    throw new Error("installed supervised-production release projection is invalid");
  }
  if (process.platform !== "win32") {
    if (Number(activeDirectory.uid) !== 0 || (Number(activeDirectory.mode & 0o777n) & 0o022) !== 0) {
      throw new Error("installed supervised-production release projection is not trusted");
    }
  }
  return join(dirname(resolvedActivePath), "verified-release-binding.json");
}

async function installedPath(kind, environment = "staging") {
  if (kind === "trust") return INSTALLED_TRUST_PATH;
  return environment === "staging" ? INSTALLED_BINDING_PATH : productionBindingPath();
}

async function assertInstalledFile(path, label) {
  let file;
  let parent;
  try {
    [file, parent] = await Promise.all([
      lstat(path, { bigint: true }),
      lstat(dirname(path), { bigint: true }),
    ]);
  } catch {
    throw new Error(`${label} is not installed`);
  }
  if (file.isSymbolicLink() || !file.isFile()) throw new Error(`${label} is not a regular file`);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent is not a regular directory`);
  }
  if (process.platform !== "win32") {
    if (Number(file.uid) !== 0 || Number(parent.uid) !== 0) {
      throw new Error(`${label} must be root owned`);
    }
    if (![0o400, 0o440, 0o444].includes(Number(file.mode & 0o777n))) {
      throw new Error(`${label} must be read only`);
    }
    if ((Number(parent.mode & 0o777n) & 0o077) !== 0) {
      throw new Error(`${label} parent permissions are too broad`);
    }
  }
}

async function loadInstalledJson(kind, label, environment = "staging") {
  const path = await installedPath(kind, environment);
  await assertInstalledFile(path, label);
  try {
    return await readEvidenceJson(path, { maxFileBytes: 256 * 1024, requireCanonical: true });
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

export async function loadInstalledReleaseBinding(options = {}) {
  const environment = requestedEnvironment(options);
  if (
    process.env.NODE_ENV === "test" &&
    Object.prototype.hasOwnProperty.call(globalThis, TEST_BINDING_GLOBAL)
  ) {
    const binding = Object.freeze({ ...validateReleaseBinding(globalThis[TEST_BINDING_GLOBAL]) });
    if (binding.environment !== environment) {
      throw new Error("release binding environment does not match the installed target");
    }
    return binding;
  }
  const label = `installed ${environment} release binding`;
  const value = await loadInstalledJson("binding", label, environment);
  const binding = Object.freeze({ ...validateReleaseBinding(value) });
  if (binding.environment !== environment) {
    throw new Error("release binding environment does not match the installed target");
  }
  return binding;
}

export function validateInstalledStagingOperatorProjection(input) {
  const binding = validateReleaseBinding(input?.binding);
  const expected = `/opt/spx-staging/release/${binding.candidateSha}/operator`;
  const expectedUid = input?.expectedUid ?? (process.platform === "win32" ? null : 0);
  if (
    binding.environment !== "staging" ||
    input?.projectionPath !== STAGING_ACTIVE_PROJECTION ||
    input?.resolvedPath?.replaceAll("\\", "/") !== expected ||
    input?.projectionIsSymlink !== true ||
    input?.targetIsSymlink !== false ||
    input?.targetIsDirectory !== true ||
    (expectedUid !== null &&
      (input?.targetUid !== expectedUid || (Number(input?.targetMode) & 0o022) !== 0))
  ) {
    throw new Error("installed staging operator projection is not bound to the trusted candidate");
  }
  return expected;
}

export async function loadInstalledStagingOperatorRoot(binding) {
  const installedBinding = binding ?? await loadInstalledReleaseBinding({ environment: "staging" });
  let projection;
  let resolvedPath;
  try {
    [projection, resolvedPath] = await Promise.all([
      lstat(STAGING_ACTIVE_PROJECTION, { bigint: true }),
      realpath(STAGING_ACTIVE_PROJECTION),
    ]);
  } catch {
    throw new Error("installed staging operator projection is unavailable");
  }
  const target = await lstat(resolvedPath, { bigint: true });
  return validateInstalledStagingOperatorProjection({
    binding: installedBinding,
    projectionPath: STAGING_ACTIVE_PROJECTION,
    resolvedPath,
    projectionIsSymlink: projection.isSymbolicLink(),
    targetIsSymlink: target.isSymbolicLink(),
    targetIsDirectory: target.isDirectory(),
    targetUid: process.platform === "win32" ? null : Number(target.uid),
    targetMode: Number(target.mode & 0o777n),
  });
}

export function buildInstalledStagingComposePrefix(operatorRoot) {
  if (!STAGING_OPERATOR_PATTERN.test(operatorRoot ?? "")) {
    throw new Error("verified release-specific staging operator root is required");
  }
  return [
    "compose",
    "-p",
    "spx-staging",
    "--env-file",
    "/etc/spx-staging/runtime.env",
    "-f",
    `${operatorRoot}/docker-compose.yml`,
    "-f",
    `${operatorRoot}/docker-compose.staging.yml`,
  ];
}

export function buildInstalledStagingComposeEnvironment(binding, operatorRoot) {
  const installedBinding = validateReleaseBinding(binding);
  const match = STAGING_OPERATOR_PATTERN.exec(operatorRoot ?? "");
  if (
    installedBinding.environment !== "staging" ||
    !match ||
    match[1] !== installedBinding.candidateSha
  ) {
    throw new Error("staging Compose environment is not bound to the installed release");
  }
  const releaseParent = posix.dirname(operatorRoot);
  return {
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    SPX_IMAGE: installedBinding.imageDigest,
    SPX_RELEASE_SHA: installedBinding.candidateSha,
    SPX_TARGET_DESCRIPTOR_SHA256: installedBinding.stagingTargetDescriptorSha256,
    SPX_OPERATOR_BUNDLE_SHA256: installedBinding.operatorBundleSha256,
    SPX_RUNTIME_ENVIRONMENT: "staging",
    SPX_STAGING_RUN_ID: installedBinding.stagingRunId,
    SPX_RELEASE_MANIFEST_PATH: `${releaseParent}/release-manifest.json`,
    SPX_TARGET_DESCRIPTOR_PATH: `${releaseParent}/deployment-target-descriptor.json`,
    SPX_DEPLOYMENT_CONTEXT_PATH: `${releaseParent}/deployment-context.json`,
  };
}

export async function loadInstalledStagingTrust() {
  if (
    process.env.NODE_ENV === "test" &&
    Object.prototype.hasOwnProperty.call(globalThis, TEST_TRUST_GLOBAL)
  ) {
    return structuredClone(globalThis[TEST_TRUST_GLOBAL]);
  }
  return loadInstalledJson("trust", "installed staging trust policy");
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function installVerifiedReleaseBinding(value) {
  const binding = Object.freeze({ ...validateReleaseBinding(value) });
  if (binding.environment !== "staging") {
    throw new Error("only staging release bindings may be installed in mutable rollout state");
  }
  if (
    process.env.NODE_ENV === "test" &&
    Object.prototype.hasOwnProperty.call(globalThis, TEST_BINDING_GLOBAL)
  ) {
    globalThis[TEST_BINDING_GLOBAL] = structuredClone(binding);
    return binding;
  }
  const path = await installedPath("binding");
  const parentPath = dirname(path);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parentRealPath = resolve(await realpath(parentPath));
  const expectedParentPath = resolve(parentPath);
  if (
    (process.platform === "win32" &&
      parentRealPath.toLowerCase() !== expectedParentPath.toLowerCase()) ||
    (process.platform !== "win32" && parentRealPath !== expectedParentPath)
  ) {
    throw new Error("installed staging release binding parent is not canonical");
  }
  const parent = await lstat(parentPath, { bigint: true });
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("installed staging release binding parent is invalid");
  }
  if (process.platform !== "win32") {
    if (Number(parent.uid) !== 0 || Number(parent.mode & 0o777n) !== 0o700) {
      throw new Error("installed staging release binding parent must be root owned mode 0700");
    }
  }

  const temporaryPath = resolve(parentPath, `.verified-release-binding.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o400);
  try {
    await handle.writeFile(Buffer.from(canonicalJson(binding)));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (process.platform === "win32") await rm(path, { force: true });
    await rename(temporaryPath, path);
    await syncDirectory(parentPath);
    await assertInstalledFile(path, "installed staging release binding");
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return binding;
}
