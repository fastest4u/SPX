#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const ALLOWED_PENDING_CLASSES = new Set(["expand", "control-plane"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertProduction(input) {
  if (
    input.releaseEnvironment !== "production" ||
    input.runtimeEnvironment !== "production" ||
    input.drillMode !== "supervised-production" ||
    input.composeProject !== "spx-production"
  )
    throw new Error("protected install production discriminator or Compose boundary mismatch");
}

function verifyBackupSummary(input) {
  const evidence = input.backupEvidence;
  if (
    evidence?.databaseFingerprint !== input.databaseFingerprint ||
    evidence?.beforeDdl !== true ||
    evidence?.encrypted !== true ||
    evidence?.isolatedRestore !== true ||
    evidence?.productionRoutesPresent !== false ||
    evidence?.providerCredentialsPresent !== false ||
    evidence?.teardownProven !== true ||
    !SHA256.test(evidence?.evidenceSha256 ?? "")
  )
    throw new Error("protected install backup/restore evidence is invalid");
  if (
    evidence.rpoMinutes > input.approvedRpoMinutes ||
    evidence.rtoMinutes > input.approvedRtoMinutes
  ) {
    throw new Error("protected install backup RPO/RTO exceeds approval");
  }
  const createdAt = Date.parse(evidence.createdAt);
  const verifiedAt = Date.parse(evidence.verifiedAt);
  const now = (input.now ?? new Date()).getTime();
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt < createdAt ||
    now < verifiedAt ||
    now - createdAt > input.maximumBackupAgeMinutes * 60_000
  )
    throw new Error("protected install backup evidence is stale");
  return evidence.evidenceSha256;
}

export function inspectOnlineAlterStatements(sql) {
  if (typeof sql !== "string") throw new Error("migration SQL is invalid");
  const withoutComments = sql.replace(/^\s*--.*$/gm, "");
  const alters = withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => /^ALTER\s+TABLE\b/i.test(statement));
  return alters.map((statement) => {
    const match = /,\s*ALGORITHM\s*=\s*(INSTANT|INPLACE)\s*,\s*LOCK\s*=\s*NONE\s*$/i.exec(
      statement,
    );
    if (!match || /ALGORITHM\s*=\s*COPY/i.test(statement)) {
      throw new Error(
        "online DDL requires explicit INSTANT/INPLACE and LOCK=NONE without fallback",
      );
    }
    return { algorithm: match[1].toUpperCase(), lock: "NONE" };
  });
}

export function verifyOnlineDdlEvidence(evidence) {
  if (
    typeof evidence?.migration !== "string" ||
    !SHA256.test(evidence?.migrationSha256 ?? "") ||
    !["INSTANT", "INPLACE"].includes(evidence?.algorithm) ||
    evidence?.lock !== "NONE" ||
    evidence?.implicitFallback !== false ||
    !Number.isFinite(evidence?.durationMs) ||
    evidence.durationMs < 0 ||
    evidence.durationMs > evidence.maximumDurationMs ||
    evidence?.latencyBudgetPassed !== true ||
    evidence?.ioBudgetPassed !== true ||
    evidence?.connectionBudgetPassed !== true ||
    typeof evidence?.tableSizeBucket !== "string" ||
    typeof evidence?.rehearsalMysqlVersion !== "string"
  )
    throw new Error("online DDL rehearsal evidence is invalid");
  return { ok: true, migration: evidence.migration, algorithm: evidence.algorithm, lock: "NONE" };
}

export function evaluateProtectedMigrationInstall(input) {
  assertProduction(input);
  const migrations = input.classification?.migrations;
  if (input.classification?.schemaVersion !== 1 || !migrations || typeof migrations !== "object") {
    throw new Error("migration classification is invalid");
  }
  const releasedNames = Object.keys(input.releasedChecksums).sort();
  if (canonical(Object.keys(migrations).sort()) !== canonical(releasedNames)) {
    throw new Error("migration classification does not cover the exact released set");
  }
  for (const name of releasedNames) {
    const item = migrations[name];
    if (!item || item.sha256 !== input.releasedChecksums[name] || !SHA256.test(item.sha256)) {
      throw new Error("migration classification checksum mismatch");
    }
  }
  const canonicalMigrationSet = releasedNames
    .map((name) => `${name}:${input.releasedChecksums[name]}`)
    .join("\n");
  const installedMigrationSetSha256 = createHash("sha256")
    .update(canonicalMigrationSet)
    .digest("hex");
  if (
    !SHA256.test(input.releaseMigrationSetSha256 ?? "") ||
    input.releaseMigrationSetSha256 !== installedMigrationSetSha256
  )
    throw new Error("released migration set hash mismatch");
  const installed = new Set(input.installedMigrations);
  const pending = releasedNames.filter((name) => !installed.has(name));
  if (canonical(pending) !== canonical([...input.expectedPending].sort())) {
    throw new Error("pending migration set differs from the signed allowlist");
  }
  for (let index = 0; index < pending.length; index += 1) {
    const name = pending[index];
    const migrationClass = migrations[name].class;
    if (name === "000_create_schema_migrations_v2.sql") {
      if (
        index !== 0 ||
        input.installedMigrations.length !== 0 ||
        migrationClass !== "control-plane-bootstrap"
      ) {
        throw new Error("control-plane bootstrap migration is invalid");
      }
    } else if (!ALLOWED_PENDING_CLASSES.has(migrationClass)) {
      throw new Error(`contract or unapproved migration cannot be installed: ${name}`);
    }
  }
  if (!Number.isSafeInteger(input.currentSchema) || !Number.isSafeInteger(input.targetSchema)) {
    throw new Error("schema range is invalid");
  }
  const numericVersions = releasedNames.map((name) => Number.parseInt(name.slice(0, 3), 10));
  if (input.targetSchema !== Math.max(...numericVersions))
    throw new Error("target schema is not the released maximum");
  if (
    input.currentSchema < input.rollbackSchemaRange.min ||
    input.targetSchema > input.rollbackSchemaRange.max
  )
    throw new Error("rollback image does not accept the expanded schema");
  const backupRestoreEvidenceSha256 = verifyBackupSummary(input);
  return {
    ok: true,
    beforeSchema: input.currentSchema,
    afterSchema: input.targetSchema,
    installedMigrationSetSha256,
    pendingReleasedMigrationCount: 0,
    backupRestoreEvidenceSha256,
    rollbackSchemaCompatible: true,
    checksumSetExact: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write('{"ok":false,"code":"release-install-check-requires-attested-inputs"}\n');
  process.exitCode = 1;
}
