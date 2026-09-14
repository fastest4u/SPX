#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STAGING_ACTION_HANDLER_MANIFEST,
  STAGING_ACTION_HANDLER_ROOT,
  handlerWrapperSource,
  validateStagingActionHandlerManifest,
} from "./lib/staging-action-handler-manifest.mjs";

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function expectedOwner(options) {
  if (options.expectedUid !== undefined) return options.expectedUid;
  return process.platform === "win32" ? null : 0;
}

async function assertDirectory(path, label, options = {}) {
  const [status, canonical] = await Promise.all([lstat(path, { bigint: true }), realpath(path)]);
  if (status.isSymbolicLink() || !status.isDirectory() || !samePath(canonical, path)) {
    throw new Error(`${label} must be a canonical non-symlink directory`);
  }
  const uid = expectedOwner(options);
  if (uid !== null) {
    if (Number(status.uid) !== uid || (Number(status.mode & 0o777n) & 0o022) !== 0) {
      throw new Error(`${label} must be root owned and not group/world writable`);
    }
  }
  return status;
}

async function assertTrustedSources(sourceRoot, options = {}) {
  await assertDirectory(sourceRoot, "verified staging operator root", options);
  for (const entry of STAGING_ACTION_HANDLER_MANIFEST) {
    const path = resolve(sourceRoot, ...entry.script.split("/"));
    const [status, canonical] = await Promise.all([lstat(path, { bigint: true }), realpath(path)]);
    if (status.isSymbolicLink() || !status.isFile() || !samePath(canonical, path)) {
      throw new Error("fixed staging handler source must be a canonical regular file");
    }
    const uid = expectedOwner(options);
    if (
      uid !== null &&
      (Number(status.uid) !== uid || (Number(status.mode & 0o777n) & 0o022) !== 0)
    ) {
      throw new Error("fixed staging handler source must be root controlled");
    }
  }
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

export async function verifyInstalledStagingActionHandlers(options = {}) {
  validateStagingActionHandlerManifest();
  const handlerRoot = resolve(options.handlerRoot ?? STAGING_ACTION_HANDLER_ROOT);
  const root = await assertDirectory(handlerRoot, "fixed staging handler root", options);
  if (expectedOwner(options) !== null && Number(root.mode & 0o777n) !== 0o555) {
    throw new Error("fixed staging handler root permissions are invalid");
  }
  const entries = await readdir(handlerRoot, { withFileTypes: true });
  const expectedNames = STAGING_ACTION_HANDLER_MANIFEST.map((entry) => entry.actionId).sort();
  const actualNames = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("fixed staging handler coverage has a missing or extra executable");
  }
  for (const manifestEntry of STAGING_ACTION_HANDLER_MANIFEST) {
    const path = join(handlerRoot, manifestEntry.actionId);
    const [directoryEntry, status, canonical, content] = await Promise.all([
      Promise.resolve(entries.find((entry) => entry.name === manifestEntry.actionId)),
      lstat(path, { bigint: true }),
      realpath(path),
      readFile(path, "utf8"),
    ]);
    if (
      !directoryEntry?.isFile() ||
      directoryEntry.isSymbolicLink() ||
      status.isSymbolicLink() ||
      !status.isFile() ||
      !samePath(canonical, path)
    ) {
      throw new Error("fixed staging handler must be a canonical regular executable");
    }
    const uid = expectedOwner(options);
    if (
      uid !== null &&
      (Number(status.uid) !== uid || Number(status.mode & 0o777n) !== 0o555)
    ) {
      throw new Error("fixed staging handler ownership or permissions are invalid");
    }
    if (content !== handlerWrapperSource(manifestEntry)) {
      throw new Error("fixed staging handler content checksum is invalid or tampered");
    }
  }
  return { ok: true, count: STAGING_ACTION_HANDLER_MANIFEST.length };
}

async function writeHandler(path, content) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o500,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o555);
}

