import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import { stagingOperationDescriptor } from "../scripts/lib/staging-operation-registry.mjs";

async function main() {
  const controllerPath = resolve("scripts", "staging-rollout-controller.mjs");
  const source = await readFile(controllerPath, "utf8");
  assert.match(source, /\/usr\/local\/libexec\/spx-staging-actions/);
  assert.match(source, /argv\.length !== 3/);
  assert.match(source, /loadInstalledReleaseBinding/);
  assert.match(source, /verifyInstalledStagingActionHandlers/);
  assert.match(source, /stagingActionHandler/);
  assert.doesNotMatch(source, /shell:\s*true|SPX_TEST_STAGING_ACTION_HANDLER_ROOT/);

  assert.deepEqual(
    REQUIRED_STAGING_ACTION_PLAN.filter((action) => action.kind === "emergency").map(
      (action) => [action.actionId, action.scope],
    ),
    [
      ["staging-guard-emergency-stop", "guard-emergency-stop"],
      ["staging-watchdog-emergency-stop", "watchdog-emergency-stop"],
    ],
  );
  assert.equal(
    new Set(REQUIRED_STAGING_ACTION_PLAN.map((action) => action.actionId)).size,
    REQUIRED_STAGING_ACTION_PLAN.length,
  );
  assert.deepEqual(
    REQUIRED_STAGING_ACTION_PLAN.map((action) => action.sequence),
    REQUIRED_STAGING_ACTION_PLAN.map((_, index) => index + 1),
  );
  for (const action of REQUIRED_STAGING_ACTION_PLAN) {
    assert.equal(action.mutationSha256, sha256Canonical(stagingOperationDescriptor(action)));
  }

  const first = REQUIRED_STAGING_ACTION_PLAN[0];
  const invalid = spawnSync(
    process.execPath,
    [controllerPath, "execute", first.actionId, first.scope, "caller-extra-argument"],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SPX_STAGING_OPERATION_DESCRIPTOR: canonicalJson(stagingOperationDescriptor(first)),
        SPX_STAGING_RUN_ID: "staging-run-20260710-001",
      },
    },
  );
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout), {
    ok: false,
    code: "staging-controller-failed",
  });
  assert.equal(invalid.stderr, "");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
