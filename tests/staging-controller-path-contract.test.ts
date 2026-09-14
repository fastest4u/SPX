import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  STAGING_ACTION_HANDLER_MANIFEST,
  handlerWrapperSource,
} from "../scripts/lib/staging-action-handler-manifest.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import { stagingOperationDescriptor } from "../scripts/lib/staging-operation-registry.mjs";
import {
  PHASE3_ACTION_IDS,
  PHASE3_SEMANTIC_SOURCE_IDS,
} from "../scripts/lib/phase3-staging-evidence.mjs";
import {
  PHASE3_STAGING_ACTIONS,
  buildStagingPhase3Transitions,
} from "../scripts/staging-phase3-action-handler.mjs";

const ACTIVE_CONTROLLER =
  "/opt/spx-staging/release/current/operator/scripts/staging-rollout-controller.mjs";
const STALE_OPERATOR_ROOT = "/opt/spx-staging/operator";

async function main(): Promise<void> {
  const observationIds = ["phase3-schema-verify", "phase3-fence-ack-wait"];
  assert.equal(REQUIRED_STAGING_ACTION_PLAN.length, 44);
  const first = REQUIRED_STAGING_ACTION_PLAN[0];
  assert.deepEqual(stagingOperationDescriptor(first), {
    schemaVersion: 1,
    controller: ACTIVE_CONTROLLER,
    operation: first.actionId,
    scope: first.scope,
    executable: "/usr/bin/node",
    argv: [ACTIVE_CONTROLLER, "execute", first.actionId, first.scope],
  });

  assert.equal(STAGING_ACTION_HANDLER_MANIFEST.length, 44);
  for (const observationId of observationIds) {
    assert.equal(
      REQUIRED_STAGING_ACTION_PLAN.some((action) => action.actionId === observationId),
      false,
    );
    assert.equal(
      STAGING_ACTION_HANDLER_MANIFEST.some((action) => action.actionId === observationId),
      false,
    );
    assert.equal(PHASE3_ACTION_IDS.includes(observationId), false);
    assert.equal(
      PHASE3_STAGING_ACTIONS.some((action) => action.actionId === observationId),
      false,
    );
    assert.throws(
      () => buildStagingPhase3Transitions(
        observationId,
        { phase3: { canaryTeamId: 2, canaryEpoch: "ifn-epoch-001" } },
        "/opt/spx-staging/release/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/operator",
      ),
      /action|observation/i,
    );
  }
  const wrapper = handlerWrapperSource(STAGING_ACTION_HANDLER_MANIFEST[0]);
  assert.ok(wrapper.includes(JSON.stringify(ACTIVE_CONTROLLER)));
  assert.match(wrapper, /parent\[1\] !== activeController/);
  assert.match(wrapper, /realpathSync\.native\(activeController\)/);
  assert.match(wrapper, /lstatSync\(current, \{ bigint: true \}\)/);
  assert.match(wrapper, /status\.isSymbolicLink\(\)/);
  assert.match(wrapper, /status\.isFile\(\)/);
  assert.match(wrapper, /Number\(status\.uid\) !== 0/);
  assert.match(
    wrapper,
    /\/opt\\\/spx-staging\\\/release\\\/\[0-9a-f\]\{40\}\\\/operator/,
  );
  assert.match(wrapper, /const script = controller\[1\] \+ "\/" \+/);
  assert.ok(!wrapper.includes(STALE_OPERATOR_ROOT));

  const watchdog = await readFile("scripts/a3-capacity-watchdog.mjs", "utf8");
  assert.match(
    watchdog,
    /const ROLLOUT_CONTROLLER =\s*"\/opt\/spx-staging\/release\/current\/operator\/scripts\/a3-staging-rollout-controller\.mjs";/,
  );

  const expectedUnits = new Map([
    [
      "deploy/systemd/spx-a3-capacity-guard.service",
      "ExecStart=/usr/bin/node /opt/spx-staging/release/current/operator/scripts/a3-capacity-guard.mjs run",
    ],
    [
      "deploy/systemd/spx-a3-capacity-watchdog.service",
      "ExecStart=/usr/bin/node /opt/spx-staging/release/current/operator/scripts/a3-capacity-watchdog.mjs run",
    ],
  ]);
  for (const [path, expectedExecStart] of expectedUnits) {
    const source = await readFile(path, "utf8");
    assert.ok(source.includes(expectedExecStart));
    assert.ok(!source.includes(STALE_OPERATOR_ROOT));
  }

  assert.ok(!watchdog.includes(STALE_OPERATOR_ROOT));
  const controller = await readFile("scripts/staging-rollout-controller.mjs", "utf8");
  assert.match(
    controller,
    /resolveVerifiedStagingOperatorRoot\(fileURLToPath\(import\.meta\.url\)\)/,
  );
  const installer = await readFile("scripts/install-staging-action-handlers.mjs", "utf8");
  assert.match(
    installer,
    /RELEASE_OPERATOR_PATTERN = \/\^\\\/opt\\\/spx-staging\\\/release\\\/\(\[0-9a-f\]\{40\}\)\\\/operator\$\//,
  );
  assert.match(installer, /const canonicalInstaller = await realpath\(installerPath\)/);
  const phase3Controller = await readFile("scripts/a3-staging-rollout-controller.mjs", "utf8");
  assert.match(phase3Controller, /rollout\.snapshot\(\)/);
  assert.doesNotMatch(phase3Controller, /readStagingActionTerminal/);
  assert.ok(!PHASE3_SEMANTIC_SOURCE_IDS.includes("phase3-semantic"));
  for (const fixedPort of [
    "openVerifiedRollout",
    "loadLeases",
    "writeSnapshot",
    "collectRuntimeSources",
    "produceSemantic",
    "produceProofs",
    "now",
  ]) assert.match(phase3Controller, new RegExp(`"${fixedPort}"`));
  assert.doesNotMatch(
    phase3Controller,
    /["'](?:sourceIds?|sourcePaths?|proofPaths?)["']/i,
  );
  assert.ok(
    phase3Controller.indexOf("produceSemantic") <
      phase3Controller.indexOf("produceProofs"),
  );
  assert.match(phase3Controller, /produceProofs[\s\S]{0,2000}rollout\.action/);
  const gateEvidence = await readFile("scripts/lib/staging-gate-evidence.mjs", "utf8");
  assert.match(gateEvidence, /"phase3-semantic"/);
  assert.match(gateEvidence, /producePhase3Gate4Proofs/);
  assert.doesNotMatch(
    gateEvidence,
    /name:\s*"(?:phase3-durable-evidence|release-binding|guard-continuity|production-unchanged)"[\s\S]{0,180}sourceActionIds:\s*Object\.freeze\(\["staging-gate-4-phase3"\]\)/,
  );
  const gateChecker = await readFile("scripts/staging-gate-evidence-check.mjs", "utf8");
  assert.match(gateChecker, /verifyInstalledPhase3RolloutEvidence/);
  assert.doesNotMatch(
    gateChecker,
    /actionId === "staging-gate-4-phase3"[\s\S]{0,300}phase3-rollout-evidence-check\.mjs/,
  );
  assert.match(
    gateChecker,
    /actionId === "staging-gate-2-worker"[\s\S]{0,300}service-worker-evidence-check\.mjs/,
  );
  const phase3Handler = await readFile("scripts/staging-phase3-action-handler.mjs", "utf8");
  assert.doesNotMatch(phase3Handler, /writeInstalledStagingPhase3ObservationEvidence/);
  assert.doesNotMatch(phase3Handler, /\brename\s*\(/);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
