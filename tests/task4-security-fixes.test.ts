process.env.DB_MODE = "memory";
process.env.NODE_ENV = "test";
process.env.SECRETS_KEY = "task4-security-fixes-secrets-key-32chars!";
process.env.JWT_SECRET = "task4-security-fixes-jwt-secret-32chars!!";
process.env.COOKIE_SECRET = "task4-security-fixes-cookie-secret-32ch!";

import assert from "node:assert/strict";
import { closePool, ensureDashboardTables } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { env, validateRuntimeConfig } from "../src/config/env.js";
import { createHttpServer } from "../src/services/http-server.js";
import { createTeam } from "../src/repositories/team-repository.js";
import {
  createUser,
  deleteUser,
  getUserByUsername,
  updateUserPassword,
  updateUserRole,
} from "../src/repositories/user-repository.js";
import { handleLineRouteCommand } from "../src/services/line-route-command.js";
import type { TeamStatusContext } from "../src/repositories/team-repository.js";
import type { NotifyRule, NotifyRuleInput, NotifyRulePatch } from "../src/services/notify-rules.js";

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  assert.ok(raw, "Expected set-cookie header from /api/login");
  return raw.split(";")[0] ?? "";
}

async function loginAndGetCookie(
  app: Awaited<ReturnType<typeof createHttpServer>>,
  username: string,
  password: string,
  remoteAddress = "10.10.0.1",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    remoteAddress,
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, `Login failed: ${res.body}`);
  return extractCookieHeader(res.headers["set-cookie"]);
}

async function testDashboardSessionRevocationAndRoleEnforcement(): Promise<void> {
  await closePool();
  resetMemoryDb();
  await ensureDashboardTables();

  const team = await createTeam({
    name: "Ops Team",
    enabled: true,
    spxCookie: "c",
    spxDeviceId: "d",
    lineGroupId: "g",
  });

  await createUser("ops-admin", "StrongAdminPass!123", "admin");
  const created = await getUserByUsername("ops-admin");
  assert.ok(created);

  const app = await createHttpServer({ surface: "web-api" });
  try {
    const adminCookie = await loginAndGetCookie(app, "ops-admin", "StrongAdminPass!123", "10.20.0.1");

    // Valid admin session can access /metrics and /system/pause
    const okMetrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { cookie: adminCookie },
      remoteAddress: "10.20.0.1",
    });
    assert.equal(okMetrics.statusCode, 200);

    // 1. Password rotation increments authVersion -> /metrics must immediately reject with 401 TOKEN_REVOKED
    await updateUserPassword(created.id, "RotatedStrongPass!456");
    const revokedMetrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { cookie: adminCookie },
      remoteAddress: "10.20.0.1",
    });
    assert.equal(revokedMetrics.statusCode, 401, "Expected 401 on /metrics after password rotation");
    assert.equal(JSON.parse(revokedMetrics.body).error_code, "TOKEN_REVOKED");

    // 2. Re-login, then downgrade role to 'user' -> /system/pause must reject stale token
    const secondCookie = await loginAndGetCookie(app, "ops-admin", "RotatedStrongPass!456", "10.20.0.2");
    await updateUserRole(created.id, "user", team.id);
    const pauseWithRevokedRoleToken = await app.inject({
      method: "POST",
      url: "/system/pause",
      headers: { cookie: secondCookie },
      remoteAddress: "10.20.0.2",
    });
    assert.equal(pauseWithRevokedRoleToken.statusCode, 401);
    assert.equal(JSON.parse(pauseWithRevokedRoleToken.body).error_code, "TOKEN_REVOKED");

    // Re-login as downgraded 'user' -> /pool-stats (admin-only) returns 403 FORBIDDEN
    const userCookie = await loginAndGetCookie(app, "ops-admin", "RotatedStrongPass!456", "10.20.0.3");
    const userPoolStats = await app.inject({
      method: "GET",
      url: "/pool-stats",
      headers: { cookie: userCookie },
      remoteAddress: "10.20.0.3",
    });
    assert.equal(userPoolStats.statusCode, 403);

    // 3. Delete user -> /metrics must immediately reject with 401 TOKEN_REVOKED
    await deleteUser(created.id);
    const deletedMetrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { cookie: userCookie },
      remoteAddress: "10.20.0.3",
    });
    assert.equal(deletedMetrics.statusCode, 401);
    assert.equal(JSON.parse(deletedMetrics.body).error_code, "TOKEN_REVOKED");
  } finally {
    await app.close();
  }
}

