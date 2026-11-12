import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, type ApiClientCredentials } from "../src/services/api-client.js";
import {
  acceptAndNotifyMatchedRules,
  claimAutoAcceptRequest,
  releaseAutoAcceptRequest,
} from "../src/services/notifier.js";
import type { NotifyRule } from "../src/services/notify-rules.js";
import { TeamCredentialPool } from "../src/services/team-credential-pool.js";
import { ProviderAuthError } from "../src/services/provider-auth/client.js";
import { NotificationSpool } from "../src/services/notification-spool.js";
import { codexDeviceModel, hasCodexDeviceAuth } from "../src/services/codex-device-auth.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeJwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
}

async function testMultiTeamClaimIsolationAndSetCapacity(): Promise<void> {
  const rule: NotifyRule = {
    id: "rule-shared-shape",
    name: "Rule A",
    enabled: true,
    auto_accept: true,
    accept_all: false,
    need: 5,
    origins: ["A"],
    destinations: ["B"],
    vehicle_types: ["4W"],
  };

  const trip = {
    booking_id: 99100,
    request_id: 77100,
    origin: "A",
    destination: "B",
    vehicle_type: "4W",
  };

  const makeSlowClient = (acceptedCalls: number[]) =>
    ({
      acceptBookingRequests: async (_bookingId: number, requestIds: number[]) => {
        acceptedCalls.push(...requestIds);
        await sleep(40);
        return { ok: false, httpStatus: 500, response: null, error: "upstream error" };
      },
      fetchBookingRequestList: async () => null,
    }) as unknown as ApiClient;

  const team1Calls: number[] = [];
  const team2Calls: number[] = [];
  await Promise.all([
    acceptAndNotifyMatchedRules([trip], makeSlowClient(team1Calls), {
      teamId: 1,
      autoAcceptRules: [rule],
    }),
    acceptAndNotifyMatchedRules([trip], makeSlowClient(team2Calls), {
      teamId: 2,
      autoAcceptRules: [rule],
    }),
  ]);

  assert.deepEqual(team1Calls, [77100], "Team 1 must attempt accept");
  assert.deepEqual(team2Calls, [77100], "Team 2 must not be blocked by Team 1 in-flight claim");

  // Verify Set insertion-order eviction does not evict an active in-flight claim when >5000 claims are released
  assert.equal(claimAutoAcceptRequest(88888, 999999, 1), true);
  for (let i = 1; i <= 5_050; i += 1) {
    assert.equal(claimAutoAcceptRequest(88888, i, 1), true);
    releaseAutoAcceptRequest(88888, i, 1);
  }
  assert.equal(
    claimAutoAcceptRequest(88888, 999999, 1),
    false,
    "Active in-flight claim must remain protected even after >5000 released claims",
  );
  releaseAutoAcceptRequest(88888, 999999, 1);
}

