import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInternalSignature } from "../src/services/internal-auth.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "service-fault-publish-notification.mjs");
const internalPath = "/internal/notification-events";
const nodeSecret = "test-node-secret-value-should-never-print-1234";
const nodeId = "fault-drill-node";
const drillId = "split-service-fault-drill-20260707-1000";

type ScriptResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runScript(args: string[], env: NodeJS.ProcessEnv = {}): Promise<ScriptResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NOTIFICATION_NODE_SECRET: nodeSecret,
        NOTIFICATION_NODE_SECRET_FILE: "",
        NOTIFIER_SHARED_SECRET: "",
        NOTIFIER_SHARED_SECRET_FILE: "",
        SPX_NODE_ID: nodeId,
        NOTIFICATION_SERVICE_URL: "",
        NOTIFIER_API_URL: "",
        ...env,
      },
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

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "spx-publish-notification-secret-"));
  const secretFilePath = join(temp, "node-signing-value");
  writeFileSync(secretFilePath, `${nodeSecret}\n`, { encoding: "utf8", mode: 0o600 });
  let requestCount = 0;
  let returnDuplicate = false;
  let capturedBody = "";
  let capturedHeaders: Record<string, string | string[] | undefined> = {};

  const server = createServer((request, response) => {
    requestCount += 1;
    capturedHeaders = request.headers;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      capturedBody += chunk;
    });
    request.on("end", () => {
      if (request.url === internalPath) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "success",
            data: { duplicate: returnDuplicate, outboxId: 123, outboxStatus: "queued" },
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "error", message: "wrong path" }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const url = `http://probe-user:probe-pass@127.0.0.1:${port}?token=query-secret`;

    const help = await runScript(["--help"], {
      NOTIFICATION_NODE_SECRET: "help-secret-should-not-print-123456789",
      SPX_NODE_ID: "help-node-should-not-print",
    });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.equal(requestCount, 0);
    assert.match(help.stdout, /service-fault-publish-notification\.mjs/);
    assert.match(help.stdout, /--dry-run/);
    assert.match(help.stdout, /--confirm-send-test-notification/);
    assert.match(help.stdout, /--team-id=<id>/);
    assert.match(help.stdout, /--drill-id=<id>/);
    assert.match(help.stdout, /--step=baseline\|line-down\|ocr-down/);
    assert.match(help.stdout, /idempotentRecovery/);
    assert.match(help.stdout, /NODE_ENV=development\|test\|production/);
    assert.match(help.stdout, /mutating/i);
    assert.doesNotMatch(
      help.stdout,
      /NOTIFICATION_NODE_SECRET|NOTIFIER_SHARED_SECRET|help-secret-should-not-print|help-node-should-not-print|SPX split-service fault drill test notification|probe-user|probe-pass|query-secret/,
    );

    const productionLegacyRejected = await runScript(
      [
        `--url=${url}`,
        "--team-id=2",
        `--drill-id=${drillId}`,
        "--step=baseline",
        "--dry-run",
      ],
      {
        NOTIFICATION_NODE_SECRET: "",
        NOTIFIER_SHARED_SECRET: "legacy-secret-must-not-authorize-production",
      },
    );
    assert.equal(productionLegacyRejected.status, 1, productionLegacyRejected.stdout);
    assert.equal(requestCount, 0);
    assert.deepEqual(JSON.parse(productionLegacyRejected.stdout).missingConfig, [
      "node-signing-credential",
    ]);
    assert.doesNotMatch(
      productionLegacyRejected.stdout,
      /legacy-secret-must-not-authorize-production/,
    );

    const fileBackedDryRun = await runScript(
      [
        `--url=${url}`,
        "--team-id=2",
        `--drill-id=${drillId}`,
        "--step=baseline",
        "--dry-run",
      ],
      {
        NOTIFICATION_NODE_SECRET: "",
        NOTIFICATION_NODE_SECRET_FILE: secretFilePath,
      },
    );
    assert.equal(fileBackedDryRun.status, 0, fileBackedDryRun.stderr || fileBackedDryRun.stdout);
    assert.equal(JSON.parse(fileBackedDryRun.stdout).ok, true);
    assert.equal(fileBackedDryRun.stdout.includes(secretFilePath), false);
    assert.doesNotMatch(fileBackedDryRun.stdout, /test-node-secret-value-should-never-print/);

    const conflictingSecretConfig = await runScript(
      [
        `--url=${url}`,
        "--team-id=2",
        `--drill-id=${drillId}`,
        "--step=baseline",
        "--dry-run",
      ],
      { NOTIFICATION_NODE_SECRET_FILE: secretFilePath },
    );
    assert.equal(conflictingSecretConfig.status, 1, conflictingSecretConfig.stdout);
    assert.equal(JSON.parse(conflictingSecretConfig.stdout).reason, "secret-config-invalid");
    assert.equal(conflictingSecretConfig.stdout.includes(secretFilePath), false);
    assert.doesNotMatch(
      conflictingSecretConfig.stdout,
      /NOTIFICATION_NODE_SECRET|test-node-secret-value-should-never-print/,
    );

    const mismatchedNode = await runScript([
      `--url=${url}`,
      "--team-id=2",
      "--node-id=impersonated-worker-node",
      `--drill-id=${drillId}`,
      "--step=baseline",
      "--dry-run",
    ]);
    assert.equal(mismatchedNode.status, 1, mismatchedNode.stdout);
    assert.equal(requestCount, 0);
    assert.equal(JSON.parse(mismatchedNode.stdout).reason, "node-id-mismatch");
    assert.doesNotMatch(mismatchedNode.stdout, /impersonated-worker-node|test-node-secret/);

    const missingDrillId = await runScript([
      `--url=${url}`,
      "--team-id=2",
      "--step=baseline",
      "--dry-run",
    ]);
    assert.equal(missingDrillId.status, 1, missingDrillId.stdout);
    assert.equal(requestCount, 0);
    const missingDrillIdOutput = JSON.parse(missingDrillId.stdout);
    assert.equal(missingDrillIdOutput.reason, "missing-config");
    assert.deepEqual(missingDrillIdOutput.missingConfig, ["--drill-id"]);

    const missingStep = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${drillId}`,
      "--dry-run",
    ]);
    assert.equal(missingStep.status, 1, missingStep.stdout);
    assert.equal(requestCount, 0);
    assert.deepEqual(JSON.parse(missingStep.stdout).missingConfig, ["--step"]);

    for (const invalidStep of ["outage", "BASELINE", "baseline "]) {
      const invalid = await runScript([
        `--url=${url}`,
        "--team-id=2",
        `--drill-id=${drillId}`,
        `--step=${invalidStep}`,
        "--dry-run",
      ]);
      assert.equal(invalid.status, 1, invalid.stdout);
      assert.equal(requestCount, 0);
      assert.equal(JSON.parse(invalid.stdout).reason, "invalid-input");
    }

    const oversizedDrillId = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${"a".repeat(129)}`,
      "--step=baseline",
      "--dry-run",
    ]);
    assert.equal(oversizedDrillId.status, 1, oversizedDrillId.stdout);
    assert.equal(requestCount, 0);
    assert.equal(JSON.parse(oversizedDrillId.stdout).reason, "invalid-input");

    for (const invalidNodeEnv of ["", "prodution", " production "]) {
      const invalidEnvironment = await runScript(
        [
          `--url=${url}`,
          "--team-id=2",
          `--drill-id=${drillId}`,
          "--step=baseline",
          "--dry-run",
        ],
        {
          NODE_ENV: invalidNodeEnv,
          NOTIFICATION_NODE_SECRET: "",
          NOTIFIER_SHARED_SECRET: "legacy-secret-must-not-authorize-invalid-node-env",
        },
      );
      assert.equal(invalidEnvironment.status, 1, invalidEnvironment.stdout);
      assert.equal(requestCount, 0);
      assert.deepEqual(JSON.parse(invalidEnvironment.stdout).missingConfig, [
        "runtime-environment",
      ]);
      assert.doesNotMatch(
        invalidEnvironment.stdout,
        /legacy-secret-must-not-authorize-invalid-node-env/,
      );
    }

    const noConfirm = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${drillId}`,
      "--step=baseline",
    ]);
    assert.equal(noConfirm.status, 1, noConfirm.stdout);
    assert.equal(requestCount, 0);
    const noConfirmOutput = JSON.parse(noConfirm.stdout);
    assert.equal(noConfirmOutput.reason, "confirmation-required");
    assert.equal(noConfirmOutput.url, `http://127.0.0.1:${port}${internalPath}`);
    assert.equal(noConfirmOutput.drillId, drillId);
    assert.doesNotMatch(
      noConfirm.stdout,
      /test-secret-should-not-print|probe-user|probe-pass|query-secret/,
    );

    const dryRun = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${drillId}`,
      "--step=baseline",
      "--team-name=Staging Drill",
      "--request-timeout-ms=1000",
      "--dry-run",
      "--confirm-send-test-notification",
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.equal(requestCount, 0);
    const dryRunOutput = JSON.parse(dryRun.stdout);
    assert.equal(dryRunOutput.ok, true);
    assert.equal(dryRunOutput.dryRun, true);
    assert.equal(dryRunOutput.url, `http://127.0.0.1:${port}${internalPath}`);
    assert.equal(dryRunOutput.teamId, 2);
    assert.equal(dryRunOutput.nodeId, nodeId);
    assert.equal(dryRunOutput.drillId, drillId);
    assert.equal(dryRunOutput.step, "baseline");
    assert.equal(dryRunOutput.requiredFlag, "--confirm-send-test-notification");
    assert.equal("eventKey" in dryRunOutput, false);
    assert.equal("outboxId" in dryRunOutput, false);
    assert.doesNotMatch(
      dryRun.stdout,
      /test-secret-should-not-print|probe-user|probe-pass|query-secret/,
    );
    assert.doesNotMatch(
      dryRun.stdout,
      /SPX split-service fault drill test notification|Staging Drill/,
    );

    const sent = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${drillId}`,
      "--step=baseline",
      "--team-name=Staging Drill",
      "--request-timeout-ms=1000",
      "--confirm-send-test-notification",
    ]);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    assert.equal(requestCount, 1);
    const sentOutput = JSON.parse(sent.stdout);
    assert.equal(sentOutput.ok, true);
    assert.equal(sentOutput.url, `http://127.0.0.1:${port}${internalPath}`);
    assert.match(
      sentOutput.eventKey,
      /^fault_drill:notifier_health:team:2:drill:split-service-fault-drill-20260707-1000:step:baseline$/,
    );
    assert.equal(sentOutput.teamId, 2);
    assert.equal(sentOutput.nodeId, nodeId);
    assert.equal(sentOutput.drillId, drillId);
    assert.equal(sentOutput.step, "baseline");
    assert.equal(sentOutput.status, 200);
    assert.equal(sentOutput.duplicate, false);
    assert.equal(sentOutput.outboxId, 123);
    assert.equal(sentOutput.outboxStatus, "queued");

    const timestamp = capturedHeaders["x-spx-timestamp"];
    const signature = capturedHeaders["x-spx-signature"];
    const eventKey = capturedHeaders["idempotency-key"];
    const requestId = capturedHeaders["x-spx-request-id"];
    assert.equal(typeof timestamp, "string");
    assert.equal(typeof signature, "string");
    assert.equal(typeof eventKey, "string");
    assert.equal(typeof requestId, "string");
    assert.match(requestId as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(capturedHeaders["x-spx-node-id"], nodeId);
    assert.equal(capturedHeaders["content-type"], "application/json");
    assert.equal(
      signature as string,
      createInternalSignature({
        body: capturedBody,
        timestamp: timestamp as string,
        nodeId,
        path: internalPath,
        secret: nodeSecret,
        nodeEnvironment: "production",
        eventKey: eventKey as string,
        requestId: requestId as string,
      }),
    );
    const payload = JSON.parse(capturedBody);
    assert.equal(payload.eventType, "notifier_health");
    assert.equal(payload.teamId, 2);
    assert.equal(payload.teamName, "Staging Drill");
    assert.equal(payload.evidence.drillId, drillId);

    assert.doesNotMatch(
      sent.stdout,
      /test-secret-should-not-print|probe-user|probe-pass|query-secret/,
    );
    assert.doesNotMatch(
      sent.stdout,
      /SPX split-service fault drill test notification|Staging Drill/,
    );

    returnDuplicate = true;
    capturedBody = "";
    const rerun = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${drillId}`,
      "--step=baseline",
      "--team-name=Staging Drill",
      "--request-timeout-ms=1000",
      "--confirm-send-test-notification",
    ]);
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.equal(requestCount, 2);
    const rerunOutput = JSON.parse(rerun.stdout);
    assert.equal(rerunOutput.ok, true);
    assert.equal(rerunOutput.eventKey, sentOutput.eventKey);
    assert.equal(rerunOutput.duplicate, true);
    assert.equal(rerunOutput.idempotentRecovery, true);
    assert.equal(rerunOutput.outboxId, 123);
    assert.notEqual(capturedHeaders["x-spx-request-id"], requestId);

    returnDuplicate = false;
    capturedBody = "";
    const lineDown = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${drillId}`,
      "--step=line-down",
      "--confirm-send-test-notification",
    ]);
    assert.equal(lineDown.status, 0, lineDown.stderr || lineDown.stdout);
    assert.equal(requestCount, 3);
    const lineDownOutput = JSON.parse(lineDown.stdout);
    assert.equal(
      lineDownOutput.eventKey,
      `fault_drill:notifier_health:team:2:drill:${drillId}:step:line-down`,
    );
    assert.notEqual(lineDownOutput.eventKey, sentOutput.eventKey);
    assert.equal(lineDownOutput.step, "line-down");

    const ocrDown = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${drillId}`,
      "--step=ocr-down",
      "--confirm-send-test-notification",
    ]);
    assert.equal(ocrDown.status, 0, ocrDown.stderr || ocrDown.stdout);
    assert.equal(requestCount, 4);
    const ocrDownOutput = JSON.parse(ocrDown.stdout);
    assert.equal(
      ocrDownOutput.eventKey,
      `fault_drill:notifier_health:team:2:drill:${drillId}:step:ocr-down`,
    );
    assert.notEqual(ocrDownOutput.eventKey, sentOutput.eventKey);
    assert.notEqual(ocrDownOutput.eventKey, lineDownOutput.eventKey);
    assert.equal(ocrDownOutput.step, "ocr-down");
    assert.equal(ocrDownOutput.duplicate, false);
    assert.equal(ocrDownOutput.idempotentRecovery, false);

    returnDuplicate = true;
    const ocrDownRerun = await runScript([
      `--url=${url}`,
      "--team-id=2",
      `--drill-id=${drillId}`,
      "--step=ocr-down",
      "--confirm-send-test-notification",
    ]);
    assert.equal(ocrDownRerun.status, 0, ocrDownRerun.stderr || ocrDownRerun.stdout);
    assert.equal(requestCount, 5);
    const ocrDownRerunOutput = JSON.parse(ocrDownRerun.stdout);
    assert.equal(ocrDownRerunOutput.eventKey, ocrDownOutput.eventKey);
    assert.equal(ocrDownRerunOutput.duplicate, true);
    assert.equal(ocrDownRerunOutput.idempotentRecovery, true);
    assert.equal(ocrDownRerunOutput.outboxId, ocrDownOutput.outboxId);
    returnDuplicate = false;

    const failure = await runScript(
      [
        `--url=http://127.0.0.1:${port}/wrong-base`,
        "--team-id=2",
        `--drill-id=${drillId}`,
        "--step=baseline",
        "--confirm-send-test-notification",
      ],
      { NOTIFICATION_NODE_SECRET: "another-node-secret-value-at-least-32-chars" },
    );
    assert.equal(failure.status, 1, failure.stdout);
    assert.doesNotMatch(failure.stdout, /another-secret-value|wrong path/);

    const missingOutboxServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", data: { duplicate: false } }));
    });
    missingOutboxServer.listen(0, "127.0.0.1");
    await once(missingOutboxServer, "listening");
    try {
      const { port: missingOutboxPort } = missingOutboxServer.address() as AddressInfo;
      const incompleteSuccess = await runScript([
        `--url=http://127.0.0.1:${missingOutboxPort}`,
        "--team-id=2",
        `--drill-id=${drillId}`,
        "--step=baseline",
        "--confirm-send-test-notification",
      ]);
      assert.equal(incompleteSuccess.status, 1, incompleteSuccess.stdout);
      const incompleteSuccessOutput = JSON.parse(incompleteSuccess.stdout);
      assert.equal(incompleteSuccessOutput.ok, false);
      assert.equal(incompleteSuccessOutput.status, 200);
      assert.equal(incompleteSuccessOutput.duplicate, false);
      assert.equal("outboxId" in incompleteSuccessOutput, false);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        missingOutboxServer.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
