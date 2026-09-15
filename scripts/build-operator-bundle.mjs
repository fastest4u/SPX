import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readStableRegularFile } from "./lib/safe-file.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^[\x20-\x7e]+$/;
const INDEX_ARCHIVE_PATH = "operator-bundle-index.json";
const MAX_OPERATOR_FILE_COUNT = 4096;
const MAX_OPERATOR_FILE_BYTES = 64 * 1024 * 1024;
const MAX_OPERATOR_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_OPERATOR_INDEX_BYTES = 8 * 1024 * 1024;
export const OPERATOR_BUNDLE_STATIC_FILES = Object.freeze([
  ".github/workflows/a3-deploy.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/deployment-target-descriptor-signer.yml",
  ".github/workflows/deployment-target-descriptor.yml",
  ".github/workflows/gate6-accepted-evidence-exporter.yml",
  ".github/workflows/gate6-accepted-evidence.yml",
  ".github/workflows/gate6-approval.yml",
  ".github/workflows/gate6-envelope-signer.yml",
  ".github/workflows/gate6-final-verifier-exporter.yml",
  ".github/workflows/gate6-final-verifier.yml",
  ".github/workflows/gate6-line-permit-signer.yml",
  ".github/workflows/gate6-line-permit.yml",
  ".github/workflows/gate6-ocr-permit-signer.yml",
  ".github/workflows/gate6-ocr-permit.yml",
  ".github/workflows/gate6-postproof-principal-signer.yml",
  ".github/workflows/gate6-postproof-principal.yml",
  ".github/workflows/gate6-runtime-executor.yml",
  ".github/workflows/gate6-runtime.yml",
  ".github/workflows/production-backup-restore.yml",
  ".github/workflows/production-project-identity.yml",
  ".github/workflows/release-artifact.yml",
  ".github/workflows/staging-rollout-approval.yml",
  ".github/workflows/staging-rollout-signer.yml",
  ".github/workflows/staging-protected-evidence.yml",
  ".github/workflows/trusted-deploy.yml",
  ".github/workflows/trusted-production-backup-restore.yml",
  ".github/workflows/trusted-production-project-identity.yml",
  ".github/workflows/trusted-release-artifact.yml",
  ".github/workflows/trusted-staging-protected-evidence.yml",
  ".github/workflows/trusted-team2-deploy.yml",
  "Dockerfile",
  "Dockerfile.a3",
  "deploy/db-grants.json",
  "deploy/deployment-target-descriptor.schema.json",
  "deploy/gate6-envelope.schema.json",
  "deploy/gate6-production-keyring.schema.json",
  "deploy/migration-classification.json",
  "deploy/n-minus-one-role-contracts.json",
  "deploy/production-backup-context.schema.json",
  "deploy/production-backup-invariants.json",
  "deploy/production-backup-isolated-compose.yml",
  "deploy/production-backup-restore-evidence.schema.json",
  "deploy/production-primary.yml",
  "deploy/production-team2.yml",
  "deploy/production-topology.json",
  "deploy/protected-install-evidence.schema.json",
  "deploy/protected-evidence-producers.json",
  "deploy/runtime-isolation-policy.json",
  "deploy/runtime-deployment-contract.json",
  "deploy/staging-rollout-envelope.schema.json",
  "deploy/staging-phase3-disabled.yml",
  "deploy/staging-phase3-enabled.yml",
  "deploy/systemd/spx-a3-capacity-guard.service",
  "deploy/systemd/spx-a3-capacity-watchdog.service",
  "deploy/systemd/spx-gate6-watchdog.service",
  "deploy/systemd/spx-production-mutation-reconciler.service",
  "deploy/systemd/spx-protected-install-watchdog@.service",
  "docker-compose.yml",
  "docker-compose.a3.yml",
  "docker-compose.staging.yml",
  "migrations/released-checksums.json",
  "package-lock.json",
  "package.json",
  "scripts/a3-capacity-check.mjs",
  "scripts/a3-team2-deploy.py",
  "scripts/a3-team2-readiness.mjs",
  "scripts/deployment-compatibility.mjs",
  "scripts/a3-capacity-guard.mjs",
  "scripts/a3-capacity-watchdog.mjs",
  "scripts/a3-staging-db-fault.mjs",
  "scripts/a3-staging-db-provision.mjs",
  "scripts/a3-staging-preflight.mjs",
  "scripts/a3-staging-rollout-controller.mjs",
  "scripts/a3-staging-service-fault.mjs",
  "scripts/build-operator-bundle.mjs",
  "scripts/container-inventory-check.mjs",
  "scripts/container-isolation-probe.mjs",
  "scripts/create-release-manifest.mjs",
  "scripts/db-grants-check.mjs",
  "scripts/db-principal-rollout.mjs",
  "scripts/deployment-target-descriptor.mjs",
  "scripts/gate6-approval-verify.mjs",
  "scripts/gate6-accepted-evidence-export.mjs",
  "scripts/gate6-final-verifier-export.mjs",
  "scripts/gate6-fault-permit-reconciler.mjs",
  "scripts/gate6-host-watchdog.mjs",
  "scripts/gate6-legacy-grant-executor.mjs",
  "scripts/gate6-production-monitor-probe.mjs",
  "scripts/gate6-rollback-coordinator.mjs",
  "scripts/gate6-runtime-control.mjs",
  "scripts/gate6-runtime-state-probe.mjs",
  "scripts/install-staging-action-handlers.mjs",
  "scripts/internal-replay-grant-preflight.mjs",
  "scripts/lib/a3-staging-approved-context.mjs",
  "scripts/lib/a3-staging-leases.mjs",
  "scripts/lib/evidence-artifact.mjs",
  "scripts/lib/file-backed-secret.mjs",
  "scripts/lib/gate6-cli-runtime.mjs",
  "scripts/lib/gate6-controller.mjs",
  "scripts/lib/gate6-immutable-runtime.mjs",
  "scripts/lib/gate6-mysql-ledger.mjs",
  "scripts/lib/gate6-postproof-actions.mjs",
  "scripts/lib/gate6-runtime-context.mjs",
  "scripts/lib/gate6-semantic-receipt.mjs",
  "scripts/lib/github-attestation-run.mjs",
  "scripts/lib/mysql-connection-config.mjs",
  "scripts/lib/phase3-staging-evidence.mjs",
  "scripts/lib/production-backup-live-adapter.mjs",
  "scripts/lib/production-db-principal-files.mjs",
  "scripts/lib/production-legacy-grants.mjs",
  "scripts/lib/protected-evidence-producers.mjs",
  "scripts/lib/safe-file.mjs",
  "scripts/lib/staging-action-handler-manifest.mjs",
  "scripts/lib/staging-action-capability.mjs",
  "scripts/lib/staging-action-ledger.mjs",
  "scripts/lib/staging-action-plan.mjs",
  "scripts/lib/staging-installed-context.mjs",
  "scripts/lib/staging-gate-evidence.mjs",
  "scripts/lib/staging-operation-registry.mjs",
  "scripts/lib/staging-protected-capability-archive.mjs",
  "scripts/lib/staging-production-observer-policy.mjs",
  "scripts/lib/task9-worker-evaluators.mjs",
  "scripts/phase3-publication-control.mjs",
  "scripts/phase3-rollback-guard.mjs",
  "scripts/phase3-rollout-evidence-produce.mjs",
  "scripts/phase3-rollout-evidence-check.mjs",
  "scripts/phase3-runtime-confidence-check.mjs",
  "scripts/phase4-n-minus-one-evidence-check.mjs",
  "scripts/phase4-n-minus-one-rehearsal.mjs",
  "scripts/phase4-rollout-evidence-check.mjs",
  "scripts/phase4-routing-guard.mjs",
  "scripts/phase4-runtime-probe.mjs",
  "scripts/phase4-staging-action-handler.mjs",
  "scripts/production-backup-restore-evidence.mjs",
  "scripts/production-backup-restore-controller.mjs",
  "scripts/production-canary-evidence-check.mjs",
  "scripts/production-canary-monitor.mjs",
  "scripts/production-db-principal-controller.mjs",
  "scripts/production-db-transition-evidence-check.mjs",
  "scripts/production-mutation-host-lock.mjs",
  "scripts/production-phase3-controller.mjs",
  "scripts/production-phase4-controller.mjs",
  "scripts/production-project-identity.mjs",
  "scripts/production-task9-controller.mjs",
  "scripts/production-topology.mjs",
  "scripts/production-worker-canary-control.mjs",
  "scripts/protected-install-evidence.mjs",
  "scripts/protected-install-watchdog.mjs",
  "scripts/release-install-migration-check.mjs",
  "scripts/schema-verify.mjs",
  "scripts/service-fault-check.mjs",
  "scripts/service-fault-evidence-check.mjs",
  "scripts/service-fault-ocr-boundary-probe.mjs",
  "scripts/service-fault-outbox-check.mjs",
  "scripts/service-fault-publish-notification.mjs",
  "scripts/service-worker-evidence-check.mjs",
  "scripts/service-worker-operation-watermark-check.mjs",
  "scripts/service-worker-runtime-status-check.mjs",
  "scripts/staging-core-action-handler.mjs",
  "scripts/staging-db-sql-executor.mjs",
  "scripts/staging-db-proxy.mjs",
  "scripts/staging-gate-evidence-check.mjs",
  "scripts/staging-isolation-check.mjs",
  "scripts/staging-phase3-action-handler.mjs",
  "scripts/staging-phase3-db-controller.mjs",
  "scripts/staging-phase3-runtime-evidence.mjs",
  "scripts/staging-protected-evidence-export.mjs",
  "scripts/staging-rollout-controller.mjs",
  "scripts/staging-rollout-approval-verify.mjs",
  "scripts/task9-ocr-fixture.png",
  "scripts/worker-healthcheck.mjs",
  "src/services/deployment-target-descriptor.ts",
  "src/services/gate6-approval-runtime.mjs",
  "src/services/production-topology.ts",
  "src/services/release-manifest.ts",
]);
const EXPLICITLY_EXCLUDED_OPERATIONAL_FILES = new Set([
  // Owner-managed trust roots are installed and pinned outside the release bundle.
  "deploy/nginx/spx-descriptor-signer.location.conf",
  "deploy/systemd/spx-descriptor-signer.service",
  "scripts/build-descriptor-signer.mjs",
  "scripts/spx-descriptor-signer.mjs",
  "scripts/spx-kms-envelope.mjs",
  "deploy/tmpfiles/spx-owner-capabilities.conf",
  // Released host deployment helpers belong to its existing CI path.
  "scripts/ci-deploy-worker.py",
  "scripts/ci-worker-readiness.mjs",
  "scripts/copy-public.mjs",
  "scripts/dev-backend.mjs",
  "scripts/dev-frontend.mjs",
  "scripts/dev-linejs.ps1",
  "scripts/e2e-runner.mjs",
  // Ad hoc operator inspection/activation scripts are not A3 capabilities.
  "scripts/enable-both-teams.mjs",
  "scripts/inspect-auto-accept.mjs",
  "scripts/inspect-rules.mjs",
  "scripts/mcp-memory-launcher.mjs",
  "scripts/run-e2e.mjs",
  "scripts/run-tests.mjs",
  "scripts/sweep-semantic-colors.mjs",
]);
const FORBIDDEN_SEGMENT =
  /^(?:\.env(?:\..*)?|\.git|\.superpowers|\.worktrees|data|dist|docs|logs?|memory|node_modules|tests)$/i;