async function testApiClientConcurrentCredentialsAndAsyncVerificationScope(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    const accounts: ApiClientCredentials[] = [
      { spxCookie: "cookie-101", spxDeviceId: "dev-101", accountId: 101, accountName: "Acc101" },
      { spxCookie: "cookie-102", spxDeviceId: "dev-102", accountId: 102, accountName: "Acc102" },
    ];
    let idx = 0;
    const rateLimited: number[] = [];
    const expired: number[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const cookie = headers.get("cookie");
      if (cookie === "cookie-101") {
        // Delay Acc101 so Acc102 has already rotated into client.lastUsedCredentials!
        await sleep(40);
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "2" },
        });
      }
      await sleep(5);
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const client = new ApiClient({
      credentialsProvider: () => accounts[idx++ % accounts.length]!,
      onRateLimit: (accountId) => {
        if (accountId !== undefined) rateLimited.push(accountId);
      },
      onSessionExpired: (accountId) => {
        if (accountId !== undefined) expired.push(accountId);
      },
    });

    // Run with 0 retries on acceptBookingRequests so we don't wait for read retries
    await Promise.all([
      client.acceptBookingRequests(1001, [1]),
      client.acceptBookingRequests(1002, [2]),
    ]);

    assert.deepEqual(rateLimited, [101], "429 on Acc101 must attribute rate limit to Acc101 even after Acc102 dispatched");
    assert.deepEqual(expired, [102], "HTTP 401 on Acc102 must trigger onSessionExpired for Acc102");

    // Verify async withVerificationPriority preserves guard & onReadStarted across await
    let guardCalls = 0;
    let startedCalls = 0;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          retcode: 0,
          message: "ok",
          data: { pageno: 1, count: 0, total: 0, request_list: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await client.withVerificationPriority(
      async () => {
        await sleep(25);
        await client.fetchBookingRequestList(555);
      },
      () => {
        guardCalls += 1;
        return true;
      },
      () => {
        startedCalls += 1;
      },
    );

    assert.equal(guardCalls, 1, "admissionGuard must stay active across async await boundaries");
    assert.equal(startedCalls, 1, "onReadStarted must stay active across async await boundaries");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCredentialPoolRecoveryCooldown(): Promise<void> {
  let now = 10_000;
  let loginAttempts = 0;
  const pool = new TeamCredentialPool({
    teamId: 1,
    clock: () => now,
    loadAccounts: async () => [
      {
        id: 201,
        teamId: 1,
        name: "CaptchaAccount",
        spxEmail: "captcha@example.com",
        spxPassword: "secret",
        spxCookie: "old-cookie",
        spxDeviceId: "dev-201",
        spxAppName: null,
        spxReferer: null,
        spxAuthStatus: "connected",
        spxAuthError: null,
        spxSessionExpiresAt: new Date(now + 60_000).toISOString(),
        spxLastLoginAt: null,
        enabled: true,
      },
    ],
    loginProvider: async () => {
      loginAttempts += 1;
      throw new ProviderAuthError("captcha_required", "CAPTCHA challenge");
    },
    updateAccountSession: async () => true,
  });

  await pool.init();
  await sleep(20);
  assert.equal(loginAttempts, 1, "Initial proactive refresh triggers once");

  // Simulate 30s and 60s poll reloads — must NOT hammer loginProvider while in cooldown!
  now += 30_000;
  pool.checkProactiveRefresh();
  await sleep(20);
  now += 30_000;
  pool.checkProactiveRefresh();
  await sleep(20);
  assert.equal(loginAttempts, 1, "Failed recovery must enforce cooldown instead of retrying every 30s");

  // Advance past 5-minute cooldown
  now += 5 * 60_000;
  pool.checkProactiveRefresh();
  await sleep(20);
  assert.equal(loginAttempts, 2, "Proactive refresh may retry after cooldown expires");
}

async function testCodexSingleFlightRefresh(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalAuthPath = process.env.CODEX_DEVICE_AUTH_PATH;
  const dir = await mkdtemp(join(tmpdir(), "spx-codex-singleflight-"));
  const authFile = join(dir, "codex-device-auth.json");

  try {
    process.env.CODEX_DEVICE_AUTH_PATH = authFile;
    const expiredToken = fakeJwt({
      exp: Math.floor((Date.now() - 10_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_sf" },
    });
    const freshToken = fakeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_sf" },
    });

    await writeFile(
      authFile,
      JSON.stringify({
        accessToken: expiredToken,
        refreshToken: "rt_initial_one_time",
        expiresAt: Date.now() - 10_000,
        accountId: "acct_sf",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    let refreshCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/oauth/token")) {
        refreshCalls += 1;
        const params = new URLSearchParams(String(init?.body ?? ""));
        if (refreshCalls > 1 || params.get("refresh_token") !== "rt_initial_one_time") {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
        }
        await sleep(40);
        return new Response(
          JSON.stringify({
            access_token: freshToken,
            refresh_token: "rt_rotated_2",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            model: "gpt-5",
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const model = codexDeviceModel("gpt-5");
    const callModel = () =>
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      });

    await Promise.all([callModel(), callModel(), callModel()]);
    assert.equal(refreshCalls, 1, "Concurrent expired-token calls must share a single OAuth refresh");
    assert.equal(await hasCodexDeviceAuth(), true, "Auth file must remain intact after single-flight refresh");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAuthPath === undefined) delete process.env.CODEX_DEVICE_AUTH_PATH;
    else process.env.CODEX_DEVICE_AUTH_PATH = originalAuthPath;
    await rm(dir, { recursive: true, force: true });
  }
}

async function testNotificationSpoolBackoffAndCorruptJsonl(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spx-spool-resilience-"));
  const filePath = join(dir, "spool.jsonl");
  try {
    const spool = new NotificationSpool(filePath, { baseDelayMs: 1_000, maxAttempts: 5 });
    const baseNow = 1_700_000_000_000;
    const validEntry = {
      eventKey: "ev:1",
      url: "https://notify.example/internal/notification-events",
      headers: { "content-type": "application/json" },
      body: "{}",
      retryCount: 0,
      firstFailedAt: new Date(baseNow).toISOString(),
      nextRetryAt: new Date(baseNow).toISOString(),
    };

    await writeFile(filePath, `{corrupt-json-line\n${JSON.stringify(validEntry)}\n`, "utf8");
    const loaded = await spool.readAll();
    assert.equal(loaded.length, 1, "Corrupt JSONL line must be skipped instead of wedging spool");

    // Attempt 1 failure -> +1000ms (1x baseDelayMs)
    await spool.flush(async () => false, new Date(baseNow));
    const after1 = (await spool.readAll())[0]!;
    assert.equal(Date.parse(after1.nextRetryAt) - baseNow, 1_000);

    // Attempt 2 failure -> +2000ms (2x baseDelayMs)
    const t2 = baseNow + 1_500;
    await spool.flush(async () => false, new Date(t2));
    const after2 = (await spool.readAll())[0]!;
    assert.equal(Date.parse(after2.nextRetryAt) - t2, 2_000);

    // Attempt 3 failure -> +4000ms (4x baseDelayMs)
    const t3 = t2 + 2_500;
    await spool.flush(async () => false, new Date(t3));
    const after3 = (await spool.readAll())[0]!;
    assert.equal(Date.parse(after3.nextRetryAt) - t3, 4_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSettingsLiveReloadDefaults(): Promise<void> {
  const { closePool } = await import("../src/db/client.js");
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { upsertAppSettings } = await import("../src/repositories/app-settings-repository.js");
  const { env } = await import("../src/config/env.js");
  const settings = await import("../src/services/settings.js");

  await closePool();
  resetMemoryDb();
  delete process.env.LINE_SERVICE_REQUEST_TIMEOUT_MS;
  delete process.env.BOOKING_REPROCESS_COOLDOWN_MS;
  delete process.env.BIDDING_VEHICLE_TYPE;

  await upsertAppSettings({
    API_URL: "https://spx.example.test/booking/bidding/list",
    APP_NAME: "SPX Test",
    REFERER: "https://spx.example.test/",
  });
  await settings.loadDbSettingsIntoEnv();

  assert.equal(env.LINE_SERVICE_REQUEST_TIMEOUT_MS, 5000, "LINE_SERVICE_REQUEST_TIMEOUT_MS default must remain 5000ms");
  assert.equal(env.BOOKING_REPROCESS_COOLDOWN_MS, 10000, "BOOKING_REPROCESS_COOLDOWN_MS default must remain 10000ms");
  assert.equal(env.BIDDING_VEHICLE_TYPE, 13, "BIDDING_VEHICLE_TYPE default must remain 13 when unset");

  await upsertAppSettings({ BIDDING_VEHICLE_TYPE: "" });
  await settings.loadDbSettingsIntoEnv();
  assert.equal(env.BIDDING_VEHICLE_TYPE, undefined, "Explicit empty BIDDING_VEHICLE_TYPE must disable vehicle filter");
}

async function main(): Promise<void> {
  await testMultiTeamClaimIsolationAndSetCapacity();
  await testApiClientConcurrentCredentialsAndAsyncVerificationScope();
  await testCredentialPoolRecoveryCooldown();
  await testCodexSingleFlightRefresh();
  await testNotificationSpoolBackoffAndCorruptJsonl();
  await testSettingsLiveReloadDefaults();
  console.log("task3-reliability-fixes: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
