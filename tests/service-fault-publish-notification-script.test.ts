import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInternalSignature } from "../src/services/internal-auth.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "service-fault-publish-notification.mjs");
const internalPath = "/internal/notification-events";
const sharedSecret = "test-secret-should-not-print";
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
        NOTIFIER_SHARED_SECRET: sharedSecret,
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
  let requestCount = 0;
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
            data: { duplicate: false, outboxId: 123, outboxStatus: "queued" },
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
      NOTIFIER_SHARED_SECRET: "help-secret-should-not-print",
      SPX_NODE_ID: "help-node-should-not-print",
    });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.equal(requestCount, 0);
    assert.match(help.stdout, /service-fault-publish-notification\.mjs/);
    assert.match(help.stdout, /--dry-run/);
    assert.match(help.stdout, /--confirm-send-test-notification/);
    assert.match(help.stdout, /--team-id=<id>/);
    assert.match(help.stdout, /--drill-id=<id>/);
    assert.match(help.stdout, /mutating/i);
    assert.doesNotMatch(
      help.stdout,
      /help-secret-should-not-print|help-node-should-not-print|SPX split-service fault drill test notification|probe-user|probe-pass|query-secret/,
    );

    const missingDrillId = await runScript([`--url=${url}`, "--team-id=2", "--dry-run"]);
    assert.equal(missingDrillId.status, 1, missingDrillId.stdout);
    assert.equal(requestCount, 0);
    const missingDrillIdOutput = JSON.parse(missingDrillId.stdout);
    assert.equal(missingDrillIdOutput.reason, "missing-config");
    assert.deepEqual(missingDrillIdOutput.missingConfig, ["--drill-id"]);

    const noConfirm = await runScript([`--url=${url}`, "--team-id=2", `--drill-id=${drillId}`]);
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
      /^fault_drill:notifier_health:team:2:drill:split-service-fault-drill-20260707-1000:\d+:[0-9a-f-]{8}$/,
    );
    assert.equal(sentOutput.teamId, 2);
    assert.equal(sentOutput.nodeId, nodeId);
    assert.equal(sentOutput.drillId, drillId);
    assert.equal(sentOutput.status, 200);
    assert.equal(sentOutput.duplicate, false);
    assert.equal(sentOutput.outboxId, 123);
    assert.equal(sentOutput.outboxStatus, "queued");

    const timestamp = capturedHeaders["x-spx-timestamp"];
    const signature = capturedHeaders["x-spx-signature"];
    const eventKey = capturedHeaders["idempotency-key"];
    assert.equal(typeof timestamp, "string");
    assert.equal(typeof signature, "string");
    assert.equal(typeof eventKey, "string");
    assert.equal(capturedHeaders["x-spx-node-id"], nodeId);
    assert.equal(capturedHeaders["content-type"], "application/json");
    assert.equal(
      signature as string,
      createInternalSignature({
        body: capturedBody,
        timestamp: timestamp as string,
        nodeId,
        path: internalPath,
        secret: sharedSecret,
        eventKey: eventKey as string,
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

    const failure = await runScript(
      [
        `--url=http://127.0.0.1:${port}/wrong-base`,
        "--team-id=2",
        `--drill-id=${drillId}`,
        "--confirm-send-test-notification",
      ],
      { NOTIFIER_SHARED_SECRET: "another-secret-value" },
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
