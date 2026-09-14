#!/usr/bin/env node

import {
  canonicalJson,
  readEvidenceBundle,
  sha256Canonical,
} from "./lib/evidence-artifact.mjs";
import { loadInstalledReleaseBinding } from "./lib/staging-installed-context.mjs";

const HASH = /^[0-9a-f]{64}$/;
const STAGING_DIRECTORY = "/var/lib/spx-staging-rollout/evidence/phase4-staging";
const PRODUCTION_DIRECTORY = "/var/lib/spx-production-rollout/evidence/phase4-production";

export const REQUIRED_GATE5_ACTION_IDS = Object.freeze([
  "phase4-n1-preflight",
  "phase4-n1-start",
  "phase4-n1-verify",
  "phase4-n1-rollback-forward",
  "phase4-n1-stop",
  "phase4-proxy-realtime-start",
  "phase4-singleton-contender-probe",
  "phase4-route-producer",
  "phase4-route-read",
  "phase4-route-stream",
  "phase4-realtime-restart-probe",
  "phase4-route-local-rollback",
  "phase4-route-approved-final",
  "phase4-db-proxy-fault",
  "phase4-db-proxy-recover",
  "phase4-route-final-cleanup-baseline",
  "staging-final-stop",
  "guard-close",
]);

export const REQUIRED_PRODUCTION_PHASE4_ACTION_IDS = Object.freeze([
  "phase4-realtime-start",
  "phase4-route-producer",
  "phase4-route-read",
  "phase4-route-stream",
  "phase4-route-local-rollback",
  "phase4-route-approved-final",
]);

function exactTerminalActions(ledger, requiredIds) {
  if (
    !ledger ||
    !HASH.test(ledger.headSha256 ?? "") ||
    ledger.pending !== 0 ||
    ledger.ambiguous !== 0 ||
    ledger.replayed !== 0 ||
    !Array.isArray(ledger.required) ||
    ledger.required.length !== requiredIds.length
  ) {
    return false;
  }
  return ledger.required.every((entry, index) => {
    const statusValid =
      entry?.status === "succeeded" ||
      (entry?.status === "reconciled-succeeded" && entry?.reconciliationVerified === true);
    return (
      entry?.actionId === requiredIds[index] &&
      entry?.occurrences === 1 &&
      statusValid &&
      entry?.compensatedWithoutRestoredPostcondition !== true
    );
  });
}

