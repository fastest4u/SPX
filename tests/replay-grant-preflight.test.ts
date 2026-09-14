import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type FakeOptions = {
  beginError?: unknown;
  deleteError?: unknown;
  insertError?: unknown;
  releaseError?: unknown;
  rollbackError?: unknown;
  selectError?: unknown;
  updateError?: unknown;
};

class FakeConnection {
  readonly calls: string[] = [];
  readonly params: unknown[][] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  async beginTransaction(): Promise<void> {
    this.calls.push("begin");
    if (this.options.beginError) throw this.options.beginError;
  }

  async execute(sql: string, params: unknown[]): Promise<[unknown[], unknown]> {
    const operation = sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
    this.calls.push(operation.toLowerCase());
    this.params.push(params);
    const error = this.options[`${operation.toLowerCase()}Error` as keyof FakeOptions];
    if (error) throw error;
    return [[], {}];
  }

  async rollback(): Promise<void> {
    this.calls.push("rollback");
    if (this.options.rollbackError) throw this.options.rollbackError;
  }

  release(): void {
    this.calls.push("release");
    if (this.options.releaseError) throw this.options.releaseError;
  }
}

const root = process.cwd();
const scriptPath = resolve(root, "scripts/internal-replay-grant-preflight.mjs");
const fingerprint = "ab".repeat(32);
const sensitive = "sensitive-host-user-password-query-error";

function accessDenied(): Error & { code: string; errno: number } {
  return Object.assign(new Error(sensitive), {
    code: "ER_TABLEACCESS_DENIED_ERROR",
    errno: 1142,
  });
}

function assertClosed(connection: FakeConnection): void {
  assert.equal(connection.calls.filter((call) => call === "rollback").length, 1);
  assert.equal(connection.calls.filter((call) => call === "release").length, 1);
}

