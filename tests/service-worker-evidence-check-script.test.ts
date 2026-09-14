import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "service-worker-evidence-check.mjs");
const tempRoot = resolve(tmpdir(), "spx-service-worker-evidence-check-test");
const installedBindingPreloadPath = resolve(tempRoot, "installed-binding-preload.mjs");
const releaseBinding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: "c".repeat(64),
  environment: "staging",
  topology: "split",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: "d".repeat(64),
  operatorBundleSha256: "e".repeat(64),
  stagingApprovalEnvelopeSha256: "f".repeat(64),
  actionJournalHeadSha256: "1".repeat(64),
  stagingRunId: "staging-run-20260710-001",
};

type ScriptResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runScript(args: string[], withTestContext = true): Promise<ScriptResult> {
  return new Promise((resolveRun, rejectRun) => {
    const childEnv: NodeJS.ProcessEnv = withTestContext
      ? {
          ...process.env,
          NODE_ENV: "test",
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(installedBindingPreloadPath).href}`.trim(),
          SPX_TEST_RELEASE_BINDING_JSON: canonicalJson(releaseBinding),
        }
      : { ...process.env, NODE_ENV: "production" };
    if (!withTestContext) {
      delete childEnv.NODE_OPTIONS;
      delete childEnv.SPX_TEST_RELEASE_BINDING_JSON;
    }
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: childEnv,
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

function validEvidence() {
  return {
    drillId: "worker-only-drill-20260708-1500",
    environment: "staging",
    note: "staging worker replacement evidence",
    webApiReadyBefore: {
      ok: true,
      checkedAt: "2026-07-08T07:00:00.000Z",
      evidenceType: "web-api-ready",
      note: "public ready endpoint stayed healthy before worker replacement",
    },
    replacementStarted: {
      ok: true,
      checkedAt: "2026-07-08T07:01:00.000Z",
      evidenceType: "worker-replacement-started",
      teamIds: [1, 2],
      oldNodeId: "prod-worker-old-1",
      newNodeId: "prod-worker-new-1",
      note: "replacement worker was started with explicit RUN_TEAM_IDS",
    },
    runtimeStatusAfter: {
      ok: true,
      checkedAt: "2026-07-08T07:02:00.000Z",
      expectedTeamIds: [1, 2],
      expectedOwnerNodeId: "prod-worker-new-1",
      leases: [
        {
          teamId: 1,
          ownerNodeId: "prod-worker-new-1",
          ownerRole: "worker",
          active: true,
          heartbeatAt: "2026-07-08T07:01:45.000Z",
          leaseExpiresAt: "2026-07-08T07:02:15.000Z",
        },
        {
          teamId: 2,
          ownerNodeId: "prod-worker-new-1",
          ownerRole: "worker",
          active: true,
          heartbeatAt: "2026-07-08T07:01:45.000Z",
          leaseExpiresAt: "2026-07-08T07:02:15.000Z",
        },
      ],
      nodes: [
        {
          nodeId: "prod-worker-new-1",
          role: "worker",
          lastHeartbeatAt: "2026-07-08T07:01:45.000Z",
        },
      ],
    },
    metricsAfter: {
      ok: true,
      checkedAt: "2026-07-08T07:03:00.000Z",
      evidenceType: "worker-metrics-publishing",
      successCount: 2,
      failureCount: 0,
      note: "notification-service received worker runtime metrics after replacement",
    },
    webApiReadyAfter: {
      ok: true,
      checkedAt: "2026-07-08T07:04:00.000Z",
      evidenceType: "web-api-ready",
      note: "public ready endpoint stayed healthy after worker replacement",
    },
  };
}

function fullHandoffEvidence() {
  const watermark = {
    bookingHistory: 10,
    autoAcceptAttempts: 20,
    autoAcceptResults: 30,
    autoAcceptHistory: 40,
    notificationEvents: 50,
    notificationOutbox: 60,
    metrics: 70,
    duplicateAnomalies: 0,
  };
  return {
    isolationModel: "same-host",
    baseline: { owner: "old-worker", webReady: true, watermark },
    forward: {
      priorReleased: true,
      owner: "new-worker",
      priorInactive: true,
      metricsFailures: 0,
      watermark: { ...watermark, bookingHistory: 11 },
    },
    reverse: {
      replacementReleased: true,
      owner: "old-worker",
      replacementInactive: true,
      metricsFailures: 0,
      watermark: { ...watermark, bookingHistory: 11, notificationEvents: 51 },
    },
    final: { webReady: true, duplicateAnomalies: 0 },
  };
}

async function writeEvidenceDir(
  evidence: ReturnType<typeof validEvidence>,
  bound = true,
): Promise<string> {
  const dir = resolve(tempRoot, `evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "drill-metadata.json"),
    bound
      ? canonicalJson({
          payload: {
            drillId: evidence.drillId,
            environment: evidence.environment,
            note: evidence.note,
          },
          releaseBinding,
        })
      : canonicalJson({
          drillId: evidence.drillId,
          environment: evidence.environment,
          note: evidence.note,
        }),
    "utf8",
  );
  const files = {
    "web-api-ready-before.json": evidence.webApiReadyBefore,
    "replacement-started.json": evidence.replacementStarted,
    "runtime-status-after.json": evidence.runtimeStatusAfter,
    "metrics-after.json": evidence.metricsAfter,
    "web-api-ready-after.json": evidence.webApiReadyAfter,
  };
  for (const [filename, value] of Object.entries(files)) {
    await writeFile(
      resolve(dir, filename),
      bound ? canonicalJson({ payload: value, releaseBinding }) : canonicalJson(value),
      "utf8",
    );
  }
  return dir;
}

