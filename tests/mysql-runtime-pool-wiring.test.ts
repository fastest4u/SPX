import assert from "node:assert/strict";
import mysql, { type PoolOptions } from "mysql2/promise";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/config/env.js";
import { closePool, getPool } from "../src/db/client.js";

async function main() {
const directory = mkdtempSync(join(tmpdir(), "spx-runtime-tls-"));
const caFile = join(directory, "ca.pem");
const ca = "-----BEGIN CERTIFICATE-----\nZmFrZS10ZXN0LWNh\n-----END CERTIFICATE-----\n";
const original = mysql.createPool;
let captured: PoolOptions | undefined;
try {
  writeFileSync(caFile, ca);
  Object.assign(env, {
    DB_MODE: "mysql", DB_HOST: "database.example.test", DB_PORT: 3306,
    DB_USERNAME: "test-runtime", DB_PASSWORD: "synthetic-test-password", DB_NAME: "test-database",
    DB_SSL_MODE: "verify-identity", DB_SSL_CA_FILE: caFile, DB_SSL_SERVERNAME: "database.example.test",
  });
  mysql.createPool = ((options: PoolOptions) => {
    captured = options;
    return { on() {}, async end() {} };
  }) as typeof mysql.createPool;
  getPool();
  assert.deepEqual(captured?.ssl, { ca, rejectUnauthorized: true, servername: "database.example.test", verifyIdentity: true });
  assert.equal(captured?.connectTimeout, 10_000);
  assert.equal(captured?.timezone, "+00:00");
  console.log("Runtime MySQL pool uses validated TLS settings");
} finally {
  await closePool();
  mysql.createPool = original;
  rmSync(directory, { recursive: true, force: true });
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
