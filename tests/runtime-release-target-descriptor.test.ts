import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync("docker-compose.a3.yml", "utf8");
const deployWorkflow = readFileSync(".github/workflows/trusted-deploy.yml", "utf8");
const deploymentDocs = readFileSync("docs/deployment-a3.md", "utf8");

const common = compose.match(/x-spx-common:[\s\S]*?(?=\nx-spx-db-environment:)/)?.[0];
assert.ok(common, "Compose must define the common immutable runtime boundary");
for (const [source, target] of [
  ["spx_release_manifest", "/run/secrets/spx-release-manifest"],
  ["spx_target_descriptor", "/run/secrets/spx-target-descriptor"],
  ["spx_deployment_context", "/run/secrets/spx-deployment-context"],
]) {
  assert.match(
    common,
    new RegExp(`source: ${source}[\\s\\S]*target: ${target.replaceAll("/", "\\/")}[\\s\\S]*mode: 0444`),
    `${source} must be inherited read-only by every runtime role`,
  );
}
assert.match(
  compose,
  /spx_target_descriptor:[\s\S]*file: \$\{SPX_TARGET_DESCRIPTOR_PATH:\?SPX_TARGET_DESCRIPTOR_PATH is required\}/,
);
assert.match(
  compose,
  /spx_deployment_context:[\s\S]*file: \$\{SPX_DEPLOYMENT_CONTEXT_PATH:\?SPX_DEPLOYMENT_CONTEXT_PATH is required\}/,
);

assert.match(
  deployWorkflow,
  /install -m 0444 "\$\{INCOMING\}\/target\/deployment-target-descriptor\.json" "\$\{RELEASE_PARENT\}\.new\/deployment-target-descriptor\.json"/,
  "trusted deploy must install the exact verified descriptor artifact beside the release",
);
assert.match(
  deployWorkflow,
  /SPX_TARGET_DESCRIPTOR_PATH="\$\{RELEASE_PARENT\}\/deployment-target-descriptor\.json"[\s\S]*SPX_DEPLOYMENT_CONTEXT_PATH="\$\{RELEASE_PARENT\}\/deployment-context\.json"[\s\S]*docker compose -p spx-production/,
  "production Compose must receive descriptor paths derived from the immutable release parent",
);
assert.match(
  deployWorkflow,
  /SPX_TARGET_DESCRIPTOR_PATH="\$\{RELEASE_PARENT\}\/deployment-target-descriptor\.json"[\s\S]*SPX_DEPLOYMENT_CONTEXT_PATH="\$\{RELEASE_PARENT\}\/deployment-context\.json"[\s\S]*docker compose -p spx-staging/,
  "staging Compose must receive descriptor paths derived from the immutable release parent",
);

assert.match(deploymentDocs, /export SPX_TARGET_DESCRIPTOR_PATH="\$RELEASE_PARENT\/deployment-target-descriptor\.json"/);
assert.match(deploymentDocs, /export SPX_DEPLOYMENT_CONTEXT_PATH="\$RELEASE_PARENT\/deployment-context\.json"/);
assert.match(
  deploymentDocs,
  /task9_compose\(\)[\s\S]*SPX_TARGET_DESCRIPTOR_PATH="\$TASK9_RELEASE_PARENT\/deployment-target-descriptor\.json"[\s\S]*SPX_DEPLOYMENT_CONTEXT_PATH="\$TASK9_RELEASE_PARENT\/deployment-context\.json"[\s\S]*docker compose -p "\$TASK9_COMPOSE_PROJECT"/,
  "Task 9 must mount identity files from the same immutable staging release",
);

console.log("runtime release target descriptor tests passed");
