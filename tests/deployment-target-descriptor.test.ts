import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAGING_DEPLOYMENT_TARGET_DB_ROLES,
  buildDeploymentTargetDescriptor,
  deploymentTargetDescriptorArtifactSha256,
  deploymentTargetFactsSha256,
  signDeploymentTargetDescriptor,
  validateDeploymentTargetFacts,
  verifyDeploymentTargetDescriptor,
} from "../src/services/deployment-target-descriptor.js";
import {
  buildBuildManifest,
  canonicalJson,
  finalizeReleaseManifest,
  sha256Hex,
} from "../src/services/release-manifest.js";
import {
  OPERATOR_BUNDLE_STATIC_FILES,
  buildOperatorBundle,
} from "../scripts/build-operator-bundle.mjs";
import { STAGING_PROVISIONED_DB_ROLES } from "../scripts/lib/staging-action-capability.mjs";

const fixture = JSON.parse(
  readFileSync("tests/fixtures/deployment-target-descriptor.complete.json", "utf8"),
);
const signerWorkflowSource = readFileSync(
  ".github/workflows/deployment-target-descriptor-signer.yml",
  "utf8",
);
const signerWorkflowSha256 = createHash("sha256").update(signerWorkflowSource).digest("hex");
fixture.signingWorkflowFileSha256 = signerWorkflowSha256;
fixture.releaseSourceSha = fixture.imageTag.slice("spx-app:".length);
fixture.targetFactsSha256 = deploymentTargetFactsSha256(fixture);
const descriptor = buildDeploymentTargetDescriptor(fixture);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const artifact = signDeploymentTargetDescriptor(descriptor, {
  keyId: "spx-staging-descriptor-test-1",
  privateKey,
});
const artifactSha256 = deploymentTargetDescriptorArtifactSha256(artifact);
const attestation = {
  schemaVersion: 1,
  artifactSha256,
  repository: fixture.signing.repository,
  workflowRef: fixture.signing.workflowRef,
  environment: fixture.signing.environment,
  subject: fixture.signing.subject,
  audience: fixture.signing.audience,
  issuer: fixture.signing.issuer,
  jobWorkflowRef: fixture.signing.jobWorkflowRef,
  jobWorkflowSha: fixture.signing.jobWorkflowSha,
  signingWorkflowSourceSha: fixture.signingWorkflowSourceSha,
  signingWorkflowFileSha256: fixture.signingWorkflowFileSha256,
  issuedAt: fixture.issuedAt,
};
const trust = {
  keyId: "spx-staging-descriptor-test-1",
  publicKey,
  repository: fixture.signing.repository,
  workflowRef: fixture.signing.workflowRef,
  environment: "staging" as const,
  subject: fixture.signing.subject,
  audience: fixture.signing.audience,
  issuer: fixture.signing.issuer,
  jobWorkflowRef: fixture.signing.jobWorkflowRef,
  signingWorkflowSourceSha: fixture.signingWorkflowSourceSha,
  signingWorkflowFileSha256: fixture.signingWorkflowFileSha256,
  releaseManifestSha256: fixture.releaseManifestSha256,
  operatorBundleSha256: fixture.operatorBundleSha256,
  releaseSourceSha: fixture.releaseSourceSha,
  imageId: fixture.imageId,
  imageTag: fixture.imageTag,
  targetFactsSha256: fixture.targetFactsSha256,
  now: new Date("2026-07-10T12:05:00.000Z"),
};

