import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "service-worker-runtime-status-check.mjs");
const authCookie = "admin_session=fake-runtime-smoke-cookie";
const responseSecret = "eyJhbGciOiJIUzI1NiJ9.fixture-only.signature";

type ScriptResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type FixtureRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
};

type HttpFixture = {
  server: Server;
  url: string;
  requests: FixtureRequest[];
};

const runtimeEnvKeys = [
  "SERVICE_WORKER_RUNTIME_AUTH_COOKIE",
  "SERVICE_WORKER_RUNTIME_STATUS_URL",
  "SERVICE_WORKER_RUNTIME_EXPECTED_TEAM_IDS",
  "SERVICE_WORKER_RUNTIME_EXPECTED_OWNER_NODE_ID",
  "SERVICE_WORKER_RUNTIME_EXPECTED_INACTIVE_NODE_ID",
  "SERVICE_WORKER_RUNTIME_TIMEOUT_MS",
];

function runScript(
  args: string[],
  envOverrides: Record<string, string> = {},
  nodeArguments: string[] = [],
): Promise<ScriptResult> {
  const env = { ...process.env };
  for (const key of runtimeEnvKeys) delete env[key];
  Object.assign(env, envOverrides);

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [...nodeArguments, scriptPath, ...args], {
      cwd: repoRoot,
      env,
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

function workerLeaseResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    data: {
      nodes: [
        {
          nodeId: "worker-old",
          role: "worker",
          lastHeartbeatAt: "2029-12-31T23:58:00.000Z",
          heartbeat: { state: "degraded", ageMs: 120_000, staleAfterMs: 120_000 },
        },
        { nodeId: responseSecret, lastError: responseSecret },
      ],
      leases: [
        { teamId: 1, ownerNodeId: "worker-new" },
        { teamId: 2, ownerNodeId: "worker-new" },
      ],
      readModels: {
        workerLeases: {
          generatedAt: "2030-01-01T00:00:00.000Z",
          teams: [
            {
              teamId: 2,
              desiredState: responseSecret,
              lease: {
                ownerNodeId: "worker-new",
                ownerRole: "worker",
                active: true,
                state: "active",
                status: responseSecret,
                heartbeatAt: "2029-12-31T23:59:59.000Z",
                leaseExpiresAt: "2030-01-01T00:00:30.000Z",
                error: { present: true, class: responseSecret },
              },
              node: {
                nodeId: "worker-new",
                role: "worker",
                hostname: `host-${responseSecret}`,
                version: responseSecret,
                lastHeartbeatAt: "2029-12-31T23:59:59.000Z",
                stale: false,
              },
            },
            {
              teamId: 99,
              lease: {
                ownerNodeId: responseSecret,
                ownerRole: "worker",
                active: true,
                heartbeatAt: "2029-12-31T23:59:59.000Z",
                leaseExpiresAt: "2030-01-01T00:00:30.000Z",
                error: { present: true, class: responseSecret },
              },
              node: {
                nodeId: responseSecret,
                role: "worker",
                hostname: responseSecret,
                version: responseSecret,
                lastHeartbeatAt: "2029-12-31T23:59:59.000Z",
                stale: false,
              },
            },
            {
              teamId: 1,
              lease: {
                ownerNodeId: "worker-new",
                ownerRole: "worker",
                active: true,
                heartbeatAt: "2029-12-31T23:59:58.000Z",
                leaseExpiresAt: "2030-01-01T00:00:30.000Z",
                error: { present: false, class: null },
              },
              node: {
                nodeId: "worker-new",
                role: "worker",
                hostname: `other-${responseSecret}`,
                version: responseSecret,
                lastHeartbeatAt: "2029-12-31T23:59:59.000Z",
                stale: false,
              },
            },
          ],
          ...overrides,
        },
        deployVersion: { version: responseSecret, hostname: responseSecret },
        notificationQueue: { lastError: responseSecret },
      },
      error: responseSecret,
    },
  };
}

async function startFixture(body: unknown, statusCode = 200): Promise<HttpFixture> {
  const requests: FixtureRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    url: `http://127.0.0.1:${address.port}/api/runtime/status`,
    requests,
  };
}

async function closeFixture(fixture: HttpFixture): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    fixture.server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function cliArgs(url: string): string[] {
  return [
    `--url=${url}`,
    "--expected-team-ids=1,2",
    "--expected-owner-node-id=worker-new",
    "--timeout-ms=2000",
  ];
}

function assertSafeFailure(
  result: ScriptResult,
  reason: string,
  forbiddenValues: string[] = [],
): void {
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), reason);
  for (const value of [authCookie, responseSecret, ...forbiddenValues]) {
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(value), false);
  }
}

