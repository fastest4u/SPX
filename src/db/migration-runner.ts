import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

const BOOTSTRAP_MIGRATION = "000_create_schema_migrations_v2.sql";
const FRESH_BASELINE_MIGRATION = "001_create_booking_requests.sql";
const FRESH_BASELINE_SUPPLEMENT = "034_complete_fresh_baseline.sql";
const FRESH_BASELINE_SUPERSEDED_MIGRATIONS = [
  "018_multi_team_runtime.sql",
  "019_notify_rules_accept_all.sql",
  "020_auto_accept_history_diagnostics.sql",
] as const;
const FRESH_BASELINE_SUPERSEDED_SET = new Set<string>(
  FRESH_BASELINE_SUPERSEDED_MIGRATIONS,
);
const MIGRATION_FILE = /^\d{3}_.+\.sql$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type MigrationStatus = "running" | "applied" | "failed";
export type MigrationClassification = "control-plane-bootstrap" | "schema";
export type MigrationHistoryShape = "absent" | "supported-v1" | "safe-partial-v2" | "v2" | "unsupported";
export type MigrationExecutionMode = "executed" | "fresh-baseline" | "baseline-superseded";

export interface MigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

export interface MigrationHistoryRow {
  name: string;
  checksumSha256: string | null;
  status: MigrationStatus | null;
  failedStatementIndex: number | null;
  attemptCount: number;
  executionMode: MigrationExecutionMode | null;
  executionSha256: string | null;
}

export interface MigrationConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
  superseded: string[];
}

export type MigrationFailureClassification =
  | {
    status: "blocked";
    reason: "partial-ddl-manual-recovery-required" | "failed-statement-index-invalid";
  }
  | {
    status: "retryable";
    reason: "mysql8-atomic-statement-resume-approved";
    resumeStatementIndex: number;
  };

export class MigrationRunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly migration?: string,
  ) {
    super(message);
    this.name = "MigrationRunnerError";
  }
}

interface MigrationRunnerOptions {
  connection: MigrationConnection;
  files: MigrationFile[];
  approvedReleasedChecksums: Record<string, string>;
  allowRetry?: ReadonlySet<string>;
}

interface RunMigrationsFromDirectoryOptions {
  connection: MigrationConnection;
  directory: string;
  allowRetry?: ReadonlySet<string>;
}

const requiredHistoryColumns = new Map<string, {
  type: string;
  nullable: "YES" | "NO";
  defaultIncludes?: string;
  extraIncludes?: string[];
}>([
  ["id", { type: "bigint unsigned", nullable: "NO", extraIncludes: ["auto_increment"] }],
  ["name", { type: "varchar(255)", nullable: "NO" }],
  ["checksum_sha256", { type: "char(64)", nullable: "YES" }],
  ["status", { type: "varchar(16)", nullable: "YES" }],
  ["execution_mode", { type: "varchar(32)", nullable: "YES" }],
  ["execution_sha256", { type: "char(64)", nullable: "YES" }],
  ["started_at", { type: "datetime", nullable: "YES" }],
  ["applied_at", { type: "datetime", nullable: "YES" }],
  ["failed_at", { type: "datetime", nullable: "YES" }],
  ["failed_statement_index", { type: "int unsigned", nullable: "YES" }],
  ["attempt_count", { type: "int unsigned", nullable: "NO", defaultIncludes: "0" }],
  ["last_error_code", { type: "varchar(64)", nullable: "YES" }],
  ["created_at", { type: "datetime", nullable: "NO", defaultIncludes: "current_timestamp" }],
  ["updated_at", {
    type: "datetime",
    nullable: "NO",
    defaultIncludes: "current_timestamp",
    extraIncludes: ["on update"],
  }],
]);

const requiredHistoryIndexes = new Map<string, { unique: boolean; columns: string[] }>([
  ["PRIMARY", { unique: true, columns: ["id"] }],
  ["schema_migrations_name_idx", { unique: true, columns: ["name"] }],
  ["schema_migrations_checksum_idx", { unique: false, columns: ["checksum_sha256"] }],
  ["schema_migrations_status_idx", { unique: false, columns: ["status"] }],
]);

export function classifyMigration(name: string): MigrationClassification {
  return name === BOOTSTRAP_MIGRATION ? "control-plane-bootstrap" : "schema";
}

