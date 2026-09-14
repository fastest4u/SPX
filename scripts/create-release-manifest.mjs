import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readStableRegularFile } from "./lib/safe-file.mjs";
import {
  buildBuildManifest,
  canonicalJson,
  finalizeReleaseManifest,
  sha256Hex,
} from "../src/services/release-manifest.ts";

function parseArguments(argv) {
  const values = {};
  for (const token of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(token);
    if (!match || match[1] in values) throw new Error(`unknown or duplicate argument: ${token}`);
    values[match[1]] = match[2];
  }
  if (values.stage !== "build" && values.stage !== "release")
    throw new Error("--stage must be build or release");
  const required =
    values.stage === "build"
      ? [
          "stage",
          "source-sha",
          "build-id",
          "artifact",
          "operator-bundle",
          "schema-min",
          "migrations",
          "output",
        ]
      : ["stage", "build-manifest", "iidfile", "image-tag", "output"];
  const allowed = new Set([...required, ...(values.stage === "build" ? ["package"] : [])]);
  const unknown = Object.keys(values).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.sort().join(", ")}`);
  const missing = required.filter((key) => !values[key]);
  if (missing.length > 0) throw new Error(`missing required argument(s): ${missing.join(", ")}`);
  return values;
}

function readRegularFile(pathInput, label) {
  const path = resolve(pathInput);
  return { path, bytes: readStableRegularFile(path, label) };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
}

function writeExclusive(pathInput, value) {
  const path = resolve(pathInput);
  const handle = openSync(path, "wx", 0o444);
  try {
    writeFileSync(handle, value, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function loadReleasedMigrations(pathInput) {
  const manifestFile = readRegularFile(pathInput, "released migration checksum manifest");
  const value = parseJson(manifestFile.bytes, "released migration checksum manifest");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("released migration checksum manifest must be an object");
  }
  const names = Object.keys(value).sort();
  if (names.length === 0) throw new Error("released migration checksum manifest must be non-empty");
  const directory = dirname(manifestFile.path);
  const diskNames = readdirSync(directory)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();
  if (canonicalJson(names) !== canonicalJson(diskNames))
    throw new Error("released migration checksum manifest does not match the migration file set");
  return names.map((name) => {
    const checksum = value[name];
    if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum))
      throw new Error(`released migration checksum is invalid: ${name}`);
    const migration = readRegularFile(resolve(directory, name), `released migration ${name}`);
    const actual = createHash("sha256").update(migration.bytes).digest("hex");
    if (actual !== checksum) throw new Error(`released migration checksum mismatch: ${name}`);
    return { name, sha256: checksum };
  });
}

function buildStage(args) {
  const packageFile = readRegularFile(args.package ?? "package.json", "package manifest");
  const packageManifest = parseJson(packageFile.bytes, "package manifest");
  if (!packageManifest || typeof packageManifest.version !== "string")
    throw new Error("package manifest version is missing");
  const schemaMin = Number(args["schema-min"]);
  if (!Number.isSafeInteger(schemaMin) || schemaMin < 0)
    throw new Error("--schema-min must be a non-negative integer");
  const migrations = loadReleasedMigrations(args.migrations);
  const highest = Math.max(...migrations.map((item) => Number(item.name.slice(0, 3))));
  const artifact = readRegularFile(args.artifact, "build artifact");
  const operatorBundle = readRegularFile(args["operator-bundle"], "operator bundle");
  const manifest = buildBuildManifest({
    version: packageManifest.version,
    sourceSha: args["source-sha"],
    buildId: args["build-id"],
    artifactSha256: sha256Hex(artifact.bytes),
    operatorBundleSha256: sha256Hex(operatorBundle.bytes),
    schema: { min: schemaMin, max: highest },
    migrations,
  });
  const bytes = canonicalJson(manifest);
  writeExclusive(args.output, bytes);
  return { stage: "build", manifestSha256: sha256Hex(bytes) };
}

function releaseStage(args) {
  const buildFile = readRegularFile(args["build-manifest"], "build manifest");
  const build = parseJson(buildFile.bytes, "build manifest");
  if (!buildFile.bytes.equals(Buffer.from(canonicalJson(build), "utf8")))
    throw new Error("build manifest bytes must be canonical JSON");
  const iidFile = readRegularFile(args.iidfile, "Docker iidfile");
  const imageId = iidFile.bytes.toString("utf8").trim();
  const manifest = finalizeReleaseManifest({ build, imageId, imageTag: args["image-tag"] });
  const bytes = canonicalJson(manifest);
  writeExclusive(args.output, bytes);
  return { stage: "release", manifestSha256: sha256Hex(bytes) };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = args.stage === "build" ? buildStage(args) : releaseStage(args);
  process.stdout.write(`${canonicalJson({ ok: true, ...result })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
