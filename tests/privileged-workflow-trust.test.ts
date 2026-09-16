import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const repository = "fastest4u/SPX";
const bootstrapDenySha = "0".repeat(40);
const producerSnapshotSha = "4c0b0cf57481eda1c88ac754fa70500cf0fb59ad";
const cutoverProducerSnapshotSha = "1f5d7a419ea23e85e2b09888572063be0798169a";
const releaseProducerSnapshotSha = "d770ebd35a0bc1ea8627f938c9b1a43bc446a4a4";
const descriptorProducerSnapshotSha = "b6c7e9b9e43302a7d1671af4dd8cd1c7cfba0cc4";
const backupProducerSnapshotSha = "b0210e1825197ebd5a746bf0de2b2d382e449fd0";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function assertPinnedReusableCall(source: string, workflow: string, label: string): string {
  const escapedRepository = repository.replace("/", "\\/");
  const escapedWorkflow = workflow.replaceAll(".", "\\.");
  const match = source.match(
    new RegExp(
      `uses:\\s+${escapedRepository}\\/\\.github\\/workflows\\/${escapedWorkflow}@([0-9a-f]{40})`,
    ),
  );
  assert.ok(match, `${label} must call ${workflow} through an immutable full SHA`);
  assert.doesNotMatch(source, /uses:\s+\.\/\.github\/workflows\//);
  if (match[1] === bootstrapDenySha) {
    assert.match(source, /BOOTSTRAP-DENY/);
  }
  return match[1];
}

function assertUnprivilegedDispatcher(
  source: string,
  label: string,
  allowExplicitSecretPassthrough = false,
): void {
  assert.doesNotMatch(source, /\bruns-on:/, `${label} must not execute mutable steps`);
  assert.doesNotMatch(source, /^\s+steps:/m, `${label} must not contain mutable steps`);
  assert.doesNotMatch(source, /\benvironment:/, `${label} must not request an environment`);
  assert.doesNotMatch(source, /secrets:\s*inherit/);
  if (allowExplicitSecretPassthrough) {
    assert.doesNotMatch(source, /\b(?:ssh|scp|docker)\b/);
  } else {
    assert.doesNotMatch(source, /\$\{\{\s*secrets\./, `${label} must not read secrets`);
    assert.doesNotMatch(source, /\b(?:ssh|scp|docker)\b|SPX_SSH_KEY|SPX_KNOWN_HOSTS/);
  }
}

const deployDispatcher = read(".github/workflows/a3-deploy.yml");
const trustedDeploy = read(".github/workflows/trusted-deploy.yml");
const trustedTeam2Deploy = read(".github/workflows/trusted-team2-deploy.yml");
const identityDispatcher = read(".github/workflows/production-project-identity.yml");
const trustedIdentity = read(".github/workflows/trusted-production-project-identity.yml");
const descriptorDispatcher = read(".github/workflows/deployment-target-descriptor.yml");
const descriptorSigner = read(".github/workflows/deployment-target-descriptor-signer.yml");
const releaseDispatcher = read(".github/workflows/release-artifact.yml");
const trustedRelease = read(".github/workflows/trusted-release-artifact.yml");
const stagingDispatcher = read(".github/workflows/staging-rollout-approval.yml");
const stagingSigner = read(".github/workflows/staging-rollout-signer.yml");
const protectedEvidenceDispatcher = read(".github/workflows/staging-protected-evidence.yml");
const trustedProtectedEvidence = read(".github/workflows/trusted-staging-protected-evidence.yml");
const productionBackupDispatcher = read(".github/workflows/production-backup-restore.yml");
const trustedProductionBackup = read(".github/workflows/trusted-production-backup-restore.yml");
const acceptedEvidenceDispatcher = read(".github/workflows/gate6-accepted-evidence.yml");
const acceptedEvidenceExporter = read(".github/workflows/gate6-accepted-evidence-exporter.yml");
const finalVerifierDispatcher = read(".github/workflows/gate6-final-verifier.yml");
const finalVerifierExporter = read(".github/workflows/gate6-final-verifier-exporter.yml");

function jobBlocks(source: string): Array<{ name: string; source: string }> {
  const lines = source.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobsIndex, -1, "workflow must define jobs");
  const blocks: Array<{ name: string; source: string }> = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (!match) continue;
    let end = index + 1;
    while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end])) end += 1;
    blocks.push({ name: match[1], source: lines.slice(index, end).join("\n") });
    index = end - 1;
  }
  return blocks;
}

