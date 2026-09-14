import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  classifyMigration,
  createMigrationRunner,
  runMigrationsFromDirectory,
  splitSqlStatements,
  type MigrationFile,
  type MigrationHistoryRow,
} from "../src/db/migration-runner.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const sha256Bytes = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const bootstrapSql = "CREATE TABLE schema_migrations (id BIGINT);";
const migrationSql = "SELECT 'first'; SELECT 'second';";
const files: MigrationFile[] = [
  { name: "000_create_schema_migrations_v2.sql", sql: bootstrapSql, sha256: sha256(bootstrapSql) },
  { name: "001_example.sql", sql: migrationSql, sha256: sha256(migrationSql) },
];
const approvedReleasedChecksums = Object.fromEntries(files.map((file) => [file.name, file.sha256]));

const historyColumns = [
  ["id", "bigint unsigned", "NO", null, "auto_increment"],
  ["name", "varchar(255)", "NO", null, ""],
  ["checksum_sha256", "char(64)", "YES", null, ""],
  ["status", "varchar(16)", "YES", null, ""],
  ["execution_mode", "varchar(32)", "YES", null, ""],
  ["execution_sha256", "char(64)", "YES", null, ""],
  ["started_at", "datetime", "YES", null, ""],
  ["applied_at", "datetime", "YES", null, ""],
  ["failed_at", "datetime", "YES", null, ""],
  ["failed_statement_index", "int unsigned", "YES", null, ""],
  ["attempt_count", "int unsigned", "NO", "0", ""],
  ["last_error_code", "varchar(64)", "YES", null, ""],
  ["created_at", "datetime", "NO", "CURRENT_TIMESTAMP", ""],
  ["updated_at", "datetime", "NO", "CURRENT_TIMESTAMP", "on update CURRENT_TIMESTAMP"],
].map(([column_name, column_type, is_nullable, column_default, extra]) => ({
  column_name,
  column_type,
  is_nullable,
  column_default,
  extra,
}));

const historyIndexes = [
  ["PRIMARY", 0, 1, "id"],
  ["schema_migrations_name_idx", 0, 1, "name"],
  ["schema_migrations_checksum_idx", 1, 1, "checksum_sha256"],
  ["schema_migrations_status_idx", 1, 1, "status"],
].map(([index_name, non_unique, seq_in_index, column_name]) => ({
  index_name,
  non_unique,
  seq_in_index,
  column_name,
}));

const legacyHistoryColumns = historyColumns.filter((column) =>
  ["id", "name", "created_at"].includes(String(column.column_name))
);
const preProvenanceHistoryColumns = historyColumns.filter((column) =>
  !["execution_mode", "execution_sha256"].includes(String(column.column_name))
);

function appliedRow(file: MigrationFile): MigrationHistoryRow {
  return {
    name: file.name,
    checksumSha256: file.sha256,
    status: "applied",
    failedStatementIndex: null,
    attemptCount: 1,
    executionMode: "executed",
    executionSha256: file.sha256,
  };
}

class FakeConnection {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly rows = new Map<string, MigrationHistoryRow>();
  lockAcquired = true;
  historyReady = true;
  failSqlIncludes: string | null = null;
  failHistoryRead = false;
  failFailedHistoryWrite = false;
  failLockTimeoutRestore = false;
  releaseValue = 1;
  zeroAppliedUpdate = false;
  lockWaitTimeout = 47;
  historyColumnsOverride: Array<Record<string, unknown>> | null = null;
  historyIndexesOverride: Array<Record<string, unknown>> | null = null;

