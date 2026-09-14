import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATOR_BUNDLE_STATIC_FILES,
  buildOperatorBundle,
  discoverOperatorBundleFiles,
  materializeOperatorBundle,
  verifyOperatorBundle,
  verifyOperatorBundleArchive,
} from "../scripts/build-operator-bundle.mjs";

const PHASE3_GATE4_BUNDLE_PATHS = Object.freeze([
  "deploy/staging-phase3-enabled.yml",
  "scripts/lib/phase3-staging-evidence.mjs",
  "scripts/phase3-rollout-evidence-produce.mjs",
  "scripts/staging-phase3-runtime-evidence.mjs",
]);

const actualRepositoryRoot = fileURLToPath(new URL("../", import.meta.url));
assert.doesNotThrow(
  () => discoverOperatorBundleFiles(actualRepositoryRoot),
  "the real repository must not contain unreviewed operational files",
);
for (const path of [
  "scripts/ci-deploy-worker.py", "scripts/ci-worker-readiness.mjs",
  "scripts/enable-both-teams.mjs", "scripts/inspect-auto-accept.mjs", "scripts/inspect-rules.mjs",
]) {
  assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes(path), false,
    `${path} must stay outside the A3 operator capability bundle`);
}

assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("src/services/release-manifest.ts"), true);
assert.equal(
  OPERATOR_BUNDLE_STATIC_FILES.includes("src/services/deployment-target-descriptor.ts"),
  true,
);
assert.equal(
  OPERATOR_BUNDLE_STATIC_FILES.includes("src/services/gate6-approval-runtime.mjs"),
  true,
);
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("deploy/runtime-isolation-policy.json"), true);
assert.equal(
  OPERATOR_BUNDLE_STATIC_FILES.includes("deploy/gate6-production-keyring.schema.json"),
  true,
);
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/container-inventory-check.mjs"), true);
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/container-isolation-probe.mjs"), true);
assert.equal(
  OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/internal-replay-grant-preflight.mjs"),
  true,
);
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/lib/file-backed-secret.mjs"), true);
for (const protectedBackupProducerPath of [
  ".github/workflows/production-backup-restore.yml",
  ".github/workflows/trusted-production-backup-restore.yml",
  "deploy/production-backup-context.schema.json",
  "deploy/production-backup-invariants.json",
  "deploy/production-backup-isolated-compose.yml",
  "scripts/lib/production-backup-live-adapter.mjs",
  "scripts/production-backup-restore-controller.mjs",
]) {
  assert.equal(
    OPERATOR_BUNDLE_STATIC_FILES.filter((path) => path === protectedBackupProducerPath).length,
    1,
    `${protectedBackupProducerPath} must be a single hashed operator-bundle entry`,
  );
}
for (const signedObserverContractPath of [
  ".github/workflows/deployment-target-descriptor-signer.yml",
  ".github/workflows/trusted-deploy.yml",
  "deploy/deployment-target-descriptor.schema.json",
  "deploy/systemd/spx-a3-capacity-guard.service",
  "deploy/systemd/spx-a3-capacity-watchdog.service",
  "scripts/deployment-target-descriptor.mjs",
  "scripts/lib/staging-production-observer-policy.mjs",
  "scripts/lib/staging-protected-capability-archive.mjs",
  "src/services/deployment-target-descriptor.ts",
]) {
  assert.equal(
    OPERATOR_BUNDLE_STATIC_FILES.filter((path) => path === signedObserverContractPath).length,
    1,
    `${signedObserverContractPath} must be a single hashed operator-bundle entry`,
  );
}
for (const protectedObserverLeaf of [
  "phase3-production-observer-policy.json",
  "phase3-production-observer-token",
  "principal-phase3-observer.password",
]) {
  assert.equal(
    OPERATOR_BUNDLE_STATIC_FILES.some((path) => path.endsWith(protectedObserverLeaf)),
    false,
    `${protectedObserverLeaf} is protected deployment material and must not be bundled`,
  );
}
for (const requiredTask3Path of [
  ".github/workflows/deploy.yml",
  ".github/workflows/production-project-identity.yml",
  ".github/workflows/release-artifact.yml",
  ".github/workflows/trusted-deploy.yml",
  ".github/workflows/trusted-production-project-identity.yml",
  ".github/workflows/trusted-release-artifact.yml",
  "deploy/systemd/spx-production-mutation-reconciler.service",
  "deploy/systemd/spx-protected-install-watchdog@.service",
  "scripts/lib/mysql-connection-config.mjs",
  "scripts/protected-install-evidence.mjs",
  "scripts/production-mutation-host-lock.mjs",
  "scripts/production-project-identity.mjs",
  "scripts/protected-install-watchdog.mjs",
]) {
  assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes(requiredTask3Path), true);
}
for (const acceptedEvidenceExporterPath of [
  ".github/workflows/gate6-accepted-evidence.yml",
  ".github/workflows/gate6-accepted-evidence-exporter.yml",
  "scripts/gate6-accepted-evidence-export.mjs",
  "scripts/lib/gate6-semantic-receipt.mjs",
]) {
  assert.equal(
    OPERATOR_BUNDLE_STATIC_FILES.filter((path) => path === acceptedEvidenceExporterPath).length,
    1,
    `${acceptedEvidenceExporterPath} must be a single hashed operator-bundle entry`,
  );
}
for (const finalVerifierPath of [
  ".github/workflows/gate6-final-verifier.yml",
  ".github/workflows/gate6-final-verifier-exporter.yml",
  "scripts/gate6-final-verifier-export.mjs",
]) {
  assert.equal(
    OPERATOR_BUNDLE_STATIC_FILES.filter((path) => path === finalVerifierPath).length,
    1,
    `${finalVerifierPath} must be a single hashed operator-bundle entry`,
  );
}
for (const protectedProducerContractPath of [
  "deploy/protected-evidence-producers.json",
  "scripts/lib/github-attestation-run.mjs",
  "scripts/lib/protected-evidence-producers.mjs",
]) {
  assert.equal(
    OPERATOR_BUNDLE_STATIC_FILES.filter((path) => path === protectedProducerContractPath).length,
    1,
    `${protectedProducerContractPath} must be a single hashed operator-bundle entry`,
  );
}
assert.equal(
  OPERATOR_BUNDLE_STATIC_FILES.includes("deploy/systemd/spx-protected-install-watchdog.service"),
  false,
);
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/lib/staging-action-plan.mjs"), true);
assert.equal(
  OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/lib/staging-operation-registry.mjs"),
  true,
);
for (const phase3RuntimePath of PHASE3_GATE4_BUNDLE_PATHS) {
  assert.equal(
    OPERATOR_BUNDLE_STATIC_FILES.filter((path) => path === phase3RuntimePath).length,
    1,
    `${phase3RuntimePath} must be included exactly once`,
  );
}
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/staging-rollout-controller.mjs"), true);
for (const protectedEvidencePath of [
  ".github/workflows/staging-protected-evidence.yml",
  ".github/workflows/trusted-staging-protected-evidence.yml",
  "scripts/staging-protected-evidence-export.mjs",
]) {
  assert.equal(
    OPERATOR_BUNDLE_STATIC_FILES.filter((path) => path === protectedEvidencePath).length,
    1,
    `${protectedEvidencePath} must be included exactly once`,
  );
}
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/dev-backend.mjs"), false);
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/e2e-runner.mjs"), false);
assert.equal(OPERATOR_BUNDLE_STATIC_FILES.includes("scripts/mcp-memory-launcher.mjs"), false);