const SECRET_PATH =
  /(?:^|\/)(?:[^/]*(?:private[-_.]?key|credential|secret|passwd|password|access[-_.]?token)[^/]*)$/i;
const REVIEWED_SECRET_HANDLER_PATHS = new Set(["scripts/lib/file-backed-secret.mjs"]);

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new Error("operator bundle index contains a non-canonical number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  throw new Error("operator bundle index is not canonical JSON");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error("operator bundle path must be a non-empty relative POSIX path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`operator bundle path escapes its root: ${path}`);
  }
  if (!SAFE_PATH.test(path)) throw new Error(`operator bundle path must be ASCII: ${path}`);
  return path;
}

function assertAllowedPath(path) {
  const normalized = normalizeRelativePath(path);
  if (
    normalized === INDEX_ARCHIVE_PATH ||
    normalized.split("/").some((segment) => FORBIDDEN_SEGMENT.test(segment)) ||
    (SECRET_PATH.test(normalized) && !REVIEWED_SECRET_HANDLER_PATHS.has(normalized))
  ) {
    throw new Error(`operator bundle path is forbidden or secret-shaped: ${normalized}`);
  }
  return normalized;
}

function absoluteWithinRoot(root, path) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...path.split("/"));
  const rel = relative(absoluteRoot, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`operator bundle path escapes root: ${path}`);
  }
  return absolute;
}

