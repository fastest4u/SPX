import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { internalLineController } from "../src/controllers/internal-line-controller.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import { LINE_INTERNAL_SEND_PATH, LINE_INTERNAL_STATUS_PATH } from "../src/services/line-service-contract.js";
import { env, isDisallowedExternalHost, validateExternalSettingUrl } from "../src/config/env.js";
import {
  CodexReauthRequiredError,
  clearCodexDeviceAuth,
  codexDeviceModel,
  completeCodexBrowserAuth,
  getCodexDeviceAuthStatus,
  startCodexBrowserAuth,
} from "../src/services/codex-device-auth.js";
import { reloadSettingsLive, writeSettings } from "../src/services/settings.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

// 1. Critical #1: internalLineController must require x-spx-request-id and enforce replay guard even in legacy shared-secret mode
async function testInternalLineRequiresRequestIdAndEnforcesReplay(): Promise<void> {
  const sendSecret = "legacy-send-secret-test-1234567890";
  const adminSecret = "legacy-admin-secret-test-1234567890";
  const app = Fastify({ logger: false });
  await app.register(internalLineController, {
    prefix: "/internal",
    sharedSecret: sendSecret,
    adminSharedSecret: adminSecret,
    line: {
      isEnabled: () => true,
      getStatus: () => ({ enabled: true, authenticated: true, message: "ok" }),
      sendMessage: async () => ({ ok: true }),
    },
  });

  try {
    const sendBody = JSON.stringify({ targetId: "C123456789", text: "hello" });
    const timestamp = new Date().toISOString();

    // Missing x-spx-request-id on send route -> must be 401
    const missingIdSend = await app.inject({
      method: "POST",
      url: LINE_INTERNAL_SEND_PATH,
      payload: sendBody,
      headers: {
        "content-type": "application/json",
        "x-spx-node-id": "notification-service",
        "x-spx-timestamp": timestamp,
        "x-spx-signature": createInternalSignature({
          body: sendBody,
          timestamp,
          nodeId: "notification-service",
          path: LINE_INTERNAL_SEND_PATH,
          secret: sendSecret,
        }),
      },
    });
    assert.equal(
      missingIdSend.statusCode,
      401,
      "Legacy shared-secret /internal/line/messages must reject requests without x-spx-request-id",
    );

    // Missing x-spx-request-id on admin route -> must be 401
    const statusBody = "{}";
    const missingIdAdmin = await app.inject({
      method: "POST",
      url: LINE_INTERNAL_STATUS_PATH,
      payload: statusBody,
      headers: {
        "content-type": "application/json",
        "x-spx-node-id": "web-api",
        "x-spx-timestamp": timestamp,
        "x-spx-signature": createInternalSignature({
          body: statusBody,
          timestamp,
          nodeId: "web-api",
          path: LINE_INTERNAL_STATUS_PATH,
          secret: adminSecret,
        }),
      },
    });
    assert.equal(
      missingIdAdmin.statusCode,
      401,
      "Legacy shared-secret /internal/line/status must reject requests without x-spx-request-id",
    );

    // Valid signed request with x-spx-request-id succeeds once, then replay returns 409
    const requestId = randomUUID();
    const validHeaders = {
      "content-type": "application/json",
      "x-spx-node-id": "notification-service",
      "x-spx-timestamp": timestamp,
      "x-spx-request-id": requestId,
      "x-spx-signature": createInternalSignature({
        body: sendBody,
        timestamp,
        nodeId: "notification-service",
        path: LINE_INTERNAL_SEND_PATH,
        secret: sendSecret,
        requestId,
      }),
    };
    const first = await app.inject({
      method: "POST",
      url: LINE_INTERNAL_SEND_PATH,
      payload: sendBody,
      headers: validHeaders,
    });
    assert.equal(first.statusCode, 200);

    const replayed = await app.inject({
      method: "POST",
      url: LINE_INTERNAL_SEND_PATH,
      payload: sendBody,
      headers: validHeaders,
    });
    assert.equal(replayed.statusCode, 409, "Replaying the same x-spx-request-id must return 409");
  } finally {
    await app.close();
  }
}

// 2. Important #2: SSRF validator must block hex IPv4-mapped IPv6, trailing-dot localhost., and CGNAT 100.64.0.0/10
function testSsrfValidatorEdgeCases(): void {
  const blockedUrls = [
    "https://[::ffff:127.0.0.1]/webhook",
    "https://[::ffff:169.254.169.254]/latest/meta-data",
    "https://[::ffff:10.0.0.1]/webhook",
    "https://[0:0:0:0:0:ffff:192.168.1.1]/webhook",
    "https://localhost./webhook",
    "https://internal.localhost./webhook",
    "https://metadata.google.internal./computeMetadata/v1",
    "https://100.64.0.1/webhook",
    "https://100.100.100.200/webhook",
  ];
  for (const url of blockedUrls) {
    assert.notEqual(
      validateExternalSettingUrl("DISCORD_WEBHOOK_URL", url, { requireHttpsAndPublicHost: true }),
      null,
      `Expected SSRF validator to block ${url}`,
    );
  }

  assert.equal(
    validateExternalSettingUrl("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/123/token", {
      requireHttpsAndPublicHost: true,
    }),
    null,
  );
  assert.equal(isDisallowedExternalHost("[2606:4700:4700::1111]"), false);
}

