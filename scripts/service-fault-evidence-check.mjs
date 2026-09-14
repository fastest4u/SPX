#!/usr/bin/env node
// Task 9 evidence bundle checker. Validation modes are non-mutating; --init-dir
// only writes the requested scaffold files.
//
// Operators paste sanitized outputs from service-fault-* scripts plus a few
// manual booleans into one JSON file. This checker prints only pass/fail
// metadata; it never echoes raw evidence values.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { canonicalJson, readEvidenceBundle, readEvidenceJson } from "./lib/evidence-artifact.mjs";
import { loadInstalledReleaseBinding } from "./lib/staging-installed-context.mjs";
import { evaluateDeliveryCounts } from "./lib/task9-worker-evaluators.mjs";

const REQUIRED_SERVICES = ["web-api", "notification-service", "line-service", "ocr-service"];
const EXPECTED_SERVICE_URLS = {
  "web-api": "http://web-api:3000/",
  "notification-service": "http://notification-service:3002/",
  "line-service": "http://line-service:3003/",
  "ocr-service": "http://ocr-service:3004/",
};
const ALLOWED_ROLLOUT_ENVIRONMENTS = ["staging", "supervised-production"];
const EXPECTED_NOTIFICATION_PUBLISH_URL =
  "http://notification-service:3002/internal/notification-events";
const EXPECTED_OUTBOX_SINCE_MINUTES = 30;
const EXPECTED_OCR_FIXTURE_SHA256 =
  "cdf7dcb00ca85d93e950cba10ac707c6e27c1dca828673512831454fbd53f73c";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const OCR_BOUNDARY_STATE_TTL_MS = 30 * 60 * 1_000;
const MAX_ID_LENGTH = 128;
const CONCRETE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_FUTURE_CHECKED_AT_SKEW_MS = 5 * 60 * 1_000;
const PLACEHOLDER_TEXT_PATTERN = /YYYY|HHMM|TODO|TBD|<|>/i;
const UNSAFE_EVIDENCE_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "credential",
  "password",
  "payload",
  "pincode",
  "raw",
  "rawresponsebody",
  "requestbody",
  "responsebody",
  "groupid",
  "linegroupid",
  "recipient",
  "secret",
  "stderr",
  "stdout",
  "target",
  "targetid",
  "token",
];
const UNSAFE_EVIDENCE_KEYS = new Set(["to"]);
const UNSAFE_EVIDENCE_CANONICAL_KEYS = new Set(["apikey", "privatekey"]);
const UNSAFE_EVIDENCE_VALUE_PATTERNS = [
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:secret|token|password|cookie|credential|pincode)\s*[=:]\s*\S+/i,
  /\b[A-Za-z0-9_.-]*(?:secret|token|password|cookie|credential|pincode|api[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];
const DIRECTORY_METADATA_FILE = "drill-metadata.json";
const DIRECTORY_EVIDENCE_FILES = {
  baselineProbe: "baseline-probe.json",
  workerBaseline: "worker-baseline.json",
  baselinePublish: "baseline-publish.json",
  baselineOutbox: "baseline-outbox.json",
  lineDownProbe: "line-down-probe.json",
  lineDownPublish: "line-down-publish.json",
  lineDownOutbox: "line-down-outbox.json",
  workerAlive: "worker-alive.json",
  lineRecoveryOutbox: "line-recovery-outbox.json",
  ocrPreflight: "ocr-preflight.json",
  ocrDownProbe: "ocr-down-probe.json",
  ocrFailureObserved: "ocr-failure-observed.json",
  workerAliveOcr: "worker-alive-ocr.json",
  ocrDownPublish: "ocr-down-publish.json",
  ocrDownOutbox: "ocr-down-outbox.json",
  ocrRecoveryObserved: "ocr-recovery-observed.json",
  finalProbe: "final-probe.json",
};

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function rolloutEnvironment() {
  const environment = argValue("environment") ?? "staging";
  if (!ALLOWED_ROLLOUT_ENVIRONMENTS.includes(environment)) {
    throw new Error("unsupported rollout environment");
  }
  return environment;
}

function helpText() {
  return `service-fault-evidence-check.mjs

Task 9 evidence bundle checker. Validation modes are non-mutating; --init-dir
only writes the requested scaffold files. Output is pass/fail or metadata-only
readiness data and does not echo raw evidence values.

Usage:
  node scripts/service-fault-evidence-check.mjs --template
  node scripts/service-fault-evidence-check.mjs --dir-manifest
  node scripts/service-fault-evidence-check.mjs --init-dir=<evidence-folder>
  node scripts/service-fault-evidence-check.mjs --dir-status=<evidence-folder>
  node scripts/service-fault-evidence-check.mjs --dir=<evidence-folder>

Use --environment=staging or --environment=supervised-production for every
directory command. The default remains staging for backward compatibility.

Task 9 live-drill flow:
  1. Create a scaffold with --init-dir.
  2. Paste sanitized command output into the manifest filenames.
  3. Use --dir-status for metadata-only readiness while collecting evidence.
  4. Use --dir for the final release-bound semantic evidence check.
`;
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactValues(values, expectedValues) {
  if (!Array.isArray(values)) return false;
  const valueSet = new Set(values);
  return (
    valueSet.size === values.length &&
    valueSet.size === expectedValues.length &&
    expectedValues.every((expected) => valueSet.has(expected))
  );
}

function hasNoValues(value) {
  return Array.isArray(value) && value.length === 0;
}

function hasConcreteDrillId(value) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    CONCRETE_ID_PATTERN.test(value) &&
    !PLACEHOLDER_TEXT_PATTERN.test(value)
  );
}

