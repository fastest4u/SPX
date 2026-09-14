import { createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOperatorBundle, verifyOperatorBundleArchive } from "./build-operator-bundle.mjs";
import { readStableRegularFile } from "./lib/safe-file.mjs";
import {
  assembleSignedDeploymentTargetDescriptor,
  buildDeploymentTargetDescriptor,
  deploymentTargetDescriptorArtifactSha256,
  deploymentTargetFactsSha256,
  validateDeploymentTargetFacts,
  verifyDeploymentTargetDescriptor,
} from "../src/services/deployment-target-descriptor.ts";
import {
  canonicalJson,
  finalizeReleaseManifest,
  sha256Hex,
} from "../src/services/release-manifest.ts";

const COMMAND_ARGUMENTS = {
  "validate-facts": ["facts", "environment"],
  build: [
    "facts",
    "release-manifest",
    "operator-bundle",
    "operator-index",
    "signing-workflow",
    "signing-provenance",
    "release-source-sha",
    "run-id",
    "output",
  ],
  assemble: ["descriptor", "signature", "key-id", "output"],
  verify: [
    "artifact",
    "attestation",
    "trust",
    "public-key",
    "release-manifest",
    "operator-bundle",
    "operator-index",
    "operator-root",
  ],
};

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (!(command in COMMAND_ARGUMENTS))
    throw new Error("command must be validate-facts, build, assemble, or verify");
  const values = {};
  for (const token of tokens) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(token);
    if (!match || match[1] in values) throw new Error(`unknown or duplicate argument: ${token}`);
    values[match[1]] = match[2];
  }
  const required = COMMAND_ARGUMENTS[command];
  const unknown = Object.keys(values).filter((key) => !required.includes(key));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.sort().join(", ")}`);
  const missing = required.filter((key) => !values[key]);
  if (missing.length > 0) throw new Error(`missing required argument(s): ${missing.join(", ")}`);
  return { command, ...values };
}

function readRegularFile(pathInput, label) {
  const path = resolve(pathInput);
  return readStableRegularFile(path, label);
}

function readJson(pathInput, label, canonical = false) {
  const bytes = readRegularFile(pathInput, label);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
  if (canonical && !bytes.equals(Buffer.from(canonicalJson(value), "utf8")))
    throw new Error(`${label} bytes must be canonical JSON`);
  return { bytes, value };
}

function writeExclusive(pathInput, value) {
  const handle = openSync(resolve(pathInput), "wx", 0o444);
  try {
    writeFileSync(handle, value, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function validatedRelease(pathInput) {
  const releaseFile = readJson(pathInput, "release manifest", true);
  const release = releaseFile.value;
  if (!release || typeof release !== "object" || Array.isArray(release))
    throw new Error("release manifest must be an object");
  const { imageId, imageTag, buildManifestSha256, ...build } = release;
  const validated = finalizeReleaseManifest({ build, imageId, imageTag });
  if (
    canonicalJson(validated) !== canonicalJson(release) ||
    validated.buildManifestSha256 !== buildManifestSha256
  ) {
    throw new Error("release manifest derived fields do not match canonical content");
  }
  return { bytes: releaseFile.bytes, value: validated };
}

function requireReleaseOperatorMigrationSet(release, operatorBundle) {
  const bundledMigrations = operatorBundle.index.files
    .filter((entry) => /^migrations\/\d{3}_[A-Za-z0-9_-]+\.sql$/.test(entry.path))
    .map((entry) => ({
      name: entry.path.slice("migrations/".length),
      sha256: entry.sha256,
    }));
  if (canonicalJson(bundledMigrations) !== canonicalJson(release.value.migrations)) {
    throw new Error("operator bundle migration set does not match release manifest");
  }
}

function exactObject(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (actual.join(",") !== [...keys].sort().join(","))
    throw new Error(`${label} has missing or unknown fields`);
  return value;
}

function materializeProtectedFacts(
  factsInput,
  release,
  workflowSha256,
  releaseSourceSha,
  signingProvenanceInput,
  runId,
) {
  if (!/^[0-9]{1,20}-[0-9]{1,4}$/.test(runId)) throw new Error("descriptor run id is invalid");
  validateDeploymentTargetFacts(factsInput, factsInput?.releaseEnvironment);
  const facts = exactObject(
    factsInput,
    [
      "releaseEnvironment",
      "runtimeEnvironment",
      "composeProject",
      "topology",
      "target",
      "database",
      "providerTargetFingerprints",
      "publishedPorts",
      "volumeFingerprints",
      "nodeIds",
      "productionDenyTargetSha256",
      "signing",
    ],
    "protected target facts",
  );
  const signing = exactObject(
    facts.signing,
    ["repository", "environment", "subject", "audience", "issuer"],
    "protected target signing facts",
  );
  const provenance = exactObject(
    signingProvenanceInput,
    [
      "repository",
      "workflowRef",
      "environment",
      "subject",
      "audience",
      "issuer",
      "jobWorkflowRef",
      "jobWorkflowSha",
    ],
    "actual signer provenance",
  );
  for (const key of ["repository", "environment", "subject", "audience", "issuer"]) {
    if (provenance[key] !== signing[key]) {
      throw new Error(`actual signer provenance ${key} does not match protected target trust`);
    }
  }
  const issuedAtDate = new Date();
  const issuedAt = issuedAtDate.toISOString();
  const expiresAt = new Date(issuedAtDate.getTime() + 15 * 60 * 1000).toISOString();
  const releaseManifestSha256 = sha256Hex(release.bytes);
  const descriptor = {
    schemaVersion: 1,
    descriptorId: `dtd-${facts.releaseEnvironment}-${releaseSourceSha.slice(0, 12)}-${releaseManifestSha256.slice(0, 12)}-${runId}`,
    ...facts,
    releaseManifestSha256,
    operatorBundleSha256: release.value.operatorBundleSha256,
    releaseSourceSha,
    imageId: release.value.imageId,
    imageTag: release.value.imageTag,
    issuedAt,
    expiresAt,
    signingWorkflowSourceSha: provenance.jobWorkflowSha,
    signingWorkflowFileSha256: workflowSha256,
    signing: provenance,
  };
  return { ...descriptor, targetFactsSha256: deploymentTargetFactsSha256(descriptor) };
}

function validateFactsCommand(args) {
  if (args.environment !== "staging" && args.environment !== "production") {
    throw new Error("protected target facts environment is invalid");
  }
  const facts = readJson(args.facts, "protected target facts").value;
  validateDeploymentTargetFacts(facts, args.environment);
  return {};
}

function buildCommand(args) {
  const protectedFacts = readJson(args.facts, "protected target facts").value;
  const release = validatedRelease(args["release-manifest"]);
  if (release.value.sourceSha !== args["release-source-sha"])
    throw new Error("release manifest source SHA does not match the exact requested source SHA");
  const bundle = verifyOperatorBundleArchive({
    archivePath: args["operator-bundle"],
    indexPath: args["operator-index"],
  });
  if (bundle.operatorBundleSha256 !== release.value.operatorBundleSha256)
    throw new Error("verified operator bundle digest does not match release manifest");
  requireReleaseOperatorMigrationSet(release, bundle);
  const workflowBytes = readRegularFile(args["signing-workflow"], "signing workflow");
  const workflowSha256 = sha256Hex(workflowBytes);
  const facts = materializeProtectedFacts(
    protectedFacts,
    release,
    workflowSha256,
    args["release-source-sha"],
    readJson(args["signing-provenance"], "actual signer provenance", true).value,
    args["run-id"],
  );
  if (facts.releaseManifestSha256 !== sha256Hex(release.bytes))
    throw new Error("protected facts release manifest digest mismatch");
  if (facts.operatorBundleSha256 !== release.value.operatorBundleSha256)
    throw new Error("protected facts operator bundle digest mismatch");
  if (facts.imageId !== release.value.imageId || facts.imageTag !== release.value.imageTag)
    throw new Error("protected facts image identity mismatch");
  if (facts.signingWorkflowFileSha256 !== workflowSha256)
    throw new Error("protected facts signing workflow file digest mismatch");
  const descriptor = buildDeploymentTargetDescriptor(facts);
  writeExclusive(args.output, canonicalJson(descriptor));
  return { descriptorSha256: sha256Hex(canonicalJson(descriptor)) };
}

function assembleCommand(args) {
  const descriptor = readJson(args.descriptor, "unsigned descriptor", true).value;
  const signature = readRegularFile(args.signature, "KMS signature").toString("utf8").trim();
  const artifact = assembleSignedDeploymentTargetDescriptor(descriptor, {
    keyId: args["key-id"],
    value: signature,
  });
  writeExclusive(args.output, canonicalJson(artifact));
  return { artifactSha256: deploymentTargetDescriptorArtifactSha256(artifact) };
}

function strictTrust(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("descriptor trust policy must be an object");
  const keys = [
    "keyId",
    "repository",
    "workflowRef",
    "environment",
    "subject",
    "audience",
    "issuer",
    "jobWorkflowRef",
    "signingWorkflowSourceSha",
    "signingWorkflowFileSha256",
    "releaseSourceSha",
    "imageId",
    "imageTag",
    "targetFactsSha256",
  ];
  const actual = Object.keys(value).sort();
  if (actual.join(",") !== [...keys].sort().join(","))
    throw new Error("descriptor trust policy has missing or unknown fields");
  return value;
}

function verifyPublishedAttestations(args, pinned) {
  const signerWorkflow = `${pinned.repository}/.github/workflows/deployment-target-descriptor-signer.yml`;
  for (const path of [args.artifact, args.attestation]) {
    let verified = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = spawnSync(
        process.platform === "win32" ? "gh.exe" : "gh",
        [
          "attestation",
          "verify",
          resolve(path),
          "--repo",
          pinned.repository,
          "--signer-workflow",
          signerWorkflow,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (!result.error && result.status === 0) {
        verified = true;
        break;
      }
      if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
    }
    if (!verified) throw new Error("GitHub artifact attestation verification failed");
  }
}

function verifyCommand(args) {
  const artifact = readJson(args.artifact, "signed descriptor artifact", true).value;
  const attestation = readJson(args.attestation, "verified attestation claims", true).value;
  const pinned = strictTrust(readJson(args.trust, "descriptor trust policy", true).value);
  verifyPublishedAttestations(args, pinned);
  const release = validatedRelease(args["release-manifest"]);
  const bundle = verifyOperatorBundle({
    root: args["operator-root"],
    archivePath: args["operator-bundle"],
    indexPath: args["operator-index"],
  });
  if (bundle.operatorBundleSha256 !== release.value.operatorBundleSha256)
    throw new Error("verified operator bundle digest does not match release manifest");
  requireReleaseOperatorMigrationSet(release, bundle);
  const publicKey = createPublicKey(readRegularFile(args["public-key"], "descriptor public key"));
  const descriptor = verifyDeploymentTargetDescriptor({
    artifact,
    attestation,
    trust: {
      ...pinned,
      publicKey,
      releaseManifestSha256: sha256Hex(release.bytes),
      operatorBundleSha256: release.value.operatorBundleSha256,
      now: new Date(),
    },
  });
  return {
    descriptorId: descriptor.descriptorId,
    artifactSha256: deploymentTargetDescriptorArtifactSha256(artifact),
  };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  let result;
  if (args.command === "validate-facts") result = validateFactsCommand(args);
  else if (args.command === "build") result = buildCommand(args);
  else if (args.command === "assemble") result = assembleCommand(args);
  else result = verifyCommand(args);
  const response =
    args.command === "verify" || args.command === "validate-facts"
      ? { ok: true, ...result }
      : { stage: args.command, ...result };
  process.stdout.write(`${canonicalJson(response)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
