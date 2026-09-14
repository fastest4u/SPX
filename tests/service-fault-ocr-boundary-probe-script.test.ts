import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "service-fault-ocr-boundary-probe.mjs");
const fixturePath = resolve(repoRoot, "scripts", "task9-ocr-fixture.png");
const expectedFixtureSha256 = "cdf7dcb00ca85d93e950cba10ac707c6e27c1dca828673512831454fbd53f73c";
const confirmation = "I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER";
const drillId = "split-service-fault-drill-20260710-1409";
const maxOcrTimeoutMs = 600000;

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
        TASK9_EXPECT: "",
        NODE_ENV: "",
        TASK9_DRILL_ID: "",
        TASK9_FIXTURE_SHA256: "",
        TASK9_CONFIRM_SYNTHETIC_OCR: "",
        SPX_ROLE: "",
        SPX_NODE_ID: "",
        OCR_SERVICE_URL: "",
        OCR_SERVICE_REQUEST_TIMEOUT_MS: "",
        OCR_NODE_SECRET: "",
        OCR_NODE_SECRET_FILE: "",
        HTTP_PORT: "",
        NOTIFIER_SHARED_SECRET: "",
        NOTIFIER_SHARED_SECRET_FILE: "",
        DB_HOST: "",
        DB_PORT: "",
        DB_USERNAME: "",
        DB_PASSWORD: "",
        DB_NAME: "",
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
  const fixture = readFileSync(fixturePath);
  assert.equal(createHash("sha256").update(fixture).digest("hex"), expectedFixtureSha256);

  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ secret: "raw-provider-response-must-not-print" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const hostileEnv = {
      TASK9_EXPECT: "invalid",
      TASK9_DRILL_ID: "help-drill-should-not-print",
      TASK9_CONFIRM_SYNTHETIC_OCR: "wrong-confirmation-should-not-print",
      SPX_ROLE: "web-api",
      SPX_NODE_ID: "help-node-should-not-print",
      OCR_SERVICE_URL: `http://127.0.0.1:${port}/provider?token=query-secret`,
      HTTP_PORT: String(port),
      NOTIFIER_SHARED_SECRET: "help-secret-should-not-print",
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      DB_USERNAME: "help-db-user-should-not-print",
      DB_PASSWORD: "help-db-password-should-not-print",
      DB_NAME: "help-db-name-should-not-print",
    };
    const help = await runScript(["--help"], hostileEnv);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.equal(requestCount, 0);
    assert.match(help.stdout, /service-fault-ocr-boundary-probe\.mjs/);
    assert.match(help.stdout, /--dry-run/);
    assert.match(help.stdout, /TASK9_EXPECT=(?:preflight\|down\|up|preflight, down, or up)/);
    assert.match(help.stdout, /TASK9_CONFIRM_SYNTHETIC_OCR/);
    assert.match(help.stdout, /maximum: 600000/);
    assert.match(help.stdout, /synthetic/i);
    assert.match(help.stdout, /mutating|calls the configured OCR provider/i);
    assert.doesNotMatch(
      help.stdout,
      /OCR_NODE_SECRET|NOTIFIER_SHARED_SECRET|help-drill|wrong-confirmation|help-node|query-secret|help-secret|help-db|raw-provider/,
    );

    const baseEnv = {
      NODE_ENV: "production",
      TASK9_EXPECT: "preflight",
      TASK9_DRILL_ID: drillId,
      TASK9_FIXTURE_SHA256: "0".repeat(64),
      TASK9_CONFIRM_SYNTHETIC_OCR: confirmation,
      SPX_ROLE: "line-service",
      SPX_NODE_ID: "prod-line-service-1",
      OCR_SERVICE_URL: "http://ocr-service:3004",
      OCR_SERVICE_REQUEST_TIMEOUT_MS: "305000",
      HTTP_PORT: String(port),
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      DB_USERNAME: "dry-run-db-user-should-not-print",
      DB_PASSWORD: "dry-run-db-password-should-not-print",
      DB_NAME: "dry-run-db-name-should-not-print",
    };

    const missingConfirmation = await runScript(["--dry-run"], {
      ...baseEnv,
      TASK9_CONFIRM_SYNTHETIC_OCR: "",
    });
    assert.equal(missingConfirmation.status, 1, missingConfirmation.stdout);
    assert.equal(requestCount, 0);
    const missingConfirmationOutput = JSON.parse(missingConfirmation.stdout);
    assert.equal(missingConfirmationOutput.failureCode, "probe_config_invalid");
    assert.doesNotMatch(missingConfirmation.stdout, /dry-run-db|raw-provider/);

    for (const invalidNodeEnv of ["", "prodution", " production "]) {
      const invalidEnvironment = await runScript(["--dry-run"], {
        ...baseEnv,
        NODE_ENV: invalidNodeEnv,
        OCR_NODE_SECRET: "",
        NOTIFIER_SHARED_SECRET: "legacy-secret-must-not-authorize-invalid-node-env",
      });
      assert.equal(invalidEnvironment.status, 1, invalidEnvironment.stdout);
      assert.equal(requestCount, 0);
      assert.equal(JSON.parse(invalidEnvironment.stdout).failureCode, "probe_config_invalid");
      assert.doesNotMatch(
        invalidEnvironment.stdout,
        /legacy-secret-must-not-authorize-invalid-node-env/,
      );
    }

    const wrongRoute = await runScript(["--dry-run"], {
      ...baseEnv,
      OCR_SERVICE_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(wrongRoute.status, 1, wrongRoute.stdout);
    assert.equal(requestCount, 0);
    const wrongRouteOutput = JSON.parse(wrongRoute.stdout);
    assert.equal(wrongRouteOutput.failureCode, "probe_input_unavailable");

    const wrongRoutePath = await runScript(["--dry-run"], {
      ...baseEnv,
      OCR_SERVICE_URL: "http://ocr-service:3004/unexpected-base",
    });
    assert.equal(wrongRoutePath.status, 1, wrongRoutePath.stdout);
    assert.equal(requestCount, 0);
    assert.equal(JSON.parse(wrongRoutePath.stdout).failureCode, "probe_input_unavailable");

    const wrongRole = await runScript(["--dry-run"], {
      ...baseEnv,
      SPX_ROLE: "web-api",
    });
    assert.equal(wrongRole.status, 1, wrongRole.stdout);
    assert.equal(requestCount, 0);
    assert.equal(JSON.parse(wrongRole.stdout).failureCode, "probe_config_invalid");

    const missingNode = await runScript(["--dry-run"], {
      ...baseEnv,
      SPX_NODE_ID: "",
    });
    assert.equal(missingNode.status, 1, missingNode.stdout);
    assert.equal(requestCount, 0);
    assert.equal(JSON.parse(missingNode.stdout).failureCode, "probe_config_invalid");

    for (const invalidDrillId of ["-", "<drill-id>", "a".repeat(129)]) {
      const invalidDrill = await runScript(["--dry-run"], {
        ...baseEnv,
        TASK9_DRILL_ID: invalidDrillId,
      });
      assert.equal(invalidDrill.status, 1, invalidDrill.stdout);
      assert.equal(requestCount, 0);
      assert.equal(JSON.parse(invalidDrill.stdout).failureCode, "probe_config_invalid");
    }

    for (const invalidNodeId of ["-", "<line-service-node>", "n".repeat(129)]) {
      const invalidNode = await runScript(["--dry-run"], {
        ...baseEnv,
        SPX_NODE_ID: invalidNodeId,
      });
      assert.equal(invalidNode.status, 1, invalidNode.stdout);
      assert.equal(requestCount, 0);
      assert.equal(JSON.parse(invalidNode.stdout).failureCode, "probe_config_invalid");
    }

    const placeholderDrill = await runScript(["--dry-run"], {
      ...baseEnv,
      TASK9_DRILL_ID: "split-service-fault-drill-YYYYMMDD-HHMM",
    });
    assert.equal(placeholderDrill.status, 1, placeholderDrill.stdout);
    assert.equal(requestCount, 0);
    assert.equal(JSON.parse(placeholderDrill.stdout).failureCode, "probe_config_invalid");

    const invalidTimeout = await runScript(["--dry-run"], {
      ...baseEnv,
      OCR_SERVICE_REQUEST_TIMEOUT_MS: "not-a-timeout",
    });
    assert.equal(invalidTimeout.status, 1, invalidTimeout.stdout);
    assert.equal(requestCount, 0);
    assert.equal(JSON.parse(invalidTimeout.stdout).failureCode, "probe_config_invalid");

    const excessiveTimeout = await runScript(["--dry-run"], {
      ...baseEnv,
      OCR_SERVICE_REQUEST_TIMEOUT_MS: String(maxOcrTimeoutMs + 1),
    });
    assert.equal(excessiveTimeout.status, 1, excessiveTimeout.stdout);
    assert.equal(requestCount, 0);
    assert.equal(JSON.parse(excessiveTimeout.stdout).failureCode, "probe_config_invalid");

    const maximumTimeout = await runScript(["--dry-run"], {
      ...baseEnv,
      OCR_SERVICE_REQUEST_TIMEOUT_MS: String(maxOcrTimeoutMs),
    });
    assert.equal(maximumTimeout.status, 0, maximumTimeout.stdout);
    assert.equal(JSON.parse(maximumTimeout.stdout).timeoutMs, maxOcrTimeoutMs);
    assert.equal(requestCount, 0);

    const dryRun = await runScript(["--dry-run"], baseEnv);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.equal(requestCount, 0);
    const dryRunOutput = JSON.parse(dryRun.stdout);
    assert.equal(dryRunOutput.ok, true);
    assert.equal(dryRunOutput.dryRun, true);
    assert.equal(dryRunOutput.expectation, "preflight");
    assert.equal(dryRunOutput.drillId, drillId);
    assert.equal(dryRunOutput.fixtureSha256, expectedFixtureSha256);
    assert.match(dryRunOutput.correlationId, /^[a-f0-9]{64}$/);
    assert.equal(dryRunOutput.endpoint, "http://ocr-service:3004/internal/ocr/line-image");
    assert.equal(dryRunOutput.nodeId, "prod-line-service-1");
    assert.equal(dryRunOutput.timeoutMs, 305000);
    assert.equal(
      dryRunOutput.requiredConfirmation,
      "TASK9_CONFIRM_SYNTHETIC_OCR=I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER",
    );
    assert.doesNotMatch(dryRun.stdout, /dry-run-db|raw-provider/);
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