  constructor(initialRows: MigrationHistoryRow[] = [appliedRow(files[0])]) {
    for (const row of initialRows) this.rows.set(row.name, { ...row });
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.queries.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (/SELECT DATABASE\(\)/i.test(normalized)) return [[{ database_name: "spx_test" }], []];
    if (/SELECT @@SESSION\.lock_wait_timeout/i.test(normalized)) {
      return [[{ lock_wait_timeout: this.lockWaitTimeout }], []];
    }
    if (/SET SESSION lock_wait_timeout = \?/i.test(normalized)) {
      const nextValue = Number(params[0]);
      if (this.failLockTimeoutRestore && nextValue === 47) {
        throw new Error("raw timeout restore password=secret host=private");
      }
      this.lockWaitTimeout = nextValue;
      return [{ affectedRows: 0 }, []];
    }
    if (/SELECT GET_LOCK/i.test(normalized)) return [[{ acquired: this.lockAcquired ? 1 : 0 }], []];
    if (/SELECT RELEASE_LOCK/i.test(normalized)) return [[{ released: this.releaseValue }], []];
    if (/FROM information_schema\.columns/i.test(normalized)) {
      return [this.historyReady ? (this.historyColumnsOverride ?? historyColumns) : [], []];
    }
    if (/FROM information_schema\.statistics/i.test(normalized)) {
      return [this.historyReady ? (this.historyIndexesOverride ?? historyIndexes) : [], []];
    }
    if (/^SELECT name, checksum_sha256/i.test(normalized)) {
      if (this.failHistoryRead) throw new Error("raw history error password=secret host=private");
      return [[...this.rows.values()].map((row) => ({
        name: row.name,
        checksum_sha256: row.checksumSha256,
        status: row.status,
        execution_mode: row.executionMode,
        execution_sha256: row.executionSha256,
        failed_statement_index: row.failedStatementIndex,
        attempt_count: row.attemptCount,
      })), []];
    }
    if (/UPDATE schema_migrations SET checksum_sha256/i.test(normalized)) {
      const [checksum, name] = params as [string, string];
      const row = this.rows.get(name);
      assert.ok(row, `expected legacy history row ${name}`);
      const checksumOnly = /SET checksum_sha256 = \? WHERE/i.test(normalized);
      if (checksumOnly && row.status === "applied" && row.checksumSha256 === null) {
        this.rows.set(name, { ...row, checksumSha256: checksum });
        return [{ affectedRows: 1 }, []];
      }
      if (row.status !== null) return [{ affectedRows: 0 }, []];
      this.rows.set(name, { ...row, checksumSha256: checksum, status: "applied", attemptCount: Math.max(1, row.attemptCount) });
      return [{ affectedRows: 1 }, []];
    }
    if (/INSERT INTO schema_migrations/i.test(normalized)) {
      const [name, checksum, rawMode, rawExecutionSha256] = params as [string, string, string, string];
      const superseded = /baseline-superseded/i.test(normalized);
      const executionMode = superseded ? "baseline-superseded" : rawMode;
      const executionSha256 = superseded ? rawMode : rawExecutionSha256;
      const existing = this.rows.get(name);
      this.rows.set(name, {
        name,
        checksumSha256: checksum,
        status: superseded ? "applied" : "running",
        failedStatementIndex: null,
        attemptCount: (existing?.attemptCount ?? 0) + 1,
        executionMode,
        executionSha256,
      });
      return [{ affectedRows: 1 }, []];
    }
    if (/UPDATE schema_migrations SET status = 'applied'/i.test(normalized)) {
      const [checksum, name] = params as [string, string];
      const row = this.rows.get(name);
      assert.ok(row, `expected running history row ${name}`);
      if (this.zeroAppliedUpdate) return [{ affectedRows: 0 }, []];
      this.rows.set(name, { ...row, checksumSha256: checksum, status: "applied", failedStatementIndex: null });
      return [{ affectedRows: 1 }, []];
    }
    if (/UPDATE schema_migrations SET status = 'failed'/i.test(normalized)) {
      if (this.failFailedHistoryWrite) throw new Error("raw history write password=secret host=private");
      const [statementIndex, errorCode, name, checksum] = params as [number, string, string, string];
      const row = this.rows.get(name);
      assert.ok(row, `expected running history row ${name}`);
      assert.equal(errorCode, "statement-failed");
      this.rows.set(name, { ...row, checksumSha256: checksum, status: "failed", failedStatementIndex: statementIndex });
      return [{ affectedRows: 1 }, []];
    }
    if (/UPDATE schema_migrations SET execution_mode = 'executed'/i.test(normalized)) {
      const [executionSha256, name] = params as [string, string];
      const row = this.rows.get(name);
      assert.ok(row, `expected history row ${name}`);
      this.rows.set(name, {
        ...row,
        executionMode: "executed",
        executionSha256,
      });
      return [{ affectedRows: 1 }, []];
    }

    if (this.failSqlIncludes && sql.includes(this.failSqlIncludes)) {
      throw new Error("raw DB failure password=secret db=spx_test host=private");
    }
    if (/SET SESSION lock_wait_timeout = 5/i.test(normalized)) this.lockWaitTimeout = 5;
    if (/CREATE TABLE schema_migrations/i.test(normalized)) {
      this.historyReady = true;
      this.historyColumnsOverride = null;
      this.historyIndexesOverride = null;
    }
    return [{ affectedRows: 0 }, []];
  }
}

