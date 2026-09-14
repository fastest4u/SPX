#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveVerifiedStagingOperatorRoot,
  verifyInstalledStagingActionHandlers,
} from "./install-staging-action-handlers.mjs";
import { canonicalJson } from "./lib/evidence-artifact.mjs";
import { stagingActionHandler } from "./lib/staging-action-handler-manifest.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "./lib/staging-action-plan.mjs";
import { loadInstalledReleaseBinding } from "./lib/staging-installed-context.mjs";
import { stagingOperationDescriptor } from "./lib/staging-operation-registry.mjs";

const HANDLER_ROOT = "/usr/local/libexec/spx-staging-actions";
const actionsById = new Map(
  REQUIRED_STAGING_ACTION_PLAN.map((action) => [action.actionId, action]),
);

function fail(message) {
  throw new Error(message);
}

function parseRequest(argv) {
  if (argv.length !== 3 || argv[0] !== "execute") {
    fail("controller accepts exactly one fixed execute operation");
  }
  const [, actionId, scope] = argv;
  const stagingRunId = process.env.SPX_STAGING_RUN_ID;
  const action = actionsById.get(actionId);
  if (!action || action.scope !== scope) fail("controller operation is not in the signed plan");
  if (
    typeof stagingRunId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stagingRunId)
  ) {
    fail("controller staging run ID is invalid");
  }
  const descriptor = stagingOperationDescriptor(action);
  if (process.env.SPX_STAGING_OPERATION_DESCRIPTOR !== canonicalJson(descriptor)) {
    fail("controller descriptor does not match the signed fixed operation");
  }
  return { action, descriptor, stagingRunId };
}

async function assertFixedHandler(actionId) {
  const fixed = stagingActionHandler(actionId);
  if (fixed.handlerPath !== resolve(HANDLER_ROOT, actionId)) {
    fail("fixed action handler path is invalid");
  }
  await verifyInstalledStagingActionHandlers({ handlerRoot: HANDLER_ROOT });
  return fixed.handlerPath;
}

export async function runStagingRolloutController(argv = process.argv.slice(2)) {
  const { action, stagingRunId } = parseRequest(argv);
  const binding = await loadInstalledReleaseBinding();
  if (binding.stagingRunId !== stagingRunId) fail("controller staging run binding changed");
  await resolveVerifiedStagingOperatorRoot(fileURLToPath(import.meta.url));
  const handlerPath = await assertFixedHandler(action.actionId);
  const result = spawnSync(handlerPath, [], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15 * 60 * 1_000,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      SPX_STAGING_ACTION_ID: action.actionId,
      SPX_STAGING_ACTION_SCOPE: action.scope,
      SPX_STAGING_RUN_ID: stagingRunId,
    },
  });
  if (result.error || result.signal || result.status !== 0) {
    fail("fixed staging action handler failed");
  }
  return { ok: true, code: "operation-complete" };
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  runStagingRolloutController()
    .then((result) => console.log(canonicalJson(result)))
    .catch(() => {
      console.log(canonicalJson({ ok: false, code: "staging-controller-failed" }));
      process.exitCode = 1;
    });
}
