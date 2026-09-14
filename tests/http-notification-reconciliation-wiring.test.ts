process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "reconciliation-http-secrets-key";
process.env.JWT_SECRET = "reconciliation-http-jwt-secret-value";
process.env.COOKIE_SECRET = "reconciliation-http-cookie-secret-value";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(raw);
  return raw.split(";")[0] ?? "";
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const isolatedCwd = await mkdtemp(join(tmpdir(), "spx-reconciliation-http-"));
  try {
    await mkdir(join(isolatedCwd, "dist", "public"), { recursive: true });
    await mkdir(join(isolatedCwd, "data", "line-images"), { recursive: true });
    process.chdir(isolatedCwd);

    const { resetMemoryDb } = await import("../src/db/client-memory.js");
    const { createTeam } = await import("../src/repositories/team-repository.js");
    const { createUser } = await import("../src/repositories/user-repository.js");
    const { createHttpServer } = await import("../src/services/http-server.js");
    resetMemoryDb();
    const team = await createTeam({ name: "Reconciliation HTTP", enabled: true });
    await createUser("reconciliation-user", "password-123456", "user", team.id);
    await createUser("reconciliation-admin", "password-123456", "admin", null);

    let listCalls = 0;
    const reconcileCalls: unknown[] = [];
    const app = await createHttpServer({
      surface: "web-api",
      notificationReconciliation: {
        listCandidates: async () => {
          listCalls += 1;
          return [{
            outboxId: 42,
            teamId: 2,
            status: "delivery_ambiguous",
            providerRequestId: "transport-request-123",
            lockedBy: null,
            attempts: 1,
            providerStartedAt: "2030-06-29 09:00:03",
            updatedAt: "2030-06-29 09:00:04",
          }];
        },
        reconcile: async (input) => {
          reconcileCalls.push(input);
          return { state: "reconciled", status: "sent" };
        },
      },
    });
    try {
      const userLogin = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "reconciliation-user", password: "password-123456" },
      });
      assert.equal(userLogin.statusCode, 200, userLogin.body);
      const userCookie = cookie(userLogin);
      for (const request of [
        { method: "GET", url: "/api/notification-reconciliation" },
        {
          method: "POST",
          url: "/api/notification-reconciliation/42",
          payload: {
            action: "mark_sent",
            expectedStatus: "delivery_ambiguous",
            providerRequestId: "transport-request-123",
            expectedProviderStartedAt: "2030-06-29 09:00:03",
            confirmation: "PROVIDER_CONFIRMED_SENT",
            evidenceReference: "LINE-console-message-123",
            reason: "LINE console confirms the message was delivered",
            providerMessageId: "line-message-123",
          },
        },
      ]) {
        const denied = await app.inject({ ...request, headers: { cookie: userCookie } });
        assert.equal(denied.statusCode, 403, denied.body);
      }
      assert.equal(listCalls, 0);
      assert.equal(reconcileCalls.length, 0);

      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "reconciliation-admin", password: "password-123456" },
      });
      assert.equal(adminLogin.statusCode, 200, adminLogin.body);
      const adminCookie = cookie(adminLogin);
      const candidates = await app.inject({
        method: "GET",
        url: "/api/notification-reconciliation",
        headers: { cookie: adminCookie },
      });
      assert.equal(candidates.statusCode, 200, candidates.body);
      assert.equal(JSON.parse(candidates.body).data[0].outboxId, 42);
      assert.equal(listCalls, 1);

      const accepted = await app.inject({
        method: "POST",
        url: "/api/notification-reconciliation/42",
        headers: { cookie: adminCookie },
        payload: {
          action: "mark_sent",
          expectedStatus: "delivery_ambiguous",
          providerRequestId: "transport-request-123",
          expectedProviderStartedAt: "2030-06-29 09:00:03",
          confirmation: "PROVIDER_CONFIRMED_SENT",
          evidenceReference: "LINE-console-message-123",
          reason: "LINE console confirms the message was delivered",
          providerMessageId: "line-message-123",
        },
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.deepEqual(JSON.parse(accepted.body).data, { outboxId: 42, status: "sent" });
      assert.deepEqual(reconcileCalls, [{
        outboxId: 42,
        action: "mark_sent",
        expectedStatus: "delivery_ambiguous",
        providerRequestId: "transport-request-123",
        expectedProviderStartedAt: "2030-06-29 09:00:03",
        evidenceReference: "LINE-console-message-123",
        reason: "LINE console confirms the message was delivered",
        providerMessageId: "line-message-123",
        actor: { userId: 2, username: "reconciliation-admin", teamId: null },
      }]);
    } finally {
      await app.close();
    }
  } finally {
    process.chdir(originalCwd);
    await rm(isolatedCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