async function withMigrationDirectory(
  configure: (directory: string) => void,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "spx-migrations-"));
  try {
    for (const file of files) writeFileSync(join(directory, file.name), file.sql);
    writeFileSync(join(directory, "released-checksums.json"), JSON.stringify(approvedReleasedChecksums));
    configure(directory);
    await run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
{
  await assert.rejects(
    () => runMigrationsFromDirectory({
      connection: new FakeConnection(),
      directory: resolve(process.cwd(), "__missing_private_migration_directory__"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /released migration manifest is unreadable/);
      assert.doesNotMatch(error.message, /missing_private|Users|Desktop/i);
      return true;
    },
  );
}

{
  await withMigrationDirectory(
    (directory) => {
      rmSync(join(directory, "released-checksums.json"));
      mkdirSync(join(directory, "released-checksums.json"));
    },
    async (directory) => {
      await assert.rejects(
        () => runMigrationsFromDirectory({ connection: new FakeConnection(), directory }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /released migration manifest is unsafe/);
          assert.doesNotMatch(error.message, /spx-migrations|Users|password|secret/i);
          return true;
        },
      );
    },
  );
}

{
  const base = mkdtempSync(join(tmpdir(), "spx-migration-root-"));
  const target = join(base, "target");
  const linkedRoot = join(base, "linked-root");
  try {
    mkdirSync(target);
    for (const file of files) writeFileSync(join(target, file.name), file.sql);
    writeFileSync(join(target, "released-checksums.json"), JSON.stringify(approvedReleasedChecksums));
    symlinkSync(target, linkedRoot, "junction");
    await assert.rejects(
      () => runMigrationsFromDirectory({ connection: new FakeConnection(), directory: linkedRoot }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /released migration directory is unsafe/);
        assert.doesNotMatch(error.message, /spx-migration-root|Users|password|secret/i);
        return true;
      },
    );
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
}

{
  let symlinkSupported = true;
  await withMigrationDirectory(
    (directory) => {
      rmSync(join(directory, "released-checksums.json"));
      writeFileSync(join(directory, "manifest-target.json"), JSON.stringify(approvedReleasedChecksums));
      try {
        symlinkSync("manifest-target.json", join(directory, "released-checksums.json"), "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        symlinkSupported = false;
      }
    },
    async (directory) => {
      if (!symlinkSupported) return;
      await assert.rejects(
        () => runMigrationsFromDirectory({ connection: new FakeConnection(), directory }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /released migration manifest is unsafe/);
          assert.doesNotMatch(error.message, /spx-migrations|Users|password|secret/i);
          return true;
        },
      );
    },
  );
}

{
  await withMigrationDirectory(
    (directory) => {
      rmSync(join(directory, files[1].name));
      mkdirSync(join(directory, files[1].name));
    },
    async (directory) => {
      await assert.rejects(
        () => runMigrationsFromDirectory({ connection: new FakeConnection(), directory }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /released migration file is unsafe.*001_example\.sql/);
          assert.doesNotMatch(error.message, /spx-migrations|Users|password|secret/i);
          return true;
        },
      );
    },
  );
}

{
  const invalidUtf8Cases = [
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
  ];
  for (const rawSql of invalidUtf8Cases) {
    await withMigrationDirectory(
      (directory) => {
        writeFileSync(join(directory, files[1].name), rawSql);
        const lossyDecodedChecksum = sha256(rawSql.toString("utf8"));
        assert.notEqual(
          sha256Bytes(rawSql),
          lossyDecodedChecksum,
          "the fixture must distinguish exact bytes from replacement-character decoding",
        );
        writeFileSync(
          join(directory, "released-checksums.json"),
          JSON.stringify({
            ...approvedReleasedChecksums,
            [files[1].name]: lossyDecodedChecksum,
          }),
        );
      },
      async (directory) => {
        const connection = new FakeConnection();
        await assert.rejects(
          () => runMigrationsFromDirectory({ connection, directory }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal("code" in error ? error.code : null, "migration-encoding-invalid");
            assert.match(error.message, /released migration encoding is invalid.*001_example\.sql/);
            assert.doesNotMatch(error.message, /spx-migrations|Users|Desktop|replacement|0xff|0xc0|0xed|\ufffd/i);
            return true;
          },
        );
        assert.deepEqual(connection.queries, [], "invalid bytes must fail before database access");
      },
    );
  }
}

