process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "ocr-rate-limit-http-secrets-key";

import assert from "node:assert/strict";
import Fastify from "fastify";
import { aiController, type OcrAuthAuditEvent } from "../src/controllers/ai-controller.js";
import type { OcrAuthAction, OcrAuthRateLimitResult } from "../src/services/ocr-auth-rate-limit.js";

const actor = { id: 41, username: "rate-limit-admin", role: "admin" as const, teamId: null };
const rawIp = "127.0.0.1";
const callbackSecret = "callback-secret-must-not-persist";
const deviceSecret = "device-secret-must-not-persist";

function deniedResult(scope: "actor" | "ip"): OcrAuthRateLimitResult {
  return {
    allowed: false,
    limitingScope: scope,
    resetAt: Date.now() + 5_000,
    retryAfterMs: 5_000,
    shouldAudit: true,
  };
}

async function main(): Promise<void> {
  const deniedActions: OcrAuthAction[] = [];
  const deniedAudits: OcrAuthAuditEvent[] = [];
  let providerCalls = 0;
  const deniedApp = Fastify();
  deniedApp.addHook("preHandler", async (request) => {
    request.user = actor;
  });
  await deniedApp.register(aiController, {
    authRateLimiter: {
      consume(input) {
        deniedActions.push(input.action);
        assert.equal(input.actorUserId, actor.id);
        assert.equal(input.clientIp, rawIp);
        return deniedResult(input.action === "complete" ? "ip" : "actor");
      },
    },
    auditWriter: async (event) => {
      deniedAudits.push(event);
    },
    authService: {
      getStatus: async () => {
        providerCalls += 1;
        return { authenticated: false };
      },
      startBrowser: async () => {
        providerCalls += 1;
        return { authorizationUrl: `https://example.test/?code=${deviceSecret}` };
      },
      startDevice: async () => {
        providerCalls += 1;
        return { deviceCode: deviceSecret };
      },
      complete: async () => {
        providerCalls += 1;
        return { authenticated: true };
      },
      logout: async () => {
        providerCalls += 1;
      },
    },
  });

  const deniedRequests = [
    { action: "status", method: "GET", url: "/codex-auth/status" },
    { action: "start", method: "POST", url: "/codex-auth/start", payload: { mode: "device" } },
    {
      action: "complete",
      method: "POST",
      url: "/codex-auth/complete",
      payload: { callbackUrl: `http://localhost/callback?code=${callbackSecret}` },
    },
    { action: "logout", method: "POST", url: "/codex-auth/logout" },
  ] as const;

  for (const request of deniedRequests) {
    const response = await deniedApp.inject(request);
    assert.equal(response.statusCode, 429, response.body);
    assert.match(response.headers["retry-after"] ?? "", /^\d+$/);
    assert.equal(JSON.parse(response.body).error_code, "RATE_LIMITED");
  }
  assert.deepEqual(deniedActions, deniedRequests.map((request) => request.action));
  assert.equal(providerCalls, 0, "rate-limited requests must not invoke OCR auth providers");
  assert.equal(deniedAudits.length, 4);
  assert.ok(deniedAudits.every((event) => event.action === "codex_auth_rate_limited"));
  const deniedAuditJson = JSON.stringify(deniedAudits);
  assert.doesNotMatch(deniedAuditJson, new RegExp(rawIp.replaceAll(".", "\\.")));
  assert.doesNotMatch(deniedAuditJson, new RegExp(callbackSecret));
  assert.doesNotMatch(deniedAuditJson, new RegExp(deviceSecret));
  await deniedApp.close();

  const allowedAudits: OcrAuthAuditEvent[] = [];
  const allowedApp = Fastify();
  allowedApp.addHook("preHandler", async (request) => {
    request.user = actor;
  });
  await allowedApp.register(aiController, {
    authRateLimiter: {
      consume: () => ({
        allowed: true,
        limitingScope: null,
        resetAt: Date.now() + 60_000,
        retryAfterMs: 0,
        shouldAudit: false,
      }),
    },
    auditWriter: async (event) => {
      allowedAudits.push(event);
    },
    authService: {
      getStatus: async () => ({ authenticated: true, accountIdSuffix: "safe" }),
      startBrowser: async () => ({ authorizationUrl: `https://example.test/?code=${deviceSecret}` }),
      startDevice: async () => ({ deviceCode: deviceSecret }),
      complete: async () => ({ authenticated: true }),
      logout: async () => undefined,
    },
  });

  for (const request of deniedRequests) {
    const response = await allowedApp.inject(request);
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.deepEqual(allowedAudits.map((event) => event.action), [
    "codex_auth_status",
    "codex_auth_start",
    "codex_auth_complete",
    "codex_auth_logout",
  ]);
  const allowedAuditJson = JSON.stringify(allowedAudits);
  assert.doesNotMatch(allowedAuditJson, new RegExp(rawIp.replaceAll(".", "\\.")));
  assert.doesNotMatch(allowedAuditJson, new RegExp(callbackSecret));
  assert.doesNotMatch(allowedAuditJson, new RegExp(deviceSecret));
  await allowedApp.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
