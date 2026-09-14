#!/usr/bin/env node

export function evaluateStagingIsolation(value) {
  const failures = [];
  if (value?.environment !== "staging") failures.push("ENVIRONMENT_INVALID");
  if (value?.project !== "spx-staging") failures.push("PROJECT_INVALID");
  if (value?.database !== "spx_staging") failures.push("DATABASE_INVALID");
  if (!value?.databaseFingerprint || value.databaseFingerprint === value.productionDatabaseFingerprint)
    failures.push("DATABASE_TARGET_COLLISION");
  if (
    !Array.isArray(value?.nodeIds) ||
    value.nodeIds.length === 0 ||
    new Set(value.nodeIds).size !== value.nodeIds.length ||
    value.nodeIds.some((nodeId) => typeof nodeId !== "string" || !nodeId.startsWith("stg-"))
  )
    failures.push("NODE_ID_INVALID");
  if (
    !Array.isArray(value?.publishedPorts) ||
    value.publishedPorts.some((entry) => entry?.host !== "127.0.0.1" || entry?.port !== 3100)
  )
    failures.push("PORT_BINDING_INVALID");
  if (value?.volumeOwners?.some((owner) => owner !== "spx-staging"))
    failures.push("VOLUME_OWNER_INVALID");
  if (value?.networkOwners?.some((owner) => owner !== "spx-staging"))
    failures.push("NETWORK_OWNER_INVALID");
  if (
    value?.providerTargetFingerprints?.some((fingerprint) =>
      value?.productionProviderTargetFingerprints?.includes(fingerprint),
    )
  )
    failures.push("PROVIDER_TARGET_COLLISION");
  return { ok: failures.length === 0, failures };
}

if (process.argv[1]?.endsWith("staging-isolation-check.mjs")) {
  console.log(JSON.stringify({ ok: false, failures: ["VERIFIED_STAGING_CONTEXT_REQUIRED"] }));
  process.exitCode = 1;
}