export function createMigrationRunner(options: MigrationRunnerOptions) {
  const files = [...options.files].sort((left, right) => left.name.localeCompare(right.name));
  const filesByName = new Map(files.map((file) => [file.name, file]));
  const allowRetry = options.allowRetry ?? new Set<string>();

  function verifyHistoryChecksums(rows: MigrationHistoryRow[]): void {
    validateReleasedFiles(files, options.approvedReleasedChecksums);
    for (const row of rows) {
      const expected = filesByName.get(row.name);
      if (!expected) {
        throw new MigrationRunnerError("unapproved-history", `unapproved migration history: ${safeName(row.name)}`, safeName(row.name));
      }
      if (row.checksumSha256 !== null && row.checksumSha256 !== expected.sha256) {
        throw new MigrationRunnerError("checksum-mismatch", `checksum mismatch for ${expected.name}`, expected.name);
      }
    }
  }

  function verifyExecutionProvenance(rows: MigrationHistoryRow[]): void {
    const rowsByName = new Map(rows.map((row) => [row.name, row]));
    const baseline = filesByName.get(FRESH_BASELINE_MIGRATION);

    for (const row of rows) {
      const migration = filesByName.get(row.name);
      if (!migration) continue;
      if (row.executionMode === "executed") {
        if (row.executionSha256 !== migration.sha256) {
          throw new MigrationRunnerError(
            "execution-provenance-invalid",
            `execution provenance is invalid for ${migration.name}`,
            migration.name,
          );
        }
        continue;
      }
      if (row.executionMode === "fresh-baseline") {
        if (migration.name !== FRESH_BASELINE_MIGRATION || row.executionSha256 !== migration.sha256) {
          throw new MigrationRunnerError(
            "execution-provenance-invalid",
            `execution provenance is invalid for ${migration.name}`,
            migration.name,
          );
        }
        continue;
      }
      if (row.executionMode === "baseline-superseded") {
        const baselineRow = rowsByName.get(FRESH_BASELINE_MIGRATION);
        if (
          !baseline ||
          !FRESH_BASELINE_SUPERSEDED_SET.has(migration.name) ||
          row.status !== "applied" ||
          row.executionSha256 !== baseline.sha256 ||
          baselineRow?.executionMode !== "fresh-baseline" ||
          baselineRow.executionSha256 !== baseline.sha256
        ) {
          throw new MigrationRunnerError(
            "execution-provenance-invalid",
            `execution provenance is invalid for ${migration.name}`,
            migration.name,
          );
        }
        continue;
      }
      throw new MigrationRunnerError(
        "execution-provenance-missing",
        `execution provenance is missing for ${migration.name}`,
        migration.name,
      );
    }
  }

  async function verifyApplied(rows: MigrationHistoryRow[]): Promise<void> {
    verifyHistoryChecksums(rows);
    verifyExecutionProvenance(rows);
  }

  async function classifyFailure(input: {
    statementIndex: number;
    statementCount: number;
    retrySafe: boolean;
  }): Promise<MigrationFailureClassification> {
    if (!Number.isSafeInteger(input.statementCount)
      || input.statementCount < 1
      || !Number.isSafeInteger(input.statementIndex)
      || input.statementIndex < 1
      || input.statementIndex > input.statementCount) {
      return { status: "blocked", reason: "failed-statement-index-invalid" };
    }
    if (!input.retrySafe) {
      return { status: "blocked", reason: "partial-ddl-manual-recovery-required" };
    }
    return {
      status: "retryable",
      reason: "mysql8-atomic-statement-resume-approved",
      resumeStatementIndex: input.statementIndex,
    };
  }

  async function run(): Promise<MigrationRunResult> {
    let lockName: string | null = null;
    let lockAcquired = false;
    let primaryFailure: MigrationRunnerError | null = null;
    let completedResult: MigrationRunResult | null = null;
    try {
      validateReleasedFiles(files, options.approvedReleasedChecksums);
      for (const name of allowRetry) {
        if (!filesByName.has(name)) {
          throw new MigrationRunnerError("retry-target-invalid", `allow-retry target is not released: ${safeName(name)}`);
        }
      }
      const bootstrap = filesByName.get(BOOTSTRAP_MIGRATION);
      if (!bootstrap) {
        throw new MigrationRunnerError("bootstrap-missing", `released migration missing: ${BOOTSTRAP_MIGRATION}`, BOOTSTRAP_MIGRATION);
      }
      const freshBaseline = filesByName.get(FRESH_BASELINE_MIGRATION) ?? null;
      if (freshBaseline) {
        for (const requiredName of [
          ...FRESH_BASELINE_SUPERSEDED_MIGRATIONS,
          FRESH_BASELINE_SUPPLEMENT,
        ]) {
          if (!filesByName.has(requiredName)) {
            throw new MigrationRunnerError(
              "fresh-baseline-contract-incomplete",
              "fresh baseline migration contract is incomplete",
            );
          }
        }
      }

      lockName = await databaseLockName(options.connection);
      lockAcquired = await acquireLock(options.connection, lockName);
      if (!lockAcquired) {
        throw new MigrationRunnerError("lock-unavailable", "migration lock unavailable");
      }

      const initialHistoryShape = await inspectHistoryShape(options.connection);
      if (initialHistoryShape === "unsupported") {
        throw new MigrationRunnerError("history-shape-unsupported", "unsupported migration history shape");
      }
      const bootstrapExecuted = initialHistoryShape !== "v2";
      if (bootstrapExecuted) {
        await executeBootstrap(options.connection, bootstrap);
        if ((await inspectHistoryShape(options.connection)) !== "v2") {
          throw new MigrationRunnerError(
            "bootstrap-postcondition-failed",
            `bootstrap postconditions failed: ${BOOTSTRAP_MIGRATION}`,
            BOOTSTRAP_MIGRATION,
          );
        }
      }

      let historyRows = await readHistory(options.connection);
      const freshBaselineEligible = freshBaseline !== null && historyRows.length === 0;
      verifyHistoryChecksums(historyRows);
      await backfillLegacyHistory(options.connection, historyRows, filesByName);
      historyRows = await readHistory(options.connection);
      if (bootstrapExecuted) {
        await backfillExecutionProvenance(options.connection, historyRows);
        historyRows = await readHistory(options.connection);
      }
      await verifyApplied(historyRows);

      let historyByName = new Map(historyRows.map((row) => [row.name, row]));
      const bootstrapRow = historyByName.get(BOOTSTRAP_MIGRATION);
      if (!bootstrapRow) {
        await markRunning(options.connection, bootstrap, {
          mode: "executed",
          sha256: bootstrap.sha256,
        });
        await markApplied(options.connection, bootstrap, {
          mode: "executed",
          sha256: bootstrap.sha256,
        });
      } else if (bootstrapRow.status !== "applied") {
        if (bootstrapRow.checksumSha256 !== bootstrap.sha256) {
          throw new MigrationRunnerError("checksum-mismatch", `checksum mismatch for ${BOOTSTRAP_MIGRATION}`, BOOTSTRAP_MIGRATION);
        }
        await markApplied(options.connection, bootstrap, {
          mode: bootstrapRow.executionMode ?? "executed",
          sha256: bootstrapRow.executionSha256 ?? bootstrap.sha256,
        });
      }

      historyRows = await readHistory(options.connection);
      await verifyApplied(historyRows);
      historyByName = new Map(historyRows.map((row) => [row.name, row]));
      const baselineModeActive = freshBaselineEligible || (
        historyByName.get(FRESH_BASELINE_MIGRATION)?.executionMode === "fresh-baseline"
      );

      const result: MigrationRunResult = { applied: [], skipped: [], superseded: [] };
      result[bootstrapExecuted ? "applied" : "skipped"].push(BOOTSTRAP_MIGRATION);

      for (const migration of files) {
        if (classifyMigration(migration.name) === "control-plane-bootstrap") continue;
        const existing = historyByName.get(migration.name);
        if (existing?.status === "applied") {
          if (existing.executionMode === "baseline-superseded") {
            result.superseded.push(migration.name);
          } else {
            result.skipped.push(migration.name);
          }
          continue;
        }
        if (baselineModeActive && FRESH_BASELINE_SUPERSEDED_SET.has(migration.name)) {
          if (!freshBaseline) {
            throw new MigrationRunnerError(
              "fresh-baseline-provenance-invalid",
              "fresh baseline provenance is invalid",
            );
          }
          await markBaselineSuperseded(options.connection, migration, freshBaseline.sha256);
          result.superseded.push(migration.name);
          continue;
        }
        if (existing?.status === "running") {
          throw new MigrationRunnerError(
            "unsafe-retry-blocked",
            `unsafe migration retry blocked for ${migration.name}: prior attempt is still running`,
            migration.name,
          );
        }
        let resumeStatementIndex = 1;
        if (existing?.status === "failed") {
          if (!Number.isSafeInteger(existing.attemptCount) || existing.attemptCount < 1) {
            throw new MigrationRunnerError(
              "failed-history-state-invalid",
              `failed migration history state is invalid for ${migration.name}`,
              migration.name,
            );
          }
          const statementCount = splitSqlStatements(migration.sql).length;
          const failure = await classifyFailure({
            statementIndex: existing.failedStatementIndex ?? Number.NaN,
            statementCount,
            retrySafe: allowRetry.has(migration.name),
          });
          if (failure.status === "blocked") {
            if (failure.reason === "failed-statement-index-invalid") {
              throw new MigrationRunnerError(
                "failed-statement-index-invalid",
                `failed statement index is invalid for ${migration.name}`,
                migration.name,
              );
            }
            throw new MigrationRunnerError(
              "unsafe-retry-blocked",
              `unsafe migration retry blocked for ${migration.name}: explicit allow-retry required`,
              migration.name,
            );
          }
          resumeStatementIndex = failure.resumeStatementIndex;
        }

        const execution = existing?.executionMode && existing.executionSha256
          ? { mode: existing.executionMode, sha256: existing.executionSha256 }
          : freshBaselineEligible && migration.name === FRESH_BASELINE_MIGRATION
            ? { mode: "fresh-baseline" as const, sha256: migration.sha256 }
            : { mode: "executed" as const, sha256: migration.sha256 };
        await applyMigration(options.connection, migration, resumeStatementIndex, execution);
        result.applied.push(migration.name);
      }

      await verifyApplied(await readHistory(options.connection));

      completedResult = result;
    } catch (error) {
      primaryFailure = sanitizedRunnerError(error);
    }

    if (lockAcquired && lockName !== null) {
      try {
        await releaseLock(options.connection, lockName);
      } catch (error) {
        const releaseFailure = sanitizedRunnerError(error);
        primaryFailure = primaryFailure === null
          ? releaseFailure
          : combineRunnerErrors(primaryFailure, releaseFailure);
      }
    }

    if (primaryFailure !== null) throw primaryFailure;
    if (completedResult === null) {
      throw new MigrationRunnerError("runner-incomplete", "migration runner did not complete");
    }
    return completedResult;
  }

  return { run, verifyApplied, classifyFailure };
}

