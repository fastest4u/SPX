import assert from "node:assert/strict";

import {
  buildStagingFaultCommand,
  executeStagingFaultAction,
  parseFaultArgs,
  verifyStagingContainerIdentity,
} from "../scripts/a3-staging-service-fault.mjs";

async function main(): Promise<void> {
const operatorRoot = `/opt/spx-staging/release/${"a".repeat(40)}/operator`;
assert.deepEqual(buildStagingFaultCommand("line-fault", operatorRoot), [
  "compose",
  "-p",
  "spx-staging",
  "--env-file",
  "/etc/spx-staging/runtime.env",
  "-f",
  `${operatorRoot}/docker-compose.yml`,
  "-f",
  `${operatorRoot}/docker-compose.staging.yml`,
  "stop",
  "line-service",
]);
assert.deepEqual(buildStagingFaultCommand("ocr-recover", operatorRoot).slice(-2), ["start", "ocr-service"]);
assert.deepEqual(parseFaultArgs(["line-fault"]), { operation: "line-fault" });
for (const value of ["spx", "spx-production", "default", "production"]) {
  assert.throws(() => parseFaultArgs(["line-fault", `--project=${value}`]), /override|spx-staging/i);
}
assert.throws(() => parseFaultArgs(["line-fault", "--service=web-api"]), /service override/i);
assert.throws(() => parseFaultArgs(["line-fault", "--env-file=.env"]), /env-file override/i);
assert.throws(
  () => parseFaultArgs(["line-fault", "--docker-host=ssh://production"]),
  /remote|override/i,
);

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
    "com.docker.compose.service": "line-service",
    "com.spx.environment": "staging",
    "com.spx.release-sha": binding.candidateSha,
    "com.spx.target-descriptor-sha256": binding.stagingTargetDescriptorSha256,
    "com.spx.operator-bundle-sha256": binding.operatorBundleSha256,
    "com.spx.staging-run-id": binding.stagingRunId,
  },
};
assert.equal(verifyStagingContainerIdentity("line-fault", identity, binding), true);
assert.throws(
  () =>
    verifyStagingContainerIdentity(
      "line-fault",
      {
        ...identity,
        labels: { ...identity.labels, "com.spx.release-sha": "e".repeat(40) },
      },
      binding,
    ),
  /identity|label/i,
);
const events: string[] = [];
await executeStagingFaultAction("line-fault", {
  binding,
  operatorRoot,
  async inspectContainer() {
    events.push("inspect");
    return identity;
  },
  async runDocker(command: string[]) {
    events.push(`docker:${command.slice(-2).join(":")}`);
  },
});
assert.deepEqual(events, ["inspect", "docker:stop:line-service"]);

console.log("A3 staging service fault tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
