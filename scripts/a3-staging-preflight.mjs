#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { canonicalJson } from "./lib/evidence-artifact.mjs";
import { loadInstalledApprovedStagingContext } from "./lib/a3-staging-approved-context.mjs";
import { loadStagingLeases } from "./lib/a3-staging-leases.mjs";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";
import { STAGING_STOP_SERVICE_ALLOWLIST } from "./a3-capacity-guard.mjs";
import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledStagingOperatorRoot,
} from "./lib/staging-installed-context.mjs";

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((item, i) => item === right[i]);
}

function sameObject(left, right) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
    leftKeys.every(
      (key) =>
        /^[a-z][a-z0-9-]{0,62}$/.test(key) &&
        typeof left[key] === "string" &&
        /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,253}[A-Za-z0-9])?$/.test(left[key]) &&
        !/[%_]/.test(left[key]) &&
        left[key] === right[key],
    )
  );
}

function validComposeFiles(files) {
  const match = /^(\/opt\/spx-staging\/release\/[0-9a-f]{40}\/operator)\/docker-compose\.yml$/.exec(
    files?.[0] ?? "",
  );
  return Boolean(
    Array.isArray(files) &&
    files.length === 2 &&
    match &&
    files[1] === `${match[1]}/docker-compose.staging.yml`,
  );
}

export function evaluateEffectiveStagingConfig(value) {
  const failures = [];
  if (value?.environment !== "staging") failures.push("ENVIRONMENT_INVALID");
  if (value?.project !== "spx-staging") failures.push("PROJECT_INVALID");
  if (value?.database !== "spx_staging") failures.push("DATABASE_INVALID");
  if (!value?.a3HostIdentity || value.a3HostIdentity === value.productionHostIdentity)
    failures.push("HOST_IDENTITY_INVALID");
  if (
    value?.signedA3HostIdentity !== undefined &&
    value.a3HostIdentity !== value.signedA3HostIdentity
  )
    failures.push("HOST_IDENTITY_BINDING_INVALID");
  if (value?.envFile !== "/etc/spx-staging/runtime.env") failures.push("ENV_FILE_INVALID");
  if (!validComposeFiles(value?.composeFiles)) failures.push("COMPOSE_FILES_INVALID");
  if (!/^sha256:[0-9a-f]{64}$/.test(value?.candidateImageId ?? ""))
    failures.push("CANDIDATE_IMAGE_INVALID");
  if (
    !Array.isArray(value?.serviceImageIds) ||
    value.serviceImageIds.length === 0 ||
    value.serviceImageIds.some((imageId) => imageId !== value.candidateImageId)
  )
    failures.push("SERVICE_IMAGE_MISMATCH");
  if (!Array.isArray(value?.mutableImageTags) || value.mutableImageTags.length > 0)
    failures.push("MUTABLE_IMAGE_TAG_PRESENT");
  if (!value?.dbFingerprint || value.dbFingerprint === value.productionDbFingerprint)
    failures.push("DATABASE_TARGET_COLLISION");
  if (!sameObject(value?.accountHosts, value?.signedAccountHosts))
    failures.push("ACCOUNT_HOST_BINDING_INVALID");
  if (
    !Array.isArray(value?.nodeIds) ||
    value.nodeIds.length === 0 ||
    new Set(value.nodeIds).size !== value.nodeIds.length ||
    value.nodeIds.some((nodeId) => typeof nodeId !== "string" || !nodeId.startsWith("stg-"))
  )
    failures.push("NODE_ID_INVALID");
  if (value?.signedNodeIds !== undefined && !sameArray(value.nodeIds, value.signedNodeIds))
    failures.push("NODE_ID_BINDING_INVALID");
  if (
    !Array.isArray(value?.publishedPorts) ||
    value.publishedPorts.some(
      (entry) =>
        entry?.host !== "127.0.0.1" ||
        !Number.isSafeInteger(entry?.port) ||
        !value?.signedPublishedPorts?.includes(entry.port),
    ) ||
    value.publishedPorts.length !== value?.signedPublishedPorts?.length ||
    value.portCollision === true
  )
    failures.push("PUBLISHED_PORT_INVALID");
  if (
    !Array.isArray(value?.providerTargetFingerprints) ||
    value.providerTargetFingerprints.length === 0 ||
    value.providerTargetFingerprints.some((fingerprint) =>
      value?.productionProviderTargetFingerprints?.includes(fingerprint),
    )
  )
    failures.push("PROVIDER_TARGET_COLLISION");
  if (
    value?.signedProviderTargetFingerprints !== undefined &&
    !sameArray(value.providerTargetFingerprints, value.signedProviderTargetFingerprints)
  )
    failures.push("PROVIDER_TARGET_BINDING_INVALID");
  if (value?.volumeOwners?.some((owner) => owner !== "spx-staging"))
    failures.push("VOLUME_OWNER_INVALID");
  if (value?.networkOwners?.some((owner) => owner !== "spx-staging"))
    failures.push("NETWORK_OWNER_INVALID");
  if (value?.bindMounts?.some((path) => typeof path !== "string" || !path.startsWith("/var/lib/spx-staging")))
    failures.push("BIND_MOUNT_INVALID");
  if (value?.dockerContext !== "default" || value?.dockerHost) failures.push("DOCKER_TARGET_INVALID");
  if (value?.productionSshKeyPresent || value?.productionMutationCredentialPresent)
    failures.push("PRODUCTION_CREDENTIAL_PRESENT");
  if (
    value?.serviceNames !== undefined &&
    (!Array.isArray(value.serviceNames) ||
      value.serviceNames.length === 0 ||
      value.serviceNames.some((service) => !STAGING_STOP_SERVICE_ALLOWLIST.includes(service)))
  )
    failures.push("SERVICE_SET_INVALID");
  return { ok: failures.length === 0, failures };
}

