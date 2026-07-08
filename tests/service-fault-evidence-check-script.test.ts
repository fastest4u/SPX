import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "service-fault-evidence-check.mjs");
const tempRoot = resolve(tmpdir(), "spx-service-fault-evidence-check-test");

type ScriptResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type OutboxExpectations = {
  minTotal: number | null;
  expectSent: boolean;
  expectFailedAttempt: boolean;
  maxPending: number | null;
};

function runScript(args: string[]): Promise<ScriptResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("exit", (status) => resolveRun({ status, stdout, stderr }));
  });
}

const requiredServices = ["web-api", "notification-service", "line-service", "ocr-service"];
const notificationServicePublishUrl =
  "http://notification-service:3002/internal/notification-events";
const drillTeamId = 2;
const drillNodeId = "fault-drill-node";
const outboxSinceMinutes = 30;
const serviceUrls: Record<string, string> = {
  "web-api": "http://web-api:3000/",
  "notification-service": "http://notification-service:3002/",
  "line-service": "http://line-service:3003/",
  "ocr-service": "http://ocr-service:3004/",
};

function serviceResult(name: string, healthOk: boolean, readyOk: boolean) {
  return {
    name,
    url: serviceUrls[name],
    health: { ok: healthOk },
    ready: { ok: readyOk },
  };
}

function healthyProbe() {
  return {
    ok: true,
    checkedAt: "2026-07-07T10:00:00.000Z",
    requiredServices,
    allowedDownServices: [],
    allowedDegradedServices: [],
    expectedDownServices: [],
    unknownServiceNames: [],
    missingRequiredServices: [],
    missingExpectedDownServices: [],
    expectedDownStillReachableServices: [],
    unexpectedFailures: [],
    services: requiredServices.map((serviceName) => serviceResult(serviceName, true, true)),
  };
}

function expectedDownProbe(serviceName: string) {
  const services = requiredServices.map((candidate) => {
    if (candidate === serviceName) return serviceResult(candidate, false, false);
    if (serviceName === "line-service" && candidate === "notification-service") {
      return serviceResult(candidate, true, false);
    }
    return serviceResult(candidate, true, true);
  });

  return {
    ...healthyProbe(),
    checkedAt:
      serviceName === "line-service" ? "2026-07-07T10:03:00.000Z" : "2026-07-07T10:08:00.000Z",
    allowedDegradedServices: serviceName === "line-service" ? ["notification-service"] : [],
    allowedDownServices: [],
    expectedDownServices: [serviceName],
    missingExpectedDownServices: [],
    expectedDownStillReachableServices: [],
    services,
  };
}