function walkOperationalFiles(directory, root, results) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      throw new Error(`operator bundle refuses operational symlink: ${path}`);
    }
    if (entry.isDirectory()) {
      walkOperationalFiles(absolute, root, results);
      continue;
    }
    if (entry.isFile()) results.push(assertAllowedPath(path));
  }
}

function auditOperationalClosure(root, required) {
  const candidates = [];
  for (const directory of [".github/workflows", "deploy", "scripts"]) {
    const absolute = resolve(root, ...directory.split("/"));
    if (existsSync(absolute)) walkOperationalFiles(absolute, root, candidates);
  }
  for (const name of readdirSync(root)) {
    if (/^docker-compose(?:\.[a-z0-9._-]+)?\.ya?ml$/.test(name)) candidates.push(name);
  }
  const reviewed = new Set(required);
  const unreviewed = [...new Set(candidates)]
    .filter((path) => !reviewed.has(path) && !EXPLICITLY_EXCLUDED_OPERATIONAL_FILES.has(path))
    .sort();
  if (unreviewed.length > 0) {
    throw new Error(`operator bundle has unreviewed operational file(s): ${unreviewed.join(", ")}`);
  }
}

function resolveLocalModulePath(root, importerPath, specifier) {
  const importer = absoluteWithinRoot(root, importerPath);
  const requested = resolve(dirname(importer), specifier);
  const relativePath = relative(resolve(root), requested);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`operator bundle local module dependency escapes root: ${importerPath}`);
  }
  const normalized = relativePath.split(sep).join("/");
  const candidates = [normalized];
  if (normalized.endsWith(".js")) candidates.push(`${normalized.slice(0, -3)}.ts`);
  if (normalized.endsWith(".mjs")) candidates.push(`${normalized.slice(0, -4)}.mts`);
  const selected = candidates.find((path) => existsSync(absoluteWithinRoot(root, path)));
  if (!selected) {
    throw new Error(
      `operator bundle local module dependency is unavailable: ${importerPath} -> ${specifier}`,
    );
  }
  return normalizeRelativePath(selected);
}