async function testSettingsSsrfAndPathTraversalHardening(): Promise<void> {
  await closePool();
  resetMemoryDb();
  await ensureDashboardTables();

  await createUser("sec-admin", "StrongAdminPass!123", "admin");
  const app = await createHttpServer({ surface: "web-api" });
  try {
    const adminCookie = await loginAndGetCookie(app, "sec-admin", "StrongAdminPass!123", "10.30.0.1");

    // Reject SSRF / non-HTTPS API_URL via POST /api/settings
    for (const unsafeUrl of [
      "http://169.254.169.254/booking/bidding/list",
      "https://127.0.0.1/booking/bidding/list",
      "https://localhost/booking/bidding/list",
      "https://10.0.0.9/booking/bidding/list",
      "http://spx.shopee.co.th/booking/bidding/list",
    ]) {
      const badApiRes = await app.inject({
        method: "POST",
        url: "/api/settings",
        headers: { cookie: adminCookie },
        remoteAddress: "10.30.0.1",
        payload: { API_URL: unsafeUrl },
      });
      assert.equal(badApiRes.statusCode, 400, `Expected 400 for unsafe API_URL: ${unsafeUrl}`);
    }

    // Reject path traversal in LINEJS_TEST_STORAGE_PATH via POST /api/settings
    for (const unsafePath of [
      "data/../../package.json",
      "/etc/passwd",
      "data\\..\\secret.json",
      "../outside.json",
    ]) {
      const badPathRes = await app.inject({
        method: "POST",
        url: "/api/settings",
        headers: { cookie: adminCookie },
        remoteAddress: "10.30.0.1",
        payload: { LINEJS_TEST_STORAGE_PATH: unsafePath },
      });
      assert.equal(badPathRes.statusCode, 400, `Expected 400 for unsafe storage path: ${unsafePath}`);
    }

    // Allow valid HTTPS public API_URL and contained data/ path
    const validRes = await app.inject({
      method: "POST",
      url: "/api/settings",
      headers: { cookie: adminCookie },
      remoteAddress: "10.30.0.1",
      payload: {
        API_URL: "https://spx.example.test/booking/bidding/list",
        APP_NAME: "SPX",
        REFERER: "https://spx.example.test/#/booking-management",
        LINEJS_TEST_STORAGE_PATH: "data/linejs-storage.json",
      },
    });
    assert.equal(validRes.statusCode, 200, `Expected 200 for valid settings: ${validRes.body}`);
  } finally {
    await app.close();
  }

  // Also test validateRuntimeConfig() directly for LINEJS_TEST_STORAGE_PATH traversal & production SSRF
  const mutableEnv = env as unknown as Record<string, unknown>;
  const savedEnv = { ...mutableEnv };
  const savedProcEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "test";
    process.env.DEBUG = "false";
    process.env.FETCH_DETAILS = "false";
    process.env.SAVE_TO_DB = "false";
    process.env.NOTIFY_ENABLED = "false";
    process.env.LINEJS_TEST_ENABLED = "true";
    process.env.AUTO_ACCEPT_ENABLED = "false";
    process.env.HTTP_ENABLED = "false";
    process.env.REQUEST_TAB_PENDING_CONFIRMATION = "true";
    Object.assign(mutableEnv, {
      NODE_ENV: "test",
      SPX_ROLE: "combined",
      SAVE_TO_DB: false,
      HTTP_ENABLED: false,
      AUTO_ACCEPT_ENABLED: false,
      LINEJS_TEST_ENABLED: true,
      LINEJS_TEST_DEVICE: "IOSIPAD",
      LINEJS_TEST_STORAGE_PATH: "data/../package.json",
      API_URL: "https://spx.example.test/booking/bidding/list",
      APP_NAME: "SPX",
      REFERER: "https://spx.example.test/",
    });
    assert.throws(
      () => validateRuntimeConfig(),
      /LINEJS_TEST_STORAGE_PATH/,
      "Expected validateRuntimeConfig to reject traversal in LINEJS_TEST_STORAGE_PATH",
    );
  } finally {
    Object.assign(mutableEnv, savedEnv);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedProcEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedProcEnv);
  }
}