export async function runMigrationsFromDirectory(options: RunMigrationsFromDirectoryOptions): Promise<MigrationRunResult> {
  let directory: string;
  try {
    directory = canonicalDirectory(options.directory);
  } catch (error) {
    if (error instanceof MigrationRunnerError) throw error;
    throw new MigrationRunnerError("manifest-unreadable", "released migration manifest is unreadable");
  }

  let approvedReleasedChecksums: Record<string, string>;
  try {
    approvedReleasedChecksums = JSON.parse(
      UTF8_DECODER.decode(readRegularFile(directory, "released-checksums.json", "manifest")),
    ) as Record<string, string>;
  } catch (error) {
    if (error instanceof MigrationRunnerError) throw error;
    throw new MigrationRunnerError("manifest-unreadable", "released migration manifest is unreadable");
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { encoding: "utf8", withFileTypes: true });
  } catch {
    throw new MigrationRunnerError("migration-directory-unreadable", "released migration directory is unreadable");
  }

  const files = entries
    .filter((entry) => MIGRATION_FILE.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry.isFile()) {
        throw new MigrationRunnerError(
          "migration-file-unsafe",
          `released migration file is unsafe: ${safeName(entry.name)}`,
          safeName(entry.name),
        );
      }
      const rawSql = readRegularFile(directory, entry.name, "migration");
      const sha256 = digest(rawSql);
      const sql = decodeMigrationSql(rawSql, entry.name);
      return {
        name: entry.name,
        sql,
        sha256,
      } satisfies MigrationFile;
    });

  return createMigrationRunner({
    connection: options.connection,
    files,
    approvedReleasedChecksums,
    allowRetry: options.allowRetry,
  }).run();
}