async function writeHandoffDir(evidence: ReturnType<typeof fullHandoffEvidence>): Promise<string> {
  const dir = resolve(tempRoot, `handoff-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "handoff-evidence.json"),
    canonicalJson({ payload: evidence, releaseBinding }),
    "utf8",
  );
  return dir;
}

async function main() {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
  await writeFile(
    installedBindingPreloadPath,
    "globalThis.__SPX_TEST_INSTALLED_RELEASE_BINDING__ = JSON.parse(process.env.SPX_TEST_RELEASE_BINDING_JSON); globalThis.__SPX_TEST_ALLOW_UNBOUND_EVIDENCE__ = true; delete process.env.SPX_TEST_RELEASE_BINDING_JSON;\n",
    "utf8",
  );
  try {
    const help = await runScript(["--help"]);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /service-worker-evidence-check\.mjs/);
    assert.match(help.stdout, /worker-only/i);
    assert.match(help.stdout, /--template/);
    assert.match(help.stdout, /--dir-status=<evidence-folder>/);
    assert.doesNotMatch(help.stdout, /YYYY-MM-DDTHH:mm:ss\.sssZ|prod-worker-new-1/);

    const success = await runScript([`--fixture-json=${JSON.stringify(validEvidence())}`]);
    assert.equal(success.status, 0, success.stderr || success.stdout);
    const successOutput = JSON.parse(success.stdout);
    assert.equal(successOutput.ok, true);
    assert.equal(successOutput.totalChecks, 8);
    assert.deepEqual(successOutput.failedChecks, []);

    const fullHandoff = await runScript([
      `--fixture-json=${JSON.stringify(fullHandoffEvidence())}`,
    ]);
    assert.equal(fullHandoff.status, 0, fullHandoff.stdout);
    assert.deepEqual(JSON.parse(fullHandoff.stdout).failedChecks, []);

    const overclaimed = fullHandoffEvidence();
    overclaimed.isolationModel = "multi-host";
    const overclaimResult = await runScript([
      `--fixture-json=${JSON.stringify(overclaimed)}`,
    ]);
    assert.equal(overclaimResult.status, 1, overclaimResult.stdout);
    assert.deepEqual(JSON.parse(overclaimResult.stdout).failedChecks, [
      "ISOLATION_MODEL_OVERCLAIM",
    ]);

    const productionUnbound = await runScript(
      [`--fixture-json=${JSON.stringify(validEvidence())}`],
      false,
    );
    assert.equal(productionUnbound.status, 1, productionUnbound.stdout);
    assert.equal(JSON.parse(productionUnbound.stdout).reason, "worker-evidence-check-failed");

    const unboundEvidenceDir = await writeEvidenceDir(validEvidence(), false);
    const unboundEvidence = await runScript([`--dir=${unboundEvidenceDir}`]);
    assert.equal(unboundEvidence.status, 1, unboundEvidence.stdout);

    const evidenceDir = await writeEvidenceDir(validEvidence());
    const directorySuccess = await runScript([`--dir=${evidenceDir}`]);
    assert.equal(directorySuccess.status, 0, directorySuccess.stderr || directorySuccess.stdout);
    const directorySuccessOutput = JSON.parse(directorySuccess.stdout);
    assert.equal(directorySuccessOutput.ok, true);
    assert.equal(directorySuccessOutput.totalChecks, 8);

    const handoffDir = await writeHandoffDir(fullHandoffEvidence());
    const boundHandoff = await runScript([`--handoff-dir=${handoffDir}`]);
    assert.equal(boundHandoff.status, 0, boundHandoff.stdout);
    assert.deepEqual(JSON.parse(boundHandoff.stdout).failedChecks, []);

    const contaminatedDir = await writeEvidenceDir(validEvidence());
    const unsafeExtraFilename = "raw-private-key-sk-proj-sensitive.log";
    const unsafeExtraContent = "sk-proj-extra-secret-material-abcdefghijklmnopqrstuvwxyz";
    await writeFile(resolve(contaminatedDir, unsafeExtraFilename), unsafeExtraContent, "utf8");
    for (const mode of ["dir", "dir-status"]) {
      const contaminated = await runScript([`--${mode}=${contaminatedDir}`]);
      assert.equal(contaminated.status, 1, contaminated.stdout);
      const contaminatedOutput = JSON.parse(contaminated.stdout);
      assert.equal(contaminatedOutput.ok, false);
      assert.equal(contaminatedOutput.reason, "worker-evidence-check-failed");
      assert.equal(contaminated.stdout.includes(unsafeExtraFilename), false);
      assert.equal(contaminated.stdout.includes(unsafeExtraContent), false);
    }

    const missingLease = validEvidence();
    missingLease.runtimeStatusAfter.leases = missingLease.runtimeStatusAfter.leases.slice(0, 1);
    const missingLeaseResult = await runScript([`--fixture-json=${JSON.stringify(missingLease)}`]);
    assert.equal(missingLeaseResult.status, 1, missingLeaseResult.stdout);
    const missingLeaseOutput = JSON.parse(missingLeaseResult.stdout);
    assert.deepEqual(missingLeaseOutput.failedChecks, ["runtimeLeaseOwnership"]);
    assert.doesNotMatch(missingLeaseResult.stdout, /prod-worker-new-1|prod-worker-old-1/);

    const duplicateOwner = validEvidence();
    duplicateOwner.runtimeStatusAfter.leases.push({
      teamId: 2,
      ownerNodeId: "prod-worker-other-1",
      ownerRole: "worker",
      active: true,
      heartbeatAt: "2026-07-08T07:01:45.000Z",
      leaseExpiresAt: "2026-07-08T07:02:15.000Z",
    });
    const duplicateOwnerResult = await runScript([
      `--fixture-json=${JSON.stringify(duplicateOwner)}`,
    ]);
    assert.equal(duplicateOwnerResult.status, 1, duplicateOwnerResult.stdout);
    const duplicateOwnerOutput = JSON.parse(duplicateOwnerResult.stdout);
    assert.deepEqual(duplicateOwnerOutput.failedChecks, ["runtimeLeaseOwnership"]);
    assert.doesNotMatch(duplicateOwnerResult.stdout, /prod-worker-other-1/);

    const expiredAtObservation = validEvidence();
    expiredAtObservation.runtimeStatusAfter.leases[0].leaseExpiresAt =
      expiredAtObservation.runtimeStatusAfter.checkedAt;
    const expiredAtObservationResult = await runScript([
      `--fixture-json=${JSON.stringify(expiredAtObservation)}`,
    ]);
    assert.equal(expiredAtObservationResult.status, 1, expiredAtObservationResult.stdout);
    const expiredAtObservationOutput = JSON.parse(expiredAtObservationResult.stdout);
    assert.deepEqual(expiredAtObservationOutput.failedChecks, ["runtimeLeaseOwnership"]);
    assert.equal(
      `${expiredAtObservationResult.stdout}\n${expiredAtObservationResult.stderr}`.includes(
        "prod-worker-new-1",
      ),
      false,
    );
    assert.equal(
      `${expiredAtObservationResult.stdout}\n${expiredAtObservationResult.stderr}`.includes(
        expiredAtObservation.runtimeStatusAfter.checkedAt,
      ),
      false,
    );

    const heartbeatAtExpiry = validEvidence();
    heartbeatAtExpiry.runtimeStatusAfter.leases[0].heartbeatAt =
      heartbeatAtExpiry.runtimeStatusAfter.leases[0].leaseExpiresAt;
    const heartbeatAtExpiryResult = await runScript([
      `--fixture-json=${JSON.stringify(heartbeatAtExpiry)}`,
    ]);
    assert.equal(heartbeatAtExpiryResult.status, 1, heartbeatAtExpiryResult.stdout);
    const heartbeatAtExpiryOutput = JSON.parse(heartbeatAtExpiryResult.stdout);
    assert.deepEqual(heartbeatAtExpiryOutput.failedChecks, ["runtimeLeaseOwnership"]);
    assert.equal(
      `${heartbeatAtExpiryResult.stdout}\n${heartbeatAtExpiryResult.stderr}`.includes(
        heartbeatAtExpiry.runtimeStatusAfter.leases[0].leaseExpiresAt,
      ),
      false,
    );

    const staleOwnerNode = validEvidence();
    staleOwnerNode.runtimeStatusAfter.nodes[0].lastHeartbeatAt = "2026-07-08T06:59:59.999Z";
    const staleOwnerNodeResult = await runScript([
      `--fixture-json=${JSON.stringify(staleOwnerNode)}`,
    ]);
    assert.equal(staleOwnerNodeResult.status, 1, staleOwnerNodeResult.stdout);
    const staleOwnerNodeOutput = JSON.parse(staleOwnerNodeResult.stdout);
    assert.deepEqual(staleOwnerNodeOutput.failedChecks, ["runtimeLeaseOwnership"]);
    assert.equal(
      `${staleOwnerNodeResult.stdout}\n${staleOwnerNodeResult.stderr}`.includes(
        staleOwnerNode.runtimeStatusAfter.nodes[0].lastHeartbeatAt,
      ),
      false,
    );

    const futureOwnerNode = validEvidence();
    futureOwnerNode.runtimeStatusAfter.nodes[0].lastHeartbeatAt = "2026-07-08T07:02:00.001Z";
    const futureOwnerNodeResult = await runScript([
      `--fixture-json=${JSON.stringify(futureOwnerNode)}`,
    ]);
    assert.equal(futureOwnerNodeResult.status, 1, futureOwnerNodeResult.stdout);
    const futureOwnerNodeOutput = JSON.parse(futureOwnerNodeResult.stdout);
    assert.deepEqual(futureOwnerNodeOutput.failedChecks, ["runtimeLeaseOwnership"]);
    assert.equal(
      `${futureOwnerNodeResult.stdout}\n${futureOwnerNodeResult.stderr}`.includes(
        futureOwnerNode.runtimeStatusAfter.nodes[0].lastHeartbeatAt,
      ),
      false,
    );

    const freshnessBoundary = validEvidence();
    freshnessBoundary.runtimeStatusAfter.nodes[0].lastHeartbeatAt = "2026-07-08T07:00:00.000Z";
    const freshnessBoundaryResult = await runScript([
      `--fixture-json=${JSON.stringify(freshnessBoundary)}`,
    ]);
    assert.equal(
      freshnessBoundaryResult.status,
      0,
      freshnessBoundaryResult.stderr || freshnessBoundaryResult.stdout,
    );

    const unsafeEvidence = validEvidence();
    unsafeEvidence.metricsAfter = {
      ...unsafeEvidence.metricsAfter,
      raw: "docker logs may contain sensitive values",
    };
    const unsafe = await runScript([`--fixture-json=${JSON.stringify(unsafeEvidence)}`]);
    assert.equal(unsafe.status, 1, unsafe.stdout);
    const unsafeOutput = JSON.parse(unsafe.stdout);
    assert.deepEqual(unsafeOutput.failedChecks, ["sanitizedEvidence"]);
    assert.doesNotMatch(unsafe.stdout, /docker logs may contain sensitive values/);

    const localEvidence = validEvidence();
    localEvidence.environment = "local";
    const local = await runScript([`--fixture-json=${JSON.stringify(localEvidence)}`]);
    assert.equal(local.status, 1, local.stdout);
    const localOutput = JSON.parse(local.stdout);
    assert.deepEqual(localOutput.failedChecks, ["drillMetadata"]);

    const outOfOrder = validEvidence();
    outOfOrder.webApiReadyAfter.checkedAt = "2026-07-08T07:00:30.000Z";
    const outOfOrderResult = await runScript([`--fixture-json=${JSON.stringify(outOfOrder)}`]);
    assert.equal(outOfOrderResult.status, 1, outOfOrderResult.stdout);
    const outOfOrderOutput = JSON.parse(outOfOrderResult.stdout);
    assert.deepEqual(outOfOrderOutput.failedChecks, ["evidenceOrder"]);

    const template = await runScript(["--template"]);
    assert.equal(template.status, 0, template.stderr || template.stdout);
    const templateOutput = JSON.parse(template.stdout);
    assert.equal(templateOutput.drillId, "worker-only-drill-YYYYMMDD-HHMM");
    assert.equal(templateOutput.environment, "staging");
    assert.equal(templateOutput.webApiReadyBefore.evidenceType, "web-api-ready");
    assert.equal(templateOutput.replacementStarted.evidenceType, "worker-replacement-started");
    assert.deepEqual(templateOutput.replacementStarted.teamIds, [1]);
    assert.equal(
      templateOutput.runtimeStatusAfter.expectedOwnerNodeId,
      "replacement-worker-node-id",
    );
    assert.equal(templateOutput.metricsAfter.evidenceType, "worker-metrics-publishing");

    const manifest = await runScript(["--dir-manifest"]);
    assert.equal(manifest.status, 0, manifest.stderr || manifest.stdout);
    const manifestOutput = JSON.parse(manifest.stdout);
    assert.equal(manifestOutput["drill-metadata.json"], "drillMetadata");
    assert.equal(manifestOutput["runtime-status-after.json"], "runtimeStatusAfter");
    assert.equal(manifestOutput["web-api-ready-after.json"], "webApiReadyAfter");

    const initializedDir = resolve(tempRoot, "initialized-worker-evidence");
    const initialized = await runScript([`--init-dir=${initializedDir}`]);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const initializedOutput = JSON.parse(initialized.stdout);
    assert.equal(initializedOutput.ok, true);
    const initializedFiles = await readdir(initializedDir);
    assert.deepEqual(initializedFiles.sort(), Object.keys(manifestOutput).sort());

    const initializedMetadata = JSON.parse(
      await readFile(resolve(initializedDir, "drill-metadata.json"), "utf8"),
    );
    assert.equal(initializedMetadata.payload.drillId, "worker-only-drill-YYYYMMDD-HHMM");
    assert.deepEqual(initializedMetadata.releaseBinding, releaseBinding);

    const initializedStatus = await runScript([`--dir-status=${initializedDir}`]);
    assert.equal(initializedStatus.status, 1, initializedStatus.stdout);
    const initializedStatusOutput = JSON.parse(initializedStatus.stdout);
    assert.equal(initializedStatusOutput.ok, false);
    assert.equal(initializedStatusOutput.readyFiles, 0);
    assert.deepEqual(initializedStatusOutput.nextRequiredEvidence, {
      file: "drill-metadata.json",
      key: "drillMetadata",
      reason: "placeholder",
    });
    assert.doesNotMatch(
      initializedStatus.stdout,
      /YYYY-MM-DDTHH:mm:ss\.sssZ|replacement-worker-node-id/,
    );

    const readyDir = await writeEvidenceDir(validEvidence());
    const readyStatus = await runScript([`--dir-status=${readyDir}`]);
    assert.equal(readyStatus.status, 0, readyStatus.stdout);
    const readyStatusOutput = JSON.parse(readyStatus.stdout);
    assert.equal(readyStatusOutput.ok, true);
    assert.equal(readyStatusOutput.readyFiles, readyStatusOutput.totalFiles);
    assert.deepEqual(readyStatusOutput.semanticStatus, {
      ok: true,
      totalChecks: 8,
      passedChecks: 8,
      failedChecks: [],
      nextFailedCheck: null,
    });
    assert.doesNotMatch(readyStatus.stdout, /prod-worker-new-1|prod-worker-old-1/);

    const missingPathMarker = "secret-like-missing-path-marker-7f3d9a";
    const missingEvidencePath = resolve(tempRoot, missingPathMarker, "missing-evidence.json");
    const missingEvidence = await runScript([`--file=${missingEvidencePath}`]);
    assert.equal(missingEvidence.status, 1, missingEvidence.stdout);
    const missingEvidenceOutput = JSON.parse(missingEvidence.stdout);
    assert.equal(missingEvidenceOutput.ok, false);
    assert.equal(missingEvidenceOutput.reason, "worker-evidence-check-failed");
    assert.equal(missingEvidence.stderr, "");
    assert.equal(missingEvidence.stdout.includes(missingEvidencePath), false);
    assert.equal(missingEvidence.stdout.includes(missingPathMarker), false);

    const protectedDir = resolve(tempRoot, "protected-worker-evidence");
    await mkdir(protectedDir, { recursive: true });
    await writeFile(resolve(protectedDir, "operator-note.txt"), "do not overwrite", "utf8");
    const protectedInit = await runScript([`--init-dir=${protectedDir}`]);
    assert.equal(protectedInit.status, 1, protectedInit.stdout);
    const protectedInitOutput = JSON.parse(protectedInit.stdout);
    assert.equal(protectedInitOutput.ok, false);
    assert.equal(protectedInitOutput.reason, "worker-evidence-check-failed");
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