async function testLineRouteCommandGuardrailsAndAudit(): Promise<void> {
  const mockTeams: TeamStatusContext[] = [
    {
      id: 7,
      name: "PTWL",
      enabled: true,
      biddingVehicleType: 13,
      lineGroupId: "c-ptwl-group",
      autoAcceptSuccessLineGroupId: "",
      autoAcceptFailureLineGroupId: "",
    },
  ];
  const rules: NotifyRule[] = [];
  const mockRuleOps = {
    async readRules(teamId: number): Promise<NotifyRule[]> {
      return rules.filter((r) => r.teamId === teamId);
    },
    async createRule(teamId: number, input: NotifyRuleInput): Promise<NotifyRule> {
      const rule: NotifyRule = {
        id: `r-${rules.length + 1}`,
        teamId,
        name: input.name,
        origins: input.origins ?? [],
        destinations: input.destinations ?? [],
        vehicle_types: input.vehicle_types ?? [],
        need: input.need ?? 1,
        enabled: input.enabled ?? true,
        fulfilled: false,
        auto_accept: true,
        accept_all: false,
        auto_accepted: false,
      };
      rules.push(rule);
      return rule;
    },
    async updateRule(teamId: number, id: string, patch: NotifyRulePatch): Promise<NotifyRule | null> {
      const found = rules.find((r) => r.id === id && r.teamId === teamId);
      if (!found) return null;
      Object.assign(found, patch);
      return found;
    },
  };

  const audits: Array<{ username: string; action: string; details?: string; targetTeamId?: number | null }> = [];

  // 1. Reject need > 1000
  const overMaxReply = await handleLineRouteCommand({
    chatId: "c-ptwl-group",
    text: "+ SOCN-GBKK 5000 4W",
    teams: mockTeams,
    ruleOps: mockRuleOps,
    auditWriter: async (username, action, details, opts) => {
      audits.push({ username, action, details, targetTeamId: opts?.targetTeamId });
    },
  });
  assert.equal(rules.length, 0, "Should not create rule when need > 1000");
  assert.match(overMaxReply, /1,?000/);
  assert.equal(audits.length, 0);

  // 2. Reject unauthorized sender when allowedSenderIds is configured
  const unauthorizedReply = await handleLineRouteCommand({
    chatId: "c-ptwl-group",
    text: "+ SOCN-GBKK 6 4W",
    senderId: "u-untrusted",
    allowedSenderIds: new Set(["u-dispatcher-1"]),
    teams: mockTeams,
    ruleOps: mockRuleOps,
    auditWriter: async (username, action, details, opts) => {
      audits.push({ username, action, details, targetTeamId: opts?.targetTeamId });
    },
  });
  assert.equal(rules.length, 0, "Should reject unauthorized sender");
  assert.match(unauthorizedReply, /ไม่มีสิทธิ์/);

  // 3. Authorized sender succeeds and writes audit log
  const authorizedReply = await handleLineRouteCommand({
    chatId: "c-ptwl-group",
    text: "+ SOCN-GBKK 6 4W",
    senderId: "u-dispatcher-1",
    allowedSenderIds: new Set(["u-dispatcher-1"]),
    teams: mockTeams,
    ruleOps: mockRuleOps,
    auditWriter: async (username, action, details, opts) => {
      audits.push({ username, action, details, targetTeamId: opts?.targetTeamId });
    },
  });
  assert.equal(rules.length, 1);
  assert.match(authorizedReply, /บันทึกเส้นทางเรียบร้อย/);
  assert.equal(audits.length, 1);
  assert.match(audits[0]!.username, /u-dispatcher-1/);
  assert.equal(audits[0]!.targetTeamId, 7);
}

