import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type MysqlScriptConfigModule = {
  mysqlScriptConnectionConfigFromEnv: (
    env?: Record<string, string | undefined>,
  ) => {
    missing: string[];
    value: null | Record<string, unknown>;
  };
};

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "spx-mysql-script-config-"));
const passwordPath = join(temp, "database-password-private-path");
const caPath = join(temp, "mysql-ca-private-path.pem");
const password = "database-password-must-not-leak";
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "ZmFrZS10ZXN0LWNh",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    DB_MODE: "mysql",
    DB_HOST: "mysql.internal",
    DB_PORT: "3306",
    DB_USERNAME: "spx-operator",
    DB_PASSWORD: "",
    DB_PASSWORD_FILE: passwordPath,
    DB_NAME: "spx",
    DB_SSL_MODE: "verify-identity",
    DB_SSL_CA_FILE: caPath,
    DB_SSL_SERVERNAME: "mysql.internal",
    ...overrides,
  };
}

function runScript(script: string, args: string[], overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(baseEnv(overrides))) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function assertSanitized(output: string): void {
  assert.equal(output.includes(password), false);
  assert.equal(output.includes(passwordPath), false);
  assert.equal(output.includes(caPath), false);
}

async function main(): Promise<void> {
try {
  writeFileSync(passwordPath, `${password}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(caPath, caPem, { encoding: "utf8", mode: 0o644 });

  const { mysqlScriptConnectionConfigFromEnv } =
    (await import("../scripts/lib/mysql-connection-config.mjs")) as MysqlScriptConfigModule;

  const verified = mysqlScriptConnectionConfigFromEnv(baseEnv());
  assert.deepEqual(verified.missing, []);
  assert.deepEqual(verified.value?.ssl, {
    ca: caPem,
    rejectUnauthorized: true,
    servername: "mysql.internal",
    verifyIdentity: true,
  });
  assert.equal(verified.value?.password, password);

  for (const host of ["127.0.0.1", "::1"]) {
    const ipLiteral = mysqlScriptConnectionConfigFromEnv(baseEnv({ DB_HOST: host }));
    assert.deepEqual(ipLiteral, {
      missing: ["database-hostname-required"],
      value: null,
    });
    assertSanitized(JSON.stringify(ipLiteral));
  }

  const proxied = mysqlScriptConnectionConfigFromEnv(baseEnv({
    DB_HOST: "staging-db-proxy",
    DB_SSL_SERVERNAME: "mysql-upstream.internal",
  }));
  assert.deepEqual(proxied.missing, []);
  assert.equal((proxied.value?.ssl as { servername?: string } | undefined)?.servername, "mysql-upstream.internal");
  assert.deepEqual(
    mysqlScriptConnectionConfigFromEnv(baseEnv({
      DB_HOST: "staging-db-proxy",
      DB_SSL_SERVERNAME: "staging-db-proxy",
    })),
    { missing: ["database-servername-upstream-required"], value: null },
  );

  const localDisabled = mysqlScriptConnectionConfigFromEnv(baseEnv({
    NODE_ENV: "test",
    DB_PASSWORD: "local-password",
    DB_PASSWORD_FILE: "",
    DB_SSL_MODE: "disabled",
    DB_SSL_CA_FILE: "",
  }));
  assert.deepEqual(localDisabled.missing, []);
  assert.equal(Object.hasOwn(localDisabled.value ?? {}, "ssl"), false);

  const productionDisabled = mysqlScriptConnectionConfigFromEnv(baseEnv({
    DB_SSL_MODE: "disabled",
    DB_SSL_CA_FILE: "",
  }));
  assert.deepEqual(productionDisabled, {
    missing: ["database-tls-required"],
    value: null,
  });

  const conflictingCredential = mysqlScriptConnectionConfigFromEnv(baseEnv({
    DB_PASSWORD: password,
  }));
  assert.deepEqual(conflictingCredential, {
    missing: ["database-credential-invalid"],
    value: null,
  });
  assertSanitized(JSON.stringify(conflictingCredential));

  const missingCa = mysqlScriptConnectionConfigFromEnv(baseEnv({ DB_SSL_CA_FILE: "" }));
  assert.deepEqual(missingCa, { missing: ["database-ca-required"], value: null });

  let symlinkCaPath = join(temp, "symlink-ca-private-path.pem");
  try {
    symlinkSync(caPath, symlinkCaPath, "file");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
    const targetDir = join(temp, "ca-target");
    const linkedDir = join(temp, "ca-linked-parent");
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "mysql-ca.pem"), caPem, "utf8");
    symlinkSync(targetDir, linkedDir, "junction");
    symlinkCaPath = join(linkedDir, "mysql-ca.pem");
  }
  const symlinkCa = mysqlScriptConnectionConfigFromEnv(baseEnv({
    DB_SSL_CA_FILE: symlinkCaPath,
  }));
  assert.deepEqual(symlinkCa, { missing: ["database-ca-invalid"], value: null });
  assert.equal(JSON.stringify(symlinkCa).includes(symlinkCaPath), false);

  const oversizedCaPath = join(temp, "oversized-ca-private-path.pem");
  writeFileSync(oversizedCaPath, Buffer.alloc(1024 * 1024 + 1, 65));
  const oversizedCa = mysqlScriptConnectionConfigFromEnv(baseEnv({
    DB_SSL_CA_FILE: oversizedCaPath,
  }));
  assert.deepEqual(oversizedCa, { missing: ["database-ca-invalid"], value: null });
  assert.equal(JSON.stringify(oversizedCa).includes(oversizedCaPath), false);

  const malformedCaPath = join(temp, "malformed-ca-private-path.pem");
  writeFileSync(malformedCaPath, "not-a-pem-ca\n", "utf8");
  const malformedCa = mysqlScriptConnectionConfigFromEnv(baseEnv({
    DB_SSL_CA_FILE: malformedCaPath,
  }));
  assert.deepEqual(malformedCa, { missing: ["database-ca-invalid"], value: null });

  const validDryRuns = [
    runScript(
      "scripts/service-fault-outbox-check.mjs",
      ["--dry-run", "--event-key-contains=tls_drill_event"],
      {},
    ),
    runScript(
      "scripts/phase3-runtime-confidence-check.mjs",
      [
        "--dry-run",
        "--poller-node-id=poller-01",
        "--auto-accept-node-id=auto-01",
        "--team-ids=1",
        "--auto-accept-modes=autoAcceptReal",
      ],
      {},
    ),
    runScript(
      "scripts/phase3-rollback-guard.mjs",
      ["--dry-run", "--team-id=2", "--epoch=phase3-test", "--poller-node-id=poller-01"],
      {},
    ),
    runScript("scripts/internal-replay-grant-preflight.mjs", ["--dry-run"], {}),
  ];
  for (const result of validDryRuns) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertSanitized(`${result.stdout}\n${result.stderr}`);
  }

  const invalidTlsRuns = [
    runScript(
      "scripts/service-fault-outbox-check.mjs",
      ["--dry-run", "--event-key-contains=tls_drill_event"],
      { DB_SSL_MODE: "disabled", DB_SSL_CA_FILE: "" },
    ),
    runScript(
      "scripts/phase3-runtime-confidence-check.mjs",
      [
        "--dry-run",
        "--poller-node-id=poller-01",
        "--auto-accept-node-id=auto-01",
        "--team-ids=1",
        "--auto-accept-modes=autoAcceptReal",
      ],
      { DB_SSL_MODE: "disabled", DB_SSL_CA_FILE: "" },
    ),
    runScript(
      "scripts/phase3-rollback-guard.mjs",
      ["--dry-run", "--team-id=2", "--epoch=phase3-test", "--poller-node-id=poller-01"],
      { DB_SSL_MODE: "disabled", DB_SSL_CA_FILE: "" },
    ),
  ];
  for (const result of invalidTlsRuns) {
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /database-tls-required/);
    assertSanitized(`${result.stdout}\n${result.stderr}`);
  }

  const replayInvalidTls = runScript(
    "scripts/internal-replay-grant-preflight.mjs",
    ["--dry-run"],
    { DB_SSL_MODE: "disabled", DB_SSL_CA_FILE: "" },
  );
  assert.equal(replayInvalidTls.status, 1, replayInvalidTls.stderr || replayInvalidTls.stdout);
  assert.match(replayInvalidTls.stdout, /database_config_invalid/);
  assertSanitized(`${replayInvalidTls.stdout}\n${replayInvalidTls.stderr}`);

  const schemaInvalidTls = runScript("scripts/schema-verify.mjs", [], {
    DB_SSL_MODE: "disabled",
    DB_SSL_CA_FILE: caPath,
  });
  assert.equal(schemaInvalidTls.status, 1, schemaInvalidTls.stderr || schemaInvalidTls.stdout);
  assert.match(schemaInvalidTls.stderr, /database-tls-required/);
  assertSanitized(`${schemaInvalidTls.stdout}\n${schemaInvalidTls.stderr}`);

  const dockerfile = readFileSync(join(root, "Dockerfile.a3"), "utf8");
  assert.match(dockerfile, /scripts\/lib\/mysql-connection-config\.mjs/);
  assert.match(dockerfile, /scripts\/lib\/safe-file\.mjs/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("mysql-script-connection-config: TLS and sanitized file-backed config verified");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
