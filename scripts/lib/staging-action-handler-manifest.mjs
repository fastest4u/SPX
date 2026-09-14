import { createHash } from "node:crypto";

import { canonicalJson } from "./evidence-artifact.mjs";
import { REQUIRED_STAGING_ACTION_PLAN } from "./staging-action-plan.mjs";
import { STAGING_ROLLOUT_CONTROLLER_PATH } from "./staging-operation-registry.mjs";

export const STAGING_ACTION_HANDLER_ROOT = "/usr/local/libexec/spx-staging-actions";
const NODE = "/usr/bin/node";

const FIXED_HANDLERS = Object.freeze({
  "staging-db-bootstrap": ["a3-staging-db-provision.mjs", ["db-bootstrap"]],
  "staging-db-migrate": ["a3-staging-db-provision.mjs", ["db-migrate"]],
  "staging-db-finalize": ["a3-staging-db-provision.mjs", ["db-finalize"]],
  "staging-db-bootstrap-revoke": ["a3-staging-db-provision.mjs", ["db-bootstrap-revoke"]],
  "staging-runtime-start": ["staging-core-action-handler.mjs", []],
  "staging-gate-1-baseline": ["staging-gate-evidence-check.mjs", []],
  "staging-controlled-publish": ["staging-core-action-handler.mjs", []],
  "staging-line-fault": ["a3-staging-service-fault.mjs", ["line-fault"]],
  "staging-line-recovery": ["a3-staging-service-fault.mjs", ["line-recover"]],
  "staging-ocr-fault": ["a3-staging-service-fault.mjs", ["ocr-fault"]],
  "staging-ocr-recovery": ["a3-staging-service-fault.mjs", ["ocr-recover"]],
  "staging-worker-forward-handoff": ["staging-core-action-handler.mjs", []],
  "staging-worker-reverse-handoff": ["staging-core-action-handler.mjs", []],
  "staging-gate-2-worker": ["staging-gate-evidence-check.mjs", []],
  "staging-gate-3-handoff": ["staging-gate-evidence-check.mjs", []],
  "phase3-consumer-start-disabled": ["staging-phase3-action-handler.mjs", []],
  "phase3-legacy-lease-release": ["staging-phase3-action-handler.mjs", []],
  "phase3-poller-start": ["staging-phase3-action-handler.mjs", []],
  "phase3-publication-enable": ["staging-phase3-action-handler.mjs", []],
  "phase3-execution-enable": ["staging-phase3-action-handler.mjs", []],
  "phase3-publication-fence": ["staging-phase3-action-handler.mjs", []],
  "phase3-drain-or-quarantine": ["staging-phase3-action-handler.mjs", []],
  "phase3-inline-owner-restore": ["staging-phase3-action-handler.mjs", []],
  "staging-gate-4-phase3": ["staging-gate-evidence-check.mjs", []],
  "phase4-n1-preflight": ["phase4-n-minus-one-rehearsal.mjs", []],
  "phase4-n1-start": ["phase4-n-minus-one-rehearsal.mjs", []],
  "phase4-n1-verify": ["phase4-n-minus-one-rehearsal.mjs", []],
  "phase4-n1-rollback-forward": ["phase4-n-minus-one-rehearsal.mjs", []],
  "phase4-n1-stop": ["phase4-n-minus-one-rehearsal.mjs", []],
  "phase4-proxy-realtime-start": ["phase4-staging-action-handler.mjs", []],
  "phase4-singleton-contender-probe": ["phase4-staging-action-handler.mjs", []],
  "phase4-route-producer": ["phase4-staging-action-handler.mjs", []],
  "phase4-route-read": ["phase4-staging-action-handler.mjs", []],
  "phase4-route-stream": ["phase4-staging-action-handler.mjs", []],
  "phase4-realtime-restart-probe": ["phase4-staging-action-handler.mjs", []],
  "phase4-route-local-rollback": ["phase4-staging-action-handler.mjs", []],
  "phase4-route-approved-final": ["phase4-staging-action-handler.mjs", []],
  "phase4-db-proxy-fault": ["a3-staging-db-fault.mjs", ["fault"]],
  "phase4-db-proxy-recover": ["a3-staging-db-fault.mjs", ["recover"]],
  "phase4-route-final-cleanup-baseline": ["phase4-staging-action-handler.mjs", []],
  "staging-final-stop": ["a3-capacity-guard.mjs", ["stop"]],
  "guard-close": ["phase4-staging-action-handler.mjs", []],
  "staging-guard-emergency-stop": ["a3-capacity-guard.mjs", ["stop"]],
  "staging-watchdog-emergency-stop": ["a3-capacity-guard.mjs", ["stop"]],
});

function freezeEntry(action) {
  const fixed = FIXED_HANDLERS[action.actionId];
  if (!fixed) throw new Error(`staging action has no fixed handler: ${action.actionId}`);
  const [filename, argv] = fixed;
  return Object.freeze({
    actionId: action.actionId,
    scope: action.scope,
    kind: action.kind,
    handlerPath: `${STAGING_ACTION_HANDLER_ROOT}/${action.actionId}`,
    executable: NODE,
    script: `scripts/${filename}`,
    argv: Object.freeze([...argv]),
  });
}

