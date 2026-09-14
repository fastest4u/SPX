import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStableRegularFile } from "../scripts/lib/safe-file.mjs";
import {
  buildBuildManifest,
  canonicalJson,
  finalizeReleaseManifest,
  sha256Hex,
} from "../src/services/release-manifest.js";

const migrations = [
  { name: "033_create_internal_request_replays.sql", sha256: "d".repeat(64) },
  { name: "034_complete_fresh_baseline.sql", sha256: "e".repeat(64) },
  { name: "035_create_auto_accept_publication_controls.sql", sha256: "f".repeat(64) },
  { name: "036_create_gate6_control_plane.sql", sha256: "2".repeat(64) },
];

const build = buildBuildManifest({
  version: "1.0.0",
  sourceSha: "a".repeat(40),
  buildId: "run-123.1",
  artifactSha256: "c".repeat(64),
  operatorBundleSha256: "1".repeat(64),
  schema: { min: 33, max: 36 },
  migrations,
});

assert.deepEqual(
  build.migrations.map((item) => item.name),
  [...migrations].map((item) => item.name).sort(),
);
assert.equal(build.migrationSetSha256.length, 64);
assert.equal(Object.isFrozen(build), true);

const reordered = buildBuildManifest({
  version: "1.0.0",
  sourceSha: "a".repeat(40),
  buildId: "run-123.1",
  artifactSha256: "c".repeat(64),
  operatorBundleSha256: "1".repeat(64),
  schema: { max: 36, min: 33 },
  migrations: [...migrations].reverse(),
});
assert.equal(canonicalJson(build), canonicalJson(reordered));

const manifest = finalizeReleaseManifest({
  build,
  imageId: "sha256:" + "b".repeat(64),
  imageTag: "spx-app:" + "a".repeat(40),
});
assert.equal(manifest.version, "1.0.0");
assert.equal("environment" in manifest, false);
assert.equal("topology" in manifest, false);
assert.equal(manifest.buildManifestSha256, sha256Hex(canonicalJson(build)));
assert.equal(Object.isFrozen(manifest), true);
const stableReadTemp = mkdtempSync(join(tmpdir(), "spx-stable-read-"));
try {
  const stablePath = join(stableReadTemp, "manifest.json");
  writeFileSync(stablePath, "stable");
  assert.equal(readStableRegularFile(stablePath, "stable fixture").toString("utf8"), "stable");
  const directoryPath = join(stableReadTemp, "not-a-file");
  mkdirSync(directoryPath);
  assert.throws(
    () => readStableRegularFile(directoryPath, "directory fixture"),
    /regular non-symlink file/,
  );
  const symlinkPath = join(stableReadTemp, "manifest-link.json");
  try {
    symlinkSync(stablePath, symlinkPath, "file");
    assert.throws(() => readStableRegularFile(symlinkPath, "symlink fixture"), /symlink/);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["EACCES", "EPERM"].includes(String(error.code))
    ) {
      throw error;
    }
  }
  assert.throws(
    () =>
      readStableRegularFile(stablePath, "replaced fixture", {
        onOpened() {
          const replacement = join(stableReadTemp, "replacement.json");
          writeFileSync(replacement, "replacement");
          rmSync(stablePath, { force: true });
          writeFileSync(stablePath, readFileSync(replacement));
        },
      }),
    /changed|identity|stable/i,
  );
} finally {
  rmSync(stableReadTemp, { recursive: true, force: true });
}
const dockerfile = readFileSync("Dockerfile.a3", "utf8");
assert.match(dockerfile, /ARG SPX_BUILD_MANIFEST=build-manifest\.json/);
assert.match(
  dockerfile,
  /COPY --chown=node:node \$\{SPX_BUILD_MANIFEST\} \/app\/build-manifest\.json/,
);