assert.deepEqual(verifyDeploymentTargetDescriptor({ artifact, attestation, trust }), descriptor);
assert.equal("signature" in descriptor, false);
assert.equal(descriptor.releaseEnvironment, "staging");
assert.equal(descriptor.runtimeEnvironment, "staging");
assert.equal(descriptor.deploymentUnit, "primary");
assert.equal(descriptor.composeProject, "spx-staging");
assert.equal(
  descriptor.target.productionObserverPolicySha256,
  "05bf8910d8f678b984a6e82abe2abd9aba717a5eda31408bcc5d590d4e88aae8",
);
assert.equal(descriptor.database.accountHosts["line-service"], "172.17.0.1");
assert.equal("ocr-service" in descriptor.database.accountHosts, false);
assert.deepEqual(STAGING_DEPLOYMENT_TARGET_DB_ROLES, STAGING_PROVISIONED_DB_ROLES);
assert.deepEqual(Object.keys(descriptor.database.accountHosts).sort(), [
  ...STAGING_PROVISIONED_DB_ROLES,
].sort());
const descriptorSchema = JSON.parse(
  readFileSync("deploy/deployment-target-descriptor.schema.json", "utf8"),
);
const stagingSchema = descriptorSchema.$defs.descriptor.allOf[0].then.properties;
assert.deepEqual(
  [...stagingSchema.database.properties.accountHosts.required].sort(),
  [...STAGING_PROVISIONED_DB_ROLES].sort(),
);
assert.deepEqual(
  [...stagingSchema.database.properties.accountHosts.propertyNames.enum].sort(),
  [...STAGING_PROVISIONED_DB_ROLES].sort(),
);
assert.equal(
  descriptorSchema.$defs.descriptor.properties.target.required.includes(
    "productionObserverPolicySha256",
  ),
  true,
);