export function evaluateStagingPreflightPhase(phase, value) {
  const base = evaluateEffectiveStagingConfig(value);
  const failures = [...base.failures];
  if (!value?.guardLeaseFresh) failures.push("GUARD_LEASE_STALE");
  if (!value?.watchdogLeaseFresh) failures.push("WATCHDOG_LEASE_STALE");
  if (phase === "pre-create") {
    if (value.databaseMutationObserved || value.stagingCatalogPresent)
      failures.push("PRE_CREATE_MUTATION_PRESENT");
  } else if (phase === "pre-migrate") {
    if (!value.stagingCatalogPresent || !value.migratorOnly)
      failures.push("MIGRATOR_BOOTSTRAP_STATE_INVALID");
  } else if (phase === "pre-start") {
    if (
      !value.stagingCatalogPresent ||
      !value.migrationsComplete ||
      !value.principalsFinalized ||
      !value.bootstrapRevoked
    )
      failures.push("PRE_START_DATABASE_STATE_INVALID");
  } else {
    failures.push("PREFLIGHT_PHASE_INVALID");
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

function spawnDocker(args, env) {
  if (process.env.DOCKER_HOST) throw new Error("remote Docker is forbidden");
  const result = spawnSync("docker", args, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
    env: env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("fixed local staging Docker inspection failed");
  }
  return result.stdout.trim();
}

function environmentObject(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return value;
  return Object.fromEntries(
    value.map((entry) => {
      const index = entry.indexOf("=");
      return index < 0 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
}

function stagingAccount(role) {
  return `spx_stg_${role.replaceAll("-", "_")}`;
}

async function collectDatabaseState(context) {
  const configured = mysqlScriptConnectionConfigFromEnv();
  if (configured.missing.length > 0) throw new Error("staging preflight DB observer is unavailable");
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({ ...configured.value, database: undefined });
  try {
    const [catalogRows] = await connection.execute(
      "SELECT COUNT(*) AS catalogCount FROM information_schema.schemata WHERE schema_name = 'spx_staging'",
    );
    const [accountRows] = await connection.execute(
      "SELECT User AS user, Host AS host FROM mysql.user WHERE User LIKE 'spx\\_stg\\_%' ESCAPE '\\\\' ORDER BY User, Host",
    );
    const catalogCount = Number(catalogRows?.[0]?.catalogCount ?? -1);
    if (![0, 1].includes(catalogCount) || !Array.isArray(accountRows)) {
      throw new Error("staging DB preflight result is invalid");
    }
    const signedHosts = context.descriptor.database.accountHosts;
    const expectedAccounts = Object.entries(signedHosts)
      .map(([role, host]) => `${stagingAccount(role)}@${host}`)
      .sort();
    const actualAccounts = accountRows.map((row) => `${row.user}@${row.host}`).sort();
    const migratorAccount = `${stagingAccount("migrator")}@${signedHosts.migrator}`;
    const bootstrapPresent = accountRows.some((row) => row.user === stagingAccount("bootstrap"));
    let migrationsComplete = false;
    if (catalogCount === 1) {
      const [migrationTableRows] = await connection.execute(
        "SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = 'spx_staging' AND table_name = 'schema_migrations'",
      );
      if (Number(migrationTableRows?.[0]?.tableCount) === 1) {
        const [migrationRows] = await connection.execute(
          "SELECT name, checksum_sha256 AS checksum, status FROM spx_staging.schema_migrations ORDER BY name",
        );
        migrationsComplete = context.envelope.migrations.every((expected) =>
          migrationRows.some(
            (actual) =>
              actual.name === expected.filename &&
              actual.checksum === expected.sha256 &&
              actual.status === "applied",
          ),
        );
      }
    }
    return {
      databaseMutationObserved: catalogCount !== 0 || accountRows.length !== 0,
      stagingCatalogPresent: catalogCount === 1,
      migratorOnly:
        actualAccounts.length === 1 && actualAccounts[0] === migratorAccount && !bootstrapPresent,
      migrationsComplete,
      principalsFinalized: canonicalJson(actualAccounts) === canonicalJson(expectedAccounts),
      bootstrapRevoked: !bootstrapPresent,
    };
  } finally {
    await connection.end();
  }
}

async function collectLiveEffectiveConfig(context, phase, leases, operatorRoot) {
  const descriptor = context.descriptor;
  const composeEnv = buildInstalledStagingComposeEnvironment(
    context.installedBinding,
    operatorRoot,
  );
  const configSource = spawnDocker(
    [...buildInstalledStagingComposePrefix(operatorRoot), "config", "--format", "json"],
    composeEnv,
  );
  const config = JSON.parse(configSource);
  if (!config?.services || typeof config.services !== "object") {
    throw new Error("effective staging Compose config is invalid");
  }
  if (spawnDocker(["context", "show"]) !== "default") {
    throw new Error("only the local default Docker context is allowed");
  }
  const services = Object.entries(config.services);
  const serviceNames = services.map(([name]) => name).sort();
  const imageReferences = [...new Set(services.map(([, service]) => service.image))];
  if (imageReferences.some((image) => typeof image !== "string" || image.length === 0)) {
    throw new Error("effective staging image reference is invalid");
  }
  const serviceImageIds = imageReferences.map((image) =>
    spawnDocker(["image", "inspect", "--format", "{{.Id}}", image]),
  );
  const nodeIds = services
    .map(([, service]) => environmentObject(service.environment).SPX_NODE_ID)
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort();
  const publishedPorts = services
    .flatMap(([, service]) => service.ports ?? [])
    .map((port) => ({
      host: port.host_ip ?? port.hostIp ?? "",
      port: Number(port.published),
    }))
    .sort((left, right) => left.port - right.port);
  const bindMounts = services.flatMap(([, service]) =>
    (service.volumes ?? [])
      .filter((volume) => volume.type === "bind")
      .map((volume) => volume.source),
  );
  const volumeOwners = Object.values(config.volumes ?? {}).map((volume) =>
    String(volume.name ?? "").startsWith("spx-staging") ? "spx-staging" : "external",
  );
  const networkOwners = Object.values(config.networks ?? {}).map((network) =>
    String(network.name ?? "").startsWith("spx-staging") ? "spx-staging" : "external",
  );
  const hostIdentity = (await readFile("/etc/spx-staging/host-identity.sha256", "utf8")).trim();
  const forbiddenNames = Object.keys(process.env).filter((name) =>
    /PROD(?:UCTION)?.*(?:SSH|DOCKER|ADMIN|MUTATION|API.*(?:KEY|TOKEN))/i.test(name),
  );
  const databaseState = await collectDatabaseState(context, phase);
  return {
    environment: descriptor.runtimeEnvironment,
    project: descriptor.composeProject,
    database: descriptor.database.name,
    a3HostIdentity: hostIdentity,
    signedA3HostIdentity: descriptor.target.hostIdentitySha256,
    productionHostIdentity: descriptor.productionDenyTargetSha256,
    envFile: descriptor.target.canonicalPaths.environmentFile,
    composeFiles: [`${operatorRoot}/docker-compose.yml`, `${operatorRoot}/docker-compose.staging.yml`],
    candidateImageId: descriptor.imageId,
    serviceImageIds,
    mutableImageTags: imageReferences.filter(
      (image) => image !== descriptor.imageTag && image !== descriptor.imageId,
    ),
    dbFingerprint: descriptor.database.tlsFingerprintSha256,
    productionDbFingerprint: descriptor.productionDenyTargetSha256,
    accountHosts: descriptor.database.accountHosts,
    signedAccountHosts: descriptor.database.accountHosts,
    nodeIds,
    signedNodeIds: [...descriptor.nodeIds].sort(),
    publishedPorts,
    signedPublishedPorts: [...descriptor.publishedPorts].sort((left, right) => left - right),
    portCollision: false,
    providerTargetFingerprints: descriptor.providerTargetFingerprints,
    signedProviderTargetFingerprints: descriptor.providerTargetFingerprints,
    productionProviderTargetFingerprints: [descriptor.productionDenyTargetSha256],
    volumeOwners,
    networkOwners,
    bindMounts,
    dockerContext: "default",
    dockerHost: process.env.DOCKER_HOST ?? null,
    productionSshKeyPresent: forbiddenNames.some((name) => /SSH/i.test(name)),
    productionMutationCredentialPresent: forbiddenNames.some((name) => !/SSH/i.test(name)),
    guardLeaseFresh:
      leases.guard?.state === "armed" && leases.guard.heartbeatAgeMs <= leases.maxAgeMs,
    watchdogLeaseFresh:
      leases.watchdog?.state === "armed" && leases.watchdog.heartbeatAgeMs <= leases.maxAgeMs,
    serviceNames,
    ...databaseState,
  };
}

export async function runInstalledStagingPreflight(phase, ports = {}) {
  if (!new Set(["pre-create", "pre-migrate", "pre-start"]).has(phase)) {
    throw new Error("staging preflight phase is invalid");
  }
  const loadContext = ports.loadContext ?? loadInstalledApprovedStagingContext;
  const loadLeases = ports.loadLeases ?? loadStagingLeases;
  const collectConfig = ports.collectConfig ?? collectLiveEffectiveConfig;
  const context = await loadContext();
  const stagingRunId = context?.installedBinding?.stagingRunId;
  if (!stagingRunId) throw new Error("installed staging run is unavailable");
  const leases = await loadLeases(stagingRunId);
  if (leases?.stagingRunId !== stagingRunId) throw new Error("staging lease run changed");
  const operatorRoot = ports.collectConfig
    ? undefined
    : await loadInstalledStagingOperatorRoot(context.installedBinding);
  const value = await collectConfig(context, phase, leases, operatorRoot);
  return evaluateStagingPreflightPhase(phase, value);
}

async function main() {
  try {
    if (process.argv.length !== 3 || !process.argv[2].startsWith("--phase=")) {
      throw new Error("a fixed staging preflight phase is required");
    }
    const phase = process.argv[2].slice("--phase=".length);
    const result = await runInstalledStagingPreflight(phase);
    console.log(canonicalJson(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["STAGING_PREFLIGHT_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("a3-staging-preflight.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