function auditLocalModuleClosure(root, required) {
  const reviewed = new Set(required);
  const localImport =
    /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s*)?|\bimport\s*\()\s*["'](\.{1,2}\/[^"'?#]+)["']/g;
  for (const importerPath of required) {
    if (!/\.(?:[cm]?[jt]s)$/.test(importerPath)) continue;
    const source = readStableRegularFile(
      absoluteWithinRoot(root, importerPath),
      "operator bundle module source",
    ).toString("utf8");
    for (const match of source.matchAll(localImport)) {
      const dependencyPath = resolveLocalModulePath(root, importerPath, match[1]);
      if (!reviewed.has(dependencyPath)) {
        throw new Error(
          `operator bundle local module dependency is not in the reviewed allowlist: ${importerPath} -> ${dependencyPath}`,
        );
      }
    }
  }
}

function releasedMigrationFiles(root) {
  const manifestPath = resolve(root, "migrations", "released-checksums.json");
  let manifest;
  try {
    manifest = JSON.parse(
      readStableRegularFile(manifestPath, "released migration checksum manifest").toString("utf8"),
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("released migration checksum manifest is invalid");
    throw error;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("released migration checksum manifest must be an object");
  }
  const files = Object.keys(manifest).sort();
  if (files.length === 0 || files.some((name) => !/^\d{3}_[A-Za-z0-9_-]+\.sql$/.test(name))) {
    throw new Error("released migration checksum manifest has an invalid file allowlist");
  }
  const diskFiles = readdirSync(resolve(root, "migrations"))
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();
  if (canonicalJson(files) !== canonicalJson(diskFiles)) {
    throw new Error("released migration file set does not match its reviewed allowlist");
  }
  return files.map((name) => `migrations/${name}`);
}

export function discoverOperatorBundleFiles(rootInput) {
  const root = resolve(rootInput);
  const required = [...OPERATOR_BUNDLE_STATIC_FILES, ...releasedMigrationFiles(root)].sort();
  if (new Set(required).size !== required.length)
    throw new Error("operator bundle allowlist has duplicates");
  auditOperationalClosure(root, required);
  for (const path of required) sourceEntry(root, path);
  auditLocalModuleClosure(root, required);
  return required;
}

function sourceEntry(root, path) {
  const allowedPath = assertAllowedPath(path);
  if (
    !OPERATOR_BUNDLE_STATIC_FILES.includes(allowedPath) &&
    !/^migrations\/\d{3}_[A-Za-z0-9_-]+\.sql$/.test(allowedPath)
  )
    throw new Error(`operator bundle path is not in the reviewed allowlist: ${allowedPath}`);
  const absolute = absoluteWithinRoot(root, allowedPath);
  const content = readStableRegularFile(absolute, "operator bundle source");
  const text = content.toString("utf8");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(text) ||
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text) ||
    /\bsk-[A-Za-z0-9_-]{20,}\b/.test(text)
  ) {
    throw new Error(`operator bundle source contains secret material: ${allowedPath}`);
  }
  return {
    path: allowedPath,
    content,
    metadata: { path: allowedPath, sha256: sha256(content), size: content.length, mode: "0644" },
  };
}