function hasConcreteNodeId(value) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    CONCRETE_ID_PATTERN.test(value) &&
    !PLACEHOLDER_TEXT_PATTERN.test(value)
  );
}

function hasDrillMetadata(value) {
  return (
    isObject(value) &&
    hasConcreteDrillId(value.drillId) &&
    typeof value.environment === "string" &&
    ALLOWED_ROLLOUT_ENVIRONMENTS.includes(value.environment)
  );
}

function hasNoUnsafeEvidenceFields(value) {
  if (Array.isArray(value)) return value.every((item) => hasNoUnsafeEvidenceFields(item));
  if (typeof value === "string") {
    return !UNSAFE_EVIDENCE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (!isObject(value)) return true;
  return Object.entries(value).every(([key, childValue]) => {
    const normalizedKey = key.toLowerCase();
    const canonicalKey = normalizedKey.replace(/[^a-z0-9]/g, "");
    if (
      UNSAFE_EVIDENCE_KEYS.has(normalizedKey) ||
      UNSAFE_EVIDENCE_CANONICAL_KEYS.has(canonicalKey) ||
      UNSAFE_EVIDENCE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))
    ) {
      return false;
    }
    return hasNoUnsafeEvidenceFields(childValue);
  });
}

function serviceResult(value, serviceName) {
  if (!Array.isArray(value.services)) return null;
  return (
    value.services.find((service) => isObject(service) && service.name === serviceName) ?? null
  );
}

function hasExpectedServiceUrl(value, serviceName) {
  const service = serviceResult(value, serviceName);
  return isObject(service) && service.url === EXPECTED_SERVICE_URLS[serviceName];
}

function isServiceDegraded(value, serviceName) {
  const service = serviceResult(value, serviceName);
  return (
    isObject(service) &&
    hasExpectedServiceUrl(value, serviceName) &&
    isObject(service.health) &&
    service.health.ok === true &&
    isObject(service.ready) &&
    service.ready.ok === false
  );
}

function isServiceDown(value, serviceName) {
  const service = serviceResult(value, serviceName);
  return (
    isObject(service) &&
    hasExpectedServiceUrl(value, serviceName) &&
    isObject(service.health) &&
    service.health.ok === false &&
    isObject(service.ready) &&
    service.ready.ok === false
  );
}

function isServiceHealthy(value, serviceName) {
  const service = serviceResult(value, serviceName);
  return (
    isObject(service) &&
    hasExpectedServiceUrl(value, serviceName) &&
    isObject(service.health) &&
    service.health.ok === true &&
    isObject(service.ready) &&
    service.ready.ok === true
  );
}

function expectedHealthyServices(serviceName, allowedDegradedServices) {
  const nonHealthyServices = new Set([serviceName, ...allowedDegradedServices]);
  return REQUIRED_SERVICES.filter((requiredService) => !nonHealthyServices.has(requiredService));
}

function isOkObject(value) {
  return isObject(value) && value.ok === true;
}

function isNotificationServicePublishUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "notification-service" &&
      url.port === "3002" &&
      url.pathname === "/internal/notification-events" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function publishEventKeyMatchesDrill(value, drillId, expectedStep) {
  if (
    !isObject(value) ||
    !Number.isInteger(value.teamId) ||
    value.teamId <= 0 ||
    typeof value.eventKey !== "string" ||
    PLACEHOLDER_TEXT_PATTERN.test(value.eventKey) ||
    !["baseline", "line-down", "ocr-down"].includes(value.step) ||
    (expectedStep !== undefined && value.step !== expectedStep)
  ) {
    return false;
  }
  if (!hasConcreteDrillId(drillId)) return false;
  return (
    value.eventKey ===
    `fault_drill:notifier_health:team:${value.teamId}:drill:${drillId}:step:${value.step}`
  );
}

