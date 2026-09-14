import assert from "node:assert/strict";
import {
  startRuntimeNodeHeartbeat,
  type RuntimeNodeLoopMode,
  type RuntimeNodeHeartbeatRegistration,
} from "../src/services/runtime-node-heartbeat.js";
import type { RuntimeReleaseIdentity } from "../src/services/runtime-release-identity.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  const noRegister = async () => {};
  const noTimer = (() => 1 as never) as typeof setInterval;
  await assert.rejects(
    () => startRuntimeNodeHeartbeat({
      nodeId: "empty-team-node",
      role: "poller-service",
      assignedTeamIds: [],
      enabledLoopModes: ["poller"],
      intervalMs: 10_000,
      registerNode: noRegister,
      setIntervalFn: noTimer,
    }),
    /assignedTeamIds must include at least one team id/,
  );
  await assert.rejects(
    () => startRuntimeNodeHeartbeat({
      nodeId: "empty-mode-node",
      role: "auto-accept-service",
      assignedTeamIds: [1],
      enabledLoopModes: [],
      intervalMs: 10_000,
      registerNode: noRegister,
      setIntervalFn: noTimer,
    }),
    /enabledLoopModes must include at least one mode/,
  );
  await assert.rejects(
    () => startRuntimeNodeHeartbeat({
      nodeId: "poller-cross-mode-node",
      role: "poller-service",
      assignedTeamIds: [1],
      enabledLoopModes: ["autoAcceptReal"],
      intervalMs: 10_000,
      registerNode: noRegister,
      setIntervalFn: noTimer,
    }),
    /poller-service may enable only poller mode/,
  );
  await assert.rejects(
    () => startRuntimeNodeHeartbeat({
      nodeId: "auto-cross-mode-node",
      role: "auto-accept-service",
      assignedTeamIds: [1],
      enabledLoopModes: ["poller"],
      intervalMs: 10_000,
      registerNode: noRegister,
      setIntervalFn: noTimer,
    }),
    /auto-accept-service cannot enable poller mode/,
  );

  const lineRegistrations: RuntimeNodeHeartbeatRegistration[] = [];
  const releaseIdentity = {
    version: "1.0.0",
    gitSha: "a".repeat(40),
    buildId: "run-123",
    environment: "staging",
    topology: "split",
    imageId: `sha256:${"b".repeat(64)}`,
    imageTag: `spx-app:${"a".repeat(40)}`,
    targetDescriptorSha256: "c".repeat(64),
    operatorBundleSha256: "d".repeat(64),
  } satisfies RuntimeReleaseIdentity;
  const lineHeartbeat = await startRuntimeNodeHeartbeat({
    nodeId: " line-service-primary ",
    role: "line-service",
    assignedTeamIds: [],
    enabledLoopModes: [],
    releaseIdentity,
    startedAt: "2026-07-11T01:00:00.000Z",
    intervalMs: 10_000,
    registerNode: async (input) => {
      lineRegistrations.push(input);
    },
    writeHeartbeat: async () => true,
    setIntervalFn: noTimer,
    clearIntervalFn: (() => {}) as typeof clearInterval,
  });
  assert.deepEqual(lineRegistrations, [{
    nodeId: "line-service-primary",
    role: "line-service",
    version: "1.0.0",
    metadata: {
      assignedTeamIds: [],
      enabledLoopModes: [],
      gitSha: "a".repeat(40),
      buildId: "run-123",
      environment: "staging",
      topology: "split",
      imageId: `sha256:${"b".repeat(64)}`,
      imageTag: `spx-app:${"a".repeat(40)}`,
      targetDescriptorSha256: "c".repeat(64),
      operatorBundleSha256: "d".repeat(64),
      startedAt: "2026-07-11T01:00:00.000Z",
    },
  }]);
  lineHeartbeat.stop();

  await assert.rejects(
    () => startRuntimeNodeHeartbeat({
      nodeId: "invalid-team-node",
      role: "poller-service",
      assignedTeamIds: [0],
      enabledLoopModes: ["poller"],
      intervalMs: 10_000,
    }),
    /assignedTeamIds must contain positive integers/,
  );
  await assert.rejects(
    () => startRuntimeNodeHeartbeat({
      nodeId: "invalid-mode-node",
      role: "auto-accept-service",
      assignedTeamIds: [1],
      enabledLoopModes: ["unknown-mode" as RuntimeNodeLoopMode],
      intervalMs: 10_000,
    }),
    /enabledLoopModes contains an unsupported mode/,
  );

  let scheduledDuringFailedStart = false;
  await assert.rejects(
    () => startRuntimeNodeHeartbeat({
      nodeId: "auto-node-failed",
      role: "auto-accept-service",
      assignedTeamIds: [2],
      enabledLoopModes: ["autoAcceptReal"],
      intervalMs: 10_000,
      registerNode: async () => {
        throw new Error("initial-db-secret-must-not-escape");
      },
      writeHeartbeat: async () => true,
      setIntervalFn: (() => {
        scheduledDuringFailedStart = true;
        return 1 as never;
      }) as typeof setInterval,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Runtime node heartbeat initial registration failed");
      assert.equal(error.message.includes("initial-db-secret"), false);
      return true;
    },
  );
  assert.equal(scheduledDuringFailedStart, false);

  const registrations: RuntimeNodeHeartbeatRegistration[] = [];
  let scheduledCallback: (() => void) | null = null;
  let clearCalls = 0;
  let heartbeatCalls = 0;
  let heartbeatBehavior: "deferred" | "fail" | "missing" | "ok" = "deferred";
  const firstHeartbeat = deferred<boolean>();
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  const heartbeat = await startRuntimeNodeHeartbeat({
    nodeId: " auto-node-1 ",
    role: "auto-accept-service",
    assignedTeamIds: [3, 1, 3, 2],
    enabledLoopModes: ["autoAcceptSettlement", "autoAcceptReal", "autoAcceptReal"],
    intervalMs: 10_000,
    registerNode: async (input) => {
      registrations.push(input);
    },
    writeHeartbeat: async () => {
      heartbeatCalls += 1;
      if (heartbeatBehavior === "deferred") return await firstHeartbeat.promise;
      if (heartbeatBehavior === "fail") {
        throw new Error("periodic-db-secret-must-not-escape");
      }
      if (heartbeatBehavior === "missing") return false;
      return true;
    },
    setIntervalFn: ((callback: () => void, intervalMs: number) => {
      assert.equal(intervalMs, 10_000);
      scheduledCallback = callback;
      return 123 as never;
    }) as typeof setInterval,
    clearIntervalFn: ((timer: ReturnType<typeof setInterval>) => {
      assert.equal(timer, 123);
      clearCalls += 1;
    }) as typeof clearInterval,
    warn: (message, meta) => {
      warnings.push({ message, meta });
    },
  });

  assert.equal(registrations.length, 1);
  assert.deepEqual(Object.keys(registrations[0] ?? {}).sort(), ["metadata", "nodeId", "role"]);
  assert.deepEqual(registrations[0], {
    nodeId: "auto-node-1",
    role: "auto-accept-service",
    metadata: {
      assignedTeamIds: [1, 2, 3],
      enabledLoopModes: ["autoAcceptReal", "autoAcceptSettlement"],
    },
  });
  const serializedRegistration = JSON.stringify(registrations[0]);
  for (const forbidden of ["secret", "cookie", "password", "hostname", "process.env", "http://"]) {
    assert.equal(serializedRegistration.toLowerCase().includes(forbidden.toLowerCase()), false);
  }

  const firstRun = heartbeat.runOnce();
  const overlappingRun = heartbeat.runOnce();
  assert.equal(heartbeatCalls, 1);
  firstHeartbeat.resolve(true);
  assert.equal(await firstRun, true);
  assert.equal(await overlappingRun, true);
  assert.equal(heartbeatCalls, 1);

  heartbeatBehavior = "fail";
  assert.equal(await heartbeat.runOnce(), false);
  assert.equal(heartbeatCalls, 2);
  assert.deepEqual(warnings, [{
    message: "runtime-node-heartbeat-write-failed",
    meta: { nodeId: "auto-node-1", role: "auto-accept-service" },
  }]);
  assert.equal(JSON.stringify(warnings).includes("periodic-db-secret"), false);

  heartbeatBehavior = "ok";
  assert.equal(await heartbeat.runOnce(), true);
  assert.equal(heartbeatCalls, 3);

  heartbeatBehavior = "missing";
  assert.equal(await heartbeat.runOnce(), true);
  assert.equal(heartbeatCalls, 4);
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations[1], registrations[0]);

  heartbeat.stop();
  heartbeat.stop();
  assert.equal(clearCalls, 1);
  assert.equal(await heartbeat.runOnce(), null);
  scheduledCallback?.();
  await Promise.resolve();
  assert.equal(heartbeatCalls, 4);

  const lateHeartbeat = deferred<boolean>();
  let lateRegistrationCalls = 0;
  const stoppedDuringWrite = await startRuntimeNodeHeartbeat({
    nodeId: "stopped-during-write-node",
    role: "poller-service",
    assignedTeamIds: [1],
    enabledLoopModes: ["poller"],
    intervalMs: 10_000,
    registerNode: async () => {
      lateRegistrationCalls += 1;
    },
    writeHeartbeat: async () => await lateHeartbeat.promise,
    setIntervalFn: noTimer,
    clearIntervalFn: (() => {}) as typeof clearInterval,
  });
  const lateRun = stoppedDuringWrite.runOnce();
  stoppedDuringWrite.stop();
  lateHeartbeat.resolve(false);
  assert.equal(await lateRun, false);
  assert.equal(lateRegistrationCalls, 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