{
  const connection = new FakeConnection();
  connection.lockAcquired = false;
  const runner = createMigrationRunner({ connection, files, approvedReleasedChecksums });
  await assert.rejects(() => runner.run(), /migration lock unavailable/);
  assert.equal(connection.queries.some((query) => /schema_migrations/i.test(query.sql)), false);
}

{
  const connection = new FakeConnection();
  const runner = createMigrationRunner({ connection, files, approvedReleasedChecksums });
  await assert.rejects(
    () => runner.verifyApplied([{ ...appliedRow(files[1]), checksumSha256: "changed" }]),
    /checksum mismatch.*001_example\.sql/,
  );
}

{
  const connection = new FakeConnection([
    appliedRow(files[0]),
    {
      name: files[1].name,
      checksumSha256: null,
      status: null,
      failedStatementIndex: null,
      attemptCount: 0,
      executionMode: null,
      executionSha256: null,
    },
  ]);
  connection.historyColumnsOverride = preProvenanceHistoryColumns;
  const result = await createMigrationRunner({ connection, files, approvedReleasedChecksums }).run();
  assert.deepEqual(result, {
    applied: [files[0].name],
    skipped: [files[1].name],
    superseded: [],
  });
  assert.deepEqual(connection.rows.get(files[1].name), appliedRow(files[1]));
}

{
  const connection = new FakeConnection([
    appliedRow(files[0]),
    {
      name: files[1].name,
      checksumSha256: null,
      status: "applied",
      failedStatementIndex: null,
      attemptCount: 1,
      executionMode: null,
      executionSha256: null,
    },
  ]);
  connection.historyColumnsOverride = preProvenanceHistoryColumns;
  await createMigrationRunner({ connection, files, approvedReleasedChecksums }).run();
  assert.equal(connection.rows.get(files[1].name)?.checksumSha256, files[1].sha256);
}

{
  const connection = new FakeConnection();
  const result = await createMigrationRunner({ connection, files, approvedReleasedChecksums }).run();
  assert.deepEqual(result, { applied: [files[1].name], skipped: [files[0].name], superseded: [] });
  assert.equal(connection.rows.get(files[1].name)?.status, "applied");
  const acquireIndex = connection.queries.findIndex((query) => /GET_LOCK/i.test(query.sql));
  const historyIndex = connection.queries.findIndex((query) => /^\s*SELECT name, checksum_sha256/i.test(query.sql));
  const releaseIndex = connection.queries.findIndex((query) => /RELEASE_LOCK/i.test(query.sql));
  assert.ok(acquireIndex >= 0 && historyIndex > acquireIndex && releaseIndex > historyIndex, "lock must enclose history access");
  const lockValue = connection.queries[acquireIndex].params[0];
  assert.equal(typeof lockValue, "string");
  assert.doesNotMatch(String(lockValue), /spx_test/, "advisory lock must hash the database scope");
}

{
  const connection = new FakeConnection();
  await createMigrationRunner({ connection, files, approvedReleasedChecksums }).run();
  const columnsQuery = connection.queries.find((query) => /FROM information_schema\.columns/i.test(query.sql));
  const indexesQuery = connection.queries.find((query) => /FROM information_schema\.statistics/i.test(query.sql));
  assert.ok(columnsQuery, "history inspection must query INFORMATION_SCHEMA columns");
  assert.ok(indexesQuery, "history inspection must query INFORMATION_SCHEMA indexes");
  assert.match(columnsQuery.sql, /COLUMN_NAME\s+AS\s+column_name/i);
  assert.match(columnsQuery.sql, /COLUMN_TYPE\s+AS\s+column_type/i);
  assert.match(columnsQuery.sql, /IS_NULLABLE\s+AS\s+is_nullable/i);
  assert.match(columnsQuery.sql, /COLUMN_DEFAULT\s+AS\s+column_default/i);
  assert.match(columnsQuery.sql, /EXTRA\s+AS\s+extra/i);
  assert.match(indexesQuery.sql, /INDEX_NAME\s+AS\s+index_name/i);
  assert.match(indexesQuery.sql, /NON_UNIQUE\s+AS\s+non_unique/i);
  assert.match(indexesQuery.sql, /SEQ_IN_INDEX\s+AS\s+seq_in_index/i);
  assert.match(indexesQuery.sql, /COLUMN_NAME\s+AS\s+column_name/i);
}

