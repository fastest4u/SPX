import { createHash } from "node:crypto";

import { canonicalGate6Json } from "../../src/services/gate6-approval-runtime.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\d{1,3}(?:\.\d{1,3}){3})$/;
const PRIVILEGES = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "EXECUTE", "LOCK TABLES",
  "CREATE TEMPORARY TABLES",
]);

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertSortedUnique(values) {
  return Array.isArray(values)
    && values.length > 0
    && values.every((value) => typeof value === "string")
    && new Set(values).size === values.length
    && values.every((value, index) => value === [...values].sort()[index]);
}

export function validateProductionLegacyGrantPlan(bytes, expected) {
  const priorGrantsSha256 = createHash("sha256").update(bytes).digest("hex");
  let value;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    value = JSON.parse(text);
    if (text !== canonicalGate6Json(value)) throw new Error("not canonical");
  } catch {
    throw new Error("production legacy grant plan is invalid");
  }
  if (
    !exactKeys(value, [
      "schemaVersion", "database", "targetDescriptorSha256",
      "positiveGrantProofSha256", "forbiddenGrantProofSha256",
      "backupEvidenceSha256", "accounts",
    ])
    || value.schemaVersion !== 1
    || value.database !== "SPX"
    || priorGrantsSha256 !== expected.priorGrantsSha256
    || value.targetDescriptorSha256 !== expected.targetDescriptorSha256
    || value.positiveGrantProofSha256 !== expected.positiveGrantProofSha256
    || value.forbiddenGrantProofSha256 !== expected.forbiddenGrantProofSha256
    || value.backupEvidenceSha256 !== expected.backupEvidenceSha256
    || ![
      priorGrantsSha256,
      value.targetDescriptorSha256,
      value.positiveGrantProofSha256,
      value.forbiddenGrantProofSha256,
      value.backupEvidenceSha256,
    ].every((hash) => SHA256.test(hash ?? ""))
    || !Array.isArray(value.accounts)
    || value.accounts.length === 0
  ) throw new Error("production legacy grant plan binding is invalid");
  let priorAccount = "";
  for (const account of value.accounts) {
    if (
      !exactKeys(account, ["username", "host", "grants"])
      || !IDENTIFIER.test(account.username ?? "")
      || !HOST.test(account.host ?? "")
      || /[%_/@\\\s]/.test(account.host)
      || !Array.isArray(account.grants)
      || account.grants.length === 0
    ) throw new Error("production legacy grant account is invalid");
    const accountKey = `${account.username}@${account.host}`;
    if (accountKey <= priorAccount) throw new Error("production legacy grant accounts are not sorted and unique");
    priorAccount = accountKey;
    let priorGrant = "";
    for (const grant of account.grants) {
      if (
        !exactKeys(grant, ["scope", "resource", "privileges"])
        || !["database", "table"].includes(grant.scope)
        || !IDENTIFIER.test(grant.resource ?? "")
        || (grant.scope === "database" && grant.resource !== "SPX")
        || !assertSortedUnique(grant.privileges)
        || grant.privileges.some((privilege) => !PRIVILEGES.has(privilege))
      ) throw new Error("production legacy grant entry is invalid");
      const grantKey = `${grant.scope}:${grant.resource}`;
      if (grantKey <= priorGrant) throw new Error("production legacy grants are not sorted and unique");
      priorGrant = grantKey;
    }
  }
  return Object.freeze(structuredClone(value));
}

function accountSql(account) {
  return `'${account.username}'@'${account.host}'`;
}

async function currentGrantState(connection, plan) {
  const states = [];
  for (const account of plan.accounts) {
    const grantee = accountSql(account);
    for (const grant of account.grants) {
      const tableGrant = grant.scope === "table";
      const [rows] = await connection.execute(tableGrant ? `
        SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES
        WHERE GRANTEE = ? AND TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY PRIVILEGE_TYPE
      ` : `
        SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES
        WHERE GRANTEE = ? AND TABLE_SCHEMA = ?
        ORDER BY PRIVILEGE_TYPE
      `, tableGrant ? [grantee, plan.database, grant.resource] : [grantee, plan.database]);
      if (!Array.isArray(rows)) throw new Error("production legacy grant state is unavailable");
      const actual = rows.map((row) => row.PRIVILEGE_TYPE).sort();
      if (actual.some((privilege) => typeof privilege !== "string")) {
        throw new Error("production legacy grant state is invalid");
      }
      if (actual.length === 0) states.push("revoked");
      else if (canonicalGate6Json(actual) === canonicalGate6Json(grant.privileges)) states.push("granted");
      else states.push("indeterminate");
    }
  }
  if (states.every((state) => state === "granted")) return "granted";
  if (states.every((state) => state === "revoked")) return "revoked";
  return "indeterminate";
}

function mutationSql(action, plan, account, grant) {
  const verb = action === "revoke" ? "REVOKE" : "GRANT";
  const connector = action === "revoke" ? "FROM" : "TO";
  const resource = grant.scope === "database"
    ? `\`${plan.database}\`.*`
    : `\`${plan.database}\`.\`${grant.resource}\``;
  return `${verb} ${grant.privileges.join(", ")} ON ${resource} ${connector} ${accountSql(account)}`;
}

export async function convergeProductionLegacyGrants({ action, connection, plan }) {
  if (!["revoke", "restore"].includes(action)) throw new Error("production legacy grant action is invalid");
  const expectedBefore = action === "revoke" ? "granted" : "revoked";
  const expectedAfter = action === "revoke" ? "revoked" : "granted";
  const before = await currentGrantState(connection, plan);
  if (before === expectedAfter) return { status: expectedAfter, idempotent: true };
  if (before !== expectedBefore) throw new Error("production legacy grant state is indeterminate");
  for (const account of plan.accounts) {
    for (const grant of account.grants) {
      await connection.execute(mutationSql(action, plan, account, grant));
    }
  }
  if (await currentGrantState(connection, plan) !== expectedAfter) {
    throw new Error("production legacy grant postcondition failed");
  }
  return { status: expectedAfter, idempotent: false };
}