assert.throws(() => buildBuildManifest({ ...build, sourceSha: "main" } as never), /40-character/);
assert.throws(
  () => buildBuildManifest({ ...build, version: "release-1" } as never),
  /semantic version/,
);
assert.throws(
  () => buildBuildManifest({ ...build, schema: { min: 37, max: 36 } } as never),
  /schema range/,
);
assert.throws(
  () => buildBuildManifest({ ...build, schema: { min: 33, max: 35 } } as never),
  /highest released migration/,
);
assert.throws(
  () => buildBuildManifest({ ...build, environment: "production" } as never),
  /unknown field/,
);
assert.throws(
  () => buildBuildManifest({ ...build, migrations: [...migrations, migrations[0]] } as never),
  /duplicate migration/,
);
assert.throws(() => buildBuildManifest({ ...build, buildId: "../escape" } as never), /buildId/);
assert.throws(
  () =>
    finalizeReleaseManifest({
      build,
      imageId: "sha256:" + "b".repeat(64),
      imageTag: "spx-app:" + "9".repeat(40),
    }),
  /source SHA/,
);
assert.throws(
  () =>
    finalizeReleaseManifest({
      build: { ...build, migrationSetSha256: "0".repeat(64) },
      imageId: "sha256:" + "b".repeat(64),
      imageTag: "spx-app:" + "a".repeat(40),
    }),
  /migrationSetSha256/,
);

const temp = mkdtempSync(join(tmpdir(), "spx-release-manifest-"));
try {
  const migrationDirectory = join(temp, "migrations");
  mkdirSync(migrationDirectory);
  const migrationBytes = Buffer.from("SELECT 1;\n", "utf8");
  const migrationName = "031_example.sql";
  const migrationSha256 = createHash("sha256").update(migrationBytes).digest("hex");
  writeFileSync(join(migrationDirectory, migrationName), migrationBytes);
  writeFileSync(
    join(migrationDirectory, "released-checksums.json"),
    JSON.stringify({ [migrationName]: migrationSha256 }),
  );
  writeFileSync(join(temp, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(temp, "dist.tar"), "dist artifact");
  writeFileSync(join(temp, "operator-bundle.tar"), "operator bundle");
  const buildPath = join(temp, "build-manifest.json");
  const buildRun = spawnSync(
    process.execPath,
    [
      "scripts/create-release-manifest.mjs",
      "--stage=build",
      `--source-sha=${"a".repeat(40)}`,
      "--build-id=run-123.1",
      `--artifact=${join(temp, "dist.tar")}`,
      `--operator-bundle=${join(temp, "operator-bundle.tar")}`,
      "--schema-min=31",
      `--migrations=${join(migrationDirectory, "released-checksums.json")}`,
      `--package=${join(temp, "package.json")}`,
      `--output=${buildPath}`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(buildRun.status, 0, buildRun.stderr);
  const builtBytes = readFileSync(buildPath, "utf8");
  const built = JSON.parse(builtBytes);
  assert.equal(builtBytes, canonicalJson(built));
  assert.equal(
    built.operatorBundleSha256,
    createHash("sha256").update("operator bundle").digest("hex"),
  );

  writeFileSync(join(temp, "iidfile"), `sha256:${"b".repeat(64)}\n`);
  const releasePath = join(temp, "release-manifest.json");
  const releaseRun = spawnSync(
    process.execPath,
    [
      "scripts/create-release-manifest.mjs",
      "--stage=release",
      `--build-manifest=${buildPath}`,
      `--iidfile=${join(temp, "iidfile")}`,
      `--image-tag=spx-app:${"a".repeat(40)}`,
      `--output=${releasePath}`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(releaseRun.status, 0, releaseRun.stderr);
  const releasedBytes = readFileSync(releasePath, "utf8");
  const released = JSON.parse(releasedBytes);
  assert.equal(releasedBytes, canonicalJson(released));
  assert.equal("environment" in released, false);
  assert.equal("topology" in released, false);
  assert.equal(released.buildManifestSha256, createHash("sha256").update(builtBytes).digest("hex"));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