{
  const connection = new FakeConnection();
  connection.historyColumnsOverride = [
    ...historyColumns,
    {
      column_name: "unapproved_payload",
      column_type: "text",
      is_nullable: "YES",
      column_default: null,
      extra: "",
    },
  ];
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    /unsupported migration history shape/,
  );
  assert.equal(
    connection.queries.some((query) => /(?:CREATE|ALTER) TABLE|PREPARE |EXECUTE /i.test(query.sql)),
    false,
    "unsupported history must be rejected before bootstrap DDL",
  );
}

{
  const connection = new FakeConnection();
  connection.historyColumnsOverride = legacyHistoryColumns;
  connection.historyIndexesOverride = historyIndexes.slice(0, 2);
  const result = await createMigrationRunner({ connection, files, approvedReleasedChecksums }).run();
  assert.deepEqual(result, { applied: files.map((file) => file.name), skipped: [], superseded: [] });
}

{
  const connection = new FakeConnection();
  connection.historyColumnsOverride = [...legacyHistoryColumns, historyColumns[2]];
  connection.historyIndexesOverride = historyIndexes.slice(0, 2);
  const result = await createMigrationRunner({ connection, files, approvedReleasedChecksums }).run();
  assert.deepEqual(result, { applied: files.map((file) => file.name), skipped: [], superseded: [] });
}

{
  const connection = new FakeConnection();
  connection.failHistoryRead = true;
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /migration runner query failed/);
      assert.doesNotMatch(error.message, /password|secret|private|spx_test/i);
      return true;
    },
  );
}

{
  const connection = new FakeConnection();
  connection.releaseValue = 0;
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    /migration lock release failed/,
  );
}

{
  const connection = new FakeConnection();
  connection.zeroAppliedUpdate = true;
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    /migration history update failed.*001_example\.sql/,
  );
}

{
  const connection = new FakeConnection();
  connection.failSqlIncludes = "SELECT 'second'";
  connection.failFailedHistoryWrite = true;
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /migration runner query failed/);
      assert.doesNotMatch(error.message, /password|secret|private|spx_test/i);
      return true;
    },
  );
}

{
  const connection = new FakeConnection();
  connection.historyReady = false;
  const result = await createMigrationRunner({ connection, files, approvedReleasedChecksums }).run();
  assert.deepEqual(result, { applied: files.map((file) => file.name), skipped: [], superseded: [] });
  assert.equal(connection.rows.get(files[0].name)?.status, "applied");
  assert.ok(connection.queries.some((query) => /CREATE TABLE schema_migrations/i.test(query.sql)));
}