function assertValidWorkflowControlSyntax(source: string, workflowName: string): void {
  assert.doesNotMatch(
    source,
    /^\s+queue:/m,
    `${workflowName} must use only supported GitHub Actions concurrency keys`,
  );
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^ {4}env:\s*$/.test(lines[index])) continue;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const indentation = /^\s*/.exec(line)?.[0].length ?? 0;
      if (line.trim().length > 0 && indentation <= 4) {
        index -= 1;
        break;
      }
      assert.doesNotMatch(
        line,
        /\$\{\{\s*job\./,
        `${workflowName} must resolve job workflow identity inside a step`,
      );
    }
  }
}

function assertPinnedPrivilegeDelegation(block: string, label: string): void {
  assert.match(
    block,
    /\n {4}uses:\s+fastest4u\/SPX\/\.github\/workflows\/[A-Za-z0-9_.-]+\.yml@[0-9a-f]{40}\s*$/m,
    `${label} must delegate only to a full-SHA reusable workflow`,
  );
  assert.doesNotMatch(block, /\n {4}(?:runs-on|environment|steps):/);
  assert.doesNotMatch(block, /uses:\s+\.\/\.github\/workflows\//);
}

const productionSecretCapableWorkflows = readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .filter((name) => /secrets\.SPX_/.test(read(`.github/workflows/${name}`)))
  .sort();
assert.deepEqual(productionSecretCapableWorkflows, [
  "deploy.yml",
  "gate6-accepted-evidence-exporter.yml",
  "gate6-final-verifier-exporter.yml",
  "gate6-runtime-executor.yml",
  "production-backup-restore.yml",
  "trusted-deploy.yml",
  "trusted-production-backup-restore.yml",
  "trusted-production-project-identity.yml",
  "trusted-staging-protected-evidence.yml",
  "trusted-team2-deploy.yml",
]);

assertUnprivilegedDispatcher(deployDispatcher, "deploy dispatcher");
assertUnprivilegedDispatcher(identityDispatcher, "identity dispatcher");
const deployPin = assertPinnedReusableCall(
  deployDispatcher,
  "trusted-deploy.yml",
  "deploy dispatcher",
);
const team2DeployPin = assertPinnedReusableCall(
  deployDispatcher,
  "trusted-team2-deploy.yml",
  "TEAM 2 deploy dispatcher",
);
const identityPin = assertPinnedReusableCall(
  identityDispatcher,
  "trusted-production-project-identity.yml",
  "identity dispatcher",
);

assert.match(trustedDeploy, /on:\s*\n\s*workflow_call:/);
assert.match(trustedDeploy, /environment:\s*\$\{\{\s*inputs\.target\s*\}\}/);
assert.match(trustedDeploy, /\$\{\{\s*secrets\.SPX_SSH_KEY\s*\}\}/);
assert.match(trustedDeploy, /\b(?:ssh|scp)\b/);
assert.match(trustedDeploy, /CALLED_WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trustedDeploy, /SPX_TRUSTED_DEPLOY_WORKFLOW_SHA/);
assert.match(trustedTeam2Deploy, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(trustedTeam2Deploy, /workflow_dispatch:/);
assert.match(trustedTeam2Deploy, /environment:\s*production/);
assert.match(trustedTeam2Deploy, /\$\{\{\s*secrets\.SPX_TEAM2_SSH_KEY\s*\}\}/);
assert.match(trustedTeam2Deploy, /\b(?:ssh|scp)\b/);
assert.match(trustedTeam2Deploy, /CALLED_WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trustedTeam2Deploy, /SPX_TRUSTED_TEAM2_DEPLOY_WORKFLOW_SHA/);
assert.deepEqual(
  trustedDeploy
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("install-staging-action-handlers.mjs")),
  ['/usr/bin/node "${RELEASE_DIR}/scripts/install-staging-action-handlers.mjs"'],
  "trusted deploy may invoke only the verified release-local zero-argument handler installer",
);
assert.match(trustedIdentity, /on:\s*\n\s*workflow_call:/);
assert.match(trustedIdentity, /environment:\s*production/);
assert.match(trustedIdentity, /\$\{\{\s*secrets\.SPX_SSH_KEY\s*\}\}/);
assert.match(trustedIdentity, /\b(?:ssh|scp)\b/);
assert.match(trustedIdentity, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trustedIdentity, /SPX_TRUSTED_IDENTITY_WORKFLOW_SHA/);

const descriptorPin = assertPinnedReusableCall(
  descriptorDispatcher,
  "deployment-target-descriptor-signer.yml",
  "descriptor dispatcher",
);
assert.match(descriptorDispatcher, /sign-request:/);
assert.match(descriptorDispatcher, /request_artifact_id:/);
assert.match(descriptorDispatcher, /release_artifact_id:/);
assert.doesNotMatch(descriptorDispatcher, /secrets:\s*inherit/);
const descriptorCallJob = descriptorDispatcher.match(/\n {2}sign-request:[\s\S]*$/)?.[0];
assert.ok(descriptorCallJob);
assert.doesNotMatch(descriptorCallJob, /\bruns-on:|^\s+steps:|\benvironment:/m);
assert.match(descriptorCallJob, /id-token:\s*write/);
assert.match(descriptorCallJob, /attestations:\s*write/);
assert.match(descriptorSigner, /on:\s*\n\s*workflow_call:/);
assert.match(descriptorSigner, /environment:\s*\$\{\{\s*inputs\.target\s*\}\}/);

const releasePin = assertPinnedReusableCall(
  releaseDispatcher,
  "trusted-release-artifact.yml",
  "release candidate workflow",
);
const releaseCallJob = releaseDispatcher.match(/\n {2}sign-release:[\s\S]*$/)?.[0];
assert.ok(releaseCallJob);
assertPinnedPrivilegeDelegation(releaseCallJob, "release signer delegation");
assert.match(trustedRelease, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(trustedRelease, /workflow_dispatch:/);
assert.match(trustedRelease, /environment:\s*release/);
assert.match(trustedRelease, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trustedRelease, /SPX_TRUSTED_RELEASE_WORKFLOW_SHA/);

const stagingPin = assertPinnedReusableCall(
  stagingDispatcher,
  "staging-rollout-signer.yml",
  "staging approval dispatcher",
);
assertUnprivilegedDispatcher(stagingDispatcher, "staging approval dispatcher");
const stagingCallJob = stagingDispatcher.match(/\n {2}sign:[\s\S]*$/)?.[0];
assert.ok(stagingCallJob);
assertPinnedPrivilegeDelegation(stagingCallJob, "staging signer delegation");
assert.match(stagingSigner, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(stagingSigner, /workflow_dispatch:/);
assert.match(stagingSigner, /environment:\s*staging/);
assert.match(stagingSigner, /TRUSTED_WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(stagingSigner, /SPX_TRUSTED_STAGING_SIGNER_SHA/);

const protectedEvidencePin = assertPinnedReusableCall(
  protectedEvidenceDispatcher,
  "trusted-staging-protected-evidence.yml",
  "staging protected evidence dispatcher",
);
assertUnprivilegedDispatcher(protectedEvidenceDispatcher, "staging protected evidence dispatcher");
const protectedEvidenceCallJob = protectedEvidenceDispatcher.match(
  /\n {2}export-protected-evidence:[\s\S]*$/,
)?.[0];
assert.ok(protectedEvidenceCallJob);
assertPinnedPrivilegeDelegation(protectedEvidenceCallJob, "staging protected evidence delegation");
assert.match(trustedProtectedEvidence, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(trustedProtectedEvidence, /workflow_dispatch:/);
assert.match(trustedProtectedEvidence, /environment:\s*staging/);
assert.match(trustedProtectedEvidence, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trustedProtectedEvidence, /SPX_TRUSTED_STAGING_PROTECTED_EVIDENCE_WORKFLOW_SHA/);

const productionBackupPin = assertPinnedReusableCall(
  productionBackupDispatcher,
  "trusted-production-backup-restore.yml",
  "production backup dispatcher",
);
assertUnprivilegedDispatcher(productionBackupDispatcher, "production backup dispatcher", true);
const productionBackupCallJob = productionBackupDispatcher.match(
  /\n {2}produce-backup-evidence:[\s\S]*$/,
)?.[0];
assert.ok(productionBackupCallJob);
assertPinnedPrivilegeDelegation(productionBackupCallJob, "production backup delegation");
assert.match(trustedProductionBackup, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(trustedProductionBackup, /workflow_dispatch:/);
assert.match(trustedProductionBackup, /environment:\s*production/);
assert.match(trustedProductionBackup, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(trustedProductionBackup, /SPX_TRUSTED_PRODUCTION_BACKUP_RESTORE_WORKFLOW_SHA/);

const acceptedEvidencePin = assertPinnedReusableCall(
  acceptedEvidenceDispatcher,
  "gate6-accepted-evidence-exporter.yml",
  "Gate 6 accepted evidence dispatcher",
);
assertUnprivilegedDispatcher(acceptedEvidenceDispatcher, "Gate 6 accepted evidence dispatcher");
const acceptedEvidenceCallJob = acceptedEvidenceDispatcher.match(
  /\n {2}export-accepted-evidence:[\s\S]*$/,
)?.[0];
assert.ok(acceptedEvidenceCallJob);
assertPinnedPrivilegeDelegation(
  acceptedEvidenceCallJob,
  "Gate 6 accepted evidence exporter delegation",
);
assert.match(acceptedEvidenceExporter, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(acceptedEvidenceExporter, /workflow_dispatch:/);
assert.match(acceptedEvidenceExporter, /environment:\s*production/);
assert.match(acceptedEvidenceExporter, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(acceptedEvidenceExporter, /SPX_TRUSTED_GATE6_ACCEPTED_EVIDENCE_EXPORTER_SHA/);

const finalVerifierPin = assertPinnedReusableCall(
  finalVerifierDispatcher,
  "gate6-final-verifier-exporter.yml",
  "Gate 6 final verifier dispatcher",
);
assertUnprivilegedDispatcher(finalVerifierDispatcher, "Gate 6 final verifier dispatcher");
const finalVerifierCallJob = finalVerifierDispatcher.match(
  /\n {2}export-final-verifier:[\s\S]*$/,
)?.[0];
assert.ok(finalVerifierCallJob);
assertPinnedPrivilegeDelegation(
  finalVerifierCallJob,
  "Gate 6 final verifier exporter delegation",
);
assert.match(finalVerifierExporter, /on:\s*\n\s*workflow_call:/);
assert.doesNotMatch(finalVerifierExporter, /workflow_dispatch:/);
assert.match(finalVerifierExporter, /environment:\s*production/);
assert.match(finalVerifierExporter, /WORKFLOW_SHA:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
assert.match(finalVerifierExporter, /SPX_TRUSTED_GATE6_FINAL_VERIFIER_EXPORTER_SHA/);

const workflowSources = Object.fromEntries(
  readdirSync(".github/workflows")
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, read(`.github/workflows/${name}`)]),
);
for (const [name, source] of Object.entries(workflowSources)) {
  assertValidWorkflowControlSyntax(source, name);
}
const privilegedReusableNames = new Set([
  "deployment-target-descriptor-signer.yml",
  "gate6-accepted-evidence-exporter.yml",
  "gate6-final-verifier-exporter.yml",
  "gate6-envelope-signer.yml",
  "gate6-line-permit-signer.yml",
  "gate6-ocr-permit-signer.yml",
  "gate6-postproof-principal-signer.yml",
  "gate6-runtime-executor.yml",
  "staging-rollout-signer.yml",
  "trusted-deploy.yml",
  "trusted-production-backup-restore.yml",
  "trusted-production-project-identity.yml",
  "trusted-release-artifact.yml",
  "trusted-staging-protected-evidence.yml",
  "trusted-team2-deploy.yml",
]);
const privilegedJobs: string[] = [];
// The released host deployment is a separate, explicitly inventoried trust
// domain, covered by ci-deploy-workflow/worker/readiness behavioral tests.
const releasedPrivilegedJobs: string[] = [];
for (const [name, source] of Object.entries(workflowSources)) {
  for (const block of jobBlocks(source)) {
    if (!/^ {4}environment:|^ {6}id-token:\s*write/m.test(block.source)) continue;
    privilegedJobs.push(`${name}:${block.name}`);
    if (name === "deploy.yml") {
      releasedPrivilegedJobs.push(block.name);
      assert.match(block.source, /^ {4}environment: production$/m);
      assert.doesNotMatch(block.source, /id-token:\s*write|attestations:\s*write/);
      continue;
    }
    if (/^ {4}uses:/m.test(block.source)) {
      assertPinnedPrivilegeDelegation(block.source, `${name}:${block.name}`);
      continue;
    }
    assert.equal(
      privilegedReusableNames.has(name),
      true,
      `${name}:${block.name} executes privilege outside a trusted reusable workflow`,
    );
    assert.match(source, /on:\s*\n\s*workflow_call:/);
    assert.doesNotMatch(source, /workflow_dispatch:/);
    const pinnedCall = Object.values(workflowSources).some((candidate) =>
      new RegExp(
        `uses:\\s+${repository.replace("/", "\\/")}\\/\\.github\\/workflows\\/${name.replaceAll(".", "\\.")}@[0-9a-f]{40}`,
      ).test(candidate),
    );
    assert.equal(pinnedCall, true, `${name} must be reached through an immutable call`);
  }
}
assert.deepEqual(releasedPrivilegedJobs, ["worker-preflight", "deploy", "deploy-workers"]);
assert.match(workflowSources["deploy.yml"], /needs: \[build, worker-preflight\]/);
assert.match(workflowSources["deploy.yml"], /needs: \[build, deploy, worker-preflight\]/);
assert.ok(privilegedJobs.length >= 9, "privileged workflow inventory is unexpectedly empty");
for (const [name, source] of Object.entries(workflowSources)) {
  if (!/environment:|id-token:\s*write/.test(source)) continue;
  const classified = jobBlocks(source).some((block) =>
    /^ {4}environment:|^ {6}id-token:\s*write/m.test(block.source),
  );
  assert.equal(classified, true, `${name} has unclassified privileged syntax`);
}
for (const [name, source] of Object.entries(workflowSources)) {
  assert.doesNotMatch(
    source,
    /--signer-workflow[^\n]*workflows\/release-artifact\.yml/,
    `${name} must verify release attestations against the trusted signer workflow`,
  );
}

const cutoverProducerSnapshotPins = [
  deployPin,
  team2DeployPin,
];
assert.ok(
  cutoverProducerSnapshotPins.every((pin) => pin === cutoverProducerSnapshotSha),
  "cutover dispatchers must pin the reviewed cutover producer snapshot",
);
assert.equal(
  releasePin,
  releaseProducerSnapshotSha,
  "release dispatcher must pin the reviewed archive-layout producer snapshot",
);
assert.equal(
  descriptorPin,
  descriptorProducerSnapshotSha,
  "descriptor dispatcher must pin the reviewed production bootstrap snapshot",
);
const producerSnapshotPins = [
  identityPin,
  stagingPin,
  protectedEvidencePin,
  acceptedEvidencePin,
  finalVerifierPin,
];
assert.equal(
  new Set(producerSnapshotPins).size,
  1,
  "unchanged foundational and protected producer dispatchers must pin the producer snapshot",
);
assert.ok(
  producerSnapshotPins.every((pin) => pin === producerSnapshotSha),
  "unchanged producer dispatchers must retain the reviewed Stage A snapshot",
);
assert.equal(
  productionBackupPin,
  backupProducerSnapshotSha,
  "the backup dispatcher must pin the reviewed backup producer revision",
);

console.log("privileged workflow trust tests passed");