function canonicalDirectory(directory: string): string {
  const requested = resolve(directory);
  const requestedStats = lstatSync(requested);
  if (!requestedStats.isDirectory() || requestedStats.isSymbolicLink()) {
    throw new MigrationRunnerError("migration-directory-unsafe", "released migration directory is unsafe");
  }
  const canonical = realpathSync.native(requested);
  if (!lstatSync(canonical).isDirectory()) {
    throw new MigrationRunnerError("migration-directory-unsafe", "released migration directory is unsafe");
  }
  return canonical;
}

function readRegularFile(
  directory: string,
  name: string,
  kind: "manifest" | "migration",
): Buffer {
  const migration = kind === "migration" ? safeName(name) : undefined;
  const unsafe = (): MigrationRunnerError => kind === "manifest"
    ? new MigrationRunnerError("manifest-unsafe", "released migration manifest is unsafe")
    : new MigrationRunnerError("migration-file-unsafe", `released migration file is unsafe: ${migration}`, migration);
  const unreadable = (): MigrationRunnerError => kind === "manifest"
    ? new MigrationRunnerError("manifest-unreadable", "released migration manifest is unreadable")
    : new MigrationRunnerError("migration-file-unreadable", `released migration file is unreadable: ${migration}`, migration);

  let descriptor: number | null = null;
  try {
    const candidate = resolve(directory, name);
    if (!isContainedPath(directory, candidate)) throw unsafe();

    const before = lstatSync(candidate);
    if (!before.isFile() || before.isSymbolicLink()) throw unsafe();
    const canonical = realpathSync.native(candidate);
    if (!isContainedPath(directory, canonical)) throw unsafe();

    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(candidate, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw unsafe();

    const afterOpen = lstatSync(candidate);
    if (!afterOpen.isFile()
      || afterOpen.isSymbolicLink()
      || afterOpen.dev !== opened.dev
      || afterOpen.ino !== opened.ino) {
      throw unsafe();
    }
    const canonicalAfterOpen = realpathSync.native(candidate);
    if (!isContainedPath(directory, canonicalAfterOpen) || canonicalAfterOpen !== canonical) throw unsafe();
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof MigrationRunnerError) throw error;
    throw unreadable();
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // A read-only descriptor close failure does not expose paths and cannot change migration state.
      }
    }
  }
}