async function main() {
  const successFixture = await startFixture(workerLeaseResponse());
  try {
    const help = await runScript(["--help", ...cliArgs(successFixture.url)], {
      SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
    });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /service-worker-runtime-status-check\.mjs/);
    assert.match(help.stdout, /SERVICE_WORKER_RUNTIME_AUTH_COOKIE/);
    assert.doesNotMatch(help.stdout, /--cookie|--auth-cookie/);
    assert.equal(help.stderr, "");
    assert.equal(successFixture.requests.length, 0);

    const success = await runScript(cliArgs(successFixture.url), {
      SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
    });
    assert.equal(success.status, 0, success.stderr || success.stdout);
    assert.equal(success.stderr, "");
    assert.equal(successFixture.requests.length, 1);
    assert.equal(successFixture.requests[0].method, "GET");
    assert.equal(successFixture.requests[0].url, "/api/runtime/status");
    assert.equal(successFixture.requests[0].headers.cookie, authCookie);
    assert.equal(successFixture.requests[0].headers.authorization, undefined);
    assert.deepEqual(JSON.parse(success.stdout), {
      ok: true,
      checkedAt: "2030-01-01T00:00:00.000Z",
      expectedTeamIds: [1, 2],
      expectedOwnerNodeId: "worker-new",
      leases: [
        {
          teamId: 1,
          ownerNodeId: "worker-new",
          ownerRole: "worker",
          active: true,
          heartbeatAt: "2029-12-31T23:59:58.000Z",
          leaseExpiresAt: "2030-01-01T00:00:30.000Z",
        },
        {
          teamId: 2,
          ownerNodeId: "worker-new",
          ownerRole: "worker",
          active: true,
          heartbeatAt: "2029-12-31T23:59:59.000Z",
          leaseExpiresAt: "2030-01-01T00:00:30.000Z",
        },
      ],
      nodes: [
        {
          nodeId: "worker-new",
          role: "worker",
          lastHeartbeatAt: "2029-12-31T23:59:59.000Z",
        },
      ],
    });
    assert.equal(success.stdout.includes(authCookie), false);
    assert.equal(success.stdout.includes(responseSecret), false);

    const envConfigured = await runScript([], {
      SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
      SERVICE_WORKER_RUNTIME_STATUS_URL: successFixture.url,
      SERVICE_WORKER_RUNTIME_EXPECTED_TEAM_IDS: "1,2",
      SERVICE_WORKER_RUNTIME_EXPECTED_OWNER_NODE_ID: "worker-new",
      SERVICE_WORKER_RUNTIME_TIMEOUT_MS: "2000",
    });
    assert.equal(envConfigured.status, 0, envConfigured.stderr || envConfigured.stdout);
    assert.equal(successFixture.requests.length, 2);

    const missingAuth = await runScript(cliArgs(successFixture.url));
    assertSafeFailure(missingAuth, "SERVICE_WORKER_RUNTIME_STATUS_AUTH_REQUIRED");
    assert.equal(successFixture.requests.length, 2);

    const malformedArgs = [
      cliArgs(successFixture.url).map((arg) =>
        arg.startsWith("--expected-team-ids=") ? "--expected-team-ids=1,1" : arg,
      ),
      cliArgs(successFixture.url).map((arg) =>
        arg.startsWith("--expected-team-ids=") ? "--expected-team-ids=0,2" : arg,
      ),
      cliArgs(successFixture.url).map((arg) =>
        arg.startsWith("--expected-owner-node-id=")
          ? "--expected-owner-node-id=replacement-worker-node-id"
          : arg,
      ),
      cliArgs(successFixture.url).map((arg) =>
        arg.startsWith("--timeout-ms=") ? "--timeout-ms=0" : arg,
      ),
      cliArgs(successFixture.url).map((arg) =>
        arg.startsWith("--timeout-ms=") ? "--timeout-ms=30001" : arg,
      ),
      [...cliArgs(successFixture.url), "--cookie=cli-cookie-must-not-be-accepted"],
    ];
    for (const args of malformedArgs) {
      const malformed = await runScript(args, {
        SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
      });
      assertSafeFailure(malformed, "SERVICE_WORKER_RUNTIME_STATUS_CONFIG_INVALID", [
        "cli-cookie-must-not-be-accepted",
      ]);
    }
    assert.equal(successFixture.requests.length, 2);

    const inactiveOwner = await runScript(
      [...cliArgs(successFixture.url), "--expected-inactive-node-id=worker-old"],
      { SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie },
    );
    assert.equal(inactiveOwner.status, 0, inactiveOwner.stderr || inactiveOwner.stdout);
    assert.deepEqual(JSON.parse(inactiveOwner.stdout).inactiveOwner, {
      nodeId: "worker-old",
      activeLeaseCount: 0,
      heartbeatState: "degraded",
    });
  } finally {
    await closeFixture(successFixture);
  }

  const priorStillActiveResponse = workerLeaseResponse();
  priorStillActiveResponse.data.leases.push({ teamId: 2, ownerNodeId: "worker-old" });
  const priorStillActiveFixture = await startFixture(priorStillActiveResponse);
  try {
    const priorStillActive = await runScript(
      [...cliArgs(priorStillActiveFixture.url), "--expected-inactive-node-id=worker-old"],
      { SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie },
    );
    assertSafeFailure(
      priorStillActive,
      "SERVICE_WORKER_RUNTIME_STATUS_VALIDATION_FAILED",
      ["worker-old"],
    );
  } finally {
    await closeFixture(priorStillActiveFixture);
  }

  const unauthorizedFixture = await startFixture(
    { error: responseSecret, cookie: authCookie },
    401,
  );
  try {
    const unauthorized = await runScript(cliArgs(unauthorizedFixture.url), {
      SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
    });
    assertSafeFailure(unauthorized, "SERVICE_WORKER_RUNTIME_STATUS_AUTH_FAILED");
  } finally {
    await closeFixture(unauthorizedFixture);
  }

  const httpFailureFixture = await startFixture(
    { error: responseSecret, url: `https://user:${responseSecret}@example.invalid/private` },
    500,
  );
  try {
    const httpFailure = await runScript(cliArgs(httpFailureFixture.url), {
      SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
    });
    assertSafeFailure(httpFailure, "SERVICE_WORKER_RUNTIME_STATUS_HTTP_FAILED");
  } finally {
    await closeFixture(httpFailureFixture);
  }

  const schemaFixture = await startFixture({
    data: {
      readModels: {
        workerLeases: { generatedAt: responseSecret, teams: responseSecret },
      },
      rawError: responseSecret,
    },
  });
  try {
    const schemaFailure = await runScript(cliArgs(schemaFixture.url), {
      SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
    });
    assertSafeFailure(schemaFailure, "SERVICE_WORKER_RUNTIME_STATUS_SCHEMA_INVALID");
  } finally {
    await closeFixture(schemaFixture);
  }

  const wrongOwnerResponse = workerLeaseResponse();
  const wrongOwnerReadModel = wrongOwnerResponse.data.readModels.workerLeases;
  wrongOwnerReadModel.teams[2].lease.ownerNodeId = "wrong-owner-secret-id";
  const wrongOwnerFixture = await startFixture(wrongOwnerResponse);
  try {
    const wrongOwner = await runScript(cliArgs(wrongOwnerFixture.url), {
      SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
    });
    assertSafeFailure(wrongOwner, "SERVICE_WORKER_RUNTIME_STATUS_VALIDATION_FAILED", [
      "wrong-owner-secret-id",
      "worker-new",
    ]);
  } finally {
    await closeFixture(wrongOwnerFixture);
  }

  const staleResponse = workerLeaseResponse();
  staleResponse.data.readModels.workerLeases.teams[0].node.stale = true;
  const staleFixture = await startFixture(staleResponse);
  try {
    const stale = await runScript(cliArgs(staleFixture.url), {
      SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie,
    });
    assertSafeFailure(stale, "SERVICE_WORKER_RUNTIME_STATUS_VALIDATION_FAILED", [
      "worker-new",
    ]);
  } finally {
    await closeFixture(staleFixture);
  }

  const credentialUrl = "http://url-user:url-password@example.invalid/api/runtime/status";
  const credentialUrlFailure = await runScript(
    cliArgs(credentialUrl),
    { SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie },
  );
  assertSafeFailure(
    credentialUrlFailure,
    "SERVICE_WORKER_RUNTIME_STATUS_CONFIG_INVALID",
    ["url-user", "url-password", credentialUrl],
  );

  const fetchGuardMarker = "TEST_FETCH_GUARD_MUST_NOT_RUN";
  const fetchGuardImport = `data:text/javascript;base64,${Buffer.from(
    `globalThis.fetch = async () => { console.error("${fetchGuardMarker}"); throw new Error("guarded fetch"); };`,
  ).toString("base64")}`;
  const insecureRemoteUrls = [
    "http://example.invalid/api/runtime/status",
    "http://192.0.2.10/api/runtime/status",
    "http://localhost.example/api/runtime/status",
  ];
  for (const insecureRemoteUrl of insecureRemoteUrls) {
    const insecureRemote = await runScript(
      cliArgs(insecureRemoteUrl),
      { SERVICE_WORKER_RUNTIME_AUTH_COOKIE: authCookie },
      ["--import", fetchGuardImport],
    );
    assertSafeFailure(insecureRemote, "SERVICE_WORKER_RUNTIME_STATUS_CONFIG_INVALID", [
      new URL(insecureRemoteUrl).hostname,
      insecureRemoteUrl,
    ]);
    assert.equal(
      `${insecureRemote.stdout}\n${insecureRemote.stderr}`.includes(fetchGuardMarker),
      false,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