// 3. Important #3: SPX_TEST_SKIP_ENV_FILE=1 must skip .env when DB_MODE=memory even if NODE_ENV=development
async function testSkipEnvFileInMemoryDevelopmentMode(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spx-dev-memory-env-"));
  try {
    await writeFile(join(dir, ".env"), "APP_NAME=LEAKED_FROM_DOTENV_FILE\n", "utf8");
    const envModulePath = resolve(process.cwd(), "src/config/env.ts").replace(/\\/g, "/");
    const tsxImport = resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs");
    const script = `import { env } from "file:///${envModulePath}"; console.log(JSON.stringify({ appName: env.APP_NAME }));`;
    const result = spawnSync(
      process.execPath,
      ["--import", `file:///${tsxImport.replace(/\\/g, "/")}`, "--input-type=module", "-e", script],
      {
        cwd: dir,
        env: {
          ...process.env,
          NODE_ENV: "development",
          DB_MODE: "memory",
          SPX_TEST_SKIP_ENV_FILE: "1",
          APP_NAME: "",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, `Subprocess failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim()) as { appName: string };
    assert.notEqual(
      parsed.appName,
      "LEAKED_FROM_DOTENV_FILE",
      "dev:memory (DB_MODE=memory + SPX_TEST_SKIP_ENV_FILE=1) must not load root .env",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 4. Important #4: clearCodexDeviceAuth during an in-flight token refresh must not resurrect codex-device-auth.json
async function testCodexClearDuringRefreshDoesNotResurrectToken(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalAuthPath = process.env.CODEX_DEVICE_AUTH_PATH;
  const dir = await mkdtemp(join(tmpdir(), "spx-codex-clear-race-"));
  const authFile = join(dir, "codex-device-auth.json");

  try {
    process.env.CODEX_DEVICE_AUTH_PATH = authFile;
    const expiredToken = fakeJwt({
      exp: Math.floor((Date.now() - 10_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_race" },
    });
    const freshToken = fakeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_race" },
    });

    await writeFile(
      authFile,
      JSON.stringify({
        accessToken: expiredToken,
        refreshToken: "rt_race_1",
        expiresAt: Date.now() - 10_000,
        accountId: "acct_race",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    let releaseRefresh!: () => void;
    let notifyRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((res) => {
      notifyRefreshStarted = res;
    });
    const refreshGate = new Promise<void>((res) => {
      releaseRefresh = res;
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/oauth/token")) {
        notifyRefreshStarted();
        await refreshGate;
        return new Response(
          JSON.stringify({
            access_token: freshToken,
            refresh_token: "rt_race_2",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const model = codexDeviceModel("gpt-5");
    const pendingCall = model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });

    await refreshStarted;
    await clearCodexDeviceAuth();
    assert.equal(existsSync(authFile), false, "clearCodexDeviceAuth must remove auth file immediately");

    releaseRefresh();
    await assert.rejects(
      pendingCall,
      (err: unknown) => err instanceof CodexReauthRequiredError,
      "In-flight refresh invalidated by clearCodexDeviceAuth must reject with CodexReauthRequiredError",
    );
    assert.equal(
      existsSync(authFile),
      false,
      "Completed stale token refresh must not resurrect codex-device-auth.json after clearCodexDeviceAuth",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAuthPath === undefined) delete process.env.CODEX_DEVICE_AUTH_PATH;
    else process.env.CODEX_DEVICE_AUTH_PATH = originalAuthPath;
    await rm(dir, { recursive: true, force: true });
  }
}

// 5. Important #5 & Minor #7/#8: deploy.yml worker-krtk readiness + rollback topology, useSse CLOSED check, settings write generation
function testDeployReadinessAndRuntimeGuards(): void {
  const root = process.cwd();
  const deployWorkflow = readFileSync(resolve(root, ".github/workflows/deploy.yml"), "utf8");
  assert.match(
    deployWorkflow,
    /wait_legacy_worker_krtk_ready\(\)/,
    "deploy.yml must verify worker-krtk health during legacy primary deploy",
  );
  assert.match(
    deployWorkflow,
    /rollback_runtime\(\)[\s\S]*?ACTIVE_READINESS_TOPOLOGY="\$\{ROLLBACK_TOPOLOGY\}"/,
    "rollback_runtime must switch ACTIVE_READINESS_TOPOLOGY to ROLLBACK_TOPOLOGY",
  );
  assert.match(
    deployWorkflow,
    /compose_up_current\(\)[\s\S]*?docker compose up -d --force-recreate notifier worker-krtk \|\| return 1/,
    "compose_up_current must propagate notifier/worker-krtk failure under if ! compose_up_current",
  );
  assert.match(
    deployWorkflow,
    /rollback_legacy\(\)[\s\S]*?docker compose up -d --force-recreate notifier worker-krtk \|\| return 1/,
    "rollback_legacy must propagate notifier/worker-krtk failure under if ! rollback_runtime",
  );
  assert.match(
    deployWorkflow,
    /wait_current_readiness\(\)[\s\S]*?ACTIVE_READINESS_TOPOLOGY[\s\S]*?wait_legacy_worker_krtk_ready \|\| return 1/,
    "wait_current_readiness must branch on ACTIVE_READINESS_TOPOLOGY and propagate worker-krtk readiness failure",
  );

  const settingsSource = readFileSync(resolve(root, "src/services/settings.ts"), "utf8");
  assert.match(
    settingsSource,
    /settingsWriteGeneration/,
    "settings.ts must fence reloadSettingsLive against concurrent writeSettings mutations",
  );

  const useSseSource = readFileSync(resolve(root, "src/frontend/hooks/useSse.ts"), "utf8");
  assert.match(
    useSseSource,
    /readyState/,
    "useSse recoverIfDisconnected should inspect EventSource.readyState for CLOSED connections",
  );
}

// 6. spx-review P1-1: reloadSettingsLive overlapping in-flight writeSettings must not overwrite new in-memory settings with stale DB read
async function testSettingsLiveReloadDoesNotClobberInFlightWrite(): Promise<void> {
  const keysToSave = [
    "NODE_ENV",
    "SPX_ROLE",
    "DB_MODE",
    "HTTP_ENABLED",
    "SAVE_TO_DB",
    "NOTIFY_ENABLED",
    "LINEJS_TEST_ENABLED",
    "AUTO_ACCEPT_ENABLED",
    "DEBUG",
    "FETCH_DETAILS",
    "REQUEST_TAB_PENDING_CONFIRMATION",
    "API_URL",
    "APP_NAME",
    "REFERER",
    "POLL_INTERVAL_MS",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of keysToSave) {
    savedEnv[k] = process.env[k];
  }

  try {
    process.env.NODE_ENV = "test";
    process.env.SPX_ROLE = "combined";
    process.env.DB_MODE = "memory";
    process.env.HTTP_ENABLED = "false";
    process.env.SAVE_TO_DB = "false";
    process.env.NOTIFY_ENABLED = "false";
    process.env.LINEJS_TEST_ENABLED = "false";
    process.env.AUTO_ACCEPT_ENABLED = "false";
    process.env.DEBUG = "false";
    process.env.FETCH_DETAILS = "false";
    process.env.REQUEST_TAB_PENDING_CONFIRMATION = "true";
    process.env.API_URL = "https://spx.shopee.co.th/api/in-station/general_to/booking/bidding/list";
    process.env.APP_NAME = "spx";
    process.env.REFERER = "https://spx.shopee.co.th/";
    process.env.POLL_INTERVAL_MS = "15000";

    let notifyUpsertStarted!: () => void;
    let releaseUpsert!: () => void;
    const upsertStarted = new Promise<void>((res) => {
      notifyUpsertStarted = res;
    });
    const upsertGate = new Promise<void>((res) => {
      releaseUpsert = res;
    });

    let notifyReloadRead!: () => void;
    let releaseReloadRead!: () => void;
    const reloadReadStarted = new Promise<void>((res) => {
      notifyReloadRead = res;
    });
    const reloadReadGate = new Promise<void>((res) => {
      releaseReloadRead = res;
    });

    const writePromise = writeSettings(
      {
        API_URL: "https://spx.shopee.co.th/api/in-station/general_to/booking/bidding/list",
        APP_NAME: "spx",
        REFERER: "https://spx.shopee.co.th/",
        POLL_INTERVAL_MS: "2500",
      },
      {
        upsertAppSettingsImpl: async () => {
          notifyUpsertStarted();
          await upsertGate;
        },
      },
    );

    await upsertStarted;

    // Background reload starts while writeSettings is still awaiting DB commit, reading stale 15000
    const reloadPromise = reloadSettingsLive({
      getAppSettingsImpl: async () => {
        notifyReloadRead();
        await reloadReadGate;
        return {
          API_URL: "https://spx.shopee.co.th/api/in-station/general_to/booking/bidding/list",
          APP_NAME: "spx",
          REFERER: "https://spx.shopee.co.th/",
          POLL_INTERVAL_MS: "15000",
        };
      },
    });

    // Either reload bails out before reading DB (ideal) or pauses at reloadReadStarted
    const raceOutcome = await Promise.race([
      reloadPromise.then(() => "early_return" as const),
      reloadReadStarted.then(() => "paused_at_read" as const),
    ]);

    releaseUpsert();
    await writePromise;

    if (raceOutcome === "paused_at_read") {
      releaseReloadRead();
      await reloadPromise;
    }

    assert.equal(
      process.env.POLL_INTERVAL_MS,
      "2500",
      "process.env.POLL_INTERVAL_MS must stay at newly written 2500 instead of reverting to stale 15000",
    );
    assert.equal(
      env.POLL_INTERVAL_MS,
      2500,
      "env.POLL_INTERVAL_MS must stay at newly written 2500 instead of reverting to stale 15000",
    );
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// 7. spx-review P2-1 & P3-2: Codex re-login during in-flight invalid_grant refresh must preserve new token, and failed rename cleans up .tmp
async function testCodexReloginDuringStaleRefreshAndTempCleanup(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalAuthPath = process.env.CODEX_DEVICE_AUTH_PATH;
  const dir = await mkdtemp(join(tmpdir(), "spx-codex-relogin-race-"));
  const authFile = join(dir, "codex-device-auth.json");

  try {
    process.env.CODEX_DEVICE_AUTH_PATH = authFile;
    const expiredToken = fakeJwt({
      exp: Math.floor((Date.now() - 10_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_old01" },
    });
    const reloginToken = fakeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_new99" },
    });

    await writeFile(
      authFile,
      JSON.stringify({
        accessToken: expiredToken,
        refreshToken: "rt_dead_old",
        expiresAt: Date.now() - 10_000,
        accountId: "acct_old01",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    let notifyRefreshStarted!: () => void;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((res) => {
      notifyRefreshStarted = res;
    });
    const refreshGate = new Promise<void>((res) => {
      releaseRefresh = res;
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/oauth/token")) {
        const bodyText = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
        if (bodyText.includes("grant_type=refresh_token")) {
          notifyRefreshStarted();
          await refreshGate;
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        if (bodyText.includes("grant_type=authorization_code")) {
          return new Response(
            JSON.stringify({
              access_token: reloginToken,
              refresh_token: "rt_fresh_new",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const model = codexDeviceModel("gpt-5");
    const staleCall = model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "ocr" }] }],
    });

    await refreshStarted;

    // Admin re-authenticates via Browser OAuth without clicking Clear first
    const started = await startCodexBrowserAuth();
    await completeCodexBrowserAuth(
      `http://localhost:1455/auth/callback?code=fresh_auth_code&state=${encodeURIComponent(started.state)}`,
    );

    // Now the stale refresh returns 401 invalid_grant
    releaseRefresh();
    await assert.rejects(staleCall, (err: unknown) => err instanceof CodexReauthRequiredError);

    const statusAfter = await getCodexDeviceAuthStatus();
    assert.equal(
      statusAfter.authenticated,
      true,
      "Stale invalid_grant refresh must not delete newly re-authenticated token file",
    );
    assert.equal(statusAfter.accountIdSuffix, "_new99");

    // P3-2: Verify failed rename in writeStoredToken cleans up .tmp file
    const dirCollisionTarget = join(dir, "collision-dir");
    await mkdir(dirCollisionTarget, { recursive: true });
    process.env.CODEX_DEVICE_AUTH_PATH = dirCollisionTarget;
    const startedCollision = await startCodexBrowserAuth();
    await assert.rejects(
      completeCodexBrowserAuth(
        `http://localhost:1455/auth/callback?code=collision_code&state=${encodeURIComponent(startedCollision.state)}`,
      ),
    );
    const remainingTmp = (await readdir(dir)).filter((entry) => entry.endsWith(".tmp"));
    assert.deepEqual(
      remainingTmp,
      [],
      "writeStoredToken must remove temporary .tmp file when atomic rename fails",
    );
  } finally {
    await clearCodexDeviceAuth().catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalAuthPath === undefined) delete process.env.CODEX_DEVICE_AUTH_PATH;
    else process.env.CODEX_DEVICE_AUTH_PATH = originalAuthPath;
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testInternalLineRequiresRequestIdAndEnforcesReplay();
  testSsrfValidatorEdgeCases();
  await testSkipEnvFileInMemoryDevelopmentMode();
  await testCodexClearDuringRefreshDoesNotResurrectToken();
  testDeployReadinessAndRuntimeGuards();
  await testSettingsLiveReloadDoesNotClobberInFlightWrite();
  await testCodexReloginDuringStaleRefreshAndTempCleanup();
  console.log("task8-review-fixes: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