function decodeMigrationSql(rawSql: Buffer, name: string): string {
  const migration = safeName(name);
  try {
    const sql = UTF8_DECODER.decode(rawSql);
    if (!Buffer.from(sql, "utf8").equals(rawSql)) {
      throw new TypeError("noncanonical utf-8");
    }
    return sql;
  } catch {
    throw new MigrationRunnerError(
      "migration-encoding-invalid",
      `released migration encoding is invalid: ${migration}`,
      migration,
    );
  }
}

function isContainedPath(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return pathFromDirectory !== ""
    && pathFromDirectory !== ".."
    && !pathFromDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(pathFromDirectory);
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "\"" | "'" | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        current += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote === null && char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (quote === null && char === "#") {
      lineComment = true;
      continue;
    }
    if (quote === null && char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (quote !== null) {
      current += char;
      if (char === "\\") {
        if (next !== undefined) {
          current += next;
          index += 1;
        }
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }
    current += char;
  }

  const finalStatement = current.trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}

function validateReleasedFiles(files: MigrationFile[], approved: Record<string, string>): void {
  const names = files.map((file) => file.name);
  if (new Set(names).size !== names.length) {
    throw new MigrationRunnerError("duplicate-migration", "released migration filenames must be unique");
  }
  const sequences = names.map((name) => name.slice(0, 3));
  if (new Set(sequences).size !== sequences.length) {
    throw new MigrationRunnerError("duplicate-sequence", "released migration sequence numbers must be unique");
  }
  const approvedNames = Object.keys(approved).sort((left, right) => left.localeCompare(right));
  if (approvedNames.length !== names.length || approvedNames.some((name, index) => name !== names[index])) {
    throw new MigrationRunnerError("manifest-set-mismatch", "released migration manifest does not match migration files");
  }
  for (const file of files) {
    const expected = approved[file.name];
    if (!SHA256.test(expected ?? "") || file.sha256 !== expected) {
      throw new MigrationRunnerError("checksum-mismatch", `checksum mismatch for ${file.name}`, file.name);
    }
  }
}

async function databaseLockName(connection: MigrationConnection): Promise<string> {
  const [rawRows] = await connection.query("SELECT DATABASE() AS database_name");
  const rows = asRecords(rawRows);
  const databaseName = rows[0]?.database_name;
  if (typeof databaseName !== "string" || databaseName.length === 0) {
    throw new MigrationRunnerError("database-scope-unavailable", "database scope unavailable for migration lock");
  }
  return `spx:migrations:${digest(databaseName).slice(0, 40)}`;
}

async function acquireLock(connection: MigrationConnection, lockName: string): Promise<boolean> {
  const [rawRows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
  return Number(asRecords(rawRows)[0]?.acquired) === 1;
}

async function releaseLock(connection: MigrationConnection, lockName: string): Promise<void> {
  try {
    const [rawRows] = await connection.query("SELECT RELEASE_LOCK(?) AS released", [lockName]);
    if (Number(asRecords(rawRows)[0]?.released) !== 1) {
      throw new MigrationRunnerError("lock-release-failed", "migration lock release failed");
    }
  } catch {
    throw new MigrationRunnerError("lock-release-failed", "migration lock release failed");
  }
}

async function inspectHistoryShape(connection: MigrationConnection): Promise<MigrationHistoryShape> {
  const [rawColumns] = await connection.query(
    `SELECT COLUMN_NAME AS column_name,
            COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable,
            COLUMN_DEFAULT AS column_default,
            EXTRA AS extra
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'schema_migrations'
      ORDER BY ordinal_position`,
  );
  const [rawIndexes] = await connection.query(
    `SELECT INDEX_NAME AS index_name,
            NON_UNIQUE AS non_unique,
            SEQ_IN_INDEX AS seq_in_index,
            COLUMN_NAME AS column_name
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'schema_migrations'
      ORDER BY index_name, seq_in_index`,
  );

  const columnRows = asRecords(rawColumns);
  const indexRows = asRecords(rawIndexes);
  if (columnRows.length === 0 && indexRows.length === 0) return "absent";

  const columns = new Map<string, Record<string, unknown>>();
  for (const row of columnRows) {
    const name = String(row.column_name);
    if (columns.has(name)) return "unsupported";
    columns.set(name, row);
  }
  for (const [name, actual] of columns) {
    const expected = requiredHistoryColumns.get(name);
    if (!expected || !historyColumnMatches(actual, expected)) return "unsupported";
  }

  const grouped = new Map<string, { unique: boolean; columns: string[] }>();
  for (const row of indexRows) {
    const name = String(row.index_name);
    const entry = grouped.get(name) ?? { unique: Number(row.non_unique) === 0, columns: [] };
    entry.columns.push(String(row.column_name));
    grouped.set(name, entry);
  }
  for (const [name, actual] of grouped) {
    const expected = requiredHistoryIndexes.get(name);
    if (!expected || !historyIndexMatches(actual, expected)) return "unsupported";
    if (actual.columns.some((column) => !columns.has(column))) return "unsupported";
  }

  const legacyColumns = ["id", "name", "created_at"];
  const legacyIndexes = ["PRIMARY", "schema_migrations_name_idx"];
  if (legacyColumns.some((name) => !columns.has(name)) || legacyIndexes.some((name) => !grouped.has(name))) {
    return "unsupported";
  }

  const isV2 = columns.size === requiredHistoryColumns.size
    && grouped.size === requiredHistoryIndexes.size;
  if (isV2) return "v2";

  const isV1 = columns.size === legacyColumns.length && grouped.size === legacyIndexes.length;
  return isV1 ? "supported-v1" : "safe-partial-v2";
}

function historyColumnMatches(
  actual: Record<string, unknown>,
  expected: {
    type: string;
    nullable: "YES" | "NO";
    defaultIncludes?: string;
    extraIncludes?: string[];
  },
): boolean {
  if (normalize(actual.column_type) !== expected.type || actual.is_nullable !== expected.nullable) return false;
  if (expected.defaultIncludes && !normalize(actual.column_default).includes(expected.defaultIncludes)) return false;
  return !expected.extraIncludes?.some((part) => !normalize(actual.extra).includes(part));
}

function historyIndexMatches(
  actual: { unique: boolean; columns: string[] },
  expected: { unique: boolean; columns: string[] },
): boolean {
  return actual.unique === expected.unique && actual.columns.join(",") === expected.columns.join(",");
}

async function executeBootstrap(connection: MigrationConnection, bootstrap: MigrationFile): Promise<void> {
  const statements = splitSqlStatements(bootstrap.sql);
  if (statements.length === 0) {
    throw new MigrationRunnerError("bootstrap-empty", `released migration is empty: ${bootstrap.name}`, bootstrap.name);
  }

  let previousLockWaitTimeout: number | null = null;
  let primaryFailure: MigrationRunnerError | null = null;
  try {
    const [rawRows] = await connection.query(
      "SELECT @@SESSION.lock_wait_timeout AS lock_wait_timeout",
    );
    const rawValue = asRecords(rawRows)[0]?.lock_wait_timeout;
    const parsedValue = Number(rawValue);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
      throw new MigrationRunnerError(
        "lock-wait-timeout-unavailable",
        "session lock wait timeout is unavailable",
        bootstrap.name,
      );
    }
    previousLockWaitTimeout = parsedValue;
    await connection.query("SET SESSION lock_wait_timeout = ?", [5]);

    for (let index = 0; index < statements.length; index += 1) {
      try {
        await connection.query(statements[index]);
      } catch {
        throw new MigrationRunnerError(
          "bootstrap-statement-failed",
          `migration ${bootstrap.name} failed at statement ${index + 1}`,
          bootstrap.name,
        );
      }
    }
  } catch (error) {
    primaryFailure = sanitizedRunnerError(error);
  }

  if (previousLockWaitTimeout !== null) {
    try {
      await connection.query("SET SESSION lock_wait_timeout = ?", [previousLockWaitTimeout]);
    } catch {
      const restoreFailure = new MigrationRunnerError(
        "lock-wait-timeout-restore-failed",
        "session lock wait timeout restoration failed",
        bootstrap.name,
      );
      primaryFailure = primaryFailure === null
        ? restoreFailure
        : combineRunnerErrors(primaryFailure, restoreFailure);
    }
  }

  if (primaryFailure !== null) throw primaryFailure;
}

async function readHistory(connection: MigrationConnection): Promise<MigrationHistoryRow[]> {
  const [rawRows] = await connection.query(
    `SELECT name, checksum_sha256, status, execution_mode, execution_sha256,
            failed_statement_index, attempt_count
       FROM schema_migrations
      ORDER BY name`,
  );
  return asRecords(rawRows).map((row) => {
    const status = row.status;
    if (status !== null && status !== "running" && status !== "applied" && status !== "failed") {
      throw new MigrationRunnerError("invalid-history-status", `invalid migration history status for ${safeName(row.name)}`);
    }
    const executionMode = row.execution_mode;
    if (
      executionMode !== null &&
      executionMode !== "executed" &&
      executionMode !== "fresh-baseline" &&
      executionMode !== "baseline-superseded"
    ) {
      throw new MigrationRunnerError(
        "invalid-execution-mode",
        `invalid migration execution mode for ${safeName(row.name)}`,
      );
    }
    return {
      name: safeName(row.name),
      checksumSha256: typeof row.checksum_sha256 === "string" ? row.checksum_sha256 : null,
      status,
      failedStatementIndex: row.failed_statement_index === null ? null : Number(row.failed_statement_index),
      attemptCount: Number(row.attempt_count ?? 0),
      executionMode,
      executionSha256: typeof row.execution_sha256 === "string" ? row.execution_sha256 : null,
    };
  });
}

async function backfillLegacyHistory(
  connection: MigrationConnection,
  rows: MigrationHistoryRow[],
  filesByName: ReadonlyMap<string, MigrationFile>,
): Promise<void> {
  for (const row of rows) {
    if (row.checksumSha256 !== null && row.status !== null) continue;
    const migration = filesByName.get(row.name);
    if (!migration) {
      throw new MigrationRunnerError("unapproved-history", `unapproved migration history: ${row.name}`, row.name);
    }
    if (row.status === null) {
      const [result] = await connection.query(
        `UPDATE schema_migrations
            SET checksum_sha256 = ?,
                status = 'applied',
                started_at = COALESCE(started_at, created_at),
                applied_at = COALESCE(applied_at, created_at),
                failed_at = NULL,
                failed_statement_index = NULL,
                attempt_count = GREATEST(attempt_count, 1),
                last_error_code = NULL
          WHERE name = ?
            AND (checksum_sha256 IS NULL OR checksum_sha256 = ?)
            AND status IS NULL`,
        [migration.sha256, migration.name, migration.sha256],
      );
      requireOneAffectedRow(result, migration.name, "legacy-backfill-failed");
      continue;
    }
    if (row.status === "applied" && row.checksumSha256 === null) {
      const [result] = await connection.query(
        `UPDATE schema_migrations
            SET checksum_sha256 = ?
          WHERE name = ?
            AND checksum_sha256 IS NULL
            AND status = 'applied'`,
        [migration.sha256, migration.name],
      );
      requireOneAffectedRow(result, migration.name, "legacy-backfill-failed");
      continue;
    }
    throw new MigrationRunnerError("history-checksum-missing", `history checksum missing for ${migration.name}`, migration.name);
  }
}

async function backfillExecutionProvenance(
  connection: MigrationConnection,
  rows: MigrationHistoryRow[],
): Promise<void> {
  for (const row of rows) {
    if (row.executionMode !== null && row.executionSha256 !== null) continue;
    if (
      row.executionMode !== null ||
      row.executionSha256 !== null ||
      row.checksumSha256 === null ||
      row.status === null
    ) {
      throw new MigrationRunnerError(
        "execution-provenance-invalid",
        `execution provenance is invalid for ${row.name}`,
        row.name,
      );
    }
    const [result] = await connection.query(
      `UPDATE schema_migrations
          SET execution_mode = 'executed',
              execution_sha256 = ?
        WHERE name = ?
          AND checksum_sha256 = ?
          AND execution_mode IS NULL
          AND execution_sha256 IS NULL`,
      [row.checksumSha256, row.name, row.checksumSha256],
    );
    requireOneAffectedRow(result, row.name, "execution-provenance-backfill-failed");
  }
}

interface MigrationExecutionProvenance {
  mode: MigrationExecutionMode;
  sha256: string;
}

async function applyMigration(
  connection: MigrationConnection,
  migration: MigrationFile,
  resumeStatementIndex = 1,
  execution: MigrationExecutionProvenance = { mode: "executed", sha256: migration.sha256 },
): Promise<void> {
  const statements = splitSqlStatements(migration.sql);
  if (statements.length === 0) {
    throw new MigrationRunnerError("migration-empty", `released migration is empty: ${migration.name}`, migration.name);
  }

  await markRunning(connection, migration, execution);
  for (let index = resumeStatementIndex - 1; index < statements.length; index += 1) {
    try {
      await connection.query(statements[index]);
    } catch {
      await markFailed(connection, migration, index + 1, execution);
      throw new MigrationRunnerError(
        "statement-failed",
        `migration ${migration.name} failed at statement ${index + 1}`,
        migration.name,
      );
    }
  }
  await markApplied(connection, migration, execution);
}

async function markRunning(
  connection: MigrationConnection,
  migration: MigrationFile,
  execution: MigrationExecutionProvenance,
): Promise<void> {
  const [result] = await connection.query(
    `INSERT INTO schema_migrations
       (name, checksum_sha256, status, execution_mode, execution_sha256,
        started_at, applied_at, failed_at,
        failed_statement_index, attempt_count, last_error_code)
     VALUES (?, ?, 'running', ?, ?, CURRENT_TIMESTAMP, NULL, NULL, NULL, 1, NULL)
     ON DUPLICATE KEY UPDATE
       checksum_sha256 = VALUES(checksum_sha256),
       status = 'running',
       execution_mode = VALUES(execution_mode),
       execution_sha256 = VALUES(execution_sha256),
       started_at = CURRENT_TIMESTAMP,
       applied_at = NULL,
       failed_at = NULL,
       failed_statement_index = NULL,
       attempt_count = attempt_count + 1,
       last_error_code = NULL`,
    [migration.name, migration.sha256, execution.mode, execution.sha256],
  );
  requirePositiveAffectedRows(result, migration.name, "history-running-write-failed");
}

async function markApplied(
  connection: MigrationConnection,
  migration: MigrationFile,
  execution: MigrationExecutionProvenance,
): Promise<void> {
  const [result] = await connection.query(
    `UPDATE schema_migrations
        SET status = 'applied',
            checksum_sha256 = ?,
            applied_at = CURRENT_TIMESTAMP,
            failed_at = NULL,
            failed_statement_index = NULL,
            last_error_code = NULL
      WHERE name = ?
        AND checksum_sha256 = ?
        AND execution_mode = ?
        AND execution_sha256 = ?`,
    [
      migration.sha256,
      migration.name,
      migration.sha256,
      execution.mode,
      execution.sha256,
    ],
  );
  requireOneAffectedRow(result, migration.name, "history-applied-write-failed");
}

async function markFailed(
  connection: MigrationConnection,
  migration: MigrationFile,
  statementIndex: number,
  execution: MigrationExecutionProvenance,
): Promise<void> {
  const [result] = await connection.query(
    `UPDATE schema_migrations
        SET status = 'failed',
            failed_at = CURRENT_TIMESTAMP,
            failed_statement_index = ?,
            last_error_code = ?
      WHERE name = ?
        AND checksum_sha256 = ?
        AND execution_mode = ?
        AND execution_sha256 = ?`,
    [
      statementIndex,
      "statement-failed",
      migration.name,
      migration.sha256,
      execution.mode,
      execution.sha256,
    ],
  );
  requireOneAffectedRow(result, migration.name, "history-failed-write-failed");
}

async function markBaselineSuperseded(
  connection: MigrationConnection,
  migration: MigrationFile,
  baselineSha256: string,
): Promise<void> {
  const [result] = await connection.query(
    `INSERT INTO schema_migrations
       (name, checksum_sha256, status, execution_mode, execution_sha256,
        started_at, applied_at, failed_at, failed_statement_index,
        attempt_count, last_error_code)
     VALUES (?, ?, 'applied', 'baseline-superseded', ?,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 1, NULL)`,
    [migration.name, migration.sha256, baselineSha256],
  );
  requireOneAffectedRow(result, migration.name, "baseline-supersession-write-failed");
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

function safeName(value: unknown): string {
  const name = typeof value === "string" && MIGRATION_FILE.test(value) ? value : "invalid-migration-name";
  return name;
}

function requireOneAffectedRow(result: unknown, migration: string, code: string): void {
  const affectedRows = affectedRowCount(result);
  if (affectedRows !== 1) {
    throw new MigrationRunnerError(code, `migration history update failed for ${migration}`, migration);
  }
}

function requirePositiveAffectedRows(result: unknown, migration: string, code: string): void {
  if (affectedRowCount(result) < 1) {
    throw new MigrationRunnerError(code, `migration history update failed for ${migration}`, migration);
  }
}

function affectedRowCount(result: unknown): number {
  return typeof result === "object" && result !== null && "affectedRows" in result
    ? Number((result as { affectedRows: unknown }).affectedRows)
    : 0;
}

function sanitizedRunnerError(error: unknown): MigrationRunnerError {
  if (error instanceof MigrationRunnerError) return error;
  return new MigrationRunnerError("query-failed", "migration runner query failed");
}

function combineRunnerErrors(
  primary: MigrationRunnerError,
  cleanup: MigrationRunnerError,
): MigrationRunnerError {
  const codes = [...new Set([...primary.code.split("+"), ...cleanup.code.split("+")])];
  const code = codes.join("+");
  return new MigrationRunnerError(
    code,
    `migration runner failed: ${code}`,
    primary.migration ?? cleanup.migration,
  );
}
