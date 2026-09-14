import { lstatSync, readFileSync } from "node:fs";

const RELEASE_MANIFEST_PATH = "/run/secrets/spx-release-manifest";
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const MIGRATION_NAME = /^\d{3}_[0-9A-Za-z][0-9A-Za-z_-]*\.sql$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface RuntimeReleasedMigration {
  name: string;
  sha256: string;
}

interface RuntimeMigrationHistoryRow {
  name?: unknown;
  checksum_sha256?: unknown;
  status?: unknown;
}

interface RuntimeSchemaPool {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}

function schemaNotReady(): never {
  throw new Error("runtime-schema-not-ready");
}

function releasedMigrationsFromManifest(path = RELEASE_MANIFEST_PATH): RuntimeReleasedMigration[] {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_RELEASE_MANIFEST_BYTES) {
      return schemaNotReady();
    }
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { migrations?: unknown };
    if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
      return schemaNotReady();
    }
    const migrations = manifest.migrations.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return schemaNotReady();
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !== "name,sha256" ||
        typeof record.name !== "string" ||
        !MIGRATION_NAME.test(record.name) ||
        typeof record.sha256 !== "string" ||
        !SHA256.test(record.sha256)
      ) {
        return schemaNotReady();
      }
      return { name: record.name, sha256: record.sha256 };
    });
    const names = migrations.map((migration) => migration.name);
    if (
      new Set(names).size !== names.length ||
      names.some((name, index) => index > 0 && names[index - 1].localeCompare(name) >= 0)
    ) {
      return schemaNotReady();
    }
    return migrations;
  } catch {
    return schemaNotReady();
  }
}

export function runtimeSchemaMutationsAllowed(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv !== "production";
}

export function verifyReleasedMigrationRows(
  released: readonly RuntimeReleasedMigration[],
  rows: readonly RuntimeMigrationHistoryRow[],
): void {
  if (released.length === 0 || rows.length !== released.length) schemaNotReady();
  for (let index = 0; index < released.length; index += 1) {
    const expected = released[index];
    const actual = rows[index];
    if (
      actual?.name !== expected.name ||
      actual.checksum_sha256 !== expected.sha256 ||
      actual.status !== "applied"
    ) {
      schemaNotReady();
    }
  }
}

export async function verifyRuntimeSchemaReady(
  pool: RuntimeSchemaPool,
  releaseManifestPath = RELEASE_MANIFEST_PATH,
): Promise<void> {
  try {
    const released = releasedMigrationsFromManifest(releaseManifestPath);
    const [rawRows] = await pool.query(
      `SELECT name AS name,
              checksum_sha256 AS checksum_sha256,
              status AS status
         FROM schema_migrations
        ORDER BY name`,
    );
    if (!Array.isArray(rawRows)) schemaNotReady();
    verifyReleasedMigrationRows(released, rawRows as RuntimeMigrationHistoryRow[]);
  } catch {
    schemaNotReady();
  }
}