{
  const freshBaselineSql = "SELECT 'fresh baseline';";
  const supersededSql = (sequence: string): string => `SELECT 'must-not-execute-${sequence}';`;
  const supplementSql = "SELECT 'fresh baseline supplement';";
  const baselineFiles: MigrationFile[] = [
    { name: "000_create_schema_migrations_v2.sql", sql: bootstrapSql, sha256: sha256(bootstrapSql) },
    {
      name: "001_create_booking_requests.sql",
      sql: freshBaselineSql,
      sha256: sha256(freshBaselineSql),
    },
    ...[
      ["018", "018_multi_team_runtime.sql"],
      ["019", "019_notify_rules_accept_all.sql"],
      ["020", "020_auto_accept_history_diagnostics.sql"],
    ].map(([sequence, name]) => {
      const sql = supersededSql(sequence);
      return {
        name,
        sql,
        sha256: sha256(sql),
      };
    }),
    {
      name: "034_complete_fresh_baseline.sql",
      sql: supplementSql,
      sha256: sha256(supplementSql),
    },
  ];
  const baselineChecksums = Object.fromEntries(
    baselineFiles.map((file) => [file.name, file.sha256]),
  );
  const connection = new FakeConnection([]);
  connection.historyReady = false;

  const first = await createMigrationRunner({
    connection,
    files: baselineFiles,
    approvedReleasedChecksums: baselineChecksums,
  }).run();
  assert.deepEqual(first, {
    applied: [
      "000_create_schema_migrations_v2.sql",
      "001_create_booking_requests.sql",
      "034_complete_fresh_baseline.sql",
    ],
    skipped: [],
    superseded: [
      "018_multi_team_runtime.sql",
      "019_notify_rules_accept_all.sql",
      "020_auto_accept_history_diagnostics.sql",
    ],
  });
  for (const sequence of ["018", "019", "020"]) {
    assert.equal(
      connection.queries.some((query) => query.sql.includes(`must-not-execute-${sequence}`)),
      false,
      `fresh baseline must not execute ${sequence}`,
    );
  }
  assert.equal(
    connection.rows.get("001_create_booking_requests.sql")?.executionMode,
    "fresh-baseline",
  );
  assert.equal(
    connection.rows.get("001_create_booking_requests.sql")?.executionSha256,
    baselineFiles[1].sha256,
  );
  for (const name of [
    "018_multi_team_runtime.sql",
    "019_notify_rules_accept_all.sql",
    "020_auto_accept_history_diagnostics.sql",
  ]) {
    assert.equal(connection.rows.get(name)?.executionMode, "baseline-superseded");
    assert.equal(connection.rows.get(name)?.executionSha256, baselineFiles[1].sha256);
  }

  const second = await createMigrationRunner({
    connection,
    files: baselineFiles,
    approvedReleasedChecksums: baselineChecksums,
  }).run();
  assert.deepEqual(second, {
    applied: [],
    skipped: [
      "000_create_schema_migrations_v2.sql",
      "001_create_booking_requests.sql",
      "034_complete_fresh_baseline.sql",
    ],
    superseded: [
      "018_multi_team_runtime.sql",
      "019_notify_rules_accept_all.sql",
      "020_auto_accept_history_diagnostics.sql",
    ],
  });

  const upgradedConnection = new FakeConnection([appliedRow(baselineFiles[0])]);
  const upgraded = await createMigrationRunner({
    connection: upgradedConnection,
    files: baselineFiles,
    approvedReleasedChecksums: baselineChecksums,
  }).run();
  assert.deepEqual(upgraded, {
    applied: baselineFiles.slice(1).map((file) => file.name),
    skipped: ["000_create_schema_migrations_v2.sql"],
    superseded: [],
  });
  for (const sequence of ["018", "019", "020"]) {
    assert.equal(
      upgradedConnection.queries.some((query) => query.sql.includes(`must-not-execute-${sequence}`)),
      true,
      `non-empty history must execute ${sequence}`,
    );
  }

  const tampered = connection.rows.get("018_multi_team_runtime.sql");
  assert.ok(tampered);
  connection.rows.set("018_multi_team_runtime.sql", {
    ...tampered,
    executionSha256: "f".repeat(64),
  });
  await assert.rejects(
    () => createMigrationRunner({
      connection,
      files: baselineFiles,
      approvedReleasedChecksums: baselineChecksums,
    }).run(),
    /execution provenance is invalid.*018_multi_team_runtime\.sql/,
  );

  const incompleteConnection = new FakeConnection([]);
  incompleteConnection.historyReady = false;
  const incompleteFiles = baselineFiles.filter(
    (file) => file.name !== "034_complete_fresh_baseline.sql",
  );
  await assert.rejects(
    () => createMigrationRunner({
      connection: incompleteConnection,
      files: incompleteFiles,
      approvedReleasedChecksums: Object.fromEntries(
        incompleteFiles.map((file) => [file.name, file.sha256]),
      ),
    }).run(),
    /fresh baseline migration contract is incomplete/,
  );
}

{
  const connection = new FakeConnection();
  const row = connection.rows.get(files[0].name);
  assert.ok(row);
  connection.rows.set(files[0].name, {
    ...row,
    executionMode: null,
    executionSha256: null,
  });
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    /execution provenance is missing.*000_create_schema_migrations_v2\.sql/,
  );
}

{
  const connection = new FakeConnection();
  connection.historyReady = false;
  connection.failSqlIncludes = "CREATE TABLE schema_migrations";
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    /000_create_schema_migrations_v2\.sql.*statement/,
  );
  assert.equal(connection.lockWaitTimeout, 47, "runner must restore lock_wait_timeout after bootstrap failure");
  assert.ok(
    connection.queries.some((query) => /SET SESSION lock_wait_timeout = \?/i.test(query.sql) && query.params[0] === 47),
    "runner-level timeout restoration must not depend on the final bootstrap statement",
  );
}