function writeOctal(header, offset, length, value) {
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error("operator bundle tar field overflow");
  header.write(octal.padStart(length - 1, "0") + "\0", offset, length, "ascii");
}

function splitTarPath(path) {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  throw new Error(`operator bundle path is too long for ustar: ${path}`);
}

function tarHeader(path, size) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(path);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function buildTar(entries) {
  const chunks = [];
  for (const entry of [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    chunks.push(tarHeader(entry.path, entry.content.length), entry.content);
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function writeNewFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error(`operator bundle output already exists: ${path}`);
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  try {
    chmodSync(path, 0o444);
  } catch {
    /* Windows may not apply POSIX modes. */
  }
}

function validateFileList(files) {
  if (!Array.isArray(files) || files.length === 0)
    throw new Error("operator bundle file list must be non-empty");
  const normalized = files.map(assertAllowedPath);
  if (new Set(normalized).size !== normalized.length)
    throw new Error("operator bundle file list contains duplicates");
  const sorted = [...normalized].sort();
  if (normalized.some((path, index) => path !== sorted[index]))
    throw new Error("operator bundle file list must be sorted");
  return normalized;
}

function validateIndex(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("operator bundle index must be an object");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "files,format,schemaVersion")
    throw new Error("operator bundle index has missing or unknown fields");
  if (value.schemaVersion !== 1 || value.format !== "ustar")
    throw new Error("operator bundle index version/format is unsupported");
  if (!Array.isArray(value.files) || value.files.length === 0)
    throw new Error("operator bundle index files must be non-empty");
  if (value.files.length > MAX_OPERATOR_FILE_COUNT)
    throw new Error("operator bundle index exceeds the file-count limit");
  const paths = [];
  let totalSize = 0;
  for (const [index, entry] of value.files.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`operator bundle index file ${index} is invalid`);
    if (Object.keys(entry).sort().join(",") !== "mode,path,sha256,size")
      throw new Error(`operator bundle index file ${index} has unknown fields`);
    const path = assertAllowedPath(entry.path);
    if (
      !OPERATOR_BUNDLE_STATIC_FILES.includes(path) &&
      !/^migrations\/\d{3}_[A-Za-z0-9_-]+\.sql$/.test(path)
    )
      throw new Error(`operator bundle index path is not reviewed: ${path}`);
    if (
      !SHA256.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_OPERATOR_FILE_BYTES ||
      entry.mode !== "0644"
    ) {
      throw new Error(`operator bundle index metadata is invalid for ${path}`);
    }
    totalSize += entry.size;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_OPERATOR_TOTAL_BYTES)
      throw new Error("operator bundle index exceeds the total-size limit");
    paths.push(path);
  }
  validateFileList(paths);
  return value;
}