function stagingFailures(input) {
  const failures = [];
  if (
    input?.releaseEnvironment !== "staging" ||
    input?.runtimeEnvironment !== "staging" ||
    input?.drillMode !== "staging" ||
    input?.composeProject !== "spx-staging"
  ) {
    failures.push("STAGING_DISCRIMINATOR_INVALID");
  }
  if (input?.release?.valid !== true || input?.release?.candidateExact !== true) {
    failures.push("RELEASE_BINDING_INVALID");
  }
  if (
    input?.targetDescriptor?.valid !== true ||
    input?.targetDescriptor?.environment !== "staging" ||
    input?.targetDescriptor?.project !== "spx-staging"
  ) {
    failures.push("TARGET_DESCRIPTOR_INVALID");
  }
  if (input?.operatorBundle?.valid !== true || input?.operatorBundle?.installedExact !== true) {
    failures.push("OPERATOR_BUNDLE_INVALID");
  }
  if (
    input?.binding?.stagingRunIdExact !== true ||
    input?.binding?.approvalEnvelopeExact !== true ||
    input?.binding?.actionIndexExact !== true ||
    input?.binding?.databaseFingerprintExact !== true
  ) {
    failures.push("STAGING_BINDING_INVALID");
  }
  if (
    input?.host?.a3HostIdentityMatches !== true ||
    input?.host?.productionHostUnchanged !== true
  ) {
    failures.push("HOST_IDENTITY_OR_PRODUCTION_CONTINUITY_INVALID");
  }
  if (
    input?.guard?.sameInstanceAsTask10AndGate4 !== true ||
    input?.guard?.heartbeatFreshThroughout !== true ||
    input?.guard?.watchdogFreshThroughout !== true ||
    input?.guard?.continuityGapMs !== 0
  ) {
    failures.push("GUARD_CONTINUITY_INVALID");
  }
  if (
    input?.runtime?.baselineLeaseOwnerExact !== true ||
    input?.runtime?.identitiesExact !== true ||
    input?.runtime?.databaseRoutingExact !== true
  ) {
    failures.push("RUNTIME_CONTINUITY_INVALID");
  }
  if (input?.migration?.checksumsValid !== true || input?.migration?.schemaCompatible !== true) {
    failures.push("MIGRATION_EVIDENCE_INVALID");
  }
  if (
    input?.singleton?.firstReady !== true ||
    input?.singleton?.competingOwnerRejected !== true ||
    input?.singleton?.ownerCount !== 1
  ) {
    failures.push("SINGLETON_EVIDENCE_INVALID");
  }
  if (
    input?.baseline?.webReady !== true ||
    input?.baseline?.productionReady !== true ||
    !Number.isSafeInteger(input?.baseline?.localWatermark)
  ) {
    failures.push("BASELINE_EVIDENCE_INVALID");
  }
  if (
    input?.routed?.producersRemote !== true ||
    input?.routed?.webRemote !== true ||
    input?.routed?.streamsRemote !== true ||
    !Number.isSafeInteger(input?.routed?.routingWatermark)
  ) {
    failures.push("ROUTING_EVIDENCE_INVALID");
  }
  if (
    input?.replay?.raceDuplicates !== 0 ||
    input?.replay?.resumedAtOrAfter < input?.routed?.routingWatermark
  ) {
    failures.push("REPLAY_EVIDENCE_INVALID");
  }
  if (
    input?.pressure?.retentionOk !== true ||
    input?.pressure?.backpressureOk !== true ||
    input?.pressure?.slowClientResynced !== true
  ) {
    failures.push("PRESSURE_EVIDENCE_INVALID");
  }
  if (
    input?.proxyTls?.bufferingDisabled !== true ||
    input?.proxyTls?.cursorPreserved !== true ||
    input?.proxyTls?.upstreamIdentityVerified !== true
  ) {
    failures.push("PROXY_TLS_EVIDENCE_INVALID");
  }
  if (
    input?.dbFault?.stagingRealtimeUnavailable !== true ||
    input?.dbFault?.targetedReaderDegraded !== true ||
    input?.dbFault?.directDbClientsHealthy !== true ||
    input?.dbFault?.stagingWebReady !== true ||
    input?.dbFault?.workerAlive !== true ||
    input?.dbFault?.productionReady !== true
  ) {
    failures.push("STAGING_DB_FAULT_EVIDENCE_INVALID");
  }
  if (
    input?.recovered?.realtimeReady !== true ||
    input?.recovered?.cursorAtOrAfter < input?.routed?.routingWatermark
  ) {
    failures.push("RECOVERY_EVIDENCE_INVALID");
  }
  if (
    input?.rollback?.webReady !== true ||
    input?.rollback?.forwardRouteRestored !== true ||
    input?.rollback?.localWatermark < input?.routed?.routingWatermark
  ) {
    failures.push("ROLLBACK_EVIDENCE_INVALID");
  }
  if (
    input?.nMinusOne?.bundleValid !== true ||
    input?.nMinusOne?.allRollbackEligibleRolesCovered !== true ||
    input?.nMinusOne?.sideEffects !== 0 ||
    input?.nMinusOne?.fixtureDrift !== 0
  ) {
    failures.push("N_MINUS_ONE_EVIDENCE_INVALID");
  }
  if (
    input?.cleanup?.allStagingStopped !== true ||
    input?.cleanup?.guardClosed !== true ||
    input?.cleanup?.watchdogClosed !== true
  ) {
    failures.push("STAGING_CLEANUP_INVALID");
  }
  if (!exactTerminalActions(input?.actionJournal, REQUIRED_GATE5_ACTION_IDS)) {
    failures.push("GATE5_ACTION_LEDGER_INVALID");
  }
  return failures;
}

