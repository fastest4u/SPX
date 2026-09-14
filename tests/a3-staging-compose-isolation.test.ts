import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evaluateStagingIsolation } from "../scripts/staging-isolation-check.mjs";

const phase3WorkerFlags = [
  "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseYamlScalar(
  doubleQuoted: string | undefined,
  singleQuoted: string | undefined,
  bare: string | undefined,
): unknown {
  if (doubleQuoted !== undefined) return doubleQuoted;
  if (singleQuoted !== undefined) return singleQuoted;
  if (bare === "true") return true;
  if (bare === "false") return false;
  if (bare === "null" || bare === "~") return null;
  if (bare !== undefined && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(bare)) return Number(bare);
  return bare;
}

function directYamlMapping(source: string, path: string[]): Record<string, unknown> {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let rangeStart = 0;
  let rangeEnd = lines.length;
  let parentIndent = -2;
  for (const key of path) {
    const indent = parentIndent + 2;
    const header = new RegExp(
      `^${" ".repeat(indent)}${escapeRegExp(key)}:\\s*(?:&[A-Za-z0-9._-]+)?\\s*$`,
    );
    let headerIndex = -1;
    for (let index = rangeStart; index < rangeEnd; index += 1) {
      if (header.test(lines[index])) {
        headerIndex = index;
        break;
      }
    }
    assert.notEqual(headerIndex, -1, `missing YAML mapping path ${path.join(".")}`);
    let childEnd = rangeEnd;
    for (let index = headerIndex + 1; index < rangeEnd; index += 1) {
      if (lines[index].trim() === "") continue;
      const currentIndent = lines[index].match(/^ */)?.[0].length ?? 0;
      if (currentIndent <= indent) {
        childEnd = index;
        break;
      }
    }
    rangeStart = headerIndex + 1;
    rangeEnd = childEnd;
    parentIndent = indent;
  }

  const values: Record<string, unknown> = {};
  const valueIndent = parentIndent + 2;
  for (let index = rangeStart; index < rangeEnd; index += 1) {
    const line = lines[index];
    if ((line.match(/^ */)?.[0].length ?? 0) !== valueIndent) continue;
    const scalar = line.slice(valueIndent).match(
      /^([A-Z][A-Z0-9_]*):\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/,
    );
    if (!scalar) continue;
    values[scalar[1]] = parseYamlScalar(scalar[2], scalar[3], scalar[4]);
  }
  return values;
}

function resolvedPhase3Environment(
  baseSource: string,
  stagingSource: string,
  service: string,
): Record<string, unknown> {
  return {
    ...directYamlMapping(baseSource, ["services", service, "environment"]),
    ...directYamlMapping(stagingSource, ["x-staging-environment"]),
    ...directYamlMapping(stagingSource, ["services", service, "environment"]),
  };
}

function assertFixedPhase3ConsumersDisabled(baseSource: string, stagingSource: string): void {
  for (const service of ["auto-accept-ifn-phase3", "auto-accept-ptwl-phase3"]) {
    const resolved = resolvedPhase3Environment(baseSource, stagingSource, service);
    assert.deepEqual(
      phase3WorkerFlags.map((flag) => [flag, resolved[flag]]),
      phase3WorkerFlags.map((flag) => [flag, "false"]),
      `${service} must resolve both worker flags to the exact string false`,
    );
  }
}

const valid = {
  environment: "staging",
  project: "spx-staging",
  database: "spx_staging",
  productionDatabaseFingerprint: "prod-db",
  databaseFingerprint: "stage-db",
  nodeIds: ["stg-web-1", "stg-worker-ifn-1"],
  publishedPorts: [{ host: "127.0.0.1", port: 3100 }],
  volumeOwners: ["spx-staging"],
  networkOwners: ["spx-staging"],
  providerTargetFingerprints: ["stage-provider"],
  productionProviderTargetFingerprints: ["prod-provider"],
};
assert.deepEqual(evaluateStagingIsolation(valid), { ok: true, failures: [] });
assert.equal(
  evaluateStagingIsolation({ ...valid, databaseFingerprint: valid.productionDatabaseFingerprint }).ok,
  false,
);
assert.equal(evaluateStagingIsolation({ ...valid, nodeIds: ["prod-worker-1"] }).ok, false);
assert.equal(
  evaluateStagingIsolation({ ...valid, publishedPorts: [{ host: "0.0.0.0", port: 3100 }] }).ok,
  false,
);

