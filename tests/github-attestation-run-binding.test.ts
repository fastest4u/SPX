import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertGitHubArtifactRunMetadata,
  assertGitHubAttestationRunBinding,
} from "../scripts/lib/github-attestation-run.mjs";

const repository = "fastest4u/SPX";
const signerWorkflow = ".github/workflows/trusted-staging-protected-evidence.yml";
const signerSha = "a".repeat(40);
const artifactId = "123456789";
const runId = "987654321";
const runAttempt = "2";
const sourceRepositoryId = "7654321";
const sourceSha = "c".repeat(40);
const artifactBytes = Buffer.from("canonical protected evidence");
const subjectSha256 = createHash("sha256").update(artifactBytes).digest("hex");
const runInvocationUri = `https://github.com/${repository}/actions/runs/${runId}/attempts/2`;

const metadata = {
  artifactId,
  expired: false,
  workflowHeadSha: sourceSha,
  workflowRepositoryId: sourceRepositoryId,
  workflowRunAttempt: runAttempt,
  workflowRunId: runId,
};

const verificationResults = [
  {
    attestation: { bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" } },
    verificationResult: {
      signature: {
        certificate: {
          buildSignerDigest: signerSha,
          buildSignerURI: `https://github.com/${repository}/${signerWorkflow}@refs/heads/main`,
          githubWorkflowRepository: repository,
          githubWorkflowSHA: sourceSha,
          runInvocationURI: runInvocationUri,
          runnerEnvironment: "github-hosted",
          sourceRepositoryDigest: sourceSha,
          sourceRepositoryIdentifier: sourceRepositoryId,
          subjectAlternativeName: `https://github.com/${repository}/${signerWorkflow}@refs/heads/main`,
        },
      },
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{ name: "staging-protected-evidence.json", digest: { sha256: subjectSha256 } }],
        predicate: {
          buildDefinition: {
            externalParameters: {
              workflow: {
                path: `/${signerWorkflow}`,
                repository: `https://github.com/${repository}`,
              },
            },
          },
          runDetails: {
            metadata: { invocationId: runInvocationUri },
          },
        },
      },
    },
  },
];