{
  const connection = new FakeConnection();
  connection.historyReady = false;
  connection.failSqlIncludes = "CREATE TABLE schema_migrations";
  connection.failLockTimeoutRestore = true;
  connection.releaseValue = 0;
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const code = "code" in error ? String(error.code) : "";
      assert.match(code, /bootstrap-statement-failed/);
      assert.match(code, /lock-wait-timeout-restore-failed/);
      assert.match(code, /lock-release-failed/);
      assert.doesNotMatch(error.message, /password|secret|private|spx_test/i);
      return true;
    },
  );
}

{
  const connection = new FakeConnection();
  connection.historyColumnsOverride = historyColumns.map((column) => column.column_name === "attempt_count"
    ? { ...column, column_default: "7" }
    : column);
  await assert.rejects(
    () => createMigrationRunner({ connection, files, approvedReleasedChecksums }).run(),
    /unsupported migration history shape/,
  );
  assert.equal(
    connection.queries.some((query) => /(?:CREATE|ALTER) TABLE|PREPARE |EXECUTE /i.test(query.sql)),
    false,
  );
}

{
  const connection = new FakeConnection();
  connection.failSqlIncludes = "SELECT 'second'";
  const runner = createMigrationRunner({ connection, files, approvedReleasedChecksums });
  await assert.rejects(
    () => runner.run(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /001_example\.sql.*statement 2/);
      assert.doesNotMatch(error.message, /password|secret|private|spx_test/i);
      return true;
    },
  );
  assert.equal(connection.rows.get(files[1].name)?.status, "failed");
  assert.equal(connection.rows.get(files[1].name)?.failedStatementIndex, 2);
  assert.ok(connection.queries.some((query) => /RELEASE_LOCK/i.test(query.sql)), "lock must be released after failure");
  assert.deepEqual(await runner.classifyFailure({ statementIndex: 2, statementCount: 2, retrySafe: false }), {
    status: "blocked",
    reason: "partial-ddl-manual-recovery-required",
  });
  assert.deepEqual(await runner.classifyFailure({ statementIndex: 2, statementCount: 2, retrySafe: true }), {
    status: "retryable",
    reason: "mysql8-atomic-statement-resume-approved",
    resumeStatementIndex: 2,
  });
}

{
  const failed = { ...appliedRow(files[1]), status: "failed" as const, failedStatementIndex: 2 };
  const blockedConnection = new FakeConnection([appliedRow(files[0]), failed]);
  await assert.rejects(
    () => createMigrationRunner({ connection: blockedConnection, files, approvedReleasedChecksums }).run(),
    /unsafe migration retry blocked.*001_example\.sql/,
  );

  const allowedConnection = new FakeConnection([appliedRow(files[0]), failed]);
  const result = await createMigrationRunner({
    connection: allowedConnection,
    files,
    approvedReleasedChecksums,
    allowRetry: new Set([files[1].name]),
  }).run();
  assert.deepEqual(result.applied, [files[1].name]);
  assert.equal(allowedConnection.rows.get(files[1].name)?.attemptCount, 2);
  assert.equal(
    allowedConnection.queries.some((query) => query.sql.includes("SELECT 'first'")),
    false,
    "retry must not replay statements recorded as already successful",
  );
  assert.equal(
    allowedConnection.queries.filter((query) => query.sql.includes("SELECT 'second'")).length,
    1,
    "retry must resume exactly at the recorded failed statement",
  );
}

{
  for (const failedStatementIndex of [0, 3, Number.NaN]) {
    const failed = {
      ...appliedRow(files[1]),
      status: "failed" as const,
      failedStatementIndex,
    };
    const connection = new FakeConnection([appliedRow(files[0]), failed]);
    await assert.rejects(
      () => createMigrationRunner({
        connection,
        files,
        approvedReleasedChecksums,
        allowRetry: new Set([files[1].name]),
      }).run(),
      /failed statement index is invalid.*001_example\.sql/,
    );
    assert.equal(
      connection.queries.some((query) => query.sql.includes("SELECT 'first'") || query.sql.includes("SELECT 'second'")),
      false,
    );
  }
}

{
  for (const attemptCount of [0, Number.NaN]) {
    const failed = {
      ...appliedRow(files[1]),
      status: "failed" as const,
      failedStatementIndex: 2,
      attemptCount,
    };
    const connection = new FakeConnection([appliedRow(files[0]), failed]);
    await assert.rejects(
      () => createMigrationRunner({
        connection,
        files,
        approvedReleasedChecksums,
        allowRetry: new Set([files[1].name]),
      }).run(),
      /failed migration history state is invalid.*001_example\.sql/,
    );
    assert.equal(
      connection.queries.some((query) => query.sql.includes("SELECT 'first'") || query.sql.includes("SELECT 'second'")),
      false,
    );
  }
}

