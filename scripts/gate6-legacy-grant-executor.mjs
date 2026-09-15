#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";
import {
  convergeProductionLegacyGrants,
  validateProductionLegacyGrantPlan,
} from "./lib/production-legacy-grants.mjs";

const PLAN_FILE = "/run/config/gate6-legacy-grants.json";
const HASH = /^[0-9a-f]{64}$/;

export const GATE6_LEGACY_GRANT_EXECUTOR_CONTRACT = Object.freeze({
  service: "gate6-postproof-db-executor",
  command: Object.freeze(["node", "scripts/gate6-legacy-grant-executor.mjs"]),
  databaseHost: "gate6-db-proxy",
  databaseName: "SPX",
  databasePrincipalEnv: "SPX_DB_USERNAME_GATE6_POSTPROOF",
  passwordSecret: "db_password_gate6_postproof",
  grantPlan: PLAN_FILE,
  networks: Object.freeze(["gate6-control-internal"]),
  dockerSocket: false,
  providerCredentials: false,
});

export function parseLegacyGrantExecutorArgs(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("legacy grant executor arguments are invalid");
    values[match[1]] = match[2];
  }
  const keys = [
    "action", "prior-grants-sha256", "target-descriptor-sha256",
    "positive-grant-proof-sha256", "forbidden-grant-proof-sha256",
    "backup-evidence-sha256",
  ];
  if (
    canonicalGate6Json(Object.keys(values).sort()) !== canonicalGate6Json(keys.sort())
    || !["revoke", "restore"].includes(values.action)
    || keys.slice(1).some((key) => !HASH.test(values[key] ?? ""))
  ) throw new Error("legacy grant executor arguments are invalid");
  return values;
}

export function assertLegacyGrantExecutorEnvironment(environment) {
  if (
    environment.DB_HOST !== "gate6-db-proxy"
    || environment.DB_PORT !== "3306"
    || environment.DB_NAME !== "SPX"
    || environment.DB_PASSWORD_FILE !== "/run/secrets/db_password"
    || environment.DB_SSL_MODE !== "verify-identity"
    || environment.DB_SSL_CA_FILE !== "/run/config/db-ca.pem"
    || !/^[A-Za-z0-9_$-]{1,64}$/.test(environment.DB_USERNAME ?? "")
    || Object.keys(environment).some((key) =>
      /(?:^|_)(?:OPENAI|CODEX|ANTHROPIC|GOOGLE|AWS|LINEJS|DOCKER_HOST)(?:_|$)/.test(key),
    )
  ) throw new Error("legacy grant executor environment is invalid");
}

async function main() {
  let connection;
  try {
    const args = parseLegacyGrantExecutorArgs(process.argv.slice(2));
    assertLegacyGrantExecutorEnvironment(process.env);
    const bytes = await readFile(PLAN_FILE);
    const plan = validateProductionLegacyGrantPlan(bytes, {
      priorGrantsSha256: args["prior-grants-sha256"],
      targetDescriptorSha256: args["target-descriptor-sha256"],
      positiveGrantProofSha256: args["positive-grant-proof-sha256"],
      forbiddenGrantProofSha256: args["forbidden-grant-proof-sha256"],
      backupEvidenceSha256: args["backup-evidence-sha256"],
    });
    const configured = mysqlScriptConnectionConfigFromEnv(process.env);
    if (configured.value === null || configured.missing.length !== 0) {
      throw new Error("legacy grant executor database is unavailable");
    }
    const mysql = await import("mysql2/promise");
    connection = await mysql.createConnection({
      ...configured.value,
      timezone: "Z",
      multipleStatements: false,
    });
    const result = await convergeProductionLegacyGrants({
      action: args.action,
      connection,
      plan,
    });
    process.stdout.write(`${canonicalGate6Json({ ok: true, status: result.status, idempotent: result.idempotent })}\n`);
  } catch {
    process.stdout.write(`${canonicalGate6Json({ ok: false, code: "gate6-legacy-grant-executor-refused" })}\n`);
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
