import assert from "node:assert/strict";

import {
  buildFaultCommand,
  executeStagingDbFaultAction,
  parseFaultArgs,
  verifyProxyContainerIdentity,
} from "../scripts/a3-staging-db-fault.mjs";

const prefix = [
  "compose",
  "-p",
  "spx-staging",
  "--env-file",
  "/etc/spx-staging/runtime.env",
  "-f",
  `/opt/spx-staging/release/${"a".repeat(40)}/operator/docker-compose.yml`,
  "-f",
  `/opt/spx-staging/release/${"a".repeat(40)}/operator/docker-compose.staging.yml`,
];
const operatorRoot = `/opt/spx-staging/release/${"a".repeat(40)}/operator`;

const binding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  stagingTargetDescriptorSha256: "c".repeat(64),
  operatorBundleSha256: "d".repeat(64),
  stagingRunId: "staging-run-001",
};

const identity = {
  imageId: binding.imageDigest,
  labels: {
    "com.docker.compose.project": "spx-staging",
    "com.docker.compose.service": "staging-db-proxy",
    "com.spx.environment": "staging",
    "com.spx.release-sha": binding.candidateSha,
    "com.spx.target-descriptor-sha256": binding.stagingTargetDescriptorSha256,
    "com.spx.operator-bundle-sha256": binding.operatorBundleSha256,
    "com.spx.staging-run-id": binding.stagingRunId,
  },
};

async function main(): Promise<void> {
  assert.deepEqual(buildFaultCommand("fault", operatorRoot), [...prefix, "stop", "staging-db-proxy"]);
  assert.deepEqual(buildFaultCommand("recover", operatorRoot), [
    ...prefix,
    "up",
    "-d",
    "--no-deps",
    "staging-db-proxy",
  ]);
  assert.equal(JSON.stringify(buildFaultCommand("fault", operatorRoot)).includes("mysqld"), false);
  assert.throws(() => buildFaultCommand("fault", "/root/SPX"), /release|operator root/i);
  for (const args of [
    ["fault", "--env-file=/etc/spx-production/runtime.env"],
    ["fault", "--service=web-api"],
    ["--confirm-staging-db-proxy-fault"],
  ]) {
    assert.throws(() => parseFaultArgs(args), /override|controller context|operation/i);
  }

  assert.equal(verifyProxyContainerIdentity(identity, binding), true);
  assert.throws(
    () =>
      verifyProxyContainerIdentity(
        {
          ...identity,
          labels: { ...identity.labels, "com.spx.environment": "production" },
        },
        binding,
      ),
    /identity/i,
  );

  const events: string[] = [];
  assert.deepEqual(
    await executeStagingDbFaultAction("fault", {
      binding,
      operatorRoot,
      async inspectContainer() {
        events.push("inspect");
        return identity;
      },
      async runDocker(command: string[]) {
        events.push(`docker:${command.slice(-2).join(":")}`);
      },
    }),
    { ok: true, operation: "fault" },
  );
  assert.deepEqual(events, ["inspect", "docker:stop:staging-db-proxy"]);

  console.log("A3 staging DB fault tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
