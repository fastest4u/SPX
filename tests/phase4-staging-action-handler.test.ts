import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PHASE4_HANDLER_ACTIONS,
  PHASE4_HANDLER_INSTALL_MAP,
  buildPhase4ComposeCommands,
  executePhase4StagingAction,
  parsePhase4HandlerInvocation,
  validatePhase4ActionCapabilities,
} from "../scripts/phase4-staging-action-handler.mjs";

const H = (value: string) => value.repeat(64);
const releaseSha = "a".repeat(40);
const stagingRunId = "staging-run-001";
const guardLeaseId = "11111111-1111-4111-8111-111111111111";
const watchdogLeaseId = "22222222-2222-4222-8222-222222222222";
const operatorRoot = `/opt/spx-staging/release/${releaseSha}/operator`;

const local = {
  environment: "staging",
  composeProject: "spx-staging",
  releaseSha,
  producers: [],
  webReadsRemote: false,
  webStreamsRemote: false,
  routingWatermark: 100,
  localFallbackWatermark: 100,
  singletonOwners: 1,
};
const producer = {
  ...local,
  producers: ["poller", "notification", "line"],
  routingWatermark: 105,
  localFallbackWatermark: 105,
};
const read = { ...producer, webReadsRemote: true };
const stream = { ...read, webStreamsRemote: true, routingWatermark: 110, localFallbackWatermark: 110 };
const rollback = {
  ...local,
  routingWatermark: 110,
  localFallbackWatermark: 110,
};

const context = {
  operatorRoot,
  installedBinding: {
    candidateSha: releaseSha,
    environment: "staging",
    composeProject: "spx-staging",
    stagingRunId,
    stagingTargetDescriptorSha256: H("b"),
    operatorBundleSha256: H("c"),
  },
  descriptor: {
    releaseEnvironment: "staging",
    runtimeEnvironment: "staging",
    composeProject: "spx-staging",
  },
};

const capabilities = {
  schemaVersion: 1,
  binding: {
    candidateSha: releaseSha,
    stagingRunId,
    stagingTargetDescriptorSha256: H("b"),
    operatorBundleSha256: H("c"),
  },
  runtimeSnapshotUrl: "http://127.0.0.1:3905/internal/phase4/runtime-snapshot",
  routingTargets: {
    "phase4-route-producer": producer,
    "phase4-route-read": read,
    "phase4-route-stream": stream,
    "phase4-route-local-rollback": rollback,
    "phase4-route-approved-final": stream,
    "phase4-route-final-cleanup-baseline": rollback,
  },
  guard: { guardLeaseId, watchdogLeaseId },
};

function inherited(actionId: string) {
  return parsePhase4HandlerInvocation([], {
    SPX_STAGING_ACTION_ID: actionId,
    SPX_STAGING_ACTION_SCOPE: actionId,
    SPX_STAGING_RUN_ID: stagingRunId,
  });
}