function parseOctal(buffer, offset, length) {
  const raw = buffer
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!/^[0-7]+$/.test(raw))
    throw new Error("operator bundle tar contains an invalid numeric field");
  return Number.parseInt(raw, 8);
}

function parseTar(buffer) {
  const entries = new Map();
  let offset = 0;
  let totalSize = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const storedChecksum = parseOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum)
      throw new Error("operator bundle tar header checksum mismatch");
    if (
      header[156] !== 0x30 ||
      !header.subarray(157, 257).every((byte) => byte === 0) ||
      !header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii")) ||
      !header.subarray(263, 265).equals(Buffer.from("00", "ascii")) ||
      !header.subarray(329, 345).every((byte) => byte === 0)
    ) {
      throw new Error("operator bundle tar contains a non-regular entry");
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const path = rawPath === INDEX_ARCHIVE_PATH ? rawPath : assertAllowedPath(rawPath);
    if (entries.has(path)) throw new Error(`operator bundle tar contains duplicate path: ${path}`);
    const size = parseOctal(header, 124, 12);
    if (size > MAX_OPERATOR_FILE_BYTES)
      throw new Error("operator bundle tar entry exceeds the size limit");
    totalSize += size;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_OPERATOR_TOTAL_BYTES)
      throw new Error("operator bundle tar exceeds the total-size limit");
    if (entries.size >= MAX_OPERATOR_FILE_COUNT + 1)
      throw new Error("operator bundle tar exceeds the file-count limit");
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) throw new Error("operator bundle tar is truncated");
    entries.set(path, Buffer.from(buffer.subarray(contentStart, contentEnd)));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (offset + 1024 > buffer.length || !buffer.subarray(offset).every((byte) => byte === 0))
    throw new Error("operator bundle tar has an invalid trailer");
  return entries;
}

export function buildOperatorBundle({
  root: rootInput,
  archivePath: archiveInput,
  indexPath: indexInput,
  topology = "released",
}) {
  if (topology !== "released" && topology !== "a3")
    throw new Error("operator bundle topology must be released or a3");
  const root = resolve(rootInput);
  const files = validateFileList(discoverOperatorBundleFiles(root));
  // Project only while building. Verification always reads the canonical
  // installed paths, so a sibling candidate file cannot mask tampering.
  const candidateSources = { "Dockerfile": "Dockerfile.a3", "docker-compose.yml": "docker-compose.a3.yml" };
  const sources = files.map((path) => {
    const sourcePath = topology === "a3" ? candidateSources[path] ?? path : path;
    const entry = sourceEntry(root, sourcePath);
    return { ...entry, path, metadata: { ...entry.metadata, path } };
  });
  const index = validateIndex({
    schemaVersion: 1,
    format: "ustar",
    files: sources.map((entry) => entry.metadata),
  });
  const indexBytes = Buffer.from(canonicalJson(index), "utf8");
  if (indexBytes.length > MAX_OPERATOR_INDEX_BYTES)
    throw new Error("operator bundle index exceeds the byte limit");
  const archive = buildTar([...sources, { path: INDEX_ARCHIVE_PATH, content: indexBytes }]);
  if (archive.length > MAX_OPERATOR_TOTAL_BYTES)
    throw new Error("operator bundle archive exceeds the byte limit");
  const archivePath = resolve(archiveInput);
  const indexPath = resolve(indexInput);
  if (archivePath === indexPath)
    throw new Error("operator bundle archive and index paths must differ");
  writeNewFile(indexPath, indexBytes);
  try {
    writeNewFile(archivePath, archive);
  } catch (error) {
    rmSync(indexPath, { force: true });
    throw error;
  }
  return { operatorBundleSha256: sha256(archive), indexSha256: sha256(indexBytes), index };
}

