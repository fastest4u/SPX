process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "provider-auth-controller-test-key";

import assert from "node:assert/strict";
import Fastify from "fastify";
import type { ProviderAuthRecord, ProviderAuthStatus } from "../src/models/provider-auth.js";
import { ProviderAuthError } from "../src/services/provider-auth/client.js";
import {
  createAdminProviderAuthController,
  createOwnTeamProviderAuthController,
} from "../src/controllers/provider-auth-controller.js";

function record(overrides: Partial<ProviderAuthRecord> = {}): ProviderAuthRecord {
  return {
    teamId: 1,
    email: "team@example.test",
    hasPassword: true,
    status: "connected",
    lastLoginAt: "2030-09-11T07:00:00.000Z",
    expiresAt: "2030-09-11T08:00:00.000Z",
    errorCode: null,
    retryAt: null,
    storedStatus: "connected",
    password: "saved-password",
    cookie: "private-cookie",
    deviceId: "private-device-id",
    epoch: 3,
    failures: 0,
    enabled: true,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const calls: Array<{ operation: string; teamId: number }> = [];
  const audit: string[] = [];
  const current = record();
  const dependencies = {
    authService: {
      connect: async (teamId: number) => {
        calls.push({ operation: "connect", teamId });
        return { ...current, teamId };
      },
      reconnect: async (teamId: number) => {
        calls.push({ operation: "reconnect", teamId });
        return { ...current, teamId };
      },
      ensure: async () => current,
      recover: async () => false,
    },
    getStatus: async (teamId: number): Promise<ProviderAuthStatus | null> => ({
      ...current,
      teamId,
    }),
    audit: async (input: { operation: string; teamId: number }) => { audit.push(`${input.operation}:${input.teamId}`); },
  };

  const app = Fastify({ logger: false });
  let user: unknown = { id: 7, username: "member", role: "user", teamId: 1 };
  app.addHook("preHandler", async (request) => { request.user = user; });
  await app.register(createOwnTeamProviderAuthController(dependencies), { prefix: "/api/team/provider-auth" });
  await app.register(createAdminProviderAuthController(dependencies), { prefix: "/api/teams" });

  try {
    const ownStatus = await app.inject({ method: "GET", url: "/api/team/provider-auth" });
    assert.equal(ownStatus.statusCode, 200);
    assert.deepEqual(Object.keys(ownStatus.json().data).sort(), [
      "email", "errorCode", "expiresAt", "hasPassword", "lastLoginAt", "retryAt", "status", "teamId",
    ]);
    assert.equal(JSON.stringify(ownStatus.json()), JSON.stringify(ownStatus.json()).replace(/private-cookie|saved-password|private-device-id/g, ""));

    const unknownField = await app.inject({
      method: "PUT",
      url: "/api/team/provider-auth",
      payload: { email: "team@example.test", password: "fixture-password", teamId: 2 },
    });
    assert.equal(unknownField.statusCode, 400);
    assert.equal(calls.length, 0);

    const malformed = await app.inject({
      method: "PUT",
      url: "/api/team/provider-auth",
      payload: { email: "team@example.test" },
    });
    assert.equal(malformed.statusCode, 400);

    for (const payload of [
      { email: `${"x".repeat(242)}@example.test`, password: "fixture-password" },
      { email: "team@example.test", password: "x".repeat(4097) },
    ]) {
      const oversized = await app.inject({ method: "PUT", url: "/api/team/provider-auth", payload });
      assert.equal(oversized.statusCode, 400, "oversized credentials must be rejected before reaching the service");
    }
    assert.equal(calls.length, 0);

    const connect = await app.inject({
      method: "PUT",
      url: "/api/team/provider-auth",
      payload: { email: "team@example.test", password: "fixture-password" },
    });
    assert.equal(connect.statusCode, 200);
    assert.deepEqual(calls, [{ operation: "connect", teamId: 1 }]);
    assert.deepEqual(audit, ["connect:1"]);

    const reconnect = await app.inject({ method: "POST", url: "/api/team/provider-auth/reconnect" });
    assert.equal(reconnect.statusCode, 200);
    assert.deepEqual(calls.at(-1), { operation: "reconnect", teamId: 1 });

    user = undefined;
    assert.equal((await app.inject({ method: "GET", url: "/api/team/provider-auth" })).statusCode, 401);
    user = { id: 8, username: "viewer", role: "viewer", teamId: 1 };
    assert.equal((await app.inject({ method: "GET", url: "/api/team/provider-auth" })).statusCode, 403);

    user = { id: 1, username: "admin", role: "admin", teamId: null };
    const adminConnect = await app.inject({
      method: "PUT",
      url: "/api/teams/2/provider-auth",
      payload: { email: "other@example.test", password: "fixture-password" },
    });
    assert.equal(adminConnect.statusCode, 200);
    assert.deepEqual(calls.at(-1), { operation: "connect", teamId: 2 });

    const callsBeforeMalformedIds = calls.length;
    const auditsBeforeMalformedIds = audit.length;
    for (const malformedId of ["2garbage", "2.5", "2e3", "9007199254740992", "0", "-1"]) {
      const malformedAdminId = await app.inject({
        method: "PUT",
        url: `/api/teams/${malformedId}/provider-auth`,
        payload: { email: "other@example.test", password: "fixture-password" },
      });
      assert.equal(malformedAdminId.statusCode, 400, `admin ID ${malformedId} must be rejected`);
      const malformedReconnectId = await app.inject({
        method: "POST",
        url: `/api/teams/${malformedId}/provider-auth/reconnect`,
      });
      assert.equal(malformedReconnectId.statusCode, 400, `admin reconnect ID ${malformedId} must be rejected`);
    }
    assert.equal(calls.length, callsBeforeMalformedIds, "malformed admin IDs must not call the auth service");
    assert.equal(audit.length, auditsBeforeMalformedIds, "malformed admin IDs must not write an audit event");

    user = { id: 7, username: "member", role: "user", teamId: 1 };
    assert.equal((await app.inject({ method: "GET", url: "/api/teams/2/provider-auth" })).statusCode, 403);

    const throttled = Fastify({ logger: false });
    throttled.addHook("preHandler", async (request) => { request.user = { id: 7, username: "member", role: "user", teamId: 1 }; });
    await throttled.register(createOwnTeamProviderAuthController({
      ...dependencies,
      authService: {
        ...dependencies.authService,
        connect: async () => { throw new ProviderAuthError("rate_limited", 20_000); },
      },
    }), { prefix: "/api/team/provider-auth" });
    const rateLimited = await throttled.inject({ method: "PUT", url: "/api/team/provider-auth", payload: { email: "team@example.test", password: "fixture-password" } });
    assert.equal(rateLimited.statusCode, 429);
    assert.equal(rateLimited.headers["retry-after"], "20");
    assert.equal(rateLimited.json().details.retryAfterMs, 20_000);
    await throttled.close();

    const providerFailure = Fastify({ logger: false });
    providerFailure.addHook("preHandler", async (request) => { request.user = { id: 7, username: "member", role: "user", teamId: 1 }; });
    await providerFailure.register(createOwnTeamProviderAuthController({
      ...dependencies,
      authService: {
        ...dependencies.authService,
        connect: async () => { throw new ProviderAuthError("provider_unavailable"); },
      },
    }), { prefix: "/api/team/provider-auth" });
    const unavailable = await providerFailure.inject({ method: "PUT", url: "/api/team/provider-auth", payload: { email: "team@example.test", password: "fixture-password" } });
    assert.equal(unavailable.statusCode, 502);
    assert.notEqual(unavailable.statusCode, 401);
    await providerFailure.close();

    const rejectedCredentials = Fastify({ logger: false });
    rejectedCredentials.addHook("preHandler", async (request) => { request.user = { id: 7, username: "member", role: "user", teamId: 1 }; });
    await rejectedCredentials.register(createOwnTeamProviderAuthController({
      ...dependencies,
      authService: {
        ...dependencies.authService,
        connect: async () => { throw new ProviderAuthError("invalid_credentials"); },
      },
    }), { prefix: "/api/team/provider-auth" });
    const rejected = await rejectedCredentials.inject({ method: "PUT", url: "/api/team/provider-auth", payload: { email: "team@example.test", password: "fixture-password" } });
    assert.equal(rejected.statusCode, 400);
    assert.notEqual(rejected.statusCode, 401, "provider credential failures must not trigger dashboard auth refresh");
    await rejectedCredentials.close();

    const maximumSized = await app.inject({
      method: "PUT",
      url: "/api/team/provider-auth",
      payload: { email: `${"x".repeat(241)}@example.test`, password: "x".repeat(4096) },
    });
    assert.equal(maximumSized.statusCode, 200, "declared maximum credential sizes remain accepted by the controller");

    for (const [failure, expectedStatus, expectedCode] of [
      [new ProviderAuthError("busy"), 409, "PROVIDER_AUTH_BUSY"],
      [new Error("synthetic-password synthetic-cookie synthetic-nonce-url"), 502, "PROVIDER_AUTH_UNAVAILABLE"],
    ] as const) {
      const failingApp = Fastify({ logger: false });
      failingApp.addHook("preHandler", async (request) => { request.user = { id: 7, username: "member", role: "user", teamId: 1 }; });
      await failingApp.register(createOwnTeamProviderAuthController({
        ...dependencies,
        authService: { ...dependencies.authService, connect: async () => { throw failure; } },
      }), { prefix: "/api/team/provider-auth" });
      try {
        const response = await failingApp.inject({ method: "PUT", url: "/api/team/provider-auth", payload: { email: "team@example.test", password: "fixture-password" } });
        assert.equal(response.statusCode, expectedStatus);
        assert.equal(response.json().error_code, expectedCode);
        assert.equal(/synthetic-password|synthetic-cookie|synthetic-nonce-url/.test(response.body), false, "raw unknown errors must never leak to the response");
      } finally {
        await failingApp.close();
      }
    }
  } finally {
    await app.close();
  }

  console.log("provider-auth-controller: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
