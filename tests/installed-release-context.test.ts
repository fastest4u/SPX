import assert from "node:assert/strict";

import {
  buildInstalledStagingComposeEnvironment,
  buildInstalledStagingComposePrefix,
  loadInstalledReleaseBinding,
  validateInstalledStagingOperatorProjection,
} from "../scripts/lib/staging-installed-context.mjs";

const globalKey = "__SPX_TEST_INSTALLED_RELEASE_BINDING__";
const productionBinding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: "c".repeat(64),
  environment: "supervised-production",
  topology: "split",
  composeProject: "spx-production",
  targetDescriptorSha256: "d".repeat(64),
  operatorBundleSha256: "e".repeat(64),
  productionIdentityApprovalSha256: "f".repeat(64),
};
const stagingBinding = {
  candidateSha: "1".repeat(40),
  imageDigest: `sha256:${"2".repeat(64)}`,
  releaseManifestSha256: "3".repeat(64),
  environment: "staging",
  topology: "split",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: "4".repeat(64),
  operatorBundleSha256: "5".repeat(64),
  stagingApprovalEnvelopeSha256: "6".repeat(64),
  actionJournalHeadSha256: "7".repeat(64),
  stagingRunId: "staging-run-001",
};

async function main(): Promise<void> {
  process.env.NODE_ENV = "test";
  (globalThis as Record<string, unknown>)[globalKey] = productionBinding;
  try {
    assert.deepEqual(
      await loadInstalledReleaseBinding({ environment: "supervised-production" }),
      productionBinding,
    );
    await assert.rejects(
      () => loadInstalledReleaseBinding({ environment: "staging" }),
      /environment does not match/i,
    );
  } finally {
    delete (globalThis as Record<string, unknown>)[globalKey];
  }

  const operatorRoot = `/opt/spx-staging/release/${stagingBinding.candidateSha}/operator`;
  assert.equal(
    validateInstalledStagingOperatorProjection({
      binding: stagingBinding,
      projectionPath: "/opt/spx-staging/release/current",
      resolvedPath: operatorRoot,
      projectionIsSymlink: true,
      targetIsSymlink: false,
      targetIsDirectory: true,
      targetUid: 0,
      targetMode: 0o755,
      expectedUid: 0,
    }),
    operatorRoot,
  );
  assert.throws(
    () => validateInstalledStagingOperatorProjection({
      binding: stagingBinding,
      projectionPath: "/opt/spx-staging/release/current",
      resolvedPath: `/opt/spx-staging/release/${"9".repeat(40)}/operator`,
      projectionIsSymlink: true,
      targetIsSymlink: false,
      targetIsDirectory: true,
      targetUid: 0,
      targetMode: 0o755,
      expectedUid: 0,
    }),
    /projection|release|candidate/i,
  );
  assert.throws(
    () => validateInstalledStagingOperatorProjection({
      binding: stagingBinding,
      projectionPath: "/opt/spx-staging/release/current",
      resolvedPath: operatorRoot,
      projectionIsSymlink: false,
      targetIsSymlink: false,
      targetIsDirectory: true,
      targetUid: 0,
      targetMode: 0o755,
      expectedUid: 0,
    }),
    /projection|symlink/i,
  );
  assert.deepEqual(buildInstalledStagingComposePrefix(operatorRoot), [
    "compose", "-p", "spx-staging", "--env-file", "/etc/spx-staging/runtime.env",
    "-f", `${operatorRoot}/docker-compose.yml`,
    "-f", `${operatorRoot}/docker-compose.staging.yml`,
  ]);
  assert.deepEqual(buildInstalledStagingComposeEnvironment(stagingBinding, operatorRoot), {
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    SPX_IMAGE: stagingBinding.imageDigest,
    SPX_RELEASE_SHA: stagingBinding.candidateSha,
    SPX_TARGET_DESCRIPTOR_SHA256: stagingBinding.stagingTargetDescriptorSha256,
    SPX_OPERATOR_BUNDLE_SHA256: stagingBinding.operatorBundleSha256,
    SPX_RUNTIME_ENVIRONMENT: "staging",
    SPX_STAGING_RUN_ID: stagingBinding.stagingRunId,
    SPX_RELEASE_MANIFEST_PATH: `/opt/spx-staging/release/${stagingBinding.candidateSha}/release-manifest.json`,
    SPX_TARGET_DESCRIPTOR_PATH: `/opt/spx-staging/release/${stagingBinding.candidateSha}/deployment-target-descriptor.json`,
    SPX_DEPLOYMENT_CONTEXT_PATH: `/opt/spx-staging/release/${stagingBinding.candidateSha}/deployment-context.json`,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
