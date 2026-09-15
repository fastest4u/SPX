import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import {
  convergeProductionLegacyGrants,
  validateProductionLegacyGrantPlan,
} from "../scripts/lib/production-legacy-grants.mjs";
import {
  GATE6_LEGACY_GRANT_EXECUTOR_CONTRACT,
  assertLegacyGrantExecutorEnvironment,
  parseLegacyGrantExecutorArgs,
} from "../scripts/gate6-legacy-grant-executor.mjs";

const H = (character: string): string => character.repeat(64);

class Connection {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly responses: unknown[]) {}
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`unexpected SQL: ${sql}`);
    return [response, []];
  }
}

const plan = {
  schemaVersion: 1,
  database: "SPX",
  targetDescriptorSha256: H("1"),
  positiveGrantProofSha256: H("2"),
  forbiddenGrantProofSha256: H("3"),
  backupEvidenceSha256: H("4"),
  accounts: [{
    username: "spx_legacy",
    host: "10.0.0.10",
    grants: [{
      scope: "table",
      resource: "auto_accept_jobs",
      privileges: ["SELECT", "UPDATE"],
    }],
  }],
};

async function main(): Promise<void> {
  assert.deepEqual(GATE6_LEGACY_GRANT_EXECUTOR_CONTRACT.networks, ["gate6-control-internal"]);
  assert.equal(GATE6_LEGACY_GRANT_EXECUTOR_CONTRACT.dockerSocket, false);
  assert.doesNotThrow(() => assertLegacyGrantExecutorEnvironment({
    DB_HOST: "gate6-db-proxy",
    DB_PORT: "3306",
    DB_NAME: "SPX",
    DB_USERNAME: "spx_gate6_postproof",
    DB_PASSWORD_FILE: "/run/secrets/db_password",
    DB_SSL_MODE: "verify-identity",
    DB_SSL_CA_FILE: "/run/config/db-ca.pem",
  }));
  assert.equal(parseLegacyGrantExecutorArgs([
    "--action=revoke",
    `--prior-grants-sha256=${H("1")}`,
    `--target-descriptor-sha256=${H("2")}`,
    `--positive-grant-proof-sha256=${H("3")}`,
    `--forbidden-grant-proof-sha256=${H("4")}`,
    `--backup-evidence-sha256=${H("5")}`,
  ]).action, "revoke");
  const bytes = Buffer.from(canonicalGate6Json(plan));
  const priorGrantsSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(validateProductionLegacyGrantPlan(bytes, {
    priorGrantsSha256,
    targetDescriptorSha256: H("1"),
    positiveGrantProofSha256: H("2"),
    forbiddenGrantProofSha256: H("3"),
    backupEvidenceSha256: H("4"),
  }).accounts.length, 1);

  const revoke = new Connection([
    [{ PRIVILEGE_TYPE: "SELECT" }, { PRIVILEGE_TYPE: "UPDATE" }],
    { affectedRows: 0 },
    [],
  ]);
  assert.deepEqual(await convergeProductionLegacyGrants({
    action: "revoke",
    connection: revoke,
    plan: validateProductionLegacyGrantPlan(bytes, {
      priorGrantsSha256,
      targetDescriptorSha256: H("1"),
      positiveGrantProofSha256: H("2"),
      forbiddenGrantProofSha256: H("3"),
      backupEvidenceSha256: H("4"),
    }),
  }), { status: "revoked", idempotent: false });
  assert.match(revoke.calls[1].sql, /^REVOKE SELECT, UPDATE ON `SPX`\.`auto_accept_jobs` FROM 'spx_legacy'@'10\.0\.0\.10'$/);
  assert.doesNotMatch(revoke.calls[1].sql, /DROP|ALTER USER/i);

  const restore = new Connection([
    [],
    { affectedRows: 0 },
    [{ PRIVILEGE_TYPE: "SELECT" }, { PRIVILEGE_TYPE: "UPDATE" }],
  ]);
  assert.deepEqual(await convergeProductionLegacyGrants({
    action: "restore",
    connection: restore,
    plan: validateProductionLegacyGrantPlan(bytes, {
      priorGrantsSha256,
      targetDescriptorSha256: H("1"),
      positiveGrantProofSha256: H("2"),
      forbiddenGrantProofSha256: H("3"),
      backupEvidenceSha256: H("4"),
    }),
  }), { status: "granted", idempotent: false });
  assert.match(restore.calls[1].sql, /^GRANT SELECT, UPDATE ON `SPX`\.`auto_accept_jobs` TO 'spx_legacy'@'10\.0\.0\.10'$/);

  const partial = new Connection([[{ PRIVILEGE_TYPE: "SELECT" }]]);
  await assert.rejects(() => convergeProductionLegacyGrants({
    action: "revoke",
    connection: partial,
    plan: validateProductionLegacyGrantPlan(bytes, {
      priorGrantsSha256,
      targetDescriptorSha256: H("1"),
      positiveGrantProofSha256: H("2"),
      forbiddenGrantProofSha256: H("3"),
      backupEvidenceSha256: H("4"),
    }),
  }), /indeterminate/i);
  console.log("production legacy grant tests passed");
}

void main();
