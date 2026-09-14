import assert from "node:assert/strict";

import {
  evaluateEffectiveStagingConfig,
  evaluateStagingPreflightPhase,
  runInstalledStagingPreflight,
} from "../scripts/a3-staging-preflight.mjs";

const valid = {
  environment: "staging",
  project: "spx-staging",
  database: "spx_staging",
  a3HostIdentity: "a3-host",
  signedA3HostIdentity: "a3-host",
  productionHostIdentity: "prod-host",
  envFile: "/etc/spx-staging/runtime.env",
  composeFiles: [
    `/opt/spx-staging/release/${"a".repeat(40)}/operator/docker-compose.yml`,
    `/opt/spx-staging/release/${"a".repeat(40)}/operator/docker-compose.staging.yml`,
  ],
  candidateImageId: `sha256:${"a".repeat(64)}`,
  serviceImageIds: [`sha256:${"a".repeat(64)}`],
  mutableImageTags: [],
  dbFingerprint: "stage-db",
  productionDbFingerprint: "prod-db",
  accountHosts: { "line-service": "172.17.0.1", migrator: "172.17.0.1" },
  signedAccountHosts: { "line-service": "172.17.0.1", migrator: "172.17.0.1" },
  nodeIds: ["stg-web-1", "stg-worker-ifn-1"],
  publishedPorts: [{ host: "127.0.0.1", port: 3100 }],
  signedPublishedPorts: [3100],
  portCollision: false,
  providerTargetFingerprints: ["stage-provider"],
  productionProviderTargetFingerprints: ["prod-provider"],
  volumeOwners: ["spx-staging"],
  networkOwners: ["spx-staging"],
  bindMounts: ["/var/lib/spx-staging"],
  dockerContext: "default",
  dockerHost: null,
  productionSshKeyPresent: false,
  productionMutationCredentialPresent: false,
  guardLeaseFresh: true,
  watchdogLeaseFresh: true,
  databaseMutationObserved: false,
  stagingCatalogPresent: false,
  migratorOnly: false,
  migrationsComplete: false,
  principalsFinalized: false,
  bootstrapRevoked: false,
};

async function main(): Promise<void> {
assert.deepEqual(evaluateEffectiveStagingConfig(valid), { ok: true, failures: [] });
for (const invalid of [
  { ...valid, project: "spx" },
  { ...valid, database: "spx" },
  { ...valid, a3HostIdentity: valid.productionHostIdentity },
  { ...valid, envFile: "/etc/spx-production/runtime.env" },
  { ...valid, nodeIds: ["prod-worker-ifn"] },
  { ...valid, publishedPorts: [{ host: "0.0.0.0", port: 3100 }] },
  { ...valid, dockerHost: "ssh://production" },
  { ...valid, productionSshKeyPresent: true },
  { ...valid, accountHosts: { ...valid.accountHosts, "line-service": "172.17.0.2" } },
]) assert.equal(evaluateEffectiveStagingConfig(invalid).ok, false);

assert.equal(evaluateStagingPreflightPhase("pre-create", valid).ok, true);
assert.equal(
  evaluateStagingPreflightPhase("pre-create", { ...valid, databaseMutationObserved: true }).ok,
  false,
);
assert.equal(
  evaluateStagingPreflightPhase("pre-migrate", {
    ...valid,
    stagingCatalogPresent: true,
    migratorOnly: true,
  }).ok,
  true,
);
assert.equal(
  evaluateStagingPreflightPhase("pre-start", {
    ...valid,
    stagingCatalogPresent: true,
    migrationsComplete: true,
    principalsFinalized: true,
    bootstrapRevoked: true,
  }).ok,
  true,
);

assert.deepEqual(
  await runInstalledStagingPreflight("pre-create", {
    async loadContext() {
      return { installedBinding: { stagingRunId: "staging-run-001" } };
    },
    async loadLeases() {
      return { stagingRunId: "staging-run-001" };
    },
    async collectConfig() {
      return valid;
    },
  }),
  { ok: true, failures: [] },
);

console.log("A3 staging preflight tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