async function main(): Promise<void> {
  assert.deepEqual(
    PHASE4_HANDLER_ACTIONS.map(({ actionId, scope, kind }) => [actionId, scope, kind]),
    [
      ["phase4-proxy-realtime-start", "phase4-proxy-realtime-start", "forward"],
      ["phase4-singleton-contender-probe", "phase4-singleton-contender-probe", "forward"],
      ["phase4-route-producer", "phase4-route-producer", "forward"],
      ["phase4-route-read", "phase4-route-read", "forward"],
      ["phase4-route-stream", "phase4-route-stream", "forward"],
      ["phase4-realtime-restart-probe", "phase4-realtime-restart-probe", "forward"],
      ["phase4-route-local-rollback", "phase4-route-local-rollback", "forward"],
      ["phase4-route-approved-final", "phase4-route-approved-final", "forward"],
      ["phase4-route-final-cleanup-baseline", "phase4-route-final-cleanup-baseline", "forward"],
      ["guard-close", "guard-close", "forward"],
    ],
  );
  assert.equal(PHASE4_HANDLER_INSTALL_MAP.length, PHASE4_HANDLER_ACTIONS.length);
  for (const mapping of PHASE4_HANDLER_INSTALL_MAP) {
    assert.equal(mapping.handlerPath, `/usr/local/libexec/spx-staging-actions/${mapping.actionId}`);
    assert.equal(mapping.executable, mapping.handlerPath);
    assert.deepEqual(mapping.argv, []);
  }

  assert.throws(
    () => parsePhase4HandlerInvocation(["phase4-route-producer"], process.env),
    /arguments|zero/i,
  );
  assert.throws(
    () => parsePhase4HandlerInvocation([], {
      SPX_STAGING_ACTION_ID: "phase4-route-producer",
      SPX_STAGING_ACTION_SCOPE: "different",
      SPX_STAGING_RUN_ID: stagingRunId,
    }),
    /scope|context/i,
  );
  assert.throws(
    () => parsePhase4HandlerInvocation([], {
      SPX_STAGING_ACTION_ID: "phase4-db-proxy-fault",
      SPX_STAGING_ACTION_SCOPE: "phase4-db-proxy-fault",
      SPX_STAGING_RUN_ID: stagingRunId,
    }),
    /unsupported|action/i,
  );

  assert.deepEqual(validatePhase4ActionCapabilities(capabilities, context), capabilities);
  assert.throws(
    () => validatePhase4ActionCapabilities(
      { ...capabilities, runtimeSnapshotUrl: "https://production.example/internal/phase4/runtime-snapshot" },
      context,
    ),
    /snapshot|loopback/i,
  );
  assert.throws(
    () => validatePhase4ActionCapabilities(
      { ...capabilities, binding: { ...capabilities.binding, stagingRunId: "other" } },
      context,
    ),
    /binding/i,
  );
  assert.throws(
    () => validatePhase4ActionCapabilities(
      {
        ...capabilities,
        routingTargets: {
          ...capabilities.routingTargets,
          "phase4-route-producer": { ...producer, authorization: "forbidden" },
        },
      },
      context,
    ),
    /routing/i,
  );

  assert.deepEqual(buildPhase4ComposeCommands("phase4-proxy-realtime-start", operatorRoot), [[
    "compose", "-p", "spx-staging",
    "--env-file", "/etc/spx-staging/runtime.env",
    "-f", `${operatorRoot}/docker-compose.yml`,
    "-f", `${operatorRoot}/docker-compose.staging.yml`,
    "up", "-d", "--no-deps", "staging-db-proxy", "realtime-service",
  ]]);
  assert.deepEqual(buildPhase4ComposeCommands("phase4-realtime-restart-probe", operatorRoot).map((args) => args.slice(-2)), [
    ["stop", "realtime-service"],
    ["--no-deps", "realtime-service"],
  ]);

  {
    const compose: string[][] = [];
    const modes: string[] = [];
    const result = await executePhase4StagingAction(
      { inherited: inherited("phase4-proxy-realtime-start"), capabilities, context },
      {
        assertLocalDocker: async () => true,
        runCompose: async (args: string[]) => {
          compose.push(args);
          return { status: 0, stdout: "" };
        },
        runRuntimeProbe: async (mode: string) => {
          modes.push(mode);
          return { ok: true, mode };
        },
      },
    );
    assert.deepEqual(result, { ok: true, actionId: "phase4-proxy-realtime-start" });
    assert.equal(compose.length, 1);
    assert.deepEqual(modes, ["baseline"]);
  }

  {
    const modes: string[] = [];
    const result = await executePhase4StagingAction(
      { inherited: inherited("phase4-singleton-contender-probe"), capabilities, context },
      {
        assertLocalDocker: async () => true,
        runCompose: async () => ({
          status: 17,
          stdout: '{"code":"REALTIME_SINGLETON_HELD","ok":false}',
        }),
        runRuntimeProbe: async (mode: string) => {
          modes.push(mode);
          return { ok: true, mode };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(modes, ["competing-owner"]);
    await assert.rejects(
      executePhase4StagingAction(
        { inherited: inherited("phase4-singleton-contender-probe"), capabilities, context },
        {
          assertLocalDocker: async () => true,
          runCompose: async () => ({ status: 1, stdout: "generic failure" }),
          runRuntimeProbe: async () => ({ ok: true }),
        },
      ),
      /singleton|rejection/i,
    );
  }

  {
    let state = local;
    const applied: string[][] = [];
    const modes: string[] = [];
    const result = await executePhase4StagingAction(
      { inherited: inherited("phase4-route-producer"), capabilities, context },
      {
        assertLocalDocker: async () => true,
        readRoutingState: async () => state,
        writeRoutingState: async (next: typeof state) => { state = next; },
        applyRouting: async (services: string[]) => { applied.push(services); },
        runRuntimeProbe: async (mode: string) => {
          modes.push(mode);
          return { ok: true, mode };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(applied, [["poller", "notification", "line"]]);
    assert.deepEqual(state, producer);
    assert.deepEqual(modes, ["baseline"]);
  }

  {
    const compose: string[][] = [];
    const modes: string[] = [];
    const cursors = [110, 110];
    const result = await executePhase4StagingAction(
      { inherited: inherited("phase4-realtime-restart-probe"), capabilities, context },
      {
        assertLocalDocker: async () => true,
        runCompose: async (args: string[]) => {
          compose.push(args);
          return { status: 0, stdout: "" };
        },
        readReplayCursor: async () => cursors.shift(),
        runRuntimeProbe: async (mode: string) => {
          modes.push(mode);
          return { ok: true, mode };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(compose.length, 2);
    assert.deepEqual(modes, ["recovered", "routed"]);
  }

  {
    const closed: number[][] = [];
    const result = await executePhase4StagingAction(
      { inherited: inherited("guard-close"), capabilities, context },
      {
        assertLocalDocker: async () => true,
        listStagingContainerIds: async () => [],
        listNMinusOneContainerIds: async () => [],
        loadLeases: async () => ({
          stagingRunId,
          maxAgeMs: 10_000,
          guard: { leaseId: guardLeaseId, pid: 101, state: "armed", heartbeatAgeMs: 1 },
          watchdog: { leaseId: watchdogLeaseId, pid: 102, state: "armed", heartbeatAgeMs: 1 },
        }),
        captureTerminalSample: async () => true,
        closeControlProcesses: async (pids: number[]) => { closed.push(pids); },
        verifyControlProcessesClosed: async () => true,
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(closed, [[101, 102]]);
    await assert.rejects(
      executePhase4StagingAction(
        { inherited: inherited("guard-close"), capabilities, context },
        {
          assertLocalDocker: async () => true,
          listStagingContainerIds: async () => ["abc123"],
          listNMinusOneContainerIds: async () => [],
          loadLeases: async () => ({}),
          captureTerminalSample: async () => true,
          closeControlProcesses: async () => undefined,
          verifyControlProcessesClosed: async () => true,
        },
      ),
      /staging.*remain|zero/i,
    );
  }

  const source = readFileSync("scripts/phase4-staging-action-handler.mjs", "utf8");
  assert.doesNotMatch(source, /shell:\s*true|\bdown\b|execSync|caller.*path/i);
  assert.match(source, /DOCKER_HOST/);
  assert.match(source, /loadInstalledApprovedStagingContext/);

  console.log("Phase 4 staging action handler tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
