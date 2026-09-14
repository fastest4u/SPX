import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMysqlPoolOptions } from "../src/db/mysql-pool-options.js";

const require = createRequire(import.meta.url);
const tsxRegisterUrl = pathToFileURL(require.resolve("tsx")).href;

const temp = mkdtempSync(join(tmpdir(), "spx-db-tls-"));
const caPath = join(temp, "mysql-ca.pem");
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "ZmFrZS10ZXN0LWNh",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

const basePoolConfig = {
  host: "mysql.example.test",
  port: 3306,
  user: "spx-runtime",
  password: "db-password-must-not-leak",
  database: "spx_production",
  sslMode: "verify-identity" as const,
  sslCaFile: caPath,
  sslServername: "mysql.example.test",
};

function validateRuntime(overrides: Record<string, string | undefined>) {
  const envModuleUrl = pathToFileURL(resolve(process.cwd(), "src/config/env.ts")).href;
  const childEnv: Record<string, string> = {
    NODE_ENV: "production",
    SPX_ROLE: "migrator",
    HTTP_ENABLED: "false",
    DB_MODE: "mysql",
    DB_HOST: "mysql.example.test",
    DB_PORT: "3306",
    DB_USERNAME: "spx-migrator",
    DB_PASSWORD: "db-password-must-not-leak",
    DB_NAME: "spx_production",
    DB_SSL_MODE: "verify-identity",
    DB_SSL_CA_FILE: caPath,
  };
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key]!;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const script = `
    const mod = await import(${JSON.stringify(envModuleUrl)});
    try { mod.validateRuntimeConfig(); console.log("VALID"); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(42); }
  `;
  return spawnSync(process.execPath, ["--import", tsxRegisterUrl, "-e", script], {
    cwd: temp,
    encoding: "utf8",
    env: childEnv,
  });
}

try {
  writeFileSync(caPath, caPem, { encoding: "utf8", mode: 0o644 });

  const verified = buildMysqlPoolOptions(basePoolConfig);
  assert.deepEqual(verified.ssl, {
    ca: caPem,
    rejectUnauthorized: true,
    servername: "mysql.example.test",
    verifyIdentity: true,
  });
  assert.equal(verified.host, basePoolConfig.host);
  assert.equal(verified.password, basePoolConfig.password);

  const disabled = buildMysqlPoolOptions({ ...basePoolConfig, sslMode: "disabled", sslCaFile: "" });
  assert.equal(Object.hasOwn(disabled, "ssl"), false);

  const marker = "PRIVATE_CA_PATH_MUST_NOT_LEAK";
  assert.throws(
    () => buildMysqlPoolOptions({ ...basePoolConfig, sslCaFile: join(temp, marker) }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /DB_SSL_CA_FILE could not be read/);
      assert.doesNotMatch(message, new RegExp(marker));
      assert.doesNotMatch(message, /db-password-must-not-leak/);
      return true;
    },
  );

  const valid = validateRuntime({});
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);

  for (const host of ["127.0.0.1", "::1"]) {
    const ipLiteral = validateRuntime({ DB_HOST: host });
    assert.equal(ipLiteral.status, 42, `${ipLiteral.stdout}\n${ipLiteral.stderr}`);
    assert.match(ipLiteral.stderr, /DB_HOST must be a DNS hostname/);
    assert.doesNotMatch(ipLiteral.stderr, /db-password-must-not-leak/);
  }

  assert.throws(
    () => buildMysqlPoolOptions({ ...basePoolConfig, host: "127.0.0.1" }),
    /DB_HOST must be a DNS hostname/,
  );

  for (const proxyHost of ["staging-db-proxy", "gate6-db-proxy"]) {
    const proxied = buildMysqlPoolOptions({
      ...basePoolConfig,
      host: proxyHost,
      sslServername: "mysql-upstream.example.test",
    });
    assert.equal(proxied.host, proxyHost);
    assert.equal(proxied.ssl && "servername" in proxied.ssl ? proxied.ssl.servername : null, "mysql-upstream.example.test");
    for (const sslServername of ["", proxyHost, "127.0.0.1", "::1"]) {
      assert.throws(
        () =>
          buildMysqlPoolOptions({
            ...basePoolConfig,
            host: proxyHost,
            sslServername,
          }),
        /DB_SSL_SERVERNAME|upstream/i,
      );
    }
  }

  for (const overrides of [
    { DB_SSL_MODE: "disabled" },
    { DB_SSL_MODE: "preferred" },
    { DB_SSL_MODE: "verify-identity", DB_SSL_CA_FILE: "" },
  ]) {
    const invalid = validateRuntime(overrides);
    assert.equal(invalid.status, 42, `${invalid.stdout}\n${invalid.stderr}`);
    assert.match(invalid.stderr, /DB_SSL_MODE|DB_SSL_CA_FILE/);
    assert.doesNotMatch(invalid.stderr, /db-password-must-not-leak/);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("db-tls-config: verify-identity and production fail-closed guards verified");