async function main(): Promise<void> {
  const { runInternalReplayGrantPreflight } = await import(
    "../scripts/internal-replay-grant-preflight.mjs"
  ) as {
    runInternalReplayGrantPreflight: (
      connection: FakeConnection,
      options: { fingerprint: string; now: Date },
    ) => Promise<{ ok: boolean; failureCodes: string[] }>;
  };

  const allowed = new FakeConnection({ updateError: accessDenied() });
  assert.deepEqual(await runInternalReplayGrantPreflight(allowed, {
    fingerprint,
    now: new Date("2026-07-11T00:00:00.000Z"),
  }), { ok: true, failureCodes: [] });
  assert.deepEqual(allowed.calls, ["begin", "select", "insert", "update", "delete", "rollback", "release"]);
  assertClosed(allowed);
  assert.equal(allowed.params.every((params) => params.includes(fingerprint)), true);

  const excessive = new FakeConnection();
  assert.deepEqual(await runInternalReplayGrantPreflight(excessive, {
    fingerprint,
    now: new Date("2026-07-11T00:00:00.000Z"),
  }), { ok: false, failureCodes: ["excessive_privilege"] });
  assertClosed(excessive);

  for (const [operation, expected] of [
    ["select", "select_failed"],
    ["insert", "insert_failed"],
    ["delete", "delete_failed"],
  ] as const) {
    const connection = new FakeConnection({ [`${operation}Error`]: new Error(sensitive) });
    const result = await runInternalReplayGrantPreflight(connection, {
      fingerprint,
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureCodes.includes(expected), true);
    assert.equal(JSON.stringify(result).includes(sensitive), false);
    assertClosed(connection);
  }

  const unexpectedUpdate = new FakeConnection({ updateError: new Error(sensitive) });
  assert.deepEqual(await runInternalReplayGrantPreflight(unexpectedUpdate, {
    fingerprint,
    now: new Date("2026-07-11T00:00:00.000Z"),
  }), { ok: false, failureCodes: ["update_check_failed"] });
  assertClosed(unexpectedUpdate);

  const beginFailed = new FakeConnection({ beginError: new Error(sensitive) });
  assert.deepEqual(await runInternalReplayGrantPreflight(beginFailed, {
    fingerprint,
    now: new Date("2026-07-11T00:00:00.000Z"),
  }), { ok: false, failureCodes: ["transaction_failed"] });
  assertClosed(beginFailed);

  const cleanupFailed = new FakeConnection({
    updateError: accessDenied(),
    rollbackError: new Error(sensitive),
    releaseError: new Error(sensitive),
  });
  assert.deepEqual(await runInternalReplayGrantPreflight(cleanupFailed, {
    fingerprint,
    now: new Date("2026-07-11T00:00:00.000Z"),
  }), {
    ok: false,
    failureCodes: ["rollback_failed", "release_failed"],
  });
  assertClosed(cleanupFailed);

  const safeEnv = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    NODE_ENV: "test",
    DB_MODE: "mysql",
    DB_HOST: sensitive,
    DB_PORT: "3306",
    DB_USERNAME: `${sensitive}-user`,
    DB_PASSWORD: `${sensitive}-password`,
    DB_NAME: `${sensitive}-database`,
    DB_SSL_MODE: "disabled",
  };
  const dryRun = spawnSync(process.execPath, [scriptPath, "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: safeEnv,
  });
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.deepEqual(JSON.parse(dryRun.stdout), {
    ok: true,
    mode: "dry-run",
    failureCodes: [],
  });
  assert.equal(`${dryRun.stdout}\n${dryRun.stderr}`.includes(sensitive), false);

  const invalid = spawnSync(process.execPath, [scriptPath, "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", NODE_ENV: "production" },
  });
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout), {
    ok: false,
    mode: "dry-run",
    failureCodes: ["database_config_invalid"],
  });
  assert.equal(`${invalid.stdout}\n${invalid.stderr}`.includes(sensitive), false);

  const externalRoot = mkdtempSync(join(tmpdir(), "spx-replay-preflight-external-"));
  try {
    const externalScripts = join(externalRoot, "scripts");
    mkdirSync(join(externalScripts, "lib"), { recursive: true });
    const externalScript = join(externalScripts, "internal-replay-grant-preflight.mjs");
    copyFileSync(scriptPath, externalScript);
    copyFileSync(
      resolve(root, "scripts/lib/mysql-connection-config.mjs"),
      join(externalScripts, "lib/mysql-connection-config.mjs"),
    );
    for (const dependency of ["file-backed-secret.mjs", "safe-file.mjs"]) {
      copyFileSync(
        resolve(root, "scripts/lib", dependency),
        join(externalScripts, "lib", dependency),
      );
    }
    const externalModule = await import(`${pathToFileURL(externalScript).href}?test=${Date.now()}`) as {
      loadMysqlPromiseClient: (moduleRoot?: string) => { createConnection?: unknown };
    };
    const mysql = externalModule.loadMysqlPromiseClient();
    assert.equal(typeof mysql.createConnection, "function");
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }

  const dockerfile = readFileSync(resolve(root, "Dockerfile.a3"), "utf8");
  assert.match(dockerfile, /scripts\/internal-replay-grant-preflight\.mjs/);
  const deployment = readFileSync(resolve(root, "docs/deployment.md"), "utf8");
  assert.match(deployment, /internal-replay-grant-preflight\.mjs --dry-run/);
  assert.match(deployment, /internal-replay-grant-preflight\.mjs/);
  assert.match(deployment, /"failureCodes":\[\]/);
  assert.match(deployment, /excessive_privilege/);
  assert.match(deployment, /SELECT, INSERT, DELETE/);
  assert.doesNotMatch(
    readFileSync(scriptPath, "utf8"),
    /connection\.execute\(\s*["`](?:CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i,
  );
  assert.match(
    readFileSync(scriptPath, "utf8"),
    /createRequire\(resolve\(moduleRoot,\s*["']package\.json["']\)\)/,
  );
  console.log("internal replay grant preflight tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
