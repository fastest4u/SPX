import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCTION_BOOTSTRAP_DB_ROLES,
  buildProductionPrincipalPlan,
  buildProductionPrincipalStatements,
  provisionProductionPrincipals,
} from "../scripts/production-db-principal-bootstrap.mjs";

const H = (value: string) => value.repeat(64).slice(0, 64);
const accountHosts = Object.fromEntries(
  PRODUCTION_BOOTSTRAP_DB_ROLES.map((role) => [role, "45.83.207.139"]),
);
const descriptor = {
  environment: "production",
  database: { name: "SPX", accountHosts },
};
const grantContract = JSON.parse(readFileSync("deploy/db-grants.json", "utf8"));

async function main(): Promise<void> {
  assert.deepEqual(PRODUCTION_BOOTSTRAP_DB_ROLES, [
    "gate6-control",
    "gate6-monitor",
    "observer",
    "realtime-service",
    "line-service",
    "notification-service",
    "worker-ifn-split",
    "worker-ptwl-split",
    "web-api",
    "phase3-control",
    "migrator",
  ]);

  const plan = buildProductionPrincipalPlan({
    descriptor,
    grantContract,
    targetDescriptorSha256: H("a"),
    legacyUsername: "spx_legacy",
    legacyPasswordSha256: H("b"),
  });
  assert.deepEqual(plan.roles, PRODUCTION_BOOTSTRAP_DB_ROLES);
  assert.equal(plan.database, "SPX");
  assert.equal(plan.principals["worker-ifn-split"].accountHost, "45.83.207.139");
  assert.equal(plan.principals["worker-ifn-split"].candidateUsername, "spx_prod_worker_ifn_split");
  assert.equal(plan.principals["gate6-monitor"].maxUserConnections, 1);
  assert.equal(plan.principals.migrator.maxUserConnections, 2);
  assert.equal(plan.principals["line-service"].maxUserConnections, 8);

  const statements = buildProductionPrincipalStatements(
    plan,
    "line-service",
    "A".repeat(48),
  );
  assert.match(statements[0].sql, /^CREATE USER IF NOT EXISTS /);
  assert.match(statements[0].sql, /IDENTIFIED BY \? REQUIRE SSL WITH MAX_USER_CONNECTIONS 8$/);
  assert.deepEqual(statements[0].parameters, ["A".repeat(48)]);
  assert.match(statements[1].sql, /^ALTER USER /);
  assert.deepEqual(statements[1].parameters, ["A".repeat(48)]);
  assert.match(statements[2].sql, /^REVOKE ALL PRIVILEGES, GRANT OPTION FROM /);
  assert.ok(statements.some((entry) => /ON `SPX`\.`line_bot_sessions`/.test(entry.sql)));
  assert.ok(statements.every((entry) => !entry.sql.includes("@'%'")));
  assert.ok(statements.slice(3).every((entry) => !/\bALL(?: PRIVILEGES)?\b/.test(entry.sql)));

  assert.throws(
    () => buildProductionPrincipalPlan({
      descriptor: {
        ...descriptor,
        database: { ...descriptor.database, accountHosts: { ...accountHosts, "line-service": "%" } },
      },
      grantContract,
      targetDescriptorSha256: H("a"),
      legacyUsername: "spx_legacy",
      legacyPasswordSha256: H("b"),
    }),
    /account host/i,
  );

  const calls: string[] = [];
  const result = await provisionProductionPrincipals({
    plan,
    passwordForRole: (role: string) => `${role.replaceAll("-", "_")}_${"x".repeat(36)}`,
    adapter: {
      async apply({ role }: { role: string }) {
        calls.push(`apply:${role}`);
        return {
          positiveGrantProofSha256: H("c"),
          forbiddenGrantProofSha256: H("d"),
        };
      },
      async writeCredential({ role }: { role: string }) { calls.push(`write:${role}`); },
      async revoke({ role }: { role: string }) { calls.push(`revoke:${role}`); },
      async removeCredential({ role }: { role: string }) { calls.push(`remove:${role}`); },
    },
  });
  assert.equal(result.length, PRODUCTION_BOOTSTRAP_DB_ROLES.length);
  assert.equal(result[0].role, "gate6-control");
  assert.equal("password" in result[0], false);
  assert.equal(result[0].candidatePasswordSha256.length, 64);
  assert.deepEqual(calls.slice(0, 4), [
    "apply:gate6-control",
    "write:gate6-control",
    "apply:gate6-monitor",
    "write:gate6-monitor",
  ]);

  const compensated: string[] = [];
  await assert.rejects(
    provisionProductionPrincipals({
      plan,
      passwordForRole: (role: string) => `${role.replaceAll("-", "_")}_${"y".repeat(36)}`,
      adapter: {
        async apply({ role }: { role: string }) {
          if (role === "observer") throw new Error("injected failure");
          return {
            positiveGrantProofSha256: H("e"),
            forbiddenGrantProofSha256: H("f"),
          };
        },
        async writeCredential() {},
        async revoke({ role }: { role: string }) { compensated.push(`revoke:${role}`); },
        async removeCredential({ role }: { role: string }) { compensated.push(`remove:${role}`); },
      },
    }),
    /injected failure/,
  );
  assert.deepEqual(compensated, [
    "remove:observer",
    "revoke:observer",
    "remove:gate6-monitor",
    "revoke:gate6-monitor",
    "remove:gate6-control",
    "revoke:gate6-control",
  ]);

  console.log("production DB principal bootstrap tests passed");
}

void main();