export async function installStagingActionHandlers(options = {}) {
  validateStagingActionHandlerManifest();
  if (typeof options.sourceRoot !== "string" || options.sourceRoot.length === 0) {
    throw new Error("verified release-specific staging operator root is required");
  }
  const sourceRoot = resolve(options.sourceRoot);
  const handlerRoot = resolve(options.handlerRoot ?? STAGING_ACTION_HANDLER_ROOT);
  await assertTrustedSources(sourceRoot, options);
  const parent = dirname(handlerRoot);
  try {
    await lstat(parent);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    await assertDirectory(dirname(parent), "fixed staging handler parent ancestor", options);
    await mkdir(parent, { mode: 0o755 });
  }
  await assertDirectory(parent, "fixed staging handler parent", options);

  try {
    await lstat(handlerRoot);
    const verified = await verifyInstalledStagingActionHandlers({
      ...options,
      handlerRoot,
    });
    return { ...verified, installed: false };
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }

  const stagingRoot = join(parent, `.spx-staging-actions.${randomUUID()}`);
  let staged = false;
  try {
    await mkdir(stagingRoot, { mode: 0o700 });
    staged = true;
    for (const entry of STAGING_ACTION_HANDLER_MANIFEST) {
      await writeHandler(join(stagingRoot, entry.actionId), handlerWrapperSource(entry));
    }
    await chmod(stagingRoot, 0o555);
    await syncDirectory(stagingRoot);
    await verifyInstalledStagingActionHandlers({
      ...options,
      handlerRoot: stagingRoot,
    });
    await rename(stagingRoot, handlerRoot);
    staged = false;
    await syncDirectory(parent);
    const verified = await verifyInstalledStagingActionHandlers({
      ...options,
      handlerRoot,
    });
    return { ...verified, installed: true };
  } finally {
    if (staged) await rm(stagingRoot, { recursive: true, force: true });
  }
}

const RELEASE_OPERATOR_PATTERN = /^\/opt\/spx-staging\/release\/([0-9a-f]{40})\/operator$/;

export function validateStagingOperatorReleaseIdentity(
  operatorRoot,
  releaseManifestBytes,
  deploymentContext,
) {
  const match = RELEASE_OPERATOR_PATTERN.exec(operatorRoot);
  if (!match) throw new Error("staging operator root is not release-specific");
  let releaseManifest;
  try {
    releaseManifest = JSON.parse(Buffer.from(releaseManifestBytes).toString("utf8"));
  } catch {
    throw new Error("staging operator release manifest is invalid");
  }
  const sourceSha = match[1];
  if (
    releaseManifest?.sourceSha !== sourceSha ||
    deploymentContext?.schemaVersion !== 1 ||
    deploymentContext?.target !== "staging" ||
    deploymentContext?.sourceSha !== sourceSha ||
    deploymentContext?.composeProject !== "spx-staging" ||
    deploymentContext?.releaseRoot !== "/opt/spx-staging/release" ||
    deploymentContext?.releaseManifestSha256 !==
      createHash("sha256").update(releaseManifestBytes).digest("hex") ||
    !/^[0-9a-f]{64}$/.test(deploymentContext?.operatorBundleSha256 ?? "") ||
    deploymentContext.operatorBundleSha256 !== releaseManifest?.operatorBundleSha256
  ) {
    throw new Error("staging operator release/deployment context binding is invalid");
  }
  return { sourceSha, operatorBundleSha256: deploymentContext.operatorBundleSha256 };
}

async function assertRootOwnedNonSymlinkChain(path, finalKind) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const status = await lstat(current, { bigint: true });
    const final = index === segments.length - 1;
    if (
      status.isSymbolicLink() ||
      (final && finalKind === "file" ? !status.isFile() : !status.isDirectory()) ||
      (process.platform !== "win32" &&
        (Number(status.uid) !== 0 || (Number(status.mode & 0o777n) & 0o022) !== 0))
    ) {
      throw new Error("staging operator path chain is not root-owned immutable regular content");
    }
  }
}

export async function resolveVerifiedStagingOperatorRoot(installerPath) {
  const canonicalInstaller = await realpath(installerPath);
  const operatorRoot = dirname(dirname(canonicalInstaller)).replaceAll("\\", "/");
  if (!RELEASE_OPERATOR_PATTERN.test(operatorRoot)) {
    throw new Error("staging handler installer is outside a release-specific operator root");
  }
  await assertRootOwnedNonSymlinkChain(canonicalInstaller, "file");
  const releaseParent = dirname(operatorRoot);
  const releaseManifestPath = join(releaseParent, "release-manifest.json");
  const deploymentContextPath = join(releaseParent, "deployment-context.json");
  await Promise.all([
    assertRootOwnedNonSymlinkChain(releaseManifestPath, "file"),
    assertRootOwnedNonSymlinkChain(deploymentContextPath, "file"),
  ]);
  const [releaseManifestBytes, deploymentContextBytes] = await Promise.all([
    readFile(releaseManifestPath),
    readFile(deploymentContextPath),
  ]);
  let deploymentContext;
  try {
    deploymentContext = JSON.parse(deploymentContextBytes.toString("utf8"));
  } catch {
    throw new Error("staging deployment context is invalid");
  }
  validateStagingOperatorReleaseIdentity(operatorRoot, releaseManifestBytes, deploymentContext);
  return operatorRoot;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("staging handler installer accepts zero arguments");
  const operatorRoot = await resolveVerifiedStagingOperatorRoot(fileURLToPath(import.meta.url));
  const result = await installStagingActionHandlers({ sourceRoot: operatorRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stdout.write('{"ok":false,"code":"staging-handler-install-refused"}\n');
    process.exitCode = 1;
  });
}
