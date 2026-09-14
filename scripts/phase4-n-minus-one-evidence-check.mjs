#!/usr/bin/env node

import {
  canonicalJson,
  readEvidenceBundle,
  sha256Canonical,
} from "./lib/evidence-artifact.mjs";
import { loadInstalledReleaseBinding } from "./lib/staging-installed-context.mjs";
import { evaluateSchemaRange } from "./phase4-n-minus-one-rehearsal.mjs";

const DIRECTORY = "/var/lib/spx-staging-rollout/evidence/phase4-n-minus-one-staging";
const ROLES = Object.freeze([
  "web-api",
  "notification-service",
  "line-service",
  "ocr-service",
  "worker-ifn-split",
  "worker-ptwl-split",
]);
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;

export const REQUIRED_N_MINUS_ONE_ACTION_IDS = Object.freeze([
  "phase4-n1-start",
  "phase4-n1-verify",
  "phase4-n1-rollback-forward",
  "phase4-n1-stop",
]);

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function terminalJournalValid(journal) {
  if (
    !journal ||
    !HASH.test(journal.headSha256 ?? "") ||
    journal.pending !== 0 ||
    journal.ambiguous !== 0 ||
    journal.replayed !== 0 ||
    !Array.isArray(journal.required) ||
    journal.required.length !== REQUIRED_N_MINUS_ONE_ACTION_IDS.length
  ) {
    return false;
  }
  return journal.required.every((entry, index) => {
    const terminal =
      entry?.status === "succeeded" ||
      (entry?.status === "reconciled-succeeded" && entry?.reconciliationVerified === true);
    return (
      entry?.actionId === REQUIRED_N_MINUS_ONE_ACTION_IDS[index] &&
      entry?.occurrences === 1 &&
      terminal
    );
  });
}

function timestampsValid(value) {
  const fields = ["preflight", "start", "verify", "rollbackForward", "stop"];
  const times = fields.map((field) => Date.parse(value?.[field]));
  return times.every(Number.isFinite) && times.every((time, index) => index === 0 || time > times[index - 1]);
}

function roleEvidenceValid(items) {
  if (!Array.isArray(items) || !same(items.map((item) => item?.role), ROLES)) return false;
  return items.every((item) => {
    const common =
      item.fixtureHashUnchanged === true &&
      item.fixtureRowCountUnchanged === true &&
      item.ddlStatements === 0 &&
      item.providerCalls === 0 &&
      item.backgroundLoops === 0 &&
      item.liveClaims === 0;
    if (!common) return false;
    if (item.role === "ocr-service") {
      return (
        item.usesDatabase === false &&
        item.dbCredentialPresent === false &&
        item.connectAttempts === 0 &&
        item.representativeReadPassed === false &&
        item.representativeWritePassed === false &&
        item.transactionRolledBack === false &&
        item.localBoundaryPassed === true
      );
    }
    return (
      item.usesDatabase === true &&
      item.dbCredentialPresent === true &&
      Number.isSafeInteger(item.connectAttempts) &&
      item.connectAttempts >= 1 &&
      item.representativeReadPassed === true &&
      item.representativeWritePassed === true &&
      item.transactionRolledBack === true
    );
  });
}

export function evaluateNMinusOneEvidence(input) {
  const failures = [];
  if (
    input?.releaseEnvironment !== "staging" ||
    input?.runtimeEnvironment !== "staging" ||
    input?.drillMode !== "staging-n-minus-one" ||
    input?.composeProject !== "spx-staging"
  ) {
    failures.push("N_MINUS_ONE_DISCRIMINATOR_INVALID");
  }
  if (
    !COMMIT.test(input?.candidateSha ?? "") ||
    !IMAGE.test(input?.candidateImageDigest ?? "") ||
    !COMMIT.test(input?.nMinusOneSha ?? "") ||
    !IMAGE.test(input?.nMinusOneImageDigest ?? "") ||
    !HASH.test(input?.candidateManifestSha256 ?? "") ||
    !HASH.test(input?.nMinusOneManifestSha256 ?? "")
  ) {
    failures.push("N_MINUS_ONE_RELEASE_BINDING_INVALID");
  }
  if (
    input?.targetDescriptorValid !== true ||
    input?.operatorBundleValid !== true ||
    input?.a3HostIdentityMatches !== true ||
    input?.stagingRunIdExact !== true ||
    input?.approvalEnvelopeExact !== true
  ) {
    failures.push("N_MINUS_ONE_TARGET_BINDING_INVALID");
  }
  if (
    input?.guardContinuous !== true ||
    input?.watchdogContinuous !== true ||
    input?.baselineIdentityExact !== true
  ) {
    failures.push("N_MINUS_ONE_BASELINE_CONTINUITY_INVALID");
  }
  if (input?.productionChanged !== false || input?.productionReadyThroughout !== true) {
    failures.push("PRODUCTION_NON_INTERFERENCE_INVALID");
  }
  if (
    input?.migrationChecksumsValid !== true ||
    !Number.isSafeInteger(input?.currentSchema) ||
    !evaluateSchemaRange({ current: input.currentSchema, ...input?.candidateSchemaRange }).ok ||
    !evaluateSchemaRange({ current: input.currentSchema, ...input?.nMinusOneSchemaRange }).ok
  ) {
    failures.push("N_MINUS_ONE_SCHEMA_COMPATIBILITY_INVALID");
  }
  if (
    !same(input?.signedRollbackEligibleRoles, ROLES) ||
    !same(input?.contractRoles, ROLES) ||
    !same(input?.probeInvocations, ROLES)
  ) {
    failures.push("N_MINUS_ONE_ROLE_COVERAGE_INVALID");
  }
  if (!roleEvidenceValid(input?.roles)) failures.push("N_MINUS_ONE_ROLE_EVIDENCE_INVALID");
  if (
    input?.fixtureDrift !== 0 ||
    input?.providerCalls !== 0 ||
    input?.backgroundLoops !== 0 ||
    input?.liveClaims !== 0
  ) {
    failures.push("N_MINUS_ONE_SIDE_EFFECT_INVALID");
  }
  if (!timestampsValid(input?.timestamps)) failures.push("N_MINUS_ONE_SEQUENCE_INVALID");
  if (!terminalJournalValid(input?.actionJournal)) failures.push("N_MINUS_ONE_ACTION_LEDGER_INVALID");
  return { ok: failures.length === 0, failures };
}

export function parseNMinusOneEvidenceArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== `--dir=${DIRECTORY}`) {
    throw new Error("N-1 evidence must use the fixed staging directory");
  }
  return { directory: DIRECTORY };
}

async function main() {
  try {
    const { directory } = parseNMinusOneEvidenceArgs(process.argv.slice(2));
    const binding = await loadInstalledReleaseBinding({ environment: "staging" });
    const bundle = await readEvidenceBundle(directory, {
      allowedNames: ["n-minus-one-evidence.json"],
      maxTotalBytes: 2 * 1024 * 1024,
      expectedBinding: binding,
    });
    const evidence = bundle["n-minus-one-evidence.json"]?.evidence;
    const result = evaluateNMinusOneEvidence(evidence);
    console.log(
      canonicalJson({
        ...result,
        bundleSha256: sha256Canonical(evidence),
      }),
    );
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(canonicalJson({ ok: false, failures: ["N_MINUS_ONE_EVIDENCE_REJECTED"] }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("phase4-n-minus-one-evidence-check.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