export function verifyOperatorBundle({
  root: rootInput,
  archivePath: archiveInput,
  indexPath: indexInput,
}) {
  const root = resolve(rootInput);
  const verifiedArchive = verifyOperatorBundleArchive({
    archivePath: archiveInput,
    indexPath: indexInput,
  });
  const { index } = verifiedArchive;
  const discovered = discoverOperatorBundleFiles(root);
  const indexed = index.files.map((entry) => entry.path);
  if (canonicalJson(discovered) !== canonicalJson(indexed))
    throw new Error("operator bundle file set has drifted");
  for (const entry of index.files) {
    const source = sourceEntry(root, entry.path);
    if (source.metadata.size !== entry.size)
      throw new Error(`operator bundle size mismatch: ${entry.path}`);
    if (source.metadata.sha256 !== entry.sha256)
      throw new Error(`operator bundle checksum mismatch: ${entry.path}`);
  }
  return verifiedArchive;
}

function reviewedArchivePaths(tarEntries) {
  for (const path of OPERATOR_BUNDLE_STATIC_FILES) {
    if (!tarEntries.has(path)) throw new Error(`operator bundle is missing required file: ${path}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(tarEntries.get("migrations/released-checksums.json").toString("utf8"));
  } catch {
    throw new Error("operator bundle released migration manifest is invalid");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("operator bundle released migration manifest must be an object");
  const migrationNames = Object.keys(manifest).sort();
  if (migrationNames.length === 0)
    throw new Error("operator bundle released migration allowlist must be non-empty");
  for (const name of migrationNames) {
    if (!/^\d{3}_[A-Za-z0-9_-]+\.sql$/.test(name) || !SHA256.test(manifest[name]))
      throw new Error("operator bundle released migration allowlist is invalid");
    const path = `migrations/${name}`;
    const content = tarEntries.get(path);
    if (!content || sha256(content) !== manifest[name])
      throw new Error(`operator bundle released migration checksum mismatch: ${name}`);
  }
  return [
    ...OPERATOR_BUNDLE_STATIC_FILES,
    ...migrationNames.map((name) => `migrations/${name}`),
  ].sort();
}

export function verifyOperatorBundleArchive({ archivePath: archiveInput, indexPath: indexInput }) {
  const indexBytes = readStableRegularFile(resolve(indexInput), "operator bundle index", {
    maximumBytes: MAX_OPERATOR_INDEX_BYTES,
  });
  let index;
  try {
    index = validateIndex(JSON.parse(indexBytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("operator bundle index is invalid JSON");
    throw error;
  }
  if (!indexBytes.equals(Buffer.from(canonicalJson(index), "utf8")))
    throw new Error("operator bundle index bytes are not canonical JSON");
  const indexed = index.files.map((entry) => entry.path);
  const archive = readStableRegularFile(resolve(archiveInput), "operator bundle archive", {
    maximumBytes: MAX_OPERATOR_TOTAL_BYTES,
  });
  const tarEntries = parseTar(archive);
  const reviewedPaths = reviewedArchivePaths(tarEntries);
  if (canonicalJson(reviewedPaths) !== canonicalJson(indexed))
    throw new Error("operator bundle archive does not match the reviewed file closure");
  const expectedPaths = [...indexed, INDEX_ARCHIVE_PATH].sort();
  if (canonicalJson([...tarEntries.keys()].sort()) !== canonicalJson(expectedPaths))
    throw new Error("operator bundle archive file set does not match its index");
  const archiveEntries = [];
  for (const entry of index.files) {
    const content = tarEntries.get(entry.path);
    if (!content || content.length !== entry.size || sha256(content) !== entry.sha256)
      throw new Error(`operator bundle archive checksum mismatch: ${entry.path}`);
    archiveEntries.push({ path: entry.path, content });
  }
  if (!tarEntries.get(INDEX_ARCHIVE_PATH)?.equals(indexBytes))
    throw new Error("operator bundle archive index does not match the detached index");
  const expectedArchive = buildTar([
    ...archiveEntries,
    { path: INDEX_ARCHIVE_PATH, content: indexBytes },
  ]);
  if (!archive.equals(expectedArchive))
    throw new Error("operator bundle archive is not deterministic");
  return { operatorBundleSha256: sha256(archive), indexSha256: sha256(indexBytes), index };
}

function requireSafeMaterializationParent(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch {
      throw new Error("operator bundle materialization parent is unavailable");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("operator bundle materialization parent must be a non-symlink directory");
  }
  return absolute;
}

function materializedFilePath(root, path) {
  const segments = path.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
    }
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("operator bundle materialization encountered an unsafe directory");
  }
  return join(current, segments.at(-1));
}

function writeMaterializedFile(path, content) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o400,
  );
  try {
    writeFileSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export function materializeOperatorBundle({
  archivePath: archiveInput,
  indexPath: indexInput,
  root: rootInput,
}) {
  const root = resolve(rootInput);
  if (existsSync(root)) throw new Error("operator bundle materialization root must be fresh");
  requireSafeMaterializationParent(dirname(root));
  const verifiedArchive = verifyOperatorBundleArchive({
    archivePath: archiveInput,
    indexPath: indexInput,
  });
  const archive = readStableRegularFile(resolve(archiveInput), "operator bundle archive", {
    maximumBytes: MAX_OPERATOR_TOTAL_BYTES,
  });
  if (sha256(archive) !== verifiedArchive.operatorBundleSha256)
    throw new Error("operator bundle archive changed before materialization");
  const entries = parseTar(archive);
  let createdRoot = false;
  try {
    mkdirSync(root, { mode: 0o700 });
    createdRoot = true;
    for (const entry of verifiedArchive.index.files) {
      const content = entries.get(entry.path);
      if (!content || content.length !== entry.size || sha256(content) !== entry.sha256)
        throw new Error("operator bundle entry changed before materialization");
      const output = materializedFilePath(root, entry.path);
      writeMaterializedFile(output, content);
      try {
        chmodSync(output, 0o444);
      } catch {
        /* Windows may not apply POSIX modes. */
      }
    }
    const verified = verifyOperatorBundle({
      root,
      archivePath: archiveInput,
      indexPath: indexInput,
    });
    return verified;
  } catch (error) {
    if (createdRoot) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (
    command !== "build" &&
    command !== "verify" &&
    command !== "verify-archive" &&
    command !== "materialize"
  )
    throw new Error(
      "usage: build-operator-bundle.mjs <build|verify|verify-archive|materialize> --archive=<path> --index=<path> [--root=<path>] [build only: --topology=released|a3]",
    );
  const values = {};
  for (const token of tokens) {
    const match = /^--(root|archive|index|topology)=(.+)$/.exec(token);
    if (!match || match[1] in values) throw new Error(`unknown or duplicate argument: ${token}`);
    values[match[1]] = match[2];
  }
  if (!values.archive || !values.index || (command !== "verify-archive" && !values.root))
    throw new Error(
      "--archive and --index are required; --root is required except for verify-archive",
    );
  if (values.topology && command !== "build")
    throw new Error("--topology is only supported when building a bundle");
  return { command, ...values };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result =
    args.command === "build"
      ? buildOperatorBundle({ root: args.root, archivePath: args.archive, indexPath: args.index, topology: args.topology })
      : args.command === "verify"
        ? verifyOperatorBundle({
            root: args.root,
            archivePath: args.archive,
            indexPath: args.index,
          })
        : args.command === "materialize"
          ? materializeOperatorBundle({
              root: args.root,
              archivePath: args.archive,
              indexPath: args.index,
            })
          : verifyOperatorBundleArchive({ archivePath: args.archive, indexPath: args.index });
  process.stdout.write(
    `${canonicalJson({ ok: true, files: result.index.files.length, operatorBundleSha256: result.operatorBundleSha256, indexSha256: result.indexSha256 })}\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