const temp = mkdtempSync(join(tmpdir(), "spx-operator-bundle-"));
const root = join(temp, "repo");
const out = join(temp, "out");
mkdirSync(root, { recursive: true });
mkdirSync(out, { recursive: true });

function put(path: string, value: string): void {
  const full = join(root, ...path.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, value, "utf8");
}

for (const path of OPERATOR_BUNDLE_STATIC_FILES) {
  if (path === "migrations/released-checksums.json") continue;
  put(path, `fixture:${path}\n`);
}
const migrationBytes = "SELECT 1;\n";
const migrationSha256 = createHash("sha256").update(migrationBytes).digest("hex");
put("migrations/031_example.sql", migrationBytes);
put("migrations/released-checksums.json", JSON.stringify({ "031_example.sql": migrationSha256 }));
put("scripts/dev-backend.mjs", "excluded dev helper\n");
put("scripts/e2e-runner.mjs", "excluded e2e helper\n");
put("scripts/mcp-memory-launcher.mjs", "excluded memory helper\n");
put(".env", "DO_NOT_INCLUDE=1\n");
put("logs/runtime.log", "do not include\n");
put("memory/private.md", "do not include\n");
put("tests/fixtures/private-key.pem", "do not include\n");

try {
  const files = discoverOperatorBundleFiles(root);
  assert.equal(files.includes("scripts/service-fault-check.mjs"), true);
  assert.equal(files.includes(".github/workflows/deployment-target-descriptor-signer.yml"), true);
  assert.equal(files.includes(".env"), false);
  assert.equal(
    files.some(
      (path) => path.startsWith("tests/") || path.startsWith("logs/") || path.startsWith("memory/"),
    ),
    false,
  );

  put("src/services/operator-bundle-omitted.mjs", "export const omitted = true;\n");
  put("scripts/service-fault-check.mjs", 'import "../src/services/operator-bundle-omitted.mjs";\n');
  assert.throws(
    () => discoverOperatorBundleFiles(root),
    /local module dependency.*not in the reviewed allowlist/i,
  );
  rmSync(join(root, "src", "services", "operator-bundle-omitted.mjs"), { force: true });
  put("scripts/service-fault-check.mjs", "fixture:scripts/service-fault-check.mjs\n");

  put("src/services/phase3-producer-omitted.mjs", "export const omitted = true;\n");
  put(
    "scripts/phase3-rollout-evidence-produce.mjs",
    'import "../src/services/phase3-producer-omitted.mjs";\n',
  );
  assert.throws(
    () => discoverOperatorBundleFiles(root),
    /local module dependency.*not in the reviewed allowlist/i,
  );
  rmSync(join(root, "src", "services", "phase3-producer-omitted.mjs"), { force: true });
  put(
    "scripts/phase3-rollout-evidence-produce.mjs",
    "fixture:scripts/phase3-rollout-evidence-produce.mjs\n",
  );

  const first = buildOperatorBundle({
    root,
    archivePath: join(out, "first.tar"),
    indexPath: join(out, "first.index.json"),
  });
  const second = buildOperatorBundle({
    root,
    archivePath: join(out, "second.tar"),
    indexPath: join(out, "second.index.json"),
  });
  assert.equal(first.operatorBundleSha256, second.operatorBundleSha256);
  assert.deepEqual(readFileSync(join(out, "first.tar")), readFileSync(join(out, "second.tar")));
  assert.deepEqual(
    readFileSync(join(out, "first.index.json")),
    readFileSync(join(out, "second.index.json")),
  );
  const detachedIndex = JSON.parse(readFileSync(join(out, "first.index.json"), "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
  };
  for (const phase3RuntimePath of PHASE3_GATE4_BUNDLE_PATHS) {
    const entry = detachedIndex.files.find(({ path }) => path === phase3RuntimePath);
    assert.equal(
      entry?.sha256,
      createHash("sha256").update(`fixture:${phase3RuntimePath}\n`).digest("hex"),
    );
  }
  assert.equal(first.operatorBundleSha256.length, 64);
  for (const path of [
    "deploy/deployment-target-descriptor.schema.json",
    "scripts/deployment-target-descriptor.mjs",
    "scripts/lib/staging-production-observer-policy.mjs",
    "src/services/deployment-target-descriptor.ts",
  ]) {
    assert.match(
      first.index.files.find((entry: { path: string }) => entry.path === path)?.sha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
  }
  assert.equal(
    first.index.files.some(({ path }: { path: string }) =>
      /phase3-production-observer-(?:policy\.json|token)$|principal-phase3-observer\.password$/.test(
        path,
      ),
    ),
    false,
  );
  assert.deepEqual(
    first.index.files.map((entry: { path: string }) => entry.path),
    files,
  );
  assert.deepEqual(
    verifyOperatorBundle({
      root,
      archivePath: join(out, "first.tar"),
      indexPath: join(out, "first.index.json"),
    }),
    first,
  );
  assert.deepEqual(
    verifyOperatorBundleArchive({
      archivePath: join(out, "first.tar"),
      indexPath: join(out, "first.index.json"),
    }),
    first,
  );
  const materializedRoot = join(out, "materialized");
  assert.deepEqual(
    materializeOperatorBundle({
      archivePath: join(out, "first.tar"),
      indexPath: join(out, "first.index.json"),
      root: materializedRoot,
    }),
    first,
  );
  assert.equal(
    readFileSync(join(materializedRoot, "scripts", "service-fault-check.mjs"), "utf8"),
    "fixture:scripts/service-fault-check.mjs\n",
  );
  for (const phase3RuntimePath of PHASE3_GATE4_BUNDLE_PATHS) {
    assert.deepEqual(
      readFileSync(join(materializedRoot, ...phase3RuntimePath.split("/"))),
      readFileSync(join(root, ...phase3RuntimePath.split("/"))),
      `${phase3RuntimePath} materialized bytes must match its hashed archive entry`,
    );
  }
  assert.deepEqual(
    verifyOperatorBundle({
      root: materializedRoot,
      archivePath: join(out, "first.tar"),
      indexPath: join(out, "first.index.json"),
    }),
    first,
  );
  assert.throws(
    () =>
      materializeOperatorBundle({
        archivePath: join(out, "first.tar"),
        indexPath: join(out, "first.index.json"),
        root: materializedRoot,
      }),
    /fresh|exists/i,
  );
  const materializationParentLink = join(out, "materialization-parent-link");
  try {
    symlinkSync(out, materializationParentLink, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () =>
        materializeOperatorBundle({
          archivePath: join(out, "first.tar"),
          indexPath: join(out, "first.index.json"),
          root: join(materializationParentLink, "linked-root"),
        }),
      /non-symlink directory/,
    );
    rmSync(materializationParentLink, { force: true });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["EACCES", "EPERM"].includes(String(error.code))
    ) {
      throw error;
    }
  }

  const tamperedArchive = readFileSync(join(out, "first.tar"));
  tamperedArchive[tamperedArchive.length - 1] ^= 1;
  writeFileSync(join(out, "tampered.tar"), tamperedArchive);
  assert.throws(
    () =>
      verifyOperatorBundleArchive({
        archivePath: join(out, "tampered.tar"),
        indexPath: join(out, "first.index.json"),
      }),
    /archive|checksum|deterministic|tar/i,
  );

  const hardlinkArchive = Buffer.from(readFileSync(join(out, "first.tar")));
  hardlinkArchive[156] = "1".charCodeAt(0);
  hardlinkArchive.fill(0x20, 148, 156);
  const hardlinkHeaderChecksum = hardlinkArchive
    .subarray(0, 512)
    .reduce((sum, byte) => sum + byte, 0);
  hardlinkArchive.write(
    hardlinkHeaderChecksum.toString(8).padStart(6, "0") + "\0 ",
    148,
    8,
    "ascii",
  );
  writeFileSync(join(out, "hardlink.tar"), hardlinkArchive);
  assert.throws(
    () =>
      verifyOperatorBundleArchive({
        archivePath: join(out, "hardlink.tar"),
        indexPath: join(out, "first.index.json"),
      }),
    /non-regular/,
  );

  const tamperedIndex = JSON.parse(readFileSync(join(out, "first.index.json"), "utf8"));
  tamperedIndex.files[0].sha256 = "0".repeat(64);
  writeFileSync(join(out, "tampered.index.json"), JSON.stringify(tamperedIndex));
  assert.throws(
    () =>
      verifyOperatorBundleArchive({
        archivePath: join(out, "first.tar"),
        indexPath: join(out, "tampered.index.json"),
      }),
    /checksum|index/i,
  );

  const oversizedIndex = JSON.parse(readFileSync(join(out, "first.index.json"), "utf8"));
  oversizedIndex.files = Array.from({ length: 4097 }, () => oversizedIndex.files[0]);
  writeFileSync(join(out, "oversized.index.json"), JSON.stringify(oversizedIndex));
  assert.throws(
    () =>
      verifyOperatorBundleArchive({
        archivePath: join(out, "first.tar"),
        indexPath: join(out, "oversized.index.json"),
      }),
    /file-count limit/,
  );

  const oversizedEntryIndex = JSON.parse(readFileSync(join(out, "first.index.json"), "utf8"));
  oversizedEntryIndex.files[0].size = 64 * 1024 * 1024 + 1;
  writeFileSync(join(out, "oversized-entry.index.json"), JSON.stringify(oversizedEntryIndex));
  assert.throws(
    () =>
      verifyOperatorBundleArchive({
        archivePath: join(out, "first.tar"),
        indexPath: join(out, "oversized-entry.index.json"),
      }),
    /metadata|size limit/,
  );

  put("scripts/service-fault-check.mjs", "export const ok = false;\n");
  assert.throws(
    () =>
      verifyOperatorBundle({
        root,
        archivePath: join(out, "first.tar"),
        indexPath: join(out, "first.index.json"),
      }),
    /checksum|size/,
  );
  put("scripts/service-fault-check.mjs", "fixture:scripts/service-fault-check.mjs\n");
  put("scripts/service-fault-check.mjs", `export const token = "ghp_${"x".repeat(32)}";\n`);
  assert.throws(
    () =>
      buildOperatorBundle({
        root,
        archivePath: join(out, "secret.tar"),
        indexPath: join(out, "secret.index.json"),
      }),
    /secret material/,
  );
  put("scripts/service-fault-check.mjs", "fixture:scripts/service-fault-check.mjs\n");
  for (const requiredPath of PHASE3_GATE4_BUNDLE_PATHS) {
    rmSync(join(root, ...requiredPath.split("/")), { force: true });
    assert.throws(() => discoverOperatorBundleFiles(root), /unavailable|required/i);
    put(requiredPath, `fixture:${requiredPath}\n`);
  }
  for (const requiredPath of [
    ".github/workflows/production-project-identity.yml",
    ".github/workflows/release-artifact.yml",
    "deploy/systemd/spx-production-mutation-reconciler.service",
    "scripts/container-isolation-probe.mjs",
    "scripts/lib/file-backed-secret.mjs",
    "scripts/lib/mysql-connection-config.mjs",
    "scripts/production-mutation-host-lock.mjs",
    "scripts/production-project-identity.mjs",
    "scripts/staging-rollout-controller.mjs",
    "scripts/staging-rollout-approval-verify.mjs",
    ".github/workflows/staging-rollout-signer.yml",
    "scripts/lib/staging-action-plan.mjs",
    "src/services/release-manifest.ts",
    "docker-compose.yml",
  ]) {
    rmSync(join(root, ...requiredPath.split("/")), { force: true });
    assert.throws(() => discoverOperatorBundleFiles(root), /unavailable|required/i);
    put(requiredPath, `fixture:${requiredPath}\n`);
  }
  put("scripts/lib/unreviewed-secret.mjs", "export const value = true;\n");
  assert.throws(() => discoverOperatorBundleFiles(root), /forbidden|secret-shaped/);
  rmSync(join(root, "scripts", "lib", "unreviewed-secret.mjs"), { force: true });
  const operationalSymlink = join(root, "scripts", "linked-controller.mjs");
  try {
    symlinkSync(join(root, "scripts", "service-fault-check.mjs"), operationalSymlink, "file");
    assert.throws(() => discoverOperatorBundleFiles(root), /symlink/);
    rmSync(operationalSymlink, { force: true });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["EACCES", "EPERM"].includes(String(error.code))
    ) {
      throw error;
    }
  }
  put("scripts/new-live-controller.mjs", "export const added = true;\n");
  assert.throws(
    () =>
      verifyOperatorBundle({
        root,
        archivePath: join(out, "first.tar"),
        indexPath: join(out, "first.index.json"),
      }),
    /unreviewed operational file/,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
