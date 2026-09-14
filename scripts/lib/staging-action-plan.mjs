import { sha256Canonical } from "./evidence-artifact.mjs";
import { stagingOperationDescriptor } from "./staging-operation-registry.mjs";

const ACTION_IDENTITIES = [
  ["staging-db-bootstrap", "database-bootstrap", "forward"],
  ["staging-db-migrate", "database-migrate", "forward"],
  ["staging-db-finalize", "database-finalize", "forward"],
  ["staging-db-bootstrap-revoke", "database-revoke", "forward"],
  ["staging-runtime-start", "runtime-start", "forward"],
  ["staging-gate-1-baseline", "gate-1", "forward"],
  ["staging-controlled-publish", "notification-publish", "forward"],
  ["staging-line-fault", "line-fault", "forward"],
  ["staging-line-recovery", "line-recovery", "forward"],
  ["staging-ocr-fault", "ocr-fault", "forward"],
  ["staging-ocr-recovery", "ocr-recovery", "forward"],
  ["staging-worker-forward-handoff", "worker-handoff-forward", "forward"],
  ["staging-worker-reverse-handoff", "worker-handoff-reverse", "forward"],
  ["staging-gate-2-worker", "gate-2", "forward"],
  ["staging-gate-3-handoff", "gate-3", "forward"],
  ["phase3-consumer-start-disabled", "phase3-consumer-start-disabled", "forward"],
  ["phase3-legacy-lease-release", "phase3-legacy-lease-release", "forward"],
  ["phase3-poller-start", "phase3-poller-start", "forward"],
  ["phase3-publication-enable", "phase3-publication-enable", "forward"],
  ["phase3-execution-enable", "phase3-execution-enable", "forward"],
  ["phase3-publication-fence", "phase3-publication-fence", "forward"],
  ["phase3-drain-or-quarantine", "phase3-drain-or-quarantine", "forward"],
  ["phase3-inline-owner-restore", "phase3-inline-owner-restore", "forward"],
  ["staging-gate-4-phase3", "gate-4", "forward"],
  ["phase4-n1-preflight", "phase4-n1-preflight", "forward"],
  ["phase4-n1-start", "phase4-n1-start", "forward"],
  ["phase4-n1-verify", "phase4-n1-verify", "forward"],
  ["phase4-n1-rollback-forward", "phase4-n1-rollback-forward", "forward"],
  ["phase4-n1-stop", "phase4-n1-stop", "forward"],
  ["phase4-proxy-realtime-start", "phase4-proxy-realtime-start", "forward"],
  ["phase4-singleton-contender-probe", "phase4-singleton-contender-probe", "forward"],
  ["phase4-route-producer", "phase4-route-producer", "forward"],
  ["phase4-route-read", "phase4-route-read", "forward"],
  ["phase4-route-stream", "phase4-route-stream", "forward"],
  ["phase4-realtime-restart-probe", "phase4-realtime-restart-probe", "forward"],
  ["phase4-route-local-rollback", "phase4-route-local-rollback", "forward"],
  ["phase4-route-approved-final", "phase4-route-approved-final", "forward"],
  ["phase4-db-proxy-fault", "phase4-db-proxy-fault", "forward"],
  ["phase4-db-proxy-recover", "phase4-db-proxy-recover", "forward"],
  ["phase4-route-final-cleanup-baseline", "phase4-route-final-cleanup-baseline", "forward"],
  ["staging-final-stop", "final-stop", "forward"],
  ["guard-close", "guard-close", "forward"],
  ["staging-guard-emergency-stop", "guard-emergency-stop", "emergency"],
  ["staging-watchdog-emergency-stop", "watchdog-emergency-stop", "emergency"],
];

export const REQUIRED_STAGING_ACTION_PLAN = Object.freeze(
  ACTION_IDENTITIES.map(([actionId, scope, kind], index) => {
    const action = { sequence: index + 1, actionId, scope, kind };
    return Object.freeze({
      ...action,
      mutationSha256: sha256Canonical(stagingOperationDescriptor(action)),
    });
  }),
);
