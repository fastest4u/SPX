import assert from "node:assert/strict";

import {
  executeStagingSqlPayload,
  validateStagingSqlPayload,
} from "../scripts/staging-db-sql-executor.mjs";

const payload = {
  schemaVersion: 1,
  connection: {
    host: "mysql.staging.internal",
    port: 3306,
    user: "spx_staging_bootstrap",
    password: "x".repeat(40),
    database: "spx_staging",
    ssl: {
      ca: "test-ca",
      rejectUnauthorized: true,
      servername: "mysql.staging.internal",
    },
  },
  statements: [
    { sql: "CREATE DATABASE IF NOT EXISTS `spx_staging`", parameters: [] },
    {
      sql: "CREATE USER IF NOT EXISTS 'spx_stg_web_api'@'172.17.0.1' IDENTIFIED BY ? REQUIRE SSL",
      parameters: ["y".repeat(40)],
    },
  ],
};

async function main(): Promise<void> {
  assert.deepEqual(validateStagingSqlPayload(payload), payload);
  assert.throws(
    () => validateStagingSqlPayload({ ...payload, command: "DROP DATABASE spx" }),
    /field|payload/i,
  );
  assert.throws(
    () => validateStagingSqlPayload({
      ...payload,
      statements: [{ sql: "SELECT 1; DROP DATABASE spx_staging", parameters: [] }],
    }),
    /statement|SQL/i,
  );
  assert.throws(
    () => validateStagingSqlPayload({
      ...payload,
      connection: { ...payload.connection, database: "spx" },
    }),
    /connection|database/i,
  );

  const calls: string[] = [];
  await executeStagingSqlPayload(payload, {
    async createConnection(config: Record<string, unknown>) {
      assert.equal(config.database, undefined);
      assert.equal(config.user, "spx_staging_bootstrap");
      return {
        async query(sql: string, parameters: string[]) {
          calls.push(`${sql}:${parameters.length}`);
        },
        async end() {
          calls.push("end");
        },
      };
    },
  });
  assert.deepEqual(calls, [
    `${payload.statements[0].sql}:0`,
    `${payload.statements[1].sql}:1`,
    "end",
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