async function testTieredRateLimits(): Promise<void> {
  await closePool();
  resetMemoryDb();
  await ensureDashboardTables();

  const team = await createTeam({
    name: "Rate Team",
    enabled: true,
    spxCookie: "c",
    spxDeviceId: "d",
    lineGroupId: "g",
  });
  await createUser("tier-user", "StrongUserPass!123", "user", team.id);
  await createUser("tier-admin", "StrongAdminPass!123", "admin");

  const app = await createHttpServer({ surface: "web-api" });
  try {
    // 1. Unauthenticated / forged-cookie client gets capped at 120 req/min
    for (let i = 1; i <= 120; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/history",
        headers: { cookie: "token=forged-token-value" },
        remoteAddress: "10.40.0.1",
      });
      assert.equal(res.statusCode, 401, `Expected 401 on request #${i}`);
    }
    const unauth121 = await app.inject({
      method: "GET",
      url: "/api/history",
      headers: { cookie: "token=forged-token-value" },
      remoteAddress: "10.40.0.1",
    });
    assert.equal(unauth121.statusCode, 429, "Forged cookie must not bypass 120/min unauthenticated rate limit");

    // 2. Authenticated 'user' gets 180 req/min (must NOT be capped at 120!)
    const userCookie = await loginAndGetCookie(app, "tier-user", "StrongUserPass!123", "10.40.0.2");
    for (let i = 1; i <= 180; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: userCookie },
        remoteAddress: "10.40.0.2",
      });
      assert.equal(res.statusCode, 200, `Expected 200 for user on request #${i}, got ${res.statusCode}`);
      if (i === 1) {
        assert.equal(res.headers["x-ratelimit-limit"], "180");
      }
    }
    const user181 = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: userCookie },
      remoteAddress: "10.40.0.2",
    });
    assert.equal(user181.statusCode, 429, "User should hit 429 on request #181");

    // 3. Authenticated 'admin' gets 300 req/min (must NOT be capped at 120!)
    const adminCookie = await loginAndGetCookie(app, "tier-admin", "StrongAdminPass!123", "10.40.0.3");
    for (let i = 1; i <= 300; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: adminCookie },
        remoteAddress: "10.40.0.3",
      });
      assert.equal(res.statusCode, 200, `Expected 200 for admin on request #${i}, got ${res.statusCode}`);
      if (i === 1) {
        assert.equal(res.headers["x-ratelimit-limit"], "300");
      }
    }
    const admin301 = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: adminCookie },
      remoteAddress: "10.40.0.3",
    });
    assert.equal(admin301.statusCode, 429, "Admin should hit 429 on request #301");
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  Object.assign(env, {
    DB_MODE: "memory",
    NODE_ENV: "test",
    SECRETS_KEY: "task4-security-fixes-secrets-key-32chars!",
    JWT_SECRET: "task4-security-fixes-jwt-secret-32chars!!",
    COOKIE_SECRET: "task4-security-fixes-cookie-secret-32ch!",
  });
  await testDashboardSessionRevocationAndRoleEnforcement();
  await testSettingsSsrfAndPathTraversalHardening();
  await testLineRouteCommandGuardrailsAndAudit();
  await testTieredRateLimits();
  await closePool();
  console.log("task4-security-fixes: all assertions passed");
}

main().catch(async (error) => {
  await closePool().catch(() => {});
  console.error(error);
  process.exit(1);
});