function isSuccessfulPublish(value, drillId, expectedStep) {
  return (
    isOkObject(value) &&
    isNotificationServicePublishUrl(value.url) &&
    publishEventKeyMatchesDrill(value, drillId, expectedStep) &&
    hasConcreteNodeId(value.nodeId) &&
    typeof value.eventKey === "string" &&
    value.eventKey.trim() !== "" &&
    Number.isInteger(value.status) &&
    value.status >= 200 &&
    value.status < 300 &&
    ((value.duplicate === false && value.idempotentRecovery === false) ||
      (value.duplicate === true && value.idempotentRecovery === true)) &&
    Number.isInteger(value.outboxId) &&
    value.outboxId > 0 &&
    typeof value.outboxStatus === "string" &&
    value.outboxStatus.trim() !== ""
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function summary(value) {
  return isObject(value) && isObject(value.summary) ? value.summary : {};
}

function hasEventKeyFilter(value) {
  return isObject(value) && isObject(value.filters) && value.filters.eventKeyContains === true;
}

function outboxMatchesPublish(outboxEvidence, publishEvidence, drillId) {
  if (!isSuccessfulPublish(publishEvidence, drillId)) return false;
  const expectedHash = sha256(publishEvidence.eventKey);
  return (
    isObject(outboxEvidence) &&
    isObject(outboxEvidence.filters) &&
    outboxEvidence.filters.eventKeyContainsSha256 === expectedHash
  );
}

function numberAt(value, key) {
  const raw = isObject(value) ? value[key] : undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function hasOutboxExpectations(value, expected) {
  if (!isObject(value) || !isObject(value.expectations)) return false;
  return (
    value.expectations.minTotal === expected.minTotal &&
    value.expectations.expectSent === expected.expectSent &&
    value.expectations.expectFailedAttempt === expected.expectFailedAttempt &&
    value.expectations.maxPending === expected.maxPending
  );
}

function hasCleanOutboxProbe(value) {
  return hasNoValues(value.missingDbEnv) && hasNoValues(value.expectationFailures);
}

function hasLiveOutboxProbe(value) {
  return isObject(value) && value.mode === "mysql";
}

function hasRunbookOutboxWindow(value) {
  return isObject(value) && value.sinceMinutes === EXPECTED_OUTBOX_SINCE_MINUTES;
}

function isOutboxVisible(value, publishEvidence, drillId) {
  const outboxSummary = summary(value);
  return (
    isOkObject(value) &&
    hasLiveOutboxProbe(value) &&
    hasRunbookOutboxWindow(value) &&
    hasCleanOutboxProbe(value) &&
    hasEventKeyFilter(value) &&
    outboxMatchesPublish(value, publishEvidence, drillId) &&
    numberAt(outboxSummary, "total") >= 1
  );
}

function hasExactProviderDelivery(value, phase) {
  if (!isObject(value?.delivery) || value.delivery.phase !== phase) return false;
  const checked = evaluateDeliveryCounts(
    {
      matchedOutboxRows: value.delivery.matchedOutboxRows,
      success: value.delivery.success,
      failed: value.delivery.failed,
    },
    phase,
  );
  return checked.ok && hasNoValues(value.delivery.failures);
}

function isOutboxSent(value, publishEvidence, drillId, expectedFailedAttempt = false) {
  const outboxSummary = summary(value);
  const retriedRows = numberAt(outboxSummary, "retriedRows");
  return (
    isOutboxVisible(value, publishEvidence, drillId) &&
    hasOutboxExpectations(value, {
      minTotal: 1,
      expectSent: true,
      expectFailedAttempt: expectedFailedAttempt,
      maxPending: 0,
    }) &&
    numberAt(outboxSummary, "sent") >= 1 &&
    numberAt(outboxSummary, "pending") === 0 &&
    (expectedFailedAttempt ? retriedRows >= 1 : retriedRows === 0) &&
    hasExactProviderDelivery(value, expectedFailedAttempt ? "recovery" : "baseline")
  );
}

function hasFailedAttempt(value, publishEvidence, drillId) {
  const outboxSummary = summary(value);
  return (
    isOutboxVisible(value, publishEvidence, drillId) &&
    hasOutboxExpectations(value, {
      minTotal: 1,
      expectSent: false,
      expectFailedAttempt: true,
      maxPending: null,
    }) &&
    numberAt(outboxSummary, "retriedRows") >= 1 &&
    numberAt(outboxSummary, "pending") >= 1 &&
    hasExactProviderDelivery(value, "line-down")
  );
}

function isProbeHealthy(value) {
  return (
    isOkObject(value) &&
    hasExactValues(value.requiredServices, REQUIRED_SERVICES) &&
    hasExactValues(value.allowedDownServices, []) &&
    hasExactValues(value.allowedDegradedServices, []) &&
    hasExactValues(value.expectedDownServices, []) &&
    REQUIRED_SERVICES.every((serviceName) => isServiceHealthy(value, serviceName)) &&
    hasNoValues(value.unknownServiceNames) &&
    hasNoValues(value.missingRequiredServices) &&
    hasNoValues(value.missingExpectedDownServices) &&
    hasNoValues(value.expectedDownStillReachableServices) &&
    hasNoValues(value.unexpectedFailures)
  );
}

function isExpectedDownProbe(value, serviceName, allowedDegradedServices = []) {
  return (
    isOkObject(value) &&
    hasExactValues(value.requiredServices, REQUIRED_SERVICES) &&
    hasExactValues(value.allowedDownServices ?? [], []) &&
    hasExactValues(value.allowedDegradedServices ?? [], allowedDegradedServices) &&
    allowedDegradedServices.every((degradedService) => isServiceDegraded(value, degradedService)) &&
    expectedHealthyServices(serviceName, allowedDegradedServices).every((healthyService) =>
      isServiceHealthy(value, healthyService),
    ) &&
    hasExactValues(value.expectedDownServices, [serviceName]) &&
    isServiceDown(value, serviceName) &&
    hasNoValues(value.unknownServiceNames) &&
    hasNoValues(value.missingRequiredServices) &&
    hasNoValues(value.missingExpectedDownServices) &&
    hasNoValues(value.expectedDownStillReachableServices) &&
    hasNoValues(value.unexpectedFailures)
  );
}

function isManualCheck(value, evidenceType) {
  return (
    isOkObject(value) &&
    value.evidenceType === evidenceType &&
    typeof value.note === "string" &&
    value.note.trim() !== "" &&
    hasValidCheckedAt(value)
  );
}

function hasOcrBoundaryIdentity(value, drillId) {
  return (
    isObject(value) &&
    hasConcreteDrillId(drillId) &&
    value.drillId === drillId &&
    value.fixtureSha256 === EXPECTED_OCR_FIXTURE_SHA256 &&
    typeof value.correlationId === "string" &&
    SHA256_HEX_PATTERN.test(value.correlationId)
  );
}

function hasSuccessfulHttpStatus(value) {
  return Number.isInteger(value) && value >= 200 && value < 300;
}

function hasRetryableFailureHttpStatus(value) {
  return value === null || (Number.isInteger(value) && value >= 500 && value <= 599);
}

function isWithinOcrBoundaryStateTtl(preflight, value) {
  const preflightMs = timestampMs(preflight);
  const valueMs = timestampMs(value);
  if (preflightMs === null || valueMs === null) return false;
  const elapsedMs = valueMs - preflightMs;
  return elapsedMs >= 0 && elapsedMs <= OCR_BOUNDARY_STATE_TTL_MS;
}

function isOcrPreflightEvidence(evidence) {
  const value = evidence.ocrPreflight;
  return (
    isManualCheck(value, "ocr-preflight") &&
    hasOcrBoundaryIdentity(value, evidence.drillId) &&
    value.boundaryStatus === "validated-success" &&
    hasSuccessfulHttpStatus(value.httpStatus)
  );
}

function isOcrFailureEvidence(evidence) {
  const value = evidence.ocrFailureObserved;
  return (
    isManualCheck(value, "ocr-failure-observed") &&
    hasOcrBoundaryIdentity(value, evidence.drillId) &&
    isObject(evidence.ocrPreflight) &&
    value.correlationId === evidence.ocrPreflight.correlationId &&
    isWithinOcrBoundaryStateTtl(evidence.ocrPreflight, value) &&
    value.boundaryStatus === "retryable-failure-observed" &&
    hasRetryableFailureHttpStatus(value.httpStatus)
  );
}

function isOcrRecoveryEvidence(evidence) {
  const value = evidence.ocrRecoveryObserved;
  return (
    isManualCheck(value, "ocr-recovery-observed") &&
    hasOcrBoundaryIdentity(value, evidence.drillId) &&
    isObject(evidence.ocrPreflight) &&
    value.correlationId === evidence.ocrPreflight.correlationId &&
    isWithinOcrBoundaryStateTtl(evidence.ocrPreflight, value) &&
    value.boundaryStatus === "validated-success" &&
    hasSuccessfulHttpStatus(value.httpStatus)
  );
}

function timestampMs(value) {
  if (!isObject(value) || typeof value.checkedAt !== "string") return null;
  const parsed = Date.parse(value.checkedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValidCheckedAt(value) {
  const checkedAtMs = timestampMs(value);
  return checkedAtMs !== null && checkedAtMs <= Date.now() + MAX_FUTURE_CHECKED_AT_SKEW_MS;
}

function happensBeforeOrAt(first, second) {
  const firstMs = timestampMs(first);
  const secondMs = timestampMs(second);
  if (firstMs === null || secondMs === null) return false;
  return firstMs <= secondMs;
}

function happensBefore(first, second) {
  const firstMs = timestampMs(first);
  const secondMs = timestampMs(second);
  if (firstMs === null || secondMs === null) return false;
  return firstMs < secondMs;
}

function hasDistinctPublishEvents(evidence) {
  const publishes = [
    [evidence.baselinePublish, "baseline"],
    [evidence.lineDownPublish, "line-down"],
    [evidence.ocrDownPublish, "ocr-down"],
  ];
  return (
    publishes.every(([publish, step]) =>
      isSuccessfulPublish(publish, evidence.drillId, step),
    ) &&
    new Set(publishes.map(([publish]) => publish.teamId)).size === 1 &&
    new Set(publishes.map(([publish]) => publish.nodeId)).size === 1 &&
    new Set(publishes.map(([publish]) => publish.eventKey)).size === publishes.length
  );
}

function hasOrderedScriptEvidence(evidence) {
  return (
    hasValidCheckedAt(evidence.baselineProbe) &&
    hasValidCheckedAt(evidence.workerBaseline) &&
    hasValidCheckedAt(evidence.baselinePublish) &&
    hasValidCheckedAt(evidence.baselineOutbox) &&
    hasValidCheckedAt(evidence.lineDownProbe) &&
    hasValidCheckedAt(evidence.lineDownPublish) &&
    hasValidCheckedAt(evidence.lineDownOutbox) &&
    hasValidCheckedAt(evidence.workerAlive) &&
    hasValidCheckedAt(evidence.lineRecoveryOutbox) &&
    hasValidCheckedAt(evidence.ocrPreflight) &&
    hasValidCheckedAt(evidence.ocrDownProbe) &&
    hasValidCheckedAt(evidence.ocrFailureObserved) &&
    hasValidCheckedAt(evidence.workerAliveOcr) &&
    hasValidCheckedAt(evidence.ocrDownPublish) &&
    hasValidCheckedAt(evidence.ocrDownOutbox) &&
    hasValidCheckedAt(evidence.ocrRecoveryObserved) &&
    hasValidCheckedAt(evidence.finalProbe) &&
    happensBeforeOrAt(evidence.baselineProbe, evidence.workerBaseline) &&
    happensBeforeOrAt(evidence.workerBaseline, evidence.baselinePublish) &&
    happensBeforeOrAt(evidence.baselinePublish, evidence.baselineOutbox) &&
    happensBeforeOrAt(evidence.baselineOutbox, evidence.lineDownProbe) &&
    happensBeforeOrAt(evidence.lineDownProbe, evidence.lineDownPublish) &&
    happensBeforeOrAt(evidence.lineDownPublish, evidence.lineDownOutbox) &&
    happensBeforeOrAt(evidence.lineDownOutbox, evidence.workerAlive) &&
    happensBeforeOrAt(evidence.workerAlive, evidence.lineRecoveryOutbox) &&
    happensBeforeOrAt(evidence.lineRecoveryOutbox, evidence.ocrPreflight) &&
    happensBefore(evidence.ocrPreflight, evidence.ocrDownProbe) &&
    happensBefore(evidence.ocrDownProbe, evidence.ocrFailureObserved) &&
    happensBefore(evidence.ocrFailureObserved, evidence.workerAliveOcr) &&
    happensBefore(evidence.workerAliveOcr, evidence.ocrDownPublish) &&
    happensBefore(evidence.ocrDownPublish, evidence.ocrDownOutbox) &&
    happensBefore(evidence.ocrDownOutbox, evidence.ocrRecoveryObserved) &&
    happensBefore(evidence.ocrRecoveryObserved, evidence.finalProbe)
  );
}

const checks = [
  {
    name: "drillMetadata",
    description: "Evidence names a concrete staging or supervised production drill bundle.",
    verify: (evidence) => hasDrillMetadata(evidence),
  },
  {
    name: "sanitizedEvidence",
    description:
      "Evidence contains sanitized script/manual output, not raw targets, payloads, logs, or secrets.",
    verify: (evidence) => hasNoUnsafeEvidenceFields(evidence),
  },
  {
    name: "distinctPublishEvents",
    description: "Baseline and outage notification publishes used distinct event keys.",
    verify: (evidence) => hasDistinctPublishEvents(evidence),
  },
  {
    name: "scriptEvidenceOrder",
    description:
      "Script-generated evidence has valid non-future checkedAt timestamps in drill order.",
    verify: (evidence) => hasOrderedScriptEvidence(evidence),
  },
  {
    name: "baselineProbe",
    description: "All split services were reachable before injection.",
    verify: (evidence) => isProbeHealthy(evidence.baselineProbe),
  },
  {
    name: "workerBaseline",
    description: "At least one split worker was running before baseline notification publish.",
    verify: (evidence) => isManualCheck(evidence.workerBaseline, "worker-running"),
  },
  {
    name: "baselinePublish",
    description: "A controlled notification event was accepted by notification-service.",
    verify: (evidence) =>
      isSuccessfulPublish(evidence.baselinePublish, evidence.drillId, "baseline"),
  },
  {
    name: "baselineOutboxSent",
    description: "The baseline notification reached line-service and drained from pending.",
    verify: (evidence) =>
      isOutboxSent(evidence.baselineOutbox, evidence.baselinePublish, evidence.drillId),
  },
  {
    name: "lineDownProbe",
    description:
      "The line-service outage was actually observed while web API stayed healthy and notification-service stayed degraded, not down.",
    verify: (evidence) =>
      isExpectedDownProbe(evidence.lineDownProbe, "line-service", ["notification-service"]),
  },
  {
    name: "lineDownPublish",
    description: "A controlled notification event was accepted while line-service was down.",
    verify: (evidence) =>
      isSuccessfulPublish(evidence.lineDownPublish, evidence.drillId, "line-down"),
  },
  {
    name: "lineDownOutboxRetryable",
    description: "The outage event recorded at least one failed/retryable outbox attempt.",
    verify: (evidence) =>
      hasFailedAttempt(evidence.lineDownOutbox, evidence.lineDownPublish, evidence.drillId),
  },
  {
    name: "workerAlive",
    description: "A split worker stayed alive or kept polling during the line outage.",
    verify: (evidence) => isManualCheck(evidence.workerAlive, "worker-alive"),
  },
  {
    name: "lineRecoveryOutboxSent",
    description: "The outage notification drained after line-service recovered.",
    verify: (evidence) =>
      isOutboxSent(evidence.lineRecoveryOutbox, evidence.lineDownPublish, evidence.drillId, true),
  },
  {
    name: "ocrPreflight",
    description: "The reviewed synthetic OCR fixture succeeded before fault injection.",
    verify: (evidence) => isOcrPreflightEvidence(evidence),
  },
  {
    name: "ocrDownProbe",
    description: "The ocr-service outage was actually observed while web API stayed healthy.",
    verify: (evidence) => isExpectedDownProbe(evidence.ocrDownProbe, "ocr-service"),
  },
  {
    name: "ocrFailureObserved",
    description: "The same synthetic OCR request produced a retryable boundary failure.",
    verify: (evidence) => isOcrFailureEvidence(evidence),
  },
  {
    name: "workerAliveOcr",
    description: "A split worker stayed alive or kept polling during the OCR outage.",
    verify: (evidence) => isManualCheck(evidence.workerAliveOcr, "worker-alive-ocr"),
  },
  {
    name: "ocrDownPublish",
    description: "A controlled notification event was accepted while ocr-service was down.",
    verify: (evidence) =>
      isSuccessfulPublish(evidence.ocrDownPublish, evidence.drillId, "ocr-down"),
  },
  {
    name: "ocrDownOutboxSent",
    description: "The OCR-outage notification reached LINE and left no pending outbox row.",
    verify: (evidence) =>
      isOutboxSent(evidence.ocrDownOutbox, evidence.ocrDownPublish, evidence.drillId),
  },
  {
    name: "ocrRecoveryObserved",
    description: "The same synthetic OCR request succeeded after ocr-service recovered.",
    verify: (evidence) => isOcrRecoveryEvidence(evidence),
  },
  {
    name: "finalProbe",
    description: "All split services returned healthy after OCR recovery.",
    verify: (evidence) => isProbeHealthy(evidence.finalProbe),
  },
];

function outboxEvidenceTemplate(expectations, note) {
  return {
    ok: false,
    checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
    mode: "mysql",
    sinceMinutes: EXPECTED_OUTBOX_SINCE_MINUTES,
    filters: {
      eventKeyContains: true,
      eventKeyContainsSha256: "sha256-of-matching-publisher-eventKey",
    },
    expectations,
    missingDbEnv: [],
    expectationFailures: [],
    summary: {
      total: 0,
      pending: 0,
      failedAttempts: 0,
      sent: 0,
    },
    note,
  };
}

function publishEvidenceTemplate(suffix, note) {
  return {
    ok: false,
    checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
    url: EXPECTED_NOTIFICATION_PUBLISH_URL,
    eventKey: `fault_drill:notifier_health:team:1:drill:split-service-fault-drill-YYYYMMDD-HHMM:step:${suffix}`,
    step: suffix,
    teamId: 1,
    nodeId: "allowed-worker-node-id",
    status: 202,
    duplicate: false,
    idempotentRecovery: false,
    outboxId: 1,
    outboxStatus: "queued",
    note,
  };
}

function serviceRowTemplate(serviceName, healthOk, readyOk) {
  return {
    name: serviceName,
    url: EXPECTED_SERVICE_URLS[serviceName],
    health: { ok: healthOk },
    ready: { ok: readyOk },
  };
}

function probeEvidenceTemplate(expectedDownService, allowedDegradedServices, note) {
  const services = REQUIRED_SERVICES.map((serviceName) => {
    if (serviceName === expectedDownService) return serviceRowTemplate(serviceName, false, false);
    if (allowedDegradedServices.includes(serviceName)) {
      return serviceRowTemplate(serviceName, true, false);
    }
    return serviceRowTemplate(serviceName, true, true);
  });
  return {
    ok: false,
    checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
    requiredServices: REQUIRED_SERVICES,
    allowedDownServices: [],
    allowedDegradedServices,
    expectedDownServices: expectedDownService ? [expectedDownService] : [],
    unknownServiceNames: [],
    missingRequiredServices: [],
    missingExpectedDownServices: [],
    expectedDownStillReachableServices: [],
    unexpectedFailures: [],
    services,
    note,
  };
}

function ocrBoundaryEvidenceTemplate(evidenceType, boundaryStatus, httpStatus, note) {
  return {
    ok: false,
    checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
    evidenceType,
    drillId: "split-service-fault-drill-YYYYMMDD-HHMM",
    fixtureSha256: EXPECTED_OCR_FIXTURE_SHA256,
    correlationId: "replace-with-64-hex-correlation-id",
    boundaryStatus,
    httpStatus,
    note,
  };
}

function evidenceTemplate() {
  return {
    drillId: "split-service-fault-drill-YYYYMMDD-HHMM",
    environment: rolloutEnvironment(),
    note: "Paste full sanitized service-fault-* JSON outputs so checkedAt timestamps and event-key hashes can be validated.",
    baselineProbe: probeEvidenceTemplate(
      null,
      [],
      "paste baseline service-fault-check.mjs output using --require=web-api,notification-service,line-service,ocr-service",
    ),
    workerBaseline: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "worker-running",
      note: "set ok true after docker compose ps/log evidence shows one split worker running",
    },
    baselinePublish: publishEvidenceTemplate(
      "baseline",
      "paste baseline service-fault-publish-notification.mjs output",
    ),
    baselineOutbox: outboxEvidenceTemplate(
      {
        minTotal: 1,
        expectSent: true,
        expectFailedAttempt: false,
        maxPending: 0,
      },
      "paste baseline service-fault-outbox-check.mjs output using --since-minutes=30 --min-total=1 --expect-sent --max-pending=0",
    ),
    lineDownProbe: probeEvidenceTemplate(
      "line-service",
      ["notification-service"],
      "paste line-service outage service-fault-check.mjs output using --require=web-api,notification-service,line-service,ocr-service --expect-down=line-service --allow-degraded=notification-service",
    ),
    lineDownPublish: publishEvidenceTemplate(
      "line-down",
      "paste outage service-fault-publish-notification.mjs output",
    ),
    lineDownOutbox: outboxEvidenceTemplate(
      {
        minTotal: 1,
        expectSent: false,
        expectFailedAttempt: true,
        maxPending: null,
      },
      "paste outage service-fault-outbox-check.mjs output using --since-minutes=30 --min-total=1 --expect-failed-attempt",
    ),
    workerAlive: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "worker-alive",
      note: "set ok true after docker compose ps/log evidence",
    },
    lineRecoveryOutbox: outboxEvidenceTemplate(
      {
        minTotal: 1,
        expectSent: true,
        expectFailedAttempt: true,
        maxPending: 0,
      },
      "paste post-recovery service-fault-outbox-check.mjs output using --since-minutes=30 --min-total=1 --expect-sent --expect-failed-attempt --max-pending=0",
    ),
    ocrPreflight: ocrBoundaryEvidenceTemplate(
      "ocr-preflight",
      "validated-success",
      200,
      "paste OCR boundary probe preflight evidence",
    ),
    ocrDownProbe: probeEvidenceTemplate(
      "ocr-service",
      [],
      "paste ocr-service outage service-fault-check.mjs output using --require=web-api,notification-service,line-service,ocr-service --expect-down=ocr-service",
    ),
    ocrFailureObserved: ocrBoundaryEvidenceTemplate(
      "ocr-failure-observed",
      "retryable-failure-observed",
      null,
      "paste OCR boundary probe outage evidence",
    ),
    workerAliveOcr: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "worker-alive-ocr",
      note: "set ok true after docker compose ps/log evidence shows the worker stayed alive during ocr-service outage",
    },
    ocrDownPublish: publishEvidenceTemplate(
      "ocr-down",
      "paste OCR-outage service-fault-publish-notification.mjs output",
    ),
    ocrDownOutbox: outboxEvidenceTemplate(
      {
        minTotal: 1,
        expectSent: true,
        expectFailedAttempt: false,
        maxPending: 0,
      },
      "paste OCR-outage service-fault-outbox-check.mjs output using --since-minutes=30 --min-total=1 --expect-sent --max-pending=0",
    ),
    ocrRecoveryObserved: ocrBoundaryEvidenceTemplate(
      "ocr-recovery-observed",
      "validated-success",
      200,
      "paste OCR boundary probe recovery evidence",
    ),
    finalProbe: probeEvidenceTemplate(
      null,
      [],
      "paste final service-fault-check.mjs output after OCR recovery",
    ),
  };
}

export const SERVICE_FAULT_EVIDENCE_MANIFEST = Object.freeze({
    [DIRECTORY_METADATA_FILE]: "drillMetadata",
    ...Object.fromEntries(
      Object.entries(DIRECTORY_EVIDENCE_FILES).map(([key, filename]) => [filename, key]),
    ),
  });

function evidenceDirectoryManifest() {
  return SERVICE_FAULT_EVIDENCE_MANIFEST;
}

function evidenceDirectoryEntries() {
  const template = evidenceTemplate();
  return [
    {
      key: "drillMetadata",
      filename: DIRECTORY_METADATA_FILE,
      templateValue: {
        drillId: template.drillId,
        environment: template.environment,
        note: template.note,
      },
    },
    ...Object.entries(DIRECTORY_EVIDENCE_FILES).map(([key, filename]) => ({
      key,
      filename,
      templateValue: template[key],
    })),
  ];
}

function isPlaceholderEvidence(value, templateValue) {
  return canonicalJson(value) === canonicalJson(templateValue);
}

function safeErrorReason() {
  return "fault-evidence-check-failed";
}

async function readJsonFile(path) {
  return readEvidenceJson(path);
}

function evidenceDirectoryFilenames() {
  return [DIRECTORY_METADATA_FILE, ...Object.values(DIRECTORY_EVIDENCE_FILES)];
}

function boundPayload(value) {
  if (
    !isObject(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(["payload", "releaseBinding"])
  ) {
    throw new Error("verified release binding wrapper is required");
  }
  return value.payload;
}

async function readBoundEvidenceFiles(dir, options = {}) {
  const expectedBinding = await loadInstalledReleaseBinding({ environment: rolloutEnvironment() });
  return readEvidenceBundle(dir, {
    allowedNames: evidenceDirectoryFilenames(),
    expectedBinding,
    maxTotalBytes: 2 * 1024 * 1024,
    requireAll: options.requireAll,
    rejectPlaceholders: options.rejectPlaceholders,
  });
}

function assembleBoundEvidence(files) {
  const metadata = boundPayload(files[DIRECTORY_METADATA_FILE]);
  if (!isObject(metadata)) throw new Error(`${DIRECTORY_METADATA_FILE} must be a JSON object`);
  const evidence = { ...metadata };
  for (const [key, filename] of Object.entries(DIRECTORY_EVIDENCE_FILES)) {
    evidence[key] = boundPayload(files[filename]);
  }
  return evidence;
}

async function loadEvidenceDirectory(dir) {
  const evidence = assembleBoundEvidence(await readBoundEvidenceFiles(dir));
  if (evidence.environment !== rolloutEnvironment()) {
    throw new Error("evidence environment does not match the installed release binding");
  }
  return evidence;
}

async function initEvidenceDirectory(dir) {
  const template = evidenceTemplate();
  const releaseBinding = await loadInstalledReleaseBinding({ environment: rolloutEnvironment() });
  await mkdir(dir, { recursive: true });
  const existingFiles = await readdir(dir);
  if (existingFiles.length > 0) {
    throw new Error("--init-dir target must be empty");
  }

  const files = [];
  const metadata = {
    drillId: template.drillId,
    environment: template.environment,
    note: template.note,
  };
  await writeFile(
    join(dir, DIRECTORY_METADATA_FILE),
    canonicalJson({ payload: metadata, releaseBinding }),
  );
  files.push(DIRECTORY_METADATA_FILE);

  for (const [key, filename] of Object.entries(DIRECTORY_EVIDENCE_FILES)) {
    await writeFile(join(dir, filename), canonicalJson({ payload: template[key], releaseBinding }));
    files.push(filename);
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    files,
  };
}

async function evidenceDirectoryStatus(dir) {
  const boundFiles = await readBoundEvidenceFiles(dir, {
    requireAll: false,
    rejectPlaceholders: false,
  });
  const files = [];
  const missingFiles = [];
  const invalidJsonFiles = [];
  const placeholderFiles = [];
  let readyFiles = 0;

  for (const entry of evidenceDirectoryEntries()) {
    const fileStatus = {
      file: entry.filename,
      key: entry.key,
      present: false,
      validJson: false,
      placeholder: false,
      ready: false,
      reason: null,
    };
    try {
      if (!(entry.filename in boundFiles)) {
        fileStatus.reason = "missing";
        missingFiles.push(entry.filename);
        files.push(fileStatus);
        continue;
      }
      const value = boundPayload(boundFiles[entry.filename]);
      fileStatus.present = true;
      fileStatus.validJson = true;
      fileStatus.placeholder = isPlaceholderEvidence(value, entry.templateValue);
      fileStatus.ready = !fileStatus.placeholder;
      if (fileStatus.placeholder) {
        fileStatus.reason = "placeholder";
        placeholderFiles.push(entry.filename);
      }
      if (fileStatus.ready) readyFiles += 1;
    } catch (error) {
      fileStatus.present = true;
      fileStatus.reason = "invalid-json";
      invalidJsonFiles.push(entry.filename);
    }
    files.push(fileStatus);
  }

  const totalFiles = files.length;
  const nextRequiredFile = files.find((file) => !file.ready);
  const structurallyReady =
    readyFiles === totalFiles && missingFiles.length === 0 && invalidJsonFiles.length === 0;
  let semanticStatus = null;
  if (structurallyReady) {
    const semanticResult = evaluateServiceFaultEvidence(assembleBoundEvidence(boundFiles));
    semanticStatus = {
      ok: semanticResult.ok,
      totalChecks: semanticResult.totalChecks,
      passedChecks: semanticResult.passedChecks,
      failedChecks: semanticResult.failedChecks,
      nextFailedCheck: semanticResult.failedChecks[0] ?? null,
    };
  }
  return {
    ok: structurallyReady && (semanticStatus === null || semanticStatus.ok),
    checkedAt: new Date().toISOString(),
    totalFiles,
    presentFiles: files.filter((file) => file.present).length,
    readyFiles,
    missingFiles,
    invalidJsonFiles,
    placeholderFiles,
    nextRequiredEvidence: nextRequiredFile
      ? {
          file: nextRequiredFile.file,
          key: nextRequiredFile.key,
          reason: nextRequiredFile.reason,
        }
      : null,
    semanticStatus,
    files,
  };
}

async function loadEvidence() {
  const fixtureJson = argValue("fixture-json");
  if (fixtureJson) {
    if ((process.env.NODE_ENV !== "test" || globalThis.__SPX_TEST_ALLOW_UNBOUND_EVIDENCE__ !== true)) {
      throw new Error("unbound fixture evidence is unavailable");
    }
    return JSON.parse(fixtureJson);
  }

  const dir = argValue("dir");
  if (dir) return loadEvidenceDirectory(dir);

  const file = argValue("file");
  if (file && (process.env.NODE_ENV !== "test" || globalThis.__SPX_TEST_ALLOW_UNBOUND_EVIDENCE__ !== true)) {
    throw new Error("production evidence must use a verified bound directory");
  }
  if (!file)
    throw new Error("Provide --dir=<evidence-folder>, --init-dir=<evidence-folder>, or --template");
  return readJsonFile(file);
}

export function evaluateServiceFaultEvidence(evidence) {
  if (!isObject(evidence)) throw new Error("Evidence must be a JSON object");
  const results = checks.map((check) => {
    let ok = false;
    try {
      ok = check.verify(evidence);
    } catch {
      ok = false;
    }
    return {
      name: check.name,
      ok,
      description: check.description,
    };
  });
  const failedChecks = results.filter((result) => !result.ok).map((result) => result.name);
  return {
    ok: failedChecks.length === 0,
    checkedAt: new Date().toISOString(),
    totalChecks: results.length,
    passedChecks: results.length - failedChecks.length,
    failedChecks,
    checks: results,
  };
}

async function main() {
if (hasFlag("help")) {
  console.log(helpText());
} else if (hasFlag("template")) {
  console.log(JSON.stringify(evidenceTemplate(), null, 2));
} else if (hasFlag("dir-manifest")) {
  console.log(JSON.stringify(evidenceDirectoryManifest(), null, 2));
} else if (argValue("init-dir")) {
  try {
    const result = await initEvidenceDirectory(argValue("init-dir"));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checkedAt: new Date().toISOString(),
          reason: safeErrorReason(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
} else if (argValue("dir-status")) {
  try {
    const result = await evidenceDirectoryStatus(argValue("dir-status"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checkedAt: new Date().toISOString(),
          reason: safeErrorReason(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
} else {
  try {
    const evidence = await loadEvidence();
    const result = evaluateServiceFaultEvidence(evidence);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checkedAt: new Date().toISOString(),
          reason: safeErrorReason(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
