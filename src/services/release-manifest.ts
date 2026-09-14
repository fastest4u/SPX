import { createHash } from "node:crypto";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BUILD_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/;
const MIGRATION_NAME = /^\d{3}_[0-9A-Za-z][0-9A-Za-z_-]*\.sql$/;

export interface ReleasedMigration {
  name: string;
  sha256: string;
}

export interface SchemaCompatibilityRange {
  min: number;
  max: number;
}

export interface SchemaCompatibilityInput extends SchemaCompatibilityRange {
  current: number;
  failed: readonly string[];
}

export interface BuildManifestInput {
  version: string;
  sourceSha: string;
  buildId: string;
  artifactSha256: string;
  operatorBundleSha256: string;
  schema: SchemaCompatibilityRange;
  migrations: ReleasedMigration[];
  migrationSetSha256?: string;
}

export function assertSchemaCompatible(input: SchemaCompatibilityInput): { current: number } {
  if (
    !Number.isSafeInteger(input.current)
    || !Number.isSafeInteger(input.min)
    || !Number.isSafeInteger(input.max)
    || input.current < 0
    || input.min < 0
    || input.max < input.min
    || !Array.isArray(input.failed)
    || !input.failed.every((name) => typeof name === "string" && name.length > 0)
  ) {
    throw new Error("schema compatibility input is invalid");
  }
  if (input.failed.length > 0) throw new Error("schema has a failed migration");
  if (input.current < input.min) throw new Error("schema is too old for this release");
  if (input.current > input.max) throw new Error("schema is too new for this release");
  return { current: input.current };
}

export interface BuildManifest extends Omit<BuildManifestInput, "migrationSetSha256"> {
  migrationSetSha256: string;
}

export interface FinalizeReleaseManifestInput {
  build: BuildManifest;
  imageId: string;
  imageTag: string;
}

