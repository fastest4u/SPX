import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      stat = null;
    }

    if (stat && stat.isFile() && !stat.isSymbolicLink() && stat.size >= 1 && stat.size <= MAX_RELEASE_MANIFEST_BYTES) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { migrations?: unknown };
      if (Array.isArray(manifest.migrations) && manifest.migrations.length > 0) {
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
      }
    }

    // Fallback for legacy deployment mode: read approved migrations from migrations/released-checksums.json
    const fallbackPath = resolve(process.cwd(), "migrations/released-checksums.json");
    let fallbackStat;
    try {
      fallbackStat = lstatSync(fallbackPath);
    } catch {
      fallbackStat = null;
    }
    if (
      fallbackStat &&
      fallbackStat.isFile() &&
      !fallbackStat.isSymbolicLink() &&
      fallbackStat.size >= 1 &&
      fallbackStat.size <= MAX_RELEASE_MANIFEST_BYTES
    ) {
      const raw = JSON.parse(readFileSync(fallbackPath, "utf8")) as Record<string, unknown>;
      const entries = Object.entries(raw).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) return schemaNotReady();
      return entries.map(([name, sha256]) => {
        if (typeof sha256 !== "string" || !MIGRATION_NAME.test(name) || !SHA256.test(sha256)) {
          return schemaNotReady();
        }
        return { name, sha256 };
      });
    }

    return schemaNotReady();
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
