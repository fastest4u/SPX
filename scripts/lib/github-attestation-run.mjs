import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { canonicalJson, readEvidenceBytes } from "./evidence-artifact.mjs";

const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const WORKFLOW_PATTERN = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.ya?ml$/;
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const MAX_ARTIFACT_BYTES = 10n * 1024n * 1024n * 1024n;
const MAX_ATTESTATION_RESULTS_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDecimalId(value, label) {
  if (typeof value !== "string" || !DECIMAL_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a positive decimal identifier`);
  }
  return value;
}

function assertExpectedBinding(expected) {
  if (!isPlainObject(expected)) throw new Error("expected attestation binding is required");
  const artifactId = assertDecimalId(expected.artifactId, "artifact ID");
  const runId = assertDecimalId(expected.runId, "run ID");
  const runAttempt = assertDecimalId(expected.runAttempt, "run attempt");
  if (typeof expected.repository !== "string" || !REPOSITORY_PATTERN.test(expected.repository)) {
    throw new Error("repository must be an owner/repository pair");
  }
  if (
    typeof expected.signerWorkflow !== "string" ||
    !WORKFLOW_PATTERN.test(expected.signerWorkflow)
  ) {
    throw new Error("signer workflow must be an exact .github/workflows file");
  }
  if (typeof expected.signerSha !== "string" || !COMMIT_SHA_PATTERN.test(expected.signerSha)) {
    throw new Error("signer SHA must be a lowercase full commit SHA");
  }
  const sourceRepositoryId = assertDecimalId(expected.sourceRepositoryId, "source repository ID");
  if (typeof expected.sourceSha !== "string" || !COMMIT_SHA_PATTERN.test(expected.sourceSha)) {
    throw new Error("source SHA must be a lowercase full commit SHA");
  }
  if (typeof expected.subjectSha256 !== "string" || !SHA256_PATTERN.test(expected.subjectSha256)) {
    throw new Error("subject SHA-256 must be a lowercase digest");
  }
  return {
    artifactId,
    repository: expected.repository,
    runAttempt,
    runId,
    signerSha: expected.signerSha,
    signerWorkflow: expected.signerWorkflow,
    sourceRepositoryId,
    sourceSha: expected.sourceSha,
    subjectSha256: expected.subjectSha256,
  };
}

export function assertGitHubArtifactRunMetadata(metadata, expected) {
  const binding = assertExpectedBinding(expected);
  if (!isPlainObject(metadata)) throw new Error("artifact metadata projection is required");
  const keys = Object.keys(metadata).sort();
  if (
    canonicalJson(keys) !==
    canonicalJson([
      "artifactId",
      "expired",
      "workflowHeadSha",
      "workflowRepositoryId",
      "workflowRunAttempt",
      "workflowRunId",
    ])
  ) {
    throw new Error("artifact metadata projection must contain the exact trusted fields");
  }
  if (
    assertDecimalId(metadata.artifactId, "artifact metadata artifact ID") !== binding.artifactId
  ) {
    throw new Error("artifact ID does not match the downloaded artifact selector");
  }
  if (metadata.expired !== false) throw new Error("artifact metadata reports an expired artifact");
  if (
    assertDecimalId(metadata.workflowRunId, "artifact metadata workflow run ID") !== binding.runId
  ) {
    throw new Error("artifact metadata workflow run does not match the selected run");
  }
  if (
    assertDecimalId(metadata.workflowRunAttempt, "artifact metadata workflow run attempt") !==
    binding.runAttempt
  ) {
    throw new Error("artifact metadata run attempt does not match the selected run attempt");
  }
  if (
    assertDecimalId(metadata.workflowRepositoryId, "artifact metadata repository ID") !==
    binding.sourceRepositoryId
  ) {
    throw new Error("artifact metadata repository ID does not match the attested source");
  }
  if (metadata.workflowHeadSha !== binding.sourceSha) {
    throw new Error("artifact metadata head SHA does not match the attested source");
  }
  return {
    artifactId: binding.artifactId,
    runAttempt: binding.runAttempt,
    runId: binding.runId,
    sourceRepositoryId: binding.sourceRepositoryId,
    sourceSha: binding.sourceSha,
  };
}

function matchesExactVerifiedAttestation(entry, binding) {
  if (!isPlainObject(entry) || !isPlainObject(entry.verificationResult)) return undefined;
  const result = entry.verificationResult;
  const certificate = result.signature?.certificate;
  const statement = result.statement;
  if (!isPlainObject(certificate) || !isPlainObject(statement)) return undefined;

  const expectedRunInvocationUri =
    `https://github.com/${binding.repository}/actions/runs/${binding.runId}` +
    `/attempts/${binding.runAttempt}`;
  if (certificate.runInvocationURI !== expectedRunInvocationUri) return undefined;

  const workflowIdentity = `https://github.com/${binding.repository}/${binding.signerWorkflow}@`;
  if (
    certificate.githubWorkflowRepository !== binding.repository ||
    certificate.buildSignerDigest !== binding.signerSha ||
    certificate.runnerEnvironment !== "github-hosted" ||
    certificate.sourceRepositoryDigest !== binding.sourceSha ||
    certificate.sourceRepositoryIdentifier !== binding.sourceRepositoryId ||
    typeof certificate.buildSignerURI !== "string" ||
    !certificate.buildSignerURI.startsWith(workflowIdentity) ||
    typeof certificate.subjectAlternativeName !== "string" ||
    !certificate.subjectAlternativeName.startsWith(workflowIdentity)
  ) {
    return undefined;
  }

  if (
    statement._type !== IN_TOTO_STATEMENT_V1 ||
    statement.predicateType !== SLSA_PROVENANCE_V1 ||
    !Array.isArray(statement.subject) ||
    !statement.subject.some(
      (subject) =>
        isPlainObject(subject) &&
        isPlainObject(subject.digest) &&
        subject.digest.sha256 === binding.subjectSha256,
    )
  ) {
    return undefined;
  }

  const provenanceInvocation = statement.predicate?.runDetails?.metadata?.invocationId;
  if (provenanceInvocation !== certificate.runInvocationURI) {
    return undefined;
  }

  return {
    attempt: binding.runAttempt,
    runInvocationUri: certificate.runInvocationURI,
    subjectSha256: binding.subjectSha256,
  };
}

export function assertGitHubAttestationRunBinding(verificationResults, expected) {
  const binding = assertExpectedBinding(expected);
  if (
    !Array.isArray(verificationResults) ||
    verificationResults.length === 0 ||
    verificationResults.length > 30
  ) {
    throw new Error("verified attestation results must be a bounded non-empty array");
  }
  for (const entry of verificationResults) {
    const match = matchesExactVerifiedAttestation(entry, binding);
    if (match) return match;
  }
  throw new Error("no verified attestation is bound to the exact Actions run and subject");
}

function parseJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function hasStableFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function sha256StableRegularFile(path) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("artifact must be a regular file and not a symbolic link");
  }
  if (before.size > MAX_ARTIFACT_BYTES) {
    throw new Error("artifact exceeds the 10 GiB size limit");
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ELOOP") {
      throw new Error("artifact must not be a symbolic link");
    }
    throw error;
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !hasStableFileIdentity(before, opened)) {
      throw new Error("artifact changed while it was being opened");
    }

    const hash = createHash("sha256");
    let bytesRead = 0n;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytesRead += BigInt(chunk.byteLength);
      if (bytesRead > MAX_ARTIFACT_BYTES) {
        throw new Error("artifact exceeds the 10 GiB size limit");
      }
      hash.update(chunk);
    }

    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      bytesRead !== opened.size ||
      !hasStableFileIdentity(opened, after) ||
      !hasStableFileIdentity(opened, pathAfter)
    ) {
      throw new Error("artifact changed while it was being hashed");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function verifyGitHubAttestationRunFiles(options) {
  if (!isPlainObject(options)) throw new Error("verification file options are required");
  const [subjectSha256, metadataBytes, verificationBytes] = await Promise.all([
    sha256StableRegularFile(options.artifactPath),
    readEvidenceBytes(options.artifactMetadataPath, { maxFileBytes: MAX_METADATA_BYTES }),
    readEvidenceBytes(options.attestationResultsPath, {
      maxFileBytes: MAX_ATTESTATION_RESULTS_BYTES,
    }),
  ]);
  const metadata = parseJsonBytes(metadataBytes, "artifact metadata");
  const expected = {
    artifactId: options.artifactId,
    repository: options.repository,
    runAttempt: metadata?.workflowRunAttempt,
    runId: options.runId,
    signerSha: options.signerSha,
    signerWorkflow: options.signerWorkflow,
    sourceRepositoryId: metadata?.workflowRepositoryId,
    sourceSha: metadata?.workflowHeadSha,
    subjectSha256,
  };
  assertGitHubArtifactRunMetadata(metadata, expected);
  const attestation = assertGitHubAttestationRunBinding(
    parseJsonBytes(verificationBytes, "attestation verification results"),
    expected,
  );
  return {
    artifactId: expected.artifactId,
    attempt: attestation.attempt,
    runId: expected.runId,
    subjectSha256: expected.subjectSha256,
  };
}

function parseCliArgs(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) {
      throw new Error("attestation run verifier received an invalid argument");
    }
    values[match[1]] = match[2];
  }
  const expectedKeys = [
    "artifact",
    "artifact-id",
    "artifact-metadata",
    "attestation-results",
    "repository",
    "run-id",
    "signer-sha",
    "signer-workflow",
  ];
  if (canonicalJson(Object.keys(values).sort()) !== canonicalJson(expectedKeys)) {
    throw new Error("attestation run verifier requires the exact documented arguments");
  }
  return {
    artifactId: values["artifact-id"],
    artifactMetadataPath: values["artifact-metadata"],
    artifactPath: values.artifact,
    attestationResultsPath: values["attestation-results"],
    repository: values.repository,
    runId: values["run-id"],
    signerSha: values["signer-sha"],
    signerWorkflow: values["signer-workflow"],
  };
}

async function main() {
  const result = await verifyGitHubAttestationRunFiles(parseCliArgs(process.argv.slice(2)));
  process.stdout.write(`${canonicalJson(result)}\n`);
}

const isMain =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "attestation run verification failed");
    process.exitCode = 1;
  });
}
