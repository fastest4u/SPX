import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";
import {
  createTestStagingOperationRegistry,
  stagingOperationDescriptor,
} from "../scripts/lib/staging-operation-registry.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import { openInstalledVerifiedStagingRollout } from "../scripts/lib/a3-staging-approved-context.mjs";
import { buildBuildManifest, finalizeReleaseManifest } from "../src/services/release-manifest.js";
import {
  deploymentTargetDescriptorArtifactSha256,
  deploymentTargetFactsSha256,
  signDeploymentTargetDescriptor,
} from "../src/services/deployment-target-descriptor.js";
import {
  openVerifiedStagingRollout,
  verifyStagedStagingRolloutArtifactProvenance,
  verifyEnvelope,
  verifyStagingRolloutEnvelope,
} from "../scripts/staging-rollout-approval-verify.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(repoRoot, "tests", "fixtures", "staging-rollout-envelope.valid.json");
const EXPECTED_ACTION_IDS = [
  "staging-db-bootstrap",
  "staging-db-migrate",
  "staging-db-finalize",
  "staging-db-bootstrap-revoke",
  "staging-runtime-start",
  "staging-gate-1-baseline",
  "staging-controlled-publish",
  "staging-line-fault",
  "staging-line-recovery",
  "staging-ocr-fault",
  "staging-ocr-recovery",
  "staging-worker-forward-handoff",
  "staging-worker-reverse-handoff",
  "staging-gate-2-worker",
  "staging-gate-3-handoff",
  "phase3-consumer-start-disabled",
  "phase3-legacy-lease-release",
  "phase3-poller-start",
  "phase3-publication-enable",
  "phase3-execution-enable",
  "phase3-publication-fence",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
  "staging-gate-4-phase3",
  "phase4-n1-preflight",
  "phase4-n1-start",
  "phase4-n1-verify",
  "phase4-n1-rollback-forward",
  "phase4-n1-stop",
  "phase4-proxy-realtime-start",
  "phase4-singleton-contender-probe",
  "phase4-route-producer",
  "phase4-route-read",
  "phase4-route-stream",
  "phase4-realtime-restart-probe",
  "phase4-route-local-rollback",
  "phase4-route-approved-final",
  "phase4-db-proxy-fault",
  "phase4-db-proxy-recover",
  "phase4-route-final-cleanup-baseline",
  "staging-final-stop",
  "guard-close",
  "staging-guard-emergency-stop",
  "staging-watchdog-emergency-stop",
] as const;
const OBSERVATION_IDS = ["phase3-schema-verify", "phase3-fence-ack-wait"];
const OBSOLETE_GROUPED_ACTION =
  /^(?:staging-phase3-(?:ifn|ptwl|cleanup)|staging-gate-(?:3-phase3|4-phase4))(?:-|$)/;

const EXPECTED_GATE5_ACTION_IDS = Object.freeze([
  "phase4-n1-preflight",
  "phase4-n1-start",
  "phase4-n1-verify",
  "phase4-n1-rollback-forward",
  "phase4-n1-stop",
  "phase4-proxy-realtime-start",
  "phase4-singleton-contender-probe",
  "phase4-route-producer",
  "phase4-route-read",
  "phase4-route-stream",
  "phase4-realtime-restart-probe",
  "phase4-route-local-rollback",
  "phase4-route-approved-final",
  "phase4-db-proxy-fault",
  "phase4-db-proxy-recover",
  "phase4-route-final-cleanup-baseline",
  "staging-final-stop",
  "guard-close",
]);

function unsignedPayload(envelope: Record<string, unknown>) {
  const value = structuredClone(envelope);
  delete value.signature;
  delete value.signedPayloadSha256;
  return value;
}

function signEnvelope(
  envelope: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  const signed = structuredClone(envelope);
  const payload = canonicalJson(unsignedPayload(signed));
  signed.signedPayloadSha256 = sha256Canonical(unsignedPayload(signed));
  signed.signature = sign(null, Buffer.from(payload), privateKey).toString("base64");
  return signed;
}

function signDocument(
  document: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  return signEnvelope(document, privateKey);
}

type ActionEnvelopeFixture = Record<string, unknown> & {
  approvalId: string;
  stagingRunId: string;
  keyId: string;
  actions: Array<Record<string, unknown> & { sequence: number; actionId: string; scope: string }>;
  provenance: {
    repository: string;
    workflow: string;
    workflowSha: string;
    environment: string;
    issuer: string;
    audience: string;
    subject: string;
  };
  release: { candidateSha: string };
};