export interface ReleaseManifest extends BuildManifest {
  imageId: string;
  imageTag: string;
  buildManifestSha256: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
  }
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new Error(`${label} is missing required field(s): ${missing.join(", ")}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeJson(value: unknown, path = "$", seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new Error(`${path} is not canonical JSON`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${path} contains a cycle`);
    seen.add(value);
    const normalized = value.map((item, index) => normalizeJson(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return normalized;
  }
  if (isRecord(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error(`${path} must be a plain JSON object`);
    if (seen.has(value)) throw new Error(`${path} contains a cycle`);
    seen.add(value);
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      const item = value[key];
      if (
        item === undefined ||
        typeof item === "bigint" ||
        typeof item === "function" ||
        typeof item === "symbol"
      ) {
        throw new Error(`${path}.${key} is not JSON-serializable`);
      }
      normalized[key] = normalizeJson(item, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return normalized;
  }
  throw new Error(`${path} is not JSON-serializable`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function validateMigrations(value: unknown): {
  migrations: ReleasedMigration[];
  migrationSetSha256: string;
  highest: number;
} {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("migrations must be a non-empty array");
  const names = new Set<string>();
  const numbers = new Set<number>();
  const migrations = value
    .map((raw, index) => {
      const migration = requireRecord(raw, `migrations[${index}]`);
      rejectUnknownFields(migration, ["name", "sha256"], `migrations[${index}]`);
      const name = requireString(migration.name, `migrations[${index}].name`);
      const sha256 = requireString(migration.sha256, `migrations[${index}].sha256`);
      if (!MIGRATION_NAME.test(name) || !SHA256.test(sha256)) {
        throw new Error(`migration name/checksum is invalid at index ${index}`);
      }
      const number = Number(name.slice(0, 3));
      if (names.has(name) || numbers.has(number)) throw new Error(`duplicate migration: ${name}`);
      names.add(name);
      numbers.add(number);
      return { name, sha256 };
    })
    .sort((left, right) => compareCodePoints(left.name, right.name));
  const canonicalSet = migrations.map((item) => `${item.name}:${item.sha256}`).join("\n");
  return {
    migrations,
    migrationSetSha256: sha256Hex(canonicalSet),
    highest: Math.max(...migrations.map((item) => Number(item.name.slice(0, 3)))),
  };
}

export function buildBuildManifest(input: BuildManifestInput): BuildManifest {
  const raw = requireRecord(input, "build manifest input");
  rejectUnknownFields(
    raw,
    [
      "version",
      "sourceSha",
      "buildId",
      "artifactSha256",
      "operatorBundleSha256",
      "schema",
      "migrations",
      "migrationSetSha256",
    ],
    "build manifest input",
    [
      "version",
      "sourceSha",
      "buildId",
      "artifactSha256",
      "operatorBundleSha256",
      "schema",
      "migrations",
    ],
  );
  const version = requireString(raw.version, "version");
  const sourceSha = requireString(raw.sourceSha, "sourceSha");
  const buildId = requireString(raw.buildId, "buildId");
  const artifactSha256 = requireString(raw.artifactSha256, "artifactSha256");
  const operatorBundleSha256 = requireString(raw.operatorBundleSha256, "operatorBundleSha256");
  if (!SEMVER.test(version)) throw new Error("version must be a semantic version");
  if (!SHA40.test(sourceSha)) throw new Error("sourceSha must be a 40-character lowercase hex SHA");
  if (!BUILD_ID.test(buildId)) throw new Error("buildId must be a stable, path-free identifier");
  if (!SHA256.test(artifactSha256)) throw new Error("artifactSha256 must be SHA-256");
  if (!SHA256.test(operatorBundleSha256)) throw new Error("operatorBundleSha256 must be SHA-256");

  const schema = requireRecord(raw.schema, "schema");
  rejectUnknownFields(schema, ["min", "max"], "schema");
  if (
    !Number.isSafeInteger(schema.min) ||
    !Number.isSafeInteger(schema.max) ||
    Number(schema.min) < 0 ||
    Number(schema.max) < 0 ||
    Number(schema.min) > Number(schema.max)
  ) {
    throw new Error("invalid schema range");
  }
  const migrationResult = validateMigrations(raw.migrations);
  if (Number(schema.max) !== migrationResult.highest) {
    throw new Error("schema.max must equal the highest released migration");
  }

  if (
    raw.migrationSetSha256 !== undefined &&
    raw.migrationSetSha256 !== migrationResult.migrationSetSha256
  ) {
    throw new Error("migrationSetSha256 does not match the canonical migration set");
  }
  return deepFreeze({
    version,
    sourceSha,
    buildId,
    artifactSha256,
    operatorBundleSha256,
    schema: { min: Number(schema.min), max: Number(schema.max) },
    migrations: migrationResult.migrations,
    migrationSetSha256: migrationResult.migrationSetSha256,
  });
}

export function finalizeReleaseManifest(input: FinalizeReleaseManifestInput): ReleaseManifest {
  const raw = requireRecord(input, "release manifest input");
  rejectUnknownFields(raw, ["build", "imageId", "imageTag"], "release manifest input");
  const buildRaw = requireRecord(raw.build, "build");
  const suppliedMigrationSetSha256 = requireString(
    buildRaw.migrationSetSha256,
    "build.migrationSetSha256",
  );
  const build = buildBuildManifest(buildRaw as unknown as BuildManifestInput);
  if (suppliedMigrationSetSha256 !== build.migrationSetSha256) {
    throw new Error("build.migrationSetSha256 does not match the canonical migration set");
  }
  const imageId = requireString(raw.imageId, "imageId");
  const imageTag = requireString(raw.imageTag, "imageTag");
  if (!IMAGE_ID.test(imageId)) throw new Error("imageId must be a sha256 image ID");
  if (imageTag !== `spx-app:${build.sourceSha}`)
    throw new Error("imageTag must contain the exact source SHA");
  return deepFreeze({
    ...build,
    imageId,
    imageTag,
    buildManifestSha256: sha256Hex(canonicalJson(build)),
  });
}