const overlay = readFileSync("docker-compose.staging.yml", "utf8");
const base = readFileSync("docker-compose.a3.yml", "utf8");
const disabled = readFileSync("deploy/staging-phase3-disabled.yml", "utf8");
const enabled = readFileSync("deploy/staging-phase3-enabled.yml", "utf8");
const fixture = readFileSync("tests/fixtures/a3-staging-compose.env", "utf8");
assert.match(overlay, /SPX_ENVIRONMENT:\s*staging/);
assert.match(overlay, /DB_NAME:\s*spx_staging/);
assert.match(overlay, /127\.0\.0\.1:3100:3000/);
for (const service of ["gate6-control", "gate6-monitor-probe", "gate6-task9-controller"]) {
  const block = overlay.match(
    new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9][a-z0-9-]+:\\r?$|^networks:)`, "m"),
  )?.[0] ?? "";
  assert.match(block, /<<:\s*\*staging-environment/, `${service} must be staging DB-bound`);
  assert.match(block, /SPX_NODE_ID:\s*stg-/, `${service} must use a staging node identity`);
}
assert.doesNotMatch(overlay, /prod-|spx-production|\/opt\/spx-production/i);
assert.match(fixture, /^SPX_DB_NAME=spx_staging$/m);
assert.doesNotMatch(fixture, /spx_production|prod-/i);

const expectedEnabled = `services:
  auto-accept-ifn-phase3:
    environment:
      AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true"
      AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "true"

  auto-accept-ptwl-phase3:
    environment:
      AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true"
      AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "true"
`;
assert.equal(enabled.replace(/\r\n/g, "\n"), expectedEnabled);

const expectedDisabled = `services:
  auto-accept-ifn-phase3:
    environment:
      AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "false"
      AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "false"

  auto-accept-ptwl-phase3:
    environment:
      AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "false"
      AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "false"
`;
assert.equal(disabled.replace(/\r\n/g, "\n"), expectedDisabled);

const sharedStagingEnvironment = directYamlMapping(overlay, ["x-staging-environment"]);
for (const service of ["auto-accept-ifn-phase3", "auto-accept-ptwl-phase3"]) {
  const baseEnvironment = directYamlMapping(base, ["services", service, "environment"]);
  for (const flag of phase3WorkerFlags) {
    assert.equal(baseEnvironment[flag], "true");
    assert.equal(sharedStagingEnvironment[flag], "false");
  }
}
assertFixedPhase3ConsumersDisabled(base, overlay);

for (const [service, nodeId] of [
  ["auto-accept-ifn-phase3", "stg-auto-accept-ifn-phase3-1"],
  ["auto-accept-ptwl-phase3", "stg-auto-accept-ptwl-phase3-1"],
] as const) {
  for (const flag of phase3WorkerFlags) {
    const nodeLine = `      SPX_NODE_ID: ${nodeId}`;
    const unsafeLocalOverride = overlay.replace(
      nodeLine,
      `${nodeLine}\n      ${flag}: "true"`,
    );
    assert.notEqual(unsafeLocalOverride, overlay);
    assert.throws(
      () => assertFixedPhase3ConsumersDisabled(base, unsafeLocalOverride),
      /must resolve both worker flags to the exact string false/,
      `${service} local ${flag} override must fail the merged-config assertion`,
    );
  }
}

console.log("A3 staging Compose isolation tests passed");