function buildSignedActionArtifacts(
  envelope: ActionEnvelopeFixture,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  const envelopeSha256 = sha256Canonical(envelope);
  const actionArtifacts: Record<string, Record<string, unknown>> = {};
  const actionAttestations: Record<string, Record<string, unknown>> = {};
  const indexEntries = envelope.actions.map((action: Record<string, unknown>) => {
    const filename = `${String(action.sequence).padStart(3, "0")}-${action.actionId}.action.json`;
    const artifact = signDocument(
      {
        schemaVersion: 1,
        artifactType: "spx-staging-action",
        approvalId: envelope.approvalId,
        stagingRunId: envelope.stagingRunId,
        envelopeSha256,
        action,
        keyId: envelope.keyId,
        signatureAlgorithm: "Ed25519",
        signedPayloadSha256: "",
        signature: "",
      },
      privateKey,
    );
    actionArtifacts[filename] = artifact;
    actionAttestations[filename] = {
      repository: envelope.provenance.repository,
      workflow: envelope.provenance.workflow,
      workflowSha: envelope.provenance.workflowSha,
      environment: envelope.provenance.environment,
      issuer: envelope.provenance.issuer,
      audience: envelope.provenance.audience,
      subject: envelope.provenance.subject,
      subjectDigestSha256: sha256Canonical(artifact),
    };
    return {
      sequence: action.sequence,
      actionId: action.actionId,
      scope: action.scope,
      filename,
      artifactSha256: sha256Canonical(artifact),
    };
  });
  const actionIndex = signDocument(
    {
      schemaVersion: 1,
      artifactType: "spx-staging-action-index",
      approvalId: envelope.approvalId,
      stagingRunId: envelope.stagingRunId,
      envelopeSha256,
      actions: indexEntries,
      keyId: envelope.keyId,
      signatureAlgorithm: "Ed25519",
      signedPayloadSha256: "",
      signature: "",
    },
    privateKey,
  );
  const actionIndexAttestation = {
    repository: envelope.provenance.repository,
    workflow: envelope.provenance.workflow,
    workflowSha: envelope.provenance.workflowSha,
    environment: envelope.provenance.environment,
    issuer: envelope.provenance.issuer,
    audience: envelope.provenance.audience,
    subject: envelope.provenance.subject,
    subjectDigestSha256: sha256Canonical(actionIndex),
  };
  return { actionIndex, actionIndexAttestation, actionArtifacts, actionAttestations };
}

