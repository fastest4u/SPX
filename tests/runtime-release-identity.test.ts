import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deploymentTargetDescriptorArtifactSha256,
  deploymentTargetFactsSha256,
  signDeploymentTargetDescriptor,
  type DeploymentTargetDescriptorInput,
} from "../src/services/deployment-target-descriptor.js";
import {
  loadRuntimeReleaseIdentity,
  runtimeNodeRegistration,
} from "../src/services/runtime-release-identity.js";
import {
  buildBuildManifest,
  canonicalJson,
  finalizeReleaseManifest,
} from "../src/services/release-manifest.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const temp = mkdtempSync(join(tmpdir(), "spx-runtime-release-identity-"));
try {
  const build = buildBuildManifest({
    version: "1.0.0",
    sourceSha: "a".repeat(40),
    buildId: "run-123",
    artifactSha256: "c".repeat(64),
    operatorBundleSha256: "1".repeat(64),
    schema: { min: 36, max: 36 },
    migrations: [{ name: "036_create_gate6_control_plane.sql", sha256: "d".repeat(64) }],
  });
  const release = finalizeReleaseManifest({
    build,
    imageId: `sha256:${"b".repeat(64)}`,
    imageTag: `spx-app:${"a".repeat(40)}`,
  });
  const buildBytes = canonicalJson(build);
  const releaseBytes = canonicalJson(release);
  const descriptorFixture = JSON.parse(
    readFileSync("tests/fixtures/deployment-target-descriptor.complete.json", "utf8"),
  ) as DeploymentTargetDescriptorInput;
  const descriptorInput: DeploymentTargetDescriptorInput = {
    ...descriptorFixture,
    releaseManifestSha256: sha256(releaseBytes),
    operatorBundleSha256: release.operatorBundleSha256,
    releaseSourceSha: release.sourceSha,
    imageId: release.imageId,
    imageTag: release.imageTag,
  };
  descriptorInput.targetFactsSha256 = deploymentTargetFactsSha256(descriptorInput as unknown as Record<string, unknown>);
  const { privateKey } = generateKeyPairSync("ed25519");
  const signedDescriptor = signDeploymentTargetDescriptor(descriptorInput, {
    keyId: "runtime-identity-test-key",
    privateKey,
  });
  const descriptorBytes = canonicalJson(signedDescriptor);
  const context = {
    schemaVersion: 1,
    target: "staging",
    sourceSha: release.sourceSha,
    imageId: release.imageId,
    imageTag: release.imageTag,
    topology: "split",
    composeProject: "spx-staging",
    releaseManifestSha256: sha256(releaseBytes),
    operatorBundleSha256: release.operatorBundleSha256,
    descriptorArtifactSha256: deploymentTargetDescriptorArtifactSha256(signedDescriptor),
  };

  const buildPath = join(temp, "build-manifest.json");
  const releasePath = join(temp, "release-manifest.json");
  const descriptorPath = join(temp, "target-descriptor.json");
  const contextPath = join(temp, "deployment-context.json");
  writeFileSync(buildPath, buildBytes);
  writeFileSync(releasePath, releaseBytes);
  writeFileSync(descriptorPath, descriptorBytes);
  writeFileSync(contextPath, canonicalJson(context));

  const identity = loadRuntimeReleaseIdentity({
    buildManifestPath: buildPath,
    releaseManifestPath: releasePath,
    targetDescriptorPath: descriptorPath,
    deploymentContextPath: contextPath,
  });
  assert.deepEqual(identity, {
    version: "1.0.0",
    gitSha: "a".repeat(40),
    buildId: "run-123",
    environment: "staging",
    topology: "split",
    imageId: `sha256:${"b".repeat(64)}`,
    imageTag: `spx-app:${"a".repeat(40)}`,
    targetDescriptorSha256: deploymentTargetDescriptorArtifactSha256(signedDescriptor),
    operatorBundleSha256: "1".repeat(64),
  });
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(JSON.stringify(identity).includes(temp), false);

  assert.deepEqual(
    runtimeNodeRegistration(identity, "2026-07-11T01:00:00.000Z"),
    {
      version: "1.0.0",
      metadata: {
        gitSha: "a".repeat(40),
        buildId: "run-123",
        environment: "staging",
        topology: "split",
        imageId: `sha256:${"b".repeat(64)}`,
        imageTag: `spx-app:${"a".repeat(40)}`,
        targetDescriptorSha256: deploymentTargetDescriptorArtifactSha256(signedDescriptor),
        operatorBundleSha256: "1".repeat(64),
        startedAt: "2026-07-11T01:00:00.000Z",
      },
    },
  );

  writeFileSync(contextPath, canonicalJson({ ...context, composeProject: "spx-production" }));
  assert.throws(
    () => loadRuntimeReleaseIdentity({
      buildManifestPath: buildPath,
      releaseManifestPath: releasePath,
      targetDescriptorPath: descriptorPath,
      deploymentContextPath: contextPath,
    }),
    /compose project|target descriptor/i,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("runtime release identity tests passed");