function productionFailures(input) {
  const failures = [];
  if (
    input?.releaseEnvironment !== "production" ||
    input?.runtimeEnvironment !== "production" ||
    input?.drillMode !== "supervised-production" ||
    input?.composeProject !== "spx-production"
  ) {
    failures.push("PRODUCTION_DISCRIMINATOR_INVALID");
  }
  if (input?.release?.valid !== true || input?.release?.candidateExact !== true) {
    failures.push("RELEASE_BINDING_INVALID");
  }
  if (
    input?.targetDescriptor?.valid !== true ||
    input?.targetDescriptor?.environment !== "production" ||
    input?.targetDescriptor?.project !== "spx-production"
  ) {
    failures.push("TARGET_DESCRIPTOR_INVALID");
  }
  if (input?.operatorBundle?.valid !== true || input?.operatorBundle?.installedExact !== true) {
    failures.push("OPERATOR_BUNDLE_INVALID");
  }
  if (
    input?.phase4Approval?.valid !== true ||
    input?.phase4Approval?.fresh !== true ||
    input?.phase4Approval?.distinct !== true ||
    input?.phase4Approval?.reused !== false
  ) {
    failures.push("PHASE4_PRODUCTION_APPROVAL_INVALID");
  }
  if (
    !HASH.test(input?.stagingBundleSha256 ?? "") ||
    !HASH.test(input?.nMinusOneBundleSha256 ?? "") ||
    !HASH.test(input?.predecessorStageCheckerSha256 ?? "")
  ) {
    failures.push("PRODUCTION_PREDECESSOR_BUNDLE_INVALID");
  }
  if (
    input?.migration?.checksumsValid !== true ||
    input?.migration?.schemaCompatible !== true ||
    input?.migration?.expandOnly !== true ||
    input?.migration?.contractMigration !== false
  ) {
    failures.push("PRODUCTION_MIGRATION_NOT_EXPAND_ONLY");
  }
  if (input?.singleton?.ownerCount !== 1 || input?.singleton?.ready !== true) {
    failures.push("PRODUCTION_SINGLETON_INVALID");
  }
  if (
    input?.routed?.incremental !== true ||
    input?.routed?.finalRouteApproved !== true ||
    !Number.isSafeInteger(input?.routed?.routingWatermark)
  ) {
    failures.push("PRODUCTION_ROUTING_INVALID");
  }
  if (
    input?.replay?.raceDuplicates !== 0 ||
    input?.replay?.resumedAtOrAfter < input?.routed?.routingWatermark
  ) {
    failures.push("PRODUCTION_REPLAY_INVALID");
  }
  if (
    input?.rollback?.catchupComplete !== true ||
    input?.rollback?.finalRouteApproved !== true ||
    input?.rollback?.localWatermark < input?.routed?.routingWatermark
  ) {
    failures.push("PRODUCTION_ROLLBACK_INVALID");
  }
  if (input?.productionDbFault?.attempted !== false || input?.productionDbFault?.count !== 0) {
    failures.push("PRODUCTION_DB_FAULT_FORBIDDEN");
  }
  if (!exactTerminalActions(input?.actionLedger, REQUIRED_PRODUCTION_PHASE4_ACTION_IDS)) {
    failures.push("PRODUCTION_PHASE4_ACTION_LEDGER_INVALID");
  }
  return failures;
}

export function evaluatePhase4Evidence(input) {
  const productionMode =
    input?.drillMode === "supervised-production" || input?.composeProject === "spx-production";
  const failures = productionMode ? productionFailures(input) : stagingFailures(input);
  return { ok: failures.length === 0, failures };
}

export function parsePhase4EvidenceArgs(argv) {
  if (!Array.isArray(argv)) throw new Error("Phase 4 evidence arguments are invalid");
  if (argv.length === 1 && argv[0] === `--dir=${STAGING_DIRECTORY}`) {
    return { mode: "staging", directory: STAGING_DIRECTORY };
  }
  if (
    argv.length === 2 &&
    argv[0] === "--supervised-production" &&
    argv[1] === `--dir=${PRODUCTION_DIRECTORY}`
  ) {
    return { mode: "supervised-production", directory: PRODUCTION_DIRECTORY };
  }
  throw new Error("Phase 4 evidence directory and mode must use the fixed approved path");
}

async function main() {
  try {
    const args = parsePhase4EvidenceArgs(process.argv.slice(2));
    const binding = await loadInstalledReleaseBinding({
      environment: args.mode === "staging" ? "staging" : "supervised-production",
    });
    const bundle = await readEvidenceBundle(args.directory, {
      allowedNames: ["phase4-evidence.json"],
      maxTotalBytes: 2 * 1024 * 1024,
      expectedBinding: binding,
    });
    const evidence = bundle["phase4-evidence.json"]?.evidence;
    const result = evaluatePhase4Evidence(evidence);
    const expectedModeOk =
      (args.mode === "staging" && evidence?.drillMode === "staging") ||
      (args.mode === "supervised-production" &&
        evidence?.drillMode === "supervised-production");
    const output = {
      ok: result.ok && expectedModeOk,
      failures: expectedModeOk ? result.failures : ["PHASE4_EVIDENCE_MODE_MISMATCH"],
      bundleSha256: sha256Canonical(evidence),
    };
    console.log(canonicalJson(output));
    if (!output.ok) process.exitCode = 1;
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["PHASE4_EVIDENCE_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("phase4-rollout-evidence-check.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