async function main() {
  const installedTrustRoot = await mkdtemp(resolve(tmpdir(), "spx-installed-staging-trust-"));
  process.env.NODE_ENV = "test";
  (globalThis as Record<string, unknown>).__SPX_TEST_INSTALLED_RELEASE_BINDING__ = null;
  const schema = JSON.parse(
    await readFile(resolve(repoRoot, "deploy", "staging-rollout-envelope.schema.json"), "utf8"),
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.release.additionalProperties, false);
  assert.equal(schema.properties.target.additionalProperties, false);
  assert.equal(schema.properties.actions.items.additionalProperties, false);
  assert.equal(REQUIRED_STAGING_ACTION_PLAN.length, 44);
  assert.deepEqual(
    REQUIRED_STAGING_ACTION_PLAN.map((action) => action.actionId),
    EXPECTED_ACTION_IDS,
  );
  assert.equal(
    REQUIRED_STAGING_ACTION_PLAN.some(({ actionId }) =>
      OBSOLETE_GROUPED_ACTION.test(actionId) || OBSERVATION_IDS.includes(actionId)),
    false,
  );
  assert.equal(schema.properties.actions.minItems, REQUIRED_STAGING_ACTION_PLAN.length);
  assert.equal(schema.properties.actions.maxItems, REQUIRED_STAGING_ACTION_PLAN.length);
  const gate4Index = REQUIRED_STAGING_ACTION_PLAN.findIndex(
    (action) => action.actionId === "staging-gate-4-phase3",
  );
  assert.equal(gate4Index, 23);
  assert.deepEqual(
    REQUIRED_STAGING_ACTION_PLAN.slice(
      gate4Index + 1,
      gate4Index + 1 + EXPECTED_GATE5_ACTION_IDS.length,
    ).map((action) => action.actionId),
    EXPECTED_GATE5_ACTION_IDS,
  );
  assert.deepEqual(
    REQUIRED_STAGING_ACTION_PLAN.slice(-2).map(({ actionId, kind }) => ({ actionId, kind })),
    [
      { actionId: "staging-guard-emergency-stop", kind: "emergency" },
      { actionId: "staging-watchdog-emergency-stop", kind: "emergency" },
    ],
  );
  assert.equal(schema.properties.migrations.maxItems, undefined);
  assert.equal(schema.$defs.migration.properties.filename.pattern, "^[0-9]{3}_[a-z0-9_]+\\.sql$");
  assert.deepEqual(schema.properties.target.properties.environment.const, "staging");
  assert.deepEqual(schema.properties.target.properties.composeProject.const, "spx-staging");
  assert.deepEqual(schema.properties.target.properties.database.const, "spx_staging");

  const approvalWorkflow = await readFile(
    resolve(repoRoot, ".github", "workflows", "staging-rollout-approval.yml"),
    "utf8",
  );
  const signerWorkflow = await readFile(
    resolve(repoRoot, ".github", "workflows", "staging-rollout-signer.yml"),
    "utf8",
  );
  const verifierSource = await readFile(
    resolve(repoRoot, "scripts", "staging-rollout-approval-verify.mjs"),
    "utf8",
  );
  const installedContextSource = await readFile(
    resolve(repoRoot, "scripts", "lib", "staging-installed-context.mjs"),
    "utf8",
  );
  assert.doesNotMatch(verifierSource, /argValue\("trust"\)|"trust",/);
  assert.match(verifierSource, /loadInstalledStagingTrust/);
  assert.match(verifierSource, /stageVerifiedCliArtifacts/);
  assert.doesNotMatch(verifierSource, /verifyPublishedArtifact\(\s*values\./);
  assert.match(verifierSource, /\.github\/workflows\/trusted-release-artifact\.yml/);
  assert.doesNotMatch(verifierSource, /\.github\/workflows\/release-artifact\.yml/);
  const publishedVerifier = verifierSource.match(
    /function verifyPublishedArtifact[\s\S]*?\n}/,
  )?.[0];
  assert.ok(publishedVerifier);
  assert.match(publishedVerifier, /--signer-digest[\s\S]*signerDigest/);
  assert.doesNotMatch(publishedVerifier, /--source-digest/);
  assert.doesNotMatch(installedContextSource, /SPX_TEST_STAGING_(?:TRUST|BINDING)_PATH/);
  assert.match(approvalWorkflow, /concurrency:/);
  assert.match(approvalWorkflow, /group:\s*spx-staging-a3/);
  assert.doesNotMatch(approvalWorkflow, /\bruns-on:|^\s+steps:|\benvironment:/m);
  assert.doesNotMatch(approvalWorkflow, /if:\s*github\.sha\s*==\s*inputs\.candidate_sha/);
  assert.doesNotMatch(approvalWorkflow, /\.\/\.github\/workflows\/staging-rollout-signer\.yml/);
  assert.match(
    approvalWorkflow,
    /uses:\s*fastest4u\/SPX\/\.github\/workflows\/staging-rollout-signer\.yml@[0-9a-f]{40}/,
  );
  assert.match(approvalWorkflow, /BOOTSTRAP-DENY/);
  assert.match(signerWorkflow, /workflow_call:/);
  assert.match(signerWorkflow, /prepare:/);
  assert.match(signerWorkflow, /signer:/);
  assert.match(signerWorkflow, /id-token:\s*write/);
  assert.match(signerWorkflow, /attestations:\s*write/);
  assert.match(signerWorkflow, /environment:\s*staging/);
  assert.match(signerWorkflow, /group:\s*spx-staging-a3/);
  assert.match(signerWorkflow, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(signerWorkflow, /gh attestation verify/);
  assert.match(signerWorkflow, /signed-envelope\.json/);
  assert.match(signerWorkflow, /action-index\.json/);
  assert.doesNotMatch(signerWorkflow, /response\.actions\.length\s*!==\s*\d+/);
  assert.match(signerWorkflow, /prepared-inputs\/unsigned-envelope\.json/);
  assert.match(signerWorkflow, /expectedActionCount\s*=\s*unsignedEnvelope\.actions\.length/);
  assert.match(signerWorkflow, /signed envelope does not match the prepared request/i);
  assert.match(signerWorkflow, /staging-rollout-approval\.attestation-claims\.json/);
  assert.match(signerWorkflow, /job_workflow_sha/);
  assert.doesNotMatch(signerWorkflow, /printf '%s\\n' "\$\{action\}"/);
  assert.match(signerWorkflow, /artifact-ids:/);
  assert.match(signerWorkflow, /run-id:/);
  assert.match(signerWorkflow, /digest-mismatch:\s*error/);
  assert.match(signerWorkflow, /deployment-target-descriptor-signer\.yml/);
  assert.match(signerWorkflow, /trusted-release-artifact\.yml/);
  assert.doesNotMatch(
    signerWorkflow,
    /signer-workflow[^\n]*workflows\/release-artifact\.yml/,
  );
  assert.match(signerWorkflow, /--signer-digest "\$\{TRUSTED_WORKFLOW_SHA\}"/);
  assert.doesNotMatch(signerWorkflow, /--source-digest/);
  assert.match(signerWorkflow, /deployment-target-descriptor\.attestation-claims\.json/);
  assert.match(signerWorkflow, /operator-bundle\.index\.json/);
  assert.match(approvalWorkflow, /rollback_sha:/);
  assert.match(approvalWorkflow, /rollback_release_run_id:/);
  assert.match(approvalWorkflow, /rollback_release_artifact_id:/);
  assert.match(signerWorkflow, /rollback_sha:/);
  assert.match(signerWorkflow, /rollback_release_run_id:/);
  assert.match(signerWorkflow, /rollback_release_artifact_id:/);
  assert.match(signerWorkflow, /inert-inputs\/rollback-release\/release-manifest\.json/);
  assert.match(signerWorkflow, /rollback-release-manifest\.json/);
  assert.doesNotMatch(
    signerWorkflow,
    /actions\/checkout|build-operator-bundle\.mjs|node scripts\//,
  );
  assert.doesNotMatch(signerWorkflow, /from ["']\.\/scripts\//);
  assert.match(signerWorkflow, /index\.files/);
  assert.doesNotMatch(signerWorkflow, /index\.candidateSha|index\.signerWorkflowSha256/);
  assert.doesNotMatch(`${approvalWorkflow}\n${signerWorkflow}`, /artifact_name/);
  assert.doesNotMatch(`${approvalWorkflow}\n${signerWorkflow}`, /uses:\s*[^\s]+@v\d/i);
  assert.doesNotMatch(
    `${approvalWorkflow}\n${signerWorkflow}`,
    /secrets\.[A-Z0-9_]*(?:PRIVATE|SIGNING)_?KEY/,
  );
  assert.match(signerWorkflow, /prepared_artifact_id/);
  assert.match(
    signerWorkflow,
    /artifact-ids:\s*\$\{\{ needs\.prepare\.outputs\.prepared_artifact_id \}\}/,
  );
  assert.match(signerWorkflow, /claims\.job_workflow_ref !== expectedWorkflowRef/);
  assert.doesNotMatch(signerWorkflow, /job_workflow_ref\.startsWith|expectedWorkflowPrefix/);
  assert.match(signerWorkflow, /TRUSTED_WORKFLOW_SHA:\s*\$\{\{ job\.workflow_sha \}\}/);
  assert.match(signerWorkflow, /SPX_TRUSTED_STAGING_SIGNER_SHA/);
  assert.match(signerWorkflow, /claims\.job_workflow_sha !== process\.env\.TRUSTED_WORKFLOW_SHA/);
  assert.doesNotMatch(
    signerWorkflow,
    /claims\.job_workflow_sha !== process\.env\.CANDIDATE_SHA/,
  );
  assert.equal((signerWorkflow.match(/id-token:\s*write/g) ?? []).length, 1);

  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(canonicalJson(fixture.actions), canonicalJson(REQUIRED_STAGING_ACTION_PLAN));
  assert.equal(fixture.actions.length, 44);
  for (const action of fixture.actions) {
    assert.equal(action.mutationSha256, sha256Canonical(stagingOperationDescriptor(action)));
  }
  assert.deepEqual(fixture.migrations.slice(-2), [
    {
      filename: "036_create_gate6_control_plane.sql",
      sha256: "28017d86825bc8d68e991728a4f583197bfba81ac4482a7071569f8eb6e8019a",
    },
    {
      filename: "037_create_n_minus_one_probe_fixtures.sql",
      sha256: "1175d9e5d41f405ef7372384d41ed765dd4111a144275277f73264b5e0e8e092",
    },
  ]);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wrongKey = generateKeyPairSync("ed25519").publicKey;
  const descriptorKeyPair = generateKeyPairSync("ed25519");

  const operatorBundle = Buffer.from("immutable operator bundle fixture", "utf8");
  const operatorBundleSha256 = createHash("sha256").update(operatorBundle).digest("hex");
  const descriptorWorkflowSha256 = "9".repeat(64);
  const operatorBundleIndex = {
    schemaVersion: 1,
    format: "ustar",
    files: [
      {
        path: ".github/workflows/deployment-target-descriptor-signer.yml",
        sha256: descriptorWorkflowSha256,
        size: 100,
        mode: "0644",
      },
      {
        path: ".github/workflows/staging-rollout-signer.yml",
        sha256: fixture.provenance.workflowFileSha256,
        size: 200,
        mode: "0644",
      },
    ],
  };
  const releaseManifest = finalizeReleaseManifest({
    build: buildBuildManifest({
      version: "1.0.0",
      sourceSha: fixture.release.candidateSha,
      buildId: "staging-approval-test-001",
      artifactSha256: "7".repeat(64),
      operatorBundleSha256,
      schema: { min: 31, max: 37 },
      migrations: fixture.migrations.map((migration: { filename: string; sha256: string }) => ({
        name: migration.filename,
        sha256: migration.sha256,
      })),
    }),
    imageId: fixture.release.candidateImageDigest,
    imageTag: `spx-app:${fixture.release.candidateSha}`,
  });
  const releaseManifestSha256 = sha256Canonical(releaseManifest);
  const rollbackMigrations = fixture.migrations
    .map((migration: { filename: string; sha256: string }) => ({
      name: migration.filename,
      sha256: migration.sha256,
    }));
  const rollbackReleaseManifest = finalizeReleaseManifest({
    build: buildBuildManifest({
      version: "0.9.0",
      sourceSha: fixture.release.rollbackSha,
      buildId: "staging-approval-rollback-test-001",
      artifactSha256: "8".repeat(64),
      operatorBundleSha256,
      schema: { min: 30, max: 37 },
      migrations: rollbackMigrations,
    }),
    imageId: fixture.release.rollbackImageDigest,
    imageTag: `spx-app:${fixture.release.rollbackSha}`,
  });
  const rollbackReleaseManifestSha256 = sha256Canonical(rollbackReleaseManifest);
  const descriptorWorkflowRef = `example/spx/.github/workflows/deployment-target-descriptor-signer.yml@${fixture.release.candidateSha}`;
  const targetDescriptorInput = {
    schemaVersion: 1,
    descriptorId: "dtd-staging-a3-20260710-01",
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    deploymentUnit: "primary",
    composeProject: "spx-staging",
    topology: "split",
    releaseManifestSha256,
    operatorBundleSha256,
    releaseSourceSha: fixture.release.candidateSha,
    imageId: fixture.release.candidateImageDigest,
    imageTag: `spx-app:${fixture.release.candidateSha}`,
    target: {
      hostIdentitySha256: "0".repeat(64),
      networkIdentitySha256: "1".repeat(64),
      approvedSourceCidrsSha256: "2".repeat(64),
      dockerContext: "unix:///var/run/docker.sock",
      productionObserverPolicySha256: "5".repeat(64),
      canonicalPaths: {
        releaseRoot: "/opt/spx-staging/release",
        environmentFile: "/etc/spx-staging/runtime.env",
        stateRoot: "/var/lib/spx-staging-rollout",
      },
    },
    database: {
      name: "spx_staging",
      tlsFingerprintSha256: fixture.target.databaseTlsFingerprintSha256,
      accountHosts: {
        "auto-accept-ifn-phase3": "172.17.0.1",
        "auto-accept-ptwl-phase3": "172.17.0.1",
        "gate6-monitor": "172.17.0.1",
        "line-service": "172.17.0.1",
        migrator: "172.17.0.1",
        "notification-service": "172.17.0.1",
        "phase3-control": "172.17.0.1",
        "phase3-observer": "172.17.0.1",
        "poller-ifn-phase3": "172.17.0.1",
        "poller-ptwl-phase3": "172.17.0.1",
        "realtime-service": "172.17.0.1",
        "web-api": "172.17.0.1",
        "worker-ifn": "172.17.0.1",
        "worker-ifn-split": "172.17.0.1",
        "worker-ptwl": "172.17.0.1",
        "worker-ptwl-split": "172.17.0.1",
      },
    },
    providerTargetFingerprints: fixture.target.providerTargetFingerprintsSha256,
    publishedPorts: [13000, 13002, 13003, 13004],
    volumeFingerprints: ["3".repeat(64)],
    nodeIds: ["stg-web-a3", "stg-worker-ifn-a3", "stg-worker-ptwl-a3"],
    productionDenyTargetSha256: "4".repeat(64),
    issuedAt: "2026-07-10T11:55:00.000Z",
    expiresAt: "2026-07-10T12:10:00.000Z",
    signingWorkflowSourceSha: fixture.release.candidateSha,
    signingWorkflowFileSha256: descriptorWorkflowSha256,
    targetFactsSha256: "0".repeat(64),
    signing: {
      repository: "example/spx",
      workflowRef: descriptorWorkflowRef,
      environment: "staging",
      subject: "repo:example/spx:environment:staging",
      audience: "https://github.com/example",
      issuer: "https://token.actions.githubusercontent.com",
      jobWorkflowRef: descriptorWorkflowRef,
      jobWorkflowSha: fixture.release.candidateSha,
    },
  };
  targetDescriptorInput.targetFactsSha256 = deploymentTargetFactsSha256(targetDescriptorInput);
  const targetDescriptor = signDeploymentTargetDescriptor(targetDescriptorInput, {
    keyId: "spx-descriptor-test-only",
    privateKey: descriptorKeyPair.privateKey,
  });
  const targetDescriptorAttestation = {
    schemaVersion: 1,
    artifactSha256: deploymentTargetDescriptorArtifactSha256(targetDescriptor),
    repository: "example/spx",
    workflowRef: descriptorWorkflowRef,
    environment: "staging",
    subject: "repo:example/spx:environment:staging",
    audience: "https://github.com/example",
    issuer: "https://token.actions.githubusercontent.com",
    jobWorkflowRef: descriptorWorkflowRef,
    jobWorkflowSha: fixture.release.candidateSha,
    signingWorkflowSourceSha: fixture.release.candidateSha,
    signingWorkflowFileSha256: descriptorWorkflowSha256,
    issuedAt: "2026-07-10T11:55:00.000Z",
  };

  fixture.release.releaseManifestSha256 = releaseManifestSha256;
  fixture.release.rollbackReleaseManifestSha256 = rollbackReleaseManifestSha256;
  fixture.release.operatorBundleSha256 = operatorBundleSha256;
  fixture.target.targetDescriptorSha256 =
    deploymentTargetDescriptorArtifactSha256(targetDescriptor);
  const validSignedEnvelope = signEnvelope(fixture, privateKey);

  const pinnedTrust = {
    publicKeys: {
      [fixture.keyId]: publicKey.export({ type: "spki", format: "pem" }),
    },
    repository: "example/spx",
    workflow: ".github/workflows/staging-rollout-signer.yml",
    workflowSha: fixture.provenance.workflowSha,
    environment: "staging",
    issuer: "https://token.actions.githubusercontent.com",
    audience: "spx-staging-rollout",
    subject: "repo:example/spx:environment:staging",
    workflowFileSha256: fixture.provenance.workflowFileSha256,
    targetDescriptor: {
      keyId: "spx-descriptor-test-only",
      publicKey: descriptorKeyPair.publicKey.export({ type: "spki", format: "pem" }),
      repository: "example/spx",
      workflowRef: descriptorWorkflowRef,
      environment: "staging",
      subject: "repo:example/spx:environment:staging",
      audience: "https://github.com/example",
      issuer: "https://token.actions.githubusercontent.com",
      jobWorkflowRef: descriptorWorkflowRef,
      signingWorkflowSourceSha: fixture.release.candidateSha,
      signingWorkflowFileSha256: descriptorWorkflowSha256,
    },
  };
  (globalThis as Record<string, unknown>).__SPX_TEST_INSTALLED_STAGING_TRUST__ = pinnedTrust;

  const fixedCliPaths = {
    "approval-envelope.json": "stage/approval-envelope.json",
    "approval-attestation.json": "stage/approval-attestation.json",
    "action-index.json": "stage/action-index.json",
    "action-index-attestation.json": "stage/action-index-attestation.json",
    "target-descriptor.json": "stage/target-descriptor.json",
    "target-descriptor-attestation.json": "stage/target-descriptor-attestation.json",
    "release-manifest.json": "stage/release-manifest.json",
    "rollback-release-manifest.json": "stage/rollback-release-manifest.json",
    "operator-bundle-index.json": "stage/operator-bundle-index.json",
    "operator-bundle.tar": "stage/operator-bundle.tar",
  };
  const provenanceCalls: Array<{
    path: string;
    repository: string;
    workflow: string;
    signerDigest: string;
  }> = [];
  verifyStagedStagingRolloutArtifactProvenance(
    fixedCliPaths,
    pinnedTrust,
    (path: string, repository: string, workflow: string, signerDigest: string) => {
      provenanceCalls.push({ path, repository, workflow, signerDigest });
    },
  );
  assert.deepEqual(
    provenanceCalls.find(({ path }) => path.endsWith("rollback-release-manifest.json")),
    {
      path: "stage/rollback-release-manifest.json",
      repository: pinnedTrust.repository,
      workflow: ".github/workflows/trusted-release-artifact.yml",
      signerDigest: pinnedTrust.workflowSha,
    },
  );
  assert.throws(
    () => verifyStagedStagingRolloutArtifactProvenance(
      fixedCliPaths,
      pinnedTrust,
      (path: string) => {
        if (path.endsWith("rollback-release-manifest.json")) {
          throw new Error("wrong rollback artifact provenance");
        }
      },
    ),
    /rollback artifact provenance/i,
  );

  const approvalAttestation = {
    repository: pinnedTrust.repository,
    workflow: pinnedTrust.workflow,
    workflowSha: fixture.provenance.workflowSha,
    environment: pinnedTrust.environment,
    issuer: pinnedTrust.issuer,
    audience: pinnedTrust.audience,
    subject: pinnedTrust.subject,
    subjectDigestSha256: sha256Canonical(validSignedEnvelope),
  };
  const signedActionArtifacts = buildSignedActionArtifacts(validSignedEnvelope, privateKey);
  const artifacts = {
    releaseManifest,
    rollbackReleaseManifest,
    targetDescriptor,
    operatorBundle,
    operatorBundleIndex,
    approvalAttestation,
    targetDescriptorAttestation,
    ...signedActionArtifacts,
  };
  const options = { now: new Date("2026-07-10T12:00:00.000Z") };

  assert.equal(await verifyEnvelope(validSignedEnvelope, artifacts, options), true);
  assert.equal(
    await verifyEnvelope(validSignedEnvelope, artifacts, options, {
      publicKeys: { [fixture.keyId]: wrongKey.export({ type: "spki", format: "pem" }) },
    }),
    true,
  );
  const verified = await verifyStagingRolloutEnvelope(validSignedEnvelope, artifacts, options);
  assert.equal(verified.approvalId, fixture.approvalId);
  assert.equal(verified.actions.length, fixture.actions.length);
  assert.equal(verified.actions.length, REQUIRED_STAGING_ACTION_PLAN.length);
  assert.equal(
    verified.rollbackReleaseManifestSha256,
    rollbackReleaseManifestSha256,
  );
  assert.equal(
    rollbackReleaseManifest.schema.min <= releaseManifest.schema.max &&
      releaseManifest.schema.max <= rollbackReleaseManifest.schema.max,
    true,
  );
  assert.equal(Object.isFrozen(verified), true);

  const journalRoot = await mkdtemp(resolve(tmpdir(), "spx-verified-staging-rollout-"));
  try {
    const rollout = await openVerifiedStagingRollout({
      envelope: validSignedEnvelope,
      artifacts,
      verificationOptions: options,
      ledgerOptions: {
        rootPath: journalRoot,
        enforceOwnership: false,
        enforceMode: process.platform !== "win32",
        now: () => options.now,
        operationRegistry: createTestStagingOperationRegistry(fixture.actions),
        persistReleaseBinding: true,
      },
    });
    const registeredSnapshot = await rollout.snapshot();
    assert.equal(registeredSnapshot.schemaVersion, 1);
    assert.equal(registeredSnapshot.actions.length, REQUIRED_STAGING_ACTION_PLAN.length);
    assert.equal(
      registeredSnapshot.actions.every(
        (entry: { state: string; occurrences: number }) =>
          entry.state === "registered" && entry.occurrences === 0,
      ),
      true,
    );
    await assert.rejects(
      () => rollout.snapshot("caller-selected-action"),
      /argument|filter|zero/i,
    );
    const dbContext = rollout.action("staging-db-bootstrap");
    assert.deepEqual(Object.keys(dbContext), []);
    assert.equal(JSON.stringify(dbContext), "{}");
    let injectedOperationRan = false;
    await assert.rejects(
      () =>
        dbContext.run(async () => {
          injectedOperationRan = true;
        }),
      /fixed signed operation/i,
    );
    assert.equal(injectedOperationRan, false);
    assert.equal(await dbContext.run(), true);
    const completedSnapshot = await rollout.snapshot();
    assert.deepEqual(
      completedSnapshot.actions.find(
        (entry: { actionId: string }) => entry.actionId === "staging-db-bootstrap",
      ),
      {
        sequence: 1,
        actionId: "staging-db-bootstrap",
        scope: "database-bootstrap",
        kind: "forward",
        mutationSha256: fixture.actions[0].mutationSha256,
        state: "succeeded",
        occurrences: 1,
        terminalRecordSha256: completedSnapshot.headSha256,
        completedAt: options.now.toISOString(),
        reconciliationId: null,
        reconciliationOutcome: null,
      },
    );
    const installedBinding = (globalThis as Record<string, unknown>)
      .__SPX_TEST_INSTALLED_RELEASE_BINDING__;
    assert.deepEqual(installedBinding, {
      candidateSha: fixture.release.candidateSha,
      imageDigest: fixture.release.candidateImageDigest,
      releaseManifestSha256,
      environment: "staging",
      topology: "split",
      composeProject: "spx-staging",
      stagingTargetDescriptorSha256: fixture.target.targetDescriptorSha256,
      operatorBundleSha256,
      stagingApprovalEnvelopeSha256: sha256Canonical(validSignedEnvelope),
      actionJournalHeadSha256: await rollout.head(),
      stagingRunId: fixture.stagingRunId,
    });
    await assert.rejects(() => dbContext.run(), /reused|consumed/i);
    assert.throws(() => rollout.action("unknown-action"), /not approved/i);
    await rollout.close();
    await assert.rejects(() => rollout.snapshot(), /closed/i);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }

  const installedWrapperEvents: string[] = [];
  const installedHeadSha256 = "f".repeat(64);
  const installedSnapshot = Object.freeze({
    schemaVersion: 1,
    marker: "functional-installed-wrapper-snapshot",
  });
  let installedSnapshotCalls = 0;
  const installedRollout = await openInstalledVerifiedStagingRollout({
    async loadContext() {
      installedWrapperEvents.push("load-context");
      return {
        installedBinding: {
          stagingRunId: fixture.stagingRunId,
          actionJournalHeadSha256: installedHeadSha256,
        },
        envelope: validSignedEnvelope,
        artifacts: { targetDescriptor: { descriptor: { topology: "split" } } },
        verified,
      };
    },
    async openRollout() {
      installedWrapperEvents.push("open-rollout");
      return {
        async head() {
          installedWrapperEvents.push("head");
          return installedHeadSha256;
        },
        async snapshot(...callerArguments: unknown[]) {
          assert.equal(callerArguments.length, 0);
          installedSnapshotCalls += 1;
          installedWrapperEvents.push("snapshot");
          return installedSnapshot;
        },
        action() {
          throw new Error("action is outside this snapshot test");
        },
        async close() {
          installedWrapperEvents.push("close");
        },
      };
    },
  });
  assert.strictEqual(await installedRollout.snapshot(), installedSnapshot);
  await assert.rejects(
    () => installedRollout.snapshot("caller-selected-filter"),
    /zero arguments/i,
  );
  assert.equal(installedSnapshotCalls, 1);
  await installedRollout.close();
  await assert.rejects(() => installedRollout.snapshot(), /closed/i);
  assert.deepEqual(installedWrapperEvents, [
    "load-context",
    "open-rollout",
    "head",
    "snapshot",
    "close",
  ]);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      () => openInstalledVerifiedStagingRollout({}),
      /injected|caller-selected|test-only|forbidden/i,
    );
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }

  const tamperedEnvelope = structuredClone(validSignedEnvelope);
  tamperedEnvelope.release.candidateSha = "0".repeat(40);
  await assert.rejects(() => verifyEnvelope(tamperedEnvelope, artifacts, options), /signature/i);

  (globalThis as Record<string, unknown>).__SPX_TEST_INSTALLED_STAGING_TRUST__ = {
    ...pinnedTrust,
    publicKeys: { [fixture.keyId]: wrongKey.export({ type: "spki", format: "pem" }) },
  };
  await assert.rejects(
    () => verifyEnvelope(validSignedEnvelope, artifacts, options),
    /key id|signature/i,
  );
  (globalThis as Record<string, unknown>).__SPX_TEST_INSTALLED_STAGING_TRUST__ = pinnedTrust;

  const incompatibleRollbackManifest = finalizeReleaseManifest({
    build: buildBuildManifest({
      version: "0.8.0",
      sourceSha: fixture.release.rollbackSha,
      buildId: "staging-approval-incompatible-rollback-test-001",
      artifactSha256: "9".repeat(64),
      operatorBundleSha256,
      schema: { min: 30, max: 36 },
      migrations: rollbackMigrations.slice(0, -1),
    }),
    imageId: fixture.release.rollbackImageDigest,
    imageTag: `spx-app:${fixture.release.rollbackSha}`,
  });
  const incompatibleEnvelope = structuredClone(fixture);
  incompatibleEnvelope.release.rollbackReleaseManifestSha256 =
    sha256Canonical(incompatibleRollbackManifest);
  await assert.rejects(
    () => verifyEnvelope(
      signEnvelope(incompatibleEnvelope, privateKey),
      { ...artifacts, rollbackReleaseManifest: incompatibleRollbackManifest },
      options,
    ),
    /rollback|range|current schema|compatible/i,
  );

  const wrongRollbackIdentity = {
    ...rollbackReleaseManifest,
    sourceSha: "0".repeat(40),
  };
  const wrongIdentityEnvelope = structuredClone(fixture);
  wrongIdentityEnvelope.release.rollbackReleaseManifestSha256 =
    sha256Canonical(wrongRollbackIdentity);
  await assert.rejects(
    () => verifyEnvelope(
      signEnvelope(wrongIdentityEnvelope, privateKey),
      { ...artifacts, rollbackReleaseManifest: wrongRollbackIdentity },
      options,
    ),
    /rollback|identity|release/i,
  );

  await assert.rejects(
    () => verifyEnvelope(
      validSignedEnvelope,
      { ...artifacts, rollbackReleaseManifest: releaseManifest },
      options,
    ),
    /rollback|manifest|hash/i,
  );

  const checksumSubstitutedRollbackManifest = finalizeReleaseManifest({
    build: buildBuildManifest({
      version: "0.7.0",
      sourceSha: fixture.release.rollbackSha,
      buildId: "staging-approval-checksum-substitution-test-001",
      artifactSha256: "6".repeat(64),
      operatorBundleSha256,
      schema: { min: 30, max: 37 },
      migrations: rollbackMigrations.map((migration: { name: string; sha256: string }) =>
        migration.name === "035_create_auto_accept_publication_controls.sql"
          ? { ...migration, sha256: "0".repeat(64) }
          : migration),
    }),
    imageId: fixture.release.rollbackImageDigest,
    imageTag: `spx-app:${fixture.release.rollbackSha}`,
  });
  const checksumSubstitutionEnvelope = structuredClone(fixture);
  checksumSubstitutionEnvelope.release.rollbackReleaseManifestSha256 =
    sha256Canonical(checksumSubstitutedRollbackManifest);
  await assert.rejects(
    () => verifyEnvelope(
      signEnvelope(checksumSubstitutionEnvelope, privateKey),
      { ...artifacts, rollbackReleaseManifest: checksumSubstitutedRollbackManifest },
      options,
    ),
    /rollback|migration|checksum|coverage/i,
  );

  await assert.rejects(
    () =>
      verifyEnvelope(
        validSignedEnvelope,
        { ...artifacts, actionIndex: { ...artifacts.actionIndex, approvalId: "tampered" } },
        options,
      ),
    /action index|signature/i,
  );
  const firstActionFilename = Object.keys(artifacts.actionArtifacts)[0];
  await assert.rejects(
    () =>
      verifyEnvelope(
        validSignedEnvelope,
        {
          ...artifacts,
          actionArtifacts: {
            ...artifacts.actionArtifacts,
            [firstActionFilename]: {
              ...artifacts.actionArtifacts[firstActionFilename],
              action: {
                ...artifacts.actionArtifacts[firstActionFilename].action,
                scope: "tampered-scope",
              },
            },
          },
        },
        options,
      ),
    /action artifact|signature|digest/i,
  );

  await assert.rejects(
    () =>
      verifyEnvelope(
        validSignedEnvelope,
        {
          ...artifacts,
          targetDescriptor: {
            ...targetDescriptor,
            descriptor: {
              ...targetDescriptor.descriptor,
              target: { ...targetDescriptor.descriptor.target, hostIdentitySha256: "f".repeat(64) },
            },
          },
        },
        options,
      ),
    /target descriptor/i,
  );

  await assert.rejects(
    () =>
      verifyEnvelope(
        validSignedEnvelope,
        {
          ...artifacts,
          operatorBundle: Buffer.from("different operator bundle", "utf8"),
        },
        options,
      ),
    /operator bundle/i,
  );

  await assert.rejects(
    () =>
      verifyEnvelope(
        validSignedEnvelope,
        {
          ...artifacts,
          approvalAttestation: {
            ...approvalAttestation,
            subject: "repo:other/repo:environment:staging",
          },
        },
        options,
      ),
    /OIDC|workflow|subject/i,
  );

  const productionTarget = structuredClone(fixture);
  productionTarget.target.environment = "supervised-production";
  productionTarget.target.composeProject = "spx-production";
  productionTarget.target.database = "spx";
  await assert.rejects(
    () => verifyEnvelope(signEnvelope(productionTarget, privateKey), artifacts, options),
    /staging only/i,
  );

  const expired = structuredClone(fixture);
  expired.policy.expiresAt = "2026-07-10T11:59:59.000Z";
  await assert.rejects(
    () => verifyEnvelope(signEnvelope(expired, privateKey), artifacts, options),
    /expired/i,
  );

  const wrongWorkflowSha = structuredClone(fixture);
  wrongWorkflowSha.provenance.jobWorkflowSha = "0".repeat(40);
  await assert.rejects(
    () => verifyEnvelope(signEnvelope(wrongWorkflowSha, privateKey), artifacts, options),
    /pinned trusted signer SHA/i,
  );

  const unknownField = structuredClone(fixture);
  unknownField.mutableBranch = "main";
  await assert.rejects(
    () => verifyEnvelope(signEnvelope(unknownField, privateKey), artifacts, options),
    /unknown field/i,
  );

  const placeholder = structuredClone(fixture);
  placeholder.policy.owners.rolloutOwner = "TODO-owner";
  await assert.rejects(
    () => verifyEnvelope(signEnvelope(placeholder, privateKey), artifacts, options),
    /placeholder/i,
  );

  const incompleteActionPlan = structuredClone(fixture);
  incompleteActionPlan.actions.splice(9, 1);
  incompleteActionPlan.actions.forEach((action: Record<string, unknown>, index: number) => {
    action.sequence = index + 1;
  });
  await assert.rejects(
    () => verifyEnvelope(signEnvelope(incompleteActionPlan, privateKey), artifacts, options),
    /exactly match|Gate 1-5/i,
  );

  const substitutedActionPlan = structuredClone(fixture);
  substitutedActionPlan.actions[9].actionId = "staging-ocr-manual-observation";
  await assert.rejects(
    () => verifyEnvelope(signEnvelope(substitutedActionPlan, privateKey), artifacts, options),
    /exact Gate 1-5/i,
  );

  for (const [threshold, invalidValue] of [
    ["maxCpuPercent", 101],
    ["minMemoryFreeBytes", 1.5],
    ["minMysqlConnectionsFree", 2.5],
    ["maxLatencyIncreasePercent", 100.1],
  ] as const) {
    const invalidThreshold = structuredClone(fixture);
    invalidThreshold.policy.thresholds[threshold] = invalidValue;
    await assert.rejects(
      () => verifyEnvelope(signEnvelope(invalidThreshold, privateKey), artifacts, options),
      new RegExp(threshold, "i"),
    );
  }

  await assert.rejects(
    () => verifyEnvelope(JSON.stringify(validSignedEnvelope, null, 2), artifacts, options),
    /canonical JSON/i,
  );
  await assert.rejects(
    () => verifyEnvelope(`${canonicalJson(validSignedEnvelope)}\n`, artifacts, options),
    /canonical JSON/i,
  );
  delete (globalThis as Record<string, unknown>).__SPX_TEST_INSTALLED_STAGING_TRUST__;
  delete (globalThis as Record<string, unknown>).__SPX_TEST_INSTALLED_RELEASE_BINDING__;
  await rm(installedTrustRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