assert.equal(classifyMigration("000_create_schema_migrations_v2.sql"), "control-plane-bootstrap");
assert.equal(classifyMigration("031_create_realtime_metrics_read_models.sql"), "schema");

const frozenBootstrapSql = readFileSync(resolve(process.cwd(), "migrations/000_create_schema_migrations_v2.sql"), "utf8");
const bootstrapStatements = splitSqlStatements(frozenBootstrapSql);
assert.ok(bootstrapStatements.length > 10, "bootstrap must expose each bounded schema statement to failure indexing");
assert.ok(
  bootstrapStatements.some((statement) => statement.includes("ADD COLUMN checksum_sha256")),
  "quoted bootstrap DDL must remain inside one prepared-statement assignment",
);
assert.match(frozenBootstrapSql, /execution_mode VARCHAR\(32\) NULL/);
assert.match(frozenBootstrapSql, /execution_sha256 CHAR\(64\) NULL/);

const freshBaselineSupplementPath = resolve(
  process.cwd(),
  "migrations/034_complete_fresh_baseline.sql",
);
assert.ok(
  existsSync(freshBaselineSupplementPath),
  "fresh baseline supersession requires append-only migration 034",
);
const freshBaselineSupplementSql = readFileSync(freshBaselineSupplementPath, "utf8");
for (const requiredEffect of [
  "INSERT INTO teams",
  "ADD COLUMN team_id INT NULL AFTER role",
  "users_team_id_idx",
  "notify_rules_team_id_idx",
  "spx_booking_history_team_request_uidx",
  "spx_booking_history_team_created_idx",
  "aah_team_created_at_idx",
  "aah_team_status_created_at_idx",
  "metrics_team_created_at_idx",
  "ADD COLUMN actor_user_id INT NULL AFTER team_id",
  "ADD COLUMN actor_team_id INT NULL AFTER actor_user_id",
  "ADD COLUMN target_team_id INT NULL AFTER actor_team_id",
  "audit_target_team_created_at_idx",
  "ADD COLUMN accept_all INT NOT NULL DEFAULT 0 AFTER auto_accept",
  "ADD COLUMN failure_reason VARCHAR(64) NULL AFTER error_message",
  "ADD COLUMN trace_id VARCHAR(160) NULL AFTER failure_reason",
  "ADD COLUMN accept_rtt_ms INT NULL AFTER trace_id",
  "ADD COLUMN list_age_ms INT NULL AFTER accept_rtt_ms",
  "ADD COLUMN verification_latency_ms INT NULL AFTER list_age_ms",
  "ADD COLUMN verification_status VARCHAR(32) NULL AFTER verification_latency_ms",
  "ADD COLUMN verified_at DATETIME NULL AFTER verification_status",
  "aah_team_reason_created_at_idx",
  "aah_trace_id_idx",
]) {
  assert.ok(
    freshBaselineSupplementSql.includes(requiredEffect),
    `fresh baseline supplement must restore: ${requiredEffect}`,
  );
}
assert.doesNotMatch(
  freshBaselineSupplementSql,
  /^\s*ALTER TABLE/mi,
  "supplement ALTER statements must be guarded through prepared no-op branches",
);

const runnerSource = readFileSync(resolve(process.cwd(), "src/db/migration-runner.ts"), "utf8");
const cliSource = readFileSync(resolve(process.cwd(), "src/scripts/db-migrate.ts"), "utf8");
assert.doesNotMatch(runnerSource, /\b(?:CREATE|ALTER)\s+TABLE\b/i, "runner must not synthesize history DDL");
assert.doesNotMatch(runnerSource, /ensureMigrationHistoryV2/i, "runner must execute the frozen bootstrap migration");
assert.match(cliSource, /runMigrationsFromDirectory/, "CLI must delegate migration behavior to the locked runner");
assert.doesNotMatch(cliSource, /\b(?:CREATE|ALTER)\s+TABLE\b/i, "CLI must not contain migration DDL");

console.log("migration-runner: lock, checksums, failure state, retry guard, and redaction verified");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "migration runner test failed");
  process.exit(1);
});