const wrapperWorkflowSource = readFileSync(
  ".github/workflows/deployment-target-descriptor.yml",
  "utf8",
);
const descriptorCliSource = readFileSync("scripts/deployment-target-descriptor.mjs", "utf8");
assert.doesNotMatch(
  wrapperWorkflowSource,
  /deploy_topology:|composeProject:|dbFingerprint:|providerTarget/i,
);
const prepareRequestJob = wrapperWorkflowSource.match(
  /\n {2}prepare-request:[\s\S]*?\n {2}sign-request:/,
)?.[0];
assert.ok(prepareRequestJob);
assert.doesNotMatch(
  prepareRequestJob,
  /id-token:\s*write|attestations:\s*write|SPX_DESCRIPTOR_SIGNER_URL|KMS/i,
);
assert.doesNotMatch(wrapperWorkflowSource, /actions\/checkout/);
assert.match(wrapperWorkflowSource, /descriptor-request/);
assert.match(wrapperWorkflowSource, /release_run_id/);
assert.match(wrapperWorkflowSource, /deployment_unit:/);
assert.match(wrapperWorkflowSource, /DEPLOYMENT_UNIT: \$\{\{ inputs\.deployment_unit \}\}/);
assert.match(
  wrapperWorkflowSource,
  /sign-request:[\s\S]*uses:\s*fastest4u\/SPX\/\.github\/workflows\/deployment-target-descriptor-signer\.yml@[0-9a-f]{40}/,
);
assert.match(signerWorkflowSource, /ref:\s*\$\{\{ job\.workflow_sha \}\}/);
assert.doesNotMatch(signerWorkflowSource, /ref:\s*\$\{\{ inputs\.source_sha \}\}/);
assert.doesNotMatch(signerWorkflowSource, /job_workflow_ref\.startsWith|expectedWorkflowPrefix/);
assert.match(signerWorkflowSource, /job_workflow_ref[^\n]+@\[0-9a-f\]\{40\}/);
assert.match(signerWorkflowSource, /environment:\s+\$\{\{ inputs\.target \}\}/);
assert.match(signerWorkflowSource, /job\.workflow_sha/);
assert.match(signerWorkflowSource, /job_workflow_ref/);
assert.match(signerWorkflowSource, /job_workflow_sha/);
assert.match(signerWorkflowSource, /SPX_DESCRIPTOR_SIGNER_URL/);
assert.match(signerWorkflowSource, /SPX_DESCRIPTOR_TEAM2_TARGET_FACTS_B64/);
assert.match(signerWorkflowSource, /request\.deploymentUnit !== process\.env\.EXPECTED_DEPLOYMENT_UNIT/);
assert.match(signerWorkflowSource, /run-id:\s+\$\{\{ inputs\.request_run_id \}\}/);
assert.match(signerWorkflowSource, /run-id:\s+\$\{\{ inputs\.release_run_id \}\}/);
assert.match(signerWorkflowSource, /github-token:\s+\$\{\{ github\.token \}\}/);
assert.match(signerWorkflowSource, /actions\/attest-build-provenance@[0-9a-f]{40}/);
assert.match(signerWorkflowSource, /build-operator-bundle\.mjs materialize/);
assert.match(signerWorkflowSource, /--operator-root="\$\{OPERATOR_TEMP_ROOT\}\/root"/);
assert.doesNotMatch(signerWorkflowSource, /cd "?\$\{OPERATOR_TEMP_ROOT\}/);
assert.match(signerWorkflowSource, /deployment-target-descriptor\.mjs verify/);
const materializeFactsOffset = signerWorkflowSource.indexOf(
  "- name: Materialize protected target facts",
);
const strictFactsOffset = signerWorkflowSource.indexOf(
  "deployment-target-descriptor.mjs validate-facts",
);
const oidcOffset = signerWorkflowSource.indexOf(
  "- name: Request OIDC and preserve actual immutable issuer provenance",
);
assert.ok(materializeFactsOffset >= 0);
assert.ok(strictFactsOffset > materializeFactsOffset);
assert.ok(oidcOffset > strictFactsOffset, "strict protected facts must fail before OIDC");
assert.doesNotMatch(signerWorkflowSource, /PRIVATE_KEY/);
assert.doesNotMatch(signerWorkflowSource, /const trust = \{[^}]*\.\.\.provenance/s);
assert.doesNotMatch(signerWorkflowSource, /readFileSync/);
assert.match(descriptorCliSource, /"attestation",\s*"verify"/);
assert.match(descriptorCliSource, /GitHub artifact attestation verification failed/);
assert.doesNotMatch(descriptorCliSource, /verify-signature/);
for (const source of [wrapperWorkflowSource, signerWorkflowSource]) {
  assert.doesNotMatch(source, /ubuntu-latest|@[A-Za-z][A-Za-z0-9._-]*$/m);
  for (const match of source.matchAll(/uses:\s+([^\s]+)/g)) {
    assert.equal(match[1].startsWith("./"), false, `local workflow call is forbidden: ${match[1]}`);
    assert.match(match[1], /@[0-9a-f]{40}$/, `action must be SHA-pinned: ${match[1]}`);
  }
}

assert.throws(
  () => buildDeploymentTargetDescriptor({ ...fixture, callerOverride: "production" }),
  /unknown field/,
);
assert.throws(
  () => buildDeploymentTargetDescriptor({ ...fixture, composeProject: "spx-production" }),
  /composeProject/,
);
assert.throws(
  () =>
    buildDeploymentTargetDescriptor({
      ...fixture,
      target: { ...fixture.target, productionObserverPolicySha256: null },
    }),
  /productionObserverPolicySha256/,
);
assert.throws(
  () =>
    buildDeploymentTargetDescriptor({
      ...fixture,
      target: { ...fixture.target, productionObserverPolicySha256: "A".repeat(64) },
    }),
  /productionObserverPolicySha256/,
);
assert.throws(
  () =>
    buildDeploymentTargetDescriptor({
      ...fixture,
      target: { ...fixture.target, productionObserverPolicySha256: "7".repeat(64) },
    }),
  /targetFactsSha256/,
);
const fixtureWithoutObserverHash = structuredClone(fixture);
delete fixtureWithoutObserverHash.target.productionObserverPolicySha256;
assert.throws(
  () => buildDeploymentTargetDescriptor(fixtureWithoutObserverHash),
  /productionObserverPolicySha256|missing required field/,
);
assert.throws(
  () =>
    buildDeploymentTargetDescriptor({
      ...fixture,
      database: {
        ...fixture.database,
        accountHosts: { ...fixture.database.accountHosts, "line-service": "%" },
      },
    }),
  /accountHosts/,
);
for (const accountHosts of [
  Object.fromEntries(
    Object.entries(fixture.database.accountHosts).filter(([role]) => role !== "phase3-observer"),
  ),
  { ...fixture.database.accountHosts, "phase3-observer": "%" },
  { ...fixture.database.accountHosts, unexpected: "172.17.0.1" },
]) {
  assert.throws(
    () =>
      buildDeploymentTargetDescriptor({
        ...fixture,
        database: { ...fixture.database, accountHosts },
      }),
    /accountHosts|phase3-observer|role/i,
  );
}

const alternatePolicyFacts = structuredClone(fixture);
alternatePolicyFacts.target.productionObserverPolicySha256 = "7".repeat(64);
assert.notEqual(
  deploymentTargetFactsSha256(alternatePolicyFacts),
  fixture.targetFactsSha256,
  "the observer policy digest must participate in signed target facts",
);

const protectedFacts = {
  releaseEnvironment: fixture.releaseEnvironment,
  runtimeEnvironment: fixture.runtimeEnvironment,
  deploymentUnit: fixture.deploymentUnit,
  composeProject: fixture.composeProject,
  topology: fixture.topology,
  target: fixture.target,
  database: fixture.database,
  providerTargetFingerprints: fixture.providerTargetFingerprints,
  publishedPorts: fixture.publishedPorts,
  volumeFingerprints: fixture.volumeFingerprints,
  nodeIds: fixture.nodeIds,
  productionDenyTargetSha256: fixture.productionDenyTargetSha256,
  signing: {
    repository: fixture.signing.repository,
    environment: fixture.signing.environment,
    subject: fixture.signing.subject,
    audience: fixture.signing.audience,
    issuer: fixture.signing.issuer,
  },
};
assert.equal(validateDeploymentTargetFacts(protectedFacts, "staging"), true);
for (const invalidFacts of [
  { ...protectedFacts, unknown: true },
  { ...protectedFacts, releaseEnvironment: "production" },
  {
    ...protectedFacts,
    target: { ...protectedFacts.target, productionObserverPolicySha256: null },
  },
  {
    ...protectedFacts,
    database: {
      ...protectedFacts.database,
      accountHosts: { ...protectedFacts.database.accountHosts, "phase3-observer": "%" },
    },
  },
  {
    ...protectedFacts,
    database: {
      ...protectedFacts.database,
      accountHosts: Object.fromEntries(
        Object.entries(protectedFacts.database.accountHosts).filter(
          ([role]) => role !== "phase3-observer",
        ),
      ),
    },
  },
]) {
  assert.throws(
    () => validateDeploymentTargetFacts(invalidFacts, "staging"),
    /protected target facts|environment|productionObserverPolicySha256|accountHosts/i,
  );
}
const missingProtectedFacts = structuredClone(protectedFacts);
delete missingProtectedFacts.target.productionObserverPolicySha256;
assert.throws(
  () => validateDeploymentTargetFacts(missingProtectedFacts, "staging"),
  /productionObserverPolicySha256|missing/i,
);

const productionInput = structuredClone(fixture);
productionInput.descriptorId = "dtd-production-a3-20260710-01";
productionInput.releaseEnvironment = "production";
productionInput.runtimeEnvironment = "production";
productionInput.composeProject = "spx-production";
productionInput.target.productionObserverPolicySha256 = null;
productionInput.target.canonicalPaths = {
  releaseRoot: "/opt/spx-production/release",
  environmentFile: "/etc/spx-production/runtime.env",
  stateRoot: "/var/lib/spx-production-rollout",
};
productionInput.database = {
  ...productionInput.database,
  name: "spx",
  accountHosts: { "web-api": "172.17.0.1" },
};
productionInput.signing = {
  ...productionInput.signing,
  environment: "production",
  subject: "repo:example/SPX:environment:production",
};
productionInput.targetFactsSha256 = deploymentTargetFactsSha256(productionInput);
assert.equal(
  buildDeploymentTargetDescriptor(productionInput).target.productionObserverPolicySha256,
  null,
);
const team2ProductionFacts = structuredClone(productionInput);
team2ProductionFacts.deploymentUnit = "team2";
team2ProductionFacts.publishedPorts = [];
team2ProductionFacts.database.accountHosts = { "worker-ifn-split": "172.17.0.1" };
team2ProductionFacts.nodeIds = ["prod-worker-ifn-node2"];
team2ProductionFacts.target.canonicalPaths = {
  releaseRoot: "/opt/spx-production-team2",
  environmentFile: "/etc/spx-production/runtime.env",
  stateRoot: "/var/lib/spx-production-team2-rollout",
};
team2ProductionFacts.targetFactsSha256 = deploymentTargetFactsSha256(team2ProductionFacts);
assert.equal(buildDeploymentTargetDescriptor(team2ProductionFacts).deploymentUnit, "team2");
assert.deepEqual(buildDeploymentTargetDescriptor(team2ProductionFacts).publishedPorts, []);
assert.deepEqual(
  buildDeploymentTargetDescriptor(team2ProductionFacts).target.canonicalPaths,
  team2ProductionFacts.target.canonicalPaths,
);
const invalidPrimaryWithoutPorts = structuredClone(productionInput);
invalidPrimaryWithoutPorts.publishedPorts = [];
assert.throws(
  () => buildDeploymentTargetDescriptor(invalidPrimaryWithoutPorts),
  /publishedPorts/,
);
const invalidStagingTeam2 = structuredClone(fixture);
invalidStagingTeam2.deploymentUnit = "team2";
assert.throws(
  () => buildDeploymentTargetDescriptor(invalidStagingTeam2),
  /deploymentUnit/,
);
const productionWithObserverHash = structuredClone(productionInput);
productionWithObserverHash.target.productionObserverPolicySha256 = "7".repeat(64);
assert.throws(
  () => buildDeploymentTargetDescriptor(productionWithObserverHash),
  /productionObserverPolicySha256/,
);
assert.throws(
  () =>
    buildDeploymentTargetDescriptor({
      ...fixture,
      signing: {
        ...fixture.signing,
        jobWorkflowRef:
          "example/SPX/.github/workflows/deployment-target-descriptor-signer.yml@main",
      },
    }),
  /exact source SHA/,
);
assert.throws(
  () =>
    verifyDeploymentTargetDescriptor({
      artifact: { ...artifact, descriptor: { ...artifact.descriptor, topology: "legacy" } },
      attestation,
      trust,
    }),
  /targetFactsSha256|descriptor hash|signature/,
);
assert.throws(
  () =>
    verifyDeploymentTargetDescriptor({
      artifact,
      attestation: { ...attestation, jobWorkflowSha: "9".repeat(40) },
      trust,
    }),
  /attestation.*jobWorkflowSha/,
);
assert.throws(
  () =>
    verifyDeploymentTargetDescriptor({
      artifact,
      attestation,
      trust: { ...trust, releaseManifestSha256: "9".repeat(64) },
    }),
  /release manifest/,
);
assert.throws(
  () =>
    verifyDeploymentTargetDescriptor({
      artifact,
      attestation,
      trust: { ...trust, now: new Date("2026-07-10T12:11:00.000Z") },
    }),
  /expired/,
);

const protectedTargetAlternates = [
  { ...fixture, topology: "legacy" },
  {
    ...fixture,
    target: { ...fixture.target, hostIdentitySha256: "0".repeat(64) },
  },
  {
    ...fixture,
    target: { ...fixture.target, networkIdentitySha256: "9".repeat(64) },
  },
  {
    ...fixture,
    target: { ...fixture.target, approvedSourceCidrsSha256: "8".repeat(64) },
  },
  {
    ...fixture,
    database: { ...fixture.database, tlsFingerprintSha256: "7".repeat(64) },
  },
  {
    ...fixture,
    database: {
      ...fixture.database,
      accountHosts: { ...fixture.database.accountHosts, "line-service": "172.17.0.2" },
    },
  },
  { ...fixture, providerTargetFingerprints: ["6".repeat(64)] },
  { ...fixture, publishedPorts: [13000, 13002, 13003, 13004, 13006] },
  { ...fixture, volumeFingerprints: ["7".repeat(64)] },
  { ...fixture, nodeIds: [...fixture.nodeIds, "stg-worker-new-a3"] },
  { ...fixture, productionDenyTargetSha256: "8".repeat(64) },
];
for (const alternateInput of protectedTargetAlternates) {
  alternateInput.targetFactsSha256 = deploymentTargetFactsSha256(alternateInput);
  const alternateArtifact = signDeploymentTargetDescriptor(
    buildDeploymentTargetDescriptor(alternateInput),
    { keyId: trust.keyId, privateKey },
  );
  assert.throws(
    () =>
      verifyDeploymentTargetDescriptor({
        artifact: alternateArtifact,
        attestation: {
          ...attestation,
          artifactSha256: deploymentTargetDescriptorArtifactSha256(alternateArtifact),
        },
        trust,
      }),
    /protected target facts digest/,
  );
}

const alternateSource = "9".repeat(40);
const sourceChangedInput = {
  ...fixture,
  releaseSourceSha: alternateSource,
  imageTag: `spx-app:${alternateSource}`,
};
const sourceChangedArtifact = signDeploymentTargetDescriptor(
  buildDeploymentTargetDescriptor(sourceChangedInput),
  { keyId: trust.keyId, privateKey },
);
const sourceChangedAttestation = {
  ...attestation,
  artifactSha256: deploymentTargetDescriptorArtifactSha256(sourceChangedArtifact),
};
assert.throws(
  () =>
    verifyDeploymentTargetDescriptor({
      artifact: sourceChangedArtifact,
      attestation: sourceChangedAttestation,
      trust,
    }),
  /release source SHA/,
);
assert.throws(
  () =>
    verifyDeploymentTargetDescriptor({
      artifact: sourceChangedArtifact,
      attestation: sourceChangedAttestation,
      trust: { ...trust, releaseSourceSha: alternateSource },
    }),
  /release image tag/,
);

const imageChangedArtifact = signDeploymentTargetDescriptor(
  buildDeploymentTargetDescriptor({
    ...fixture,
    imageId: `sha256:${"8".repeat(64)}`,
  }),
  { keyId: trust.keyId, privateKey },
);
assert.throws(
  () =>
    verifyDeploymentTargetDescriptor({
      artifact: imageChangedArtifact,
      attestation: {
        ...attestation,
        artifactSha256: deploymentTargetDescriptorArtifactSha256(imageChangedArtifact),
      },
      trust,
    }),
  /release image ID/,
);

const cliTemp = mkdtempSync(join(tmpdir(), "spx-target-descriptor-cli-"));
try {
  const operatorRoot = join(cliTemp, "operator-root");
  const operatorOut = join(cliTemp, "operator-out");
  mkdirSync(operatorRoot, { recursive: true });
  mkdirSync(operatorOut, { recursive: true });
  const putOperator = (path: string, value: string | Buffer): void => {
    const full = join(operatorRoot, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, value);
  };
  for (const path of OPERATOR_BUNDLE_STATIC_FILES) {
    if (path === "migrations/released-checksums.json") continue;
    putOperator(path, `fixture:${path}\n`);
  }
  const migrationBytes = Buffer.from("SELECT 1;\n", "utf8");
  const migrationSha256 = sha256Hex(migrationBytes);
  putOperator("migrations/031_example.sql", migrationBytes);
  putOperator(
    "migrations/released-checksums.json",
    canonicalJson({ "031_example.sql": migrationSha256 }),
  );
  const operatorArchive = join(operatorOut, "operator-bundle.tar");
  const operatorIndex = join(operatorOut, "operator-bundle.index.json");
  const operatorBundle = buildOperatorBundle({
    root: operatorRoot,
    archivePath: operatorArchive,
    indexPath: operatorIndex,
  });
  const cliBuild = buildBuildManifest({
    version: "1.0.0",
    sourceSha: "a".repeat(40),
    buildId: "run-cli-1",
    artifactSha256: "c".repeat(64),
    operatorBundleSha256: operatorBundle.operatorBundleSha256,
    schema: { min: 31, max: 31 },
    migrations: [{ name: "031_example.sql", sha256: migrationSha256 }],
  });
  const cliRelease = finalizeReleaseManifest({
    build: cliBuild,
    imageId: "sha256:" + "b".repeat(64),
    imageTag: "spx-app:" + "a".repeat(40),
  });
  const releaseBytes = Buffer.from(canonicalJson(cliRelease), "utf8");
  const files = {
    release: join(cliTemp, "release.json"),
    mismatchedRelease: join(cliTemp, "mismatched-release.json"),
    facts: join(cliTemp, "target-facts.json"),
    invalidFacts: join(cliTemp, "invalid-target-facts.json"),
    provenance: join(cliTemp, "signer-provenance.json"),
    unsigned: join(cliTemp, "unsigned-descriptor.json"),
  };
  writeFileSync(files.release, releaseBytes);
  const mismatchedBuild = buildBuildManifest({
    ...cliBuild,
    schema: { min: 32, max: 32 },
    migrations: [{ name: "032_other.sql", sha256: "2".repeat(64) }],
    migrationSetSha256: undefined,
  });
  const mismatchedRelease = finalizeReleaseManifest({
    build: mismatchedBuild,
    imageId: cliRelease.imageId,
    imageTag: cliRelease.imageTag,
  });
  writeFileSync(files.mismatchedRelease, canonicalJson(mismatchedRelease));
  const staticFacts = {
    releaseEnvironment: fixture.releaseEnvironment,
    runtimeEnvironment: fixture.runtimeEnvironment,
    deploymentUnit: fixture.deploymentUnit,
    composeProject: fixture.composeProject,
    topology: fixture.topology,
    target: fixture.target,
    database: fixture.database,
    providerTargetFingerprints: fixture.providerTargetFingerprints,
    publishedPorts: fixture.publishedPorts,
    volumeFingerprints: fixture.volumeFingerprints,
    nodeIds: fixture.nodeIds,
    productionDenyTargetSha256: fixture.productionDenyTargetSha256,
    signing: {
      repository: fixture.signing.repository,
      environment: fixture.signing.environment,
      subject: fixture.signing.subject,
      audience: fixture.signing.audience,
      issuer: fixture.signing.issuer,
    },
  };
  writeFileSync(files.facts, canonicalJson(staticFacts));
  writeFileSync(files.invalidFacts, canonicalJson({ ...staticFacts, unknown: true }));
  writeFileSync(files.provenance, canonicalJson(fixture.signing));
  const validateFactsRun = spawnSync(
    process.execPath,
    [
      "scripts/deployment-target-descriptor.mjs",
      "validate-facts",
      `--facts=${files.facts}`,
      "--environment=staging",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(validateFactsRun.status, 0, validateFactsRun.stderr);
  assert.deepEqual(JSON.parse(validateFactsRun.stdout), { ok: true });
  const invalidFactsRun = spawnSync(
    process.execPath,
    [
      "scripts/deployment-target-descriptor.mjs",
      "validate-facts",
      `--facts=${files.invalidFacts}`,
      "--environment=staging",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(invalidFactsRun.status, 0);
  assert.match(invalidFactsRun.stderr, /protected target facts/i);
  const mismatchedMigrationRun = spawnSync(
    process.execPath,
    [
      "scripts/deployment-target-descriptor.mjs",
      "build",
      `--facts=${files.facts}`,
      `--release-manifest=${files.mismatchedRelease}`,
      `--operator-bundle=${operatorArchive}`,
      `--operator-index=${operatorIndex}`,
      "--signing-workflow=.github/workflows/deployment-target-descriptor-signer.yml",
      `--signing-provenance=${files.provenance}`,
      `--release-source-sha=${cliRelease.sourceSha}`,
      "--run-id=12345-0",
      `--output=${join(cliTemp, "mismatched-migration.json")}`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(mismatchedMigrationRun.status, 0);
  assert.match(mismatchedMigrationRun.stderr, /migration set/i);
  const buildCliRun = spawnSync(
    process.execPath,
    [
      "scripts/deployment-target-descriptor.mjs",
      "build",
      `--facts=${files.facts}`,
      `--release-manifest=${files.release}`,
      `--operator-bundle=${operatorArchive}`,
      `--operator-index=${operatorIndex}`,
      "--signing-workflow=.github/workflows/deployment-target-descriptor-signer.yml",
      `--signing-provenance=${files.provenance}`,
      `--release-source-sha=${cliRelease.sourceSha}`,
      "--run-id=12345-1",
      `--output=${files.unsigned}`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(buildCliRun.status, 0, buildCliRun.stderr);
  assert.equal(JSON.parse(buildCliRun.stdout).ok, undefined);
  const builtDescriptor = JSON.parse(readFileSync(files.unsigned, "utf8"));
  assert.match(builtDescriptor.descriptorId, /-12345-1$/);
  assert.equal(builtDescriptor.releaseManifestSha256, sha256Hex(releaseBytes));
  assert.equal(builtDescriptor.operatorBundleSha256, cliRelease.operatorBundleSha256);
  const wrongSourceRun = spawnSync(
    process.execPath,
    [
      "scripts/deployment-target-descriptor.mjs",
      "build",
      `--facts=${files.facts}`,
      `--release-manifest=${files.release}`,
      `--operator-bundle=${operatorArchive}`,
      `--operator-index=${operatorIndex}`,
      "--signing-workflow=.github/workflows/deployment-target-descriptor-signer.yml",
      `--signing-provenance=${files.provenance}`,
      `--release-source-sha=${"9".repeat(40)}`,
      "--run-id=12345-2",
      `--output=${join(cliTemp, "wrong-source.json")}`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(wrongSourceRun.status, 0);
  assert.match(wrongSourceRun.stderr, /release manifest source SHA/);

  const plainBundle = join(cliTemp, "plain-bundle.tar");
  writeFileSync(plainBundle, "not a tar archive");
  const plainBundleRun = spawnSync(
    process.execPath,
    [
      "scripts/deployment-target-descriptor.mjs",
      "build",
      `--facts=${files.facts}`,
      `--release-manifest=${files.release}`,
      `--operator-bundle=${plainBundle}`,
      `--operator-index=${operatorIndex}`,
      "--signing-workflow=.github/workflows/deployment-target-descriptor-signer.yml",
      `--signing-provenance=${files.provenance}`,
      `--release-source-sha=${cliRelease.sourceSha}`,
      "--run-id=12345-3",
      `--output=${join(cliTemp, "plain-bundle.json")}`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(plainBundleRun.status, 0);
  assert.match(plainBundleRun.stderr, /tar|archive|bundle/i);
} finally {
  rmSync(cliTemp, { recursive: true, force: true });
}
