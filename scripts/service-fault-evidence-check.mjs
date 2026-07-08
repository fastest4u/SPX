#!/usr/bin/env node
// Non-mutating Task 9 evidence bundle checker.
//
// Operators paste sanitized outputs from service-fault-* scripts plus a few
// manual booleans into one JSON file. This checker prints only pass/fail
// metadata; it never echoes raw evidence values.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
  "secret",
  "stderr",
  "stdout",
  "targetid",
  "token",
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
  ocrDownProbe: "ocr-down-probe.json",
  ocrFailureObserved: "ocr-failure-observed.json",
  ocrRecoveryObserved: "ocr-recovery-observed.json",
};

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function helpText() {
  return `service-fault-evidence-check.mjs

Non-mutating Task 9 evidence bundle checker. Prints only pass/fail or
metadata-only readiness output; it does not echo raw evidence values.

Usage:
  node scripts/service-fault-evidence-check.mjs --template
  node scripts/service-fault-evidence-check.mjs --dir-manifest
  node scripts/service-fault-evidence-check.mjs --init-dir=<evidence-folder>
  node scripts/service-fault-evidence-check.mjs --dir-status=<evidence-folder>
  node scripts/service-fault-evidence-check.mjs --dir=<evidence-folder>
  node scripts/service-fault-evidence-check.mjs --file=<evidence.json>

Task 9 live-drill flow:
  1. Create a scaffold with --init-dir.
  2. Paste sanitized command output into the manifest filenames.
  3. Use --dir-status for metadata-only readiness while collecting evidence.
  4. Use --dir or --file for the final semantic evidence check.
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
  return typeof value === "string" && value.trim() !== "" && !PLACEHOLDER_TEXT_PATTERN.test(value);
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
  if (!isObject(value)) return true;
  return Object.entries(value).every(([key, childValue]) => {
    const normalizedKey = key.toLowerCase();
    if (UNSAFE_EVIDENCE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))) {
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

function publishEventKeyMatchesDrill(value, drillId) {
  if (
    !isObject(value) ||
    !Number.isInteger(value.teamId) ||
    value.teamId <= 0 ||
    typeof value.eventKey !== "string" ||
    PLACEHOLDER_TEXT_PATTERN.test(value.eventKey)
  ) {
    return false;
  }
  const expectedPrefix = hasConcreteDrillId(drillId)
    ? `fault_drill:notifier_health:team:${value.teamId}:drill:${drillId}:`
    : `fault_drill:notifier_health:team:${value.teamId}:drill:`;
  return value.eventKey.startsWith(expectedPrefix) && value.eventKey.length > expectedPrefix.length;
}

function isSuccessfulPublish(value, drillId) {
  return (
    isOkObject(value) &&
    isNotificationServicePublishUrl(value.url) &&
    publishEventKeyMatchesDrill(value, drillId) &&
    typeof value.nodeId === "string" &&
    value.nodeId.trim() !== "" &&
    typeof value.eventKey === "string" &&
    value.eventKey.trim() !== "" &&
    Number.isInteger(value.status) &&
    value.status >= 200 &&
    value.status < 300 &&
    value.duplicate === false &&
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

function isOutboxSent(value, publishEvidence, drillId) {
  const outboxSummary = summary(value);
  return (
    isOutboxVisible(value, publishEvidence, drillId) &&
    hasOutboxExpectations(value, {
      minTotal: 1,
      expectSent: true,
      expectFailedAttempt: false,
      maxPending: 0,
    }) &&
    numberAt(outboxSummary, "sent") >= 1 &&
    numberAt(outboxSummary, "pending") === 0
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
    numberAt(outboxSummary, "failedAttempts") >= 1 &&
    numberAt(outboxSummary, "pending") >= 1
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

function hasDistinctPublishEvents(evidence) {
  return (
    isSuccessfulPublish(evidence.baselinePublish, evidence.drillId) &&
    isSuccessfulPublish(evidence.lineDownPublish, evidence.drillId) &&
    evidence.baselinePublish.teamId === evidence.lineDownPublish.teamId &&
    evidence.baselinePublish.nodeId === evidence.lineDownPublish.nodeId &&
    evidence.baselinePublish.eventKey !== evidence.lineDownPublish.eventKey
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
    hasValidCheckedAt(evidence.ocrDownProbe) &&
    hasValidCheckedAt(evidence.ocrFailureObserved) &&
    hasValidCheckedAt(evidence.ocrRecoveryObserved) &&
    happensBeforeOrAt(evidence.baselineProbe, evidence.workerBaseline) &&
    happensBeforeOrAt(evidence.workerBaseline, evidence.baselinePublish) &&
    happensBeforeOrAt(evidence.baselinePublish, evidence.baselineOutbox) &&
    happensBeforeOrAt(evidence.baselineOutbox, evidence.lineDownProbe) &&
    happensBeforeOrAt(evidence.lineDownProbe, evidence.lineDownPublish) &&
    happensBeforeOrAt(evidence.lineDownPublish, evidence.lineDownOutbox) &&
    happensBeforeOrAt(evidence.lineDownOutbox, evidence.workerAlive) &&
    happensBeforeOrAt(evidence.workerAlive, evidence.lineRecoveryOutbox) &&
    happensBeforeOrAt(evidence.lineRecoveryOutbox, evidence.ocrDownProbe) &&
    happensBeforeOrAt(evidence.ocrDownProbe, evidence.ocrFailureObserved) &&
    happensBeforeOrAt(evidence.ocrFailureObserved, evidence.ocrRecoveryObserved)
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
    verify: (evidence) => isSuccessfulPublish(evidence.baselinePublish, evidence.drillId),
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
    verify: (evidence) => isSuccessfulPublish(evidence.lineDownPublish, evidence.drillId),
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
      isOutboxSent(evidence.lineRecoveryOutbox, evidence.lineDownPublish, evidence.drillId),
  },
  {
    name: "ocrDownProbe",
    description: "The ocr-service outage was actually observed while web API stayed healthy.",
    verify: (evidence) => isExpectedDownProbe(evidence.ocrDownProbe, "ocr-service"),
  },
  {
    name: "ocrFailureObserved",
    description: "Line-service stayed alive and produced OCR degraded/failure behavior.",
    verify: (evidence) => isManualCheck(evidence.ocrFailureObserved, "ocr-failure-observed"),
  },
  {
    name: "ocrRecoveryObserved",
    description: "New OCR requests succeeded after ocr-service recovered.",
    verify: (evidence) => isManualCheck(evidence.ocrRecoveryObserved, "ocr-recovery-observed"),
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
    eventKey: `fault_drill:notifier_health:team:1:drill:split-service-fault-drill-YYYYMMDD-HHMM:${suffix}`,
    teamId: 1,
    nodeId: "allowed-worker-node-id",
    status: 202,
    duplicate: false,
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

function evidenceTemplate() {
  return {
    drillId: "split-service-fault-drill-YYYYMMDD-HHMM",
    environment: "staging",
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
        expectFailedAttempt: false,
        maxPending: 0,
      },
      "paste post-recovery service-fault-outbox-check.mjs output using --since-minutes=30 --min-total=1 --expect-sent --max-pending=0",
    ),
    ocrDownProbe: probeEvidenceTemplate(
      "ocr-service",
      [],
      "paste ocr-service outage service-fault-check.mjs output using --require=web-api,notification-service,line-service,ocr-service --expect-down=ocr-service",
    ),
    ocrFailureObserved: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "ocr-failure-observed",
      note: "set ok true after LINE OCR failure/degraded reply evidence",
    },
    ocrRecoveryObserved: {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      evidenceType: "ocr-recovery-observed",
      note: "set ok true after new OCR request success evidence",
    },
  };
}

function evidenceDirectoryManifest() {
  return {
    [DIRECTORY_METADATA_FILE]: "drillMetadata",
    ...Object.fromEntries(
      Object.entries(DIRECTORY_EVIDENCE_FILES).map(([key, filename]) => [filename, key]),
    ),
  };
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

function canonicalJson(value) {
  return JSON.stringify(value);
}

function isPlaceholderEvidence(value, templateValue) {
  return canonicalJson(value) === canonicalJson(templateValue);
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadEvidenceDirectory(dir) {
  const metadata = await readJsonFile(join(dir, DIRECTORY_METADATA_FILE));
  if (!isObject(metadata)) throw new Error(`${DIRECTORY_METADATA_FILE} must be a JSON object`);
  const evidence = { ...metadata };
  for (const [key, filename] of Object.entries(DIRECTORY_EVIDENCE_FILES)) {
    evidence[key] = await readJsonFile(join(dir, filename));
  }
  return evidence;
}

async function initEvidenceDirectory(dir) {
  const template = evidenceTemplate();
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
  await writeFile(join(dir, DIRECTORY_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
  files.push(DIRECTORY_METADATA_FILE);

  for (const [key, filename] of Object.entries(DIRECTORY_EVIDENCE_FILES)) {
    await writeFile(join(dir, filename), `${JSON.stringify(template[key], null, 2)}\n`);
    files.push(filename);
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    directory: dir,
    files,
  };
}

async function evidenceDirectoryStatus(dir) {
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
      const value = await readJsonFile(join(dir, entry.filename));
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
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        fileStatus.reason = "missing";
        missingFiles.push(entry.filename);
      } else {
        fileStatus.present = true;
        fileStatus.reason = "invalid-json";
        invalidJsonFiles.push(entry.filename);
      }
    }
    files.push(fileStatus);
  }

  const totalFiles = files.length;
  const nextRequiredFile = files.find((file) => !file.ready);
  const structurallyReady =
    readyFiles === totalFiles && missingFiles.length === 0 && invalidJsonFiles.length === 0;
  let semanticStatus = null;
  if (structurallyReady) {
    const semanticResult = evaluateEvidence(await loadEvidenceDirectory(dir));
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
    directory: dir,
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
  if (fixtureJson) return JSON.parse(fixtureJson);

  const dir = argValue("dir");
  if (dir) return loadEvidenceDirectory(dir);

  const file = argValue("file");
  if (!file)
    throw new Error(
      "Provide --file=<evidence.json>, --dir=<evidence-folder>, --fixture-json=<json>, --init-dir=<evidence-folder>, or --template",
    );
  return readJsonFile(file);
}

function evaluateEvidence(evidence) {
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
          reason: error instanceof Error ? error.message : "init-dir-failed",
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
          reason: error instanceof Error ? error.message : "dir-status-failed",
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
    const result = evaluateEvidence(evidence);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          checkedAt: new Date().toISOString(),
          reason: error instanceof Error ? error.message : "invalid-evidence",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
