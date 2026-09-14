import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

assert.match(
  packageJson.scripts.build,
  /\bsrc\/scripts\/phase4-n-minus-one-role-probe\.ts\b/,
  "the N-1 role probe must be bundled into the runtime image",
);

const expected = {
  "service:worker-healthcheck": "node scripts/worker-healthcheck.mjs",
  "service:worker-operation-watermark-check":
    "node scripts/service-worker-operation-watermark-check.mjs",
  "service:a3-capacity-check": "node scripts/a3-capacity-check.mjs",
  "service:a3-capacity-guard": "node scripts/a3-capacity-guard.mjs",
  "service:a3-capacity-watchdog": "node scripts/a3-capacity-watchdog.mjs",
  "service:a3-staging-preflight": "node scripts/a3-staging-preflight.mjs",
  "service:a3-staging-db-provision": "node scripts/a3-staging-db-provision.mjs",
  "service:a3-staging-db-fault": "node scripts/a3-staging-db-fault.mjs",
  "service:a3-staging-service-fault": "node scripts/a3-staging-service-fault.mjs",
  "service:a3-staging-rollout-controller": "node scripts/a3-staging-rollout-controller.mjs",
  "service:staging-isolation-check": "node scripts/staging-isolation-check.mjs",
  "service:db-grants-check": "node scripts/db-grants-check.mjs",
  "service:phase3-publication-control": "node scripts/phase3-publication-control.mjs",
  "service:phase3-rollout-evidence-produce": "node scripts/phase3-rollout-evidence-produce.mjs",
  "service:phase3-rollout-evidence": "node scripts/phase3-rollout-evidence-check.mjs",
  "service:phase4-runtime-probe": "node scripts/phase4-runtime-probe.mjs",
  "service:phase4-routing-guard": "node scripts/phase4-routing-guard.mjs",
  "service:phase4-rollout-evidence": "node scripts/phase4-rollout-evidence-check.mjs",
  "service:phase4-n-minus-one-rehearsal": "node scripts/phase4-n-minus-one-rehearsal.mjs",
  "service:phase4-n-minus-one-evidence": "node scripts/phase4-n-minus-one-evidence-check.mjs",
  "service:staging-protected-evidence": "node scripts/staging-protected-evidence-export.mjs",
  "service:db-principal-rollout": "node scripts/db-principal-rollout.mjs",
  "service:release-install-migration-check": "node scripts/release-install-migration-check.mjs",
  "service:production-backup-restore-evidence":
    "node scripts/production-backup-restore-evidence.mjs",
  "service:production-backup-restore-controller":
    "node scripts/production-backup-restore-controller.mjs",
  "service:protected-install-watchdog": "node scripts/protected-install-watchdog.mjs",
  "service:protected-install-evidence": "node scripts/protected-install-evidence.mjs",
  "service:gate6-approval-verify": "node scripts/gate6-approval-verify.mjs",
  "service:gate6-accepted-evidence-export": "node scripts/gate6-accepted-evidence-export.mjs",
  "service:gate6-final-verifier-export": "node scripts/gate6-final-verifier-export.mjs",
  "service:gate6-runtime-control": "node scripts/gate6-runtime-control.mjs",
  "service:gate6-runtime-state-probe": "node scripts/gate6-runtime-state-probe.mjs",
  "service:gate6-host-watchdog": "node scripts/gate6-host-watchdog.mjs",
  "service:gate6-production-monitor-probe": "node scripts/gate6-production-monitor-probe.mjs",
  "service:gate6-rollback-coordinator": "node scripts/gate6-rollback-coordinator.mjs",
  "service:production-canary-evidence": "node scripts/production-canary-evidence-check.mjs",
  "service:production-canary-monitor": "node scripts/production-canary-monitor.mjs",
  "service:production-db-transition-evidence":
    "node scripts/production-db-transition-evidence-check.mjs",
  "service:production-db-principal-controller":
    "node scripts/production-db-principal-controller.mjs",
  "service:production-task9-controller": "node scripts/production-task9-controller.mjs",
  "service:production-worker-canary-control": "node scripts/production-worker-canary-control.mjs",
  "service:production-phase3-controller": "node scripts/production-phase3-controller.mjs",
  "service:production-phase4-controller": "node scripts/production-phase4-controller.mjs",
} as const;

for (const [name, command] of Object.entries(expected)) {
  assert.equal(
    packageJson.scripts[name],
    command,
    `${name} must expose the fixed operator command`,
  );
  const scriptPath = command.replace(/^node /, "");
  assert.equal(existsSync(resolve(root, scriptPath)), true, `${name} target must exist`);
}

console.log("operational package scripts verified");