function publish(eventKey: string, checkedAt: string) {
  return {
    ok: true,
    checkedAt,
    url: notificationServicePublishUrl,
    eventKey,
    teamId: drillTeamId,
    nodeId: drillNodeId,
    status: 200,
    duplicate: false,
    outboxId: 123,
    outboxStatus: "queued",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outbox(
  eventKey: string,
  checkedAt: string,
  overrides: Record<string, number>,
  expectations: OutboxExpectations = {
    minTotal: 1,
    expectSent: true,
    expectFailedAttempt: false,
    maxPending: 0,
  },
) {
  return {
    ok: true,
    checkedAt,
    mode: "mysql",
    sinceMinutes: outboxSinceMinutes,
    filters: { eventKeyContains: true, eventKeyContainsSha256: sha256(eventKey) },
    expectations,
    missingDbEnv: [],
    expectationFailures: [],
    summary: {
      total: 1,
      pending: 0,
      failedAttempts: 0,
      sent: 1,
      ...overrides,
    },
  };
}

function eventKeyFor(drillId: string, teamId: number, suffix: string) {
  return `fault_drill:notifier_health:team:${teamId}:drill:${drillId}:${suffix}`;
}

function validEvidence() {
  const drillId = "split-service-fault-drill-20260707-1000";
  const baselineEventKey = eventKeyFor(drillId, drillTeamId, "baseline");
  const lineDownEventKey = eventKeyFor(drillId, drillTeamId, "line-down");
  return {
    drillId,
    environment: "staging",
    note: "supervised split-service fault drill evidence bundle",
    baselineProbe: healthyProbe(),
    workerBaseline: {
      ok: true,
      checkedAt: "2026-07-07T10:00:30.000Z",
      evidenceType: "worker-running",
      note: "docker compose ps showed one split worker running before baseline publish",
    },
    baselinePublish: publish(baselineEventKey, "2026-07-07T10:01:00.000Z"),
    baselineOutbox: outbox(baselineEventKey, "2026-07-07T10:02:00.000Z", { sent: 1, pending: 0 }),
    lineDownProbe: expectedDownProbe("line-service"),
    lineDownPublish: publish(lineDownEventKey, "2026-07-07T10:04:00.000Z"),
    lineDownOutbox: outbox(
      lineDownEventKey,
      "2026-07-07T10:05:00.000Z",
      {
        failedAttempts: 1,
        sent: 0,
        pending: 1,
      },
      {
        minTotal: 1,
        expectSent: false,
        expectFailedAttempt: true,
        maxPending: null,
      },
    ),
    workerAlive: {
      ok: true,
      checkedAt: "2026-07-07T10:06:00.000Z",
      evidenceType: "worker-alive",
      note: "docker compose ps showed the split worker stayed alive during line-service outage",
    },
    lineRecoveryOutbox: outbox(lineDownEventKey, "2026-07-07T10:07:00.000Z", {
      sent: 1,
      pending: 0,
    }),
    ocrDownProbe: expectedDownProbe("ocr-service"),
    ocrFailureObserved: {
      ok: true,
      checkedAt: "2026-07-07T10:09:00.000Z",
      evidenceType: "ocr-failure-observed",
      note: "LINE OCR request returned degraded behavior while ocr-service was stopped",
    },
    ocrRecoveryObserved: {
      ok: true,
      checkedAt: "2026-07-07T10:10:00.000Z",
      evidenceType: "ocr-recovery-observed",
      note: "new LINE OCR request succeeded after ocr-service restarted",
    },
  };
}

async function writeEvidenceDir(evidence: Record<string, unknown>): Promise<string> {
  const dir = resolve(tempRoot, `evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "drill-metadata.json"),
    JSON.stringify(
      {
        drillId: evidence.drillId,
        environment: evidence.environment,
        note: evidence.note,
      },
      null,
      2,
    ),
    "utf8",
  );
  const files: Record<string, keyof ReturnType<typeof validEvidence>> = {
    "baseline-probe.json": "baselineProbe",
    "worker-baseline.json": "workerBaseline",
    "baseline-publish.json": "baselinePublish",
    "baseline-outbox.json": "baselineOutbox",
    "line-down-probe.json": "lineDownProbe",
    "line-down-publish.json": "lineDownPublish",
    "line-down-outbox.json": "lineDownOutbox",
    "worker-alive.json": "workerAlive",
    "line-recovery-outbox.json": "lineRecoveryOutbox",
    "ocr-down-probe.json": "ocrDownProbe",
    "ocr-failure-observed.json": "ocrFailureObserved",
    "ocr-recovery-observed.json": "ocrRecoveryObserved",
  };
  for (const [filename, key] of Object.entries(files)) {
    await writeFile(resolve(dir, filename), JSON.stringify(evidence[key], null, 2), "utf8");
  }
  return dir;
}

async function main() {
  await rm(tempRoot, { recursive: true, force: true });
  try {
    const success = await runScript([`--fixture-json=${JSON.stringify(validEvidence())}`]);
    assert.equal(success.status, 0, success.stderr || success.stdout);
    const successOutput = JSON.parse(success.stdout);
    assert.equal(successOutput.ok, true);
    assert.equal(successOutput.totalChecks, 16);
    assert.equal(successOutput.passedChecks, 16);
    assert.deepEqual(successOutput.failedChecks, []);

    const evidenceDir = await writeEvidenceDir(validEvidence());
    const directorySuccess = await runScript([`--dir=${evidenceDir}`]);
    assert.equal(directorySuccess.status, 0, directorySuccess.stderr || directorySuccess.stdout);
    const directorySuccessOutput = JSON.parse(directorySuccess.stdout);
    assert.equal(directorySuccessOutput.ok, true);
    assert.equal(directorySuccessOutput.passedChecks, 16);

    const unsafeEvidence = validEvidence();
    unsafeEvidence.baselinePublish = {
      ...unsafeEvidence.baselinePublish,
      targetId: "C-secret-line-target",
      payload: { message: "secret drill payload" },
    };
    unsafeEvidence.workerAlive = {
      ...unsafeEvidence.workerAlive,
      raw: "worker log may contain secret but must not print",
    };
    const unsafe = await runScript([`--fixture-json=${JSON.stringify(unsafeEvidence)}`]);
    assert.equal(unsafe.status, 1, unsafe.stdout);
    const unsafeOutput = JSON.parse(unsafe.stdout);
    assert.deepEqual(unsafeOutput.failedChecks, ["sanitizedEvidence"]);
    assert.doesNotMatch(
      unsafe.stdout,
      /C-secret-line-target|secret drill payload|worker log may contain secret/,
    );

    const unsafeKeyVariantEvidence = validEvidence();
    unsafeKeyVariantEvidence.baselinePublish = {
      ...unsafeKeyVariantEvidence.baselinePublish,
      lineTargetId: "C-secret-line-target",
      accessToken: "line-access-token",
    };
    unsafeKeyVariantEvidence.workerAlive = {
      ...unsafeKeyVariantEvidence.workerAlive,
      authorizationHeader: "Bearer secret-token",
      sharedSecretValue: "not-for-evidence",
    };
    const unsafeKeyVariant = await runScript([
      `--fixture-json=${JSON.stringify(unsafeKeyVariantEvidence)}`,
    ]);
    assert.equal(unsafeKeyVariant.status, 1, unsafeKeyVariant.stdout);
    const unsafeKeyVariantOutput = JSON.parse(unsafeKeyVariant.stdout);
    assert.deepEqual(unsafeKeyVariantOutput.failedChecks, ["sanitizedEvidence"]);
    assert.doesNotMatch(
      unsafeKeyVariant.stdout,
      /C-secret-line-target|line-access-token|Bearer secret-token|not-for-evidence/,
    );

    const unsafeValueVariantEvidence = validEvidence();
    unsafeValueVariantEvidence.workerAlive = {
      ...unsafeValueVariantEvidence.workerAlive,
      note: "Authorization: Bearer secret-token-value",
    };
    unsafeValueVariantEvidence.ocrRecoveryObserved = {
      ...unsafeValueVariantEvidence.ocrRecoveryObserved,
      note: "password=plain-text-secret",
    };
    const unsafeValueVariant = await runScript([
      `--fixture-json=${JSON.stringify(unsafeValueVariantEvidence)}`,
    ]);
    assert.equal(unsafeValueVariant.status, 1, unsafeValueVariant.stdout);
    const unsafeValueVariantOutput = JSON.parse(unsafeValueVariant.stdout);
    assert.deepEqual(unsafeValueVariantOutput.failedChecks, ["sanitizedEvidence"]);
    assert.doesNotMatch(
      unsafeValueVariant.stdout,
      /secret-token-value|plain-text-secret/,
    );

    const missingDrillMetadataEvidence = validEvidence();
    delete (missingDrillMetadataEvidence as { drillId?: string }).drillId;
    const missingDrillMetadata = await runScript([
      `--fixture-json=${JSON.stringify(missingDrillMetadataEvidence)}`,
    ]);
    assert.equal(missingDrillMetadata.status, 1, missingDrillMetadata.stdout);
    const missingDrillMetadataOutput = JSON.parse(missingDrillMetadata.stdout);
    assert.deepEqual(missingDrillMetadataOutput.failedChecks, ["drillMetadata"]);

    const localDrillMetadataEvidence = validEvidence();
    localDrillMetadataEvidence.environment = "local";
    const localDrillMetadata = await runScript([
      `--fixture-json=${JSON.stringify(localDrillMetadataEvidence)}`,
    ]);
    assert.equal(localDrillMetadata.status, 1, localDrillMetadata.stdout);
    const localDrillMetadataOutput = JSON.parse(localDrillMetadata.stdout);
    assert.deepEqual(localDrillMetadataOutput.failedChecks, ["drillMetadata"]);

    const placeholderDrillMetadataEvidence = validEvidence();
    placeholderDrillMetadataEvidence.drillId = "split-service-fault-drill-YYYYMMDD-HHMM";
    const placeholderDrillMetadata = await runScript([
      `--fixture-json=${JSON.stringify(placeholderDrillMetadataEvidence)}`,
    ]);
    assert.equal(placeholderDrillMetadata.status, 1, placeholderDrillMetadata.stdout);
    const placeholderDrillMetadataOutput = JSON.parse(placeholderDrillMetadata.stdout);
    assert.deepEqual(placeholderDrillMetadataOutput.failedChecks, ["drillMetadata"]);
    assert.doesNotMatch(placeholderDrillMetadata.stdout, /YYYYMMDD-HHMM/);

    const missingWorkerBaselineEvidence = validEvidence();
    delete (missingWorkerBaselineEvidence as { workerBaseline?: unknown }).workerBaseline;
    const missingWorkerBaseline = await runScript([
      `--fixture-json=${JSON.stringify(missingWorkerBaselineEvidence)}`,
    ]);
    assert.equal(missingWorkerBaseline.status, 1, missingWorkerBaseline.stdout);
    const missingWorkerBaselineOutput = JSON.parse(missingWorkerBaseline.stdout);
    assert.deepEqual(missingWorkerBaselineOutput.failedChecks, [
      "scriptEvidenceOrder",
      "workerBaseline",
    ]);

    const missingBaselineServiceRowEvidence = validEvidence();
    missingBaselineServiceRowEvidence.baselineProbe = {
      ...healthyProbe(),
      services: healthyProbe().services.filter((service) => service.name !== "ocr-service"),
    };
    const missingBaselineServiceRow = await runScript([
      `--fixture-json=${JSON.stringify(missingBaselineServiceRowEvidence)}`,
    ]);
    assert.equal(missingBaselineServiceRow.status, 1, missingBaselineServiceRow.stdout);
    const missingBaselineServiceRowOutput = JSON.parse(missingBaselineServiceRow.stdout);
    assert.deepEqual(missingBaselineServiceRowOutput.failedChecks, ["baselineProbe"]);

    const unhealthyBaselineServiceEvidence = validEvidence();
    unhealthyBaselineServiceEvidence.baselineProbe = {
      ...healthyProbe(),
      services: healthyProbe().services.map((service) =>
        service.name === "notification-service"
          ? serviceResult(service.name, true, false)
          : service,
      ),
    };
    const unhealthyBaselineService = await runScript([
      `--fixture-json=${JSON.stringify(unhealthyBaselineServiceEvidence)}`,
    ]);
    assert.equal(unhealthyBaselineService.status, 1, unhealthyBaselineService.stdout);
    const unhealthyBaselineServiceOutput = JSON.parse(unhealthyBaselineService.stdout);
    assert.deepEqual(unhealthyBaselineServiceOutput.failedChecks, ["baselineProbe"]);

    const wrongBaselineServiceUrlEvidence = validEvidence();
    wrongBaselineServiceUrlEvidence.baselineProbe = {
      ...healthyProbe(),
      services: healthyProbe().services.map((service) =>
        service.name === "notification-service"
          ? { ...service, url: "http://127.0.0.1:3002/" }
          : service,
      ),
    };
    const wrongBaselineServiceUrl = await runScript([
      `--fixture-json=${JSON.stringify(wrongBaselineServiceUrlEvidence)}`,
    ]);
    assert.equal(wrongBaselineServiceUrl.status, 1, wrongBaselineServiceUrl.stdout);
    const wrongBaselineServiceUrlOutput = JSON.parse(wrongBaselineServiceUrl.stdout);
    assert.deepEqual(wrongBaselineServiceUrlOutput.failedChecks, ["baselineProbe"]);

    const baselineWithAllowedDownEvidence = validEvidence();
    baselineWithAllowedDownEvidence.baselineProbe = {
      ...healthyProbe(),
      allowedDownServices: ["line-service"],
    };
    const baselineWithAllowedDown = await runScript([
      `--fixture-json=${JSON.stringify(baselineWithAllowedDownEvidence)}`,
    ]);
    assert.equal(baselineWithAllowedDown.status, 1, baselineWithAllowedDown.stdout);
    const baselineWithAllowedDownOutput = JSON.parse(baselineWithAllowedDown.stdout);
    assert.deepEqual(baselineWithAllowedDownOutput.failedChecks, ["baselineProbe"]);

    const baselineWithExpectedDownEvidence = validEvidence();
    baselineWithExpectedDownEvidence.baselineProbe = {
      ...healthyProbe(),
      expectedDownServices: ["ocr-service"],
    };
    const baselineWithExpectedDown = await runScript([
      `--fixture-json=${JSON.stringify(baselineWithExpectedDownEvidence)}`,
    ]);
    assert.equal(baselineWithExpectedDown.status, 1, baselineWithExpectedDown.stdout);
    const baselineWithExpectedDownOutput = JSON.parse(baselineWithExpectedDown.stdout);
    assert.deepEqual(baselineWithExpectedDownOutput.failedChecks, ["baselineProbe"]);

    const failureEvidence = validEvidence();
    failureEvidence.lineDownOutbox = outbox(
      failureEvidence.lineDownPublish.eventKey,
      "2026-07-07T10:05:00.000Z",
      {
        failedAttempts: 0,
        sent: 0,
        pending: 1,
      },
      {
        minTotal: 1,
        expectSent: false,
        expectFailedAttempt: true,
        maxPending: null,
      },
    );
    const failure = await runScript([`--fixture-json=${JSON.stringify(failureEvidence)}`]);
    assert.equal(failure.status, 1, failure.stdout);
    const failureOutput = JSON.parse(failure.stdout);
    assert.equal(failureOutput.ok, false);
    assert.deepEqual(failureOutput.failedChecks, ["lineDownOutboxRetryable"]);

    const duplicateBaselinePublishEvidence = validEvidence();
    duplicateBaselinePublishEvidence.baselinePublish = {
      ...duplicateBaselinePublishEvidence.baselinePublish,
      duplicate: true,
    };
    const duplicateBaselinePublish = await runScript([
      `--fixture-json=${JSON.stringify(duplicateBaselinePublishEvidence)}`,
    ]);
    assert.equal(duplicateBaselinePublish.status, 1, duplicateBaselinePublish.stdout);
    const duplicateBaselinePublishOutput = JSON.parse(duplicateBaselinePublish.stdout);
    assert.deepEqual(duplicateBaselinePublishOutput.failedChecks, [
      "distinctPublishEvents",
      "baselinePublish",
      "baselineOutboxSent",
    ]);

    const missingPublishOutboxIdEvidence = validEvidence();
    delete (missingPublishOutboxIdEvidence.lineDownPublish as { outboxId?: number }).outboxId;
    const missingPublishOutboxId = await runScript([
      `--fixture-json=${JSON.stringify(missingPublishOutboxIdEvidence)}`,
    ]);
    assert.equal(missingPublishOutboxId.status, 1, missingPublishOutboxId.stdout);
    const missingPublishOutboxIdOutput = JSON.parse(missingPublishOutboxId.stdout);
    assert.deepEqual(missingPublishOutboxIdOutput.failedChecks, [
      "distinctPublishEvents",
      "lineDownPublish",
      "lineDownOutboxRetryable",
      "lineRecoveryOutboxSent",
    ]);

    const legacyNotifierPublishEvidence = validEvidence();
    legacyNotifierPublishEvidence.baselinePublish = {
      ...legacyNotifierPublishEvidence.baselinePublish,
      url: "http://notifier:3000/internal/notification-events",
    };
    const legacyNotifierPublish = await runScript([
      `--fixture-json=${JSON.stringify(legacyNotifierPublishEvidence)}`,
    ]);
    assert.equal(legacyNotifierPublish.status, 1, legacyNotifierPublish.stdout);
    const legacyNotifierPublishOutput = JSON.parse(legacyNotifierPublish.stdout);
    assert.deepEqual(legacyNotifierPublishOutput.failedChecks, [
      "distinctPublishEvents",
      "baselinePublish",
      "baselineOutboxSent",
    ]);

    const placeholderPublishEventKeyEvidence = validEvidence();
    const placeholderPublishEventKey =
      "fault_drill:notifier_health:team:2:drill:split-service-fault-drill-20260707-1000:baseline-YYYYMMDD-HHMM";
    placeholderPublishEventKeyEvidence.baselinePublish = publish(
      placeholderPublishEventKey,
      "2026-07-07T10:01:00.000Z",
    );
    placeholderPublishEventKeyEvidence.baselineOutbox = outbox(
      placeholderPublishEventKey,
      "2026-07-07T10:02:00.000Z",
      { sent: 1, pending: 0 },
    );
    const placeholderPublishEventKeyResult = await runScript([
      `--fixture-json=${JSON.stringify(placeholderPublishEventKeyEvidence)}`,
    ]);
    assert.equal(
      placeholderPublishEventKeyResult.status,
      1,
      placeholderPublishEventKeyResult.stdout,
    );
    const placeholderPublishEventKeyOutput = JSON.parse(placeholderPublishEventKeyResult.stdout);
    assert.deepEqual(placeholderPublishEventKeyOutput.failedChecks, [
      "distinctPublishEvents",
      "baselinePublish",
      "baselineOutboxSent",
    ]);
    assert.doesNotMatch(placeholderPublishEventKeyResult.stdout, /YYYYMMDD-HHMM/);

    const missingPublishUrlEvidence = validEvidence();
    delete (missingPublishUrlEvidence.lineDownPublish as { url?: string }).url;
    const missingPublishUrl = await runScript([
      `--fixture-json=${JSON.stringify(missingPublishUrlEvidence)}`,
    ]);
    assert.equal(missingPublishUrl.status, 1, missingPublishUrl.stdout);
    const missingPublishUrlOutput = JSON.parse(missingPublishUrl.stdout);
    assert.deepEqual(missingPublishUrlOutput.failedChecks, [
      "distinctPublishEvents",
      "lineDownPublish",
      "lineDownOutboxRetryable",
      "lineRecoveryOutboxSent",
    ]);

    const missingPublishNodeEvidence = validEvidence();
    delete (missingPublishNodeEvidence.baselinePublish as { nodeId?: string }).nodeId;
    const missingPublishNode = await runScript([
      `--fixture-json=${JSON.stringify(missingPublishNodeEvidence)}`,
    ]);
    assert.equal(missingPublishNode.status, 1, missingPublishNode.stdout);
    const missingPublishNodeOutput = JSON.parse(missingPublishNode.stdout);
    assert.deepEqual(missingPublishNodeOutput.failedChecks, [
      "distinctPublishEvents",
      "baselinePublish",
      "baselineOutboxSent",
    ]);

    const publishTeamEventKeyMismatchEvidence = validEvidence();
    publishTeamEventKeyMismatchEvidence.lineDownPublish = {
      ...publishTeamEventKeyMismatchEvidence.lineDownPublish,
      teamId: 3,
    };
    const publishTeamEventKeyMismatch = await runScript([
      `--fixture-json=${JSON.stringify(publishTeamEventKeyMismatchEvidence)}`,
    ]);
    assert.equal(publishTeamEventKeyMismatch.status, 1, publishTeamEventKeyMismatch.stdout);
    const publishTeamEventKeyMismatchOutput = JSON.parse(publishTeamEventKeyMismatch.stdout);
    assert.deepEqual(publishTeamEventKeyMismatchOutput.failedChecks, [
      "distinctPublishEvents",
      "lineDownPublish",
      "lineDownOutboxRetryable",
      "lineRecoveryOutboxSent",
    ]);

    const differentPublishTeamEvidence = validEvidence();
    differentPublishTeamEvidence.lineDownPublish = publish(
      eventKeyFor(differentPublishTeamEvidence.drillId, 3, "line-down"),
      "2026-07-07T10:04:00.000Z",
    );
    differentPublishTeamEvidence.lineDownPublish.teamId = 3;
    differentPublishTeamEvidence.lineDownOutbox = outbox(
      differentPublishTeamEvidence.lineDownPublish.eventKey,
      "2026-07-07T10:05:00.000Z",
      { failedAttempts: 1, sent: 0, pending: 1 },
      {
        minTotal: 1,
        expectSent: false,
        expectFailedAttempt: true,
        maxPending: null,
      },
    );
    differentPublishTeamEvidence.lineRecoveryOutbox = outbox(
      differentPublishTeamEvidence.lineDownPublish.eventKey,
      "2026-07-07T10:07:00.000Z",
      { sent: 1, pending: 0 },
    );
    const differentPublishTeam = await runScript([
      `--fixture-json=${JSON.stringify(differentPublishTeamEvidence)}`,
    ]);
    assert.equal(differentPublishTeam.status, 1, differentPublishTeam.stdout);
    const differentPublishTeamOutput = JSON.parse(differentPublishTeam.stdout);
    assert.deepEqual(differentPublishTeamOutput.failedChecks, ["distinctPublishEvents"]);

    const mismatchedDrillPublishEvidence = validEvidence();
    const mismatchedDrillEventKey = eventKeyFor(
      "other-drill-20260707-1000",
      drillTeamId,
      "baseline",
    );
    mismatchedDrillPublishEvidence.baselinePublish = publish(
      mismatchedDrillEventKey,
      "2026-07-07T10:01:00.000Z",
    );
    mismatchedDrillPublishEvidence.baselineOutbox = outbox(
      mismatchedDrillEventKey,
      "2026-07-07T10:02:00.000Z",
      { sent: 1, pending: 0 },
    );
    const mismatchedDrillPublish = await runScript([
      `--fixture-json=${JSON.stringify(mismatchedDrillPublishEvidence)}`,
    ]);
    assert.equal(mismatchedDrillPublish.status, 1, mismatchedDrillPublish.stdout);
    const mismatchedDrillPublishOutput = JSON.parse(mismatchedDrillPublish.stdout);
    assert.deepEqual(mismatchedDrillPublishOutput.failedChecks, [
      "distinctPublishEvents",
      "baselinePublish",
      "baselineOutboxSent",
    ]);
    assert.doesNotMatch(mismatchedDrillPublish.stdout, /other-drill-20260707-1000/);

    const mismatchEvidence = validEvidence();
    mismatchEvidence.baselineOutbox = outbox(
      eventKeyFor(mismatchEvidence.drillId, drillTeamId, "wrong"),
      "2026-07-07T10:02:00.000Z",
      {
        sent: 1,
        pending: 0,
      },
    );
    const mismatch = await runScript([`--fixture-json=${JSON.stringify(mismatchEvidence)}`]);
    assert.equal(mismatch.status, 1, mismatch.stdout);
    const mismatchOutput = JSON.parse(mismatch.stdout);
    assert.deepEqual(mismatchOutput.failedChecks, ["baselineOutboxSent"]);

    const baselineOutboxWrongExpectationsEvidence = validEvidence();
    baselineOutboxWrongExpectationsEvidence.baselineOutbox = outbox(
      baselineOutboxWrongExpectationsEvidence.baselinePublish.eventKey,
      "2026-07-07T10:02:00.000Z",
      { sent: 1, pending: 0 },
      {
        minTotal: 1,
        expectSent: false,
        expectFailedAttempt: false,
        maxPending: null,
      },
    );
    const baselineOutboxWrongExpectations = await runScript([
      `--fixture-json=${JSON.stringify(baselineOutboxWrongExpectationsEvidence)}`,
    ]);
    assert.equal(baselineOutboxWrongExpectations.status, 1, baselineOutboxWrongExpectations.stdout);
    const baselineOutboxWrongExpectationsOutput = JSON.parse(
      baselineOutboxWrongExpectations.stdout,
    );
    assert.deepEqual(baselineOutboxWrongExpectationsOutput.failedChecks, ["baselineOutboxSent"]);

    const baselineOutboxFixtureModeEvidence = validEvidence();
    baselineOutboxFixtureModeEvidence.baselineOutbox = {
      ...baselineOutboxFixtureModeEvidence.baselineOutbox,
      mode: "fixture",
    };
    const baselineOutboxFixtureMode = await runScript([
      `--fixture-json=${JSON.stringify(baselineOutboxFixtureModeEvidence)}`,
    ]);
    assert.equal(baselineOutboxFixtureMode.status, 1, baselineOutboxFixtureMode.stdout);
    const baselineOutboxFixtureModeOutput = JSON.parse(baselineOutboxFixtureMode.stdout);
    assert.deepEqual(baselineOutboxFixtureModeOutput.failedChecks, ["baselineOutboxSent"]);

    const baselineOutboxWideWindowEvidence = validEvidence();
    baselineOutboxWideWindowEvidence.baselineOutbox = {
      ...baselineOutboxWideWindowEvidence.baselineOutbox,
      sinceMinutes: 120,
    };
    const baselineOutboxWideWindow = await runScript([
      `--fixture-json=${JSON.stringify(baselineOutboxWideWindowEvidence)}`,
    ]);
    assert.equal(baselineOutboxWideWindow.status, 1, baselineOutboxWideWindow.stdout);
    const baselineOutboxWideWindowOutput = JSON.parse(baselineOutboxWideWindow.stdout);
    assert.deepEqual(baselineOutboxWideWindowOutput.failedChecks, ["baselineOutboxSent"]);

    const missingRecoveryOutboxModeEvidence = validEvidence();
    delete (missingRecoveryOutboxModeEvidence.lineRecoveryOutbox as { mode?: string }).mode;
    const missingRecoveryOutboxMode = await runScript([
      `--fixture-json=${JSON.stringify(missingRecoveryOutboxModeEvidence)}`,
    ]);
    assert.equal(missingRecoveryOutboxMode.status, 1, missingRecoveryOutboxMode.stdout);
    const missingRecoveryOutboxModeOutput = JSON.parse(missingRecoveryOutboxMode.stdout);
    assert.deepEqual(missingRecoveryOutboxModeOutput.failedChecks, ["lineRecoveryOutboxSent"]);

    const missingLineDownOutboxWindowEvidence = validEvidence();
    delete (missingLineDownOutboxWindowEvidence.lineDownOutbox as { sinceMinutes?: number })
      .sinceMinutes;
    const missingLineDownOutboxWindow = await runScript([
      `--fixture-json=${JSON.stringify(missingLineDownOutboxWindowEvidence)}`,
    ]);
    assert.equal(missingLineDownOutboxWindow.status, 1, missingLineDownOutboxWindow.stdout);
    const missingLineDownOutboxWindowOutput = JSON.parse(missingLineDownOutboxWindow.stdout);
    assert.deepEqual(missingLineDownOutboxWindowOutput.failedChecks, ["lineDownOutboxRetryable"]);

    const lineDownOutboxNotPendingEvidence = validEvidence();
    lineDownOutboxNotPendingEvidence.lineDownOutbox = outbox(
      lineDownOutboxNotPendingEvidence.lineDownPublish.eventKey,
      "2026-07-07T10:05:00.000Z",
      { failedAttempts: 1, sent: 0, pending: 0 },
      {
        minTotal: 1,
        expectSent: false,
        expectFailedAttempt: true,
        maxPending: null,
      },
    );
    const lineDownOutboxNotPending = await runScript([
      `--fixture-json=${JSON.stringify(lineDownOutboxNotPendingEvidence)}`,
    ]);
    assert.equal(lineDownOutboxNotPending.status, 1, lineDownOutboxNotPending.stdout);
    const lineDownOutboxNotPendingOutput = JSON.parse(lineDownOutboxNotPending.stdout);
    assert.deepEqual(lineDownOutboxNotPendingOutput.failedChecks, ["lineDownOutboxRetryable"]);

    const lineDownOutboxExpectationFailureEvidence = validEvidence();
    lineDownOutboxExpectationFailureEvidence.lineDownOutbox = {
      ...lineDownOutboxExpectationFailureEvidence.lineDownOutbox,
      expectationFailures: ["expected-failed-attempt-missing"],
    };
    const lineDownOutboxExpectationFailure = await runScript([
      `--fixture-json=${JSON.stringify(lineDownOutboxExpectationFailureEvidence)}`,
    ]);
    assert.equal(
      lineDownOutboxExpectationFailure.status,
      1,
      lineDownOutboxExpectationFailure.stdout,
    );
    const lineDownOutboxExpectationFailureOutput = JSON.parse(
      lineDownOutboxExpectationFailure.stdout,
    );
    assert.deepEqual(lineDownOutboxExpectationFailureOutput.failedChecks, [
      "lineDownOutboxRetryable",
    ]);

    const duplicatePublishEvidence = validEvidence();
    duplicatePublishEvidence.lineDownPublish = publish(
      duplicatePublishEvidence.baselinePublish.eventKey,
      "2026-07-07T10:04:00.000Z",
    );
    duplicatePublishEvidence.lineDownOutbox = outbox(
      duplicatePublishEvidence.baselinePublish.eventKey,
      "2026-07-07T10:05:00.000Z",
      { failedAttempts: 1, sent: 0, pending: 1 },
      {
        minTotal: 1,
        expectSent: false,
        expectFailedAttempt: true,
        maxPending: null,
      },
    );
    duplicatePublishEvidence.lineRecoveryOutbox = outbox(
      duplicatePublishEvidence.baselinePublish.eventKey,
      "2026-07-07T10:07:00.000Z",
      { sent: 1, pending: 0 },
    );
    const duplicatePublish = await runScript([
      `--fixture-json=${JSON.stringify(duplicatePublishEvidence)}`,
    ]);
    assert.equal(duplicatePublish.status, 1, duplicatePublish.stdout);
    const duplicatePublishOutput = JSON.parse(duplicatePublish.stdout);
    assert.deepEqual(duplicatePublishOutput.failedChecks, ["distinctPublishEvents"]);

    const futureTimestampEvidence = validEvidence();
    const futureCheckedAt = [
      ["baselineProbe", "2999-01-01T00:00:00.000Z"],
      ["workerBaseline", "2999-01-01T00:00:30.000Z"],
      ["baselinePublish", "2999-01-01T00:01:00.000Z"],
      ["baselineOutbox", "2999-01-01T00:02:00.000Z"],
      ["lineDownProbe", "2999-01-01T00:03:00.000Z"],
      ["lineDownPublish", "2999-01-01T00:04:00.000Z"],
      ["lineDownOutbox", "2999-01-01T00:05:00.000Z"],
      ["workerAlive", "2999-01-01T00:06:00.000Z"],
      ["lineRecoveryOutbox", "2999-01-01T00:07:00.000Z"],
      ["ocrDownProbe", "2999-01-01T00:08:00.000Z"],
      ["ocrFailureObserved", "2999-01-01T00:09:00.000Z"],
      ["ocrRecoveryObserved", "2999-01-01T00:10:00.000Z"],
    ] as const;
    for (const [key, checkedAt] of futureCheckedAt) {
      futureTimestampEvidence[key] = { ...futureTimestampEvidence[key], checkedAt };
    }
    const futureTimestamp = await runScript([
      `--fixture-json=${JSON.stringify(futureTimestampEvidence)}`,
    ]);
    assert.equal(futureTimestamp.status, 1, futureTimestamp.stdout);
    const futureTimestampOutput = JSON.parse(futureTimestamp.stdout);
    assert.deepEqual(futureTimestampOutput.failedChecks, [
      "scriptEvidenceOrder",
      "workerBaseline",
      "workerAlive",
      "ocrFailureObserved",
      "ocrRecoveryObserved",
    ]);

    const outOfOrderEvidence = validEvidence();
    outOfOrderEvidence.lineDownOutbox = outbox(
      outOfOrderEvidence.lineDownPublish.eventKey,
      "2026-07-07T09:59:00.000Z",
      { failedAttempts: 1, sent: 0, pending: 1 },
      {
        minTotal: 1,
        expectSent: false,
        expectFailedAttempt: true,
        maxPending: null,
      },
    );
    const outOfOrder = await runScript([`--fixture-json=${JSON.stringify(outOfOrderEvidence)}`]);
    assert.equal(outOfOrder.status, 1, outOfOrder.stdout);
    const outOfOrderOutput = JSON.parse(outOfOrder.stdout);
    assert.deepEqual(outOfOrderOutput.failedChecks, ["scriptEvidenceOrder"]);

    const outOfOrderWorkerBaselineEvidence = validEvidence();
    outOfOrderWorkerBaselineEvidence.workerBaseline = {
      ...outOfOrderWorkerBaselineEvidence.workerBaseline,
      checkedAt: "2026-07-07T10:02:30.000Z",
    };
    const outOfOrderWorkerBaseline = await runScript([
      `--fixture-json=${JSON.stringify(outOfOrderWorkerBaselineEvidence)}`,
    ]);
    assert.equal(outOfOrderWorkerBaseline.status, 1, outOfOrderWorkerBaseline.stdout);
    const outOfOrderWorkerBaselineOutput = JSON.parse(outOfOrderWorkerBaseline.stdout);
    assert.deepEqual(outOfOrderWorkerBaselineOutput.failedChecks, ["scriptEvidenceOrder"]);

    const missingDegradedEvidence = validEvidence();
    missingDegradedEvidence.lineDownProbe = {
      ...expectedDownProbe("line-service"),
      allowedDegradedServices: [],
      allowedDownServices: ["notification-service"],
    };
    const missingDegraded = await runScript([
      `--fixture-json=${JSON.stringify(missingDegradedEvidence)}`,
    ]);
    assert.equal(missingDegraded.status, 1, missingDegraded.stdout);
    const missingDegradedOutput = JSON.parse(missingDegraded.stdout);
    assert.deepEqual(missingDegradedOutput.failedChecks, ["lineDownProbe"]);

    const extraAllowedDownEvidence = validEvidence();
    extraAllowedDownEvidence.lineDownProbe = {
      ...expectedDownProbe("line-service"),
      allowedDownServices: ["web-api"],
    };
    const extraAllowedDown = await runScript([
      `--fixture-json=${JSON.stringify(extraAllowedDownEvidence)}`,
    ]);
    assert.equal(extraAllowedDown.status, 1, extraAllowedDown.stdout);
    const extraAllowedDownOutput = JSON.parse(extraAllowedDown.stdout);
    assert.deepEqual(extraAllowedDownOutput.failedChecks, ["lineDownProbe"]);

    const extraAllowedDegradedEvidence = validEvidence();
    extraAllowedDegradedEvidence.lineDownProbe = {
      ...expectedDownProbe("line-service"),
      allowedDegradedServices: ["notification-service", "ocr-service"],
    };
    const extraAllowedDegraded = await runScript([
      `--fixture-json=${JSON.stringify(extraAllowedDegradedEvidence)}`,
    ]);
    assert.equal(extraAllowedDegraded.status, 1, extraAllowedDegraded.stdout);
    const extraAllowedDegradedOutput = JSON.parse(extraAllowedDegraded.stdout);
    assert.deepEqual(extraAllowedDegradedOutput.failedChecks, ["lineDownProbe"]);

    const missingDegradedServiceRowEvidence = validEvidence();
    missingDegradedServiceRowEvidence.lineDownProbe = {
      ...expectedDownProbe("line-service"),
      services: expectedDownProbe("line-service").services.filter(
        (service) => service.name !== "notification-service",
      ),
    };
    const missingDegradedServiceRow = await runScript([
      `--fixture-json=${JSON.stringify(missingDegradedServiceRowEvidence)}`,
    ]);
    assert.equal(missingDegradedServiceRow.status, 1, missingDegradedServiceRow.stdout);
    const missingDegradedServiceRowOutput = JSON.parse(missingDegradedServiceRow.stdout);
    assert.deepEqual(missingDegradedServiceRowOutput.failedChecks, ["lineDownProbe"]);

    const notActuallyDegradedEvidence = validEvidence();
    notActuallyDegradedEvidence.lineDownProbe = {
      ...expectedDownProbe("line-service"),
      services: expectedDownProbe("line-service").services.map((service) =>
        service.name === "notification-service" ? serviceResult(service.name, true, true) : service,
      ),
    };
    const notActuallyDegraded = await runScript([
      `--fixture-json=${JSON.stringify(notActuallyDegradedEvidence)}`,
    ]);
    assert.equal(notActuallyDegraded.status, 1, notActuallyDegraded.stdout);
    const notActuallyDegradedOutput = JSON.parse(notActuallyDegraded.stdout);
    assert.deepEqual(notActuallyDegradedOutput.failedChecks, ["lineDownProbe"]);

    const missingExpectedDownServiceRowEvidence = validEvidence();
    missingExpectedDownServiceRowEvidence.lineDownProbe = {
      ...expectedDownProbe("line-service"),
      services: expectedDownProbe("line-service").services.filter(
        (service) => service.name !== "line-service",
      ),
    };
    const missingExpectedDownServiceRow = await runScript([
      `--fixture-json=${JSON.stringify(missingExpectedDownServiceRowEvidence)}`,
    ]);
    assert.equal(missingExpectedDownServiceRow.status, 1, missingExpectedDownServiceRow.stdout);
    const missingExpectedDownServiceRowOutput = JSON.parse(missingExpectedDownServiceRow.stdout);
    assert.deepEqual(missingExpectedDownServiceRowOutput.failedChecks, ["lineDownProbe"]);

    const missingHealthyLineDownServiceRowEvidence = validEvidence();
    missingHealthyLineDownServiceRowEvidence.lineDownProbe = {
      ...expectedDownProbe("line-service"),
      services: expectedDownProbe("line-service").services.filter(
        (service) => service.name !== "web-api",
      ),
    };
    const missingHealthyLineDownServiceRow = await runScript([
      `--fixture-json=${JSON.stringify(missingHealthyLineDownServiceRowEvidence)}`,
    ]);
    assert.equal(
      missingHealthyLineDownServiceRow.status,
      1,
      missingHealthyLineDownServiceRow.stdout,
    );
    const missingHealthyLineDownServiceRowOutput = JSON.parse(
      missingHealthyLineDownServiceRow.stdout,
    );
    assert.deepEqual(missingHealthyLineDownServiceRowOutput.failedChecks, ["lineDownProbe"]);

    const missingRequiredLineDownServiceEvidence = validEvidence();
    missingRequiredLineDownServiceEvidence.lineDownProbe = {
      ...expectedDownProbe("line-service"),
      missingRequiredServices: ["web-api"],
    };
    const missingRequiredLineDownService = await runScript([
      `--fixture-json=${JSON.stringify(missingRequiredLineDownServiceEvidence)}`,
    ]);
    assert.equal(missingRequiredLineDownService.status, 1, missingRequiredLineDownService.stdout);
    const missingRequiredLineDownServiceOutput = JSON.parse(missingRequiredLineDownService.stdout);
    assert.deepEqual(missingRequiredLineDownServiceOutput.failedChecks, ["lineDownProbe"]);

    const expectedDownStillReachableEvidence = validEvidence();
    expectedDownStillReachableEvidence.ocrDownProbe = {
      ...expectedDownProbe("ocr-service"),
      services: expectedDownProbe("ocr-service").services.map((service) =>
        service.name === "ocr-service" ? serviceResult(service.name, false, true) : service,
      ),
    };
    const expectedDownStillReachable = await runScript([
      `--fixture-json=${JSON.stringify(expectedDownStillReachableEvidence)}`,
    ]);
    assert.equal(expectedDownStillReachable.status, 1, expectedDownStillReachable.stdout);
    const expectedDownStillReachableOutput = JSON.parse(expectedDownStillReachable.stdout);
    assert.deepEqual(expectedDownStillReachableOutput.failedChecks, ["ocrDownProbe"]);

    const missingOcrDownServiceUrlEvidence = validEvidence();
    missingOcrDownServiceUrlEvidence.ocrDownProbe = {
      ...expectedDownProbe("ocr-service"),
      services: expectedDownProbe("ocr-service").services.map((service) => {
        if (service.name !== "ocr-service") return service;
        const { url: _url, ...withoutUrl } = service;
        return withoutUrl;
      }),
    };
    const missingOcrDownServiceUrl = await runScript([
      `--fixture-json=${JSON.stringify(missingOcrDownServiceUrlEvidence)}`,
    ]);
    assert.equal(missingOcrDownServiceUrl.status, 1, missingOcrDownServiceUrl.stdout);
    const missingOcrDownServiceUrlOutput = JSON.parse(missingOcrDownServiceUrl.stdout);
    assert.deepEqual(missingOcrDownServiceUrlOutput.failedChecks, ["ocrDownProbe"]);

    const extraExpectedDownEvidence = validEvidence();
    extraExpectedDownEvidence.ocrDownProbe = {
      ...expectedDownProbe("ocr-service"),
      expectedDownServices: ["ocr-service", "line-service"],
    };
    const extraExpectedDown = await runScript([
      `--fixture-json=${JSON.stringify(extraExpectedDownEvidence)}`,
    ]);
    assert.equal(extraExpectedDown.status, 1, extraExpectedDown.stdout);
    const extraExpectedDownOutput = JSON.parse(extraExpectedDown.stdout);
    assert.deepEqual(extraExpectedDownOutput.failedChecks, ["ocrDownProbe"]);

    const missingHealthyOcrDownServiceRowEvidence = validEvidence();
    missingHealthyOcrDownServiceRowEvidence.ocrDownProbe = {
      ...expectedDownProbe("ocr-service"),
      services: expectedDownProbe("ocr-service").services.filter(
        (service) => service.name !== "web-api",
      ),
    };
    const missingHealthyOcrDownServiceRow = await runScript([
      `--fixture-json=${JSON.stringify(missingHealthyOcrDownServiceRowEvidence)}`,
    ]);
    assert.equal(missingHealthyOcrDownServiceRow.status, 1, missingHealthyOcrDownServiceRow.stdout);
    const missingHealthyOcrDownServiceRowOutput = JSON.parse(
      missingHealthyOcrDownServiceRow.stdout,
    );
    assert.deepEqual(missingHealthyOcrDownServiceRowOutput.failedChecks, ["ocrDownProbe"]);

    const missingRequiredOcrDownServiceEvidence = validEvidence();
    missingRequiredOcrDownServiceEvidence.ocrDownProbe = {
      ...expectedDownProbe("ocr-service"),
      missingRequiredServices: ["notification-service"],
    };
    const missingRequiredOcrDownService = await runScript([
      `--fixture-json=${JSON.stringify(missingRequiredOcrDownServiceEvidence)}`,
    ]);
    assert.equal(missingRequiredOcrDownService.status, 1, missingRequiredOcrDownService.stdout);
    const missingRequiredOcrDownServiceOutput = JSON.parse(missingRequiredOcrDownService.stdout);
    assert.deepEqual(missingRequiredOcrDownServiceOutput.failedChecks, ["ocrDownProbe"]);

    const missingManualNoteEvidence = validEvidence();
    missingManualNoteEvidence.workerAlive = { ok: true };
    const missingManualNote = await runScript([
      `--fixture-json=${JSON.stringify(missingManualNoteEvidence)}`,
    ]);
    assert.equal(missingManualNote.status, 1, missingManualNote.stdout);
    const missingManualNoteOutput = JSON.parse(missingManualNote.stdout);
    assert.deepEqual(missingManualNoteOutput.failedChecks, ["scriptEvidenceOrder", "workerAlive"]);

    const missingManualTimestampEvidence = validEvidence();
    delete (missingManualTimestampEvidence.workerAlive as { checkedAt?: string }).checkedAt;
    const missingManualTimestamp = await runScript([
      `--fixture-json=${JSON.stringify(missingManualTimestampEvidence)}`,
    ]);
    assert.equal(missingManualTimestamp.status, 1, missingManualTimestamp.stdout);
    const missingManualTimestampOutput = JSON.parse(missingManualTimestamp.stdout);
    assert.deepEqual(missingManualTimestampOutput.failedChecks, [
      "scriptEvidenceOrder",
      "workerAlive",
    ]);

    const missingManualEvidenceTypeEvidence = validEvidence();
    delete (missingManualEvidenceTypeEvidence.workerAlive as { evidenceType?: string })
      .evidenceType;
    const missingManualEvidenceType = await runScript([
      `--fixture-json=${JSON.stringify(missingManualEvidenceTypeEvidence)}`,
    ]);
    assert.equal(missingManualEvidenceType.status, 1, missingManualEvidenceType.stdout);
    const missingManualEvidenceTypeOutput = JSON.parse(missingManualEvidenceType.stdout);
    assert.deepEqual(missingManualEvidenceTypeOutput.failedChecks, ["workerAlive"]);

    const wrongManualEvidenceTypeEvidence = validEvidence();
    wrongManualEvidenceTypeEvidence.ocrRecoveryObserved = {
      ...wrongManualEvidenceTypeEvidence.ocrRecoveryObserved,
      evidenceType: "ocr-failure-observed",
    };
    const wrongManualEvidenceType = await runScript([
      `--fixture-json=${JSON.stringify(wrongManualEvidenceTypeEvidence)}`,
    ]);
    assert.equal(wrongManualEvidenceType.status, 1, wrongManualEvidenceType.stdout);
    const wrongManualEvidenceTypeOutput = JSON.parse(wrongManualEvidenceType.stdout);
    assert.deepEqual(wrongManualEvidenceTypeOutput.failedChecks, ["ocrRecoveryObserved"]);

    const outOfOrderManualEvidence = validEvidence();
    outOfOrderManualEvidence.workerAlive = {
      ...outOfOrderManualEvidence.workerAlive,
      checkedAt: "2026-07-07T10:08:00.000Z",
    };
    const outOfOrderManual = await runScript([
      `--fixture-json=${JSON.stringify(outOfOrderManualEvidence)}`,
    ]);
    assert.equal(outOfOrderManual.status, 1, outOfOrderManual.stdout);
    const outOfOrderManualOutput = JSON.parse(outOfOrderManual.stdout);
    assert.deepEqual(outOfOrderManualOutput.failedChecks, ["scriptEvidenceOrder"]);

    const missing = await runScript([`--fixture-json=${JSON.stringify({})}`]);
    assert.equal(missing.status, 1, missing.stdout);
    const missingOutput = JSON.parse(missing.stdout);
    assert.equal(missingOutput.failedChecks.length, 15);

    const template = await runScript(["--template"]);
    assert.equal(template.status, 0, template.stderr || template.stdout);
    const templateOutput = JSON.parse(template.stdout);
    assert.equal(templateOutput.drillId, "split-service-fault-drill-YYYYMMDD-HHMM");
    assert.equal(templateOutput.environment, "staging");
    assert.equal(templateOutput.workerAlive.ok, false);
    assert.deepEqual(templateOutput.baselineProbe, {
      ...healthyProbe(),
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      note: "paste baseline service-fault-check.mjs output using --require=web-api,notification-service,line-service,ocr-service",
    });
    assert.deepEqual(templateOutput.baselinePublish, {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      url: notificationServicePublishUrl,
      eventKey:
        "fault_drill:notifier_health:team:1:drill:split-service-fault-drill-YYYYMMDD-HHMM:baseline",
      teamId: 1,
      nodeId: "allowed-worker-node-id",
      status: 202,
      duplicate: false,
      outboxId: 1,
      outboxStatus: "queued",
      note: "paste baseline service-fault-publish-notification.mjs output",
    });
    assert.deepEqual(templateOutput.lineDownProbe, {
      ...expectedDownProbe("line-service"),
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      note: "paste line-service outage service-fault-check.mjs output using --require=web-api,notification-service,line-service,ocr-service --expect-down=line-service --allow-degraded=notification-service",
    });
    assert.deepEqual(templateOutput.lineDownPublish, {
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      url: notificationServicePublishUrl,
      eventKey:
        "fault_drill:notifier_health:team:1:drill:split-service-fault-drill-YYYYMMDD-HHMM:line-down",
      teamId: 1,
      nodeId: "allowed-worker-node-id",
      status: 202,
      duplicate: false,
      outboxId: 1,
      outboxStatus: "queued",
      note: "paste outage service-fault-publish-notification.mjs output",
    });
    assert.deepEqual(templateOutput.ocrDownProbe, {
      ...expectedDownProbe("ocr-service"),
      ok: false,
      checkedAt: "YYYY-MM-DDTHH:mm:ss.sssZ",
      note: "paste ocr-service outage service-fault-check.mjs output using --require=web-api,notification-service,line-service,ocr-service --expect-down=ocr-service",
    });
    assert.equal(templateOutput.baselineOutbox.sinceMinutes, 30);
    assert.deepEqual(templateOutput.baselineOutbox.expectations, {
      minTotal: 1,
      expectSent: true,
      expectFailedAttempt: false,
      maxPending: 0,
    });
    assert.equal(templateOutput.lineDownOutbox.sinceMinutes, 30);
    assert.deepEqual(templateOutput.lineDownOutbox.expectations, {
      minTotal: 1,
      expectSent: false,
      expectFailedAttempt: true,
      maxPending: null,
    });
    assert.equal(templateOutput.lineRecoveryOutbox.sinceMinutes, 30);
    assert.deepEqual(templateOutput.lineRecoveryOutbox.expectations, {
      minTotal: 1,
      expectSent: true,
      expectFailedAttempt: false,
      maxPending: 0,
    });

    const manifest = await runScript(["--dir-manifest"]);
    assert.equal(manifest.status, 0, manifest.stderr || manifest.stdout);
    const manifestOutput = JSON.parse(manifest.stdout);
    assert.equal(manifestOutput["drill-metadata.json"], "drillMetadata");
    assert.equal(manifestOutput["baseline-probe.json"], "baselineProbe");
    assert.equal(manifestOutput["worker-baseline.json"], "workerBaseline");
    assert.equal(manifestOutput["line-recovery-outbox.json"], "lineRecoveryOutbox");

    const help = await runScript(["--help"]);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /service-fault-evidence-check\.mjs/);
    assert.match(help.stdout, /--init-dir=<evidence-folder>/);
    assert.match(help.stdout, /--dir-status=<evidence-folder>/);
    assert.match(help.stdout, /--dir=<evidence-folder>/);
    assert.match(help.stdout, /metadata-only/i);
    assert.doesNotMatch(help.stdout, /YYYY-MM-DDTHH:mm:ss\.sssZ|allowed-worker-node-id/);

    const initializedDir = resolve(tempRoot, "initialized-evidence");
    const initialized = await runScript([`--init-dir=${initializedDir}`]);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const initializedOutput = JSON.parse(initialized.stdout);
    assert.equal(initializedOutput.ok, true);
    assert.equal(initializedOutput.directory, initializedDir);
    assert.equal(initializedOutput.files.length, Object.keys(manifestOutput).length);

    const initializedFiles = await readdir(initializedDir);
    assert.deepEqual(initializedFiles.sort(), Object.keys(manifestOutput).sort());

    const initializedMetadata = JSON.parse(
      await readFile(resolve(initializedDir, "drill-metadata.json"), "utf8"),
    );
    assert.deepEqual(initializedMetadata, {
      drillId: "split-service-fault-drill-YYYYMMDD-HHMM",
      environment: "staging",
      note: "Paste full sanitized service-fault-* JSON outputs so checkedAt timestamps and event-key hashes can be validated.",
    });

    const initializedBaselineProbe = JSON.parse(
      await readFile(resolve(initializedDir, "baseline-probe.json"), "utf8"),
    );
    assert.deepEqual(initializedBaselineProbe, templateOutput.baselineProbe);

    const initializedWorkerAlive = JSON.parse(
      await readFile(resolve(initializedDir, "worker-alive.json"), "utf8"),
    );
    assert.equal(initializedWorkerAlive.evidenceType, "worker-alive");
    assert.equal(initializedWorkerAlive.ok, false);

    const initializedValidation = await runScript([`--dir=${initializedDir}`]);
    assert.equal(initializedValidation.status, 1, initializedValidation.stdout);
    const initializedValidationOutput = JSON.parse(initializedValidation.stdout);
    assert.equal(initializedValidationOutput.ok, false);
    assert.equal(initializedValidationOutput.totalChecks, 16);
    assert.ok(initializedValidationOutput.failedChecks.includes("baselineProbe"));
    assert.ok(initializedValidationOutput.failedChecks.includes("drillMetadata"));

    const initializedStatus = await runScript([`--dir-status=${initializedDir}`]);
    assert.equal(initializedStatus.status, 1, initializedStatus.stdout);
    const initializedStatusOutput = JSON.parse(initializedStatus.stdout);
    assert.equal(initializedStatusOutput.ok, false);
    assert.equal(initializedStatusOutput.directory, initializedDir);
    assert.equal(initializedStatusOutput.totalFiles, Object.keys(manifestOutput).length);
    assert.equal(initializedStatusOutput.presentFiles, Object.keys(manifestOutput).length);
    assert.equal(initializedStatusOutput.readyFiles, 0);
    assert.equal(initializedStatusOutput.missingFiles.length, 0);
    assert.equal(initializedStatusOutput.invalidJsonFiles.length, 0);
    assert.deepEqual(initializedStatusOutput.nextRequiredEvidence, {
      file: "drill-metadata.json",
      key: "drillMetadata",
      reason: "placeholder",
    });
    assert.ok(initializedStatusOutput.placeholderFiles.includes("baseline-probe.json"));
    assert.ok(initializedStatusOutput.placeholderFiles.includes("drill-metadata.json"));
    assert.match(initializedStatus.stdout, /baseline-probe\.json/);
    assert.doesNotMatch(
      initializedStatus.stdout,
      /YYYY-MM-DDTHH:mm:ss\.sssZ|allowed-worker-node-id/,
    );

    const partialDir = await writeEvidenceDir(validEvidence());
    await rm(resolve(partialDir, "line-down-outbox.json"), { force: true });
    await writeFile(resolve(partialDir, "worker-alive.json"), "{not-json", "utf8");
    const partialStatus = await runScript([`--dir-status=${partialDir}`]);
    assert.equal(partialStatus.status, 1, partialStatus.stdout);
    const partialStatusOutput = JSON.parse(partialStatus.stdout);
    assert.equal(partialStatusOutput.ok, false);
    assert.deepEqual(partialStatusOutput.missingFiles, ["line-down-outbox.json"]);
    assert.deepEqual(partialStatusOutput.invalidJsonFiles, ["worker-alive.json"]);
    assert.deepEqual(partialStatusOutput.nextRequiredEvidence, {
      file: "line-down-outbox.json",
      key: "lineDownOutbox",
      reason: "missing",
    });
    assert.ok(partialStatusOutput.readyFiles > 0);
    assert.ok(partialStatusOutput.readyFiles < partialStatusOutput.totalFiles);
    assert.doesNotMatch(partialStatus.stdout, /fault_drill:notifier_health|docker compose ps/);

    const readyDir = await writeEvidenceDir(validEvidence());
    const readyStatus = await runScript([`--dir-status=${readyDir}`]);
    assert.equal(readyStatus.status, 0, readyStatus.stdout);
    const readyStatusOutput = JSON.parse(readyStatus.stdout);
    assert.equal(readyStatusOutput.ok, true);
    assert.equal(readyStatusOutput.readyFiles, readyStatusOutput.totalFiles);
    assert.deepEqual(readyStatusOutput.missingFiles, []);
    assert.deepEqual(readyStatusOutput.invalidJsonFiles, []);
    assert.deepEqual(readyStatusOutput.placeholderFiles, []);
    assert.equal(readyStatusOutput.nextRequiredEvidence, null);
    assert.deepEqual(readyStatusOutput.semanticStatus, {
      ok: true,
      totalChecks: 16,
      passedChecks: 16,
      failedChecks: [],
      nextFailedCheck: null,
    });
    assert.doesNotMatch(readyStatus.stdout, /fault_drill:notifier_health|docker compose ps/);

    const semanticFailureEvidence = validEvidence();
    semanticFailureEvidence.workerAlive = {
      ...semanticFailureEvidence.workerAlive,
      evidenceType: "worker-running",
    };
    const semanticFailureDir = await writeEvidenceDir(semanticFailureEvidence);
    const semanticFailureStatus = await runScript([`--dir-status=${semanticFailureDir}`]);
    assert.equal(semanticFailureStatus.status, 1, semanticFailureStatus.stdout);
    const semanticFailureStatusOutput = JSON.parse(semanticFailureStatus.stdout);
    assert.equal(semanticFailureStatusOutput.readyFiles, semanticFailureStatusOutput.totalFiles);
    assert.equal(semanticFailureStatusOutput.nextRequiredEvidence, null);
    assert.deepEqual(semanticFailureStatusOutput.semanticStatus, {
      ok: false,
      totalChecks: 16,
      passedChecks: 15,
      failedChecks: ["workerAlive"],
      nextFailedCheck: "workerAlive",
    });
    assert.doesNotMatch(
      semanticFailureStatus.stdout,
      /fault_drill:notifier_health|docker compose ps/,
    );

    const protectedDir = resolve(tempRoot, "protected-evidence");
    await mkdir(protectedDir, { recursive: true });
    await writeFile(resolve(protectedDir, "operator-note.txt"), "do not overwrite", "utf8");
    const protectedInit = await runScript([`--init-dir=${protectedDir}`]);
    assert.equal(protectedInit.status, 1, protectedInit.stdout);
    const protectedInitOutput = JSON.parse(protectedInit.stdout);
    assert.equal(protectedInitOutput.ok, false);
    assert.match(protectedInitOutput.reason, /empty/);
    assert.equal(
      await readFile(resolve(protectedDir, "operator-note.txt"), "utf8"),
      "do not overwrite",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