const expected = {
  artifactId,
  repository,
  runId,
  runAttempt,
  signerSha,
  signerWorkflow,
  sourceRepositoryId,
  sourceSha,
  subjectSha256,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

assert.deepEqual(assertGitHubArtifactRunMetadata(metadata, expected), {
  artifactId,
  runAttempt,
  runId,
  sourceRepositoryId,
  sourceSha,
});
assert.deepEqual(assertGitHubAttestationRunBinding(verificationResults, expected), {
  attempt: "2",
  runInvocationUri,
  subjectSha256,
});

assert.throws(
  () => assertGitHubArtifactRunMetadata({ ...metadata, artifactId: "123456790" }, expected),
  /artifact ID/i,
  "metadata for a different artifact must not authorize copied bytes",
);
assert.throws(
  () => assertGitHubArtifactRunMetadata({ ...metadata, workflowRunAttempt: "1" }, expected),
  /run attempt/i,
  "metadata from a different attempt of the same run must not authorize copied bytes",
);
assert.throws(
  () => assertGitHubArtifactRunMetadata({ ...metadata, workflowRunId: "987654322" }, expected),
  /workflow run/i,
  "a manually re-uploaded artifact must not inherit the original run identity",
);
assert.throws(
  () => assertGitHubArtifactRunMetadata({ ...metadata, expired: true }, expected),
  /expired/i,
);
assert.throws(
  () => assertGitHubArtifactRunMetadata({ ...metadata, workflowRepositoryId: "7654322" }, expected),
  /repository ID/i,
);
assert.throws(
  () => assertGitHubArtifactRunMetadata({ ...metadata, workflowHeadSha: "d".repeat(40) }, expected),
  /head SHA/i,
);

{
  const previousAttempt = clone(verificationResults);
  previousAttempt[0].verificationResult.signature.certificate.runInvocationURI = `https://github.com/${repository}/actions/runs/${runId}/attempts/1`;
  previousAttempt[0].verificationResult.statement.predicate.runDetails.metadata.invocationId =
    previousAttempt[0].verificationResult.signature.certificate.runInvocationURI;
  assert.throws(
    () => assertGitHubAttestationRunBinding(previousAttempt, expected),
    /exact Actions run/i,
    "an attestation from a different attempt of the same run must not authorize copied bytes",
  );
}

{
  const copied = clone(verificationResults);
  copied[0].verificationResult.signature.certificate.runInvocationURI = `https://github.com/${repository}/actions/runs/987654320/attempts/2`;
  copied[0].verificationResult.statement.predicate.runDetails.metadata.invocationId =
    copied[0].verificationResult.signature.certificate.runInvocationURI;
  assert.throws(
    () => assertGitHubAttestationRunBinding(copied, expected),
    /exact Actions run/i,
    "valid bytes attested by an older run must not authorize a re-upload",
  );
}

{
  const mismatchedStatement = clone(verificationResults);
  mismatchedStatement[0].verificationResult.statement.predicate.runDetails.metadata.invocationId = `https://github.com/${repository}/actions/runs/${runId}/attempts/1`;
  assert.throws(
    () => assertGitHubAttestationRunBinding(mismatchedStatement, expected),
    /exact Actions run/i,
    "the signed provenance invocation must agree with the immutable certificate claim",
  );
}

{
  const missingCertificateRun = clone(verificationResults);
  delete missingCertificateRun[0].verificationResult.signature.certificate.runInvocationURI;
  assert.throws(
    () => assertGitHubAttestationRunBinding(missingCertificateRun, expected),
    /exact Actions run/i,
  );
}

for (const invalidRunUri of [
  `${runInvocationUri}?replayed=true`,
  `${runInvocationUri}#replayed`,
  `https://github.com:443/${repository}/actions/runs/${runId}/attempts/2`,
  `https://github.com/${repository}/actions/runs/${runId}/attempts/0`,
]) {
  const invalid = clone(verificationResults);
  invalid[0].verificationResult.signature.certificate.runInvocationURI = invalidRunUri;
  invalid[0].verificationResult.statement.predicate.runDetails.metadata.invocationId =
    invalidRunUri;
  assert.throws(() => assertGitHubAttestationRunBinding(invalid, expected), /exact Actions run/i);
}

{
  const wrongSubject = clone(verificationResults);
  wrongSubject[0].verificationResult.statement.subject[0].digest.sha256 = "b".repeat(64);
  assert.throws(
    () => assertGitHubAttestationRunBinding(wrongSubject, expected),
    /exact Actions run/i,
  );
}

for (const mutate of [
  (value: typeof verificationResults) => {
    value[0].verificationResult.signature.certificate.githubWorkflowRepository = "other/repo";
  },
  (value: typeof verificationResults) => {
    value[0].verificationResult.signature.certificate.sourceRepositoryDigest = "b".repeat(40);
  },
  (value: typeof verificationResults) => {
    value[0].verificationResult.signature.certificate.sourceRepositoryIdentifier = "7654322";
  },
  (value: typeof verificationResults) => {
    value[0].verificationResult.signature.certificate.buildSignerURI = `https://github.com/${repository}/.github/workflows/other.yml@refs/heads/main`;
  },
  (value: typeof verificationResults) => {
    value[0].verificationResult.signature.certificate.runnerEnvironment = "self-hosted";
  },
]) {
  const invalid = clone(verificationResults);
  mutate(invalid);
  assert.throws(() => assertGitHubAttestationRunBinding(invalid, expected), /exact Actions run/i);
}

assert.throws(
  () => assertGitHubAttestationRunBinding([], expected),
  /verified attestation results/i,
);
assert.throws(
  () => assertGitHubAttestationRunBinding(verificationResults, { ...expected, runId: "0" }),
  /run ID/i,
);

{
  const directory = mkdtempSync(join(tmpdir(), "spx-attestation-large-"));
  try {
    const largeArtifactBytes = Buffer.alloc(17 * 1024 * 1024, 0x61);
    const largeSubjectSha256 = createHash("sha256").update(largeArtifactBytes).digest("hex");
    const largeVerificationResults = clone(verificationResults);
    largeVerificationResults[0].verificationResult.statement.subject[0].digest.sha256 =
      largeSubjectSha256;
    const artifactPath = join(directory, "spx-image.tar");
    const metadataPath = join(directory, "metadata.json");
    const resultsPath = join(directory, "attestation-results.json");
    writeFileSync(artifactPath, largeArtifactBytes);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    writeFileSync(resultsPath, JSON.stringify(largeVerificationResults));
    const verification = spawnSync(
      process.execPath,
      [
        "scripts/lib/github-attestation-run.mjs",
        `--artifact=${artifactPath}`,
        `--artifact-id=${artifactId}`,
        `--artifact-metadata=${metadataPath}`,
        `--attestation-results=${resultsPath}`,
        `--repository=${repository}`,
        `--run-id=${runId}`,
        `--signer-sha=${signerSha}`,
        `--signer-workflow=${signerWorkflow}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(verification.stderr, "");
    assert.equal(verification.status, 0);
    assert.deepEqual(
      JSON.parse(verification.stdout),
      {
        artifactId,
        attempt: runAttempt,
        runId,
        subjectSha256: largeSubjectSha256,
      },
      "release tar subjects larger than 16 MiB must be hashed without buffering them as evidence JSON",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

console.log("GitHub attestation run binding tests passed");
