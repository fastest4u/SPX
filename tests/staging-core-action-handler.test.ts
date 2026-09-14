import assert from "node:assert/strict";

import {
  CORE_STAGING_ACTIONS,
  buildCoreActionSteps,
  executeCoreStagingAction,
  parseCoreActionInvocation,
} from "../scripts/staging-core-action-handler.mjs";

const stagingRunId = "staging-run-20260710-001";
const operatorRoot = `/opt/spx-staging/release/${"a".repeat(40)}/operator`;

function inherited(actionId: string, scope: string) {
  return parseCoreActionInvocation([], {
    SPX_STAGING_ACTION_ID: actionId,
    SPX_STAGING_ACTION_SCOPE: scope,
    SPX_STAGING_RUN_ID: stagingRunId,
  });
}

async function main(): Promise<void> {
  assert.deepEqual(
    CORE_STAGING_ACTIONS.map(({ actionId, scope }) => [actionId, scope]),
    [
      ["staging-runtime-start", "runtime-start"],
      ["staging-controlled-publish", "notification-publish"],
      ["staging-worker-forward-handoff", "worker-handoff-forward"],
      ["staging-worker-reverse-handoff", "worker-handoff-reverse"],
    ],
  );
  assert.throws(
    () => parseCoreActionInvocation(["caller-argument"], process.env),
    /zero|argument/i,
  );
  assert.throws(
    () =>
      parseCoreActionInvocation([], {
        SPX_STAGING_ACTION_ID: "staging-runtime-start",
        SPX_STAGING_ACTION_SCOPE: "production-start",
        SPX_STAGING_RUN_ID: stagingRunId,
      }),
    /scope|context/i,
  );

  const runtime = buildCoreActionSteps("staging-runtime-start", stagingRunId, operatorRoot);
  assert.deepEqual(runtime, [
    {
      type: "compose",
      argv: [
        "compose", "-p", "spx-staging", "--env-file", "/etc/spx-staging/runtime.env",
        "-f", `${operatorRoot}/docker-compose.yml`,
        "-f", `${operatorRoot}/docker-compose.staging.yml`,
        "--profile", "split", "up", "-d", "--no-deps",
        "web-api", "notification-service", "line-service", "ocr-service",
        "worker-ifn-split", "worker-ptwl-split",
      ],
    },
    {
      type: "verify-running",
      services: [
        "web-api", "notification-service", "line-service", "ocr-service",
        "worker-ifn-split", "worker-ptwl-split",
      ],
    },
  ]);

  const publish = buildCoreActionSteps("staging-controlled-publish", stagingRunId, operatorRoot);
  assert.deepEqual(publish[0], {
    type: "publish",
    argv: [
      "compose", "-p", "spx-staging", "--env-file", "/etc/spx-staging/runtime.env",
      "-f", `${operatorRoot}/docker-compose.yml`,
      "-f", `${operatorRoot}/docker-compose.staging.yml`,
      "exec", "-T", "worker-ifn-split", "node",
      "scripts/service-fault-publish-notification.mjs",
      "--url=http://notification-service:3002/internal/notification-events",
      "--team-id=2", `--drill-id=${stagingRunId}`, "--step=baseline",
      "--confirm-send-test-notification",
    ],
  });

  assert.deepEqual(
    buildCoreActionSteps("staging-worker-forward-handoff", stagingRunId, operatorRoot)
      .filter((step) => step.type === "compose")
      .map((step) => step.argv.slice(-3)),
    [
      ["120", "worker-ifn-split", "worker-ptwl-split"],
      ["--no-deps", "worker-ifn", "worker-ptwl"],
    ],
  );
  assert.deepEqual(
    buildCoreActionSteps("staging-worker-reverse-handoff", stagingRunId, operatorRoot)
      .filter((step) => step.type === "compose")
      .map((step) => step.argv.slice(-3)),
    [
      ["120", "worker-ifn", "worker-ptwl"],
      ["--no-deps", "worker-ifn-split", "worker-ptwl-split"],
    ],
  );
  for (const phase3ActionId of [
    "phase3-consumer-start-disabled",
    "phase3-legacy-lease-release",
    "phase3-poller-start",
    "phase3-publication-enable",
    "phase3-execution-enable",
    "phase3-publication-fence",
    "phase3-drain-or-quarantine",
    "phase3-inline-owner-restore",
  ]) {
    assert.throws(
      () => buildCoreActionSteps(phase3ActionId, stagingRunId, operatorRoot),
      /core action|invalid/i,
    );
    assert.throws(
      () => parseCoreActionInvocation([], {
        SPX_STAGING_ACTION_ID: phase3ActionId,
        SPX_STAGING_ACTION_SCOPE: phase3ActionId,
        SPX_STAGING_RUN_ID: stagingRunId,
      }),
      /core action|context/i,
    );
  }

  for (const action of CORE_STAGING_ACTIONS) {
    const serialized = JSON.stringify(buildCoreActionSteps(action.actionId, stagingRunId, operatorRoot));
    assert.doesNotMatch(serialized, /spx-production|\/root\/SPX|DOCKER_HOST|--project-name/);
  }

  const events: string[] = [];
  const result = await executeCoreStagingAction(
    {
      inherited: inherited("staging-runtime-start", "runtime-start"),
      binding: { stagingRunId, candidateSha: "a".repeat(40) },
      operatorRoot,
    },
    {
      assertLocalDocker: async () => { events.push("local-docker"); },
      loadLeases: async () => ({
        stagingRunId,
        maxAgeMs: 10_000,
        guard: { state: "armed", heartbeatAgeMs: 1 },
        watchdog: { state: "armed", heartbeatAgeMs: 1 },
      }),
      runCompose: async () => { events.push("compose"); return { status: 0, stdout: "" }; },
      verifyRunning: async () => { events.push("verify-running"); },
      verifyStopped: async () => { events.push("verify-stopped"); },
      waitLeaseReleased: async () => { events.push("lease-released"); },
      verifyOwners: async () => { events.push("verify-owners"); },
    },
  );
  assert.deepEqual(result, { ok: true, actionId: "staging-runtime-start" });
  assert.deepEqual(events, [
    "local-docker", "compose", "verify-running",
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