export const STAGING_ACTION_HANDLER_MANIFEST = Object.freeze(
  REQUIRED_STAGING_ACTION_PLAN.map(freezeEntry),
);

export function handlerWrapperSource(entry) {
  const fixedArgv = canonicalJson(entry.argv);
  const script = JSON.stringify(entry.script);
  const actionId = JSON.stringify(entry.actionId);
  const scope = JSON.stringify(entry.scope);
  return [
    "#!/usr/bin/node",
    '"use strict";',
    'const { spawnSync } = require("node:child_process");',
    'const { lstatSync, readFileSync, realpathSync } = require("node:fs");',
    'const { parse, resolve } = require("node:path");',
    `if (process.argv.length !== 2 || process.env.SPX_STAGING_ACTION_ID !== ${actionId} || process.env.SPX_STAGING_ACTION_SCOPE !== ${scope} || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(process.env.SPX_STAGING_RUN_ID || "")) process.exit(64);`,
    'const parent = readFileSync("/proc/" + process.ppid + "/cmdline", "utf8").split("\\0").filter(Boolean);',
    `const activeController = ${JSON.stringify(STAGING_ROLLOUT_CONTROLLER_PATH)};`,
    `if (parent.length !== 5 || parent[0] !== "/usr/bin/node" || parent[1] !== activeController || parent[2] !== "execute" || parent[3] !== ${actionId} || parent[4] !== ${scope}) process.exit(65);`,
    "let canonicalController;",
    "try {",
    '  canonicalController = realpathSync.native(activeController).replaceAll("\\\\", "/");',
    "  const root = parse(canonicalController).root;",
    "  const segments = canonicalController.slice(root.length).split(/[\\\\/]+/).filter(Boolean);",
    "  let current = root;",
    "  for (const [index, segment] of segments.entries()) {",
    "    current = resolve(current, segment);",
    "    const status = lstatSync(current, { bigint: true });",
    "    const final = index === segments.length - 1;",
    "    if (status.isSymbolicLink() || (final ? !status.isFile() : !status.isDirectory()) || Number(status.uid) !== 0 || (Number(status.mode & 0o777n) & 0o022) !== 0) process.exit(65);",
    "  }",
    "} catch { process.exit(65); }",
    'const controller = /^(\\/opt\\/spx-staging\\/release\\/[0-9a-f]{40}\\/operator)\\/scripts\\/staging-rollout-controller\\.mjs$/.exec(canonicalController);',
    "if (!controller) process.exit(65);",
    `const script = controller[1] + "/" + ${script};`,
    `const result = spawnSync("/usr/bin/node", [script, ...${fixedArgv}], {`,
    "  shell: false,",
    "  windowsHide: true,",
    '  stdio: ["ignore", "ignore", "ignore"],',
    "  timeout: 15 * 60 * 1000,",
    "  env: {",
    '    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",',
    "    SPX_STAGING_ACTION_ID: process.env.SPX_STAGING_ACTION_ID,",
    "    SPX_STAGING_ACTION_SCOPE: process.env.SPX_STAGING_ACTION_SCOPE,",
    "    SPX_STAGING_RUN_ID: process.env.SPX_STAGING_RUN_ID,",
    "  },",
    "});",
    "if (result.error || result.signal || result.status !== 0) process.exit(1);",
    "",
  ].join("\n");
}

export function handlerWrapperSha256(entry) {
  return createHash("sha256").update(handlerWrapperSource(entry)).digest("hex");
}

export function validateStagingActionHandlerManifest(
  manifest = STAGING_ACTION_HANDLER_MANIFEST,
  plan = REQUIRED_STAGING_ACTION_PLAN,
) {
  if (!Array.isArray(manifest) || manifest.length !== plan.length) {
    throw new Error("fixed staging handler coverage does not match the signed action plan");
  }
  const seen = new Set();
  for (const [index, entry] of manifest.entries()) {
    const action = plan[index];
    if (
      !entry ||
      entry.actionId !== action.actionId ||
      entry.scope !== action.scope ||
      entry.kind !== action.kind ||
      seen.has(entry.actionId) ||
      entry.handlerPath !== `${STAGING_ACTION_HANDLER_ROOT}/${entry.actionId}` ||
      entry.executable !== NODE ||
      typeof entry.script !== "string" ||
      !/^scripts\/[a-z0-9-]+\.mjs$/.test(entry.script) ||
      !Array.isArray(entry.argv) ||
      entry.argv.some((argument) => typeof argument !== "string" || !/^[a-z0-9-]+$/.test(argument))
    ) {
      throw new Error("fixed staging handler manifest is invalid or ambiguous");
    }
    seen.add(entry.actionId);
  }
  if (Object.keys(FIXED_HANDLERS).length !== plan.length || seen.size !== plan.length) {
    throw new Error("fixed staging handler manifest has missing or extra actions");
  }
  return manifest;
}

export function stagingActionHandler(actionId) {
  validateStagingActionHandlerManifest();
  const entry = STAGING_ACTION_HANDLER_MANIFEST.find((candidate) => candidate.actionId === actionId);
  if (!entry) throw new Error("staging action has no fixed executable handler");
  return entry;
}
