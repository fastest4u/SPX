import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "service-fault-check.mjs");

type ScriptResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runScript(args: string[]): Promise<ScriptResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, WEB_API_URL: "" },
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
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok token=plain-secret password=hunter2 Authorization=Bearer abc123");
      return;
    }

    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ready: true,
          token: "json-token",
          nested: {
            password: "json-password",
            message: "credential=inline-secret cookie=session-secret",
          },
          auth: ["Bearer nested-token"],
        }),
      );
      return;
    }

    response.writeHead(404);
    response.end("not found");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    let requestCount = 0;
    server.on("request", () => {
      requestCount += 1;
    });

    const help = await runScript([
      `--web-api-url=http://probe-user:probe-pass@127.0.0.1:${port}?token=query-secret`,
      "--help",
    ]);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.equal(requestCount, 0);
    assert.match(help.stdout, /service-fault-check\.mjs/);
    assert.match(help.stdout, /--require=<services>/);
    assert.match(help.stdout, /--expect-down=<services>/);
    assert.match(help.stdout, /--allow-degraded=<services>/);
    assert.match(help.stdout, /read-only/i);
    assert.doesNotMatch(help.stdout, /probe-user|probe-pass|query-secret/);

    const result = await runScript([
      `--web-api-url=http://probe-user:probe-pass@127.0.0.1:${port}?token=query-secret`,
      "--timeout-ms=1000",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const outputText = result.stdout;
    const output = JSON.parse(outputText);

    assert.equal(output.ok, true);
    assert.deepEqual(output.requiredServices, []);
    assert.deepEqual(output.allowedDownServices, []);
    assert.deepEqual(output.expectedDownServices, []);
    assert.deepEqual(output.unknownServiceNames, []);
    assert.deepEqual(output.missingRequiredServices, []);
    assert.deepEqual(output.missingExpectedDownServices, []);
    assert.deepEqual(output.expectedDownStillReachableServices, []);
    assert.deepEqual(output.unexpectedFailures, []);
    assert.equal(output.services[0].url, `http://127.0.0.1:${port}/`);
    assert.match(output.services[0].health.data.text, /token=\[redacted\]/);
    assert.match(output.services[0].health.data.text, /password=\[redacted\]/);
    assert.match(output.services[0].health.data.text, /Authorization=\[redacted\]/i);
    assert.equal(output.services[0].ready.data.token, "[redacted]");
    assert.equal(output.services[0].ready.data.nested.password, "[redacted]");
    assert.match(output.services[0].ready.data.nested.message, /credential=\[redacted\]/);
    assert.match(output.services[0].ready.data.nested.message, /cookie=\[redacted\]/);
    assert.equal(output.services[0].ready.data.auth[0], "Bearer [redacted]");

    assert.doesNotMatch(outputText, /plain-secret|hunter2|abc123|json-token|json-password/);
    assert.doesNotMatch(
      outputText,
      /inline-secret|session-secret|nested-token|probe-user|probe-pass/,
    );
    assert.doesNotMatch(outputText, /query-secret/);

    const missingRequiredResult = await runScript([
      `--web-api-url=http://127.0.0.1:${port}`,
      "--require=web-api,line-service",
      "--timeout-ms=1000",
    ]);
    assert.equal(missingRequiredResult.status, 1, missingRequiredResult.stdout);
    const missingRequiredOutput = JSON.parse(missingRequiredResult.stdout);
    assert.equal(missingRequiredOutput.ok, false);
    assert.deepEqual(missingRequiredOutput.requiredServices, ["web-api", "line-service"]);
    assert.deepEqual(missingRequiredOutput.allowedDownServices, []);
    assert.deepEqual(missingRequiredOutput.expectedDownServices, []);
    assert.deepEqual(missingRequiredOutput.unknownServiceNames, []);
    assert.deepEqual(missingRequiredOutput.missingRequiredServices, ["line-service"]);
    assert.deepEqual(missingRequiredOutput.missingExpectedDownServices, []);
    assert.deepEqual(missingRequiredOutput.expectedDownStillReachableServices, []);
    assert.deepEqual(missingRequiredOutput.unexpectedFailures, []);
    assert.equal(missingRequiredOutput.services.length, 1);

    const stillReachableResult = await runScript([
      `--web-api-url=http://127.0.0.1:${port}`,
      "--expect-down=web-api",
      "--timeout-ms=1000",
    ]);
    assert.equal(stillReachableResult.status, 1, stillReachableResult.stdout);
    const stillReachableOutput = JSON.parse(stillReachableResult.stdout);
    assert.equal(stillReachableOutput.ok, false);
    assert.deepEqual(stillReachableOutput.expectedDownServices, ["web-api"]);
    assert.deepEqual(stillReachableOutput.unknownServiceNames, []);
    assert.deepEqual(stillReachableOutput.missingExpectedDownServices, []);
    assert.deepEqual(stillReachableOutput.expectedDownStillReachableServices, ["web-api"]);
    assert.deepEqual(stillReachableOutput.unexpectedFailures, []);

    const missingExpectedDownResult = await runScript([
      `--web-api-url=http://127.0.0.1:${port}`,
      "--expect-down=line-service",
      "--timeout-ms=1000",
    ]);
    assert.equal(missingExpectedDownResult.status, 1, missingExpectedDownResult.stdout);
    const missingExpectedDownOutput = JSON.parse(missingExpectedDownResult.stdout);
    assert.equal(missingExpectedDownOutput.ok, false);
    assert.deepEqual(missingExpectedDownOutput.expectedDownServices, ["line-service"]);
    assert.deepEqual(missingExpectedDownOutput.unknownServiceNames, []);
    assert.deepEqual(missingExpectedDownOutput.missingExpectedDownServices, ["line-service"]);
    assert.deepEqual(missingExpectedDownOutput.expectedDownStillReachableServices, []);

    const degradedServer = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
        return;
      }

      if (request.url === "/ready") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ready: false, downstream: { lineService: "down" } }));
        return;
      }

      response.writeHead(404);
      response.end("not found");
    });
    degradedServer.listen(0, "127.0.0.1");
    await once(degradedServer, "listening");
    try {
      const { port: degradedPort } = degradedServer.address() as AddressInfo;
      const degradedResult = await runScript([
        `--web-api-url=http://127.0.0.1:${port}`,
        `--notification-service-url=http://127.0.0.1:${degradedPort}`,
        "--line-service-url=http://127.0.0.1:9",
        "--require=web-api,notification-service,line-service",
        "--expect-down=line-service",
        "--allow-degraded=notification-service",
        "--timeout-ms=1000",
      ]);
      assert.equal(degradedResult.status, 0, degradedResult.stdout);
      const degradedOutput = JSON.parse(degradedResult.stdout);
      assert.equal(degradedOutput.ok, true);
      assert.deepEqual(degradedOutput.allowedDegradedServices, ["notification-service"]);
      assert.deepEqual(degradedOutput.expectedDownServices, ["line-service"]);
      assert.deepEqual(degradedOutput.unexpectedFailures, []);
      const notificationResult = degradedOutput.services.find(
        (service: { name: string }) => service.name === "notification-service",
      );
      assert.equal(notificationResult.health.ok, true);
      assert.equal(notificationResult.ready.ok, false);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        degradedServer.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }

    const nonDegradedResult = await runScript([
      `--web-api-url=http://127.0.0.1:${port}`,
      `--notification-service-url=http://127.0.0.1:${port}`,
      "--require=web-api,notification-service",
      "--allow-degraded=notification-service",
      "--timeout-ms=1000",
    ]);
    assert.equal(nonDegradedResult.status, 1, nonDegradedResult.stdout);
    const nonDegradedOutput = JSON.parse(nonDegradedResult.stdout);
    assert.equal(nonDegradedOutput.ok, false);
    assert.deepEqual(nonDegradedOutput.unexpectedFailures, ["notification-service"]);

    const unknownServiceResult = await runScript([
      `--web-api-url=http://127.0.0.1:${port}`,
      "--require=web-api,line-servcie",
      "--allow-down=ocr-servcie",
      "--allow-degraded=web-apl",
      "--expect-down=notification-servcie",
      "--timeout-ms=1000",
    ]);
    assert.equal(unknownServiceResult.status, 1, unknownServiceResult.stdout);
    const unknownServiceOutput = JSON.parse(unknownServiceResult.stdout);
    assert.equal(unknownServiceOutput.ok, false);
    assert.deepEqual(unknownServiceOutput.unknownServiceNames, [
      "line-servcie",
      "ocr-servcie",
      "web-apl",
      "notification-servcie",
    ]);
    assert.deepEqual(unknownServiceOutput.missingRequiredServices, []);
    assert.deepEqual(unknownServiceOutput.missingExpectedDownServices, []);
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
