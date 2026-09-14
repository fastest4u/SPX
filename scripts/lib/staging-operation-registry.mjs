import { spawnSync } from "node:child_process";

import { canonicalJson } from "./evidence-artifact.mjs";

const CONTROLLER_EXECUTABLE = "/usr/bin/node";
export const STAGING_ROLLOUT_CONTROLLER_PATH =
  "/opt/spx-staging/release/current/operator/scripts/staging-rollout-controller.mjs";
const trustedRegistries = new WeakSet();

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stagingOperationDescriptor(action) {
  if (!isObject(action)) throw new Error("staging action descriptor is required");
  return Object.freeze({
    schemaVersion: 1,
    controller: STAGING_ROLLOUT_CONTROLLER_PATH,
    operation: action.actionId,
    scope: action.scope,
    executable: CONTROLLER_EXECUTABLE,
    argv: Object.freeze([
      STAGING_ROLLOUT_CONTROLLER_PATH,
      "execute",
      action.actionId,
      action.scope,
    ]),
  });
}

function createRegistry(actions, executorFor) {
  const registry = new Map();
  for (const action of actions) {
    if (registry.has(action.actionId)) throw new Error("staging operation IDs must be unique");
    const descriptor = stagingOperationDescriptor(action);
    registry.set(
      action.actionId,
      Object.freeze({
        descriptor,
        execute: executorFor(action, descriptor),
      }),
    );
  }
  trustedRegistries.add(registry);
  return registry;
}

export function createProductionStagingOperationRegistry(actions) {
  return createRegistry(actions, (action, descriptor) => async () => {
    const result = spawnSync(descriptor.executable, descriptor.argv, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15 * 60 * 1_000,
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        SPX_STAGING_OPERATION_DESCRIPTOR: canonicalJson(descriptor),
        SPX_STAGING_RUN_ID: action.stagingRunId,
      },
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error("fixed staging controller operation failed");
    }
    return { ok: true, code: "operation-complete" };
  });
}

export function createTestStagingOperationRegistry(actions, behaviors = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("test staging operation registry is unavailable outside tests");
  }
  return createRegistry(actions, (action) => {
    const behavior = behaviors[action.actionId];
    return typeof behavior === "function"
      ? behavior
      : async () => ({ ok: true, code: "operation-complete" });
  });
}

export function assertTrustedStagingOperationRegistry(registry, actions) {
  if (!(registry instanceof Map) || !trustedRegistries.has(registry)) {
    throw new Error("a fixed trusted staging operation registry is required");
  }
  const expectedIds = actions.map((action) => action.actionId).sort();
  const actualIds = [...registry.keys()].sort();
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
    throw new Error("fixed staging operation registry does not exactly match approved actions");
  }
  return registry;
}
